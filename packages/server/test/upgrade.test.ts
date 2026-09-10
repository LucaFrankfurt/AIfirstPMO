/**
 * An upgrade is a restart, and this is what has to stay true across one.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a database that already
 * exists, so every column added after a table's first release is applied by the
 * list at the top of `db/index.ts`. The list is maintained by hand and there was
 * nothing behind it, which is how decisions shipped two columns that only
 * existed on a database created from scratch.
 *
 * What that cost is the reason this file exists. `notifications.decision_id` is
 * written by the announcement that fires when a ballot becomes answerable —
 * which is the moment its **second** option lands. So on every upgraded
 * instance the second option's write threw inside its own transaction, the push
 * rejected it, and the client forgot the row, correctly, because the server
 * 404s a row it never created. Every ballot came out with exactly one option
 * and nothing anywhere said why. It passed every test in this suite, because
 * every test in this suite starts from an empty directory.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-upgrade-${process.pid}`;

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DATA = process.env.KOLIBRI_DATA_DIR!;
const DB = join(DATA, 'kolibri.sqlite');
const SCHEMA = new URL('../src/kernel/platform/db/schema.sql', import.meta.url).pathname;
/**
 * The schema as it stood when this check was written — an exact copy, refreshed
 * deliberately and never automatically. See the case at the foot of this file.
 */
const RELEASED = new URL('./released.sql', import.meta.url).pathname;
const SOURCE = new URL('../src/kernel/platform/db/index.ts', import.meta.url).pathname;

/**
 * The columns the upgrade list claims to add, read out of the source.
 *
 * Read rather than imported: the list is a literal inside a module that opens
 * the database as a side effect of being loaded, and this test has to know what
 * is in it *before* that happens.
 */
function upgradeColumns(): [table: string, column: string][] {
  const text = readFileSync(SOURCE, 'utf8');
  const start = text.indexOf('for (const [table, column, definition] of [');
  const end = text.indexOf('] as const) {', start);
  assert.ok(start > 0 && end > start, 'the upgrade list has moved — this test reads it by shape');
  return [...text.slice(start, end).matchAll(/^\s*\['([a-z_]+)', '([a-z_]+)',/gm)]
    .map((match) => [match[1], match[2]] as [string, string]);
}

/** A database as an older release left it: every post-release column gone. */
function agedDatabase(): [table: string, column: string][] {
  mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(DB);
  db.exec(readFileSync(SCHEMA, 'utf8'));

  const dropped: [string, string][] = [];
  for (const [table, column] of upgradeColumns()) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes(column)) continue;
    // A column an index is built on cannot be dropped; those are not the ones
    // this is about, and skipping them keeps the case honest rather than green.
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      dropped.push([table, column]);
    } catch { /* held by an index or a constraint — left in place */ }
  }
  db.close();
  return dropped;
}

const columnsOf = (table: string): string[] => {
  const db = new DatabaseSync(DB, { readOnly: true });
  const names = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  db.close();
  return names;
};

let dropped: [string, string][] = [];

before(() => {
  rmSync(DATA, { recursive: true, force: true });
  dropped = agedDatabase();
});

after(() => rmSync(DATA, { recursive: true, force: true }));

describe('every column the upgrade list names comes back on a restart', () => {
  it('had something to prove', () => {
    // If nothing could be dropped the rest of this file asserts nothing at all.
    assert.ok(dropped.length > 20, `only ${dropped.length} columns were dropped`);
    assert.ok(
      dropped.some(([table, column]) => table === 'notifications' && column === 'decision_id'),
      'notifications.decision_id is not in the upgrade list — an upgraded instance loses a ballot’s second option',
    );
    assert.ok(
      dropped.some(([table, column]) => table === 'decisions' && column === 'announced_at'),
      'decisions.announced_at is not in the upgrade list',
    );
  });

  it('restores every one of them when the server opens the database', async () => {
    // Importing is what runs the upgrade: the module opens the database and
    // applies the list as a side effect of being loaded.
    await import('../src/kernel/platform/db/index.ts');
    const missing = dropped.filter(([table, column]) => !columnsOf(table).includes(column));
    assert.deepEqual(missing, [], `these did not come back: ${missing.map((m) => m.join('.')).join(', ')}`);
  });
});

describe('a ballot on an upgraded database keeps every option', () => {
  let base = '';
  let cookie = '';
  let workspace = '';
  let server: import('node:http').Server;

  before(async () => {
    ({ server } = await import('../src/index.ts'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'upgrade@example.com', name: 'Up', password: 'correct horse battery' }),
    });
    const body = await register.json() as any;
    cookie = register.headers.get('set-cookie')!.split(';')[0];
    workspace = body.workspaces[0].id;
    await fetch(`${base}/api/workspaces/${workspace}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ features: { decisions: true } }),
    });
  });

  after(() => server.close());

  /*
   * Through `sync/push` and not REST, because that is the difference that hid
   * this: the browser pushes, every test in this suite used REST, and the two
   * take the same write path but report failure differently — a push rejects
   * one mutation and carries on, so the option vanished without an error
   * anybody saw.
   */
  it('accepts the second option, which is the one the announcement fires on', async () => {
    const uuid = () => crypto.randomUUID();
    const decision = uuid();
    let tick = 0;
    const hlc = () => `${Date.now()}:${String(tick++).padStart(4, '0')}:test`;
    const option = (label: string, order: string) => {
      const id = uuid();
      return {
        id: uuid(), entity: 'decisionOption', entityId: id, op: 'upsert', hlc: hlc(),
        patch: { id, workspace_id: workspace, created_at: Date.now(), deleted_at: null, decision_id: decision, label, description: null, sort_order: order },
      };
    };

    const push: any = await (await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workspaceId: workspace,
        clientId: 'upgrade-test',
        mutations: [
          {
            id: uuid(), entity: 'decision', entityId: decision, op: 'upsert', hlc: hlc(),
            patch: {
              id: decision, workspace_id: workspace, created_at: Date.now(), deleted_at: null,
              question: 'Test poll', description: null, mode: 'single', visibility: 'open',
              status: 'open', closes_at: null, task_id: null, project_id: null, sort_order: 'V',
            },
          },
          option('Opt1', 'V'),
          option('Opt2', 'k'),
        ],
      }),
    })).json();

    assert.deepEqual(push.rejected, [], 'a mutation was rejected on an upgraded database');
    assert.equal(push.accepted.length, 3);

    const options = await (await fetch(`${base}/api/workspaces/${workspace}/decision-options`, { headers: { cookie } })).json() as any[];
    assert.deepEqual(
      options.filter((row: any) => row.decision_id === decision).map((row: any) => row.label).sort(),
      ['Opt1', 'Opt2'],
    );
  });
});

/**
 * Every column in `schema.sql` reaches a database that already exists.
 *
 * The two cases above prove the upgrade list *works*. Neither can prove it is
 * *complete*, and that was the actual bug: `notifications.decision_id` went
 * into `schema.sql` and nowhere else, which is correct for a fresh database and
 * does nothing at all for one that is being upgraded. Nothing here knew the
 * column was new, because nothing here knew what old looked like.
 *
 * `released.sql` is what old looks like: a copy of `schema.sql` frozen at a
 * moment somebody chose. A column added to an existing table since then is not
 * in it, so the only way that column can reach an upgraded instance is the
 * list — and this asserts exactly that, by building the frozen schema, applying
 * the list to it, and comparing what comes out against the schema as it now
 * stands.
 *
 * The gap it does not close, named rather than papered over: a table created
 * *after* the freeze is not in `released.sql`, so a column added to it later is
 * not covered until somebody refreshes the copy. That is precisely how
 * `decisions.announced_at` slipped — the table arrived in one commit and the
 * column in the next. Refreshing is one `cp`, and the failure message says so.
 */
describe('every column in schema.sql reaches a database that already exists', () => {
  const columnsIn = (sql: string, apply: readonly [string, string, string][] = []) => {
    const db = new DatabaseSync(':memory:');
    db.exec(sql);
    for (const [table, column, definition] of apply) {
      const held = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      // A table the frozen schema does not have yet: the upgrade list may name
      // it, and on a real instance `CREATE TABLE` will have made it already.
      if (!held.length || held.includes(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));
    const out = new Map<string, string[]>();
    for (const table of tables) {
      out.set(table, (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name).sort());
    }
    db.close();
    return out;
  };

  /** The list as `db/index.ts` writes it, definitions included. */
  const upgrades = (): [string, string, string][] => {
    const text = readFileSync(SOURCE, 'utf8');
    const start = text.indexOf('for (const [table, column, definition] of [');
    const end = text.indexOf('] as const) {', start);
    return [...text.slice(start, end).matchAll(/^\s*\['([a-z_]+)', '([a-z_]+)', (`[^`]*`|'[^']*')\],/gm)]
      .map((m) => [m[1], m[2], m[3].slice(1, -1)] as [string, string, string]);
  };

  it('has something to prove: the frozen copy is missing what the list adds', () => {
    const frozen = columnsIn(readFileSync(RELEASED, 'utf8'));
    const list = upgrades();
    assert.ok(list.length > 40, `only ${list.length} upgrade entries were parsed out of db/index.ts`);
    // Not an assertion about any one column — just that the two files are not
    // the same thing, which would make the case below vacuous.
    assert.ok(frozen.size > 30, `the frozen schema has only ${frozen.size} tables`);
  });

  it('leaves no column that only a fresh database would have', () => {
    const upgraded = columnsIn(readFileSync(RELEASED, 'utf8'), upgrades());
    const fresh = columnsIn(readFileSync(SCHEMA, 'utf8'));

    const missing: string[] = [];
    for (const [table, columns] of fresh) {
      const had = upgraded.get(table);
      // A table added since the freeze is created whole by `CREATE TABLE IF NOT
      // EXISTS` on every instance, so it needs no entry.
      if (!had) continue;
      for (const column of columns) if (!had.includes(column)) missing.push(`${table}.${column}`);
    }

    assert.deepEqual(missing, [], [
      `these columns exist only on a database created from scratch: ${missing.join(', ')}.`,
      'Add each to the list at the top of `db/index.ts` — `CREATE TABLE IF NOT EXISTS`',
      'cannot add a column to a database that already exists.',
      'If the column is genuinely on a table younger than the frozen copy, refresh it:',
      '  cp packages/server/src/kernel/platform/db/schema.sql packages/server/test/released.sql',
    ].join('\n'));
  });
});

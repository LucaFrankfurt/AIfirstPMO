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
 *
 * What is proved here is that the list *works*: every column it names is back on
 * the database after a restart, and a ballot survives a push on an aged one.
 * That the list is *complete* is a different claim, and one no case in this
 * suite can make, because none of them has ever seen an old database that was
 * not built from today's schema. `npm run check:schema` makes it, against
 * `db/origin.sql`.
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

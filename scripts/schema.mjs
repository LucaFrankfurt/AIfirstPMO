/**
 * A column on a table that already exists can only get there through the list.
 *
 *   node scripts/schema.mjs            # check
 *   node scripts/schema.mjs --fix      # record tables this has not seen before
 *
 * `CREATE TABLE IF NOT EXISTS` builds a database that does not exist yet and
 * does nothing whatever to one that does. Everything a table gained after it
 * was first created therefore has to be applied by the list at the top of
 * `db/index.ts`, and the note above that list has said so since it was written.
 * It was still missed: `notifications.decision_id` went into `schema.sql` and
 * nowhere else, and because the announcement that writes it fires on a ballot's
 * *second* option, every upgraded instance silently lost one option per ballot.
 *
 * `upgrade.test.ts` proves the list *works*. This proves it *complete*, and the
 * difference is the whole point: nothing there knows a column is new, because
 * nothing there knows what a table looked like when it was created.
 *
 * `origin.sql` is what it looked like. Every table as first created — no
 * column the list has since added — and it is **append-only by construction**:
 * `--fix` records a table this has never seen and will not re-record one it
 * has. That is the property the check rests on. A whole-file copy would be a
 * way to silence any finding by taking a new photograph of the crime scene;
 * appending one table cannot silence anything, because a column arriving on a
 * table already in the file is exactly what is being looked for.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DB = join(ROOT, 'packages/server/src/kernel/platform/db');
const SCHEMA = join(DB, 'schema.sql');
const ORIGIN = join(DB, 'origin.sql');
const SOURCE = join(DB, 'index.ts');

const fix = process.argv.includes('--fix');

/** Every ordinary table in a database built from this SQL, with its columns. */
function tablesIn(sql) {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  const rows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all();
  /*
   * Full-text search is left out, both halves of it.
   *
   * An FTS5 table is `CREATE VIRTUAL TABLE`, and the five tables SQLite builds
   * underneath each one — `_data`, `_idx`, `_content`, `_docsize`, `_config` —
   * are its private storage rather than anything this schema wrote. Neither
   * kind gains a column by `ALTER TABLE`: an FTS index changes by being
   * rebuilt, which is a different operation with a different migration, and
   * recording the shadow tables here would be recording a detail of the
   * extension's current version as though it were ours.
   */
  const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(String(r.sql ?? ''))).map((r) => String(r.name));
  const shadow = (name) => virtual.some((v) => name === v || name.startsWith(`${v}_`));

  const out = new Map();
  for (const { name, sql: create } of rows) {
    if (shadow(String(name))) continue;
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    out.set(String(name), { create: String(create ?? ''), columns });
  }
  db.close();
  return out;
}

/**
 * The list as `db/index.ts` writes it.
 *
 * Read out of the source rather than imported, because importing that module
 * opens a database as a side effect of being loaded — which is the right shape
 * for a server and the wrong one for a check.
 */
function upgrades() {
  const text = readFileSync(SOURCE, 'utf8');
  const start = text.indexOf('for (const [table, column, definition] of [');
  const end = text.indexOf('] as const) {', start);
  if (start < 0 || end < 0) {
    console.error('the upgrade list has moved — scripts/schema.mjs reads it by shape');
    process.exit(1);
  }
  return [...text.slice(start, end).matchAll(/^\s*\['([a-z_]+)', '([a-z_]+)', (`[^`]*`|'[^']*')\],/gm)]
    .map((m) => ({ table: m[1], column: m[2], definition: m[3].slice(1, -1) }));
}

/**
 * A table as it was before the list touched it.
 *
 * Reconstructed rather than remembered: the list says which columns arrived
 * later, so dropping them from today's table gives the shape it was created
 * with. SQLite rewrites the `CREATE` statement on a drop, so what comes back is
 * real DDL rather than something this file assembled by hand.
 *
 * A list entry naming a column `CREATE TABLE` does not create at all is not a
 * mistake and is skipped: eight of them are exactly that, columns the list is
 * already the sole source of, on a fresh database as much as an upgraded one.
 * They are the shape everything here is trying to reach.
 *
 * A column an index or a UNIQUE constraint holds cannot be dropped, and is left
 * in place — recorded as though the table had always had it. That is the
 * conservative direction: the check will not *demand* a list entry for that one,
 * so it can miss a missing entry there but can never invent one. Dropping it
 * properly means rebuilding the table rather than altering it, which this file
 * does not do; what it does instead is say so, both on the terminal and in a
 * comment above the table it happened to, so the exception is named where a
 * reader meets it rather than inferred from a silence.
 */
function asCreated(name, create, added) {
  const db = new DatabaseSync(':memory:');
  db.exec(create);
  const has = () => db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  const held = [];
  for (const column of added) {
    if (!has().includes(column)) continue;
    try { db.exec(`ALTER TABLE ${name} DROP COLUMN ${column}`); } catch { held.push(column); }
  }
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name)?.sql;
  db.close();
  const note = held.length
    ? `-- ${held.map((c) => `${name}.${c}`).join(', ')}: added by the upgrade list, but held by an\n`
      + `-- index or a constraint and so undroppable — recorded here as original.\n`
    : '';
  return { block: `${note}${String(sql).trim()};\n`, held: held.map((c) => `${name}.${c}`) };
}

const schema = tablesIn(readFileSync(SCHEMA, 'utf8'));
const list = upgrades();
const origin = existsSync(ORIGIN) ? tablesIn(readFileSync(ORIGIN, 'utf8')) : new Map();

/* ------------------------------------------------------------ tables it has not seen */

const unseen = [...schema.keys()].filter((name) => !origin.has(name));

if (unseen.length && fix) {
  const added = (name) => list.filter((entry) => entry.table === name).map((entry) => entry.column);
  const built = unseen.map((name) => asCreated(name, schema.get(name).create, added(name)));
  const blocks = built.map((b) => b.block);
  const held = built.flatMap((b) => b.held);
  const header = existsSync(ORIGIN) ? '' : `${[
    '-- Every table as it was first created, and nothing it has gained since.',
    '--',
    '-- Generated and append-only: `npm run schema -- --fix` records a table this',
    '-- file has never seen and never re-records one it has. Do not hand-edit — a',
    '-- table rewritten here is a column that no longer has to be in the upgrade',
    '-- list, which is the one thing this file exists to make impossible.',
    '--',
    '-- See scripts/schema.mjs.',
  ].join('\n')}\n\n`;
  writeFileSync(ORIGIN, (existsSync(ORIGIN) ? `${readFileSync(ORIGIN, 'utf8').trimEnd()}\n\n` : header) + blocks.join('\n'));
  console.log(`origin.sql: recorded ${unseen.length} table(s) — ${unseen.join(', ')}`);
  if (held.length) {
    console.log(`  ${held.length} column(s) could not be dropped and are recorded as original: ${held.join(', ')}`);
    console.log('  The check cannot ask for a list entry for those — see asCreated().');
  }
}

/* --------------------------------------------------------------- the check itself */

const recorded = existsSync(ORIGIN) ? tablesIn(readFileSync(ORIGIN, 'utf8')) : new Map();
const missing = [];
const unrecorded = [];

for (const [name, { columns }] of schema) {
  const first = recorded.get(name);
  if (!first) { unrecorded.push(name); continue; }
  const reachable = new Set([...first.columns, ...list.filter((e) => e.table === name).map((e) => e.column)]);
  for (const column of columns) if (!reachable.has(column)) missing.push(`${name}.${column}`);
}

if (!missing.length && !unrecorded.length) {
  console.log(`origin.sql: ${recorded.size} tables recorded, ${list.length} upgrades — every column reaches a database that already exists.`);
  process.exit(0);
}

if (unrecorded.length) {
  console.log(`${unrecorded.length} table(s) this has never seen: ${unrecorded.join(', ')}\n`);
  console.log('  Run `npm run schema -- --fix` to record them as created.\n');
}
if (missing.length) {
  console.log(`${missing.length} column(s) exist only on a database created from scratch:\n`);
  for (const column of missing) console.log(`  ${column}`);
  console.log('\n  `CREATE TABLE IF NOT EXISTS` cannot add a column to a database that already');
  console.log('  exists. Add each to the list at the top of `db/index.ts`.');
}
process.exit(1);

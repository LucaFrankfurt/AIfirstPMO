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

/**
 * The `CHECK` and `COLLATE` clauses a `CREATE TABLE` declares.
 *
 * No pragma reports either, so they are read off the statement SQLite kept —
 * with quoted strings and comments blanked first, so a literal that happens to
 * contain the word does not become a clause. `ALTER TABLE` can attach both to a
 * column it is adding and to nothing that is already there, which puts them in
 * the same family as a type: edited in place, they reach new instances only.
 */
function clausesIn(create) {
  let out = '';
  for (let i = 0; i < create.length; i++) {
    if (create[i] === "'") {
      // Blank the literal, keeping the length so nothing shifts.
      out += ' ';
      while (++i < create.length && create[i] !== "'") out += ' ';
      out += ' ';
      continue;
    }
    if (create[i] === '-' && create[i + 1] === '-') {
      while (i < create.length && create[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      continue;
    }
    out += create[i];
  }

  const found = [];
  for (const match of out.matchAll(/\bCHECK\s*\(/gi)) {
    // Balanced from the opening paren: a CHECK body is an expression and can
    // nest, so counting is the only honest way to find where it ends.
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < out.length; end++) {
      if (out[end] === '(') depth++;
      else if (out[end] === ')' && --depth === 0) break;
    }
    found.push(`CHECK ${out.slice(match.index + match[0].length - 1, end + 1).replace(/\s+/g, ' ')}`);
  }
  for (const match of out.matchAll(/\bCOLLATE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) found.push(`COLLATE ${match[1].toUpperCase()}`);
  return found.sort();
}

/**
 * Every ordinary table in a database built from this SQL, as declared.
 *
 * `apply` is the upgrade list, and passing it is what turns `origin.sql` into
 * the database an existing instance actually ends up with. A column's shape is
 * read from `PRAGMA table_info` rather than from the DDL text, so alignment and
 * column order cannot make two identical tables look different; the constraints
 * a `CREATE TABLE` declares inline come from `PRAGMA index_list` with the
 * indexes `CREATE INDEX` made (`origin === 'c'`) left out, because those are
 * `IF NOT EXISTS` in `schema.sql` and do reach an existing database.
 */
function tablesIn(sql, apply = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  for (const { table, column, definition } of apply) {
    const held = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    // A table the recorded schema does not have yet: on a real instance
    // `CREATE TABLE` will have made it whole, column and all.
    if (!held.length || held.includes(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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
    const shape = new Map(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => [
      String(c.name),
      `${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value === null ? '' : ` DEFAULT ${c.dflt_value}`}${c.pk ? ' PRIMARY KEY' : ''}`,
    ]));
    const constraints = db.prepare(`PRAGMA index_list(${name})`).all()
      .filter((idx) => idx.origin !== 'c')
      .map((idx) => `${idx.unique ? 'UNIQUE' : 'INDEX'} (${db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name).join(', ')})`)
      .sort();
    out.set(String(name), {
      create: String(create ?? ''), columns: [...shape.keys()], shape, constraints, clauses: clausesIn(String(create ?? '')),
    });
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

/*
 * Two databases, compared column by column.
 *
 * `upgraded` is what an instance that already existed ends up with: the tables
 * as first created, plus the list. `fresh` is `schema.sql`. They have to agree
 * on every column that is in both, not merely on which columns exist — because
 * `ALTER TABLE` can add a column and can do nothing else. It cannot change a
 * type, cannot add a NOT NULL or a DEFAULT to a column that is already there,
 * and cannot add a UNIQUE constraint at all. So a declaration edited in
 * `schema.sql` takes effect on new instances and on no other, permanently, and
 * the two halves of the estate drift apart with nothing anywhere saying so.
 * Comparing names alone let that through, which is why this compares shape.
 */
const upgraded = existsSync(ORIGIN) ? tablesIn(readFileSync(ORIGIN, 'utf8'), list) : new Map();
const missing = [];
const unrecorded = [];
/** A column that is on both but not the same on both, with what would fix it. */
const divergent = [];

const listed = (table, column) => list.some((e) => e.table === table && e.column === column);

for (const [name, table] of schema) {
  const now = upgraded.get(name);
  if (!now) { unrecorded.push(name); continue; }

  for (const [column, declared] of table.shape) {
    const applied = now.shape.get(column);
    if (applied === undefined) { missing.push(`${name}.${column}`); continue; }
    if (applied === declared) continue;
    divergent.push({
      what: `${name}.${column}`,
      fresh: declared,
      upgraded: applied,
      // Which of the two remedies applies is not a detail: one is editing a
      // string, the other is a migration mechanism this repository does not have.
      remedy: listed(name, column)
        ? 'the list entry adds this column — make its definition match `schema.sql`'
        : 'this column predates the list, so no entry can reach it — it needs a table rewrite',
    });
  }

  for (const constraint of table.constraints) {
    if (now.constraints.includes(constraint)) continue;
    divergent.push({
      what: `${name} ${constraint}`,
      fresh: 'declared',
      upgraded: 'absent',
      remedy: '`ALTER TABLE` cannot add a constraint — declare it as a `CREATE UNIQUE INDEX IF NOT EXISTS`, which does reach an existing database',
    });
  }

  for (const clause of table.clauses) {
    if (now.clauses.includes(clause)) continue;
    divergent.push({
      what: `${name} ${clause}`,
      fresh: 'declared',
      upgraded: 'absent',
      remedy: 'a CHECK or a COLLATE can be attached to a column being added and to nothing already there — this one needs a table rewrite',
    });
  }
}

if (!missing.length && !unrecorded.length && !divergent.length) {
  console.log(`origin.sql: ${upgraded.size} tables recorded, ${list.length} upgrades — every column reaches a database that already exists, in the shape schema.sql declares.`);
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
if (divergent.length) {
  console.log(`\n${divergent.length} column(s) would not have the same shape on an upgraded database:\n`);
  for (const d of divergent) {
    console.log(`  ${d.what}`);
    console.log(`    schema.sql   ${d.fresh}`);
    console.log(`    an upgrade   ${d.upgraded}`);
    console.log(`    ${d.remedy}`);
  }
  console.log('\n  `ALTER TABLE` adds a column and does nothing else — no type change, no');
  console.log('  NOT NULL or DEFAULT on a column already there, no constraint. A');
  console.log('  declaration edited in `schema.sql` alone reaches new instances only.');
}
process.exit(1);

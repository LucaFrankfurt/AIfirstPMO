import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, any>;

export const db = new DatabaseSync(env.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
`);

db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` cannot
 * add them to a database that already exists, so they are applied here — an
 * upgrade stays a restart.
 */
for (const [table, column, definition] of [
  ['users', 'email_prefs', `TEXT NOT NULL DEFAULT 'important'`],
  ['users', 'email_verified_at', 'INTEGER'],
  ['users', 'locale', 'TEXT'],
  ['notifications', 'emailed_at', 'INTEGER'],
  ['files', 'storage', `TEXT NOT NULL DEFAULT 'disk'`],
  ['views', 'show_done', 'INTEGER NOT NULL DEFAULT 1'],
  ['tasks', 'type_id', 'TEXT'],
  ['tasks', 'recurrence', 'TEXT'],
  ['tasks', 'recurred_from', 'TEXT'],
  ['users', 'digest', `TEXT NOT NULL DEFAULT 'off'`],
  ['users', 'totp_secret', 'TEXT'],
  ['users', 'totp_confirmed_at', 'INTEGER'],
  ['users', 'recovery_codes', `TEXT NOT NULL DEFAULT '[]'`],
  ['automations', 'trigger_days', 'INTEGER NOT NULL DEFAULT 1'],
  ['automations', 'action_kind', `TEXT NOT NULL DEFAULT 'file_template'`],
  ['automations', 'action_patch', `TEXT NOT NULL DEFAULT '{}'`],
  ['automations', 'last_run_day', 'TEXT'],
  ['pages', 'labels', `TEXT NOT NULL DEFAULT '[]'`],
  ['pages', 'watchers', `TEXT NOT NULL DEFAULT '[]'`],
  ['pages', 'is_template', 'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'parent_id', 'TEXT'],
  ['states', 'wip_limit', 'INTEGER NOT NULL DEFAULT 0'],
  ['states', 'allowed_roles', `TEXT NOT NULL DEFAULT '[]'`],
  ['comments', 'anchor', 'TEXT'],
  ['webhooks', 'direction', `TEXT NOT NULL DEFAULT 'out'`],
  ['webhooks', 'format', `TEXT NOT NULL DEFAULT 'kolibri'`],
  ['webhooks', 'created_by', 'TEXT'],
  ['projects', 'default_view_id', 'TEXT'],
  ['notifications', 'project_id', 'TEXT'],
  ['task_relations', 'lag', 'INTEGER NOT NULL DEFAULT 0'],
  ['comments', 'guest_name', 'TEXT'],
  ['shares', 'allow_comments', 'INTEGER NOT NULL DEFAULT 0'],
  ['pages', 'body', 'TEXT'],
  ['projects', 'working_days', `TEXT NOT NULL DEFAULT '[1,2,3,4,5]'`],
  ['users', 'telegram_chat_id', 'TEXT'],
  ['users', 'telegram_prefs', `TEXT NOT NULL DEFAULT 'all'`],
  ['users', 'telegram_linked_at', 'INTEGER'],
  ['notifications', 'telegram_sent_at', 'INTEGER'],
  ['notifications', 'telegram_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['notifications', 'telegram_error', 'TEXT'],
  ['notifications', 'channel_id', 'TEXT'],
  ['channels', 'invite_policy', `TEXT NOT NULL DEFAULT 'members'`],
  ['messages', 'reactions', `TEXT NOT NULL DEFAULT '{}'`],
  // An access token granted through OAuth is an API token like any other, so it
  // lives in the same table — which means it appears in Settings beside the
  // rest and the same Revoke button stops it. These two columns are what a
  // hand-made token does not have: who it was granted to, and the refresh token
  // that mints the next one.
  ['api_tokens', 'client_id', 'TEXT'],
  ['api_tokens', 'refresh_hash', 'TEXT'],
  // Added without UNIQUE, because SQLite cannot add a unique column to a table
  // that already has rows. The index below is the constraint instead, and it
  // is the same constraint — it is how SQLite implements UNIQUE anyway.
  ['users', 'calendar_token', 'TEXT'],
  ['projects', 'is_container', 'INTEGER NOT NULL DEFAULT 0'],
] as const) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_calendar_token ON users (calendar_token) WHERE calendar_token IS NOT NULL`);

/**
 * `files` was keyed by hash alone, and a hash is not a row.
 *
 * Uploads are content-addressed, so two workspaces sending identical bytes
 * share the stored object — and with `hash` as the whole primary key they also
 * shared the one row, which belongs to whoever uploaded first. The second
 * uploader got no row, and then a 403 reading back the file they had just
 * sent. The key is `(hash, workspace_id)` now; the blob is still stored once.
 *
 * Detected by asking whether `hash` is still the sole key, so a restart on an
 * already-migrated database costs one pragma.
 */
{
  const info = db.prepare(`PRAGMA table_info(files)`).all() as { name: string; pk: number }[];
  const keyed = info.filter((c) => c.pk > 0).map((c) => c.name);
  if (keyed.length === 1 && keyed[0] === 'hash') {
    const columns = info.map((c) => c.name).join(', ');
    db.exec('BEGIN IMMEDIATE');
    try {
      const create = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'`).get() as { sql: string }).sql;
      db.exec(create
        .replace(/\bfiles\b/, 'files__rekeying')
        .replace(/hash\s+TEXT\s+PRIMARY KEY/i, 'hash TEXT NOT NULL')
        .replace(/\)\s*$/, ', PRIMARY KEY (hash, workspace_id))'));
      db.exec(`INSERT INTO files__rekeying (${columns}) SELECT ${columns} FROM files`);
      db.exec('DROP TABLE files');
      db.exec('ALTER TABLE files__rekeying RENAME TO files');
      db.exec('CREATE INDEX IF NOT EXISTS files_workspace ON files (workspace_id)');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Columns that were `NOT NULL` and should not have been.
 *
 * SQLite cannot relax a constraint in place, so the table is rebuilt — the
 * standard copy, drop, rename — and only when `PRAGMA table_info` still shows
 * the old one, so a restart on an already-migrated database costs one pragma
 * and nothing else.
 *
 * The case is chat. A direct conversation belongs to no workspace, and neither
 * do the messages in it or the notifications about them: two people may share
 * no workspace, or several, and filing their conversation under one of them
 * would make it disappear the moment either switched. See `crossWorkspace` in
 * the entity registry.
 */
let rebuilt = false;
for (const [table, column] of [
  ['channels', 'workspace_id'],
  ['messages', 'workspace_id'],
  ['channel_reads', 'workspace_id'],
  ['notifications', 'workspace_id'],
] as const) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
  if (!info.some((c) => c.name === column && c.notnull)) continue;
  const create = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }).sql;
  const columns = info.map((c) => c.name).join(', ');
  const relaxed = create
    .replace(new RegExp(`^(\\s*${column}\\s+\\w+)\\s+NOT NULL`, 'im'), '$1')
    .replace(new RegExp(`\\b${table}\\b`), `${table}__relaxing`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(relaxed);
    db.exec(`INSERT INTO ${table}__relaxing (${columns}) SELECT ${columns} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__relaxing RENAME TO ${table}`);
    db.exec('COMMIT');
    rebuilt = true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
if (rebuilt) {
  // Dropping a table takes its indexes with it. The schema is `IF NOT EXISTS`
  // throughout, so running it again puts those back and changes nothing else.
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  // And a conversation written before any of this belongs outside a workspace
  // now, along with what was said in it — otherwise the same instance would
  // hold two kinds of direct message and only the new ones would work.
  db.exec(`
    UPDATE channels SET workspace_id = NULL WHERE kind = 'direct' AND workspace_id IS NOT NULL;
    UPDATE messages SET workspace_id = NULL
     WHERE workspace_id IS NOT NULL
       AND channel_id IN (SELECT id FROM channels WHERE kind = 'direct');
    UPDATE channel_reads SET workspace_id = NULL
     WHERE workspace_id IS NOT NULL
       AND channel_id IN (SELECT id FROM channels WHERE kind = 'direct');
  `);
}

const stmtCache = new Map<string, StatementSync>();

function prepare(sql: string): StatementSync {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

/** SQLite only speaks null/number/string/bigint/buffer — normalise the rest. */
type SqlValue = null | number | bigint | string | Uint8Array;

function coerce(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as SqlValue;
}

const args = (params: unknown[]): SqlValue[] => params.map(coerce);

export const all = <T = Row>(sql: string, ...params: unknown[]): T[] =>
  prepare(sql).all(...args(params)) as T[];

export const get = <T = Row>(sql: string, ...params: unknown[]): T | undefined =>
  prepare(sql).get(...args(params)) as T | undefined;

export const run = (sql: string, ...params: unknown[]) => prepare(sql).run(...args(params));

export const pluck = <T = unknown>(sql: string, ...params: unknown[]): T | undefined => {
  const row = get<Row>(sql, ...params);
  return row ? (Object.values(row)[0] as T) : undefined;
};

/** Runs `fn` in a transaction; nested calls join the outer transaction. */
let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    depth--;
  }
}

/**
 * Global monotonic change counter. Sync cursors are values of this counter, so
 * "give me everything after X" is a single indexed range scan per table.
 */
export function nextSeq(): number {
  run(`INSERT INTO counters (name, value) VALUES ('seq', 1)
       ON CONFLICT (name) DO UPDATE SET value = value + 1`);
  return Number(pluck<number>(`SELECT value FROM counters WHERE name = 'seq'`) ?? 1);
}

export const currentSeq = (): number => Number(pluck<number>(`SELECT value FROM counters WHERE name = 'seq'`) ?? 0);

/** Idempotent column addition, so upgrades never need a migration runner. */
export function ensureColumn(table: string, column: string, definition: string): void {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function columnsOf(table: string): string[] {
  return all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
}

export function close(): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  db.close();
}

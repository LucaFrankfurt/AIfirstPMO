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
] as const) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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

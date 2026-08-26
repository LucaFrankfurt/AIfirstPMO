/**
 * Putting a snapshot back **into a running instance**.
 *
 * `restore.ts` next door swaps the database file under a stopped process. That
 * is the right operation when an instance has gone wrong and somebody is at a
 * terminal. It is the wrong shape for the case this exists for: a fresh
 * instance, deployed somewhere new, that has to become the old one — because
 * there the operator is in a browser, there may be no terminal at all (a
 * hosted container, a PaaS), and "stop the server first" is advice nobody can
 * follow through a web page.
 *
 * So this does not touch the file. It **attaches** the snapshot and replaces
 * the contents of every table in one transaction. That turns out to be better
 * than a file swap in three ways beyond not needing a restart:
 *
 *   - **An older snapshot still restores.** Rows are copied through the
 *     columns the two databases have *in common*, so a column added since is
 *     left at its default rather than making the whole file unreadable.
 *   - **It is all or nothing.** A transaction either lands or rolls back; a
 *     half-copied file is a thing somebody discovers later.
 *   - **The uploads follow the instance's own storage.** A snapshot taken on a
 *     disk instance restores into an S3 one, because the blobs are put through
 *     `storage` rather than copied into a directory.
 *
 * Two guarantees worth stating, because they are what make a button safe:
 *
 *   - **The snapshot is never written to.** It is copied to a temporary file
 *     and *that* is attached — attaching read-write is enough to leave a
 *     write-ahead log beside somebody's only backup.
 *   - **What is replaced is snapshotted first**, where the instance is
 *     configured for backups. Restoring the wrong file is exactly the moment
 *     somebody needs the previous state, and it is the moment it has just
 *     stopped existing.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, all, pluck, run, tx, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { take } from './backups.ts';
import { reindex } from './maintenance.ts';
import * as storage from './storage.ts';

export interface RehydrateReport {
  /** Where it came from, as the caller named it. */
  from: string;
  /** Rows written, per table, for the tables that carried any. */
  rows: Record<string, number>;
  /** Rows put back into the search index afterwards. */
  indexed: number;
  files: { restored: number; alreadyThere: number; missing: number };
  /** Tables in the snapshot this build no longer has, named rather than counted. */
  ignored: string[];
  /** The snapshot taken of what was replaced, when one could be. */
  replaced?: string;
}

/**
 * Tables that are not data.
 *
 * `search_index` is an FTS5 virtual table with four shadow tables behind it;
 * copying those by hand is how an index ends up describing rows that are not
 * there. It is rebuilt from the restored tables instead, which is also the
 * only way to be sure it matches them.
 */
const isCopyable = (name: string): boolean =>
  !name.startsWith('sqlite_') && !name.startsWith('search_index');

const tablesIn = (schema: string): string[] =>
  all<Row>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' ORDER BY name`)
    .map((row) => String(row.name))
    .filter(isCopyable);

const columnsOf = (schema: string, table: string): string[] =>
  (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((column) => column.name);

/** Whether this instance has anything somebody would miss. */
export function isUnused(): boolean {
  const users = Number(pluck<number>(`SELECT count(*) FROM users`) ?? 0);
  const tasks = Number(pluck<number>(`SELECT count(*) FROM tasks WHERE deleted_at IS NULL`) ?? 0);
  const pages = Number(pluck<number>(`SELECT count(*) FROM pages WHERE deleted_at IS NULL`) ?? 0);
  // One account and nothing written is a freshly claimed instance: whoever
  // registered a minute ago to be able to press this button. More than that is
  // somebody's work, and the confirmation in front of this says so.
  return users <= 1 && tasks === 0 && pages === 0;
}

/** What a snapshot holds, without restoring it. */
export function inspect(dir: string): { counts: Record<string, number>; uploads: number; manifest: Record<string, unknown> | null } {
  const database = join(dir, 'kolibri.sqlite');
  if (!existsSync(database)) throw new Error('That is not a Kolibri snapshot — there is no kolibri.sqlite in it');

  const staged = stage(database);
  try {
    attach(staged);
    const counts: Record<string, number> = {};
    for (const table of ['users', 'workspaces', 'projects', 'tasks', 'pages', 'comments', 'files']) {
      if (!tablesIn('snap').includes(table)) continue;
      counts[table] = Number(pluck<number>(`SELECT count(*) FROM snap.${table}`) ?? 0);
    }
    return { counts, uploads: countUploads(dir), manifest: readManifest(dir) };
  } finally {
    detach();
    rmSync(staged, { recursive: true, force: true });
  }
}

/**
 * Replace everything in this instance with what is in the snapshot.
 *
 * Afterwards every device is signed out, because `sessions` is one of the
 * tables that was replaced. That is not a side effect to apologise for — it is
 * the mechanism: a client meeting a 401 clears its local copy and downloads
 * again, which is exactly what a device holding a newer sync cursor than the
 * restored data must be made to do.
 */
export function rehydrate(dir: string, options: { safetyBackup?: boolean } = {}): RehydrateReport {
  const database = join(dir, 'kolibri.sqlite');
  if (!existsSync(database)) throw new Error('That is not a Kolibri snapshot — there is no kolibri.sqlite in it');

  const staged = stage(database);
  const report: RehydrateReport = {
    from: dir,
    rows: {},
    indexed: 0,
    files: { restored: 0, alreadyThere: 0, missing: 0 },
    ignored: [],
  };

  try {
    attach(staged);

    // Checked before anything here is touched, and on the copy that is about
    // to be read rather than on the original — those are the same bytes, but
    // only one of them is the file this is going to trust.
    const integrity = all<Row>(`PRAGMA snap.integrity_check`).map((row) => String(row.integrity_check));
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new Error(`That snapshot is damaged and was not restored: ${integrity.join('; ')}`);
    }
    const theirs = tablesIn('snap');
    if (!theirs.includes('workspaces') || !theirs.includes('users')) {
      throw new Error('That database is not a Kolibri snapshot');
    }

    const mine = tablesIn('main');
    report.ignored = theirs.filter((table) => !mine.includes(table));

    if (options.safetyBackup !== false) report.replaced = keepWhatIsHere();

    tx(() => {
      for (const table of mine) {
        // A table this build has and the snapshot does not is emptied rather
        // than left alone: a restore that leaves yesterday's rows in one table
        // has not restored anything, it has merged two instances.
        run(`DELETE FROM main.${table}`);
        if (!theirs.includes(table)) continue;

        // The columns both sides agree on. An older snapshot is missing the
        // ones added since — they take their defaults — and a newer one has
        // columns this build cannot store, which are dropped rather than
        // refused: half a restore is better than none, and the alternative is
        // an instance that will not start at all.
        const shared = columnsOf('main', table).filter((column) => columnsOf('snap', table).includes(column));
        if (!shared.length) continue;
        const list = shared.map((column) => `"${column}"`).join(', ');
        run(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM snap.${table}`);
        const written = Number(pluck<number>(`SELECT count(*) FROM main.${table}`) ?? 0);
        if (written) report.rows[table] = written;
      }
    });
  } finally {
    detach();
    rmSync(staged, { recursive: true, force: true });
  }

  // Outside the transaction: the index is derived, so rebuilding it is a
  // repair rather than part of the write, and a failure here leaves an
  // instance whose data is right and whose search is one `kolibri reindex`
  // away from being right.
  report.indexed = reindex();
  return report;
}

/**
 * Put the snapshot's uploads into whichever store this instance uses.
 *
 * After the tables, and driven by them: every blob is looked up by the `files`
 * row that now refers to it, so the content type is the one recorded rather
 * than one guessed from a file extension. A snapshot taken on a disk instance
 * therefore restores into an S3 one without anybody converting anything.
 */
export async function restoreUploads(dir: string): Promise<RehydrateReport['files']> {
  const result = { restored: 0, alreadyThere: 0, missing: 0 };
  const source = join(dir, 'uploads');
  if (!existsSync(source)) {
    // Nothing in the snapshot. On an instance whose blobs live in an object
    // store that is correct and expected — they never left it.
    return result;
  }

  for (const row of all<Row>(`SELECT hash, mime FROM files`)) {
    const key = storage.keyFor(String(row.hash), String(row.mime));
    const path = join(source, key);
    if (!existsSync(path)) { result.missing++; continue; }
    if (await storage.exists(key)) { result.alreadyThere++; continue; }
    await storage.put(key, readFileSync(path), String(row.mime));
    result.restored++;
  }
  return result;
}

/* ------------------------------------------------------------------ plumbing */

/**
 * A copy of the snapshot, for this to attach.
 *
 * Attaching the original would be read-only in intent and read-write in fact:
 * SQLite is entitled to write a journal beside any database it opens, and
 * doing that to somebody's only backup while restoring from it is the sort of
 * thing that is discovered on the second restore.
 */
function stage(database: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'kolibri-restore-'));
  const copy = join(directory, 'snapshot.sqlite');
  copyFileSync(database, copy);
  return directory;
}

const attach = (staged: string): void => {
  detach(); // a previous attempt that threw before its own detach
  db.exec(`ATTACH DATABASE '${join(staged, 'snapshot.sqlite').replace(/'/g, "''")}' AS snap`);
};

const detach = (): void => {
  try { db.exec(`DETACH DATABASE snap`); } catch { /* was not attached */ }
};

/**
 * A snapshot of what is about to be replaced.
 *
 * Best effort on purpose: an instance with no backup directory configured
 * should still be able to restore into itself, and refusing over the absence
 * of somewhere to put a safety copy would block the fresh-deployment case this
 * whole thing exists for. What it cannot do is fail silently — the report says
 * whether there is one, and the screen repeats it before anybody agrees.
 */
function keepWhatIsHere(): string | undefined {
  if (!env.backup.dir) return undefined;
  try {
    const done = take(env.backup.dir, { force: true });
    return done?.snapshot.name;
  } catch {
    return undefined;
  }
}

const countUploads = (dir: string): number => {
  const source = join(dir, 'uploads');
  if (!existsSync(source)) return 0;
  let total = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name));
      else total++;
    }
  };
  walk(source);
  return total;
};

function readManifest(dir: string): Record<string, unknown> | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

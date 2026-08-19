/**
 * Putting a snapshot back.
 *
 * This module never imports the database, on purpose: opening it would create
 * the very file the restore is about to replace, and a restore that has to
 * argue with a half-open handle is a restore that goes wrong at the worst
 * possible moment. Everything here is files.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { env } from '../env.ts';

export interface RestoreReport {
  from: string;
  database: string;
  uploads: 'restored' | 'not in the snapshot' | 'in the object store';
  /** Where anything that was already there was moved, if it was. */
  displaced?: string;
  manifest: Record<string, unknown> | null;
}

/** Read the snapshot's own account of itself, if it has one. */
export function readManifest(dir: string): Record<string, unknown> | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Check a snapshot before anything is replaced by it.
 *
 * Opening the copy read-only and asking SQLite whether it is intact is the only
 * way to know the snapshot is worth restoring — and the moment to find out is
 * before the live database has been moved aside, not after.
 */
export function verify(dir: string): { database: string; rows: Record<string, number> } {
  const database = join(dir, 'kolibri.sqlite');
  if (!existsSync(database)) throw new Error(`No kolibri.sqlite in ${dir} — is that a Kolibri snapshot?`);

  const copy = new DatabaseSync(database, { readOnly: true });
  try {
    const integrity = copy.prepare(`PRAGMA integrity_check`).all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`The snapshot is damaged: ${integrity.map((r) => r.integrity_check).join('; ')}`);
    }
    const rows: Record<string, number> = {};
    for (const table of ['users', 'workspaces', 'projects', 'tasks', 'pages']) {
      const row = copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | undefined;
      rows[table] = Number(row?.n ?? 0);
    }
    return { database, rows };
  } finally {
    copy.close();
  }
}

/**
 * Replace this instance's data with a snapshot.
 *
 * The server must not be running: SQLite would go on writing into a file that
 * is no longer there. What is already in place is moved aside rather than
 * deleted, because the moment somebody restores the wrong snapshot is the
 * moment they need the old one back.
 */
export function restore(dir: string, options: { force?: boolean } = {}): RestoreReport {
  const { database } = verify(dir);

  let displaced: string | undefined;
  if (existsSync(env.dbFile)) {
    if (!options.force) {
      throw new Error(
        `${env.dbFile} already exists. Stop the server and pass --force to replace it (the old one is kept alongside).`,
      );
    }
    displaced = `${env.dbFile}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(env.dbFile, displaced);
  }
  // A write-ahead log belonging to the database that was just moved away would
  // be replayed into the new one. Both siblings go.
  for (const suffix of ['-wal', '-shm']) rmSync(`${env.dbFile}${suffix}`, { force: true });

  mkdirSync(dirname(env.dbFile), { recursive: true });
  copyFileSync(database, env.dbFile);

  let uploads: RestoreReport['uploads'] = 'not in the snapshot';
  const source = join(dir, 'uploads');
  if (existsSync(source)) {
    mkdirSync(env.uploadDir, { recursive: true });
    // Uploads are content-addressed, so merging rather than replacing is safe:
    // a name that exists in both holds the same bytes by construction.
    cpSync(source, env.uploadDir, { recursive: true, force: false, errorOnExist: false });
    uploads = 'restored';
  } else if (readManifest(dir)?.storage === 's3') {
    uploads = 'in the object store';
  }

  return { from: dir, database: env.dbFile, uploads, displaced, manifest: readManifest(dir) };
}

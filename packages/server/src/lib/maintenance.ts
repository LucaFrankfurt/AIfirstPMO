/**
 * Maintenance: check the database, repair what is safe to repair, and take a
 * snapshot that can actually be put back.
 *
 * Everything here is written to be run against a *live* instance. The one
 * exception is a restore, which replaces files under a stopped process and so
 * lives in `restore.ts` — a module that deliberately never opens the database.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, all, pluck, run, type Row } from '../db/index.ts';
import { ENTITIES, crdt, type CrdtState, type EntityName } from '@kolibri/shared';
import { env } from '../env.ts';
import { indexForSearch, SEARCHABLE } from './repo.ts';
import { keyFor } from './storage.ts';
import * as storage from './storage.ts';

export type Level = 'ok' | 'warn' | 'fail';

export interface Finding {
  /** Short name of what was looked at. */
  check: string;
  level: Level;
  detail: string;
  /** Whether `--fix` knows how to deal with it. */
  fixable?: boolean;
}

const ok = (check: string, detail: string): Finding => ({ check, level: 'ok', detail });

/* --------------------------------------------------------------- the checks */

/** Tables that carry rows people would notice the loss of. */
const COUNTED = ['users', 'workspaces', 'projects', 'tasks', 'pages', 'comments', 'files', 'time_entries'] as const;

export function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of COUNTED) out[table] = Number(pluck<number>(`SELECT count(*) FROM ${table}`) ?? 0);
  return out;
}

/** The tables the search index is built from, with their entity name. */
const searchableTables = (): [EntityName, string][] =>
  (Object.keys(SEARCHABLE) as EntityName[]).map((entity) => [entity, ENTITIES[entity].table]);

/**
 * Rows that should be in the search index and are not, and index rows whose
 * subject is gone. Both directions matter: the first loses results, the second
 * hands out links to rows that no longer exist.
 */
export function searchDrift(): { missing: number; stale: number } {
  let missing = 0;
  for (const [entity, table] of searchableTables()) {
    missing += Number(pluck<number>(
      `SELECT count(*) FROM ${table} t
        WHERE t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM search_index s WHERE s.kind = ? AND s.ref_id = t.id)`,
      entity,
    ) ?? 0);
  }

  const byKind = new Map(searchableTables());
  let stale = 0;
  for (const row of all<{ kind: string; count: number }>(`SELECT kind, count(*) AS count FROM search_index GROUP BY kind`)) {
    const table = byKind.get(row.kind as EntityName);
    // A kind nobody indexes any more is stale in its entirety.
    if (!table) { stale += Number(row.count); continue; }
    stale += Number(pluck<number>(
      `SELECT count(*) FROM search_index s
        WHERE s.kind = ?
          AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = s.ref_id AND t.deleted_at IS NULL)`,
      row.kind,
    ) ?? 0);
  }
  return { missing, stale };
}

/** How much of the file is empty space waiting to be reused. */
export function freeSpace(): { total: number; free: number } {
  const pageSize = Number(pluck<number>(`PRAGMA page_size`) ?? 4096);
  const pages = Number(pluck<number>(`PRAGMA page_count`) ?? 0);
  const freePages = Number(pluck<number>(`PRAGMA freelist_count`) ?? 0);
  return { total: pages * pageSize, free: freePages * pageSize };
}

export const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Rows the housekeeping sweep would delete if the server were running. */
export function prunable(now = Date.now()): { sessions: number; mutations: number; emails: number } {
  const month = now - 30 * 86_400_000;
  return {
    sessions: Number(pluck<number>(`SELECT count(*) FROM sessions WHERE expires_at < ?`, now) ?? 0),
    mutations: Number(pluck<number>(`SELECT count(*) FROM applied_mutations WHERE applied_at < ?`, month) ?? 0),
    emails: Number(pluck<number>(`SELECT count(*) FROM email_queue WHERE sent_at IS NOT NULL AND sent_at < ?`, month) ?? 0),
  };
}

/**
 * Everything the database can say about itself. Storage lives in its own
 * function because it talks to a network in the S3 case, and a check that can
 * hang is a check people learn to skip.
 */
export function check(now = Date.now()): Finding[] {
  const findings: Finding[] = [];

  const integrity = all<{ integrity_check: string }>(`PRAGMA integrity_check`).map((r) => r.integrity_check);
  findings.push(integrity.length === 1 && integrity[0] === 'ok'
    ? ok('integrity', 'the database is internally consistent')
    : { check: 'integrity', level: 'fail', detail: integrity.join('; ') });

  const orphans = all<Record<string, unknown>>(`PRAGMA foreign_key_check`);
  findings.push(orphans.length === 0
    ? ok('references', 'every row points at something that exists')
    : {
      check: 'references',
      level: 'fail',
      // Naming the tables is the difference between a number and a next step.
      detail: `${orphans.length} row(s) point at something gone: ${[...new Set(orphans.map((o) => String(o.table)))].join(', ')}`,
    });

  const drift = searchDrift();
  findings.push(drift.missing === 0 && drift.stale === 0
    ? ok('search', 'the index matches the tables')
    : {
      check: 'search',
      level: 'warn',
      detail: `${drift.missing} row(s) missing from the index, ${drift.stale} stale entr(ies) in it`,
      fixable: true,
    });

  const { total, free } = freeSpace();
  // A tenth of the file is the point where a vacuum is worth the pause it costs.
  findings.push(free > total / 10 && free > 8 * 1_048_576
    ? { check: 'size', level: 'warn', detail: `${mb(free)} of ${mb(total)} is free space that a vacuum would return`, fixable: true }
    : ok('size', `${mb(total)}, of which ${mb(free)} is free space`));

  const wal = `${env.dbFile}-wal`;
  const walSize = existsSync(wal) ? statSync(wal).size : 0;
  findings.push(walSize > 256 * 1_048_576
    ? { check: 'wal', level: 'warn', detail: `the write-ahead log is ${mb(walSize)}; a checkpoint would fold it back in`, fixable: true }
    : ok('wal', `write-ahead log ${mb(walSize)}`));

  const stale = prunable(now);
  const total_stale = stale.sessions + stale.mutations + stale.emails;
  findings.push(total_stale === 0
    ? ok('housekeeping', 'nothing expired is still lying around')
    : {
      check: 'housekeeping',
      level: 'warn',
      detail: `${stale.sessions} expired session(s), ${stale.mutations} old mutation record(s), ${stale.emails} sent message(s)`,
      fixable: true,
    });

  return findings;
}

/**
 * Blobs, checked in both directions: a row whose bytes are gone is a broken
 * download, and bytes with no row are space nobody can reach.
 */
export async function checkStorage(): Promise<Finding[]> {
  const rows = all<{ hash: string; mime: string; storage: string }>(`SELECT hash, mime, storage FROM files`);
  const missing: string[] = [];
  for (const row of rows) {
    if (!(await storage.exists(keyFor(row.hash, row.mime), row.storage as 'disk' | 's3'))) missing.push(row.hash);
  }

  const findings: Finding[] = [missing.length === 0
    ? ok('files', `${rows.length} file(s), every one of them readable`)
    : { check: 'files', level: 'fail', detail: `${missing.length} of ${rows.length} file(s) have a row but no bytes: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}` }];

  // Only the disk backend can be walked cheaply; listing a bucket is a paged
  // API call per thousand objects and belongs behind an explicit command.
  if (existsSync(env.uploadDir)) {
    const known = new Set(rows.filter((r) => r.storage === 'disk').map((r) => keyFor(r.hash, r.mime)));
    let orphans = 0;
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (!known.has(rel)) orphans++;
      }
    };
    walk(env.uploadDir, '');
    findings.push(orphans === 0
      ? ok('uploads', 'no unreferenced files on disk')
      : { check: 'uploads', level: 'warn', detail: `${orphans} file(s) on disk that no row points at` });
  }

  return findings;
}

/* --------------------------------------------------------------- the repairs */

/** Rebuild the whole search index from the tables it is derived from. */
export function reindex(): number {
  let indexed = 0;
  db.exec(`DELETE FROM search_index`);
  for (const [entity, table] of searchableTables()) {
    for (const row of all(`SELECT * FROM ${table} WHERE deleted_at IS NULL`)) {
      // Counted only when it went in: an archived row is walked and skipped,
      // and reporting it as indexed would make the number a row count.
      if (indexForSearch(entity, row)) indexed++;
    }
  }
  return indexed;
}

export function prune(now = Date.now()): { sessions: number; mutations: number; emails: number } {
  const before = prunable(now);
  const month = now - 30 * 86_400_000;
  run(`DELETE FROM sessions WHERE expires_at < ?`, now);
  run(`DELETE FROM applied_mutations WHERE applied_at < ?`, month);
  run(`DELETE FROM email_queue WHERE sent_at IS NOT NULL AND sent_at < ?`, month);
  return before;
}

/**
 * Fold away the tombstones in page bodies.
 *
 * A page body is a CRDT, and every character anybody has ever deleted is still
 * in it — that is what lets a device that was offline for a week merge without
 * resurrecting text. It is also unbounded: a page rewritten fifty times carries
 * fifty drafts nobody will ever read.
 *
 * There is no safe automatic moment for this. "Every device has seen the
 * delete" is not knowable in an offline-first system, and dropping a tombstone
 * a device still refers to means its pending insert lands at the start of the
 * page instead of where it was typed. So it is a `--fix` and not a sweep: a
 * person, on a Tuesday, who knows whether anybody has been away for a month.
 * Tombstones something visible still points at are kept regardless.
 */
export function compactPages(): { pages: number; saved: number } {
  let pages = 0;
  let saved = 0;
  for (const row of all<Row>(`SELECT id, body FROM pages WHERE body IS NOT NULL AND deleted_at IS NULL`)) {
    const before = String(row.body ?? '');
    let state: CrdtState;
    try {
      state = JSON.parse(before) as CrdtState;
    } catch {
      continue;
    }
    const text = crdt.textOf(state);
    const after = JSON.stringify(crdt.compact(state));
    if (after.length >= before.length) continue;
    // Belt and braces: a compaction that changed what the page says would be a
    // bug in the CRDT, and finding out here is much better than finding out
    // from whoever wrote the page.
    if (crdt.textOf(JSON.parse(after) as CrdtState) !== text) continue;
    run(`UPDATE pages SET body = ? WHERE id = ?`, after, row.id);
    pages++;
    saved += before.length - after.length;
  }
  return { pages, saved };
}

/** Fold the write-ahead log back in and give the free pages back to the disk. */
export function vacuum(): { before: number; after: number } {
  const before = freeSpace().total;
  db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  db.exec(`VACUUM`);
  return { before, after: freeSpace().total };
}

/* --------------------------------------------------------------- the backup */

export interface Manifest {
  kolibri: string;
  created_at: string;
  seq: number;
  storage: string;
  counts: Record<string, number>;
  /** Whether the uploads in this snapshot are the whole set. */
  uploads: 'included' | 'in the object store';
}

/**
 * A snapshot that can be put back.
 *
 * `VACUUM INTO` is the only way to copy a live SQLite database that is
 * guaranteed consistent: it is a read transaction, so a write during the copy
 * lands after it rather than half inside it. Copying the file with `cp` while
 * the server is running is the classic way to take a backup that restores into
 * a corrupt database.
 */
export function backup(dir: string, now = new Date()): Manifest {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'kolibri.sqlite');
  if (existsSync(target)) rmSync(target);
  db.prepare(`VACUUM INTO ?`).run(target);

  const onDisk = env.storage.kind === 'disk';
  if (onDisk && existsSync(env.uploadDir)) {
    cpSync(env.uploadDir, join(dir, 'uploads'), { recursive: true });
  }

  const manifest: Manifest = {
    kolibri: '0.1.0',
    created_at: now.toISOString(),
    seq: Number(pluck<number>(`SELECT value FROM counters WHERE name = 'seq'`) ?? 0),
    storage: env.storage.kind,
    counts: counts(),
    uploads: onDisk ? 'included' : 'in the object store',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/* ------------------------------------------------------- moving the uploads */

/**
 * Move every blob to a backend, row by row, and record where it now lives.
 *
 * The row is updated only after the bytes have arrived, and the source copy is
 * left alone: an interrupted move leaves an instance that still works, which is
 * worth more than the space the duplicates take.
 */
export async function moveFiles(
  to: 'disk' | 's3',
  onProgress?: (done: number, total: number, hash: string) => void,
): Promise<{ moved: number; already: number; failed: string[] }> {
  const rows = all<{ hash: string; mime: string; storage: string }>(`SELECT hash, mime, storage FROM files`);
  const failed: string[] = [];
  let moved = 0;
  let already = 0;

  for (const [index, row] of rows.entries()) {
    onProgress?.(index + 1, rows.length, row.hash);
    if (row.storage === to) { already++; continue; }
    const key = keyFor(row.hash, row.mime);
    try {
      const source = await storage.read(key, row.storage as 'disk' | 's3');
      if (!source) { failed.push(row.hash); continue; }
      const chunks: Buffer[] = [];
      for await (const chunk of source.stream) chunks.push(chunk as Buffer);
      await storage.put(key, Buffer.concat(chunks), row.mime, to);
      run(`UPDATE files SET storage = ? WHERE hash = ?`, to, row.hash);
      moved++;
    } catch {
      failed.push(row.hash);
    }
  }
  return { moved, already, failed };
}

/** Blobs still held by the backend that is no longer in use. */
export function strandedFiles(): number {
  return Number(pluck<number>(`SELECT count(*) FROM files WHERE storage <> ?`, env.storage.kind) ?? 0);
}

export const worst = (findings: Finding[]): Level =>
  findings.some((f) => f.level === 'fail') ? 'fail' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';

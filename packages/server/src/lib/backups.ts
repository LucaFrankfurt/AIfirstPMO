/**
 * Backups that happen without anybody remembering to take them.
 *
 * `kolibri backup` has always been there and has always worked. What was
 * missing is the part that decides *when* — which in practice meant a cron
 * entry somebody wrote once, on a host somebody has since rebuilt, running a
 * command nobody has verified since. The commonest backup failure is not a
 * corrupt snapshot; it is a snapshot that stopped being taken in March.
 *
 * So: the hourly sweep takes one, keeps a stated number of them, and can push
 * a copy somewhere that is not this disk. Everything here is deliberately
 * boring and idempotent — a snapshot is named for the day it covers, so a
 * restart, a double tick or a clock jump costs nothing.
 *
 * Three things this does **not** do, each on purpose:
 *
 *   - **Restore.** SQLite must not be open when its file is replaced, so a
 *     restore is a command run against a stopped server. A button that could
 *     only ever half-work is worse than a documented command.
 *   - **Prune the offsite blobs.** They are content-addressed and shared by
 *     every snapshot, so "delete the ones this snapshot used" is wrong for any
 *     snapshot older than it. They are cheap and they are the part you cannot
 *     regenerate; deleting them stays a decision somebody makes on purpose.
 *   - **Encrypt.** The snapshot is exactly as readable as the database it came
 *     from. Where that matters, it is the volume or the bucket that should be
 *     encrypted, by somebody who knows where the key lives.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env } from '../env.ts';
import { backup as takeSnapshot, mb, type Manifest } from './maintenance.ts';
import { readManifest, verify } from './restore.ts';
import * as s3 from './s3.ts';

/**
 * A snapshot is named for the day it covers: `2026-08-26`.
 *
 * The **local** day, because the hour it is taken at is a local hour and an
 * operator looking at a list of backups is looking at their own calendar. Read
 * off the parts rather than through `toISOString`, which would shift the date
 * by one for half the world and name Tuesday morning's snapshot "Monday".
 */
export const nameFor = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** Names we are willing to touch. Everything else in the directory is not ours. */
const SAFE_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{4})?$/;

export interface Snapshot {
  name: string;
  path: string;
  /** Bytes on disk, database and any copied uploads together. */
  size: number;
  created_at: string | null;
  counts: Record<string, number>;
  uploads: string;
  /** Whether the database in it opens and passes an integrity check. */
  intact?: boolean;
  problem?: string;
}

const sizeOf = (path: string): number => {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? sizeOf(child) : statSync(child).size;
  }
  return total;
};

/**
 * The snapshots in a directory, newest first.
 *
 * A directory with no `manifest.json` is not one of ours and is left out
 * rather than listed as a broken backup — the directory may well be somebody's
 * own, and an operator reading a list of backups should see backups.
 */
export function snapshots(dir = env.backup.dir): Snapshot[] {
  if (!dir || !existsSync(dir)) return [];
  const out: Snapshot[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (!existsSync(join(path, 'manifest.json'))) continue;
    const manifest = (readManifest(path) ?? {}) as Partial<Manifest>;
    out.push({
      name: entry.name,
      path,
      size: sizeOf(path),
      created_at: manifest.created_at ?? null,
      counts: manifest.counts ?? {},
      uploads: manifest.uploads ?? 'unknown',
    });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** The path a name refers to, or null when the name is not one of ours. */
export function pathOf(name: string, dir = env.backup.dir): string | null {
  if (!dir || !SAFE_NAME.test(name)) return null;
  const path = resolve(join(dir, name));
  // Belt as well as braces: the pattern above already forbids a separator, and
  // this is the check that stays right if the pattern is ever relaxed.
  if (!path.startsWith(resolve(dir))) return null;
  return existsSync(join(path, 'manifest.json')) ? path : null;
}

export function checked(name: string, dir = env.backup.dir): Snapshot | null {
  const path = pathOf(name, dir);
  if (!path) return null;
  const found = snapshots(dir).find((snapshot) => snapshot.name === name);
  if (!found) return null;
  try {
    verify(path);
    return { ...found, intact: true };
  } catch (problem) {
    return { ...found, intact: false, problem: problem instanceof Error ? problem.message : String(problem) };
  }
}

/**
 * Take one, unless one for the same day is already there.
 *
 * The suffix is what makes "run one now" possible on a day the schedule has
 * already covered: without it the second run would either overwrite a good
 * snapshot or refuse, and both are the wrong answer to somebody clicking the
 * button before an upgrade.
 */
export function take(dir = env.backup.dir, options: { force?: boolean; now?: Date } = {}): { snapshot: Snapshot; manifest: Manifest } | null {
  if (!dir) throw new Error('No backup directory is configured (KOLIBRI_BACKUP_DIR)');
  const now = options.now ?? new Date();
  let name = nameFor(now);
  if (existsSync(join(dir, name))) {
    if (!options.force) return null;
    name = `${name}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const manifest = takeSnapshot(join(dir, name), now);
  const snapshot = snapshots(dir).find((one) => one.name === name)!;
  return { snapshot, manifest };
}

/**
 * Keep the newest `keep` and remove the rest. `0` keeps everything.
 *
 * Only ever directories this module would have created — the name pattern is
 * the whole of the guard, and it is why `pathOf` exists rather than a join.
 */
export function prune(dir = env.backup.dir, keep = env.backup.keep): string[] {
  if (!dir || keep <= 0) return [];
  const removed: string[] = [];
  for (const snapshot of snapshots(dir).slice(keep)) {
    rmSync(snapshot.path, { recursive: true, force: true });
    removed.push(snapshot.name);
  }
  return removed;
}

/* ------------------------------------------------------------------ offsite */

/**
 * Copy a snapshot into the object store.
 *
 * The database and its manifest go under the snapshot's own prefix. The
 * uploads — present only when this instance keeps its blobs on disk — go under
 * a **shared** prefix keyed by content, so a nightly backup of a workspace
 * whose files have not changed uploads the database and nothing else. That is
 * the difference between an offsite copy somebody keeps switched on and one
 * they turn off in week three.
 */
export async function offsite(name: string, dir = env.backup.dir): Promise<{ uploaded: number; skipped: number; bytes: number }> {
  const path = pathOf(name, dir);
  if (!path) throw new Error(`No snapshot called ${name}`);
  if (env.storage.kind !== 's3') throw new Error('There is no object store configured to copy to (KOLIBRI_STORAGE=s3)');

  const config = env.storage.s3;
  const prefix = `${env.backup.prefix}/${name}`;
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;

  const send = async (key: string, body: Buffer, type: string): Promise<void> => {
    await s3.putObject(config, key, body, type);
    uploaded++;
    bytes += body.length;
  };

  await send(`${prefix}/manifest.json`, readFileSync(join(path, 'manifest.json')), 'application/json');
  await send(`${prefix}/kolibri.sqlite`, readFileSync(join(path, 'kolibri.sqlite')), 'application/vnd.sqlite3');

  const uploads = join(path, 'uploads');
  if (existsSync(uploads)) {
    for (const relative of walk(uploads)) {
      const key = `${env.backup.prefix}/blobs/${relative}`;
      // Content-addressed: the same key always holds the same bytes, so one
      // that is already there is already right.
      if (await s3.headObject(config, key)) { skipped++; continue; }
      await send(key, readFileSync(join(uploads, relative)), 'application/octet-stream');
    }
  }

  return { uploaded, skipped, bytes };
}

function* walk(root: string, base = ''): Generator<string> {
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, relative);
    else yield relative;
  }
}

/* ---------------------------------------------------------------- the sweep */

export interface SweepResult {
  taken: string | null;
  pruned: string[];
  copied: number;
  problem?: string;
}

/**
 * What the hourly sweep calls.
 *
 * Returns without doing anything for all but one hour of the day, and without
 * doing anything at all when no directory is configured — which is the default,
 * because choosing where somebody else's backups live is not this program's
 * decision to make.
 */
export async function sweepBackups(now = new Date()): Promise<SweepResult | null> {
  if (!env.backup.dir) return null;
  if (now.getHours() !== env.backup.hour) return null;
  if (existsSync(join(env.backup.dir, nameFor(now)))) return null;

  const result: SweepResult = { taken: null, pruned: [], copied: 0 };
  try {
    const done = take(env.backup.dir, { now });
    if (!done) return null;
    result.taken = done.snapshot.name;
    // Verified before the old ones are removed. A snapshot that does not open
    // is not a snapshot, and finding that out *after* pruning the last good
    // one is the specific disaster this ordering avoids.
    verify(done.snapshot.path);
    result.pruned = prune(env.backup.dir, env.backup.keep);
    if (env.backup.offsite) {
      const sent = await offsite(done.snapshot.name, env.backup.dir);
      result.copied = sent.uploaded;
    }
  } catch (problem) {
    result.problem = problem instanceof Error ? problem.message : String(problem);
  }
  return result;
}

/** What the health check and the settings screen both want to say. */
export function status(): {
  enabled: boolean;
  dir: string;
  hour: number;
  keep: number;
  offsite: boolean;
  last: Snapshot | null;
  total: number;
  size: string;
} {
  const list = snapshots();
  return {
    enabled: !!env.backup.dir,
    dir: env.backup.dir,
    hour: env.backup.hour,
    keep: env.backup.keep,
    offsite: env.backup.offsite,
    last: list[0] ?? null,
    total: list.length,
    size: mb(list.reduce((sum, snapshot) => sum + snapshot.size, 0)),
  };
}

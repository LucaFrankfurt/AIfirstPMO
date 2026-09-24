/**
 * Backups that happen without anybody remembering to take them.
 *
 * `kolibri backup` has always been there and has always worked. What was
 * missing is the part that decides *when* — which in practice meant a cron
 * entry somebody wrote once, on a host somebody has since rebuilt, running a
 * command nobody has verified since. The commonest backup failure is not a
 * corrupt snapshot; it is a snapshot that stopped being taken in March.
 *
 * So: the hourly sweep takes one, keeps a stated number of them, and sends a
 * copy wherever it was told to. Everything here is deliberately boring and
 * idempotent — a snapshot is named for the day it covers, so a restart, a
 * double tick or a clock jump costs nothing.
 *
 * *Where* was the part that stayed hard. A directory mounted from another
 * volume was the only way in, and on a hosted container that is the one thing
 * nobody can do from a browser. It is one of three places now, and the other
 * two need no volume at all — a bucket or an address, typed into Settings →
 * Server (see `destinations.ts` for what fills them). With only those, the
 * snapshot is written to a scratch directory, opened, sent, and removed:
 * nothing accumulates on the disk whose failure the copy is meant to survive.
 *
 * Three things this does **not** do, each on purpose:
 *
 *   - **Restore.** `rehydrate.ts` next door does that into a running instance,
 *     and `restore.ts` against a stopped one; this only has to make sure there
 *     is something for them to restore.
 *   - **Delete anything outside the directory.** `KEEP` prunes the directory,
 *     which is a disk with a size. A bucket keeps every snapshot and every
 *     blob, and an inbox keeps what it is sent: the blobs are shared by every
 *     snapshot, so "delete the ones this snapshot used" is wrong for any older
 *     one, and a server able to delete its own offsite copies is a server whose
 *     compromise takes them with it. A bucket's lifecycle rules are the tool
 *     for that, in the hands of whoever owns the bucket.
 *   - **Encrypt.** The snapshot is exactly as readable as the database it came
 *     from. Where that matters, it is the volume or the bucket that should be
 *     encrypted, by somebody who knows where the key lives — and an emailed one
 *     is as readable as the mailbox it lands in, which is a thing to know
 *     before typing an address.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { all, run, type Row } from '../../kernel/platform/db/index.ts';
import { env } from '../../kernel/platform/env.ts';
import { keyFor } from '../../kernel/files/storage.ts';
import { backup as takeSnapshot, mb, type Manifest } from './maintenance.ts';
import { readManifest, verify } from './restore.ts';
import {
  configured, destinations, SAFE_NAME,
  type Delivery, type Destination, type DestinationKind, type Outgoing, type SnapshotFile,
} from './destinations.ts';

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

/** The same day, to the second — for one taken on purpose. */
const stampFor = (at: Date): string =>
  `${nameFor(at)}-${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}`;

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

const message = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

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
    return { ...found, intact: false, problem: message(problem) };
  }
}

/**
 * Take one, unless one for the same day is already there.
 *
 * The suffix is what makes "run one now" possible on a day the schedule has
 * already covered: without it the second run would either overwrite a good
 * snapshot or refuse, and both are the wrong answer to somebody clicking the
 * button before an upgrade.
 *
 * `stamp` asks for the suffix whatever is in the directory, for a snapshot
 * taken into a scratch directory on its way somewhere else. That directory is
 * always empty, so it cannot say whether the bucket already holds tonight's —
 * and a second one sent under the same name would replace it there.
 */
export function take(
  dir = env.backup.dir,
  options: { force?: boolean; now?: Date; uploads?: boolean; stamp?: boolean } = {},
): { snapshot: Snapshot; manifest: Manifest } | null {
  if (!dir) throw new Error('No backup directory is configured (KOLIBRI_BACKUP_DIR)');
  const now = options.now ?? new Date();
  let name = options.stamp ? stampFor(now) : nameFor(now);
  if (existsSync(join(dir, name))) {
    if (!options.force) return null;
    // To the second, not the minute. Two forced snapshots a minute apart is a
    // schedule; two within the same minute is somebody restoring twice in a
    // hurry, and that is exactly when the first of the two safety copies must
    // not be the one the second overwrites.
    name = stampFor(now);
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const manifest = takeSnapshot(join(dir, name), now, { uploads: options.uploads });
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

/* ---------------------------------------------------------------- elsewhere */

/**
 * The files a snapshot's rows refer to, read from the snapshot itself.
 *
 * From the copy and not from the live table, so what is sent is what the
 * database being sent refers to: a file uploaded a second after the copy was
 * taken is tomorrow's, and one deleted since is still tonight's. Read-only,
 * the way `verify` opens it.
 */
function filesOf(dir: string): SnapshotFile[] {
  const copy = new DatabaseSync(join(dir, 'kolibri.sqlite'), { readOnly: true });
  try {
    // One row per workspace that holds the file; one key for all of them.
    const rows = copy.prepare(
      `SELECT hash, mime, max(size) AS size, min(storage) AS storage FROM files GROUP BY hash, mime`,
    ).all() as { hash: string; mime: string; size: number; storage: string }[];
    return rows.map((row) => {
      const key = keyFor(String(row.hash), String(row.mime));
      const local = join(dir, 'uploads', key);
      return {
        key,
        mime: String(row.mime),
        size: Number(row.size ?? 0),
        storage: row.storage === 's3' ? 's3' : 'disk',
        local: existsSync(local) ? local : null,
      };
    });
  } finally {
    copy.close();
  }
}

const outgoing = (dir: string, name: string): Outgoing => ({
  name,
  dir,
  manifest: (readManifest(dir) ?? {}) as unknown as Manifest,
  files: filesOf(dir),
});

/**
 * What the last attempt to send somewhere looked like, per destination.
 *
 * Written after every attempt, including the ones that never got as far as a
 * snapshot, so the screen can say "last night's did not happen" rather than
 * nothing at all.
 */
export interface DeliveryRecord {
  snapshot: string;
  attempted_at: number;
  ok: boolean;
  detail: string;
  /** The newest snapshot that did arrive, and when — kept when a later one fails. */
  delivered: string | null;
  delivered_at: number | null;
}

function record(snapshot: string, result: Delivery, at = Date.now()): void {
  run(
    `INSERT INTO backup_deliveries (destination, snapshot, attempted_at, ok, detail, delivered, delivered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?4 = 1 THEN ?2 END, CASE WHEN ?4 = 1 THEN ?3 END)
     ON CONFLICT (destination) DO UPDATE SET
       snapshot = excluded.snapshot, attempted_at = excluded.attempted_at,
       ok = excluded.ok, detail = excluded.detail,
       delivered = coalesce(excluded.delivered, backup_deliveries.delivered),
       delivered_at = coalesce(excluded.delivered_at, backup_deliveries.delivered_at)`,
    result.kind, snapshot, at, result.ok ? 1 : 0, result.detail.slice(0, 500),
  );
}

export function deliveries(): Partial<Record<DestinationKind, DeliveryRecord>> {
  const out: Partial<Record<DestinationKind, DeliveryRecord>> = {};
  for (const row of all<Row>(`SELECT * FROM backup_deliveries`)) {
    out[row.destination as DestinationKind] = {
      snapshot: String(row.snapshot),
      attempted_at: Number(row.attempted_at),
      ok: !!row.ok,
      detail: String(row.detail ?? ''),
      delivered: row.delivered ?? null,
      delivered_at: row.delivered_at === null || row.delivered_at === undefined ? null : Number(row.delivered_at),
    };
  }
  return out;
}

/** Whether tonight has already been tried for this destination, whichever way it went. */
const attempted = (kind: DestinationKind, day: string, records = deliveries()): boolean =>
  records[kind]?.snapshot.startsWith(day) ?? false;

/**
 * Send a snapshot that has opened to every destination, one after the other.
 *
 * One after the other rather than together, because a later one is often told
 * about an earlier one: an inbox receiving the database can be told the files
 * are in the bucket — or that the bucket refused them tonight. And each on its
 * own: a bucket that is down is not a reason for the email not to go.
 */
export async function deliver(dir: string, name: string, to: Destination[] = configured()): Promise<Delivery[]> {
  if (!to.length) return [];
  const snapshot = outgoing(dir, name);
  const results: Delivery[] = [];
  for (const destination of to) {
    let result: Delivery;
    try {
      const sent = await destination.send(snapshot, [...results]);
      result = { kind: destination.kind, ok: true, detail: sent.detail, bytes: sent.bytes };
    } catch (problem) {
      result = { kind: destination.kind, ok: false, detail: message(problem) };
    }
    results.push(result);
    record(name, result);
  }
  return results;
}

/** Tell every destination that can hear it that there was nothing to send. */
async function tell(to: Destination[], problem: string, at: Date): Promise<void> {
  for (const destination of to) {
    if (!destination.failed) continue;
    // A notice that cannot be sent either is not a second problem to report:
    // the first one is already in the log and on the screen.
    await destination.failed(problem, at).catch(() => undefined);
  }
}

/** A directory that is gone again once `work` is done, whichever way it ended. */
async function scratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kolibri-backup-'));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- the sweep */

export interface SweepResult {
  taken: string | null;
  pruned: string[];
  /** Where it was sent tonight, and how that went. */
  sent: Delivery[];
  problem?: string;
}

/**
 * What the hourly sweep calls.
 *
 * Returns without doing anything for all but one hour of the day, and without
 * doing anything at all when nobody has said where backups go — which is the
 * default, because choosing where somebody else's backups live is not this
 * program's decision to make.
 */
export async function sweepBackups(now = new Date()): Promise<SweepResult | null> {
  const dir = env.backup.dir;
  const targets = configured();
  if (!dir && !targets.length) return null;
  if (now.getHours() !== env.backup.hour) return null;

  const day = nameFor(now);
  const records = deliveries();
  const owed = targets.filter((destination) => !attempted(destination.kind, day, records));
  const tonight = dir ? pathOf(day, dir) : null;
  if (!owed.length && (tonight || !dir)) return null;

  const result: SweepResult = { taken: null, pruned: [], sent: [] };

  const attempt = async (into: string): Promise<void> => {
    const done = take(into, { now, uploads: !!dir });
    if (!done) return;
    result.taken = done.snapshot.name;
    // Verified before the old ones are removed. A snapshot that does not open
    // is not a snapshot, and finding that out *after* pruning the last good
    // one is the specific disaster this ordering avoids.
    verify(done.snapshot.path);
    if (dir) result.pruned = prune(dir, env.backup.keep);
    result.sent = await deliver(done.snapshot.path, done.snapshot.name, owed);
  };

  try {
    if (tonight) {
      // Taken and never sent: a restart between the two, or a destination set
      // up since. The snapshot is there, so it is the one that goes — opened
      // first, since whatever interrupted it may have come before its check.
      verify(tonight);
      result.sent = await deliver(tonight, day, owed);
    } else if (dir) {
      await attempt(dir);
    } else {
      await scratch(attempt);
    }
  } catch (problem) {
    result.problem = message(problem);
    // Recorded against every place that was owed one, so tomorrow's screen
    // says tonight did not happen instead of showing yesterday as the last.
    for (const destination of owed) {
      if (!result.sent.some((sent) => sent.kind === destination.kind)) {
        record(day, { kind: destination.kind, ok: false, detail: result.problem });
      }
    }
    await tell(owed, result.problem, now);
  }
  return result;
}

/* ------------------------------------------------------------------ one now */

export interface Taken {
  snapshot: Snapshot;
  manifest: Manifest;
  /** Whether it is in the directory as well as wherever it was sent. */
  kept: boolean;
  pruned: string[];
  sent: Delivery[];
}

/**
 * One now, wherever the nightly one goes: the button, `kolibri backup`, and the
 * copy a restore keeps of what it is about to replace.
 *
 * Forced, so a day the schedule has already covered is not refused, and
 * opened before anything older is pruned — the same order as the night.
 */
export async function backUpNow(
  options: { dir?: string; keep?: number; now?: Date; to?: Destination[] } = {},
): Promise<Taken> {
  const dir = options.dir ?? env.backup.dir;
  const to = options.to ?? configured();
  if (!dir && !to.length) {
    throw new Error('There is nowhere to put a backup — set a directory, a bucket or an address');
  }

  const attempt = async (into: string): Promise<Taken> => {
    const done = take(into, { force: true, now: options.now, uploads: !!dir, stamp: !dir })!;
    verify(done.snapshot.path);
    const pruned = dir ? prune(dir, options.keep ?? env.backup.keep) : [];
    const sent = await deliver(done.snapshot.path, done.snapshot.name, to);
    return { snapshot: { ...done.snapshot, intact: true }, manifest: done.manifest, kept: !!dir, pruned, sent };
  };
  return dir ? attempt(dir) : scratch(attempt);
}

/** Send one that is already in the directory to everywhere else. */
export async function sendAgain(name: string, dir = env.backup.dir): Promise<Delivery[]> {
  const path = pathOf(name, dir);
  if (!path) throw new Error(`No snapshot called ${name}`);
  verify(path);
  return deliver(path, name);
}

/* ------------------------------------------------------------- reading back */

/** A destination snapshots can be fetched back from, if one is configured. */
const readable = (): Destination | undefined => configured().find((destination) => destination.list && destination.fetch);

/** Whether a restore has somewhere to keep what it replaces. */
export const canKeep = (): boolean => !!env.backup.dir || !!readable();

/** What the bucket holds, for the list beside the directory's. */
export async function remoteSnapshots(): Promise<{ kind: DestinationKind; where: string; names: string[]; problem?: string } | null> {
  const source = readable();
  if (!source) return null;
  const where = source.state().where;
  try {
    return { kind: source.kind, where, names: (await source.list!()).filter((name) => SAFE_NAME.test(name)) };
  } catch (problem) {
    return { kind: source.kind, where, names: [], problem: message(problem) };
  }
}

/** Fetch one of those into a directory. False when there is no such place or name. */
export async function fetchRemote(name: string, into: string): Promise<boolean> {
  const source = readable();
  if (!source || !SAFE_NAME.test(name)) return false;
  return (await source.fetch!(name, into)) && existsSync(join(into, 'kolibri.sqlite'));
}

/**
 * Where a restore can find an uploaded file its snapshot does not carry.
 *
 * An emailed snapshot carries none, and a scratch one sent to a bucket carried
 * them there instead — so a restore on an instance that has the bucket set up
 * finds them in it, whichever file the tables arrived in.
 */
export function blobSource(): ((key: string) => Promise<Buffer | null>) | undefined {
  const source = configured().find((destination) => destination.blob);
  return source ? (key) => source.blob!(key) : undefined;
}

/**
 * A copy of what is here, sent where it can be fetched back from, before a
 * restore replaces it — for an instance with no directory to keep one in.
 */
export async function keepBeforeRestore(): Promise<string | undefined> {
  const source = readable();
  if (!source) return undefined;
  const done = await backUpNow({ dir: '', to: [source] });
  return done.sent[0]?.ok ? done.snapshot.name : undefined;
}

/** Try every configured destination without a snapshot, and say how each went. */
export async function testDestinations(): Promise<Delivery[]> {
  const out: Delivery[] = [];
  for (const destination of configured()) {
    try {
      out.push({ kind: destination.kind, ok: true, detail: await destination.test() });
    } catch (problem) {
      out.push({ kind: destination.kind, ok: false, detail: message(problem) });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- the state */

export interface Place {
  kind: DestinationKind;
  configured: boolean;
  where: string;
  problem?: string;
  last: DeliveryRecord | null;
}

/** Whether there is anywhere at all for a backup to go. */
export const somewhere = (): boolean => !!env.backup.dir || configured().length > 0;

/** Every place this build can send one, and how the last attempt there went. */
export function places(): Place[] {
  const records = deliveries();
  return destinations().map((destination): Place => ({
    kind: destination.kind,
    ...destination.state(),
    last: records[destination.kind] ?? null,
  }));
}

/** What the health check and the settings screen both want to say. */
export function status(): {
  enabled: boolean;
  dir: string;
  hour: number;
  keep: number;
  /** Whether a copy leaves the directory at all. */
  offsite: boolean;
  /** Whether a restore can keep what it replaces. */
  keeps: boolean;
  destinations: Place[];
  last: Snapshot | null;
  total: number;
  size: string;
} {
  const list = snapshots();
  const everywhere = places();
  return {
    enabled: !!env.backup.dir || everywhere.some((place) => place.configured),
    dir: env.backup.dir,
    hour: env.backup.hour,
    keep: env.backup.keep,
    offsite: everywhere.some((place) => place.configured),
    keeps: canKeep(),
    destinations: everywhere,
    last: list[0] ?? null,
    total: list.length,
    size: mb(list.reduce((sum, snapshot) => sum + snapshot.size, 0)),
  };
}

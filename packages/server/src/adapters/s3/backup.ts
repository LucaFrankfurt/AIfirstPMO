/**
 * A bucket as a place backups go — any bucket, not only the uploads' own.
 *
 * The layout is the one `KOLIBRI_BACKUP_OFFSITE` has always written, so a
 * bucket that has been receiving those is already a bucket of backups:
 *
 *     <prefix>/<name>/kolibri.sqlite
 *     <prefix>/<name>/manifest.json
 *     <prefix>/blobs/ab/cd/<hash>.png     shared by every snapshot
 *
 * The blobs are keyed by content, so a night whose files have not changed
 * sends the database and nothing else — the difference between an offsite
 * copy somebody keeps switched on and one they turn off in week three. They
 * are read wherever the uploads actually are: the snapshot's own copy when it
 * carries one, the storage otherwise. That is what makes a bucket of its own
 * a whole backup even for an instance whose uploads live in another bucket,
 * which is the case the old offsite copy could never cover.
 *
 * Written in the order that makes an interrupted run harmless: the blobs, then
 * the database, then the manifest. A folder holding a database therefore
 * already holds every file that database refers to.
 *
 * Nothing here deletes a backup; see `backups.ts` for why. The one object it
 * removes is the one `test` writes.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../../kernel/platform/env.ts';
import * as storage from '../../kernel/files/storage.ts';
import {
  registerDestination, SAFE_NAME,
  type Destination, type DestinationState, type Outgoing, type SnapshotFile,
} from '../../modules/operations/destinations.ts';
import * as s3 from './s3.ts';

const config = (): s3.S3Config => {
  const { endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle } = env.backup.s3;
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle };
};

const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** `s3.fr-par.scw.cloud/kolibri-backups/backups` — the host, not the whole URL. */
function where(): string {
  const { endpoint, bucket } = env.backup.s3;
  let host = endpoint;
  try { host = new URL(endpoint).host; } catch { /* said as typed */ }
  return [host, bucket, env.backup.prefix].filter(Boolean).join('/');
}

function state(): DestinationState {
  const { bucket, endpoint, accessKeyId, secretAccessKey } = env.backup.s3;
  if (!bucket) {
    // The older spelling, on an instance whose uploads are not in a bucket: it
    // used to fail every night with a sentence nobody read.
    return env.backup.offsite
      ? { configured: false, where: '', problem: 'KOLIBRI_BACKUP_OFFSITE copies into the uploads’ own bucket, and they are on disk — name a bucket for backups instead' }
      : { configured: false, where: '' };
  }
  if (!endpoint) return { configured: false, where: where(), problem: 'The bucket needs an endpoint — the address of the store it is in' };
  if (!accessKeyId || !secretAccessKey) {
    return { configured: false, where: where(), problem: 'The bucket needs an access key and a secret key' };
  }
  return { configured: true, where: where() };
}

/**
 * Write, and make the bucket if that is the only thing in the way.
 *
 * Asked for at the first write rather than checked before it: checking means
 * listing the bucket, a key allowed to write backups and nothing else may not
 * list, and such a key is exactly the one a careful operator would give this.
 */
async function put(key: string, body: Buffer, type: string): Promise<void> {
  const cfg = config();
  try {
    await s3.putObject(cfg, key, body, type);
  } catch (error) {
    if (!(error instanceof s3.S3Error) || error.status !== 404) throw error;
    await s3.ensureBucket(cfg);
    await s3.putObject(cfg, key, body, type);
  }
}

/**
 * The blob keys the bucket already holds, in one listing rather than a
 * question per file — a thousand keys a request instead of one.
 *
 * Null when the key may not list, and the caller asks per file instead; an
 * empty set when the bucket is not there yet, since then it holds nothing.
 */
async function held(prefix: string): Promise<Set<string> | null> {
  const keys = new Set<string>();
  try {
    for await (const page of s3.listAll(config(), prefix)) for (const item of page.keys) keys.add(item.key);
    return keys;
  } catch (error) {
    if (error instanceof s3.S3Error && error.status === 404) return keys;
    if (error instanceof s3.S3Error && error.status === 403) return null;
    throw error;
  }
}

/** A file's bytes, from the snapshot's own copy when it has one. */
async function bytesOf(file: SnapshotFile): Promise<Buffer | null> {
  if (file.local) return readFileSync(file.local);
  try {
    // The row's size is what was recorded, not necessarily what is stored —
    // `readAll` refuses to allocate past the bound it is given.
    return await storage.readAll(file.key, Math.max(file.size, env.maxUploadBytes) + 1, file.storage);
  } catch {
    return null;
  }
}

async function send(snapshot: Outgoing): Promise<{ detail: string; bytes: number }> {
  const prefix = env.backup.prefix;
  const blobs = `${prefix}/blobs/`;
  const known = await held(blobs);
  let readable = true;
  const there = async (key: string): Promise<boolean> => {
    if (known) return known.has(key);
    if (!readable) return false;
    try {
      return await present(key);
    } catch (error) {
      // A key that may neither list nor read: every file goes every night,
      // which costs bandwidth and still makes a whole backup.
      if (error instanceof s3.S3Error && error.status === 403) { readable = false; return false; }
      throw error;
    }
  };

  let sent = 0;
  let already = 0;
  let bytes = 0;
  const unreadable: string[] = [];
  for (const file of snapshot.files) {
    // Already in this very bucket, where the uploads live: a second copy under
    // another prefix would double the bill and protect against nothing.
    if (env.backup.s3.shared && file.storage === 's3') { already++; continue; }
    const key = `${blobs}${file.key}`;
    if (await there(key)) { already++; continue; }
    const body = await bytesOf(file);
    // A file whose bytes are gone is a finding for `kolibri doctor`, not a
    // reason to send no database tonight.
    if (!body) { unreadable.push(file.key); continue; }
    await put(key, body, 'application/octet-stream');
    sent++;
    bytes += body.length;
  }

  const database = readFileSync(join(snapshot.dir, 'kolibri.sqlite'));
  await put(`${prefix}/${snapshot.name}/kolibri.sqlite`, database, 'application/vnd.sqlite3');
  // Last, so a folder with a manifest in it is a whole one.
  const manifest = readFileSync(join(snapshot.dir, 'manifest.json'));
  await put(`${prefix}/${snapshot.name}/manifest.json`, manifest, 'application/json');
  bytes += database.length + manifest.length;

  const parts = [`database ${megabytes(database.length)}`, `${sent} new file(s)`];
  if (already) parts.push(`${already} already there`);
  if (unreadable.length) parts.push(`${unreadable.length} unreadable here: ${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ' …' : ''}`);
  return { detail: `${parts.join(', ')} → ${where()}`, bytes };
}

const present = async (key: string): Promise<boolean> => (await s3.headObject(config(), key)) !== null;

/** Stream one object into a file, or say it is not there. */
async function download(key: string, path: string): Promise<boolean> {
  let response: Response;
  try {
    response = await s3.getObject(config(), key);
  } catch (error) {
    if (error instanceof s3.S3Error && error.status === 404) return false;
    throw error;
  }
  if (!response.body) return false;
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
  return true;
}

const destination: Destination = {
  kind: 's3',
  state,
  send,

  /**
   * Written and read back, because a key that can write but not read is a key
   * the nightly copy works with and a restore does not — and the restore is
   * the half nobody tries until they need it.
   */
  async test() {
    const key = `${env.backup.prefix}/.kolibri-test`;
    await put(key, Buffer.from('Written by Kolibri to check the backup settings. Safe to delete.\n'), 'text/plain');
    try {
      if (!(await present(key))) throw new Error('The bucket took a test object and then could not find it');
    } catch (error) {
      if (error instanceof s3.S3Error && error.status === 403) {
        throw new Error('The bucket takes backups, but this key may not read them back — a restore from it would fail');
      }
      throw error;
    }
    await s3.deleteObject(config(), key).catch(() => undefined);
    return where();
  },

  async list() {
    const prefix = `${env.backup.prefix}/`;
    const names: string[] = [];
    try {
      for await (const page of s3.listAll(config(), prefix, '/')) {
        for (const folder of page.prefixes) names.push(folder.slice(prefix.length).replace(/\/$/, ''));
      }
    } catch (error) {
      // No bucket yet is no backups yet, not a failure: the first night makes it.
      if (!(error instanceof s3.S3Error) || error.status !== 404) throw error;
    }
    return names.filter((name) => SAFE_NAME.test(name)).sort().reverse();
  },

  async fetch(name, into) {
    if (!SAFE_NAME.test(name)) return false;
    const prefix = `${env.backup.prefix}/${name}`;
    if (!(await download(`${prefix}/kolibri.sqlite`, join(into, 'kolibri.sqlite')))) return false;
    // Optional, the way it is in an uploaded file: the database is the snapshot.
    await download(`${prefix}/manifest.json`, join(into, 'manifest.json'));
    return true;
  },

  async blob(key) {
    const cfg = config();
    const read = async (at: string): Promise<Buffer | null> => {
      try {
        return Buffer.from(await (await s3.getObject(cfg, at)).arrayBuffer());
      } catch (error) {
        if (error instanceof s3.S3Error && error.status === 404) return null;
        throw error;
      }
    };
    // In the uploads' own bucket, a file that was already there was never
    // copied under the prefix — it is at its own key.
    return (await read(`${env.backup.prefix}/blobs/${key}`)) ?? (env.backup.s3.shared ? read(key) : null);
  },
};

/** Hung off the backups by `backends.ts`. */
export const installS3Backups = (): void => registerDestination(destination);

/**
 * Blob storage, with the disk under it and room for anything else.
 *
 * Files are content-addressed, so the key is derived from the bytes and never
 * changes. Each row in `files` records which backend holds it, which means an
 * instance can switch from disk to S3 without losing what is already stored —
 * every function below therefore takes the backend a row *says* it is in, not
 * just the one configured now.
 *
 * The disk is here because it is the default and needs nothing outside the
 * process. Everything else registers: this file used to import the S3 client
 * directly and branch on `kind === 's3'` in six places, which is the kernel
 * knowing one specific provider. It knows the *name* from configuration and
 * nothing else now.
 */
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { env } from '../platform/env.ts';

export type StorageKind = 'disk' | 's3';

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
};

/** `<hash>` -> `ab/cd/<hash>.png`; the same key in both backends. */
export function keyFor(hash: string, mime: string): string {
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${EXTENSIONS[mime] ?? ''}`;
}

const diskPath = (key: string): string => join(env.uploadDir, key);

export const activeKind: StorageKind = env.storage.kind;

export interface ReadResult {
  stream: Readable;
  size?: number;
}

/**
 * What a place to put bytes has to be able to do.
 *
 * `directUrl` is optional because handing the browser a URL is a property of
 * the store rather than of storage: the disk has no such thing and returns
 * null, which is the caller's signal to stream the bytes itself.
 */
export interface Backend {
  /** Create the bucket, make the directory — whatever readiness means. */
  init(): Promise<void>;
  put(key: string, body: Buffer, mime: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<ReadResult | null>;
  remove(key: string): Promise<void>;
  directUrl?(key: string, filename: string, mime: string): string | null;
  /** One line for the doctor and the settings screen. */
  describe(): string;
}

const disk: Backend = {
  async init() {
    mkdirSync(env.uploadDir, { recursive: true });
  },
  async put(key, body) {
    const path = diskPath(key);
    mkdirSync(join(path, '..'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, body);
  },
  async exists(key) {
    return existsSync(diskPath(key));
  },
  async read(key) {
    const path = diskPath(key);
    if (!existsSync(path)) return null;
    return { stream: createReadStream(path), size: statSync(path).size };
  },
  async remove(key) {
    const path = diskPath(key);
    if (existsSync(path)) unlinkSync(path);
  },
  describe: () => `disk (${env.uploadDir})`,
};

const backends = new Map<StorageKind, Backend>([['disk', disk]]);

/**
 * Offer a place to put bytes. `wiring.ts` installs the ones this build has.
 *
 * A configured backend that nothing registered is a configuration error rather
 * than a silent fall back to the disk: writing to the wrong store is how an
 * instance ends up with half its files in each.
 */
export function registerBackend(kind: StorageKind, backend: Backend): void {
  backends.set(kind, backend);
}

const backendFor = (kind: StorageKind): Backend => {
  const backend = backends.get(kind);
  if (!backend) throw new Error(`storage: nothing registered for "${kind}" — see wiring.ts`);
  return backend;
};

export const init = (): Promise<void> => backendFor(activeKind).init();

export const put = (key: string, body: Buffer, mime: string, kind: StorageKind = activeKind): Promise<void> =>
  backendFor(kind).put(key, body, mime);

export const exists = (key: string, kind: StorageKind = activeKind): Promise<boolean> =>
  backendFor(kind).exists(key);

export const read = (key: string, kind: StorageKind = activeKind): Promise<ReadResult | null> =>
  backendFor(kind).read(key);

export const remove = (key: string, kind: StorageKind = activeKind): Promise<void> =>
  backendFor(kind).remove(key);

/**
 * A URL the browser can fetch directly, or null when the app has to stream the
 * bytes itself. Pre-signing keeps large downloads off the app server, at the
 * cost of a short-lived URL that carries its own authorisation — which is why
 * the permission check happens before one is minted.
 */
export const directUrl = (key: string, filename: string, mime: string, kind: StorageKind = activeKind): string | null =>
  backendFor(kind).directUrl?.(key, filename, mime) ?? null;

export const describe = (): string => backendFor(activeKind).describe();

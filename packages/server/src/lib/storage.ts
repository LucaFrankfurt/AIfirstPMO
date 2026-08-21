/**
 * Blob storage with two backends: the local disk (default) and any
 * S3-compatible object store (MinIO, Ceph, R2, AWS).
 *
 * Files are content-addressed, so the key is derived from the bytes and never
 * changes. Each row in `files` records which backend holds it, which means an
 * instance can switch from disk to S3 without losing what is already stored.
 */
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { env } from '../env.ts';
import { disposition } from './mime.ts';
import * as s3 from './s3.ts';

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

/** Ready the backend: create the bucket, or make sure the directory exists. */
export async function init(): Promise<void> {
  if (env.storage.kind === 's3') await s3.ensureBucket(env.storage.s3);
  else mkdirSync(env.uploadDir, { recursive: true });
}

export async function put(key: string, body: Buffer, mime: string, kind: StorageKind = activeKind): Promise<void> {
  if (kind === 's3') {
    await s3.putObject(env.storage.s3, key, body, mime);
    return;
  }
  const path = diskPath(key);
  mkdirSync(join(path, '..'), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, body);
}

export async function exists(key: string, kind: StorageKind = activeKind): Promise<boolean> {
  if (kind === 's3') return (await s3.headObject(env.storage.s3, key)) !== null;
  return existsSync(diskPath(key));
}

export async function read(key: string, kind: StorageKind = activeKind): Promise<ReadResult | null> {
  if (kind === 's3') {
    const response = await s3.getObject(env.storage.s3, key);
    if (!response.body) return null;
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      size: Number(response.headers.get('content-length') ?? 0) || undefined,
    };
  }
  const path = diskPath(key);
  if (!existsSync(path)) return null;
  return { stream: createReadStream(path), size: statSync(path).size };
}

export async function remove(key: string, kind: StorageKind = activeKind): Promise<void> {
  if (kind === 's3') {
    await s3.deleteObject(env.storage.s3, key);
    return;
  }
  const path = diskPath(key);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * A URL the browser can fetch directly, or null when the app has to stream the
 * bytes itself. Pre-signing keeps large downloads off the app server, at the
 * cost of a short-lived URL that carries its own authorisation — which is why
 * the permission check happens before one is minted.
 */
export function directUrl(key: string, filename: string, mime: string, kind: StorageKind = activeKind): string | null {
  if (kind !== 's3' || !env.storage.presign) return null;
  // Sign for the host the browser will actually connect to.
  const config = env.storage.publicEndpoint
    ? { ...env.storage.s3, endpoint: env.storage.publicEndpoint }
    : env.storage.s3;
  return s3.presignGet(config, key, env.storage.presignSeconds, new Date(), filename, mime);
}

export const describe = (): string =>
  env.storage.kind === 's3'
    ? `s3 (${env.storage.s3.endpoint}/${env.storage.s3.bucket}${env.storage.presign ? ', pre-signed URLs' : ''})`
    : `disk (${env.uploadDir})`;

/**
 * Object-storage tests against a fake S3 that verifies the SigV4 signature by
 * recomputing it from the request. That is what makes this test worth having:
 * a mock that accepted any Authorization header would pass even if the
 * canonicalisation were wrong, and MinIO would then reject every upload.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-s3-${process.pid}`;

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

const ACCESS_KEY = 'kolibri-test';
const SECRET_KEY = 'kolibri-test-secret';

const objects = new Map<string, { body: Buffer; contentType: string }>();
const buckets = new Set<string>();
let lastAuthOk = false;

const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Recompute the signature the client claims, exactly as S3 does. */
function verifySignature(method: string, path: string, query: string, headers: Record<string, string>, payloadHash: string): boolean {
  const authorization = headers.authorization ?? '';
  const parsed = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(authorization);
  if (!parsed) return false;
  const [, accessKey, dateStamp, region, signedHeaders, signature] = parsed;
  if (accessKey !== ACCESS_KEY) return false;

  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${String(headers[name] ?? '').trim()}\n`)
    .join('');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', headers['x-amz-date'], scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), region), 's3'), 'aws4_request');
  return hmac(key, stringToSign).toString('hex') === signature;
}

const s3Server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk as Buffer));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0]! : String(v ?? '')]),
    );

    // `/bucket` addresses the bucket, `/bucket/key…` an object.
    const segments = url.pathname.split('/').filter(Boolean);
    const bucket = segments[0];
    const key = segments.slice(1).map(decodeURIComponent).join('/');

    if (url.searchParams.has('X-Amz-Signature')) {
      // Pre-signed GET: we only assert it is well formed, then serve.
      const stored = objects.get(key);
      if (!stored) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': stored.contentType, 'content-length': String(stored.body.length) });
      res.end(stored.body);
      return;
    }

    lastAuthOk = verifySignature(
      req.method ?? 'GET',
      url.pathname,
      url.searchParams.toString(),
      headers,
      headers['x-amz-content-sha256'] ?? sha256(body),
    );
    if (!lastAuthOk) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }

    if (!key) {
      // Bucket-level call.
      if (req.method === 'HEAD') res.writeHead(buckets.has(bucket) ? 200 : 404).end();
      else if (req.method === 'PUT') {
        buckets.add(bucket);
        res.writeHead(200).end();
      } else res.writeHead(405).end();
      return;
    }

    if (req.method === 'PUT') {
      objects.set(key, { body, contentType: headers['content-type'] ?? 'application/octet-stream' });
      res.writeHead(200, { etag: `"${sha256(body)}"` }).end();
      return;
    }
    if (req.method === 'HEAD' || req.method === 'GET') {
      const stored = objects.get(key);
      if (!stored) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': stored.contentType, 'content-length': String(stored.body.length) });
      if (req.method === 'HEAD') res.end();
      else res.end(stored.body);
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
});

const port = await new Promise<number>((resolve) => {
  s3Server.listen(0, '127.0.0.1', () => resolve((s3Server.address() as AddressInfo).port));
});

process.env.KOLIBRI_STORAGE = 's3';
process.env.KOLIBRI_S3_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.KOLIBRI_S3_BUCKET = 'kolibri-test';
process.env.KOLIBRI_S3_ACCESS_KEY = ACCESS_KEY;
process.env.KOLIBRI_S3_SECRET_KEY = SECRET_KEY;
process.env.KOLIBRI_S3_PATH_STYLE = 'true';

const storage = await import('../src/kernel/files/storage.ts');
const s3 = await import('../src/adapters/s3/s3.ts');
const { env } = await import('../src/kernel/platform/env.ts');
// `storage` knows the disk and whatever registers. Anything driving it has to
// wire the rest up, exactly as the server does — see `wiring.ts`.
(await import('../src/wiring.ts')).installEffects();

after(() => {
  s3Server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const read = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe('s3 storage', () => {
  it('derives a content-addressed key', () => {
    const key = storage.keyFor('abcdef0123456789', 'image/png');
    assert.equal(key, 'ab/cd/abcdef0123456789.png');
  });

  it('creates the bucket when it is missing', async () => {
    assert.equal(buckets.has('kolibri-test'), false);
    await storage.init();
    assert.equal(buckets.has('kolibri-test'), true);
    assert.ok(lastAuthOk, 'the bucket call must be signed correctly');
  });

  it('round-trips an object', async () => {
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog');
    const key = storage.keyFor(createHash('sha256').update(payload).digest('hex'), 'text/plain');

    await storage.put(key, payload, 'text/plain');
    assert.ok(lastAuthOk, 'PUT signature verified by the server');
    assert.equal(await storage.exists(key), true);

    const result = await storage.read(key);
    assert.ok(result);
    assert.equal((await read(result!.stream)).toString(), payload.toString());
    assert.equal(result!.size, payload.length);
  });

  it('signs keys that need percent-encoding', async () => {
    const key = 'ab/cd/a file with spaces & symbols (1).png';
    await storage.put(key, Buffer.from('x'), 'image/png');
    assert.ok(lastAuthOk, 'the canonical path must use the same encoding as the URL');
    assert.equal(await storage.exists(key), true);
  });

  it('deletes', async () => {
    const key = 'ab/cd/deleteme.txt';
    await storage.put(key, Buffer.from('bye'), 'text/plain');
    await storage.remove(key);
    assert.equal(await storage.exists(key), false);
  });

  it('mints a pre-signed URL that actually serves the object', async () => {
    const payload = Buffer.from('presigned!');
    const key = 'ab/cd/presigned.txt';
    await storage.put(key, payload, 'text/plain');

    const url = storage.directUrl(key, 'presigned.txt', 'text/plain');
    assert.ok(url, 'pre-signing is on by default for s3');
    const parsed = new URL(url!);
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.match(parsed.searchParams.get('X-Amz-Credential') ?? '', new RegExp(`^${ACCESS_KEY}/\\d{8}/`));
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), String(env.storage.presignSeconds));
    assert.match(parsed.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);

    const response = await fetch(url!);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'presigned!');
  });

  it('rejects a tampered signature', async () => {
    const bad = { ...env.storage.s3, secretAccessKey: 'wrong-secret' };
    await assert.rejects(() => s3.putObject(bad, 'ab/cd/nope.txt', Buffer.from('x'), 'text/plain'), /403|SignatureDoesNotMatch/);
  });

  it('addresses buckets by subdomain when path style is off', () => {
    const url = s3.objectUrl({ ...env.storage.s3, forcePathStyle: false, endpoint: 'https://s3.eu-central-1.amazonaws.com' }, 'ab/cd/x.png');
    assert.equal(url.host, 'kolibri-test.s3.eu-central-1.amazonaws.com');
    assert.equal(url.pathname, '/ab/cd/x.png');
  });
});

/**
 * A minimal S3 client: AWS Signature V4 over `fetch`.
 *
 * Works against MinIO, Ceph, Cloudflare R2, Backblaze B2 and AWS itself — the
 * five calls an object store actually needs for this app. The official SDK is
 * ~20 MB of dependencies for the same five calls.
 */
import { createHash, createHmac } from 'node:crypto';
import { disposition } from '../../kernel/files/mime.ts';

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and friends address buckets as `host/bucket/key`; AWS uses a subdomain. */
  forcePathStyle: boolean;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer => createHmac('sha256', key).update(value).digest();

/** Everything except the unreserved set has to be percent-encoded, `/` included in keys. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export function objectUrl(config: S3Config, key: string): URL {
  const base = new URL(config.endpoint);
  if (config.forcePathStyle) {
    base.pathname = `/${config.bucket}/${encodeKey(key)}`;
  } else {
    base.hostname = `${config.bucket}.${base.hostname}`;
    base.pathname = `/${encodeKey(key)}`;
  }
  return base;
}

const stamps = (date: Date) => {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

function signingKey(config: S3Config, dateStamp: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'), 'aws4_request');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign a request with SigV4 (header form). `payloadHash` must be the hex
 * SHA-256 of the body — S3 refuses anything else for non-streaming uploads.
 */
export function signRequest(
  config: S3Config,
  method: string,
  key: string,
  payloadHash: string,
  extraHeaders: Record<string, string> = {},
  now = new Date(),
): SignedRequest {
  return signUrl(config, method, objectUrl(config, key), payloadHash, extraHeaders, now);
}

/** The same signature over an arbitrary URL (bucket-level calls). */
export function signUrl(
  config: S3Config,
  method: string,
  url: URL,
  payloadHash: string,
  extraHeaders: Record<string, string> = {},
  now = new Date(),
): SignedRequest {
  const { amzDate, dateStamp } = stamps(now);

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, dateStamp), stringToSign).toString('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: url.toString(), headers };
}

/**
 * Pre-signed GET URL (query form). Lets the browser fetch straight from the
 * object store, so file downloads do not stream through the app server.
 */
/**
 * A signed URL for one object.
 *
 * `mime` decides what the store is told to serve it as, and it matters: the
 * store obeys the URL, so a URL that says `inline` renders whatever the
 * uploader chose as a content type. The disk path refuses that for anything
 * outside the inline allowlist and this has to refuse it too, or turning on an
 * object store quietly removes the protection.
 *
 * The overrides are query parameters, so they are covered by the signature by
 * construction — editing one invalidates the URL rather than changing what it
 * serves.
 */
export function presignGet(
  config: S3Config, key: string, expiresInSeconds = 300, now = new Date(), filename?: string, mime?: string,
): string {
  const url = objectUrl(config, key);
  const { amzDate, dateStamp } = stamps(now);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${config.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (mime) {
    const { inline, type } = disposition(mime);
    url.searchParams.set('response-content-type', type);
    if (filename) url.searchParams.set('response-content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`);
  } else if (filename) {
    url.searchParams.set('response-content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  }
  url.searchParams.sort();

  const canonicalRequest = [
    'GET',
    url.pathname,
    url.searchParams.toString(),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  url.searchParams.set('X-Amz-Signature', hmac(signingKey(config, dateStamp), stringToSign).toString('hex'));
  return url.toString();
}

/* ------------------------------------------------------------------ calls */

export async function putObject(config: S3Config, key: string, body: Buffer, contentType: string): Promise<void> {
  const signed = signRequest(config, 'PUT', key, sha256(body), {
    'content-type': contentType,
    'content-length': String(body.length),
  });
  const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(body) });
  if (!response.ok) throw new Error(`S3 PUT ${key} failed: ${response.status} ${await response.text()}`);
}

export async function getObject(config: S3Config, key: string): Promise<Response> {
  const signed = signRequest(config, 'GET', key, EMPTY_SHA256);
  const response = await fetch(signed.url, { headers: signed.headers });
  if (!response.ok) throw new Error(`S3 GET ${key} failed: ${response.status}`);
  return response;
}

export async function headObject(config: S3Config, key: string): Promise<{ size: number } | null> {
  const signed = signRequest(config, 'HEAD', key, EMPTY_SHA256);
  const response = await fetch(signed.url, { method: 'HEAD', headers: signed.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`S3 HEAD ${key} failed: ${response.status}`);
  return { size: Number(response.headers.get('content-length') ?? 0) };
}

export async function deleteObject(config: S3Config, key: string): Promise<void> {
  const signed = signRequest(config, 'DELETE', key, EMPTY_SHA256);
  const response = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
  if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${response.status}`);
}

export function bucketUrl(config: S3Config): URL {
  const base = new URL(config.endpoint);
  if (config.forcePathStyle) {
    base.pathname = `/${config.bucket}`;
    return base;
  }
  base.hostname = `${config.bucket}.${base.hostname}`;
  base.pathname = '/';
  return base;
}

/** Create the bucket if the operator has not — a fresh MinIO starts empty. */
export async function ensureBucket(config: S3Config): Promise<void> {
  const url = bucketUrl(config);

  const head = signUrl(config, 'HEAD', url, EMPTY_SHA256);
  const exists = await fetch(head.url, { method: 'HEAD', headers: head.headers });
  if (exists.ok) return;
  if (exists.status !== 404) {
    throw new Error(`Cannot reach the object store (${exists.status}). Check endpoint, keys and clock skew.`);
  }

  const create = signUrl(config, 'PUT', url, EMPTY_SHA256);
  const response = await fetch(create.url, { method: 'PUT', headers: create.headers });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Could not create bucket ${config.bucket}: ${response.status} ${await response.text()}`);
  }
}

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

/**
 * A refusal from the store, with the status it came with.
 *
 * Carried rather than read back out of the text, for the reason
 * `DeliveryError` carries `permanent`: what to do next depends on it. A 404 on
 * a list is a bucket that is not there yet, a 403 is a key that may write but
 * not read — and both are worth a different sentence from "failed".
 */
export class S3Error extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
  }
}

/** RFC 3986: the unreserved set as it is, everything else percent-encoded. */
const encodePart = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Everything except the unreserved set has to be percent-encoded, `/` included in keys. */
function encodeKey(key: string): string {
  return key.split('/').map(encodePart).join('/');
}

/**
 * The query string SigV4 signs: every name and value in RFC 3986's encoding,
 * sorted by name.
 *
 * Not `URLSearchParams.toString()`, which writes the form encoding — a space as
 * `+`, a `~` as `%7E` — so any value holding one is signed as something other
 * than what the store reads, and refused as a bad signature. No request signed
 * here carried a query until the bucket had to be listed — `presignGet` below
 * builds its own — which is why this was never found.
 */
function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [encodePart(name), encodePart(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
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
  // Sent exactly as signed, so the store reads the same bytes this hashed.
  const query = canonicalQuery(url.searchParams);
  url.search = query;

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
    query,
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

/** The five entities XML has, and numeric references, which is all a key can carry. */
const unescapeXml = (value: string): string =>
  value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });

/**
 * What the store said, in a line: its own code and message, not the XML.
 *
 * `AccessDenied — Access Denied` or `NoSuchBucket — The specified bucket does
 * not exist` is what somebody pressing Test needs to read; the envelope around
 * it is noise, and a page of it in a toast hides the one word that matters.
 */
async function refusal(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(body)?.[1];
  const said = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1];
  if (code) return `${response.status} ${unescapeXml(code)}${said ? ` — ${unescapeXml(said)}` : ''}`;
  return `${response.status} ${body.replace(/\s+/g, ' ').trim().slice(0, 200)}`.trim();
}

export async function putObject(config: S3Config, key: string, body: Buffer, contentType: string): Promise<void> {
  const signed = signRequest(config, 'PUT', key, sha256(body), {
    'content-type': contentType,
    'content-length': String(body.length),
  });
  const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(body) });
  if (!response.ok) throw new S3Error(`S3 PUT ${key} failed: ${await refusal(response)}`, response.status);
}

export async function getObject(config: S3Config, key: string): Promise<Response> {
  const signed = signRequest(config, 'GET', key, EMPTY_SHA256);
  const response = await fetch(signed.url, { headers: signed.headers });
  if (!response.ok) throw new S3Error(`S3 GET ${key} failed: ${await refusal(response)}`, response.status);
  return response;
}

export async function headObject(config: S3Config, key: string): Promise<{ size: number } | null> {
  const signed = signRequest(config, 'HEAD', key, EMPTY_SHA256);
  const response = await fetch(signed.url, { method: 'HEAD', headers: signed.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new S3Error(`S3 HEAD ${key} failed: ${response.status}`, response.status);
  return { size: Number(response.headers.get('content-length') ?? 0) };
}

export async function deleteObject(config: S3Config, key: string): Promise<void> {
  const signed = signRequest(config, 'DELETE', key, EMPTY_SHA256);
  const response = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
  if (!response.ok && response.status !== 404) throw new S3Error(`S3 DELETE ${key} failed: ${response.status}`, response.status);
}

/** What one page of a listing holds. */
export interface Listing {
  keys: { key: string; size: number }[];
  /** With a delimiter, the "folders" one level down, each ending in it. */
  prefixes: string[];
  /** Where the next page starts, or null on the last. */
  next: string | null;
}

/**
 * One page of `ListObjectsV2`.
 *
 * Read with patterns rather than an XML parser, because the response is a flat
 * list of four element names this asks for by name, and a parser would be the
 * largest dependency in the server. Keys come back entity-escaped, and nothing
 * else in the document is read.
 */
export async function listObjects(
  config: S3Config, prefix: string, options: { delimiter?: string; token?: string } = {},
): Promise<Listing> {
  const url = bucketUrl(config);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('prefix', prefix);
  if (options.delimiter) url.searchParams.set('delimiter', options.delimiter);
  if (options.token) url.searchParams.set('continuation-token', options.token);
  const signed = signUrl(config, 'GET', url, EMPTY_SHA256);
  const response = await fetch(signed.url, { headers: signed.headers });
  if (!response.ok) throw new S3Error(`S3 LIST ${prefix} failed: ${await refusal(response)}`, response.status);

  const xml = await response.text();
  const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({
    key: unescapeXml(/<Key>([\s\S]*?)<\/Key>/.exec(match[1])?.[1] ?? ''),
    size: Number(/<Size>(\d+)<\/Size>/.exec(match[1])?.[1] ?? 0),
  }));
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)].map((match) => unescapeXml(match[1]));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const next = truncated ? unescapeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : '';
  return { keys, prefixes, next: next || null };
}

/** Every page of a listing, one after the other. */
export async function* listAll(config: S3Config, prefix: string, delimiter?: string): AsyncGenerator<Listing> {
  let token: string | undefined;
  do {
    const page = await listObjects(config, prefix, { delimiter, token });
    yield page;
    token = page.next ?? undefined;
  } while (token);
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
    throw new S3Error(`Cannot reach the object store (${exists.status}). Check endpoint, keys and clock skew.`, exists.status);
  }

  const create = signUrl(config, 'PUT', url, EMPTY_SHA256);
  const response = await fetch(create.url, { method: 'PUT', headers: create.headers });
  if (!response.ok && response.status !== 409) {
    throw new S3Error(`Could not create bucket ${config.bucket}: ${await refusal(response)}`, response.status);
  }
}

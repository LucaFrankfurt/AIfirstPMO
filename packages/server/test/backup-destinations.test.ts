/**
 * Backups that go somewhere other than a directory: a bucket, an address.
 *
 * No backup directory is configured here, on purpose — that is the case this
 * exists for: an instance on a hosted container that cannot mount a volume,
 * whose backups have to leave through the network or not at all.
 *
 * Both ends are stand-ins that behave like the real thing where it matters.
 * The bucket recomputes every signature, the query string included, because a
 * mock that accepted any `Authorization` would pass a client whose listing is
 * refused by every real store; it pages its listings two keys at a time, so the
 * continuation token is exercised; and the prefix has a space and a tilde in it,
 * which is where form encoding and SigV4's encoding part ways. The relay keeps
 * every message whole, so the attachment can be unpacked and opened.
 *
 * The test that matters most is the last one a backup is ever put to: an
 * instance that has lost its files restoring from the bucket, and from the
 * emailed attachment, and getting the files back from the bucket either way.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createTcp, type Server as TcpServer, type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

/* ------------------------------------------------------------ the bucket */

const ACCESS_KEY = 'backup-key';
const SECRET_KEY = 'backup-secret';
const BUCKET = 'kolibri-backups';
const PREFIX = 'nightly copies~test';

const objects = new Map<string, Buffer>();
const buckets = new Set<string>();
const puts: string[] = [];
let badSignatures = 0;
/** A store having a bad night: every write refused, the way a real one says it. */
let refuseWrites = false;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
/** RFC 3986, which is what S3 re-encodes the decoded query with before it checks. */
const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function signed(method: string, url: URL, headers: Record<string, string>, body: Buffer): boolean {
  const parsed = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/
    .exec(headers.authorization ?? '');
  if (!parsed) return false;
  const [, key, day, region, names, signature] = parsed;
  if (key !== ACCESS_KEY) return false;
  const payload = headers['x-amz-content-sha256'];
  if (method === 'PUT' && payload !== sha256(body)) return false;
  const query = [...url.searchParams]
    .map(([name, value]) => [rfc3986(name), rfc3986(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`).join('&');
  const canonical = [
    method, url.pathname, query,
    names.split(';').map((name) => `${name}:${String(headers[name] ?? '').trim()}\n`).join(''),
    names, payload,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', headers['x-amz-date'], scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, day), region), 's3'), 'aws4_request');
  return hmac(signingKey, toSign).toString('hex') === signature;
}

/** ListObjectsV2, two entries a page, folded by the delimiter. */
function listing(bucket: string, url: URL): string {
  const prefix = url.searchParams.get('prefix') ?? '';
  const delimiter = url.searchParams.get('delimiter') ?? '';
  const entries: { key?: string; folder?: string }[] = [];
  const folders = new Set<string>();
  for (const stored of [...objects.keys()].sort()) {
    if (!stored.startsWith(`${bucket}/`)) continue;
    const key = stored.slice(bucket.length + 1);
    if (!key.startsWith(prefix)) continue;
    const at = delimiter ? key.slice(prefix.length).indexOf(delimiter) : -1;
    if (at >= 0) {
      const folder = key.slice(0, prefix.length + at + delimiter.length);
      if (!folders.has(folder)) { folders.add(folder); entries.push({ folder }); }
    } else {
      entries.push({ key });
    }
  }
  const token = url.searchParams.get('continuation-token');
  // Base64 with its padding, so the `=` has to survive the query string.
  const start = token ? Number(Buffer.from(token, 'base64').toString().split(':')[1]) : 0;
  const page = entries.slice(start, start + 2);
  const more = start + 2 < entries.length;
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix>`
    + page.map((entry) => (entry.key
      ? `<Contents><Key>${xml(entry.key)}</Key><Size>${objects.get(`${bucket}/${entry.key}`)!.length}</Size></Contents>`
      : `<CommonPrefixes><Prefix>${xml(entry.folder!)}</Prefix></CommonPrefixes>`)).join('')
    + `<IsTruncated>${more}</IsTruncated>`
    + (more ? `<NextContinuationToken>${Buffer.from(`at:${start + 2}`).toString('base64')}</NextContinuationToken>` : '')
    + '</ListBucketResult>';
}

const s3: HttpServer = createHttp((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk) => chunks.push(chunk as Buffer));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? '/', 'http://localhost');
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, String(v)]));
    const method = request.method ?? 'GET';
    if (!signed(method, url, headers, body)) {
      badSignatures++;
      response.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    const [bucket, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const key = rest.join('/');
    const at = `${bucket}/${key}`;
    if (!key) {
      if (method === 'PUT') { buckets.add(bucket); response.writeHead(200).end(); return; }
      if (!buckets.has(bucket)) {
        response.writeHead(404).end('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>');
        return;
      }
      if (method === 'HEAD') { response.writeHead(200).end(); return; }
      response.writeHead(200, { 'content-type': 'application/xml' }).end(listing(bucket, url));
      return;
    }
    if (!buckets.has(bucket)) {
      response.writeHead(404).end('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>');
      return;
    }
    if (method === 'PUT' && refuseWrites) {
      response.writeHead(503).end('<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>');
      return;
    }
    if (method === 'PUT') { objects.set(at, body); puts.push(key); response.writeHead(200).end(); return; }
    if (method === 'DELETE') { objects.delete(at); response.writeHead(204).end(); return; }
    const stored = objects.get(at);
    if (!stored) { response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
    response.writeHead(200, { 'content-length': String(stored.length) });
    response.end(method === 'HEAD' ? undefined : stored);
  });
});

/* ------------------------------------------------------------- the relay */

interface Letter { to: string; raw: string }
const letters: Letter[] = [];
/** Messages bigger than this are refused at the end of DATA, the way a real relay's size limit is. */
let relayLimit = Infinity;

const relay: TcpServer = createTcp((socket: Socket) => {
  socket.setEncoding('utf8');
  socket.write('220 relay.test ESMTP\r\n');
  let buffer = '';
  let data: string[] | null = null;
  let to = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data) {
        if (line !== '.') { data.push(line.startsWith('..') ? line.slice(1) : line); continue; }
        const raw = data.join('\r\n');
        data = null;
        if (raw.length > relayLimit) { socket.write('552 5.3.4 Message size exceeds fixed maximum message size\r\n'); continue; }
        letters.push({ to, raw });
        socket.write('250 2.0.0 Ok: queued\r\n');
        continue;
      }
      if (/^EHLO/i.test(line)) socket.write('250-relay.test\r\n250 SIZE 52428800\r\n');
      else if (/^RCPT TO:<(.+)>/i.test(line)) { to = /^RCPT TO:<(.+)>/i.exec(line)![1]; socket.write('250 Ok\r\n'); }
      else if (/^DATA/i.test(line)) { data = []; socket.write('354 go ahead\r\n'); }
      else if (/^QUIT/i.test(line)) { socket.write('221 Bye\r\n'); socket.end(); }
      else socket.write('250 Ok\r\n');
    }
  });
  socket.on('error', () => undefined);
});

/** The parts of a message, as header text and decoded body. */
function partsOf(raw: string): { headers: string; body: Buffer }[] {
  const boundary = /boundary="([^"]+)"/.exec(raw.split('\r\n\r\n')[0])?.[1];
  const split = (part: string) => {
    const at = part.indexOf('\r\n\r\n');
    return { headers: part.slice(0, at), body: Buffer.from(part.slice(at + 4).replace(/\r\n/g, ''), 'base64') };
  };
  if (!boundary) return [split(raw)];
  return raw.split(`--${boundary}`).slice(1, -1).map((part) => split(part.replace(/^\r\n/, '')));
}

const attachmentOf = (raw: string) => partsOf(raw).find((part) => /Content-Disposition: attachment/.test(part.headers));
const textOf = (raw: string) => partsOf(raw)
  .filter((part) => /Content-Type: text\/plain/.test(part.headers))
  .map((part) => part.body.toString('utf8')).join('\n');
const subjectOf = (raw: string): string => {
  const encoded = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '';
  const b64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(encoded);
  return b64 ? Buffer.from(b64[1], 'base64').toString('utf8') : encoded;
};
const lettersTo = (to: string) => letters.filter((letter) => letter.to === to);

/* ----------------------------------------------------------- the instance */

await new Promise<void>((done) => s3.listen(0, '127.0.0.1', done));
await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));

process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-backup-destinations-${process.pid}`;
delete process.env.KOLIBRI_BACKUP_DIR;
process.env.KOLIBRI_BACKUP_S3_ENDPOINT = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
process.env.KOLIBRI_BACKUP_S3_BUCKET = BUCKET;
process.env.KOLIBRI_BACKUP_S3_ACCESS_KEY = ACCESS_KEY;
process.env.KOLIBRI_BACKUP_S3_SECRET_KEY = SECRET_KEY;
process.env.KOLIBRI_BACKUP_PREFIX = PREFIX;
process.env.KOLIBRI_BACKUP_EMAIL = 'ops@example.com';
process.env.KOLIBRI_SMTP_HOST = '127.0.0.1';
process.env.KOLIBRI_SMTP_PORT = String((relay.address() as AddressInfo).port);
process.env.KOLIBRI_SMTP_ENCRYPTION = 'none';
process.env.KOLIBRI_MAIL_FROM = 'kolibri@example.com';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { env, refreshEnv } = await import('../src/kernel/platform/env.ts');
const { unzip } = await import('../src/kernel/files/zip.ts');
const storage = await import('../src/kernel/files/storage.ts');
const backups = await import('../src/modules/operations/backups.ts');
const { verify } = await import('../src/modules/operations/restore.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let pictureKey = '';
let pictureHash = '';
let nightly = '';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function call(path: string, body?: unknown, method?: string, as = cookie) {
  return fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(as ? { cookie: as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok(path: string, body?: unknown, method?: string, as = cookie): Promise<any> {
  const response = await call(path, body, method, as);
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function signIn(): Promise<void> {
  resetRateLimits();
  const response = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' }, 'POST', '');
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  await response.text();
}

/** The backup hour today, so the sweep has something to do. */
const tonight = (days = 0): Date => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  at.setHours(env.backup.hour, 7, 0, 0);
  return at;
};

/** Say something in the environment for one test, and put it back after. */
async function saying<T>(values: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  refreshEnv();
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    refreshEnv();
  }
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const owner = await call('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  cookie = (owner.headers.get('set-cookie') ?? '').split(';')[0];
  workspaceId = ((await owner.json()) as any).workspaces[0].id;
  resetRateLimits();

  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Before', key: 'BEF' });
  await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'A task from before the backup' });
  const upload = await fetch(`${base}/api/workspaces/${workspaceId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': 'pixel.png', cookie },
    body: PIXEL,
  });
  pictureHash = ((await upload.json()) as any).hash;
  pictureKey = storage.keyFor(pictureHash, 'image/png');
});

after(() => {
  server.close();
  s3.close();
  relay.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- tests */

describe('a night with only a bucket and an address', () => {
  it('knows both are set up, and that no directory is', () => {
    const status = backups.status();
    assert.equal(status.dir, '');
    assert.equal(status.enabled, true, 'a bucket or an address is enough to switch it on');
    assert.deepEqual(status.destinations.map((place) => [place.kind, place.configured]), [['s3', true], ['email', true]]);
    assert.equal(status.keeps, true, 'a restore can keep what it replaces in the bucket');
  });

  it('does nothing outside the hour', async () => {
    const early = tonight();
    early.setHours((env.backup.hour + 1) % 24);
    assert.equal(await backups.sweepBackups(early), null);
  });

  it('takes one, sends it to both, and leaves nothing behind on this disk', async () => {
    const result = await backups.sweepBackups(tonight());
    assert.ok(result, 'the sweep ran');
    assert.equal(result!.problem, undefined, result!.problem);
    nightly = result!.taken!;
    assert.match(nightly, /^\d{4}-\d{2}-\d{2}$/, 'named for the night, like one in a directory');
    assert.deepEqual(result!.sent.map((sent) => [sent.kind, sent.ok]), [['s3', true], ['email', true]], JSON.stringify(result!.sent));
    assert.equal(badSignatures, 0, 'every request was signed the way the store checks it');

    assert.ok(objects.has(`${BUCKET}/${PREFIX}/${nightly}/kolibri.sqlite`));
    assert.ok(objects.has(`${BUCKET}/${PREFIX}/${nightly}/manifest.json`));
    assert.ok(objects.get(`${BUCKET}/${PREFIX}/blobs/${pictureKey}`)?.equals(PIXEL), 'the upload went too, by content');
    assert.ok(buckets.has(BUCKET), 'the bucket was made at the first write, not checked for first');
    assert.equal(puts.at(-1), `${PREFIX}/${nightly}/manifest.json`, 'the manifest last, so a folder with one is whole');
  });

  it('mails the database as a .zip that opens', () => {
    const [letter] = lettersTo('ops@example.com');
    assert.ok(letter, 'a message reached the address');
    assert.match(subjectOf(letter.raw), new RegExp(`Kolibri backup ${nightly}`));
    const attachment = attachmentOf(letter.raw);
    assert.ok(attachment, 'with an attachment');
    assert.match(attachment!.headers, new RegExp(`filename="kolibri-${nightly}.zip"`));

    const archive = unzip(attachment!.body);
    assert.deepEqual(archive.names().sort(), ['kolibri.sqlite', 'manifest.json'], 'the database and its manifest, and no uploads');
    const dir = mkdtempSync(join(tmpdir(), 'kolibri-attached-'));
    try {
      writeFileSync(join(dir, 'kolibri.sqlite'), archive.read('kolibri.sqlite')!);
      assert.ok(verify(dir).rows.tasks >= 1, 'it opens, and the work is in it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const text = textOf(letter.raw);
    assert.match(text, /Restore from a file/, 'it says how to put it back');
    assert.match(text, /kolibri-backups/, 'and where the files are, since they are not attached');
    assert.match(text, /can read all of it/, 'and what it costs to have it in a mailbox');
  });

  it('records how each went, and does not do the night twice', async () => {
    const records = backups.deliveries();
    assert.equal(records.s3?.ok, true);
    assert.equal(records.s3?.delivered, nightly);
    assert.equal(records.email?.snapshot, nightly);
    const mailed = lettersTo('ops@example.com').length;
    assert.equal(await backups.sweepBackups(tonight()), null, 'a second tick in the same hour is nothing');
    assert.equal(lettersTo('ops@example.com').length, mailed);
  });

  it('sends a night’s files once: the next one sends the database and nothing else', async () => {
    const done = await backups.backUpNow();
    assert.match(done.snapshot.name, /^\d{4}-\d{2}-\d{2}-\d{6}$/, 'one taken on purpose is stamped, so it cannot replace the night’s in the bucket');
    assert.equal(done.kept, false);
    assert.ok(!existsSync(done.snapshot.path), 'the scratch copy is gone');
    const s3 = done.sent.find((sent) => sent.kind === 's3')!;
    assert.match(s3.detail, /0 new file\(s\), 1 already there/, s3.detail);
    assert.ok(objects.has(`${BUCKET}/${PREFIX}/${nightly}/kolibri.sqlite`), 'the night’s is still there');
  });
});

describe('a bucket read back', () => {
  it('lists what it holds, newest first, through a paged listing', async () => {
    const held = await ok('/api/admin/backups/bucket');
    assert.ok(held.names.includes(nightly), JSON.stringify(held));
    assert.deepEqual(held.names, [...held.names].sort().reverse());
    assert.ok(!held.names.includes('blobs'), 'the shared blobs are not a snapshot');
  });

  it('restores a fresh copy of the instance, files and all, from the bucket alone', async () => {
    // What a new machine looks like: the work done since, and the file gone.
    const later = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'After', key: 'AFT' });
    assert.ok(later.id);
    await storage.remove(pictureKey);
    assert.equal(await storage.exists(pictureKey), false);

    const report = await ok(`/api/admin/backups/bucket/${nightly}/restore`, {});
    assert.equal(report.files.restored, 1, 'the picture came out of the bucket’s blobs');
    assert.equal(report.replacedIn, 'bucket', 'with no directory, what was here was kept in the bucket');
    assert.ok(objects.has(`${BUCKET}/${PREFIX}/${report.replaced}/kolibri.sqlite`), 'under the name the report gives');

    await signIn();
    const projects = await ok(`/api/workspaces/${workspaceId}/projects`);
    assert.ok(projects.some((one: any) => one.name === 'Before'));
    assert.ok(!projects.some((one: any) => one.name === 'After'), 'the work done since is gone');
    const served = await fetch(`${base}/files/${pictureHash}/pixel.png`, { headers: { cookie } });
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(PIXEL), 'and the bytes are the bytes');
  });

  it('restores the emailed attachment too, with the files from the bucket', async () => {
    const attachment = attachmentOf(lettersTo('ops@example.com')[0].raw)!;
    await storage.remove(pictureKey);
    const response = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', cookie },
      body: attachment.body,
    });
    const report = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.equal(report.files.restored, 1, 'the attachment carries no files, and the bucket had it');
    await signIn();
    assert.equal(await storage.exists(pictureKey), true);
  });

  it('says a name the bucket does not hold is not there', async () => {
    const response = await call('/api/admin/backups/bucket/1999-01-01/restore', {});
    assert.equal(response.status, 404);
    await response.text();
    const nonsense = await call('/api/admin/backups/bucket/..%2F..%2Fetc/restore', {});
    assert.equal(nonsense.status, 404);
    await nonsense.text();
  });
});

describe('when an attachment does not go', () => {
  it('sends a notice instead of a snapshot that is too big, and counts the night as failed', async () => {
    const done = await saying({ KOLIBRI_BACKUP_EMAIL_MAX_MB: '0.001' }, () => backups.backUpNow());
    const email = done.sent.find((sent) => sent.kind === 'email')!;
    assert.equal(email.ok, false);
    assert.match(email.detail, /more than the 0\.0 MB/);
    const notice = lettersTo('ops@example.com').at(-1)!;
    assert.match(subjectOf(notice.raw), /too large to email/);
    assert.equal(attachmentOf(notice.raw), undefined);
    assert.match(textOf(notice.raw), /kolibri-backups/, 'and says where the snapshot is instead');
    assert.equal(done.sent.find((sent) => sent.kind === 's3')?.ok, true, 'the bucket is not held back by the inbox');
  });

  it('tells the address when the relay refuses the attachment', async () => {
    relayLimit = 6_000;
    try {
      const done = await backups.backUpNow();
      const email = done.sent.find((sent) => sent.kind === 'email')!;
      assert.equal(email.ok, false);
      assert.match(email.detail, /552/);
      const notice = lettersTo('ops@example.com').at(-1)!;
      assert.match(subjectOf(notice.raw), /refused by the mail provider/);
      assert.match(textOf(notice.raw), /552 5\.3\.4/, 'quoting what the relay said');
    } finally {
      relayLimit = Infinity;
    }
  });

  it('tells the address when the bucket did not take tonight’s copy', async () => {
    refuseWrites = true;
    try {
      const done = await backups.backUpNow();
      const s3 = done.sent.find((sent) => sent.kind === 's3')!;
      assert.equal(s3.ok, false);
      assert.match(s3.detail, /503 SlowDown — Please reduce your request rate/, 'the store’s own words, not its XML');
      assert.equal(done.sent.find((sent) => sent.kind === 'email')?.ok, true, 'the email still goes');
      const letter = lettersTo('ops@example.com').at(-1)!;
      assert.ok(attachmentOf(letter.raw), 'with the database attached');
      assert.match(textOf(letter.raw), /did not arrive: .*SlowDown/, 'and a line saying the bucket refused it');
    } finally {
      refuseWrites = false;
    }
  });

  it('writes to the address when there was nothing to send at all', async () => {
    // A directory that cannot be one, for a night that has not been tried yet.
    const result = await saying({ KOLIBRI_BACKUP_DIR: '/dev/null/kolibri' }, () => backups.sweepBackups(tonight(1)));
    assert.ok(result?.problem, 'the night failed');
    const notice = lettersTo('ops@example.com').at(-1)!;
    assert.match(subjectOf(notice.raw), /Kolibri backup failed/);
    const records = backups.deliveries();
    assert.equal(records.s3?.ok, false, 'and both places say so on the screen');
    assert.equal(records.s3?.delivered?.startsWith(nightly.slice(0, 10)), true, 'without forgetting when it last worked');
  });
});

describe('a directory as well', () => {
  it('sends a night that was taken and never sent — a restart between the two', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kolibri-backup-dir-'));
    try {
      await saying({ KOLIBRI_BACKUP_DIR: dir }, async () => {
        const night = tonight(2);
        const taken = backups.take(dir, { now: night })!;
        assert.equal(taken.manifest.uploads, 'included', 'a directory keeps the files beside the database');
        const result = await backups.sweepBackups(night);
        assert.equal(result?.taken, null, 'nothing new was taken: the night’s is there');
        assert.deepEqual(result?.sent.map((sent) => [sent.kind, sent.ok]), [['s3', true], ['email', true]]);
        assert.ok(objects.has(`${BUCKET}/${PREFIX}/${taken.snapshot.name}/kolibri.sqlite`));
        assert.equal(await backups.sweepBackups(night), null, 'and once sent, the night is done');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the settings screen', () => {
  it('tries both the way a night would, and cleans up after itself', async () => {
    const before = lettersTo('ops@example.com').length;
    const result = await ok('/api/instance/test/backup', {});
    assert.equal(result.ok, true);
    assert.match(result.bucket, /kolibri-backups/);
    assert.equal(result.email, 'ops@example.com');
    assert.ok(![...objects.keys()].some((key) => key.includes('.kolibri-test')), 'the test object is gone again');
    const test = lettersTo('ops@example.com').slice(before)[0];
    assert.match(attachmentOf(test.raw)!.headers, /kolibri-test\.zip/, 'with a .zip, which is what a provider may refuse');
  });

  it('refuses what a console’s copy button tends to produce', async () => {
    for (const [key, value, said] of [
      ['KOLIBRI_BACKUP_S3_BUCKET', 's3://kolibri-backups', /Just the bucket/],
      ['KOLIBRI_BACKUP_HOUR', '25', /0 to 23/],
      ['KOLIBRI_BACKUP_EMAIL', 'not an address', /not an email address/],
      ['KOLIBRI_BACKUP_S3_ENDPOINT', 's3.fr-par.scw.cloud', /not a web address/],
    ] as const) {
      const response = await call('/api/instance/settings', { settings: { [key]: value } });
      assert.equal(response.status, 400, key);
      assert.match(((await response.json()) as any).message, said);
    }
  });

  it('shows a region nobody typed as what applies, not as a value', async () => {
    const state = await ok('/api/instance/settings');
    const region = state.settings.find((one: any) => one.key === 'KOLIBRI_BACKUP_S3_REGION');
    assert.equal(region.value, '');
    assert.equal(region.inherited, 'us-east-1');
    assert.equal(region.inherits, true);
    const secret = state.settings.find((one: any) => one.key === 'KOLIBRI_BACKUP_S3_SECRET_KEY');
    assert.equal(secret.value, '', 'a secret never leaves');
    assert.equal(secret.inherited, undefined);
    assert.deepEqual(state.status.backup.places.map((place: any) => place.kind), ['s3', 'email']);
  });

  it('takes an address typed into the app over the environment’s, and gives it back', async () => {
    await ok('/api/instance/settings', { settings: { KOLIBRI_BACKUP_EMAIL: 'night@example.com' } });
    assert.equal(env.backup.email.to, 'night@example.com');
    await ok('/api/instance/settings', { settings: { KOLIBRI_BACKUP_EMAIL: null } });
    assert.equal(env.backup.email.to, 'ops@example.com');
  });

  it('says the older switch cannot work on an instance whose uploads are on disk', async () => {
    const said = await saying({ KOLIBRI_BACKUP_OFFSITE: 'true', KOLIBRI_BACKUP_S3_BUCKET: '' }, async () =>
      backups.places().find((place) => place.kind === 's3'));
    assert.equal(said?.configured, false);
    assert.match(said?.problem ?? '', /KOLIBRI_BACKUP_OFFSITE/);
  });

  it('is not something an ordinary member can ask about', async () => {
    const invite = await ok(`/api/workspaces/${workspaceId}/invites`, { role: 'member' });
    resetRateLimits();
    const joined = await call('/api/auth/register', {
      email: 'grace@example.com', name: 'Grace', password: 'correct horse battery', invite: invite.code,
    }, 'POST', '');
    const as = (joined.headers.get('set-cookie') ?? '').split(';')[0];
    await joined.text();
    resetRateLimits();
    for (const path of ['/api/admin/backups/bucket']) {
      const refused = await call(path, undefined, 'GET', as);
      assert.equal(refused.status, 403, path);
      await refused.text();
    }
    const restore = await call(`/api/admin/backups/bucket/${nightly}/restore`, {}, 'POST', as);
    assert.equal(restore.status, 403);
    await restore.text();
    assert.ok(get<any>(`SELECT id FROM users WHERE email = 'grace@example.com'`));
  });
});

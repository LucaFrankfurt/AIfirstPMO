/**
 * Web Push and bounce handling.
 *
 * The push is driven against a *real* push service running in this process,
 * because the only interesting question is what leaves this server: a VAPID
 * token it can verify, no body at all, and a subscription that disappears the
 * moment the service says it is gone.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-push-${process.pid}`;
process.env.KOLIBRI_BOUNCE_TOKEN = 'bounce-secret';

import assert from 'node:assert/strict';
import { createPublicKey, createVerify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { keys, authorization, notifyDevices, subscribe } = await import('../src/adapters/push/push.ts');
const { isSuppressed, queueMail, suppress, unsuppress } = await import('../src/adapters/mail/mail.ts');
const { all, get, run } = await import('../src/kernel/platform/db/index.ts');
const { env } = await import('../src/kernel/platform/env.ts');

/* ---------------------------------------------------- the push service */

interface Received { path: string; auth: string; body: string; ttl: string }
let received: Received[] = [];
/** What the fake service answers next: 201, or something else. */
let answer = 201;

const service = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk) => chunks.push(chunk as Buffer));
  request.on('end', () => {
    received.push({
      path: request.url ?? '',
      auth: String(request.headers.authorization ?? ''),
      body: Buffer.concat(chunks).toString(),
      ttl: String(request.headers.ttl ?? ''),
    });
    response.writeHead(answer).end();
  });
});

let base = '';
let serviceUrl = '';
let cookie = '';
let userId = '';
let workspaceId = '';

async function ok(path: string, body?: unknown, method?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  await new Promise<void>((done) => service.listen(0, '127.0.0.1', done));
  // `https` in the URL is what the subscriber checks; the socket is local.
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  // A push service on loopback is refused by default — see `outbound.ts`. The
  // stand-in has to be local for the test to see what arrived, so the check is
  // relaxed here and asserted on its own in `injection.test.ts`.
  env.outbound.allowPrivate = true;

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  userId = session.user.id;
  workspaceId = session.workspaces[0].id;
});

after(() => {
  server.close();
  service.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the VAPID identity', () => {
  it('is one key pair, kept, and its signature verifies', () => {
    const first = keys();
    assert.match(first.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(keys().publicKey, first.publicKey, 'asking twice is the same instance, not a new one');

    const header = authorization('https://push.example.com/xyz');
    const [, token] = /vapid t=([^,]+)/.exec(header)!;
    const [head, claims, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });

    const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(body.aud, 'https://push.example.com', 'the audience is the origin, not the endpoint');
    assert.ok(body.exp > Math.floor(Date.now() / 1000));

    // The point of a VAPID token is that the push service can check it, so the
    // test checks it the same way — with the public key the header advertises.
    const point = Buffer.from(/k=([A-Za-z0-9_-]+)/.exec(header)![1], 'base64url');
    const spki = Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      point,
    ]);
    const verified = createVerify('SHA256')
      .update(`${head}.${claims}`)
      .verify(
        { key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      );
    assert.equal(verified, true);
  });

  it('hands the browser the public half and nothing else', async () => {
    const config = await ok('/api/push/key');
    assert.equal(config.enabled, true);
    assert.equal(config.key, keys().publicKey);
    assert.equal((config as any).privateKeyPem, undefined);
  });
});

describe('a subscribed device', () => {
  before(() => {
    received = [];
    answer = 201;
    // Subscribed directly: the endpoint has to be this test's own service, and
    // the HTTP route quite rightly insists on https.
    subscribe(userId, { endpoint: `${serviceUrl}/push/abc`, keys: { p256dh: 'p', auth: 'a' } });
  });

  it('is woken with a token and no body at all', async () => {
    notifyDevices(userId);
    await settle();

    assert.equal(received.length, 1);
    assert.equal(received[0].path, '/push/abc');
    assert.match(received[0].auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(received[0].body, '', 'nothing of anybody’s sits on a push service');
    assert.equal(received[0].ttl, '86400');
  });

  it('is woken when a notification is written, not only when asked', async () => {
    received = [];
    const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Push', key: 'PSH' });
    const task = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Look at this' });

    // A second person assigning it to Ada is what produces a notification.
    run(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('other', 'grace@example.com', 'Grace', '', ?, ?)`,
      Date.now(), Date.now());
    run(`INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at) VALUES ('m2', ?, 'other', 'member', ?, ?)`,
      workspaceId, Date.now(), Date.now());
    const { writeEntity } = await import('../src/kernel/write-path/repo.ts');
    const { serverClock } = await import('../src/kernel/write-path/bootstrap.ts');
    writeEntity('task', task.id, { assignees: [userId] }, {
      workspaceId, actorId: 'other', hlc: serverClock.now(),
    });
    await settle(80);

    assert.equal(received.length, 1, 'one notification, one wake-up');
    const latest = await ok('/api/notifications/latest');
    assert.match(latest.title, /Look at this/, 'and the worker has a sentence to show');
    assert.match(latest.url, /^\/t\//);
  });

  it('is forgotten when the push service says it is gone', async () => {
    answer = 410;
    notifyDevices(userId);
    await settle();
    assert.equal(all(`SELECT id FROM push_subscriptions WHERE user_id = ?`, userId).length, 0);
  });

  it('is not duplicated when the same browser subscribes again', () => {
    subscribe(userId, { endpoint: `${serviceUrl}/push/same` });
    subscribe(userId, { endpoint: `${serviceUrl}/push/same` });
    assert.equal(all(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, `${serviceUrl}/push/same`).length, 1);
  });
});

describe('bounces', () => {
  it('stops writing to an address a provider reported', async () => {
    const response = await fetch(`${base}/api/mail/bounces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bounce-secret' },
      body: JSON.stringify({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'gone@example.com', Description: 'No such user' }),
    });
    assert.equal(response.status, 200);
    assert.equal(isSuppressed('gone@example.com'), true);
    assert.equal(queueMail({ to: 'gone@example.com', subject: 'x', text: 'y' }), null, 'and queues nothing for it');
  });

  it('reads Amazon’s shape, and only its permanent bounces', async () => {
    const send = (message: unknown) => fetch(`${base}/api/mail/bounces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bounce-secret' },
      body: JSON.stringify({ Message: JSON.stringify(message) }),
    });

    await send({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'hard@example.com' }] } });
    await send({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] } });
    await send({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'annoyed@example.com' }] } });

    assert.equal(isSuppressed('hard@example.com'), true);
    assert.equal(isSuppressed('full@example.com'), false, 'a full mailbox is a bad afternoon, not a dead address');
    assert.equal(isSuppressed('annoyed@example.com'), true);
    assert.equal(get<any>(`SELECT reason FROM email_suppressions WHERE email = 'annoyed@example.com'`)?.reason, 'complaint');
  });

  it('refuses a report without the shared secret', async () => {
    const response = await fetch(`${base}/api/mail/bounces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anybody@example.com', type: 'bounce' }),
    });
    assert.equal(response.status, 401);
    assert.equal(isSuppressed('anybody@example.com'), false);
  });

  it('can be undone, because a mailbox that was full stops being full', async () => {
    suppress('back@example.com', 'bounce');
    assert.equal(isSuppressed('back@example.com'), true);
    unsuppress('back@example.com');
    assert.equal(isSuppressed('back@example.com'), false);
  });
});

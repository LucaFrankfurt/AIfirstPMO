/**
 * Waking the packaged app, through the relay.
 *
 * Driven against a stand-in relay in this process, because the questions worth
 * asking are about what leaves this server: one wake for a burst rather than
 * one per notification, nothing in it about what happened, no phone whose
 * session has ended, and a token Apple or Google said is gone, gone here too.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-app-push-${process.pid}`;

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { flushAppWakes } = await import('../src/adapters/push/app.ts');
const { createNotification } = await import('../src/modules/notifications/notify.ts');
const { all } = await import('../src/kernel/platform/db/index.ts');
const { env } = await import('../src/kernel/platform/env.ts');

/* ------------------------------------------------------------ the relay */

let woken: { path: string; body: any }[] = [];
/** What the stand-in says Apple and Google reported gone, next time. */
let gone: string[] = [];

const relay = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk) => chunks.push(chunk as Buffer));
  request.on('end', () => {
    woken.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ gone }));
  });
});

let base = '';

/** Sign in the way the app does, and keep the session token it is handed. */
async function signIn(email: string, register = false): Promise<{ token: string; userId: string; workspaceId: string }> {
  const response = await fetch(`${base}/api/auth/${register ? 'register' : 'login'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kolibri-client': 'native' },
    body: JSON.stringify({ email, password: 'correct horse battery', name: email.split('@')[0], locale: 'de' }),
  });
  const session = await response.json() as any;
  assert.equal(typeof session.token, 'string', `no session token for ${email}: ${JSON.stringify(session).slice(0, 200)}`);
  return { token: session.token, userId: session.user.id, workspaceId: session.workspaces[0]?.id };
}

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const notify = (userId: string, workspaceId: string, title = 'Grace commented on WEB-12') =>
  createNotification({ workspaceId, userId, kind: 'comment', title, body: 'The secret launch date is Friday' });

let ada: { token: string; userId: string; workspaceId: string };
const PHONE = 'a'.repeat(64);

before(async () => {
  await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
  env.push.relay = `http://127.0.0.1:${(relay.address() as AddressInfo).port}/`;
  // A relay on loopback is refused by default — see `outbound.ts`. The stand-in
  // has to be local for the test to see what arrived.
  env.outbound.allowPrivate = true;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ada = await signIn('ada@example.com', true);
});

beforeEach(() => {
  woken = [];
  gone = [];
});

after(() => {
  server.close();
  relay.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a phone saying it wants to be woken', () => {
  it('is told the server can wake it', async () => {
    const { json } = await call(ada.token, '/api/push/key');
    assert.equal(json.app, true);
  });

  it('registers on its session, and only as a phone could', async () => {
    assert.equal((await call(ada.token, '/api/push/app', { platform: 'ios', token: PHONE })).status, 200);
    assert.equal((await call(ada.token, '/api/push/app', { platform: 'windows', token: PHONE })).status, 400);
    assert.equal((await call(ada.token, '/api/push/app', { platform: 'ios', token: 'short' })).status, 400);
    assert.equal((await call(ada.token, '/api/push/app', { platform: 'ios', token: 'has spaces in it, so no' })).status, 400);
    assert.equal(all(`SELECT * FROM app_push_tokens WHERE user_id = ?`, ada.userId).length, 1);
  });

  /* A script has no phone, and an API token has no sign-out to end it with. */
  it('is refused on an API token', async () => {
    const made = await call(ada.token, '/api/tokens', { name: 'script', scopes: ['read', 'write'] });
    const { status } = await call(made.json.token, '/api/push/app', { platform: 'android', token: 'b'.repeat(64) });
    assert.equal(status, 400);
  });
});

describe('a notification', () => {
  /*
   * The whole of option A. The relay — and Apple, and Google — learn that a
   * phone should be woken and in which language, and nothing else: not the
   * title, not the body, not the workspace, not this server's address.
   */
  it('wakes the phone with a token, a platform and a language, and nothing about what happened', async () => {
    notify(ada.userId, ada.workspaceId);
    await flushAppWakes();
    assert.equal(woken.length, 1);
    assert.equal(woken[0].path, '/v1/wake');
    assert.deepEqual(woken[0].body, { devices: [{ platform: 'ios', token: PHONE }], locale: 'de' });
    const sent = JSON.stringify(woken[0].body);
    for (const secret of ['Grace', 'WEB-12', 'Friday', ada.workspaceId, ada.userId]) {
      assert.ok(!sent.includes(secret), `the relay was told ${secret}`);
    }
  });

  it('wakes once for a burst, not once per notification', async () => {
    for (let i = 0; i < 15; i++) notify(ada.userId, ada.workspaceId, `Change ${i}`);
    await flushAppWakes();
    assert.equal(woken.length, 1);
  });

  it('forgets a phone Apple or Google said is gone', async () => {
    gone = [PHONE];
    notify(ada.userId, ada.workspaceId);
    await flushAppWakes();
    assert.equal(all(`SELECT * FROM app_push_tokens WHERE token = ?`, PHONE).length, 0);
    notify(ada.userId, ada.workspaceId);
    await flushAppWakes();
    assert.equal(woken.length, 1, 'woken again after the platform said the token was over');
  });
});

describe('when the session ends', () => {
  /*
   * A phone that signed out must stop buzzing for the account it signed out
   * of — and so must one whose session was revoked from another device, which
   * is the case the phone itself never hears about.
   */
  it('signing out stops the waking', async () => {
    const phone = await signIn('ada@example.com');
    await call(phone.token, '/api/push/app', { platform: 'android', token: 'c'.repeat(80) });
    notify(ada.userId, ada.workspaceId);
    await flushAppWakes();
    assert.equal(woken.at(-1)?.body.devices.length, 1);

    await call(phone.token, '/api/auth/logout', {});
    woken = [];
    notify(ada.userId, ada.workspaceId);
    await flushAppWakes();
    assert.equal(woken.length, 0, 'a signed-out phone was still woken');
    assert.equal(all(`SELECT * FROM app_push_tokens WHERE token = ?`, 'c'.repeat(80)).length, 0);
  });

  it('a phone handed to somebody else wakes for them and not for the first', async () => {
    const shared = 'd'.repeat(64);
    await call(ada.token, '/api/push/app', { platform: 'ios', token: shared });
    const grace = await signIn('grace@example.com', true);
    await call(grace.token, '/api/push/app', { platform: 'ios', token: shared });

    notify(ada.userId, ada.workspaceId);
    await flushAppWakes();
    assert.equal(woken.length, 0, 'the first owner still woke a phone that is now somebody else\'s');

    // And the first owner cannot take it off the second.
    await call(ada.token, '/api/push/app/forget', { token: shared });
    assert.equal(all(`SELECT * FROM app_push_tokens WHERE token = ? AND user_id = ?`, shared, grace.userId).length, 1);
  });
});

describe('an instance that does not wake the app', () => {
  it('says so, refuses a phone, and sends nothing', async () => {
    const relayWas = env.push.relay;
    env.push.relay = '';
    try {
      assert.equal((await call(ada.token, '/api/push/key')).json.app, false);
      assert.equal((await call(ada.token, '/api/push/app', { platform: 'ios', token: 'e'.repeat(64) })).status, 400);
      notify(ada.userId, ada.workspaceId);
      await flushAppWakes();
      assert.equal(woken.length, 0);
    } finally {
      env.push.relay = relayWas;
    }
  });
});

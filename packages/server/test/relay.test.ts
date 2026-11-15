/**
 * The push relay, against stand-ins for Google and Apple in this process.
 *
 * Nothing here can reach the real services — they need the publisher's
 * credentials — so what is checked is what would be sent to them: a JWT each
 * service could verify with the key it holds for us, the request shapes their
 * documentation describes, and what the relay does with each answer they are
 * documented to give. Whether Apple and Google agree is the one thing only a
 * real key and a real phone can show; `docs/mobile.md` says so.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttp2Server, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { fcmSender, readServiceAccount } from '../src/adapters/relay/fcm.ts';
import { apnsSender } from '../src/adapters/relay/apns.ts';
import { createRelay } from '../src/adapters/relay/relay.ts';
import type { Outcome, Sender } from '../src/adapters/relay/sender.ts';
import { wakeWords } from '../src/adapters/relay/words.ts';

const decode = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString());

function verifies(jwt: string, key: KeyObject, algorithm: 'RSA-SHA256' | 'SHA256', p1363 = false): boolean {
  const [head, claims, signature] = jwt.split('.');
  return createVerify(algorithm).update(`${head}.${claims}`)
    .verify(p1363 ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(signature, 'base64url'));
}

const listen = (server: { listen: (port: number, host: string, done: () => void) => void; address: () => unknown }) =>
  new Promise<string>((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

const PHONE = 'f'.repeat(152);

/* ------------------------------------------------------------- Google */

describe('Firebase Cloud Messaging', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let google = '';
  let assertions: string[] = [];
  let messages: { path: string; auth: string; body: any }[] = [];
  /** What the next message is answered with. */
  let answer: { status: number; body: unknown }[] = [];

  const service = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      if (request.url === '/token') {
        assertions.push(new URLSearchParams(text).get('assertion') ?? '');
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: `access-${assertions.length}`, expires_in: 3600 }));
        return;
      }
      messages.push({ path: request.url ?? '', auth: String(request.headers.authorization), body: JSON.parse(text) });
      const next = answer.shift() ?? { status: 200, body: { name: 'projects/kolibri/messages/1' } };
      response.writeHead(next.status, { 'content-type': 'application/json' }).end(JSON.stringify(next.body));
    });
  });

  let sender: Sender;
  before(async () => {
    google = await listen(service);
    sender = fcmSender(readServiceAccount(JSON.stringify({
      project_id: 'kolibri-app',
      client_email: 'relay@kolibri-app.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: `${google}/token`,
    })), { endpoint: google });
  });
  beforeEach(() => { messages = []; answer = []; });
  after(() => service.close());

  /* The assertion is what Google checks against the key it issued us. */
  it('signs in as the service account with a JWT Google could verify', async () => {
    assert.equal(await sender.send(PHONE, wakeWords('en')), 'sent');
    const [head, claims] = assertions[0].split('.');
    assert.deepEqual(decode(head), { alg: 'RS256', typ: 'JWT' });
    const body = decode(claims);
    assert.equal(body.iss, 'relay@kolibri-app.iam.gserviceaccount.com');
    assert.equal(body.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(body.aud, `${google}/token`);
    assert.ok(verifies(assertions[0], rsa.publicKey, 'RSA-SHA256'));
  });

  it('keeps the access token for the hour it is good for', async () => {
    const before = assertions.length;
    await sender.send(PHONE, wakeWords('en'));
    await sender.send(PHONE, wakeWords('en'));
    assert.equal(assertions.length, before, 'a new access token per message');
  });

  it('posts the fixed sentence, collapsed, opening on the inbox', async () => {
    await sender.send(PHONE, wakeWords('de'));
    const [sent] = messages;
    assert.equal(sent.path, '/v1/projects/kolibri-app/messages:send');
    assert.match(sent.auth, /^Bearer access-\d+$/);
    assert.deepEqual(sent.body.message.notification, { title: 'Neue Aktivität', body: 'Öffne Kolibri, um zu sehen, was neu ist.' });
    assert.equal(sent.body.message.token, PHONE);
    assert.deepEqual(sent.body.message.data, { url: '/inbox' });
    assert.equal(sent.body.message.android.collapse_key, 'kolibri');
    assert.equal(sent.body.message.android.notification.tag, 'kolibri');
    // A drawable the app ships; the launcher icon would be a white square.
    assert.equal(sent.body.message.android.notification.icon, 'ic_stat_kolibri');
  });

  it('calls a token gone when Google says UNREGISTERED, or that it belongs to another project', async () => {
    answer = [{ status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }];
    assert.equal(await sender.send(PHONE, wakeWords('en')), 'gone');
    answer = [{ status: 403, body: { error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } } }];
    assert.equal(await sender.send(PHONE, wakeWords('en')), 'gone');
  });

  it('does not call a token gone for a failure of its own', async () => {
    answer = [{ status: 503, body: { error: { status: 'UNAVAILABLE' } } }];
    assert.equal(await sender.send(PHONE, wakeWords('en')), 'failed');
    answer = [{ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' } } }];
    assert.equal(await sender.send(PHONE, wakeWords('en')), 'failed');
  });

  it('asks for a fresh access token once when Google stops honouring the old one', async () => {
    const before = assertions.length;
    answer = [{ status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }];
    assert.equal(await sender.send(PHONE, wakeWords('en')), 'sent');
    assert.equal(assertions.length, before + 1);
    assert.equal(messages.length, 2);
  });
});

/* -------------------------------------------------------------- Apple */

describe('the APNs provider API', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  interface Seen { host: string; headers: IncomingHttpHeaders; body: any }
  let seen: Seen[] = [];
  /** Per host, what the next request is answered with. */
  const answers: Record<string, { status: number; reason?: string }[]> = { production: [], sandbox: [] };

  const apple = (name: 'production' | 'sandbox'): Http2Server => createHttp2Server((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      seen.push({ host: name, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const next = answers[name].shift() ?? { status: 200 };
      response.writeHead(next.status, { 'content-type': 'application/json' });
      response.end(next.reason ? JSON.stringify({ reason: next.reason }) : '');
    });
  });
  const production = apple('production');
  const sandbox = apple('sandbox');
  let sender: Sender;

  before(async () => {
    sender = apnsSender(
      { keyId: 'ABC123DEFG', teamId: 'TEAM123456', key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), topic: 'day.kolibri.client' },
      { production: await listen(production), sandbox: await listen(sandbox) },
    );
  });
  beforeEach(() => { seen = []; answers.production = []; answers.sandbox = []; });
  after(() => {
    sender.close?.();
    production.close();
    sandbox.close();
  });

  it('signs with an ES256 provider token Apple could verify against the key it issued', async () => {
    assert.equal(await sender.send('a'.repeat(64), wakeWords('en')), 'sent');
    const token = String(seen[0].headers.authorization).replace(/^bearer /, '');
    const [head, claims] = token.split('.');
    assert.deepEqual(decode(head), { alg: 'ES256', kid: 'ABC123DEFG' });
    assert.equal(decode(claims).iss, 'TEAM123456');
    assert.ok(verifies(token, ec.publicKey, 'SHA256', true));
  });

  it('asks production for a visible alert, collapsed, for this app', async () => {
    await sender.send('a'.repeat(64), wakeWords('fr'));
    const [{ host, headers, body }] = seen;
    assert.equal(host, 'production');
    assert.equal(headers[':path'], `/3/device/${'a'.repeat(64)}`);
    assert.equal(headers['apns-topic'], 'day.kolibri.client');
    assert.equal(headers['apns-push-type'], 'alert');
    assert.equal(headers['apns-collapse-id'], 'kolibri');
    assert.deepEqual(body.aps.alert, { title: 'Nouvelle activité', body: 'Ouvrez Kolibri pour voir les nouveautés.' });
    assert.equal(body.url, '/inbox');
  });

  /* A build from Xcode is given a sandbox token, and the token does not say so. */
  it('tries the sandbox before calling a development phone\'s token bad', async () => {
    answers.production = [{ status: 400, reason: 'BadDeviceToken' }];
    assert.equal(await sender.send('b'.repeat(64), wakeWords('en')), 'sent');
    assert.deepEqual(seen.map((one) => one.host), ['production', 'sandbox']);
  });

  it('calls a token gone when Apple says the app is gone, or it is bad on both services', async () => {
    answers.production = [{ status: 410, reason: 'Unregistered' }];
    assert.equal(await sender.send('c'.repeat(64), wakeWords('en')), 'gone');
    answers.production = [{ status: 400, reason: 'BadDeviceToken' }];
    answers.sandbox = [{ status: 400, reason: 'BadDeviceToken' }];
    assert.equal(await sender.send('d'.repeat(64), wakeWords('en')), 'gone');
  });

  it('does not call a token gone for a failure of its own', async () => {
    answers.production = [{ status: 403, reason: 'InvalidProviderToken' }];
    assert.equal(await sender.send('e'.repeat(64), wakeWords('en')), 'failed');
  });
});

/* ------------------------------------------------------------ the relay */

describe('the relay', () => {
  const sent: { platform: string; token: string; title: string }[] = [];
  const fake = (platform: string, outcome: (token: string) => Outcome = () => 'sent'): Sender => ({
    async send(token, words) {
      sent.push({ platform, token, title: words.title });
      return outcome(token);
    },
  });
  const relay = createServer(createRelay({
    android: fake('android'),
    ios: fake('ios', (token) => (token.startsWith('gone') ? 'gone' : 'sent')),
  }));
  let base = '';

  const wake = (body: unknown) => fetch(`${base}/v1/wake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  before(async () => { base = await listen(relay); });
  beforeEach(() => { sent.length = 0; });
  after(() => relay.close());

  it('wakes each phone on its own platform, in the reader\'s language, and says which are gone', async () => {
    const response = await wake({
      devices: [{ platform: 'android', token: 'a'.repeat(100) }, { platform: 'ios', token: `gone${'x'.repeat(60)}` }],
      locale: 'de',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { gone: [`gone${'x'.repeat(60)}`] });
    assert.deepEqual(sent.map((one) => [one.platform, one.title]).sort(), [['android', 'Neue Aktivität'], ['ios', 'Neue Aktivität']]);
  });

  it('says it in English for a language it does not have', async () => {
    await wake({ devices: [{ platform: 'android', token: 'b'.repeat(100) }], locale: 'tlh' });
    assert.equal(sent[0].title, 'New activity');
  });

  /* Whatever a caller sends, the phone is shown the one sentence. */
  it('ignores any text it is sent', async () => {
    await wake({ devices: [{ platform: 'android', token: 'c'.repeat(100) }], locale: 'en', title: 'Your account is locked', body: 'call us' });
    assert.equal(sent[0].title, 'New activity');
  });

  it('skips what is not a phone it can reach, rather than failing the rest', async () => {
    const response = await wake({
      devices: [{ platform: 'windows', token: 'd'.repeat(100) }, { platform: 'ios', token: 'short' }, { platform: 'ios', token: 'e'.repeat(64) }, null],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(sent.map((one) => one.token), ['e'.repeat(64)]);
  });

  /* A server gathers for two seconds; more than six a minute is not a server. */
  it('wakes one phone at most six times a minute', async () => {
    for (let i = 0; i < 9; i++) await wake({ devices: [{ platform: 'android', token: 'f'.repeat(100) }] });
    assert.equal(sent.length, 6);
  });

  it('refuses what is not a wake', async () => {
    assert.equal((await wake('not json')).status, 400);
    assert.equal((await wake({ devices: Array.from({ length: 21 }, (_, i) => ({ platform: 'ios', token: `${i}`.padEnd(64, 'g') })) })).status, 400);
    assert.equal((await wake({ devices: 'all of them' })).status, 400);
    assert.equal((await wake('x'.repeat(70 * 1024))).status, 413);
    assert.equal((await fetch(`${base}/v1/anything`)).status, 404);
    assert.equal(sent.length, 0);
  });

  it('says which platforms it can reach', async () => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, android: true, ios: true });
  });
});

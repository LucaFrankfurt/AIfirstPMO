/**
 * Settings an admin changes without touching the container.
 *
 * The interesting cases are not "does it save". They are the three rules the
 * feature rests on, each of which is a way to get this wrong:
 *
 *  - a stored value **wins over the environment**, and clearing it hands the
 *    setting back — otherwise the screen is a lie on any instance whose
 *    compose file has an opinion;
 *  - a secret **never comes back out**, and is not sitting in the database in
 *    the clear either;
 *  - only the account that holds the *instance* may touch any of it. A
 *    workspace owner is not that, and on an instance where anybody may sign up
 *    everybody is a workspace owner.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-settings-${process.pid}`;
process.env.KOLIBRI_SMTP_HOST = 'relay.from-the-environment.test';
process.env.KOLIBRI_MAIL_FROM = 'kolibri@example.com';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { env } = await import('../src/kernel/platform/env.ts');
const { get, run } = await import('../src/kernel/platform/db/index.ts');
const { loadSettings, resetSettings } = await import('../src/kernel/platform/settings.ts');
const { refreshEnv } = await import('../src/kernel/platform/env.ts');

let base = '';
/** The admin: the first account on the instance claims it. */
let adminCookie = '';
/** Somebody who owns a workspace of their own and nothing else. */
let ownerCookie = '';

async function call(cookie: string, path: string, body?: unknown, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0], password: 'correct horse battery' }),
  });
  const body = await response.json();
  assert.equal(response.status < 400, true, JSON.stringify(body));
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

const save = (cookie: string, settings: Record<string, string | null>) =>
  call(cookie, '/api/instance/settings', { settings });

const valueOf = (state: any, key: string) => state.settings.find((row: any) => row.key === key);

/**
 * Scaleway's API, answering everything with `status` and keeping what it was
 * sent. Its address goes in through the environment, the only place
 * `KOLIBRI_SCALEWAY_EMAIL_URL` is read from.
 */
async function fakeScaleway(status: number) {
  const calls: { token: string | undefined; body: any }[] = [];
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({ token: req.headers['x-auth-token'] as string | undefined, body: JSON.parse(raw || '{}') });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status < 300
        ? { emails: [{ id: 'scw-1', message_id: '<test@kolibri>' }] }
        : { message: 'insufficient permissions', type: 'permissions_denied' }));
    });
  });
  await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
  process.env.KOLIBRI_SCALEWAY_EMAIL_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}/emails`;
  return {
    calls,
    close: () => { api.close(); delete process.env.KOLIBRI_SCALEWAY_EMAIL_URL; },
  };
}

/** Whatever earlier tests left due, so a test counts only its own message. */
const dropDueMail = () =>
  run(`UPDATE email_queue SET failed_at = ? WHERE sent_at IS NULL AND failed_at IS NULL`, Date.now());

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminCookie = await register('ada@example.com');
  ownerCookie = await register('grace@example.com');
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

beforeEach(() => resetSettings());

describe('who may configure the instance', () => {
  it('lets the account that claimed the server read and write', async () => {
    const read = await call(adminCookie, '/api/instance/settings');
    assert.equal(read.status, 200);
    assert.ok(read.body.settings.length > 10);
  });

  it('refuses an owner of a workspace inside it', async () => {
    assert.equal((await call(ownerCookie, '/api/instance/settings')).status, 403);
    assert.equal((await save(ownerCookie, { KOLIBRI_SMTP_HOST: 'relay.theirs.test' })).status, 403);
    assert.equal((await call(ownerCookie, '/api/instance/test/mail', {})).status, 403);
  });

  it('refuses somebody who is not signed in at all', async () => {
    assert.equal((await call('', '/api/instance/settings')).status, 401);
  });

  it('says so in the session, so the screen knows whether to offer it', async () => {
    const mine = await call(adminCookie, '/api/session');
    const theirs = await call(ownerCookie, '/api/session');
    assert.equal(mine.body.instanceAdmin, true);
    assert.equal(theirs.body.instanceAdmin, false);
  });
});

describe('a stored setting and the environment', () => {
  it('starts out reading the environment', async () => {
    const state = await call(adminCookie, '/api/instance/settings');
    const host = valueOf(state.body, 'KOLIBRI_SMTP_HOST');
    assert.equal(host.value, 'relay.from-the-environment.test');
    assert.equal(host.source, 'environment');
  });

  it('lets what was typed in win, without a restart', async () => {
    const saved = await save(adminCookie, { KOLIBRI_SMTP_HOST: 'relay.typed-in.test', KOLIBRI_SMTP_PORT: '2525' });
    assert.equal(saved.status, 200);
    // The running server, not just the answer: this is the whole point.
    assert.equal(env.mail.host, 'relay.typed-in.test');
    assert.equal(env.mail.port, 2525);
    assert.equal(valueOf(saved.body, 'KOLIBRI_SMTP_HOST').source, 'app');
  });

  it('hands the setting back to the environment when it is cleared', async () => {
    await save(adminCookie, { KOLIBRI_SMTP_HOST: 'relay.typed-in.test' });
    assert.equal(env.mail.host, 'relay.typed-in.test');
    const cleared = await save(adminCookie, { KOLIBRI_SMTP_HOST: null });
    assert.equal(env.mail.host, 'relay.from-the-environment.test');
    assert.equal(valueOf(cleared.body, 'KOLIBRI_SMTP_HOST').source, 'environment');
  });

  it('turns mail on and off through the transport it decides', async () => {
    assert.equal(env.mailTransport, 'smtp');
    await save(adminCookie, { KOLIBRI_SMTP_HOST: null });
    // Nothing in the environment either, once the host is gone from both.
    assert.equal(env.mail.host, 'relay.from-the-environment.test');
    await save(adminCookie, { KOLIBRI_MAIL_TRANSPORT: 'scaleway' });
    // Named but not configured is off, rather than quietly falling back to the
    // relay that is configured — the same refusal `env.ts` makes.
    assert.equal(env.mailTransport, 'off');
    assert.equal(env.mailEnabled, false);
  });

  it('switches Telegram on with a token and off again', async () => {
    assert.equal(env.telegramEnabled, false);
    await save(adminCookie, { KOLIBRI_TELEGRAM_BOT_TOKEN: '123456789:AAH-fake-token-for-a-test-only' });
    assert.equal(env.telegramEnabled, true);
    await save(adminCookie, { KOLIBRI_TELEGRAM_BOT_TOKEN: null });
    assert.equal(env.telegramEnabled, false);
  });

  it('picks a model provider the same way', async () => {
    assert.equal(env.aiProvider, 'off');
    await save(adminCookie, { KOLIBRI_AI_PROVIDER: 'anthropic', KOLIBRI_AI_API_KEY: 'sk-not-a-real-key' });
    assert.equal(env.aiProvider, 'anthropic');
    assert.equal(env.ai.key, 'sk-not-a-real-key');
  });
});

describe('a secret', () => {
  it('never comes back out', async () => {
    const saved = await save(adminCookie, { KOLIBRI_SMTP_PASS: 'hunter2' });
    const pass = valueOf(saved.body, 'KOLIBRI_SMTP_PASS');
    assert.equal(pass.value, '', 'the value must not be returned');
    assert.equal(pass.set, true, 'but it must say that there is one');
    assert.equal(JSON.stringify(saved.body).includes('hunter2'), false);
    // And it is in effect all the same.
    assert.equal(env.mail.pass, 'hunter2');
  });

  it('is not in the database in the clear', async () => {
    await save(adminCookie, { KOLIBRI_SMTP_PASS: 'hunter2' });
    const row = get<any>(`SELECT value, secret FROM instance_settings WHERE key = 'KOLIBRI_SMTP_PASS'`);
    assert.equal(row.secret, 1);
    assert.equal(row.value.includes('hunter2'), false);
    assert.match(row.value, /^v1\./);
  });

  it('reads as unset rather than as gibberish when the seal cannot be opened', async () => {
    await save(adminCookie, { KOLIBRI_SMTP_PASS: 'hunter2' });
    // What a restore without the `.secret` file looks like from in here: the
    // row is unreadable, and the next start-up is what finds that out.
    run(`UPDATE instance_settings SET value = 'v1.AAAA.BBBB.CCCC' WHERE key = 'KOLIBRI_SMTP_PASS'`);
    loadSettings();
    refreshEnv();
    const state = await call(adminCookie, '/api/instance/settings');
    assert.equal(valueOf(state.body, 'KOLIBRI_SMTP_PASS').set, false);
  });
});

describe('what it refuses', () => {
  it('refuses a setting it has never heard of', async () => {
    const result = await save(adminCookie, { KOLIBRI_SECRET: 'nice try' });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /not a setting/);
  });

  it('refuses a port that is not one', async () => {
    assert.equal((await save(adminCookie, { KOLIBRI_SMTP_PORT: '70000' })).status, 400);
    assert.equal((await save(adminCookie, { KOLIBRI_SMTP_PORT: 'five eight seven' })).status, 400);
  });

  it('refuses a sender address that cannot be sent from', async () => {
    assert.equal((await save(adminCookie, { KOLIBRI_MAIL_FROM: 'not an address' })).status, 400);
    // A bare host is a domain — the rule this project already settled once.
    assert.equal((await save(adminCookie, { KOLIBRI_MAIL_FROM: 'kolibri@localhost' })).status, 200);
  });

  it('refuses a bot token of the wrong shape, where the failure is otherwise a 404', async () => {
    assert.equal((await save(adminCookie, { KOLIBRI_TELEGRAM_BOT_TOKEN: 'bot123:abc' })).status, 400);
  });

  it('refuses a newline, which is how a header or an SMTP line is forged', async () => {
    assert.equal((await save(adminCookie, { KOLIBRI_SMTP_USER: 'someone\r\nDATA' })).status, 400);
  });

  it('writes nothing at all when one field of the form is wrong', async () => {
    const result = await save(adminCookie, { KOLIBRI_SMTP_HOST: 'relay.good.test', KOLIBRI_SMTP_PORT: '0' });
    assert.equal(result.status, 400);
    assert.equal(env.mail.host, 'relay.from-the-environment.test', 'the good field must not have landed');
  });
});

describe('the test button', () => {
  it('says what is missing rather than failing silently', async () => {
    await save(adminCookie, { KOLIBRI_MAIL_TRANSPORT: 'scaleway' });
    const mail = await call(adminCookie, '/api/instance/test/mail', {});
    assert.equal(mail.status, 400);
    assert.match(mail.body.message, /No mail transport/);

    const telegram = await call(adminCookie, '/api/instance/test/telegram', {});
    assert.equal(telegram.status, 400);
    assert.match(telegram.body.message, /bot token/);

    const ai = await call(adminCookie, '/api/instance/test/ai', {});
    assert.equal(ai.status, 400);
    assert.match(ai.body.message, /No model/);
  });

  it('has nothing to say about a group that does not exist', async () => {
    assert.equal((await call(adminCookie, '/api/instance/test/carrier-pigeon', {})).status, 400);
  });

  it('repeats what the relay said rather than saying the test failed', async () => {
    // Port 1 on loopback: nothing listens, and the point is that the sentence
    // on screen is the connection's own — "connection refused" and
    // "authentication failed" send you to two different places.
    await save(adminCookie, { KOLIBRI_SMTP_HOST: '127.0.0.1', KOLIBRI_SMTP_PORT: '1', KOLIBRI_SMTP_ENCRYPTION: 'none' });
    const result = await call(adminCookie, '/api/instance/test/mail', {});
    assert.equal(result.status, 400);
    assert.match(String(result.body.message), /ECONNREFUSED|refused|connect/i);
  });

  it('sends through Scaleway with the key and project stored here, over the environment’s', async () => {
    // The environment names another key and project, as a container carrying
    // a neighbouring app's `SCW_*` variables would: what was typed in here has
    // to be what reaches Scaleway — the project under the body's `project_id`,
    // where the API reads it, and the key in `X-Auth-Token`.
    process.env.SCW_SECRET_KEY_EMAIL = 'key-from-the-environment';
    process.env.SCW_PROJECT_ID = 'project-from-the-environment';
    const api = await fakeScaleway(200);
    try {
      dropDueMail();
      await save(adminCookie, {
        KOLIBRI_MAIL_TRANSPORT: 'scaleway',
        KOLIBRI_SCALEWAY_SECRET_KEY: 'key-typed-in-the-app',
        KOLIBRI_SCALEWAY_PROJECT_ID: 'project-typed-in-the-app',
      });
      const result = await call(adminCookie, '/api/instance/test/mail', {});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(api.calls.length, 1);
      const [sent] = api.calls;
      assert.equal(sent.token, 'key-typed-in-the-app');
      assert.equal(sent.body.project_id, 'project-typed-in-the-app');
      assert.deepEqual(sent.body.from, { email: 'kolibri@example.com', name: 'Kolibri' });
      assert.deepEqual(sent.body.to, [{ email: 'ada@example.com' }]);
    } finally {
      api.close();
      delete process.env.SCW_SECRET_KEY_EMAIL;
      delete process.env.SCW_PROJECT_ID;
    }
  });

  it('leaves the admin’s address alone when Scaleway refuses the key, and asks again next time', async () => {
    // A 403 is the key's problem — its permission, or a project that is not
    // its own — and used to put the admin's own address on the suppression
    // list, so every later test sent nothing at all. It is final for that one
    // message and says nothing about the person it was for.
    const api = await fakeScaleway(403);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      dropDueMail();
      await save(adminCookie, {
        KOLIBRI_MAIL_TRANSPORT: 'scaleway',
        KOLIBRI_SCALEWAY_SECRET_KEY: 'a-key-without-the-permission',
        KOLIBRI_SCALEWAY_PROJECT_ID: 'a-project',
      });
      for (const path of ['/api/instance/test/mail', '/api/mail/test']) {
        const refused = await call(adminCookie, path, {});
        assert.equal(refused.status, 400);
        assert.match(refused.body.message, /HTTP 403/, path);
      }
      assert.equal(api.calls.length, 2, 'the second test did not reach Scaleway');
      assert.equal(get(`SELECT 1 FROM email_suppressions`), undefined, 'a refused key suppressed the recipient');
    } finally {
      console.warn = warn;
      api.close();
      run(`DELETE FROM email_suppressions`);
    }
  });

  it('says the address is suppressed, rather than repeating the refusal that put it there', async () => {
    // A 400 is the one Scaleway refusal still read as the address's: final,
    // and it puts the address on the list. The next test sends nothing, and
    // has to say why rather than show the first one's refusal as its own —
    // from either of the two test buttons.
    const api = await fakeScaleway(400);
    try {
      dropDueMail();
      await save(adminCookie, {
        KOLIBRI_MAIL_TRANSPORT: 'scaleway',
        KOLIBRI_SCALEWAY_SECRET_KEY: 'a-key',
        KOLIBRI_SCALEWAY_PROJECT_ID: 'a-project',
      });
      const first = await call(adminCookie, '/api/instance/test/mail', {});
      assert.equal(first.status, 400);
      assert.match(first.body.message, /HTTP 400/);
      for (const path of ['/api/instance/test/mail', '/api/mail/test']) {
        const again = await call(adminCookie, path, {});
        assert.equal(again.status, 400);
        assert.match(again.body.message, /suppression list/, path);
      }
      assert.equal(api.calls.length, 1, 'only the first test reached Scaleway');
    } finally {
      api.close();
      run(`DELETE FROM email_suppressions`);
    }
  });

  it('asks the model a question and says which one answered', async () => {
    const fake = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }));
      });
    });
    await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
    try {
      await save(adminCookie, {
        KOLIBRI_AI_PROVIDER: 'anthropic',
        KOLIBRI_AI_API_KEY: 'sk-not-a-real-key',
        KOLIBRI_AI_MODEL: 'a-model',
        KOLIBRI_AI_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      });
      const result = await call(adminCookie, '/api/instance/test/ai', {});
      assert.equal(result.status, 200);
      assert.equal(result.body.detail, 'a-model');
    } finally {
      fake.close();
    }
  });
});

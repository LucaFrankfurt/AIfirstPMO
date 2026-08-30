/**
 * Telegram as a notification channel.
 *
 * The Bot API is stood up locally rather than mocked at the module boundary:
 * `KOLIBRI_TELEGRAM_API` exists so a test can point the real `fetch` at a real
 * server, which means the request shape, the JSON envelope and the error codes
 * are all exercised instead of asserted about. A stub of `call()` would pass
 * even if the payload were nonsense.
 *
 * What is worth testing here is mostly consent and refusal: that a chat can
 * only be connected by somebody holding a live code, that a spent code stays
 * spent, that `/stop` works from Telegram's side, and that an account which
 * blocked the bot is disconnected rather than retried forever.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-telegram-${process.pid}`;

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

/* ------------------------------------------------------- the Telegram stand-in */

interface Sent {
  method: string;
  payload: any;
}

/** Every call the server made, in order. */
const sent: Sent[] = [];
/** What the next call to a given method should answer, when not the default. */
const replies = new Map<string, { status: number; body: any }>();

const fake: Server = createServer((req, res) => {
  const method = String(req.url ?? '').split('/').pop() ?? '';
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const payload = raw ? JSON.parse(raw) : {};
    sent.push({ method, payload });
    const scripted = replies.get(method);
    if (scripted) {
      replies.delete(method);
      res.writeHead(scripted.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body));
      return;
    }
    const result = method === 'getMe' ? { username: 'kolibri_test_bot' } : method === 'getUpdates' ? [] : { message_id: 1 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
process.env.KOLIBRI_TELEGRAM_API = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.KOLIBRI_TELEGRAM_BOT_TOKEN = 'test-token';
process.env.KOLIBRI_PUBLIC_URL = 'https://kolibri.example';

const { server } = await import('../src/index.ts');
const { env } = await import('../src/kernel/platform/env.ts');
const telegram = await import('../src/adapters/telegram/telegram.ts');
const { createNotification } = await import('../src/modules/notifications/notify.ts');
const { all, get, run } = await import('../src/kernel/platform/db/index.ts');

/* -------------------------------------------------------------------- setup */

let base = '';
let cookie = '';
let workspaceId = '';
let ada = '';

async function call(path: string, body?: unknown, method?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ok(path: string, body?: unknown, method?: string): Promise<any> {
  const result = await call(path, body, method);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', {
    email: 'ada@example.com', name: 'Ada', password: 'correct horse battery',
  });
  ada = session.user.id;
  workspaceId = session.workspaces[0].id;
});

after(() => {
  server.close();
  fake.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

beforeEach(async () => {
  // Sends are fired without being awaited, so the previous test may still have
  // one in flight. Drain first, then clear — otherwise it lands in this test's
  // log and the count is somebody else's.
  await settle();
  sent.length = 0;
  replies.clear();
  telegram.forgetBot();
  telegram.unlink(ada);
  run(`UPDATE users SET telegram_prefs = 'all' WHERE id = ?`, ada);
  run(`DELETE FROM notifications`);
});

/**
 * Connect Ada's account to a chat, the way a person would.
 *
 * Waits for the confirmation Telegram gets sent, then forgets it: every caller
 * cares about what happens *after* linking, and leaving the confirmation in the
 * log makes `messages()` count one thing more than the test is about.
 */
let chats = 0;
let chat = '';

async function link(chatId?: string): Promise<string> {
  // A fresh chat each time unless the test names one. The sender holds a
  // message per second per chat — Telegram's own limit — so reusing one id
  // would make every second test wait on the first one's delivery.
  chat = chatId ?? String(700000 + (chats += 1));
  const started = await telegram.startLink(ada);
  telegram.handleUpdate({ update_id: 1, message: { chat: { id: chat }, text: `/start ${started.code}` } } as any);
  await settle();
  sent.length = 0;
  return started.code;
}

const notify = (over: Record<string, unknown> = {}): string =>
  createNotification({
    workspaceId, userId: ada, kind: 'assigned', title: 'Assigned: KOL-1 Ship it', ...over,
  } as any);

/** The delivery is fired without being awaited, so give it a moment to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

const messages = (): Sent[] => sent.filter((entry) => entry.method === 'sendMessage');

/* -------------------------------------------------------------------- tests */

describe('connecting an account to a chat', () => {
  it('hands out a deep link carrying a single-use code', async () => {
    const started = await telegram.startLink(ada);
    assert.match(started.url, /^https:\/\/t\.me\/kolibri_test_bot\?start=[0-9a-f]{32}$/);
    assert.equal(started.url.split('start=')[1], started.code);
    assert.ok(started.expiresAt > Date.now());
    assert.ok(get(`SELECT code FROM telegram_links WHERE code = ?`, started.code));
  });

  it('only ever keeps one live code per account', async () => {
    const first = await telegram.startLink(ada);
    await telegram.startLink(ada);
    assert.equal(get(`SELECT code FROM telegram_links WHERE code = ?`, first.code), undefined);
    assert.equal(all(`SELECT code FROM telegram_links WHERE user_id = ?`, ada).length, 1);
  });

  it('connects the chat the code was sent from', async () => {
    const started = await telegram.startLink(ada);
    telegram.handleUpdate({ update_id: 1, message: { chat: { id: '55555' }, text: `/start ${started.code}` } } as any);
    assert.equal(telegram.linkedChat(ada), '55555');
    // And says so, in the chat, rather than only in the app.
    await settle();
    assert.equal(messages().length, 1);
    assert.match(messages()[0].payload.text, /Connected/);
  });

  it('refuses a code that has already been spent', async () => {
    const started = await telegram.startLink(ada);
    telegram.handleUpdate({ update_id: 1, message: { chat: { id: '1' }, text: `/start ${started.code}` } } as any);
    telegram.unlink(ada);
    const outcome = telegram.handleUpdate({ update_id: 2, message: { chat: { id: '9' }, text: `/start ${started.code}` } } as any);
    assert.equal(outcome, 'ignored');
    assert.equal(telegram.linkedChat(ada), null);
  });

  it('refuses a code that has expired', async () => {
    const started = await telegram.startLink(ada);
    run(`UPDATE telegram_links SET expires_at = ? WHERE code = ?`, Date.now() - 1, started.code);
    const outcome = telegram.handleUpdate({ update_id: 1, message: { chat: { id: '7' }, text: `/start ${started.code}` } } as any);
    assert.equal(outcome, 'ignored');
    assert.equal(telegram.linkedChat(ada), null);
  });

  it('sweeps codes nobody used', async () => {
    const started = await telegram.startLink(ada);
    run(`UPDATE telegram_links SET expires_at = ? WHERE code = ?`, Date.now() - 1, started.code);
    assert.equal(telegram.expireLinks(), 1);
    assert.equal(all(`SELECT code FROM telegram_links`).length, 0);
  });

  it('moves the chat to the account that just claimed it', async () => {
    // Registering signs this client in as Lin; Ada's session has to come back
    // or every later request in this file is quietly somebody else's.
    const ada$ = cookie;
    const session = await call('/api/auth/register', {
      email: 'lin@example.com', name: 'Lin', password: 'correct horse battery',
    });
    const lin = session.body.user.id;
    cookie = ada$;
    await link('3131');

    const started = await telegram.startLink(lin);
    telegram.handleUpdate({ update_id: 2, message: { chat: { id: '3131' }, text: `/start ${started.code}` } } as any);

    // One phone cannot be two people's notification channel at once.
    assert.equal(telegram.linkedChat(lin), '3131');
    assert.equal(telegram.linkedChat(ada), null);
    telegram.unlink(lin);
  });

  it('disconnects on /stop, from Telegram rather than from the app', async () => {
    await link('808');
    const outcome = telegram.handleUpdate({ update_id: 2, message: { chat: { id: '808' }, text: '/stop' } } as any);
    assert.equal(outcome, 'unlinked');
    assert.equal(telegram.linkedChat(ada), null);
  });

  it('ignores a /stop from a chat it does not know', () => {
    assert.equal(telegram.handleUpdate({ update_id: 1, message: { chat: { id: '404' }, text: '/stop' } } as any), 'ignored');
  });

  it('answers a bare /start with what to do instead of a silence', async () => {
    telegram.handleUpdate({ update_id: 1, message: { chat: { id: '12' }, text: '/start' } } as any);
    await settle();
    assert.match(messages()[0].payload.text, /Settings/);
  });
});

describe('delivering a notification', () => {
  it('sends to the linked chat and records that it went', async () => {
    await link();
    const id = notify();
    await settle();

    const message = messages().at(-1)!;
    assert.equal(message.payload.chat_id, chat);
    assert.match(message.payload.text, /Assigned: KOL-1 Ship it/);
    assert.equal(get<any>(`SELECT telegram_sent_at FROM notifications WHERE id = ?`, id)?.telegram_sent_at > 0, true);
  });

  it('links back into the app when the instance knows its own address', async () => {
    await link();
    notify({ taskId: 'task-9' });
    await settle();
    assert.match(messages().at(-1)!.payload.text, /https:\/\/kolibri\.example\/t\/task-9/);
  });

  it('escapes a title that contains markup rather than sending it', async () => {
    await link();
    notify({ title: 'Assigned: <b>KOL-1</b> & co' });
    await settle();
    const text = messages().at(-1)!.payload.text;
    assert.ok(text.includes('&lt;b&gt;KOL-1&lt;/b&gt; &amp; co'), text);
  });

  it('sends nothing to an account that never connected a chat', async () => {
    notify();
    await settle();
    assert.equal(messages().length, 0);
  });

  it('honours "none"', async () => {
    await link();
    run(`UPDATE users SET telegram_prefs = 'none' WHERE id = ?`, ada);
    notify();
    await settle();
    assert.equal(messages().length, 0);
  });

  it('on "important" sends a mention and holds back a page edit', async () => {
    await link();
    run(`UPDATE users SET telegram_prefs = 'important' WHERE id = ?`, ada);
    notify({ kind: 'page_changed', title: 'A page changed' });
    await settle();
    assert.equal(messages().length, 0);

    notify({ kind: 'mention', title: 'You were mentioned' });
    await settle();
    assert.equal(messages().length, 1);
  });

  it('records a failure on the row instead of losing it', async () => {
    await link();
    replies.set('sendMessage', { status: 200, body: { ok: false, error_code: 500, description: 'Bad Gateway' } });
    const id = notify();
    await settle();

    const row = get<any>(`SELECT * FROM notifications WHERE id = ?`, id)!;
    assert.equal(row.telegram_sent_at, null);
    assert.equal(row.telegram_attempts, 1);
    assert.match(row.telegram_error, /Bad Gateway/);
  });

  it('retries what failed, and stops once it is through', async () => {
    await link();
    replies.set('sendMessage', { status: 200, body: { ok: false, error_code: 500, description: 'Bad Gateway' } });
    const id = notify();
    await settle();

    const result = await telegram.retryPending();
    assert.deepEqual(result, { sent: 1, failed: 0 });
    assert.ok(get<any>(`SELECT telegram_sent_at FROM notifications WHERE id = ?`, id)!.telegram_sent_at > 0);

    // Already delivered, so a second sweep has nothing to do.
    assert.deepEqual(await telegram.retryPending(), { sent: 0, failed: 0 });
  });

  it('gives up after the attempt limit rather than retrying forever', async () => {
    await link();
    const id = notify();
    await settle();
    run(`UPDATE notifications SET telegram_sent_at = NULL, telegram_attempts = ? WHERE id = ?`, env.telegram.maxAttempts, id);
    assert.deepEqual(await telegram.retryPending(), { sent: 0, failed: 0 });
  });

  it('disconnects an account that blocked the bot', async () => {
    await link();
    replies.set('sendMessage', { status: 200, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
    notify();
    await settle();

    // Consent withdrawn from the other side is consent withdrawn.
    assert.equal(telegram.linkedChat(ada), null);
  });
});

describe('the long poll', () => {
  it('acknowledges past the highest update it handled', async () => {
    const started = await telegram.startLink(ada);
    replies.set('getUpdates', {
      status: 200,
      body: { ok: true, result: [{ update_id: 17, message: { chat: { id: '99' }, text: `/start ${started.code}` } }] },
    });
    assert.equal(await telegram.pollOnce(), 1);
    assert.equal(telegram.linkedChat(ada), '99');

    // The next poll must not ask for update 17 again.
    await telegram.pollOnce();
    const poll = sent.filter((entry) => entry.method === 'getUpdates').at(-1)!;
    assert.equal(poll.payload.offset, 18);
  });

  it('leaves the cursor alone when there is nothing to read', async () => {
    const before = sent.length;
    assert.equal(await telegram.pollOnce(), 0);
    assert.ok(sent.length > before);
  });
});

describe('the settings routes', () => {
  it('reports the instance and the account separately', async () => {
    const status = await ok('/api/telegram/status');
    assert.equal(status.enabled, true);
    assert.equal(status.linked, false);
    assert.equal(status.preference, 'all');

    await link();
    assert.equal((await ok('/api/telegram/status')).linked, true);
  });

  it('hands out the link and takes it back', async () => {
    const link = await ok('/api/telegram/link', {});
    assert.match(link.url, /t\.me\/kolibri_test_bot/);
    await ok('/api/telegram/unlink', {});
    assert.equal((await ok('/api/telegram/status')).linked, false);
  });

  it('never puts the bot token in an answer', async () => {
    const status = JSON.stringify(await ok('/api/telegram/status'));
    const link = JSON.stringify(await ok('/api/telegram/link', {}));
    assert.ok(!status.includes('test-token'));
    assert.ok(!link.includes('test-token'));
  });

  it('refuses a test message with no chat connected', async () => {
    const result = await call('/api/telegram/test', {});
    assert.equal(result.status, 400);
    assert.match(result.body.message, /no Telegram chat/i);
  });

  it('sends a test message once connected', async () => {
    await link();
    assert.deepEqual(await ok('/api/telegram/test', {}), { sent: true });
    assert.match(messages().at(-1)!.payload.text, /working/i);
  });

  it('stores the preference and refuses one it does not know', async () => {
    await ok('/api/me', { telegram_prefs: 'important' }, 'PATCH');
    assert.equal((await ok('/api/telegram/status')).preference, 'important');
    await ok('/api/me', { telegram_prefs: 'whenever' }, 'PATCH');
    assert.equal((await ok('/api/telegram/status')).preference, 'important');
  });

  it('needs a session', async () => {
    const anonymous = await fetch(`${base}/api/telegram/status`);
    assert.equal(anonymous.status, 401);
  });
});

describe('an instance with no bot configured', () => {
  it('says so rather than pretending the channel exists', async () => {
    const token = env.telegram.botToken;
    env.telegram.botToken = '';
    try {
      assert.equal(env.telegramEnabled, false);
      assert.equal((await ok('/api/telegram/status')).enabled, false);
      assert.equal((await call('/api/telegram/link', {})).status, 400);
      // And a notification is simply written without a delivery attempt.
      notify();
      await settle();
      assert.equal(messages().length, 0);
    } finally {
      env.telegram.botToken = token;
    }
  });
});

describe('what counts as important', () => {
  it('is one definition, and the instant channels add exactly one kind to it', async () => {
    const { isImportantFor } = await import('@kolibri/shared');
    for (const kind of ['assigned', 'mention', 'invite', 'due_soon']) {
      assert.equal(isImportantFor('email', kind), true, kind);
      assert.equal(isImportantFor('instant', kind), true, kind);
    }
    // A chat message belongs on a phone in a second or not at all; a batched
    // digest would deliver it too late to answer.
    assert.equal(isImportantFor('instant', 'message'), true);
    assert.equal(isImportantFor('email', 'message'), false);
    // And neither channel invents anything else.
    assert.equal(isImportantFor('instant', 'page_changed'), false);
    assert.equal(isImportantFor('email', 'comment'), false);
  });

  it('sends a message on "important" and holds back a page edit', async () => {
    await link();
    run(`UPDATE users SET telegram_prefs = 'important' WHERE id = ?`, ada);
    notify({ kind: 'message', title: 'Lin in #general' });
    await settle();
    assert.equal(messages().length, 1);
  });
});

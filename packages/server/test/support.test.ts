/**
 * Support: a chat widget on somebody else's site, and the team answering it.
 *
 * Most of this is about the wall between the two sides — what a visitor's
 * browser can reach, what proves who they are, and what never leaves the
 * server — and then the loop itself: a message in, a notification out, an
 * answer back, live or by email.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-support-${process.pid}`;
process.env.KOLIBRI_WEB_DIR = `/tmp/kolibri-support-web-${process.pid}`;
process.env.KOLIBRI_SMTP_HOST = 'localhost';

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

mkdirSync(process.env.KOLIBRI_WEB_DIR!, { recursive: true });
writeFileSync(`${process.env.KOLIBRI_WEB_DIR}/widget.html`, '<!doctype html><title>chat</title>');

const { server } = await import('../src/index.ts');
const { all, get, run } = await import('../src/kernel/platform/db/index.ts');
const { pruneEmptyConversations, sealWidgetSecrets } = await import('../src/modules/support/support.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { replyTag, replyText, takeReply } = await import('../src/adapters/widget/mail.ts');
const { writeEntity } = await import('../src/kernel/write-path/repo.ts');
const { serverClock } = await import('../src/kernel/write-path/bootstrap.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';

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

/** A visitor's browser: no cookie, a session header once it has one. */
async function visit(path: string, body?: unknown, session?: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { 'x-widget-session': session } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** What a host site's server does with `jose`, written out so the test needs nothing installed. */
function hostToken(secret: string, claims: Record<string, unknown>, alg = 'HS256'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = part({ alg });
  const body = part(claims);
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

let widget: any;
let secret = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  projectId = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Support', key: 'SUP' })).id;
  resetRateLimits();
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.KOLIBRI_WEB_DIR!, { recursive: true, force: true });
});

describe('a widget', () => {
  it('needs support switched on', async () => {
    await assert.rejects(
      ok(`/api/workspaces/${workspaceId}/widgets`, { project_id: projectId, name: 'Merchants' }),
      /switched off/,
    );
  });

  it('is made by an admin, with a secret the server minted and never syncs', async () => {
    await ok(`/api/workspaces/${workspaceId}`, { features: { support: true } }, 'PATCH');
    widget = await ok(`/api/workspaces/${workspaceId}/widgets`, {
      project_id: projectId,
      name: 'Merchants',
      origins: ['example.com', 'https://dev.example.com/shop?x=1', 'http://evil.example', '*.shops.example.com', '*.com', 'http://*.example.com'],
      secret: 'chosen-by-the-client',
    });
    assert.equal('secret' in widget, false, 'the secret is not in the row a client is sent');
    assert.deepEqual(
      widget.origins,
      ['https://example.com', 'https://dev.example.com', 'https://*.shops.example.com'],
      'origins, not URLs; no http; a pattern only as every subdomain of a domain',
    );
    assert.equal(widget.identity, 'signed');
    secret = (await ok(`/api/widgets/${widget.id}/secret`)).secret;
    assert.ok(secret.length >= 32);
    assert.notEqual(secret, 'chosen-by-the-client');
    const stored = get<any>(`SELECT secret FROM widgets WHERE id = ?`, widget.id).secret;
    assert.match(stored, /^v1\./, 'sealed in the database');
    assert.equal(stored.includes(secret), false, 'a copied backup is not a copied key');
  });

  it('seals a key stored before keys were sealed, once, and keeps it working', async () => {
    const legacy = await ok(`/api/workspaces/${workspaceId}/widgets`, { project_id: projectId, name: 'Legacy' });
    run(`UPDATE widgets SET secret = 'typed-before-sealing-existed' WHERE id = ?`, legacy.id);
    sealWidgetSecrets();
    sealWidgetSecrets();
    const stored = get<any>(`SELECT secret FROM widgets WHERE id = ?`, legacy.id).secret;
    assert.match(stored, /^v1\./);
    assert.equal((await ok(`/api/widgets/${legacy.id}/secret`)).secret, 'typed-before-sealing-existed', 'sealed once, not twice');
    await ok(`/api/widgets/${legacy.id}`, undefined, 'DELETE');
  });

  it('hands its secret only to a credential that may write', async () => {
    // The secret signs any visitor in as any customer and writes into the
    // workspace as them, so a read-only token that could fetch it could write.
    const readOnly = (await ok('/api/tokens', { name: 'reports', scopes: 'read' })).token;
    const asToken = (method: string) => fetch(`${base}/api/widgets/${widget.id}/secret`, {
      method, headers: { authorization: `Bearer ${readOnly}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal((await asToken('GET')).status, 403, 'reading it is refused');
    assert.equal((await asToken('POST')).status, 403, 'rotating it is refused');
    assert.equal((await ok(`/api/widgets/${widget.id}/secret`)).secret, secret, 'and it was not rotated');

    const writer = (await ok('/api/tokens', { name: 'deploy', scopes: 'read,write' })).token;
    const revealed = await fetch(`${base}/api/widgets/${widget.id}/secret`, { headers: { authorization: `Bearer ${writer}` } });
    assert.equal(revealed.status, 200, 'an admin\'s token that may write still can');
    assert.equal(((await revealed.json()) as { secret: string }).secret, secret);
  });

  it('serves its page to the sites it names, and only those', async () => {
    const response = await fetch(`${base}/w/${widget.id}`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors 'self' https:\/\/example\.com https:\/\/dev\.example\.com https:\/\/\*\.shops\.example\.com;/);
    assert.equal(response.headers.get('x-frame-options'), null);
    const config = await visit(`/w/${widget.id}/config`);
    assert.equal(config.json.widget.name, 'Merchants');
    assert.equal('secret' in config.json.widget, false);
    assert.equal('agents' in config.json.widget, false);
  });
});

describe('a signed visitor', () => {
  let session = '';

  it('is refused without a token signed with this widget\'s secret', async () => {
    resetRateLimits();
    const claims = { sub: 'merchant-7', name: 'Grace', email: 'grace@example.com', exp: inAnHour() };
    assert.equal((await visit(`/w/${widget.id}/session`, { token: hostToken('wrong', claims) })).status, 401);
    assert.equal((await visit(`/w/${widget.id}/session`, { token: hostToken(secret, claims, 'none') })).status, 401);
    assert.equal((await visit(`/w/${widget.id}/session`, { token: hostToken(secret, { ...claims, exp: inAnHour() - 7200 }) })).status, 401);
    const forever = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, { ...claims, exp: inAnHour() + 86_400 * 365 }) });
    assert.equal(forever.status, 401);
    assert.match(forever.json.message, /longer than a day/);
    assert.equal((await visit(`/w/${widget.id}/session`, { name: 'Grace' })).status, 401, 'a signed widget believes no typed name');
  });

  it('opens one conversation, under the id their own site gave them', async () => {
    const token = hostToken(secret, { sub: 'merchant-7', name: 'Grace', email: 'grace@example.com', exp: inAnHour() });
    const first = await visit(`/w/${widget.id}/session`, { token });
    assert.equal(first.status, 200);
    session = first.json.session;
    const again = await visit(`/w/${widget.id}/session`, { token });
    assert.equal(again.json.conversation.id, first.json.conversation.id, 'the same visitor finds the same thread');
    const row = get<any>(`SELECT * FROM conversations WHERE id = ?`, first.json.conversation.id);
    assert.equal(row.visitor_id, 'merchant-7');
    assert.equal(row.visitor_email, 'grace@example.com');
    assert.equal(row.verified, 1);
  });

  it('writes, and the team is told once per burst', async () => {
    const before = all(`SELECT * FROM notifications WHERE kind = 'support'`).length;
    const sent = await visit(`/w/${widget.id}/messages`, { body: 'The invoice export is empty.' }, session);
    assert.equal(sent.status, 200);
    assert.equal(sent.json.message.author, 'visitor');
    await visit(`/w/${widget.id}/messages`, { body: 'Since this morning.' }, session);
    const told = all<any>(`SELECT * FROM notifications WHERE kind = 'support'`);
    assert.equal(told.length - before, 1, 'two lines in a row are one notification');
    assert.match(told[told.length - 1].title, /Grace via Merchants/);
    const conversation = get<any>(`SELECT * FROM conversations WHERE widget_id = ?`, widget.id);
    assert.equal(conversation.last_author, 'visitor');
    assert.equal(conversation.status, 'open');
  });

  it('refuses a session for another widget, or none', async () => {
    assert.equal((await visit(`/w/${widget.id}/messages`)).status, 401);
    assert.equal((await visit(`/w/${widget.id}/messages`, undefined, 'forged.token')).status, 401);
  });

  it('hears the answer live, and the email it would have got is withdrawn once read', async () => {
    const conversation = get<any>(`SELECT * FROM conversations WHERE widget_id = ?`, widget.id);
    const history = await visit(`/w/${widget.id}/messages`, undefined, session);
    const after = Math.max(...history.json.messages.map((message: any) => message.seq));

    const controller = new AbortController();
    const stream = await fetch(`${base}/w/${widget.id}/stream?session=${encodeURIComponent(session)}&after=${after}`, { signal: controller.signal });
    const reader = stream.body!.getReader();

    const answer = await ok(`/api/workspaces/${workspaceId}/conversation-messages`, {
      conversation_id: conversation.id, body: 'Fixed — try again?', author: 'visitor', author_id: 'somebody-else',
    });
    assert.equal(answer.author, 'agent', 'who wrote it is the server\'s to say');
    assert.notEqual(answer.author_id, 'somebody-else');

    let heard = '';
    const decoder = new TextDecoder();
    while (!heard.includes('Fixed')) heard += decoder.decode((await reader.read()).value);
    controller.abort();
    assert.match(heard, /event: message/);
    assert.match(heard, /"agent":"Ada"/);

    const queued = get<any>(`SELECT * FROM email_queue WHERE kind = 'support' AND sent_at IS NULL`);
    assert.equal(queued.to_email, 'grace@example.com');
    assert.ok(queued.send_after > Date.now() + 60_000, 'not at once: they may still be in the window');
    assert.equal((await visit(`/w/${widget.id}/read`, {}, session)).status, 200);
    assert.equal(get(`SELECT 1 FROM email_queue WHERE id = ?`, queued.id), undefined, 'read in the window, so no email');
  });

  it('becomes a task with the conversation as its description', async () => {
    const conversation = get<any>(`SELECT * FROM conversations WHERE widget_id = ?`, widget.id);
    const result = await ok(`/api/conversations/${conversation.id}/task`, {});
    assert.equal(result.task.title, 'The invoice export is empty.');
    assert.match(result.task.description, /\*\*Grace\*\*/);
    assert.match(result.task.description, /Fixed — try again\?/);
    assert.equal(result.conversation.task_id, result.task.id);
    await assert.rejects(ok(`/api/conversations/${conversation.id}/task`, {}), /already a task/);
  });

  it('cannot be opened by a member', async () => {
    await assert.rejects(ok(`/api/workspaces/${workspaceId}/conversations`, { project_id: projectId, status: 'open' }), /opened by a visitor/);
  });

  it('starts afresh after the team deletes the conversation, rather than bringing it back', async () => {
    const claims = { sub: 'merchant-9', name: 'Ada B', exp: inAnHour() };
    const first = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, claims) });
    await visit(`/w/${widget.id}/messages`, { body: 'Something private I regret sending.' }, first.json.session);
    await ok(`/api/conversations/${first.json.conversation.id}`, undefined, 'DELETE');

    assert.equal((await visit(`/w/${widget.id}/messages`, undefined, first.json.session)).status, 401, 'the old session names a row that is gone');
    const again = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, claims) });
    assert.notEqual(again.json.conversation.id, first.json.conversation.id);
    const thread = await visit(`/w/${widget.id}/messages`, undefined, again.json.session);
    assert.deepEqual(thread.json.messages, [], 'nothing of the deleted thread comes back');
    const old = get<any>(`SELECT deleted_at FROM conversations WHERE id = ?`, first.json.conversation.id);
    assert.ok(old.deleted_at, 'and the deleted one stays deleted');
  });

  it('keeps from the token\'s ctx only the facts the widget allows, on the server only', async () => {
    resetRateLimits();
    await ok(`/api/widgets/${widget.id}`, { context_fields: 'plan: Plan\nstatus: Status\nNot A Key: x\nplan: twice' }, 'PATCH');
    const fields = get<any>(`SELECT context_fields FROM widgets WHERE id = ?`, widget.id).context_fields;
    assert.deepEqual(JSON.parse(fields), [{ key: 'plan', label: 'Plan' }, { key: 'status', label: 'Status' }], 'a bad key and a repeat are dropped');
    const token = hostToken(secret, {
      sub: 'merchant-ctx', exp: inAnHour(),
      ctx: { plan: 'Pro', status: { nested: true }, card: '4242 4242 4242 4242', ignored: 'x' },
    });
    const opened = await visit(`/w/${widget.id}/session`, { token });
    const row = get<any>(`SELECT * FROM conversations WHERE id = ?`, opened.json.conversation.id);
    assert.deepEqual(JSON.parse(row.visitor_context), { plan: 'Pro' }, 'not allowed, not kept; nested, not kept');
    const viaApi = await ok(`/api/conversations/${row.id}`);
    assert.equal('visitor_context' in viaApi, false, 'never in a row a member is sent');
    // A conversation reaches a device with its first line, so there is one.
    await visit(`/w/${widget.id}/messages`, { body: 'Which plan am I on?' }, opened.json.session);
    const pulled = await ok(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    const synced = (pulled.changes.conversation ?? []).filter((change: any) => change.id === row.id);
    assert.ok(synced.length, 'the conversation itself does sync');
    assert.equal(JSON.stringify(synced).includes('visitor_context'), false, 'its context never does');

    const later = hostToken(secret, { sub: 'merchant-ctx', exp: inAnHour(), ctx: { plan: 'Team', status: 'x'.repeat(201) } });
    await visit(`/w/${widget.id}/session`, { token: later });
    assert.deepEqual(
      JSON.parse(get<any>(`SELECT visitor_context FROM conversations WHERE id = ?`, row.id).visitor_context),
      { plan: 'Team' }, 'every token overwrites it, and a value too long is dropped rather than cut',
    );
    await ok(`/api/widgets/${widget.id}`, { context_fields: [] }, 'PATCH');
  });

  it('stops when the secret is rotated', async () => {
    resetRateLimits();
    const old = secret;
    secret = (await ok(`/api/widgets/${widget.id}/secret`, {})).secret;
    assert.notEqual(secret, old);
    assert.match(get<any>(`SELECT secret FROM widgets WHERE id = ?`, widget.id).secret, /^v1\./, 'a new key is sealed too');
    const claims = { sub: 'merchant-7', exp: inAnHour() };
    assert.equal((await visit(`/w/${widget.id}/session`, { token: hostToken(old, claims) })).status, 401);
    assert.equal((await visit(`/w/${widget.id}/session`, { token: hostToken(secret, claims) })).status, 200);
  });
});

describe('an anonymous widget', () => {
  let prospects: any;

  before(async () => {
    resetRateLimits();
    prospects = await ok(`/api/workspaces/${workspaceId}/widgets`, {
      project_id: projectId, name: 'Prospects', identity: 'anonymous', origins: ['example.com'],
    });
  });

  it('takes a typed name as unverified, and refuses the field no person fills in', async () => {
    assert.equal((await visit(`/w/${prospects.id}/session`, { name: 'Bot', website: 'http://spam.example' })).status, 400);
    const opened = await visit(`/w/${prospects.id}/session`, { name: 'Linus', email: 'not an address' });
    assert.equal(opened.status, 200);
    const row = get<any>(`SELECT * FROM conversations WHERE id = ?`, opened.json.conversation.id);
    assert.equal(row.verified, 0);
    assert.equal(row.visitor_name, 'Linus');
    assert.equal(row.visitor_email, null, 'an address that is not one is dropped, not stored');
    assert.match(row.visitor_id, /^anon-/);
  });

  it('closes when support is switched off', async () => {
    await ok(`/api/workspaces/${workspaceId}`, { features: { support: false } }, 'PATCH');
    assert.equal((await visit(`/w/${prospects.id}/config`)).status, 404);
    await ok(`/api/workspaces/${workspaceId}`, { features: { support: true } }, 'PATCH');
    assert.equal((await visit(`/w/${prospects.id}/config`)).status, 200);
  });
});

describe('answering the email', () => {
  let conversation: any;

  before(async () => {
    resetRateLimits();
    await ok(`/api/widgets/${widget.id}`, { reply_to: ' Support@Example.com ' }, 'PATCH');
    const opened = await visit(`/w/${widget.id}/session`, {
      token: hostToken(secret, { sub: 'merchant-11', name: 'Linus', email: 'linus@example.com', exp: inAnHour() }),
    });
    conversation = opened.json.conversation;
    await visit(`/w/${widget.id}/messages`, { body: 'Is the API down?' }, opened.json.session);
    await ok(`/api/workspaces/${workspaceId}/conversation-messages`, { conversation_id: conversation.id, body: 'It is back up.' });
  });

  it('names the widget\'s inbox as the Reply-To, and tags the subject', () => {
    const queued = get<any>(`SELECT * FROM email_queue WHERE kind = 'support' AND to_email = 'linus@example.com'`);
    assert.ok(queued.subject.endsWith(replyTag(conversation.id)), queued.subject);
    assert.equal(JSON.parse(queued.headers)[':reply-to'], 'support@example.com', 'trimmed and folded on the way in');
    assert.match(queued.body_text, /answer this email/);
  });

  it('takes the visitor\'s answer into the conversation, without the quoted email', () => {
    const subject = `Re: New reply from Merchants ${replyTag(conversation.id)}`;
    const body = 'Thanks, works now.\n\nOn Tue, 11 Nov 2026 at 10:00, Kolibri <noreply@example.com> wrote:\n> It is back up.';
    assert.equal(takeReply(workspaceId, { subject, fromAddress: 'Linus@Example.com', body }), true);
    const last = get<any>(`SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`, conversation.id);
    assert.equal(last.author, 'visitor');
    assert.equal(last.body, 'Thanks, works now.');
  });

  it('believes it only from the visitor\'s address, and only with the signed tag', () => {
    const subject = `Re: ${replyTag(conversation.id)}`;
    assert.equal(takeReply(workspaceId, { subject, fromAddress: 'mallory@example.com', body: 'Let me in' }), false);
    const forged = `Re: [#${conversation.id.slice(0, 8)}-000000]`;
    assert.equal(takeReply(workspaceId, { subject: forged, fromAddress: 'linus@example.com', body: 'Hi' }), false);
    assert.equal(takeReply('another-workspace', { subject, fromAddress: 'linus@example.com', body: 'Hi' }), false);
  });

  it('arrives by the mail poller like any other message, and lands in the conversation', async () => {
    const { pollMailbox, mailFetcher, registerMailFetcher } = await import('../src/modules/mail/poll.ts');
    const { setPassword } = await import('../src/modules/mail/mailboxes.ts');
    await ok(`/api/workspaces/${workspaceId}`, { features: { mail: true } }, 'PATCH');
    const box = await ok(`/api/workspaces/${workspaceId}/mailboxes`, { address: 'support@example.com', host: 'imap.example.com', port: 993, encryption: 'tls' });
    setPassword(box.id, 'hunter2', get<any>(`SELECT user_id FROM workspace_members WHERE workspace_id = ?`, workspaceId).user_id);
    const real = mailFetcher();
    registerMailFetcher({
      fetch: async () => [{
        uid: 1, messageId: '<reply-1@example.com>', references: [], to: ['support@example.com'], cc: [],
        subject: `Re: New reply from Merchants ${replyTag(conversation.id)}`,
        fromName: 'Linus', fromAddress: 'linus@example.com', sentAt: Date.now(), seen: false, size: 100,
        body: 'One more question: can I export to CSV?\n\n> It is back up.', attachments: [],
      }],
      fetchPart: async () => Buffer.alloc(0),
      check: async () => {},
    });
    try {
      const result = await pollMailbox(get<any>(`SELECT * FROM mailboxes WHERE id = ?`, box.id));
      assert.equal(result.fetched, 1, result.error);
    } finally {
      registerMailFetcher(real);
    }
    const last = get<any>(`SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`, conversation.id);
    assert.equal(last.body, 'One more question: can I export to CSV?');
  });

  it('cuts at the usual shapes of a quote', () => {
    assert.equal(replyText('Ja, danke!\n\nAm 11.11.2026 um 10:00 schrieb Kolibri <a@b.c>:\n> alt'), 'Ja, danke!');
    assert.equal(replyText('Merci\n-----Message d\'origine-----\nDe: x'), 'Merci');
    assert.equal(replyText('Fine.\r\n\r\nFrom: Kolibri\r\nSent: today'), 'Fine.');
    assert.equal(replyText('> only a quote'), '');
  });
});

/** A 1×1 PNG with a colour of its own, so every call is a different file. */
async function picture(seed: number): Promise<Buffer> {
  const { deflateSync } = await import('node:zlib');
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let x = 0xffffffff;
    for (const b of buf) x = table[(x ^ b) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, seed & 255, 7, 9]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A signed visitor who sends one line and one picture. Returns the conversation and the picture's hash. */
async function visitorWithPicture(sub: string, bytes: Buffer): Promise<{ conversation: string; hash: string; session: string }> {
  resetRateLimits();
  const opened = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, { sub, name: 'Ada', email: 'ada.v@example.com', exp: inAnHour() }) });
  const uploaded = await fetch(`${base}/w/${widget.id}/files`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': 'screen.png', 'x-widget-session': opened.json.session },
    body: bytes,
  });
  const { file } = await uploaded.json() as { file: { hash: string } };
  await visit(`/w/${widget.id}/messages`, { body: 'Here is what I see.', files: [file] }, opened.json.session);
  return { conversation: opened.json.conversation.id, hash: file.hash, session: opened.json.session };
}

describe('a visitor done with a chat', () => {
  it('hears that the team resolved it, and reopens it by writing on', async () => {
    const { conversation, session } = await visitorWithPicture('done-1', await picture(11));
    const history = await visit(`/w/${widget.id}/messages`, undefined, session);
    assert.equal(history.json.conversation.status, 'open');
    const after = Math.max(...history.json.messages.map((message: any) => message.seq));
    const controller = new AbortController();
    const stream = await fetch(`${base}/w/${widget.id}/stream?session=${encodeURIComponent(session)}&after=${after}`, { signal: controller.signal });
    const reader = stream.body!.getReader();

    await ok(`/api/conversations/${conversation}`, { status: 'resolved' }, 'PATCH');
    let heard = '';
    const decoder = new TextDecoder();
    while (!heard.includes('"resolved"')) heard += decoder.decode((await reader.read()).value);
    controller.abort();
    assert.match(heard, /event: status\ndata: \{"status":"resolved"\}/);

    await visit(`/w/${widget.id}/messages`, { body: 'One more thing.' }, session);
    assert.equal(get<any>(`SELECT status FROM conversations WHERE id = ?`, conversation).status, 'open');
  });

  it('resolves it themselves, without waking the team', async () => {
    const { conversation, session } = await visitorWithPicture('done-2', await picture(12));
    const before = all(`SELECT * FROM notifications WHERE kind = 'support'`).length;
    assert.equal((await visit(`/w/${widget.id}/resolve`, {}, session)).status, 200);
    assert.equal(get<any>(`SELECT status FROM conversations WHERE id = ?`, conversation).status, 'resolved');
    assert.equal(all(`SELECT * FROM notifications WHERE kind = 'support'`).length, before);
  });

  it('starts a new chat, which closes the one they leave and is the one they come back to', async () => {
    const { conversation, session } = await visitorWithPicture('done-3', await picture(13));
    const fresh = await visit(`/w/${widget.id}/conversations`, {}, session);
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.json.conversation.id, conversation);
    assert.equal(get<any>(`SELECT status FROM conversations WHERE id = ?`, conversation).status, 'resolved');
    const thread = await visit(`/w/${widget.id}/messages`, undefined, fresh.json.session);
    assert.deepEqual(thread.json.messages, [], 'a new chat starts clean');
    const row = get<any>(`SELECT * FROM conversations WHERE id = ?`, fresh.json.conversation.id);
    assert.equal(row.visitor_id, 'done-3');
    assert.equal(row.verified, 1, 'still the visitor their site vouched for');

    const back = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, { sub: 'done-3', name: 'Ada', exp: inAnHour() }) });
    assert.equal(back.json.conversation.id, fresh.json.conversation.id, 'the next page opens the newest');
  });
});

describe('a visitor\'s earlier chats', () => {
  it('are listed for them, newest first, with what they have not read', async () => {
    const { conversation: first, session } = await visitorWithPicture('earlier-1', await picture(31));
    await ok(`/api/workspaces/${workspaceId}/conversation-messages`, { conversation_id: first, body: 'Answered while you were away.' });
    const fresh = await visit(`/w/${widget.id}/conversations`, {}, session);
    const listed = await visit(`/w/${widget.id}/conversations`, undefined, fresh.json.session);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.conversations.map((row: any) => row.id), [fresh.json.conversation.id, first]);
    assert.equal(listed.json.conversations[0].current, true);
    const old = listed.json.conversations[1];
    assert.equal(old.status, 'resolved');
    assert.equal(old.unread, 1);
    assert.equal(old.said, 'Answered while you were away.');
  });

  it('can be gone back to — their own, and nobody else\'s', async () => {
    const mine = await visitorWithPicture('earlier-2', await picture(32));
    const theirs = await visitorWithPicture('earlier-3', await picture(33));
    const fresh = await visit(`/w/${widget.id}/conversations`, {}, mine.session);
    const back = await visit(`/w/${widget.id}/conversations/${mine.conversation}/open`, {}, fresh.json.session);
    assert.equal(back.status, 200);
    assert.equal(back.json.conversation.id, mine.conversation);
    const thread = await visit(`/w/${widget.id}/messages`, undefined, back.json.session);
    assert.equal(thread.json.messages[0].body, 'Here is what I see.');
    assert.equal((await visit(`/w/${widget.id}/conversations/${theirs.conversation}/open`, {}, fresh.json.session)).status, 404);
  });

  it('are reopened by a member\'s answer, which the window hears about while it is in another', async () => {
    const { conversation: first, session } = await visitorWithPicture('earlier-5', await picture(35));
    const fresh = await visit(`/w/${widget.id}/conversations`, {}, session);
    assert.equal(get<any>(`SELECT status FROM conversations WHERE id = ?`, first).status, 'resolved');

    const controller = new AbortController();
    const stream = await fetch(`${base}/w/${widget.id}/stream?session=${encodeURIComponent(fresh.json.session)}`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    await ok(`/api/workspaces/${workspaceId}/conversation-messages`, { conversation_id: first, body: 'One more thing from us.' });
    let heard = '';
    const decoder = new TextDecoder();
    while (!heard.includes('event: elsewhere')) heard += decoder.decode((await reader.read()).value);
    controller.abort();
    assert.doesNotMatch(heard, /One more thing from us/, 'only that something happened there, not what');
    assert.equal(get<any>(`SELECT status FROM conversations WHERE id = ?`, first).status, 'open', 'an answer reopens it');
  });

  it('do not pile up empty ones when "new chat" is pressed twice', async () => {
    const { session } = await visitorWithPicture('earlier-4', await picture(34));
    const once = await visit(`/w/${widget.id}/conversations`, {}, session);
    const twice = await visit(`/w/${widget.id}/conversations`, {}, session);
    assert.equal(twice.json.conversation.id, once.json.conversation.id);
  });
});

describe('a conversation as a task', () => {
  it('links back to the chat and shows its pictures as pictures', async () => {
    const { conversation, hash } = await visitorWithPicture('task-1', await picture(21));
    const { task } = await ok(`/api/conversations/${conversation}/task`, {});
    const [link] = task.description.split('\n');
    assert.equal(link, `[From the support chat with Ada via Merchants](/support/${conversation})`);
    assert.match(task.description, new RegExp(`!\\[screen\\.png\\]\\(/files/${hash}/screen\\.png\\)`));
  });

  it('words the link in the language the member is looking at', async () => {
    const { conversation } = await visitorWithPicture('task-3', await picture(23));
    const { task } = await ok(`/api/conversations/${conversation}/task`, { locale: 'de' });
    assert.equal(task.description.split('\n')[0], `[Aus dem Support-Chat mit Ada über Merchants](/support/${conversation})`);
  });

  it('can be made again once the task it became is deleted', async () => {
    const { conversation } = await visitorWithPicture('task-2', await picture(22));
    const first = (await ok(`/api/conversations/${conversation}/task`, {})).task;
    await assert.rejects(ok(`/api/conversations/${conversation}/task`, {}), /already a task/);
    await ok(`/api/tasks/${first.id}`, undefined, 'DELETE');
    const second = await ok(`/api/conversations/${conversation}/task`, {});
    assert.notEqual(second.task.id, first.id);
    assert.equal(second.conversation.task_id, second.task.id);
  });
});

describe('support over MCP', () => {
  let token = '';
  let rpc = 0;
  async function tool(name: string, args: Record<string, unknown> = {}, as = token): Promise<any> {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as any;
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    if (body.result?.isError) throw new Error(`${name}: ${body.result.content?.[0]?.text ?? 'failed'}`);
    return body.result.structuredContent;
  }

  before(async () => {
    token = (await ok('/api/tokens', { name: 'mcp', workspaceId })).token;
  });

  it('lists the inbox and reads a thread, as the inbox shows them', async () => {
    const { conversation } = await visitorWithPicture('mcp-1', await picture(41));
    const listed = await tool('list_conversations', {});
    const row = listed.conversations.find((one: any) => one.id === conversation);
    assert.ok(row, 'the open conversation is listed');
    assert.equal(row.unread, true);
    assert.equal(row.awaiting_reply, true);
    assert.equal(row.widget, 'Merchants');
    const thread = await tool('get_conversation', { conversation });
    assert.equal(thread.messages[0].from, 'visitor');
    assert.equal(thread.messages[0].body, 'Here is what I see.');
    assert.deepEqual(thread.messages[0].pictures, ['screen.png']);
  });

  it('answers as a member: the visitor hears it, and a resolved one reopens', async () => {
    const { conversation, session } = await visitorWithPicture('mcp-2', await picture(42));
    await tool('update_conversation', { conversation, status: 'resolved', assignee: 'Ada' });
    const resolved = get<any>(`SELECT status, assignee_id FROM conversations WHERE id = ?`, conversation);
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.assignee_id);
    const answered = await tool('reply_to_conversation', { conversation, body: 'Sorted from an assistant.' });
    assert.equal(answered.status, 'open', 'answering reopens it');
    const thread = await visit(`/w/${widget.id}/messages`, undefined, session);
    const last = thread.json.messages.at(-1);
    assert.equal(last.body, 'Sorted from an assistant.');
    assert.equal(last.author, 'agent');
  });

  it('makes a task once, with the link back', async () => {
    const { conversation } = await visitorWithPicture('mcp-3', await picture(43));
    const made = await tool('create_task_from_conversation', { conversation, locale: 'en' });
    assert.ok(made.task.identifier);
    const task = get<any>(`SELECT description FROM tasks WHERE id = ?`, made.task.id);
    assert.match(task.description, new RegExp(`\\(/support/${conversation}\\)`));
    await assert.rejects(tool('create_task_from_conversation', { conversation }), /already a task/);
  });

  it('refuses a read-only token a write, and a switched-off workspace everything', async () => {
    const { conversation } = await visitorWithPicture('mcp-4', await picture(44));
    const reader = (await ok('/api/tokens', { name: 'read', workspaceId, scopes: 'read' })).token;
    await assert.rejects(tool('reply_to_conversation', { conversation, body: 'no' }, reader), /read-only/);
    await ok(`/api/workspaces/${workspaceId}`, { features: { support: false } }, 'PATCH');
    try {
      await assert.rejects(tool('list_conversations'), /switched off/);
    } finally {
      await ok(`/api/workspaces/${workspaceId}`, { features: { support: true } }, 'PATCH');
    }
  });
});

describe('deleting a conversation, and emptying the trash', () => {
  const liveLines = (conversation: string) =>
    all(`SELECT id FROM conversation_messages WHERE conversation_id = ? AND deleted_at IS NULL`, conversation).length;

  it('takes its lines with it, and gives them back when it is restored', async () => {
    const { conversation } = await visitorWithPicture('trash-1', await picture(1));
    const before = liveLines(conversation);
    assert.ok(before > 0);
    await ok(`/api/conversations/${conversation}`, undefined, 'DELETE');
    assert.equal(liveLines(conversation), 0, 'every line is a tombstone now, which devices hear and the trash takes');

    const userId = get<any>(`SELECT user_id FROM workspace_members WHERE workspace_id = ?`, workspaceId).user_id;
    writeEntity('conversation', conversation, {}, { workspaceId, actorId: userId, hlc: serverClock.now() });
    assert.equal(liveLines(conversation), before, 'restored from the trash, with what was deleted with it');
  });

  it('leaves nothing of a stranger behind once the trash is emptied — not the lines, not the picture', async () => {
    const { conversation, hash } = await visitorWithPicture('trash-2', await picture(2));
    const lines = all<any>(`SELECT id FROM conversation_messages WHERE conversation_id = ?`, conversation).map((row) => row.id);
    await ok(`/api/conversations/${conversation}`, undefined, 'DELETE');
    await ok(`/api/workspaces/${workspaceId}/trash/empty`, {});

    assert.equal(get(`SELECT 1 FROM conversations WHERE id = ?`, conversation), undefined);
    assert.equal(all(`SELECT 1 FROM conversation_messages WHERE conversation_id = ?`, conversation).length, 0);
    for (const id of lines) {
      assert.ok(get(`SELECT 1 FROM purges WHERE row_id = ?`, id), 'a marker, so every device forgets the line too');
    }
    assert.equal(get(`SELECT 1 FROM files WHERE hash = ?`, hash), undefined, 'the picture went with the last line naming it');
  });

  it('keeps a picture another conversation still shows', async () => {
    const shared = await picture(3);
    const live = await visitorWithPicture('trash-3', shared);
    const gone = await visitorWithPicture('trash-4', shared);
    assert.equal(live.hash, gone.hash, 'the same bytes are the same file');
    await ok(`/api/conversations/${gone.conversation}`, undefined, 'DELETE');
    await ok(`/api/workspaces/${workspaceId}/trash/empty`, {});
    assert.ok(get(`SELECT 1 FROM files WHERE hash = ?`, live.hash), 'still in use, so it stays');
  });
});

describe('the snippet', () => {
  it('carries the widget\'s colour, so the button matches the window it opens', async () => {
    const { widgetSnippet } = await import('@kolibri/shared');
    assert.match(widgetSnippet('https://k.example.com/', 'w1', 'signed', '#e5383b'), /color: '#e5383b',/);
    assert.match(widgetSnippet('https://k.example.com', 'w1', 'anonymous', '#e5383b'), /color: '#e5383b'/);
    assert.doesNotMatch(widgetSnippet('https://k.example.com', 'w1', 'anonymous', null), /color/);
    assert.doesNotMatch(widgetSnippet('https://k.example.com', 'w1', 'signed', "red'; alert(1)//"), /alert/, 'only a colour gets in');
  });
});

/*
 * What the review measured outliving the change that should have ended it, or
 * reaching what it should not. Every case here failed before.
 */
describe('a session, after the widget changes under it', () => {
  it('ends a signed visitor\'s session when the secret is rotated', async () => {
    resetRateLimits();
    const opened = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, { sub: 'merchant-rotate', exp: inAnHour() }) });
    assert.equal((await visit(`/w/${widget.id}/messages`, { body: 'before' }, opened.json.session)).status, 200);
    secret = (await ok(`/api/widgets/${widget.id}/secret`, {})).secret;
    assert.equal((await visit(`/w/${widget.id}/messages`, { body: 'after' }, opened.json.session)).status, 401,
      'a withdrawn key does not keep working for the twelve hours a session lasts');
  });

  it('ends an anonymous session when the widget comes to want signed-in visitors', async () => {
    resetRateLimits();
    const open = await ok(`/api/workspaces/${workspaceId}/widgets`, {
      project_id: projectId, name: 'Switching', identity: 'anonymous', origins: ['example.com'],
    });
    const opened = await visit(`/w/${open.id}/session`, { name: 'Ida' });
    assert.equal((await visit(`/w/${open.id}/messages`, { body: 'hello' }, opened.json.session)).status, 200);
    await ok(`/api/widgets/${open.id}`, { identity: 'signed' }, 'PATCH');
    assert.equal((await visit(`/w/${open.id}/messages`, { body: 'still me' }, opened.json.session)).status, 401);
  });

  it('ends the stream of a widget switched off while it was open', async () => {
    resetRateLimits();
    const closing = await ok(`/api/workspaces/${workspaceId}/widgets`, {
      project_id: projectId, name: 'Closing', identity: 'anonymous', origins: ['example.com'],
    });
    const opened = await visit(`/w/${closing.id}/session`, { name: 'Jo' });
    await visit(`/w/${closing.id}/messages`, { body: 'hi' }, opened.json.session);
    const control = new AbortController();
    const response = await fetch(`${base}/w/${closing.id}/stream?session=${encodeURIComponent(opened.json.session)}`, { signal: control.signal });
    const reader = response.body!.getReader();
    const timer = setTimeout(() => control.abort(), 3000);
    let heard = '';
    try {
      await ok(`/api/widgets/${closing.id}`, { enabled: 0 }, 'PATCH');
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        heard += new TextDecoder().decode(value);
      }
    } catch { /* aborted: the stream never ended */ } finally {
      clearTimeout(timer);
    }
    assert.match(heard, /event: end/, 'the window is told, and stops hearing the team');
  });
});

describe('what a visitor can attach', () => {
  it('is only a picture this conversation uploaded, not a file somebody else did', async () => {
    resetRateLimits();
    const pdf = Buffer.from('%PDF-1.4 the internal price list');
    const uploaded = await fetch(`${base}/api/workspaces/${workspaceId}/files`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/pdf', 'x-filename': 'internal.pdf' }, body: pdf,
    });
    const memberFile = (await uploaded.json() as any);
    const hash = memberFile.hash ?? memberFile.file?.hash;
    assert.match(hash, /^[0-9a-f]{64}$/);

    const opened = await visit(`/w/${widget.id}/session`, { token: hostToken(secret, { sub: 'merchant-files', exp: inAnHour() }) });
    const sent = await visit(`/w/${widget.id}/messages`, { body: 'look', files: [{ hash }] }, opened.json.session);
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.json.message.files, [], 'a hash alone is not a file of theirs');
    const fetched = await fetch(`${base}/w/${widget.id}/files/${hash}`, { headers: { 'x-widget-session': opened.json.session } });
    assert.equal(fetched.status, 404, 'and so not a way to download one');

    // A picture they uploaded is theirs — in the conversation it was uploaded for, and no other.
    const { hash: own } = await visitorWithPicture('merchant-files-2', await picture(31));
    const other = await visit(`/w/${widget.id}/messages`, { body: 'mine?', files: [{ hash: own, sig: 'made-up' }] }, opened.json.session);
    assert.deepEqual(other.json.message.files, []);
  });
});

describe('a conversation nobody wrote in', () => {
  it('stays out of the team\'s devices, and is pruned once no session can open it', async () => {
    resetRateLimits();
    const anonymous = await ok(`/api/workspaces/${workspaceId}/widgets`, {
      project_id: projectId, name: 'Quiet', identity: 'anonymous', origins: ['example.com'],
    });
    const silent = (await visit(`/w/${anonymous.id}/session`, { name: 'Kai' })).json.conversation.id;
    const spoken = await visit(`/w/${anonymous.id}/session`, { name: 'Lea' });
    await visit(`/w/${anonymous.id}/messages`, { body: 'hello' }, spoken.json.session);

    const pulled = (await ok(`/api/sync/pull?workspace=${workspaceId}&since=0`)).changes.conversation ?? [];
    assert.equal(pulled.some((row: any) => row.id === silent), false, 'not in the inbox');
    assert.equal(pulled.some((row: any) => row.id === spoken.json.conversation.id), true);

    const longAgo = Date.now() - 32 * 86_400_000;
    run(`UPDATE conversations SET created_at = ? WHERE id IN (?, ?)`, longAgo, silent, spoken.json.conversation.id);
    assert.ok(pruneEmptyConversations() >= 1);
    assert.equal(get(`SELECT id FROM conversations WHERE id = ?`, silent), undefined);
    assert.ok(get(`SELECT id FROM purges WHERE entity = 'conversation' AND row_id = ?`, silent), 'a device that has it drops it');
    assert.ok(get(`SELECT id FROM conversations WHERE id = ?`, spoken.json.conversation.id), 'one somebody wrote in stays');
  });
});

describe('who a conversation reaches', () => {
  let linId = '';
  let hidden: any;
  let conversationId = '';
  let session = '';

  before(async () => {
    resetRateLimits();
    const lin = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lin@example.com', name: 'Lin', password: 'correct horse battery' }),
    });
    linId = ((await lin.json()) as any).user.id;
    run(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, 'member', ?, ?, 0, '{}')`,
      `wm-${linId}`, workspaceId, linId, Date.now(), Date.now(),
    );
    const secretProject = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Inner', key: 'INN', visibility: 'private' })).id;
    hidden = await ok(`/api/workspaces/${workspaceId}/widgets`, {
      project_id: secretProject, name: 'Inner', identity: 'anonymous', origins: ['example.com'],
    });
    const opened = await visit(`/w/${hidden.id}/session`, { name: 'Nia' });
    session = opened.json.session;
    conversationId = opened.json.conversation.id;
  });

  it('is not given to somebody who cannot see its project', async () => {
    await assert.rejects(
      ok(`/api/conversations/${conversationId}`, { assignee_id: linId }, 'PATCH'),
      /cannot see this conversation's project/,
    );
  });

  it('finds somebody when the person it was given to can no longer see it', async () => {
    // As if Lin had been taken off the project after being given it.
    run(`UPDATE conversations SET assignee_id = ? WHERE id = ?`, linId, conversationId);
    const before = all(`SELECT * FROM notifications WHERE kind = 'support'`).length;
    await visit(`/w/${hidden.id}/messages`, { body: 'anybody there?' }, session);
    const told = all<any>(`SELECT * FROM notifications WHERE kind = 'support'`).slice(before);
    assert.equal(told.length, 1, 'an owner hears it rather than nobody');
    assert.equal(told[0].conversation_id, conversationId);
  });

  it('opens the conversation it is about, not the project\'s board', async () => {
    const latest = await ok('/api/notifications/latest');
    assert.equal(latest.url, `/support/${conversationId}`);
  });
});


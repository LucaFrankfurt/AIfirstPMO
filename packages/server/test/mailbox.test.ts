/**
 * Who may read a mailbox, asked through every door.
 *
 * A connected mailbox is the only thing in this product where the answer to
 * "may I see this" and the answer to "may I see the rows underneath it" come
 * from two different tables — the mailbox row carries the rule, and the
 * messages carry only a mailbox id. So the rule is written in four places, each
 * shaped for its own query: `canReadMailbox` in shared, a SQL clause in the
 * sync filter, `visibleMailboxes` for the REST routes, and the same function
 * again behind every MCP tool. Four copies is four chances to get it wrong, so
 * each is asked the same question here — the arrangement `chat.test.ts` uses,
 * for the same reason.
 *
 * The second thing tested is the one inversion in the codebase: an empty
 * `members` list on a restricted mailbox means **nobody**, where an empty list
 * everywhere else means everybody. It is deliberate and it is exactly the kind
 * of decision that gets "tidied" back into consistency by somebody who does not
 * know why, so it is pinned.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mailbox-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { canReadMailbox, parseMailQuery, scoreDocument, padDate } = await import('@kolibri/shared');
const { run, get, all } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { visibleMailboxes, findMailbox, setPassword, credentialsFor, hasPassword } =
  await import('../src/modules/mail/mailboxes.ts');
const { storeMessage, highestUid, forgetMailbox, countMessages } = await import('../src/modules/mail/store.ts');
const { searchMail, countMail, narrow, threadOf } = await import('../src/modules/mail/search.ts');
const { mailStats, responseTimes } = await import('../src/modules/mail/analytics.ts');
const { rankDocuments } = await import('../src/modules/mail/documents.ts');

let base = '';
let workspaceId = '';
const people: Record<string, { id: string; cookie: string }> = {};
const boxes: Record<string, string> = {};

async function raw(who: { cookie: string } | null, path: string, body?: unknown, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(who ? { cookie: who.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function as(who: { cookie: string }, path: string, body?: unknown, method?: string): Promise<any> {
  const result = await raw(who, path, body, method);
  if (result.status >= 400) throw new Error(`${result.status} ${method ?? ''} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function register(email: string, name: string) {
  resetRateLimits();
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name, password: 'correct horse battery' }),
  });
  const session = await response.json() as any;
  return { id: session.user.id, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}

/** A message as the poller would have stored one. */
let nextUid = 100;
function seed(mailbox: string, fields: Partial<{
  subject: string; from: string; fromName: string; to: string[]; body: string;
  sentAt: number; files: { filename: string; mime: string; size: number; part: string }[];
  references: string[]; messageId: string;
}> = {}) {
  nextUid += 1;
  return storeMessage(workspaceId, mailbox, 'INBOX', {
    uid: nextUid,
    messageId: fields.messageId ?? `<m${nextUid}@x>`,
    references: fields.references ?? [],
    subject: fields.subject ?? 'Hello',
    fromName: fields.fromName ?? '',
    fromAddress: fields.from ?? 'someone@example.com',
    to: fields.to ?? ['support@calendoora.de'],
    cc: [],
    sentAt: fields.sentAt ?? Date.parse('2024-08-17T09:00:00Z'),
    seen: true,
    size: 1000,
    body: fields.body ?? 'A body.',
    attachments: fields.files ?? [],
  });
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  people.ada = await register('ada@example.com', 'Ada');
  workspaceId = (await as(people.ada, '/api/session')).workspaces[0].id;
  people.lin = await register('lin@example.com', 'Lin');
  people.max = await register('max@example.com', 'Max');
  for (const [name, role] of [['lin', 'admin'], ['max', 'member']] as const) {
    run(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, ?, ?, ?, 0, '{}')`,
      `wm-${people[name].id}`, workspaceId, people[name].id, role, Date.now(), Date.now(),
    );
  }
  // The switch has to be on before a mailbox may be written at all — see the
  // guard in `mailRules`, which is tested for that below.
  await as(people.ada, `/api/workspaces/${workspaceId}`, { features: { mail: true } }, 'PATCH');

  boxes.support = (await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
    address: 'support@calendoora.de', host: 'imap.calendoora.de', port: 993, encryption: 'tls',
  })).id;
  boxes.admin = (await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
    address: 'admin@calendoora.de', host: 'imap.calendoora.de', port: 993, encryption: 'tls',
    access: 'members', members: [people.ada.id],
  })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the rule */

describe('who may read a mailbox', () => {
  it('lets everybody into a workspace mailbox', () => {
    assert.equal(canReadMailbox({ access: 'workspace', members: [] }, 'anyone'), true);
  });

  it('lets nobody into a restricted one with an empty list', () => {
    // The one inversion in the codebase, pinned on purpose: an empty list here
    // means nobody, where an empty list on a channel or a cycle means
    // everybody. Removing the last person from a private inbox must not open
    // it to the company.
    assert.equal(canReadMailbox({ access: 'members', members: [] }, 'anyone'), false);
  });

  it('reads an access value it does not recognise as restricted', () => {
    // A hand-edited or corrupted row fails closed. `scopeOf` decides this.
    const rows = all<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support);
    assert.equal(canReadMailbox({ access: 'nonsense' as never, members: [] }, String(rows[0].id)), false);
  });
});

describe('the four doors', () => {
  it('agrees between the resolver and the API', async () => {
    assert.deepEqual(
      visibleMailboxes(people.max.id, workspaceId).map((row) => String(row.address)),
      ['support@calendoora.de'],
    );
    const listed = await as(people.max, `/api/workspaces/${workspaceId}/mailboxes`);
    assert.deepEqual(listed.mailboxes.map((box: any) => box.address), ['support@calendoora.de']);
  });

  it('keeps a restricted mailbox out of a non-member\'s sync pull', async () => {
    const mine = await as(people.ada, `/api/sync/pull?workspace=${workspaceId}&since=0`);
    const theirs = await as(people.max, `/api/sync/pull?workspace=${workspaceId}&since=0`);
    const ids = (changes: any) => (changes.changes?.mailbox ?? []).map((row: any) => row.id);
    assert.equal(ids(mine).length, 2);
    assert.deepEqual(ids(theirs), [boxes.support]);
  });

  it('never sends the password down any of them', async () => {
    setPassword(boxes.support, 'hunter2', people.ada.id);
    const listed = await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`);
    const box = listed.mailboxes.find((one: any) => one.id === boxes.support);
    // Whether, never what.
    assert.equal(box.has_password, true);
    assert.equal(box.password, undefined);
    const pulled = await as(people.ada, `/api/sync/pull?workspace=${workspaceId}&since=0`);
    for (const row of pulled.changes.mailbox) assert.equal(row.password, undefined);
    // And it is not on the row at all — it is in its own table, sealed.
    assert.equal(get<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support).password, undefined);
    assert.notEqual(get<any>(`SELECT secret FROM mailbox_credentials WHERE mailbox_id = ?`, boxes.support).secret, 'hunter2');
    assert.equal(credentialsFor(get<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support))?.password, 'hunter2');
  });

  it('refuses the generic row route too — the fifth door', async () => {
    // Not the password, which is in its own table; the host, the login name
    // and the list of who may read it. And a PATCH through the same route
    // would let somebody repoint the mailbox at a host they control, which is
    // `admin@`'s credential being tried against somebody else's server.
    assert.equal((await raw(people.ada, `/api/mailboxes/${boxes.admin}`)).status, 200);
    assert.equal((await raw(people.max, `/api/mailboxes/${boxes.admin}`)).status, 403);
    assert.equal((await raw(people.lin, `/api/mailboxes/${boxes.admin}`)).status, 403);
    const repoint = await raw(people.lin, `/api/mailboxes/${boxes.admin}`, { host: 'evil.test' }, 'PATCH');
    assert.equal(repoint.status, 403);
    assert.equal(get<any>(`SELECT host FROM mailboxes WHERE id = ?`, boxes.admin).host, 'imap.calendoora.de');
  });

  it('refuses an admin who is not on a restricted mailbox\'s list', async () => {
    // Lin is a workspace admin and still cannot reach `admin@`. The line is
    // drawn on purpose: removing yourself from a mailbox has to mean you are
    // out of it, including out of the half that could point it elsewhere.
    assert.equal(findMailbox(boxes.admin, people.lin.id, workspaceId), undefined);
    const refused = await raw(people.lin, `/api/workspaces/${workspaceId}/mailboxes/${boxes.admin}/test`, {});
    assert.equal(refused.status, 404);
  });
});

describe('the rules a mailbox is written under', () => {
  it('refuses a member', async () => {
    const refused = await raw(people.max, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'sneaky@calendoora.de', host: 'imap.calendoora.de',
    });
    assert.equal(refused.status, 403);
  });

  it('refuses a restricted mailbox with nobody on it', async () => {
    const refused = await raw(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'nobody@calendoora.de', host: 'imap.calendoora.de', access: 'members', members: [],
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /at least one person/);
  });

  it('refuses a second row for the same address', async () => {
    const refused = await raw(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'SUPPORT@calendoora.de', host: 'imap.calendoora.de',
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /already connected/);
  });

  it('folds the address and fills the username in', () => {
    const row = get<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support);
    assert.equal(row.address, 'support@calendoora.de');
    assert.equal(row.username, 'support@calendoora.de');
  });
});

/* ------------------------------------------------------------ the corpus */

describe('storing what was fetched', () => {
  before(() => {
    seed(boxes.support, {
      subject: 'Rechnung März 2024', from: 'anna@steuerkanzlei.de', fromName: 'Anna Weber',
      body: 'Rechnungsnummer 4711, Betrag 1.234,56 EUR',
      files: [{ filename: 'Rechnung_2024_03.pdf', mime: 'application/pdf', size: 40_000, part: '2' }],
      sentAt: Date.parse('2024-03-04T10:00:00Z'), references: ['thread-a@x'],
    });
    seed(boxes.support, {
      subject: 'Newsletter', from: 'news@shop.example',
      body: 'Unsubscribe at the bottom', sentAt: Date.parse('2024-03-05T10:00:00Z'),
    });
    seed(boxes.support, {
      subject: 'Re: Rechnung März 2024', from: 'support@calendoora.de',
      body: 'Danke, ist angekommen.', sentAt: Date.parse('2024-03-04T12:00:00Z'),
      references: ['thread-a@x'],
    });
    seed(boxes.admin, {
      subject: 'Lohnabrechnung', from: 'payroll@steuerkanzlei.de',
      body: 'Anbei die Abrechnung.', sentAt: Date.parse('2024-03-06T10:00:00Z'),
      files: [{ filename: 'Lohn_2024_03.pdf', mime: 'application/pdf', size: 20_000, part: '2' }],
    });
  });

  it('is idempotent on the same UID', () => {
    const before = countMessages(boxes.support);
    // A poll that died halfway through and ran again. The second pass updates
    // the flags and does not produce a second row.
    const message = {
      uid: 90_001, messageId: '<m90001@x>', references: [], subject: 'Hello', fromName: '',
      fromAddress: 'a@x', to: [], cc: [], sentAt: Date.now(), seen: false, size: 1,
      body: '', attachments: [],
    };
    assert.equal(storeMessage(workspaceId, boxes.support, 'INBOX', message), true);
    assert.equal(storeMessage(workspaceId, boxes.support, 'INBOX', message), false);
    assert.equal(countMessages(boxes.support), before + 1);
  });

  it('knows where the next poll starts', () => {
    assert.ok(highestUid(boxes.support, 'INBOX') > 0);
    assert.equal(highestUid(boxes.support, 'Sent'), 0);
  });
});

describe('searching', () => {
  const mine = () => visibleMailboxes(people.ada.id, workspaceId).map((row) => String(row.id));
  const theirs = () => visibleMailboxes(people.max.id, workspaceId).map((row) => String(row.id));

  it('finds a word in the body across the mailboxes it may read', () => {
    const hits = searchMail({ workspaceId, mailboxIds: mine(), filter: { text: 'Rechnungsnummer' } });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].mailbox_address, 'support@calendoora.de');
  });

  it('finds a message by its attachment\'s name', () => {
    // The filename is indexed with the body, and it is the strongest signal
    // there is — nobody names a newsletter `Rechnung_2024_03.pdf`.
    const hits = searchMail({ workspaceId, mailboxIds: mine(), filter: { text: 'Rechnung_2024_03' } });
    assert.equal(hits.length, 1);
  });

  it('returns nothing at all from a mailbox the caller may not read', () => {
    assert.equal(searchMail({ workspaceId, mailboxIds: theirs(), filter: { text: 'Lohnabrechnung' } }).length, 0);
    assert.equal(searchMail({ workspaceId, mailboxIds: mine(), filter: { text: 'Lohnabrechnung' } }).length, 1);
  });

  it('finds nothing when the list is empty, rather than everything', () => {
    // The property the whole design rests on: a reader that forgets to resolve
    // the visible mailboxes gets no rows instead of all of them.
    assert.equal(searchMail({ workspaceId, mailboxIds: [], filter: {} }).length, 0);
    assert.equal(countMail({ workspaceId, mailboxIds: [], filter: {} }), 0);
  });

  it('drops a named mailbox the caller cannot see rather than refusing', () => {
    // Refusing would answer a question nobody asked: whether `admin@` exists.
    const rows = visibleMailboxes(people.max.id, workspaceId);
    assert.deepEqual(narrow(rows, ['admin@calendoora.de']), []);
    assert.deepEqual(narrow(rows, ['support@calendoora.de']), [boxes.support]);
    assert.equal(narrow(rows, undefined).length, 1);
  });

  it('counts what it lists', () => {
    const filter = { since: '2024-03-01', until: '2024-03-31' };
    assert.equal(countMail({ workspaceId, mailboxIds: mine(), filter }), 4);
    assert.equal(searchMail({ workspaceId, mailboxIds: mine(), filter, limit: 2 }).length, 2);
  });

  it('reads `until` as the end of its day', () => {
    // Midnight would drop everything sent on the last day of the year, which
    // is a bad day to lose in this feature in particular.
    const filter = { since: '2024-03-04', until: '2024-03-04' };
    assert.equal(countMail({ workspaceId, mailboxIds: mine(), filter }), 2);
  });

  it('stitches a thread across mailboxes', () => {
    const thread = threadOf(workspaceId, mine(), 'thread-a@x');
    assert.equal(thread.length, 2);
    assert.ok(thread[0].sent_at <= thread[1].sent_at);
  });
});

describe('the document hunt', () => {
  it('ranks the invoice above the newsletter, and says why', () => {
    const mine = visibleMailboxes(people.ada.id, workspaceId).map((row) => String(row.id));
    const { ranked } = rankDocuments({ workspaceId, mailboxIds: mine, filter: {}, limit: 10 });
    assert.equal(ranked[0].message.subject, 'Rechnung März 2024');
    assert.ok(ranked[0].score > 0);
    assert.ok(ranked[0].why.some((one) => /filename/.test(one)), ranked[0].why.join(', '));
    assert.deepEqual(ranked[0].documents, ['Rechnung_2024_03.pdf']);
    const newsletter = ranked.find((one) => one.message.subject === 'Newsletter');
    assert.ok(!newsletter || newsletter.score < ranked[0].score);
  });

  it('scores a filename above the same word in a subject', () => {
    const inName = scoreDocument({ subject: 'FYI', from: 'a@x', filenames: ['Rechnung.pdf'] });
    const inSubject = scoreDocument({ subject: 'Rechnung', from: 'a@x', filenames: [] });
    assert.ok(inName.score > inSubject.score);
  });

  it('finds nothing to say about an ordinary message', () => {
    assert.equal(scoreDocument({ subject: 'Lunch?', from: 'a@x', filenames: [] }).score, 0);
  });
});

describe('the numbers', () => {
  it('reports the window it actually covers', () => {
    const mine = visibleMailboxes(people.ada.id, workspaceId).map((row) => String(row.id));
    const stats = mailStats({ workspaceId, mailboxIds: mine });
    assert.equal(stats.covers.from, '2024-03-04');
    assert.ok(stats.per_mailbox.length === 2);
    assert.ok(stats.per_month.some((month) => month.month === '2024-03'));
    assert.ok(stats.top_domains.some((one) => one.domain === 'steuerkanzlei.de' && one.senders === 2));
  });

  it('measures a reply only where the mailbox\'s own sent mail was fetched', () => {
    const mine = visibleMailboxes(people.ada.id, workspaceId).map((row) => String(row.id));
    const measured = responseTimes({ workspaceId, mailboxIds: mine }, ['support@calendoora.de']);
    assert.equal(measured.measurable, true);
    assert.equal(measured.replies, 1);
    assert.equal(measured.median_minutes, 120);
    // Without the sent side there is nothing to measure, and it says so rather
    // than reporting the median of an empty set as zero.
    const unmeasured = responseTimes({ workspaceId, mailboxIds: mine }, []);
    assert.equal(unmeasured.measurable, false);
    assert.equal(unmeasured.median_minutes, null);
  });
});

/* ----------------------------------------------------------------- MCP */

describe('over MCP', () => {
  const call = async (who: { cookie: string }, name: string, args: Record<string, unknown> = {}) => {
    const answer = await as(who, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { workspace_id: workspaceId, ...args } },
    });
    if (answer.error) throw new Error(answer.error.message);
    return JSON.parse(answer.result.content[0].text);
  };

  it('offers the mail tools', async () => {
    const answer = await as(people.ada, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = answer.result.tools.map((tool: any) => tool.name);
    for (const tool of ['list_mailboxes', 'search_mail', 'get_mail', 'mail_thread', 'find_documents',
      'list_mail_attachments', 'mail_stats', 'file_mail_as_task']) {
      assert.ok(names.includes(tool), `missing ${tool}`);
    }
    // Everything but the last one is read-only, and says so to the client.
    const readOnly = (name: string) =>
      answer.result.tools.find((tool: any) => tool.name === name).annotations.readOnlyHint;
    assert.equal(readOnly('search_mail'), true);
    assert.equal(readOnly('file_mail_as_task'), false);
  });

  it('searches only the mailboxes the caller may read', async () => {
    const asAda = await call(people.ada, 'search_mail', { text: 'Lohnabrechnung' });
    assert.equal(asAda.total, 1);
    const asMax = await call(people.max, 'search_mail', { text: 'Lohnabrechnung' });
    assert.equal(asMax.total, 0);
    // And says which inboxes it looked in, so "nothing found" and "you cannot
    // see that inbox" are distinguishable answers.
    assert.deepEqual(asMax.searched, ['support@calendoora.de']);
  });

  it('takes the search box dialect, in German', async () => {
    const answer = await call(people.ada, 'search_mail', { query: 'von:anna seit:2024-03 rechnung' });
    assert.equal(answer.total, 1);
  });

  it('refuses to read a message in a mailbox the caller may not see', async () => {
    const found = await call(people.ada, 'search_mail', { text: 'Lohnabrechnung' });
    const id = found.messages[0].id;
    assert.ok((await call(people.ada, 'get_mail', { id })).body.length > 0);
    await assert.rejects(() => call(people.max, 'get_mail', { id }), /may not read/);
  });

  it('turns a message into a task without touching the mail server', async () => {
    const project = await as(people.ada, `/api/workspaces/${workspaceId}/projects`, { name: 'Ops', key: 'OPS' });
    const found = await call(people.ada, 'search_mail', { text: 'Rechnungsnummer' });
    const task = await call(people.ada, 'file_mail_as_task', { id: found.messages[0].id, project: 'OPS' });
    assert.equal(task.title, 'Rechnung März 2024');
    const row = get<any>(`SELECT description FROM tasks WHERE id = ?`, task.id);
    assert.match(row.description, /anna@steuerkanzlei\.de/);
    assert.match(row.description, /Rechnungsnummer 4711/);
    assert.equal(get<any>(`SELECT project_id FROM tasks WHERE id = ?`, task.id).project_id, project.id);
  });

  it('refuses everything when the workspace has mail switched off', async () => {
    await as(people.ada, `/api/workspaces/${workspaceId}`, { features: { mail: false } }, 'PATCH');
    // Not the rows with a screen hidden in front of them: the switch has to
    // mean something at the read path or it is decoration.
    assert.deepEqual(visibleMailboxes(people.ada.id, workspaceId), []);
    await assert.rejects(() => call(people.ada, 'search_mail', { text: 'anything' }), /switched off|No mailbox/);
    await as(people.ada, `/api/workspaces/${workspaceId}`, { features: { mail: true } }, 'PATCH');
  });
});

/* ------------------------------------------------------------ the dialect */

describe('the query dialect', () => {
  it('reads German and English prefixes alike', () => {
    assert.deepEqual(parseMailQuery('von:stripe seit:2024-01 rechnung'),
      { from: 'stripe', since: '2024-01-01', text: 'rechnung' });
    assert.deepEqual(parseMailQuery('from:stripe since:2024-01 invoice'),
      { from: 'stripe', since: '2024-01-01', text: 'invoice' });
  });

  it('pads a bare year to both ends of it', () => {
    // Both padded the same way would ask for one day, which is the quiet
    // version of this being wrong.
    assert.equal(padDate('2024', false), '2024-01-01');
    assert.equal(padDate('2024', true), '2024-12-31');
    assert.equal(padDate('2024-02', true), '2024-02-29');
    assert.equal(padDate('31.12.2024', false), '2024-12-31');
  });

  it('leaves an unknown prefix in the free text', () => {
    // The corpus is somebody else's prose: `re:` and `http:` are in real
    // subject lines, and refusing them would be absurd.
    assert.equal(parseMailQuery('re: rechnung').text, 're: rechnung');
  });

  it('keeps a quoted phrase together', () => {
    assert.equal(parseMailQuery('"invoice number" hat:anhang').text, 'invoice number');
    assert.equal(parseMailQuery('"invoice number" hat:anhang').hasAttachment, true);
  });
});

describe('disconnecting', () => {
  it('throws the copy and the credential away', async () => {
    const id = (await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'temp@calendoora.de', host: 'imap.calendoora.de',
    })).id;
    setPassword(id, 'hunter2', people.ada.id);
    seed(id, { subject: 'Something' });
    assert.equal(countMessages(id), 1);
    assert.equal(hasPassword(id), true);

    await as(people.ada, `/api/mailboxes/${id}`, undefined, 'DELETE');

    // The one place in this product where switching something off throws data
    // away, and it has to: "we disconnected that inbox" must be able to mean it.
    assert.equal(countMessages(id), 0);
    assert.equal(hasPassword(id), false);
    assert.equal(all<any>(`SELECT * FROM mail_index WHERE mailbox_id = ?`, id).length, 0);
    assert.equal(all<any>(`SELECT * FROM mail_attachments WHERE mailbox_id = ?`, id).length, 0);
  });

  it('leaves nothing behind when a mailbox is forgotten directly', () => {
    const before = countMessages(boxes.admin);
    assert.ok(before > 0);
    assert.equal(forgetMailbox(boxes.admin), before);
    assert.equal(countMessages(boxes.admin), 0);
  });
});

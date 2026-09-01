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
const { visibleMailboxes, findMailbox, setPassword, credentialsFor, hasPassword, configOf, mailboxView } =
  await import('../src/modules/mail/mailboxes.ts');
const { storeMessage, highestUid, forgetMailbox, countMessages } = await import('../src/modules/mail/store.ts');
const { checkMailbox, cleanHost } = await import('../src/kernel/mail/mailbox.ts');
const { pollMailbox } = await import('../src/modules/mail/poll.ts');
const { searchMail, countMail, narrow, threadOf } = await import('../src/modules/mail/search.ts');
const { mailStats, responseTimes } = await import('../src/modules/mail/analytics.ts');
const { rankDocuments } = await import('../src/modules/mail/documents.ts');
const { accessTokenFor, registerMailAuthProvider, storeTokens, storedCredential } =
  await import('../src/modules/mail/oauth.ts');
const { registerCorpus, searchWorkspace } = await import('../src/kernel/search/search.ts');
const { writeEntity } = await import('../src/kernel/write-path/repo.ts');
const { serverClock } = await import('../src/kernel/write-path/bootstrap.ts');
const { uid } = await import('../src/kernel/platform/ids.ts');

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

/**
 * A request that does not follow the redirect.
 *
 * The OAuth callback answers with a 302 to the settings screen, because
 * whoever is looking at it is a person in a tab rather than a script — and
 * `fetch` follows redirects by default, so `raw` would parse the served
 * `index.html` as JSON and fail with a syntax error rather than a useful one.
 */
async function hop(who: { cookie: string }, path: string): Promise<{ status: number; location: string }> {
  const response = await fetch(`${base}${path}`, { headers: { cookie: who.cookie }, redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location') ?? '' };
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
    const config = await credentialsFor(get<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support));
    assert.deepEqual(config?.credential, { kind: 'password', password: 'hunter2' });
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

/* ------------------------------------------------- what a paste drags in */

/**
 * A host is copied out of a hosting panel, and a selection takes what is at its
 * edges.
 *
 * One instance sat on `calendoora-de.netcup-mail.de` being refused for
 * containing a space, in a field showing no space, because what it contained
 * was invisible. The refusal read "a host name has no spaces in it", which is
 * the one thing an error must never do — argue with what the person can see.
 *
 * So the invisible ones are removed and only the visible ones are reported, by
 * name. Both halves are pinned: the cleaning, and the sentence.
 */
describe('a host name that was pasted rather than typed', () => {
  const HOST = 'calendoora-de.netcup-mail.de';

  for (const [what, host] of [
    ['a trailing space', `${HOST} `],
    ['a leading space', ` ${HOST}`],
    ['a non-breaking space at the end', `${HOST}\u00a0`],
    ['a zero-width space at the end', `${HOST}\u200b`],
    ['a zero-width space in the middle', 'calendoora-de.\u200bnetcup-mail.de'],
    ['a byte-order mark in front', `\ufeff${HOST}`],
    ['a trailing newline', `${HOST}\n`],
  ] as const) {
    it(`survives ${what}`, () => {
      assert.equal(cleanHost(host), HOST);
      assert.equal(checkMailbox({ host, port: 993, encryption: 'tls', username: 'support@calendoora.de' }), null);
    });
  }

  /*
   * The other half of the rule, and the reason it is not simply "strip all
   * whitespace": a space in the middle is one somebody can see, so it is a typo
   * to report rather than a character to delete. Deleting it would turn
   * "mail example com" into a host that resolves somewhere else entirely.
   */
  it('still refuses a space somebody can see, and says which character it is', () => {
    const said = checkMailbox({ host: 'calendoora-de netcup-mail.de', port: 993, encryption: 'tls' });
    assert.match(String(said), /has a space in it/);
  });

  it('names a non-breaking space in the middle rather than calling it a space', () => {
    const said = checkMailbox({ host: 'calendoora-de.\u00a0netcup-mail.de', port: 993, encryption: 'tls' });
    assert.match(String(said), /non-breaking space \(U\+00A0\)/);
  });

  it('names the character in a pasted URL instead of talking about spaces', () => {
    const said = checkMailbox({ host: 'imaps://mail.example.com', port: 993, encryption: 'tls' });
    assert.match(String(said), /"\/" \(U\+002F\)/);
  });

  it('asks for a host when there is none, rather than blaming spaces', () => {
    assert.match(String(checkMailbox({ host: '', port: 993, encryption: 'tls' })), /needs a host/);
  });

  /* And the write path settles it, so no later reader has to clean it again. */
  it('stores the cleaned host, not what was pasted', async () => {
    const made = await raw(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'pasted@calendoora.de',
      host: `\u200b${HOST} `,
      username: ' pasted@calendoora.de ',
    });
    assert.equal(made.status, 200);
    const row = get<any>(`SELECT * FROM mailboxes WHERE id = ?`, made.body.id);
    assert.equal(row.host, HOST);
    assert.equal(row.username, 'pasted@calendoora.de');
    // Taken back out again. Every later block in this file counts the mailboxes
    // it can see, and a row left behind here fails two of them — which is how
    // this test first ran.
    run(`DELETE FROM mailboxes WHERE id = ?`, made.body.id);
  });

  /*
   * The row that is already wrong.
   *
   * Cleaning on the way in fixes every mailbox from here on and not one that is
   * already stored — and the stored one is the whole report: its owner cannot
   * retype a character they cannot see, and the field offers them nothing to
   * correct. So the row is written here the way the database already holds one,
   * and every path that reads it has to come back clean: what gets dialled,
   * what the screen shows, and whether the password saves.
   */
  it('unbreaks a mailbox that was stored dirty, without anybody retyping it', async () => {
    const dirty = get<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support);
    run(`UPDATE mailboxes SET host = ? WHERE id = ?`, `\u200b${HOST} `, boxes.support);
    try {
      const row = get<any>(`SELECT * FROM mailboxes WHERE id = ?`, boxes.support);
      assert.notEqual(row.host, HOST, 'the row really is stored dirty');

      // What gets dialled, and what the screen shows.
      assert.equal(configOf(row).host, HOST);
      assert.equal(mailboxView(row).host, HOST);

      // And the button that was refusing: a password now saves.
      const saved = await raw(
        people.ada, `/api/workspaces/${workspaceId}/mailboxes/${boxes.support}/password`, { password: 'hunter2' },
      );
      assert.equal(saved.status, 200);
    } finally {
      run(`UPDATE mailboxes SET host = ? WHERE id = ?`, dirty.host, boxes.support);
    }
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

/* --------------------------------------------------------------- OAuth */

/**
 * A provider that hands out tokens without a network.
 *
 * `issued` records every refresh, which is what lets the tests below assert on
 * the thing that actually matters — that a cached token is *not* refreshed. A
 * token endpoint hit every five minutes per mailbox is a rate limit somebody
 * meets on a bad day, and nothing about a working mailbox would show it.
 */
const issued: string[] = [];
let refusing = false;

before(() => {
  registerMailAuthProvider({
    name: 'fake',
    label: 'Fake provider',
    configured: () => true,
    authorizeUrl: ({ state, redirectUri, login }) =>
      `https://provider.test/consent?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&login_hint=${encodeURIComponent(login)}`,
    exchange: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }),
    refresh: async (token) => {
      if (refusing) throw new Error('invalid_grant: the consent was revoked');
      issued.push(token);
      return { accessToken: `access-${issued.length + 1}`, expiresAt: Date.now() + 3_600_000 };
    },
  });
});

describe('a mailbox that signs in with a token', () => {
  let box = '';

  before(async () => {
    box = (await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'oauth@calendoora.de', host: 'imap.calendoora.de',
    })).id;
    storeTokens(box, 'fake', { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }, people.ada.id);
  });

  it('stores the refresh token where the password was, sealed', () => {
    const raw = get<any>(`SELECT * FROM mailbox_credentials WHERE mailbox_id = ?`, box);
    assert.equal(raw.kind, 'oauth');
    assert.equal(raw.provider, 'fake');
    assert.notEqual(raw.secret, 'refresh-1');
    assert.notEqual(raw.access_token, 'access-1');
    assert.equal(storedCredential(box)?.secret, 'refresh-1');
  });

  it('never sends either half to a client', async () => {
    const listed = await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`);
    const row = listed.mailboxes.find((one: any) => one.id === box);
    assert.equal(row.auth, 'oauth');
    assert.equal(row.provider, 'fake');
    assert.equal(row.secret, undefined);
    assert.equal(row.access_token, undefined);
    // `access` *is* sent and should be: two tables away it means who may read
    // the inbox, which is a different thing entirely — see the note on the
    // credential column, which was called `access` for about an hour.
    assert.equal(row.access, 'workspace');
    const pulled = await as(people.ada, `/api/sync/pull?workspace=${workspaceId}&since=0`);
    for (const one of pulled.changes.mailbox) {
      assert.equal(one.password, undefined);
      assert.equal(one.secret, undefined);
    }
  });

  it('uses the cached token rather than asking again', async () => {
    const before = issued.length;
    assert.equal(await accessTokenFor(box), 'access-1');
    assert.equal(await accessTokenFor(box), 'access-1');
    assert.equal(issued.length, before, 'a valid token was refreshed anyway');
  });

  it('refreshes once the token has gone stale, and keeps the refresh token', async () => {
    // Expired a minute ago. The slack in `accessTokenFor` is why this is not
    // simply `Date.now()`: a first pass holds one connection for minutes, and
    // a token that dies halfway through is a batch lost to an error that reads
    // like a wrong password.
    run(`UPDATE mailbox_credentials SET expires_at = ? WHERE mailbox_id = ?`, Date.now() - 60_000, box);
    const token = await accessTokenFor(box);
    assert.equal(token, 'access-2');
    assert.deepEqual(issued.slice(-1), ['refresh-1']);
    // The provider repeated no refresh token, so the stored one is kept —
    // overwriting it with `undefined` would sign the mailbox out in an hour.
    assert.equal(storedCredential(box)?.secret, 'refresh-1');
  });

  it('reports a revoked consent rather than "no password stored"', async () => {
    run(`UPDATE mailbox_credentials SET expires_at = ? WHERE mailbox_id = ?`, Date.now() - 60_000, box);
    refusing = true;
    try {
      await assert.rejects(() => credentialsFor(get<any>(`SELECT * FROM mailboxes WHERE id = ?`, box)), /revoked/);
      // And the poller records it on the row, where the screen shows it —
      // rather than the timestamp advancing and the mailbox looking fresh.
      const result = await pollMailbox(get<any>(`SELECT * FROM mailboxes WHERE id = ?`, box));
      assert.match(String(result.error), /revoked/);
      const row = get<any>(`SELECT last_status, last_error, last_sync_at FROM mailboxes WHERE id = ?`, box);
      assert.equal(row.last_status, 'failing');
      assert.match(String(row.last_error), /revoked/);
      assert.equal(row.last_sync_at, null);
    } finally {
      refusing = false;
    }
  });

  it('goes back to a password cleanly, taking the token with it', () => {
    setPassword(box, 'hunter2', people.ada.id);
    const stored = storedCredential(box);
    assert.equal(stored?.kind, 'password');
    assert.equal(stored?.secret, 'hunter2');
    // Two credentials on one mailbox is a question nobody wants to answer at
    // sign-in time, and a refresh token outliving the decision to stop using
    // it is a grant nobody remembers making.
    assert.equal(stored?.accessToken, null);
    assert.equal(stored?.provider, '');
  });
});

describe('the consent flow', () => {
  let box = '';
  before(async () => {
    box = (await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'consent@calendoora.de', host: 'imap.calendoora.de',
    })).id;
  });

  it('sends the browser somewhere with the mailbox pre-filled', async () => {
    const started = await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'fake' });
    const url = new URL(started.url);
    assert.equal(url.host, 'provider.test');
    // So the account picker offers the right inbox rather than whichever one
    // the browser happens to be signed in to — which is how somebody connects
    // their personal mail to the company's support queue.
    assert.equal(url.searchParams.get('login_hint'), 'consent@calendoora.de');
    assert.match(String(url.searchParams.get('redirect_uri')), /\/api\/mail\/oauth\/callback$/);
  });

  it('refuses a member, like every other mailbox write', async () => {
    const refused = await raw(people.max, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'fake' });
    assert.equal(refused.status, 403);
  });

  it('says which provider is missing rather than "something went wrong"', async () => {
    // The whole content of this failure is *which* setting is absent, so the
    // generic 500 the bare throw produced was the least useful answer
    // available. Found by running it rather than by reading it.
    const refused = await raw(people.ada, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'google' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /not configured on this server/);
    const unknown = await raw(people.ada, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'nope' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /No mail OAuth provider/);
  });

  it('connects the mailbox when the browser comes back', async () => {
    const started = await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'fake' });
    const state = new URL(started.url).searchParams.get('state')!;
    const back = await hop(people.ada, `/api/mail/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(back.status, 302);
    assert.match(back.location, /tab=mailboxes.*mail_connected=1/);
    assert.equal(storedCredential(box)?.kind, 'oauth');
    assert.equal(storedCredential(box)?.secret, 'refresh-1');
  });

  it('will not accept the same state twice', async () => {
    const started = await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'fake' });
    const state = new URL(started.url).searchParams.get('state')!;
    assert.match((await hop(people.ada, `/api/mail/oauth/callback?code=abc&state=${encodeURIComponent(state)}`)).location, /mail_connected/);
    // A state is one attempt. The second is answered with an error rather than
    // connecting again — a state that survived its use is a replay.
    const replayed = await hop(people.ada, `/api/mail/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(replayed.status, 302);
    assert.match(replayed.location, /mail_error/);
  });

  it('refuses a callback finished by somebody else', async () => {
    // A callback is a URL somebody can be sent, so the person who comes back
    // has to be the person who started it.
    const started = await as(people.ada, `/api/workspaces/${workspaceId}/mailboxes/${box}/oauth`, { provider: 'fake' });
    const state = new URL(started.url).searchParams.get('state')!;
    const stolen = await hop(people.lin, `/api/mail/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(stolen.status, 302);
    assert.match(decodeURIComponent(stolen.location.replace(/\+/g, ' ')), /started by somebody else/);
    // And nothing was written under the wrong person's consent.
    assert.equal(storedCredential(box)?.secret, 'refresh-1');
  });
});

/* ------------------------------------------------------ the box over everything */

describe('mail in the global search box', () => {
  it('finds a message the shared index has never heard of', () => {
    // The gap this closed: the Mail screen found it, `search_mail` found it,
    // and the one box at the top of the app said "no results" — with nothing
    // to suggest it had not looked.
    const hits = searchWorkspace(workspaceId, people.ada.id, 'Rechnungsnummer');
    assert.ok(hits.some((hit) => hit.kind === 'mail'), JSON.stringify(hits));
  });

  it('carries the sender, because a subject alone does not say it is an email', () => {
    const hit = searchWorkspace(workspaceId, people.ada.id, 'Rechnungsnummer').find((one) => one.kind === 'mail');
    assert.match(String(hit?.snippet), /Anna Weber/);
    assert.equal(hit?.title, 'Rechnung März 2024');
  });

  it('inherits the mailbox rule rather than restating it', () => {
    // The corpus resolves the readable mailboxes exactly as every other reader
    // does, so a restricted inbox is not findable from the box either — and
    // nothing in the kernel had to be told that mailboxes exist.
    assert.equal(searchWorkspace(workspaceId, people.ada.id, 'Lohnabrechnung').filter((h) => h.kind === 'mail').length, 1);
    assert.equal(searchWorkspace(workspaceId, people.max.id, 'Lohnabrechnung').filter((h) => h.kind === 'mail').length, 0);
  });

  it('is skipped entirely when the caller asked for other kinds', () => {
    // Asserted as "no mail among the hits" rather than "no hits": the same word
    // is in a task by now, because `file_mail_as_task` above put the message's
    // body in one. That is the corpus filter working, not a coincidence to
    // write around.
    const tasksOnly = searchWorkspace(workspaceId, people.ada.id, 'Rechnungsnummer', 30, ['task']);
    assert.ok(tasksOnly.length > 0);
    assert.equal(tasksOnly.filter((hit) => hit.kind === 'mail').length, 0);
    assert.ok(searchWorkspace(workspaceId, people.ada.id, 'Rechnungsnummer', 30, ['mail']).length > 0);
  });

  it('interleaves rather than letting one corpus take the whole page', () => {
    // Two rankings from two FTS tables cannot be compared — see `interleave`.
    // What the merge promises is only that each corpus's best hit is near the
    // top, which is what this checks: one mail among two results, not two
    // mails and no task.
    const project = get<any>(`SELECT id FROM projects WHERE workspace_id = ? LIMIT 1`, workspaceId);
    const state = get<any>(`SELECT id FROM states WHERE project_id = ? LIMIT 1`, project.id);
    for (const title of ['Zwiebelkuchen one', 'Zwiebelkuchen two', 'Zwiebelkuchen three']) {
      writeEntity('task', uid(), { project_id: project.id, title, state_id: state.id },
        { workspaceId, actorId: people.ada.id, hlc: serverClock.now() });
    }
    seed(boxes.support, { subject: 'Zwiebelkuchen', body: 'Zwiebelkuchen im Anhang' });

    const two = searchWorkspace(workspaceId, people.ada.id, 'Zwiebelkuchen', 2);
    assert.equal(two.length, 2);
    assert.deepEqual([...new Set(two.map((hit) => hit.kind))].sort(), ['mail', 'task']);
  });

  it('answers without mail rather than not at all when a corpus fails', () => {
    // A box that went blank because an inbox was unreachable would be a worse
    // failure than the gap it is covering.
    registerCorpus({ kind: 'exploding', find: () => { throw new Error('nope'); } });
    const hits = searchWorkspace(workspaceId, people.ada.id, 'Rechnungsnummer');
    assert.ok(hits.length > 0);
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

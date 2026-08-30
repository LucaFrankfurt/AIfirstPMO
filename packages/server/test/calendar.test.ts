/**
 * Due dates, where somebody already looks.
 *
 * Two halves, and the first is the one that quietly goes wrong: iCalendar is a
 * format whose mistakes produce an *empty* calendar rather than an error, so
 * the folding, the escaping and the exclusive `DTEND` are asserted on the bytes
 * rather than trusted.
 *
 * The second half is who may read one. The URL is the whole authorisation, so
 * it has to be worth exactly what the person it belongs to is worth and not a
 * character more.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-calendar-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { buildCalendar } = await import('../src/adapters/calendar/ical.ts');

let base = '';
const jar: Record<string, string> = {};
let workspaceId = '';
let projectId = '';
let feedUrl = '';
let mallorysWorkspace = '';

async function call(who: string, path: string, body?: unknown, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(jar[who] ? { cookie: jar[who] } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    jar[who] = [...(jar[who] ? [jar[who]] : []), cookie.split(';')[0]].join('; ');
  }
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    type,
    text,
    body: text && type.includes('json') ? JSON.parse(text) : null,
  };
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const session = await call('ada', '/api/auth/register', {
    email: 'ada@example.com', name: 'Ada Lovelace', password: 'correct horse battery',
  });
  workspaceId = session.body.workspaces[0].id;
  const me = session.body.user.id;

  const other = await call('mallory', '/api/auth/register', {
    email: 'mallory@example.com', name: 'Mallory', password: 'correct horse battery',
  });
  mallorysWorkspace = other.body.workspaces[0].id;

  projectId = (await call('ada', `/api/workspaces/${workspaceId}/projects`, { name: 'Website', key: 'WEB' })).body.id;

  // Two of Ada's, one of nobody's — the feed is what is on *her*.
  await call('ada', `/api/workspaces/${workspaceId}/tasks`, {
    project_id: projectId, title: 'Redraw the empty state', due_date: '2026-09-04',
    assignees: [me], priority: 'urgent',
  });
  await call('ada', `/api/workspaces/${workspaceId}/tasks`, {
    project_id: projectId, title: 'Buy milk, eggs; and bread', due_date: '2026-09-05', assignees: [me],
  });
  await call('ada', `/api/workspaces/${workspaceId}/tasks`, {
    project_id: projectId, title: 'Nobody is on this', due_date: '2026-09-06',
  });
  await call('ada', `/api/workspaces/${workspaceId}/tasks`, {
    project_id: projectId, title: 'No date on this one', assignees: [me],
  });

  feedUrl = (await call('ada', '/api/me/calendar', {})).body.url;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------ the format */

describe('the bytes iCalendar actually requires', () => {
  const one = (over: Partial<Parameters<typeof buildCalendar>[0]['entries'][0]> = {}) => buildCalendar({
    name: 'Test',
    now: Date.UTC(2026, 7, 21, 12, 0, 0),
    entries: [{ uid: 'a@kolibri', summary: 'Hello', due: '2026-09-04', ...over }],
  });

  it('ends every line with CRLF, including the last', () => {
    const text = one();
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'a bare LF anywhere is a malformed file');
  });

  it('makes DTEND exclusive, or the client draws it a day early', () => {
    const text = one();
    assert.match(text, /DTSTART;VALUE=DATE:20260904/);
    assert.match(text, /DTEND;VALUE=DATE:20260905/);
  });

  it('escapes the four characters that mean something', () => {
    const text = one({ summary: 'Buy milk, eggs; and a\\thing' });
    assert.match(text, /SUMMARY:Buy milk\\, eggs\\; and a\\\\thing/);
  });

  it('turns a newline in a description into the escape, not a new line', () => {
    const text = one({ description: 'first\nsecond' });
    assert.match(text, /DESCRIPTION:first\\nsecond/);
    assert.doesNotMatch(text, /^second/m);
  });

  it('folds a long line at 75 octets and continues it with a space', () => {
    const text = one({ summary: 'x'.repeat(200) });
    for (const line of text.split('\r\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line of ${Buffer.byteLength(line)} octets: ${line.slice(0, 40)}…`);
    }
    assert.match(text, /\r\n x/, 'a continuation line starts with a space');
  });

  it('folds on octets rather than characters, and never mid-character', () => {
    // Every character is three bytes, so a naive 75-*character* fold would
    // produce lines of 225 octets — and a naive octet fold would cut one in
    // half and produce a replacement character.
    const text = one({ summary: '日'.repeat(60) });
    for (const line of text.split('\r\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `${Buffer.byteLength(line)} octets`);
    }
    assert.doesNotMatch(text, /�/, 'a character was cut in half');
    // And it still says what it said: unfolding puts it back together.
    assert.ok(text.replace(/\r\n /g, '').includes('日'.repeat(60)));
  });

  it('writes VTODO when asked, and VEVENT when not', () => {
    assert.match(one(), /BEGIN:VEVENT/);
    const todo = buildCalendar({
      name: 'Test', kind: 'todo', now: 0,
      entries: [{ uid: 'a', summary: 'x', due: '2026-09-04' }],
    });
    assert.match(todo, /BEGIN:VTODO/);
    assert.match(todo, /DUE;VALUE=DATE:20260904/);
    assert.doesNotMatch(todo, /DTEND/, 'a todo has a due, not an end');
  });

  it('starts on the start date when there is one', () => {
    const text = one({ start: '2026-09-01' });
    assert.match(text, /DTSTART;VALUE=DATE:20260901/);
    assert.match(text, /DTEND;VALUE=DATE:20260905/);
  });
});

/* ------------------------------------------------------------- the feed */

describe('subscribing to it', () => {
  it('hands out a URL only when asked, and the same one twice', async () => {
    assert.match(feedUrl, /\/calendar\/[\w-]{20,}\.ics$/);
    const again = await call('ada', '/api/me/calendar', {});
    assert.equal(again.body.url, feedUrl, 'asking twice does not invalidate the first');
  });

  it('serves what is on that person, with a due date, and nothing else', async () => {
    const feed = await call('anon', new URL(feedUrl).pathname);
    assert.equal(feed.status, 200);
    assert.match(feed.type, /text\/calendar/);
    assert.match(feed.text, /WEB-1 Redraw the empty state/);
    assert.match(feed.text, /Buy milk\\, eggs\\; and bread/);
    assert.doesNotMatch(feed.text, /Nobody is on this/, 'not assigned to her');
    assert.doesNotMatch(feed.text, /No date on this one/, 'nothing for a calendar to draw');
  });

  it('carries the priority and a link back', async () => {
    const feed = await call('anon', new URL(feedUrl).pathname);
    assert.match(feed.text, /PRIORITY:1/);
    assert.match(feed.text, /URL:http/);
    assert.match(feed.text, /STATUS:NEEDS-ACTION/);
  });

  it('answers as VTODO when the client wants tasks', async () => {
    const feed = await call('anon', `${new URL(feedUrl).pathname}?kind=todo`);
    assert.match(feed.text, /BEGIN:VTODO/);
  });

  it('is never cached by anything in between', async () => {
    const response = await fetch(feedUrl.replace(/^https?:\/\/[^/]+/, base));
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('refuses a token that is not one', async () => {
    assert.equal((await call('anon', '/calendar/not-a-real-token-at-all.ics')).status, 404);
    assert.equal((await call('anon', '/calendar/short.ics')).status, 404);
  });

  it('stops answering the old URL the moment it is rotated', async () => {
    const rotated = await call('ada', '/api/me/calendar/rotate', {});
    assert.notEqual(rotated.body.url, feedUrl);
    assert.equal((await call('anon', new URL(feedUrl).pathname)).status, 404, 'the old link is gone');
    assert.equal((await call('anon', new URL(rotated.body.url).pathname)).status, 200);
    feedUrl = rotated.body.url;
  });

  it('turns off entirely when deleted', async () => {
    const url = feedUrl;
    const off = await call('ada', '/api/me/calendar', undefined, 'DELETE');
    assert.equal(off.status, 200, off.text);
    assert.equal((await call('anon', new URL(url).pathname)).status, 404);
    assert.equal((await call('ada', '/api/me/calendar')).body.url, null);
    feedUrl = (await call('ada', '/api/me/calendar', {})).body.url;
  });
});

describe('a saved view as a calendar', () => {
  let viewUrl = '';

  it('serves the view a member can see', async () => {
    const view = await call('ada', `/api/workspaces/${workspaceId}/views`, {
      name: 'Everything', project_id: projectId, layout: 'list', filters: {}, show_done: 1,
    });
    viewUrl = `${new URL(feedUrl).pathname.replace(/\.ics$/, '')}/${view.body.id}.ics`;

    const feed = await call('anon', viewUrl);
    assert.equal(feed.status, 200);
    // A view is not "my work": the unassigned task with a date is in it.
    assert.match(feed.text, /Nobody is on this/);
    assert.doesNotMatch(feed.text, /No date on this one/);
  });

  it('refuses a view in a workspace the token holder is not in', async () => {
    // Mallory's own workspace, from their own session rather than a list
    // endpoint that does not exist.
    const theirWorkspace = mallorysWorkspace;
    const theirProject = (await call('mallory', `/api/workspaces/${theirWorkspace}/projects`, { name: 'Secret', key: 'SEC' })).body.id;
    const theirView = await call('mallory', `/api/workspaces/${theirWorkspace}/views`, {
      name: 'Theirs', project_id: theirProject, layout: 'list', filters: {},
    });

    const path = `${new URL(feedUrl).pathname.replace(/\.ics$/, '')}/${theirView.body.id}.ics`;
    assert.equal((await call('anon', path)).status, 404, 'a feed token is not a way into another workspace');
  });
});

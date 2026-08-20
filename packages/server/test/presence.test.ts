/**
 * Who is here, and who is typing.
 *
 * Three things are worth testing and everything else is decoration.
 *
 * **It expires.** Presence is the only state in this app that is true for a
 * few seconds and then is not, so the thing that can actually break is the
 * clock: a name that stays lit after the laptop closed is worse than no
 * indicator, because it is a wrong answer rather than a missing one.
 *
 * **It is not a directory.** The rule the sync filter applies to a `user` row
 * applies here too — somebody in a workspace with you, or somebody you are
 * already in a direct conversation with. If presence leaked more widely it
 * would be a way to enumerate the accounts on an instance, which is exactly
 * what the `user` filter exists to prevent.
 *
 * **It rides the stream without joining it.** The events arrive on the same
 * connection as the change notifications and carry no cursor, so a client that
 * drops every one of them still syncs correctly.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-presence-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { directChannelId } = await import('@kolibri/shared');
const { run } = await import('../src/db/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const presence = await import('../src/lib/presence.ts');

let base = '';
let workspaceId = '';

interface Person {
  id: string;
  name: string;
  cookie: string;
}

const people: Record<string, Person> = {};

async function as(who: Person | null, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(who ? { cookie: who.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(email: string, name: string): Promise<Person> {
  resetRateLimits();
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name, password: 'correct horse battery' }),
  });
  const session = await response.json() as any;
  return { id: session.user.id, name, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}

/**
 * Read events off the stream until one of them is a `presence` frame, or the
 * deadline passes. Deliberately not "read one frame": the connection opens with
 * a `hello` and can carry `change` events from anything else in the test run.
 */
async function nextPresence(who: Person, ms = 2000): Promise<any[] | null> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    const response = await fetch(`${base}/api/sync/stream?workspace=${workspaceId}&client=test-${who.id}`, {
      headers: { cookie: who.cookie, accept: 'text/event-stream' },
      signal: control.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (frame.includes('event: presence')) {
          const data = frame.slice(frame.indexOf('data: ') + 6);
          void reader.cancel();
          return JSON.parse(data).people;
        }
        cut = buffer.indexOf('\n\n');
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    control.abort();
  }
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  people.ada = await register('ada@example.com', 'Ada');
  const session = await as(people.ada, '/api/session');
  workspaceId = session.body.workspaces[0].id;

  people.lin = await register('lin@example.com', 'Lin');
  run(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at, seq, clocks)
     VALUES (?, ?, ?, 'member', ?, ?, 0, '{}')`,
    `wm-${people.lin.id}`, workspaceId, people.lin.id, Date.now(), Date.now(),
  );

  // Zoe shares no workspace with anybody. She is the control.
  people.zoe = await register('zoe@example.com', 'Zoe');
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

beforeEach(() => presence.forget());

/* ------------------------------------------------------------------ clocks */

describe('presence', () => {
  it('counts somebody as here the moment they beat', () => {
    presence.touch(people.ada.id);
    assert.equal(presence.isOnline(people.ada.id), true);
  });

  it('forgets them once the window has passed', () => {
    presence.touch(people.ada.id);
    // Age the entry rather than waiting 45 seconds for it.
    presence.presenceInternals.seen.get(people.ada.id)!.at = Date.now() - presence.presenceInternals.ONLINE_MS - 1;
    assert.equal(presence.isOnline(people.ada.id), false);
    presence.presenceInternals.sweep();
    assert.equal(presence.presenceInternals.seen.has(people.ada.id), false);
  });

  it('announces the departure, so a lit name goes out without a reload', () => {
    const heard: any[] = [];
    const stop = presence.subscribePresence((event) => heard.push(event));
    try {
      presence.touch(people.ada.id);
      presence.presenceInternals.seen.get(people.ada.id)!.at = Date.now() - presence.presenceInternals.ONLINE_MS - 1;
      presence.presenceInternals.sweep();
    } finally {
      stop();
    }
    assert.deepEqual(heard.at(-1), { userId: people.ada.id, online: false, typing: null });
  });

  it('lets typing expire on its own, faster than the person does', () => {
    presence.touch(people.ada.id, 'channel-1');
    assert.equal(presence.snapshot(new Set([people.ada.id]))[0].typing, 'channel-1');

    presence.presenceInternals.seen.get(people.ada.id)!.typingAt = Date.now() - presence.presenceInternals.TYPING_MS - 1;
    presence.presenceInternals.sweep();
    // Still here — only the typing went stale.
    assert.equal(presence.isOnline(people.ada.id), true);
    assert.equal(presence.snapshot(new Set([people.ada.id]))[0].typing, null);
  });

  it('treats a bare heartbeat as "leave the typing alone" and null as "I stopped"', () => {
    presence.touch(people.ada.id, 'channel-1');
    presence.touch(people.ada.id);
    assert.equal(presence.snapshot(new Set([people.ada.id]))[0].typing, 'channel-1');
    presence.touch(people.ada.id, null);
    assert.equal(presence.snapshot(new Set([people.ada.id]))[0].typing, null);
  });

  it('stays quiet when a beat says the same thing as the last one', () => {
    const heard: any[] = [];
    presence.touch(people.ada.id);
    const stop = presence.subscribePresence((event) => heard.push(event));
    try {
      presence.touch(people.ada.id);
      presence.touch(people.ada.id);
    } finally {
      stop();
    }
    assert.equal(heard.length, 0);
  });
});

/* --------------------------------------------------------------- who may see */

describe('who a person may be told about', () => {
  it('includes the people they share a workspace with', () => {
    const visible = presence.visiblePeople(people.ada.id);
    assert.equal(visible.has(people.lin.id), true);
  });

  it('excludes a stranger on the same instance', () => {
    const visible = presence.visiblePeople(people.ada.id);
    assert.equal(visible.has(people.zoe.id), false);
  });

  it('includes somebody they are in a direct conversation with, workspace or not', async () => {
    const id = directChannelId(people.ada.id, people.zoe.id);
    const created = await as(people.ada, `/api/workspaces/${workspaceId}/channels`, { id, kind: 'direct' });
    assert.equal(created.status < 400, true, JSON.stringify(created.body));

    assert.equal(presence.visiblePeople(people.ada.id).has(people.zoe.id), true);
    assert.equal(presence.visiblePeople(people.zoe.id).has(people.ada.id), true);
  });

  it('hides a stranger from the snapshot even while they are online', () => {
    presence.touch(people.lin.id);
    presence.touch(people.zoe.id);
    const visible = presence.visiblePeople(people.lin.id);
    const seen = presence.snapshot(visible).map((entry) => entry.userId);
    assert.equal(seen.includes(people.zoe.id), false);
  });
});

/* ------------------------------------------------------------- over the wire */

describe('the heartbeat endpoint', () => {
  it('refuses a stranger', async () => {
    const response = await fetch(`${base}/api/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
  });

  it('marks the caller as here', async () => {
    const response = await as(people.lin, '/api/presence', {});
    assert.equal(response.status, 200);
    assert.equal(presence.isOnline(people.lin.id), true);
  });

  it('records what they are typing in', async () => {
    await as(people.lin, '/api/presence', { typing: 'channel-9' });
    assert.equal(presence.snapshot(new Set([people.lin.id]))[0].typing, 'channel-9');
    await as(people.lin, '/api/presence', { typing: null });
    assert.equal(presence.snapshot(new Set([people.lin.id]))[0].typing, null);
  });
});

describe('the stream', () => {
  it('opens with a snapshot of who is already here', async () => {
    presence.touch(people.lin.id, 'channel-3');
    const first = await nextPresence(people.ada);
    assert.ok(first, 'expected a presence frame');
    const lin = first.find((entry: any) => entry.userId === people.lin.id);
    assert.deepEqual(lin, { userId: people.lin.id, online: true, typing: 'channel-3' });
  });

  it('never mentions somebody the viewer may not know exists', async () => {
    presence.touch(people.zoe.id);
    const first = await nextPresence(people.lin);
    assert.ok(first, 'expected a presence frame');
    assert.equal(first.some((entry: any) => entry.userId === people.zoe.id), false);
  });
});

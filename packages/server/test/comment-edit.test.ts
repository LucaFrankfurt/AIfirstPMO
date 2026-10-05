/**
 * Whose words a comment is, asked from the outside.
 *
 * `body` was an ordinary synced field with no rule on it, so until the pencil
 * existed in the interface nothing was *missing* — and that is exactly what
 * kept the hole open. `PATCH /api/comments/<id>` rewrote a colleague's
 * sentence under the colleague's name, and `DELETE` removed it, for any member
 * who could see the task. The screen only ever showed the author a pencil, and
 * the screen is not the only way in.
 *
 * So these are plain HTTP calls with a second member's own cookie, the way
 * `isolation.test.ts` is written: the difference between "the interface does
 * not offer it" and "the server refuses it" only shows from here.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-comment-edit-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';

async function call(path: string, options: { cookie?: string; body?: unknown; method?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(email: string): Promise<{ cookie: string; workspace: string; id: string }> {
  resetRateLimits();
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0], password: 'correct horse battery' }),
  });
  const session = await response.json() as any;
  return {
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0],
    workspace: session.workspaces[0].id,
    id: session.user.id,
  };
}

let ada: { cookie: string; workspace: string; id: string };
let lin: { cookie: string; workspace: string; id: string };
let admin: { cookie: string; workspace: string; id: string };
let taskId = '';
let pageId = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ada = await register('ada@example.com');

  const join = async (email: string, role: 'member' | 'admin') => {
    const { body: invite } = await call(`/api/workspaces/${ada.workspace}/invites`, {
      cookie: ada.cookie, body: { role },
    });
    const person = await register(email);
    await call(`/api/invites/${invite.code}/accept`, { cookie: person.cookie, body: {} });
    return person;
  };
  lin = await join('lin@example.com', 'member');
  admin = await join('mo@example.com', 'admin');

  const { body: project } = await call(`/api/workspaces/${ada.workspace}/projects`, {
    cookie: ada.cookie, body: { name: 'Release', key: 'REL' },
  });
  taskId = (await call(`/api/workspaces/${ada.workspace}/tasks`, {
    cookie: ada.cookie, body: { project_id: project.id, title: 'Ship it' },
  })).body.id;
  pageId = (await call(`/api/workspaces/${ada.workspace}/pages`, {
    cookie: ada.cookie, body: { project_id: project.id, title: 'Release notes', content: 'Soon.' },
  })).body.id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/** A fresh comment by whoever is given, so one case cannot bleed into the next. */
const comment = async (person: { cookie: string }, fields: Record<string, unknown>) =>
  (await call(`/api/workspaces/${ada.workspace}/comments`, { cookie: person.cookie, body: fields })).body;

describe('a comment its author rewrites', () => {
  it('takes the new words and says that it was edited', async () => {
    const made = await comment(ada, { task_id: taskId, body: 'Ships Tusday' });
    assert.equal(made.edited_at, null, 'a comment nobody has edited must not claim to have been');

    const { status, body } = await call(`/api/comments/${made.id}`, {
      cookie: ada.cookie, method: 'PATCH', body: { body: 'Ships Tuesday' },
    });
    assert.equal(status, 200);
    assert.equal(body.body, 'Ships Tuesday');
    assert.ok(Number(body.edited_at) > 0, 'the body changed and nothing recorded it');
  });

  it('stamps the server’s clock rather than the client’s claim', async () => {
    const made = await comment(ada, { task_id: taskId, body: 'first' });
    // Both halves of the lie: a date in the past on a real edit, and a date on
    // a write that does not touch the body at all.
    await call(`/api/comments/${made.id}`, {
      cookie: ada.cookie, method: 'PATCH', body: { body: 'second', edited_at: 1 },
    });
    const edited = get<any>(`SELECT edited_at FROM comments WHERE id = ?`, made.id);
    assert.ok(Number(edited.edited_at) > 1_600_000_000_000, `a client set edited_at: ${edited.edited_at}`);

    const quiet = await comment(ada, { task_id: taskId, body: 'untouched' });
    await call(`/api/comments/${quiet.id}`, {
      cookie: ada.cookie, method: 'PATCH', body: { edited_at: Date.now() },
    });
    assert.equal(
      get<any>(`SELECT edited_at FROM comments WHERE id = ?`, quiet.id).edited_at, null,
      'a comment can claim to have been edited without anybody editing it',
    );
  });

  it('cannot move to another task, another page, another author or another passage', async () => {
    const made = await comment(ada, {
      task_id: taskId, body: 'about this sentence', anchor: { quote: 'Soon.', before: '', after: '' },
    });
    await call(`/api/comments/${made.id}`, {
      cookie: ada.cookie,
      method: 'PATCH',
      body: {
        task_id: null, page_id: pageId, author_id: lin.id,
        anchor: { quote: 'something else', before: '', after: '' },
      },
    });
    const row = get<any>(`SELECT * FROM comments WHERE id = ?`, made.id);
    assert.equal(row.task_id, taskId, 'an edit rewrites the words, not what they are about');
    assert.equal(row.page_id, null);
    assert.equal(row.author_id, ada.id, 'a comment changed who said it');
    assert.match(String(row.anchor), /about this sentence|Soon\./, `the anchor moved: ${row.anchor}`);
  });
});

describe('a comment somebody else wrote', () => {
  it('cannot be rewritten', async () => {
    const made = await comment(ada, { task_id: taskId, body: 'I disagree with the plan' });
    const { status } = await call(`/api/comments/${made.id}`, {
      cookie: lin.cookie, method: 'PATCH', body: { body: 'I agree with the plan' },
    });
    assert.equal(status, 403, 'a colleague rewrote somebody’s words under their name');
    assert.equal(
      get<any>(`SELECT body FROM comments WHERE id = ?`, made.id).body,
      'I disagree with the plan',
    );
  });

  it('cannot be deleted', async () => {
    const made = await comment(ada, { task_id: taskId, body: 'still here' });
    const { status } = await call(`/api/comments/${made.id}`, { cookie: lin.cookie, method: 'DELETE' });
    assert.equal(status, 403, 'a colleague deleted somebody else’s comment');
    assert.equal(get<any>(`SELECT deleted_at FROM comments WHERE id = ?`, made.id).deleted_at, null);
  });

  it('can still be reacted to, and only the reactor’s own name moves', async () => {
    const made = await comment(ada, { task_id: taskId, body: 'worth a 👍' });
    await call(`/api/comments/${made.id}`, {
      cookie: ada.cookie, method: 'PATCH', body: { reactions: { '👍': [ada.id] } },
    });

    // Lin's whole-map write arrives claiming Ada is not on the emoji and that
    // somebody who never reacted is. One of those is Lin's to say.
    const { status, body } = await call(`/api/comments/${made.id}`, {
      cookie: lin.cookie, method: 'PATCH', body: { reactions: { '👍': [lin.id], '🎉': [ada.id] } },
    });
    assert.equal(status, 200, 'a reaction is not an edit and must stay allowed');
    assert.deepEqual([...body.reactions['👍']].sort(), [ada.id, lin.id].sort(), 'a doctored map cleared a reaction');
    assert.equal(body.reactions['🎉'], undefined, 'a write added a reaction in somebody else’s name');
  });

  it('refuses a reaction from somebody who cannot see it at all', async () => {
    const made = await comment(ada, { task_id: taskId, body: 'inside' });
    const stranger = await register('mallory@example.com');
    const { status } = await call(`/api/comments/${made.id}`, {
      cookie: stranger.cookie, method: 'PATCH', body: { reactions: { '👍': [stranger.id] } },
    });
    assert.equal(status, 403, 'the carve-out for reactions is a way in for anybody holding an id');
  });
});

/**
 * A note left through a public link, which has no account behind it.
 *
 * `author_id` is null, so "only the author" names nobody — and the answer is
 * not "then anybody". Nobody may put words in a stranger's mouth under the
 * name they typed; somebody has to be able to take the note down, and the
 * people who can also revoke the link are the right ones.
 */
describe('a note from outside', () => {
  let guestComment = '';

  before(async () => {
    const { body: share } = await call(`/api/workspaces/${ada.workspace}/shares`, {
      cookie: ada.cookie,
      body: { kind: 'page', page_id: pageId, name: 'Please review', allow_comments: 1 },
    });
    resetRateLimits();
    const posted = await fetch(`${base}/s/${share.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ note: 'The second paragraph contradicts the first.', who: 'Kim' }).toString(),
      redirect: 'manual',
    });
    assert.equal(posted.status, 303, 'the note has to land before anything can be asked about it');
    guestComment = get<any>(
      `SELECT id FROM comments WHERE page_id = ? AND author_id IS NULL ORDER BY created_at DESC`, pageId,
    ).id;
  });

  it('cannot be rewritten by anybody, admin included', async () => {
    for (const person of [() => ada, () => lin, () => admin]) {
      const { status } = await call(`/api/comments/${guestComment}`, {
        cookie: person().cookie, method: 'PATCH', body: { body: 'Actually it is fine.' },
      });
      assert.equal(status, 403, 'a member rewrote an outsider’s note under the outsider’s name');
    }
    assert.match(get<any>(`SELECT body FROM comments WHERE id = ?`, guestComment).body, /contradicts/);
  });

  it('is not an ordinary member’s to delete', async () => {
    const { status } = await call(`/api/comments/${guestComment}`, { cookie: lin.cookie, method: 'DELETE' });
    assert.equal(status, 403);
    assert.equal(get<any>(`SELECT deleted_at FROM comments WHERE id = ?`, guestComment).deleted_at, null);
  });

  it('is an admin’s to delete, because a share link is a door to strangers', async () => {
    const { status } = await call(`/api/comments/${guestComment}`, { cookie: admin.cookie, method: 'DELETE' });
    assert.equal(status, 200, 'nobody could take down a note left from outside');
    assert.ok(get<any>(`SELECT deleted_at FROM comments WHERE id = ?`, guestComment).deleted_at);
  });
});

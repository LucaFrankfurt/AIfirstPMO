/**
 * What was said on a private page, and who may read it.
 *
 * A comment is whatever it hangs on. The pull filter has always said so in two
 * clauses — a task half and a page half — and three other doors said only the
 * first: the REST read of one comment and the listing waved through any comment
 * with no task, and search let a page through on its project alone, ignoring
 * the page's own `access`. Found while adding pinned comments to canvases,
 * which are page comments too, and measured before the fix against a seeded
 * instance: a member who got 403 for a colleague's private page got 200 and the
 * text of the comment on it, the comment in the listing, and both the page and
 * the comment from search.
 *
 * Plus the write the other way round: leaving a comment on a page you cannot
 * see was accepted, because the guard only looked at comments that existed.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-page-comments-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
interface Person { cookie: string; id: string }

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
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.get('set-cookie') };
}

async function ok<T = any>(path: string, options: Parameters<typeof call>[1] = {}): Promise<T> {
  const result = await call(path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

let author: Person;
let colleague: Person;
let workspace = '';
let page = '';
let comment = '';
let open = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const register = async (email: string): Promise<Person> => {
    resetRateLimits();
    const result = await call('/api/auth/register', { body: { email, name: email.split('@')[0], password: 'correct horse battery' } });
    return { cookie: result.setCookie!.split(';')[0], id: result.body.user.id };
  };
  author = await register('comments-author@example.com');
  workspace = (await ok('/api/session', { cookie: author.cookie })).workspaces[0].id;
  const invite = await ok(`/api/workspaces/${workspace}/invites`, { cookie: author.cookie, body: { role: 'member' } });
  colleague = await register('comments-colleague@example.com');
  await ok(`/api/invites/${invite.code}/accept`, { cookie: colleague.cookie, body: {} });

  page = (await ok(`/api/workspaces/${workspace}/pages`, {
    cookie: author.cookie, body: { title: 'Zebrafinch notes', content: 'quokkaword salary bands', access: 'private' },
  })).id;
  comment = (await ok(`/api/workspaces/${workspace}/comments`, {
    cookie: author.cookie, body: { page_id: page, body: 'wombatword remark' },
  })).id;
  open = (await ok(`/api/workspaces/${workspace}/pages`, {
    cookie: author.cookie, body: { title: 'Open notes', content: 'everybody reads this' },
  })).id;
  await ok(`/api/workspaces/${workspace}/comments`, { cookie: author.cookie, body: { page_id: open, body: 'open remark' } });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a comment on a private page', () => {
  it('is read by the page\'s author', async () => {
    assert.equal((await call(`/api/comments/${comment}`, { cookie: author.cookie })).status, 200);
  });

  it('is refused to another member, read one at a time', async () => {
    assert.equal((await call(`/api/pages/${page}`, { cookie: colleague.cookie })).status, 403);
    assert.equal((await call(`/api/comments/${comment}`, { cookie: colleague.cookie })).status, 403);
  });

  it('is left out of their listing, while a comment on an open page stays in it', async () => {
    const listed = await ok(`/api/workspaces/${workspace}/comments?limit=500`, { cookie: colleague.cookie });
    const bodies = (listed.items ?? listed).map((row: { body: string }) => row.body);
    assert.ok(!bodies.includes('wombatword remark'), 'the listing carried a private page\'s comment');
    assert.ok(bodies.includes('open remark'));
  });

  it('cannot be changed or deleted by them', async () => {
    assert.equal((await call(`/api/comments/${comment}`, { cookie: colleague.cookie, method: 'PATCH', body: { reactions: { '👍': [colleague.id] } } })).status, 403);
    assert.equal((await call(`/api/comments/${comment}`, { cookie: colleague.cookie, method: 'DELETE' })).status, 403);
  });

  it('cannot be added to the page by them', async () => {
    assert.equal((await call(`/api/workspaces/${workspace}/comments`, {
      cookie: colleague.cookie, body: { page_id: page, body: 'planted' },
    })).status, 403);
    assert.equal((await call(`/api/workspaces/${workspace}/comments`, {
      cookie: colleague.cookie, body: { page_id: open, body: 'fine here' },
    })).status, 200, 'a comment on a page everybody reads is still allowed');
  });
});

describe('search', () => {
  // The results only: the answer repeats the query, which is not a leak.
  const found = async (person: Person, words: string) =>
    JSON.stringify((await ok(`/api/workspaces/${workspace}/search?q=${encodeURIComponent(words)}`, { cookie: person.cookie })).results);

  it('finds a private page and its comments for their author', async () => {
    assert.match(await found(author, 'quokkaword'), /Zebrafinch/);
    assert.match(await found(author, 'wombatword'), /wombatword/);
  });

  it('finds neither for anybody else', async () => {
    assert.doesNotMatch(await found(colleague, 'quokkaword'), /Zebrafinch|quokkaword/);
    assert.doesNotMatch(await found(colleague, 'wombatword'), /wombatword/);
  });

  it('still finds an open page for everybody', async () => {
    assert.match(await found(colleague, 'everybody'), /Open notes/);
  });
});

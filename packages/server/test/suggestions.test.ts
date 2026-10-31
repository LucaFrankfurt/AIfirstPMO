/**
 * Suggesting a change instead of making it, and settling a comment.
 *
 * A suggestion is a comment that carries what its passage should say instead.
 * Accepting it is the interesting half: the server writes the replacement into
 * the page — or the board — against the text as it stands *then*, found again
 * by its quote, and refuses if that passage has changed since. So these ask
 * what a reviewer would: does accepting change exactly those words and nothing
 * else, does a stale one refuse rather than land on the wrong sentence, and is
 * "who accepted it" the server's record rather than the client's claim.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-suggestions-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Clock, makeAnchor } from '@kolibri/shared';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
const clock = new Clock('suggestions-test');
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
let reviewer: Person;
let workspace = '';

/** A page with `content`, and a suggestion on `quote` in it from the reviewer. */
async function suggested(content: string, quote: string, replacement: string, format = 'markdown') {
  const page = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: `Page ${Math.random()}`, content, format } });
  const start = content.indexOf(quote);
  const anchor = makeAnchor(content, start, start + quote.length);
  const comment = await ok(`/api/workspaces/${workspace}/comments`, {
    cookie: reviewer.cookie, body: { page_id: page.id, body: 'better?', anchor, suggestion: replacement },
  });
  return { page: page.id as string, comment: comment.id as string };
}

const settle = (who: Person, comment: string, resolution: string | null, extra: Record<string, unknown> = {}) =>
  call(`/api/comments/${comment}`, { cookie: who.cookie, method: 'PATCH', body: { resolution, ...extra } });

const contentOf = async (page: string) => (await ok(`/api/pages/${page}`, { cookie: author.cookie })).content as string;

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const register = async (email: string): Promise<Person> => {
    resetRateLimits();
    const result = await call('/api/auth/register', { body: { email, name: email.split('@')[0], password: 'correct horse battery' } });
    return { cookie: result.setCookie!.split(';')[0], id: result.body.user.id };
  };
  author = await register('suggest-author@example.com');
  workspace = (await ok('/api/session', { cookie: author.cookie })).workspaces[0].id;
  const invite = await ok(`/api/workspaces/${workspace}/invites`, { cookie: author.cookie, body: { role: 'member' } });
  reviewer = await register('suggest-reviewer@example.com');
  await ok(`/api/invites/${invite.code}/accept`, { cookie: reviewer.cookie, body: {} });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('accepting a suggestion', () => {
  it('writes exactly the replacement, and records who accepted it', async () => {
    const { page, comment } = await suggested('We ship on Friday. Ask Grace if unsure.', 'Friday', 'Monday');
    const settled = await settle(author, comment, 'accepted', { resolved_by: reviewer.id, resolved_at: 1 });
    assert.equal(settled.status, 200);
    assert.equal(await contentOf(page), 'We ship on Monday. Ask Grace if unsure.');
    assert.equal(settled.body.resolution, 'accepted');
    assert.equal(settled.body.resolved_by, author.id, 'who accepted it was taken from the client');
    assert.ok(settled.body.resolved_at > 1_000_000, 'when it was accepted was taken from the client');
  });

  it('keeps the words it replaced in the page history', async () => {
    const { page, comment } = await suggested('Budget is 40k.', '40k', '45k');
    await settle(author, comment, 'accepted');
    const versions = await ok(`/api/pages/${page}/versions`, { cookie: author.cookie });
    const old = await ok(`/api/pages/${page}/versions/${versions[0].id}`, { cookie: author.cookie });
    assert.equal(old.content, 'Budget is 40k.');
  });

  it('refuses when the passage has changed since, and leaves the comment open', async () => {
    const { page, comment } = await suggested('Ask Grace about the launch.', 'Grace', 'Ada');
    await ok(`/api/pages/${page}`, { cookie: author.cookie, method: 'PATCH', body: { content: 'Ask Lin about the launch.' } });
    const settled = await settle(author, comment, 'accepted');
    assert.equal(settled.status, 400);
    assert.equal(await contentOf(page), 'Ask Lin about the launch.');
    assert.equal((await ok(`/api/comments/${comment}`, { cookie: author.cookie })).resolution, null);
  });

  it('is refused the same way when it arrives from a device', async () => {
    const { page, comment } = await suggested('Ship it on Tuesday.', 'Tuesday', 'Thursday');
    await ok(`/api/pages/${page}`, { cookie: author.cookie, method: 'PATCH', body: { content: 'Ship it next week.' } });
    const pushed = await ok('/api/sync/push', {
      cookie: author.cookie,
      body: {
        workspaceId: workspace, clientId: 'author-phone',
        mutations: [{ id: crypto.randomUUID(), entity: 'comment', entityId: comment, op: 'upsert', patch: { resolution: 'accepted' }, hlc: clock.now() }],
      },
    });
    assert.equal(pushed.rejected.length, 1);
    assert.equal(await contentOf(page), 'Ship it next week.');
  });

  it('escapes the replacement on an HTML page — it is words, not markup', async () => {
    const { page, comment } = await suggested('<p>Use the old logo.</p>', 'old logo', '<b>new</b> logo', 'html');
    await settle(author, comment, 'accepted');
    assert.equal(await contentOf(page), '<p>Use the &lt;b&gt;new&lt;/b&gt; logo.</p>');
  });

  it('is final: reopening an accepted suggestion keeps it accepted', async () => {
    const { comment } = await suggested('Owner: Ada.', 'Ada', 'Lin');
    await settle(author, comment, 'accepted');
    const again = await settle(author, comment, null);
    assert.equal(again.body.resolution, 'accepted');
  });
});

describe('rejecting and resolving', () => {
  it('rejecting changes no text', async () => {
    const { page, comment } = await suggested('Price is 10 euros.', '10', '12');
    const settled = await settle(author, comment, 'rejected');
    assert.equal(settled.body.resolution, 'rejected');
    assert.equal(await contentOf(page), 'Price is 10 euros.');
  });

  it('an ordinary comment told it was accepted is resolved', async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: 'Plain', content: 'x' } });
    const comment = await ok(`/api/workspaces/${workspace}/comments`, { cookie: author.cookie, body: { page_id: page.id, body: 'done?' } });
    assert.equal((await settle(reviewer, comment.id, 'accepted')).body.resolution, 'resolved');
    // And reopened, which an ordinary comment may be.
    const reopened = await settle(reviewer, comment.id, null);
    assert.equal(reopened.body.resolution, null);
    assert.equal(reopened.body.resolved_by, null);
  });

  it('lets anybody who can read a comment settle it, and still only its author reword it', async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: 'Mine', content: 'x' } });
    const comment = await ok(`/api/workspaces/${workspace}/comments`, { cookie: author.cookie, body: { page_id: page.id, body: 'check this' } });
    assert.equal((await settle(reviewer, comment.id, 'resolved')).status, 200);
    assert.equal((await call(`/api/comments/${comment.id}`, { cookie: reviewer.cookie, method: 'PATCH', body: { body: 'reworded' } })).status, 403);
  });

  it('stores a suggestion with no passage as the ordinary comment it is', async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: 'Whole', content: 'x' } });
    const comment = await ok(`/api/workspaces/${workspace}/comments`, {
      cookie: reviewer.cookie, body: { page_id: page.id, body: 'rewrite all of it', suggestion: 'y' },
    });
    assert.equal(comment.suggestion, null);
  });
});

describe('a suggestion on a board', () => {
  it('replaces the passage in the board\'s HTML, escaped', async () => {
    const canvas = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: 'Canvas', format: 'canvas' } });
    const html = '<!doctype html><html><body><h1>Q3 pipeline</h1></body></html>';
    const board = await ok(`/api/workspaces/${workspace}/artboards`, { cookie: author.cookie, body: { page_id: canvas.id, title: 'B', content: html } });
    const start = html.indexOf('Q3 pipeline');
    const passage = makeAnchor(html, start, start + 'Q3 pipeline'.length)!;
    const comment = await ok(`/api/workspaces/${workspace}/comments`, {
      cookie: reviewer.cookie,
      body: { page_id: canvas.id, body: '', anchor: { board: board.id, x: 10, y: 10, ...passage }, suggestion: 'Q4 pipeline & forecast' },
    });
    await settle(author, comment.id, 'accepted');
    const after = await ok(`/api/artboards/${board.id}`, { cookie: author.cookie });
    assert.equal(after.content, '<!doctype html><html><body><h1>Q4 pipeline &amp; forecast</h1></body></html>');
  });
});

describe('suggestions carried in a project export', () => {
  it('import with their status, and an accepted one is not applied a second time', async () => {
    const project = await ok(`/api/workspaces/${workspace}/projects`, { cookie: author.cookie, body: { name: 'Docs', key: 'DOC' } });
    const content = 'Release on Friday, notes by Ada.';
    const page = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: 'Release', content, project_id: project.id } });
    const make = async (quote: string, replacement: string) => {
      const text = await contentOf(page.id);
      const start = text.indexOf(quote);
      return (await ok(`/api/workspaces/${workspace}/comments`, {
        cookie: reviewer.cookie,
        body: { page_id: page.id, body: '', anchor: makeAnchor(text, start, start + quote.length), suggestion: replacement },
      })).id as string;
    };
    const accepted = await make('Friday', 'Monday');
    await make('Ada', 'Lin');
    await settle(author, accepted, 'accepted');

    const document = await ok(`/api/workspaces/${workspace}/projects/${project.id}/export`, { cookie: author.cookie });
    const imported = await call(`/api/workspaces/${workspace}/import/json`, {
      cookie: author.cookie, body: { document, name: 'Docs copy', key: 'DOC2' },
    });
    assert.equal(imported.status, 200, `the import was refused: ${imported.body?.message}`);
    const pages = await ok(`/api/workspaces/${workspace}/pages?limit=500`, { cookie: author.cookie });
    const copy = (pages.items ?? pages).find((one: { project_id: string }) => one.project_id === imported.body.project.id);
    assert.equal(copy.content, 'Release on Monday, notes by Ada.');
    const comments = await ok(`/api/workspaces/${workspace}/comments?limit=500`, { cookie: author.cookie });
    const statuses = (comments.items ?? comments).filter((one: { page_id: string }) => one.page_id === copy.id)
      .map((one: { resolution: string | null }) => one.resolution).sort();
    assert.deepEqual(statuses, ['accepted', null].sort());
  });

  it('a comment cannot arrive already accepted', async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, { cookie: author.cookie, body: { title: 'Arrive', content: 'Say hello.' } });
    const anchor = makeAnchor('Say hello.', 4, 9);
    const comment = await ok(`/api/workspaces/${workspace}/comments`, {
      cookie: reviewer.cookie, body: { page_id: page.id, body: '', anchor, suggestion: 'goodbye', resolution: 'accepted' },
    });
    assert.equal(comment.resolution, null);
    assert.equal(await contentOf(page.id), 'Say hello.');
  });
});

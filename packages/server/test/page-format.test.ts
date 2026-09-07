/**
 * A page that is HTML, all the way through the server.
 *
 * `sanitizeHtml` has its own tests and they are about markup. These are about
 * the three places the *column* changes what the server does, each of which
 * passed the typechecker while being wrong at some point in writing this:
 *
 * - The write path folds an unknown format to markdown rather than refusing the
 *   write. A page nobody can save because a client three versions old sent
 *   `format: "Markdown"` is a worse failure than a page that renders its own
 *   tags.
 * - The search index stores what an HTML page *says*. Left raw, the index
 *   learns every tag name in the document, and a workspace with one imported
 *   page starts answering searches for `div`.
 * - A shared link renders the same allowlist the app renders. The reader there
 *   is a stranger holding a URL, which is the one audience that cannot be
 *   assumed to be a colleague.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-page-format-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';

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

const makePage = (page: Record<string, unknown>) => ok(`/api/workspaces/${workspaceId}/pages`, { title: 'Doc', ...page });
const rowOf = (id: string) => get<any>(`SELECT * FROM pages WHERE id = ?`, id);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the format column', () => {
  it('is markdown unless the writer says otherwise', async () => {
    const page = await makePage({ content: '# Hello' });
    assert.equal(rowOf(page.id).format, 'markdown');
  });

  it('takes html', async () => {
    const page = await makePage({ content: '<p>Hello</p>', format: 'html' });
    assert.equal(rowOf(page.id).format, 'html');
  });

  it('folds anything else to markdown rather than refusing the write', async () => {
    const page = await makePage({ content: 'x', format: 'HTML5' });
    assert.equal(rowOf(page.id).format, 'markdown');
  });

  it('stores the markup exactly as it was sent', async () => {
    // Sanitising is a render-time rule on every path, not a write-time rewrite.
    // Cleaning here would put `content` and the CRDT permanently out of step,
    // and would eat the tag somebody is halfway through typing.
    const messy = '<div class="lead" onclick="x()"><p>Hello';
    const page = await makePage({ content: messy, format: 'html' });
    assert.equal(rowOf(page.id).content, messy);
  });

  it('keeps the CRDT saying what the text says, HTML or not', async () => {
    const page = await makePage({ content: '<p>one</p>', format: 'html' });
    await ok(`/api/pages/${page.id}`, { content: '<p>two</p>' }, 'PATCH');
    const row = rowOf(page.id);
    assert.equal(row.content, '<p>two</p>');
    assert.ok(row.body, 'and it has one');
  });
});

describe('search', () => {
  it('indexes what an HTML page says, not what it is made of', async () => {
    const page = await makePage({
      title: 'Onboarding',
      content: '<div class="wrapper"><p>Willkommen im <strong>Team</strong></p></div>',
      format: 'html',
    });
    const indexed = get<any>(`SELECT body FROM search_index WHERE kind = 'page' AND ref_id = ?`, page.id);
    assert.match(String(indexed.body), /Willkommen im Team/);
    assert.doesNotMatch(String(indexed.body), /wrapper|strong|div/);
  });

  it('finds an HTML page by a word in it', async () => {
    await makePage({ title: 'Runbook', content: '<h2>Deployment</h2><p>Zuerst kolibrieren.</p>', format: 'html' });
    const hits = await ok(`/api/workspaces/${workspaceId}/search?q=kolibrieren`);
    assert.ok((hits.results ?? hits).length > 0, 'the page is findable by its own words');
  });
});

describe('a shared HTML page', () => {
  it('is rendered through the same allowlist the app renders', async () => {
    const page = await makePage({
      title: 'Public',
      content: '<p>Safe</p><script>alert(1)</script><a href="javascript:alert(2)">click</a>',
      format: 'html',
    });
    const share = await ok(`/api/workspaces/${workspaceId}/shares`, { kind: 'page', page_id: page.id });
    const html = await (await fetch(`${base}/s/${share.token}`)).text();
    assert.match(html, /<p>Safe<\/p>/);
    assert.doesNotMatch(html, /alert\(1\)/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, />click</, 'and the words of the refused link survive');
  });

  it('does not bolt a second title onto a page that opens with its own', async () => {
    const page = await makePage({ title: 'Spec', content: '<h1>Spec</h1><p>Body</p>', format: 'html' });
    const share = await ok(`/api/workspaces/${workspaceId}/shares`, { kind: 'page', page_id: page.id });
    const html = await (await fetch(`${base}/s/${share.token}`)).text();
    assert.equal((html.match(/>Spec</g) ?? []).length, 1, 'the heading appears once');
  });
});

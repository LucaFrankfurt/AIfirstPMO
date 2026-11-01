/**
 * A board on its own: a page of format `board`, which holds one board.
 *
 * The board is an ordinary row in `artboards`, so everything a board already
 * was — private with its page, merged as text, kept in history — it stays, and
 * `artboards.test.ts` asks those doors. What is new is pinned here:
 *
 * - the format survives a write, where an unknown one is folded to markdown;
 * - one board, never two and never a note — refused when it is put there, and
 *   when a canvas holding more is turned into a board page;
 * - one title: renaming the page renames its board, so a search hit and
 *   `get_artboard` say what the page says;
 * - over MCP, `create_page` with `format: "board"` makes the page and its board
 *   in one call, and `add_artboard` explains itself instead of adding a second.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-board-pages-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
const cookies: Record<string, string> = {};

async function send(who: string, path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  else if (cookies[who]) headers.cookie = cookies[who];
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const set = response.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function api<T = any>(who: string, path: string, options: Parameters<typeof send>[2] = {}): Promise<T> {
  const result = await send(who, path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

let rpc = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await api('rpc', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } } });
  if (response.error) throw new Error(`refused: ${response.error.message}`);
  if (response.result?.isError) throw new Error(`refused: ${JSON.stringify(response.result.content)}`);
  return response.result.structuredContent;
}

const ONE_PAGER = `<!doctype html>
<html><head><title>Q4 one-pager</title></head>
<body style="margin: 0; font: 15px system-ui">
  <h1 style="color: #14161c">Pipeline, Q4</h1>
  <p>Weighted: <strong>€155k</strong></p>
</body></html>`;

let workspace = '';
let ada = '';
let lin = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const registered = await api('ada', '/api/auth/register', {
    body: { email: 'ada@boardpage.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspace = registered.workspaces[0].id;
  ada = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId: workspace } })).token;
  const invite = await api('ada', `/api/workspaces/${workspace}/invites`, { body: { role: 'member' } });
  resetRateLimits();
  await api('lin', '/api/auth/register', { body: { email: 'lin@boardpage.test', name: 'Lin', password: 'another fine password' } });
  await api('lin', `/api/invites/${invite.code}/accept`, { body: {} });
  lin = (await api('lin', '/api/tokens', { body: { name: 'lin', workspaceId: workspace } })).token;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const newPage = (body: Record<string, unknown>) => api('ada', `/api/workspaces/${workspace}/pages`, { body });
const newBoard = (body: Record<string, unknown>) => send('ada', `/api/workspaces/${workspace}/artboards`, { body });

describe('a board page on the write path', () => {
  it('keeps its format', async () => {
    const page = await newPage({ title: 'One-pager', format: 'board' });
    assert.equal(page.format, 'board');
    assert.equal((await api('ada', `/api/pages/${page.id}`)).format, 'board');
  });

  it('holds one board — not a second, and not a note', async () => {
    const page = await newPage({ title: 'Only one', format: 'board' });
    const first = await newBoard({ page_id: page.id, title: 'Only one', content: ONE_PAGER });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await newBoard({ page_id: page.id, title: 'Another', content: '<p>no</p>' });
    assert.equal(second.status, 400, 'a second board went onto a board page');
    const note = await newBoard({ page_id: page.id, kind: 'note', content: 'no' });
    assert.equal(note.status, 400, 'a note went onto a board page');

    // A deleted board is not in the way: the page can start over.
    await api('ada', `/api/artboards/${first.body.id}`, { method: 'DELETE' });
    assert.equal((await newBoard({ page_id: page.id, title: 'Again', content: ONE_PAGER })).status, 200);
  });

  it('is what a canvas becomes only while it has one board', async () => {
    const canvas = await newPage({ title: 'Was a canvas', format: 'canvas' });
    const keep = await newBoard({ page_id: canvas.id, title: 'Keep', content: ONE_PAGER });
    const drop = await newBoard({ page_id: canvas.id, title: 'Drop', content: '<p>later</p>' });
    const refused = await send('ada', `/api/pages/${canvas.id}`, { method: 'PATCH', body: { format: 'board' } });
    assert.equal(refused.status, 400, 'a canvas of two boards became a board page');
    assert.equal((await api('ada', `/api/pages/${canvas.id}`)).format, 'canvas');

    await api('ada', `/api/artboards/${drop.body.id}`, { method: 'DELETE' });
    await api('ada', `/api/pages/${canvas.id}`, { method: 'PATCH', body: { format: 'board' } });
    assert.equal((await api('ada', `/api/pages/${canvas.id}`)).format, 'board');
    // And the board it kept is named after the page it now is.
    assert.equal((await api('ada', `/api/artboards/${keep.body.id}`)).title, 'Was a canvas');

    // Back again: a board page is a canvas with one board, and can be one.
    await api('ada', `/api/pages/${canvas.id}`, { method: 'PATCH', body: { format: 'canvas' } });
    assert.equal((await newBoard({ page_id: canvas.id, title: 'Beside it', content: '<p>more</p>' })).status, 200);
  });

  it('has one title, which its board carries', async () => {
    const page = await newPage({ title: 'Draft name', format: 'board' });
    const board = await newBoard({ page_id: page.id, title: 'Draft name', content: ONE_PAGER });
    await api('ada', `/api/pages/${page.id}`, { method: 'PATCH', body: { title: 'Final name' } });
    assert.equal((await api('ada', `/api/artboards/${board.body.id}`)).title, 'Final name');
  });

  it('is private with its page, board and all', async () => {
    const page = await newPage({ title: 'Mine alone', format: 'board', access: 'private' });
    const board = await newBoard({ page_id: page.id, title: 'Mine alone', content: ONE_PAGER });
    assert.equal((await send('lin', `/api/artboards/${board.body.id}`, { token: lin })).status, 403);
    await assert.rejects(tool(lin, 'get_artboard', { artboard: board.body.id }));
  });
});

describe('a board page over MCP', () => {
  it('is made in one call, its HTML as its content', async () => {
    const made = await tool(ada, 'create_page', { title: 'Q4 one-pager', format: 'board', content: ONE_PAGER, w: 1100 });
    assert.equal(made.format, 'board');
    assert.equal(made.content, '', 'the HTML went into the page text instead of the board');
    assert.equal(made.artboard.w, 1100);
    assert.equal(made.icon, '🖼️');

    const read = await tool(ada, 'get_artboard', { artboard: made.artboard.id });
    assert.equal(read.content, ONE_PAGER);
    const page = await tool(ada, 'get_page', { page: made.id });
    assert.deepEqual(page.artboards.map((board: any) => board.id), [made.artboard.id]);
  });

  it('refuses a second board, and says what to do instead', async () => {
    const made = await tool(ada, 'create_page', { title: 'No room', format: 'board', content: ONE_PAGER });
    await assert.rejects(
      tool(ada, 'add_artboard', { page: made.id, html: '<p>more</p>' }),
      /board page.*update_artboard/,
    );
  });
});

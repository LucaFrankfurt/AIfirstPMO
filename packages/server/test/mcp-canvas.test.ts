/**
 * A canvas, built and discussed over MCP.
 *
 * The point of a canvas in an AI-first workspace is that the assistant which
 * wrote a board is not the only one who can change it afterwards — and that the
 * people who changed it can say so to the assistant in a comment. So the tools
 * are asked here end to end, as a token holder would: make a canvas, put a
 * board on it, read it back whole, rewrite it, pin a comment to it and read the
 * discussion.
 *
 * And the other half, which every door to a page has had to be taught at least
 * once: a token acts as the person it belongs to, so a colleague's token sees
 * none of a private canvas — not its boards, not their HTML, not its comments —
 * and cannot write onto it.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mcp-canvas-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
const cookies: Record<string, string> = {};

async function api<T = any>(who: string, path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
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
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

let rpc = 0;
async function call(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const response = await api('rpc', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpc, method, params } });
  if (response.error) throw new Error(`refused: ${response.error.message}`);
  if (response.result?.isError) throw new Error(`refused: ${JSON.stringify(response.result.content)}`);
  return response.result;
}

const tool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  call(token, 'tools/call', { name, arguments: args }).then((r) => r.structuredContent);

const BOARD = `<!doctype html>
<html><head><style>body { font: 15px system-ui; }</style></head>
<body>
  <h1 style="color: #14161c">Cold calling</h1>
  <p>Calls this week: <strong>42</strong></p>
  <script>document.title = 'Cold calling';</script>
</body></html>`;

let ada = '';
let lin = '';
let workspaceId = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const registered = await api('ada', '/api/auth/register', {
    body: { email: 'ada@canvas.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspaceId = registered.workspaces[0].id;
  ada = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId } })).token;
  const invite = await api('ada', `/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
  resetRateLimits();
  await api('lin', '/api/auth/register', { body: { email: 'lin@canvas.test', name: 'Lin', password: 'another fine password' } });
  await api('lin', `/api/invites/${invite.code}/accept`, { body: {} });
  lin = (await api('lin', '/api/tokens', { body: { name: 'lin', workspaceId } })).token;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a canvas built over MCP', () => {
  let page = '';
  let board = '';

  it('starts as a page in the canvas format', async () => {
    const made = await tool(ada, 'create_page', { title: 'SetSide CRM', format: 'canvas' });
    page = made.id;
    assert.equal(made.format, 'canvas');
    assert.equal(made.icon, '🎨');
  });

  it('takes a board, and lists it without its HTML', async () => {
    const added = await tool(ada, 'add_artboard', { page, title: 'Cold calling', html: BOARD, w: 1280, h: 800 });
    board = added.id;
    assert.equal(added.kind, 'html');
    assert.match(added.text, /Cold calling Calls this week: 42/);

    const second = await tool(ada, 'add_artboard', { page, title: 'Pipeline', html: '<p>Pipeline</p>' });
    assert.equal(second.x, 1280 + 80, 'a board with no position goes to the right of the others');

    const read = await tool(ada, 'get_page', { page });
    assert.deepEqual(read.artboards.map((one: { title: string }) => one.title), ['Cold calling', 'Pipeline']);
    assert.equal(JSON.stringify(read.artboards).includes('<h1'), false, 'the listing carried the HTML');
  });

  it('hands one board back whole', async () => {
    const read = await tool(ada, 'get_artboard', { artboard: board });
    assert.equal(read.content, BOARD);
    assert.equal(read.body, undefined, 'the CRDT is the editor\'s business, not the assistant\'s');
  });

  it('refuses a board on a page that is not a canvas', async () => {
    const text = await tool(ada, 'create_page', { title: 'Plain notes' });
    await assert.rejects(() => tool(ada, 'add_artboard', { page: text.id, html: '<p>x</p>' }), /not a canvas/);
  });

  it('rewrites and moves a board', async () => {
    const next = BOARD.replace('42', '57');
    const changed = await tool(ada, 'update_artboard', { artboard: board, html: next, x: 120, w: 1440 });
    assert.equal(changed.x, 120);
    assert.equal(changed.w, 1440);
    assert.equal((await tool(ada, 'get_artboard', { artboard: board })).content, next);
  });

  it('pins a comment to a board and reads the discussion back', async () => {
    await tool(ada, 'comment_page', { page, body: 'Is 57 calls right?', artboard: board, x: 300, y: 40 });
    await tool(ada, 'comment_page', { page, body: 'Looks good overall.' });
    // A list comes back wrapped: `structuredContent` has to be an object.
    const thread = (await tool(ada, 'list_page_comments', { page })).result;
    assert.equal(thread.length, 2);
    assert.deepEqual(thread[0].pinned_to, { artboard: board, title: 'Cold calling', x: 300, y: 40 });
    assert.equal(thread[1].pinned_to, undefined);
  });

  it('will not pin a comment to a board on another page', async () => {
    const other = await tool(ada, 'create_page', { title: 'Other canvas', format: 'canvas' });
    await assert.rejects(() => tool(ada, 'comment_page', { page: other.id, body: 'x', artboard: board }), /another page/);
  });

  it('keeps all of it from a colleague once the canvas is private', async () => {
    await api('ada', `/api/pages/${page}`, { method: 'PATCH', body: { access: 'private' } });
    await assert.rejects(() => tool(lin, 'get_artboard', { artboard: board }));
    await assert.rejects(() => tool(lin, 'update_artboard', { artboard: board, html: '<p>mine</p>' }));
    await assert.rejects(() => tool(lin, 'add_artboard', { page, html: '<p>planted</p>' }));
    await assert.rejects(() => tool(lin, 'comment_page', { page, body: 'hello' }));
    await assert.rejects(() => tool(lin, 'list_page_comments', { page }));
    await assert.rejects(() => tool(lin, 'delete_artboard', { artboard: board }));
    assert.match((await tool(ada, 'get_artboard', { artboard: board })).content, /57/, 'a refused write changed the board');
  });

  it('deletes a board', async () => {
    await tool(ada, 'delete_artboard', { artboard: board });
    const read = await tool(ada, 'get_page', { page });
    assert.deepEqual(read.artboards.map((one: { title: string }) => one.title), ['Pipeline']);
  });
});

describe('suggestions over MCP', () => {
  let page = '';

  it('proposes a change rather than making it', async () => {
    page = (await tool(ada, 'create_page', { title: 'Launch plan', content: 'We launch on Friday. Friday is final.' })).id;
    await assert.rejects(() => tool(ada, 'suggest_page_edit', { page, quote: 'Friday', replacement: 'Monday' }), /more than once/);
    await assert.rejects(() => tool(ada, 'suggest_page_edit', { page, quote: 'Saturday', replacement: 'Monday' }), /not in it/);
    const made = await tool(ada, 'suggest_page_edit', { page, quote: 'launch on Friday', replacement: 'launch on Monday', body: 'Legal needs the weekend' });
    assert.equal(made.status, 'open');
    assert.equal((await tool(ada, 'get_page', { page })).content, 'We launch on Friday. Friday is final.', 'a suggestion changed the page');
    const thread = (await tool(ada, 'list_page_comments', { page })).result;
    assert.equal(thread[0].suggests, 'launch on Monday');
    assert.equal(thread[0].about, 'launch on Friday');
  });

  it('writes it in when accepted', async () => {
    const thread = (await tool(ada, 'list_page_comments', { page })).result;
    const settled = await tool(ada, 'resolve_comment', { comment: thread[0].id, status: 'accepted' });
    assert.equal(settled.status, 'accepted');
    assert.equal((await tool(ada, 'get_page', { page })).content, 'We launch on Monday. Friday is final.');
  });

  it('cannot settle a comment the caller cannot see', async () => {
    const hidden = (await tool(ada, 'create_page', { title: 'Hidden', content: 'secret words here' })).id;
    await api('ada', `/api/pages/${hidden}`, { method: 'PATCH', body: { access: 'private' } });
    const made = await tool(ada, 'suggest_page_edit', { page: hidden, quote: 'secret', replacement: 'open' });
    await assert.rejects(() => tool(lin, 'resolve_comment', { comment: made.id, status: 'accepted' }), /not found/);
    await assert.rejects(() => tool(lin, 'suggest_page_edit', { page: hidden, quote: 'words', replacement: 'x' }));
  });
});

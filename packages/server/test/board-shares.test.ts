/**
 * A canvas or a board page, out of the workspace: a share link, and a template.
 *
 * **A share link.** The shared document is one server-rendered page with no
 * script in it, and a board is a page full of script, so the document frames
 * each board and each board is served on its own under the board frame's
 * sandbox. What is pinned here is what a stranger holding the token reaches:
 *
 * - the document frames the boards of the shared page — in reading order, a
 *   canvas's notes as text — and never their source;
 * - each board is served sandboxed, framed only by this origin, and only while
 *   the link is live and only if the board is on the shared page or a page it
 *   brings;
 * - a picture is inlined when it hangs on the board's own page, and a file from
 *   anywhere else in the workspace is not published by naming it in a board.
 *
 * **A template.** A canvas or a board page is its boards, so a page made from
 * one over MCP gets copies of them — in the template's format, with the new
 * page's title on a board page's board.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-board-shares-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
let cookie = '';
let token = '';
let workspace = '';

async function send(path: string, options: { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; anonymous?: boolean } = {}) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!options.anonymous && cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined || options.raw ? 'POST' : 'GET'),
    headers,
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const set = response.headers.get('set-cookie');
  if (set && !options.anonymous) cookie = set.split(';')[0];
  return response;
}

async function api<T = any>(path: string, options: Parameters<typeof send>[1] = {}): Promise<T> {
  const response = await send(path, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

let rpc = 0;
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.json() as any;
  if (body.error || body.result?.isError) throw new Error(`refused: ${JSON.stringify(body.error ?? body.result.content)}`);
  return body.result.structuredContent;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAABirU3bAAAAG0lEQVR4nGP8//8/AzGAiShVowZTx2AKAAAA//8DAAKrAsfKF8p1AAAAAElFTkSuQmCC',
  'base64',
);
/** Another picture: files are stored by their bytes, so the same bytes twice would be one file. */
const OTHER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const upload = (query: string, name: string, bytes = PNG) => api(`/api/workspaces/${workspace}/files?${query}`, {
  raw: bytes, headers: { 'content-type': 'image/png', 'x-filename': name },
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const registered = await api('/api/auth/register', {
    body: { email: 'ada@boardshare.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspace = registered.workspaces[0].id;
  token = (await api('/api/tokens', { body: { name: 'ada', workspaceId: workspace } })).token;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const newPage = (body: Record<string, unknown>) => api(`/api/workspaces/${workspace}/pages`, { body });
const newBoard = (body: Record<string, unknown>) => api(`/api/workspaces/${workspace}/artboards`, { body });
const share = (pageId: string) => api(`/api/workspaces/${workspace}/shares`, { body: { kind: 'page', page_id: pageId } });
const open = (path: string) => send(path, { anonymous: true });

describe('a shared board page', () => {
  let link = '';
  let board = '';
  let picture = '';
  let elsewhere = '';
  let pageId = '';

  before(async () => {
    const page = await newPage({ title: 'Q3 one-pager', format: 'board' });
    pageId = page.id;
    picture = (await upload(`page_id=${page.id}`, 'chart.png')).url;
    const other = await newPage({ title: 'Someone else\'s page' });
    elsewhere = (await upload(`page_id=${other.id}`, 'private.png', OTHER_PNG)).url;
    board = (await newBoard({
      page_id: page.id, title: 'Q3 one-pager', w: 1080, h: 720,
      content: `<!doctype html><html><head><title>Q3</title></head><body><h1>Q3 in one page</h1>`
        + `<img src="${picture}" alt="chart"><img src="${elsewhere}" alt="not this one">`
        + `<a href="https://example.com/report">report</a><script>document.title = 'ran';</script></body></html>`,
    })).id;
    link = (await share(page.id)).token;
  });

  it('frames its board in the shared document, and never puts the source there', async () => {
    const response = await open(`/s/${link}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, new RegExp(`<iframe src="/s/${link}/boards/${board}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`));
    assert.match(body, /class="board single"/);
    assert.doesNotMatch(body, /Q3 in one page/, 'the board\'s HTML was written into the share document');
    assert.doesNotMatch(body, /<script/, 'the share document grew a script');
  });

  it('serves the board on its own, sandboxed, with the scripts it came with', async () => {
    const response = await open(`/s/${link}/boards/${board}`);
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
    assert.match(policy, /connect-src 'none'/);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.equal(response.headers.get('x-frame-options'), null, 'the app\'s DENY was left on a document that is only ever framed');
    const body = await response.text();
    assert.match(body, /<h1>Q3 in one page<\/h1>/);
    assert.match(body, /document\.title = 'ran'/);
    assert.match(body, /window\.open\(u\.href,'_blank'/, 'links would navigate the frame away from the board');
  });

  it('inlines a picture hung on its page, and no other', async () => {
    const body = await (await open(`/s/${link}/boards/${board}`)).text();
    assert.match(body, /<img src="data:image\/png;base64,iVBOR/, 'the page\'s own picture was not handed in');
    assert.ok(body.includes(`<img src="${elsewhere}"`), 'a file from another page was published by naming it');
    assert.ok(!body.includes(picture), 'the page\'s picture was left as a path a stranger cannot fetch');
  });

  it('serves nothing that is not on the shared page', async () => {
    const other = await newPage({ title: 'Not shared', format: 'board' });
    const stranger = (await newBoard({ page_id: other.id, title: 'Not shared', content: '<h1>secret</h1>' })).id;
    const response = await open(`/s/${link}/boards/${stranger}`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /secret/);
    assert.equal((await open(`/s/not-a-token/boards/${board}`)).status, 404);
  });

  it('stops serving the board when the link is turned off', async () => {
    const shareRow = (await api(`/api/workspaces/${workspace}/shares`)).find((one: any) => one.page_id === pageId);
    await api(`/api/shares/${shareRow.id}`, { method: 'DELETE' });
    assert.equal((await open(`/s/${link}/boards/${board}`)).status, 404);
  });
});

describe('a shared canvas', () => {
  it('frames its boards in reading order, with its notes as text', async () => {
    const canvas = await newPage({ title: 'Sales canvas', format: 'canvas' });
    const second = await newBoard({ page_id: canvas.id, title: 'Second', content: '<p>2</p>', x: 0, y: 900, w: 800, h: 500 });
    const first = await newBoard({ page_id: canvas.id, title: 'First', content: '<p>1</p>', x: 0, y: 0, w: 1280, h: 720 });
    await newBoard({ page_id: canvas.id, kind: 'note', content: 'Check <the> numbers', x: 1400, y: 0, w: 240, h: 180 });
    const link = (await share(canvas.id)).token;
    const body = await (await open(`/s/${link}`)).text();
    const at = (id: string) => body.indexOf(`/boards/${id}"`);
    assert.ok(at(first.id) > 0 && at(second.id) > at(first.id), 'the boards are not in reading order');
    assert.match(body, /<figcaption>First<\/figcaption>/);
    assert.match(body, /style="height: 720px"/);
    assert.match(body, /<aside class="board-note">Check &lt;the&gt; numbers<\/aside>/);
    assert.equal((await open(`/s/${link}/boards/${second.id}`)).status, 200);
  });
});

describe('a canvas or a board page as a template', () => {
  it('gives the new page copies of its boards, in its format', async () => {
    const template = await newPage({ title: 'Weekly one-pager', format: 'board' });
    await newBoard({ page_id: template.id, title: 'Weekly one-pager', content: '<h1>This week</h1>', w: 900, h: 600 });
    await api(`/api/pages/${template.id}`, { method: 'PATCH', body: { is_template: 1 } });

    const made = await tool('create_page_from_template', { template: template.id, title: 'Week 45' });
    assert.equal(made.artboards, 1);
    const page = await api(`/api/pages/${made.id}`);
    assert.equal(page.format, 'board');
    const boards = (await api(`/api/workspaces/${workspace}/artboards?limit=500`)).filter((one: any) => one.page_id === made.id);
    assert.equal(boards.length, 1);
    assert.equal(boards[0].content, '<h1>This week</h1>');
    assert.equal(boards[0].title, 'Week 45', 'the board kept the template\'s title instead of its page\'s');
    assert.equal(boards[0].w, 900);
  });

  it('copies a canvas whole, notes included, and leaves the template as it was', async () => {
    const template = await newPage({ title: 'Kick-off canvas', format: 'canvas' });
    await newBoard({ page_id: template.id, title: 'Agenda', content: '<h1>Agenda</h1>', x: 0, y: 0 });
    await newBoard({ page_id: template.id, kind: 'note', content: 'Bring numbers', x: 1400, y: 0, w: 240, h: 180 });
    await api(`/api/pages/${template.id}`, { method: 'PATCH', body: { is_template: 1 } });
    const made = await tool('create_page_from_template', { template: 'Kick-off canvas' });
    const all = await api(`/api/workspaces/${workspace}/artboards?limit=500`);
    const copied = all.filter((one: any) => one.page_id === made.id);
    assert.deepEqual(copied.map((one: any) => one.kind).sort(), ['html', 'note']);
    assert.equal(all.filter((one: any) => one.page_id === template.id).length, 2, 'the template lost its boards');
  });

  it('keeps an HTML template HTML', async () => {
    const template = await newPage({ title: 'HTML brief', format: 'html', content: '<h2>Brief</h2>' });
    await api(`/api/pages/${template.id}`, { method: 'PATCH', body: { is_template: 1 } });
    const made = await tool('create_page_from_template', { template: template.id });
    assert.equal((await api(`/api/pages/${made.id}`)).format, 'html');
  });
});

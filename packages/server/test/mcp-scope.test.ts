/**
 * What MCP may hand back, and to whom.
 *
 * Every other way into a page applies the same two-part rule: the project has
 * to be one you can see, *and* the page has to not be somebody else's private
 * one. The sync filter says it in one SQL clause, `guardPage` says it on the
 * REST route, and `guardPage`'s docblock said MCP said it too.
 *
 * MCP did not. `findPage` checked the private half and never asked about the
 * project — the only `find*` helper in `kit.ts` that did not — and the resource
 * URIs asked about neither, so `kolibri://page/<id>` read out any page in the
 * workspace by id. A token is not a second class of member: it acts as the
 * person it belongs to and must see exactly what they see.
 *
 * These are the cases, written against a real server, because the reason this
 * went unnoticed is that every one of them type-checked.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mcp-scope-${process.pid}`;

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
/** A JSON-RPC call as the holder of `token`. Throws whatever MCP refuses with. */
async function call(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const response = await api('rpc', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpc, method, params } });
  if (response.error) throw new Error(`refused: ${response.error.message}`);
  return response.result;
}

const tool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  call(token, 'tools/call', { name, arguments: args }).then((r) => r.structuredContent);

/** The upload route takes a raw body, so it does not go through `api`. */
async function upload(who: string, ws: string, query: string, bytes: Buffer, name: string, mime: string): Promise<any> {
  const response = await fetch(`${base}/api/workspaces/${ws}/files?${query}`, {
    method: 'POST',
    headers: { cookie: cookies[who], 'content-type': mime, 'x-filename': name },
    body: new Uint8Array(bytes),
  });
  return response.json();
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('what a token may read', () => {
  let workspaceId = '';
  let hidden = '';
  let personal = '';
  let hiddenTask = '';
  let personalFile = '';
  let outsider = '';

  const SECRET = 'We are paying 4.2 million';
  const PERSONAL = 'The pay review draft';
  /** A one-pixel GIF, so the bytes on the private page are a real image. */
  const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  it('is set up: Ada has a private project and a private page; Lin is in neither', async () => {
    resetRateLimits();
    const ada = await api('ada', '/api/auth/register', {
      body: { email: 'ada@scope.test', name: 'Ada', password: 'a perfectly fine password' },
    });
    workspaceId = ada.workspaces[0].id;

    const project = await api('ada', `/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Acquisition', key: 'ACQ', visibility: 'private' },
    });
    hidden = (await api('ada', `/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Deal terms', content: SECRET, project_id: project.id },
    })).id;
    hiddenTask = (await api('ada', `/api/workspaces/${workspaceId}/tasks`, {
      body: { title: 'Sign the term sheet', description: SECRET, project_id: project.id },
    })).id;
    // A private page with no project at all: the other half of the rule.
    personal = (await api('ada', `/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Pay review', content: PERSONAL, access: 'private' },
    })).id;

    // And a picture on that private page, which is the thing `get_attachment`
    // hands over — a page's file is the page's content with a download URL on it.
    const stored = await upload('ada', workspaceId, `page_id=${personal}`, Buffer.from(PIXEL), 'salaries.gif', 'image/gif');
    personalFile = stored.url;

    const invite = await api('ada', `/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    resetRateLimits();
    await api('lin', '/api/auth/register', {
      body: { email: 'lin@scope.test', name: 'Lin', password: 'another fine password' },
    });
    await api('lin', `/api/invites/${invite.code}/accept`, { body: {} });
    outsider = (await api('lin', '/api/tokens', { body: { name: 'lin', workspaceId } })).token;
  });

  it('refuses both over plain REST — the rule this is measured against', async () => {
    await assert.rejects(() => api('lin', `/api/pages/${hidden}`));
    await assert.rejects(() => api('lin', `/api/pages/${personal}`));
  });

  /* ------------------------------------------------------------- the tools */

  it('will not get_page a page in a project the caller is not in', async () => {
    await assert.rejects(() => tool(outsider, 'get_page', { page: 'Deal terms' }));
    await assert.rejects(() => tool(outsider, 'get_page', { page: hidden }));
  });

  it('will not get_page somebody else’s private page', async () => {
    await assert.rejects(() => tool(outsider, 'get_page', { page: 'Pay review' }));
  });

  it('does not list either of them', async () => {
    const listed = JSON.stringify(await tool(outsider, 'list_pages', {}));
    assert.equal(listed.includes('Deal terms'), false, 'a page from a private project was listed');
    assert.equal(listed.includes('Pay review'), false, 'somebody else’s private page was listed');
  });

  it('will not let the caller rewrite either of them', async () => {
    await assert.rejects(() => tool(outsider, 'update_page', { page: 'Deal terms', content: 'rewritten' }));
    await assert.rejects(() => tool(outsider, 'update_page', { page: 'Pay review', content: 'rewritten' }));
  });

  it('does not reveal them as backlinks or as unwritten titles', async () => {
    // `get_page` answers with the shape of the whole web around a page, and a
    // title is a disclosure however small it looks.
    const own = await api('lin', `/api/workspaces/${workspaceId}/pages`, { body: { title: 'Lin notes', content: 'See [[Deal terms]].' } });
    const seen = await tool(outsider, 'get_page', { page: own.id });
    assert.deepEqual(seen.links_to, [], 'the hidden page was named as a link target');
    assert.deepEqual(seen.linked_from, [], 'the hidden page was named as a backlink');
    // Her own sentence comes back as an unwritten title, which is right: she
    // typed those words, and the answer is about her page rather than about
    // whether a page by that name exists somewhere she cannot see.
    assert.deepEqual(seen.links_unwritten, ['Deal terms']);
  });

  /**
   * The bytes on a private page, by both of the names that reach them.
   *
   * `get_attachment` takes an attachment id *or* the `/files/…` URL an image in
   * a page renders from, and the second is the one worth a case: a URL is a
   * hash with a name on the end, and `canSeeFile` — the rule the plain HTTP
   * route applies — answers `true` for a page-bound file without looking at the
   * page at all. That gap is recorded in TODO.md and is the file route's; a tool
   * that inherited it would answer "no" to the id and "here you are" to the URL
   * for the same bytes, which is the shape of every access bug this has had.
   */
  it('will not hand over a file on somebody else’s private page, by id or by URL', async () => {
    const listed = await tool(outsider, 'list_attachments', { page: personal }).catch((err: Error) => err.message);
    assert.match(String(listed), /private|not found/i, 'the listing named a private page’s files');

    await assert.rejects(() => tool(outsider, 'get_attachment', { file: personalFile }));
    const attempt = await call(outsider, 'tools/call', { name: 'get_attachment', arguments: { file: personalFile } })
      .then(() => 'answered', (err: Error) => err.message);
    assert.notEqual(attempt, 'answered');
  });

  /* --------------------------------------------------------- the resources */

  it('does not offer them as resources', async () => {
    const listed = JSON.stringify(await call(outsider, 'resources/list', {}));
    assert.equal(listed.includes('Deal terms'), false, 'a page from a private project was offered');
    assert.equal(listed.includes('Pay review'), false, 'somebody else’s private page was offered');
  });

  it('will not read one back by its URI', async () => {
    // The one that checked nothing but workspace membership: a page id is not a
    // capability, and anybody in the workspace can guess at one they saw once.
    await assert.rejects(() => call(outsider, 'resources/read', { uri: `kolibri://page/${hidden}` }));
    await assert.rejects(() => call(outsider, 'resources/read', { uri: `kolibri://page/${personal}` }));
  });

  it('will not read a task out of a private project by its URI either', async () => {
    await assert.rejects(() => call(outsider, 'resources/read', { uri: `kolibri://task/${hiddenTask}` }));
  });

  /* ------------------------------------------------------- and Ada still can */

  it('still lets the author read her own', async () => {
    const mine = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId } })).token;
    assert.match((await tool(mine, 'get_page', { page: 'Deal terms' })).content, /4\.2 million/);
    assert.match((await tool(mine, 'get_page', { page: 'Pay review' })).content, /pay review draft/i);
    const read = await call(mine, 'resources/read', { uri: `kolibri://page/${hidden}` });
    assert.match(JSON.stringify(read), /4\.2 million/);

    // Including the picture on it, as a picture. A rule that refuses everybody
    // is not a rule.
    const file = await call(mine, 'tools/call', { name: 'get_attachment', arguments: { file: personalFile } });
    assert.equal(file.content[1].type, 'image');
    assert.equal(file.content[1].mimeType, 'image/gif');
    assert.deepEqual(Buffer.from(file.content[1].data, 'base64'), PIXEL);
  });
});

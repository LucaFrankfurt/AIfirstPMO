/**
 * Public share links.
 *
 * The token in the URL is the whole of the authorisation, so the cases that
 * matter are about what an anonymous request can and cannot reach: the shared
 * thing and nothing else, only while the link is live, and never with a token
 * the caller chose.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-share-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/db/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let pageId = '';

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

/** Anonymous: no cookie, exactly as a stranger with a link. */
const open = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Shared', key: 'SH' });
  projectId = project.id;
  const page = await ok(`/api/workspaces/${workspaceId}/pages`, {
    project_id: projectId,
    title: 'Release notes',
    content: '# Release notes\n\nWe shipped **the thing**.\n\n<script>alert(1)</script>\n',
  });
  pageId = page.id;
  await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: projectId, parent_id: pageId, title: 'Known issues', content: 'None yet.' });
  resetRateLimits();
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const makeShare = (body: Record<string, unknown>) => ok(`/api/workspaces/${workspaceId}/shares`, body);

describe('a shared page', () => {
  let token = '';

  it('mints its own token and never takes the one it was handed', async () => {
    const share = await makeShare({
      kind: 'page', page_id: pageId, project_id: projectId, name: 'Release notes', token: 'chosen-by-me',
    });
    assert.notEqual(share.token, 'chosen-by-me', 'a share whose secret the caller picked is one somebody can guess');
    assert.ok(String(share.token).length >= 30, 'and it is long enough to be worth having');
    token = share.token;
  });

  it('reads without a session, brings its children, and escapes what was written in it', async () => {
    const response = await open(`/s/${token}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store', 'an unshared document must not linger in a cache');
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);

    const body = await response.text();
    assert.match(body, /Release notes/);
    assert.match(body, /<strong>the thing<\/strong>/, 'the markdown is rendered');
    assert.match(body, /Known issues/, 'and a shared page brings its tree');
    // The body opens with `# Release notes`, so the renderer does not bolt a
    // second copy of the title on top of it.
    assert.equal((body.match(/Release notes/g) ?? []).length, 2, 'once in the tab title, once in the document');
    assert.equal(body.includes('<script>alert(1)</script>'), false, 'nothing a person typed becomes markup');
  });

  it('gives a stranger nothing else', async () => {
    // The token opens one door. Everything else still needs a session.
    for (const path of [
      `/api/workspaces/${workspaceId}/tasks`,
      `/api/pages/${pageId}`,
      `/api/workspaces/${workspaceId}/shares`,
      '/api/session',
    ]) {
      const response = await open(path);
      assert.ok(response.status === 401 || response.status === 403, `${path} answered ${response.status}`);
    }
  });

  it('stops working when it is turned off', async () => {
    const share = get<any>(`SELECT id FROM shares WHERE token = ?`, token)!;
    await ok(`/api/shares/${share.id}`, undefined, 'DELETE');
    const response = await open(`/s/${token}`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /does not exist|turned off/i, 'and says so as a page, not as JSON');
  });

  it('stops working when it expires', async () => {
    const share = await makeShare({
      kind: 'page', page_id: pageId, project_id: projectId, name: 'Old', expires_at: Date.now() - 1000,
    });
    const response = await open(`/s/${share.token}`);
    assert.equal(response.status, 410, 'gone, which is what an expired link is');
  });

  it('counts how often it is opened, and not by whom', async () => {
    const share = await makeShare({ kind: 'page', page_id: pageId, project_id: projectId, name: 'Counted' });
    await open(`/s/${share.token}`);
    await open(`/s/${share.token}`);
    const row = get<any>(`SELECT views, last_seen_at FROM shares WHERE id = ?`, share.id)!;
    assert.equal(row.views, 2);
    assert.ok(row.last_seen_at);
    // There is deliberately no column for who opened it.
    const columns = get<any>(`SELECT * FROM shares WHERE id = ?`, share.id)!;
    assert.equal('opened_by' in columns, false);
  });
});

describe('a shared task list', () => {
  it('renders the tasks a view resolves to, and can leave the finished ones out', async () => {
    const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const done = states.find((state: any) => state.group_key === 'completed');
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Still to do' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Already done', state_id: done.id });

    const withDone = await makeShare({ kind: 'tasks', project_id: projectId, name: 'Everything', include_done: 1 });
    const body = await (await open(`/s/${withDone.token}`)).text();
    assert.match(body, /Still to do/);
    assert.match(body, /Already done/);

    const openOnly = await makeShare({ kind: 'tasks', project_id: projectId, name: 'Open work', include_done: 0 });
    const shorter = await (await open(`/s/${openOnly.token}`)).text();
    assert.match(shorter, /Still to do/);
    assert.equal(shorter.includes('Already done'), false);
  });

  it('shows nothing from a project it does not point at', async () => {
    const other = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Private matters', key: 'PM' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: other.id, title: 'Not for sharing' });

    const share = await makeShare({ kind: 'tasks', project_id: projectId, name: 'Open work' });
    const body = await (await open(`/s/${share.token}`)).text();
    assert.equal(body.includes('Not for sharing'), false);
  });
});

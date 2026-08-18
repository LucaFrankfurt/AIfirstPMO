/**
 * End-to-end API test. Boots the real server against a throwaway database and
 * drives it over HTTP the same way the browser client does.
 *
 * Run with: npm test
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = process.env.KOLIBRI_TEST_DIR ?? `/tmp/kolibri-test-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Clock, orderKey, type PullResponse, type PushResponse } from '@kolibri/shared';

// Imported dynamically: static imports are hoisted above the env setup above,
// and the server reads its data directory at module load.
const { server } = await import('../src/index.ts');

let base = '';
let cookie = '';
const clock = new Clock('test');

interface Options {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  raw?: Buffer;
}

async function api<T = any>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (cookie && !options.token) headers.cookie = cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined || options.raw ? 'POST' : 'GET'),
    headers,
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('kolibri api', () => {
  let workspaceId = '';
  let projectId = '';
  let taskId = '';
  let stateIds: Record<string, string> = {};
  let apiToken = '';

  it('registers the first user and bootstraps a workspace', async () => {
    const session = await api('/api/auth/register', {
      body: { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' },
    });
    assert.equal(session.user.email, 'ada@example.com');
    assert.equal(session.workspaces.length, 1);
    assert.equal(session.workspaces[0].role, 'owner');
    workspaceId = session.workspaces[0].id;
  });

  it('rejects a bad password', async () => {
    await assert.rejects(() => api('/api/auth/login', { body: { email: 'ada@example.com', password: 'nope' } }), /401/);
  });

  it('creates a project with default states', async () => {
    const project = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Website relaunch', key: 'WEB' },
    });
    projectId = project.id;
    assert.equal(project.key, 'WEB');

    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    assert.equal(states.length, 6);
    stateIds = Object.fromEntries(states.map((s: any) => [s.name, s.id]));
    assert.ok(stateIds['In Progress']);
  });

  it('creates tasks with running identifiers', async () => {
    const first = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: projectId, title: 'Design the landing page', priority: 'high' },
    });
    const second = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: projectId, title: 'Wire up analytics' },
    });
    taskId = first.id;
    assert.equal(first.identifier, 'WEB-1');
    assert.equal(second.identifier, 'WEB-2');
    assert.equal(first.priority, 'high');
    assert.deepEqual(first.assignees, []);
  });

  it('sets completed_at when a task enters a done state', async () => {
    const updated = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { state_id: stateIds.Done } });
    assert.ok(updated.completed_at, 'completed_at should be stamped');
    const reopened = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { state_id: stateIds.Todo } });
    assert.equal(reopened.completed_at, null);
  });

  it('finds tasks through full-text search', async () => {
    const { results } = await api(`/api/workspaces/${workspaceId}/search?q=landing`);
    assert.ok(results.some((hit: any) => hit.id === taskId), 'search should find the task');
  });

  it('pulls a full snapshot and then only deltas', async () => {
    const snapshot = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.ok(snapshot.changes.task?.length === 2);
    assert.ok(snapshot.changes.project?.length === 2); // "Getting started" + "Website relaunch"
    assert.ok(snapshot.cursor > 0);

    await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Delta task' } });
    const delta = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=${snapshot.cursor}`);
    assert.equal(delta.changes.task?.length, 1);
    assert.equal(delta.changes.task?.[0].title, 'Delta task');
  });

  it('accepts an offline mutation batch and is idempotent on retry', async () => {
    const id = crypto.randomUUID();
    const mutationId = crypto.randomUUID();
    const push = () => api<PushResponse>('/api/sync/push', {
      body: {
        workspaceId,
        clientId: 'test-client',
        mutations: [{
          id: mutationId,
          entity: 'task',
          entityId: id,
          op: 'upsert',
          patch: { workspace_id: workspaceId, project_id: projectId, title: 'Filed while offline', sort_order: orderKey(null, null) },
          hlc: clock.now(),
        }],
      },
    });

    const first = await push();
    assert.deepEqual(first.rejected, []);
    assert.equal(first.patched.task?.[0].identifier, 'WEB-4');

    const again = await push();
    assert.deepEqual(again.rejected, []);
    assert.equal(again.patched.task, undefined, 'a replayed mutation must not create a second task');

    const task = await api(`/api/tasks/${id}`);
    assert.equal(task.title, 'Filed while offline');
  });

  it('merges concurrent edits field by field', async () => {
    const older = clock.now();
    const newer = clock.now();

    // Two offline clients: one renamed the task, the other changed its priority.
    await api('/api/sync/push', {
      body: {
        workspaceId, clientId: 'client-b',
        mutations: [{ id: crypto.randomUUID(), entity: 'task', entityId: taskId, op: 'upsert', patch: { title: 'Renamed by B' }, hlc: newer }],
      },
    });
    await api('/api/sync/push', {
      body: {
        workspaceId, clientId: 'client-a',
        mutations: [{ id: crypto.randomUUID(), entity: 'task', entityId: taskId, op: 'upsert', patch: { title: 'Renamed by A', priority: 'urgent' }, hlc: older }],
      },
    });

    const task = await api(`/api/tasks/${taskId}`);
    assert.equal(task.title, 'Renamed by B', 'the newer stamp wins for title');
    assert.equal(task.priority, 'urgent', 'the untouched field still takes the older write');
  });

  it('stores uploads content-addressed and serves them back', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAABirU3bAAAAG0lEQVR4nGP8//8/AzGAiShVowZTx2AKAAAA//8DAAKrAsfKF8p1AAAAAElFTkSuQmCC',
      'base64',
    );
    const upload = await api(`/api/workspaces/${workspaceId}/files?task_id=${taskId}`, {
      raw: png,
      headers: { 'content-type': 'image/png', 'x-filename': 'pixel.png' },
    });
    assert.equal(upload.width, 10);
    assert.equal(upload.height, 5);
    assert.ok(upload.attachment.id);

    const response = await fetch(`${base}${upload.url}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal((await response.arrayBuffer()).byteLength, png.length);

    const anonymous = await fetch(`${base}${upload.url}`);
    assert.equal(anonymous.status, 401, 'uploads must not be public');
  });

  it('keeps page history when the body changes', async () => {
    const page = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Runbook', content: '# Runbook\n\nfirst revision' },
    });
    await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { content: '# Runbook\n\nsecond revision' } });
    const versions = await api(`/api/pages/${page.id}/versions`);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].title, 'Runbook');
  });

  it('issues API tokens and speaks MCP', async () => {
    const created = await api('/api/tokens', { body: { name: 'mcp', workspaceId } });
    apiToken = created.token;
    assert.match(apiToken, /^kol_/);

    const listed = await api('/mcp', {
      token: apiToken,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const names = listed.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('create_task'));
    assert.ok(names.includes('project_status'));

    const call = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', title: 'Filed by an assistant', priority: 'urgent' } },
      },
    });
    assert.equal(call.result.structuredContent.identifier, 'WEB-5');

    const status = await api('/mcp', {
      token: apiToken,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_status', arguments: { project: 'WEB' } } },
    });
    assert.ok(status.result.structuredContent.by_state_group);

    const initialize = await api('/mcp', {
      token: apiToken,
      body: { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    });
    assert.equal(initialize.result.serverInfo.name, 'kolibri');
  });

  it('refuses writes from a read-only token', async () => {
    const readOnly = await api('/api/tokens', { body: { name: 'ro', workspaceId, scopes: 'read' } });
    const result = await api('/mcp', {
      token: readOnly.token,
      body: {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', title: 'should fail' } },
      },
    });
    assert.match(result.result?.content?.[0]?.text ?? result.error.message, /read-only/i);
  });

  it('notifies the person named in a comment', async () => {
    // Bob is invited further down; for the mention we need a second member now.
    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    const adaCookie = cookie;

    cookie = '';
    await api('/api/auth/register', { body: { email: 'lin@example.com', name: 'Lin Clark', password: 'yet another pass' } });
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    const linId = (await api('/api/session')).user.id;

    cookie = adaCookie;
    await api(`/api/workspaces/${workspaceId}/comments`, {
      body: { task_id: taskId, body: 'Can you take a look at this, @lin?' },
    });

    cookie = '';
    await api('/api/auth/login', { body: { email: 'lin@example.com', password: 'yet another pass' } });
    const notifications = await api(`/api/workspaces/${workspaceId}/notifications`);
    const mention = notifications.find((n: any) => n.kind === 'mention');
    assert.ok(mention, 'the mentioned user gets a notification');
    assert.equal(mention.user_id, linId);
    assert.match(mention.title, /mentioned/i);

    cookie = adaCookie;
  });

  it('writes notifications in the recipient\'s language, not the actor\'s', async () => {
    const adaCookie = cookie;

    // Lin switches to German; Ada stays on English.
    cookie = '';
    await api('/api/auth/login', { body: { email: 'lin@example.com', password: 'yet another pass' } });
    const me = await api('/api/me', { method: 'PATCH', body: { locale: 'de' } });
    assert.equal(me.user.locale, 'de');
    await assert.rejects(() => api('/api/me', { method: 'PATCH', body: { locale: 'klingon' } }), /400/);
    const linCookie = cookie;

    cookie = adaCookie;
    await api(`/api/workspaces/${workspaceId}/comments`, {
      body: { task_id: taskId, body: 'Zweiter Blick bitte, @lin' },
    });

    cookie = linCookie;
    const notifications = await api(`/api/workspaces/${workspaceId}/notifications`);
    const german = notifications.find((n: any) => n.kind === 'mention' && /erwähnt/.test(n.title));
    assert.ok(german, 'the German user gets a German notification title');

    cookie = adaCookie;
  });

  it('hides private projects from non-members', async () => {
    cookie = '';
    await api('/api/auth/register', { body: { email: 'bob@example.com', name: 'Bob', password: 'another good pass' } });
    const bobCookie = cookie;

    cookie = '';
    await api('/api/auth/login', { body: { email: 'ada@example.com', password: 'correct horse battery' } });
    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    const secret = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Secret plans', key: 'SEC', visibility: 'private' },
    });

    cookie = bobCookie;
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    const projects = await api(`/api/workspaces/${workspaceId}/projects`);
    assert.ok(!projects.some((p: any) => p.id === secret.id), 'Bob must not see the private project');

    const pull = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.ok(!pull.changes.project?.some((p: any) => p.id === secret.id), 'sync must not leak private projects');
  });
});

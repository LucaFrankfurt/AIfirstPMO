/**
 * What a deleted project takes with it, and what a restored one brings back.
 *
 * Nothing cascaded before this, and the visible half was odd rather than
 * alarming: a task whose project was in the trash stayed in every list, in
 * every report and on every synced device, while `list_projects` and every
 * project-scoped call refused the project it named — `DOOM-1` in somebody's
 * own work with no `DOOM` to open.
 *
 * The invisible half was the reason to fix it. `purgeable()` collects rows
 * carrying a `deleted_at` and those rows had none, so emptying the trash took
 * the project and left its contents behind *permanently* — unreachable,
 * un-restorable and un-purgeable. These tests are mostly about the second
 * half: the tombstones exist, they sync, and the trash can finally see them.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-cascade-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { all, get } = await import('../src/kernel/platform/db/index.ts');
const { purgeable } = await import('../src/modules/trash/trash.ts');

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

let workspaceId = '';
let token = '';
let projectId = '';
let childId = '';
let keptTask = '';
let alreadyBinned = '';
let pageId = '';
let secretId = '';
let looseLabel = '';

const tool = (name: string, args: Record<string, unknown> = {}) =>
  api('mcp', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
    .then((response) => (response.error ? { error: response.error.message } : response.result.structuredContent));

const live = (table: string, id: string) => !get<any>(`SELECT deleted_at FROM ${table} WHERE id = ?`, id)?.deleted_at;

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const ada = await api('ada', '/api/auth/register', {
    body: { email: 'ada@cascade.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspaceId = ada.workspaces[0].id;
  token = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId } })).token;

  const project = await api('ada', `/api/workspaces/${workspaceId}/projects`, { body: { name: 'Doomed', key: 'DOOM' } });
  projectId = project.id;
  const child = await api('ada', `/api/workspaces/${workspaceId}/projects`, {
    body: { name: 'Doomed child', key: 'DOOMC', parent_id: projectId },
  });
  childId = child.id;

  keptTask = (await api('ada', `/api/workspaces/${workspaceId}/tasks`, {
    body: { project_id: projectId, title: 'Orphan task', assignees: [ada.user.id] },
  })).id;
  alreadyBinned = (await api('ada', `/api/workspaces/${workspaceId}/tasks`, {
    body: { project_id: projectId, title: 'Binned last week' },
  })).id;
  pageId = (await api('ada', `/api/workspaces/${workspaceId}/pages`, {
    body: { project_id: projectId, title: 'Orphan page', content: 'still here' },
  })).id;
  secretId = (await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
    body: { name: 'DOOM deploy key', kind: 'api_key', access: 'project', project_id: projectId, value: 'sk-doom' },
  })).id;
  // A workspace-wide row, to prove the cascade reads `project_id` rather than
  // "anything in this workspace".
  looseLabel = (await api('ada', `/api/workspaces/${workspaceId}/labels`, { body: { name: 'workspace-wide' } })).id;
  await api('ada', `/api/workspaces/${workspaceId}/tasks`, {
    body: { project_id: childId, title: 'In the child' },
  });

  // Binned before the project goes, which is what restoring must not undo.
  await api('ada', `/api/tasks/${alreadyBinned}`, { method: 'DELETE' });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('deleting the project', () => {
  it('takes what points at it, and leaves what does not', async () => {
    await api('ada', `/api/projects/${projectId}`, { method: 'DELETE' });

    assert.equal(live('tasks', keptTask), false, 'the task outlived its project');
    assert.equal(live('pages', pageId), false, 'the page outlived its project');
    assert.equal(live('secrets', secretId), false, 'the secret outlived its project');
    assert.equal(live('labels', looseLabel), true, 'a workspace-wide label was taken with a project');
  });

  it('follows the tree into a child project', () => {
    assert.equal(live('projects', childId), false, 'a nested project was left behind');
    const inChild = all<any>(`SELECT deleted_at FROM tasks WHERE project_id = ?`, childId);
    assert.ok(inChild.length, 'the child had no tasks, so this proved nothing');
    assert.ok(inChild.every((row) => row.deleted_at), 'the child cascaded but its own contents did not');
  });

  it('is gone from every surface at once', async () => {
    assert.deepEqual(await api('ada', `/api/workspaces/${workspaceId}/tasks`), []);
    assert.deepEqual((await tool('list_tasks')).result ?? [], []);
    assert.deepEqual((await tool('search', { query: 'Orphan' })).result ?? [], []);
    const mine = await tool('my_work');
    assert.deepEqual([...mine.overdue, ...mine.today, ...mine.upcoming, ...mine.unscheduled], []);
  });

  it('reaches a device as a tombstone rather than as an absence', async () => {
    // The difference decides whether an offline laptop ever drops its copy.
    // A row simply filtered out of the pull stays on that laptop for good.
    const pull = await api('ada', `/api/sync/pull?workspace=${workspaceId}&since=0`);
    const task = (pull.changes.task ?? []).find((row: any) => row.id === keptTask);
    assert.ok(task, 'the task was filtered out of the pull instead of tombstoned');
    assert.ok(task.deleted_at, 'the task reached the device still looking alive');
  });

  it('is finally something the trash can see', () => {
    // The half nobody would have noticed: with no `deleted_at` these rows were
    // never collected, so emptying the trash removed the project and left them
    // behind permanently.
    const counts = purgeable(workspaceId, Date.now() + 1000);
    const byEntity = Object.fromEntries(counts.entries.map((one) => [one.entity, one.count]));
    assert.ok(byEntity.task >= 3, `only ${byEntity.task ?? 0} tasks are purgeable`);
    assert.ok(byEntity.page >= 1);
    assert.ok(byEntity.project >= 2, 'the child project is not purgeable');
  });

  it('keeps the log, which is the record that any of it existed', () => {
    const entries = all<any>(`SELECT id FROM activities WHERE project_id = ? AND deleted_at IS NULL`, projectId);
    assert.ok(entries.length, 'the cascade erased its own history');
  });
});

describe('restoring it', () => {
  it('brings back exactly what this deletion took', async () => {
    await api('ada', `/api/projects/${projectId}`, { method: 'PATCH', body: { deleted_at: null } });

    assert.equal(live('projects', projectId), true);
    assert.equal(live('tasks', keptTask), true, 'the task did not come back with its project');
    assert.equal(live('pages', pageId), true);
    assert.equal(live('secrets', secretId), true);
    assert.equal(live('projects', childId), true, 'the child project did not come back');
  });

  it('leaves what was already in the trash in the trash', () => {
    // Restoring a project is not "undelete everything that ever belonged to
    // it": a task somebody binned last week was not part of this deletion.
    assert.equal(live('tasks', alreadyBinned), false, 'restoring resurrected a task nobody asked for');
  });

  it('puts it back on every surface', async () => {
    const listed = await api('ada', `/api/workspaces/${workspaceId}/tasks`);
    assert.ok(listed.some((row: any) => row.id === keptTask));
    assert.equal((await tool('project_status', { project: 'DOOM' })).error, undefined);
  });
});

describe('the cascade fires once', () => {
  it('does not run again when an already-deleted project is edited', async () => {
    await api('ada', `/api/projects/${projectId}`, { method: 'DELETE' });
    await api('ada', `/api/tasks/${keptTask}`, { method: 'PATCH', body: { title: 'Touched while gone' } });
    const seqBefore = Number(get<any>(`SELECT seq FROM tasks WHERE id = ?`, keptTask).seq);
    // An edit to the project itself is not a second deletion, so nothing it
    // contains should be written again.
    await api('ada', `/api/projects/${projectId}`, { method: 'PATCH', body: { description: 'still in the bin' } });
    assert.equal(Number(get<any>(`SELECT seq FROM tasks WHERE id = ?`, keptTask).seq), seqBefore,
      'editing a deleted project cascaded a second time');
  });
});

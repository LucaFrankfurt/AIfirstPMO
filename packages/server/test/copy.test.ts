/**
 * Copying a project — the thing this codebase calls a project template.
 *
 * The cases that matter are the references: a copied rule has to point at the
 * *copy's* state and the *copy's* template, a copied sub-task at its copied
 * parent, and a copied label id inside a task's label list at the copied label.
 * Get one of those wrong and the copy looks right until somebody uses it.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-copy-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let sourceId = '';

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

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;

  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Client onboarding', key: 'ON' });
  sourceId = project.id;

  const labels = await ok(`/api/workspaces/${workspaceId}/labels?project_id=${sourceId}`);
  const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${sourceId}`);

  const parent = await ok(`/api/workspaces/${workspaceId}/tasks`, {
    project_id: sourceId, title: 'Kick-off', labels: [labels[0].id], state_id: states[0].id,
  });
  await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: sourceId, title: 'Send the welcome pack', parent_id: parent.id });
  const done = await ok(`/api/workspaces/${workspaceId}/tasks`, {
    project_id: sourceId, title: 'Signed contract', state_id: states.find((s: any) => s.group_key === 'completed').id,
  });
  await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: parent.id, related_task_id: done.id, kind: 'relates_to' });

  const page = await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: sourceId, title: 'Runbook', content: 'Step one.' });
  await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: sourceId, title: 'Checklist', parent_id: page.id });

  await ok(`/api/workspaces/${workspaceId}/fields`, {
    project_id: sourceId, name: 'Account manager', kind: 'person', options: [], type_ids: [],
  });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const copy = (body: unknown) => ok(`/api/workspaces/${workspaceId}/projects/${sourceId}/copy`, body);

describe('copying a project', () => {
  it('brings the structure across and nothing else by default', async () => {
    const result = await copy({ name: 'Acme onboarding' });
    const id = result.project.id;

    assert.notEqual(id, sourceId);
    assert.equal(result.project.name, 'Acme onboarding');
    assert.match(result.project.key, /^[A-Z]/, 'and gets a key of its own');
    assert.notEqual(result.project.key, 'ON', 'never the source’s, which has to stay unique');

    const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    assert.equal(states.length, (await ok(`/api/workspaces/${workspaceId}/states?project_id=${sourceId}`)).length);
    assert.equal((await ok(`/api/workspaces/${workspaceId}/fields?project_id=${id}`)).length, 1, 'custom fields too');
    assert.equal((await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${id}`)).length, 0, 'but no tasks');
    assert.equal((await ok(`/api/workspaces/${workspaceId}/pages?project_id=${id}`)).length, 0, 'and no pages');

    // The default state has to point into the copy's own list, or the first
    // task created in it lands in another project's column.
    const project = await ok(`/api/projects/${id}`);
    assert.ok(states.some((state: any) => state.id === project.default_state_id), 'the default state follows the copy');
  });

  it('copies the rules so they fire on the copy’s own states', async () => {
    const result = await copy({ name: 'With rules', include: { automations: true } });
    const id = result.project.id;

    const rules = await ok(`/api/workspaces/${workspaceId}/automations?project_id=${id}`);
    assert.equal(rules.length, 1, 'the feedback rule every project starts with');
    const rule = rules[0];

    const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    const templates = await ok(`/api/workspaces/${workspaceId}/templates?project_id=${id}`);
    assert.ok(states.some((state: any) => state.id === rule.trigger_state_id), 'it watches this project’s review column');
    assert.ok(templates.some((template: any) => template.id === rule.template_id), 'and files this project’s template');
  });

  it('copies tasks with their tree, labels and relations, but not their history', async () => {
    const result = await copy({ name: 'With tasks', include: { tasks: true } });
    const id = result.project.id;

    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${id}`);
    assert.equal(tasks.length, 2, 'the finished one is left behind unless asked for');

    const parent = tasks.find((task: any) => task.title === 'Kick-off');
    const child = tasks.find((task: any) => task.title === 'Send the welcome pack');
    assert.equal(child.parent_id, parent.id, 'the sub-task hangs off the copied parent');
    assert.match(parent.identifier, /^[A-Z]+-1$/, 'and identifiers are the copy’s own, numbered from one');

    const labels = await ok(`/api/workspaces/${workspaceId}/labels?project_id=${id}`);
    assert.equal(parent.labels.length, 1);
    assert.ok(labels.some((label: any) => label.id === parent.labels[0]), 'the label id points into this project');

    // The relation's other end was a finished task that was not copied, so the
    // relation is dropped rather than left pointing at another project.
    const relations = all(`SELECT * FROM task_relations WHERE task_id = ?`, parent.id);
    assert.equal(relations.length, 0);
  });

  it('takes the finished ones too when asked, and then keeps the relation', async () => {
    const result = await copy({ name: 'Everything', include: { tasks: true, doneTasks: true, pages: true } });
    const id = result.project.id;

    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${id}`);
    assert.equal(tasks.length, 3);
    const parent = tasks.find((task: any) => task.title === 'Kick-off');
    const relations = all<any>(`SELECT * FROM task_relations WHERE task_id = ?`, parent.id);
    assert.equal(relations.length, 1, 'both ends exist now, so the link survives');
    assert.ok(tasks.some((task: any) => task.id === relations[0].related_task_id), 'and points inside the copy');

    // It lands in the Done column, so it *is* done — but dated when the copy was
    // made rather than carrying the original's timestamp, which was never true
    // of this row.
    const finished = tasks.find((task: any) => task.title === 'Signed contract');
    assert.ok(finished.completed_at >= finished.created_at, 'dated by the copy, not by the original');

    const pages = await ok(`/api/workspaces/${workspaceId}/pages?project_id=${id}`);
    assert.equal(pages.length, 2);
    const runbook = pages.find((page: any) => page.title === 'Runbook');
    const checklist = pages.find((page: any) => page.title === 'Checklist');
    assert.equal(checklist.parent_id, runbook.id, 'the page tree survives');
  });

  it('refuses a copy with no name', async () => {
    await assert.rejects(() => copy({ name: '  ' }), /needs a name/i);
  });
});

describe('a project under another project', () => {
  it('nests, and refuses to be its own ancestor', async () => {
    const parent = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Portfolio', key: 'PF' });
    const child = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Workstream', key: 'WS' });

    await ok(`/api/projects/${child.id}`, { parent_id: parent.id }, 'PATCH');
    assert.equal((await ok(`/api/projects/${child.id}`)).parent_id, parent.id);

    // The loop: the parent is asked to sit under its own child.
    await ok(`/api/projects/${parent.id}`, { parent_id: child.id }, 'PATCH');
    assert.equal(
      get<any>(`SELECT parent_id FROM projects WHERE id = ?`, parent.id)?.parent_id,
      null,
      'the move is refused rather than closing the circle',
    );

    // And a copy can be filed under a parent as it is made.
    const copied = await copy({ name: 'Nested copy', parentId: parent.id });
    assert.equal(copied.project.parent_id, parent.id);
  });
});

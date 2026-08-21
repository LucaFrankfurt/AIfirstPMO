/**
 * The schedule, applied where the interface is not the caller.
 *
 * The Gantt has always written the shifted successors itself, so it works
 * offline. That left a hole: a date set over REST, over MCP, by an import or by
 * an automation moved one task and left everything waiting on it sitting behind
 * its blocker — which made the promise a Gantt chart *is* true only when a Gantt
 * chart was doing the moving.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-cascade-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';

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

const patch = (path: string, body: unknown) => ok(path, body, 'PATCH');
const dates = (id: string) => {
  const row = get<any>(`SELECT start_date, due_date FROM tasks WHERE id = ?`, id)!;
  return [row.start_date, row.due_date];
};

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  // Every day is a working day here, so the arithmetic in these tests is about
  // the cascade rather than about weekends — those have their own file.
  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Plan', key: 'PLN' });
  projectId = project.id;
  await patch(`/api/projects/${projectId}`, { working_days: [0, 1, 2, 3, 4, 5, 6] });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const makeTask = (title: string, start: string, due: string) =>
  ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title, start_date: start, due_date: due });

describe('a date set over the API', () => {
  it('moves everything waiting on it, without the interface being involved', async () => {
    const a = await makeTask('Pour the foundation', '2026-08-10', '2026-08-14');
    const b = await makeTask('Build the walls', '2026-08-15', '2026-08-20');
    const c = await makeTask('Put the roof on', '2026-08-21', '2026-08-22');
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: a.id, related_task_id: b.id, kind: 'blocks' });
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: b.id, related_task_id: c.id, kind: 'blocks' });

    // The foundation takes a week longer.
    await patch(`/api/tasks/${a.id}`, { due_date: '2026-08-21' });

    assert.deepEqual(dates(b.id), ['2026-08-22', '2026-08-27'], 'the walls wait');
    assert.deepEqual(dates(c.id), ['2026-08-28', '2026-08-29'], 'and the roof waits for the walls');
  });

  it('respects the wait somebody put on the link', async () => {
    const a = await makeTask('Paint it', '2026-09-01', '2026-09-01');
    const b = await makeTask('Hang the pictures', '2026-09-02', '2026-09-02');
    await ok(`/api/workspaces/${workspaceId}/relations`, {
      task_id: a.id, related_task_id: b.id, kind: 'blocks', lag: 3,
    });

    await patch(`/api/tasks/${a.id}`, { due_date: '2026-09-03' });
    assert.deepEqual(dates(b.id), ['2026-09-07', '2026-09-07'], 'three days for the paint to dry');
  });

  it('re-runs when somebody adds the wait, not only when a date moves', async () => {
    const a = await makeTask('Lay the concrete', '2026-09-14', '2026-09-15');
    const b = await makeTask('Drive on it', '2026-09-16', '2026-09-16');
    const link = await ok(`/api/workspaces/${workspaceId}/relations`, {
      task_id: a.id, related_task_id: b.id, kind: 'blocks',
    });
    assert.deepEqual(dates(b.id), ['2026-09-16', '2026-09-16'], 'nothing to do yet');

    await patch(`/api/relations/${link.id}`, { lag: 7 });
    assert.deepEqual(dates(b.id), ['2026-09-23', '2026-09-23'], 'a week for it to cure');
  });

  it('never pulls anything earlier, because a plan that snaps backwards argues', async () => {
    const a = await makeTask('Ship it', '2026-10-01', '2026-10-05');
    const b = await makeTask('Announce it', '2026-10-20', '2026-10-21');
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: a.id, related_task_id: b.id, kind: 'blocks' });

    await patch(`/api/tasks/${a.id}`, { due_date: '2026-10-02' });
    assert.deepEqual(dates(b.id), ['2026-10-20', '2026-10-21'], 'finishing early does not drag the plan forward');
  });

  it('leaves a task with no dates alone rather than inventing some', async () => {
    const a = await makeTask('Decide the colour', '2026-11-02', '2026-11-03');
    const b = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Someday' });
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: a.id, related_task_id: b.id, kind: 'blocks' });

    await patch(`/api/tasks/${a.id}`, { due_date: '2026-11-30' });
    assert.deepEqual(dates(b.id), [null, null], 'an undated task is not on the chart at all');
  });

  it('is not an edit anybody made, so it leaves no activity trail of its own', async () => {
    const a = await makeTask('Sign the contract', '2026-12-01', '2026-12-02');
    const b = await makeTask('Start the work', '2026-12-03', '2026-12-04');
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: a.id, related_task_id: b.id, kind: 'blocks' });
    await patch(`/api/tasks/${a.id}`, { due_date: '2026-12-10' });

    assert.deepEqual(dates(b.id), ['2026-12-11', '2026-12-12'], 'it did move');
    assert.equal(
      get(`SELECT id FROM activities WHERE task_id = ? AND field = 'start_date'`, b.id), undefined,
      'the schedule moving a task is not a person editing it',
    );
  });

  it('stops at the guard rather than spinning on a circular plan', async () => {
    const a = await makeTask('Chicken', '2027-01-04', '2027-01-05');
    const b = await makeTask('Egg', '2027-01-06', '2027-01-07');
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: a.id, related_task_id: b.id, kind: 'blocks' });
    await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: b.id, related_task_id: a.id, kind: 'blocks' });

    // The point is that this returns at all.
    await patch(`/api/tasks/${a.id}`, { due_date: '2027-01-08' });
    assert.ok(dates(b.id)[0]! > '2027-01-08');
  });
});

/**
 * A project that only holds other projects.
 *
 * A flag rather than a separate "folder" entity, so the interesting part is not
 * that it can be set — it is what refuses to set it, and what a create can
 * quietly get away with.
 */
describe('container projects', () => {
  it('accepts a parent when the project is created, and refuses one from elsewhere', async () => {
    const parent = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Calendoora', key: 'CAL' });
    const child = await ok(`/api/workspaces/${workspaceId}/projects`, {
      name: 'Setaside', key: 'SET', parent_id: parent.id,
    });
    assert.equal(child.parent_id, parent.id, 'the parent was accepted at creation');

    // Somebody else's project id, which is not this workspace's to nest under.
    const stranger = await ok(`/api/workspaces/${workspaceId}/projects`, {
      name: 'Elsewhere', key: 'ELS', parent_id: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(stranger.parent_id, null, 'a parent that is not here is dropped, not written');
  });

  it('refuses to become a container while it still holds tasks', async () => {
    const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Busy', key: 'BSY' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Something to do' });

    const refused = await ok(`/api/projects/${project.id}`, { is_container: 1 }, 'PATCH');
    assert.equal(refused.is_container, 0, 'the flag was refused, not obeyed');
  });

  it('lets an empty project become one, and lets it back again', async () => {
    const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Empty', key: 'EMP' });

    const on = await ok(`/api/projects/${project.id}`, { is_container: 1 }, 'PATCH');
    assert.equal(on.is_container, 1);

    // Always allowed in this direction: there is nothing to hide.
    const off = await ok(`/api/projects/${project.id}`, { is_container: 0 }, 'PATCH');
    assert.equal(off.is_container, 0);
  });

  it('still refuses a loop, however it is asked for', async () => {
    const top = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Top', key: 'TOP' });
    const mid = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Mid', key: 'MID', parent_id: top.id });
    const leaf = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Leaf', key: 'LEA', parent_id: mid.id });

    const looped = await ok(`/api/projects/${top.id}`, { parent_id: leaf.id }, 'PATCH');
    assert.equal(looped.parent_id, null, 'a ring three deep is still a ring');
  });
});

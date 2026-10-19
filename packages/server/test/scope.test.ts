/**
 * What a cycle or a milestone covers, and the one shape it is stored in.
 *
 * Three combinations are legal and a fourth is not: an owner with an empty
 * list is one project's own, no owner with an empty list is every project, no
 * owner with a list is exactly those — and an owner *together with* a list is
 * never written, because then every reader downstream has to decide which of
 * the two fields wins. `scope.ts` in `@kolibri/shared` has claimed since it was
 * written that the server normalises this on the way in.
 *
 * For a KPI and a budget it did. For a cycle and a milestone — the two whose
 * scope is the thing people actually edit — it did not: the only caller that
 * normalised was MCP, which did it in its own argument parsing before the
 * write. So a `PATCH` over REST, a sync push from a device, or an import could
 * store the combination the docblock says never exists, and `coversProject`
 * would answer from the list while the project page answered from the owner.
 *
 * It became reachable the day the interface learned to re-scope a cycle, which
 * is why these are here rather than in a unit test beside `projectScope`: the
 * arithmetic was never in doubt, the question is whether the write path applies
 * it, and that can only be asked of a real write.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-scope-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
/** Three projects, because "some" needs two and "not covered" needs a third. */
let web = '';
let api = '';
let mobile = '';

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

/** The stored pair, read straight out of SQLite rather than off the response. */
const stored = (table: 'cycles' | 'modules', id: string) => {
  const row = get<any>(`SELECT project_id, projects FROM ${table} WHERE id = ?`, id)!;
  return { project_id: row.project_id ?? null, projects: JSON.parse(String(row.projects ?? '[]')) };
};

const makeCycle = (extra: Record<string, unknown> = {}) =>
  ok(`/api/workspaces/${workspaceId}/cycles`, {
    project_id: web, name: `Sprint ${Math.random().toString(36).slice(2, 7)}`,
    start_date: '2026-09-01', end_date: '2026-09-14', ...extra,
  });

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  web = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Website', key: 'WEB' })).id;
  api = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Public API', key: 'API' })).id;
  mobile = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Mobile app', key: 'MOB' })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('re-scoping a cycle that already exists', () => {
  it('widens one project’s cycle to several', async () => {
    const cycle = await makeCycle();
    assert.deepEqual(stored('cycles', cycle.id), { project_id: web, projects: [] }, 'starts as one project’s own');

    await patch(`/api/cycles/${cycle.id}`, { project_id: null, projects: [web, api] });

    assert.deepEqual(stored('cycles', cycle.id), { project_id: null, projects: [web, api] });
  });

  it('narrows a shared cycle back to one, as an owner rather than a list of one', async () => {
    const cycle = await makeCycle({ project_id: null, projects: [web, api] });

    await patch(`/api/cycles/${cycle.id}`, { projects: [api] });

    // `projects: ["api"]` and `project_id: "api"` describe the same cycle, and
    // storing both spellings would mean two rows that are equal and do not
    // compare equal.
    assert.deepEqual(stored('cycles', cycle.id), { project_id: api, projects: [] });
  });

  it('makes it every project when the list is emptied and no owner is named', async () => {
    const cycle = await makeCycle({ project_id: null, projects: [web, api] });

    await patch(`/api/cycles/${cycle.id}`, { project_id: null, projects: [] });

    assert.deepEqual(stored('cycles', cycle.id), { project_id: null, projects: [] });
  });

  it('never stores an owner and a list at once — the list wins and the owner is cleared', async () => {
    const cycle = await makeCycle();

    const answer = await patch(`/api/cycles/${cycle.id}`, { project_id: web, projects: [web, api] });

    assert.deepEqual(stored('cycles', cycle.id), { project_id: null, projects: [web, api] });
    // And the caller is told rather than silently disagreed with: the response
    // is the row as the server settled it.
    assert.equal(answer.project_id, null);
    assert.deepEqual(answer.projects, [web, api]);
  });

  it('drops a duplicate a caller sent twice', async () => {
    const cycle = await makeCycle();

    await patch(`/api/cycles/${cycle.id}`, { project_id: null, projects: [api, web, api] });

    const { projects } = stored('cycles', cycle.id);
    assert.deepEqual([...projects].sort(), [api, web].sort());
  });

  it('leaves the scope alone when the write is about something else', async () => {
    const cycle = await makeCycle({ project_id: null, projects: [web, api] });

    await patch(`/api/cycles/${cycle.id}`, { name: 'Renamed, not re-scoped' });

    assert.deepEqual(stored('cycles', cycle.id), { project_id: null, projects: [web, api] });
  });

  it('normalises on the way in at creation too, not only on an edit', async () => {
    // An import and a seeded workspace come through the same door as a form.
    const cycle = await makeCycle({ project_id: web, projects: [web, api] });

    assert.deepEqual(stored('cycles', cycle.id), { project_id: null, projects: [web, api] });
  });
});

/**
 * The half that is deliberately *not* done.
 *
 * Dropping a project out of a cycle could orphan its tasks from a sprint
 * somebody put them in on purpose, and doing that silently as a side effect of
 * an edit is the kind of loss nobody attributes to the right action. So the
 * work stays where it is, and both surfaces say so instead: `update_cycle`
 * names the tasks in its answer, and the sheet names them before the save.
 */
describe('the work in a cycle that was re-scoped', () => {
  it('keeps its cycle even when its project is no longer covered', async () => {
    const cycle = await makeCycle({ project_id: null, projects: [web, mobile] });
    const task = await ok(`/api/workspaces/${workspaceId}/tasks`, {
      project_id: mobile, title: 'Booked into a shared fortnight', cycle_id: cycle.id,
    });
    assert.equal(get<any>(`SELECT cycle_id FROM tasks WHERE id = ?`, task.id)!.cycle_id, cycle.id);

    await patch(`/api/cycles/${cycle.id}`, { project_id: null, projects: [web, api] });

    assert.equal(
      get<any>(`SELECT cycle_id FROM tasks WHERE id = ?`, task.id)!.cycle_id, cycle.id,
      'still in the cycle, which is what lets somebody find and move it',
    );
    assert.equal(
      get<any>(`SELECT project_id FROM tasks WHERE id = ?`, task.id)!.project_id, mobile,
      'and still in its own project, which the cycle no longer covers',
    );
  });
});

/**
 * A milestone is scoped by the same pair and goes through the same rule.
 *
 * It has its own editor now, the cycle's twin, so the interface reaches these
 * columns as well as REST, a sync push, an import and `update_module` — which
 * is why they are checked here rather than left to the cycle's cases above.
 */
describe('a milestone', () => {
  it('is normalised the same way a cycle is', async () => {
    const module_ = await ok(`/api/workspaces/${workspaceId}/modules`, { project_id: web, name: 'Checkout' });

    await patch(`/api/modules/${module_.id}`, { project_id: web, projects: [web, api] });

    assert.deepEqual(stored('modules', module_.id), { project_id: null, projects: [web, api] });
  });

  it('collapses a list of one to an owner, as a cycle does', async () => {
    const module_ = await ok(`/api/workspaces/${workspaceId}/modules`, {
      project_id: null, projects: [web, api], name: 'Shared milestone',
    });

    await patch(`/api/modules/${module_.id}`, { projects: [api] });

    assert.deepEqual(stored('modules', module_.id), { project_id: api, projects: [] });
  });
});

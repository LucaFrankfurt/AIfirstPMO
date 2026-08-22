/**
 * Moving a task to another project, where the interface is not the caller.
 *
 * Almost everything on a task that is not text belongs to the project it is
 * filed in: the columns, the labels, the cycle, the module.
 * A caller that sets `project_id` and nothing else — a `PATCH` over REST, an
 * MCP call, an import, an automation — would otherwise leave a row sitting in a
 * column its new board does not have, which renders as a task that is simply
 * not on the board at all.
 *
 * The interface performs the move itself so the board reacts without a round
 * trip. These are the same rules, checked on the side that has to hold even
 * when it does not.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-relocate-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
/** Where tasks start, and where they are moved to. */
let from = '';
let to = '';

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
const task = (id: string) => get<any>(`SELECT * FROM tasks WHERE id = ?`, id)!;
const statesOf = (projectId: string) =>
  all<any>(`SELECT id, name, group_key FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order`, projectId);
const labelsOf = (projectId: string) =>
  all<any>(`SELECT id, name FROM labels WHERE project_id = ? AND deleted_at IS NULL`, projectId);

const named = (rows: { id: string; name: string }[], name: string): string => {
  const row = rows.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  assert.ok(row, `no "${name}" among ${JSON.stringify(rows.map((r) => r.name))}`);
  return row.id;
};

const makeTask = (title: string, extra: Record<string, unknown> = {}) =>
  ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: from, title, ...extra });

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  from = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Website', key: 'WEB' })).id;
  to = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Public API', key: 'API' })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a task filed under a different project', () => {
  it('lands in the column that means the same thing, not the first one', async () => {
    // The two projects were seeded with the same workflow, so "started" exists
    // in both — under whatever each of them calls it.
    const started = statesOf(from).find((state) => state.group_key === 'started');
    assert.ok(started, 'the seeded workflow has a started column');
    const row = await makeTask('Redesign the pricing page', { state_id: started.id });

    await patch(`/api/tasks/${row.id}`, { project_id: to });

    const moved = task(row.id);
    assert.equal(moved.project_id, to);
    const landed = statesOf(to).find((state) => state.id === moved.state_id);
    assert.ok(landed, 'the state it landed in belongs to the project it landed in');
    assert.equal(landed.group_key, 'started', 'and it is still started, not back to the top of the board');
  });

  it('keeps its identifier, because that is the address people pasted', async () => {
    const row = await makeTask('Fix the footer');
    const before = task(row.id).identifier;
    assert.match(before, /^WEB-\d+$/);

    await patch(`/api/tasks/${row.id}`, { project_id: to });
    assert.equal(task(row.id).identifier, before, 'WEB-n stays WEB-n after it moves');
  });

  it('carries a label across when the other project has one by that name', async () => {
    const here = await ok(`/api/workspaces/${workspaceId}/labels`, { project_id: from, name: 'regression', color: '#f00' });
    await ok(`/api/workspaces/${workspaceId}/labels`, { project_id: to, name: 'Regression', color: '#00f' });
    const row = await makeTask('Scroll position resets', { labels: [here.id] });

    await patch(`/api/tasks/${row.id}`, { project_id: to });

    const moved = task(row.id);
    assert.deepEqual(JSON.parse(moved.labels), [named(labelsOf(to), 'regression')],
      'the same word, the destination project\'s row for it');
  });

  it('drops a label the other project has never heard of, rather than inventing one', async () => {
    const only = await ok(`/api/workspaces/${workspaceId}/labels`, { project_id: from, name: 'needs-photography', color: '#0f0' });
    const row = await makeTask('New team page', { labels: [only.id] });

    await patch(`/api/tasks/${row.id}`, { project_id: to });

    assert.deepEqual(JSON.parse(task(row.id).labels), []);
    assert.equal(labelsOf(to).some((label) => label.name === 'needs-photography'), false,
      'and nothing was created in the destination on the strength of a drag');
  });

  it('leaves the cycle behind, because a cycle belongs to one project', async () => {
    const cycle = await ok(`/api/workspaces/${workspaceId}/cycles`, {
      project_id: from, name: 'Sprint 12', start_date: '2026-09-01', end_date: '2026-09-14',
    });
    const module_ = await ok(`/api/workspaces/${workspaceId}/modules`, { project_id: from, name: 'Checkout' });
    const row = await makeTask('Tidy the receipt', { cycle_id: cycle.id, module_id: module_.id });

    await patch(`/api/tasks/${row.id}`, { project_id: to });

    const moved = task(row.id);
    assert.equal(moved.cycle_id, null, 'no sprint');
    assert.equal(moved.module_id, null, 'and no module');
  });

  it('tells the caller what it decided, rather than silently correcting it', async () => {
    const started = statesOf(from).find((state) => state.group_key === 'started')!;
    const row = await makeTask('Rewrite the onboarding copy', { state_id: started.id });

    const answer = await patch(`/api/tasks/${row.id}`, { project_id: to });
    // The response is the row as the server settled it, so a client that sent
    // only `project_id` can draw the result without asking again.
    assert.equal(answer.project_id, to);
    assert.ok(statesOf(to).some((state) => state.id === answer.state_id));
  });

  it('does not touch a client that already did the work', async () => {
    const started = statesOf(from).find((state) => state.group_key === 'started')!;
    const row = await makeTask('Prune the changelog', { state_id: started.id });
    // What the interface sends: the destination worked out locally, in full.
    const chosen = statesOf(to).find((state) => state.group_key === 'completed')!;

    await patch(`/api/tasks/${row.id}`, { project_id: to, state_id: chosen.id });

    assert.equal(task(row.id).state_id, chosen.id,
      'a valid choice is a choice, not something to re-derive');
  });

  it('leaves a task alone when the write is not a move at all', async () => {
    const row = await makeTask('Still here');
    const before = task(row.id);

    await patch(`/api/tasks/${row.id}`, { title: 'Still here, renamed' });

    const after_ = task(row.id);
    assert.equal(after_.project_id, before.project_id);
    assert.equal(after_.state_id, before.state_id);
  });
});

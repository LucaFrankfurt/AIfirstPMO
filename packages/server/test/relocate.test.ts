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
const { get, all } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
/** Where tasks start, and where they are moved to. */
let from = '';
let to = '';
/** An MCP token for the same person, because MCP is the other way in. */
let token = '';

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

/** One MCP tool call as the holder of `token`. Throws whatever MCP refuses with. */
let rpc = 0;
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const payload = await response.json() as any;
  if (payload.error) throw new Error(`refused: ${payload.error.message}`);
  return payload.result.structuredContent;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  from = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Website', key: 'WEB' })).id;
  to = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Public API', key: 'API' })).id;
  token = (await ok('/api/tokens', { name: 'ada', workspaceId })).token;
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

/**
 * A sub-task is filed where its parent is filed.
 *
 * Nothing carried the children before, and the result was a job split across
 * two boards: the parent on the new one, its three sub-tasks on the old one,
 * each still wearing the old project's column and each breadcrumb pointing at
 * a parent that had left. The move looked like it had worked from the card that
 * was dragged and from nowhere else.
 */
describe('the sub-tasks of a task that moved', () => {
  const childrenOf = (id: string) =>
    all<any>(`SELECT * FROM tasks WHERE parent_id = ? AND deleted_at IS NULL`, id);

  it('go where the parent went', async () => {
    const parent = await makeTask('Ship the new pricing page');
    const first = await makeTask('Write the copy', { parent_id: parent.id });
    const second = await makeTask('Draw the table', { parent_id: parent.id });

    await patch(`/api/tasks/${parent.id}`, { project_id: to });

    assert.equal(task(parent.id).project_id, to);
    assert.deepEqual(
      childrenOf(parent.id).map((child) => child.project_id).sort(),
      [to, to],
      `${first.identifier} and ${second.identifier} followed`,
    );
  });

  it('take the whole tree, not only the first floor', async () => {
    const parent = await makeTask('Rebuild the checkout');
    const child = await makeTask('Replace the card form', { parent_id: parent.id });
    const grandchild = await makeTask('Validate the expiry', { parent_id: child.id });

    await patch(`/api/tasks/${parent.id}`, { project_id: to });

    assert.equal(task(child.id).project_id, to, 'the child');
    assert.equal(task(grandchild.id).project_id, to, 'and the child of the child');
  });

  it('land in a column the destination actually has', async () => {
    const started = statesOf(from).find((state) => state.group_key === 'started')!;
    const parent = await makeTask('Tidy the settings screen');
    const child = await makeTask('Rename the tab', { parent_id: parent.id, state_id: started.id });

    await patch(`/api/tasks/${parent.id}`, { project_id: to });

    const landed = statesOf(to).find((state) => state.id === task(child.id).state_id);
    assert.ok(landed, 'the sub-task went through the same rule its parent did');
    assert.equal(landed.group_key, 'started', 'and kept the progress it had');
  });

  it('reaches past a child that was already filed there', async () => {
    // The shape that decided the walk: recursing through each child's own
    // effect stops at a row that needs no write, and this grandchild is behind
    // exactly such a row.
    const parent = await makeTask('Replace the search box');
    const child = await makeTask('Index the titles', { parent_id: parent.id, project_id: to });
    const grandchild = await makeTask('Strip the stop words', { parent_id: child.id });
    assert.equal(task(child.id).project_id, to, 'the middle row starts out in the destination');
    assert.equal(task(grandchild.id).project_id, from);

    await patch(`/api/tasks/${parent.id}`, { project_id: to });

    assert.equal(task(grandchild.id).project_id, to, 'and the row behind it came too');
  });

  it('stay where they are when the parent did not move', async () => {
    const parent = await makeTask('Still filed here');
    const child = await makeTask('And so is this', { parent_id: parent.id });

    await patch(`/api/tasks/${parent.id}`, { title: 'Still filed here, renamed' });

    assert.equal(task(child.id).project_id, from);
  });

  it('does not drag the parent along when a sub-task is the one that moved', async () => {
    const parent = await makeTask('Stays put');
    const child = await makeTask('Goes alone', { parent_id: parent.id });

    await patch(`/api/tasks/${child.id}`, { project_id: to });

    assert.equal(task(child.id).project_id, to);
    assert.equal(task(parent.id).project_id, from, 'filing a part of something is not filing the whole');
  });
});

/**
 * A container holds projects, not tasks.
 *
 * The rule is old — a project with tasks in it is refused the flag — and it had
 * a hole the other way round: nothing stopped a task being moved *into* a
 * container. The interface's own guard is in `moveTaskToProject`, which REST,
 * MCP, an import and an automation all go around, and a container draws a list
 * of projects rather than a board, so the task arrived somewhere with no screen
 * that shows it.
 */
describe('a task offered a container', () => {
  it('stays where it was, and the answer says so', async () => {
    const folder = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Everything', key: 'ALL' });
    await patch(`/api/projects/${folder.id}`, { is_container: 1 });

    const row = await makeTask('Not for a folder');
    const answer = await patch(`/api/tasks/${row.id}`, { project_id: folder.id });

    assert.equal(answer.project_id, from, 'the value came back changed rather than obeyed');
    assert.equal(task(row.id).project_id, from);
  });
});

/**
 * The same move over MCP.
 *
 * `update_task` could change every field of a task except the one that decides
 * which board it is on, so an assistant asked to tidy a backlog could do
 * everything but the tidying. The project is resolved before the rest of the
 * call, because `{project: 'API', state: 'Doing'}` means the destination's
 * "Doing" and resolving it against the project being left behind finds the
 * wrong column or no column at all.
 */
describe('update_task over MCP', () => {
  it('files a task under another project by name', async () => {
    const row = await makeTask('Move me over MCP');

    const answer = await tool('update_task', { task: row.identifier, project: 'Public API' });

    assert.equal(answer.project_id ?? task(row.id).project_id, to);
    assert.equal(task(row.id).project_id, to);
    assert.equal(task(row.id).identifier, row.identifier, 'and keeps the address people pasted');
  });

  it('reads a state named in the same call against the project it is moving to', async () => {
    const row = await makeTask('Move and start');
    const wanted = statesOf(to).find((state) => state.group_key === 'started')!;

    await tool('update_task', { task: row.identifier, project: 'API', state: wanted.name });

    assert.equal(task(row.id).state_id, wanted.id, 'the destination’s column, not a column of the old board');
  });

  it('takes the sub-tasks with it', async () => {
    const parent = await makeTask('Parent over MCP');
    const child = await makeTask('Child over MCP', { parent_id: parent.id });

    await tool('update_task', { task: parent.identifier, project: 'API' });

    assert.equal(task(child.id).project_id, to);
  });

  it('refuses a container out loud rather than quietly correcting it', async () => {
    const folder = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Archive box', key: 'BOX' });
    await patch(`/api/projects/${folder.id}`, { is_container: 1 });
    const row = await makeTask('Not for a folder either');

    await assert.rejects(
      () => tool('update_task', { task: row.identifier, project: 'Archive box' }),
      /container/,
      'an assistant reads a `forced` field as success, so this one throws',
    );
    assert.equal(task(row.id).project_id, from);
  });
});

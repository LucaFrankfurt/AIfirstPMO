/**
 * The six read-only report tools over MCP.
 *
 * They are tested by running them against a real database rather than by
 * asserting about their source, because the whole class of bug they can carry
 * is invisible to the compiler: every one of them is a SQL string, and the
 * first draft of `workload` named a table `memberships` that has been called
 * `workspace_members` since the schema was written. `npm run typecheck` was
 * perfectly happy with it. Only calling the tool finds that.
 *
 * The other thing asserted here is the one that matters more than any number:
 * a report must not widen what a token can see. A private project the caller
 * is not in has to be absent from a workspace-wide answer, including from the
 * aggregate counts — a total that moves when a private task changes is a
 * disclosure with extra steps.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = process.env.KOLIBRI_TEST_DIR ?? `/tmp/kolibri-reports-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');

let base = '';
let cookie = '';

async function api<T = any>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (cookie && !options.token) headers.cookie = cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

let rpcId = 0;
/** Call a tool the way a client does, and fail loudly on a JSON-RPC error. */
async function tool<T = any>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await api('/mcp', {
    token,
    body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  return response.result.structuredContent as T;
}

const day = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * day).toISOString().slice(0, 10);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('mcp reports', () => {
  let workspaceId = '';
  let projectId = '';
  let readToken = '';
  let writeToken = '';
  let ada = '';
  let grace = '';
  const states: Record<string, string> = {};
  const tasks: Record<string, any> = {};

  it('sets up a workspace with work in every interesting condition', async () => {
    const session = await api('/api/auth/register', {
      body: { email: 'ada@example.com', name: 'Ada Lovelace', password: 'correct horse battery' },
    });
    workspaceId = session.workspaces[0].id;
    ada = session.user.id;

    const project = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name: 'Website', key: 'WEB' } });
    projectId = project.id;
    for (const state of await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`)) {
      states[state.group_key] = state.id;
    }

    // A second member, so `workload` has more than one column to fill. Joining
    // is an invite somebody accepts — there is no endpoint that adds a person
    // to a workspace behind their back, which is the point.
    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    const adaCookie = cookie;
    cookie = '';
    await api('/api/auth/register', {
      body: { email: 'grace@example.com', name: 'Grace Hopper', password: 'another good password' },
    });
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    grace = (await api('/api/session')).user.id;
    cookie = adaCookie;

    const make = (key: string, body: Record<string, unknown>) =>
      api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, ...body } })
        .then((row) => { tasks[key] = row; return row; });

    await make('overdue', {
      title: 'Overdue and on Ada', due_date: isoDay(-3), state_id: states.started,
      assignees: [ada], estimate: 3,
    });
    await make('soonUnstarted', {
      title: 'Due Thursday, still in the backlog', due_date: isoDay(2), state_id: states.backlog,
    });
    await make('blocker', { title: 'The blocker, unfinished', state_id: states.started, assignees: [grace] });
    await make('blocked', {
      title: 'Waiting on the blocker', due_date: isoDay(5), state_id: states.unstarted, assignees: [ada],
    });
    await make('safe', { title: 'Due next month, moving along', due_date: isoDay(40), state_id: states.started, assignees: [grace] });
    await make('finished', { title: 'Already done', state_id: states.completed, assignees: [ada] });

    await api(`/api/workspaces/${workspaceId}/relations`, {
      body: { task_id: tasks.blocker.id, related_task_id: tasks.blocked.id, kind: 'blocks' },
    });

    const write = await api('/api/tokens', { body: { name: 'reports-write', workspaceId } });
    writeToken = write.token;
    const read = await api('/api/tokens', { body: { name: 'reports-read', workspaceId, scopes: 'read' } });
    readToken = read.token;
  });

  it('lists every report as read-only, so a read token may call them', async () => {
    const listed = await api('/mcp', { token: readToken, body: { jsonrpc: '2.0', id: 100, method: 'tools/list' } });
    const byName = new Map(listed.result.tools.map((t: any) => [t.name, t]));
    for (const name of ['changes_since', 'deadlines_at_risk', 'workload', 'blocked_tasks', 'stale_tasks', 'cycle_review']) {
      assert.ok(byName.has(name), `${name} is missing from tools/list`);
      assert.equal((byName.get(name) as any).annotations.readOnlyHint, true, `${name} should be read-only`);
    }
  });

  it('deadlines_at_risk gives a reason, not just a date', async () => {
    const report = await tool(readToken, 'deadlines_at_risk', { project: 'WEB' });
    const byId = new Map(report.at_risk.map((t: any) => [t.identifier, t]));

    const overdue = byId.get(tasks.overdue.identifier) as any;
    assert.ok(overdue, 'the overdue task is missing');
    assert.ok(overdue.reasons.includes('overdue'));
    assert.equal(overdue.days_until_due, -3);

    const soon = byId.get(tasks.soonUnstarted.identifier) as any;
    assert.ok(soon.reasons.includes('not_started'), 'a backlog task due in two days is not started');
    assert.ok(soon.reasons.includes('unassigned'), 'and nobody is on it');

    const blocked = byId.get(tasks.blocked.identifier) as any;
    assert.ok(blocked.reasons.includes('blocked'));
    assert.equal(blocked.blocked_by[0].identifier, tasks.blocker.identifier);

    assert.ok(!byId.has(tasks.safe.identifier), 'work due in forty days is not at risk');
    assert.ok(!byId.has(tasks.finished.identifier), 'finished work is never at risk');

    // Worst first, so the first row is the one to talk about.
    assert.equal(report.at_risk[0].identifier, tasks.overdue.identifier);
    assert.equal(report.counts.overdue, 1);
  });

  it('deadlines_at_risk honours its horizon', async () => {
    const narrow = await tool(readToken, 'deadlines_at_risk', { project: 'WEB', days: 1 });
    const ids = narrow.at_risk.map((t: any) => t.identifier);
    assert.ok(ids.includes(tasks.overdue.identifier), 'overdue is always in range');
    assert.ok(!ids.includes(tasks.blocked.identifier), 'due in five days is outside a one-day horizon');
  });

  it('workload counts people, unassigned work and who has left', async () => {
    const report = await tool(readToken, 'workload', { project: 'WEB' });
    const adaRow = report.people.find((p: any) => p.user_id === ada);
    assert.equal(adaRow.name, 'Ada Lovelace');
    assert.equal(adaRow.open, 2, 'the finished task is not open work');
    assert.equal(adaRow.overdue, 1);
    assert.equal(adaRow.still_a_member, true);
    assert.equal(report.unassigned.open, 1, 'the backlog task belongs to nobody');
  });

  it('blocked_tasks reports the chain, and separately the links nobody removed', async () => {
    const before = await tool(readToken, 'blocked_tasks', { project: 'WEB' });
    assert.equal(before.blocked.length, 1);
    assert.equal(before.blocked[0].identifier, tasks.blocked.identifier);
    assert.equal(before.stale_links.length, 0);

    // Finish the blocker: the waiting task stops being blocked, and the link
    // becomes one somebody should tidy up. Moved through the write tool rather
    // than by touching a row, so the report is reading what an assistant would
    // actually have done to the board.
    await tool(writeToken, 'update_task', { task: tasks.blocker.identifier, state: 'Done' });
    const after = await tool(readToken, 'blocked_tasks', { project: 'WEB' });
    assert.equal(after.blocked.length, 0, 'a finished blocker blocks nothing');
    assert.equal(after.stale_links.length, 1);
    assert.equal(after.stale_links[0].waiting, tasks.blocked.identifier);
  });

  it('changes_since counts what happened, and what got finished', async () => {
    const report = await tool(readToken, 'changes_since', { project: 'WEB', days: 7 });
    assert.equal(report.window_days, 7);
    assert.ok(report.total > 0, 'a workspace that was just built has activity');
    assert.ok(report.created.length >= 6, 'every task above was created inside the window');
    assert.ok(
      report.completed.some((t: any) => t.identifier === tasks.blocker.identifier),
      'the blocker was completed in the previous test and belongs in the digest',
    );
    assert.ok(Object.keys(report.by_person).length >= 1);
  });

  it('stale_tasks finds nothing in a workspace built a moment ago', async () => {
    const fresh = await tool(readToken, 'stale_tasks', { project: 'WEB' });
    assert.equal(fresh.stale.length, 0, 'nothing has had time to go quiet');
    assert.equal(fresh.quiet_for_days, 14);

    // A window of one day still finds nothing, because `updated_at` is now.
    const narrow = await tool(readToken, 'stale_tasks', { project: 'WEB', days: 1 });
    assert.equal(narrow.stale.length, 0);
  });

  it('cycle_review says which cycle it means, and refuses when there is none', async () => {
    await assert.rejects(() => tool(readToken, 'cycle_review', { project: 'WEB' }), /No cycle is running/);

    const cycle = await api(`/api/workspaces/${workspaceId}/cycles`, {
      body: { project_id: projectId, name: 'Sprint 1', start_date: isoDay(-2), end_date: isoDay(5) },
    });
    for (const key of ['overdue', 'finished']) {
      await tool(writeToken, 'update_task', { task: tasks[key].identifier, cycle: 'Sprint 1' });
    }

    const review = await tool(readToken, 'cycle_review', { project: 'WEB' });
    assert.equal(review.cycle.name, 'Sprint 1');
    assert.equal(review.totals.tasks, 2);
    assert.equal(review.totals.completed, 1);
    assert.equal(review.totals.carried, 1);
    assert.equal(review.finished, false, 'a cycle ending in five days has not finished');
    assert.equal(review.carried_over[0].identifier, tasks.overdue.identifier);
    // Both were created before the cycle row existed, but *after* its start
    // date, which is what "added after start" means to a burn-up.
    assert.equal(review.added_after_start.length, 2);
  });

  /**
   * The one that matters most. A private project the caller is not a member of
   * must be absent from every workspace-wide report — not merely unlisted, but
   * uncounted, because a total that moves when a private task changes says
   * something about it.
   */
  it('never reports a private project the token cannot see', async () => {
    const secret = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Acquisition', key: 'SEC', visibility: 'private' },
    });
    const secretStates = await api(`/api/workspaces/${workspaceId}/states?project_id=${secret.id}`);
    const hidden = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: {
        project_id: secret.id, title: 'Do not leak me', due_date: isoDay(-1),
        state_id: secretStates.find((s: any) => s.group_key === 'started').id,
      },
    });

    // Ada, who made it, sees it in a workspace-wide report.
    const mine = await tool(writeToken, 'deadlines_at_risk', {});
    assert.ok(mine.at_risk.some((t: any) => t.identifier === hidden.identifier));

    // Grace, who is a member of the workspace but not of that project, must not.
    cookie = '';
    await api('/api/auth/login', { body: { email: 'grace@example.com', password: 'another good password' } });
    const graceToken = (await api('/api/tokens', { body: { name: 'grace', workspaceId, scopes: 'read' } })).token;

    for (const name of ['deadlines_at_risk', 'blocked_tasks', 'stale_tasks', 'workload', 'changes_since']) {
      const report = await tool(graceToken, name, {});
      const text = JSON.stringify(report);
      assert.ok(!text.includes(hidden.identifier), `${name} leaked the private identifier`);
      assert.ok(!text.includes('Do not leak me'), `${name} leaked the private title`);
    }

    // And asking for it by name is refused rather than answered emptily.
    await assert.rejects(() => tool(graceToken, 'cycle_review', { project: 'SEC' }), /private/);
    await assert.rejects(() => tool(graceToken, 'deadlines_at_risk', { project: 'SEC' }), /private/);
  });
});

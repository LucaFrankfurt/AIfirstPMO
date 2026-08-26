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
/* Registration is limited to five per two minutes, on purpose. This file makes
   a fresh workspace per describe block, so it runs into that limit for reasons
   that have nothing to do with what any of these tests are asserting. */
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

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
    resetRateLimits();
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
    resetRateLimits();
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
    // Named a project and got nothing: an error, because the caller asked for
    // something specific.
    await assert.rejects(() => tool(readToken, 'cycle_review', { project: 'WEB' }), /No cycle is running/);
    // Asked the workspace and got nothing: an ordinary Tuesday, answered.
    const quiet = await tool(readToken, 'cycle_review', {});
    assert.equal(quiet.scope, 'workspace');
    assert.deepEqual(quiet.cycles, []);
    assert.equal(quiet.totals.cycles, 0);

    const cycle = await api(`/api/workspaces/${workspaceId}/cycles`, {
      body: { project_id: projectId, name: 'Sprint 1', start_date: isoDay(-2), end_date: isoDay(5) },
    });
    for (const key of ['overdue', 'finished']) {
      await tool(writeToken, 'update_task', { task: tasks[key].identifier, cycle: 'Sprint 1' });
    }

    const review = await tool(readToken, 'cycle_review', { project: 'WEB' });
    assert.equal(review.scope, 'project');
    assert.equal(review.cycles.length, 1);
    const first = review.cycles[0];
    assert.equal(first.cycle.name, 'Sprint 1');
    assert.equal(first.project, 'WEB');
    assert.equal(first.totals.tasks, 2);
    assert.equal(first.totals.completed, 1);
    assert.equal(first.totals.carried, 1);
    assert.equal(first.finished, false, 'a cycle ending in five days has not finished');
    assert.equal(first.carried_over[0].identifier, tasks.overdue.identifier);
    // Both were created before the cycle row existed, but *after* its start
    // date, which is what "added after start" means to a burn-up.
    assert.equal(first.added_after_start.length, 2);

    // The same cycle found without naming a project, and totalled.
    const across = await tool(readToken, 'cycle_review', {});
    assert.equal(across.scope, 'workspace');
    assert.equal(across.cycles.length, 1);
    assert.equal(across.totals.cycles, 1);
    assert.equal(across.totals.tasks, 2);
    assert.equal(across.totals.completed, 1);
  });

  /**
   * The workspace is a first-class scope, not the absence of a project.
   *
   * Two projects, work in both, and one call. Every row has to name the
   * project it is in — reading it off the front of `WEB-42` happens to work
   * and is not something a caller should have to rely on — and the answer has
   * to carry a per-project count, or "which project is on fire" is a question
   * the caller re-aggregates by hand.
   */
  it('answers for the whole workspace, and says which project each row is in', async () => {
    const second = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name: 'Mobile app', key: 'MOB' } });
    const mobStates = await api(`/api/workspaces/${workspaceId}/states?project_id=${second.id}`);
    const late = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: {
        project_id: second.id, title: 'Late in the other project', due_date: isoDay(-4),
        state_id: mobStates.find((s: any) => s.group_key === 'started').id, assignees: [ada],
      },
    });

    const risk = await tool(readToken, 'deadlines_at_risk', {});
    assert.equal(risk.scope, 'workspace');
    assert.equal(risk.project, null);
    // Inclusive rather than exact: registering also seeds a "Getting started"
    // project, and a test that pins the whole list breaks the day the bootstrap
    // changes something this report does not care about.
    for (const key of ['MOB', 'WEB']) assert.ok(risk.projects.includes(key), `${key} is missing from the scope`);

    const ids = risk.at_risk.map((t: any) => t.identifier);
    assert.ok(ids.includes(late.identifier), 'the other project is in a workspace-wide answer');
    assert.ok(ids.includes(tasks.overdue.identifier), 'and so is the first one');

    // Every row names its project, and none of them leaks an internal id.
    for (const task of risk.at_risk) {
      assert.ok(task.project, `row ${task.identifier} does not name its project`);
      assert.equal(task.project, task.identifier.split('-')[0], 'the named project disagrees with the identifier');
      assert.equal(task.project_id, undefined, 'the grouping id is not part of the answer');
    }
    assert.equal(risk.by_project.MOB, 1);
    assert.ok(risk.by_project.WEB >= 1);

    // Narrowing to one project excludes the other, and says so.
    const narrowed = await tool(readToken, 'deadlines_at_risk', { project: 'MOB' });
    assert.equal(narrowed.scope, 'project');
    assert.equal(narrowed.project, 'MOB');
    assert.deepEqual(narrowed.at_risk.map((t: any) => t.identifier), [late.identifier]);

    // And the person-level report splits a workload across projects, because
    // eight tasks in one project and eight across five are different weeks.
    const load = await tool(readToken, 'workload', {});
    const adaRow = load.people.find((p: any) => p.user_id === ada);
    assert.equal(adaRow.by_project.MOB, 1);
    assert.ok(adaRow.by_project.WEB >= 1);
    assert.ok(load.by_project.MOB >= 1);
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

/**
 * A cycle that several projects run together.
 *
 * `cycles.project_id` was `NOT NULL`, so a fortnight three teams shared was
 * three rows with the same name and separately drifting dates — and a burn-up
 * per project of a thing nobody planned per project. Null now means every
 * project, exactly as it already does on a label, so the rule is one somebody
 * has met rather than a second one to learn.
 *
 * What is asserted here is the part that makes it real rather than nominal: a
 * task in *any* project can join it, and the reports narrow it correctly —
 * asked about one project, a shared cycle reports that project's half; asked
 * about the workspace, all of it.
 */
describe('cycles across projects', () => {
  let workspaceId = '';
  let token = '';
  const project: Record<string, any> = {};
  const state: Record<string, Record<string, string>> = {};
  let shared: any = null;

  const openState = async (id: string) => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    return Object.fromEntries(states.map((s: any) => [s.group_key, s.id]));
  };

  it('sets up two projects', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'lin@example.com', name: 'Lin Clark', password: 'a perfectly fine password' },
    });
    workspaceId = session.workspaces[0].id;
    for (const [key, name] of [['ALP', 'Alpha'], ['BET', 'Beta']]) {
      project[key] = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name, key } });
      state[key] = await openState(project[key].id);
    }
    token = (await api('/api/tokens', { body: { name: 'cycles', workspaceId } })).token;
  });

  it('creates a cycle belonging to no project, and lists it under both', async () => {
    shared = await tool(token, 'create_cycle', {
      name: 'Q3 fortnight', start_date: isoDay(-1), end_date: isoDay(10),
    });
    assert.equal(shared.project_id, null, 'a shared cycle belongs to no project');
    assert.equal(shared.scope, 'workspace');

    // Offered to both projects, the way a workspace label is.
    for (const key of ['ALP', 'BET']) {
      const listed = await tool(token, 'list_cycles', { project: key });
      assert.ok(
        listed.result.some((c: any) => c.id === shared.id),
        `the shared cycle is missing from ${key}`,
      );
    }
  });

  it('takes work from both projects', async () => {
    for (const key of ['ALP', 'BET']) {
      await api(`/api/workspaces/${workspaceId}/tasks`, {
        body: {
          project_id: project[key].id, title: `${key} work in the shared fortnight`,
          state_id: state[key].started, cycle_id: shared.id, estimate: 2,
        },
      });
    }
    // One more in Alpha, finished, so the halves are distinguishable.
    const done = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: {
        project_id: project.ALP.id, title: 'Alpha, already done',
        state_id: state.ALP.completed, cycle_id: shared.id, estimate: 3,
      },
    });
    assert.equal(done.cycle_id, shared.id, 'a task in any project may join a shared cycle');
  });

  it('reviews a shared cycle at both scopes, narrowing correctly', async () => {
    const whole = await tool(token, 'cycle_review', {});
    const across = whole.cycles.find((c: any) => c.cycle.id === shared.id);
    assert.ok(across, 'the shared cycle is missing from the workspace review');
    assert.equal(across.cycle_scope, 'workspace');
    assert.equal(across.project, null, 'a shared cycle is not any one project’s');
    assert.deepEqual(across.projects_involved, ['ALP', 'BET']);
    assert.equal(across.totals.tasks, 3);
    assert.equal(across.totals.completed, 1);
    assert.equal(across.totals.points_planned, 7);

    // The same cycle asked about one project: that project's half only.
    const alpha = await tool(token, 'cycle_review', { project: 'ALP' });
    const half = alpha.cycles.find((c: any) => c.cycle.id === shared.id);
    assert.ok(half, 'a shared cycle belongs in its projects’ reviews too');
    assert.deepEqual(half.projects_involved, ['ALP']);
    assert.equal(half.totals.tasks, 2, 'Beta’s task is not Alpha’s business');
    assert.equal(half.totals.completed, 1);
    assert.equal(half.totals.points_planned, 5);
  });

  /**
   * The bug this feature shipped with for an afternoon.
   *
   * Relaxing the column and widening every query made a shared cycle work
   * perfectly over the API — and no client ever saw one. `pull` scopes each
   * entity by project, and `cycle` sat in the group whose rule is
   * `project_id IN (visible)`, which never matches a null. The row existed,
   * the REST and MCP calls returned it, and the Cycles tab of every project
   * was empty of it.
   *
   * Nothing server-side could have caught that, so this asserts the thing the
   * browser actually depends on: the row comes down the sync channel.
   */
  it('sends a shared cycle down the sync channel, or no client ever sees it', async () => {
    const pull = await api<any>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    const cycles = pull.changes.cycle ?? [];
    const row = cycles.find((c: any) => c.id === shared.id);
    assert.ok(row, 'the shared cycle never reached the client');
    assert.equal(row.project_id ?? null, null, 'it arrives still belonging to no project');

    // And the project cycles still come down, so widening the rule did not
    // trade one scope for the other.
    assert.ok(cycles.length >= 1);
  });

  it('still keeps a project cycle to its own project', async () => {
    const own = await tool(token, 'create_cycle', {
      project: 'BET', name: 'Beta only', start_date: isoDay(-1), end_date: isoDay(10),
    });
    assert.equal(own.scope, 'project');

    const alpha = await tool(token, 'list_cycles', { project: 'ALP' });
    assert.ok(!alpha.result.some((c: any) => c.id === own.id), 'Beta’s own cycle is not Alpha’s');
    const beta = await tool(token, 'list_cycles', { project: 'BET' });
    assert.ok(beta.result.some((c: any) => c.id === own.id));
    // And Beta sees both: its own, plus the shared one.
    assert.ok(beta.result.some((c: any) => c.id === shared.id));
  });
});

/**
 * A cycle that covers some projects but not all of them.
 *
 * The two ends of the range — one project, every project — were already
 * expressible, and the middle is the one teams actually ask for: a fortnight
 * that Web and Mobile run together while Platform is on its own schedule.
 *
 * The shape follows `channels.members` rather than inventing a fourth rule: a
 * JSON array where empty means everything. So the assertions worth making are
 * about the boundaries — that a listed project sees it, an unlisted one does
 * not, and that the list normalises (one project is an owner, not a list of
 * one) so the same cycle is not two different rows depending on how it was
 * made.
 */
describe('cycles covering a defined set of projects', () => {
  let workspaceId = '';
  let token = '';
  const project: Record<string, any> = {};
  const state: Record<string, Record<string, string>> = {};
  let some: any = null;
  let betaTask: any = null;

  const openState = async (id: string) => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    return Object.fromEntries(states.map((s: any) => [s.group_key, s.id]));
  };

  it('sets up three projects', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'mira@example.com', name: 'Mira Bell', password: 'a perfectly fine password' },
    });
    workspaceId = session.workspaces[0].id;
    for (const [key, name] of [['ALP', 'Alpha'], ['BET', 'Beta'], ['GAM', 'Gamma']]) {
      project[key] = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name, key } });
      state[key] = await openState(project[key].id);
    }
    token = (await api('/api/tokens', { body: { name: 'subset', workspaceId } })).token;
  });

  it('creates a cycle for exactly two of them', async () => {
    some = await tool(token, 'create_cycle', {
      projects: ['ALP', 'BET'], name: 'Two-team fortnight', start_date: isoDay(-1), end_date: isoDay(10),
    });
    assert.equal(some.scope, 'projects');
    assert.equal(some.project_id, null, 'a cycle covering several projects is owned by none of them');
    assert.deepEqual(
      [...some.projects].sort(),
      [project.ALP.id, project.BET.id].sort(),
      'the projects it covers are stored by id',
    );
  });

  it('is offered to the projects it names and to no others', async () => {
    for (const key of ['ALP', 'BET']) {
      const listed = await tool(token, 'list_cycles', { project: key });
      assert.ok(listed.result.some((c: any) => c.id === some.id), `${key} was named but cannot see it`);
    }
    const gamma = await tool(token, 'list_cycles', { project: 'GAM' });
    assert.ok(
      !gamma.result.some((c: any) => c.id === some.id),
      'Gamma was not named and must not be offered the cycle',
    );
  });

  /**
   * The same regression the workspace-wide cycle shipped with.
   *
   * `pull` scopes every entity by project, and a cycle that belongs to no one
   * project fails the obvious `project_id IN (visible)` rule. Widening it for
   * a null owner is not enough on its own — the `projects` array needs its own
   * `json_each` arm, and nothing but this assertion notices when it is missing,
   * because REST and MCP both answer from queries that have it.
   */
  it('sends a subset cycle down the sync channel', async () => {
    const pull = await api<any>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    const row = (pull.changes.cycle ?? []).find((c: any) => c.id === some.id);
    assert.ok(row, 'the subset cycle never reached the client');
    // An array, not a string: `projects` is declared a json field in the
    // entity registry, so sync hands the client the list rather than the text
    // of one. Asserting that here is what pins it — a client reading
    // `cycle.projects.includes(id)` gets `false` from a string, silently.
    assert.deepEqual(
      [...row.projects].sort(),
      [project.ALP.id, project.BET.id].sort(),
      'it arrives still knowing which projects it covers',
    );
  });

  it('collapses a list of one into an ordinary project cycle', async () => {
    const one = await tool(token, 'create_cycle', {
      projects: ['GAM'], name: 'Gamma alone', start_date: isoDay(-1), end_date: isoDay(10),
    });
    assert.equal(one.scope, 'project', 'a list of one is a project cycle, not a set that happens to hold one');
    assert.equal(one.project_id, project.GAM.id);
    assert.deepEqual(one.projects, [], 'and the list is left empty, so there is one way to say this');

    const alpha = await tool(token, 'list_cycles', { project: 'ALP' });
    assert.ok(!alpha.result.some((c: any) => c.id === one.id));
  });

  it('refuses a project the caller cannot see, rather than quietly covering fewer', async () => {
    await assert.rejects(
      () => tool(token, 'create_cycle', {
        projects: ['ALP', 'NOPE'], name: 'Half a cycle', start_date: isoDay(-1), end_date: isoDay(10),
      }),
      /NOPE/,
    );
  });

  it('refuses `project` and `projects` together rather than picking one', async () => {
    await assert.rejects(
      () => tool(token, 'create_cycle', {
        project: 'ALP', projects: ['BET'], name: 'Which is it', start_date: isoDay(-1), end_date: isoDay(10),
      }),
      /not both/,
    );
  });

  it('takes work from the projects it covers', async () => {
    await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: {
        project_id: project.ALP.id, title: 'Alpha half', state_id: state.ALP.completed,
        cycle_id: some.id, estimate: 2,
      },
    });
    betaTask = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: {
        project_id: project.BET.id, title: 'Beta half', state_id: state.BET.started,
        cycle_id: some.id, estimate: 3,
      },
    });
    assert.equal(betaTask.cycle_id, some.id);
  });

  it('reviews it as a set, naming both the projects it covers and the ones that turned up', async () => {
    const whole = await tool(token, 'cycle_review', {});
    const review = whole.cycles.find((c: any) => c.cycle.id === some.id);
    assert.ok(review, 'a subset cycle is missing from the workspace review');
    assert.equal(review.cycle_scope, 'projects');
    assert.equal(review.project, null);
    assert.deepEqual(review.cycle_projects, ['ALP', 'BET']);
    assert.deepEqual(review.projects_involved, ['ALP', 'BET']);
    assert.equal(review.totals.tasks, 2);
    assert.equal(review.totals.points_planned, 5);

    // Asked about one of its projects, it is that project's half.
    const beta = await tool(token, 'cycle_review', { project: 'BET' });
    const half = beta.cycles.find((c: any) => c.cycle.id === some.id);
    assert.ok(half, 'a covered project reviews the cycle it is running');
    assert.equal(half.totals.tasks, 1, 'Alpha’s half is not Beta’s business');
    assert.deepEqual(half.cycle_projects, ['ALP', 'BET'], 'but it can still see who else is in it');
  });

  it('does not turn up in the review of a project it does not cover', async () => {
    // Gamma has its own cycle running, so this is not "no cycles at all" —
    // it is the narrower claim that the two-team fortnight is not Gamma's.
    const gamma = await tool(token, 'cycle_review', { project: 'GAM' });
    assert.ok(!gamma.cycles.some((c: any) => c.cycle.id === some.id));
    assert.ok(gamma.cycles.some((c: any) => c.cycle.name === 'Gamma alone'));
  });

  /**
   * Re-scoping never removes work.
   *
   * Dropping Beta from the cycle could quietly orphan a task somebody put
   * there on purpose, and data loss as a side effect of an edit is the kind
   * nobody attributes to the right action. The task stays; the caller is told.
   */
  it('reports stranded work when narrowed, and moves none of it', async () => {
    const narrowed = await tool(token, 'update_cycle', { cycle: some.id, projects: ['ALP'] });
    assert.equal(narrowed.scope, 'project');
    assert.equal(narrowed.project_id, project.ALP.id);
    assert.deepEqual(narrowed.stranded_tasks, [betaTask.identifier]);
    assert.match(String(narrowed.note), /Nothing was removed/);

    const still = await api(`/api/tasks/${betaTask.id}`);
    assert.equal(still.cycle_id, some.id, 'the stranded task is still in the cycle');
  });

  /**
   * And it names only the work the caller could have seen anyway.
   *
   * A private project this token is not in may have tasks in the cycle, and
   * `PRIV-42` in a list of stranded work discloses that project as surely as
   * any report would. The projects that can be *named* in a re-scope are
   * already limited to the visible ones; this is the other half of that rule.
   */
  it('leaves a private project’s work out of the list it names', async () => {
    const mira = cookie;
    const secret = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Acquisition', key: 'SEC', visibility: 'private' },
    });
    const secretStates = await openState(secret.id);
    const shared = await tool(token, 'create_cycle', {
      name: 'Everything fortnight', start_date: isoDay(-1), end_date: isoDay(10),
    });
    const hidden = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: secret.id, title: 'Do not leak me', state_id: secretStates.started, cycle_id: shared.id },
    });
    const open = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.GAM.id, title: 'Gamma work', state_id: state.GAM.started, cycle_id: shared.id },
    });

    // Someone in the workspace but not in that project, with a write token.
    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    cookie = '';
    resetRateLimits();
    await api('/api/auth/register', {
      body: { email: 'noor@example.com', name: 'Noor Khan', password: 'another good password' },
    });
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    const noor = (await api('/api/tokens', { body: { name: 'noor', workspaceId } })).token;
    cookie = mira;

    const narrowed = await tool(noor, 'update_cycle', { cycle: shared.id, projects: ['ALP'] });
    assert.deepEqual(narrowed.stranded_tasks, [open.identifier], 'the visible one, and only it');
    assert.ok(!JSON.stringify(narrowed).includes(hidden.identifier), 'the private identifier leaked');
    assert.ok(!JSON.stringify(narrowed).includes('Do not leak me'));

    // Still not moved — invisible to the caller is not the same as removed.
    const still = await api(`/api/tasks/${hidden.id}`);
    assert.equal(still.cycle_id, shared.id);
  });

  it('widens back to a set, and says nothing about stranding when nothing is stranded', async () => {
    const widened = await tool(token, 'update_cycle', { cycle: some.id, projects: ['ALP', 'BET', 'GAM'] });
    assert.equal(widened.scope, 'projects');
    assert.equal(widened.projects.length, 3);
    assert.equal(widened.stranded_tasks, undefined);

    const gamma = await tool(token, 'list_cycles', { project: 'GAM' });
    assert.ok(gamma.result.some((c: any) => c.id === some.id), 'Gamma is in it now');
  });

  it('an empty list opens it to every project', async () => {
    const opened = await tool(token, 'update_cycle', { cycle: some.id, projects: [] });
    assert.equal(opened.scope, 'workspace');
    assert.equal(opened.project_id, null);
    assert.deepEqual(opened.projects, []);
  });
});

/**
 * Modules across projects, and the tools that were missing entirely.
 *
 * A module answers *what is this part of*, and a launch is routinely three
 * projects working towards one date — which was as unsayable as a shared
 * fortnight was. It is scoped exactly as a cycle is now, by the same
 * `coversProject`, so the interesting assertions are the boundaries and the one
 * thing the two features share that neither tested: what happens to a task that
 * moves between projects while it is in a shared one.
 */
describe('modules across projects', () => {
  let workspaceId = '';
  let token = '';
  const project: Record<string, any> = {};
  const state: Record<string, Record<string, string>> = {};
  let launch: any = null;
  let betaTask: any = null;

  const openState = async (id: string) => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    return Object.fromEntries(states.map((s: any) => [s.group_key, s.id]));
  };

  it('sets up three projects', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'grace@kolibri.test', name: 'Grace Chen', password: 'a perfectly fine password' },
    });
    workspaceId = session.workspaces[0].id;
    for (const [key, name] of [['ALP', 'Alpha'], ['BET', 'Beta'], ['GAM', 'Gamma']]) {
      project[key] = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name, key } });
      state[key] = await openState(project[key].id);
    }
    token = (await api('/api/tokens', { body: { name: 'modules', workspaceId } })).token;
  });

  it('creates one that two projects work towards', async () => {
    launch = await tool(token, 'create_module', {
      projects: ['ALP', 'BET'], name: 'Public launch', target_date: isoDay(30), lead: 'Grace Chen',
    });
    assert.equal(launch.scope, 'projects');
    assert.equal(launch.project_id, null);
    assert.deepEqual([...launch.projects].sort(), [project.ALP.id, project.BET.id].sort());
    assert.ok(launch.lead_id, 'the lead was resolved by name');
  });

  it('refuses a lead nobody matches, rather than filing it with none', async () => {
    await assert.rejects(
      () => tool(token, 'create_module', { project: 'ALP', name: 'Nobody home', lead: 'Not A Person' }),
      /Not A Person/,
    );
  });

  it('refuses a milestone due before it starts', async () => {
    await assert.rejects(
      () => tool(token, 'create_module', {
        project: 'ALP', name: 'Backwards', start_date: isoDay(10), target_date: isoDay(2),
      }),
      /before it starts/,
    );
  });

  it('is listed for the projects it names and no others', async () => {
    for (const key of ['ALP', 'BET']) {
      const listed = await tool(token, 'list_modules', { project: key });
      assert.ok(listed.result.some((m: any) => m.id === launch.id), `${key} was named but cannot see it`);
    }
    const gamma = await tool(token, 'list_modules', { project: 'GAM' });
    assert.ok(!gamma.result.some((m: any) => m.id === launch.id), 'Gamma was not named');
  });

  /** The regression the cycle feature shipped with. Same column, same risk. */
  it('sends a shared module down the sync channel', async () => {
    const pull = await api<any>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    const row = (pull.changes.module ?? []).find((m: any) => m.id === launch.id);
    assert.ok(row, 'the shared module never reached the client');
    assert.equal(row.project_id ?? null, null);
    assert.deepEqual([...row.projects].sort(), [project.ALP.id, project.BET.id].sort());
  });

  it('takes work from every project it covers, and counts all of it', async () => {
    await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.ALP.id, title: 'Alpha piece', state_id: state.ALP.completed },
    }).then((task) => tool(token, 'update_task', { task: task.identifier, module: 'Public launch' }));
    betaTask = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.BET.id, title: 'Beta piece', state_id: state.BET.started },
    });
    await tool(token, 'update_task', { task: betaTask.identifier, module: 'Public launch' });

    const listed = await tool(token, 'list_modules', {});
    const row = listed.result.find((m: any) => m.id === launch.id);
    assert.equal(row.total, 2, 'both projects’ work is in the one milestone');
    assert.equal(row.done, 1);

    // And it is filterable, which is the question "what is left before launch".
    const left = await tool(token, 'list_tasks', { module: 'Public launch' });
    assert.equal(left.result.length, 2);
  });

  it('refuses a module nobody recognises instead of answering with everything', async () => {
    await assert.rejects(() => tool(token, 'list_tasks', { module: 'No Such Milestone' }), /not found/);
    await assert.rejects(
      () => tool(token, 'update_task', { task: betaTask.identifier, module: 'No Such Milestone' }),
      /not found/,
    );
  });

  /**
   * The bug both features shared, found while building the second.
   *
   * Moving a task between projects re-checks its cycle and module against the
   * destination, and that check was `project_id = ?` — which a shared row fails
   * by construction, because it has no owner. So a task moved from Alpha to
   * Beta *inside a milestone both projects are working on* was silently taken
   * out of it. Nobody would have attributed that to the move.
   */
  it('keeps a task in a shared module when it moves to another covered project', async () => {
    const cycle = await tool(token, 'create_cycle', {
      projects: ['ALP', 'BET'], name: 'Launch fortnight', start_date: isoDay(-1), end_date: isoDay(10),
    });
    const moving = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.ALP.id, title: 'Moves house', state_id: state.ALP.started, cycle_id: cycle.id },
    });
    await tool(token, 'update_task', { task: moving.identifier, module: 'Public launch' });

    const moved = await api(`/api/tasks/${moving.id}`, { method: 'PATCH', body: { project_id: project.BET.id } });
    assert.equal(moved.project_id, project.BET.id, 'it moved');
    assert.equal(moved.module_id, launch.id, 'and stayed in the module both projects work on');
    assert.equal(moved.cycle_id, cycle.id, 'and in the cycle both projects run');
  });

  it('still drops one that the destination really is outside', async () => {
    const own = await tool(token, 'create_module', { project: 'ALP', name: 'Alpha only' });
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.ALP.id, title: 'Leaves it behind', state_id: state.ALP.started },
    });
    await tool(token, 'update_task', { task: task.identifier, module: 'Alpha only' });

    const moved = await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { project_id: project.GAM.id } });
    assert.equal(moved.module_id ?? null, null, 'Gamma is not in that module, so the task leaves it');
    assert.equal(own.scope, 'project');
  });

  it('reports stranded work when narrowed, and moves none of it', async () => {
    const narrowed = await tool(token, 'update_module', { module: launch.id, projects: ['ALP'] });
    assert.equal(narrowed.scope, 'project');
    assert.ok(narrowed.stranded_tasks.includes(betaTask.identifier), 'Beta’s work is named');
    assert.match(String(narrowed.note), /Nothing was removed/);

    const still = await api(`/api/tasks/${betaTask.id}`);
    assert.equal(still.module_id, launch.id, 'and is still in the module');

    // Widened again, so the delete below releases what it should.
    await tool(token, 'update_module', { module: launch.id, projects: ['ALP', 'BET'] });
  });

  it('deletes it softly, releasing the tasks rather than taking them along', async () => {
    const gone = await tool(token, 'delete_module', { module: 'Public launch' });
    assert.equal(gone.deleted, 'Public launch');
    assert.ok(gone.tasks_released >= 2, 'it says how much work it let go of');

    const still = await api(`/api/tasks/${betaTask.id}`);
    assert.equal(still.title, 'Beta piece', 'the task itself is untouched');
  });
});

/**
 * What a client can attach from Kolibri, which is not the tool list.
 *
 * `resources/list` is the "add from Kolibri" menu, and it took no arguments —
 * so unlike every tool, which accepts `workspace_id` and can be pointed
 * somewhere else, whatever it left out was unreachable from that menu. It
 * listed one workspace's pages: the token's pinned one, or for an unpinned
 * token whichever membership came back first. Somebody in two workspaces saw
 * one of them.
 *
 * `resources/read` had always allowed any workspace in `memberships`, so those
 * pages were readable by URI the whole time and only missing from the list.
 */
describe('the resources a client is offered', () => {
  let token = '';
  let pinned = '';
  const workspace: Record<string, string> = {};

  const rpc = async (name: string, method: string, params: Record<string, unknown> = {}) => {
    const response = await api('/mcp', {
      token: name,
      body: { jsonrpc: '2.0', id: ++rpcId, method, params },
    });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };

  it('sets up two workspaces with a page in each', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'iris@kolibri.test', name: 'Iris Wu', password: 'a perfectly fine password' },
    });
    workspace.first = session.workspaces[0].id;
    workspace.second = (await api('/api/workspaces', { body: { name: 'Second' } })).workspace.id;

    for (const [key, title] of [['first', 'Notes from the first'], ['second', 'Notes from the second']]) {
      await api(`/api/workspaces/${workspace[key]}/pages`, { body: { title, content: `# ${title}` } });
    }
    token = (await api('/api/tokens', { body: { name: 'unpinned' } })).token;
    pinned = (await api('/api/tokens', { body: { name: 'pinned', workspaceId: workspace.second } })).token;
  });

  it('offers pages from every workspace an unpinned token can reach', async () => {
    const { resources } = await rpc(token, 'resources/list');
    const titles = resources.map((r: any) => r.name);
    assert.ok(titles.includes('Notes from the first'), 'the first workspace’s page is missing');
    assert.ok(titles.includes('Notes from the second'), 'the second workspace’s page is missing');

    // Named, because two pages called "Notes" in one flat list are the same
    // row twice as far as the person picking is concerned.
    const one = resources.find((r: any) => r.name === 'Notes from the second');
    assert.match(one.title, /Second/, 'with more than one workspace, each says which it is from');
  });

  it('offers exactly what it lists — the list and the read agree', async () => {
    const { resources } = await rpc(token, 'resources/list');
    for (const resource of resources) {
      const { contents } = await rpc(token, 'resources/read', { uri: resource.uri });
      assert.match(contents[0].text, /^# /, `${resource.uri} was listed and could not be read`);
    }
  });

  it('keeps a pinned token to the workspace it was pinned to', async () => {
    const { resources } = await rpc(pinned, 'resources/list');
    const titles = resources.map((r: any) => r.name);
    assert.deepEqual(titles, ['Notes from the second'], 'a pin is a boundary somebody set on purpose');
    // And with one workspace in play there is nothing to disambiguate.
    assert.ok(!resources[0].title.includes('—'), 'so the title is not padded with a name nobody needs');
  });
});

/**
 * The agenda, the page templates, and the prompts that reach them.
 *
 * `prepare_meeting` is the six reports in the order a meeting runs, and it
 * calls their own `run` rather than repeating their queries — so the assertion
 * that matters is that each section really is the tool's answer, not a second
 * implementation that will drift from it.
 */
describe('preparing a meeting', () => {
  let workspaceId = '';
  let token = '';
  let read = '';
  const project: Record<string, any> = {};
  const state: Record<string, Record<string, string>> = {};

  const openState = async (id: string) => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    return Object.fromEntries(states.map((s: any) => [s.group_key, s.id]));
  };

  it('sets up a workspace with something to talk about', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'omar@kolibri.test', name: 'Omar Diaz', password: 'a perfectly fine password' },
    });
    workspaceId = session.workspaces[0].id;
    for (const [key, name] of [['ONE', 'One'], ['TWO', 'Two']]) {
      project[key] = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name, key } });
      state[key] = await openState(project[key].id);
    }
    // Something finished, something overdue, something nobody is on.
    await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.ONE.id, title: 'Shipped it', state_id: state.ONE.completed },
    });
    await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: project.TWO.id, title: 'Late and nobody on it', state_id: state.TWO.started, due_date: isoDay(-2) },
    });
    token = (await api('/api/tokens', { body: { name: 'agenda', workspaceId } })).token;
    read = (await api('/api/tokens', { body: { name: 'read', workspaceId, scopes: 'read' } })).token;
  });

  it('answers for the whole workspace, in the order a meeting runs', async () => {
    const agenda = await tool(token, 'prepare_meeting', {});
    assert.equal(agenda.scope, 'workspace');
    assert.deepEqual(agenda.projects.includes('ONE') && agenda.projects.includes('TWO'), true);
    assert.equal(agenda.window_days, 7, 'a week, because that is the meeting this is for');
    assert.deepEqual(
      agenda.agenda.map((section: any) => section.report),
      ['changes_since', 'cycle_review', 'deadlines_at_risk', 'blocked_tasks', 'stale_tasks', 'workload'],
    );
    assert.equal(agenda.headline.finished, 1);
    assert.equal(agenda.headline.at_risk, 1);
    // Open work only: the finished one is not somebody's load any more.
    assert.equal(agenda.headline.unassigned, 1, 'the overdue one, which nobody is on');
  });

  /** Composition, not a second implementation — the point of building it this way. */
  it('each section is the report tool’s own answer', async () => {
    const agenda = await tool(token, 'prepare_meeting', {});
    for (const section of agenda.agenda) {
      if (section.report === 'cycle_review') continue; // no cycle running; asserted below
      const direct = await tool(token, section.report, section.report === 'changes_since' || section.report === 'stale_tasks' ? { days: 7 } : {});
      // `since` is stamped from the clock, so two calls milliseconds apart
      // disagree about it and about nothing else. Comparing it would assert
      // that the two ran in the same millisecond, which is not the claim.
      const { since: _a, ...agendaSection } = section.detail;
      const { since: _b, ...directCall } = direct;
      assert.deepEqual(agendaSection, directCall, `${section.report} in the agenda differs from the tool`);
    }
  });

  /**
   * `cycle_review` refuses a project with no cycle running, on purpose. An
   * agenda that asked for whatever is running must not inherit that refusal and
   * take the other five sections down with it.
   */
  it('survives a week with no cycle running', async () => {
    await assert.rejects(() => tool(token, 'cycle_review', { project: 'ONE' }), /No cycle/);
    const agenda = await tool(token, 'prepare_meeting', { project: 'ONE' });
    assert.equal(agenda.scope, 'project');
    assert.equal(agenda.headline.cycles_running, 0);
    assert.equal(agenda.agenda.length, 6, 'and the other five sections are still there');
    assert.match(String(agenda.agenda[1].detail.note), /No cycle is running/);
  });

  it('is read-only, so a read token may prepare one', async () => {
    const agenda = await tool(read, 'prepare_meeting', {});
    assert.ok(agenda.agenda.length);
  });

  it('narrows to a project, and the numbers narrow with it', async () => {
    const one = await tool(token, 'prepare_meeting', { project: 'ONE' });
    assert.equal(one.project, 'ONE');
    assert.equal(one.headline.finished, 1, 'One shipped the thing');
    assert.equal(one.headline.at_risk, 0, 'the overdue one is Two’s');
  });
});

describe('page templates over MCP', () => {
  let workspaceId = '';
  let token = '';
  let templateId = '';

  it('sets up a template and an ordinary page', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'petra@kolibri.test', name: 'Petra Novak', password: 'a perfectly fine password' },
    });
    workspaceId = session.workspaces[0].id;
    const template = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Weekly notes', content: '## Decisions\n\n## Actions\n', icon: '📋' },
    });
    templateId = template.id;
    await api(`/api/pages/${templateId}`, { method: 'PATCH', body: { is_template: 1 } });
    await api(`/api/workspaces/${workspaceId}/pages`, { body: { title: 'Actual handbook', content: '# Handbook' } });
    token = (await api('/api/tokens', { body: { name: 'pages', workspaceId } })).token;
  });

  it('lists the templates, which list_pages now leaves out', async () => {
    const templates = await tool(token, 'list_page_templates', {});
    assert.deepEqual(templates.result.map((t: any) => t.title), ['Weekly notes']);

    // A template is a starting point, not content: summarising "the pages here"
    // should not summarise a half-written form as though somebody meant it.
    const pages = await tool(token, 'list_pages', {});
    assert.deepEqual(pages.result.map((p: any) => p.title), ['Actual handbook']);

    const withThem = await tool(token, 'list_pages', { include_templates: true });
    assert.equal(withThem.result.length, 2);
    assert.equal(withThem.result.find((p: any) => p.title === 'Weekly notes').is_template, 1, 'and says which is which');
  });

  it('copies one into a new page, which is not itself a template', async () => {
    const made = await tool(token, 'create_page_from_template', {
      template: 'Weekly notes', title: 'Notes — Monday',
    });
    assert.equal(made.title, 'Notes — Monday');
    assert.equal(made.from_template, 'Weekly notes');

    const page = await api(`/api/pages/${made.id}`);
    assert.match(page.content, /## Decisions/, 'the body came across');
    assert.equal(page.is_template, 0, 'copying a template must not make another one');
    assert.notEqual(page.id, templateId, 'a copy, not a link');

    // And the template is untouched, which is the thing a link would break.
    const template = await api(`/api/pages/${templateId}`);
    assert.equal(template.title, 'Weekly notes');
    assert.equal(template.is_template, 1);
  });

  it('refuses a template nobody has, and says where to look', async () => {
    await assert.rejects(
      () => tool(token, 'create_page_from_template', { template: 'Does not exist' }),
      /list_page_templates/,
    );
    // An ordinary page is not a template, however much it looks like one.
    await assert.rejects(
      () => tool(token, 'create_page_from_template', { template: 'Actual handbook' }),
      /No page template/,
    );
  });
});

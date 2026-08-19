/**
 * The one part of Kolibri that happens because time passed.
 *
 * Three behaviours, each of which is wrong in a way that is easy to ship: a
 * reminder that repeats every hour, a repeating task that spawns four copies
 * for four missed weeks, and a sweep that re-fires everything after a restart.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-sched-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { sweep, nextDueDate, remindAboutDueTasks, rollRecurringTasks } = await import('../src/lib/scheduler.ts');
const { all, get, run } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let userId = '';

async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await api('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  userId = session.user.id;
  projectId = (await api(`/api/workspaces/${workspaceId}/projects`, { name: 'Sweeping', key: 'SWP' })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const notifications = (kind: string): any[] =>
  all(`SELECT * FROM notifications WHERE user_id = ? AND kind = ?`, userId, kind);

describe('reminding about a due date', () => {
  it('tells the people on a task, once, and not again on the next sweep', async () => {
    await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Nearly due', due_date: day(1), assignees: [userId] });

    assert.equal(remindAboutDueTasks(), 1);
    assert.equal(notifications('due_soon').length, 1);

    // The sweep runs hourly. A reminder that repeats every hour is not a
    // reminder, it is a reason to turn notifications off.
    assert.equal(remindAboutDueTasks(), 0, 'the second sweep says nothing');
    assert.equal(notifications('due_soon').length, 1);
  });

  it('reminds again when the deadline moves, because that is a new deadline', async () => {
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Moving target', due_date: day(1), assignees: [userId] });
    remindAboutDueTasks();
    const first = notifications('due_soon').length;

    await api(`/api/tasks/${task.id}`, { due_date: day(2) }, 'PATCH');
    assert.equal(remindAboutDueTasks(), 1);
    assert.equal(notifications('due_soon').length, first + 1);
  });

  it('says nothing about a task that is already finished', async () => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const done = states.find((state: any) => state.group_key === 'completed');
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Already done', due_date: day(1), assignees: [userId] });
    await api(`/api/tasks/${task.id}`, { state_id: done.id }, 'PATCH');

    const before = notifications('due_soon').length;
    remindAboutDueTasks();
    assert.equal(notifications('due_soon').length, before, 'nothing for a task nobody still has to do');
  });
});

describe('repeating tasks', () => {
  it('reads the shorthand', () => {
    assert.equal(nextDueDate('2026-03-04', 'daily'), '2026-03-05');
    assert.equal(nextDueDate('2026-03-04', 'weekly'), '2026-03-11');
    assert.equal(nextDueDate('2026-03-04', 'weekly:2'), '2026-03-18');
    assert.equal(nextDueDate('2026-01-31', 'monthly'), '2026-02-28', 'the 31st of a short month is its last day');
    assert.equal(nextDueDate('2026-03-04', 'yearly'), null, 'and an unknown unit is not guessed');
  });

  it('creates the next one when the last is finished, not when a date passes', async () => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const done = states.find((state: any) => state.group_key === 'completed');
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Water the plants', due_date: '2026-03-04', recurrence: 'weekly' });

    // Still open: a weekly task nobody did four times is one late task, not
    // four tasks nobody will do.
    assert.equal(rollRecurringTasks(), 0, 'nothing while it is unfinished');

    await api(`/api/tasks/${task.id}`, { state_id: done.id }, 'PATCH');
    assert.equal(rollRecurringTasks(), 1);

    const copies = all<any>(`SELECT * FROM tasks WHERE recurred_from = ?`, task.id);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].due_date, '2026-03-11');
    assert.equal(copies[0].recurrence, 'weekly', 'and it repeats too');
    assert.notEqual(copies[0].state_id, done.id, 'the new one starts open');

    assert.equal(rollRecurringTasks(), 0, 'and finishing the sweep twice makes one copy, not two');
  });
});

describe('a rule that fires because a date is coming', () => {
  it('runs once a day and marks the day it ran', async () => {
    const template = await api(`/api/workspaces/${workspaceId}/templates`, { project_id: projectId, name: 'Chase it', title: 'Chase {identifier}', kind: 'task' });
    const rule = await api(`/api/workspaces/${workspaceId}/automations`, {
        project_id: projectId, name: 'Chase two days out', enabled: 1,
        trigger_kind: 'due_in', trigger_days: 2, template_id: template.id,
        recipients: [{ kind: 'creator' }], fan_out: 'single', link_kind: 'relates_to',
      });
    await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Due in two days', due_date: day(2) });

    const chases = () => all<any>(`SELECT * FROM tasks WHERE title LIKE 'Chase %'`).length;
    const first = sweep();
    // Earlier cases in this file also left a task due in two days, so the rule
    // correctly fires for more than the one created here.
    assert.ok(first.rules >= 1, 'the rule fired');
    const filed = chases();
    assert.ok(filed >= 1, 'and filed a task for each');

    // A restart in the same day must not file them again.
    assert.equal(sweep().rules, 0, 'the sweep remembers the day it ran');
    assert.equal(chases(), filed, 'and nothing was filed twice');

    // Tomorrow it may run again.
    run(`UPDATE automations SET last_run_day = '2000-01-01' WHERE id = ?`, rule.id);
    assert.ok(sweep().rules >= 1, 'a new day sweeps again');
    assert.ok(chases() > filed, 'and files for the same tasks again, because it is a new day');
  });
});

describe('a rule that changes the task instead of filing one', () => {
  it('sets the fields it is allowed to and nothing else', async () => {
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const review = states.find((state: any) => state.name === 'In Review');
    await api(`/api/workspaces/${workspaceId}/automations`, {
        project_id: projectId, name: 'Review is urgent', enabled: 1,
        trigger_kind: 'state_entered', trigger_state_id: review.id,
        action_kind: 'set_fields',
        // `state_id` is not settable: a rule that moves a task can trigger a
        // rule that moves it back.
        action_patch: { priority: 'urgent', state_id: states[0].id },
        recipients: [], fan_out: 'single', link_kind: '',
      });

    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Needs a look' });
    await api(`/api/tasks/${task.id}`, { state_id: review.id }, 'PATCH');

    const after = get<any>(`SELECT * FROM tasks WHERE id = ?`, task.id);
    assert.equal(after.priority, 'urgent', 'the allowed field was set');
    assert.equal(after.state_id, review.id, 'and the forbidden one was ignored');
  });
});

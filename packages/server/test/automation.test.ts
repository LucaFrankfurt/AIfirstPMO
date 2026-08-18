/**
 * Templates and automations, driven over the real API.
 *
 * The interesting cases are not "does it create a task" but the three that make
 * a rule engine either trustworthy or a nuisance: does it refuse to feed
 * itself, does it say so when it decides to do nothing, and do the recipient
 * selectors still mean the right people after the team changes.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-automation-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');

let base = '';
let cookie = '';

async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
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

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('templates and automations', () => {
  let workspaceId = '';
  let projectId = '';
  let states: Record<string, string> = {};
  let adaId = '';
  let linId = '';
  let adaCookie = '';
  let linCookie = '';
  let templateId = '';

  const move = (taskId: string, stateId: string) =>
    api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { state_id: stateId } });

  const tasksIn = async (): Promise<any[]> => api(`/api/workspaces/${workspaceId}/tasks`);

  it('sets up a workspace with two people', async () => {
    const session = await api('/api/auth/register', {
      body: { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' },
    });
    assert.equal(session.user.locale, null, 'no language claimed when none was sent');
    workspaceId = session.workspaces[0].id;
    adaId = session.user.id;
    adaCookie = cookie;

    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    cookie = '';
    await api('/api/auth/register', { body: { email: 'lin@example.com', name: 'Lin', password: 'another good pass' } });
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    linId = (await api('/api/session')).user.id;
    linCookie = cookie;

    cookie = adaCookie;
    const project = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name: 'Website', key: 'WEB' } });
    projectId = project.id;
    const rows = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    states = Object.fromEntries(rows.map((s: any) => [s.name, s.id]));
    assert.ok(states['In Review'], 'the seeded workflow has a review state');
  });

  it('seeds every project with a feedback template and a rule pointing at review', async () => {
    const templates = await api(`/api/workspaces/${workspaceId}/templates?project_id=${projectId}`);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].kind, 'feedback');
    assert.equal(templates[0].subtasks.length, 3, 'the template carries its checklist');
    templateId = templates[0].id;

    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${projectId}`);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enabled, 1);
    assert.equal(rules[0].trigger_state_id, states['In Review']);
    assert.deepEqual(rules[0].recipients, [{ kind: 'lead' }]);
  });

  it('says it did nothing rather than filing a ticket nobody is on', async () => {
    // Ada leads the project and is the one moving the task, and the rule
    // excludes the actor — so there is correctly nobody to ask.
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Solo work' } });
    await move(task.id, states['In Review']);

    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${projectId}`);
    const runs = await api(`/api/automations/${rules[0].id}/runs`);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].skipped, 'no-recipients');
    assert.equal(runs[0].created_task_id, null);
  });

  it('files a feedback task with the checklist when somebody else can take it', async () => {
    // Hand the project to Lin, so the lead and the actor are different people.
    await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { lead_id: linId } });

    const task = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: projectId, title: 'Redesign the pricing page' },
    });
    await move(task.id, states['In Review']);

    const all = await tasksIn();
    const feedback = all.find((row: any) => row.title.startsWith('Feedback:'));
    assert.ok(feedback, 'a feedback task was filed');
    assert.deepEqual(feedback.assignees, [linId], 'it went to the lead, not the person who moved it');
    assert.match(feedback.title, /Redesign the pricing page/, 'placeholders are filled in');
    assert.match(feedback.description, /\/t\//, 'the body links back to the task');
    assert.ok(!feedback.description.includes('{'), 'no placeholder was left unfilled');

    const children = await api(`/api/tasks/${feedback.id}/children`);
    assert.equal(children.length, 3, 'the checklist became sub-tasks');

    const relations = await api(`/api/workspaces/${workspaceId}/relations?task_id=${feedback.id}`);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].related_task_id, task.id, 'linked back to the source');

    // The recipient hears about it the ordinary way.
    cookie = linCookie;
    const inbox = await api(`/api/workspaces/${workspaceId}/notifications`);
    assert.ok(inbox.some((n: any) => n.kind === 'assigned' && n.title.includes(feedback.identifier)));
    cookie = adaCookie;
  });

  it('does not file feedback about its own feedback', async () => {
    const before = (await tasksIn()).length;
    const feedback = (await tasksIn()).find((row: any) => row.title.startsWith('Feedback:'));

    await move(feedback.id, states['In Review']);
    const after = (await tasksIn()).length;
    assert.equal(after, before, 'moving a generated task into review creates nothing');

    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${projectId}`);
    const runs = await api(`/api/automations/${rules[0].id}/runs`);
    assert.equal(runs[0].skipped, 'generated-task', 'and the run log says why');
  });

  it('fires again on a second round unless the rule says once', async () => {
    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${projectId}`);
    const rule = rules[0];
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Second look' } });

    await move(task.id, states['In Review']);
    await move(task.id, states['In Progress']);
    await move(task.id, states['In Review']);
    let filed = (await api(`/api/automations/${rule.id}/runs?limit=50`))
      .filter((r: any) => r.task_id === task.id && r.skipped === '');
    assert.equal(filed.length, 2, 'a second review round asks again');

    await api(`/api/automations/${rule.id}`, { method: 'PATCH', body: { once: 1 } });
    await move(task.id, states.Todo);
    await move(task.id, states['In Review']);
    filed = (await api(`/api/automations/${rule.id}/runs?limit=50`))
      .filter((r: any) => r.task_id === task.id && r.skipped === '');
    assert.equal(filed.length, 2, 'with `once` set it stays at two');
  });

  it('resolves several kinds of recipient at once, and one task each', async () => {
    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${projectId}`);
    await api(`/api/automations/${rules[0].id}`, {
      method: 'PATCH',
      body: { recipients: [{ kind: 'lead' }, { kind: 'user', ref: adaId }], fan_out: 'each', exclude_actor: 0, once: 0 },
    });

    const before = (await tasksIn()).length;
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Fan out' } });
    await move(task.id, states['In Review']);
    const created = (await tasksIn()).length - before - 1;   // minus the task itself
    assert.equal(created, 8, 'two feedback tasks, three sub-tasks each');

    const runs = (await api(`/api/automations/${rules[0].id}/runs?limit=50`))
      .filter((r: any) => r.task_id === task.id && r.skipped === '');
    assert.equal(runs.length, 2, 'one run recorded per recipient');
    const filed = await tasksIn();
    const theirs = runs.map((r: any) => filed.find((row: any) => row.id === r.created_task_id).assignees);
    assert.deepEqual(theirs.map((a: string[]) => a.length), [1, 1], 'each task went to exactly one person');
    assert.deepEqual([...new Set(theirs.flat())].sort(), [adaId, linId].sort());
  });

  it('leaves out somebody who cannot see the project the task lands in', async () => {
    const secret = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Secret plans', key: 'SEC', visibility: 'private' },
    });
    const secretStates = await api(`/api/workspaces/${workspaceId}/states?project_id=${secret.id}`);
    const review = secretStates.find((s: any) => s.name === 'In Review');
    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${secret.id}`);

    // Ask for a person who is not a member of this private project.
    await api(`/api/automations/${rules[0].id}`, {
      method: 'PATCH', body: { recipients: [{ kind: 'user', ref: linId }], exclude_actor: 0 },
    });
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: secret.id, title: 'Quiet work' } });
    await move(task.id, review.id);

    const runs = await api(`/api/automations/${rules[0].id}/runs`);
    assert.equal(runs[0].skipped, 'no-recipients', 'a private project does not leak through a rule');
  });

  it('seeds the starter project in the language the browser signed up with', async () => {
    const saved = cookie;
    cookie = '';
    const session = await api('/api/auth/register', {
      body: { email: 'jonas@example.com', name: 'Jonas', password: 'ein gutes langes passwort', locale: 'de' },
    });
    assert.equal(session.user.locale, 'de');
    const ws = session.workspaces[0].id;
    const [project] = await api(`/api/workspaces/${ws}/projects`);
    assert.equal(project.name, 'Erste Schritte');

    const rows = await api(`/api/workspaces/${ws}/states?project_id=${project.id}`);
    assert.ok(rows.some((s: any) => s.name === 'In Arbeit'), 'the workflow too');
    const [template] = await api(`/api/workspaces/${ws}/templates`);
    assert.equal(template.name, 'Feedback anfordern', 'and the seeded template');
    assert.match(template.subtasks[0], /Aufgabe verlangt/);
    const [rule] = await api(`/api/workspaces/${ws}/automations`);
    assert.match(rule.name, /Feedback anfordern/);

    cookie = saved;
  });

  it('applies a template by hand through the same path', async () => {
    const task = await api(`/api/templates/${templateId}/apply`, {
      method: 'POST', body: { project_id: projectId, assignees: [adaId] },
    });
    assert.match(task.title, /Feedback/);
    assert.deepEqual(task.assignees, [adaId]);
    const children = await api(`/api/tasks/${task.id}/children`);
    assert.equal(children.length, 3, 'by hand you get the checklist too');
    // Nothing was invented for the placeholders it cannot know.
    assert.ok(!task.title.includes('undefined'));
  });

  it('does nothing at all once the rule is switched off', async () => {
    const rules = await api(`/api/workspaces/${workspaceId}/automations?project_id=${projectId}`);
    await api(`/api/automations/${rules[0].id}`, { method: 'PATCH', body: { enabled: 0 } });
    const before = (await tasksIn()).length;
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Quiet now' } });
    await move(task.id, states['In Review']);
    assert.equal((await tasksIn()).length, before + 1, 'only the task itself');
  });
});

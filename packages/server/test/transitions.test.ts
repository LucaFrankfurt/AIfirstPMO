/**
 * Who may move work where.
 *
 * A column can name the roles allowed to receive work. The rule is enforced on
 * the write path rather than in the interface, so it holds for REST, for MCP,
 * and for a phone that was offline while the rule was written.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-transitions-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { mayEnter } from '@kolibri/shared';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let ownerCookie = '';
let memberCookie = '';
let workspaceId = '';
let projectId = '';
let doneStateId = '';
let openStateId = '';
let taskId = '';

async function call(path: string, body?: unknown, method?: string, cookie?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0],
  };
}

const ok = async (path: string, body?: unknown, method?: string, cookie = ownerCookie) => {
  const result = await call(path, body, method, cookie);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
};

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const owner = await call('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  ownerCookie = owner.cookie;
  workspaceId = owner.body.workspaces[0].id;

  const invite = await ok(`/api/workspaces/${workspaceId}/invites`, { role: 'member' });
  resetRateLimits();
  const member = await call('/api/auth/register', {
    email: 'grace@example.com', name: 'Grace', password: 'correct horse battery', invite: invite.code,
  });
  memberCookie = member.cookie;

  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Gated', key: 'GATE' });
  projectId = project.id;
  const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
  openStateId = states[0].id;
  doneStateId = states.find((state: any) => state.group_key === 'completed').id;

  const task = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Sign this off' });
  taskId = task.id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the rule itself', () => {
  it('lets anybody in when nothing is named, and reads a rank rather than a list', () => {
    assert.equal(mayEnter([], 'member'), true, 'no rule is no restriction');
    assert.equal(mayEnter(null, 'member'), true);
    assert.equal(mayEnter(['admin'], 'member'), false);
    assert.equal(mayEnter(['admin'], 'owner'), true, 'an owner outranks the bar rather than needing to be listed');
    assert.equal(mayEnter(['member'], 'admin'), true);
    assert.equal(mayEnter(['member'], 'guest'), false, 'a guest cannot write at all');
  });
});

describe('a column that only admins may fill', () => {
  before(async () => {
    await ok(`/api/states/${doneStateId}`, { allowed_roles: ['admin'] }, 'PATCH');
  });

  it('refuses the move to a member, and says which role is wanted', async () => {
    const refused = await call(`/api/tasks/${taskId}`, { state_id: doneStateId }, 'PATCH', memberCookie);
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /admin/);
    assert.equal(
      get<any>(`SELECT state_id FROM tasks WHERE id = ?`, taskId)?.state_id,
      openStateId,
      'and the task did not move',
    );
  });

  it('allows it to the owner, who outranks the bar', async () => {
    const moved = await ok(`/api/tasks/${taskId}`, { state_id: doneStateId }, 'PATCH');
    assert.equal(moved.state_id, doneStateId);
    assert.ok(moved.completed_at, 'and the completion date still gets set, as for any done column');
  });

  it('refuses the same move over the sync push, with a readable reason', async () => {
    await ok(`/api/tasks/${taskId}`, { state_id: openStateId }, 'PATCH');
    const push = await call('/api/sync/push', {
      workspaceId,
      clientId: 'test-client',
      mutations: [{
        id: 'mutation-1', entity: 'task', entityId: taskId, op: 'upsert',
        patch: { state_id: doneStateId }, hlc: '9999999999999:0000:zzzz',
      }],
    }, 'POST', memberCookie);

    assert.equal(push.status, 200, 'the push itself succeeds — one mutation failing is not a failed push');
    assert.deepEqual(push.body.accepted, []);
    assert.equal(push.body.rejected.length, 1);
    assert.match(push.body.rejected[0].reason, /admin/);
  });

  it('does not stand in the way of the server’s own writes', async () => {
    // An automation, an import or a recurrence rolling a task forward is not a
    // person moving a card, and a rule that blocked those would be a bug.
    const { writeEntity } = await import('../src/kernel/write-path/repo.ts');
    const { serverClock } = await import('../src/kernel/write-path/bootstrap.ts');
    const member = get<any>(`SELECT id FROM users WHERE email = 'grace@example.com'`)!;
    const { row } = writeEntity('task', taskId, { state_id: doneStateId }, {
      workspaceId, actorId: member.id, hlc: serverClock.now(), system: true,
    });
    assert.equal(row.state_id, doneStateId);
  });
});

describe('a work-in-progress limit', () => {
  it('is stored on the column and refuses nothing', async () => {
    const updated = await ok(`/api/states/${openStateId}`, { wip_limit: 2 }, 'PATCH');
    assert.equal(updated.wip_limit, 2);

    // Three tasks into a column limited to two: the number is shown, the write
    // goes through. A board that will not take a card teaches people to work
    // somewhere it cannot see them.
    for (const title of ['One', 'Two', 'Three']) {
      await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title, state_id: openStateId });
    }
    const inColumn = await ok(`/api/workspaces/${workspaceId}/tasks?state_id=${openStateId}`);
    assert.ok(inColumn.length >= 3);
  });
});

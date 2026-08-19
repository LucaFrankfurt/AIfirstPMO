/**
 * Commits that reach the task they name.
 *
 * The URL is the authorisation, so the cases are: an unknown token gets
 * nothing, a payload nobody recognises is accepted and ignored rather than
 * refused, a mention links, "fixes" closes, and a hook scoped to one project
 * cannot touch another.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-inbound-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/db/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let otherProjectId = '';
let hookUrl = '';
let tasks: Record<string, any> = {};

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

/** A push, as GitHub would send it — no session, only the token in the URL. */
const push = (url: string, commits: unknown[]) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ref: 'refs/heads/main', commits }),
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KOLIBRI_PUBLIC_URL = base;

  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Server', key: 'SRV' });
  projectId = project.id;
  const other = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Elsewhere', key: 'ELS' });
  otherProjectId = other.id;

  tasks.one = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Rate limit the API' });
  tasks.two = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Cache the responses' });
  tasks.away = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: otherProjectId, title: 'Not this one' });

  const hook = await ok(`/api/workspaces/${workspaceId}/webhooks`, {
    name: 'GitHub', direction: 'in', project_id: projectId, events: '', enabled: 1,
  });
  const secret = await ok(`/api/webhooks/${hook.id}/secret`);
  // The instance has no public URL configured here, so the endpoint hands back
  // a path — which is the honest answer rather than a guessed hostname.
  hookUrl = secret.url.startsWith('http') ? secret.url : `${base}${secret.url}`;
  resetRateLimits();
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the hook itself', () => {
  it('gets a secret of its own, which is the URL', () => {
    assert.match(hookUrl, /\/api\/hooks\/[A-Za-z0-9_-]{20,}$/);
  });

  it('refuses the secret to somebody who is not an admin here', async () => {
    const hooks = await ok(`/api/workspaces/${workspaceId}/webhooks`);
    const anonymous = await fetch(`${base}/api/webhooks/${hooks[0].id}/secret`);
    assert.equal(anonymous.status, 401);
  });

  it('is not synced to anybody’s device', async () => {
    const hooks = await ok(`/api/workspaces/${workspaceId}/webhooks`);
    assert.equal(hooks[0].secret, undefined, 'the token stays on the server until an admin asks');
    assert.equal(hooks[0].direction, 'in');
  });

  it('answers a token nobody issued with a plain not-found', async () => {
    const response = await push(`${base}/api/hooks/definitely-not-a-token`, [{ message: 'SRV-1 whatever' }]);
    assert.equal(response.status, 404);
  });
});

describe('a push', () => {
  it('comments on the task a commit names', async () => {
    const response = await push(hookUrl, [{
      message: 'SRV-1 add a token bucket\n\nMore detail here.',
      url: 'https://example.com/commit/abc123',
      author: { name: 'Grace Hopper' },
    }]);
    const result = await response.json() as any;
    assert.equal(result.linked, 1);
    assert.equal(result.closed, 0, 'a mention links; it does not finish anything');

    const comments = await ok(`/api/workspaces/${workspaceId}/comments?task_id=${tasks.one.id}`);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Grace Hopper/);
    assert.match(comments[0].body, /add a token bucket/);
    assert.match(comments[0].body, /example\.com\/commit\/abc123/);
    assert.equal(comments[0].body.includes('More detail here'), false, 'the subject line, not the whole message');
  });

  it('moves a task the commit says it fixed', async () => {
    const before = await ok(`/api/tasks/${tasks.two.id}`);
    const response = await push(hookUrl, [{ message: 'fixes SRV-2 — cache for a minute', url: 'https://example.com/c/2' }]);
    const result = await response.json() as any;
    assert.equal(result.closed, 1);

    const after = await ok(`/api/tasks/${tasks.two.id}`);
    assert.notEqual(after.state_id, before.state_id);
    const state = get<any>(`SELECT group_key FROM states WHERE id = ?`, after.state_id);
    assert.equal(state.group_key, 'completed');
    assert.ok(after.completed_at, 'and the completion date comes with it, as for any other move');
  });

  it('leaves a task in another project alone', async () => {
    const response = await push(hookUrl, [{ message: 'fixes ELS-1 while we are here' }]);
    const result = await response.json() as any;
    assert.equal(result.linked, 0, 'the hook is scoped to its project');
    const untouched = await ok(`/api/tasks/${tasks.away.id}`);
    assert.equal(untouched.completed_at, null);
  });

  it('accepts a payload it does not understand rather than refusing it', async () => {
    // A ping, a branch deletion, a release event. Answering with an error
    // trains people to turn the integration off.
    const response = await fetch(hookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zen: 'Non-blocking is better than blocking.', hook_id: 1 }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).ignored, true);
  });

  it('comments once when three commits mention the same task', async () => {
    const before = (await ok(`/api/workspaces/${workspaceId}/comments?task_id=${tasks.one.id}`)).length;
    await push(hookUrl, [
      { message: 'SRV-1 first go', url: 'https://example.com/c/a' },
      { message: 'SRV-1 second go', url: 'https://example.com/c/a' },
      { message: 'SRV-1 third go', url: 'https://example.com/c/a' },
    ]);
    const after = (await ok(`/api/workspaces/${workspaceId}/comments?task_id=${tasks.one.id}`)).length;
    assert.equal(after - before, 1, 'one push, one comment — a rebase should not flood the thread');
  });
});

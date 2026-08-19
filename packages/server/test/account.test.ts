/**
 * The account-security surface: a second factor, the devices signed in, and
 * the workspace's audit trail.
 *
 * The cases that matter are the ones where a half-finished setup or a wrong
 * assumption locks somebody out of their own account.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-account-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { currentCode } = await import('../src/lib/totp.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { get } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let userId = '';

async function call(path: string, body?: unknown, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const ok = async (path: string, body?: unknown, method?: string) => {
  const result = await call(path, body, method);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
};

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  userId = session.user.id;
  resetRateLimits();
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const secret = () => String(get<any>(`SELECT totp_secret FROM users WHERE id = ?`, userId)?.totp_secret ?? '');

describe('a second factor', () => {
  it('does not lock anybody out while the setup is half finished', async () => {
    const started = await ok('/api/me/2fa', {});
    assert.match(started.uri, /^otpauth:\/\/totp\//);
    assert.ok(started.secret.length > 20);

    // The secret is stored but not confirmed, so signing in is unaffected.
    // This is the case that turns a feature into a support ticket.
    cookie = '';
    resetRateLimits();
    const signIn = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' });
    assert.equal(signIn.status, 200, 'an abandoned setup must not gate the door');
  });

  it('is enforced once a working code confirms it', async () => {
    const codes = await ok('/api/me/2fa/confirm', { code: currentCode(secret()) });
    assert.equal(codes.recovery_codes.length, 8);

    cookie = '';
    resetRateLimits();
    const without = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' });
    assert.equal(without.status, 401);
    assert.equal(without.body.error, 'totp_required', 'and says what is missing rather than "wrong password"');

    const wrong = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery', code: '000000' });
    assert.equal(wrong.status, 401);

    const right = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery', code: currentCode(secret()) });
    assert.equal(right.status, 200);
    assert.equal(right.body.user.two_factor, true);
    assert.equal(right.body.user.totp_secret, undefined, 'the secret never leaves the server');
    assert.equal(right.body.user.recovery_codes, undefined);
  });

  it('lets a recovery code in exactly once', async () => {
    const fresh = await ok('/api/session');
    void fresh;
    // A new set, so this case does not depend on the previous one's output.
    await ok('/api/me/2fa/off', { password: 'correct horse battery' });
    await ok('/api/me/2fa', {});
    const { recovery_codes: recovery } = await ok('/api/me/2fa/confirm', { code: currentCode(secret()) });

    cookie = '';
    resetRateLimits();
    const first = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery', code: recovery[0] });
    assert.equal(first.status, 200, 'a recovery code works when the phone does not');

    cookie = '';
    resetRateLimits();
    const again = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery', code: recovery[0] });
    assert.equal(again.status, 401, 'and only once');

    cookie = '';
    resetRateLimits();
    const another = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery', code: recovery[1] });
    assert.equal(another.status, 200, 'while the others still work');
  });

  it('needs the password to turn off, not just the session', async () => {
    const refused = await call('/api/me/2fa/off', { password: 'not it' });
    assert.equal(refused.status, 401, 'a borrowed laptop is not permission to remove the second factor');
    await ok('/api/me/2fa/off', { password: 'correct horse battery' });
    assert.equal((await ok('/api/session')).user.two_factor, false);
  });
});

describe('the devices signed in as you', () => {
  it('lists them, marks this one, and revokes one at a time', async () => {
    resetRateLimits();
    const here = cookie;
    // A second sign-in from "another device".
    cookie = '';
    await ok('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' });
    const elsewhere = cookie;

    cookie = here;
    const sessions = await ok('/api/sessions');
    assert.ok(sessions.length >= 2);
    assert.equal(sessions.filter((row: any) => row.current).length, 1, 'exactly one is this one');
    assert.equal(sessions.some((row: any) => row.token_hash), false, 'and no hashes are handed out');

    const other = sessions.find((row: any) => !row.current);
    await ok(`/api/sessions/${other.id}`, undefined, 'DELETE');

    cookie = elsewhere;
    const dead = await call('/api/session');
    assert.equal(dead.status, 401, 'the revoked device is signed out');

    cookie = here;
    assert.equal((await call('/api/session')).status, 200, 'and this one is not');
  });
});

describe('the workspace audit trail', () => {
  it('answers "what happened here", newest first', async () => {
    const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Audited', key: 'AUD' });
    const task = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Something happened' });
    await ok(`/api/tasks/${task.id}`, { priority: 'urgent' }, 'PATCH');

    const audit = await ok(`/api/workspaces/${workspaceId}/audit`);
    assert.ok(audit.entries.length >= 2);
    assert.equal(audit.entries[0].actor_name, 'Ada', 'the actor is named, not just their id');
    assert.ok(audit.entries.some((row: any) => row.task_identifier === task.identifier));
    for (let index = 1; index < audit.entries.length; index++) {
      assert.ok(audit.entries[index - 1].created_at >= audit.entries[index].created_at, 'newest first');
    }
  });

  it('is not open to ordinary members', async () => {
    const invite = await ok(`/api/workspaces/${workspaceId}/invites`, { role: 'member' });
    const owner = cookie;

    cookie = '';
    resetRateLimits();
    await ok('/api/auth/register', { email: 'lin@example.com', name: 'Lin', password: 'yet another pass' });
    await ok(`/api/invites/${invite.code}/accept`, {});
    const refused = await call(`/api/workspaces/${workspaceId}/audit`);
    assert.equal(refused.status, 403, 'who did what is not something every member browses');

    cookie = owner;
  });
});

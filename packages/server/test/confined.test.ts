/**
 * What a token confined to one workspace can and cannot reach.
 *
 * `api_tokens.workspace_id` has always been a *default* — which workspace a
 * call that names none lands in — and the settings screen said so. It was
 * never a boundary, so a token meant only to file bug reports read every board
 * its owner could.
 *
 * The confinement is enforced by cutting `auth.memberships` down rather than by
 * adding a check to `requireWorkspace`, and the difference is the reason this
 * file exists. `memberships` is not one gate; it is the map twelve gates read.
 * A check inside `requireWorkspace` would look right, pass an obvious test, and
 * leave `GET /files/:hash/*` wide open — because that route asks the map
 * directly, and it is the route that hands over the bytes. The file case below
 * is the one that would catch that regression; the rest would not.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-confined-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
let cookie = '';
/** The workspace the token is confined to, and one the account is also in. */
let home = '';
let other = '';
let confined = '';
let unconfined = '';
let otherHash = '';
let otherTask = '';

const call = async (
  path: string,
  options: { body?: unknown; method?: string; token?: string; cookie?: string } = {},
) => {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.token ? {} : { cookie: options.cookie ?? cookie }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();

  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bot-owner@example.com', name: 'Owner', password: 'correct horse battery' }),
  });
  const session = await register.json() as any;
  cookie = register.headers.get('set-cookie')!.split(';')[0];
  home = session.workspaces[0].id;

  // A second workspace the same account is genuinely a member of. That is the
  // whole point: the confinement has to hold where the *membership* does not.
  other = (await call('/api/workspaces', { body: { name: 'Calendoora' } })).body.workspace.id;

  const project = (await call(`/api/workspaces/${other}/projects`, {
    body: { name: 'The board', key: 'BRD' },
  })).body;
  otherTask = (await call(`/api/workspaces/${other}/tasks`, {
    body: { project_id: project.id, title: 'Q3 revenue' },
  })).body.id;

  const upload = await fetch(`${base}/api/workspaces/${other}/files?task_id=${otherTask}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/webp', 'x-filename': 'board.webp' },
    body: new Uint8Array(Buffer.from('RIFF....WEBPthe other workspace’s screenshot')),
  });
  otherHash = (await upload.json() as any).hash;

  confined = (await call('/api/tokens', {
    body: { name: 'setaside', workspaceId: home, confined: true },
  })).body.token;
  unconfined = (await call('/api/tokens', {
    body: { name: 'ordinary', workspaceId: home },
  })).body.token;
  assert.ok(confined && unconfined && otherHash && otherTask);
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a confined token', () => {
  it('works normally in the workspace it is confined to', async () => {
    const { status } = await call(`/api/workspaces/${home}/tasks`, { token: confined });
    assert.equal(status, 200, 'the confinement swallowed its own workspace');
  });

  it('is refused by a workspace the account is a member of', async () => {
    const { status, body } = await call(`/api/workspaces/${other}/tasks`, { token: confined });
    assert.equal(status, 403, 'the token read a workspace it was confined out of');
    assert.equal(body.error, 'forbidden');
  });

  it('cannot fetch a file from that workspace', async () => {
    // The case that separates "cut the map" from "check in requireWorkspace":
    // this route never calls `requireWorkspace`, it reads `auth.memberships`
    // itself. If the check ever moves, this is the test that fails.
    const response = await fetch(`${base}/files/${otherHash}/board.webp`, {
      headers: { authorization: `Bearer ${confined}` },
    });
    assert.equal(response.status, 403, 'the file route handed over bytes from a confined-out workspace');
  });

  it('does not even see the other workspace in its session', async () => {
    const { body } = await call('/api/session', { token: confined });
    assert.deepEqual(
      body.workspaces.map((w: any) => w.id), [home],
      'a confined token listed workspaces it cannot touch — a name leak, and it makes a client’s own reach check lie',
    );
  });

  it('does not see it over MCP either', async () => {
    const { body } = await call('/mcp', {
      token: confined,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workspaces', arguments: {} } },
    });
    const text = JSON.stringify(body);
    assert.ok(!text.includes(other), `list_workspaces named a confined-out workspace: ${text.slice(0, 300)}`);
    assert.ok(text.includes(home), 'list_workspaces lost the workspace it is allowed to see');
  });

  it('cannot reach that workspace by naming it explicitly over MCP', async () => {
    const { body } = await call('/mcp', {
      token: confined,
      body: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_tasks', arguments: { workspace_id: other } },
      },
    });
    assert.match(JSON.stringify(body), /Not a member of workspace/, 'an explicit workspace argument went around the confinement');
  });

  it('cannot mint a token that escapes it', async () => {
    const { status } = await call('/api/tokens', { token: confined, body: { name: 'escape' } });
    assert.equal(status, 403, 'a confined token issued a credential — the confinement is only as good as this');
  });

  it('cannot get a calendar link, which covers every workspace by design', async () => {
    const { status } = await call('/api/me/calendar', { token: confined, method: 'POST', body: {} });
    assert.equal(status, 403, 'the calendar feed is a second credential and it ignores workspaces');
  });

  it('loses everything if the membership behind it is withdrawn', async () => {
    // Not "fall back to all workspaces". Withdrawing somebody's membership must
    // never be the thing that widens their token.
    const second = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'temp@example.com', name: 'Temp', password: 'correct horse battery' }),
    });
    const theirSession = await second.json() as any;
    const theirCookie = second.headers.get('set-cookie')!.split(';')[0];
    const theirWorkspace = theirSession.workspaces[0].id;

    const { body: invite } = await call(`/api/workspaces/${theirWorkspace}/invites`, {
      cookie: theirCookie, body: { role: 'member' },
    });
    await call(`/api/invites/${invite.code}/accept`, { body: {} });
    const guestToken = (await call('/api/tokens', {
      body: { name: 'guest', workspaceId: theirWorkspace, confined: true },
    })).body.token;
    assert.equal((await call(`/api/workspaces/${theirWorkspace}/tasks`, { token: guestToken })).status, 200);

    const { body: members } = await call(`/api/workspaces/${theirWorkspace}/members`, { cookie: theirCookie });
    const mine = members.find((m: any) => m.email === 'bot-owner@example.com');
    await call(`/api/workspaces/${theirWorkspace}/members/${mine.user_id}`, {
      cookie: theirCookie, method: 'DELETE',
    });

    assert.equal(
      (await call(`/api/workspaces/${theirWorkspace}/tasks`, { token: guestToken })).status, 403,
      'the confinement survived the membership it named',
    );
    const { body: session } = await call('/api/session', { token: guestToken });
    assert.deepEqual(session.workspaces, [], 'an empty map, not a full one');
  });
});

describe('an ordinary token', () => {
  it('still reaches every workspace the account is in', async () => {
    // The regression that protects everybody's existing integration: a token
    // pinned to a workspace but not confined behaves exactly as it always did.
    for (const workspace of [home, other]) {
      const { status } = await call(`/api/workspaces/${workspace}/tasks`, { token: unconfined });
      assert.equal(status, 200, 'a pinned-but-not-confined token lost access it used to have');
    }
  });

  it('still fetches files from either of them', async () => {
    const response = await fetch(`${base}/files/${otherHash}/board.webp`, {
      headers: { authorization: `Bearer ${unconfined}` },
    });
    assert.equal(response.status, 200, 'an unconfined token lost access to a file it could always read');
  });

  it('still lists both in its session', async () => {
    const { body } = await call('/api/session', { token: unconfined });
    assert.equal(body.workspaces.length, 2);
  });
});

describe('minting a token', () => {
  it('cannot hand out more than the caller holds', async () => {
    // `read` used to be a note about intent: the route asked only for a session,
    // and the scopes came out of the body unchecked, so a read-only token wrote
    // itself a read-write one. Measured, not theorised.
    const readOnly = (await call('/api/tokens', {
      body: { name: 'reader', workspaceId: home, scopes: 'read' },
    })).body.token;

    const escalate = await call('/api/tokens', {
      token: readOnly, body: { name: 'promoted', workspaceId: home, scopes: 'read,write' },
    });
    assert.equal(escalate.status, 403, 'a read-only token minted a credential at all');

    const { status } = await call(`/api/workspaces/${home}/tasks`, {
      token: readOnly, body: { title: 'should not exist' },
    });
    assert.equal(status, 403, 'the read-only token could write directly');
  });

  it('keeps write for a caller that has it', async () => {
    const { body } = await call('/api/tokens', { body: { name: 'writer', workspaceId: home, scopes: 'read,write' } });
    assert.match(body.scopes, /write/, 'a session lost the scope it is entitled to');
  });
});

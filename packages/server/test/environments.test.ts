/**
 * Environments, and the two things they are for.
 *
 * The first is ordinary: the same key holds a different value in production
 * than in development. What makes that worth a row rather than a string is the
 * second — a floor on who may open one — and the fact that there is *no
 * fallback* between them.
 *
 * The absence is the load-bearing part, as it was for the vault itself. A
 * process that asks for `production` and receives the `development` value
 * because nobody overrode it has not failed; it has succeeded against the
 * wrong database. So "not found" is the answer, and these tests say so from
 * both directions.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-environments-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { all, run } = await import('../src/kernel/platform/db/index.ts');
const { backfillEnvironments } = await import('../src/kernel/write-path/bootstrap.ts');

let base = '';
const cookies: Record<string, string> = {};

async function api<T = any>(who: string, path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  else if (cookies[who]) headers.cookie = cookies[who];
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const set = response.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

let rpc = 0;
const tool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  api('mcp', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } } })
    .then((response) => {
      if (response.error) throw new Error(response.error.message);
      return response.result.structuredContent;
    });

let workspaceId = '';
let adaToken = '';
let linToken = '';
const env: Record<string, string> = {};

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const ada = await api('ada', '/api/auth/register', {
    body: { email: 'ada@env.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspaceId = ada.workspaces[0].id;
  adaToken = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId } })).token;

  const invite = await api('ada', `/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
  resetRateLimits();
  await api('lin', '/api/auth/register', {
    body: { email: 'lin@env.test', name: 'Lin', password: 'another fine password' },
  });
  await api('lin', `/api/invites/${invite.code}/accept`, { body: {} });
  linToken = (await api('lin', '/api/tokens', { body: { name: 'lin', workspaceId } })).token;

  for (const row of await api('ada', `/api/workspaces/${workspaceId}/environments`)) env[row.name] = row.id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a workspace comes with four', () => {
  it('is seeded with the words the infrastructure register already uses', () => {
    // Not `prod`/`dev`: a component sits in `production`, so a credential does
    // too. One vocabulary, seeded from `ENVIRONMENTS`.
    assert.deepEqual(Object.keys(env).sort(), ['development', 'production', 'shared', 'staging']);
  });

  it('gives them to a workspace that predates them, once', () => {
    run(`DELETE FROM environments WHERE workspace_id = ?`, workspaceId);
    backfillEnvironments();
    const after = all<any>(`SELECT name FROM environments WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId);
    assert.equal(after.length, 4, 'the backfill did not seed an empty workspace');
    backfillEnvironments();
    assert.equal(
      all<any>(`SELECT id FROM environments WHERE workspace_id = ?`, workspaceId).length, 4,
      'running it twice seeded a second set',
    );
    // Put the ids back for everything below.
    for (const row of all<any>(`SELECT id, name FROM environments WHERE workspace_id = ?`, workspaceId)) {
      env[String(row.name)] = String(row.id);
    }
  });

  it('folds a name into something a command line can carry', async () => {
    const made = await api('ada', `/api/workspaces/${workspaceId}/environments`, { body: { name: '  Staging EU!  ' } });
    assert.equal(made.name, 'staging-eu');
    await api('ada', `/api/environments/${made.id}`, { method: 'DELETE' });
  });

  it('refuses a second environment of the same name', async () => {
    await assert.rejects(
      () => api('ada', `/api/workspaces/${workspaceId}/environments`, { body: { name: 'production' } }),
      /already has an environment/,
    );
  });

  it('is an administrator’s to set up', async () => {
    await assert.rejects(
      () => api('lin', `/api/workspaces/${workspaceId}/environments`, { body: { name: 'qa' } }),
      /administrator/,
    );
    // The sharp case: lowering the floor is what a member must not be able to do.
    await assert.rejects(
      () => api('lin', `/api/environments/${env.production}`, { method: 'PATCH', body: { min_role: 'member' } }),
      /administrator/,
    );
  });
});

describe('the same key, a different value', () => {
  it('holds one name twice when the environments differ', async () => {
    for (const where of ['production', 'development']) {
      const made = await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
        body: { name: 'STRIPE_KEY', kind: 'api_key', environment_id: env[where], value: `sk-${where}` },
      });
      assert.equal(made.environment_id, env[where]);
    }
  });

  it('refuses the same name twice in one environment', async () => {
    // CAP-5 asks for a secret to be identified by (scope, environment, key).
    // Without this a CLI resolving `STRIPE_KEY` in production has a choice to
    // make and no way to make it.
    await assert.rejects(
      () => api('ada', `/api/workspaces/${workspaceId}/secrets`, {
        body: { name: 'STRIPE_KEY', kind: 'api_key', environment_id: env.production, value: 'sk-again' },
      }),
      /already exists here/,
    );
  });

  it('still allows the name once more with no environment at all', async () => {
    // Which is a different statement: the same everywhere, rather than the
    // production one. Null is not a wildcard, so it collides with neither.
    const made = await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
      body: { name: 'STRIPE_KEY', kind: 'api_key', value: 'sk-everywhere' },
    });
    assert.equal(made.environment_id, null);
  });

  it('does not fall back from one environment to another', async () => {
    await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
      body: { name: 'ONLY_IN_DEV', kind: 'password', environment_id: env.development, value: 'dev-only' },
    });
    const production = await tool(adaToken, 'list_secrets', { environment: 'production' });
    assert.equal(production.secrets.some((one: any) => one.name === 'ONLY_IN_DEV'), false,
      'a value defined only in development answered a question about production');
    const development = await tool(adaToken, 'list_secrets', { environment: 'development' });
    assert.ok(development.secrets.some((one: any) => one.name === 'ONLY_IN_DEV'));
  });

  it('refuses a filter naming an environment that does not exist', async () => {
    // Rather than reporting an empty vault, which an assistant would repeat.
    await assert.rejects(() => tool(adaToken, 'list_secrets', { environment: 'prod' }), /No environment/);
  });

  it('counts what exists, including the environments holding nothing', async () => {
    const answer = await tool(adaToken, 'list_secrets');
    assert.equal(answer.by_environment.production, 1);
    assert.equal(answer.by_environment.development, 2);
    assert.equal(answer.by_environment.staging, 0, 'an empty environment must read as empty, not as absent');
    assert.equal(answer.by_environment.none, 1);
  });
});

describe('a floor on who may open one', () => {
  before(async () => {
    await api('ada', `/api/environments/${env.production}`, { method: 'PATCH', body: { min_role: 'admin' } });
  });

  it('keeps a member out of every door at once', async () => {
    const secret = all<any>(
      `SELECT id FROM secrets WHERE workspace_id = ? AND environment_id = ?`, workspaceId, env.production,
    )[0].id;

    await assert.rejects(() => api('lin', `/api/secrets/${secret}`), 'the single-row read let a member in');
    await assert.rejects(() => api('lin', `/api/secrets/${secret}/reveal`, { body: {} }), 'the reveal let a member in');

    const listed = await api('lin', `/api/workspaces/${workspaceId}/secrets`);
    assert.equal(listed.some((row: any) => row.environment_id === env.production), false, 'the listing let one through');

    const mcp = await tool(linToken, 'list_secrets');
    assert.equal(mcp.secrets.some((one: any) => one.environment === 'production'), false, 'MCP let a member in');
  });

  it('does not mirror one to a member’s device', async () => {
    const pull = await api('lin', `/api/sync/pull?workspace=${workspaceId}&since=0`);
    const secrets: any[] = pull.changes.secret ?? [];
    // The guard first: an empty pull would pass the assertion below while
    // proving nothing at all about the clause it is testing.
    assert.ok(secrets.length, 'the pull carried no secrets, so this proved nothing');
    assert.equal(secrets.some((row) => row.environment_id === env.production), false,
      'a member’s device mirrored the name of something kept in an admin-only environment');
    assert.doesNotMatch(JSON.stringify(pull), /sk-production/, 'a value reached a device');

    // And an administrator's does, so the clause is a floor rather than a wall.
    const mine = await api('ada', `/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.ok((mine.changes.secret ?? []).some((row: any) => row.environment_id === env.production));
  });

  it('still lets an administrator in', async () => {
    const mcp = await tool(adaToken, 'list_secrets', { environment: 'production' });
    assert.equal(mcp.secrets.length, 1);
    assert.equal(mcp.secrets[0].environment, 'production');
  });

  it('refuses a member writing into one they cannot open', async () => {
    await assert.rejects(
      () => api('lin', `/api/workspaces/${workspaceId}/secrets`, {
        body: { name: 'SNEAKY', kind: 'password', environment_id: env.production, value: 'x' },
      }),
      /not yours to write into/,
    );
  });
});

describe('renaming and deleting', () => {
  it('renames freely, because everything points at the id', async () => {
    const renamed = await api('ada', `/api/environments/${env.staging}`, { method: 'PATCH', body: { name: 'preprod' } });
    assert.equal(renamed.name, 'preprod');
    await api('ada', `/api/environments/${env.staging}`, { method: 'PATCH', body: { name: 'staging' } });
  });

  it('refuses to delete one that still holds something', async () => {
    // The alternative is a secret in an environment that no longer exists:
    // invisible in every filter and refused by every reader, which is a vault
    // quietly losing rows rather than warning about them.
    await assert.rejects(
      () => api('ada', `/api/environments/${env.development}`, { method: 'DELETE' }),
      /still holds 2 secret/,
    );
  });

  it('deletes one that is empty', async () => {
    await api('ada', `/api/environments/${env.shared}`, { method: 'DELETE' });
    const left = await api('ada', `/api/workspaces/${workspaceId}/environments`);
    assert.equal(left.some((row: any) => row.name === 'shared'), false);
  });
});

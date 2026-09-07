/**
 * The vault, and the six places a value must not appear.
 *
 * The encryption is the easy half and it is not what these are about. What
 * makes a secret manager worth having over a page is a set of *absences* — the
 * value is not in a synced row, not in an export, not in the search index, not
 * in an MCP answer, not in a listing, not in a colleague's reach — and an
 * absence is exactly the kind of property that holds on the day it is written
 * and quietly stops holding two features later.
 *
 * So each one is a test. They read like paranoia and they are the specification.
 *
 * The seventh was found by asking rather than by reading, and it is not about
 * the value at all: the log the vault keeps of who read what is an ordinary
 * table, and two report tools were reading it. See the block at the bottom.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-secrets-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { get, run } = await import('../src/kernel/platform/db/index.ts');

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

const VALUE = 'sk-live-4f2a-do-not-paste-this-anywhere';
const PERSONAL = 'my-own-recovery-code-9911';

let workspaceId = '';
let shared = '';
let mine = '';
let adaToken = '';
let linToken = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const ada = await api('ada', '/api/auth/register', {
    body: { email: 'ada@vault.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspaceId = ada.workspaces[0].id;
  adaToken = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId } })).token;

  const invite = await api('ada', `/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
  resetRateLimits();
  await api('lin', '/api/auth/register', {
    body: { email: 'lin@vault.test', name: 'Lin', password: 'another fine password' },
  });
  await api('lin', `/api/invites/${invite.code}/accept`, { body: {} });
  linToken = (await api('lin', '/api/tokens', { body: { name: 'lin', workspaceId } })).token;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('keeping one', () => {
  it('takes one call, because a value cannot be written offline', async () => {
    // The two-call version — create the row, then seal a value into it — asked
    // the server about a row the device had only written locally. It answered
    // `Secret not found` and left an orphan behind on every retry.
    const row = await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
      body: { name: 'Stripe live key', kind: 'api_key', access: 'workspace', value: VALUE },
    });
    shared = row.id;
    assert.equal(row.value, undefined, 'a created row must not echo a value field at all');
    assert.equal(row.preview, '••••here', 'the answer is a mask, not the value');
    assert.ok(row.rotated_at, 'and the row says when it was set');
  });

  it('refuses a secret with no value rather than keeping an empty one', async () => {
    await assert.rejects(
      () => api('ada', `/api/workspaces/${workspaceId}/secrets`, { body: { name: 'Empty' } }),
      'an empty secret was kept',
    );
  });

  it('is encrypted in the database rather than stored', () => {
    const stored = String(get<any>(`SELECT value FROM secrets WHERE id = ?`, shared).value);
    assert.doesNotMatch(stored, /sk-live/, 'the value is readable in the table');
    assert.match(stored, /^v1\./, 'and it is sealed the way everything else here is');
  });

  it('comes back to somebody who may read it, and says so in the log', async () => {
    const revealed = await api('ada', `/api/secrets/${shared}/reveal`, { body: {} });
    assert.equal(revealed.value, VALUE);
    const history = await api('ada', `/api/secrets/${shared}/history`);
    assert.equal(history.entries[0].verb, 'revealed');
    assert.equal(history.entries[0].actor_name, 'Ada');
    assert.equal(history.entries.at(-1).verb, 'set', 'and the first thing that ever happened to it');
  });

  it('rotates through a route of its own, and says so', async () => {
    const put = await api('ada', `/api/secrets/${shared}/value`, { method: 'PUT', body: { value: `${VALUE}-v2` } });
    assert.equal(put.preview, '••••e-v2');
    const history = await api('ada', `/api/secrets/${shared}/history`);
    assert.equal(history.entries[0].verb, 'rotated', 'the second write is a rotation, not a set');
    // Put it back, so what follows is measuring the value it was given.
    await api('ada', `/api/secrets/${shared}/value`, { method: 'PUT', body: { value: VALUE } });
  });

  it('refuses a rotation from a read-only token but still reveals to one', async () => {
    const readOnly = (await api('ada', '/api/tokens', { body: { name: 'ro', workspaceId, scopes: ['read'] } })).token;
    await assert.rejects(
      () => api('t', `/api/secrets/${shared}/value`, { method: 'PUT', body: { value: 'x' }, token: readOnly }),
      'a read-only token rotated a secret',
    );
    assert.equal((await api('t', `/api/secrets/${shared}/reveal`, { body: {}, token: readOnly })).value, VALUE);
  });
});

describe('a private one', () => {
  it('is created by its author', async () => {
    mine = (await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
      body: { name: 'Recovery codes', kind: 'note', access: 'private', value: PERSONAL },
    })).id;
  });

  it('is not revealed to a colleague, and not even named', async () => {
    await assert.rejects(() => api('lin', `/api/secrets/${mine}/reveal`, { body: {} }));
    await assert.rejects(() => api('lin', `/api/secrets/${mine}`), 'the label was readable');
  });

  it('is not in a colleague’s listing', async () => {
    const listed = await api('lin', `/api/workspaces/${workspaceId}/secrets`);
    const names = listed.map((row: any) => row.name);
    assert.equal(names.includes('Recovery codes'), false, 'a private secret was listed');
    assert.equal(names.includes('Stripe live key'), true, 'and the shared one still is');
  });

  it('keeps its name out of the audit log', async () => {
    await api('ada', `/api/secrets/${mine}/reveal`, { body: {} });
    const log = await api('ada', `/api/workspaces/${workspaceId}/audit`);
    const entries = log.entries.filter((row: any) => row.secret_id === mine);
    assert.ok(entries.length, 'the reveal was recorded');
    assert.equal(entries[0].new_value, null, 'a private secret’s name reached the admin log');
    // ...while a shared one's name is there, because anybody reading this log
    // could have read the secret itself.
    assert.ok(log.entries.some((row: any) => row.secret_id === shared && row.new_value === 'Stripe live key'));
  });

  it('cannot be turned into a project secret without a project', async () => {
    // `project` on a secret belonging to no project would read as "the project
    // it is in" and fall through to the whole workspace.
    const row = await api('ada', `/api/secrets/${mine}`, { method: 'PATCH', body: { access: 'project' } });
    assert.equal(row.access, 'private');
  });
});

describe('the six places a value must not be', () => {
  it('is not in a synced row', async () => {
    const pull = await api('ada', `/api/sync/pull?workspace=${workspaceId}&since=0`);
    const text = JSON.stringify(pull);
    assert.doesNotMatch(text, /sk-live/, 'the value reached a device');
    assert.match(text, /Stripe live key/, 'and the label still does, so the list works offline');
  });

  it('is not in a REST row', async () => {
    const row = await api('ada', `/api/secrets/${shared}`);
    assert.equal(row.value, undefined);
    assert.doesNotMatch(JSON.stringify(row), /sk-live/);
  });

  it('is not in the search index', () => {
    const hit = get<any>(`SELECT count(*) AS n FROM search_index WHERE body LIKE '%sk-live%' OR title LIKE '%Stripe live%'`);
    assert.equal(hit.n, 0, 'a secret was indexed');
  });

  it('is not findable by search', async () => {
    const found = await api('ada', `/api/workspaces/${workspaceId}/search?q=Stripe`);
    assert.doesNotMatch(JSON.stringify(found), /sk-live/);
  });

  it('is not in a workspace export', async () => {
    const doc = await api('ada', `/api/workspaces/${workspaceId}/export`);
    const text = JSON.stringify(doc);
    assert.doesNotMatch(text, /sk-live/, 'the value is in the export file');
    assert.doesNotMatch(text, /my-own-recovery-code/, 'the private value is in the export file');
  });

  it('is not reachable over MCP, however many tools grow beside it', async () => {
    /*
     * This asserted that no tool is named /secret/i at all, which held until
     * `list_secrets` was asked for. The absence it was really guarding is the
     * one below: a *value* has no tool, no argument and no route through MCP,
     * and `list_secrets` is read-only labels. Naming the exception is the
     * point — the next tool to match this pattern fails the case.
     */
    const response = await api('mcp', '/mcp', {
      token: adaToken,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    const vault = response.result.tools.filter((tool: any) => /secret/i.test(tool.name));
    assert.deepEqual(vault.map((tool: any) => tool.name), ['list_secrets'], 'MCP grew a second secret tool');
    assert.equal(vault[0].annotations.readOnlyHint, true, 'the one secret tool is not read-only');
    // On the names, not on the descriptions: `list_secrets` says of itself
    // that there is no tool which reveals a value, and a sweep over the whole
    // document caught that sentence — which is a check measuring its own
    // prose. Names are what a client can call.
    const names = response.result.tools.map((one: any) => one.name);
    assert.deepEqual(names.filter((name: string) => /reveal|unseal|decrypt|rotate/i.test(name)), []);
    assert.deepEqual(Object.keys(vault[0].inputSchema.properties).filter((arg) => /value|secret|reveal/i.test(arg)), []);
  });
});

describe('the seventh place, which is not about the value at all', () => {
  /*
   * Every absence above is about the value, and no value ever reached MCP.
   * What reached it was the *log*: the vault records each set and each reveal
   * in `activities`, and two report tools read that table without knowing
   * whose rows they were.
   *
   * `changes_since` answered "what did we get done last week" with
   * `revealed:secret: 2`, counted against the person who did it. `project_status`
   * was worse — a secret kept under a project put its name in the project's
   * last twenty changes: `revealed · secret · Stripe live key · Ada`.
   *
   * Nothing there was decryptable and it was still the surface docs/secrets.md
   * says there is none of. An assistant that can name your credentials is a
   * transcript that names your credentials.
   *
   * The two tools are the ones that read `activities` today. The clause they
   * share is on `secret_id`, so a third that joins the table is the thing to
   * watch — which is what the last case here is for.
   */
  let projectId = '';

  it('has a project with a secret of its own, read once', async () => {
    const project = await api('ada', `/api/workspaces/${workspaceId}/projects`, { body: { name: 'Payments', key: 'PAY' } });
    projectId = project.id;
    const scoped = await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
      body: { name: 'Stripe live key', kind: 'api_key', access: 'project', project_id: projectId, value: VALUE },
    });
    assert.equal(scoped.project_id, projectId, 'the secret is filed under the project');
    await api('ada', `/api/secrets/${scoped.id}/reveal`, { body: {} });
  });

  it('is not in a project status report', async () => {
    const status = await tool(adaToken, 'project_status', { project: 'PAY' });
    const text = JSON.stringify(status.recent_activity);
    assert.doesNotMatch(text, /Stripe live key/, 'a report named a secret');
    assert.doesNotMatch(text, /"secret"/, 'a report carried a vault entry');
  });

  it('is not counted in what changed', async () => {
    // The tool returns early when the workspace has no project at all, so this
    // is only worth anything with the one above created: a null result that
    // never ran the query proves nothing.
    const changed = await tool(adaToken, 'changes_since');
    assert.equal(changed.scope, 'workspace');
    assert.deepEqual(Object.keys(changed.by_kind).filter((kind) => /secret/i.test(kind)), []);
    assert.doesNotMatch(JSON.stringify(changed), /Stripe live key/);
  });

  it('is in the audit log, which is where it belongs', async () => {
    const log = await api('ada', `/api/workspaces/${workspaceId}/audit`);
    const reveals = log.entries.filter((row: any) => row.verb === 'revealed');
    assert.ok(reveals.length >= 3, 'the admin log lost the reveals it is for');
    assert.ok(reveals.some((row: any) => row.new_value === 'Stripe live key'));
  });

  it('leaves no vault row reachable through any read-only tool', async () => {
    /*
     * The two above are the queries known to have leaked. This one asks every
     * read-only tool the same question at once, because the next one will not
     * be a query somebody remembered to come back and test.
     */
    const listed = await api('mcp', '/mcp', { token: adaToken, body: { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} } });
    // `readOnly` is not a field of the wire shape — it is `annotations.readOnlyHint`,
    // and reading the wrong one is how the first sweep of this came back clean.
    const readOnly = listed.result.tools.filter((one: any) => one.annotations?.readOnlyHint).map((one: any) => one.name);
    assert.ok(readOnly.length > 10, 'the tool list came back empty, so this proved nothing');
    for (const name of readOnly) {
      let answer = '';
      // A tool that needs an argument we have not got is not a surface.
      try { answer = JSON.stringify(await tool(adaToken, name, name === 'project_status' ? { project: 'PAY' } : {})); } catch { continue; }
      assert.doesNotMatch(answer, /sk-live/, `${name} answered with a value`);
      assert.doesNotMatch(answer, /••••/, `${name} answered with a mask`);
      // The one tool that is allowed to name one, by name rather than by a
      // count — the next tool to do it is a decision somebody has to make here.
      if (name === 'list_secrets') continue;
      assert.doesNotMatch(answer, /Stripe live key|Recovery codes/, `${name} named a secret`);
      assert.doesNotMatch(answer, /"(set|revealed|rotated):?secret"|:secret\b/, `${name} carried a vault entry`);
    }
  });
});

describe('list_secrets, the one thing an assistant may know', () => {
  /*
   * The relaxation of "no MCP surface, not even a list of names", and the
   * cases are mostly about what it still refuses. Labels answer "which of our
   * credentials has nobody rotated since the contractor left", which is the
   * question a vault exists for and the one no screen answers for somebody who
   * is not looking at a screen. Everything past a label stays behind the
   * screen the credential is kept on.
   */
  it('lists what exists, with the rotation each one is due', async () => {
    const answer = await tool(adaToken, 'list_secrets');
    const names = answer.secrets.map((one: any) => one.name);
    assert.ok(names.includes('Stripe live key'), 'the workspace secret is missing');
    assert.equal(answer.total, answer.secrets.length);

    const stripe = answer.secrets.find((one: any) => one.name === 'Stripe live key' && one.access === 'workspace');
    assert.equal(stripe.kind, 'api_key');
    assert.equal(stripe.kept_by, 'Ada', 'a name rather than a user id, which is what a reader has');
    assert.equal(stripe.rotation, 'unset', 'nobody asked for a cadence, and that is a state and not a failure');
    assert.match(stripe.last_rotated, /^\d{4}-\d{2}-\d{2}T/, 'a date a model can read');
    // Written by the reveal route, and the reason it is worth carrying: a
    // credential nobody has read in a year is one to ask about.
    assert.match(stripe.last_used, /^\d{4}-\d{2}-\d{2}T/, 'the reveals above left no mark');
  });

  it('answers with no value and no mask, in any of its shapes', async () => {
    for (const args of [{}, { kind: 'api_key' }, { access: 'workspace' }, { rotation: 'stale' }, { include_archived: true }]) {
      const text = JSON.stringify(await tool(adaToken, 'list_secrets', args));
      assert.doesNotMatch(text, /sk-live/, `a value came back for ${JSON.stringify(args)}`);
      // `maskSecret` is four real characters of a credential. The REST listing
      // does not carry it either — only the two write routes echo it, to the
      // person who just typed the value in.
      assert.doesNotMatch(text, /••••|preview/, `a mask came back for ${JSON.stringify(args)}`);
    }
  });

  it('shows a private secret to the person who kept it, and to nobody else', async () => {
    const hers = await tool(adaToken, 'list_secrets', { access: 'private' });
    assert.ok(hers.secrets.some((one: any) => one.name === 'Recovery codes'), 'her own private one is missing');
    const theirs = await tool(linToken, 'list_secrets');
    assert.equal(theirs.secrets.some((one: any) => one.name === 'Recovery codes'), false, 'a private secret was listed to a colleague');
    assert.ok(theirs.secrets.some((one: any) => one.name === 'Stripe live key'), 'and the shared one still is');
  });

  it('puts what is late first, and counts it', async () => {
    // Aged in the table rather than by waiting: `rotated_at` is server-written,
    // so there is no route that could set this and no clock to move.
    const late = await api('ada', `/api/workspaces/${workspaceId}/secrets`, {
      body: { name: 'Contractor database password', kind: 'password', access: 'workspace', rotate_after_days: 90, value: 'ancient-and-shared' },
    });
    run(`UPDATE secrets SET rotated_at = ? WHERE id = ?`, Date.now() - 400 * 86_400_000, late.id);

    const answer = await tool(adaToken, 'list_secrets');
    assert.equal(answer.secrets[0].name, 'Contractor database password', 'the overdue one is not the first line');
    assert.equal(answer.secrets[0].rotation, 'overdue');
    assert.ok(answer.secrets[0].days_until_rotation < -300, 'and says how long it has been');
    assert.equal(answer.overdue, 1);

    const stale = await tool(adaToken, 'list_secrets', { rotation: 'stale' });
    assert.deepEqual(stale.secrets.map((one: any) => one.name), ['Contractor database password']);
  });

  it('narrows to a project, and refuses a project the token cannot see', async () => {
    const scoped = await tool(adaToken, 'list_secrets', { project: 'PAY' });
    assert.deepEqual(scoped.secrets.map((one: any) => one.project), ['Payments']);
    await assert.rejects(() => tool(linToken, 'list_secrets', { project: 'nothing by that name' }));
  });

  it('refuses a guest rather than showing them an empty vault', async () => {
    // The same refusal the REST listing makes, for the same reason: a guest is
    // in the workspace, so an empty list would read as a fact about it. A
    // guest who mints themselves a token has not stopped being a guest.
    const invite = await api('ada', `/api/workspaces/${workspaceId}/invites`, { body: { role: 'guest' } });
    resetRateLimits();
    await api('gil', '/api/auth/register', { body: { email: 'gil@vault.test', name: 'Gil', password: 'a fourth fine password' } });
    await api('gil', `/api/invites/${invite.code}/accept`, { body: {} });
    const gilToken = (await api('gil', '/api/tokens', { body: { name: 'gil', workspaceId } })).token;
    await assert.rejects(() => tool(gilToken, 'list_secrets'), /members of the workspace/);
  });
});

describe('a guest', () => {
  let guestToken = '';

  it('is invited to the workspace as a guest', async () => {
    const invite = await api('ada', `/api/workspaces/${workspaceId}/invites`, { body: { role: 'guest' } });
    resetRateLimits();
    await api('gus', '/api/auth/register', {
      body: { email: 'gus@vault.test', name: 'Gus', password: 'a third fine password' },
    });
    await api('gus', `/api/invites/${invite.code}/accept`, { body: {} });
    guestToken = (await api('gus', '/api/tokens', { body: { name: 'gus', workspaceId } })).token;
  });

  it('is refused the vault rather than shown an empty one', async () => {
    // An empty list would read as a fact about the workspace. They are in it.
    await assert.rejects(() => api('gus', `/api/workspaces/${workspaceId}/secrets`));
  });

  it('does not receive a single secret through sync', async () => {
    const pull = await api('gus', `/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.doesNotMatch(JSON.stringify(pull), /Stripe live key/, 'a guest’s device mirrored the vault');
  });

  it('cannot reveal one it has the id of', async () => {
    await assert.rejects(() => api('g', `/api/secrets/${shared}/reveal`, { body: {}, token: guestToken }));
  });
});

describe('a page is not listed to somebody it is private from', () => {
  /*
   * Not about secrets, and here because the vault is what found it: the
   * collection route guarded a single page read and never the listing beside
   * it, so `GET /api/workspaces/:ws/pages` handed a colleague every private
   * page in the workspace. Same rule, same clause, and now the same test.
   */
  it('holds for pages the way it holds for secrets', async () => {
    await api('ada', `/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Pay review', content: 'the first draft', access: 'private' },
    });
    const listed = await api('lin', `/api/workspaces/${workspaceId}/pages`);
    assert.equal(listed.some((row: any) => row.title === 'Pay review'), false);
    assert.equal((await api('ada', `/api/workspaces/${workspaceId}/pages`)).some((row: any) => row.title === 'Pay review'), true);
  });
});

void linToken;

/**
 * Incidents over the wire: the switch, the number, the record the server keeps
 * on its own, who may see any of it, and the tools an assistant runs an outage
 * through.
 *
 * The part worth the length is what the server writes without being asked —
 * the number, the resolution stamps and the `change` lines on the timeline —
 * because each of those is a figure a review rests on, and each is one a
 * client could otherwise have claimed. A test that only checked the screens
 * would pass while every incident resolved itself whenever a laptop's clock
 * said so.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-incident-api-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';

interface Person { id: string; cookie: string; token: string }

async function call(path: string, options: { cookie?: string; token?: string; body?: unknown; method?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.get('set-cookie') };
}

async function ok<T = any>(path: string, options: Parameters<typeof call>[1] = {}): Promise<T> {
  const result = await call(path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await ok('/mcp', {
    token, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  if (response.result?.isError) throw new Error(`${name}: ${response.result.content?.[0]?.text ?? 'failed'}`);
  return response.result.structuredContent;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

async function register(email: string): Promise<{ person: Person; workspace: string }> {
  resetRateLimits();
  const result = await call('/api/auth/register', {
    body: { email, name: email.split('@')[0], password: 'correct horse battery' },
  });
  if (result.status >= 400) throw new Error(`register ${email}: ${result.body?.message}`);
  const cookie = result.setCookie!.split(';')[0];
  const workspace = result.body.workspaces[0].id;
  const { token } = await ok('/api/tokens', { cookie, body: { name: 'mcp', workspaceId: workspace } });
  return { person: { id: result.body.user.id, cookie, token }, workspace };
}

/** A second person, in the same workspace. */
async function join(email: string, workspace: string, owner: Person, role = 'member'): Promise<Person> {
  const { person } = await register(email);
  const invite = await ok(`/api/workspaces/${workspace}/invites`, {
    cookie: owner.cookie, body: { email, role },
  });
  await ok(`/api/invites/${invite.code}/accept`, { cookie: person.cookie, body: {} });
  const { token } = await ok('/api/tokens', { cookie: person.cookie, body: { name: 'mcp', workspaceId: workspace } });
  return { ...person, token };
}

const switchOn = (workspace: string, owner: Person) =>
  ok(`/api/workspaces/${workspace}`, { cookie: owner.cookie, method: 'PATCH', body: { features: { incidents: true } } });

// Spread into plain objects: SQLite hands rows back with a null prototype.
const changeLines = (incidentId: string) => all<any>(
  `SELECT field, old_value, new_value FROM incident_updates WHERE incident_id = ? AND kind = 'change' AND deleted_at IS NULL
    ORDER BY occurred_at, created_at`,
  incidentId,
).map((row) => ({ ...row }));

describe('the feature switch', () => {
  it('refuses every incident tool while incidents are off, and works once switched on', async () => {
    const { person, workspace } = await register('inc-switch@example.com');
    await assert.rejects(() => tool(person.token, 'list_incidents'), /switched off/);
    await assert.rejects(() => tool(person.token, 'create_incident', { summary: 'Nope' }), /switched off/);
    await switchOn(workspace, person);
    const listed = await tool(person.token, 'list_incidents');
    assert.deepEqual(listed.incidents, []);
  });
});

describe('the number', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('inc-number@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  it('counts per workspace, and a client cannot choose it', async () => {
    const first = await ok(`/api/workspaces/${workspace}/incidents`, {
      cookie: owner.cookie, body: { summary: 'Shop down', number: 99, identifier: 'INC-99' },
    });
    const second = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'VPN slow' } });
    assert.equal(first.identifier, 'INC-1');
    assert.equal(first.number, 1);
    assert.equal(second.identifier, 'INC-2');
  });

  it('never hands a deleted incident’s number out again', async () => {
    const doomed = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'Doomed' } });
    assert.equal(doomed.identifier, 'INC-3');
    await ok(`/api/incidents/${doomed.id}`, { cookie: owner.cookie, method: 'DELETE' });
    const next = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'After' } });
    assert.equal(next.identifier, 'INC-4');
  });

  it('starts again at one in another workspace', async () => {
    const other = await register('inc-number-2@example.com');
    await switchOn(other.workspace, other.person);
    const made = await ok(`/api/workspaces/${other.workspace}/incidents`, { cookie: other.person.cookie, body: { summary: 'Elsewhere' } });
    assert.equal(made.identifier, 'INC-1');
  });
});

describe('what the server writes on its own', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('inc-record@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  it('suggests a priority from impact × urgency, and keeps one that was given', async () => {
    const suggested = await ok(`/api/workspaces/${workspace}/incidents`, {
      cookie: owner.cookie, body: { summary: 'Payments failing', impact: 'high', urgency: 'high' },
    });
    assert.equal(suggested.priority, 'p1');
    assert.ok(suggested.detected_at > 0, 'a new incident was noticed by now at the latest');
    const given = await ok(`/api/workspaces/${workspace}/incidents`, {
      cookie: owner.cookie, body: { summary: 'Typo on a page', impact: 'high', urgency: 'high', priority: 'p4' },
    });
    assert.equal(given.priority, 'p4');
  });

  it('stamps resolution from the status, and takes the stamp back when it comes back', async () => {
    const made = await ok(`/api/workspaces/${workspace}/incidents`, {
      cookie: owner.cookie, body: { summary: 'Login loop', started_at: Date.now() - 3_600_000 },
    });
    assert.equal(made.resolved_at, null);
    const forged = await ok(`/api/incidents/${made.id}`, {
      cookie: owner.cookie, method: 'PATCH', body: { resolved_at: 1, closed_at: 1 },
    });
    assert.equal(forged.resolved_at, null, 'a client claimed a resolution');

    const resolved = await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'resolved' } });
    assert.ok(resolved.resolved_at > 0);
    assert.ok(resolved.ended_at > 0, 'resolving with the impact still open ends it');
    assert.equal(resolved.closed_at, null);

    const back = await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'investigating' } });
    assert.equal(back.resolved_at, null, 'an incident that came back was not resolved');

    const closed = await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'closed' } });
    assert.ok(closed.resolved_at > 0 && closed.closed_at > 0);
  });

  it('writes the status, priority and manager moves onto the timeline', async () => {
    const lin = await join('inc-record-lin@example.com', workspace, owner);
    const made = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'Disk full' } });
    await ok(`/api/incidents/${made.id}`, {
      cookie: owner.cookie, method: 'PATCH', body: { status: 'investigating', priority: 'p2', manager_id: lin.id },
    });
    // An edit that moves nothing tracked writes nothing.
    await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { description: 'df says 100%' } });
    const lines = changeLines(made.id);
    assert.deepEqual(lines.map((line) => line.field), ['status', 'status', 'priority', 'manager_id']);
    assert.deepEqual(lines[0], { field: 'status', old_value: null, new_value: 'new' });
    assert.deepEqual(lines[1], { field: 'status', old_value: 'new', new_value: 'investigating' });
    assert.equal(lines[3].new_value, lin.id);
  });

  it('refuses a change line from a client, and an edit of somebody else’s update', async () => {
    const lin = await join('inc-record-lin2@example.com', workspace, owner);
    const made = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'Mail delayed' } });
    const forged = await call(`/api/workspaces/${workspace}/incident-updates`, {
      cookie: owner.cookie, body: { incident_id: made.id, kind: 'change', field: 'status', new_value: 'resolved' },
    });
    assert.equal(forged.status, 403);

    const mine = await ok(`/api/workspaces/${workspace}/incident-updates`, {
      cookie: owner.cookie, body: { incident_id: made.id, body: 'Looking at the queue' },
    });
    assert.equal(mine.author_id, owner.id);
    assert.equal(mine.kind, 'update');
    const theirs = await call(`/api/incident-updates/${mine.id}`, {
      cookie: lin.cookie, method: 'PATCH', body: { body: 'Nothing to see' },
    });
    assert.equal(theirs.status, 403);

    const opened = get<any>(`SELECT id FROM incident_updates WHERE incident_id = ? AND kind = 'change'`, made.id);
    const rewrite = await call(`/api/incident-updates/${opened.id}`, {
      cookie: owner.cookie, method: 'PATCH', body: { new_value: 'closed' },
    });
    assert.equal(rewrite.status, 403, 'a change line was rewritten');
  });

  it('keeps people to members, and applications to this workspace’s list', async () => {
    const guest = await join('inc-record-guest@example.com', workspace, owner, 'guest');
    const app = await ok(`/api/workspaces/${workspace}/applications`, { cookie: owner.cookie, body: { name: 'CRM', criticality: 'critical' } });
    const made = await ok(`/api/workspaces/${workspace}/incidents`, {
      cookie: owner.cookie,
      body: { summary: 'CRM down', manager_id: guest.id, responders: [owner.id, guest.id], applications: [app.id, 'not-a-thing'] },
    });
    assert.equal(made.manager_id, null, 'a guest was made manager of something they cannot open');
    assert.deepEqual(made.responders, [owner.id]);
    assert.deepEqual(made.applications, [app.id]);
  });
});

describe('who may see an incident', () => {
  let owner: Person;
  let guest: Person;
  let workspace = '';
  let incidentId = '';

  before(async () => {
    const made = await register('inc-seen@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    guest = await join('inc-seen-guest@example.com', workspace, owner, 'guest');
    incidentId = (await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'Secret outage' } })).id;
  });

  it('sends a guest none of it at the pull', async () => {
    const { body } = await call(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: guest.cookie });
    assert.equal((body.changes?.incident ?? []).length, 0);
    assert.equal((body.changes?.incidentUpdate ?? []).length, 0);
    const mine = await call(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: owner.cookie });
    assert.ok((mine.body.changes?.incident ?? []).some((row: any) => row.id === incidentId));
  });

  it('refuses a guest at the REST door and over MCP', async () => {
    assert.equal((await call(`/api/workspaces/${workspace}/incidents`, { cookie: guest.cookie })).status, 403);
    assert.equal((await call(`/api/incidents/${incidentId}`, { cookie: guest.cookie })).status, 403);
    await assert.rejects(() => tool(guest.token, 'list_incidents'), /members of the workspace/);
  });
});

describe('who is told', () => {
  let owner: Person;
  let lin: Person;
  let workspace = '';

  before(async () => {
    const made = await register('inc-told@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('inc-told-lin@example.com', workspace, owner);
  });

  const inbox = (who: Person) => all<any>(`SELECT kind, incident_id FROM notifications WHERE user_id = ?`, who.id);

  it('tells the new manager, and nobody twice', async () => {
    const made = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'Queue stuck', priority: 'p3' } });
    await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { manager_id: lin.id } });
    await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { description: 'still stuck' } });
    const told = inbox(lin).filter((row) => row.incident_id === made.id);
    assert.deepEqual(told.map((row) => row.kind), ['incident']);
  });

  it('tells every member about a P1, once', async () => {
    const made = await ok(`/api/workspaces/${workspace}/incidents`, { cookie: owner.cookie, body: { summary: 'Everything down', priority: 'p1' } });
    await ok(`/api/incidents/${made.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'investigating' } });
    const told = inbox(lin).filter((row) => row.incident_id === made.id && row.kind === 'incident_major');
    assert.equal(told.length, 1);
    assert.equal(inbox(owner).filter((row) => row.incident_id === made.id).length, 0, 'the person who opened it was told');
  });
});

describe('the tools an assistant runs an outage through', () => {
  let owner: Person;
  let lin: Person;
  let workspace = '';

  before(async () => {
    const made = await register('inc-tools@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('inc-tools-lin@example.com', workspace, owner);
  });

  it('opens, updates, resolves and reports', async () => {
    const opened = await tool(owner.token, 'create_incident', {
      summary: 'Checkout returns 500',
      impact: 'high',
      urgency: 'medium',
      applications: ['Shop', 'Payments'],
      manager: 'inc-tools-lin@example.com',
      started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      financial_impact: '12 500,00',
      currency: 'eur',
      first_update: 'Investigating elevated error rates',
    });
    assert.equal(opened.identifier, 'INC-1');
    assert.equal(opened.priority, 'p2');
    assert.deepEqual(opened.applications, ['Shop', 'Payments']);
    assert.equal(opened.manager, 'inc-tools-lin');
    assert.equal(opened.financial_impact_minor, 1_250_000);
    assert.equal(opened.currency, 'EUR');
    assert.ok(opened.timeline.some((line: any) => line.kind === 'update' && line.text === 'Investigating elevated error rates'));

    const apps = await tool(owner.token, 'list_applications');
    assert.deepEqual(apps.applications.map((app: any) => app.name).sort(), ['Payments', 'Shop']);
    const again = await tool(owner.token, 'create_application', { name: 'shop', criticality: 'critical' });
    assert.equal(again.name, 'Shop', 'a case-different name made a second application');
    assert.equal(again.criticality, 'critical');

    const moved = await tool(owner.token, 'add_incident_update', {
      incident: 'inc-1', body: 'Rolled back the deploy', status: 'monitoring',
    });
    assert.equal(moved.status, 'monitoring');

    const resolved = await tool(owner.token, 'resolve_incident', {
      incident: '#1', resolution_code: 'rolled_back', resolution: 'Rolled back release 4.2', root_cause: 'A missing index',
    });
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolved_at > 0);
    assert.notEqual(resolved.time_to_resolve, '—');

    const report = await tool(owner.token, 'incident_report', { days: 7 });
    assert.equal(report.total, 1);
    assert.equal(report.awaitingReview, 1);
    assert.equal(report.byPriority.p2, 1);
    assert.deepEqual(report.cost.map((one: any) => [one.currency, one.amount]), [['EUR', 1_250_000]]);
    assert.equal(report.unpriced, 0);

    const active = await tool(owner.token, 'list_incidents');
    assert.equal(active.incidents.length, 0);
    const review = await tool(owner.token, 'list_incidents', { state: 'review' });
    assert.deepEqual(review.incidents.map((one: any) => one.identifier), ['INC-1']);
    void lin;
  });

  it('files a follow-up and a review, and links both', async () => {
    const project = await ok(`/api/workspaces/${workspace}/projects`, { cookie: owner.cookie, body: { name: 'Platform', key: 'PLT' } });
    const follow = await tool(owner.token, 'create_incident_follow_up', {
      incident: 'INC-1', project: project.key, title: 'Add the missing index',
    });
    assert.match(follow.task.identifier, /^PLT-\d+$/);

    const review = await tool(owner.token, 'write_incident_review', { incident: 'INC-1' });
    assert.equal(review.rewritten, false);
    const page = get<any>(`SELECT title, content FROM pages WHERE id = ?`, review.page_id);
    assert.match(page.title, /INC-1 Checkout returns 500/);
    assert.match(page.content, /A missing index/);
    assert.match(page.content, /PLT-\d+ Add the missing index/);

    const again = await tool(owner.token, 'write_incident_review', { incident: 'INC-1' });
    assert.equal(again.rewritten, true);
    assert.equal(again.page_id, review.page_id);

    const full = await tool(owner.token, 'get_incident', { incident: 'INC-1' });
    assert.equal(full.tasks.length, 1);
    assert.equal(full.pages.length, 1);
    assert.equal(full.pages[0].id, review.page_id);
  });

  it('refuses a status nobody has heard of, rather than filing it as new', async () => {
    await assert.rejects(() => tool(owner.token, 'update_incident', { incident: 'INC-1', status: 'exploded' }), /status is one of/);
    await assert.rejects(() => tool(owner.token, 'get_incident', { incident: 'INC-404' }), /No incident/);
  });
});

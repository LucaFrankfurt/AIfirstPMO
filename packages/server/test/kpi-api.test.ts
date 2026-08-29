/**
 * KPIs over the wire: the switch, the scale the server will not take a
 * client's word for, the two cascades that go opposite ways, and who may see a
 * number.
 *
 * The cascades are the half worth the length. Deleting a KPI takes its readings
 * and targets with it, because a measurement of a metric nobody keeps is not
 * evidence of anything on its own. Deleting a *milestone* does the opposite and
 * leaves the targets standing, because cancelling a release does not cancel the
 * promise. Getting either backwards is silent: nothing errors, rows simply
 * stop existing or stop meaning what they said.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-kpi-api-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/db/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';

interface Person { cookie: string; token: string }

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
  return { person: { cookie, token }, workspace };
}

describe('the feature switch', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('kpi-switch@example.com');
    me = made.person;
    workspace = made.workspace;
  });

  it('refuses every KPI tool while KPIs are off', async () => {
    await assert.rejects(() => tool(me.token, 'list_kpis'), /switched off/);
    await assert.rejects(() => tool(me.token, 'create_kpi', { name: 'Nope' }), /switched off/);
  });

  it('works once an admin switches them on', async () => {
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { kpi: true } } });
    const listed = await tool(me.token, 'list_kpis');
    assert.deepEqual(listed.kpis, []);
  });
});

describe('the scale the server settles', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('kpi-scale@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { kpi: true } } });
  });

  it('clamps decimals rather than storing an exponent nobody meant', async () => {
    /*
     * Not a fussy validation. `decimals` is the exponent every value on the KPI
     * is scaled by, so a wild one does not make one figure slightly wrong — it
     * moves the decimal point on every reading and every target at once.
     */
    const made = await ok(`/api/workspaces/${workspace}/kpis`, {
      cookie: me.cookie, body: { name: 'Silly', decimals: 17 },
    });
    assert.equal(made.decimals, 4);
    const negative = await ok(`/api/workspaces/${workspace}/kpis`, {
      cookie: me.cookie, body: { name: 'Also silly', decimals: -3 },
    });
    assert.equal(negative.decimals, 0);
  });

  it('falls back on an enum it has never heard of', async () => {
    const made = await ok(`/api/workspaces/${workspace}/kpis`, {
      cookie: me.cookie,
      body: { name: 'From the future', unit: 'furlongs', direction: 'sideways', cadence: 'fortnightly' },
    });
    assert.equal(made.unit, 'number');
    assert.equal(made.direction, 'up');
    assert.equal(made.cadence, 'monthly');
  });

  it('gives a reading with no date today rather than no day at all', async () => {
    const kpi = await ok(`/api/workspaces/${workspace}/kpis`, { cookie: me.cookie, body: { name: 'Dated' } });
    const reading = await ok(`/api/workspaces/${workspace}/kpi-readings`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, value: 5 },
    });
    assert.match(reading.measured_on, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('reads a measurement at the KPI’s own scale over MCP', async () => {
    const kpi = await tool(me.token, 'create_kpi', { name: 'Uptime', unit: 'percent', decimals: 2 });
    const recorded = await tool(me.token, 'record_measurement', { kpi: 'Uptime', value: '99,95' });
    assert.equal(recorded.value_text, '99.95 %');
    const status = await tool(me.token, 'kpi_status', { kpi: kpi.id });
    assert.equal(status.value, 9995, 'stored as an integer, not a float');
  });

  it('refuses a value it cannot read rather than storing zero', async () => {
    await tool(me.token, 'create_kpi', { name: 'Fussy' });
    await assert.rejects(() => tool(me.token, 'record_measurement', { kpi: 'Fussy', value: 'lots' }), /not a number/);
  });
});

describe('what a client may point at', () => {
  let me: Person;
  let mine = '';
  let stranger: Person;
  let theirs = '';
  let theirKpi = '';

  before(async () => {
    const made = await register('kpi-scope-a@example.com');
    me = made.person;
    mine = made.workspace;
    await ok(`/api/workspaces/${mine}`, { cookie: me.cookie, method: 'PATCH', body: { features: { kpi: true } } });

    const other = await register('kpi-scope-b@example.com');
    stranger = other.person;
    theirs = other.workspace;
    await ok(`/api/workspaces/${theirs}`, { cookie: stranger.cookie, method: 'PATCH', body: { features: { kpi: true } } });
    const kpi = await ok(`/api/workspaces/${theirs}/kpis`, { cookie: stranger.cookie, body: { name: 'Theirs' } });
    theirKpi = kpi.id;
  });

  it('refuses a reading pointed at a KPI in another workspace', async () => {
    /*
     * `kpi_id` was missing from `SCOPED_REFERENCES`, so nothing checked it —
     * and `followKpiWorkspace` then *relocated* the row into the workspace it
     * pointed at. The result was a member of one workspace writing a row into
     * another, attached to a KPI they cannot read. The equivalent budget
     * request has always been refused; this is that check.
     */
    const result = await call(`/api/workspaces/${mine}/kpi-readings`, {
      cookie: me.cookie, body: { kpi_id: theirKpi, measured_on: '2026-06-01', value: 1 },
    });
    assert.ok(result.status >= 400, `expected a refusal, got ${result.status}`);
    const landed = all(`SELECT id FROM kpi_readings WHERE kpi_id = ?`, theirKpi);
    assert.equal(landed.length, 0, 'and nothing was written into the other workspace');
  });

  it('refuses a target pointed at a KPI in another workspace', async () => {
    const result = await call(`/api/workspaces/${mine}/kpi-targets`, {
      cookie: me.cookie, body: { kpi_id: theirKpi, value: 1, due_on: '2026-12-31' },
    });
    assert.ok(result.status >= 400, `expected a refusal, got ${result.status}`);
  });

  it('refuses a target pointed at a milestone in another workspace', async () => {
    const projects = await ok(`/api/workspaces/${theirs}/projects`, { cookie: stranger.cookie });
    const module = await ok(`/api/workspaces/${theirs}/modules`, {
      cookie: stranger.cookie, body: { project_id: projects[0].id, name: 'Theirs too' },
    });
    const kpi = await ok(`/api/workspaces/${mine}/kpis`, { cookie: me.cookie, body: { name: 'Mine' } });
    const result = await call(`/api/workspaces/${mine}/kpi-targets`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, value: 1, module_id: module.id },
    });
    assert.ok(result.status >= 400, `expected a refusal, got ${result.status}`);
  });

  it('takes a null value as zero rather than throwing the batch away', async () => {
    /*
     * `value` is NOT NULL, so a null did not store a slightly wrong figure — it
     * threw inside the write and took down the whole sync push it arrived in.
     * A correction, like every other invariant here.
     */
    const kpi = await ok(`/api/workspaces/${mine}/kpis`, { cookie: me.cookie, body: { name: 'Nullable' } });
    const reading = await ok(`/api/workspaces/${mine}/kpi-readings`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, measured_on: '2026-06-01', value: null },
    });
    assert.equal(reading.value, 0);
    const target = await ok(`/api/workspaces/${mine}/kpi-targets`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, value: null },
    });
    assert.equal(target.value, 0);
  });

  it('keeps a baseline nullable, because null means something there', async () => {
    const kpi = await ok(`/api/workspaces/${mine}/kpis`, {
      cookie: me.cookie, body: { name: 'No baseline', baseline: null },
    });
    assert.equal(kpi.baseline, null, 'nobody has said where it started');
  });
});

describe('the two cascades', () => {
  let me: Person;
  let workspace = '';
  let project = '';

  before(async () => {
    const made = await register('kpi-cascade@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { kpi: true } } });
    const projects = await ok(`/api/workspaces/${workspace}/projects`, { cookie: me.cookie });
    project = projects[0].id;
  });

  it('takes a KPI’s readings and targets with it', async () => {
    const kpi = await ok(`/api/workspaces/${workspace}/kpis`, { cookie: me.cookie, body: { name: 'Doomed' } });
    const reading = await ok(`/api/workspaces/${workspace}/kpi-readings`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, measured_on: '2026-06-01', value: 5 },
    });
    const target = await ok(`/api/workspaces/${workspace}/kpi-targets`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, value: 10, due_on: '2026-12-31' },
    });

    await ok(`/api/kpis/${kpi.id}`, { cookie: me.cookie, method: 'DELETE' });
    assert.ok(get(`SELECT deleted_at FROM kpi_readings WHERE id = ?`, reading.id)?.deleted_at, 'the reading goes');
    assert.ok(get(`SELECT deleted_at FROM kpi_targets WHERE id = ?`, target.id)?.deleted_at, 'the target goes');
  });

  it('leaves a deleted milestone’s targets standing, and undated', async () => {
    /*
     * The opposite cascade, on purpose. Cancelling a release does not cancel
     * the promise: "we want 90% uptime" outlives the milestone it was hung on,
     * and deleting the target with the module would quietly retire a
     * commitment nobody decided to drop.
     */
    const module = await ok(`/api/workspaces/${workspace}/modules`, {
      cookie: me.cookie, body: { project_id: project, name: 'Ship it', target_date: '2026-09-30' },
    });
    const kpi = await ok(`/api/workspaces/${workspace}/kpis`, { cookie: me.cookie, body: { name: 'Survivor' } });
    const target = await ok(`/api/workspaces/${workspace}/kpi-targets`, {
      cookie: me.cookie, body: { kpi_id: kpi.id, value: 90, module_id: module.id },
    });

    await ok(`/api/modules/${module.id}`, { cookie: me.cookie, method: 'DELETE' });
    const after = get<any>(`SELECT * FROM kpi_targets WHERE id = ?`, target.id);
    assert.equal(after.deleted_at, null, 'the promise survives the milestone');
    assert.equal(after.module_id, null, 'and stops pointing at something that is not there');
    assert.equal(Number(after.value), 90, 'with the number it always had');
  });
});

describe('a target due by a milestone', () => {
  let me: Person;
  let workspace = '';
  let project = '';

  before(async () => {
    const made = await register('kpi-milestone@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { kpi: true } } });
    const projects = await ok(`/api/workspaces/${workspace}/projects`, { cookie: me.cookie });
    project = projects[0].id;
  });

  it('reports the milestone’s date, and says the date will move with it', async () => {
    const module = await ok(`/api/workspaces/${workspace}/modules`, {
      cookie: me.cookie, body: { project_id: project, name: 'Launch', target_date: '2026-09-30' },
    });
    await tool(me.token, 'create_kpi', { name: 'Latency', unit: 'duration' });
    const set = await tool(me.token, 'set_kpi_target', { kpi: 'Latency', value: '120', milestone: 'Launch' });
    assert.equal(set.due, '2026-09-30');
    assert.equal(set.moves_with_milestone, true);

    // And it really moves: the sentence was "by the time we ship".
    await ok(`/api/modules/${module.id}`, {
      cookie: me.cookie, method: 'PATCH', body: { target_date: '2026-12-15' },
    });
    const status = await tool(me.token, 'kpi_status', { kpi: 'Latency' });
    assert.equal(status.targets[0].due, '2026-12-15');
    assert.equal(status.targets[0].milestone, 'Launch');
  });

  it('refuses a milestone that does not exist rather than dropping the link', async () => {
    await tool(me.token, 'create_kpi', { name: 'Careful' });
    await assert.rejects(
      () => tool(me.token, 'set_kpi_target', { kpi: 'Careful', value: '1', milestone: 'Not a thing' }),
      /No milestone/,
    );
  });
});

describe('what a report says about a number nobody refreshed', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('kpi-stale@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { kpi: true } } });
  });

  it('counts the states that are not judgements separately', async () => {
    await tool(me.token, 'create_kpi', { name: 'Never measured' });
    await tool(me.token, 'create_kpi', { name: 'Measured, unpromised' });
    await tool(me.token, 'record_measurement', { kpi: 'Measured, unpromised', value: '5' });

    const listed = await tool(me.token, 'list_kpis');
    assert.equal(listed.counts.no_data, 1);
    assert.equal(listed.counts.no_target, 1);
    assert.ok(!listed.counts.on_track, 'and neither is counted as doing well');
  });

  it('reports a reading two cadences old as stale, with its age', async () => {
    await tool(me.token, 'create_kpi', { name: 'Forgotten', cadence: 'weekly' });
    await tool(me.token, 'record_measurement', { kpi: 'Forgotten', value: '5', measured_on: '2020-01-01' });
    await tool(me.token, 'set_kpi_target', { kpi: 'Forgotten', value: '10', due_on: '2030-01-01' });

    const status = await tool(me.token, 'kpi_status', { kpi: 'Forgotten' });
    assert.equal(status.health, 'stale');
    assert.ok(status.age_days > 1000, 'and says how old, so a quote can be dated');
  });

  it('returns both the number and the text, so a model cannot quote the wrong one', async () => {
    await tool(me.token, 'create_kpi', { name: 'Both', unit: 'percent', decimals: 2 });
    await tool(me.token, 'record_measurement', { kpi: 'Both', value: '94.5' });
    const status = await tool(me.token, 'kpi_status', { kpi: 'Both' });
    assert.equal(status.value, 9450);
    assert.equal(status.value_text, '94.50 %');
  });
});

describe('who may see a number', () => {
  let owner: Person;
  let outsider: Person;
  let workspace = '';
  let privateProject = '';
  let scoped = '';

  before(async () => {
    const made = await register('kpi-owner@example.com');
    owner = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: owner.cookie, method: 'PATCH', body: { features: { kpi: true } } });

    const project = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: owner.cookie, body: { name: 'Hush', key: 'HUSH', visibility: 'private' },
    });
    privateProject = project.id;
    const kpi = await ok(`/api/workspaces/${workspace}/kpis`, {
      cookie: owner.cookie, body: { name: 'Secret rate', project_id: privateProject },
    });
    scoped = kpi.id;

    const other = await register('kpi-outsider@example.com');
    outsider = other.person;
    // Into the workspace, but not into the private project.
    const invite = await ok(`/api/workspaces/${workspace}/invites`, {
      cookie: owner.cookie, body: { email: 'kpi-outsider@example.com', role: 'member' },
    }).catch(() => null);
    if (invite?.code) await ok(`/api/invites/${invite.code}/accept`, { cookie: outsider.cookie, body: {} }).catch(() => null);
  });

  it('keeps a KPI scoped to a private project off an outsider’s row read', async () => {
    const result = await call(`/api/kpis/${scoped}`, { cookie: outsider.cookie });
    assert.ok(result.status >= 400, `expected a refusal, got ${result.status}`);
  });

  it('keeps it out of an outsider’s list', async () => {
    const listed = await call(`/api/workspaces/${workspace}/kpis`, { cookie: outsider.cookie });
    const ids = Array.isArray(listed.body) ? listed.body.map((row: any) => row.id) : [];
    assert.ok(!ids.includes(scoped));
  });

  it('shows it to somebody who can see the project', async () => {
    const row = await ok(`/api/kpis/${scoped}`, { cookie: owner.cookie });
    assert.equal(row.id, scoped);
  });
});

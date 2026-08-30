/**
 * The estate: what runs, what it costs, and what the plan is for changing it.
 *
 * The thing being protected here is the decision the whole feature rests on —
 * **a landscape is a date, not a document.** There is no "current" set and no
 * "target" set to be kept in step; both fall out of `live_from` and
 * `live_until`, so the tests are largely about whether the same rows answer two
 * different days correctly, and whether the things that have no dates are
 * reported rather than quietly dropped out of both.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-landscape-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
let cookie = '';
let token = '';
let workspace = '';
let web = '';

async function call(path: string, options: { body?: unknown; method?: string; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : cookie ? { cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ok<T = any>(path: string, options: Parameters<typeof call>[1] = {}): Promise<T> {
  const result = await call(path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

let rpcId = 0;
async function tool(name: string, args: Record<string, unknown> = {}) {
  const response = await ok('/mcp', {
    token, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  return response.result.structuredContent;
}

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const session = await ok('/api/auth/register', {
    body: { email: 'ops@example.com', name: 'Ops', password: 'correct horse battery' },
  });
  workspace = session.workspaces[0].id;
  token = (await ok('/api/tokens', { body: { name: 'mcp', workspaceId: workspace } })).token;
  await ok(`/api/workspaces/${workspace}`, {
    method: 'PATCH', body: { features: { infrastructure: true, budget: true } },
  });
  web = (await ok(`/api/workspaces/${workspace}/projects`, { body: { name: 'Web', key: 'WEB' } })).id;
});

const component = (body: Record<string, unknown>) =>
  ok(`/api/workspaces/${workspace}/components`, { body });

/* ----------------------------------------------------------- the switch */

describe('the feature switch', () => {
  it('refuses the register while it is off', async () => {
    await ok(`/api/workspaces/${workspace}`, { method: 'PATCH', body: { features: { infrastructure: false } } });
    await assert.rejects(() => tool('list_components'), /switched off/);
    await assert.rejects(() => tool('landscape'), /switched off/);
    await ok(`/api/workspaces/${workspace}`, { method: 'PATCH', body: { features: { infrastructure: true } } });
  });
});

/* ------------------------------------------------------- what is stored */

describe('what the server will not take on trust', () => {
  it('rounds money and upper-cases a currency', async () => {
    const row = await component({ name: 'Odd', amount: 1200.4, currency: 'eur' });
    assert.equal(row.amount, 1200);
    assert.equal(row.currency, 'EUR');
    assert.equal(Number.isInteger(get<any>(`SELECT amount FROM components WHERE id = ?`, row.id)!.amount), true);
  });

  it('snaps unknown enums to their defaults', async () => {
    const row = await component({ name: 'Strange', kind: 'teapot', environment: 'moon', status: 'undead' });
    assert.equal(row.kind, 'other');
    assert.equal(row.environment, 'production');
    assert.equal(row.status, 'live');
  });

  it('drops an end date that falls before the start', async () => {
    // Such a component is in no landscape on any day, and nothing on any screen
    // would say why. The start is kept because it is the date somebody knew.
    const row = await component({ name: 'Backwards', live_from: '2026-06-01', live_until: '2026-01-01' });
    assert.equal(row.live_from, '2026-06-01');
    assert.equal(row.live_until, null);
  });

  it('clears a malformed date rather than storing something that will not sort', async () => {
    const row = await component({ name: 'Vague', live_from: 'next spring' });
    assert.equal(row.live_from, null);
  });

  it('clamps a notice period rather than putting the reminder in the past', async () => {
    const vendor = await ok(`/api/workspaces/${workspace}/vendors`, {
      body: { name: 'Odd terms', notice_days: -30 },
    });
    assert.equal(vendor.notice_days, 0);
    const long = await ok(`/api/workspaces/${workspace}/vendors`, {
      body: { name: 'Very odd terms', notice_days: 99999 },
    });
    assert.equal(long.notice_days, 1095);
  });

  it('refuses to let a component sit under itself', async () => {
    const parent = await component({ name: 'Host' });
    const child = await component({ name: 'Guest', parent_id: parent.id });
    const loop = await ok(`/api/components/${parent.id}`, { method: 'PATCH', body: { parent_id: child.id } });
    assert.equal(loop.parent_id, null, 'the loop is refused and the old value comes back');
  });
});

/* ------------------------------------------------- current against future */

describe('a landscape is a date', () => {
  let oldDb = '';
  let newDb = '';

  before(async () => {
    // A clean estate: everything above was about storage.
    for (const row of all<any>(`SELECT id FROM components WHERE deleted_at IS NULL`)) {
      await ok(`/api/components/${row.id}`, { method: 'DELETE' });
    }
    const host = await component({
      name: 'db-01', kind: 'server', amount: 40000, recurrence: 'monthly', live_from: '2024-01-01',
    });
    oldDb = (await component({
      name: 'postgres-legacy', kind: 'database', parent_id: host.id, amount: 80000,
      recurrence: 'monthly', status: 'retiring', live_from: '2024-01-01', live_until: '2026-09-30',
    })).id;
    newDb = (await component({
      name: 'managed-postgres', kind: 'database', amount: 95000, recurrence: 'monthly',
      status: 'planned', live_from: '2026-09-01',
    })).id;
    await component({ name: 'someday-cdn', kind: 'service', status: 'planned', amount: 20000 });
    await component({ name: 'the rack', kind: 'server', amount: 1200000, recurrence: 'once', live_from: '2024-01-01' });
    await component({ name: 'unpriced-thing', kind: 'service', live_from: '2024-01-01' });
  });

  it('answers two different days from the same rows', async () => {
    const now = await tool('landscape', { from: '2026-06-01', to: '2026-06-01' });
    assert.ok(now.leaving.length === 0 && now.arriving.length === 0);

    const future = await tool('landscape', { from: '2026-06-01', to: '2026-12-01' });
    assert.deepEqual(future.leaving.map((row: any) => row.name), ['postgres-legacy']);
    assert.deepEqual(future.arriving.map((row: any) => row.name), ['managed-postgres']);
  });

  it('states what the difference costs a year', async () => {
    const future = await tool('landscape', { from: '2026-06-01', to: '2026-12-01' });
    // 950 arrives, 800 goes: 150 a month, 1800 a year, more expensive.
    assert.equal(future.annual_delta[0].amount, 180_000);
  });

  it('keeps a one-off purchase out of the run rate', async () => {
    // A year in which somebody bought a rack is not a year in which the estate
    // got permanently more expensive.
    const now = await tool('landscape', { from: '2026-06-01' });
    assert.equal(now.now.annual_cost[0].amount, (400_00 + 800_00) * 12);
    assert.ok(now.now.one_off_cost[0].amount === 1_200_000);
  });

  it('counts what nobody has priced instead of calling it free', async () => {
    const now = await tool('landscape', { from: '2026-06-01' });
    assert.equal(now.now.unpriced, 1);
  });

  it('reports a planned component with no date rather than hiding it', async () => {
    // It is in no landscape at all — present or future — and a register that
    // silently left it out of both would stop describing the plan.
    const future = await tool('landscape', { from: '2026-06-01', to: '2027-06-01' });
    assert.deepEqual(future.undated.map((row: any) => row.name), ['someday-cdn']);
    assert.ok(!future.arriving.some((row: any) => row.name === 'someday-cdn'));
  });

  it('lists only what is running on a day when asked to', async () => {
    const june = await tool('list_components', { on: '2026-06-01' });
    const names = june.components.map((row: any) => row.name);
    assert.ok(names.includes('postgres-legacy'));
    assert.ok(!names.includes('managed-postgres'));

    const december = await tool('list_components', { on: '2026-12-01' });
    const later = december.components.map((row: any) => row.name);
    assert.ok(!later.includes('postgres-legacy'));
    assert.ok(later.includes('managed-postgres'));
  });

  it('says which machine an instance is on', async () => {
    const listed = await tool('list_components', { on: '2026-06-01' });
    const legacy = listed.components.find((row: any) => row.name === 'postgres-legacy');
    assert.equal(legacy.parent, 'db-01');
  });

  /* ------------------------------------------------------------- moves */

  it('reads a move\'s progress from the register, not from its status', async () => {
    await tool('plan_move', {
      name: 'Managed Postgres', status: 'done',
      leaving: ['postgres-legacy'], arriving: ['managed-postgres'],
      target_date: '2026-09-30', project: 'WEB',
    });
    const moves = await tool('list_moves');
    const move = moves.moves.find((row: any) => row.name === 'Managed Postgres');
    // Claimed done; today is before the cutover, so the register disagrees.
    assert.equal(move.disagrees_with_the_register, true);
    assert.ok(move.done_share < 1);
    assert.deepEqual(move.leaving, ['postgres-legacy']);
  });

  it('takes a deleted component out of the moves that named it', async () => {
    // Otherwise the move sits short of complete forever with nothing on the
    // screen able to explain the missing part.
    await ok(`/api/components/${newDb}`, { method: 'DELETE' });
    const moves = await tool('list_moves');
    const move = moves.moves.find((row: any) => row.name === 'Managed Postgres');
    assert.deepEqual(move.arriving, []);
    void oldDb;
  });

  it('leaves the children of a deleted component running, at the top', async () => {
    const host = all<any>(`SELECT id FROM components WHERE name = 'db-01' AND deleted_at IS NULL`)[0];
    await ok(`/api/components/${host.id}`, { method: 'DELETE' });
    const child = get<any>(`SELECT parent_id, deleted_at FROM components WHERE name = 'postgres-legacy'`);
    assert.equal(child.deleted_at, null, 'the database did not vanish with its machine');
    assert.equal(child.parent_id, null);
  });
});

/* --------------------------------------------------------------- vendors */

describe('vendors and their contracts', () => {
  it('works out the day notice has to be given', async () => {
    const vendor = await ok(`/api/workspaces/${workspace}/vendors`, {
      body: { name: 'Scaleway', kind: 'cloud', contract_end: '2027-03-31', notice_days: 90 },
    });
    const listed = await tool('list_vendors');
    const found = listed.vendors.find((row: any) => row.id === vendor.id);
    assert.equal(found.notice_by, '2026-12-31');
  });

  it('creates a vendor named on a component rather than refusing it', async () => {
    // An assistant writing down an estate should not have to create eleven
    // suppliers before it can record a server.
    const made = await tool('record_component', {
      name: 'object-store', kind: 'storage', vendor: 'Backblaze', amount: '4000',
    });
    assert.ok(made.id);
    const vendors = await tool('list_vendors');
    assert.ok(vendors.vendors.some((row: any) => row.name === 'Backblaze'));
  });

  it('leaves a vendor\'s components running when the vendor goes', async () => {
    const vendor = (await tool('list_vendors')).vendors.find((row: any) => row.name === 'Backblaze');
    await ok(`/api/vendors/${vendor.id}`, { method: 'DELETE' });
    const store = get<any>(`SELECT vendor_id, deleted_at FROM components WHERE name = 'object-store'`);
    assert.equal(store.deleted_at, null);
    assert.equal(store.vendor_id, null);
  });
});

/* ---------------------------------------------------------- the budget link */

describe('the link to a budget', () => {
  it('charges a component to a plan line and says it is budgeted', async () => {
    const budget = await ok(`/api/workspaces/${workspace}/budgets`, {
      body: { name: 'Platform', period_start: '2026-01-01', period_end: '2026-12-31' },
    });
    const line = await ok(`/api/workspaces/${workspace}/budget-lines`, {
      body: { budget_id: budget.id, name: 'Hosting', amount: 400_00, recurrence: 'monthly' },
    });
    const made = await tool('record_component', {
      name: 'app-01', amount: '420', recurrence: 'monthly', budget: 'Platform', line: 'Hosting',
    });
    assert.equal(made.in_a_landscape, true);
    assert.equal(get<any>(`SELECT line_id FROM components WHERE id = ?`, made.id)!.line_id, line.id);

    const listed = await tool('list_components', {});
    assert.equal(listed.components.find((row: any) => row.name === 'app-01').budgeted, true);
  });

  it('refuses a line nobody has', async () => {
    await assert.rejects(
      () => tool('record_component', { name: 'ghost', line: 'Imaginary' }),
      /No budget line/,
    );
  });

  it('warns that a planned component with no date is in no landscape', async () => {
    const made = await tool('record_component', { name: 'maybe-later', status: 'planned' });
    assert.equal(made.in_a_landscape, false);
    void web;
  });
});

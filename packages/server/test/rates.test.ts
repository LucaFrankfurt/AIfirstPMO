/**
 * What an hour is worth, over the wire.
 *
 * Two things are being protected here and they are not the same. One is the
 * arithmetic — a rate is dated, so raising it must not restate last month, and
 * an hour nothing costed must not come out as free. The other is the
 * restriction: a rate is close enough to somebody's pay that it goes to owners
 * and admins only, and a total is a rate anybody can divide back out — one
 * person on a project, and cost ÷ their hours is exactly what they are paid.
 *
 * So every door is tried separately. A member who cannot pull a rate but can
 * `GET /api/rates/:id`, or ask MCP what a project cost, has no restriction at
 * all.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-rates-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/db/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';
interface Person { cookie: string; token: string; id: string }

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

let admin: Person;
let member: Person;
let workspace = '';
let web = '';
let api = '';

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* One hook, not two: two top-level `before`s are not ordered against each
   other in a way worth relying on, and the second needs the address the first
   discovers. */
before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  resetRateLimits();
  const first = await call('/api/auth/register', {
    body: { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' },
  });
  const cookie = first.setCookie!.split(';')[0];
  workspace = first.body.workspaces[0].id;
  admin = { cookie, token: (await ok('/api/tokens', { cookie, body: { name: 'mcp', workspaceId: workspace } })).token, id: first.body.user.id };

  await ok(`/api/workspaces/${workspace}`, { cookie, method: 'PATCH', body: { features: { time: true } } });
  web = (await ok(`/api/workspaces/${workspace}/projects`, { cookie, body: { name: 'Web', key: 'WEB' } })).id;
  api = (await ok(`/api/workspaces/${workspace}/projects`, { cookie, body: { name: 'API', key: 'API' } })).id;

  resetRateLimits();
  const second = await call('/api/auth/register', {
    body: { email: 'bob@example.com', name: 'Bob', password: 'correct horse battery' },
  });
  const bobCookie = second.setCookie!.split(';')[0];
  const bobId = second.body.user.id;
  const invite = await ok(`/api/workspaces/${workspace}/invites`, {
    cookie, body: { email: 'bob@example.com', role: 'member' },
  });
  await ok(`/api/invites/${invite.code}/accept`, { cookie: bobCookie, body: {} });
  member = {
    cookie: bobCookie,
    token: (await ok('/api/tokens', { cookie: bobCookie, body: { name: 'mcp', workspaceId: workspace } })).token,
    id: bobId,
  };
});

/* ------------------------------------------------------------------ rates */

describe('setting a rate', () => {
  it('applies from today when no date is given', async () => {
    const rate = await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { amount: 8000, currency: 'eur' },
    });
    assert.match(rate.starts_on, /^\d{4}-\d{2}-\d{2}$/);
    // Backdating restates every report that has ever been run, so it is
    // something somebody types rather than something that happens by default.
    assert.equal(rate.starts_on, new Date().toISOString().slice(0, 10));
  });

  it('upper-cases the currency and rounds the amount', async () => {
    const rate = await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { amount: 95.6, currency: 'gbp', starts_on: '2026-01-01' },
    });
    assert.equal(rate.currency, 'GBP');
    assert.equal(rate.amount, 96);
    assert.equal(Number.isInteger(get<any>(`SELECT amount FROM rates WHERE id = ?`, rate.id)!.amount), true);
  });

  it('refuses to store a negative rate', async () => {
    // An hour that earns money back is not a thing, and a stray minus would
    // subtract from every project that person touched.
    const rate = await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { amount: -5000, starts_on: '2026-01-01' },
    });
    assert.equal(rate.amount, 0);
  });

  it('snaps an unknown kind to cost, and a bad date to today', async () => {
    const rate = await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { amount: 100, kind: 'imaginary', starts_on: 'soon' },
    });
    assert.equal(rate.kind, 'cost');
    assert.match(rate.starts_on, /^\d{4}-\d{2}-\d{2}$/);
  });
});

/* ------------------------------------------------------------ the maths */

describe('what time cost', () => {
  before(async () => {
    // A clean slate for the arithmetic: everything above was about storage.
    for (const row of await ok<any[]>(`/api/workspaces/${workspace}/rates`, { cookie: admin.cookie })) {
      await ok(`/api/rates/${row.id}`, { cookie: admin.cookie, method: 'DELETE' });
    }
    await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { amount: 8000, currency: 'EUR', starts_on: '2020-01-01' },
    });
    await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { user_id: admin.id, amount: 10000, currency: 'EUR', starts_on: '2026-04-01' },
    });
    await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { kind: 'billable', amount: 15000, currency: 'EUR', starts_on: '2020-01-01' },
    });

    const task = await ok(`/api/workspaces/${workspace}/tasks`, {
      cookie: admin.cookie, body: { project_id: web, title: 'Work' },
    });
    // Two hours in March, before Ada's own rate starts; two in April, after.
    await ok(`/api/workspaces/${workspace}/time-entries`, {
      cookie: admin.cookie, body: { project_id: web, task_id: task.id, minutes: 120, spent_on: '2026-03-10', billable: 1 },
    });
    await ok(`/api/workspaces/${workspace}/time-entries`, {
      cookie: admin.cookie, body: { project_id: web, task_id: task.id, minutes: 120, spent_on: '2026-04-10', billable: 1 },
    });
    // An hour on another project that nobody bills.
    await ok(`/api/workspaces/${workspace}/time-entries`, {
      cookie: admin.cookie, body: { project_id: api, minutes: 60, spent_on: '2026-04-11', billable: 0 },
    });
  });

  it('costs an hour at the rate in force on the day it was worked', async () => {
    const cost = await tool(admin.token, 'time_cost', { from: '2026-01-01', to: '2026-12-31' });
    // 2h at the €80 workspace rate, 3h at Ada's €100 from April: 160 + 300.
    assert.equal(cost.cost[0].amount, 46_000);
    assert.equal(cost.hours, 5);
  });

  it('does not restate the past when a rate is raised', async () => {
    const march = await tool(admin.token, 'time_cost', { from: '2026-03-01', to: '2026-03-31' });
    assert.equal(march.cost[0].amount, 16_000);
    await ok(`/api/workspaces/${workspace}/rates`, {
      cookie: admin.cookie, body: { user_id: admin.id, amount: 20000, currency: 'EUR', starts_on: '2026-06-01' },
    });
    const againstTheSameMonth = await tool(admin.token, 'time_cost', { from: '2026-03-01', to: '2026-03-31' });
    assert.equal(againstTheSameMonth.cost[0].amount, 16_000, 'March is still March');
  });

  it('earns revenue only on billable time, and states the margin', async () => {
    const cost = await tool(admin.token, 'time_cost', { from: '2026-01-01', to: '2026-12-31' });
    // Four billable hours at €150; the non-billable hour earns nothing.
    assert.equal(cost.revenue[0].amount, 60_000);
    assert.equal(cost.margin[0].amount, 60_000 - 46_000);
    assert.equal(cost.billable_share, 0.8);
  });

  it('counts hours no rate covers rather than costing them at zero', async () => {
    // Bob logs an hour and has no rate of his own; deleting the workspace
    // default leaves his hour uncosted, which has to be visible.
    const rates = await ok<any[]>(`/api/workspaces/${workspace}/rates?kind=cost`, { cookie: admin.cookie });
    const fallback = rates.find((row) => !row.user_id && !row.project_id && row.starts_on === '2020-01-01');
    await ok(`/api/workspaces/${workspace}/time-entries`, {
      cookie: member.cookie, body: { project_id: web, minutes: 60, spent_on: '2026-04-12', billable: 1 },
    });
    await ok(`/api/rates/${fallback.id}`, { cookie: admin.cookie, method: 'DELETE' });

    const cost = await tool(admin.token, 'time_cost', { from: '2026-04-01', to: '2026-04-30' });
    assert.ok(cost.unrated_hours > 0, 'the uncosted hours are reported');
    // And the cost that is stated is only the part that really was costed.
    assert.equal(cost.cost[0].amount, 30_000);
  });

  it('answers the billable share, and a target only when given one', async () => {
    const plain = await tool(admin.token, 'utilisation', { from: '2026-01-01', to: '2026-12-31' });
    assert.ok(plain.rows[0].billable_share !== null);
    assert.equal(plain.rows[0].against_target, null, 'no target, no invented ratio');

    const target = await tool(admin.token, 'utilisation', { from: '2026-01-01', to: '2026-12-31', target_hours: 10 });
    assert.ok(target.rows[0].against_target !== null);
  });
});

/* ------------------------------------------------------- the restriction */

describe('who may see a rate', () => {
  it('refuses the list to an ordinary member', async () => {
    const listed = await call(`/api/workspaces/${workspace}/rates`, { cookie: member.cookie });
    assert.equal(listed.status, 403);
  });

  it('refuses the row even when the id is known', async () => {
    const mine = await ok<any[]>(`/api/workspaces/${workspace}/rates`, { cookie: admin.cookie });
    const direct = await call(`/api/rates/${mine[0].id}`, { cookie: member.cookie });
    assert.equal(direct.status, 403);
  });

  it('refuses to let a member write one', async () => {
    const attempt = await call(`/api/workspaces/${workspace}/rates`, {
      cookie: member.cookie, body: { amount: 1 },
    });
    assert.equal(attempt.status, 403);
  });

  it('keeps rates out of a member\'s pull, so cost cannot be computed on the device', async () => {
    // The one that actually matters. Everything above is a door; this is the
    // reason the client's own screens are empty rather than wrong.
    const mine = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: admin.cookie });
    assert.ok((mine.changes.rate ?? []).length > 0, 'an admin does receive them');

    const theirs = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: member.cookie });
    assert.equal((theirs.changes.rate ?? []).length, 0);
    // And they still get the time entries — hours are not the secret, money is.
    assert.ok((theirs.changes.timeEntry ?? []).length > 0);
  });

  it('refuses every cost tool over MCP', async () => {
    for (const name of ['list_rates', 'time_cost', 'utilisation']) {
      await assert.rejects(() => tool(member.token, name), /owners and admins/, name);
    }
    await assert.rejects(
      () => tool(member.token, 'set_rate', { amount: '100' }),
      /owners and admins/,
    );
  });

  it('still lets a member read the hours themselves', async () => {
    // The restriction is on money, not on time. A lead adding up a project is
    // the reason time is not private in the first place.
    const time = await tool(member.token, 'list_time', {});
    assert.ok(time.entries.length > 0);
  });
});

/* ----------------------------------------------------------- the feature */

describe('the time switch still governs all of it', () => {
  it('refuses rate tools when time tracking is off', async () => {
    await ok(`/api/workspaces/${workspace}`, {
      cookie: admin.cookie, method: 'PATCH', body: { features: { time: false } },
    });
    await assert.rejects(() => tool(admin.token, 'time_cost'), /switched off/);
    await ok(`/api/workspaces/${workspace}`, {
      cookie: admin.cookie, method: 'PATCH', body: { features: { time: true } },
    });
  });
});

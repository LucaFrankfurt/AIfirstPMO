/**
 * Budgets over the wire: the feature switch, the money the server refuses to
 * take a client's word for, the cascades, and who may see a plan.
 *
 * The visibility half is the reason this file is long. A budget carries no
 * `project_id` when it covers several, which is exactly the shape the ordinary
 * project filter reads as "belongs to nobody, show it to everybody" — the same
 * hole a private conversation would have had. So each way in is asked
 * separately: the pull, the list, the row, and MCP. A budget is where the money
 * is, and a leak here is a salary line on somebody's screen.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-budget-api-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/kernel/platform/db/index.ts');
/* Registration is limited to five per two minutes; this file makes several
   accounts for reasons unrelated to what it asserts. */
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

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

/* ------------------------------------------------------------ the switch */

describe('the feature switch', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('switch@example.com');
    me = made.person;
    workspace = made.workspace;
  });

  it('refuses every budget tool while budgets are off', async () => {
    // Not "half works": a tool that records money into a workspace where no
    // screen will ever show it has done something worse than refuse.
    await assert.rejects(() => tool(me.token, 'list_budgets'), /switched off/);
    await assert.rejects(() => tool(me.token, 'create_budget', { name: 'Nope' }), /switched off/);
  });

  it('works once an admin switches them on', async () => {
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { budget: true } } });
    const listed = await tool(me.token, 'list_budgets');
    assert.deepEqual(listed.budgets, []);
  });
});

/* ---------------------------------------------------------------- money */

describe('what the server will not take a client\'s word for', () => {
  let me: Person;
  let workspace = '';
  let projectA = '';
  let projectB = '';
  let budget = '';

  before(async () => {
    const made = await register('money@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { budget: true } } });
    projectA = (await ok(`/api/workspaces/${workspace}/projects`, { cookie: me.cookie, body: { name: 'Web', key: 'WEB' } })).id;
    projectB = (await ok(`/api/workspaces/${workspace}/projects`, { cookie: me.cookie, body: { name: 'Ops', key: 'OPS' } })).id;
    budget = (await ok(`/api/workspaces/${workspace}/budgets`, {
      cookie: me.cookie,
      body: { name: 'Platform 2026', currency: 'eur', period_start: '2026-01-01', period_end: '2026-12-31' },
    })).id;
  });

  it('upper-cases a currency, so two spellings are not two totals', () => {
    assert.equal(get<any>(`SELECT currency FROM budgets WHERE id = ?`, budget)!.currency, 'EUR');
  });

  it('refuses a currency that is not three letters', async () => {
    const row = await ok(`/api/budgets/${budget}`, { cookie: me.cookie, method: 'PATCH', body: { currency: 'Euros' } });
    assert.equal(row.currency, 'EUR');
  });

  it('rounds an amount to whole minor units rather than storing a float', async () => {
    // A client sending 12.5 means twelve and a half cents, which is not a
    // thing — and a float in this column drifts every time it is summed.
    const line = await ok(`/api/workspaces/${workspace}/budget-lines`, {
      cookie: me.cookie, body: { budget_id: budget, name: 'Odd', amount: 12.5 },
    });
    assert.equal(line.amount, 13);
    assert.equal(Number.isInteger(get<any>(`SELECT amount FROM budget_lines WHERE id = ?`, line.id)!.amount), true);
  });

  it('turns a number it cannot read into zero rather than NULL', async () => {
    // NULL would be skipped silently by every later SUM.
    const line = await ok(`/api/workspaces/${workspace}/budget-lines`, {
      cookie: me.cookie, body: { budget_id: budget, name: 'Rubbish', amount: 'twelve' },
    });
    assert.equal(line.amount, 0);
  });

  it('scales a split that does not add up', async () => {
    // 90% allocated is 10% that has quietly left every per-project report.
    const line = await ok(`/api/workspaces/${workspace}/budget-lines`, {
      cookie: me.cookie,
      body: {
        budget_id: budget,
        name: 'Cluster',
        amount: 450_000,
        allocations: [{ project_id: projectA, share: 3 }, { project_id: projectB, share: 2 }],
      },
    });
    assert.equal(line.allocations.reduce((sum: number, row: any) => sum + row.share, 0), 10_000);
    assert.equal(line.allocations.find((row: any) => row.project_id === projectA).share, 6000);
  });

  it('snaps an unknown category or stage to its default', async () => {
    const entry = await ok(`/api/workspaces/${workspace}/budget-actuals`, {
      cookie: me.cookie,
      body: { budget_id: budget, description: 'Odd', amount: 100, category: 'wizardry', stage: 'imagined', spent_on: '2026-01-05' },
    });
    assert.equal(entry.category, 'other');
    assert.equal(entry.stage, 'paid');
  });

  it('replaces a malformed date rather than letting it sort into no month', async () => {
    const entry = await ok(`/api/workspaces/${workspace}/budget-actuals`, {
      cookie: me.cookie, body: { budget_id: budget, description: 'Undated', amount: 100, spent_on: 'January-ish' },
    });
    assert.match(entry.spent_on, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('records who filed an invoice, whatever the client claims', async () => {
    const entry = await ok(`/api/workspaces/${workspace}/budget-actuals`, {
      cookie: me.cookie,
      body: { budget_id: budget, description: 'Mine', amount: 100, spent_on: '2026-01-06', recorded_by: 'somebody-else' },
    });
    assert.notEqual(entry.recorded_by, 'somebody-else');
  });

  it('collapses a scope of one project to an owner', async () => {
    // `projects: [a]` and `project_id: a` describe the same thing, and storing
    // both spellings would be storing two rows that are equal and do not
    // compare equal.
    const scoped = await ok(`/api/budgets/${budget}`, {
      cookie: me.cookie, method: 'PATCH', body: { projects: [projectA] },
    });
    assert.equal(scoped.project_id, projectA);
    assert.deepEqual(scoped.projects, []);

    const wider = await ok(`/api/budgets/${budget}`, {
      cookie: me.cookie, method: 'PATCH', body: { projects: [projectA, projectB] },
    });
    assert.equal(wider.project_id, null);
    assert.equal(wider.projects.length, 2);
  });
});

/* -------------------------------------------------------------- cascades */

describe('what goes when something is deleted', () => {
  let me: Person;
  let workspace = '';
  let budget = '';
  let lineId = '';
  let actualId = '';

  before(async () => {
    const made = await register('cascade@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { budget: true } } });
    budget = (await ok(`/api/workspaces/${workspace}/budgets`, {
      cookie: me.cookie, body: { name: 'Doomed', period_start: '2026-01-01', period_end: '2026-12-31' },
    })).id;
    lineId = (await ok(`/api/workspaces/${workspace}/budget-lines`, {
      cookie: me.cookie, body: { budget_id: budget, name: 'Hosting', amount: 1000 },
    })).id;
    actualId = (await ok(`/api/workspaces/${workspace}/budget-actuals`, {
      cookie: me.cookie, body: { budget_id: budget, line_id: lineId, description: 'Bill', amount: 900, spent_on: '2026-01-10' },
    })).id;
    await ok(`/api/workspaces/${workspace}/budget-scenarios`, {
      cookie: me.cookie, body: { budget_id: budget, name: 'Cheaper', adjustments: [{ factor: 5000 }] },
    });
  });

  it('leaves an invoice behind when its plan line goes, as unplanned spend', async () => {
    // Money does not stop having been spent because somebody tidied the plan.
    await ok(`/api/budget-lines/${lineId}`, { cookie: me.cookie, method: 'DELETE' });
    const entry = get<any>(`SELECT line_id, deleted_at FROM budget_actuals WHERE id = ?`, actualId)!;
    assert.equal(entry.deleted_at, null);
    assert.equal(entry.line_id, null);
  });

  it('takes the plan, the invoices and the scenarios when the budget goes', async () => {
    // Tombstones rather than a DELETE: every other device holds those rows and
    // only a tombstone tells them.
    await ok(`/api/budgets/${budget}`, { cookie: me.cookie, method: 'DELETE' });
    for (const table of ['budget_lines', 'budget_actuals', 'budget_scenarios']) {
      const left = all<any>(`SELECT id FROM ${table} WHERE budget_id = ? AND deleted_at IS NULL`, budget);
      assert.equal(left.length, 0, `${table} still has live rows`);
    }
    assert.ok(get<any>(`SELECT deleted_at FROM budget_actuals WHERE id = ?`, actualId)!.deleted_at);
  });
});

/* ------------------------------------------------------------ visibility */

describe('who may see a plan', () => {
  let lead: Person;
  let other: Person;
  let workspace = '';
  let secret = '';
  let open = '';
  let secretBudget = '';
  let sharedBudget = '';
  let secretLine = '';

  before(async () => {
    const owner = await register('lead@example.com');
    lead = owner.person;
    workspace = owner.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: lead.cookie, method: 'PATCH', body: { features: { budget: true } } });

    secret = (await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: lead.cookie, body: { name: 'Secret', key: 'SEC', visibility: 'private' },
    })).id;
    open = (await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: lead.cookie, body: { name: 'Open', key: 'OPN' },
    })).id;

    // A budget covering two projects, one of them private — the shape with no
    // `project_id` for the ordinary filter to test.
    secretBudget = (await ok(`/api/workspaces/${workspace}/budgets`, {
      cookie: lead.cookie,
      body: { name: 'Secret programme', projects: [secret], period_start: '2026-01-01', period_end: '2026-12-31' },
    })).id;
    sharedBudget = (await ok(`/api/workspaces/${workspace}/budgets`, {
      cookie: lead.cookie, body: { name: 'Everyone', period_start: '2026-01-01', period_end: '2026-12-31' },
    })).id;
    secretLine = (await ok(`/api/workspaces/${workspace}/budget-lines`, {
      cookie: lead.cookie, body: { budget_id: secretBudget, name: 'Salaries', amount: 500_000, category: 'people' },
    })).id;

    // A second member of the same workspace, not on the private project.
    const guest = await register('colleague@example.com');
    other = guest.person;
    const invite = await ok(`/api/workspaces/${workspace}/invites`, {
      cookie: lead.cookie, body: { email: 'colleague@example.com', role: 'member' },
    });
    await ok(`/api/invites/${invite.code}/accept`, { cookie: other.cookie, body: {} });
    const membership = await ok('/api/tokens', {
      cookie: other.cookie, body: { name: 'mcp', workspaceId: workspace },
    });
    other = { ...other, token: membership.token };
  });

  it('keeps a budget scoped to a private project out of the list', async () => {
    const listed = await ok<any[]>(`/api/workspaces/${workspace}/budgets`, { cookie: other.cookie });
    const names = listed.map((row) => row.name);
    assert.ok(names.includes('Everyone'), 'the workspace-wide one is theirs to see');
    assert.ok(!names.includes('Secret programme'), 'the private one is not');
  });

  it('refuses the row even when the id is known', async () => {
    // A list is scoped by whoever asked for it; an id is a claim about a row.
    const direct = await call(`/api/budgets/${secretBudget}`, { cookie: other.cookie });
    assert.equal(direct.status, 403);
  });

  it('refuses a line through its budget, which is the only thing it names', async () => {
    // The child rows carry no project of their own, so the project guard has
    // nothing to test and would wave them through.
    const line = await call(`/api/budget-lines/${secretLine}`, { cookie: other.cookie });
    assert.equal(line.status, 403);
    const listed = await ok<any[]>(`/api/workspaces/${workspace}/budget-lines`, { cookie: other.cookie });
    assert.ok(!listed.some((row) => row.id === secretLine));
  });

  it('keeps it out of a pull, so it never reaches the device at all', async () => {
    const pull = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: other.cookie });
    assert.ok(!(pull.changes.budget ?? []).some((row: any) => row.id === secretBudget));
    assert.ok(!(pull.changes.budgetLine ?? []).some((row: any) => row.id === secretLine));
    // And the one they may see does arrive, so this is a filter rather than an
    // entity that simply never syncs.
    assert.ok((pull.changes.budget ?? []).some((row: any) => row.id === sharedBudget));
  });

  it('keeps it out of MCP as well', async () => {
    const listed = await tool(other.token, 'list_budgets');
    assert.ok(!listed.budgets.some((row: any) => row.name === 'Secret programme'));
    await assert.rejects(() => tool(other.token, 'budget_status', { budget: 'Secret programme' }), /No budget/);
  });

  it('keeps it out of search, where a budget has no project to be filtered by', async () => {
    const mine = await ok(`/api/workspaces/${workspace}/search?q=Secret`, { cookie: lead.cookie });
    assert.ok(mine.results.some((row: any) => row.kind === 'budget'), 'the lead can find their own');
    const theirs = await ok(`/api/workspaces/${workspace}/search?q=Secret`, { cookie: other.cookie });
    assert.ok(!theirs.results.some((row: any) => row.id === secretBudget));
  });

  it('lets the lead see everything they scoped', async () => {
    const listed = await ok<any[]>(`/api/workspaces/${workspace}/budgets`, { cookie: lead.cookie });
    assert.equal(listed.length, 2);
    void open;
  });
});

/* ------------------------------------------------------------------- MCP */

describe('planning and recording over MCP', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('mcp@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { budget: true } } });
    await ok(`/api/workspaces/${workspace}/projects`, { cookie: me.cookie, body: { name: 'Web', key: 'WEB' } });
    await ok(`/api/workspaces/${workspace}/projects`, { cookie: me.cookie, body: { name: 'Ops', key: 'OPS' } });
  });

  it('reads an amount however it was written, and answers in both units', async () => {
    const made = await tool(me.token, 'create_budget', {
      name: 'Platform 2026', currency: 'EUR', approved: '250.000,00',
      period_start: '2026-01-01', period_end: '2026-12-31', status: 'active',
    });
    assert.ok(made.id);
    const status = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-02-15' });
    assert.equal(status.approved, 25_000_000);
    assert.match(status.approved_text, /250,000/);
  });

  it('expands a recurring line rather than counting it once', async () => {
    await tool(me.token, 'add_budget_line', {
      budget: 'Platform 2026', name: 'Kubernetes cluster', amount: '4500',
      category: 'infrastructure', recurrence: 'monthly', allocations: { WEB: 60, OPS: 40 },
    });
    const status = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-02-15' });
    assert.equal(status.planned, 4500_00 * 12);
  });

  it('charges each project its share, and the shares add up to the whole', async () => {
    const status = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-02-15' });
    const web = status.by_project.find((row: any) => row.project === 'Web');
    const ops = status.by_project.find((row: any) => row.project === 'Ops');
    assert.ok(web && ops);
    const costs = await tool(me.token, 'project_costs', { project: 'WEB', as_of: '2026-02-15' });
    assert.equal(costs.totals[0].currency, 'EUR');
  });

  it('refuses a split naming a project that does not exist', async () => {
    // A split that quietly dropped one of its halves would charge the whole
    // cost to the other, which is a wrong number nobody would question.
    await assert.rejects(
      () => tool(me.token, 'add_budget_line', {
        budget: 'Platform 2026', name: 'Ghost', amount: '100', allocations: { NOPE: 100 },
      }),
      /Project NOPE not found/,
    );
  });

  it('refuses an amount it cannot read rather than recording a zero', async () => {
    await assert.rejects(
      () => tool(me.token, 'record_spend', { budget: 'Platform 2026', description: 'Vague', amount: 'a lot' }),
      /Cannot read/,
    );
  });

  it('takes the category from the line an invoice is filed against', async () => {
    await tool(me.token, 'record_spend', {
      budget: 'Platform 2026', description: 'AWS January', amount: '4650.50',
      line: 'Kubernetes cluster', spent_on: '2026-01-31', stage: 'paid', reference: 'INV-1',
    });
    const status = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-02-15' });
    assert.equal(status.paid, 465_050);
    assert.equal(status.unplanned, 0);
    const infra = status.by_category.find((row: any) => row.category === 'infrastructure');
    assert.match(infra.actual, /4,650\.50/);
  });

  it('counts spend no plan line accounts for', async () => {
    await tool(me.token, 'record_spend', {
      budget: 'Platform 2026', description: 'A licence nobody planned', amount: '1200',
      spent_on: '2026-02-03', stage: 'committed',
    });
    const status = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-02-15' });
    assert.equal(status.unplanned, 120_000);
    assert.equal(status.committed, 120_000);
  });

  it('answers under a scenario without changing the plan', async () => {
    const budgetId = (await tool(me.token, 'list_budgets')).budgets[0].id;
    await ok(`/api/workspaces/${workspace}/budget-scenarios`, {
      cookie: me.cookie,
      body: { budget_id: budgetId, name: 'Half the cluster', adjustments: [{ factor: 5000 }] },
    });
    const halved = await tool(me.token, 'budget_status', {
      budget: 'Platform 2026', scenario: 'Half the cluster', as_of: '2026-02-15',
    });
    const plain = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-02-15' });
    assert.equal(halved.planned, plain.planned / 2);
    assert.equal(halved.scenario.name, 'Half the cluster');
  });

  it('says which scenario it could not find rather than silently using the plan', async () => {
    await assert.rejects(
      () => tool(me.token, 'budget_status', { budget: 'Platform 2026', scenario: 'Wishful' }),
      /No scenario/,
    );
  });

  it('takes a month\'s plan across as ordinary records', async () => {
    // The recurring half of a budget is almost all of it, and this is the
    // difference between actuals that get filled in and actuals that stop in
    // April. What it writes has to be indistinguishable from typing it.
    const dry = await tool(me.token, 'confirm_planned', {
      budget: 'Platform 2026', month: '2026-06', dry_run: true,
    });
    assert.equal(dry.dry_run, true);
    assert.ok(dry.recorded.some((row: any) => row.line === 'Kubernetes cluster'));
    // The cluster bills on the 1st because the line carries no day of its own.
    assert.match(dry.recorded[0].spent_on, /^2026-06-\d{2}$/);

    const before = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-07-01' });
    const done = await tool(me.token, 'confirm_planned', { budget: 'Platform 2026', month: '2026-06' });
    assert.equal(done.recorded.length, dry.recorded.length);

    const after = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-07-01' });
    // The cluster is €4,500 a month — 450,000 minor units, not 45,000.
    assert.equal(after.paid - before.paid, 4500_00, 'the month landed at the planned amount');
    // And it is filed against the line, so it is not unplanned spend.
    assert.equal(after.unplanned, before.unplanned);
  });

  it('leaves a line alone once anything is recorded against it that month', async () => {
    // Under-recording shows up in the figures; a silent double-book does not.
    const again = await tool(me.token, 'confirm_planned', { budget: 'Platform 2026', month: '2026-06' });
    assert.equal(again.recorded.length, 0);
    assert.ok(again.skipped.some((row: any) => row.line === 'Kubernetes cluster'));
  });

  it('records the stage it was told to, and defaults to paid', async () => {
    const committed = await tool(me.token, 'confirm_planned', {
      budget: 'Platform 2026', month: '2026-07', stage: 'committed',
    });
    assert.equal(committed.stage, 'committed');
    const status = await tool(me.token, 'budget_status', { budget: 'Platform 2026', as_of: '2026-08-01' });
    assert.ok(status.committed >= 4500_00);
  });

  it('refuses a month it cannot read, and a line that is not due', async () => {
    await assert.rejects(
      () => tool(me.token, 'confirm_planned', { budget: 'Platform 2026', month: 'June' }),
      /YYYY-MM/,
    );
    await assert.rejects(
      () => tool(me.token, 'confirm_planned', { budget: 'Platform 2026', month: '2026-08', line: 'Imaginary' }),
      /No plan line/,
    );
  });

  it('refuses to write with a read-only token', async () => {
    const readOnly = (await ok('/api/tokens', {
      cookie: me.cookie, body: { name: 'ro', workspaceId: workspace, scopes: 'read' },
    })).token;
    await assert.rejects(
      () => tool(readOnly, 'create_budget', { name: 'Nope' }),
      /read-only/,
    );
    // Reading is still fine.
    assert.ok((await tool(readOnly, 'list_budgets')).budgets.length > 0);
  });
});

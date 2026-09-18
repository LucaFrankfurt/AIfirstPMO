/**
 * The catalogue over the wire: the switch, the values the server will not take
 * a client's word for, the two cascades that go opposite ways, and the one rule
 * here that refuses rather than corrects.
 *
 * The cascades are the half worth the length, and they are deliberately not
 * symmetrical. Deleting a **product** takes its prices, its costs, its people
 * and its parts with it — and also the rows where it was somebody else's part,
 * which is the one a budget has no equivalent of: leaving those behind gives
 * every package containing it a component that resolves to nothing, and a list
 * value quietly short by whatever it was worth. Deleting a **group** does the
 * opposite and leaves its products standing, because tidying up the families
 * does not stop anything being sold. Getting either backwards is silent.
 *
 * The refusal is the cycle. A package that contains itself is not a data-entry
 * mistake with a sensible correction — every correction available is a guess at
 * what somebody meant — and the failure mode is a walk that never terminates,
 * inside a write transaction, on a row a client will retry.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-product-api-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/kernel/platform/db/index.ts');
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

describe('the feature switch', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('product-switch@example.com');
    me = made.person;
    workspace = made.workspace;
  });

  it('refuses every catalogue tool while products are off', async () => {
    await assert.rejects(() => tool(me.token, 'list_products'), /switched off/);
    await assert.rejects(() => tool(me.token, 'create_product', { name: 'Nope' }), /switched off/);
    await assert.rejects(() => tool(me.token, 'list_promotions'), /switched off/);
  });

  it('works once an admin switches them on', async () => {
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { products: true } } });
    const listed = await tool(me.token, 'list_products');
    assert.deepEqual(listed.products, []);
  });
});

describe('what the server settles', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('product-invariants@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { products: true } } });
  });

  it('falls back on an enum it has never heard of rather than refusing the row', async () => {
    // These arrive in sync batches from devices that have been away. One value
    // an older build spelled differently must not take twenty other rows down.
    const made = await ok(`/api/workspaces/${workspace}/products`, {
      cookie: me.cookie,
      body: { name: 'From the future', kind: 'bundleish', status: 'pending', billing: 'fortnightly', renewal: 'someday' },
    });
    assert.equal(made.kind, 'single');
    assert.equal(made.status, 'draft');
    assert.equal(made.billing, 'once');
    assert.equal(made.renewal, 'none');
  });

  it('upper-cases a currency, so eur and EUR are not two totals', async () => {
    const made = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Lower', currency: 'eur' } });
    assert.equal(made.currency, 'EUR');
    const nonsense = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Odd', currency: 'euros' } });
    assert.equal(nonsense.currency, 'EUR');
  });

  it('clamps a churn nobody could have meant and keeps a capacity of none', async () => {
    const wild = await ok(`/api/workspaces/${workspace}/products`, {
      cookie: me.cookie, body: { name: 'Wild', churn_bps: 400_000, term_months: 9000 },
    });
    assert.equal(wild.churn_bps, 10_000, 'four hundred per cent a month has no reading');
    assert.equal(wild.term_months, 600);
    // Null is "no ceiling" and has to survive. Zero would read as a product
    // that can sell nothing, which is not what an empty field means.
    const open = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Open', capacity: null } });
    assert.equal(open.capacity, null);
  });

  it('clamps a percentage promotion and leaves a money one alone', async () => {
    const percent = await ok(`/api/workspaces/${workspace}/promotions`, {
      cookie: me.cookie, body: { name: 'Too much', kind: 'percent', value: 45_000 },
    });
    assert.equal(percent.value, 10_000, '120% off is somebody mistyping basis points');
    // The same column means money here, and clamping it would turn "€450 off"
    // into 100% — which is how a campaign quietly becomes free.
    const amount = await ok(`/api/workspaces/${workspace}/promotions`, {
      cookie: me.cookie, body: { name: 'Big', kind: 'amount', value: 45_000 },
    });
    assert.equal(amount.value, 45_000);
  });

  it('turns a window that runs backwards the right way round', async () => {
    // A price whose window runs backwards is a price nothing falls inside: it
    // would simply never apply, and never say why.
    const product = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Windowed' } });
    const price = await ok(`/api/workspaces/${workspace}/product-prices`, {
      cookie: me.cookie,
      body: { product_id: product.id, amount: 1000, valid_from: '2026-09-01', valid_to: '2026-03-01' },
    });
    assert.equal(price.valid_from, '2026-03-01');
    assert.equal(price.valid_to, '2026-09-01');
  });

  it('gives a child the workspace of its product rather than the client\'s word for it', async () => {
    const product = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Owned' } });
    const cost = await ok(`/api/workspaces/${workspace}/product-costs`, {
      cookie: me.cookie, body: { product_id: product.id, name: 'Room', basis: 'delivery', amount: 50_000, workspace_id: 'somewhere-else' },
    });
    assert.equal(cost.workspace_id, workspace);
  });
});

describe('a package may not contain itself', () => {
  let me: Person;
  let workspace = '';
  const made: Record<string, string> = {};

  before(async () => {
    const person = await register('product-cycle@example.com');
    me = person.person;
    workspace = person.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { products: true } } });
    for (const name of ['a', 'b', 'c']) {
      const row = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name, kind: 'bundle' } });
      made[name] = row.id;
    }
  });

  it('refuses the obvious case', async () => {
    const result = await call(`/api/workspaces/${workspace}/product-parts`, {
      cookie: me.cookie, body: { product_id: made.a, part_id: made.a },
    });
    assert.equal(result.status, 422);
  });

  it('refuses a ring three deep, which is the one nothing else would catch', async () => {
    // a contains b, b contains c. Putting a inside c closes the ring, and the
    // walk that would follow it is the one that never terminates.
    await ok(`/api/workspaces/${workspace}/product-parts`, { cookie: me.cookie, body: { product_id: made.a, part_id: made.b } });
    await ok(`/api/workspaces/${workspace}/product-parts`, { cookie: me.cookie, body: { product_id: made.b, part_id: made.c } });
    const result = await call(`/api/workspaces/${workspace}/product-parts`, {
      cookie: me.cookie, body: { product_id: made.c, part_id: made.a },
    });
    assert.equal(result.status, 422);
    assert.match(String(result.body?.message ?? ''), /inside itself/);
  });

  it('still allows the same product in two packages, which is not a cycle', async () => {
    const shared = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'shared' } });
    await ok(`/api/workspaces/${workspace}/product-parts`, { cookie: me.cookie, body: { product_id: made.a, part_id: shared.id } });
    await ok(`/api/workspaces/${workspace}/product-parts`, { cookie: me.cookie, body: { product_id: made.b, part_id: shared.id } });
  });
});

describe('the two cascades', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('product-cascade@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { products: true } } });
  });

  it('a deleted product takes its prices, costs, people and parts with it', async () => {
    const product = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Going' } });
    const price = await ok(`/api/workspaces/${workspace}/product-prices`, { cookie: me.cookie, body: { product_id: product.id, amount: 1000 } });
    const cost = await ok(`/api/workspaces/${workspace}/product-costs`, { cookie: me.cookie, body: { product_id: product.id, name: 'x', amount: 1 } });
    const person = await ok(`/api/workspaces/${workspace}/product-contributors`, { cookie: me.cookie, body: { product_id: product.id, name: 'Dr M' } });

    await ok(`/api/products/${product.id}`, { cookie: me.cookie, method: 'DELETE' });

    // Tombstones rather than a DELETE: every other device holds these rows and
    // only a tombstone tells them.
    for (const [table, id] of [['product_prices', price.id], ['product_costs', cost.id], ['product_contributors', person.id]] as const) {
      const row = get<any>(`SELECT deleted_at FROM ${table} WHERE id = ?`, id);
      assert.ok(row?.deleted_at, `${table} row should be tombstoned`);
    }
  });

  it('and takes the memberships where it was somebody else\'s part', async () => {
    const pack = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Pack', kind: 'bundle' } });
    const inside = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Inside' } });
    const part = await ok(`/api/workspaces/${workspace}/product-parts`, { cookie: me.cookie, body: { product_id: pack.id, part_id: inside.id } });

    await ok(`/api/products/${inside.id}`, { cookie: me.cookie, method: 'DELETE' });

    // Without this the package keeps a component that resolves to nothing: no
    // price, no capabilities, and a list value short by whatever it was worth.
    assert.ok(get<any>(`SELECT deleted_at FROM product_parts WHERE id = ?`, part.id)?.deleted_at);
    assert.equal(get<any>(`SELECT deleted_at FROM products WHERE id = ?`, pack.id)?.deleted_at, null);
  });

  it('a deleted group leaves its products behind, ungrouped', async () => {
    const group = await ok(`/api/workspaces/${workspace}/product-groups`, { cookie: me.cookie, body: { name: 'Training' } });
    const product = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Staying', group_id: group.id } });

    await ok(`/api/product-groups/${group.id}`, { cookie: me.cookie, method: 'DELETE' });

    // The opposite of the rule above, on purpose: tidying up the families does
    // not stop anything being sold.
    const row = get<any>(`SELECT deleted_at, group_id FROM products WHERE id = ?`, product.id);
    assert.equal(row.deleted_at, null);
    assert.equal(row.group_id, null);
  });
});

describe('the tools an assistant gets', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('product-tools@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { products: true } } });
  });

  it('creates a product with its list price in one call', async () => {
    const made = await tool(me.token, 'create_product', {
      name: 'Projektmanagement-Seminar',
      code: 'SEM-PM-2',
      unit_label: 'Platz',
      scope_amount: 2,
      scope_unit: 'Tage',
      capacity: 12,
      price: '1450',
    });
    assert.ok(made.id);
    const rows = all<any>(`SELECT * FROM product_prices WHERE product_id = ? AND deleted_at IS NULL`, made.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 145_000);
  });

  it('answers the break-even, and says when it is out of reach', async () => {
    await tool(me.token, 'add_product_cost', { product: 'SEM-PM-2', name: 'Raum', basis: 'delivery', amount: '4000' });
    await tool(me.token, 'add_product_contributor', {
      product: 'SEM-PM-2', name: 'Dr. Müller', role: 'Referentin', fee: '2400', fee_basis: 'delivery',
    });
    const status = await tool(me.token, 'product_status', { product: 'SEM-PM-2', months: 12, deliveries: 1 });

    assert.equal(status.price, 145_000);
    assert.equal(status.break_even.fixed, 640_000, 'the room and the speaker, per run');
    assert.equal(status.break_even.units, 5);
    assert.equal(status.break_even.reachable, true);
    assert.equal(status.contributors.length, 1);
  });

  it('says an unpriced product has no price rather than a price of nothing', async () => {
    await tool(me.token, 'create_product', { name: 'Unpriced thing' });
    const listed = await tool(me.token, 'list_products');
    const row = listed.products.find((entry: any) => entry.name === 'Unpriced thing');
    assert.equal(row.price, null, 'a model reading 0 here would say the product is free');
    assert.equal(row.health, 'unpriced');
  });

  it('makes a product a package as soon as something is put in it', async () => {
    const pack = await tool(me.token, 'create_product', { name: 'Komplettpaket', price: '2500' });
    await tool(me.token, 'add_product_part', { package: 'Komplettpaket', product: 'SEM-PM-2', quantity: 2 });
    // Otherwise it has parts that no screen shows and nobody can see why.
    assert.equal(get<any>(`SELECT kind FROM products WHERE id = ?`, pack.id).kind, 'bundle');

    const status = await tool(me.token, 'product_status', { product: 'Komplettpaket' });
    assert.equal(status.bundle.list_value, 290_000);
    assert.equal(status.bundle.saving, 40_000);
  });

  it('charges a package what its parts cost to hand over', async () => {
    // Without the roll-up a package has no costs of its own and comes back at a
    // hundred per cent margin, flagged `no_costs` — flattering and wrong.
    await tool(me.token, 'add_product_cost', { product: 'SEM-PM-2', name: 'Unterlagen', basis: 'unit', amount: '45' });
    const status = await tool(me.token, 'product_status', { product: 'Komplettpaket' });
    assert.equal(status.unit_cost, 9_000, 'two seats of handouts at 45,00 €');
    assert.notEqual(status.health, 'no_costs');
  });

  it('simulates without writing anything', async () => {
    const before = get<any>(`SELECT COUNT(*) AS n FROM product_prices`).n;
    const result = await tool(me.token, 'simulate_product', {
      product: 'SEM-PM-2', months: 6, units: 8, deliveries: 1, price_percent: -10,
    });
    assert.equal(result.months.length, 6);
    assert.equal(result.price, 130_500, 'the list price, 10% off');
    assert.equal(result.turned_away, 0, 'eight seats in a room for twelve');
    assert.equal(get<any>(`SELECT COUNT(*) AS n FROM product_prices`).n, before);
  });

  it('will not forecast more seats than the room holds', async () => {
    const result = await tool(me.token, 'simulate_product', { product: 'SEM-PM-2', months: 3, units: 20, deliveries: 1 });
    assert.equal(result.months[0].units, 12);
    assert.equal(result.turned_away, 24);
  });

  it('refuses a campaign naming a product nobody has', async () => {
    // A campaign that quietly covers fewer products than asked for is a
    // campaign whose figures are wrong in the flattering direction.
    await assert.rejects(
      () => tool(me.token, 'create_promotion', { name: 'Ghost', kind: 'percent', value: 10, products: ['no such thing'] }),
      /No product/,
    );
  });

  it('names what is missing rather than leaving a null to be guessed at', async () => {
    const outlook = await tool(me.token, 'retention_outlook', { product: 'Unpriced thing' });
    assert.deepEqual(outlook.products[0].missing, ['price']);
    assert.equal(outlook.products[0].lifetime_value, null);
  });
});

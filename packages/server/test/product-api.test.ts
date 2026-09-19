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
const { get, all, run } = await import('../src/kernel/platform/db/index.ts');
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
      body: { name: 'From the future', kind: 'bundleish', status: 'pending', renewal: 'someday' },
    });
    assert.equal(made.kind, 'single');
    assert.equal(made.status, 'draft');
    assert.equal(made.renewal, 'none');
  });

  it('no longer carries a billing period, because the price does', async () => {
    /*
     * The column is gone, and a client that still sends one is not refused —
     * it is a registry field nobody lists, so the write path drops it. The same
     * product is sold monthly, yearly and two-yearly at once, which is exactly
     * what one column on the product could not say.
     */
    const made = await ok(`/api/workspaces/${workspace}/products`, {
      cookie: me.cookie, body: { name: 'Old client', billing: 'monthly' },
    });
    assert.equal(made.billing, undefined);
    assert.equal(made.name, 'Old client', 'and the rest of the row still lands');
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

describe('archiving and deleting a product', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('product-archive@example.com');
    me = made.person;
    workspace = made.workspace;
    await ok(`/api/workspaces/${workspace}`, { cookie: me.cookie, method: 'PATCH', body: { features: { products: true } } });
  });

  it('archives and brings back, which is not the same as retiring', async () => {
    /*
     * Three states that sound alike and are not. `status: retired` is a fact
     * about the product — no longer sold, figures still count. `archived` is a
     * fact about the reader — take it off my screen. Deleted is gone.
     */
    const made = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Altlast' } });
    assert.equal(made.archived, 0);

    const archived = await ok(`/api/products/${made.id}`, { cookie: me.cookie, method: 'PATCH', body: { archived: 1 } });
    assert.equal(archived.archived, 1);
    assert.equal(archived.status, 'draft', 'archiving does not retire it');

    const back = await ok(`/api/products/${made.id}`, { cookie: me.cookie, method: 'PATCH', body: { archived: 0 } });
    assert.equal(back.archived, 0);
  });

  it('is restorable after a delete, with its prices', async () => {
    // The trash lists products now, and a restore has to bring back something
    // usable rather than a name with nothing under it.
    const made = await ok(`/api/workspaces/${workspace}/products`, { cookie: me.cookie, body: { name: 'Versehen' } });
    const price = await ok(`/api/workspaces/${workspace}/product-prices`, {
      cookie: me.cookie, body: { product_id: made.id, amount: 1_000 },
    });
    await ok(`/api/products/${made.id}`, { cookie: me.cookie, method: 'DELETE' });
    assert.ok(get<any>(`SELECT deleted_at FROM products WHERE id = ?`, made.id)?.deleted_at);
    assert.ok(get<any>(`SELECT deleted_at FROM product_prices WHERE id = ?`, price.id)?.deleted_at);

    await ok(`/api/products/${made.id}`, { cookie: me.cookie, method: 'PATCH', body: { deleted_at: null } });
    assert.equal(get<any>(`SELECT deleted_at FROM products WHERE id = ?`, made.id)?.deleted_at, null);
    assert.equal(
      get<any>(`SELECT deleted_at FROM product_prices WHERE id = ?`, price.id)?.deleted_at, null,
      'a product restored without its price is a product nobody can sell',
    );
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

  it('quotes the period a price is charged in rather than one on the product', async () => {
    // Luca's case: the same product sold monthly and yearly. The catalogue used
    // to pick by the raw number and call 49,00 € a month cheaper than 490,00 €
    // a year, which per month it is not.
    const made = await tool(me.token, 'create_product', { name: 'Calenoora SaaS', code: 'SAAS' });
    await tool(me.token, 'set_product_price', { product: 'SAAS', name: 'Monatlich', amount: '49', recurrence: 'monthly' });
    await tool(me.token, 'set_product_price', { product: 'SAAS', name: 'Jährlich', amount: '490', recurrence: 'yearly' });

    const status = await tool(me.token, 'product_status', { product: 'SAAS' });
    assert.deepEqual(status.periods, ['monthly', 'yearly']);
    assert.equal(status.mixed_periods, false);
    assert.equal(status.price, 49_000, 'the yearly one, which is 40,83 € a month');
    assert.ok(made.id);
  });

  it('changes a price without leaving two of them live', async () => {
    /*
     * The mistake this tool exists to prevent: a second `set_product_price`
     * without closing the first leaves both applicable, `priceFor` then answers
     * deterministically, and nobody knows which of the two won.
     */
    await tool(me.token, 'create_product', { name: 'Wartung', code: 'WART', price: '100', billing: 'monthly' });
    const changed = await tool(me.token, 'change_product_price', { product: 'WART', amount: '120', from: '2026-07-01' });

    assert.equal(changed.was, 10_000);
    assert.equal(changed.now, 12_000);
    assert.equal(changed.change_percent, 20);
    assert.equal(changed.old_price_ends, '2026-06-30', 'the day before, never the same day');

    const rows = all<any>(`SELECT * FROM product_prices WHERE product_id = (SELECT id FROM products WHERE code = 'WART') AND deleted_at IS NULL ORDER BY amount`);
    assert.equal(rows.length, 2, 'the old amount is kept rather than overwritten');
    assert.equal(rows[0].valid_to, '2026-06-30');
    assert.equal(rows[1].valid_from, '2026-07-01');

    const status = await tool(me.token, 'product_status', { product: 'WART' });
    assert.equal(status.price_history.length, 1);
    assert.equal(status.price_history[0].change, 2_000);
    assert.deepEqual(status.overlapping_prices, [], 'and the two windows do not collide');
  });

  it('refuses to change a price on a product that has none', async () => {
    // Better than inventing one: a product nobody has priced has no "current"
    // price to raise, and guessing which it meant is how a catalogue grows a
    // price nobody chose.
    await tool(me.token, 'create_product', { name: 'Noch ohne Preis', code: 'OHNE' });
    await assert.rejects(
      () => tool(me.token, 'change_product_price', { product: 'OHNE', amount: '50' }),
      /no price that applies today/,
    );
  });

  it('prices one product at three terms at once, and calls them three offers', async () => {
    /*
     * Calendoora's core module, end to end: 64 EUR a month with no commitment,
     * 59 EUR on a year, 54 EUR on two — all billed monthly. Before the term
     * reached the price these were one lane, so `product_status` reported three
     * overlaps and read the amounts as a price cut twice. The catalogue this
     * was built for could not be entered without that being wrong.
     */
    await tool(me.token, 'create_product', { name: 'Buchung', code: 'BUCH' });
    for (const [amount, term] of [['64', 0], ['59', 12], ['54', 24]] as const) {
      await tool(me.token, 'set_product_price', {
        product: 'BUCH', name: `Laufzeit ${term}`, amount, billing: 'monthly', term_months: term,
      });
    }

    const status = await tool(me.token, 'product_status', { product: 'BUCH' });
    assert.equal(status.prices.length, 3);
    assert.deepEqual(status.overlapping_prices, [], 'three offers, not three collisions');
    assert.deepEqual(status.price_history, [], 'and nothing here replaced anything');

    const rows = all<any>(`SELECT amount, term_months FROM product_prices
      WHERE product_id = (SELECT id FROM products WHERE code = 'BUCH') AND deleted_at IS NULL
      ORDER BY amount`);
    assert.deepEqual(rows.map((r: any) => [r.amount, r.term_months]), [[5_400, 24], [5_900, 12], [6_400, 0]]);
  });

  it('leaves a price that names no term answering to the product', async () => {
    // Null is not zero: it defers, and keeps deferring when the product's own
    // term changes. Writing the product's number into the price would freeze it.
    await tool(me.token, 'create_product', { name: 'Ohne Angabe', code: 'OHNEA', term_months: 12 });
    const set = await tool(me.token, 'set_product_price', {
      product: 'OHNEA', amount: '30', billing: 'monthly',
    });
    assert.equal(set.term_months, 12, 'reported as the product\'s, so nobody reads it as no commitment');

    const stored = get<any>(`SELECT term_months FROM product_prices WHERE id = ?`, set.id);
    assert.equal(stored.term_months, null, 'but stored as nothing, which is what defers');
  });

  it('carries the commitment across a price change', async () => {
    // A change of amount is not a change of offer: raising the two-year price
    // must not quietly turn it into the no-commitment one.
    await tool(me.token, 'create_product', { name: 'Zwei Jahre', code: 'ZWEI' });
    await tool(me.token, 'set_product_price', {
      product: 'ZWEI', name: 'Zwei Jahre', amount: '54', billing: 'monthly', term_months: 24,
    });
    const changed = await tool(me.token, 'change_product_price', {
      product: 'ZWEI', amount: '58', from: '2027-01-01',
    });
    const stored = get<any>(`SELECT term_months FROM product_prices WHERE id = ?`, changed.new_price_id);
    assert.equal(stored.term_months, 24);
  });

  it('refuses a change dated outside the window the price already has', async () => {
    /*
     * The date arrives from a caller, so both ends are reachable. On or before
     * the start, the old window would close before it opened and match no day
     * at all — the amount would not become history, it would vanish. After the
     * end, the close date would move later than the end somebody set, reselling
     * a price that had stopped. Both are silent in the schema, so they are
     * refused here with the end that is wrong named in the message.
     */
    await tool(me.token, 'create_product', { name: 'Fenster', code: 'FENS' });
    await tool(me.token, 'set_product_price', {
      product: 'FENS', name: 'Saison', amount: '40', billing: 'monthly',
      valid_from: '2026-01-01', valid_to: '2026-06-30',
    });
    // Named rather than left to the default, which is whichever price applies
    // *today* — a window written in the test would otherwise decide the outcome
    // by the date the suite happens to run on.
    const saison = { product: 'FENS', price: 'Saison', amount: '50' };

    await assert.rejects(
      () => tool(me.token, 'change_product_price', { ...saison, from: '2026-01-01' }),
      /only starts on 2026-01-01/,
    );
    await assert.rejects(
      () => tool(me.token, 'change_product_price', { ...saison, from: '2026-07-01' }),
      /already ends on 2026-06-30/,
    );

    const rows = all<any>(`SELECT * FROM product_prices WHERE product_id = (SELECT id FROM products WHERE code = 'FENS') AND deleted_at IS NULL`);
    assert.equal(rows.length, 1, 'a refused change writes nothing');
    assert.equal(rows[0].valid_to, '2026-06-30', 'and moves nothing');

    const ok = await tool(me.token, 'change_product_price', { ...saison, from: '2026-04-01' });
    assert.equal(ok.old_price_ends, '2026-03-31');
    assert.equal(ok.new_price_starts, '2026-04-01');
  });

  it('moves a cost to the basis it belonged on all along', async () => {
    /*
     * The case this whole group of tools exists for. A website at 25 EUR a
     * month with a euro of hosting per customer per month, filed under
     * `period` because that column says *Every month*: the catalogue answered
     * a 100% contribution. There was no way to fix it — six tools that create
     * and not one that changes.
     */
    await tool(me.token, 'create_product', { name: 'Webseite', code: 'WEBT' });
    await tool(me.token, 'set_product_price', { product: 'WEBT', amount: '25', billing: 'monthly' });
    await tool(me.token, 'add_product_cost', { product: 'WEBT', name: 'Hosting', amount: '1', basis: 'period' });

    const before = await tool(me.token, 'product_status', { product: 'WEBT' });
    assert.equal(before.margin_percent, 100, 'a fixed cost leaves the whole price');

    const moved = await tool(me.token, 'update_product_cost', { product: 'WEBT', cost: 'Hosting', basis: 'unit' });
    assert.equal(moved.basis, 'unit');
    assert.deepEqual(moved.changed, ['basis'], 'and nothing else was touched');
    assert.equal(moved.unit_cost, 100);
    assert.equal(moved.margin_percent, 96, 'the answer carries the consequence, not just the row');

    const after = await tool(me.token, 'product_status', { product: 'WEBT' });
    assert.equal(after.unit_cost, 100);
    assert.equal(after.contribution, 2_400);
    assert.equal(get<any>(`SELECT amount FROM product_costs WHERE id = ?`, moved.id).amount, 100,
      'the amount was never named, so it is still a euro');
  });

  it('refuses to make a package a single product while it still holds one', async () => {
    // `unitCosts` recurses through parts whatever `kind` says, so the catalogue
    // would carry a package's costs under a single product's name.
    await tool(me.token, 'create_product', { name: 'Kern', code: 'KERN' });
    await tool(me.token, 'create_product', { name: 'Bundle', code: 'BNDL', kind: 'bundle' });
    await tool(me.token, 'add_product_part', { package: 'BNDL', product: 'KERN' });

    await assert.rejects(
      () => tool(me.token, 'update_product', { product: 'BNDL', kind: 'single' }),
      /still holds 1 product/,
    );

    await tool(me.token, 'remove_product_part', { package: 'BNDL', part: 'Kern' });
    const freed = await tool(me.token, 'update_product', { product: 'BNDL', kind: 'single' });
    assert.deepEqual(freed.changed, ['kind'], 'and once it is empty it goes through');
  });

  it('says which packages a deleted product leaves short', async () => {
    // Counted before the write, because cascadeProduct tombstones the part rows
    // in the same transaction and afterwards there is nothing left to count.
    await tool(me.token, 'create_product', { name: 'Zutat', code: 'ZUT' });
    await tool(me.token, 'set_product_price', { product: 'ZUT', amount: '10', billing: 'monthly' });
    for (const code of ['PAKA', 'PAKB']) {
      await tool(me.token, 'create_product', { name: `Paket ${code}`, code, kind: 'bundle' });
      await tool(me.token, 'add_product_part', { package: code, product: 'ZUT' });
    }

    const gone = await tool(me.token, 'delete_product', { product: 'ZUT' });
    assert.deepEqual(gone.packages_left_short.sort(), ['Paket PAKA', 'Paket PAKB']);
    assert.equal(gone.rows_taken_with_it, 3, 'its price and the two part rows pointing at it');
    assert.equal(
      all<any>(`SELECT id FROM product_parts WHERE part_id = (SELECT id FROM products WHERE code = 'ZUT') AND deleted_at IS NULL`).length,
      0,
      'and the cascade really took them',
    );
  });

  it('refuses a corrected price window that ends before it begins', async () => {
    // An inverted window matches no day at all: the price neither applies nor
    // reads as history, it simply disappears.
    await tool(me.token, 'create_product', { name: 'Fenster zwei', code: 'FEN2' });
    const set = await tool(me.token, 'set_product_price', {
      product: 'FEN2', name: 'Saison', amount: '40', billing: 'monthly',
      valid_from: '2026-01-01', valid_to: '2026-06-30',
    });

    await assert.rejects(
      () => tool(me.token, 'update_product_price', { product: 'FEN2', price: 'Saison', valid_to: '2025-12-01' }),
      /apply to no day at all/,
    );
    assert.equal(get<any>(`SELECT valid_to FROM product_prices WHERE id = ?`, set.id).valid_to, '2026-06-30',
      'and a refused correction writes nothing');

    const ok = await tool(me.token, 'update_product_price', { product: 'FEN2', price: 'Saison', amount: '44' });
    assert.equal(ok.amount, 4_400);
    assert.deepEqual(ok.overlapping_prices, []);
  });

  it('says what a product costs after a price is taken away', async () => {
    // Removing the row that applied today leaves a product that answers
    // "unpriced" everywhere — that belongs in the reply, not in a margin
    // somebody reads next week.
    await tool(me.token, 'create_product', { name: 'Einziger', code: 'EINZ' });
    await tool(me.token, 'set_product_price', { product: 'EINZ', name: 'Liste', amount: '30', billing: 'monthly' });

    const gone = await tool(me.token, 'delete_product_price', { product: 'EINZ', price: 'Liste' });
    assert.equal(gone.prices_left, 0);
    assert.equal(gone.applies_now, null, 'nothing applies, and the answer says so');
    const status = await tool(me.token, 'product_status', { product: 'EINZ' });
    assert.equal(status.price, null);
  });

  it('will not let a package be put inside itself by a correction', async () => {
    // refuseCycle runs on every productPart write, updates included, and falls
    // back to the existing row for whichever side the patch does not name.
    await tool(me.token, 'create_product', { name: 'Aussen', code: 'AUS' });
    await tool(me.token, 'create_product', { name: 'Innen', code: 'INN' });
    await tool(me.token, 'add_product_part', { package: 'AUS', product: 'INN' });

    await assert.rejects(
      () => tool(me.token, 'update_product_part', { package: 'AUS', part: 'Innen', product: 'AUS' }),
      /itself/,
    );
    const bumped = await tool(me.token, 'update_product_part', { package: 'AUS', part: 'Innen', quantity: 3 });
    assert.equal(bumped.quantity, 3);
    assert.equal(bumped.product, 'Innen', 'and the part still points where it did');
  });

  it("reads a campaign's value against the kind it will have, not the one it had", async () => {
    /*
     * `value` means basis points for a percentage and minor units otherwise.
     * Changing both at once against the old kind would store 2000 as twenty
     * euros or 20 as a fifth of a basis point, and nothing downstream would
     * say which had happened.
     */
    const made = await tool(me.token, 'create_promotion', { name: 'Wechsel', kind: 'percent', value: '20' });
    assert.equal(get<any>(`SELECT value FROM promotions WHERE id = ?`, made.id).value, 2_000);

    await tool(me.token, 'update_promotion', { promotion: 'Wechsel', kind: 'amount', value: '20' });
    assert.equal(get<any>(`SELECT value FROM promotions WHERE id = ?`, made.id).value, 2_000,
      'twenty euros in minor units, which happens to look the same — so check the kind too');
    assert.equal(get<any>(`SELECT kind FROM promotions WHERE id = ?`, made.id).kind, 'amount');

    await tool(me.token, 'update_promotion', { promotion: 'Wechsel', kind: 'percent', value: '5' });
    assert.equal(get<any>(`SELECT value FROM promotions WHERE id = ?`, made.id).value, 500, 'five per cent, not five cents');
  });

  it('touches nothing it was not asked to touch', async () => {
    // The distinction every update tool here rests on: undefined is "not
    // mentioned", and everything else — null included — is "set it to this".
    await tool(me.token, 'create_product', { name: 'Unberührt', code: 'UNB', status: 'active' });
    await tool(me.token, 'update_product', { product: 'UNB', code: 'UNB-2' });

    const row = get<any>(`SELECT * FROM products WHERE id = (SELECT id FROM products WHERE code = 'UNB-2')`);
    assert.equal(row.name, 'Unberührt');
    assert.equal(row.status, 'active', 'not reset to the create default');
    assert.equal(row.currency, 'EUR');
    await assert.rejects(
      () => tool(me.token, 'update_product', { product: 'UNB-2' }),
      /Nothing to change/,
      'and naming no field at all is a mistake worth saying out loud',
    );
  });

  it('refuses a name that is not one, rather than writing the word null', async () => {
    /*
     * `String(raw).trim()` is what every creating tool does and on a create the
     * worst it costs is a row nobody wanted. On an update the same line
     * overwrites what was there: a client sending JSON null for a field it
     * means to leave alone renamed the product to the four letters n-u-l-l,
     * and the old name was gone. The same applied to a price, a cost, a
     * contributor and a campaign.
     */
    await tool(me.token, 'create_product', { name: 'Namenstreu', code: 'NAME' });
    for (const value of [null, '', '   ']) {
      await assert.rejects(
        () => tool(me.token, 'update_product', { product: 'NAME', name: value as any }),
        /must be a non-empty string/,
      );
    }
    assert.equal(get<any>(`SELECT name FROM products WHERE code = 'NAME'`).name, 'Namenstreu');
  });

  it('refuses a currency the write path would have snapped to EUR', async () => {
    // The rule below settles anything that is not three capitals to EUR, which
    // is right for sync traffic and wrong for a caller who typed the code: a
    // dollar product would come back euro-denominated with nothing said.
    await tool(me.token, 'create_product', { name: 'Dollarware', code: 'USDW', currency: 'USD' });
    await assert.rejects(
      () => tool(me.token, 'update_product', { product: 'USDW', currency: 'Dollars' }),
      /three-letter ISO 4217 code/,
    );
    assert.equal(get<any>(`SELECT currency FROM products WHERE code = 'USDW'`).currency, 'USD');

    // And a real change is allowed, but it names what it just made incoherent:
    // nothing converts, and a package sums its parts under its own symbol.
    await tool(me.token, 'create_product', { name: 'Dollarpaket', code: 'USDP', kind: 'bundle' });
    await tool(me.token, 'add_product_part', { package: 'USDP', product: 'USDW' });
    const moved = await tool(me.token, 'update_product', { product: 'USDW', currency: 'chf' });
    assert.deepEqual(moved.changed, ['currency']);
    assert.deepEqual(moved.packages_now_mixing_currencies, ['Dollarpaket']);
  });

  it('refuses a date that is not a string instead of clearing the window', async () => {
    /*
     * `isoDay` went through `str`, which answers undefined for a number the
     * same way it does for a missing argument. So `valid_to: 20261231` did not
     * fail — it cleared the end of the window, and a price that was to run
     * until December ran forever.
     */
    await tool(me.token, 'create_product', { name: 'Befristet', code: 'BEFR' });
    const price = await tool(me.token, 'set_product_price', {
      product: 'BEFR', name: 'Aktion', amount: '10', billing: 'monthly', valid_to: '2026-12-31',
    });
    await assert.rejects(
      () => tool(me.token, 'update_product_price', { product: 'BEFR', price: 'Aktion', valid_to: 20261231 as any }),
      /must be a YYYY-MM-DD string, not a number/,
    );
    assert.equal(get<any>(`SELECT valid_to FROM product_prices WHERE id = ?`, price.id).valid_to, '2026-12-31');

    // Null still clears one, because that is a caller saying so.
    await tool(me.token, 'update_product_price', { product: 'BEFR', price: 'Aktion', valid_to: null });
    assert.equal(get<any>(`SELECT valid_to FROM product_prices WHERE id = ?`, price.id).valid_to, null);
  });

  it('names in `changed` only what the write actually took', async () => {
    /*
     * The write path drops a field whose stored stamp is newer than the
     * write's — a browser whose clock runs fast leaves one behind, which is the
     * case `check:clocks` opens a second browser for. `changed` was built from
     * the patch, so it named that field anyway and a caller had no way to know
     * the correction had not landed.
     */
    await tool(me.token, 'create_product', { name: 'Uhrvor', code: 'UHRV' });
    const price = await tool(me.token, 'set_product_price', { product: 'UHRV', name: 'Liste', amount: '10', billing: 'monthly' });

    const clocks = JSON.parse(get<any>(`SELECT clocks FROM product_prices WHERE id = ?`, price.id).clocks);
    clocks.amount = `${String(Date.now() + 600_000).padStart(11, '0')}-0000-schnelleuhr`;
    run(`UPDATE product_prices SET clocks = ? WHERE id = ?`, JSON.stringify(clocks), price.id);

    const tried = await tool(me.token, 'update_product_price', { product: 'UHRV', price: 'Liste', amount: '99', note: 'korrigiert' });
    assert.deepEqual(tried.changed, ['note'], 'the amount was dropped as stale and is not claimed');
    assert.equal(tried.amount, 1_000, 'and the answer carries what the row still says');
  });

  it('finds a price by its id without being told the product', async () => {
    // The fallback read `args.product ?? args.price` and looked the price up as
    // a product, so a caller holding a price id was told "No product
    // \"pr_…\" in this workspace" — a true sentence about the wrong noun.
    await tool(me.token, 'create_product', { name: 'Ohneprodukt', code: 'OHNE' });
    const price = await tool(me.token, 'set_product_price', { product: 'OHNE', name: 'Liste', amount: '12', billing: 'monthly' });

    const fixed = await tool(me.token, 'update_product_price', { price: price.id, amount: '13' });
    assert.equal(fixed.product, 'Ohneprodukt');
    assert.equal(fixed.amount, 1_300);

    // A name is not unique across a workspace, so that path still needs the
    // product — and says which of the two is missing.
    await assert.rejects(
      () => tool(me.token, 'update_product_price', { price: 'Liste', amount: '14' }),
      /name the product too/,
    );
    await assert.rejects(
      () => tool(me.token, 'update_product_cost', { amount: '14' }),
      /`cost` is required and was not given/,
    );

    // And a child of somebody else's product reads exactly like one that does
    // not exist: the lookup is bounded by the workspace, not only the answer.
    const stranger = await register('fremde-preise@example.com');
    await ok(`/api/workspaces/${stranger.workspace}`, {
      cookie: stranger.person.cookie, method: 'PATCH', body: { features: { products: true } },
    });
    await tool(stranger.person.token, 'create_product', { name: 'Fremd', code: 'FRMD' });
    const theirs = await tool(stranger.person.token, 'set_product_price', {
      product: 'FRMD', name: 'Liste', amount: '99', billing: 'monthly',
    });
    await assert.rejects(
      () => tool(me.token, 'update_product_price', { price: theirs.id, amount: '1' }),
      new RegExp(`No price with id "${theirs.id}"`),
    );
  });

  it('says which packages a changed cost moved, and what a delivery cost is', async () => {
    /*
     * `unitCosts` recurses into parts, so a module's cost is a package's cost
     * — the margin in the answer is this product's and the packages' moved
     * with it, in a figure nobody was looking at. And `delivery` is one of the
     * three bases this tool's description explains at length; it was the one
     * the answer never carried.
     */
    await tool(me.token, 'create_product', { name: 'Modul', code: 'MODL' });
    await tool(me.token, 'set_product_price', { product: 'MODL', amount: '100', billing: 'monthly' });
    await tool(me.token, 'add_product_cost', { product: 'MODL', name: 'Anreise', amount: '20', basis: 'delivery' });
    await tool(me.token, 'create_product', { name: 'Grosspaket', code: 'GPAK', kind: 'bundle' });
    await tool(me.token, 'add_product_part', { package: 'GPAK', product: 'MODL' });

    const changed = await tool(me.token, 'update_product_cost', { product: 'MODL', cost: 'Anreise', amount: '500' });
    assert.equal(changed.per_delivery, 50_000, 'the basis the answer used to leave out entirely');
    assert.deepEqual(changed.packages_affected, ['Grosspaket']);

    const gone = await tool(me.token, 'delete_product_cost', { product: 'MODL', cost: 'Anreise' });
    assert.equal(gone.health, 'no_costs', 'which means nobody has costed it, not that it is free');
    assert.deepEqual(gone.packages_affected, ['Grosspaket']);
  });

  it('names the packages that lose a part\'s value when its last price goes', async () => {
    // `bundleValue` counts a part with no applicable price as worth nothing
    // rather than as missing, so the package's list value simply drops.
    await tool(me.token, 'create_product', { name: 'Teilwert', code: 'TWRT' });
    await tool(me.token, 'set_product_price', { product: 'TWRT', name: 'Liste', amount: '50', billing: 'monthly' });
    await tool(me.token, 'create_product', { name: 'Wertpaket', code: 'WPAK', kind: 'bundle' });
    await tool(me.token, 'add_product_part', { package: 'WPAK', product: 'TWRT' });
    assert.equal((await tool(me.token, 'product_status', { product: 'WPAK' })).bundle.list_value, 5_000);

    const gone = await tool(me.token, 'delete_product_price', { product: 'TWRT', price: 'Liste' });
    assert.equal(gone.applies_now, null);
    assert.deepEqual(gone.packages_affected, ['Wertpaket']);
    const after = await tool(me.token, 'product_status', { product: 'WPAK' });
    assert.equal(after.bundle.list_value, 0, 'an unpriced part counts as worth nothing, not as missing');
    assert.equal(after.bundle.unpriced_parts, 1);
  });

  it('will not guess which of two identical parts to remove', async () => {
    // Nothing stops a package holding the same product twice, and a part has no
    // name of its own — so the name matches both rows and `find` answered the
    // first. On a removal that is a coin flip about which row is destroyed.
    await tool(me.token, 'create_product', { name: 'Doppelt', code: 'DOPP' });
    await tool(me.token, 'create_product', { name: 'Doppelpaket', code: 'DPAK', kind: 'bundle' });
    const first = await tool(me.token, 'add_product_part', { package: 'DPAK', product: 'DOPP' });
    await tool(me.token, 'add_product_part', { package: 'DPAK', product: 'DOPP' });

    await assert.rejects(
      () => tool(me.token, 'remove_product_part', { package: 'DPAK', part: 'Doppelt' }),
      /holds Doppelt 2 times — name the row by its id/,
    );
    const removed = await tool(me.token, 'remove_product_part', { package: 'DPAK', part: first.id });
    assert.equal(removed.parts_left, 1, 'and by id it is unambiguous');
  });

  it('will not let a campaign change what its number means without saying the number', async () => {
    /*
     * `2000` under `amount` is twenty euros off a fourteen-hundred-euro
     * seminar; the same row read as `price` sells it for twenty. Nothing in
     * the write path would object, the campaign can be live, and the first
     * evidence would be an invoice.
     */
    await tool(me.token, 'create_promotion', { name: 'Bedeutung', kind: 'amount', value: '20' });
    await assert.rejects(
      () => tool(me.token, 'update_promotion', { promotion: 'Bedeutung', kind: 'price' }),
      /give `value` as well/,
    );
    assert.equal(get<any>(`SELECT kind FROM promotions WHERE name = 'Bedeutung'`).kind, 'amount');

    const moved = await tool(me.token, 'update_promotion', { promotion: 'Bedeutung', kind: 'price', value: '1200' });
    assert.deepEqual(moved.changed.sort(), ['kind', 'value']);
    assert.equal(get<any>(`SELECT value FROM promotions WHERE name = 'Bedeutung'`).value, 120_000);
  });

  it('names the saved simulations a deleted product leaves pointing at nothing', async () => {
    // Scenarios are not in PRODUCT_CHILDREN, so they are neither tombstoned nor
    // restored. Whether that should cascade is a decision about saved work;
    // leaving it silent is not a decision at all.
    const product = await tool(me.token, 'create_product', { name: 'Simuliert', code: 'SIMU' });
    await tool(me.token, 'set_product_price', { product: 'SIMU', amount: '10', billing: 'monthly' });
    /*
     * Written straight into the table because nothing else in this process
     * can: the screen saves a scenario through the sync push and there is no
     * REST collection and no tool for one. That is itself part of the finding
     * — a row a product can be deleted out from under, reachable from exactly
     * one surface.
     */
    run(
      `INSERT INTO product_scenarios (id, workspace_id, product_id, name, assumptions, created_at, updated_at, seq)
       VALUES (?, ?, ?, ?, '{}', ?, ?, 0)`,
      'sc-basisfall', workspace, product.id, 'Basisfall', Date.now(), Date.now(),
    );

    const gone = await tool(me.token, 'delete_product', { product: 'SIMU' });
    assert.deepEqual(gone.scenarios_left_dangling, ['Basisfall']);
  });

  it('tells a client which of its tools destroy something', async () => {
    /*
     * `destructiveHint` is what a client reads to decide whether to ask a
     * person first, and it was `tool.name === 'delete_task'` — one name,
     * written when there was one. Every delete tool added since announced
     * itself as not destructive, which is worse than saying nothing.
     */
    const listed = await ok<any>('/mcp', {
      token: me.token, body: { jsonrpc: '2.0', id: 9_001, method: 'tools/list', params: {} },
    });
    const flagged = new Map<string, boolean>(
      listed.result.tools.map((entry: any) => [entry.name, !!entry.annotations?.destructiveHint]),
    );
    for (const name of [
      'delete_task', 'delete_cycle', 'delete_module', 'delete_attachment',
      'delete_product', 'delete_product_price', 'delete_product_cost',
      'delete_product_contributor', 'remove_product_part', 'delete_promotion',
      'update_product_price',
    ]) {
      assert.equal(flagged.get(name), true, `${name} loses something and must say so`);
    }
    for (const name of ['list_products', 'update_product', 'change_product_price', 'add_product_part']) {
      assert.equal(flagged.get(name), false, `${name} does not, and a false alarm is how a hint stops being read`);
    }
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

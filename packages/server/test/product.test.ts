/**
 * The arithmetic a catalogue is argued from, pinned down.
 *
 * Every figure on the product screens and every figure an assistant quotes
 * comes out of these functions, and the cases worth the length are not the
 * multiplications — they are the places where a plausible answer is the wrong
 * one:
 *
 * - a product nobody has priced, which is not a product priced at nothing;
 * - a contribution at or below zero, where the break-even has no answer at all
 *   rather than a very large one;
 * - a capacity the business cannot exceed, which a spreadsheet never knows about;
 * - a non-renewing product, whose lifetime is its term and not one over its churn.
 *
 * Each of those shipped wrong at least once somewhere, in a way that reads as a
 * confident number on a slide.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPromotion, assumptionsOf, breakEven, bundleValue, capabilitiesOf, costStructure,
  expectedMonths, healthOfProduct, monthlyAmount, priceFor, promotedPrice, promotionCovers,
  dayBefore, mixedPeriods, overlappingPrices, periodsOf, priceChangeRefusal, priceHistory,
  priceLane, promotionPhase, raisePrice,
  retentionCurve, retentionOf, simulate, unitCosts, unitEconomics,
  type Product, type ProductContributor, type ProductCost, type ProductPart, type ProductPrice,
  type Promotion,
} from '@kolibri/shared';

let seq = 0;

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1', workspace_id: 'w', group_id: null, name: 'Seminar', code: 'SEM', description: null,
  kind: 'single', status: 'active', owner_id: null, currency: 'EUR', unit_label: 'Platz',
  scope_amount: 2, scope_unit: 'Tage', capacity: null, term_months: 0,
  renewal: 'none', churn_bps: 0, acquisition_cost: 0, capabilities: [], archived: 0,
  sort_order: 'V', created_at: 1, updated_at: 1, deleted_at: null, seq: 1,
  ...over,
} as Product);

const price = (over: Partial<ProductPrice> = {}): ProductPrice => ({
  id: `pr${++seq}`, workspace_id: 'w', product_id: 'p1', name: 'List', kind: 'list',
  amount: 100_000, min_quantity: 1, recurrence: 'once', term_months: null, valid_from: null, valid_to: null,
  note: null, sort_order: 'V', created_at: seq, updated_at: seq, deleted_at: null, seq,
  ...over,
} as ProductPrice);

const cost = (over: Partial<ProductCost> = {}): ProductCost => ({
  id: `pc${++seq}`, workspace_id: 'w', product_id: 'p1', name: 'Handbuch', category: 'other',
  basis: 'unit', amount: 2_000, vendor: null, note: null, sort_order: 'V',
  created_at: seq, updated_at: seq, deleted_at: null, seq,
  ...over,
} as ProductCost);

const speaker = (over: Partial<ProductContributor> = {}): ProductContributor => ({
  id: `co${++seq}`, workspace_id: 'w', product_id: 'p1', name: 'Dr. Müller', role: 'Referentin',
  organisation: null, email: null, fee: 120_000, fee_basis: 'delivery', note: null,
  sort_order: 'V', created_at: seq, updated_at: seq, deleted_at: null, seq,
  ...over,
} as ProductContributor);

const promotion = (over: Partial<Promotion> = {}): Promotion => ({
  id: `pm${++seq}`, workspace_id: 'w', name: 'Sommer', description: null, kind: 'percent',
  value: 2000, starts_on: null, ends_on: null, products: [], groups: [], spend: 0,
  uplift_bps: 0, status: 'live', owner_id: null, currency: 'EUR', sort_order: 'V',
  created_at: seq, updated_at: seq, deleted_at: null, seq,
  ...over,
} as Promotion);

/* ------------------------------------------------------------- the price */

describe('which price applies', () => {
  it('takes the most specific volume tier the order reaches', () => {
    const prices = [
      price({ id: 'a', amount: 100_000, min_quantity: 1 }),
      price({ id: 'b', amount: 90_000, min_quantity: 5, kind: 'volume' }),
      price({ id: 'c', amount: 80_000, min_quantity: 20, kind: 'volume' }),
    ];
    assert.equal(priceFor(prices, { quantity: 1 })?.id, 'a');
    assert.equal(priceFor(prices, { quantity: 5 })?.id, 'b');
    assert.equal(priceFor(prices, { quantity: 19 })?.id, 'b', 'one short of the next tier stays on this one');
    assert.equal(priceFor(prices, { quantity: 500 })?.id, 'c');
  });

  it('never picks an internal transfer price unless asked', () => {
    // A transfer price in a revenue figure is a cross-charge counted as income.
    const prices = [price({ id: 'i', amount: 10_000, kind: 'internal' })];
    assert.equal(priceFor(prices), null);
    assert.equal(priceFor(prices, { kind: 'internal' })?.id, 'i');
  });

  it('ignores a window that has closed and one that has not opened', () => {
    const prices = [
      price({ id: 'old', amount: 50_000, valid_to: '2025-12-31' }),
      price({ id: 'soon', amount: 60_000, valid_from: '2026-06-01' }),
      price({ id: 'now', amount: 70_000 }),
    ];
    assert.equal(priceFor(prices, { on: '2026-03-01' })?.id, 'now');
    assert.equal(priceFor(prices, { on: '2025-06-01' })?.id, 'old');
    assert.equal(priceFor(prices, { on: '2026-07-01' })?.id, 'soon');
  });

  it('ranks by what a month costs, not by the number on the row', () => {
    /*
     * The first product anybody modelled with more than one billing period hit
     * this. Monthly 49,00 € and yearly 490,00 € are 4900 and 49000 on their
     * rows, and the raw comparison called the monthly one cheaper — per month
     * it is the dearer of the two, 49,00 € against 40,83 €.
     */
    const prices = [
      price({ id: 'monat', amount: 4_900, recurrence: 'monthly' }),
      price({ id: 'jahr', amount: 49_000, recurrence: 'yearly' }),
    ];
    assert.equal(priceFor(prices)?.id, 'jahr');
  });

  it('answers for one billing period when asked for one', () => {
    // What a screen quoting "per month" needs, and what a customer who has
    // chosen to pay yearly needs. Neither is the other's answer.
    const prices = [
      price({ id: 'monat', amount: 4_900, recurrence: 'monthly' }),
      price({ id: 'jahr', amount: 49_000, recurrence: 'yearly' }),
    ];
    assert.equal(priceFor(prices, { recurrence: 'monthly' })?.id, 'monat');
    assert.equal(priceFor(prices, { recurrence: 'yearly' })?.id, 'jahr');
    assert.equal(priceFor(prices, { recurrence: 'quarterly' }), null, 'a period nobody sells in is no price');
  });

  it('lists the periods a product is really sold in, and names the mixed case', () => {
    const subscription = [
      price({ amount: 4_900, recurrence: 'monthly' }),
      price({ amount: 49_000, recurrence: 'yearly' }),
    ];
    assert.deepEqual(periodsOf(subscription), ['monthly', 'yearly'], 'in enum order, not arrival order');
    assert.equal(mixedPeriods(subscription), false);
    // A licence with a one-off setup fee. Real, and no single figure describes
    // it — which is why it is a question rather than an average.
    assert.equal(mixedPeriods([...subscription, price({ amount: 120_000, recurrence: 'once' })]), true);
  });

  it('is null when nothing applies, which is not a price of zero', () => {
    assert.equal(priceFor([]), null);
    assert.equal(priceFor([price({ min_quantity: 10 })], { quantity: 1 }), null);
  });

  it('reaches the same row from either order, so two devices agree', () => {
    const a = price({ id: 'aaa', amount: 90_000, min_quantity: 5 });
    const b = price({ id: 'bbb', amount: 90_000, min_quantity: 5 });
    assert.equal(priceFor([a, b], { quantity: 9 })?.id, priceFor([b, a], { quantity: 9 })?.id);
  });
});

describe('a price history', () => {
  const dated = (over: Partial<ProductPrice>) => price({ kind: 'list', recurrence: 'monthly', ...over });

  it('reads a closed window as the old price rather than as a second live one', () => {
    /*
     * There is no versions table and there should not be one. A page has
     * versions because its body is overwritten; a price is never overwritten —
     * raising one closes a window and opens another, so the old row already is
     * the history and `priceFor` has always read it that way.
     */
    const changes = priceHistory([
      dated({ id: 'neu', amount: 5_900, valid_from: '2026-01-01' }),
      dated({ id: 'alt', amount: 4_900, valid_to: '2025-12-31' }),
    ]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].from.id, 'alt');
    assert.equal(changes[0].to.id, 'neu');
    assert.equal(changes[0].delta, 1_000);
    assert.equal(changes[0].deltaBps, 2_041, 'just over a fifth');
    assert.equal(changes[0].on, '2026-01-01');
  });

  it('keeps a volume tier out of the list price\'s history', () => {
    // Two lanes, not two versions: a list price and a ten-seat price are
    // alternatives that live at once, and neither is a change of the other.
    const changes = priceHistory([
      dated({ id: 'liste', amount: 4_900 }),
      dated({ id: 'zehn', amount: 3_900, kind: 'volume', min_quantity: 10 }),
    ]);
    assert.deepEqual(changes, []);
  });

  it('finds two prices left live in one lane, in January for a March collision', () => {
    /*
     * Not a tier and not a history — a price change where somebody forgot to
     * close the old one. `priceFor` answers it deterministically and nobody
     * knows which of the two won, which is why it is reported rather than
     * resolved.
     */
    const clash = overlappingPrices([
      dated({ id: 'a', amount: 4_900 }),
      dated({ id: 'b', amount: 5_900, valid_from: '2026-03-01' }),
    ]);
    assert.equal(clash.length, 1);
    assert.deepEqual(clash[0].map((p) => p.id), ['a', 'b']);

    // Closed properly, there is nothing to report.
    assert.deepEqual(overlappingPrices([
      dated({ id: 'a', amount: 4_900, valid_to: '2026-02-28' }),
      dated({ id: 'b', amount: 5_900, valid_from: '2026-03-01' }),
    ]), []);
  });

  it('closes the old window the day before the new one opens', () => {
    // Sharing a day would leave both live for twenty-four hours, which is the
    // overlap above and the exact mistake this exists to prevent.
    const { closes, opens } = raisePrice(dated({ id: 'alt', amount: 4_900 }), { amount: 5_900, on: '2026-03-01' });
    assert.equal(closes.id, 'alt');
    assert.equal(closes.valid_to, '2026-02-28', '2026 is not a leap year');
    assert.equal(opens.amount, 5_900);
    assert.equal(opens.valid_from, '2026-03-01');
    assert.equal(opens.kind, 'list', 'everything else about the offer carries over');
    assert.equal(opens.recurrence, 'monthly');
  });

  it('reads one product sold at three terms as three offers, not a falling price', () => {
    /*
     * The case that put the term into the lane, from a real catalogue.
     * Calendoora sells one module at 64 EUR a month with no commitment, 59 EUR
     * on a year and 54 EUR on two — all billed monthly, all list prices, all
     * for one seat. With the term only on the product those three were one
     * lane: three collisions reported, and a history reading 64 -> 59 -> 54 as
     * a price cut twice. They are three offers standing side by side, and the
     * only thing telling them apart is what the customer signs.
     */
    const monthly = dated({ id: 'm', amount: 6_400, term_months: 0 });
    const year = dated({ id: 'y', amount: 5_900, term_months: 12 });
    const twoYears = dated({ id: 't', amount: 5_400, term_months: 24 });
    const three = [monthly, year, twoYears];

    assert.equal(new Set(three.map((p) => priceLane(p))).size, 3, 'three lanes, not one');
    assert.deepEqual(overlappingPrices(three), [], 'and therefore no collision');
    assert.deepEqual(priceHistory(three), [], 'and no change: nothing here replaced anything');

    // And a change within one of them is still a change of that one alone.
    const raised = dated({ id: 'y2', amount: 6_400, term_months: 12, valid_from: '2027-01-01' });
    const history = priceHistory([...three, raised]);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.from.id, 'y', 'the year price rose; the other two are untouched');
    assert.equal(history[0]!.delta, 500);
  });

  it('applies the price that asks for no commitment to an order that made none', () => {
    /*
     * The tie-break went straight to the lowest amount, so three terms at one
     * threshold answered 54 EUR — every margin, break-even and simulation on
     * the product figured against the two-year price, and the screen told
     * somebody who had signed nothing that it was what they pay.
     */
    const three = [
      dated({ id: 'm', amount: 6_400, term_months: 0 }),
      dated({ id: 'y', amount: 5_900, term_months: 12 }),
      dated({ id: 't', amount: 5_400, term_months: 24 }),
    ];
    assert.equal(priceFor(three)!.id, 'm', 'the rack rate, not the cheapest');
    assert.equal(priceFor(three, { termMonths: 12 })!.id, 'y', 'and the signed one when asked');
    assert.equal(priceFor(three, { termMonths: 24 })!.amount, 5_400);
    assert.equal(priceFor(three, { termMonths: 36 }), null, 'a commitment nobody offers is not a price');
  });

  it('still lets the volume tier beat the commitment, and the amount beat a tie', () => {
    // The order the docblock claims, asserted rather than assumed: quantity is
    // a harder fact about an order than a term, and a term than an amount.
    const tiers = [
      dated({ id: 'one', amount: 6_400, min_quantity: 1, term_months: 0 }),
      dated({ id: 'ten', amount: 6_000, min_quantity: 10, term_months: 24 }),
    ];
    assert.equal(priceFor(tiers, { quantity: 10 })!.id, 'ten', 'the tier wins over the shorter term');

    const same = [
      dated({ id: 'a', amount: 6_400, term_months: 12 }),
      dated({ id: 'b', amount: 5_900, term_months: 12 }),
    ];
    assert.equal(priceFor(same)!.id, 'b', 'equal terms, and the customer does not pay for a mid-edit');
  });

  it('reads a price that states no term as the product\'s own, not as a lane of its own', () => {
    // Otherwise a price deferring to twelve months and a price saying twelve
    // months would be alternatives to each other, which they are not — they
    // are the same offer written two ways.
    const defers = dated({ id: 'a', amount: 5_900, term_months: null });
    const states = dated({ id: 'b', amount: 5_900, term_months: 12 });
    assert.equal(priceLane(defers, 12), priceLane(states, 12));
    assert.notEqual(priceLane(defers, 0), priceLane(states, 0), 'and on a product with no term they differ');
    assert.equal(overlappingPrices([defers, states], 12).length, 1, 'so a genuine duplicate is still caught');
  });

  it('lets the price decide the commitment a retention is figured over', () => {
    /*
     * `term_months` is a floor on how long a customer stays. The product holds
     * one, and a two-year price on a product whose default is none would
     * otherwise be valued as if the customer could leave next month.
     */
    const sold = product({ term_months: 0, churn_bps: 1_000, renewal: 'auto', acquisition_cost: 0 });
    const loose = retentionOf({ product: sold, contribution: 6_400, recurrence: 'monthly' });
    const tied = retentionOf({ product: sold, contribution: 5_400, recurrence: 'monthly', termMonths: 24 });

    assert.equal(loose.months, 10, '10% churn on its own');
    assert.equal(tied.months, 24, 'the contract outlasts the churn');
    assert.equal(tied.cappedByTerm, true, 'and says that it is the contract talking');
    assert.ok(tied.value! > loose.value!, 'the cheaper price on a longer term is worth more');

    assert.equal(
      retentionOf({ product: sold, contribution: 6_400, recurrence: 'monthly', termMonths: null }).months,
      10,
      'null defers to the product, the same as leaving it out',
    );
  });

  it('refuses a day the old window does not contain, either end', () => {
    /*
     * Both ways out of the window are silent, which is why this is a refusal
     * rather than a best effort. Landing on or before `valid_from` closes the
     * old price before it opened, and an inverted window matches no day at all
     * — the old amount does not become history, it disappears. Landing after
     * `valid_to` moves the close date later than the end somebody already set,
     * reselling a price that had stopped, and hands the new row that same past
     * `valid_to` so it is born inverted too. Nothing in the schema forbids
     * either shape and nothing downstream reports it.
     */
    const window = dated({ valid_from: '2026-01-01', valid_to: '2026-06-30' });

    assert.equal(priceChangeRefusal(window, '2026-01-01'), 'before-start', 'the old price keeps at least one day');
    assert.equal(priceChangeRefusal(window, '2025-12-31'), 'before-start');
    assert.equal(priceChangeRefusal(window, '2026-07-01'), 'after-end');
    assert.equal(priceChangeRefusal(window, '2026-01-02'), null);
    assert.equal(priceChangeRefusal(window, '2026-06-30'), null, 'the last day it applies is still a day it applies');
    assert.equal(priceChangeRefusal(dated({}), '2026-01-01'), null, 'an open window contains every day');

    assert.throws(() => raisePrice(window, { amount: 5_900, on: '2026-01-01' }), /before-start/);
    assert.throws(() => raisePrice(window, { amount: 5_900, on: '2026-07-01' }), /after-end/);
  });

  it('never writes a window that ends before it begins', () => {
    // The shape the guard exists to prevent, asserted on what comes back rather
    // than on the guard: a caller reads these two rows, not the refusal.
    const window = dated({ valid_from: '2026-01-01', valid_to: '2026-06-30' });
    const { closes, opens } = raisePrice(window, { amount: 5_900, on: '2026-04-01' });
    assert.ok(closes.valid_to >= (window.valid_from ?? ''), 'the old price keeps a window');
    assert.ok(!opens.valid_to || opens.valid_to >= opens.valid_from!, 'and so does the new one');
    assert.equal(closes.valid_to, '2026-03-31');
    assert.equal(opens.valid_to, '2026-06-30', 'the end somebody set is not moved by a change of amount');
  });

  it('steps back across a month and a year end without a timezone anywhere', () => {
    assert.equal(dayBefore('2026-03-01'), '2026-02-28');
    assert.equal(dayBefore('2026-01-01'), '2025-12-31');
    assert.equal(dayBefore('2024-03-01'), '2024-02-29', 'a leap year');
  });
});

describe('a price over one month', () => {
  it('divides a period price by its months and leaves a sale alone', () => {
    assert.equal(monthlyAmount(120_000, 'yearly'), 10_000);
    assert.equal(monthlyAmount(30_000, 'quarterly'), 10_000);
    assert.equal(monthlyAmount(10_000, 'monthly'), 10_000);
    // A one-off is an amount, not a rate. One twelfth of it is a number nobody
    // is charged and nobody receives.
    assert.equal(monthlyAmount(120_000, 'once'), 0);
  });
});

/* -------------------------------------------------------------- the cost */

describe('what a cost varies with', () => {
  it('folds a contributor fee in as a cost of its own basis', () => {
    const structure = costStructure({
      costs: [cost({ basis: 'unit', amount: 2_000 }), cost({ basis: 'period', amount: 50_000 })],
      contributors: [speaker({ fee: 120_000, fee_basis: 'delivery' })],
    });
    assert.deepEqual(structure, { period: 50_000, delivery: 120_000, unit: 2_000 });
  });

  it('moves all three at once under a scenario factor', () => {
    const structure = costStructure({
      costs: [cost({ basis: 'unit', amount: 1_000 }), cost({ basis: 'period', amount: 1_000 })],
      factorBps: 11_000,
    });
    assert.deepEqual(structure, { period: 1_100, delivery: 0, unit: 1_100 });
  });
});

describe('what one unit earns', () => {
  it('takes only the per-unit costs off the price', () => {
    const economics = unitEconomics({
      product: product(),
      prices: [price({ amount: 100_000 })],
      costs: [cost({ basis: 'unit', amount: 20_000 }), cost({ basis: 'delivery', amount: 500_000 })],
    });
    assert.equal(economics.price, 100_000);
    assert.equal(economics.unitCost, 20_000);
    assert.equal(economics.contribution, 80_000);
    // Margin is the share of what the customer pays, not the mark-up on cost.
    assert.equal(economics.marginBps, 8_000);
  });

  it('is null rather than zero when nobody has priced it', () => {
    const economics = unitEconomics({ product: product(), prices: [], costs: [cost()] });
    assert.equal(economics.price, null);
    assert.equal(economics.contribution, null);
    assert.equal(economics.marginBps, null);
  });
});

/* --------------------------------------------------------- the break-even */

describe('break-even', () => {
  it('counts period costs by month and delivery costs by run', () => {
    const structure = { period: 10_000, delivery: 100_000, unit: 0 };
    const result = breakEven({
      product: product(),
      economics: { price: 50_000, contribution: 50_000 },
      structure,
      months: 12,
      deliveries: 4,
    });
    // 12 × 100,00 € + 4 × 1 000,00 € = 5 200,00 €, over 500,00 € a seat.
    assert.equal(result.fixed, 10_000 * 12 + 100_000 * 4);
    assert.equal(result.units, Math.ceil(520_000 / 50_000));
    assert.equal(result.unitsPerDelivery, 3, 'eleven seats over four runs is three a run, rounded up');
    assert.equal(result.revenue, 11 * 50_000);
    assert.equal(result.reachable, true);
  });

  it('has no answer at all when every unit loses money', () => {
    const result = breakEven({
      product: product(),
      economics: { price: 10_000, contribution: -2_000 },
      structure: { period: 100_000, delivery: 0, unit: 12_000 },
      months: 12,
      deliveries: 1,
    });
    // Not Infinity rendered as a big number: there is no volume that fixes it,
    // and a screen showing 9 999 999 units reads as merely ambitious.
    assert.equal(result.units, null);
    assert.equal(result.reachable, false);
    assert.equal(result.blocked, 'no_contribution');
  });

  it('says so when the answer is more seats than the room holds', () => {
    const result = breakEven({
      product: product({ capacity: 12 }),
      economics: { price: 50_000, contribution: 50_000 },
      structure: { period: 0, delivery: 1_000_000, unit: 0 },
      months: 12,
      deliveries: 1,
    });
    assert.equal(result.units, 20);
    assert.equal(result.reachable, false, 'twenty seats in a room for twelve');
    assert.equal(result.blocked, 'over_capacity');
  });

  it('refuses to answer when nobody has priced it', () => {
    const result = breakEven({
      product: product(),
      economics: { price: null, contribution: null },
      structure: { period: 10_000, delivery: 0, unit: 0 },
      months: 6,
      deliveries: 0,
    });
    assert.equal(result.blocked, 'no_price');
    assert.equal(result.fixed, 60_000, 'the fixed cost is still a fact');
  });
});

/* -------------------------------------------------------------- campaigns */

describe('campaigns', () => {
  it('derives the phase from the dates rather than a column', () => {
    const live = promotion({ starts_on: '2026-06-01', ends_on: '2026-08-31' });
    assert.equal(promotionPhase(live, '2026-05-01'), 'upcoming');
    assert.equal(promotionPhase(live, '2026-07-01'), 'running');
    assert.equal(promotionPhase(live, '2026-09-01'), 'ended');
    // An open start means "already", an open end "until somebody stops it".
    assert.equal(promotionPhase(promotion({ ends_on: '2099-01-01' }), '2026-07-01'), 'running');
    assert.equal(promotionPhase(promotion({ status: 'draft' }), '2026-07-01'), 'draft');
  });

  it('covers the whole catalogue only when neither list is given', () => {
    const any = promotion();
    assert.equal(promotionCovers(any, { id: 'p1', group_id: null }), true);
    const some = promotion({ products: ['p2'] });
    assert.equal(promotionCovers(some, { id: 'p1', group_id: null }), false);
    assert.equal(promotionCovers(some, { id: 'p2', group_id: null }), true);
    const byGroup = promotion({ groups: ['g1'] });
    assert.equal(promotionCovers(byGroup, { id: 'p1', group_id: 'g1' }), true);
    assert.equal(promotionCovers(byGroup, { id: 'p1', group_id: null }), false);
  });

  it('never takes a price below zero', () => {
    // 120% off is somebody mistyping basis points; a negative price would flow
    // into a revenue projection as income the business pays out.
    assert.equal(applyPromotion(10_000, { kind: 'percent', value: 12_000 }), 0);
    assert.equal(applyPromotion(10_000, { kind: 'amount', value: 50_000 }), 0);
    assert.equal(applyPromotion(10_000, { kind: 'price', value: -5 }), 0);
  });

  it('stacks deepest first, so two devices reach the same price', () => {
    const percent = promotion({ id: 'a', kind: 'percent', value: 2000 });
    const amount = promotion({ id: 'b', kind: 'amount', value: 10_000 });
    assert.equal(promotedPrice(100_000, [percent, amount]), promotedPrice(100_000, [amount, percent]));
    // Against the list price, 20% off (80,00) is deeper than 10,00 off (90,00),
    // so the percentage goes first: 100,00 → 80,00 → 70,00.
    assert.equal(promotedPrice(100_000, [percent, amount]), 70_000);
  });
});

/* --------------------------------------------------------------- packages */

describe('a package', () => {
  const part = (over: Partial<ProductPart> = {}): ProductPart => ({
    id: `pt${++seq}`, workspace_id: 'w', product_id: 'bundle', part_id: 'p1', quantity: 1,
    sort_order: 'V', created_at: seq, updated_at: seq, deleted_at: null, seq,
    ...over,
  } as ProductPart);

  it('shows the discount as the difference from the parts', () => {
    const value = bundleValue({
      parts: [part({ part_id: 'a', quantity: 2 }), part({ part_id: 'b' })],
      pricesOf: (id) => (id === 'a' ? [price({ amount: 50_000 })] : [price({ amount: 100_000 })]),
      price: 150_000,
    });
    assert.equal(value.listValue, 200_000);
    assert.equal(value.saving, 50_000);
    assert.equal(value.savingBps, 2_500);
  });

  it('calls a package dearer than its parts a premium rather than hiding it', () => {
    const value = bundleValue({
      parts: [part({ part_id: 'a' })],
      pricesOf: () => [price({ amount: 100_000 })],
      price: 120_000,
    });
    assert.equal(value.saving, -20_000);
  });

  it('counts the parts it could not price rather than flattering the figure', () => {
    const value = bundleValue({
      parts: [part({ part_id: 'a' }), part({ part_id: 'b' })],
      pricesOf: (id) => (id === 'a' ? [price({ amount: 100_000 })] : []),
      price: 90_000,
    });
    assert.equal(value.listValue, 100_000);
    assert.equal(value.unpriced, 1);
  });

  it('costs what its parts cost to hand over, and only the unit half', () => {
    // A bundle of two seminars with no cost rows of its own used to come out at
    // a hundred per cent margin and `no_costs` — the most confident wrong number
    // the catalogue could produce.
    const costOf = unitCosts({
      costsOf: (id) => (id === 'seminar' ? [cost({ basis: 'unit', amount: 4_500 }), cost({ basis: 'delivery', amount: 90_000 })] : []),
      partsOf: (id) => (id === 'pack' ? [part({ product_id: 'pack', part_id: 'seminar', quantity: 2 })] : []),
    });
    assert.equal(costOf('seminar'), 4_500);
    // Two seats at 45,00 €. The 900,00 € room is the seminar's to pay once and
    // is deliberately not counted again here — see `costStructure`.
    assert.equal(costOf('pack'), 9_000);
  });

  it('does not recurse forever on a ring the mirror is holding mid-sync', () => {
    // The server refuses a package inside itself. A client's mirror can hold one
    // for the length of one sync, and an unguarded walk there is a white screen.
    const costOf = unitCosts({
      costsOf: () => [cost({ basis: 'unit', amount: 1_000 })],
      partsOf: (id) => (id === 'a' ? [part({ product_id: 'a', part_id: 'b' })] : [part({ product_id: 'b', part_id: 'a' })]),
    });
    assert.equal(costOf('a'), 2_000, 'each contributes its own unit cost once');
  });

  it('gives the customer the union of every part\'s capabilities', () => {
    const known = new Set(['c1', 'c2', 'c3']);
    const out = capabilitiesOf({
      product: { capabilities: ['c1'] },
      parts: [part({ part_id: 'a' }), part({ part_id: 'b' })],
      capabilitiesOfPart: (id) => (id === 'a' ? ['c2'] : ['c2', 'c3']),
      known,
    });
    assert.deepEqual([...out].sort(), ['c1', 'c2', 'c3']);
  });

  it('drops an id no capability answers to rather than rendering a blank chip', () => {
    const out = capabilitiesOf({ product: { capabilities: ['c1', 'gone'] }, known: new Set(['c1']) });
    assert.deepEqual(out, ['c1']);
  });
});

/* -------------------------------------------------------------- retention */

describe('retention', () => {
  it('decays a cohort geometrically and starts at all of it', () => {
    const curve = retentionCurve(1000, 4);
    assert.deepEqual(curve, [10_000, 9_000, 8_100, 7_290]);
  });

  it('treats no churn as unmeasured rather than as an immortal customer', () => {
    // `Infinity` months in a lifetime value is a number that ends a meeting in
    // the wrong direction.
    assert.equal(expectedMonths(0), null);
    assert.equal(expectedMonths(2000), 5);
  });

  it('takes the acquisition cost off the lifetime value', () => {
    const result = retentionOf({
      product: product({ renewal: 'auto', churn_bps: 500, acquisition_cost: 30_000 }),
      recurrence: 'monthly',
      contribution: 10_000,
    });
    assert.equal(result.monthly, 10_000);
    assert.equal(result.months, 20);
    // 20 × 100,00 € gross, less the 300,00 € it cost to win them.
    assert.equal(result.value, 200_000 - 30_000);
    assert.equal(result.payback, 3);
  });

  it('does not let churn undercut a contract somebody signed', () => {
    /*
     * Measured on the first subscription modelled here: a twelve-month minimum
     * term with 10% monthly churn answered "stays 10 months" — a customer
     * leaving two months before a contract they signed. Churn measures people
     * leaving something they *could* have left.
     */
    const result = retentionOf({
      product: product({ renewal: 'auto', term_months: 12, churn_bps: 1_000 }),
      contribution: 4_900,
      recurrence: 'monthly',
    });
    assert.equal(result.months, 12);
    assert.equal(result.cappedByTerm, true, 'and it says which of the two is doing the work');
  });

  it('lets churn run past the term when the customer stays longer', () => {
    // The floor is a floor, not a ceiling: 2% a month is fifty months, and a
    // twelve-month minimum does not shorten that.
    const result = retentionOf({
      product: product({ renewal: 'auto', term_months: 12, churn_bps: 200 }),
      contribution: 4_900,
      recurrence: 'monthly',
    });
    assert.equal(result.months, 50);
    assert.equal(result.cappedByTerm, false);
  });

  it('lives exactly as long as its term when it does not renew', () => {
    // Churn measures people leaving something they could have stayed in. A
    // fixed term that ends is not churn, and the geometric model would quietly
    // carry a non-renewing product well past its own contract.
    const result = retentionOf({
      product: product({ renewal: 'none', term_months: 6, churn_bps: 100 }),
      recurrence: 'monthly',
      contribution: 10_000,
    });
    assert.equal(result.months, 6);
    assert.equal(result.value, 60_000);
  });
});

/* ------------------------------------------------------------- simulation */

describe('simulation', () => {
  it('settles missing assumptions and clamps the ones somebody mistyped', () => {
    const settled = assumptionsOf({ months: 1200, units: -4, growth_bps: 500 });
    assert.equal(settled.months, 120, 'a horizon off a form is capped, not rendered');
    assert.equal(settled.units, 0);
    assert.equal(settled.growth_bps, 500);
    assert.equal(settled.deliveries, 1);
    assert.deepEqual(settled.promotions, []);
  });

  it('charges acquisition in the month the customer arrives, so the line dips first', () => {
    const result = simulate({
      product: product({ renewal: 'auto', acquisition_cost: 50_000 }),
      prices: [price({ amount: 10_000, recurrence: 'monthly' })],
      costs: [],
      assumptions: { months: 12, units: 10, deliveries: 0 },
      from: '2026-01',
      today: '2026-01-15',
    });
    assert.ok(result.months[0].margin < 0, 'the first month pays to win ten customers');
    assert.ok(result.months[11].margin > 0, 'by the twelfth it is only collecting');
    assert.ok(result.breakEvenMonth !== null, 'and it crosses zero somewhere between');
  });

  it('stays on the number line when somebody types a growth rate of 1 000%', () => {
    // 11 to the hundredth is Infinity, and `Infinity - Infinity` for what was
    // turned away renders as *NaN units*. An obviously silly chart is fine; one
    // that says NaN is not.
    const result = simulate({
      product: product({ capacity: 10 }),
      prices: [price({ amount: 10_000 })],
      costs: [],
      assumptions: { months: 120, units: 1, growth_bps: 100_000, deliveries: 1 },
      from: '2026-01',
      today: '2026-01-15',
    });
    assert.ok(Number.isFinite(result.turnedAway));
    assert.ok(Number.isFinite(result.revenue));
    assert.equal(result.months[119].units, 10, 'the room still holds ten');
  });

  it('does not treat a capacity as a ceiling for a product that is not delivered', () => {
    /*
     * `capacity * deliveries` with no deliveries is zero, and it turned every
     * unit away — silently, for exactly the products that have none: a licence,
     * a subscription, anything sold rather than run.
     */
    const result = simulate({
      product: product({ capacity: 1 }),
      prices: [price({ amount: 4_900, recurrence: 'monthly' })],
      costs: [],
      assumptions: { months: 3, units: 40, deliveries: 0 },
      from: '2026-01',
      today: '2026-01-15',
    });
    assert.equal(result.months[0].units, 40);
    assert.equal(result.turnedAway, 0);
  });

  it('will not forecast units the business cannot deliver', () => {
    const result = simulate({
      product: product({ capacity: 12 }),
      prices: [price({ amount: 100_000 })],
      costs: [],
      assumptions: { months: 3, units: 20, deliveries: 1 },
      from: '2026-01',
      today: '2026-01-15',
    });
    assert.equal(result.months[0].units, 12);
    assert.equal(result.turnedAway, 24, 'eight a month, three months');
  });

  it('compounds a subscription and does not compound a sale', () => {
    const shared = { costs: [], assumptions: { months: 3, units: 10, deliveries: 0 }, from: '2026-01', today: '2026-01-15' } as const;
    const sub = simulate({
      ...shared,
      product: product({ renewal: 'auto' }),
      prices: [price({ amount: 10_000, recurrence: 'monthly' })],
    });
    assert.equal(sub.months[0].active, 10);
    assert.equal(sub.months[2].active, 30, 'three months of arrivals, nobody churning');

    const sale = simulate({ ...shared, product: product(), prices: [price({ amount: 10_000, recurrence: 'once' })] });
    assert.equal(sale.months[2].active, 10, 'a sale is paid for and done');
  });

  it('applies only the campaigns the scenario names *and* that cover the product', () => {
    // The filter was on the id alone once, which made a campaign for another
    // product look good in whichever scenario happened to mention it.
    const elsewhere = promotion({ id: 'other', kind: 'percent', value: 5000, products: ['p2'] });
    const result = simulate({
      product: product(),
      prices: [price({ amount: 100_000 })],
      costs: [],
      promotions: [elsewhere],
      assumptions: { months: 1, units: 1, promotions: ['other'] },
      from: '2026-01',
      today: '2026-01-15',
    });
    assert.deepEqual(result.promotions, []);
    assert.equal(result.price, 100_000);
  });

  it('charges a campaign\'s spend in the month it starts', () => {
    const campaign = promotion({ id: 'c', kind: 'percent', value: 0, spend: 80_000, starts_on: '2026-03-01' });
    const result = simulate({
      product: product(),
      prices: [price({ amount: 10_000 })],
      costs: [],
      promotions: [campaign],
      assumptions: { months: 4, units: 1, deliveries: 0, promotions: ['c'] },
      from: '2026-01',
      today: '2026-01-15',
    });
    assert.equal(result.months[0].cost, 0);
    assert.equal(result.months[2].cost, 80_000, 'March, which is when it starts');
  });
});

/* ---------------------------------------------------------------- health */

describe('how a product is doing', () => {
  const judge = (over: { price: number | null; unitCost: number; costs?: boolean }) => healthOfProduct({
    economics: {
      currency: 'EUR',
      price: over.price,
      unitCost: over.unitCost,
      contribution: over.price === null ? null : over.price - over.unitCost,
      marginBps: over.price === null || over.price === 0
        ? null
        : Math.round(((over.price - over.unitCost) * 10_000) / over.price),
    },
    structure: { period: over.costs === false ? 0 : 1, delivery: 0, unit: over.unitCost },
  });

  it('separates the two states a catalogue paints green by omission', () => {
    assert.equal(judge({ price: null, unitCost: 0 }), 'unpriced');
    assert.equal(judge({ price: 100_000, unitCost: 0, costs: false }), 'no_costs');
  });

  it('names a loss before it names a thin margin', () => {
    assert.equal(judge({ price: 10_000, unitCost: 12_000 }), 'loss');
    assert.equal(judge({ price: 10_000, unitCost: 8_500 }), 'thin');
    assert.equal(judge({ price: 10_000, unitCost: 5_000 }), 'healthy');
  });

  it('does not call a product given away while costing something healthy', () => {
    // A price of exactly zero has no margin to take a share of, so the margin
    // is null — and falling through on that null painted it green.
    assert.equal(judge({ price: 0, unitCost: 0 }), 'thin');
  });
});

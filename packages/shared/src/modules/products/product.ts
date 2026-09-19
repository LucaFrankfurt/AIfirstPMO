/**
 * What a product is worth, what it costs, and when it starts paying for itself.
 *
 * Every figure the catalogue screens, the simulations and the MCP tools show is
 * computed here, from rows, on demand — the decision `budget.ts` made and for
 * the same two reasons. A stored margin is a number that goes stale the moment
 * somebody edits a cost on a train, and two devices that each edited a
 * different cost would then hold two margins with no way to merge them.
 *
 * The whole file is pure functions over plain objects, so the server can run it
 * against SQLite rows and the browser against its local mirror and neither can
 * disagree with the other about whether a product breaks even. That is not
 * hypothetical here: `break_even` answers from the server over MCP and the
 * product screen draws the same number in the client, and two implementations
 * of "how much of a monthly cost falls inside a nine-month horizon" would have
 * differed by one month about half the time.
 *
 * Money is `Minor` throughout and proportions are **basis points**, both
 * borrowed from `budget.ts` rather than restated: one number, one source. The
 * one thing this file deliberately does *not* do is convert between currencies.
 * A product priced in two of them is two answers, never a sum.
 */
import {
  COST_RECURRENCES,
  type Base, type CostBasis, type CostCategory, type CostRecurrence, type ID, type ISODate, type Minor,
  type Product, type ProductAssumptions, type ProductContributor, type ProductCost, type ProductPart,
  type ProductPrice, type Promotion, type PromotionKind, type PromotionStatus,
} from '../../kernel/registry/types.ts';
import { addMonths, type Month, monthOf, FULL_SHARE } from '../budgets/budget.ts';

/** How many months one charging period covers. `once` is not a period at all. */
const MONTHS_PER: Record<CostRecurrence, number> = { once: 0, monthly: 1, quarterly: 3, yearly: 12 };

/**
 * A proportion of the whole, in basis points. 10000 is all of it.
 *
 * The same unit `Allocation.share` uses, and imported from there rather than
 * declared again — a second constant with the same value is a second constant
 * somebody will eventually change.
 */
export const FULL_BPS = FULL_SHARE;

/** Apply a basis-point factor to an amount, rounding once. */
const scaleBps = (amount: Minor, bps: number): Minor => Math.round((amount * bps) / FULL_BPS);

/* -------------------------------------------------------------- the price */

/**
 * The price a given order pays on a given day.
 *
 * Three filters and one preference, in that order, because a product with four
 * prices has to answer this deterministically on two devices that hold the rows
 * in different orders:
 *
 * 1. **Kind.** `internal` is never picked unless it is asked for. A transfer
 *    price is not a discount and it must not land in a revenue figure.
 * 2. **Validity.** A price whose window has closed is not a price. A window
 *    that has not opened yet is not one either — which is the case somebody
 *    enters in October for January and would otherwise see applied in October.
 * 3. **Quantity.** Only prices whose `min_quantity` the order reaches.
 *
 * Of what is left, the one with the **highest `min_quantity`** wins — the most
 * specific volume tier the order qualifies for. Then the **shortest
 * commitment**, then the lowest amount, then the id so that two devices reach
 * the same row rather than a mergeable-looking pair of different ones.
 *
 * **The commitment was not in that list and had to be.** The tie-break used to
 * go straight to the lowest amount, justified by "two tiers at the same
 * threshold is somebody mid-edit and the customer should not pay for that".
 * That stopped being true the moment a price could carry its own term: a
 * catalogue selling one module at 64 EUR with no commitment, 59 EUR on a year
 * and 54 EUR on two has three tiers at one threshold on purpose, and the rule
 * as written answered 54 EUR — so every margin, break-even and simulation on
 * the product was quietly figured against the two-year price, and the screen
 * marked it "applies today" to somebody who had signed nothing.
 *
 * An order that says nothing about a commitment has made none, so the price
 * that asks for none is the one it pays. `termMonths` is how a caller that
 * *does* know says so, the same way `recurrence` and `quantity` already do.
 *
 * Null when the product has no applicable price at all, which is a real state:
 * a draft product nobody has priced. Every caller renders it as "not priced"
 * rather than as zero, because a margin computed against a price of nothing is
 * a very confident wrong answer.
 */
export function priceFor(
  prices: readonly ProductPrice[],
  options: {
    quantity?: number;
    on?: ISODate;
    kind?: ProductPrice['kind'];
    /** Only prices charged this often. Omitted, every period is eligible. */
    recurrence?: CostRecurrence;
    /** Only prices asking for exactly this commitment, in months. */
    termMonths?: number;
    /** What a price that names no term commits to. See `Product.term_months`. */
    productTerm?: number;
  } = {},
): ProductPrice | null {
  const quantity = Math.max(1, Math.round(options.quantity ?? 1));
  const on = options.on ?? null;
  const productTerm = options.productTerm ?? 0;
  const termOf = (price: ProductPrice) => price.term_months ?? productTerm;
  const eligible = prices.filter((price) => {
    if (options.kind ? price.kind !== options.kind : price.kind === 'internal') return false;
    if (options.recurrence && price.recurrence !== options.recurrence) return false;
    if (options.termMonths !== undefined && termOf(price) !== options.termMonths) return false;
    if (on && price.valid_from && price.valid_from > on) return false;
    if (on && price.valid_to && price.valid_to < on) return false;
    return Math.max(1, price.min_quantity || 1) <= quantity;
  });
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) =>
    (Math.max(1, b.min_quantity || 1) - Math.max(1, a.min_quantity || 1))
    || (termOf(a) - termOf(b))
    || (comparableAmount(a) - comparableAmount(b))
    || (a.id < b.id ? -1 : 1))[0]!;
}

/**
 * What two prices can honestly be ranked by.
 *
 * The tie-break above used to be `a.amount - b.amount`, and that compared
 * numbers which do not mean the same thing. A product sold at €49.00 a month
 * and at €490.00 a year has 4900 and 49000 on its two rows; the raw comparison
 * calls the monthly one cheaper, and per month it is the dearer of the two —
 * €49.00 against €40.83. The first product anybody modelled with more than one
 * billing period hit it, because that is what a subscription business *is*.
 *
 * So a recurring price ranks by what it costs **per month** and a one-off ranks
 * by itself. Mixing the two on one product is not resolved by arithmetic and is
 * not silently averaged either: `mixedPeriods` below says so, and the screens
 * show the sentence rather than a number that looks decided.
 */
export function comparableAmount(price: Pick<ProductPrice, 'amount' | 'recurrence'>): Minor {
  const perMonth = monthlyAmount(price.amount, price.recurrence);
  return perMonth || price.amount;
}

/**
 * The billing periods a product is actually sold in, in a fixed order.
 *
 * `COST_RECURRENCES` order rather than the order the rows arrive in, so two
 * devices holding the same prices list them the same way.
 */
export function periodsOf(prices: readonly ProductPrice[]): CostRecurrence[] {
  const seen = new Set(prices.filter((price) => price.kind !== 'internal').map((price) => price.recurrence));
  return COST_RECURRENCES.filter((every) => seen.has(every));
}

/**
 * Whether a product is sold both as a sale and as a subscription.
 *
 * A real thing — a licence with a one-off setup fee — and a state no single
 * figure describes, which is why it is a question rather than a computation.
 * `€1 200 once` and `€49 a month` have no common denominator that is not an
 * assumption about how long somebody stays.
 */
export const mixedPeriods = (prices: readonly ProductPrice[]): boolean => {
  const periods = periodsOf(prices);
  return periods.includes('once') && periods.length > 1;
};

/**
 * The commitments one offer is sold on, and what it costs on each.
 *
 * `periodsOf` answers how *often* a product is billed, and for a catalogue
 * built out of subscription modules that answer is "monthly" and says nothing.
 * Calendoora sells Buchung at 64 EUR with no commitment, 59 EUR on a year and
 * 54 EUR on two — three rows, one billing period, three different offers. The
 * list showed a single chip reading "monthly" and a single price of 64, which
 * is both the dearest of the three and the only one a customer can decline.
 *
 * Only prices that are the *same offer* are gathered: same kind, same billing
 * period, same threshold, differing in the term alone. A partner price or a
 * ten-seat price is a different offer rather than a longer version of this one,
 * and a span that mixed them would name an amount nobody is charged.
 *
 * Empty when the product has no applicable price, and a single entry when it
 * is sold on one commitment — the screens can then treat "more than one" as
 * the question it is.
 */
export function termsOf(
  prices: readonly ProductPrice[],
  options: { on?: ISODate; quantity?: number; productTerm?: number } = {},
): { months: number; amount: Minor; price: ProductPrice }[] {
  const quoted = priceFor(prices, options);
  if (!quoted) return [];
  const productTerm = options.productTerm ?? 0;
  const lane = (price: ProductPrice) => `${price.kind}|${price.recurrence}|${Math.max(1, price.min_quantity || 1)}`;
  const wanted = lane(quoted);
  const byTerm = new Map<number, ProductPrice>();
  for (const price of prices) {
    if (lane(price) !== wanted) continue;
    const term = price.term_months ?? productTerm;
    // Whichever of two prices on the same term `priceFor` would quote, so this
    // never disagrees with the figure beside it.
    const better = priceFor([price, ...(byTerm.has(term) ? [byTerm.get(term)!] : [])], { ...options, termMonths: term });
    if (better) byTerm.set(term, better);
  }
  return [...byTerm.entries()]
    .sort(([a], [b]) => a - b)
    .map(([months, price]) => ({ months, amount: comparableAmount(price), price }));
}

/**
 * Which prices are alternatives to one another rather than a change of one.
 *
 * Two prices are in the same **lane** when they are the same offer to the same
 * buyer: same kind, same billing period, same threshold, same commitment. A
 * list price and a ten-seat volume price are two lanes and both live at once;
 * last year's list price and this year's are one lane, one after the other.
 *
 * **The term joined the key after a real catalogue did not fit.** Calendoora
 * sells one module at three terms at once — 64 EUR a month with no commitment,
 * 59 EUR on a year, 54 EUR on two — all billed monthly, all list prices, all
 * for one seat. Without the term those three were one lane: `overlappingPrices`
 * reported three collisions and `priceHistory` read them as a price falling
 * twice. They are three offers standing side by side, and the only thing
 * telling them apart is what the customer signs up to.
 *
 * A null term is the product's own, so it reads as that number rather than as
 * a fourth lane — otherwise a price that defers and a price that states the
 * same figure would be alternatives to each other, which they are not.
 *
 * The lane is a derived key rather than a column because it is a fact about
 * those fields and would go stale as one of them changed.
 */
export const priceLane = (
  price: Pick<ProductPrice, 'kind' | 'recurrence' | 'min_quantity' | 'term_months'>,
  productTerm = 0,
): string => {
  const term = price.term_months ?? productTerm;
  return `${price.kind}|${price.recurrence}|${Math.max(1, price.min_quantity || 1)}|${term}`;
};

/** Whether a price's window is open on a day. Both dates absent is always. */
export function priceApplies(price: Pick<ProductPrice, 'valid_from' | 'valid_to'>, on: ISODate): boolean {
  if (price.valid_from && price.valid_from > on) return false;
  if (price.valid_to && price.valid_to < on) return false;
  return true;
}

/** One step in a lane's history: what it was, what it became, and from when. */
export interface PriceChange {
  lane: string;
  from: ProductPrice;
  to: ProductPrice;
  /** The day the new one takes over — its `valid_from`, or the day it was made. */
  on: ISODate;
  /** The difference, in minor units. Negative is a cut. */
  delta: Minor;
  /** The difference as basis points of the old price. Null when it was zero. */
  deltaBps: number | null;
}

/**
 * A product's price history, lane by lane, oldest first.
 *
 * There is no `product_price_versions` table and there should not be one. A
 * page has versions because its body is *overwritten* — the old text exists
 * only if something copied it first. A price is never overwritten: raising one
 * closes a window and opens another, so the old row, with its `valid_to` in the
 * past, already **is** the historical price, and `priceFor` has always read it
 * that way. A second table would be a copy of rows that are still there.
 *
 * Ordered by when each price takes effect, with `created_at` settling the ties
 * — two prices starting the same day is somebody correcting a mistake, and the
 * later edit is the one that stands.
 */
export function priceHistory(prices: readonly ProductPrice[], productTerm = 0): PriceChange[] {
  const lanes = new Map<string, ProductPrice[]>();
  for (const price of prices) {
    const lane = priceLane(price, productTerm);
    lanes.set(lane, [...(lanes.get(lane) ?? []), price]);
  }
  const out: PriceChange[] = [];
  for (const [lane, listed] of lanes) {
    const ordered = [...listed].sort((a, b) =>
      (a.valid_from ?? '').localeCompare(b.valid_from ?? '') || a.created_at - b.created_at);
    for (let index = 1; index < ordered.length; index++) {
      const from = ordered[index - 1]!;
      const to = ordered[index]!;
      const delta = to.amount - from.amount;
      out.push({
        lane,
        from,
        to,
        on: to.valid_from ?? new Date(to.created_at).toISOString().slice(0, 10),
        delta,
        deltaBps: from.amount === 0 ? null : Math.round((delta * FULL_BPS) / from.amount),
      });
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

/**
 * Prices that are live at the same time in the same lane.
 *
 * Two list prices both open today is not a tier and not a history — it is a
 * price change where somebody forgot to close the old one, and `priceFor`
 * answers it deterministically without anybody knowing which of the two won.
 * Reported rather than resolved: which one was meant is not ours to guess.
 *
 * Compared as windows rather than on one day, so a pair that will collide in
 * March is found in January. An open end is a window that never closes.
 */
export function overlappingPrices(prices: readonly ProductPrice[], productTerm = 0): [ProductPrice, ProductPrice][] {
  const out: [ProductPrice, ProductPrice][] = [];
  const lanes = new Map<string, ProductPrice[]>();
  for (const price of prices) {
    const lane = priceLane(price, productTerm);
    lanes.set(lane, [...(lanes.get(lane) ?? []), price]);
  }
  for (const listed of lanes.values()) {
    for (let a = 0; a < listed.length; a++) {
      for (let b = a + 1; b < listed.length; b++) {
        const one = listed[a]!;
        const two = listed[b]!;
        const startsAfter = (x: ProductPrice, y: ProductPrice) => !!y.valid_to && !!x.valid_from && x.valid_from > y.valid_to;
        if (startsAfter(one, two) || startsAfter(two, one)) continue;
        out.push(one.id < two.id ? [one, two] : [two, one]);
      }
    }
  }
  return out;
}

/**
 * Why a price cannot change on a given day, or null if it can.
 *
 * Separate from `raisePrice` so a form can grey the button out and say which
 * way the date is wrong, rather than letting somebody press save and catch an
 * exception. The two answers are the two ends of the old price's window: a
 * change takes effect strictly after it started — the old one has to keep at
 * least one day to be the price it was — and not after it ended, because a
 * price that already stopped is not the one being changed.
 */
export function priceChangeRefusal(
  price: Pick<ProductPrice, 'valid_from' | 'valid_to'>,
  on: ISODate,
): 'before-start' | 'after-end' | null {
  if (price.valid_from && on <= price.valid_from) return 'before-start';
  if (price.valid_to && on > price.valid_to) return 'after-end';
  return null;
}

/**
 * The two rows a price change is made of: the old one closed, the new one open.
 *
 * Returned as a pair rather than written, because `@kolibri/shared` writes
 * nothing — but it is one function so that the client and MCP cannot disagree
 * about the boundary. The old window closes the **day before** the new one
 * opens: sharing a day would leave both live for twenty-four hours, which is
 * the overlap above and the exact mistake this exists to prevent.
 *
 * Everything else about the price carries over. A change of amount is a change
 * of amount; changing the threshold or the period at the same time makes it a
 * different offer, which is a new price rather than a new version of this one.
 *
 * **Refuses a day the old window does not contain**, because all three ways out
 * of it are silent. Landing on or before its `valid_from` closes it before it
 * opened, and an inverted window matches *no* day, so the old price does not
 * become history — it disappears, from the history table and from `priceFor`
 * alike. Landing after its `valid_to` is the mirror: the close date moves
 * *later* than the end somebody already set, quietly reselling a price that had
 * stopped, and the new row inherits that same past `valid_to` and is born
 * inverted too. Nothing in the schema forbids `valid_to < valid_from`, and
 * nothing downstream reports it; `priceChangeRefusal` is how a caller asks
 * before writing, and this throw is the backstop for one that did not.
 */
export function raisePrice(
  price: ProductPrice,
  input: { amount: Minor; on: ISODate },
): { closes: { id: ID; valid_to: ISODate }; opens: Omit<ProductPrice, keyof Base> & { product_id: ID } } {
  const refusal = priceChangeRefusal(price, input.on);
  if (refusal) throw new Error(`a price cannot change on ${input.on}: ${refusal}`);
  return {
    closes: { id: price.id, valid_to: dayBefore(input.on) },
    opens: {
      workspace_id: price.workspace_id,
      product_id: price.product_id,
      name: price.name,
      kind: price.kind,
      amount: input.amount,
      min_quantity: price.min_quantity,
      recurrence: price.recurrence,
      term_months: price.term_months,
      valid_from: input.on,
      valid_to: price.valid_to,
      note: price.note,
      sort_order: price.sort_order,
    },
  };
}

/** The day before an ISO date, without a timezone anywhere near it. */
export function dayBefore(date: ISODate): ISODate {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/**
 * A price over one month, whatever it is charged over.
 *
 * What makes a €1 200 annual licence and a €100 monthly one comparable, and
 * the reason every revenue figure in a simulation goes through it. A `once`
 * price has no monthly value at all — it is a sale, not a rate — and returns
 * zero here rather than pretending to be one twelfth of itself.
 */
export function monthlyAmount(amount: Minor, recurrence: CostRecurrence): Minor {
  const months = MONTHS_PER[recurrence] ?? 0;
  return months ? Math.round(amount / months) : 0;
}

/* --------------------------------------------------------------- the cost */

/** What a product's costs and fees come to, split the way a break-even needs. */
export interface CostStructure {
  /** Incurred every month the product exists, whatever is sold. */
  period: Minor;
  /** Incurred each time it is delivered, whoever attends. */
  delivery: Minor;
  /** Incurred per unit sold. The only one that comes off the price. */
  unit: Minor;
}

const EMPTY_STRUCTURE: CostStructure = { period: 0, delivery: 0, unit: 0 };

/**
 * Every cost of a product, by what it varies with.
 *
 * Contributors are folded in here rather than counted separately, and that is
 * the point of them sharing `CostBasis`: an external speaker on a day fee is a
 * delivery cost and has to be one everywhere, or the break-even and the margin
 * disagree about the same product. That they are *also* people with addresses
 * and calendars is why they are a table of their own — see `ProductContributor`.
 *
 * `factorBps` moves every figure at once, which is what a scenario's `cost_bps`
 * is. Applied here rather than by the caller so that no caller can apply it to
 * two of the three.
 */
export function costStructure(input: {
  costs: readonly ProductCost[];
  contributors?: readonly ProductContributor[];
  factorBps?: number;
  /** For a package: what is in it, and what one of each costs. See below. */
  parts?: readonly ProductPart[];
  unitCostOfPart?: (productId: ID) => Minor;
}): CostStructure {
  const out: CostStructure = { ...EMPTY_STRUCTURE };
  for (const cost of input.costs) out[cost.basis in out ? cost.basis : 'unit'] += Math.round(Number(cost.amount) || 0);
  for (const person of input.contributors ?? []) {
    const basis = (person.fee_basis in out ? person.fee_basis : 'delivery') as CostBasis;
    out[basis] += Math.round(Number(person.fee) || 0);
  }
  /*
   * A package costs what its parts cost, and only the **unit** half of it.
   *
   * Without this a package is free: a bundle of two seminars with no cost rows
   * of its own came out at a hundred per cent margin and `no_costs`, which is
   * the most confident wrong number the catalogue could produce. Selling one
   * package delivers `quantity` of each part, so `quantity × the part's unit
   * cost` is exactly what it costs to hand over.
   *
   * The fixed half deliberately does **not** roll up. A part's `period` cost is
   * a monthly bill the business pays once — the platform licence does not cost
   * twice because a package also references it — and adding it here would count
   * it again in every catalogue total that sums both. Whose delivery a package
   * shares is a question only the team can answer, so the package carries its
   * own `delivery` rows and nothing is invented. See `docs/products.md`.
   */
  if (input.parts && input.unitCostOfPart) {
    for (const part of input.parts) {
      out.unit += Math.max(1, Math.round(part.quantity) || 1) * input.unitCostOfPart(part.part_id);
    }
  }
  const factor = input.factorBps ?? FULL_BPS;
  if (factor === FULL_BPS) return out;
  return { period: scaleBps(out.period, factor), delivery: scaleBps(out.delivery, factor), unit: scaleBps(out.unit, factor) };
}

/**
 * What one unit of a product costs to hand over, its parts included, at any depth.
 *
 * Memoised and cycle-guarded. The server refuses a package that contains itself
 * — see the write path's `refuseCycle` — but a client's mirror can hold a stale
 * ring for the length of one sync, and an unguarded recursion there is a white
 * screen rather than a wrong number. A product already being walked contributes
 * nothing to itself, which is the only answer that terminates.
 */
export function unitCosts(input: {
  costsOf: (productId: ID) => readonly ProductCost[];
  contributorsOf?: (productId: ID) => readonly ProductContributor[];
  partsOf?: (productId: ID) => readonly ProductPart[];
}): (productId: ID) => Minor {
  const cache = new Map<ID, Minor>();
  const walking = new Set<ID>();
  const of = (productId: ID): Minor => {
    const hit = cache.get(productId);
    if (hit !== undefined) return hit;
    if (walking.has(productId)) return 0;
    walking.add(productId);
    let total = 0;
    for (const cost of input.costsOf(productId)) if (cost.basis === 'unit') total += Math.round(Number(cost.amount) || 0);
    for (const person of input.contributorsOf?.(productId) ?? []) {
      if (person.fee_basis === 'unit') total += Math.round(Number(person.fee) || 0);
    }
    for (const part of input.partsOf?.(productId) ?? []) {
      total += Math.max(1, Math.round(part.quantity) || 1) * of(part.part_id);
    }
    walking.delete(productId);
    cache.set(productId, total);
    return total;
  };
  return of;
}

/** Costs grouped by the budget's own vocabulary, for the chart that compares the two. */
export function costsByCategory(costs: readonly ProductCost[]): { category: CostCategory; amount: Minor }[] {
  const out = new Map<CostCategory, Minor>();
  for (const cost of costs) out.set(cost.category, (out.get(cost.category) ?? 0) + (Math.round(Number(cost.amount)) || 0));
  return [...out].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}

/* ----------------------------------------------------------- unit economics */

/**
 * What one unit earns before any of the fixed costs are paid for.
 *
 * The figure everything else is built on, and the one a catalogue is read for:
 * a product whose contribution is negative cannot be saved by volume, and no
 * amount of break-even arithmetic will say so as plainly as this does.
 *
 * `price` is null when nothing applies — see `priceFor`. Everything derived
 * from it is then null as well rather than zero, because a margin of 0% and a
 * product nobody has priced look identical on a screen and are not the same
 * thing at all.
 */
export interface UnitEconomics {
  currency: string;
  /** What one unit is sold for, or null when it has no price. */
  price: Minor | null;
  /** What one unit costs to deliver: the `unit` half of the structure. */
  unitCost: Minor;
  /** Price less unit cost. Null when there is no price. */
  contribution: Minor | null;
  /** Contribution as basis points of the price. Null when there is no price. */
  marginBps: number | null;
}

export function unitEconomics(input: {
  product: Pick<Product, 'currency'>;
  prices: readonly ProductPrice[];
  costs: readonly ProductCost[];
  contributors?: readonly ProductContributor[];
  parts?: readonly ProductPart[];
  unitCostOfPart?: (productId: ID) => Minor;
  quantity?: number;
  on?: ISODate;
  priceBps?: number;
  costBps?: number;
}): UnitEconomics {
  const chosen = priceFor(input.prices, { quantity: input.quantity, on: input.on });
  const structure = costStructure({
    costs: input.costs,
    contributors: input.contributors,
    parts: input.parts,
    unitCostOfPart: input.unitCostOfPart,
    factorBps: input.costBps,
  });
  const price = chosen ? scaleBps(chosen.amount, input.priceBps ?? FULL_BPS) : null;
  const contribution = price === null ? null : price - structure.unit;
  return {
    currency: input.product.currency || 'EUR',
    price,
    unitCost: structure.unit,
    contribution,
    // Against the price rather than against the cost: margin is the share of
    // what the customer pays that the business keeps, and the other reading —
    // mark-up — is a different number that people quote in the same sentence.
    marginBps: price === null || price === 0 ? null : Math.round((contribution! * FULL_BPS) / price),
  };
}

/* --------------------------------------------------------------- break-even */

/**
 * How much has to be sold before the fixed costs are covered.
 *
 * `reachable` is the field that matters and the reason this returns an object
 * rather than a number. Three ways it is false, and each is a different
 * sentence on the screen:
 *
 * - **No price.** Nobody has said what it costs, so there is nothing to solve.
 * - **Contribution at or below zero.** Every unit sold loses money. There is no
 *   volume that fixes this, and a break-even of `Infinity` rendered as a very
 *   large number is how somebody comes away thinking it is merely ambitious.
 * - **Above capacity.** The arithmetic has an answer and the business cannot
 *   deliver it: nineteen seats in a room that holds twelve. This is the one a
 *   spreadsheet never catches, because a spreadsheet does not know about rooms.
 *
 * The horizon is explicit rather than assumed. A fixed cost only means
 * something against a length of time — €400 a month is one break-even over a
 * quarter and another over a year — and a function that picked twelve months
 * quietly would be picking the answer.
 */
export interface BreakEven {
  /** Fixed cost over the horizon: period costs by month, delivery costs by run. */
  fixed: Minor;
  /** Contribution per unit, or null when there is no price. */
  contribution: Minor | null;
  /** Units needed over the whole horizon. Null when there is no answer. */
  units: number | null;
  /** What those units are worth. Null when `units` is. */
  revenue: Minor | null;
  /** Units per delivery, when there is more than one. Null when `units` is. */
  unitsPerDelivery: number | null;
  /** Whether the answer is one the business can actually reach. */
  reachable: boolean;
  /** Why not, when it is not: `no_price`, `no_contribution` or `over_capacity`. */
  blocked: 'no_price' | 'no_contribution' | 'over_capacity' | null;
}

export function breakEven(input: {
  product: Pick<Product, 'capacity'>;
  economics: Pick<UnitEconomics, 'price' | 'contribution'>;
  structure: CostStructure;
  /** Months the fixed period costs run for. At least one. */
  months: number;
  /** Deliveries over the whole horizon. Zero is a product that is not delivered. */
  deliveries: number;
}): BreakEven {
  const months = Math.max(1, Math.round(input.months) || 1);
  const deliveries = Math.max(0, Math.round(input.deliveries) || 0);
  const fixed = input.structure.period * months + input.structure.delivery * deliveries;
  const { price, contribution } = input.economics;

  if (price === null || contribution === null) {
    return { fixed, contribution: null, units: null, revenue: null, unitsPerDelivery: null, reachable: false, blocked: 'no_price' };
  }
  if (contribution <= 0) {
    return { fixed, contribution, units: null, revenue: null, unitsPerDelivery: null, reachable: false, blocked: 'no_contribution' };
  }
  // Ceiling, not rounding: half a seat does not cover half a room.
  const units = Math.ceil(fixed / contribution);
  const perDelivery = deliveries > 0 ? Math.ceil(units / deliveries) : null;
  const capacity = input.product.capacity;
  const overCapacity = capacity != null && capacity > 0
    && (perDelivery != null ? perDelivery > capacity : units > capacity);
  return {
    fixed,
    contribution,
    units,
    revenue: units * price,
    unitsPerDelivery: perDelivery,
    reachable: !overCapacity,
    blocked: overCapacity ? 'over_capacity' : null,
  };
}

/* -------------------------------------------------------------- promotions */

/** Where a promotion stands against today. Derived, never stored. */
export type PromotionPhase = 'draft' | 'cancelled' | 'upcoming' | 'running' | 'ended';

/**
 * Whether a promotion is running today, from the dates rather than a column.
 *
 * A stored phase is wrong by the next morning and right again by accident, and
 * the two bugs that produces — a campaign that keeps discounting after it ended,
 * and one that never starts because nobody ran the job — are both silent. An
 * open start means "already", an open end means "until somebody stops it": the
 * two readings somebody leaving a date field empty actually intends.
 */
export function promotionPhase(
  promotion: Pick<Promotion, 'status' | 'starts_on' | 'ends_on'>,
  today: ISODate,
): PromotionPhase {
  if (promotion.status !== 'live') return promotion.status as Exclude<PromotionStatus, 'live'>;
  if (promotion.starts_on && promotion.starts_on > today) return 'upcoming';
  if (promotion.ends_on && promotion.ends_on < today) return 'ended';
  return 'running';
}

/**
 * Whether a promotion covers a product.
 *
 * Empty `products` *and* empty `groups` is the whole catalogue, which is the
 * same rule `coversProject` follows and for the same reason: writing every
 * product into a campaign that means "everything" would mean keeping that list
 * correct as products are created, forever, for no gain.
 */
export function promotionCovers(
  promotion: Pick<Promotion, 'products' | 'groups'>,
  product: Pick<Product, 'id' | 'group_id'>,
): boolean {
  const products = promotion.products ?? [];
  const groups = promotion.groups ?? [];
  if (!products.length && !groups.length) return true;
  if (products.includes(product.id)) return true;
  return !!product.group_id && groups.includes(product.group_id);
}

/** The promotions running against a product on a day, in the order they were made. */
export function promotionsFor(
  promotions: readonly Promotion[],
  product: Pick<Product, 'id' | 'group_id'>,
  today: ISODate,
): Promotion[] {
  return promotions
    .filter((promotion) => promotionPhase(promotion, today) === 'running')
    .filter((promotion) => promotionCovers(promotion, product));
}

/**
 * A price after one promotion.
 *
 * Never below zero. A 120% discount is somebody mistyping basis points, and a
 * negative price would flow straight into a revenue projection as income the
 * business pays out — which looks like a rounding problem three screens later.
 */
export function applyPromotion(price: Minor, promotion: Pick<Promotion, 'kind' | 'value'>): Minor {
  const value = Math.round(Number(promotion.value) || 0);
  const after = ((): Minor => {
    switch (promotion.kind as PromotionKind) {
      case 'percent': return price - scaleBps(price, Math.min(value, FULL_BPS));
      case 'amount': return price - value;
      case 'price': return value;
      default: return price;
    }
  })();
  return Math.max(0, after);
}

/**
 * A price after every promotion that applies, cheapest first.
 *
 * Stacking is deliberate and so is the order. Applying them in the order the
 * rows happen to arrive would give two devices two prices; applying the
 * *deepest* discount first and the rest to what is left is both deterministic
 * and the reading a customer will argue for.
 */
export function promotedPrice(
  price: Minor,
  promotions: readonly Pick<Promotion, 'id' | 'kind' | 'value'>[],
): Minor {
  const ordered = [...promotions].sort((a, b) =>
    applyPromotion(price, a) - applyPromotion(price, b) || (a.id < b.id ? -1 : 1));
  let out = price;
  for (const promotion of ordered) out = applyPromotion(out, promotion);
  return out;
}

/* --------------------------------------------------------- what a campaign does */

/**
 * What a campaign does to one product's price, and what it has to earn back.
 *
 * The campaign screen used to show only what somebody typed: a percentage, a
 * window, a spend. Not one figure was computed, so "50% off Buchung" never said
 * 64 € becomes 32 €, and nothing anywhere said what that costs.
 */
export interface PromotionReach {
  product: Product;
  /** What it would cost without this campaign. Null when the product has no price. */
  list: Minor | null;
  /** What it costs under this campaign alone — not stacked with any other. */
  promoted: Minor | null;
  /** Given away per sale. Zero when there is no price to discount. */
  discount: Minor;
  /** That discount as a share of the list price. Null when the list price is zero. */
  discountBps: number | null;
  /** What one sale still contributes after the discount and the unit cost. */
  contribution: Minor | null;
  breakEven: PromotionBreakEven;
}

/**
 * When a campaign starts being worth running.
 *
 * Three answers rather than a number, because two of them are not numbers. A
 * campaign with no spend that earns more per extra sale than it gives away on
 * the rest pays at **any** volume; one whose expected uplift cannot cover what
 * the discount costs on the sales that would have happened anyway pays at
 * **none**. Returning 0 and Infinity for those would put two very different
 * statements in one column and let a reader mistake either for a threshold.
 */
export type PromotionBreakEven =
  | { kind: 'always' }
  | { kind: 'never'; why: 'no-uplift' | 'uplift-too-small' | 'no-price' }
  | { kind: 'above'; units: number };

/**
 * The baseline volume a campaign needs before it pays for itself.
 *
 * Every sale that would have happened anyway costs the discount; every sale the
 * campaign *causes* earns the contribution that is left after it. With `b` the
 * baseline, `u` the expected uplift and `c` the contribution after the discount:
 *
 *     spend + b × discount = b × u × c        →        b = spend / (u × c − discount)
 *
 * **This is the first thing that uses `uplift_bps`, and the distinction matters.**
 * `TODO.md` records that a simulation deliberately does *not* raise its volumes
 * by the expected uplift: a projection that silently inflates itself by a number
 * nobody has been held to is the kind of confident wrong figure this repository
 * is written against. A break-even is the opposite move — it makes the guess
 * load-bearing *and* visible, and answers "at what point would this have been
 * worth it", which is a question about the assumption rather than a forecast
 * dressed as a fact. The screens say whose number it is.
 *
 * An uplift of zero therefore reads as **never**, and it should: a discount
 * nobody expects to sell more is a giveaway, and the arithmetic says so rather
 * than dividing by zero and reporting something.
 */
export function promotionBreakEven(input: {
  spend: Minor;
  /** Given away per sale. */
  discount: Minor;
  /** What one sale contributes after that discount. Null when there is no price. */
  contribution: Minor | null;
  upliftBps: number;
}): PromotionBreakEven {
  if (input.contribution === null) return { kind: 'never', why: 'no-price' };
  if (input.upliftBps <= 0) return { kind: 'never', why: 'no-uplift' };
  const earned = (input.upliftBps * input.contribution) / FULL_BPS;
  const gap = earned - input.discount;
  if (gap <= 0) return { kind: 'never', why: 'uplift-too-small' };
  const spend = Math.max(0, Math.round(Number(input.spend) || 0));
  if (spend === 0) return { kind: 'always' };
  return { kind: 'above', units: Math.ceil(spend / gap) };
}

/**
 * Every product a campaign touches, and what it does to each.
 *
 * Per product rather than as one total, because a campaign covering four
 * products discounts four different prices by four different amounts, and the
 * sum of them is a number nobody can act on without a volume mix nothing here
 * records. Four rows that each mean something beat one that does not.
 *
 * The promoted price is this campaign **alone**. What a customer actually pays
 * when two campaigns run at once is `promotedPrice`, and that they stack is
 * what `stackedPromotions` is for — showing the stacked figure here would hide
 * the collision rather than report it.
 */
export function promotionReach(input: {
  promotion: Promotion;
  products: readonly Product[];
  pricesOf: (id: ID) => readonly ProductPrice[];
  /** What one unit costs to deliver. Nothing recorded is zero, not unknown. */
  unitCostOf?: (id: ID) => Minor;
  on: ISODate;
}): PromotionReach[] {
  const live = input.products.filter((product) => !product.archived && !product.deleted_at);
  return live
    .filter((product) => promotionCovers(input.promotion, product))
    .map((product) => {
      const price = priceFor(input.pricesOf(product.id), { on: input.on, productTerm: product.term_months });
      const list = price ? price.amount : null;
      const promoted = list === null ? null : applyPromotion(list, input.promotion);
      const discount = list === null || promoted === null ? 0 : list - promoted;
      const unitCost = input.unitCostOf?.(product.id) ?? 0;
      const contribution = promoted === null ? null : promoted - unitCost;
      return {
        product,
        list,
        promoted,
        discount,
        discountBps: list === null || list === 0 ? null : Math.round((discount * FULL_BPS) / list),
        contribution,
        breakEven: promotionBreakEven({
          spend: input.promotion.spend,
          discount,
          contribution,
          upliftBps: Number(input.promotion.uplift_bps) || 0,
        }),
      };
    });
}

/**
 * Campaigns that will both be applied to the same product at the same time.
 *
 * `promotedPrice` stacks them — deliberately, and deterministically, deepest
 * discount first. What it cannot do is tell anybody it happened: two live 50%
 * campaigns on one product make it 25% of list, and the only place that shows
 * is a price three screens away that looks wrong. This is the same reporting
 * `overlappingPrices` does one floor down, for the same reason — the arithmetic
 * is fine, the surprise is not.
 *
 * Compared as windows rather than on one day, so a pair that will collide in
 * March is found in January. A campaign that is not live at all cannot collide
 * with anything.
 */
export function stackedPromotions(
  promotions: readonly Promotion[],
  products: readonly Product[],
): { a: Promotion; b: Promotion; products: Product[] }[] {
  const live = promotions.filter((promotion) => promotion.status === 'live' && !promotion.deleted_at);
  const sellable = products.filter((product) => !product.archived && !product.deleted_at);
  const out: { a: Promotion; b: Promotion; products: Product[] }[] = [];
  const overlaps = (a: Promotion, b: Promotion) => {
    const after = (x: Promotion, y: Promotion) => !!y.ends_on && !!x.starts_on && x.starts_on > y.ends_on;
    return !after(a, b) && !after(b, a);
  };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (!overlaps(a, b)) continue;
      const shared = sellable.filter((product) => promotionCovers(a, product) && promotionCovers(b, product));
      if (shared.length) out.push(a.id < b.id ? { a, b, products: shared } : { a: b, b: a, products: shared });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- packages */

/**
 * What a package would cost bought part by part, and what it actually costs.
 *
 * The discount a package *is*, made visible. `listValue` is the sum of the
 * parts at their own prices times their quantities; `price` is what the package
 * itself is sold for. A package priced above its parts is a real thing — a
 * managed service is worth more than its licences — and it should be seen on
 * purpose rather than discovered by a customer.
 *
 * A part that has no price of its own contributes nothing and is counted in
 * `unpriced`, because a list value that silently omits a part is a discount
 * figure that is wrong in the flattering direction.
 */
export interface BundleValue {
  /** The parts at their own prices, times quantity. */
  listValue: Minor;
  /** What the package is sold for, or null when it has no price. */
  price: Minor | null;
  /** List value less the package price. Negative is a premium. */
  saving: Minor | null;
  /** Basis points of the list value. Null when there is nothing to compare. */
  savingBps: number | null;
  /** Parts with no applicable price, which the list value could not include. */
  unpriced: number;
}

export function bundleValue(input: {
  parts: readonly ProductPart[];
  /** Every part's prices, by product id. */
  pricesOf: (productId: ID) => readonly ProductPrice[];
  price: Minor | null;
  on?: ISODate;
}): BundleValue {
  let listValue = 0;
  let unpriced = 0;
  for (const part of input.parts) {
    const quantity = Math.max(1, Math.round(part.quantity) || 1);
    const price = priceFor(input.pricesOf(part.part_id), { quantity, on: input.on });
    if (!price) { unpriced += 1; continue; }
    listValue += price.amount * quantity;
  }
  const saving = input.price === null ? null : listValue - input.price;
  return {
    listValue,
    price: input.price,
    saving,
    savingBps: saving === null || listValue === 0 ? null : Math.round((saving * FULL_BPS) / listValue),
    unpriced,
  };
}

/**
 * Everything a product can do, a package included.
 *
 * A package's capabilities are its own plus every part's, because that is what
 * a customer gets — and because the alternative, retyping the union onto the
 * package, is a list that goes wrong the first time a part gains a capability.
 * Ids that no longer resolve are dropped rather than rendered as a blank chip:
 * a deleted capability leaves its id behind on every product that claimed it,
 * and cleaning that up on delete would mean rewriting every product row inside
 * one transaction for no benefit a reader can see.
 */
export function capabilitiesOf(input: {
  product: Pick<Product, 'capabilities'>;
  parts?: readonly ProductPart[];
  capabilitiesOfPart?: (productId: ID) => readonly ID[];
  known: ReadonlySet<ID>;
}): ID[] {
  const out = new Set<ID>();
  for (const id of input.product.capabilities ?? []) if (input.known.has(id)) out.add(id);
  for (const part of input.parts ?? []) {
    for (const id of input.capabilitiesOfPart?.(part.part_id) ?? []) if (input.known.has(id)) out.add(id);
  }
  return [...out];
}

/* -------------------------------------------------------------- retention */

/**
 * How much of a cohort is still there, month by month.
 *
 * Geometric decay: the ordinary model, stated rather than implied, and honest
 * about what it is not. Real churn is front-loaded — most of what a cohort
 * loses, it loses in the first two months — so this understates the early drop
 * and overstates the tail. It is here because it needs one number somebody
 * actually has, and a survival curve needs a customer table this does not keep.
 * See `TODO.md`.
 *
 * Returned in basis points of the original cohort, starting at the full 10 000,
 * so a caller can multiply a unit count by it without a float anywhere.
 */
export function retentionCurve(churnBps: number, months: number): number[] {
  const churn = Math.min(Math.max(Math.round(churnBps) || 0, 0), FULL_BPS);
  const out: number[] = [];
  let left = FULL_BPS;
  for (let month = 0; month < Math.max(0, Math.round(months) || 0); month++) {
    out.push(left);
    left = left - Math.round((left * churn) / FULL_BPS);
  }
  return out;
}

/**
 * How long a customer stays, in months, from a monthly churn.
 *
 * `1 / churn`, and the reason it is a function rather than an expression at
 * four call sites is the two edges. Zero churn is not an infinite customer, it
 * is a product nobody has measured — and an `Infinity` months rendered into a
 * lifetime value produces a number that ends a meeting in the wrong direction.
 * Both return null, and every screen says "no churn recorded" instead.
 */
export function expectedMonths(churnBps: number): number | null {
  const churn = Math.round(churnBps) || 0;
  if (churn <= 0) return null;
  return FULL_BPS / Math.min(churn, FULL_BPS);
}

/**
 * What one customer is worth over their life, less what winning them cost.
 *
 * Contribution per month times how long they stay, minus the acquisition cost.
 * The subtraction is the part that gets left out of the version people quote —
 * "LTV" as a gross figure is a number that makes every product look good — and
 * leaving it out here would make the payback figure beside it contradict it.
 *
 * Null for a product that is sold once: a one-off sale has a lifetime of one
 * transaction, its value is its contribution, and dividing that by a churn rate
 * nobody gathered would be inventing a number. The screens show the contribution
 * for those, which is the honest answer to the same question.
 */
export interface Retention {
  /** What one customer contributes each month. Null when it is not a subscription. */
  monthly: Minor | null;
  /** How long they stay. Null when no churn has been recorded. */
  months: number | null;
  /** Contribution over that life, after acquisition. Null when either is. */
  value: Minor | null;
  /** Months until the acquisition cost is back. Null when it never is. */
  payback: number | null;
  /**
   * Whether the minimum term is doing the work rather than the churn.
   *
   * True when the churn on its own would have said a customer leaves before
   * the contract they signed ends. Not an error — a high churn against a long
   * term is exactly the thing somebody should look at — but the two are saying
   * different things and only one of them can be the figure.
   */
  cappedByTerm: boolean;
}

export function retentionOf(input: {
  product: Pick<Product, 'churn_bps' | 'acquisition_cost' | 'term_months' | 'renewal'>;
  contribution: Minor | null;
  /**
   * How the contribution is charged, which is a fact about the **price** and
   * not about the product.
   *
   * It used to fall back to `product.billing`, and that column is gone: the
   * same product is sold monthly, yearly and two-yearly at once, so a single
   * answer on the product was a single answer to a question with several. A
   * caller with no price has nothing to convert and says `once`, which is what
   * an unpriced product's contribution already is — an amount, not a rate.
   */
  recurrence?: CostRecurrence;
  /**
   * The commitment behind that contribution, when the **price** states one.
   *
   * Same move as `recurrence` above and for the same reason: the product holds
   * one term and a catalogue selling one module monthly, on a year and on two
   * has three. Undefined and null both mean the product's own — so a caller
   * that knows nothing about terms keeps the answer it always got.
   */
  termMonths?: number | null;
  churnBps?: number | null;
}): Retention {
  const recurrence = input.recurrence ?? 'once';
  const contribution = input.contribution;
  const monthly = contribution === null ? null : monthlyAmount(contribution, recurrence);
  const churn = input.churnBps ?? input.product.churn_bps;
  /*
   * A product that does not renew lives exactly as long as its term, whatever
   * its churn says. Churn measures people leaving something they could have
   * stayed in; a fixed-term contract that ends is not churn, and running the
   * geometric model over it would quietly extend every non-renewing product
   * past its own contract.
   */
  /*
   * A minimum term is a **floor**, and it was not one.
   *
   * The first subscription anybody modelled here had a twelve-month minimum
   * term and 10% monthly churn, and the screen answered "stays 10 months" —
   * a customer leaving two months before a contract they signed. Churn measures
   * people leaving something they *could* have left; inside the term they could
   * not, so the term wins and the churn only decides what happens after it.
   *
   * Stated as a maximum of the two rather than as a warning, because a warning
   * leaves the wrong number on the screen beside it. The two disagreeing is
   * still worth seeing — `Retention.cappedByTerm` says so — but the figure
   * itself is now the one the contract makes true.
   */
  const byChurn = expectedMonths(churn);
  const committed = input.termMonths ?? input.product.term_months;
  const term = committed > 0 ? committed : null;
  const months = input.product.renewal === 'none'
    ? term
    : (byChurn === null ? term : Math.max(byChurn, term ?? 0));
  const gross = monthly === null || months === null ? null : Math.round(monthly * months);
  const value = gross === null ? null : gross - (Math.round(Number(input.product.acquisition_cost)) || 0);
  const payback = monthly === null || monthly <= 0
    ? null
    : Math.ceil((Math.round(Number(input.product.acquisition_cost)) || 0) / monthly);
  return {
    monthly,
    months,
    value,
    payback,
    cappedByTerm: term !== null && byChurn !== null && byChurn < term && input.product.renewal !== 'none',
  };
}

/* ------------------------------------------------------------- simulation */

/**
 * What a scenario assumes when it does not say.
 *
 * Twelve months because that is the horizon a product is argued about over, one
 * unit and one delivery a month because a projection of nothing is not a
 * projection, and no growth and no adjustments because a default that moves the
 * numbers is a default that puts words in somebody's mouth.
 */
export const DEFAULT_ASSUMPTIONS: SettledAssumptions = {
  months: 12,
  units: 1,
  growth_bps: 0,
  price_bps: 0,
  cost_bps: 0,
  deliveries: 1,
  promotions: [],
  churn_bps: null,
  price_id: null,
};

/**
 * `ProductAssumptions` with nothing left to ask about.
 *
 * A separate type rather than `Required<ProductAssumptions>` because two of the
 * fields are genuinely nullable — a scenario that does not override the churn
 * and one that overrides it to null are the same thing — and `Required` would
 * make them mandatory without making them present.
 */
export interface SettledAssumptions {
  months: number;
  units: number;
  growth_bps: number;
  price_bps: number;
  cost_bps: number;
  deliveries: number;
  promotions: ID[];
  churn_bps: number | null;
  price_id: ID | null;
}

/** A scenario's assumptions with every gap filled, and every number sane. */
export function assumptionsOf(input: ProductAssumptions | null | undefined): SettledAssumptions {
  const given = input ?? {};
  const whole = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };
  return {
    // Capped at 120 for the reason `monthsBetween` is capped at 600: the number
    // comes off a form, somebody will type 1200 for 12, and the difference
    // between a wrong chart and a tab that never finishes rendering is this line.
    months: whole(given.months, DEFAULT_ASSUMPTIONS.months, 1, 120),
    units: whole(given.units, DEFAULT_ASSUMPTIONS.units, 0, 1_000_000),
    growth_bps: whole(given.growth_bps, 0, -FULL_BPS, 10 * FULL_BPS),
    price_bps: whole(given.price_bps, 0, -FULL_BPS, 10 * FULL_BPS),
    cost_bps: whole(given.cost_bps, 0, -FULL_BPS, 10 * FULL_BPS),
    deliveries: whole(given.deliveries, DEFAULT_ASSUMPTIONS.deliveries, 0, 1000),
    promotions: Array.isArray(given.promotions) ? given.promotions.filter((id): id is ID => typeof id === 'string') : [],
    churn_bps: given.churn_bps == null ? null : whole(given.churn_bps, 0, 0, FULL_BPS),
    price_id: typeof given.price_id === 'string' ? given.price_id : null,
  };
}

/** One month of a projection. Every figure is for that month alone but the last two. */
export interface SimulatedMonth {
  month: Month;
  /** Units sold in the month, after growth and after capacity. */
  units: number;
  /** Units still being paid for, subscriptions included. See `retained`. */
  active: number;
  /** What came in. */
  revenue: Minor;
  /** What went out: period costs, delivery costs, unit costs, acquisition, campaigns. */
  cost: Minor;
  /** Revenue less cost. */
  margin: Minor;
  /** Margin from the first month to this one. */
  cumulative: Minor;
}

export interface Simulation {
  currency: string;
  months: SimulatedMonth[];
  /** The price the projection ran at, after adjustments and campaigns. */
  price: Minor | null;
  /** The list price before them, for the screen that shows both. */
  listPrice: Minor | null;
  /**
   * What the customer commits to at the price this ran at, in months.
   *
   * On the result because the caller cannot work it out: the price may have
   * been chosen by `price_id` or found by `priceFor`, and a retention figured
   * beside a projection has to be figured over the same contract it did.
   */
  termMonths: number;
  unitCost: Minor;
  contribution: Minor | null;
  revenue: Minor;
  cost: Minor;
  margin: Minor;
  /** The first month the cumulative margin is not negative. Null when there is none. */
  breakEvenMonth: Month | null;
  /** How many units were turned away by `capacity` over the whole horizon. */
  turnedAway: number;
  /** Campaigns that were applied, by id. */
  promotions: ID[];
}

/**
 * A product's next year under one set of assumptions.
 *
 * The thing a catalogue is for. Nothing here writes: a scenario is a set of
 * numbers applied on the way to a projection, the prices and costs it read are
 * untouched, and running the same scenario twice gives the same answer — which
 * is why it is safe to put in front of a steering committee.
 *
 * Three things it does that a spreadsheet of the same shape usually does not,
 * and each of them was the reason for a wrong number somewhere:
 *
 * - **Capacity is a ceiling, not a suggestion.** Units above it are counted in
 *   `turnedAway` rather than sold. A forecast the business cannot deliver is
 *   not a forecast.
 * - **Acquisition is charged in the month the customer arrives**, not spread.
 *   That is what makes the cumulative line dip before it climbs, and the dip is
 *   the entire question somebody is asking.
 * - **A subscription keeps paying and keeps churning.** `active` carries last
 *   month's survivors plus this month's arrivals, so a monthly product's
 *   revenue compounds and a `once` product's does not — one function, because
 *   two would drift.
 */
export function simulate(input: {
  product: Pick<Product, 'id' | 'group_id' | 'currency' | 'capacity' | 'churn_bps' | 'acquisition_cost' | 'term_months'>;
  prices: readonly ProductPrice[];
  costs: readonly ProductCost[];
  contributors?: readonly ProductContributor[];
  /** For a package: what is in it, and what one of each costs. See `unitCosts`. */
  parts?: readonly ProductPart[];
  unitCostOfPart?: (productId: ID) => Minor;
  promotions?: readonly Promotion[];
  assumptions?: ProductAssumptions | null;
  /** The month to start in. Defaults to the month of `today`. */
  from?: Month;
  today: ISODate;
}): Simulation {
  const assumed = assumptionsOf(input.assumptions);
  const currency = input.product.currency || 'EUR';
  const start = input.from ?? monthOf(input.today);

  const chosen = assumed.price_id
    ? input.prices.find((price) => price.id === assumed.price_id) ?? null
    : priceFor(input.prices, {
      quantity: assumed.units || 1,
      on: input.today,
      productTerm: input.product.term_months,
    });
  const listPrice = chosen ? chosen.amount : null;
  // The chosen price says how often it is charged. A product with no price is
  // not a projection at all — `price` is null and every figure below with it —
  // so the fallback only has to be something that does not divide.
  const recurrence = chosen ? chosen.recurrence : 'once';

  /*
   * Only the campaigns the scenario names, and only where they cover this
   * product. A scenario that listed a campaign for another product used to get
   * its discount anyway — the filter was on the id and not on the coverage —
   * which made the same promotion look good in whichever scenario mentioned it.
   */
  const applied = (input.promotions ?? [])
    .filter((promotion) => assumed.promotions.includes(promotion.id))
    .filter((promotion) => promotionCovers(promotion, input.product));

  const adjusted = listPrice === null ? null : scaleBps(listPrice, FULL_BPS + assumed.price_bps);
  const price = adjusted === null ? null : promotedPrice(adjusted, applied);
  const structure = costStructure({
    costs: input.costs,
    contributors: input.contributors,
    parts: input.parts,
    unitCostOfPart: input.unitCostOfPart,
    factorBps: FULL_BPS + assumed.cost_bps,
  });
  const contribution = price === null ? null : price - structure.unit;

  /*
   * A campaign's spend lands in the month it starts, or in the first month of
   * the projection when it started before it. Spreading it would be inventing a
   * schedule nobody entered, and dropping it would make every campaign free.
   */
  const spendByMonth = new Map<Month, Minor>();
  for (const promotion of applied) {
    const month = promotion.starts_on && monthOf(promotion.starts_on) > start ? monthOf(promotion.starts_on) : start;
    spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + (Math.round(Number(promotion.spend)) || 0));
  }

  const churn = assumed.churn_bps ?? input.product.churn_bps;
  const recurring = (MONTHS_PER[recurrence] ?? 0) > 0;
  const perMonth = MONTHS_PER[recurrence] ?? 0;
  const capacity = input.product.capacity != null && input.product.capacity > 0 ? input.product.capacity : null;
  const acquisition = Math.round(Number(input.product.acquisition_cost)) || 0;

  const months: SimulatedMonth[] = [];
  /*
   * A ceiling on the units one month can produce, for the reason `monthsBetween`
   * has one: the growth rate comes off a form. `assumptionsOf` allows up to
   * 1 000% a month, which over a hundred-month horizon is 11 to the hundredth —
   * `Infinity` after about the ninetieth month, and `Infinity - Infinity` for
   * `turnedAway`, which renders as *NaN units turned away*. A projection that
   * has run off the end of the number line is not a projection, and clamping it
   * is the difference between an obviously silly chart and one that says NaN.
   */
  const MOST_UNITS = 100_000_000;
  let cumulative = 0;
  let revenueTotal = 0;
  let costTotal = 0;
  let turnedAway = 0;
  let active = 0;
  let breakEvenMonth: Month | null = null;

  for (let index = 0; index < assumed.months; index++) {
    const month = addMonths(start, index);
    const grown = assumed.units * ((FULL_BPS + assumed.growth_bps) / FULL_BPS) ** index;
    const wanted = Math.min(MOST_UNITS, Math.max(0, Number.isFinite(grown) ? Math.round(grown) : MOST_UNITS));
    /*
     * A capacity is a ceiling **per delivery**, so with no deliveries it is not
     * a ceiling at all.
     *
     * It used to multiply out to `capacity * 0 = 0` and turn every unit away,
     * silently, for exactly the products that have no deliveries: a licence, a
     * subscription, anything sold rather than run. The first SaaS anybody
     * modelled here had `capacity: 1` and `deliveries: 1` and forecast one sale
     * a month against forty — which is the same trap one step along, and why
     * the form no longer offers the field to a product that is not delivered.
     */
    const ceiling = capacity === null || assumed.deliveries <= 0 ? wanted : capacity * assumed.deliveries;
    const sold = Math.min(wanted, ceiling);
    turnedAway += wanted - sold;

    // Last month's survivors, then this month's arrivals. A `once` product has
    // no survivors: it was paid for and it is done.
    active = recurring ? active - Math.round((active * Math.min(Math.max(churn, 0), FULL_BPS)) / FULL_BPS) + sold : sold;

    /*
     * A subscription charged quarterly bills a third of its customers each
     * month on average, which is what dividing the period price by its months
     * says — and it is the only reading that makes a quarterly and a monthly
     * product comparable on the same chart. A `once` price bills the arrivals.
     */
    const billed = price === null ? 0 : (recurring ? Math.round((active * price) / perMonth) : sold * price);
    const unitCost = recurring
      ? Math.round((active * structure.unit) / perMonth)
      : sold * structure.unit;
    const spend = spendByMonth.get(month) ?? 0;
    const cost = structure.period
      + structure.delivery * assumed.deliveries
      + unitCost
      + sold * acquisition
      + spend;

    const margin = billed - cost;
    cumulative += margin;
    revenueTotal += billed;
    costTotal += cost;
    if (breakEvenMonth === null && cumulative >= 0 && (billed > 0 || cost > 0)) breakEvenMonth = month;
    months.push({ month, units: sold, active, revenue: billed, cost, margin, cumulative });
  }

  return {
    currency,
    months,
    price,
    listPrice,
    termMonths: chosen?.term_months ?? input.product.term_months,
    unitCost: structure.unit,
    contribution,
    revenue: revenueTotal,
    cost: costTotal,
    margin: revenueTotal - costTotal,
    breakEvenMonth,
    turnedAway,
    promotions: applied.map((promotion) => promotion.id),
  };
}

/* ------------------------------------------------------------- the catalogue */

/** One product as a catalogue row reads it. */
export interface CatalogueEntry {
  product: Product;
  economics: UnitEconomics;
  structure: CostStructure;
  breakEven: BreakEven;
  retention: Retention;
  /** Campaigns running against it today. */
  promotions: ID[];
  /** The price after those campaigns, when any apply. */
  promoted: Minor | null;
  /**
   * The billing periods it is actually sold in, read off its prices.
   *
   * A list rather than a field on the product, which is what it was and what
   * made the form ask for one answer to a question with several: the same
   * product is sold monthly, yearly and two-yearly at once. Empty for a product
   * nobody has priced.
   */
  periods: CostRecurrence[];
  /** Sold both as a sale and as a subscription. See `mixedPeriods`. */
  mixed: boolean;
  /**
   * The commitments the quoted offer is sold on, shortest first.
   *
   * One entry is the ordinary case and says nothing new. More than one is a
   * product whose price depends on how long the customer signs up for, and the
   * figures beside it are computed from the first of them — the shortest, which
   * is the dearest and the one nobody has to agree to. See `termsOf`.
   */
  terms: { months: number; amount: Minor }[];
}

/**
 * Every product at once, with the four figures a catalogue is read for.
 *
 * One function rather than four loops in the screen, because the client and
 * MCP both want exactly this and a second assembly of it would be the place
 * the two came to disagree. The horizon is the caller's: a catalogue read at
 * twelve months and a product page read at twelve months have to agree, so
 * neither of them gets to assume it.
 */
export function catalogue(input: {
  products: readonly Product[];
  pricesOf: (productId: ID) => readonly ProductPrice[];
  costsOf: (productId: ID) => readonly ProductCost[];
  contributorsOf?: (productId: ID) => readonly ProductContributor[];
  /** What is inside each package. Leave it out and a package costs only its own rows. */
  partsOf?: (productId: ID) => readonly ProductPart[];
  promotions?: readonly Promotion[];
  months: number;
  deliveries: number;
  today: ISODate;
}): CatalogueEntry[] {
  // Once for the whole catalogue rather than once per product: a package three
  // deep would otherwise walk its parts again for every row that mentions them.
  const unitCostOfPart = unitCosts({
    costsOf: input.costsOf,
    contributorsOf: input.contributorsOf,
    partsOf: input.partsOf,
  });
  return input.products.map((product) => {
    const prices = input.pricesOf(product.id);
    const costs = input.costsOf(product.id);
    const contributors = input.contributorsOf?.(product.id) ?? [];
    const parts = input.partsOf?.(product.id) ?? [];
    const economics = unitEconomics({ product, prices, costs, contributors, parts, unitCostOfPart, on: input.today });
    const structure = costStructure({ costs, contributors, parts, unitCostOfPart });
    const running = promotionsFor(input.promotions ?? [], product, input.today);
    /* One lookup for the row's period and its commitment: the price the row
       quotes is the contract the retention beside it has to be figured over. */
    const quoted = priceFor(prices, { on: input.today, productTerm: product.term_months });
    return {
      product,
      economics,
      structure,
      breakEven: breakEven({ product, economics, structure, months: input.months, deliveries: input.deliveries }),
      retention: retentionOf({
        product,
        contribution: economics.contribution,
        // The period *and* the commitment of the price the row is quoting,
        // not fields on the product — otherwise a yearly contribution is read
        // as a monthly one, and a two-year price is valued over whatever term
        // the product happens to name.
        recurrence: quoted?.recurrence,
        termMonths: quoted?.term_months,
      }),
      promotions: running.map((promotion) => promotion.id),
      promoted: economics.price === null || !running.length ? null : promotedPrice(economics.price, running),
      periods: periodsOf(prices),
      mixed: mixedPeriods(prices),
      terms: termsOf(prices, { on: input.today, productTerm: product.term_months })
        .map(({ months, amount }) => ({ months, amount })),
    };
  });
}

/** What a group of products comes to. Per currency, because nothing converts. */
export interface GroupTotal {
  group_id: ID | null;
  currency: string;
  products: number;
  /** Products with no applicable price. A total that hides these is flattering. */
  unpriced: number;
  /** Period costs a month, across the group. */
  monthlyCost: Minor;
  /** Contribution per unit, summed. Not a revenue figure — see below. */
  contribution: Minor;
}

/**
 * Products grouped by family and currency.
 *
 * `contribution` is a sum of per-unit figures and is **not** a forecast: it
 * says what one of each would earn, which is the comparison a catalogue makes
 * between two lines of business without anybody having to enter a volume. What
 * it would take to turn it into revenue is a simulation, and that is a
 * different screen on purpose.
 */
export function byGroup(entries: readonly CatalogueEntry[]): GroupTotal[] {
  const out = new Map<string, GroupTotal>();
  for (const entry of entries) {
    const key = `${entry.product.group_id ?? ''}::${entry.economics.currency}`;
    const row = out.get(key) ?? {
      group_id: entry.product.group_id ?? null,
      currency: entry.economics.currency,
      products: 0,
      unpriced: 0,
      monthlyCost: 0,
      contribution: 0,
    };
    row.products += 1;
    if (entry.economics.price === null) row.unpriced += 1;
    row.monthlyCost += entry.structure.period;
    row.contribution += entry.economics.contribution ?? 0;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => b.contribution - a.contribution);
}

/**
 * Where a product stands, under one rule used everywhere.
 *
 * Listed worst first, the way `MEASURE_HEALTH` is, and the two that are not
 * judgements sit in the middle rather than at either end: `unpriced` and
 * `no_costs` are the states a catalogue usually paints green by omission, and
 * neither is good news or bad — nobody has said what it sells for, or nobody
 * has said what it costs.
 */
export const PRODUCT_HEALTH = ['loss', 'thin', 'unpriced', 'no_costs', 'healthy'] as const;
export type ProductHealth = (typeof PRODUCT_HEALTH)[number];

/**
 * A margin under a fifth is `thin`.
 *
 * A named threshold and not a configurable one, for the reason the repository
 * gives for named exceptions over counted ones: a number a workspace can set is
 * a number somebody sets to make a screen go green. Twenty per cent is where a
 * product stops absorbing a bad month, and a workspace that disagrees reads the
 * margin itself, which is on the same row.
 */
const THIN_MARGIN_BPS = 2000;

export function healthOfProduct(entry: Pick<CatalogueEntry, 'economics' | 'structure'>): ProductHealth {
  if (entry.economics.price === null) return 'unpriced';
  if (entry.economics.contribution !== null && entry.economics.contribution < 0) return 'loss';
  if (!entry.structure.period && !entry.structure.delivery && !entry.structure.unit) return 'no_costs';
  /*
   * `marginBps` is null here only for a price of exactly zero — a price of null
   * was answered two lines up. A product given away while costing something is
   * not healthy, and falling through to `healthy` on the null is what it used
   * to do: a free product with a server bill behind it came out green.
   */
  if (entry.economics.marginBps === null || entry.economics.marginBps < THIN_MARGIN_BPS) return 'thin';
  return 'healthy';
}

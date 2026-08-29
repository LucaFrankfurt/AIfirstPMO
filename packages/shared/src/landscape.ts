/**
 * What the estate looks like on a given day, and what it costs.
 *
 * The idea the whole file rests on: **a landscape is a date, not a document.**
 *
 * The obvious model is a "current" set of components and a "target" set beside
 * it, and it is wrong in a way that shows up about a month in. Two sets have to
 * be kept in step by hand, the target goes stale the moment somebody
 * decommissions something in the real world, and there is nowhere to put "and
 * in June we will have both". Dates do not have any of those problems: every
 * component says when it joined and when it leaves, the landscape on any day
 * falls out of that, and "current versus future" is the same function called
 * twice.
 *
 * It also means the answer is never out of date. Nobody has to remember to move
 * a component from one list to the other; the day arrives and it is in.
 *
 * Pure functions over plain rows, like `budget.ts` and `rates.ts`, so the
 * server and the browser cannot disagree about what is running.
 */
import type { Component, CostRecurrence, ID, ISODate, Minor, Move } from './types.ts';
// The same shape money takes everywhere here: a list per currency, never a sum
// across two. Defined beside the time totals because that is where it was first
// needed; re-used rather than re-declared so a screen showing both cannot end
// up with two nearly-identical types.
import type { MoneyByCurrency } from './rates.ts';

/* --------------------------------------------------------------- liveness */

/**
 * Whether a component is in the landscape on a day — and when it is not, why.
 *
 * Four answers rather than a boolean, because the fourth is the one worth
 * seeing. A component somebody has planned but given no date is not in *any*
 * landscape, present or future, and silently leaving it out of both is how a
 * register quietly stops describing the plan. It comes back as `undated` so a
 * screen can say so.
 *
 * Dates decide; `status` answers only where a date is missing. A row marked
 * `retired` with no end date is gone, and one marked `live` with no start has
 * always been here — which is what somebody who typed neither meant.
 */
export type Liveness = 'live' | 'not_yet' | 'gone' | 'undated';

export function livenessOn(
  component: Pick<Component, 'status' | 'live_from' | 'live_until'>,
  day: ISODate,
): Liveness {
  if (component.status === 'retired' && !component.live_until) return 'gone';
  if (component.status === 'planned' && !component.live_from) return 'undated';
  if (component.live_from && day < component.live_from) return 'not_yet';
  if (component.live_until && day > component.live_until) return 'gone';
  return 'live';
}

export const isLiveOn = (
  component: Pick<Component, 'status' | 'live_from' | 'live_until'>,
  day: ISODate,
): boolean => livenessOn(component, day) === 'live';

/** Everything running on a day. The landscape, as of then. */
export const landscapeOn = <T extends Pick<Component, 'status' | 'live_from' | 'live_until'>>(
  components: readonly T[],
  day: ISODate,
): T[] => components.filter((component) => isLiveOn(component, day));

/** Components nobody has dated, which therefore appear in no landscape at all. */
export const undated = <T extends Pick<Component, 'status' | 'live_from' | 'live_until'>>(
  components: readonly T[],
  day: ISODate,
): T[] => components.filter((component) => livenessOn(component, day) === 'undated');

/* ------------------------------------------------------------------ money */

const PER_YEAR: Record<CostRecurrence, number> = { once: 0, monthly: 12, quarterly: 4, yearly: 1 };

/**
 * What a component costs in a year, or `null` when it is not a running cost.
 *
 * The **annual** figure is the primitive here rather than the monthly one, and
 * that is arithmetic rather than taste: a yearly cost divided into twelve does
 * not come back to itself. €8,900 a year is €741.67 a month, and twelve of
 * those is €8,900.04 — four cents that appear in the total of any estate with a
 * yearly contract in it, every time. Multiplying up is exact; dividing down is
 * not, so the division happens once, at the edge, for display.
 *
 * `once` returns `null` rather than 0. A one-off purchase is not a run rate,
 * and folding it into one would make a year in which somebody bought a rack
 * look like a year in which the estate got permanently more expensive.
 */
export function annualCost(component: Pick<Component, 'amount' | 'recurrence'>): Minor | null {
  const per = PER_YEAR[component.recurrence] ?? 0;
  if (!per) return null;
  return Math.round(Number(component.amount) || 0) * per;
}

/** The one-off side: what it cost to buy, for a component that was bought. */
export function oneOffCost(component: Pick<Component, 'amount' | 'recurrence'>): Minor {
  return component.recurrence === 'once' ? Math.round(Number(component.amount) || 0) : 0;
}

/** An annual figure as a month, rounded once, for a screen rather than a sum. */
export const perMonth = (annual: Minor): Minor => Math.round(annual / 12);

export interface LandscapeCost {
  /** Recurring spend, per currency, as a yearly figure. */
  annual: MoneyByCurrency[];
  /** What the one-off components in it cost to acquire. */
  oneOff: MoneyByCurrency[];
  /** How many components carry no price. Counted, never treated as free. */
  unpriced: number;
  components: number;
}

const addTo = (into: Map<string, Minor>, currency: string, amount: Minor) =>
  into.set(currency, (into.get(currency) ?? 0) + amount);

const asList = (from: Map<string, Minor>): MoneyByCurrency[] =>
  [...from].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);

/**
 * What a set of components costs.
 *
 * Currencies stay apart, as they do everywhere else here: an exchange rate is a
 * fact about a day, and one invented in a total is invisible in the total it
 * changed. An unpriced component is counted rather than costed at zero — the
 * same decision `unrated` makes for time and `unallocated` for budgets.
 */
export function costOfLandscape(components: readonly Component[]): LandscapeCost {
  const annual = new Map<string, Minor>();
  const oneOff = new Map<string, Minor>();
  let unpriced = 0;

  for (const component of components) {
    const amount = Math.round(Number(component.amount) || 0);
    if (!amount) { unpriced++; continue; }
    const currency = component.currency || 'EUR';
    const yearly = annualCost(component);
    if (yearly === null) addTo(oneOff, currency, oneOffCost(component));
    else addTo(annual, currency, yearly);
  }

  return { annual: asList(annual), oneOff: asList(oneOff), unpriced, components: components.length };
}

/* ------------------------------------------------------------------- diff */

export interface LandscapeDiff {
  from: ISODate;
  to: ISODate;
  /** Running on both days. */
  staying: Component[];
  /** Not running on the first day, running on the second. */
  arriving: Component[];
  /** Running on the first day, not on the second. */
  leaving: Component[];
  costFrom: LandscapeCost;
  costTo: LandscapeCost;
  /** `to` minus `from`, per currency. Negative is cheaper. */
  annualDelta: MoneyByCurrency[];
  /** Planned components with no date, which are in neither answer. */
  undated: Component[];
}

/**
 * Current against future, as one call.
 *
 * The three lists are what an architecture review actually asks for — what goes,
 * what arrives, what is untouched — and the delta is what a finance review asks
 * for immediately afterwards. Both from the same pair of dates, so the picture
 * and the number cannot describe different plans.
 */
export function compareLandscapes(
  components: readonly Component[],
  from: ISODate,
  to: ISODate,
): LandscapeDiff {
  const before = new Set(landscapeOn(components, from).map((component) => component.id));
  const after = new Set(landscapeOn(components, to).map((component) => component.id));

  const staying: Component[] = [];
  const arriving: Component[] = [];
  const leaving: Component[] = [];
  for (const component of components) {
    const was = before.has(component.id);
    const is = after.has(component.id);
    if (was && is) staying.push(component);
    else if (!was && is) arriving.push(component);
    else if (was && !is) leaving.push(component);
  }

  const costFrom = costOfLandscape(components.filter((component) => before.has(component.id)));
  const costTo = costOfLandscape(components.filter((component) => after.has(component.id)));

  const delta = new Map<string, Minor>();
  for (const row of costTo.annual) addTo(delta, row.currency, row.amount);
  for (const row of costFrom.annual) addTo(delta, row.currency, -row.amount);

  return {
    from,
    to,
    staying,
    arriving,
    leaving,
    costFrom,
    costTo,
    annualDelta: [...delta]
      .filter(([, amount]) => amount !== 0)
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    undated: undated(components, to),
  };
}

/* ------------------------------------------------------------------ moves */

export interface MoveProgress {
  /** Components named as leaving that really have gone, over the total named. */
  retired: number;
  retiring: number;
  /** Components named as arriving that really are live, over the total named. */
  arrived: number;
  arriving: number;
  /** 0–1 over everything the move names, or null when it names nothing. */
  done: number | null;
  /**
   * What the components say, against what the move claims.
   *
   * A move marked done with a server still running is the discrepancy this
   * exists to surface — a plan nobody executed reads exactly like one that was
   * executed, until somebody checks the estate against it.
   */
  disagrees: boolean;
}

/**
 * How far a move has actually got, read from the components rather than from
 * its own status.
 *
 * A status is a claim somebody typed; this is what the register says. Where the
 * two disagree, the register is the one that came from somewhere.
 */
export function moveProgress(
  move: Pick<Move, 'leaving' | 'arriving' | 'status'>,
  components: readonly Component[],
  day: ISODate,
): MoveProgress {
  const byId = new Map(components.map((component) => [component.id, component]));
  const state = (id: ID): Liveness | null => {
    const component = byId.get(id);
    return component ? livenessOn(component, day) : null;
  };

  const leaving = move.leaving ?? [];
  const arriving = move.arriving ?? [];
  const retired = leaving.filter((id) => state(id) === 'gone').length;
  const arrived = arriving.filter((id) => state(id) === 'live').length;
  const named = leaving.length + arriving.length;
  const complete = retired + arrived;

  return {
    retired,
    retiring: leaving.length,
    arrived,
    arriving: arriving.length,
    done: named ? complete / named : null,
    disagrees: named > 0 && (
      (move.status === 'done' && complete < named)
      || (move.status === 'proposed' && complete > 0)
    ),
  };
}

/**
 * The moves that touch a component, so a row in the register can say why it is
 * going and what is replacing it.
 */
export const movesFor = (moves: readonly Move[], componentId: ID): Move[] =>
  moves.filter((move) => (move.leaving ?? []).includes(componentId)
    || (move.arriving ?? []).includes(componentId));

/* ------------------------------------------------------------------- tree */

export interface ComponentNode<T> {
  component: T;
  children: ComponentNode<T>[];
}

/**
 * Servers holding their instances, nested.
 *
 * A component whose parent is not in the list given — filtered out, archived,
 * or simply not passed — comes back at the top rather than disappearing with
 * it. A register that hides a running instance because somebody filtered its
 * host is a register that is quietly wrong about what is running.
 */
export function treeOf<T extends { id: ID; parent_id: ID | null; sort_order?: string; name: string }>(
  components: readonly T[],
): ComponentNode<T>[] {
  const present = new Set(components.map((component) => component.id));
  const nodes = new Map<ID, ComponentNode<T>>(
    components.map((component) => [component.id, { component, children: [] }]),
  );
  const roots: ComponentNode<T>[] = [];

  for (const component of components) {
    const node = nodes.get(component.id)!;
    const parent = component.parent_id && present.has(component.parent_id)
      ? nodes.get(component.parent_id)
      : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const order = (a: ComponentNode<T>, b: ComponentNode<T>) => {
    const left = a.component.sort_order ?? '';
    const right = b.component.sort_order ?? '';
    return (left < right ? -1 : left > right ? 1 : 0) || a.component.name.localeCompare(b.component.name);
  };
  const sort = (list: ComponentNode<T>[]) => {
    list.sort(order);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** A tree flattened back to rows, each with how deep it sits. */
export function flattenTree<T>(nodes: readonly ComponentNode<T>[], depth = 0): { component: T; depth: number }[] {
  const out: { component: T; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ component: node.component, depth });
    out.push(...flattenTree(node.children, depth + 1));
  }
  return out;
}

/* ------------------------------------------------------- vendor contracts */

/**
 * The day a contract stops being cancellable.
 *
 * `contract_end` minus the notice period. The date that matters and the one
 * nothing can work out from a note — a renewal that surprises somebody almost
 * always surprised them on this day rather than on the end date.
 */
export function noticeBy(vendor: { contract_end: ISODate | null; notice_days: number }): ISODate | null {
  if (!vendor.contract_end || !vendor.notice_days) return vendor.contract_end;
  const date = new Date(`${vendor.contract_end}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - vendor.notice_days);
  return date.toISOString().slice(0, 10);
}

/** Contracts whose notice date falls within the next `days`, soonest first. */
export function noticeDue<T extends { contract_end: ISODate | null; notice_days: number; archived?: number }>(
  vendors: readonly T[],
  day: ISODate,
  days = 90,
): { vendor: T; by: ISODate }[] {
  const horizon = new Date(`${day}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + days);
  const until = horizon.toISOString().slice(0, 10);

  return vendors
    .filter((vendor) => !vendor.archived)
    .map((vendor) => ({ vendor, by: noticeBy(vendor) }))
    .filter((row): row is { vendor: T; by: ISODate } => !!row.by && row.by <= until)
    .sort((a, b) => (a.by < b.by ? -1 : 1));
}

/**
 * What logged time cost, and what it was worth.
 *
 * The same shape as `budget.ts` and for the same reasons: pure functions over
 * plain rows, so the server answering over MCP and the browser drawing a
 * timesheet cannot disagree about a figure, and both work from whatever they
 * already have rather than from an endpoint.
 *
 * Two rules carry most of the weight here, and both are about not inventing a
 * number:
 *
 *   - **An hour is costed at the rate in force on the day it was worked.**
 *     Not today's rate. A rate raised in April must not rewrite March, because
 *     a report that changes retroactively is one nobody can reconcile against
 *     the copy they exported last month.
 *   - **Time with no rate is unrated, not free.** It is counted, carried
 *     through every roll-up as its own figure, and never silently costed at
 *     zero — the same decision `unallocated` makes in budgets, and for the
 *     same reason: a wrong number that looks like a real one is worse than an
 *     admitted gap.
 */
import type { ID, ISODate, Minor, Rate, RateKind, TimeEntry } from '../../kernel/registry/types.ts';

/** Minutes to hours, as a number nothing rounds until the money is computed. */
const HOURS = (minutes: number): number => minutes / 60;

/* ------------------------------------------------------------- resolution */

/**
 * How specific a rate is. Higher wins, and the order is fixed rather than
 * configurable: a workspace that could reorder these would be a workspace
 * where two people reading the same rows get different costs.
 */
function specificity(rate: Rate): number {
  if (rate.user_id && rate.project_id) return 3;
  if (rate.user_id) return 2;
  if (rate.project_id) return 1;
  return 0;
}

/**
 * The rate that applies to this person, on this project, on this day.
 *
 * Most specific first; within a specificity, the latest one that has already
 * started. Ties on the same day are broken by id, so two devices that wrote a
 * rate on the same morning agree about which of them is in force rather than
 * costing the same hour two ways.
 *
 * Returns `undefined` rather than a zero rate. Every caller here treats that
 * as *unrated* and keeps it visible.
 */
export function resolveRate(
  rates: readonly Rate[],
  on: { userId: ID | null; projectId: ID | null; day: ISODate; kind: RateKind },
): Rate | undefined {
  let best: Rate | undefined;
  let bestRank = -1;
  for (const rate of rates) {
    if (rate.kind !== on.kind) continue;
    if (rate.starts_on > on.day) continue; // not in force yet on that day
    if (rate.user_id && rate.user_id !== on.userId) continue;
    if (rate.project_id && rate.project_id !== on.projectId) continue;

    const rank = specificity(rate);
    if (rank < bestRank) continue;
    if (rank > bestRank) { best = rate; bestRank = rank; continue; }
    // Same specificity: the one that started later is the one in force.
    if (!best) { best = rate; continue; }
    if (rate.starts_on > best.starts_on) best = rate;
    else if (rate.starts_on === best.starts_on && rate.id > best.id) best = rate;
  }
  return best;
}

/** What one entry cost, or `null` when no rate covers it. */
export function costOf(
  entry: Pick<TimeEntry, 'user_id' | 'project_id' | 'spent_on' | 'minutes'>,
  rates: readonly Rate[],
  kind: RateKind,
): { amount: Minor; currency: string } | null {
  const rate = resolveRate(rates, {
    userId: entry.user_id,
    projectId: entry.project_id ?? null,
    day: entry.spent_on,
    kind,
  });
  if (!rate) return null;
  // Rounded once, at the end, on the whole entry — rounding per hour and then
  // summing drifts, which is the same trap the allocation split avoids.
  return { amount: Math.round(HOURS(entry.minutes) * rate.amount), currency: rate.currency };
}

/* ---------------------------------------------------------------- totals */

export interface MoneyByCurrency {
  currency: string;
  amount: Minor;
}

/**
 * What a set of entries came to.
 *
 * Currencies are kept apart rather than added, exactly as budgets keep them
 * apart: an exchange rate is a fact about a day, and one invented here would
 * be invisible in the total it changed.
 */
export interface TimeTotals {
  minutes: number;
  billableMinutes: number;
  /** Minutes no rate of this kind covered. Not zero-cost — uncosted. */
  unratedMinutes: number;
  cost: MoneyByCurrency[];
  revenue: MoneyByCurrency[];
  /** Revenue minus cost, per currency — only where both sides are known. */
  margin: MoneyByCurrency[];
  /** Billable share of the minutes logged, 0–1. Null when nothing was logged. */
  billableShare: number | null;
}

const addTo = (into: Map<string, Minor>, currency: string, amount: Minor) =>
  into.set(currency, (into.get(currency) ?? 0) + amount);

const asList = (from: Map<string, Minor>): MoneyByCurrency[] =>
  [...from].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);

/**
 * Cost, revenue and margin over a set of entries.
 *
 * `unratedMinutes` counts against the *cost* side, because that is the side
 * every report leads with. An entry with a cost rate and no billable rate is
 * costed and earns nothing, which is the truth about it — a project nobody
 * bills is exactly that shape.
 */
export function totalsOf(entries: readonly TimeEntry[], rates: readonly Rate[]): TimeTotals {
  const cost = new Map<string, Minor>();
  const revenue = new Map<string, Minor>();
  let minutes = 0;
  let billableMinutes = 0;
  let unratedMinutes = 0;

  for (const entry of entries) {
    const worked = Number(entry.minutes) || 0;
    if (worked <= 0) continue; // a running timer has no minutes yet
    minutes += worked;
    if (entry.billable) billableMinutes += worked;

    const spent = costOf(entry, rates, 'cost');
    if (spent) addTo(cost, spent.currency, spent.amount);
    else unratedMinutes += worked;

    // Only billable time earns. Non-billable hours with a billable rate on
    // them would invent revenue nobody is going to invoice.
    if (entry.billable) {
      const earned = costOf(entry, rates, 'billable');
      if (earned) addTo(revenue, earned.currency, earned.amount);
    }
  }

  const margin = new Map<string, Minor>();
  for (const [currency, earned] of revenue) {
    // A margin needs both halves in the same currency. Where only one side is
    // known there is no margin to state, and stating one would mean treating
    // an unknown cost as nothing.
    if (cost.has(currency)) margin.set(currency, earned - cost.get(currency)!);
  }

  return {
    minutes,
    billableMinutes,
    unratedMinutes,
    cost: asList(cost),
    revenue: asList(revenue),
    margin: asList(margin),
    billableShare: minutes ? billableMinutes / minutes : null,
  };
}

/* ------------------------------------------------------------- timesheet */

/** The Monday of the week a day falls in. ISO weeks start on Monday. */
export function weekStart(day: ISODate): ISODate {
  const date = new Date(`${day}T00:00:00Z`);
  // `getUTCDay` is 0 for Sunday, which is the end of an ISO week rather than
  // the start — so Sunday steps back six days, not none.
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return date.toISOString().slice(0, 10);
}

/** The seven days of the week that day falls in. */
export function weekDays(day: ISODate): ISODate[] {
  const start = new Date(`${weekStart(day)}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

/** Move a day by whole weeks, for the arrows either side of a timesheet. */
export function shiftWeeks(day: ISODate, weeks: number): ISODate {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

export interface TimesheetRow {
  /** Whatever the sheet is grouped by: a user id, or a project id. */
  key: ID;
  /** Minutes per day, in the order `weekDays` returns them. */
  days: number[];
  minutes: number;
  billableMinutes: number;
  unratedMinutes: number;
  cost: MoneyByCurrency[];
}

export interface Timesheet {
  days: ISODate[];
  rows: TimesheetRow[];
  /** Column totals, in minutes, in the same order as `days`. */
  perDay: number[];
  totals: TimeTotals;
}

/**
 * One week, as a grid.
 *
 * Grouped by whatever the caller asks for — a person or a project — because
 * the two questions ("what did Ada do this week", "who worked on the API")
 * want the same grid transposed, and building it twice would mean two places
 * that round the same minutes.
 *
 * Days are the seven of the week rather than only the ones with time on them:
 * a Thursday nobody logged is a fact about the week, and a sheet that hides
 * its empty columns cannot be scanned down.
 */
export function timesheet(input: {
  entries: readonly TimeEntry[];
  rates: readonly Rate[];
  week: ISODate;
  by: 'user' | 'project';
}): Timesheet {
  const days = weekDays(input.week);
  const index = new Map(days.map((day, at) => [day, at]));
  const within = input.entries.filter((entry) => index.has(entry.spent_on) && Number(entry.minutes) > 0);

  const grouped = new Map<ID, TimeEntry[]>();
  for (const entry of within) {
    // A loose entry with no project groups under the empty key rather than
    // being dropped: unfiled time is still somebody's week.
    const key = String((input.by === 'user' ? entry.user_id : entry.project_id) ?? '');
    const rows = grouped.get(key) ?? [];
    rows.push(entry);
    grouped.set(key, rows);
  }

  const perDay = days.map(() => 0);
  const rows: TimesheetRow[] = [];
  for (const [key, entries] of grouped) {
    const totals = totalsOf(entries, input.rates);
    const byDay = days.map(() => 0);
    for (const entry of entries) {
      const at = index.get(entry.spent_on)!;
      byDay[at] += Number(entry.minutes) || 0;
      perDay[at] += Number(entry.minutes) || 0;
    }
    rows.push({
      key,
      days: byDay,
      minutes: totals.minutes,
      billableMinutes: totals.billableMinutes,
      unratedMinutes: totals.unratedMinutes,
      cost: totals.cost,
    });
  }

  rows.sort((a, b) => b.minutes - a.minutes || (a.key < b.key ? -1 : 1));
  return { days, rows, perDay, totals: totalsOf(within, input.rates) };
}

/* ----------------------------------------------------------- utilisation */

export interface Utilisation {
  key: ID;
  minutes: number;
  billableMinutes: number;
  /** Billable over logged, 0–1. Always answerable. */
  share: number | null;
  /**
   * Billable over what somebody was available for, 0–1 — and null unless a
   * target was given. Kolibri holds no contracted hours, so this is only ever
   * a number the reader supplied. See `targetMinutes`.
   */
  againstTarget: number | null;
}

/**
 * How much of what was logged was billable, per person or per project.
 *
 * The share is always answerable because it divides one recorded figure by
 * another. The ratio people usually mean by "utilisation" — billable over
 * *available* — is not, because available hours are an HR fact this app does
 * not hold; asking for it produces a number somebody made up. So a target is
 * a parameter, set by whoever is reading, exactly as the team planner's
 * comfortable load is.
 */
export function utilisation(input: {
  entries: readonly TimeEntry[];
  by: 'user' | 'project';
  /** Minutes a person was available over the window. Omit for share only. */
  targetMinutes?: number;
}): Utilisation[] {
  const grouped = new Map<ID, { minutes: number; billable: number }>();
  for (const entry of input.entries) {
    const worked = Number(entry.minutes) || 0;
    if (worked <= 0) continue;
    const key = String((input.by === 'user' ? entry.user_id : entry.project_id) ?? '');
    const row = grouped.get(key) ?? { minutes: 0, billable: 0 };
    row.minutes += worked;
    if (entry.billable) row.billable += worked;
    grouped.set(key, row);
  }

  return [...grouped]
    .map(([key, row]) => ({
      key,
      minutes: row.minutes,
      billableMinutes: row.billable,
      share: row.minutes ? row.billable / row.minutes : null,
      againstTarget: input.targetMinutes ? row.billable / input.targetMinutes : null,
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

/**
 * Every rate that has ever applied to one person-and-project pair, newest
 * first — the history behind a figure somebody is querying.
 *
 * A rate is never edited in place, so this is also the audit trail: "why is
 * March €80 and April €90" is answered by two rows with two start dates.
 */
export function rateHistory(
  rates: readonly Rate[],
  on: { userId: ID | null; projectId: ID | null; kind: RateKind },
): Rate[] {
  return rates
    .filter((rate) => rate.kind === on.kind
      && (rate.user_id ?? null) === (on.userId ?? null)
      && (rate.project_id ?? null) === (on.projectId ?? null))
    .sort((a, b) => (a.starts_on < b.starts_on ? 1 : a.starts_on > b.starts_on ? -1 : (a.id < b.id ? 1 : -1)));
}

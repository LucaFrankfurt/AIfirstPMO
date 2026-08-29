/**
 * What a budget adds up to.
 *
 * Every figure the budget screens, the reports and the MCP tools show is
 * computed here, from rows, on demand. Nothing is stored pre-totalled and there
 * is no aggregation table — the same decision the insights charts made, for the
 * same two reasons: a stored total is a number that goes stale the moment
 * somebody edits a line on a train, and two devices that each edited a
 * different line would then hold two totals with no way to merge them. Nine
 * rows add up in microseconds.
 *
 * The whole file is pure functions over plain objects, so the server can run it
 * against SQLite rows and the browser against its local mirror and neither can
 * disagree with the other about what a budget is worth. That mattered
 * immediately: MCP answers `budget_status` from the server and the dashboard
 * draws the same numbers in the client, and two implementations of "how much of
 * a quarterly line falls inside this period" would have differed by one
 * occurrence about a quarter of the time.
 *
 * Money is an integer of minor units throughout. See `Minor` in `types.ts` for
 * why, and `parseMoney` / `formatMoney` for the only two places a decimal point
 * is allowed to exist.
 */
import type {
  Allocation, Budget, BudgetActual, BudgetLine, BudgetScenario, CostCategory, CostConfidence,
  CostKind, ID, ISODate, Minor, ScenarioAdjustment, SpendStage,
} from './types.ts';

/** The whole of a cost, in basis points. See `Allocation`. */
export const FULL_SHARE = 10_000;

/* ------------------------------------------------------------------- money */

/**
 * Read what somebody typed as minor units.
 *
 * Deliberately forgiving about the things people actually type and strict about
 * the one thing that matters: `1.234,56`, `1,234.56`, `1234,56`, `€1 234.56`
 * and `1234` all read as the same amount, and anything left over after that is
 * `null` rather than a number somebody did not mean.
 *
 * The separator question is settled by position, not by locale: whichever of
 * `.` or `,` appears last is the decimal one, because that is true in every
 * convention that uses both. A lone separator followed by exactly three digits
 * is thousands (`1,234` is 1234, not 1.234) — the one case position cannot
 * settle, and the one people would otherwise be out by a factor of a thousand
 * on.
 */
export function parseMoney(input: string, exponent = 2): Minor | null {
  const raw = String(input).trim();
  if (!raw) return null;
  // Currency symbols, spaces and the Unicode minus, out of the way first.
  const cleaned = raw.replace(/[^\d.,\-−+]/g, '').replace(/−/g, '-');
  if (!/\d/.test(cleaned)) return null;

  const negative = cleaned.startsWith('-') || /^\(.*\)$/.test(raw);
  const body = cleaned.replace(/[+-]/g, '');
  if (!/^[\d.,]+$/.test(body)) return null;

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  const cut = Math.max(lastDot, lastComma);
  let whole = body;
  let fraction = '';
  if (cut >= 0) {
    const tail = body.slice(cut + 1);
    const both = lastDot >= 0 && lastComma >= 0;
    const repeated = body.split(body[cut]).length > 2;
    // Both separators: the later one is the decimal, whatever the reader's
    // language. One separator, appearing once, with three digits after it: a
    // thousands group — `1,234` is one thousand and not one-and-a-bit.
    const decimal = both || (!repeated && tail.length !== 3);
    if (decimal) {
      whole = body.slice(0, cut);
      fraction = tail;
    }
  }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;

  const scale = 10 ** exponent;
  const cents = Math.round(Number(`${whole || '0'}.${fraction || '0'}`) * scale);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Minor units as a person reads them.
 *
 * `Intl.NumberFormat` does the currency, because where the symbol goes and what
 * separates the thousands is a property of the reader's language rather than of
 * the money. A currency this runtime has never heard of falls back to the code
 * itself rather than throwing — a budget in a currency `Intl` does not know is
 * still a budget.
 */
export function formatMoney(
  minor: Minor,
  currency: string,
  locale = 'en',
  options: { compact?: boolean; exponent?: number } = {},
): string {
  const exponent = options.exponent ?? 2;
  const value = (minor ?? 0) / 10 ** exponent;
  const shape: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: currency || 'EUR',
    // A budget is read at the scale of thousands, so cents are noise on every
    // figure except the invoice somebody is checking. `compact` is off by
    // default and on wherever a whole column of totals is shown at once.
    ...(options.compact
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { minimumFractionDigits: exponent, maximumFractionDigits: exponent }),
  };
  try {
    return new Intl.NumberFormat(locale, shape).format(value);
  } catch {
    return `${value.toFixed(options.compact ? 1 : exponent)} ${currency || ''}`.trim();
  }
}

/* ------------------------------------------------------------- allocations */

/**
 * Shares that add up to the whole, from whatever somebody supplied.
 *
 * A cost that is 90% allocated is a cost 10% of which has quietly left every
 * per-project report while still counting in the total, which is the sort of
 * discrepancy that takes an afternoon to find. So the shares are scaled to sum
 * to `FULL_SHARE` and the rounding remainder is given to the largest — the
 * largest, rather than the first, so the answer does not depend on the order
 * rows happen to arrive in from two devices.
 *
 * An empty list stays empty. Unallocated is a real state, not a rounding error.
 */
export function normaliseAllocations(input: readonly Allocation[] | null | undefined): Allocation[] {
  const rows = (input ?? [])
    .filter((row) => row && row.project_id && Number.isFinite(row.share) && row.share > 0)
    .map((row) => ({ project_id: row.project_id, share: Math.round(row.share) }));
  if (!rows.length) return [];

  // Two rows for one project are one row. Two devices adding the same project
  // offline is exactly how that happens.
  const merged = new Map<ID, number>();
  for (const row of rows) merged.set(row.project_id, (merged.get(row.project_id) ?? 0) + row.share);

  const total = [...merged.values()].reduce((sum, share) => sum + share, 0);
  if (total <= 0) return [];

  const scaled = [...merged].map(([project_id, share]) => ({
    project_id,
    share: Math.floor((share * FULL_SHARE) / total),
  }));
  let remainder = FULL_SHARE - scaled.reduce((sum, row) => sum + row.share, 0);
  // Largest share first, and the project id as a tie-break so two devices that
  // scale the same list reach the same answer rather than a mergeable-looking
  // pair of different ones.
  const order = [...scaled].sort((a, b) => b.share - a.share || (a.project_id < b.project_id ? -1 : 1));
  for (let index = 0; remainder > 0; index = (index + 1) % order.length, remainder--) {
    order[index].share += 1;
  }
  return scaled;
}

/**
 * Split an amount between projects so the parts sum to exactly the whole.
 *
 * Largest-remainder, which is the only method that both keeps every project's
 * share as close as possible to its proportion *and* guarantees the parts add
 * up. Naive rounding does neither: three projects splitting €10.00 equally
 * comes to €9.99 or €10.02 depending on which way the third rounds, and a
 * portfolio report that is two cents out is a portfolio report somebody stops
 * trusting.
 *
 * An unallocated cost returns an empty map. It is not silently charged to
 * anybody — see `unallocatedOf`, which is how it stays visible.
 */
export function allocate(amount: Minor, allocations: readonly Allocation[] | null | undefined): Map<ID, Minor> {
  const shares = normaliseAllocations(allocations);
  const out = new Map<ID, Minor>();
  if (!shares.length || !amount) return out;

  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);
  const parts = shares.map((row) => {
    const exact = (magnitude * row.share) / FULL_SHARE;
    const floor = Math.floor(exact);
    return { project_id: row.project_id, floor, remainder: exact - floor };
  });
  let left = magnitude - parts.reduce((sum, part) => sum + part.floor, 0);
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder
    || (a.project_id < b.project_id ? -1 : 1))) {
    if (left <= 0) break;
    part.floor += 1;
    left--;
  }
  for (const part of parts) out.set(part.project_id, sign * part.floor);
  return out;
}

/**
 * Which split an actual follows: its own, or the plan line's if it has none.
 *
 * Inheriting is the useful default by a wide margin — an invoice for the
 * cluster splits the way the cluster does — and overriding matters for the one
 * month somebody's usage was not typical. An actual against no line and with no
 * split of its own is unallocated, which is a state worth seeing.
 */
export function allocationsFor(
  actual: Pick<BudgetActual, 'allocations' | 'line_id'>,
  lines: ReadonlyMap<ID, Pick<BudgetLine, 'allocations'>> | readonly BudgetLine[],
): Allocation[] {
  const own = normaliseAllocations(actual.allocations);
  if (own.length) return own;
  if (!actual.line_id) return [];
  const line = lines instanceof Map
    ? lines.get(actual.line_id)
    : (lines as readonly BudgetLine[]).find((row) => row.id === actual.line_id);
  return normaliseAllocations(line?.allocations);
}

/* ------------------------------------------------------------------ months */

/** `YYYY-MM` — the bucket every chart and every roll-up counts in. */
export type Month = string;

export const monthOf = (date: ISODate): Month => date.slice(0, 7);

/** The first day of a month, as the ISO date everything else here speaks. */
export const monthStart = (month: Month): ISODate => `${month}-01`;

export function addMonths(month: Month, count: number): Month {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + count;
  const shifted = new Date(Date.UTC(year, index, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** How many whole months from one to the other; negative when it runs backwards. */
export function monthDistance(from: Month, to: Month): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
    + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
}

/**
 * Every month from one to the other, inclusive.
 *
 * Capped at 600 — fifty years. Not defensive programming for its own sake: the
 * period comes off a form, somebody will type `2206` for `2026`, and the
 * difference between a chart with a wrong end date and a tab that never
 * finishes rendering is this line.
 */
export function monthsBetween(from: Month, to: Month): Month[] {
  const span = monthDistance(from, to);
  if (span < 0) return [from];
  const out: Month[] = [];
  for (let index = 0; index <= Math.min(span, 599); index++) out.push(addMonths(from, index));
  return out;
}

const MONTHS_PER: Record<string, number> = { once: 0, monthly: 1, quarterly: 3, yearly: 12 };

/* -------------------------------------------------------------------- plan */

/** A budget's period, with sensible answers when it has not been given one. */
export function periodOf(budget: Pick<Budget, 'period_start' | 'period_end'>, today: ISODate): { from: Month; to: Month } {
  const from = monthOf(budget.period_start || budget.period_end || today);
  const to = monthOf(budget.period_end || budget.period_start || today);
  return monthDistance(from, to) < 0 ? { from: to, to: from } : { from, to };
}

/** A line's own window, falling back to its budget's period. */
export function windowOf(
  line: Pick<BudgetLine, 'starts_on' | 'ends_on'>,
  period: { from: Month; to: Month },
): { from: Month; to: Month } {
  const from = line.starts_on ? monthOf(line.starts_on) : period.from;
  const to = line.ends_on ? monthOf(line.ends_on) : period.to;
  return monthDistance(from, to) < 0 ? { from, to: from } : { from, to };
}

/**
 * When a line's money is planned to land, month by month.
 *
 * A one-off lands in the month its window opens. A recurring line lands every
 * month, quarter or year from there until its window closes — counted from the
 * line's own start rather than from the calendar, because a contract that
 * renews in February renews in February, not in January because that is when
 * the quarter does.
 *
 * Months outside the budget's own period are dropped: a line that runs past the
 * end of the budget is planning next year's money, and adding it to this year's
 * total is how a budget appears overspent from the day it is written.
 */
export function scheduleOf(
  line: Pick<BudgetLine, 'amount' | 'recurrence' | 'starts_on' | 'ends_on'>,
  period: { from: Month; to: Month },
): Map<Month, Minor> {
  const window = windowOf(line, period);
  const out = new Map<Month, Minor>();
  const amount = Math.round(Number(line.amount) || 0);
  if (!amount) return out;

  const step = MONTHS_PER[line.recurrence] ?? 0;
  const within = (month: Month) => monthDistance(period.from, month) >= 0 && monthDistance(month, period.to) >= 0;

  if (!step) {
    if (within(window.from)) out.set(window.from, amount);
    return out;
  }
  const span = monthDistance(window.from, window.to);
  for (let offset = 0; offset <= span; offset += step) {
    const month = addMonths(window.from, offset);
    if (!within(month)) continue;
    out.set(month, (out.get(month) ?? 0) + amount);
  }
  return out;
}

/** What one line is planned to cost across the whole period. */
export function plannedTotal(
  line: Pick<BudgetLine, 'amount' | 'recurrence' | 'starts_on' | 'ends_on'>,
  period: { from: Month; to: Month },
): Minor {
  let total = 0;
  for (const amount of scheduleOf(line, period).values()) total += amount;
  return total;
}

/* ------------------------------------------------- confirming a plan line */

/**
 * One month's occurrence of a planned cost, and whether it has been recorded.
 *
 * The shape behind "confirm this line for March". A recurring cost that lands
 * at exactly the planned amount is the overwhelming majority of what a budget
 * records — twelve identical hosting bills a year — and typing the same four
 * fields twelve times is both tedious and the reason the actuals in a budget
 * stop being filled in around April.
 */
export interface PlannedForMonth {
  line: BudgetLine;
  month: Month;
  /** What the plan says this month costs. One occurrence, not the period. */
  amount: Minor;
  /** The day to date it: the line's own day of the month, clamped. */
  on: ISODate;
  /** What is already recorded against this line in this month. */
  recorded: Minor;
  /** Whether anything at all is. See below for why this is not a comparison. */
  confirmed: boolean;
}

/**
 * What a month's plan expects, and what has already been recorded against it.
 *
 * `confirmed` is "is there anything at all", not "does the total match". A line
 * paid across two invoices is a real thing, and a check that compared totals
 * would keep offering to confirm the rest of it — which is how somebody ends up
 * booking a cost one and a half times. Once a month has *any* record against a
 * line, the offer to confirm it goes away and the ordinary Record-spend path
 * takes over. Under-recording is visible in the figures; a silent double-book
 * is not.
 */
export function plannedForMonth(input: {
  lines: readonly BudgetLine[];
  actuals: readonly BudgetActual[];
  month: Month;
  period: { from: Month; to: Month };
}): PlannedForMonth[] {
  const recorded = new Map<ID, Minor>();
  for (const entry of input.actuals) {
    if (!entry.line_id || monthOf(entry.spent_on || '') !== input.month) continue;
    recorded.set(entry.line_id, (recorded.get(entry.line_id) ?? 0) + (Math.round(Number(entry.amount)) || 0));
  }

  const out: PlannedForMonth[] = [];
  for (const line of input.lines) {
    const amount = scheduleOf(line, input.period).get(input.month);
    if (!amount) continue;
    out.push({
      line,
      month: input.month,
      amount,
      on: dayInMonth(line, input.month),
      recorded: recorded.get(line.id) ?? 0,
      confirmed: recorded.has(line.id),
    });
  }
  return out.sort((a, b) => b.amount - a.amount || a.line.name.localeCompare(b.line.name));
}

/**
 * Which day of the month a confirmed cost is dated.
 *
 * The line's own day, carried across: a contract billed on the 15th is billed
 * on the 15th, and dating every confirmation to the 1st would put a month's
 * costs on a day none of them happened. `shiftDate` clamps, so a line starting
 * on the 31st lands on the last day of a short month rather than sliding into
 * the next one — which would file it under the wrong month entirely, and this
 * function exists to decide a month.
 */
function dayInMonth(line: Pick<BudgetLine, 'starts_on'>, month: Month): ISODate {
  if (!line.starts_on) return monthStart(month);
  return shiftDate(line.starts_on, monthDistance(monthOf(line.starts_on), month));
}

/**
 * The record a confirmation writes.
 *
 * Deliberately the same shape somebody typing it by hand would produce, so a
 * confirmed row is an ordinary actual in every respect — editable, deletable,
 * counted the same way, and indistinguishable in the totals. There is no
 * "confirmed" flag on the row and nothing downstream knows the difference.
 *
 * `allocations` is left empty on purpose. An empty split *means* "follow the
 * line", so a confirmed cost keeps following its line when the percentages
 * change later — copying today's split would freeze it into twelve rows that
 * then quietly disagree with the plan they came from.
 */
export function actualFromPlan(
  planned: PlannedForMonth,
  options: { budgetId: ID; stage: SpendStage; describe?: (planned: PlannedForMonth) => string },
): Record<string, unknown> {
  return {
    budget_id: options.budgetId,
    line_id: planned.line.id,
    description: options.describe?.(planned) ?? planned.line.name,
    category: planned.line.category,
    amount: planned.amount,
    spent_on: planned.on,
    stage: options.stage,
    vendor: planned.line.vendor ?? null,
    reference: null,
    allocations: [],
    note: null,
  };
}

/* --------------------------------------------------------------- scenarios */

/** Does this adjustment speak about this line? */
function matches(adjustment: ScenarioAdjustment, line: BudgetLine): boolean {
  if (adjustment.line_id) return adjustment.line_id === line.id;
  if (adjustment.category && adjustment.category !== line.category) return false;
  if (adjustment.kind && adjustment.kind !== line.kind) return false;
  // Neither an id nor a filter is "every line" — which is how "cut everything
  // by ten percent" is one adjustment rather than one per line.
  return true;
}

/**
 * The plan as a scenario would have it.
 *
 * Returns new line objects; the stored plan is never touched, which is the
 * whole point — a scenario is an argument somebody is making, not a decision
 * somebody has taken, and the two must not be the same rows.
 *
 * Order matters and is the order the adjustments are written in: a factor and
 * then a delta is not the same as a delta and then a factor, and pretending
 * otherwise would make a scenario mean something different from what it reads
 * like on the screen.
 *
 * `weights` applies last, and only to lines the plan is not sure about. It is
 * the honest version of the thing every finance spreadsheet does by hand:
 * carry all of the signed money, some of the likely money and none of the
 * maybes, and say which is which.
 */
export function applyScenario(
  lines: readonly BudgetLine[],
  scenario: Pick<BudgetScenario, 'adjustments' | 'weights'> | null | undefined,
): BudgetLine[] {
  if (!scenario) return [...lines];
  const adjustments = scenario.adjustments ?? [];
  const weights = scenario.weights ?? null;
  const out: BudgetLine[] = [];

  for (const line of lines) {
    let amount = Math.round(Number(line.amount) || 0);
    let startsOn = line.starts_on;
    let endsOn = line.ends_on;
    let dropped = false;

    for (const adjustment of adjustments) {
      if (!matches(adjustment, line)) continue;
      if (adjustment.drop) { dropped = true; break; }
      if (adjustment.factor != null && Number.isFinite(adjustment.factor)) {
        amount = Math.round((amount * adjustment.factor) / FULL_SHARE);
      }
      if (adjustment.delta != null && Number.isFinite(adjustment.delta)) {
        amount += Math.round(adjustment.delta);
      }
      const shift = adjustment.shift_months;
      if (shift != null && Number.isFinite(shift) && shift !== 0) {
        // Whole months, so a line that starts on the 15th still starts on the
        // 15th. Slipping a project by a quarter does not move its invoice dates
        // within the month, and pretending it does invents precision.
        if (startsOn) startsOn = shiftDate(startsOn, shift);
        if (endsOn) endsOn = shiftDate(endsOn, shift);
      }
    }
    if (dropped) continue;

    if (weights) {
      const weight = weights[line.confidence];
      if (weight != null && Number.isFinite(weight)) amount = Math.round((amount * weight) / FULL_SHARE);
    }
    out.push({ ...line, amount, starts_on: startsOn, ends_on: endsOn });
  }
  return out;
}

/** Move an ISO date by whole months, clamping to the end of a shorter one. */
export function shiftDate(date: ISODate, months: number): ISODate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10)) || 1;
  const target = new Date(Date.UTC(year, month + months, 1));
  // The 31st of a month the target does not have is its last day, not the 1st
  // of the next one — a payment on the last day of the quarter stays there.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- roll-ups */

export interface CategoryTotal {
  key: CostCategory;
  planned: Minor;
  actual: Minor;
}

export interface ProjectTotal {
  /** Empty string is the unallocated bucket. */
  project_id: ID | '';
  planned: Minor;
  actual: Minor;
}

export interface MonthTotal {
  month: Month;
  planned: Minor;
  actual: Minor;
  plannedToDate: Minor;
  actualToDate: Minor;
  /** Actual so far, then the plan for what is left. The EAC curve. */
  forecastToDate: Minor;
}

export interface BudgetTotals {
  currency: string;
  /** Signed off. `0` means nobody has, and the plan is the only number there is. */
  approved: Minor;
  /** What the lines add up to over the period. */
  planned: Minor;
  /** Contracted but not yet invoiced — the number a budget gets caught by. */
  committed: Minor;
  invoiced: Minor;
  paid: Minor;
  /** Money that has really gone: invoiced plus paid. */
  spent: Minor;
  /** Money no longer available: spent plus committed. */
  actual: Minor;
  /** Planned money in months that have not happened yet. */
  remaining: Minor;
  /** Estimate at completion: what has gone, plus what is still planned. */
  forecast: Minor;
  /**
   * The same estimate the other way round: what has gone, scaled by how much
   * of the period is left. Null before anything has been spent, and null for a
   * budget with no period — an extrapolation from nothing is not a forecast.
   */
  runRate: Minor | null;
  /** Envelope minus forecast. Negative is an overrun. */
  variance: Minor;
  /** Of the envelope, how much is gone. `null` when there is no envelope. */
  used: number | null;
  /** Of the period, how much has passed. */
  elapsed: number;
}

export interface BudgetRollUp extends BudgetTotals {
  period: { from: Month; to: Month };
  byCategory: CategoryTotal[];
  byProject: ProjectTotal[];
  byMonth: MonthTotal[];
  /** Planned money nobody has assigned to a project. */
  unallocatedPlanned: Minor;
  unallocatedActual: Minor;
  /** Actuals that no plan line accounts for — usually the interesting ones. */
  unplanned: Minor;
}

const STAGE_KEYS: Record<SpendStage, 'committed' | 'invoiced' | 'paid'> = {
  committed: 'committed', invoiced: 'invoiced', paid: 'paid',
};

/**
 * Everything a budget screen needs, in one pass over the rows.
 *
 * One function rather than a dozen selectors because every number here is
 * defined in terms of the others — a forecast that used a different definition
 * of "actual" from the tile above it would be wrong in a way nobody could see.
 *
 * `asOf` is a parameter rather than `today` so a report can be run for the end
 * of last month, which is when a PMO actually runs it.
 */
export function rollUp(input: {
  budget: Budget;
  lines: readonly BudgetLine[];
  actuals: readonly BudgetActual[];
  scenario?: Pick<BudgetScenario, 'adjustments' | 'weights'> | null;
  asOf?: ISODate;
}): BudgetRollUp {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const budget = input.budget;
  const period = periodOf(budget, asOf);
  const lines = applyScenario(input.lines, input.scenario);
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const months = monthsBetween(period.from, period.to);
  const nowMonth = monthOf(asOf);

  const plannedByMonth = new Map<Month, Minor>();
  const actualByMonth = new Map<Month, Minor>();
  const byCategory = new Map<CostCategory, CategoryTotal>();
  const byProject = new Map<ID | '', ProjectTotal>();

  const bump = (map: Map<Month, Minor>, month: Month, amount: Minor) =>
    map.set(month, (map.get(month) ?? 0) + amount);
  const category = (key: CostCategory): CategoryTotal => {
    let row = byCategory.get(key);
    if (!row) byCategory.set(key, row = { key, planned: 0, actual: 0 });
    return row;
  };
  const project = (id: ID | ''): ProjectTotal => {
    let row = byProject.get(id);
    if (!row) byProject.set(id, row = { project_id: id, planned: 0, actual: 0 });
    return row;
  };

  let planned = 0;
  let unallocatedPlanned = 0;
  for (const line of lines) {
    const schedule = scheduleOf(line, period);
    let total = 0;
    for (const [month, amount] of schedule) {
      bump(plannedByMonth, month, amount);
      total += amount;
    }
    if (!total) continue;
    planned += total;
    category(line.category).planned += total;
    const split = allocate(total, line.allocations);
    if (split.size) for (const [id, amount] of split) project(id).planned += amount;
    else { unallocatedPlanned += total; project('').planned += total; }
  }

  const stages = { committed: 0, invoiced: 0, paid: 0 };
  let unallocatedActual = 0;
  let unplanned = 0;
  for (const entry of input.actuals) {
    const amount = Math.round(Number(entry.amount) || 0);
    if (!amount) continue;
    // An actual dated outside the period belongs to a different budget's story.
    const month = monthOf(entry.spent_on || monthStart(period.from));
    if (monthDistance(period.from, month) < 0 || monthDistance(month, period.to) < 0) continue;

    stages[STAGE_KEYS[entry.stage] ?? 'paid'] += amount;
    bump(actualByMonth, month, amount);
    category(entry.category).actual += amount;
    if (!entry.line_id || !lineById.has(entry.line_id)) unplanned += amount;

    const split = allocate(amount, allocationsFor(entry, lineById));
    if (split.size) for (const [id, part] of split) project(id).actual += part;
    else { unallocatedActual += amount; project('').actual += amount; }
  }

  const spent = stages.invoiced + stages.paid;
  const actual = spent + stages.committed;

  /*
   * The forecast, month by month, under one rule applied everywhere:
   *
   *   a month that has closed contributes what actually happened;
   *   this month and every month after it contribute whichever is larger,
   *   what has happened or what was planned.
   *
   * The rule is here rather than in two places because the obvious pair of
   * definitions disagree. "Actuals to date plus the remaining plan" counts
   * this month twice when its invoice has already landed; "actuals plus the
   * plan for months after this one" loses this month's bill entirely when it
   * has not. Taking the larger of the two for an open month does neither: it
   * shows an overrun the month it happens and never charges for it twice.
   *
   * The tile and the curve both read this loop, so the number at the end of
   * the burn chart is the number on the forecast tile, by construction.
   */
  const byMonth: MonthTotal[] = [];
  let plannedToDate = 0;
  let actualToDate = 0;
  let forecastToDate = 0;
  for (const month of months) {
    const plannedHere = plannedByMonth.get(month) ?? 0;
    const actualHere = actualByMonth.get(month) ?? 0;
    const closed = monthDistance(month, nowMonth) > 0;
    plannedToDate += plannedHere;
    actualToDate += actualHere;
    forecastToDate += closed ? actualHere : Math.max(actualHere, plannedHere);
    byMonth.push({ month, planned: plannedHere, actual: actualHere, plannedToDate, actualToDate, forecastToDate });
  }

  const forecast = forecastToDate;
  // What is still expected to go. Never negative: every month contributes at
  // least what it has already spent, so the forecast cannot fall below it.
  const remaining = Math.max(forecast - actual, 0);

  const elapsedMonths = Math.min(Math.max(monthDistance(period.from, nowMonth) + 1, 0), months.length);
  const elapsed = months.length ? elapsedMonths / months.length : 0;
  const runRate = actual > 0 && elapsed > 0 && months.length > 1 ? Math.round(actual / elapsed) : null;

  const envelope = budget.approved || planned;

  return {
    currency: budget.currency || 'EUR',
    approved: budget.approved || 0,
    planned,
    committed: stages.committed,
    invoiced: stages.invoiced,
    paid: stages.paid,
    spent,
    actual,
    remaining,
    forecast,
    runRate,
    variance: envelope - forecast,
    used: envelope ? actual / envelope : null,
    elapsed,
    period,
    byCategory: [...byCategory.values()].sort((a, b) => b.planned - a.planned || b.actual - a.actual),
    byProject: [...byProject.values()].sort((a, b) => b.planned - a.planned || b.actual - a.actual),
    byMonth,
    unallocatedPlanned,
    unallocatedActual,
    unplanned,
  };
}

/**
 * How a budget is doing, in one word.
 *
 * Thresholds rather than a continuous colour, because the question a portfolio
 * screen answers is "which of these do I need to look at" and a gradient
 * answers it worse than three buckets. `over` is a forecast past the envelope;
 * `tight` is within five per cent of it, which is the band where a budget is
 * technically fine and practically finished.
 */
export type BudgetHealth = 'unset' | 'healthy' | 'tight' | 'over';

export function healthOf(totals: Pick<BudgetTotals, 'approved' | 'planned' | 'forecast'>): BudgetHealth {
  const envelope = totals.approved || totals.planned;
  if (!envelope) return 'unset';
  if (totals.forecast > envelope) return 'over';
  if (totals.forecast >= envelope * 0.95) return 'tight';
  return 'healthy';
}

/**
 * What one project's share of a set of budgets comes to.
 *
 * The other direction from `rollUp`, and the reason allocations exist: a
 * project lead does not care what the central infrastructure budget totals,
 * they care what lands on them. Budgets in different currencies are kept apart
 * rather than added — see `Budget.currency`.
 */
export function projectShare(input: {
  projectId: ID;
  budgets: readonly Budget[];
  lines: readonly BudgetLine[];
  actuals: readonly BudgetActual[];
  asOf?: ISODate;
}): { currency: string; planned: Minor; actual: Minor; budgets: number }[] {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const linesFor = new Map<ID, BudgetLine[]>();
  for (const line of input.lines) {
    const rows = linesFor.get(line.budget_id) ?? [];
    rows.push(line);
    linesFor.set(line.budget_id, rows);
  }
  const actualsFor = new Map<ID, BudgetActual[]>();
  for (const entry of input.actuals) {
    const rows = actualsFor.get(entry.budget_id) ?? [];
    rows.push(entry);
    actualsFor.set(entry.budget_id, rows);
  }

  const totals = new Map<string, { currency: string; planned: Minor; actual: Minor; budgets: number }>();
  for (const budget of input.budgets) {
    const rolled = rollUp({
      budget,
      lines: linesFor.get(budget.id) ?? [],
      actuals: actualsFor.get(budget.id) ?? [],
      asOf,
    });
    const share = rolled.byProject.find((row) => row.project_id === input.projectId);
    if (!share || (!share.planned && !share.actual)) continue;
    const currency = rolled.currency;
    const row = totals.get(currency) ?? { currency, planned: 0, actual: 0, budgets: 0 };
    row.planned += share.planned;
    row.actual += share.actual;
    row.budgets += 1;
    totals.set(currency, row);
  }
  return [...totals.values()].sort((a, b) => b.planned - a.planned);
}

/** Every confidence level a plan carries, and what each is worth. */
export function byConfidence(
  lines: readonly BudgetLine[],
  period: { from: Month; to: Month },
): Record<CostConfidence, Minor> {
  const out: Record<CostConfidence, Minor> = { committed: 0, likely: 0, possible: 0 };
  for (const line of lines) out[line.confidence] = (out[line.confidence] ?? 0) + plannedTotal(line, period);
  return out;
}

/** Every kind a plan carries — the capex/opex split a finance report opens with. */
export function byKind(
  lines: readonly BudgetLine[],
  period: { from: Month; to: Month },
): Record<CostKind, Minor> {
  const out: Record<CostKind, Minor> = { opex: 0, capex: 0 };
  for (const line of lines) out[line.kind] = (out[line.kind] ?? 0) + plannedTotal(line, period);
  return out;
}

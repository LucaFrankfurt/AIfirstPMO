/**
 * Where a number stands against what it was supposed to be.
 *
 * The same shape as `budget.ts`, and for the same reason: a definition, a list
 * of things that actually happened, and one pure function that compares them.
 * The server answers MCP from it and the browser draws the dashboard from it,
 * so the two cannot disagree about whether a KPI is on track — which they
 * would, because "on track" is a judgement with at least four defensible
 * definitions and any two implementations would pick different ones.
 *
 * Values are integers scaled by the KPI's own `decimals`, for the reason money
 * is minor units: 99.95 stored as a float and averaged over twelve readings is
 * not 99.95, and these figures are compared against a target that somebody will
 * argue about. `parseMeasure` and `formatMeasure` are the only two places a
 * decimal point exists.
 */
import { parseMoney } from './budget.ts';
import { duration } from './duration.ts';
import { MEASURE_HEALTH } from './types.ts';
import type {
  ISODate, Kpi, KpiReading, KpiTarget, MeasureCadence, MeasureHealth, Module,
} from './types.ts';

/* ------------------------------------------------------------------ values */

/**
 * Read what somebody typed as a scaled integer.
 *
 * The money parser, with the exponent handed in. Not a copy of it: `1.234,56`,
 * `1,234.56` and `1234` have to read the same way here as they do in a budget,
 * and two parsers that agree today are two parsers that disagree after the next
 * bug report. The only thing money adds is a currency symbol to strip, which a
 * KPI written "94 %" needs stripped just the same.
 */
export const parseMeasure = (input: string, decimals: number): number | null =>
  parseMoney(input, Math.max(0, Math.min(4, Math.round(decimals) || 0)));

/**
 * A measurement as a person reads it.
 *
 * `duration` is the one that is not just a number with a word after it: minutes
 * are read as hours and minutes by the same function the timesheet uses, so
 * "lead time" and "time logged" are written the same way on two screens that
 * sit next to each other in the sidebar.
 */
export function formatMeasure(
  value: number | null | undefined,
  kpi: Pick<Kpi, 'unit' | 'unit_label' | 'decimals'>,
  locale = 'en',
): string {
  if (value === null || value === undefined) return '—';
  const decimals = Math.max(0, Math.min(4, Math.round(kpi.decimals) || 0));
  if (kpi.unit === 'duration') return duration(Math.round(value / 10 ** decimals));
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 10 ** decimals);
  if (kpi.unit === 'percent') return `${number} %`;
  if (kpi.unit === 'score') return number;
  return kpi.unit_label ? `${number} ${kpi.unit_label}` : number;
}

/* ------------------------------------------------------------------- dates */

const DAY = 86_400_000;
const dayOf = (date: ISODate): number => Date.parse(`${date}T00:00:00Z`);
const daysBetween = (from: ISODate, to: ISODate): number =>
  Math.round((dayOf(to) - dayOf(from)) / DAY);

/**
 * How long a reading stands for before it stops describing today.
 *
 * Two cadences, not one. One is too tight — a weekly number taken eight days
 * ago is late, not unusable — and the point of the state is to catch the KPI
 * nobody has touched since the quarter it was invented in, not to nag.
 */
export const CADENCE_DAYS: Record<MeasureCadence, number> = {
  daily: 1, weekly: 7, monthly: 31, quarterly: 92,
};

export const staleAfter = (cadence: MeasureCadence): number => CADENCE_DAYS[cadence] * 2;

/* ---------------------------------------------------------------- readings */

/** Newest first, which is the order every screen wants and no screen should sort for. */
export const byMeasuredOn = (readings: readonly KpiReading[]): KpiReading[] =>
  [...readings].sort((a, b) => (a.measured_on < b.measured_on ? 1 : a.measured_on > b.measured_on ? -1 : b.created_at - a.created_at));

/**
 * The reading that stands for a date.
 *
 * The latest one on or before it, rather than the latest one full stop, so a
 * dashboard asked "as it stood at the end of June" does not answer with a
 * number from August. Two readings on the same day are settled by which was
 * written later, which is the only ordering two devices can agree on.
 */
export function readingOn(readings: readonly KpiReading[], asOf: ISODate): KpiReading | null {
  let best: KpiReading | null = null;
  for (const row of readings) {
    if (!row.measured_on || row.measured_on > asOf) continue;
    if (!best
      || row.measured_on > best.measured_on
      || (row.measured_on === best.measured_on && row.created_at > best.created_at)) best = row;
  }
  return best;
}

/* ----------------------------------------------------------------- targets */

/**
 * When a target is actually due.
 *
 * A target tied to a milestone takes the milestone's date, and takes it *live*
 * rather than as a copy made when somebody linked them. That is the whole
 * reason the link exists: the sentence was "90% by the time we ship", so a
 * milestone that slips a month drags the target with it. A copied date would
 * quietly turn every slip into a missed target.
 *
 * A milestone with no date of its own falls back to whatever was typed on the
 * target, and a target with neither is undated — which is a real state (somebody
 * has said where they want to get to and not yet when) and is reported rather
 * than guessed at.
 */
export function dueOn(
  target: Pick<KpiTarget, 'module_id' | 'due_on'>,
  modules: readonly Pick<Module, 'id' | 'target_date'>[] = [],
): ISODate | null {
  if (target.module_id) {
    const module = modules.find((row) => row.id === target.module_id);
    if (module?.target_date) return module.target_date;
  }
  return target.due_on || null;
}

/**
 * The target in force on a date: the earliest one still ahead of it.
 *
 * "Still ahead" rather than "nearest", because a ladder of targets is a
 * sequence of promises and the one being kept is the next one. Once they have
 * all passed, the last one stands — a KPI does not stop having a target because
 * the date went by, it has a target it is now late for.
 *
 * Undated targets sort last: they are a destination without a deadline, which
 * is worth keeping and cannot displace one that has a date.
 */
export function targetFor(
  targets: readonly KpiTarget[],
  asOf: ISODate,
  modules: readonly Pick<Module, 'id' | 'target_date'>[] = [],
): { target: KpiTarget; due: ISODate | null } | null {
  const dated = targets
    .map((target) => ({ target, due: dueOn(target, modules) }))
    .filter((row): row is { target: KpiTarget; due: ISODate } => !!row.due)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  const ahead = dated.find((row) => row.due >= asOf);
  if (ahead) return ahead;
  if (dated.length) return dated[dated.length - 1];
  const undated = targets.find((target) => !dueOn(target, modules));
  return undated ? { target: undated, due: null } : null;
}

/* ---------------------------------------------------------------- progress */

export interface KpiProgress {
  /** The reading that stands for `asOf`, and when it was taken. */
  value: number | null;
  measuredOn: ISODate | null;
  /** Where it started: the KPI's baseline, or the first reading when there is none. */
  baseline: number | null;
  /** True when the baseline is the first reading rather than a stated one. */
  baselineImplied: boolean;
  target: number | null;
  due: ISODate | null;
  /**
   * How far it has come, in basis points of the distance from baseline to
   * target. Over 10000 is past the target; negative is the wrong way.
   * `null` when there is nothing to measure against.
   */
  achieved: number | null;
  /** Where a straight line from baseline to target says it should be by now. */
  expected: number | null;
  /** Days since the reading that stands for `asOf`. */
  age: number | null;
  health: MeasureHealth;
}

/**
 * Where a KPI stands, under one rule.
 *
 * The rule, in order, because the order is the argument:
 *
 * 1. **No readings — `no_data`.** Nothing has been measured, so nothing can be
 *    on track. A dashboard that paints this green is lying by omission.
 * 2. **The reading is older than two cadences — `stale`.** This is the state
 *    this feature exists to make sayable. A KPI is the one figure that looks
 *    equally confident whether it was taken this morning or in March, and
 *    "we are at 94%" from a number nobody has refreshed in two quarters is not
 *    a claim about today. It outranks on-track deliberately: a stale reading
 *    that happens to be past its target is not evidence of anything.
 * 3. **No target — `no_target`.** Measured, but nobody has said what it should
 *    be. Also not a judgement, and also not green.
 * 4. Otherwise compare where it is against **where a straight line from the
 *    baseline to the target says it should be today**. At or past that line is
 *    `on_track`; behind the line but on the right side of the baseline is
 *    `at_risk`; on the wrong side of the baseline is `off_track`.
 *
 * The line is the whole of the judgement — there is no "within 10%" fudge
 * factor, because a threshold nobody can derive is a threshold every reader
 * has to be told. Direction is handled by measuring *distance travelled toward
 * the target*, which is the same arithmetic whether up or down is better.
 */
export function progressOf(input: {
  kpi: Pick<Kpi, 'baseline' | 'cadence' | 'direction'>;
  readings: readonly KpiReading[];
  targets?: readonly KpiTarget[];
  modules?: readonly Pick<Module, 'id' | 'target_date'>[];
  asOf?: ISODate;
}): KpiProgress {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const reading = readingOn(input.readings, asOf);
  const chosen = targetFor(input.targets ?? [], asOf, input.modules ?? []);

  const ordered = byMeasuredOn(input.readings.filter((row) => row.measured_on && row.measured_on <= asOf));
  const first = ordered[ordered.length - 1] ?? null;
  const stated = input.kpi.baseline;
  const baseline = stated ?? (first ? first.value : null);

  const out: KpiProgress = {
    value: reading ? reading.value : null,
    measuredOn: reading ? reading.measured_on : null,
    baseline,
    baselineImplied: stated === null || stated === undefined,
    target: chosen ? chosen.target.value : null,
    due: chosen ? chosen.due : null,
    achieved: null,
    expected: null,
    age: reading ? daysBetween(reading.measured_on, asOf) : null,
    health: 'no_data',
  };

  if (!reading) return out;
  if (out.age !== null && out.age > staleAfter(input.kpi.cadence)) {
    out.health = 'stale';
    // The distances are still computed below for the screens, which show the
    // last known position even while refusing to call it current.
  }
  if (!chosen) {
    if (out.health !== 'stale') out.health = 'no_target';
    return out;
  }

  const target = chosen.target.value;
  const span = target - (baseline ?? reading.value);
  if (span !== 0) {
    out.achieved = Math.round(((reading.value - (baseline ?? reading.value)) / span) * 10_000);
  } else {
    // Baseline and target are the same number: holding a level rather than
    // moving one. Reaching it is the whole of the job, so it is all-or-nothing
    // rather than a division by zero.
    out.achieved = reading.value === target ? 10_000 : 0;
  }

  const from = first ? first.measured_on : reading.measured_on;
  if (chosen.due && span !== 0) {
    const total = daysBetween(from, chosen.due);
    const gone = daysBetween(from, asOf);
    out.expected = total <= 0 ? 10_000 : Math.max(0, Math.min(10_000, Math.round((gone / total) * 10_000)));
  } else {
    // Undated, or nothing to travel: the target is either met or it is not, so
    // "should be here by now" is the whole distance.
    out.expected = 10_000;
  }

  if (out.health === 'stale') return out;
  out.health = out.achieved >= out.expected ? 'on_track'
    : out.achieved > 0 ? 'at_risk'
      : 'off_track';
  return out;
}

/* ------------------------------------------------------------------ trends */

export interface KpiTrend {
  /** The change over one cadence, in the KPI's own units. */
  change: number | null;
  /** Whether that change is toward the target, given the KPI's direction. */
  better: boolean | null;
  from: ISODate | null;
  to: ISODate | null;
}

/**
 * Which way it has moved over one cadence.
 *
 * One cadence rather than a fixed window, because the useful comparison for a
 * daily number and a quarterly one are not the same length, and a fixed
 * fortnight would report "no change" for every quarterly KPI in the workspace.
 *
 * `better` is direction-aware and separate from the sign, so a screen never has
 * to know that falling churn is good — the arithmetic that does know is here,
 * once.
 */
export function trendOf(
  kpi: Pick<Kpi, 'direction' | 'cadence'>,
  readings: readonly KpiReading[],
  asOf: ISODate = new Date().toISOString().slice(0, 10),
): KpiTrend {
  const now = readingOn(readings, asOf);
  if (!now) return { change: null, better: null, from: null, to: null };
  const back = new Date(dayOf(asOf) - CADENCE_DAYS[kpi.cadence] * DAY).toISOString().slice(0, 10);
  const then = readingOn(readings.filter((row) => row.id !== now.id), back);
  if (!then) return { change: null, better: null, from: null, to: now.measured_on };
  const change = now.value - then.value;
  return {
    change,
    better: change === 0 ? null : (kpi.direction === 'up' ? change > 0 : change < 0),
    from: then.measured_on,
    to: now.measured_on,
  };
}

/* ------------------------------------------------------------------ series */

export interface SeriesPoint {
  on: ISODate;
  value: number;
}

/**
 * The readings as a line, oldest first, with the target as a second series.
 *
 * The target line is drawn from the baseline to each target in turn rather than
 * as a flat bar at the final figure, because a flat bar answers "have we
 * arrived" and the useful question halfway through a year is "are we where we
 * said we would be by now". It is the same straight line `progressOf` judges
 * against, so the picture and the verdict cannot disagree.
 */
export function seriesOf(input: {
  kpi: Pick<Kpi, 'baseline'>;
  readings: readonly KpiReading[];
  targets?: readonly KpiTarget[];
  modules?: readonly Pick<Module, 'id' | 'target_date'>[];
  asOf?: ISODate;
}): { actual: SeriesPoint[]; target: SeriesPoint[] } {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const actual = byMeasuredOn(input.readings.filter((row) => row.measured_on && row.measured_on <= asOf)).reverse()
    .map((row) => ({ on: row.measured_on, value: row.value }));

  const dated = (input.targets ?? [])
    .map((target) => ({ value: target.value, due: dueOn(target, input.modules ?? []) }))
    .filter((row): row is { value: number; due: ISODate } => !!row.due)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  if (!dated.length) return { actual, target: [] };

  const start = input.kpi.baseline ?? actual[0]?.value ?? dated[0].value;
  const on = actual[0]?.on ?? dated[0].due;
  return {
    actual,
    target: [{ on, value: start }, ...dated.map((row) => ({ on: row.due, value: row.value }))],
  };
}

/* --------------------------------------------------------------- roll-ups */

export interface KpiSummary {
  kpi: Kpi;
  progress: KpiProgress;
  trend: KpiTrend;
}

/**
 * Every KPI with where it stands, worst first.
 *
 * Worst first because a list of numbers sorted by name is a list somebody
 * reads the top of and stops. The states that are not judgements sort between
 * the bad and the good rather than at either end: `no_data` is not a crisis,
 * and it is not fine either.
 */
/* Derived from the enum rather than written out again: two lists in the same
   order are two lists that will one day be in different orders, which is how
   the phone lost three screens last week. `MEASURE_HEALTH` is declared worst
   first for exactly this. */
const rankOf = (health: MeasureHealth): number => MEASURE_HEALTH.indexOf(health);

export function summarise(input: {
  kpis: readonly Kpi[];
  readings: readonly KpiReading[];
  targets: readonly KpiTarget[];
  modules?: readonly Pick<Module, 'id' | 'target_date'>[];
  asOf?: ISODate;
}): KpiSummary[] {
  const readingsBy = new Map<string, KpiReading[]>();
  for (const row of input.readings) {
    const list = readingsBy.get(row.kpi_id);
    if (list) list.push(row); else readingsBy.set(row.kpi_id, [row]);
  }
  const targetsBy = new Map<string, KpiTarget[]>();
  for (const row of input.targets) {
    const list = targetsBy.get(row.kpi_id);
    if (list) list.push(row); else targetsBy.set(row.kpi_id, [row]);
  }

  return input.kpis
    .map((kpi) => {
      const readings = readingsBy.get(kpi.id) ?? [];
      return {
        kpi,
        progress: progressOf({
          kpi, readings, targets: targetsBy.get(kpi.id) ?? [], modules: input.modules, asOf: input.asOf,
        }),
        trend: trendOf(kpi, readings, input.asOf),
      };
    })
    .sort((a, b) => rankOf(a.progress.health) - rankOf(b.progress.health)
      || a.kpi.name.localeCompare(b.kpi.name));
}

/**
 * What has been promised by a milestone.
 *
 * The other direction through the same link: a module page asking "what has to
 * be true by the time this ships". Sorted worst first for the same reason the
 * index is.
 */
export function promisedBy(input: {
  moduleId: string;
  kpis: readonly Kpi[];
  readings: readonly KpiReading[];
  targets: readonly KpiTarget[];
  modules?: readonly Pick<Module, 'id' | 'target_date'>[];
  asOf?: ISODate;
}): KpiSummary[] {
  const wanted = new Set(
    input.targets.filter((row) => row.module_id === input.moduleId).map((row) => row.kpi_id),
  );
  if (!wanted.size) return [];
  return summarise({ ...input, kpis: input.kpis.filter((kpi) => wanted.has(kpi.id)) });
}

/**
 * The judgement, pinned down.
 *
 * "On track" has at least four defensible definitions and every one of them is
 * a sentence somebody will quote in a steering meeting, so the rule lives in
 * one function and this file is what it means. The cases that matter are not
 * the arithmetic — they are the three states a dashboard usually paints green
 * by omission: nothing measured, nothing targeted, and a number too old to
 * stand for today.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dueOn, formatMeasure, parseMeasure, progressOf, promisedBy, seriesOf, summarise,
  targetFor, trendOf,
  type Kpi, type KpiReading, type KpiTarget,
} from '@kolibri/shared';

const kpi = (over: Partial<Kpi> = {}): Kpi => ({
  id: 'k1', workspace_id: 'w', project_id: null, projects: [],
  name: 'Uptime', description: null, unit: 'percent', unit_label: null, decimals: 2,
  direction: 'up', baseline: 9000, cadence: 'monthly', owner_id: null, archived: 0,
  sort_order: 'V', created_at: 1, updated_at: 1, deleted_at: null,
  ...over,
} as Kpi);

let seq = 0;
const reading = (over: Partial<KpiReading> = {}): KpiReading => ({
  id: `r${++seq}`, workspace_id: 'w', kpi_id: 'k1', measured_on: '2026-01-15',
  value: 9000, source: null, note: null,
  created_at: seq, updated_at: seq, deleted_at: null,
  ...over,
} as KpiReading);

const target = (over: Partial<KpiTarget> = {}): KpiTarget => ({
  id: `t${++seq}`, workspace_id: 'w', kpi_id: 'k1', module_id: null,
  due_on: '2026-12-31', value: 9900, note: null, sort_order: 'V',
  created_at: seq, updated_at: seq, deleted_at: null,
  ...over,
} as KpiTarget);

describe('reading and writing a measurement', () => {
  it('reads whatever somebody types the way a budget does', () => {
    // Same parser as money, on purpose: two that agree today are two that
    // disagree after the next bug report.
    assert.equal(parseMeasure('99,95', 2), 9995);
    assert.equal(parseMeasure('99.95', 2), 9995);
    assert.equal(parseMeasure('94 %', 2), 9400);
    assert.equal(parseMeasure('1.234', 0), 1234, 'a lone separator with three digits is thousands');
    assert.equal(parseMeasure('nonsense', 2), null);
  });

  it('writes each unit the way that unit is read', () => {
    assert.equal(formatMeasure(9995, { unit: 'percent', unit_label: null, decimals: 2 }), '99.95 %');
    assert.equal(formatMeasure(4200, { unit: 'number', unit_label: 'Tickets', decimals: 0 }), '4,200 Tickets');
    assert.equal(formatMeasure(47, { unit: 'score', unit_label: null, decimals: 0 }), '47');
    // Minutes read as hours and minutes, by the timesheet's own function.
    assert.equal(formatMeasure(150, { unit: 'duration', unit_label: null, decimals: 0 }), '2h 30m');
  });

  it('says nothing rather than zero when there is no value', () => {
    assert.equal(formatMeasure(null, { unit: 'percent', unit_label: null, decimals: 2 }), '—');
  });
});

describe('the state a dashboard would paint green', () => {
  it('is no_data when nothing has been measured', () => {
    const out = progressOf({ kpi: kpi(), readings: [], targets: [target()], asOf: '2026-06-30' });
    assert.equal(out.health, 'no_data');
    assert.equal(out.value, null);
  });

  it('is no_target when it is measured but nobody said what it should be', () => {
    const out = progressOf({
      kpi: kpi(), readings: [reading({ measured_on: '2026-06-20', value: 9500 })],
      targets: [], asOf: '2026-06-30',
    });
    assert.equal(out.health, 'no_target');
    assert.equal(out.value, 9500);
  });

  it('is stale when the last reading is older than two cadences', () => {
    /*
     * The state this feature exists to make sayable. A monthly KPI last taken
     * in March is not evidence about June, however good the number was.
     */
    const out = progressOf({
      kpi: kpi({ cadence: 'monthly' }),
      readings: [reading({ measured_on: '2026-03-01', value: 9950 })],
      targets: [target()], asOf: '2026-06-30',
    });
    assert.equal(out.health, 'stale');
  });

  it('calls a stale reading stale even when it is past its target', () => {
    // Staleness outranks being on track on purpose: a number nobody has
    // refreshed is not a claim about today, whatever it says.
    const out = progressOf({
      kpi: kpi({ cadence: 'weekly' }),
      readings: [reading({ measured_on: '2026-01-01', value: 10_000 })],
      targets: [target({ value: 9900 })], asOf: '2026-06-30',
    });
    assert.equal(out.health, 'stale');
    assert.ok(out.achieved !== null && out.achieved > 10_000, 'and still reports where it got to');
  });

  it('is not stale while the reading is within two cadences', () => {
    const out = progressOf({
      kpi: kpi({ cadence: 'monthly' }),
      readings: [reading({ measured_on: '2026-06-01', value: 9500 })],
      targets: [target()], asOf: '2026-06-30',
    });
    assert.notEqual(out.health, 'stale');
  });
});

describe('on track means past the line, not near the target', () => {
  const targets = [target({ due_on: '2026-12-31', value: 10_000 })];

  it('is on track when it has come further than the days have', () => {
    // Baseline 90, target 100, half the year gone, at 96: ahead of the line.
    const out = progressOf({
      kpi: kpi({ baseline: 9000 }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 9000 }),
        reading({ measured_on: '2026-06-30', value: 9600 }),
      ],
      targets, asOf: '2026-06-30',
    });
    assert.equal(out.health, 'on_track');
    assert.equal(out.achieved, 6000);
    assert.ok(out.expected !== null && out.expected < 6000);
  });

  it('is at risk when it has moved the right way but not far enough', () => {
    const out = progressOf({
      kpi: kpi({ baseline: 9000 }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 9000 }),
        reading({ measured_on: '2026-06-30', value: 9100 }),
      ],
      targets, asOf: '2026-06-30',
    });
    assert.equal(out.health, 'at_risk');
    assert.equal(out.achieved, 1000);
  });

  it('is off track when it has gone backwards from the baseline', () => {
    const out = progressOf({
      kpi: kpi({ baseline: 9000 }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 9000 }),
        reading({ measured_on: '2026-06-30', value: 8800 }),
      ],
      targets, asOf: '2026-06-30',
    });
    assert.equal(out.health, 'off_track');
    assert.ok(out.achieved !== null && out.achieved < 0);
  });

  it('does not call a KPI sitting exactly on its baseline off track', () => {
    /*
     * The boundary the rule and the code disagreed on. "Off track" is stated as
     * *on the wrong side of the baseline*, and a KPI that has not moved is not
     * on the wrong side of anything — it is behind the line, which is at risk.
     */
    const out = progressOf({
      kpi: kpi({ baseline: 9000 }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 9000 }),
        reading({ measured_on: '2026-06-30', value: 9000 }),
      ],
      targets, asOf: '2026-06-30',
    });
    assert.equal(out.achieved, 0);
    assert.equal(out.health, 'at_risk');
  });

  it('measures distance travelled, so falling is progress when down is better', () => {
    /*
     * Churn at 5%, aiming for 2%, now at 3%: two thirds of the way there. The
     * same arithmetic as the case above without a sign flip anywhere, which is
     * the point — no screen has to know that falling churn is good.
     */
    const out = progressOf({
      kpi: kpi({ direction: 'down', baseline: 500 }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 500 }),
        reading({ measured_on: '2026-06-30', value: 300 }),
      ],
      targets: [target({ value: 200, due_on: '2026-12-31' })],
      asOf: '2026-06-30',
    });
    assert.equal(out.achieved, 6667);
    assert.equal(out.health, 'on_track');
  });

  it('treats holding a level as all or nothing rather than dividing by zero', () => {
    const holding = { kpi: kpi({ baseline: 9900 }), targets: [target({ value: 9900 })], asOf: '2026-06-30' };
    const met = progressOf({ ...holding, readings: [reading({ measured_on: '2026-06-30', value: 9900 })] });
    assert.equal(met.achieved, 10_000);
    assert.equal(met.health, 'on_track');
    /* Negative, not zero: with no distance to travel the baseline *is* the
       target, so a reading that is not on it has moved off it. Zero would have
       reported a dropped level as merely late — see the note in `progressOf`. */
    const missed = progressOf({ ...holding, readings: [reading({ measured_on: '2026-06-30', value: 9800 })] });
    assert.equal(missed.achieved, -10_000);
    assert.equal(missed.health, 'off_track');
  });

  it('falls back to the first reading when no baseline was stated', () => {
    const out = progressOf({
      kpi: kpi({ baseline: null }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 8000 }),
        reading({ measured_on: '2026-06-30', value: 9000 }),
      ],
      targets, asOf: '2026-06-30',
    });
    assert.equal(out.baseline, 8000);
    assert.equal(out.baselineImplied, true, 'and says that is what it did');
  });
});

describe('a target due by a milestone', () => {
  const shipping = { id: 'm1', target_date: '2026-09-30' };

  it('takes the milestone’s date rather than its own', () => {
    assert.equal(dueOn({ module_id: 'm1', due_on: '2026-06-30' }, [shipping]), '2026-09-30');
  });

  it('moves when the milestone moves', () => {
    // The whole reason the link is a link: "90% by the time we ship" is not
    // "90% by 30 September", and a copied date would turn a slip into a miss.
    const slipped = { id: 'm1', target_date: '2026-12-15' };
    assert.equal(dueOn({ module_id: 'm1', due_on: null }, [slipped]), '2026-12-15');
  });

  it('falls back to its own date when the milestone has none', () => {
    assert.equal(dueOn({ module_id: 'm1', due_on: '2026-06-30' }, [{ id: 'm1', target_date: null }]), '2026-06-30');
  });

  it('is undated when neither has a date, rather than guessing one', () => {
    assert.equal(dueOn({ module_id: null, due_on: null }, []), null);
  });

  it('answers the milestone asking which promises ride on it', () => {
    const kpis = [kpi({ id: 'k1', name: 'Uptime' }), kpi({ id: 'k2', name: 'Churn' })];
    const out = promisedBy({
      moduleId: 'm1',
      kpis,
      readings: [reading({ kpi_id: 'k1', measured_on: '2026-06-30', value: 9500 })],
      targets: [target({ kpi_id: 'k1', module_id: 'm1' }), target({ kpi_id: 'k2', module_id: 'm2' })],
      modules: [shipping],
      asOf: '2026-06-30',
    });
    assert.deepEqual(out.map((row) => row.kpi.id), ['k1']);
  });
});

describe('which target is the one in force', () => {
  it('is the next one still ahead, not the nearest', () => {
    const june = target({ id: 'june', due_on: '2026-06-30', value: 9500 });
    const december = target({ id: 'dec', due_on: '2026-12-31', value: 9900 });
    assert.equal(targetFor([december, june], '2026-04-01')?.target.id, 'june');
    assert.equal(targetFor([december, june], '2026-08-01')?.target.id, 'dec');
  });

  it('keeps the last one once they have all passed', () => {
    // A KPI does not stop having a target because the date went by; it has one
    // it is late for.
    const june = target({ id: 'june', due_on: '2026-06-30' });
    assert.equal(targetFor([june], '2027-01-01')?.target.id, 'june');
  });

  it('lets an undated target stand when there is nothing else', () => {
    const someday = target({ id: 'someday', due_on: null });
    const chosen = targetFor([someday], '2026-06-30');
    assert.equal(chosen?.target.id, 'someday');
    assert.equal(chosen?.due, null);
  });
});

describe('which way it has moved', () => {
  it('compares against one cadence ago rather than a fixed window', () => {
    const out = trendOf(kpi({ cadence: 'monthly' }), [
      reading({ measured_on: '2026-05-01', value: 9000 }),
      reading({ measured_on: '2026-06-01', value: 9400 }),
    ], '2026-06-05');
    assert.equal(out.change, 400);
    assert.equal(out.better, true);
  });

  it('knows a fall is an improvement when down is better', () => {
    const out = trendOf(kpi({ direction: 'down', cadence: 'monthly' }), [
      reading({ measured_on: '2026-05-01', value: 500 }),
      reading({ measured_on: '2026-06-01', value: 300 }),
    ], '2026-06-05');
    assert.equal(out.change, -200);
    assert.equal(out.better, true);
  });

  it('says nothing rather than zero when there is only one reading', () => {
    const out = trendOf(kpi(), [reading({ measured_on: '2026-06-01' })], '2026-06-05');
    assert.equal(out.change, null);
    assert.equal(out.better, null);
  });
});

describe('the picture', () => {
  it('draws the target as the line progress is judged against', () => {
    const out = seriesOf({
      kpi: kpi({ baseline: 9000 }),
      readings: [
        reading({ measured_on: '2026-01-01', value: 9000 }),
        reading({ measured_on: '2026-06-30', value: 9600 }),
      ],
      targets: [target({ due_on: '2026-12-31', value: 10_000 })],
      asOf: '2026-06-30',
    });
    assert.deepEqual(out.actual.map((p) => p.value), [9000, 9600], 'oldest first');
    assert.deepEqual(out.target, [{ on: '2026-01-01', value: 9000 }, { on: '2026-12-31', value: 10_000 }]);
  });

  it('leaves out the future, so the line never claims a reading that has not happened', () => {
    const out = seriesOf({
      kpi: kpi(),
      readings: [
        reading({ measured_on: '2026-06-30', value: 9600 }),
        reading({ measured_on: '2026-12-01', value: 9900 }),
      ],
      asOf: '2026-06-30',
    });
    assert.equal(out.actual.length, 1);
  });
});

describe('the list', () => {
  it('puts the worst first, with the non-judgements in the middle', () => {
    const rows = summarise({
      kpis: [
        kpi({ id: 'fine', name: 'Fine' }),
        kpi({ id: 'quiet', name: 'Quiet' }),
        kpi({ id: 'bad', name: 'Bad' }),
      ],
      readings: [
        reading({ kpi_id: 'fine', measured_on: '2026-06-30', value: 9600 }),
        reading({ kpi_id: 'fine', measured_on: '2026-01-01', value: 9000 }),
        reading({ kpi_id: 'bad', measured_on: '2026-06-30', value: 8000 }),
        reading({ kpi_id: 'bad', measured_on: '2026-01-01', value: 9000 }),
      ],
      targets: [
        target({ kpi_id: 'fine', value: 10_000 }),
        target({ kpi_id: 'bad', value: 10_000 }),
      ],
      asOf: '2026-06-30',
    });
    assert.deepEqual(rows.map((row) => row.kpi.id), ['bad', 'quiet', 'fine']);
    assert.equal(rows[1].progress.health, 'no_data', 'measured by nobody is neither a crisis nor fine');
  });
});

/**
 * The arithmetic a budget is made of.
 *
 * Tested as pure functions rather than through the interface, because every
 * bug this file is protecting against is a bug in a number rather than in a
 * screen: a split that loses a cent, a quarterly cost counted five times in a
 * year, a forecast that charges the current month twice. None of those look
 * wrong. They look like a figure that is very slightly not the one somebody
 * expected, which is the kind of thing that gets found in a board meeting.
 *
 * The end-to-end half — permissions, the feature switch, MCP — is in
 * `budget-api.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FULL_SHARE, allocate, applyScenario, byConfidence, byKind, formatMoney, healthOf, monthsBetween,
  normaliseAllocations, parseMoney, plannedTotal, projectShare, rollUp, scheduleOf, shiftDate,
  type Budget, type BudgetActual, type BudgetLine,
} from '@kolibri/shared';

/* Rows as the store holds them, with only the fields the arithmetic reads. */
const base = { created_at: 0, updated_at: 0, deleted_at: null, seq: 0, workspace_id: 'w' };

const budget = (over: Partial<Budget> = {}): Budget => ({
  ...base,
  id: 'b1',
  project_id: null,
  projects: [],
  name: 'Platform',
  description: null,
  currency: 'EUR',
  approved: 0,
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  status: 'active',
  owner_id: null,
  archived: 0,
  sort_order: 'V',
  ...over,
});

const line = (over: Partial<BudgetLine> = {}): BudgetLine => ({
  ...base,
  id: `l${Math.random()}`,
  budget_id: 'b1',
  name: 'Cost',
  category: 'infrastructure',
  kind: 'opex',
  amount: 0,
  recurrence: 'once',
  starts_on: null,
  ends_on: null,
  vendor: null,
  confidence: 'likely',
  allocations: [],
  note: null,
  sort_order: 'V',
  ...over,
});

const actual = (over: Partial<BudgetActual> = {}): BudgetActual => ({
  ...base,
  id: `a${Math.random()}`,
  budget_id: 'b1',
  line_id: null,
  description: 'Invoice',
  category: 'infrastructure',
  amount: 0,
  spent_on: '2026-01-15',
  stage: 'paid',
  vendor: null,
  reference: null,
  allocations: [],
  note: null,
  recorded_by: null,
  ...over,
});

const period = { from: '2026-01', to: '2026-12' };

describe('reading an amount', () => {
  it('reads the shapes people actually type as the same money', () => {
    // Both separator conventions, a symbol, spaces as a group separator.
    for (const input of ['1234.56', '1.234,56', '1,234.56', '1234,56', '€1 234.56', '  1234.56 ']) {
      assert.equal(parseMoney(input), 123_456, `${input} is €1234.56`);
    }
  });

  it('reads three digits after a lone separator as a thousands group', () => {
    // The one case position cannot settle, and the one people would otherwise
    // be out by a factor of a thousand on.
    assert.equal(parseMoney('1,234'), 123_400);
    assert.equal(parseMoney('1.234'), 123_400);
    // Two digits is unambiguous in either convention.
    assert.equal(parseMoney('1,23'), 123);
  });

  it('understands both ways of writing a negative', () => {
    assert.equal(parseMoney('-42.10'), -4210);
    assert.equal(parseMoney('(42.10)'), -4210);
  });

  it('says nothing rather than zero when there is no number', () => {
    // A silent zero in a budget is money that disappears without an error.
    for (const input of ['', '   ', 'about ten grand', '-', 'EUR']) {
      assert.equal(parseMoney(input), null, `${JSON.stringify(input)} is not an amount`);
    }
  });

  it('formats without inventing precision', () => {
    assert.match(formatMoney(123_456, 'EUR', 'en'), /1,234\.56/);
    // A currency this runtime may not know still comes back as something.
    assert.ok(formatMoney(100, 'XTS', 'en').length > 0);
  });
});

describe('splitting a cost between projects', () => {
  it('scales any set of shares to the whole', () => {
    const split = normaliseAllocations([
      { project_id: 'a', share: 1 },
      { project_id: 'b', share: 1 },
      { project_id: 'c', share: 1 },
    ]);
    assert.equal(split.reduce((sum, row) => sum + row.share, 0), FULL_SHARE);
  });

  it('merges two rows naming the same project', () => {
    // Two devices adding the same project offline is exactly how this happens.
    const split = normaliseAllocations([
      { project_id: 'a', share: 3000 },
      { project_id: 'a', share: 3000 },
      { project_id: 'b', share: 4000 },
    ]);
    assert.equal(split.length, 2);
    assert.equal(split.find((row) => row.project_id === 'a')?.share, 6000);
  });

  it('leaves an empty split empty', () => {
    // Unallocated is a real state, not a rounding error to be corrected.
    assert.deepEqual(normaliseAllocations([]), []);
    assert.deepEqual(normaliseAllocations(null), []);
  });

  it('never loses a cent, however awkward the split', () => {
    const three = [
      { project_id: 'a', share: 3333 },
      { project_id: 'b', share: 3333 },
      { project_id: 'c', share: 3334 },
    ];
    for (const amount of [1000, 1, 7, 99, 100_001, 4_650_50]) {
      const parts = [...allocate(amount, three).values()];
      assert.equal(parts.reduce((sum, part) => sum + part, 0), amount, `${amount} splits exactly`);
    }
  });

  it('splits a negative the same way', () => {
    // A credit note is a cost with a minus in front of it, and it has to land
    // on the same projects the invoice did.
    const parts = [...allocate(-1000, [{ project_id: 'a', share: 6000 }, { project_id: 'b', share: 4000 }]).values()];
    assert.deepEqual(parts.sort((x, y) => x - y), [-600, -400].sort((x, y) => x - y));
  });

  it('charges nobody for an unallocated cost', () => {
    assert.equal(allocate(1000, []).size, 0);
  });
});

describe('when a planned cost lands', () => {
  it('puts a one-off in the month its window opens', () => {
    const schedule = scheduleOf(line({ amount: 5000, recurrence: 'once', starts_on: '2026-03-10' }), period);
    assert.deepEqual([...schedule], [['2026-03', 5000]]);
  });

  it('repeats a monthly cost across the period', () => {
    assert.equal(plannedTotal(line({ amount: 4500, recurrence: 'monthly' }), period), 4500 * 12);
  });

  it('counts a quarter from the line rather than from the calendar', () => {
    // A contract that renews in February renews in February — not in January
    // because that is when the calendar quarter does.
    const schedule = scheduleOf(line({ amount: 900, recurrence: 'quarterly', starts_on: '2026-02-10' }), period);
    assert.deepEqual([...schedule.keys()], ['2026-02', '2026-05', '2026-08', '2026-11']);
  });

  it('drops the months that fall outside the budget', () => {
    // A line running past the end of the budget is planning next year's money.
    const schedule = scheduleOf(
      line({ amount: 100, recurrence: 'monthly', starts_on: '2026-11-01', ends_on: '2027-06-30' }),
      period,
    );
    assert.deepEqual([...schedule.keys()], ['2026-11', '2026-12']);
  });

  it('caps a period somebody typed wrong rather than hanging', () => {
    // `2206` for `2026` is one keystroke away and would otherwise be a chart
    // with two thousand columns.
    assert.ok(monthsBetween('2026-01', '2206-01').length <= 600);
  });
});

describe('adding a budget up', () => {
  it('separates money that has gone from money that is committed', () => {
    const totals = rollUp({
      budget: budget(),
      lines: [line({ amount: 1000, recurrence: 'monthly' })],
      actuals: [
        actual({ amount: 500, stage: 'paid', spent_on: '2026-01-10' }),
        actual({ amount: 300, stage: 'invoiced', spent_on: '2026-01-20' }),
        actual({ amount: 900, stage: 'committed', spent_on: '2026-02-01' }),
      ],
      asOf: '2026-03-15',
    });
    assert.equal(totals.paid, 500);
    assert.equal(totals.invoiced, 300);
    assert.equal(totals.committed, 900);
    // Spent is what has really gone; actual is what is no longer available.
    assert.equal(totals.spent, 800);
    assert.equal(totals.actual, 1700);
  });

  it('never charges the current month twice', () => {
    /*
     * The failure this rule exists for: a month whose bill has already landed
     * must not also contribute its plan. January is closed and contributed
     * what happened (1100); February onwards contribute the larger of plan and
     * actual, which is the plan (1000 × 11).
     */
    const totals = rollUp({
      budget: budget(),
      lines: [line({ amount: 1000, recurrence: 'monthly' })],
      actuals: [actual({ amount: 1100, spent_on: '2026-01-31' })],
      asOf: '2026-02-15',
    });
    assert.equal(totals.forecast, 1100 + 1000 * 11);
    // And the chart's last point is the tile's figure, by construction.
    assert.equal(totals.byMonth[totals.byMonth.length - 1].forecastToDate, totals.forecast);
  });

  it('shows an overrun in the month it happens', () => {
    // February is open and has already spent more than it planned, so the
    // forecast carries the larger of the two rather than the plan: 4000 for
    // February, 1000 for each of the ten months after it.
    const totals = rollUp({
      budget: budget(),
      lines: [line({ amount: 1000, recurrence: 'monthly' })],
      actuals: [actual({ amount: 4000, spent_on: '2026-02-20' })],
      asOf: '2026-02-15',
    });
    assert.equal(totals.forecast, 4000 + 1000 * 10);
  });

  it('treats a closed month with no spend as money that was not spent', () => {
    /*
     * The other half of the rule, and the one worth stating out loud: January
     * planned a thousand, January is over, and nothing was recorded — so the
     * forecast is eleven months rather than twelve.
     *
     * The alternative would be to carry the plan for closed months too, which
     * would make a forecast that can never fall below the plan — and an
     * underspend that no report can show is worse than one somebody has to
     * explain. It does mean a January invoice nobody has entered lowers the
     * forecast until it is: the fix for that is entering it, and `committed`
     * exists so it can be entered before it is billed.
     */
    const totals = rollUp({
      budget: budget(),
      lines: [line({ amount: 1000, recurrence: 'monthly' })],
      actuals: [],
      asOf: '2026-02-15',
    });
    assert.equal(totals.planned, 12_000);
    assert.equal(totals.forecast, 11_000);
  });

  it('keeps the remaining figure consistent with the forecast', () => {
    const totals = rollUp({
      budget: budget(),
      lines: [line({ amount: 1000, recurrence: 'monthly' })],
      actuals: [actual({ amount: 900, spent_on: '2026-01-10' })],
      asOf: '2026-06-15',
    });
    assert.equal(totals.remaining, totals.forecast - totals.actual);
    assert.ok(totals.remaining >= 0);
  });

  it('counts spend no plan line accounts for', () => {
    const planned = line({ amount: 1000, recurrence: 'once', starts_on: '2026-01-01' });
    const totals = rollUp({
      budget: budget(),
      lines: [planned],
      actuals: [
        actual({ amount: 1000, line_id: planned.id }),
        actual({ amount: 400, line_id: null, description: 'A licence nobody planned' }),
      ],
      asOf: '2026-06-15',
    });
    assert.equal(totals.unplanned, 400);
  });

  it('ignores money dated outside the period', () => {
    // An invoice from last year belongs to a different budget's story.
    const totals = rollUp({
      budget: budget(),
      lines: [],
      actuals: [actual({ amount: 5000, spent_on: '2025-11-01' })],
      asOf: '2026-06-15',
    });
    assert.equal(totals.actual, 0);
  });

  it('charges each project its share, and the shares add up', () => {
    const cluster = line({
      amount: 4500,
      recurrence: 'monthly',
      allocations: [{ project_id: 'web', share: 6000 }, { project_id: 'ops', share: 4000 }],
    });
    const totals = rollUp({
      budget: budget(),
      lines: [cluster],
      actuals: [actual({ amount: 4650_50, line_id: cluster.id })],
      asOf: '2026-06-15',
    });
    const web = totals.byProject.find((row) => row.project_id === 'web')!;
    const ops = totals.byProject.find((row) => row.project_id === 'ops')!;
    assert.equal(web.planned + ops.planned, totals.planned);
    assert.equal(web.actual + ops.actual, totals.actual);
    assert.equal(web.planned, 4500 * 12 * 0.6);
  });

  it('lets an invoice follow the line it pays for', () => {
    // An empty split on an actual *means* "follow the line", so the invoice
    // moves when the line's percentages do rather than freezing today's.
    const cluster = line({ amount: 100, allocations: [{ project_id: 'web', share: FULL_SHARE }] });
    const totals = rollUp({
      budget: budget(),
      lines: [cluster],
      actuals: [actual({ amount: 700, line_id: cluster.id, allocations: [] })],
      asOf: '2026-06-15',
    });
    assert.equal(totals.byProject.find((row) => row.project_id === 'web')?.actual, 700);
    assert.equal(totals.unallocatedActual, 0);
  });

  it('keeps unallocated money visible rather than charging it to somebody', () => {
    const totals = rollUp({
      budget: budget(),
      lines: [line({ amount: 1000 })],
      actuals: [actual({ amount: 600 })],
      asOf: '2026-06-15',
    });
    assert.equal(totals.unallocatedPlanned, 1000);
    assert.equal(totals.unallocatedActual, 600);
    assert.equal(totals.byProject.find((row) => row.project_id === '')?.planned, 1000);
  });

  it('measures variance against the approved total, and against the forecast', () => {
    // Both halves matter. The envelope is what was approved; what it is
    // compared to is the forecast rather than the plan, because "we approved
    // 20k and plan to spend 12k" is not the question — "and we now expect to
    // spend 7k" is.
    const totals = rollUp({
      budget: budget({ approved: 20_000 }),
      lines: [line({ amount: 1000, recurrence: 'monthly' })],
      actuals: [],
      asOf: '2026-06-15',
    });
    assert.equal(totals.forecast, 7000); // June to December, the open months
    assert.equal(totals.variance, 20_000 - 7000);
    assert.equal(healthOf(totals), 'healthy');
  });

  it('falls back to the plan when nothing has been approved', () => {
    // No approved total, so the plan is the envelope — and a plan whose money
    // was all in a month that closed unspent is a plan entirely under.
    const totals = rollUp({ budget: budget(), lines: [line({ amount: 5000 })], actuals: [], asOf: '2026-06-15' });
    assert.equal(totals.planned, 5000);
    assert.equal(totals.forecast, 0);
    assert.equal(totals.variance, 5000);
    assert.equal(healthOf(totals), 'healthy');
  });

  it('calls a budget over when the forecast passes the envelope', () => {
    const totals = rollUp({
      budget: budget({ approved: 1000 }),
      lines: [line({ amount: 900 })],
      actuals: [actual({ amount: 4000, spent_on: '2026-06-01' })],
      asOf: '2026-06-15',
    });
    assert.equal(healthOf(totals), 'over');
    assert.ok(totals.variance < 0);
  });

  it('says nothing about a budget with no envelope at all', () => {
    assert.equal(healthOf({ approved: 0, planned: 0, forecast: 0 }), 'unset');
  });
});

describe('scenarios', () => {
  const plan = [
    line({ id: 'infra', amount: 1000, category: 'infrastructure', confidence: 'committed' }),
    line({ id: 'travel', amount: 600, category: 'travel', confidence: 'possible' }),
    line({ id: 'build', amount: 8000, category: 'investment', kind: 'capex', confidence: 'likely', starts_on: '2026-03-01' }),
  ];

  it('never touches the plan it is applied to', () => {
    const before = plan.map((row) => row.amount);
    applyScenario(plan, { adjustments: [{ factor: 5000 }], weights: null });
    assert.deepEqual(plan.map((row) => row.amount), before);
  });

  it('cuts a whole category with one adjustment', () => {
    const cut = applyScenario(plan, { adjustments: [{ category: 'travel', factor: 6600 }], weights: null });
    assert.equal(cut.find((row) => row.id === 'travel')?.amount, 396);
    assert.equal(cut.find((row) => row.id === 'infra')?.amount, 1000);
  });

  it('applies a factor and then a delta, in the order they are written', () => {
    // The two do not commute, and a scenario has to mean what it reads like.
    const [first] = applyScenario([line({ amount: 1000 })], {
      adjustments: [{ factor: 5000 }, { delta: 100 }], weights: null,
    });
    assert.equal(first.amount, 600);
    const [second] = applyScenario([line({ amount: 1000 })], {
      adjustments: [{ delta: 100 }, { factor: 5000 }], weights: null,
    });
    assert.equal(second.amount, 550);
  });

  it('slips a line by whole months', () => {
    const [slipped] = applyScenario([plan[2]], { adjustments: [{ line_id: 'build', shift_months: 3 }], weights: null });
    assert.equal(slipped.starts_on, '2026-06-01');
  });

  it('drops a line out of the total entirely', () => {
    const kept = applyScenario(plan, { adjustments: [{ line_id: 'travel', drop: true }], weights: null });
    assert.equal(kept.length, 2);
    assert.ok(!kept.some((row) => row.id === 'travel'));
  });

  it('carries unsigned money at whatever weight it was given', () => {
    const careful = applyScenario(plan, {
      adjustments: [],
      weights: { committed: FULL_SHARE, likely: 5000, possible: 0 },
    });
    assert.equal(careful.find((row) => row.id === 'infra')?.amount, 1000);
    assert.equal(careful.find((row) => row.id === 'build')?.amount, 4000);
    assert.equal(careful.find((row) => row.id === 'travel')?.amount, 0);
  });

  it('changes the total a budget rolls up to', () => {
    const withScenario = rollUp({
      budget: budget(),
      lines: plan,
      actuals: [],
      scenario: { adjustments: [{ line_id: 'build', drop: true }], weights: null },
      asOf: '2026-06-15',
    });
    const plain = rollUp({ budget: budget(), lines: plan, actuals: [], asOf: '2026-06-15' });
    assert.equal(plain.planned - withScenario.planned, 8000);
  });
});

describe('a month at the edge of one', () => {
  it('lands a shifted end-of-month date on the last day, not the first of the next', () => {
    assert.equal(shiftDate('2026-01-31', 1), '2026-02-28');
    assert.equal(shiftDate('2026-03-31', -1), '2026-02-28');
    assert.equal(shiftDate('2026-12-15', 3), '2027-03-15');
  });
});

describe('the breakdowns a report opens with', () => {
  it('splits a plan by how sure it is', () => {
    const totals = byConfidence([
      line({ amount: 100, confidence: 'committed' }),
      line({ amount: 200, confidence: 'likely' }),
      line({ amount: 300, confidence: 'possible' }),
    ], period);
    assert.deepEqual(totals, { committed: 100, likely: 200, possible: 300 });
  });

  it('splits a plan into running and building', () => {
    const totals = byKind([line({ amount: 100, kind: 'opex' }), line({ amount: 900, kind: 'capex' })], period);
    assert.deepEqual(totals, { opex: 100, capex: 900 });
  });
});

describe('what one project costs', () => {
  it('adds up its share across budgets, keeping currencies apart', () => {
    const euro = budget({ id: 'b1', currency: 'EUR' });
    const sterling = budget({ id: 'b2', currency: 'GBP' });
    const totals = projectShare({
      projectId: 'web',
      budgets: [euro, sterling],
      lines: [
        line({ budget_id: 'b1', amount: 1000, allocations: [{ project_id: 'web', share: FULL_SHARE }] }),
        line({ budget_id: 'b2', amount: 500, allocations: [{ project_id: 'web', share: FULL_SHARE }] }),
      ],
      actuals: [],
      asOf: '2026-06-15',
    });
    // Two currencies are two answers. Adding them would need a rate, and a
    // rate is a fact about a day rather than about a budget.
    assert.equal(totals.length, 2);
    assert.equal(totals.find((row) => row.currency === 'EUR')?.planned, 1000);
    assert.equal(totals.find((row) => row.currency === 'GBP')?.planned, 500);
  });

  it('leaves out a budget that covers the project but charges it nothing', () => {
    const totals = projectShare({
      projectId: 'web',
      budgets: [budget()],
      lines: [line({ amount: 1000, allocations: [{ project_id: 'ops', share: FULL_SHARE }] })],
      actuals: [],
      asOf: '2026-06-15',
    });
    assert.deepEqual(totals, []);
  });
});

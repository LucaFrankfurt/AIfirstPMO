/**
 * What was planned, what has gone, and which projects pay for it.
 */
import { actualFromPlan, BUDGET_STATUS, type BudgetActual, type BudgetLine, COST_CATEGORIES, COST_CONFIDENCE, COST_KINDS, COST_RECURRENCES, coversProject, formatMoney, healthOf, orderKey, plannedForMonth, type PlannedForMonth, plannedTotal, projectShare, SPEND_STAGES, type SpendStage } from '@kolibri/shared';
import { all, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { allocationsFromArgs, budgetChildren, findBudget, findProject, isoDay, lastLineOrder, McpError, money, projectNames, requireFeature, requireMoney, requireWrite, resolveScope, rollUpBudget, scopeOf, str, type ToolDef, visibleBudgets, workspaceOf, writeOpts } from '../kit.ts';

export const budgetTools: ToolDef[] = [
  {
    name: 'list_budgets',
    title: 'List budgets',
    description:
      'Budgets in the workspace with their headline figures: what was approved, what is planned, '
      + 'what has actually gone, the forecast, and whether it is on track. Optionally narrowed to '
      + 'the budgets covering one project.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key or name; budgets covering it' },
        status: { type: 'string', enum: [...BUDGET_STATUS] },
        include_archived: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'budget');
      const projectId = args.project ? String(findProject(String(args.project), workspaceId, ctx).id) : null;
      const budgets = visibleBudgets(workspaceId, ctx)
        .filter((row) => (args.include_archived ? true : !Number(row.archived)))
        .filter((row) => (args.status ? row.status === args.status : true))
        .filter((row) => (projectId ? coversProject(scopeOf(row), projectId) : true));

      return {
        budgets: budgets.map((row) => {
          const rolled = rollUpBudget(row);
          return {
            id: row.id,
            name: row.name,
            currency: rolled.currency,
            status: row.status,
            period: `${row.period_start ?? '…'} → ${row.period_end ?? '…'}`,
            ...money(rolled.currency, {
              approved: rolled.approved,
              planned: rolled.planned,
              actual: rolled.actual,
              forecast: rolled.forecast,
              variance: rolled.variance,
            }),
            health: healthOf(rolled),
            url: `${env.publicUrl}/budgets/${row.id}`,
          };
        }),
        total: budgets.length,
      };
    },
  },
  {
    name: 'budget_status',
    title: 'Budget status',
    description:
      'One budget in full: plan against actual, the forecast and the variance, broken down by '
      + 'category, by project and by month. Optionally under a saved scenario, and optionally as '
      + 'it stood on an earlier date.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['budget'],
      properties: {
        budget: { type: 'string', description: 'Budget id or name' },
        scenario: { type: 'string', description: 'Scenario name or id to apply instead of the plan' },
        as_of: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'budget');
      const budget = findBudget(String(args.budget), workspaceId, ctx);
      const asOf = isoDay(args.as_of, 'as_of') ?? undefined;

      let scenario: Row | null = null;
      if (args.scenario) {
        const wanted = String(args.scenario).toLowerCase();
        scenario = all<Row>(
          `SELECT * FROM budget_scenarios WHERE budget_id = ? AND deleted_at IS NULL`, budget.id,
        ).find((row) => row.id === args.scenario || String(row.name).toLowerCase() === wanted) ?? null;
        if (!scenario) throw new McpError(`No scenario called "${args.scenario}" on that budget`);
      }

      const rolled = rollUpBudget(budget, { scenario, asOf });
      const names = projectNames(workspaceId);
      const fmt = (value: number) => formatMoney(value, rolled.currency, 'en');

      return {
        budget: { id: budget.id, name: budget.name, currency: rolled.currency, status: budget.status },
        scenario: scenario ? { id: scenario.id, name: scenario.name } : null,
        period: rolled.period,
        as_of: asOf ?? new Date().toISOString().slice(0, 10),
        ...money(rolled.currency, {
          approved: rolled.approved,
          planned: rolled.planned,
          committed: rolled.committed,
          invoiced: rolled.invoiced,
          paid: rolled.paid,
          actual: rolled.actual,
          remaining: rolled.remaining,
          forecast: rolled.forecast,
          variance: rolled.variance,
          unplanned: rolled.unplanned,
        }),
        health: healthOf(rolled),
        /* Two ratios rather than one: a budget 80% spent is fine in November
           and alarming in February, and the pair is the whole of that
           sentence. */
        used_share: rolled.used === null ? null : Math.round(rolled.used * 100) / 100,
        elapsed_share: Math.round(rolled.elapsed * 100) / 100,
        run_rate_forecast: rolled.runRate === null ? null : fmt(rolled.runRate),
        by_category: rolled.byCategory.map((row) => ({
          category: row.key, planned: fmt(row.planned), actual: fmt(row.actual),
          variance: fmt(row.planned - row.actual),
        })),
        by_project: rolled.byProject.map((row) => ({
          project: row.project_id ? names[row.project_id] ?? row.project_id : 'unallocated',
          planned: fmt(row.planned), actual: fmt(row.actual),
        })),
        by_month: rolled.byMonth.map((row) => ({
          month: row.month, planned: fmt(row.planned), actual: fmt(row.actual),
        })),
      };
    },
  },
  {
    name: 'create_budget',
    title: 'Create a budget',
    description:
      'Open an envelope of money over a period. Scoped like a cycle: give `project` for one '
      + 'project\'s own budget, `projects` for several, or neither for a workspace-wide one.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        currency: { type: 'string', description: 'ISO 4217, e.g. EUR. Defaults to EUR' },
        approved: { type: 'string', description: 'The signed-off total, e.g. "250000"' },
        period_start: { type: 'string', description: 'YYYY-MM-DD' },
        period_end: { type: 'string', description: 'YYYY-MM-DD' },
        status: { type: 'string', enum: [...BUDGET_STATUS] },
        project: { type: 'string', description: 'Project key or name — one project\'s own budget' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Several projects' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'budget');
      const scope = resolveScope(args, workspaceId, ctx);
      const currency = String(args.currency ?? 'EUR').trim().toUpperCase();

      const { row } = writeEntity('budget', uid(), {
        workspace_id: workspaceId,
        ...scope,
        name: String(args.name).trim(),
        description: str(args.description) ?? null,
        currency,
        approved: args.approved === undefined ? 0 : requireMoney(args.approved, 'approved'),
        period_start: isoDay(args.period_start, 'period_start'),
        period_end: isoDay(args.period_end, 'period_end'),
        status: (BUDGET_STATUS as readonly string[]).includes(String(args.status)) ? args.status : 'draft',
        archived: 0,
      }, writeOpts(workspaceId, ctx));

      return { id: row.id, name: row.name, currency: row.currency, url: `${env.publicUrl}/budgets/${row.id}` };
    },
  },
  {
    name: 'add_budget_line',
    title: 'Plan a cost',
    description:
      'Add a planned cost to a budget. `amount` is per occurrence, so twelve months of hosting is '
      + 'one line with `recurrence: "monthly"` rather than twelve rows. `allocations` splits the '
      + 'cost between projects in percent; leave it out and the cost is unallocated.',
    schema: {
      type: 'object',
      required: ['budget', 'name', 'amount'],
      properties: {
        budget: { type: 'string', description: 'Budget id or name' },
        name: { type: 'string' },
        amount: { type: 'string', description: 'Per occurrence, e.g. "4500" or "4.500,00"' },
        category: { type: 'string', enum: [...COST_CATEGORIES] },
        kind: { type: 'string', enum: [...COST_KINDS], description: 'opex to run, capex to build' },
        recurrence: { type: 'string', enum: [...COST_RECURRENCES] },
        starts_on: { type: 'string', description: 'YYYY-MM-DD; defaults to the budget period' },
        ends_on: { type: 'string', description: 'YYYY-MM-DD' },
        vendor: { type: 'string' },
        confidence: { type: 'string', enum: [...COST_CONFIDENCE] },
        allocations: {
          type: 'object',
          description: 'Project key or name → percent, e.g. {"WEB": 60, "OPS": 40}. Rescaled to 100.',
          additionalProperties: { type: 'number' },
        },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'budget');
      const budget = findBudget(String(args.budget), workspaceId, ctx);

      const { row } = writeEntity('budgetLine', uid(), {
        workspace_id: workspaceId,
        budget_id: budget.id,
        name: String(args.name).trim(),
        amount: requireMoney(args.amount, 'amount'),
        category: args.category ?? 'other',
        kind: args.kind ?? 'opex',
        recurrence: args.recurrence ?? 'once',
        starts_on: isoDay(args.starts_on, 'starts_on'),
        ends_on: isoDay(args.ends_on, 'ends_on'),
        vendor: str(args.vendor) ?? null,
        confidence: args.confidence ?? 'likely',
        allocations: allocationsFromArgs(args.allocations, workspaceId, ctx),
        note: str(args.note) ?? null,
        sort_order: orderKey(lastLineOrder(budget.id), null),
      }, writeOpts(workspaceId, ctx));

      const rolled = rollUpBudget(budget);
      return {
        id: row.id,
        name: row.name,
        // What the line is worth over the whole period, which is the number the
        // caller meant and not the one they typed for a recurring cost.
        planned_total: formatMoney(
          plannedTotal(serialize('budgetLine', row) as any, rolled.period), rolled.currency, 'en',
        ),
        budget: budget.name,
      };
    },
  },
  {
    name: 'record_spend',
    title: 'Record money spent',
    description:
      'Record money that has actually gone, or is committed and will. `stage` matters: '
      + '"committed" is a purchase order nobody has invoiced yet, and leaving it out of a report '
      + 'is how a budget looks healthy until the invoices land. Attach it to a plan line with '
      + '`line`, or leave that out — unplanned spend is a real thing and the reports count it.',
    schema: {
      type: 'object',
      required: ['budget', 'description', 'amount'],
      properties: {
        budget: { type: 'string', description: 'Budget id or name' },
        description: { type: 'string' },
        amount: { type: 'string', description: 'e.g. "1250.40"' },
        line: { type: 'string', description: 'Plan line id or name this pays for' },
        category: { type: 'string', enum: [...COST_CATEGORIES] },
        spent_on: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        stage: { type: 'string', enum: [...SPEND_STAGES], description: 'Defaults to paid' },
        vendor: { type: 'string' },
        reference: { type: 'string', description: 'Invoice or purchase-order number' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'budget');
      const budget = findBudget(String(args.budget), workspaceId, ctx);

      let line: Row | null = null;
      if (args.line) {
        const wanted = String(args.line).toLowerCase();
        line = all<Row>(`SELECT * FROM budget_lines WHERE budget_id = ? AND deleted_at IS NULL`, budget.id)
          .find((row) => row.id === args.line || String(row.name).toLowerCase() === wanted) ?? null;
        if (!line) throw new McpError(`No plan line called "${args.line}" on that budget`);
      }

      const { row } = writeEntity('budgetActual', uid(), {
        workspace_id: workspaceId,
        budget_id: budget.id,
        line_id: line?.id ?? null,
        description: String(args.description).trim(),
        amount: requireMoney(args.amount, 'amount'),
        // The line's category unless told otherwise: an invoice against the
        // hosting line is a hosting cost, and asking again invites a mismatch
        // that shows up only as two categories that should have been one.
        category: args.category ?? line?.category ?? 'other',
        spent_on: isoDay(args.spent_on, 'spent_on') ?? new Date().toISOString().slice(0, 10),
        stage: args.stage ?? 'paid',
        vendor: str(args.vendor) ?? line?.vendor ?? null,
        reference: str(args.reference) ?? null,
        allocations: '[]',
        note: str(args.note) ?? null,
      }, writeOpts(workspaceId, ctx));

      const rolled = rollUpBudget(budget);
      return {
        id: row.id,
        amount: formatMoney(Number(row.amount), rolled.currency, 'en'),
        stage: row.stage,
        spent_on: row.spent_on,
        line: line?.name ?? null,
        budget: budget.name,
        ...money(rolled.currency, { actual_now: rolled.actual, forecast_now: rolled.forecast, variance_now: rolled.variance }),
        health: healthOf(rolled),
      };
    },
  },
  {
    name: 'confirm_planned',
    title: 'Take a month\'s plan across',
    description:
      'Record the planned costs for one month as actuals, at the amounts the plan says. This is '
      + 'closing a month: the recurring half of a budget is almost all of it, and typing twelve '
      + 'identical hosting bills a year is why the actuals stop being filled in. A line that '
      + 'already has anything recorded against it that month is left alone and reported as '
      + 'skipped — under-recording is visible in the figures, a silent double-book is not. '
      + 'Call with `dry_run` first to see what would be written.',
    schema: {
      type: 'object',
      required: ['budget', 'month'],
      properties: {
        budget: { type: 'string', description: 'Budget id or name' },
        month: { type: 'string', description: 'YYYY-MM' },
        stage: { type: 'string', enum: [...SPEND_STAGES], description: 'Defaults to paid' },
        line: { type: 'string', description: 'Only this plan line, by id or name' },
        dry_run: { type: 'boolean', description: 'Report what would be written, and write nothing' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'budget');
      const budget = findBudget(String(args.budget), workspaceId, ctx);
      const month = String(args.month ?? '');
      if (!/^\d{4}-\d{2}$/.test(month)) throw new McpError('month must be YYYY-MM');

      const rolled = rollUpBudget(budget);
      const lines = budgetChildren('budget_lines', [budget])
        .map((row) => serialize('budgetLine', row) as unknown as BudgetLine);
      const actuals = budgetChildren('budget_actuals', [budget])
        .map((row) => serialize('budgetActual', row) as unknown as BudgetActual);

      let planned = plannedForMonth({ lines, actuals, month, period: rolled.period });
      if (args.line) {
        const wanted = String(args.line).toLowerCase();
        planned = planned.filter((row) => row.line.id === args.line || row.line.name.toLowerCase() === wanted);
        if (!planned.length) throw new McpError(`No plan line called "${args.line}" is due in ${month}`);
      }

      const stage = (SPEND_STAGES as readonly string[]).includes(String(args.stage))
        ? String(args.stage) as SpendStage
        : 'paid';
      const open = planned.filter((row) => !row.confirmed);
      const money = (amount: number) => formatMoney(amount, rolled.currency, 'en');
      /* The same shape the web writes, so a ledger filled in by both hands
         reads as one ledger. English, for the same reason the money above is
         English: there is no person here whose language to use. */
      const monthText = new Date(`${month}-01T00:00:00Z`)
        .toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const describe = (row: PlannedForMonth) => `${row.line.name} · ${monthText}`;

      const wrote = args.dry_run ? [] : open.map((row) => {
        const { row: stored } = writeEntity('budgetActual', uid(), {
          workspace_id: workspaceId,
          ...actualFromPlan(row, { budgetId: String(budget.id), stage, describe }),
          allocations: '[]',
        }, writeOpts(workspaceId, ctx));
        return { id: stored.id, line: row.line.name, amount_text: money(row.amount), spent_on: stored.spent_on };
      });

      return {
        budget: budget.name,
        month,
        stage,
        dry_run: !!args.dry_run,
        /* What would be, or was, written — and separately what was left alone.
           A caller reporting "the month is closed" needs both halves: the
           skipped list is not an error, it is the part somebody had already
           done by hand. */
        recorded: args.dry_run
          ? open.map((row) => ({ line: row.line.name, amount_text: money(row.amount), spent_on: row.on }))
          : wrote,
        total_text: money(open.reduce((sum, row) => sum + row.amount, 0)),
        skipped: planned.filter((row) => row.confirmed).map((row) => ({
          line: row.line.name,
          planned_text: money(row.amount),
          already_recorded_text: money(row.recorded),
        })),
      };
    },
  },
  {
    name: 'project_costs',
    title: 'What a project costs',
    description:
      'One project\'s share of every budget that charges it, planned against actual. This is the '
      + 'other direction from `budget_status`: a project lead does not care what the central '
      + 'infrastructure budget totals, they care what lands on them. Budgets in different '
      + 'currencies are reported separately rather than added.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', description: 'Project key or name' },
        as_of: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'budget');
      const project = findProject(String(args.project), workspaceId, ctx);
      const asOf = isoDay(args.as_of, 'as_of') ?? undefined;
      const budgets = visibleBudgets(workspaceId, ctx).filter((row) => !Number(row.archived));

      const charged: Record<string, unknown>[] = [];
      for (const budget of budgets) {
        const rolled = rollUpBudget(budget, { asOf });
        const share = rolled.byProject.find((row) => row.project_id === project.id);
        if (!share || (!share.planned && !share.actual)) continue;
        charged.push({
          budget: budget.name,
          budget_id: budget.id,
          currency: rolled.currency,
          planned: formatMoney(share.planned, rolled.currency, 'en'),
          actual: formatMoney(share.actual, rolled.currency, 'en'),
          variance: formatMoney(share.planned - share.actual, rolled.currency, 'en'),
        });
      }

      const totals = projectShare({
        projectId: project.id,
        budgets: budgets.map((row) => serialize('budget', row) as any),
        lines: budgetChildren('budget_lines', budgets).map((row) => serialize('budgetLine', row) as any),
        actuals: budgetChildren('budget_actuals', budgets).map((row) => serialize('budgetActual', row) as any),
        asOf,
      });

      return {
        project: { id: project.id, key: project.key, name: project.name },
        totals: totals.map((row) => ({
          currency: row.currency,
          budgets: row.budgets,
          planned: formatMoney(row.planned, row.currency, 'en'),
          actual: formatMoney(row.actual, row.currency, 'en'),
          variance: formatMoney(row.planned - row.actual, row.currency, 'en'),
        })),
        budgets: charged,
      };
    },
  },

  /* ----------------------------------------------------------- landscape --
   *
   * The estate: what runs where, what it costs, and what the plan is for
   * changing it. `landscape` is the one worth knowing about — it takes two
   * dates and answers what goes, what arrives, and what the difference costs,
   * which is the question an architecture review and a finance review ask in
   * that order.
   */
];

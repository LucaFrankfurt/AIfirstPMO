/**
 * The money screens' shared parts: what a figure looks like, how a split is
 * edited, and the two charts a budget needs that a task board does not.
 *
 * Every number here comes out of `rollUp` in `@kolibri/shared`, computed from
 * the local mirror on every render. No endpoint, no aggregation table, and no
 * arithmetic of its own — the server answers `budget_status` over MCP from the
 * same function, so a figure on this screen and a figure an assistant quotes
 * cannot disagree.
 *
 * The charts are hand-drawn SVG for the reason the insights charts are: a
 * chart you can read is worth more than one you have to trust.
 */
import { useMemo, useState } from 'react';
import {
  COST_CATEGORIES, FULL_SHARE, healthOf, normaliseAllocations,
  projectShare, rollUp,
  type Allocation, type Budget, type BudgetHealth, type BudgetRollUp,
  type BudgetScenario, type CostCategory, type Minor,
} from '@kolibri/shared';
import { useT, type TranslationKey } from '../lib/i18n';
import { list, useQuery } from '../lib/store';
import { Icon } from './ui';
import { Chip } from './ui/chip';
import { Button } from './ui/button';
import { Input } from './ui/field';
import { Table } from './ui/table';
import { asMoney } from './ui/money';

/* ------------------------------------------------------------------ money */

/**
 * A signed figure, with the sign spelled out.
 *
 * A variance is the one number on these screens where the sign carries the
 * whole meaning, and `-€12,000` in a column of positives is easy to skim past.
 * The word in front of it is not decoration: colour alone cannot say "under"
 * to somebody who cannot see the colour.
 */
export function Variance({ value, currency }: { value: Minor; currency: string }) {
  const t = useT();
  if (!value) return <span className="money-flat">{asMoney(0, currency)}</span>;
  const over = value < 0;
  return (
    <span className={over ? 'money-over' : 'money-under'}>
      {asMoney(Math.abs(value), currency)} {over ? t('budget.over') : t('budget.under')}
    </span>
  );
}

export const categoryKey = (category: string): TranslationKey => `budget.category.${category}` as TranslationKey;
export const stageKey = (stage: string): TranslationKey => `budget.stage.${stage}` as TranslationKey;
export const confidenceKey = (level: string): TranslationKey => `budget.confidence.${level}` as TranslationKey;
export const recurrenceKey = (every: string): TranslationKey => `budget.recurrence.${every}` as TranslationKey;
export const healthKey = (health: string): TranslationKey => `budget.health.${health}` as TranslationKey;

/**
 * A class rather than a Chip `tone`: the chip's variants are `default` and
 * `on`, which are about selection, and adding three semantic colours to a
 * primitive forty screens import would be a wide change for one chip.
 *
 * Written out rather than interpolated, so `check:css` can see the names —
 * a `health-${x}` template is a class the stylesheet check cannot verify and
 * a build tool cannot find. `unset` deliberately maps to nothing: a budget
 * nobody has approved a number for is not a state to colour.
 */
const HEALTH_CLASS: Record<BudgetHealth, string> = {
  unset: '',
  healthy: 'health-healthy',
  tight: 'health-tight',
  over: 'health-over',
};

/** How a budget is doing, as one word somebody can scan a column of. */
export function Health({ totals }: { totals: BudgetRollUp }) {
  const t = useT();
  const health = healthOf(totals);
  return <Chip className={HEALTH_CLASS[health]}>{t(healthKey(health))}</Chip>;
}

/* ------------------------------------------------------------ allocations */

/**
 * Who pays for this, and how much of it.
 *
 * Percentages on screen, basis points in the row: nobody types 6000 meaning
 * 60%, and nobody wants to discover that a third of a cost cannot be expressed.
 * The line under it is the part that matters — a split that does not add up to
 * the whole is the quiet failure this feature is most likely to produce, so it
 * is stated rather than corrected in silence.
 */
export function AllocationEditor({ value, projects, onChange }: {
  value: Allocation[];
  projects: { id: string; name: string }[];
  onChange: (next: Allocation[]) => void;
}) {
  const t = useT();
  const rows = value ?? [];
  const total = rows.reduce((sum, row) => sum + row.share, 0);
  const free = projects.filter((project) => !rows.some((row) => row.project_id === project.id));

  const set = (index: number, patch: Partial<Allocation>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <div className="alloc">
      {rows.map((row, index) => (
        <div className="alloc-row" key={`${row.project_id}-${index}`}>
          <select
            className="alloc-project"
            value={row.project_id}
            aria-label={t('budget.allocProject')}
            onChange={(event) => set(index, { project_id: event.target.value })}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <Input
            className="alloc-share"
            type="number"
            min={0}
            max={100}
            step={1}
            aria-label={t('budget.allocShare')}
            value={Math.round(row.share / 100)}
            onChange={(event) => set(index, { share: Math.max(0, Number(event.target.value) || 0) * 100 })}
          />
          <span className="alloc-unit">%</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('action.remove')}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
      ))}
      {free.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...rows, { project_id: free[0].id, share: Math.max(FULL_SHARE - total, 0) }])}
        >
          <Icon name="plus" size={13} /> {t('budget.allocAdd')}
        </Button>
      )}
      <p className={`alloc-total${total !== FULL_SHARE && rows.length ? ' off' : ''}`}>
        {rows.length === 0
          ? t('budget.allocNone')
          : total === FULL_SHARE
            ? t('budget.allocExact')
            : t('budget.allocOff', { percent: (total / 100).toFixed(0) })}
      </p>
    </div>
  );
}

/** The split as chips, for a row in a table. */
export function AllocationChips({ allocations, names }: {
  allocations: Allocation[];
  names: Map<string, string>;
}) {
  const t = useT();
  const rows = normaliseAllocations(allocations);
  if (!rows.length) return <span className="text-muted">{t('budget.unallocated')}</span>;
  return (
    <span className="alloc-chips">
      {rows.map((row) => (
        <Chip key={row.project_id}>
          {names.get(row.project_id) ?? t('budget.unknownProject')} {Math.round(row.share / 100)}%
        </Chip>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ charts */

export interface MoneySeries {
  name: string;
  color: string;
  /**
   * May be shorter than `labels`, and the actual line always is.
   *
   * A cumulative total drawn to the right-hand edge is flat from today
   * onwards, and a flat line across four empty months reads as a claim that
   * nothing more will be spent. It is not a claim, it is the absence of one —
   * so the line stops where the record does. The insights burn-up chart made
   * the same decision for the same reason.
   */
  points: Minor[];
  /** Drawn dashed. The forecast is a claim about the future, not a record. */
  dashed?: boolean;
}

/**
 * Cumulative money over the months of a budget: the burn chart.
 *
 * Three lines rather than two, and the third is the point. Plan and actual
 * alone answer "are we behind"; the forecast line answers "and where does that
 * end up", which is the question somebody is actually in the meeting to
 * settle. It is dashed from end to end rather than only past today, because a
 * forecast is an estimate for the whole of its length — the part that runs
 * under the actual line is an estimate that happens to have come true.
 */
export function BurnChart({ series, labels, currency, caption }: {
  series: MoneySeries[];
  labels: string[];
  currency: string;
  caption: string;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.flatMap((line) => line.points));
  const count = labels.length;
  const x = (index: number) => (count > 1 ? (index / (count - 1)) * 100 : 50);
  const y = (value: number) => 100 - (value / max) * 100;

  return (
    <figure className="chart">
      <div className="chart-legend">
        {series.map((line) => (
          <span key={line.name}>
            <i style={{ background: line.color }} aria-hidden /> {line.name}
          </span>
        ))}
      </div>
      <div className="chart-scale"><span>{asMoney(max, currency, true)}</span><span>{asMoney(0, currency, true)}</span></div>
      <div
        className="chart-plot lines"
        style={{ height: 190 }}
        role="img"
        aria-label={caption}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          setHover(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
        }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="lines-svg">
          {[0, 50, 100].map((line) => (
            <line key={line} x1="0" x2="100" y1={line} y2={line} className="grid-line" vectorEffect="non-scaling-stroke" />
          ))}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1="0" y2="100" className="crosshair" vectorEffect="non-scaling-stroke" />
          )}
          {series.map((line) => (
            <polyline
              key={line.name}
              points={line.points.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              /* Dashes in user units would stretch with the viewBox and come
                 out as smears; `non-scaling-stroke` keeps both the width and
                 the dash pattern in screen pixels. */
              strokeDasharray={line.dashed ? '4 3' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {hover !== null && (
          <span className="chart-tip pinned" role="status" style={{ left: `${x(hover)}%` }}>
            {labels[hover]}
            {/* A series that has ended is left out of the tooltip rather than
                shown as zero — "actual €0" in November would be a figure, and
                there is no figure. */}
            {series.filter((line) => line.points[hover] !== undefined)
              .map((line) => ` · ${line.name} ${asMoney(line.points[hover], currency, true)}`)}
          </span>
        )}
      </div>
      <div className="chart-axis">
        <span className="flex-1">{labels[0]}</span>
        <span style={{ flex: 1, textAlign: 'end' }}>{labels[labels.length - 1]}</span>
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('budget.month'), ...series.map((line) => line.name)]}
        rows={labels.map((label, index) => [
          label,
          ...series.map((line) => (line.points[index] === undefined ? '—' : asMoney(line.points[index], currency))),
        ])}
      />
    </figure>
  );
}

/**
 * Two bars a month: what was planned, and what went.
 *
 * Side by side rather than stacked or overlaid. Stacking would add two things
 * that are alternatives rather than parts, and an overlay makes the smaller of
 * the two unreadable in exactly the months somebody is looking at.
 */
export function PlanVsActual({ rows, currency, caption }: {
  rows: { month: string; label: string; planned: Minor; actual: Minor }[];
  currency: string;
  caption: string;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.flatMap((row) => [row.planned, row.actual]));
  const width = 100 / Math.max(rows.length, 1);

  return (
    <figure className="chart">
      <div className="chart-legend">
        <span><i style={{ background: 'var(--chart-1)' }} aria-hidden /> {t('budget.planned')}</span>
        <span><i style={{ background: 'var(--chart-2)' }} aria-hidden /> {t('budget.actual')}</span>
      </div>
      <div className="chart-scale"><span>{asMoney(max, currency, true)}</span><span>{asMoney(0, currency, true)}</span></div>
      <div className="chart-plot" style={{ height: 160 }} role="img" aria-label={caption}>
        {rows.map((row, index) => (
          <div
            key={row.month}
            className="col-slot"
            style={{ width: `${width}%` }}
            tabIndex={0}
            role="figure"
            aria-label={`${row.label}: ${t('budget.planned')} ${asMoney(row.planned, currency)}, ${t('budget.actual')} ${asMoney(row.actual, currency)}`}
            onPointerEnter={() => setHover(index)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(index)}
            onBlur={() => setHover(null)}
          >
            <span className="col-pair">
              {/* A zero draws nothing: a stub for "no money moved" is ink that
                  says some did. */}
              {row.planned > 0 && (
                <span className="col-bar" style={{ height: `${(row.planned / max) * 100}%`, background: 'var(--chart-1)' }} />
              )}
              {row.actual > 0 && (
                <span className="col-bar" style={{ height: `${(row.actual / max) * 100}%`, background: 'var(--chart-2)' }} />
              )}
            </span>
            {hover === index && (
              <span className="chart-tip" role="status">
                {row.label} · {asMoney(row.planned, currency, true)} / {asMoney(row.actual, currency, true)}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="chart-axis">
        {rows.map((row, index) => (
          <span key={row.month} style={{ width: `${width}%` }}>{index % 3 === 0 ? row.label : ''}</span>
        ))}
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('budget.month'), t('budget.planned'), t('budget.actual')]}
        rows={rows.map((row) => [row.label, asMoney(row.planned, currency), asMoney(row.actual, currency)])}
      />
    </figure>
  );
}

/**
 * A breakdown where each row has two figures — plan and actual — and the
 * comparison between them is the point.
 *
 * One track per row with the actual drawn over the plan, because here the two
 * *are* comparable in the way a month's pair is not: the question is "how much
 * of this category's money has gone", and an overlay answers it at a glance.
 */
export function SplitBars({ rows, currency, caption, unit }: {
  rows: { key: string; label: string; planned: Minor; actual: Minor }[];
  currency: string;
  caption: string;
  unit: string;
}) {
  const t = useT();
  const max = Math.max(1, ...rows.flatMap((row) => [row.planned, row.actual]));
  return (
    <figure className="chart">
      <div className="chart-legend">
        <span><i style={{ background: 'var(--chart-1)' }} aria-hidden /> {t('budget.planned')}</span>
        <span><i style={{ background: 'var(--chart-2)' }} aria-hidden /> {t('budget.actual')}</span>
      </div>
      <div className="bars">
        {rows.map((row) => (
          <div className="bar-row" key={row.key}>
            <span className="bar-label truncate" title={row.label}>{row.label}</span>
            <span className="bar-track split">
              <span className="bar-fill" style={{ width: `${(row.planned / max) * 100}%`, background: 'var(--chart-1)' }} />
              <span className="bar-over" style={{ width: `${(row.actual / max) * 100}%`, background: 'var(--chart-2)' }} />
            </span>
            <span className="bar-value">{asMoney(row.actual, currency, true)}</span>
          </div>
        ))}
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[unit, t('budget.planned'), t('budget.actual'), t('budget.variance')]}
        rows={rows.map((row) => [
          row.label, asMoney(row.planned, currency), asMoney(row.actual, currency),
          asMoney(row.planned - row.actual, currency),
        ])}
      />
    </figure>
  );
}

/* --------------------------------------------------------------- roll-ups */

/** One budget's rows out of the local mirror, added up. */
export function useRollUp(budget: Budget | undefined, scenario?: BudgetScenario | null, asOf?: string): BudgetRollUp | null {
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget?.id), [budget?.id]);
  const actuals = useQuery(() => list('budgetActual', (row) => row.budget_id === budget?.id), [budget?.id]);
  return useMemo(
    () => (budget ? rollUp({ budget, lines, actuals, scenario, asOf }) : null),
    [budget, lines, actuals, scenario, asOf],
  );
}

/** Project id → name, for every chart that has to say whose money this is. */
export function useProjectNames(): Map<string, string> {
  const projects = useQuery(() => list('project', (row) => !row.archived), []);
  return useMemo(() => new Map(projects.map((row) => [row.id, row.name])), [projects]);
}

/** The categories a budget actually uses, in the order the enum declares them. */
export const orderedCategories = (used: Set<string>): CostCategory[] =>
  COST_CATEGORIES.filter((category) => used.has(category));

/* ---------------------------------------------------------- a project's own */

/**
 * What lands on one project, out of every budget that charges it.
 *
 * The other direction from the budget screen, and the reason allocations
 * exist: a project lead does not care what the central infrastructure budget
 * totals, they care what part of it is theirs. Currencies are kept apart
 * rather than added — see `Budget.currency`.
 */
export function ProjectBudget({ projectId }: { projectId: string }) {
  const t = useT();
  const budgets = useQuery(() => list('budget', (row) => !row.archived), []);
  const lines = useQuery(() => list('budgetLine'), []);
  const actuals = useQuery(() => list('budgetActual'), []);

  const totals = useMemo(
    () => projectShare({ projectId, budgets, lines, actuals }),
    [projectId, budgets, lines, actuals],
  );

  /**
   * Which budgets charge this project, and how much of each.
   *
   * A budget may cover this project without charging it a penny — a shared
   * envelope whose lines all name somebody else — so the list is built from
   * the allocations rather than from the scope. Showing a budget with two
   * zeroes beside it would answer a question nobody asked.
   */
  const charged = useMemo(() => {
    const out: { budget: Budget; totals: BudgetRollUp; planned: Minor; actual: Minor }[] = [];
    for (const budget of budgets) {
      const rolled = rollUp({
        budget,
        lines: lines.filter((row) => row.budget_id === budget.id),
        actuals: actuals.filter((row) => row.budget_id === budget.id),
      });
      const share = rolled.byProject.find((row) => row.project_id === projectId);
      if (!share || (!share.planned && !share.actual)) continue;
      out.push({ budget, totals: rolled, planned: share.planned, actual: share.actual });
    }
    return out.sort((a, b) => b.planned - a.planned);
  }, [budgets, lines, actuals, projectId]);

  if (!charged.length) {
    return (
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <p className="text-[13px] text-muted">{t('budget.projectNone')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="kpi-row">
        {totals.map((row) => (
          <div className="stat" key={row.currency}>
            <span className="stat-label">{t('budget.projectPlanned')}</span>
            <strong className="stat-value">{asMoney(row.planned, row.currency, true)}</strong>
            <span className="stat-hint">
              {t('budget.projectActualHint', { amount: asMoney(row.actual, row.currency, true), count: row.budgets })}
            </span>
          </div>
        ))}
      </div>

      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th>{t('budget.budget')}</th>
              <th>{t('budget.period')}</th>
              <th className="num">{t('budget.plannedShare')}</th>
              <th className="num">{t('budget.actualShare')}</th>
              <th className="num">{t('budget.variance')}</th>
            </tr>
          </thead>
          <tbody>
            {charged.map((row) => (
              <tr key={row.budget.id}>
                <td className="title">{row.budget.name}</td>
                <td>{row.totals.period.from} → {row.totals.period.to}</td>
                <td className="num">{asMoney(row.planned, row.totals.currency)}</td>
                <td className="num">{asMoney(row.actual, row.totals.currency)}</td>
                <td className="num"><Variance value={row.planned - row.actual} currency={row.totals.currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-muted">{t('budget.projectHint')}</p>
    </div>
  );
}

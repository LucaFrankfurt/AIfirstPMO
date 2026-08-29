/**
 * The budget screens: what money was planned, what has gone, and where that
 * ends up.
 *
 * Four tabs, in the order somebody uses them. The dashboard is first because
 * it is what people come back for; the plan and the record of spend are the
 * two halves of the data behind it; scenarios are the argument somebody makes
 * about it on a Tuesday.
 *
 * Everything is read from the local mirror and added up on render, so all of
 * this works offline — including the charts, which is the whole reason
 * `rollUp` is a pure function in `@kolibri/shared` rather than an endpoint.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  BUDGET_STATUS, COST_CATEGORIES, COST_CONFIDENCE, COST_KINDS, COST_RECURRENCES, FULL_SHARE,
  compareOrder,
  SPEND_STAGES, actualFromPlan, byConfidence, byKind, coversProject, monthOf, orderKey,
  plannedForMonth, plannedTotal,
  projectScope, rollUp,
  type Allocation, type Budget, type BudgetActual, type BudgetLine, type BudgetScenario,
  type CostCategory, type Minor, type PlannedForMonth, type ScenarioAdjustment, type SpendStage,
} from '@kolibri/shared';
import { Header } from '../components/AppShell';
import {
  AllocationChips, AllocationEditor, BurnChart, Health, MoneyInput, PlanVsActual, SplitBars,
  Variance, asMoney, categoryKey, confidenceKey, healthKey, recurrenceKey, stageKey,
  useProjectNames, useRollUp,
} from '../components/budget';
import { Stat } from '../components/insights';
import { Empty, Icon, Sheet, useConfirm, useToast } from '../components/ui';
import { Button } from '../components/ui/button';
import { Chip } from '../components/ui/chip';
import { Input, Select, Textarea } from '../components/ui/field';
import { SectionHeading } from '../components/ui/section';
import { monthName, shortDate, today } from '../lib/format';
import { useT, type TranslationKey } from '../lib/i18n';
import { create, remove, update } from '../lib/mutations';
import { list, useQuery, useRow } from '../lib/store';
import { useTabStrip } from '../lib/tab-strip';
import { useCanWrite, useFeature } from '../session';

/* A tick on a cumulative axis: the point in time the running total is read
   at, so a day is the honest label. Prose wants `monthName` instead. */
const monthLabel = (month: string): string => shortDate(`${month}-01`);

/**
 * How far real money has got, as a class. Written out for the reason
 * `HEALTH_CLASS` is: `check:css` reads the source for class names, and a
 * template literal is a name it cannot check. `invoiced` maps to nothing —
 * it is the ordinary middle of the three and needs no colour of its own.
 */
const STAGE_CLASS: Record<SpendStage, string> = {
  committed: 'stage-committed',
  invoiced: '',
  paid: 'stage-paid',
};
/**
 * Plan lines in the order somebody put them, with a tie-break that is not
 * chance.
 *
 * The comparator this replaced never returned 0, so eight lines that all
 * carried the schema's default key — which is what a line created over REST or
 * by an import has — came out in whatever order the sort happened to leave
 * them, and a different order on the next render. `compareOrder` is the shared
 * fractional-index comparison, and creation time settles the ties.
 */
const byOrder = (a: { sort_order?: string; created_at: number }, b: { sort_order?: string; created_at: number }) =>
  compareOrder(a.sort_order ?? '', b.sort_order ?? '') || a.created_at - b.created_at;

/** The screen every budget route shows when the workspace has not switched it on. */
function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('budget.offTitle')} hint={t('budget.offHint')} />;
}

/* ------------------------------------------------------------------ index */

/**
 * Every budget at once, and what they add up to.
 *
 * The totals are per currency rather than one number, because nothing here
 * invents an exchange rate — see `Budget.currency`. A workspace with one
 * currency, which is most of them, sees one row and never notices.
 */
export function BudgetIndex() {
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('budget');
  const [creating, setCreating] = useState(false);
  const names = useProjectNames();

  const budgets = useQuery(() => list('budget', (row) => !row.archived), []);
  const lines = useQuery(() => list('budgetLine'), []);
  const actuals = useQuery(() => list('budgetActual'), []);

  const rolled = useMemo(() => budgets.map((budget) => ({
    budget,
    totals: rollUp({
      budget,
      lines: lines.filter((row) => row.budget_id === budget.id),
      actuals: actuals.filter((row) => row.budget_id === budget.id),
    }),
  })).sort((a, b) => b.totals.planned - a.totals.planned), [budgets, lines, actuals]);

  /** One set of totals per currency. Two currencies are two answers, not one. */
  const perCurrency = useMemo(() => {
    const out = new Map<string, { currency: string; approved: Minor; planned: Minor; actual: Minor; forecast: Minor; count: number }>();
    for (const { totals } of rolled) {
      const row = out.get(totals.currency)
        ?? { currency: totals.currency, approved: 0, planned: 0, actual: 0, forecast: 0, count: 0 };
      row.approved += totals.approved;
      row.planned += totals.planned;
      row.actual += totals.actual;
      row.forecast += totals.forecast;
      row.count += 1;
      out.set(totals.currency, row);
    }
    return [...out.values()].sort((a, b) => b.planned - a.planned);
  }, [rolled]);

  /**
   * What every project is charged, across every budget.
   *
   * The view a PMO opens the week before a steering meeting, and the one
   * allocations exist for: money is planned centrally and spent per project,
   * and until now nothing anywhere could put those two facts together.
   *
   * Only the dominant currency is charted. Bars whose lengths mean different
   * things is not a chart, and the alternative — one chart per currency — buys
   * a second picture for the rare workspace at the cost of a confusing first
   * one for every other.
   */
  const main = perCurrency[0]?.currency ?? 'EUR';
  const byProject = useMemo(() => {
    const out = new Map<string, { key: string; label: string; planned: Minor; actual: Minor }>();
    for (const { totals } of rolled.filter((row) => row.totals.currency === main)) {
      for (const row of totals.byProject) {
        const key = row.project_id || '';
        const bucket = out.get(key) ?? {
          key: key || 'unallocated',
          label: key ? names.get(key) ?? t('budget.unknownProject') : t('budget.unallocated'),
          planned: 0,
          actual: 0,
        };
        bucket.planned += row.planned;
        bucket.actual += row.actual;
        out.set(key, bucket);
      }
    }
    return [...out.values()].filter((row) => row.planned || row.actual).sort((a, b) => b.planned - a.planned).slice(0, 10);
  }, [rolled, main, names, t]);

  const byCategory = useMemo(() => {
    const out = new Map<CostCategory, { key: string; label: string; planned: Minor; actual: Minor }>();
    for (const { totals } of rolled.filter((row) => row.totals.currency === main)) {
      for (const row of totals.byCategory) {
        const bucket = out.get(row.key) ?? { key: row.key, label: t(categoryKey(row.key)), planned: 0, actual: 0 };
        bucket.planned += row.planned;
        bucket.actual += row.actual;
        out.set(row.key, bucket);
      }
    }
    return COST_CATEGORIES.map((key) => out.get(key)).filter((row): row is NonNullable<typeof row> => !!row);
  }, [rolled, main, t]);

  if (!enabled) return <><Header title={t('budget.title')} /><SwitchedOff /></>;

  return (
    <>
      <Header title={t('budget.title')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('budget.new')}</span>
          </Button>
        )}
      </Header>

      {!budgets.length ? (
        <Empty emoji="💶" title={t('budget.emptyTitle')} hint={t('budget.emptyHint')} />
      ) : (
        <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
          {/* The list first, then what it adds up to.
              The other way round is how this page shipped, and it reads fine on
              a desktop where the tiles are one compact row — on a phone they
              stack two-by-two and the two charts follow, so the budgets
              themselves began 665 pixels down an 844-pixel screen. Somebody
              opening "Budgets" to open a budget met a page of analysis and
              concluded there were none. A summary is context for a list; it is
              not what an index is for. */}
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>{t('budget.budget')}</th>
                  <th>{t('budget.period')}</th>
                  <th>{t('budget.status')}</th>
                  <th className="num">{t('budget.approved')}</th>
                  <th className="num">{t('budget.planned')}</th>
                  <th className="num">{t('budget.actual')}</th>
                  <th className="num">{t('budget.forecast')}</th>
                  <th className="num">{t('budget.variance')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rolled.map(({ budget, totals }) => (
                  <tr key={budget.id} onClick={() => navigate(`/budgets/${budget.id}`)}>
                    <td className="title">
                      <Link to={`/budgets/${budget.id}`}>{budget.name}</Link>
                      {/* The row is nine columns wide and a phone shows two of
                          them, so the figure somebody came for was behind a
                          sideways scroll. It goes under the name on a narrow
                          screen — and only there, since on a wide one it would
                          repeat the two columns sitting right beside it. */}
                      <span className="row-sub row-sub-sm">
                        {t('budget.actualOfPlanned', {
                          actual: asMoney(totals.actual, totals.currency),
                          planned: asMoney(totals.planned, totals.currency),
                        })}
                      </span>
                    </td>
                    <td>{totals.period.from} → {totals.period.to}</td>
                    <td>{t(`budget.status.${budget.status}` as TranslationKey)}</td>
                    <td className="num">{budget.approved ? asMoney(budget.approved, totals.currency) : '—'}</td>
                    <td className="num">{asMoney(totals.planned, totals.currency)}</td>
                    <td className="num">{asMoney(totals.actual, totals.currency)}</td>
                    <td className="num">{asMoney(totals.forecast, totals.currency)}</td>
                    <td className="num"><Variance value={totals.variance} currency={totals.currency} /></td>
                    <td><Health totals={totals} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* `mt-5` rather than `tight`: this is no longer the top of the page. */}
          <SectionHeading>{t('budget.portfolioTitle')}</SectionHeading>
          <p className="text-[12px] text-muted">{t('budget.portfolioHint')}</p>
          {perCurrency.map((row) => (
            <div className="kpi-row" key={row.currency}>
              <Stat
                label={t('budget.approved')}
                value={asMoney(row.approved, row.currency, true)}
                hint={t('budget.count', { count: row.count })}
              />
              <Stat label={t('budget.planned')} value={asMoney(row.planned, row.currency, true)} />
              <Stat label={t('budget.actual')} value={asMoney(row.actual, row.currency, true)} />
              <Stat
                label={t('budget.forecast')}
                value={asMoney(row.forecast, row.currency, true)}
                hint={t('budget.forecastHint')}
              />
            </div>
          ))}

          <div className="grid gap-3 sm:grid-cols-2">
            {byProject.length > 0 && (
              <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
                <h2 className="chart-title">{t('budget.byProject')}</h2>
                <p className="text-[12px] text-muted">{t('budget.byProjectHint')}</p>
                <SplitBars rows={byProject} currency={main} caption={t('budget.byProjectCaption')} unit={t('budget.project')} />
              </div>
            )}
            {byCategory.length > 0 && (
              <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
                <h2 className="chart-title">{t('budget.byCategory')}</h2>
                <p className="text-[12px] text-muted">{t('budget.byCategoryHint')}</p>
                <SplitBars rows={byCategory} currency={main} caption={t('budget.byCategoryCaption')} unit={t('budget.category')} />
              </div>
            )}
          </div>
        </div>
      )}

      {creating && <BudgetForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/budgets/${id}`)} />}
    </>
  );
}

/* ----------------------------------------------------------------- detail */

const TABS = ['dashboard', 'plan', 'actuals', 'scenarios', 'settings'] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TranslationKey> = {
  dashboard: 'budget.tabDashboard',
  plan: 'budget.tabPlan',
  actuals: 'budget.tabActuals',
  scenarios: 'budget.tabScenarios',
  settings: 'project.tabSettings',
};

export function BudgetDetail() {
  const t = useT();
  const { id = '' } = useParams();
  const enabled = useFeature('budget');
  const budget = useRow('budget', id);
  const [search, setSearch] = useSearchParams();
  const asked = search.get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(asked as Tab) ? asked as Tab : 'dashboard');
  const strip = useTabStrip(tab);
  // Which scenario the dashboard is drawing. Held here rather than in the URL:
  // it is a lens somebody is looking through, not a place they navigated to.
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const scenario = useRow('budgetScenario', scenarioId);
  const totals = useRollUp(budget, scenario ?? null);

  if (!enabled) return <><Header title={t('budget.title')} /><SwitchedOff /></>;
  if (!budget || !totals) {
    return (
      <>
        <Header title={t('budget.title')} />
        <Empty emoji="🕳️" title={t('project.notFound')} hint={t('project.notFoundHint')} />
      </>
    );
  }

  return (
    <>
      <Header title={budget.name}>
        <Chip>{budget.currency}</Chip>
        <Health totals={totals} />
      </Header>

      <div ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {TABS.map((name) => (
          <button
            key={name}
            className={tab === name ? 'active' : ''}
            onClick={() => {
              setTab(name);
              setSearch(name === 'dashboard' ? {} : { tab: name }, { replace: true });
            }}
          >
            {t(TAB_KEY[name])}
          </button>
        ))}
      </div>

      {scenario && tab === 'dashboard' && (
        <div className="scenario-bar">
          <Icon name="sparkle" size={13} />
          <span className="flex-1 min-w-0 truncate">{t('budget.applied', { name: scenario.name })}</span>
          <Button size="sm" onClick={() => setScenarioId(null)}>{t('budget.clearScenario')}</Button>
        </div>
      )}

      {tab === 'dashboard' && <Dashboard budget={budget} totals={totals} />}
      {tab === 'plan' && <Plan budget={budget} />}
      {tab === 'actuals' && <Actuals budget={budget} />}
      {tab === 'scenarios' && <Scenarios budget={budget} showing={scenarioId} onShow={setScenarioId} />}
      {tab === 'settings' && <BudgetSettings budget={budget} />}
    </>
  );
}

/* -------------------------------------------------------------- dashboard */

function Dashboard({ budget, totals }: { budget: Budget; totals: ReturnType<typeof rollUp> }) {
  const t = useT();
  const names = useProjectNames();
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const currency = totals.currency;
  const period = `${totals.period.from} → ${totals.period.to}`;
  const thisMonth = monthOf(today());

  const confidence = useMemo(() => byConfidence(lines, totals.period), [lines, totals.period]);
  const kinds = useMemo(() => byKind(lines, totals.period), [lines, totals.period]);

  if (!lines.length && !totals.actual) {
    return <Empty emoji="🧮" title={t('budget.noLines')} hint={t('budget.noLinesHint')} />;
  }

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="kpi-row">
        <Stat
          label={t('budget.approved')}
          value={budget.approved ? asMoney(budget.approved, currency, true) : '—'}
          hint={totals.used === null ? undefined : t('budget.usedOfApproved', {
            used: asMoney(totals.actual, currency, true),
            envelope: asMoney(budget.approved || totals.planned, currency, true),
          })}
        />
        <Stat label={t('budget.planned')} value={asMoney(totals.planned, currency, true)} />
        <Stat
          label={t('budget.actual')}
          value={asMoney(totals.actual, currency, true)}
          hint={t('budget.elapsed', { percent: Math.round(totals.elapsed * 100) })}
        />
        <Stat
          label={t('budget.forecast')}
          value={asMoney(totals.forecast, currency, true)}
          hint={t('budget.forecastHint')}
        />
        {totals.runRate !== null && (
          <Stat
            label={t('budget.runRate')}
            value={asMoney(totals.runRate, currency, true)}
            hint={t('budget.runRateHint')}
          />
        )}
      </div>
      {/* The sentence the tile has no room for. A hint long enough to explain
          a figure is a hint that stretches every tile in the row to match it. */}
      {totals.runRate !== null && <p className="mb-4 text-[12px] text-muted">{t('budget.runRateAside')}</p>}

      <div className="kpi-row">
        <Stat label={t('budget.committed')} value={asMoney(totals.committed, currency, true)} />
        <Stat label={t('budget.invoiced')} value={asMoney(totals.invoiced, currency, true)} />
        <Stat label={t('budget.paid')} value={asMoney(totals.paid, currency, true)} />
        <Stat label={t('budget.remaining')} value={asMoney(totals.remaining, currency, true)} />
        {totals.unplanned > 0 && (
          <Stat
            label={t('budget.unplanned')}
            value={asMoney(totals.unplanned, currency, true)}
            hint={t('budget.unplannedHint')}
          />
        )}
      </div>

      <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
        <h2 className="chart-title">{t('budget.burn')}</h2>
        <p className="text-[12px] text-muted">{t('budget.burnHint')}</p>
        <BurnChart
          labels={totals.byMonth.map((row) => monthLabel(row.month))}
          currency={currency}
          caption={t('budget.burnCaption', { period })}
          series={[
            { name: t('budget.planned'), color: 'var(--chart-1)', points: totals.byMonth.map((row) => row.plannedToDate) },
            // The record of what happened stops where the record does. See
            // `MoneySeries.points` — a flat line to December would read as a
            // promise that nothing more is coming.
            {
              name: t('budget.actual'),
              color: 'var(--chart-2)',
              points: totals.byMonth.filter((row) => row.month <= thisMonth).map((row) => row.actualToDate),
            },
            { name: t('budget.forecast'), color: 'var(--fg-soft)', points: totals.byMonth.map((row) => row.forecastToDate), dashed: true },
          ]}
        />
      </div>

      <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
        <h2 className="chart-title">{t('budget.monthly')}</h2>
        <p className="text-[12px] text-muted">{t('budget.monthlyHint')}</p>
        <PlanVsActual
          currency={currency}
          caption={t('budget.monthlyCaption')}
          rows={totals.byMonth.map((row) => ({
            month: row.month, label: monthLabel(row.month), planned: row.planned, actual: row.actual,
          }))}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('budget.byCategory')}</h2>
          <p className="text-[12px] text-muted">{t('budget.byCategoryHint')}</p>
          <SplitBars
            currency={currency}
            caption={t('budget.byCategoryCaption')}
            unit={t('budget.category')}
            rows={totals.byCategory.map((row) => ({
              key: row.key, label: t(categoryKey(row.key)), planned: row.planned, actual: row.actual,
            }))}
          />
        </div>
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('budget.byProject')}</h2>
          <p className="text-[12px] text-muted">{t('budget.byProjectHint')}</p>
          <SplitBars
            currency={currency}
            caption={t('budget.byProjectCaption')}
            unit={t('budget.project')}
            rows={totals.byProject.map((row) => ({
              key: row.project_id || 'unallocated',
              label: row.project_id ? names.get(row.project_id) ?? t('budget.unknownProject') : t('budget.unallocated'),
              planned: row.planned,
              actual: row.actual,
            }))}
          />
        </div>
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('budget.byConfidence')}</h2>
          <SplitBars
            currency={currency}
            caption={t('budget.byConfidenceCaption')}
            unit={t('budget.confidence')}
            rows={COST_CONFIDENCE.map((level) => ({
              key: level, label: t(confidenceKey(level)), planned: confidence[level], actual: 0,
            })).filter((row) => row.planned)}
          />
        </div>
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('budget.byKind')}</h2>
          <SplitBars
            currency={currency}
            caption={t('budget.byKindCaption')}
            unit={t('budget.kind')}
            rows={COST_KINDS.map((kind) => ({
              key: kind, label: t(`budget.kind.${kind}` as TranslationKey), planned: kinds[kind], actual: 0,
            })).filter((row) => row.planned)}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- plan */

function Plan({ budget }: { budget: Budget }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const names = useProjectNames();
  const estate = useFeature('infrastructure');
  const [editing, setEditing] = useState<BudgetLine | 'new' | null>(null);
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const components = useQuery(() => list('component'), []);
  const totals = useRollUp(budget);
  const sorted = useMemo(() => [...lines].sort(byOrder), [lines]);

  /**
   * What the register says a line's components come to, over the same period
   * the line is planned over.
   *
   * The reconciliation this whole link exists for: "we budgeted €4,500 a month
   * for hosting, and the register says the machines charged to that line cost
   * €5,200". Neither figure is authoritative — one is a plan and the other is
   * an inventory — and the useful thing is being told they disagree rather
   * than being handed one of them.
   *
   * A component is read through the same `plannedTotal` a budget line is,
   * because both carry an amount, a recurrence and a window. That is not a
   * coincidence: the component's cost fields were given the budget's
   * vocabulary so this comparison would need no conversion in between, and a
   * conversion is where two figures start quietly meaning different things.
   */
  const fromRegister = useMemo(() => {
    const out = new Map<string, Minor>();
    if (!estate || !totals) return out;
    for (const component of components) {
      if (!component.line_id) continue;
      const amount = plannedTotal(
        {
          amount: component.amount,
          recurrence: component.recurrence,
          starts_on: component.live_from,
          ends_on: component.live_until,
        },
        totals.period,
      );
      if (amount) out.set(component.line_id, (out.get(component.line_id) ?? 0) + amount);
    }
    return out;
  }, [estate, components, totals]);
  const anyRegistered = fromRegister.size > 0;

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('budget.addLine')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="🧾" title={t('budget.noLines')} hint={t('budget.noLinesHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('budget.lineName')}</th>
                <th>{t('budget.category')}</th>
                <th>{t('budget.recurrence')}</th>
                <th className="num">{t('budget.amountEach')}</th>
                <th className="num">{t('budget.total')}</th>
                {anyRegistered && <th className="num">{t('estate.fromRegister')}</th>}
                <th>{t('budget.charges')}</th>
                <th>{t('budget.confidence')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((line) => (
                <tr key={line.id} onClick={() => canWrite && setEditing(line)}>
                  <td className="title">
                    {line.name}
                    {line.vendor && <span className="row-sub">{line.vendor}</span>}
                  </td>
                  <td>{t(categoryKey(line.category))}</td>
                  <td>{t(recurrenceKey(line.recurrence))}</td>
                  <td className="num">{asMoney(line.amount, budget.currency)}</td>
                  <td className="num">
                    {totals ? asMoney(plannedTotal(line, totals.period), budget.currency) : '—'}
                  </td>
                  {anyRegistered && (
                    <td className="num">
                      {fromRegister.has(line.id) ? (
                        <>
                          {asMoney(fromRegister.get(line.id)!, budget.currency)}
                          {/* Only shown when they disagree. A column of "and
                              they match" is a column nobody reads, and the
                              whole point is the row where they do not. */}
                          {totals && fromRegister.get(line.id) !== plannedTotal(line, totals.period) && (
                            <span className="row-sub">
                              <Variance
                                value={plannedTotal(line, totals.period) - fromRegister.get(line.id)!}
                                currency={budget.currency}
                              />
                            </span>
                          )}
                        </>
                      ) : <span className="text-muted">—</span>}
                    </td>
                  )}
                  <td><AllocationChips allocations={line.allocations} names={names} /></td>
                  <td><Chip>{t(confidenceKey(line.confidence))}</Chip></td>
                  <td>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (await confirm(t('budget.deleteLine', { name: line.name }))) remove('budgetLine', line.id);
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {anyRegistered && <p className="mt-2 text-[12px] text-muted">{t('estate.fromRegisterHint')}</p>}

      {editing && (
        <LineForm
          budget={budget}
          line={editing === 'new' ? null : editing}
          last={sorted[sorted.length - 1]?.sort_order ?? null}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

function LineForm({ budget, line, last, onClose }: {
  budget: Budget;
  line: BudgetLine | null;
  last: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const [form, setForm] = useState(() => ({
    name: line?.name ?? '',
    amount: line?.amount ?? 0,
    category: line?.category ?? ('infrastructure' as CostCategory),
    kind: line?.kind ?? 'opex',
    recurrence: line?.recurrence ?? 'once',
    starts_on: line?.starts_on ?? '',
    ends_on: line?.ends_on ?? '',
    vendor: line?.vendor ?? '',
    confidence: line?.confidence ?? 'likely',
    note: line?.note ?? '',
  }));
  const [allocations, setAllocations] = useState<Allocation[]>(line?.allocations ?? []);

  const save = () => {
    const patch = {
      budget_id: budget.id,
      name: form.name.trim(),
      amount: form.amount,
      category: form.category,
      kind: form.kind,
      recurrence: form.recurrence,
      starts_on: form.starts_on || null,
      ends_on: form.ends_on || null,
      vendor: form.vendor.trim() || null,
      confidence: form.confidence,
      allocations,
      note: form.note.trim() || null,
    };
    if (line) update('budgetLine', line.id, patch);
    else create('budgetLine', { ...patch, sort_order: orderKey(last, null) });
    onClose();
  };

  return (
    <Sheet
      title={line ? t('budget.line') : t('budget.addLine')}
      onClose={onClose}
      footer={<Button variant="primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</Button>}
    >
      <div className="field">
        <label htmlFor="bl-name">{t('budget.lineName')}</label>
        <Input
          id="bl-name"
          autoFocus
          placeholder={t('budget.lineNamePlaceholder')}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-amount">{t('budget.amount')} ({budget.currency})</label>
          <MoneyInput
            id="bl-amount"
            currency={budget.currency}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
          />
          <span className="text-[12px] text-muted">{t('budget.amountHint')}</span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-every">{t('budget.recurrence')}</label>
          <Select
            id="bl-every"
            value={form.recurrence}
            onChange={(event) => setForm({ ...form, recurrence: event.target.value as typeof form.recurrence })}
          >
            {COST_RECURRENCES.map((every) => (
              <option key={every} value={every}>{t(recurrenceKey(every))}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-category">{t('budget.category')}</label>
          <Select
            id="bl-category"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value as CostCategory })}
          >
            {COST_CATEGORIES.map((category) => (
              <option key={category} value={category}>{t(categoryKey(category))}</option>
            ))}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-kind">{t('budget.kind')}</label>
          <Select
            id="bl-kind"
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value as typeof form.kind })}
          >
            {COST_KINDS.map((kind) => (
              <option key={kind} value={kind}>{t(`budget.kind.${kind}` as TranslationKey)}</option>
            ))}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-confidence">{t('budget.confidence')}</label>
          <Select
            id="bl-confidence"
            value={form.confidence}
            onChange={(event) => setForm({ ...form, confidence: event.target.value as typeof form.confidence })}
          >
            {COST_CONFIDENCE.map((level) => (
              <option key={level} value={level}>{t(confidenceKey(level))}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-from">{t('budget.periodStart')}</label>
          <Input id="bl-from" type="date" value={form.starts_on} onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="bl-to">{t('budget.periodEnd')}</label>
          <Input id="bl-to" type="date" value={form.ends_on} onChange={(event) => setForm({ ...form, ends_on: event.target.value })} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="bl-vendor">{t('budget.vendor')}</label>
        <Input id="bl-vendor" value={form.vendor} onChange={(event) => setForm({ ...form, vendor: event.target.value })} />
      </div>

      <div className="field">
        <label>{t('budget.charges')}</label>
        <AllocationEditor value={allocations} projects={projects} onChange={setAllocations} />
      </div>

      <div className="field">
        <label htmlFor="bl-note">{t('budget.adjNote')}</label>
        <Textarea id="bl-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- actuals */

function Actuals({ budget }: { budget: Budget }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<BudgetActual | 'new' | null>(null);
  const actuals = useQuery(() => list('budgetActual', (row) => row.budget_id === budget.id), [budget.id]);
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const lineNames = useMemo(() => new Map(lines.map((row) => [row.id, row.name])), [lines]);
  const sorted = useMemo(
    () => [...actuals].sort((a, b) => (a.spent_on < b.spent_on ? 1 : a.spent_on > b.spent_on ? -1 : b.created_at - a.created_at)),
    [actuals],
  );

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      {canWrite && <ConfirmPlanned budget={budget} lines={lines} actuals={actuals} />}

      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('budget.addActual')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="🧾" title={t('budget.noActuals')} hint={t('budget.noActualsHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('budget.spentOn')}</th>
                <th>{t('budget.actualDescription')}</th>
                <th>{t('budget.against')}</th>
                <th>{t('budget.category')}</th>
                <th>{t('budget.stage')}</th>
                <th className="num">{t('budget.amount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.id} onClick={() => canWrite && setEditing(entry)}>
                  <td>{shortDate(entry.spent_on)}</td>
                  <td className="title">
                    {entry.description}
                    {entry.reference && <span className="row-sub">{entry.reference}</span>}
                  </td>
                  <td>
                    {entry.line_id
                      ? lineNames.get(entry.line_id) ?? t('budget.noLine')
                      : <span className="text-muted">{t('budget.noLine')}</span>}
                  </td>
                  <td>{t(categoryKey(entry.category))}</td>
                  <td>
                    <Chip className={STAGE_CLASS[entry.stage]}>{t(stageKey(entry.stage))}</Chip>
                  </td>
                  <td className="num">{asMoney(entry.amount, budget.currency)}</td>
                  <td>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const amount = asMoney(entry.amount, budget.currency);
                          if (await confirm(t('budget.deleteActual', { amount }))) remove('budgetActual', entry.id);
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ActualForm
          budget={budget}
          entry={editing === 'new' ? null : editing}
          lines={lines}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

/**
 * Taking a month's planned costs across, one press each.
 *
 * The recurring half of a budget is almost all of it — twelve identical hosting
 * bills a year, four quarterly ones, a licence renewal — and typing the same
 * four fields twelve times is why the actuals in a budget stop being filled in
 * around April. A budget nobody records against is a budget with a plan and no
 * reality to compare it to, which is a worse failure than any of the ones the
 * forecast rules guard against.
 *
 * A confirmed row is an ordinary actual in every respect: same shape, same
 * table, editable and deletable like any other, and nothing downstream knows it
 * was not typed. See `actualFromPlan` — there is deliberately no flag on the
 * row saying where it came from.
 */
function ConfirmPlanned({ budget, lines, actuals }: {
  budget: Budget;
  lines: BudgetLine[];
  actuals: BudgetActual[];
}) {
  const t = useT();
  const toast = useToast();
  const totals = useRollUp(budget);
  /* The month somebody is closing. Today's, unless the budget's period ended
     first — a closed budget opens on its last month rather than on one that
     was never in it and can therefore never have anything to confirm. */
  const [month, setMonth] = useState(() => {
    const now = monthOf(today());
    if (!budget.period_end) return now;
    const last = monthOf(budget.period_end);
    return now > last ? last : now;
  });
  /**
   * What stage a confirmation records.
   *
   * A choice rather than a constant, because the same press means different
   * things depending on when in the month it happens: at the start it is a
   * commitment nobody has invoiced, at the end it is a bill that was paid.
   * Defaulted to paid, which is what somebody closing a month means.
   */
  const [stage, setStage] = useState<SpendStage>('paid');

  const planned = useMemo(
    () => (totals ? plannedForMonth({ lines, actuals, month, period: totals.period }) : []),
    [lines, actuals, month, totals],
  );
  const open = planned.filter((row) => !row.confirmed);
  const outstanding = open.reduce((sum, row) => sum + row.amount, 0);

  const describe = (row: PlannedForMonth) => `${row.line.name} · ${monthName(row.month)}`;
  const take = (rows: PlannedForMonth[]) => {
    for (const row of rows) create('budgetActual', actualFromPlan(row, { budgetId: budget.id, stage, describe }));
    toast(t('budget.confirmed', { count: rows.length }));
  };

  /**
   * Two ways for the strip to have nothing to offer, and both collapse it.
   *
   * Nothing planned is the empty month: the picker stays so somebody can look
   * at another one, but a heading over an empty box helps nobody. Settled is
   * the closed month, and it collapses for a different reason — every row it
   * would list is already a row in the table directly below, so leaving the
   * list up prints the same two figures twice on one screen and turns a
   * checklist into wallpaper. One sentence says the useful part.
   */
  const nothingPlanned = !planned.length;
  const settled = !nothingPlanned && !open.length;

  return (
    <div className="confirm-strip">
      <div className="confirm-head">
        <strong className="flex-1 min-w-0">{t('budget.confirmTitle')}</strong>
        <Input
          type="month"
          className="w-auto"
          aria-label={t('budget.month')}
          value={month}
          onChange={(event) => setMonth(event.target.value || monthOf(today()))}
        />
        {/* The stage only describes something about to be written, so it is
            not offered on a month with nothing left to write. */}
        {!!open.length && (
          <Select
            className="w-auto"
            aria-label={t('budget.stage')}
            value={stage}
            onChange={(event) => setStage(event.target.value as SpendStage)}
          >
            {SPEND_STAGES.map((name) => <option key={name} value={name}>{t(stageKey(name))}</option>)}
          </Select>
        )}
      </div>

      {nothingPlanned ? (
        <p className="confirm-empty">{t('budget.confirmNothing', { month: monthName(month) })}</p>
      ) : settled ? (
        <p className="confirm-empty done">
          <Icon name="check" size={13} /> {t('budget.confirmSettled', { month: monthName(month) })}
        </p>
      ) : (
        <>
          <ul className="confirm-list">
            {planned.map((row) => (
              <li key={row.line.id} className={row.confirmed ? 'done' : ''}>
                <span className="flex-1 min-w-0 truncate">{row.line.name}</span>
                <span className="text-[12px] text-muted">{shortDate(row.on)}</span>
                <span className="tabular-nums">{asMoney(row.amount, budget.currency)}</span>
                {row.confirmed ? (
                  /* Already recorded, so no button — and the figure that is
                     really there, which is the useful thing when it is not the
                     one that was planned. */
                  <span className="confirm-done">
                    <Icon name="check" size={13} />
                    {t('budget.confirmAlready', { amount: asMoney(row.recorded, budget.currency) })}
                  </span>
                ) : (
                  <Button size="sm" onClick={() => take([row])}>{t('budget.confirmOne')}</Button>
                )}
              </li>
            ))}
          </ul>
          {open.length > 1 && (
            <div className="confirm-foot">
              <Button variant="primary" size="sm" onClick={() => take(open)}>
                {t('budget.confirmAll', { count: open.length, amount: asMoney(outstanding, budget.currency) })}
              </Button>
              <span className="text-[12px] text-muted">{t('budget.confirmHint')}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ActualForm({ budget, entry, lines, onClose }: {
  budget: Budget;
  entry: BudgetActual | null;
  lines: BudgetLine[];
  onClose: () => void;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const [form, setForm] = useState(() => ({
    description: entry?.description ?? '',
    amount: entry?.amount ?? 0,
    line_id: entry?.line_id ?? '',
    category: entry?.category ?? ('infrastructure' as CostCategory),
    spent_on: entry?.spent_on ?? today(),
    stage: entry?.stage ?? 'paid',
    vendor: entry?.vendor ?? '',
    reference: entry?.reference ?? '',
    note: entry?.note ?? '',
  }));
  const [allocations, setAllocations] = useState<Allocation[]>(entry?.allocations ?? []);

  /**
   * Picking a plan line fills in the things the line already knows.
   *
   * Only the fields somebody has not touched — an invoice against the hosting
   * line is a hosting cost from that supplier, and asking again invites a
   * mismatch that only ever shows up as two categories that should have been
   * one. The split is deliberately left empty rather than copied: an empty
   * split *means* "follow the line", and copying it would freeze today's
   * percentages into an invoice that should follow the line when it changes.
   */
  const pickLine = (id: string) => {
    const line = lines.find((row) => row.id === id);
    setForm((current) => ({
      ...current,
      line_id: id,
      category: line?.category ?? current.category,
      vendor: current.vendor || (line?.vendor ?? ''),
    }));
  };

  const save = () => {
    const patch = {
      budget_id: budget.id,
      line_id: form.line_id || null,
      description: form.description.trim(),
      amount: form.amount,
      category: form.category,
      spent_on: form.spent_on || today(),
      stage: form.stage,
      vendor: form.vendor.trim() || null,
      reference: form.reference.trim() || null,
      allocations,
      note: form.note.trim() || null,
    };
    if (entry) update('budgetActual', entry.id, patch);
    else create('budgetActual', patch);
    onClose();
  };

  return (
    <Sheet
      title={t('budget.addActual')}
      onClose={onClose}
      footer={<Button variant="primary" onClick={save} disabled={!form.description.trim()}>{t('action.save')}</Button>}
    >
      <div className="field">
        <label htmlFor="ba-what">{t('budget.actualDescription')}</label>
        <Input
          id="ba-what"
          autoFocus
          placeholder={t('budget.actualDescriptionPlaceholder')}
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="ba-amount">{t('budget.amount')} ({budget.currency})</label>
          <MoneyInput
            id="ba-amount"
            currency={budget.currency}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
          />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="ba-date">{t('budget.spentOn')}</label>
          <Input id="ba-date" type="date" value={form.spent_on} onChange={(event) => setForm({ ...form, spent_on: event.target.value })} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="ba-line">{t('budget.against')}</label>
        <Select id="ba-line" value={form.line_id} onChange={(event) => pickLine(event.target.value)}>
          <option value="">{t('budget.noLine')}</option>
          {lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
        </Select>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="ba-category">{t('budget.category')}</label>
          <Select
            id="ba-category"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value as CostCategory })}
          >
            {COST_CATEGORIES.map((category) => (
              <option key={category} value={category}>{t(categoryKey(category))}</option>
            ))}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="ba-stage">{t('budget.stage')}</label>
          <Select
            id="ba-stage"
            value={form.stage}
            onChange={(event) => setForm({ ...form, stage: event.target.value as typeof form.stage })}
          >
            {SPEND_STAGES.map((stage) => <option key={stage} value={stage}>{t(stageKey(stage))}</option>)}
          </Select>
          <span className="text-[12px] text-muted">{t('budget.stageHint')}</span>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="ba-vendor">{t('budget.vendor')}</label>
          <Input id="ba-vendor" value={form.vendor} onChange={(event) => setForm({ ...form, vendor: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="ba-ref">{t('budget.reference')}</label>
          <Input id="ba-ref" value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
        </div>
      </div>

      <div className="field">
        <label>{t('budget.charges')}</label>
        <AllocationEditor value={allocations} projects={projects} onChange={setAllocations} />
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------- scenarios */

function Scenarios({ budget, showing, onShow }: {
  budget: Budget;
  showing: string | null;
  onShow: (id: string | null) => void;
}) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<BudgetScenario | 'new' | null>(null);
  const scenarios = useQuery(() => list('budgetScenario', (row) => row.budget_id === budget.id), [budget.id]);
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const actuals = useQuery(() => list('budgetActual', (row) => row.budget_id === budget.id), [budget.id]);
  const plan = useMemo(() => rollUp({ budget, lines, actuals }), [budget, lines, actuals]);

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <p className="text-[12px] text-muted">{t('budget.scenarioHint')}</p>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('budget.addScenario')}
          </Button>
        </div>
      )}

      {!scenarios.length ? (
        <Empty emoji="🔀" title={t('budget.noScenarios')} hint={t('budget.noScenariosHint')} />
      ) : (
        <div className="scenario-list">
          <div className="scenario-card baseline">
            <div className="flex-1 min-w-0">
              <strong>{t('budget.scenarioPlan')}</strong>
              <span className="row-sub">{asMoney(plan.planned, plan.currency)}</span>
            </div>
            {showing && <Button size="sm" onClick={() => onShow(null)}>{t('budget.clearScenario')}</Button>}
          </div>
          {scenarios.map((scenario) => {
            const rolled = rollUp({ budget, lines, actuals, scenario });
            const delta = rolled.planned - plan.planned;
            return (
              <div className={`scenario-card${showing === scenario.id ? ' showing' : ''}`} key={scenario.id}>
                <div className="flex-1 min-w-0">
                  <strong>{scenario.name}</strong>
                  <span className="row-sub">
                    {asMoney(rolled.planned, rolled.currency)} · {t('budget.scenarioDelta', {
                      amount: `${delta > 0 ? '+' : ''}${asMoney(delta, rolled.currency)}`,
                    })}
                  </span>
                  {scenario.description && <span className="row-sub">{scenario.description}</span>}
                </div>
                <Button size="sm" onClick={() => onShow(scenario.id)} disabled={showing === scenario.id}>
                  {t('budget.apply')}
                </Button>
                {canWrite && (
                  <>
                    <Button variant="ghost" size="icon" aria-label={t('action.edit')} onClick={() => setEditing(scenario)}>
                      <Icon name="pencil" size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('action.delete')}
                      onClick={async () => {
                        if (await confirm(t('budget.deleteScenario', { name: scenario.name }))) {
                          if (showing === scenario.id) onShow(null);
                          remove('budgetScenario', scenario.id);
                        }
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ScenarioForm
          budget={budget}
          scenario={editing === 'new' ? null : editing}
          lines={lines}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

function ScenarioForm({ budget, scenario, lines, onClose }: {
  budget: Budget;
  scenario: BudgetScenario | null;
  lines: BudgetLine[];
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(scenario?.name ?? '');
  const [description, setDescription] = useState(scenario?.description ?? '');
  const [adjustments, setAdjustments] = useState<ScenarioAdjustment[]>(scenario?.adjustments ?? []);
  const [weights, setWeights] = useState(() => ({
    committed: scenario?.weights?.committed ?? FULL_SHARE,
    likely: scenario?.weights?.likely ?? FULL_SHARE,
    possible: scenario?.weights?.possible ?? FULL_SHARE,
  }));

  const set = (index: number, patch: Partial<ScenarioAdjustment>) =>
    setAdjustments(adjustments.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const save = () => {
    const patch = {
      budget_id: budget.id,
      name: name.trim(),
      description: description.trim() || null,
      adjustments,
      // Written only when it says something. A weights object that carries
      // everything at 100% is the plan as written, and storing it would make
      // every scenario look like it had an opinion about confidence.
      weights: Object.values(weights).every((value) => value === FULL_SHARE) ? null : weights,
    };
    if (scenario) update('budgetScenario', scenario.id, patch);
    else create('budgetScenario', patch);
    onClose();
  };

  return (
    <Sheet
      title={scenario ? t('budget.scenario') : t('budget.addScenario')}
      wide
      onClose={onClose}
      footer={<Button variant="primary" onClick={save} disabled={!name.trim()}>{t('action.save')}</Button>}
    >
      <div className="field">
        <label htmlFor="bs-name">{t('budget.scenarioName')}</label>
        <Input
          id="bs-name"
          autoFocus
          placeholder={t('budget.scenarioNamePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="bs-desc">{t('budget.description')}</label>
        <Textarea id="bs-desc" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>

      <SectionHeading tight>{t('budget.weights')}</SectionHeading>
      <p className="text-[12px] text-muted">{t('budget.weightsHint')}</p>
      <div className="field-row">
        {COST_CONFIDENCE.map((level) => (
          <div className="field flex-1 min-w-0" key={level}>
            <label htmlFor={`bs-w-${level}`}>{t(confidenceKey(level))}</label>
            <Input
              id={`bs-w-${level}`}
              type="number"
              min={0}
              max={100}
              value={Math.round(weights[level] / 100)}
              onChange={(event) => setWeights({ ...weights, [level]: Math.max(0, Number(event.target.value) || 0) * 100 })}
            />
          </div>
        ))}
      </div>

      <SectionHeading tight>{t('budget.adjustment')}</SectionHeading>
      {adjustments.map((adjustment, index) => (
        <div className="adjustment" key={index}>
          <div className="field-row">
            <div className="field flex-1 min-w-0">
              <label htmlFor={`bs-a-${index}`}>{t('budget.adjApplies')}</label>
              <Select
                id={`bs-a-${index}`}
                value={adjustment.line_id ?? (adjustment.category ? `cat:${adjustment.category}` : '')}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith('cat:')) set(index, { line_id: null, category: value.slice(4) as CostCategory });
                  else set(index, { line_id: value || null, category: null });
                }}
              >
                <option value="">{t('budget.adjEveryLine')}</option>
                {COST_CATEGORIES.map((category) => (
                  <option key={category} value={`cat:${category}`}>{t(categoryKey(category))}</option>
                ))}
                {lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
              </Select>
            </div>
            <div className="field flex-1 min-w-0">
              <label htmlFor={`bs-f-${index}`}>{t('budget.adjFactor')} %</label>
              <Input
                id={`bs-f-${index}`}
                type="number"
                min={0}
                value={Math.round((adjustment.factor ?? FULL_SHARE) / 100)}
                onChange={(event) => set(index, { factor: Math.max(0, Number(event.target.value) || 0) * 100 })}
              />
            </div>
            <div className="field flex-1 min-w-0">
              <label htmlFor={`bs-s-${index}`}>{t('budget.adjShift')}</label>
              <Input
                id={`bs-s-${index}`}
                type="number"
                value={adjustment.shift_months ?? 0}
                onChange={(event) => set(index, { shift_months: Number(event.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="field-row items-center">
            <label className="check-row flex-1 min-w-0">
              <input
                type="checkbox"
                checked={!!adjustment.drop}
                onChange={(event) => set(index, { drop: event.target.checked })}
              />
              <span><span>{t('budget.adjDrop')}</span></span>
            </label>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('action.remove')}
              onClick={() => setAdjustments(adjustments.filter((_, at) => at !== index))}
            >
              <Icon name="close" size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button size="sm" onClick={() => setAdjustments([...adjustments, { factor: FULL_SHARE }])}>
        <Icon name="plus" size={13} /> {t('budget.addAdjustment')}
      </Button>
    </Sheet>
  );
}

/* --------------------------------------------------------------- settings */

function BudgetSettings({ budget }: { budget: Budget }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-[720px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <BudgetFields budget={budget} onChange={(patch) => update('budget', budget.id, patch)} disabled={!canWrite} />
      {canWrite && (
        <>
          <SectionHeading>{t('action.delete')}</SectionHeading>
          <Button
            variant="danger"
            onClick={async () => {
              if (!(await confirm(t('budget.deleteBudget', { name: budget.name })))) return;
              remove('budget', budget.id);
              toast(t('budget.deletedToast'));
              navigate('/budgets');
            }}
          >
            <Icon name="trash" size={14} /> {t('action.delete')}
          </Button>
        </>
      )}
      {dialog}
    </div>
  );
}

/** The fields a budget has, shared by the create sheet and the settings tab. */
function BudgetFields({ budget, onChange, disabled }: {
  budget: Partial<Budget>;
  onChange: (patch: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const covered = projects.filter((project) => coversProject(
    { project_id: budget.project_id ?? null, projects: budget.projects ?? [] },
    project.id,
  ));
  const workspaceWide = !budget.project_id && !(budget.projects ?? []).length;

  return (
    <>
      <div className="field">
        <label htmlFor="b-name">{t('budget.name')}</label>
        <Input
          id="b-name"
          disabled={disabled}
          placeholder={t('budget.namePlaceholder')}
          value={budget.name ?? ''}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="b-desc">{t('budget.description')}</label>
        <Textarea
          id="b-desc"
          rows={2}
          disabled={disabled}
          value={budget.description ?? ''}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="b-currency">{t('budget.currency')}</label>
          <Input
            id="b-currency"
            disabled={disabled}
            maxLength={3}
            value={budget.currency ?? 'EUR'}
            onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
          />
          <span className="text-[12px] text-muted">{t('budget.currencyHint')}</span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="b-approved">{t('budget.approved')}</label>
          <MoneyInput
            id="b-approved"
            currency={budget.currency ?? 'EUR'}
            value={budget.approved ?? 0}
            onChange={(approved) => onChange({ approved })}
          />
          <span className="text-[12px] text-muted">{t('budget.approvedHint')}</span>
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="b-from">{t('budget.periodStart')}</label>
          <Input
            id="b-from"
            type="date"
            disabled={disabled}
            value={budget.period_start ?? ''}
            onChange={(event) => onChange({ period_start: event.target.value || null })}
          />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="b-to">{t('budget.periodEnd')}</label>
          <Input
            id="b-to"
            type="date"
            disabled={disabled}
            value={budget.period_end ?? ''}
            onChange={(event) => onChange({ period_end: event.target.value || null })}
          />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="b-status">{t('budget.status')}</label>
          <Select
            id="b-status"
            disabled={disabled}
            value={budget.status ?? 'draft'}
            onChange={(event) => onChange({ status: event.target.value })}
          >
            {BUDGET_STATUS.map((status) => (
              <option key={status} value={status}>{t(`budget.status.${status}` as TranslationKey)}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="field">
        <label>{t('budget.scope')}</label>
        <span className="text-[12px] text-muted">{t('budget.scopeHint')}</span>
        <div className="scope-picker">
          <label className="check-row">
            <input
              type="checkbox"
              disabled={disabled}
              checked={workspaceWide}
              onChange={() => onChange(projectScope({ project: null, projects: [] }))}
            />
            <span><span>{t('budget.scopeWorkspace')}</span></span>
          </label>
          {projects.map((project) => (
            <label className="check-row" key={project.id}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={!workspaceWide && covered.some((row) => row.id === project.id)}
                onChange={(event) => {
                  const picked = new Set(covered.filter(() => !workspaceWide).map((row) => row.id));
                  if (event.target.checked) picked.add(project.id);
                  else picked.delete(project.id);
                  onChange(projectScope({ project: null, projects: [...picked] }));
                }}
              />
              <span><span>{project.name}</span></span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

/** The create sheet. Nothing is written until Save, so an abandoned one leaves nothing. */
function BudgetForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Budget>>(() => ({
    name: '',
    description: '',
    currency: 'EUR',
    approved: 0,
    period_start: `${monthOf(today())}-01`,
    period_end: null,
    status: 'draft',
    project_id: null,
    projects: [],
  }));

  return (
    <Sheet
      title={t('budget.new')}
      wide
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!(draft.name ?? '').trim()}
          onClick={() => {
            const id = create('budget', {
              name: (draft.name ?? '').trim(),
              description: draft.description || null,
              currency: draft.currency ?? 'EUR',
              approved: draft.approved ?? 0,
              period_start: draft.period_start || null,
              period_end: draft.period_end || null,
              status: draft.status ?? 'draft',
              project_id: draft.project_id ?? null,
              projects: draft.projects ?? [],
              archived: 0,
            });
            onClose();
            onSaved(id);
          }}
        >
          {t('action.create')}
        </Button>
      )}
    >
      <BudgetFields budget={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
    </Sheet>
  );
}

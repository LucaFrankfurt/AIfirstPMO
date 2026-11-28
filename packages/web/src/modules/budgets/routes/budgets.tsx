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
import { COST_CATEGORIES, rollUp, type CostCategory, type Minor } from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { Health, SplitBars, Variance, categoryKey, useProjectNames, useRollUp } from '../budget';
import { Stat, statRow } from '../../../kernel/design-system/ui/stat';
import { asMoney } from '../../../kernel/design-system/ui/money';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { list, useQuery, useRow } from '../../../kernel/sync/store';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { TabButton, TabList } from '../../../kernel/design-system/ui/tabs';
import { useCanWrite, useFeature } from '../../../kernel/identity/session';
import { pageBody } from '../../../kernel/design-system/ui/page';
import { DataTable, Td, Th, Tr, cellLink } from '../../../kernel/design-system/ui/data-table';
import { Actuals } from '../actuals';
import { BudgetForm, BudgetSettings } from '../budget-settings';
import { Dashboard } from '../dashboard';
import { Plan } from '../plan';
import { Scenarios } from '../scenarios';

/** The screen every budget route shows when the workspace has not switched it on. */
function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('budget.offTitle')} hint={t('budget.offHint')} />;
}

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
        <div className={pageBody}>
          {/* The list first, then what it adds up to.
              The other way round is how this page shipped, and it reads fine on
              a desktop where the tiles are one compact row — on a phone they
              stack two-by-two and the two charts follow, so the budgets
              themselves began 665 pixels down an 844-pixel screen. Somebody
              opening "Budgets" to open a budget met a page of analysis and
              concluded there were none. A summary is context for a list; it is
              not what an index is for. */}
          <div className="table-wrap">
            <DataTable>
              <thead>
                <tr>
                  <Th>{t('budget.budget')}</Th>
                  <Th>{t('budget.period')}</Th>
                  <Th>{t('budget.status')}</Th>
                  <Th numeric>{t('budget.approved')}</Th>
                  <Th numeric>{t('budget.planned')}</Th>
                  <Th numeric>{t('budget.actual')}</Th>
                  <Th numeric>{t('budget.forecast')}</Th>
                  <Th numeric>{t('budget.variance')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rolled.map(({ budget, totals }) => (
                  <Tr key={budget.id} onClick={() => navigate(`/budgets/${budget.id}`)}>
                    <Td lead>
                      <Link className={cellLink} to={`/budgets/${budget.id}`}>{budget.name}</Link>
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
                    </Td>
                    <Td>{totals.period.from} → {totals.period.to}</Td>
                    <Td>{t(`budget.status.${budget.status}` as TranslationKey)}</Td>
                    <Td numeric>{budget.approved ? asMoney(budget.approved, totals.currency) : '—'}</Td>
                    <Td numeric>{asMoney(totals.planned, totals.currency)}</Td>
                    <Td numeric>{asMoney(totals.actual, totals.currency)}</Td>
                    <Td numeric>{asMoney(totals.forecast, totals.currency)}</Td>
                    <Td numeric><Variance value={totals.variance} currency={totals.currency} /></Td>
                    <Td><Health totals={totals} /></Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          </div>

          {/* `mt-5` rather than `tight`: this is no longer the top of the page. */}
          <SectionHeading>{t('budget.portfolioTitle')}</SectionHeading>
          <p className="text-label text-muted">{t('budget.portfolioHint')}</p>
          {perCurrency.map((row) => (
            <div className={statRow} key={row.currency}>
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
              <div className="rounded border border-line bg-raised p-3.5">
                <h2 className="chart-title">{t('budget.byProject')}</h2>
                <p className="text-label text-muted">{t('budget.byProjectHint')}</p>
                <SplitBars rows={byProject} currency={main} caption={t('budget.byProjectCaption')} unit={t('budget.project')} />
              </div>
            )}
            {byCategory.length > 0 && (
              <div className="rounded border border-line bg-raised p-3.5">
                <h2 className="chart-title">{t('budget.byCategory')}</h2>
                <p className="text-label text-muted">{t('budget.byCategoryHint')}</p>
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
  const navigate = useNavigate();
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
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/budgets', label: t('budget.title'), icon: <Icon name="wallet" size={13} /> }]} />
        </div>
        <Empty
          emoji="🕳️" title={t('project.notFound')} hint={t('project.notFoundHint')}
          action={<Button onClick={() => navigate('/budgets')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  return (
    <>
      <Header title={budget.name}>
        <Chip>{budget.currency}</Chip>
        <Health totals={totals} />
      </Header>

      {/* Above the tabs, for the reason the project and KPI screens put it
          there: the tabs are places inside this budget and the trail is the way
          out of it. */}
      <div className="px-3 pt-3 sm:px-6">
        <Trail parts={[{ to: '/budgets', label: t('budget.title'), icon: <Icon name="wallet" size={13} /> }]} />
      </div>

      <TabList ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {TABS.map((name) => (
          <TabButton
            key={name}
            active={tab === name}
            onClick={() => {
              setTab(name);
              setSearch(name === 'dashboard' ? {} : { tab: name }, { replace: true });
            }}
          >
            {t(TAB_KEY[name])}
          </TabButton>
        ))}
      </TabList>

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

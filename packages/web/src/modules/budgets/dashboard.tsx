/** A budget's first tab: where the money stands, in figures and in charts. */
import { useMemo } from 'react';
import {
  COST_CONFIDENCE, COST_KINDS, byConfidence, byKind, monthOf, rollUp, type Budget,
} from '@kolibri/shared';
import { BurnChart, PlanVsActual, SplitBars, categoryKey, confidenceKey, useProjectNames } from './budget';
import { Stat, statRow } from '../../kernel/design-system/ui/stat';
import { asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { shortDate, today } from '../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { list, useQuery } from '../../kernel/sync/store';
import { pageBody } from '../../kernel/design-system/ui/page';

const monthLabel = (month: string): string => shortDate(`${month}-01`);

export function Dashboard({ budget, totals }: { budget: Budget; totals: ReturnType<typeof rollUp> }) {
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
    <div className={pageBody}>
      <div className={statRow}>
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
      {totals.runRate !== null && <p className="mb-4 text-label text-muted">{t('budget.runRateAside')}</p>}

      <div className={statRow}>
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

      <div className="rounded border border-line bg-raised p-3.5">
        <h2 className="chart-title">{t('budget.burn')}</h2>
        <p className="text-label text-muted">{t('budget.burnHint')}</p>
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

      <div className="rounded border border-line bg-raised p-3.5">
        <h2 className="chart-title">{t('budget.monthly')}</h2>
        <p className="text-label text-muted">{t('budget.monthlyHint')}</p>
        <PlanVsActual
          currency={currency}
          caption={t('budget.monthlyCaption')}
          rows={totals.byMonth.map((row) => ({
            month: row.month, label: monthLabel(row.month), planned: row.planned, actual: row.actual,
          }))}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('budget.byCategory')}</h2>
          <p className="text-label text-muted">{t('budget.byCategoryHint')}</p>
          <SplitBars
            currency={currency}
            caption={t('budget.byCategoryCaption')}
            unit={t('budget.category')}
            rows={totals.byCategory.map((row) => ({
              key: row.key, label: t(categoryKey(row.key)), planned: row.planned, actual: row.actual,
            }))}
          />
        </div>
        <div className="rounded border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('budget.byProject')}</h2>
          <p className="text-label text-muted">{t('budget.byProjectHint')}</p>
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
        <div className="rounded border border-line bg-raised p-3.5">
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
        <div className="rounded border border-line bg-raised p-3.5">
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

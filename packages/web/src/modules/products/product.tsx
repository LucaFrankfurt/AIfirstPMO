/**
 * The catalogue screens' shared parts: what a margin looks like, what a
 * break-even looks like when it cannot be reached, and the one chart a product
 * needs that a budget does not.
 *
 * Every number here comes out of `@kolibri/shared`, computed from the local
 * mirror on every render — no endpoint, no aggregation table, and no arithmetic
 * of its own. The server answers `product_status` and `simulate_product` over
 * MCP from the same functions, so a figure on this screen and a figure an
 * assistant quotes cannot disagree. That mattered immediately: "how much of a
 * quarterly subscription falls into one month" has two plausible readings and
 * two implementations would have picked different ones.
 */
import { useMemo } from 'react';
import {
  catalogue, type CatalogueEntry, type CostBasis, type Minor, type Product,
  type ProductHealth, type Simulation, healthOfProduct, promotionsFor,
} from '@kolibri/shared';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { list, useQuery } from '../../kernel/sync/store';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Table } from '../../kernel/design-system/ui/table';
import { asMoney } from '../../kernel/design-system/ui/money';
import { today } from '../../kernel/design-system/format';

export const basisKey = (basis: string): TranslationKey => `product.basis.${basis}` as TranslationKey;
export const priceKindKey = (kind: string): TranslationKey => `product.priceKind.${kind}` as TranslationKey;
export const statusKey = (status: string): TranslationKey => `product.status.${status}` as TranslationKey;
export const billingKey = (every: string): TranslationKey => `product.billing.${every}` as TranslationKey;
export const renewalKey = (renewal: string): TranslationKey => `product.renewal.${renewal}` as TranslationKey;
export const healthKey = (health: string): TranslationKey => `product.health.${health}` as TranslationKey;
export const phaseKey = (phase: string): TranslationKey => `product.phase.${phase}` as TranslationKey;
export const promoKindKey = (kind: string): TranslationKey => `product.promoKind.${kind}` as TranslationKey;
export const blockedKey = (reason: string): TranslationKey => `product.blocked.${reason}` as TranslationKey;

/**
 * A product's standing, as one of the three colours the budget screens already
 * use.
 *
 * Reusing `health-over`, `health-tight` and `health-healthy` rather than
 * inventing `product-loss` and friends, and not to save three rules: a workspace
 * with both features on shows these chips a scroll apart, and "red means this is
 * going badly" has to mean the same thing on both screens or it means nothing on
 * either.
 *
 * Written out rather than interpolated so `check:css` can see the names. The two
 * states that are not judgements map to nothing on purpose — nobody has priced
 * it, or nobody has costed it, and neither is good news or bad.
 */
const HEALTH_CLASS: Record<ProductHealth, string> = {
  loss: 'health-over',
  thin: 'health-tight',
  unpriced: '',
  no_costs: '',
  healthy: 'health-healthy',
};

export function Health({ entry }: { entry: Pick<CatalogueEntry, 'economics' | 'structure'> }) {
  const t = useT();
  const health = healthOfProduct(entry);
  return <Chip className={HEALTH_CLASS[health]}>{t(healthKey(health))}</Chip>;
}

/**
 * A margin, as a figure and as a word.
 *
 * Colour alone cannot say "this loses money" to somebody who cannot see the
 * colour, which is the same reason `Variance` on the budget screens spells the
 * sign out. A product with no price shows an em dash rather than 0% — the two
 * look identical as a number and are not the same claim.
 */
export function Margin({ marginBps }: { marginBps: number | null }) {
  const t = useT();
  if (marginBps === null) return <span className="money-flat">—</span>;
  const percent = Math.round(marginBps / 100);
  if (marginBps < 0) return <span className="money-over">{percent}% {t('product.atALoss')}</span>;
  return <span className={marginBps < 2000 ? 'money-flat' : 'money-under'}>{percent}%</span>;
}

/**
 * What one unit earns, drawn as the two parts it is made of.
 *
 * A stacked track rather than two bars: the cost is *inside* the price, and
 * putting them side by side invites the reading that the customer pays both.
 * A cost above the price overflows the track deliberately — a loss that fits
 * neatly inside the bar is a loss nobody notices.
 */
export function UnitBar({ price, unitCost, currency }: { price: Minor | null; unitCost: Minor; currency: string }) {
  const t = useT();
  if (price === null) return <span className="money-flat">{t('product.unpriced')}</span>;
  const scale = Math.max(price, unitCost, 1);
  /*
   * The `.bar-row` wrapper is load-bearing, not decoration. `.bar-track` is
   * `flex: 1`, so outside a flex container it has no width at all — which is
   * exactly how this first shipped: the heading rendered, the caption rendered,
   * and between them was nothing. Nothing threw and no test could see it.
   */
  return (
    <div className="bars">
      <div className="bar-row">
        <span className="bar-label">{t('product.contribution')}</span>
        <span className="bar-track split" title={`${asMoney(unitCost, currency)} / ${asMoney(price, currency)}`}>
          <span className="bar-fill" style={{ width: `${(price / scale) * 100}%`, background: 'var(--chart-1)' }} />
          <span className="bar-over" style={{ width: `${(unitCost / scale) * 100}%`, background: 'var(--chart-2)' }} />
        </span>
        <span className="bar-value">{asMoney(Math.max(0, price - unitCost), currency, true)}</span>
      </div>
    </div>
  );
}

/**
 * Cumulative margin over the horizon, with the month it crosses zero marked.
 *
 * Hand-drawn SVG for the reason the budget's burn chart is: a chart you can
 * read is worth more than one you have to trust. The zero line is drawn even
 * when nothing crosses it, because a curve that stays below it is the answer
 * somebody came for and an axis that is not there makes it look like a rise.
 */
export function ProjectionChart({ simulation, caption }: { simulation: Simulation; caption: string }) {
  const t = useT();
  const points = simulation.months;
  if (points.length < 2) return null;

  const values = points.map((row) => row.cumulative);
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const span = Math.max(1, high - low);
  const x = (index: number) => (index / (points.length - 1)) * 100;
  const y = (value: number) => 100 - ((value - low) / span) * 100;

  return (
    <figure className="chart">
      <div className="chart-scale">
        <span>{asMoney(high, simulation.currency, true)}</span>
        <span>{asMoney(low, simulation.currency, true)}</span>
      </div>
      {/*
        * `lines` and `lines-svg` are what give the SVG a box.
        *
        * `.chart-plot` is a flex row with `position: relative`; the stylesheet's
        * `.lines-svg` is what pins the SVG to its corners. Without the pair the
        * SVG has no width, no height and no containing block — and a `viewBox`
        * of 0 0 100 100 with nothing to scale into is drawn at whatever size the
        * page gives it, which is a single line dragged diagonally across the
        * whole screen. It rendered; it was simply not a chart.
        */}
      <div className="chart-plot lines" style={{ height: 180 }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="lines-svg" role="img" aria-label={caption}>
          <line x1="0" y1={y(0)} x2="100" y2={y(0)} stroke="var(--line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <polyline
            points={values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="chart-axis">
        <span className="flex-1">{points[0].month}</span>
        <span style={{ flex: 1, textAlign: 'end' }}>{points[points.length - 1].month}</span>
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('product.month'), t('product.units'), t('product.revenue'), t('product.cost'), t('product.cumulative')]}
        rows={points.map((row) => [
          row.month,
          String(row.units),
          asMoney(row.revenue, simulation.currency),
          asMoney(row.cost, simulation.currency),
          asMoney(row.cumulative, simulation.currency),
        ])}
      />
    </figure>
  );
}

/**
 * How much of a cohort is left, month by month.
 *
 * Bars rather than a line, because the question is "how many are still here in
 * month six" and a bar is something you can count against a row of others. The
 * caption says the model out loud — geometric decay from one number — because a
 * retention curve drawn confidently is the most believable wrong thing on the
 * screen.
 */
export function RetentionBars({ curve, caption }: { curve: number[]; caption: string }) {
  const t = useT();
  if (!curve.length) return null;
  const width = 100 / curve.length;
  return (
    <figure className="chart">
      <div className="chart-plot" style={{ height: 120 }} role="img" aria-label={caption}>
        {curve.map((share, index) => (
          <div key={index} className="col-slot" style={{ width: `${width}%` }}>
            <span className="col-pair">
              <span className="col-bar" style={{ height: `${share / 100}%`, background: 'var(--chart-1)' }} />
            </span>
          </div>
        ))}
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('product.month'), t('product.retained')]}
        rows={curve.map((share, index) => [String(index + 1), `${Math.round(share / 100)}%`])}
      />
    </figure>
  );
}

/* ----------------------------------------------------------------- the data */

/**
 * The whole catalogue out of the local mirror, added up.
 *
 * One hook rather than six `useQuery` calls in each screen, because the index
 * and the detail page both need exactly this and two assemblies of it would be
 * where they came to disagree. The horizon is the caller's for the same reason
 * `catalogue` takes it: a break-even read at twelve months on one screen and at
 * twelve months on another has to be the same number, so neither gets to assume.
 */
export function useCatalogue(options: { months: number; deliveries: number }): {
  entries: CatalogueEntry[];
  today: string;
} {
  const products = useQuery(() => list('product'), []);
  const prices = useQuery(() => list('productPrice'), []);
  const costs = useQuery(() => list('productCost'), []);
  const people = useQuery(() => list('productContributor'), []);
  const parts = useQuery(() => list('productPart'), []);
  const promotions = useQuery(() => list('promotion'), []);
  const day = today();

  return useMemo(() => {
    const by = <T extends { product_id: string }>(rows: T[]): Map<string, T[]> => {
      const out = new Map<string, T[]>();
      for (const row of rows) {
        const listed = out.get(row.product_id) ?? [];
        listed.push(row);
        out.set(row.product_id, listed);
      }
      return out;
    };
    const priceMap = by(prices);
    const costMap = by(costs);
    const peopleMap = by(people);
    // Packages too: a bundle whose parts' costs are left out reads as free.
    const partMap = by(parts);
    return {
      today: day,
      entries: catalogue({
        products,
        pricesOf: (id) => priceMap.get(id) ?? [],
        costsOf: (id) => costMap.get(id) ?? [],
        contributorsOf: (id) => peopleMap.get(id) ?? [],
        partsOf: (id) => partMap.get(id) ?? [],
        promotions,
        months: options.months,
        deliveries: options.deliveries,
        today: day,
      }),
    };
  }, [products, prices, costs, people, parts, promotions, options.months, options.deliveries, day]);
}

/** The campaigns running against a product today, for the chips on its row. */
export function useRunningPromotions(product: Product | undefined): { id: string; name: string }[] {
  const promotions = useQuery(() => list('promotion'), []);
  const day = today();
  return useMemo(
    () => (product ? promotionsFor(promotions, product, day) : []),
    [promotions, product, day],
  );
}

/** Capability ids to names, for the chips a product and a package both show. */
export function useCapabilityNames(): Map<string, string> {
  const rows = useQuery(() => list('productCapability', (row) => !row.archived), []);
  return useMemo(() => new Map(rows.map((row) => [row.id, row.name])), [rows]);
}

/** The three bases, in the order a cost structure reads: fixed first, variable last. */
export const BASES: readonly CostBasis[] = ['period', 'delivery', 'unit'];

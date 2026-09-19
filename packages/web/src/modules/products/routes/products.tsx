/**
 * The catalogue screens: what is sold, what it earns, and what would happen if
 * something changed.
 *
 * Three tabs on the index, in the order somebody uses them — the catalogue is
 * what people come back for, the campaigns are what is being done to it this
 * quarter, and the scenarios are the argument somebody makes about it on a
 * Tuesday. Five on a product, in the order a product is filled in: what it is,
 * what it costs to sell, what it costs to make, what is in it, and what happens
 * next.
 *
 * Everything is read from the local mirror and added up on render, so all of
 * this works offline — the simulation included, which is the whole reason
 * `simulate` is a pure function in `@kolibri/shared` rather than an endpoint.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  COST_BASIS, COST_CATEGORIES, COST_RECURRENCES, DEFAULT_ASSUMPTIONS, PRICE_KINDS,
  PRODUCT_KINDS, PRODUCT_STATUS, PROMOTION_KINDS, PROMOTION_STATUS, RENEWALS,
  assumptionsOf, bundleValue, byGroup, compareOrder, costsByCategory, dayBefore, expectedMonths, orderKey,
  overlappingPrices, priceChangeRefusal, priceFor, priceHistory, promotionPhase, promotionReach,
  raisePrice, retentionCurve, retentionOf, simulate, stackedPromotions,
  type CatalogueEntry, type CostBasis, type Minor, type Product, type ProductAssumptions, type ProductCapability,
  type ProductContributor, type ProductCost, type ProductGroup, type ProductPrice,
  type ProductScenario, type Promotion, type PromotionBreakEven,
} from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import {
  BASES, CURRENCIES, Health, Margin, ProjectionChart, RetentionBars, SCOPE_UNITS, UNIT_SUGGESTIONS, UnitBar,
  basisKey, billingKey, blockedKey, phaseKey, priceKindKey, promoKindKey,
  renewalKey, statusKey, useCapabilityNames, useCatalogue,
} from '../product';
import { Stat } from '../../planning/insights';
import { MoneyInput, asMoney } from '../../../kernel/design-system/ui/money';
import { Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Input, Select, Textarea } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { categoryKey } from '../../budgets/budget';
import { shortDate, today } from '../../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { create, remove, update } from '../../../kernel/sync/mutations';
import { list, useQuery, useRow } from '../../../kernel/sync/store';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { useCanWrite, useFeature } from '../../../kernel/identity/session';

/**
 * Rows in the order somebody put them, with a tie-break that is not chance.
 *
 * The same comparator the budget screens use and for the same reason: rows
 * carrying the schema's default key — which is what anything created over REST
 * or by an import has — would otherwise come out in whatever order the sort
 * happened to leave them, and a different order on the next render.
 */
const byOrder = (a: { sort_order?: string; created_at: number }, b: { sort_order?: string; created_at: number }) =>
  compareOrder(a.sort_order ?? '', b.sort_order ?? '') || a.created_at - b.created_at;

/** The screen every catalogue route shows when the workspace has not switched it on. */
function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('product.offTitle')} hint={t('product.offHint')} />;
}

/**
 * The horizon every figure on these screens is read over.
 *
 * Twelve months and one delivery, which is `DEFAULT_ASSUMPTIONS` — stated here
 * as a reference to it rather than as two literals, because a break-even the
 * screen computes over twelve months and one an assistant computes over
 * something else is the disagreement this whole arrangement exists to prevent.
 */
const HORIZON = { months: DEFAULT_ASSUMPTIONS.months, deliveries: DEFAULT_ASSUMPTIONS.deliveries };

/* ------------------------------------------------------------------ index */

type IndexTab = 'catalogue' | 'promotions' | 'scenarios';
const INDEX_TABS: IndexTab[] = ['catalogue', 'promotions', 'scenarios'];
const INDEX_TAB_KEY: Record<IndexTab, TranslationKey> = {
  catalogue: 'product.tabCatalogue',
  promotions: 'product.tabPromotions',
  scenarios: 'product.tabScenarios',
};

export function ProductIndex() {
  const t = useT();
  const canWrite = useCanWrite();
  const enabled = useFeature('products');
  const [search, setSearch] = useSearchParams();
  const tab = (INDEX_TABS.includes(search.get('tab') as IndexTab) ? search.get('tab') : 'catalogue') as IndexTab;
  const strip = useTabStrip(tab);
  const [creating, setCreating] = useState(false);

  if (!enabled) return <><Header title={t('product.title')} /><SwitchedOff /></>;

  const go = (next: IndexTab) => setSearch({ tab: next }, { replace: true });

  return (
    <>
      <Header title={t('product.title')}>
        {canWrite && tab === 'catalogue' && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('product.new')}</span>
          </Button>
        )}
      </Header>
      <div ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {INDEX_TABS.map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => go(name)}>
            {t(INDEX_TAB_KEY[name])}
          </button>
        ))}
      </div>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {tab === 'catalogue' && <Catalogue />}
        {tab === 'promotions' && <Promotions />}
        {tab === 'scenarios' && <Scenarios />}
      </div>
      {creating && <ProductForm onClose={() => setCreating(false)} />}
    </>
  );
}

/**
 * Every product at once, grouped by family.
 *
 * The totals are per currency rather than one number, because nothing here
 * invents an exchange rate — see `Product.currency`. A workspace with one
 * currency, which is most of them, sees one row and never notices.
 *
 * The headline figure is **contribution per unit summed**, and the tile says so
 * in as many words. It is not revenue and it is not a forecast: it says what one
 * of each would earn, which is the comparison a catalogue makes between two
 * lines of business without anybody having to enter a volume first.
 */
function Catalogue() {
  const t = useT();
  const { entries } = useCatalogue(HORIZON);
  const groups = useQuery(() => list('productGroup', (row) => !row.archived), []);
  /*
   * Archived products are hidden and findable, not gone. Without the toggle the
   * archive is a one-way door: `archived` was read by this filter and set by
   * nothing, so a product made by mistake could only ever be deleted.
   */
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = entries.filter((entry) => entry.product.archived).length;
  const live = entries.filter((entry) => (showArchived ? true : !entry.product.archived));
  const totals = useMemo(() => byGroup(live), [live]);

  const perCurrency = useMemo(() => {
    const out = new Map<string, { currency: string; products: number; unpriced: number; contribution: Minor; monthlyCost: Minor }>();
    for (const row of totals) {
      const bucket = out.get(row.currency)
        ?? { currency: row.currency, products: 0, unpriced: 0, contribution: 0, monthlyCost: 0 };
      bucket.products += row.products;
      bucket.unpriced += row.unpriced;
      bucket.contribution += row.contribution;
      bucket.monthlyCost += row.monthlyCost;
      out.set(row.currency, bucket);
    }
    return [...out.values()].sort((a, b) => b.contribution - a.contribution);
  }, [totals]);

  if (!live.length) {
    /*
     * The way back out has to be *here*, not below.
     *
     * The toggle used to sit at the foot of the table, under an early return
     * that fires exactly when somebody needs it most: archive the last product
     * and the screen says "nothing is being sold yet" with no hint that three
     * products are one click away. An escape hatch below the thing it escapes
     * is not an escape hatch.
     */
    return (
      <Empty
        emoji="🏷️"
        title={archivedCount > 0 ? t('product.allArchived') : t('product.emptyTitle')}
        hint={archivedCount > 0 ? t('product.allArchivedHint', { count: String(archivedCount) }) : t('product.emptyHint')}
        action={archivedCount > 0
          ? <Button onClick={() => setShowArchived(true)}>{t('product.showArchived', { count: String(archivedCount) })}</Button>
          : undefined}
      />
    );
  }

  /* Ungrouped last, and under a heading that says so rather than an empty one. */
  const families = [
    ...groups.map((group) => ({ id: group.id as string | null, name: group.name })),
    ...(live.some((entry) => !entry.product.group_id) ? [{ id: null, name: t('product.ungrouped') }] : []),
  ].filter((family) => live.some((entry) => (entry.product.group_id ?? null) === family.id));

  return (
    <div className="grid gap-3.5">
      {perCurrency.map((row) => (
        <div className="kpi-row" key={row.currency}>
          <Stat label={t('product.countLabel')} value={String(row.products)} hint={row.currency} />
          <Stat
            label={t('product.contributionLabel')}
            value={asMoney(row.contribution, row.currency, true)}
            hint={t('product.contributionHint')}
          />
          <Stat
            label={t('product.monthlyCostLabel')}
            value={asMoney(row.monthlyCost, row.currency, true)}
            hint={t('product.monthlyCostHint')}
          />
          {/* Only where there are any. A tile reading "0 unpriced" is a tile
              spent on the absence of a problem. */}
          {row.unpriced > 0 && (
            <Stat label={t('product.unpricedLabel')} value={String(row.unpriced)} hint={t('product.unpricedHint')} />
          )}
        </div>
      ))}

      {families.map((family) => (
        <div key={family.id ?? 'none'}>
          <SectionHeading>{family.name}</SectionHeading>
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>{t('product.name')}</th>
                  {/*
                    * The price and the standing are *not* `narrow`, and the
                    * other three are. A phone drops every column marked narrow —
                    * "the ones that are only useful for comparing", says the
                    * stylesheet — and marking all five left a catalogue that was
                    * a list of names and nothing else. The price and the verdict
                    * are the two somebody would read out loud.
                    */}
                  <th>{t('product.price')}</th>
                  <th className="narrow">{t('product.unitCost')}</th>
                  <th className="narrow">{t('product.margin')}</th>
                  <th className="narrow">{t('product.breakEven')}</th>
                  <th>{t('product.healthLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {live.filter((entry) => (entry.product.group_id ?? null) === family.id)
                  .sort((a, b) => (b.economics.contribution ?? 0) - (a.economics.contribution ?? 0))
                  .map((entry) => (
                    <tr key={entry.product.id}>
                      <td>
                        <Link className="cell-link" to={`/products/${entry.product.id}`}>{entry.product.name}</Link>
                        {entry.product.kind === 'bundle' && <> <Chip>{t('product.package')}</Chip></>}
                        {entry.product.status !== 'active' && <> <Chip>{t(statusKey(entry.product.status))}</Chip></>}
                        {/* A campaign is the one thing that makes today's price
                            different from the one in the column beside it. */}
                        {entry.promotions.length > 0 && entry.promoted !== null && (
                          <> <Chip>{asMoney(entry.promoted, entry.economics.currency, true)}</Chip></>
                        )}
                        {/* Which periods it is actually sold in. A product with
                            three prices used to show one number and say nothing
                            about which of the three it was. */}
                        {entry.periods.map((every) => (
                          <span key={every}> <Chip>{t(billingKey(every))}</Chip></span>
                        ))}
                        {/* And on what commitment. `periods` answers how often
                            it is billed, which for three subscription prices is
                            "monthly" three times over — the thing that tells
                            them apart is what the customer signs. One term is
                            the ordinary case and adds nothing, so it is only
                            said when there is a choice to be seen.

                            `narrow` on the chips rather than on a column,
                            because they live inside the name. Spelled out on a
                            360px screen they made this cell 363px wide on its
                            own and pushed the price off the side entirely —
                            information added by taking the subject away. The
                            span in the next column is the same fact said
                            short, so the phone keeps that one. */}
                        {entry.terms.length > 1 && (
                          <span className="narrow">
                            {entry.terms.map(({ months }) => (
                              <span key={months}> <Chip>{termChip(t, months)}</Chip></span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>
                        {entry.economics.price === null
                          ? <span className="money-flat">—</span>
                          /* The span when the commitment moves the price, because
                             the single figure was the shortest term — the dearest
                             of them, and the only one a customer can decline. The
                             columns beside it are still figured from that one:
                             the cheaper prices are an offer, not a forecast. */
                          : entry.terms.length > 1
                            ? t('product.priceSpan', {
                              low: asMoney(entry.terms[entry.terms.length - 1]!.amount, entry.economics.currency, true),
                              high: asMoney(entry.terms[0]!.amount, entry.economics.currency, true),
                            })
                            : asMoney(entry.economics.price, entry.economics.currency, true)}
                      </td>
                      <td className="narrow">{asMoney(entry.economics.unitCost, entry.economics.currency, true)}</td>
                      <td className="narrow"><Margin marginBps={entry.economics.marginBps} /></td>
                      <td className="narrow">
                        {entry.breakEven.units === null
                          ? <span className="money-flat">{t(blockedKey(entry.breakEven.blocked ?? 'no_price'))}</span>
                          : (
                            <span className={entry.breakEven.reachable ? '' : 'money-over'}>
                              {t('product.breakEvenUnits', { units: String(entry.breakEven.units) })}
                            </span>
                          )}
                      </td>
                      <td><Health entry={entry} /></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="text-[12px] text-muted">{t('product.horizonNote', { months: String(HORIZON.months) })}</p>
      {archivedCount > 0 && (
        <label className="check-row">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <span><span>{t('product.showArchived', { count: String(archivedCount) })}</span></span>
        </label>
      )}
      <GroupAdmin groups={groups} />
    </div>
  );
}

/** The families, edited where they are used rather than in a settings screen. */
function GroupAdmin({ groups }: { groups: ProductGroup[] }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState('');
  if (!canWrite) return null;

  return (
    <div>
      <SectionHeading>{t('product.groups')}</SectionHeading>
      <p className="text-[12px] text-muted">{t('product.groupsHint')}</p>
      <div className="flex flex-wrap gap-2 pt-2">
        {groups.map((group) => (
          <span className="flex items-center gap-1" key={group.id}>
            <Chip>{group.name}</Chip>
            {/* A `Button` rather than a bare `<button>` with an icon in it: the
                bare one measured 11×11, which is under half the 24px WCAG 2.2
                asks for and is the shape `check:a11y` exists to catch. */}
            <Button
              variant="ghost"
              size="iconSm"
              title={t('product.removeGroup', { name: group.name })}
              aria-label={t('product.removeGroup', { name: group.name })}
              onClick={async () => {
                if (await confirm(t('product.removeGroupHint', { name: group.name }))) {
                  remove('productGroup', group.id);
                }
              }}
            >
              <Icon name="close" size={13} />
            </Button>
          </span>
        ))}
      </div>
      <div className="field-row pt-2">
        <Input
          className="flex-1 min-w-0"
          value={name}
          placeholder={t('product.groupName')}
          aria-label={t('product.groupName')}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          disabled={!name.trim()}
          onClick={() => {
            create('productGroup', { name: name.trim(), archived: 0, sort_order: orderKey() });
            setName('');
          }}
        >
          {t('action.add')}
        </Button>
      </div>
      {dialog}
    </div>
  );
}

/* -------------------------------------------------------------- promotions */

function Promotions() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const promotions = useQuery(() => list('promotion'), []);
  const products = useQuery(() => list('product'), []);
  const groups = useQuery(() => list('productGroup'), []);
  const [editing, setEditing] = useState<Promotion | null | undefined>(undefined);
  const [opened, setOpened] = useState<Promotion | null>(null);
  const day = today();

  /* Two campaigns live on one product at once are applied one after the other
     by `promotedPrice` — deliberately, and invisibly. Reported here for the
     same reason overlapping prices are reported one floor down. */
  const stacked = useMemo(() => stackedPromotions(promotions, products), [promotions, products]);

  const named = useMemo(() => {
    const out = new Map<string, string>();
    for (const row of products) out.set(row.id, row.name);
    for (const row of groups) out.set(row.id, row.name);
    return out;
  }, [products, groups]);

  return (
    <div className="grid gap-3.5">
      {canWrite && (
        <div>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> {t('product.newPromotion')}
          </Button>
        </div>
      )}
      {stacked.length > 0 && (
        <p className="notice-warn">
          {t('product.promoStacked', {
            count: String(stacked.length),
            products: [...new Set(stacked.flatMap((pair) => pair.products.map((row) => row.name)))].join(', '),
          })}
        </p>
      )}
      {!promotions.length ? (
        <Empty emoji="📣" title={t('product.noPromotions')} hint={t('product.noPromotionsHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('product.name')}</th>
                <th>{t('product.promoValue')}</th>
                <th className="narrow">{t('product.appliesTo')}</th>
                <th className="narrow">{t('product.window')}</th>
                <th className="narrow">{t('product.spend')}</th>
                <th>{t('product.phaseLabel')}</th>
                {canWrite && <th className="actions" />}
              </tr>
            </thead>
            <tbody>
              {[...promotions].sort(byOrder).map((promotion) => {
                const covered = [...promotion.products, ...promotion.groups];
                return (
                  <tr key={promotion.id}>
                    <td>
                      {/* The name is the way in. Everything computed about a
                          campaign is per covered product, which is a table,
                          and a table does not fit in a cell. */}
                      <button type="button" className="cell-link" onClick={() => setOpened(promotion)}>
                        {promotion.name}
                      </button>
                    </td>
                    <td>
                      {promotion.kind === 'percent'
                        ? `${promotion.value / 100}%`
                        : asMoney(promotion.value, promotion.currency, true)}
                      {' '}<span className="text-[11px] text-muted">{t(promoKindKey(promotion.kind))}</span>
                    </td>
                    <td className="narrow">
                      {/* Both lists empty is the whole catalogue, which is a
                          claim worth spelling out — an empty cell would read as
                          "nothing", which is the opposite. */}
                      {covered.length
                        ? covered.map((id) => named.get(id) ?? id).join(', ')
                        : <span className="text-muted">{t('product.wholeCatalogue')}</span>}
                    </td>
                    <td className="narrow">
                      {promotion.starts_on ? shortDate(promotion.starts_on) : '…'}
                      {' → '}
                      {promotion.ends_on ? shortDate(promotion.ends_on) : '…'}
                    </td>
                    <td className="narrow">{asMoney(promotion.spend, promotion.currency, true)}</td>
                    <td><Chip>{t(phaseKey(promotionPhase(promotion, day)))}</Chip></td>
                    {canWrite && (
                      <td className="actions">
                        <MenuButton
                          variant="ghost" size="iconSm"
                          label={t('common.moreActions')}
                          items={[
                          { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(promotion) },
                          {
                            id: 'delete',
                            label: t('action.delete'),
                            danger: true,
                            onSelect: async () => { if (await confirm(t('product.removePromotionHint'))) remove('promotion', promotion.id); },
                          },
                          ]}
                        >
                          <Icon name="dots" size={14} />
                        </MenuButton>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined && (
        <PromotionForm promotion={editing} products={products} groups={groups} onClose={() => setEditing(undefined)} />
      )}
      {opened && <PromotionDetail promotion={opened} onClose={() => setOpened(null)} />}
      {dialog}
    </div>
  );
}

/**
 * What a campaign actually does, per product it touches.
 *
 * The list row says a percentage and a window; this says 64 € becomes 32 €,
 * that it gives away 32 € a sale, and at what volume it starts paying for
 * itself. Per product rather than as one total, because a campaign covering
 * four products discounts four different prices and the sum of them is a
 * figure nobody can act on without a volume mix nothing here records.
 */
function PromotionDetail({ promotion, onClose }: { promotion: Promotion; onClose: () => void }) {
  const t = useT();
  const { entries, today: day } = useCatalogue({ months: 12, deliveries: 1 });
  const prices = useQuery(() => list('productPrice'), []);

  const reached = useMemo(() => {
    const pricesOf = new Map<string, ProductPrice[]>();
    for (const price of prices) {
      const listed = pricesOf.get(price.product_id) ?? [];
      listed.push(price);
      pricesOf.set(price.product_id, listed);
    }
    const costs = new Map(entries.map((entry) => [entry.product.id, entry.structure.unit]));
    return promotionReach({
      promotion,
      products: entries.map((entry) => entry.product),
      pricesOf: (id) => pricesOf.get(id) ?? [],
      unitCostOf: (id) => costs.get(id) ?? 0,
      on: day,
    });
  }, [promotion, entries, prices, day]);

  return (
    <Sheet title={promotion.name} onClose={onClose} wide>
      <p className="text-[12.5px] text-muted">{t('product.promoDetailHint')}</p>
      {!reached.length ? (
        <p className="notice-warn">{t('product.promoReachesNothing')}</p>
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('product.product')}</th>
                <th className="narrow">{t('product.listPrice')}</th>
                <th className="narrow">{t('product.withPromo')}</th>
                <th className="narrow">{t('product.givenAway')}</th>
                <th>{t('product.paysFrom')}</th>
              </tr>
            </thead>
            <tbody>
              {reached.map((row) => (
                <tr key={row.product.id}>
                  <td>{row.product.name}</td>
                  <td className="narrow">{row.list === null ? '—' : asMoney(row.list, row.product.currency)}</td>
                  <td className="narrow">{row.promoted === null ? '—' : asMoney(row.promoted, row.product.currency)}</td>
                  <td className="narrow">
                    {row.list === null ? '—' : (
                      /* Flat, not red: a discount given is not an overrun, and
                         whether it is bad news depends on what it buys. */
                      <span className="money-flat">
                        −{asMoney(row.discount, row.product.currency)}
                        {row.discountBps !== null && ` (${Math.round(row.discountBps / 100)}%)`}
                      </span>
                    )}
                  </td>
                  <td>{payback(t, row.breakEven)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[12.5px] text-muted">
        {t('product.promoAssumption', {
          uplift: String(Math.round(promotion.uplift_bps / 100)),
          spend: asMoney(promotion.spend, promotion.currency, true),
        })}
      </p>
    </Sheet>
  );
}

/**
 * The break-even as a sentence, because two of its three answers are not numbers.
 *
 * It names no unit. `unit_label` is a word the organisation typed, in the
 * singular — "Platz", "Lizenz", "Tag" — and "ab 45 Platz im Monat" is what
 * putting it after a count reads as. No locale here can decline a word it was
 * handed, so the sentence is written not to need one.
 */
function payback(t: ReturnType<typeof useT>, answer: PromotionBreakEven): string {
  if (answer.kind === 'always') return t('product.paysAlways');
  if (answer.kind === 'never') {
    return t(answer.why === 'no-price' ? 'product.paysNoPrice'
      : answer.why === 'no-uplift' ? 'product.paysNoUplift'
        : 'product.paysNeverSmall');
  }
  return t('product.paysAbove', { units: String(answer.units) });
}

function PromotionForm({ promotion, products, groups, onClose }: {
  promotion: Promotion | null;
  products: Product[];
  groups: ProductGroup[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({
    name: promotion?.name ?? '',
    description: promotion?.description ?? '',
    kind: promotion?.kind ?? 'percent',
    value: promotion?.value ?? 0,
    starts_on: promotion?.starts_on ?? '',
    ends_on: promotion?.ends_on ?? '',
    products: promotion?.products ?? [],
    groups: promotion?.groups ?? [],
    spend: promotion?.spend ?? 0,
    uplift: promotion?.uplift_bps ?? 0,
    status: promotion?.status ?? 'draft',
    currency: promotion?.currency ?? 'EUR',
  });

  const toggle = (field: 'products' | 'groups', id: string) => setForm({
    ...form,
    [field]: form[field].includes(id) ? form[field].filter((row) => row !== id) : [...form[field], id],
  });

  return (
    <Sheet
      title={promotion ? t('product.editPromotion') : t('product.newPromotion')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const patch = {
              name: form.name.trim(),
              description: form.description.trim() || null,
              kind: form.kind,
              value: form.value,
              starts_on: form.starts_on || null,
              ends_on: form.ends_on || null,
              products: form.products,
              groups: form.groups,
              spend: form.spend,
              uplift_bps: form.uplift,
              status: form.status,
              currency: form.currency,
            };
            if (promotion) update('promotion', promotion.id, patch);
            else create('promotion', { ...patch, sort_order: orderKey() });
            toast(t('product.promotionSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field">
        <label htmlFor="pm-name">{t('product.name')}</label>
        <Input id="pm-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="pm-desc">{t('product.description')}</label>
        <Textarea id="pm-desc" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pm-kind">{t('product.promoKindLabel')}</label>
          <Select id="pm-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Promotion['kind'], value: 0 })}>
            {PROMOTION_KINDS.map((kind) => <option key={kind} value={kind}>{t(promoKindKey(kind))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pm-value">{t('product.promoValue')}</label>
          {/* A percentage is basis points and money is minor units, so the two
              take different inputs. One box that guessed from the kind is how
              "20" becomes twenty cents off. */}
          {form.kind === 'percent' ? (
            <Input
              id="pm-value"
              type="number"
              min={0}
              max={100}
              value={form.value / 100}
              onChange={(event) => setForm({ ...form, value: Math.round(Number(event.target.value) * 100) })}
            />
          ) : (
            <MoneyInput id="pm-value" value={form.value} currency={form.currency} onChange={(value) => setForm({ ...form, value })} />
          )}
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pm-from">{t('product.startsOn')}</label>
          <Input id="pm-from" type="date" value={form.starts_on} onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pm-to">{t('product.endsOn')}</label>
          <Input id="pm-to" type="date" value={form.ends_on} onChange={(event) => setForm({ ...form, ends_on: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>{t('product.appliesTo')}</label>
        <span className="text-[12px] text-muted">{t('product.appliesToHint')}</span>
        <div className="flex flex-wrap gap-2 pt-1">
          {groups.map((group) => (
            <Chip
              key={group.id}
              tone={form.groups.includes(group.id) ? 'on' : 'default'}
              interactive
              onClick={() => toggle('groups', group.id)}
            >
              {group.name}
            </Chip>
          ))}
          {products.map((product) => (
            <Chip
              key={product.id}
              tone={form.products.includes(product.id) ? 'on' : 'default'}
              interactive
              onClick={() => toggle('products', product.id)}
            >
              {product.name}
            </Chip>
          ))}
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pm-spend">{t('product.spend')}</label>
          <MoneyInput id="pm-spend" value={form.spend} currency={form.currency} onChange={(spend) => setForm({ ...form, spend })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pm-uplift">{t('product.uplift')}</label>
          <Input
            id="pm-uplift"
            type="number"
            value={form.uplift / 100}
            onChange={(event) => setForm({ ...form, uplift: Math.round(Number(event.target.value) * 100) })}
          />
          <span className="text-[12px] text-muted">{t('product.upliftHint')}</span>
        </div>
      </div>
      <div className="field">
        <label htmlFor="pm-status">{t('product.statusLabel')}</label>
        <Select id="pm-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Promotion['status'] })}>
          {PROMOTION_STATUS.map((status) => (
            <option key={status} value={status}>{t(phaseKey(status))}</option>
          ))}
        </Select>
        <span className="text-[12px] text-muted">{t('product.statusHint')}</span>
      </div>
    </Sheet>
  );
}

/* --------------------------------------------------------------- scenarios */

function Scenarios() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const scenarios = useQuery(() => list('productScenario'), []);
  const products = useQuery(() => list('product'), []);
  const [editing, setEditing] = useState<ProductScenario | null | undefined>(undefined);
  const names = useMemo(() => new Map(products.map((row) => [row.id, row.name])), [products]);

  return (
    <div className="grid gap-3.5">
      <p className="text-[12px] text-muted">{t('product.scenariosHint')}</p>
      {canWrite && (
        <div>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> {t('product.newScenario')}
          </Button>
        </div>
      )}
      {!scenarios.length ? (
        <Empty emoji="🔮" title={t('product.noScenarios')} hint={t('product.noScenariosHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('product.name')}</th>
                <th>{t('product.scenarioProduct')}</th>
                <th>{t('product.months')}</th>
                <th>{t('product.units')}</th>
                {canWrite && <th className="actions" />}
              </tr>
            </thead>
            <tbody>
              {[...scenarios].sort(byOrder).map((scenario) => {
                const settled = assumptionsOf(scenario.assumptions);
                return (
                  <tr key={scenario.id}>
                    <td>
                      {scenario.product_id
                        ? <Link className="cell-link" to={`/products/${scenario.product_id}?tab=simulation&scenario=${scenario.id}`}>{scenario.name}</Link>
                        : scenario.name}
                    </td>
                    <td>{scenario.product_id ? names.get(scenario.product_id) ?? '—' : t('product.wholeCatalogue')}</td>
                    <td>{settled.months}</td>
                    <td>{settled.units}</td>
                    {canWrite && (
                      <td className="actions">
                        <MenuButton
                          variant="ghost" size="iconSm"
                          label={t('common.moreActions')}
                          items={[
                          { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(scenario) },
                          {
                            id: 'delete',
                            label: t('action.delete'),
                            danger: true,
                            onSelect: async () => { if (await confirm(t('product.removeScenarioHint'))) remove('productScenario', scenario.id); },
                          },
                          ]}
                        >
                          <Icon name="dots" size={14} />
                        </MenuButton>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined && (
        <ScenarioForm scenario={editing} products={products} onClose={() => setEditing(undefined)} />
      )}
      {dialog}
    </div>
  );
}

function ScenarioForm({ scenario, products, productId, assumptions, onClose }: {
  scenario: ProductScenario | null;
  products: Product[];
  productId?: string;
  /**
   * What to start from when there is no scenario yet.
   *
   * This is what "save as a scenario" means on the simulation tab: somebody has
   * spent five minutes arriving at a set of numbers, and a form that opened on
   * the defaults would throw all of it away while looking like it had not.
   */
  assumptions?: ProductAssumptions;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const promotions = useQuery(() => list('promotion'), []);
  const settled = assumptionsOf(scenario?.assumptions ?? assumptions);
  const [form, setForm] = useState({
    name: scenario?.name ?? '',
    product_id: scenario?.product_id ?? productId ?? '',
    ...settled,
  });

  return (
    <Sheet
      title={scenario ? t('product.editScenario') : t('product.newScenario')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const assumptions: ProductAssumptions = {
              months: form.months,
              units: form.units,
              growth_bps: form.growth_bps,
              price_bps: form.price_bps,
              cost_bps: form.cost_bps,
              deliveries: form.deliveries,
              promotions: form.promotions,
              churn_bps: form.churn_bps,
            };
            const patch = { name: form.name.trim(), product_id: form.product_id || null, assumptions };
            if (scenario) update('productScenario', scenario.id, patch);
            else create('productScenario', { ...patch, description: null, sort_order: orderKey() });
            toast(t('product.scenarioSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field">
        <label htmlFor="sc-name">{t('product.name')}</label>
        <Input id="sc-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="sc-product">{t('product.scenarioProduct')}</label>
        <Select id="sc-product" value={form.product_id} onChange={(event) => setForm({ ...form, product_id: event.target.value })}>
          <option value="">{t('product.wholeCatalogue')}</option>
          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </Select>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="sc-months">{t('product.months')}</label>
          <Input id="sc-months" type="number" min={1} max={120} value={form.months}
            onChange={(event) => setForm({ ...form, months: Number(event.target.value) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="sc-units">{t('product.unitsFirstMonth')}</label>
          <Input id="sc-units" type="number" min={0} value={form.units}
            onChange={(event) => setForm({ ...form, units: Number(event.target.value) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="sc-deliveries">{t('product.deliveries')}</label>
          <Input id="sc-deliveries" type="number" min={0} value={form.deliveries}
            onChange={(event) => setForm({ ...form, deliveries: Number(event.target.value) })} />
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="sc-growth">{t('product.growth')}</label>
          <Input id="sc-growth" type="number" value={form.growth_bps / 100}
            onChange={(event) => setForm({ ...form, growth_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="sc-price">{t('product.priceChange')}</label>
          <Input id="sc-price" type="number" value={form.price_bps / 100}
            onChange={(event) => setForm({ ...form, price_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="sc-cost">{t('product.costChange')}</label>
          <Input id="sc-cost" type="number" value={form.cost_bps / 100}
            onChange={(event) => setForm({ ...form, cost_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="sc-churn">{t('product.churnOverride')}</label>
        <Input
          id="sc-churn"
          type="number"
          min={0}
          max={100}
          value={form.churn_bps === null ? '' : form.churn_bps / 100}
          placeholder={t('product.churnOwn')}
          onChange={(event) => setForm({
            ...form,
            churn_bps: event.target.value === '' ? null : Math.round(Number(event.target.value) * 100),
          })}
        />
      </div>
      <div className="field">
        <label>{t('product.campaignsApplied')}</label>
        <div className="flex flex-wrap gap-2 pt-1">
          {promotions.map((promotion) => (
            <Chip
              key={promotion.id}
              tone={form.promotions.includes(promotion.id) ? 'on' : 'default'}
              interactive
              onClick={() => setForm({
                ...form,
                promotions: form.promotions.includes(promotion.id)
                  ? form.promotions.filter((id) => id !== promotion.id)
                  : [...form.promotions, promotion.id],
              })}
            >
              {promotion.name}
            </Chip>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------------- detail */

type Tab = 'overview' | 'prices' | 'costs' | 'package' | 'simulation';
const TABS: Tab[] = ['overview', 'prices', 'costs', 'package', 'simulation'];
const TAB_KEY: Record<Tab, TranslationKey> = {
  overview: 'product.tabOverview',
  prices: 'product.tabPrices',
  costs: 'product.tabCosts',
  package: 'product.tabPackage',
  simulation: 'product.tabSimulation',
};

export function ProductDetail() {
  const t = useT();
  const navigate = useNavigate();
  const enabled = useFeature('products');
  const { id = '' } = useParams();
  const product = useRow('product', id);
  const [search, setSearch] = useSearchParams();
  const tab = (TABS.includes(search.get('tab') as Tab) ? search.get('tab') : 'overview') as Tab;
  const strip = useTabStrip(tab);
  const { entries } = useCatalogue(HORIZON);
  const entry = entries.find((row) => row.product.id === id);

  if (!enabled) return <><Header title={t('product.title')} /><SwitchedOff /></>;
  if (!product || !entry) {
    return (
      <>
        <Header title={t('product.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/products', label: t('product.title'), icon: <Icon name="tag" size={13} /> }]} />
        </div>
        <Empty
          emoji="🏷️" title={t('product.gone')}
          action={<Button onClick={() => navigate('/products')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const go = (next: Tab) => setSearch({ tab: next }, { replace: true });

  return (
    <>
      <Header title={product.name}><Health entry={entry} /></Header>
      {/* Above the tabs: the tabs are places inside this product, the trail is
          the way out of it, and mixing the two would read as a sixth tab. */}
      <div className="px-3 pt-3 sm:px-6">
        <Trail parts={[{ to: '/products', label: t('product.title'), icon: <Icon name="tag" size={13} /> }]} />
      </div>
      <div ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {TABS.map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => go(name)}>
            {t(TAB_KEY[name])}
          </button>
        ))}
      </div>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {tab === 'overview' && <Overview product={product} entry={entry} />}
        {tab === 'prices' && <Prices product={product} />}
        {tab === 'costs' && <Costs product={product} />}
        {tab === 'package' && <Package product={product} entry={entry} />}
        {tab === 'simulation' && <SimulationTab product={product} />}
      </div>
    </>
  );
}

function Overview({ product, entry }: { product: Product; entry: CatalogueEntry }) {
  const t = useT();
  const canWrite = useCanWrite();
  const toast = useToast();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState(false);
  const capabilities = useCapabilityNames();
  const contributors = useQuery(() => list('productContributor', (row) => row.product_id === product.id), [product.id]);
  const currency = entry.economics.currency;
  const retention = entry.retention;
  const curve = useMemo(
    () => (product.renewal === 'none' ? [] : retentionCurve(product.churn_bps, 12)),
    [product.renewal, product.churn_bps],
  );
  /** The price row the tiles above are quoting, so they can name its period. */
  const prices = useQuery(() => list('productPrice', (row) => row.product_id === product.id), [product.id]);
  const quoted = useMemo(() => priceFor(prices, { on: today() }), [prices]);

  return (
    <div className="grid gap-3.5">
      {product.description && <p className="text-[13px] text-muted">{product.description}</p>}

      <div className="kpi-row">
        {/*
          * The period is part of the figure, not decoration.
          *
          * Without it the tile read "490,00 € je Lizenz" beside a lifetime value
          * of 489,96 € and looked like a contradiction: the 490 is a *year* and
          * the lifetime is twelve months of it. A price with no period on it is
          * a number the reader has to guess the denominator of.
          */}
        <Stat
          label={t('product.price')}
          value={entry.economics.price === null ? '—' : asMoney(entry.economics.price, currency)}
          hint={[
            product.unit_label ? t('product.perUnit', { unit: product.unit_label }) : null,
            quoted ? t(billingKey(quoted.recurrence)).toLocaleLowerCase() : null,
          ].filter(Boolean).join(' · ') || undefined}
        />
        <Stat label={t('product.unitCost')} value={asMoney(entry.economics.unitCost, currency)} hint={t('product.unitCostHint')} />
        <Stat
          label={t('product.contribution')}
          value={entry.economics.contribution === null ? '—' : asMoney(entry.economics.contribution, currency)}
          hint={entry.economics.marginBps === null ? undefined : t('product.marginHint', { percent: String(Math.round(entry.economics.marginBps / 100)) })}
        />
        <Stat
          label={t('product.scope')}
          value={product.scope_amount ? `${product.scope_amount} ${product.scope_unit ?? ''}`.trim() : '—'}
          hint={product.capacity ? t('product.capacityHint', { capacity: String(product.capacity) }) : undefined}
        />
      </div>

      {entry.periods.length > 0 && (
        <p className="text-[12.5px] text-muted">
          {t('product.periods')}: {entry.periods.map((every) => t(billingKey(every))).join(' · ')}
        </p>
      )}
      {entry.mixed && <p className="notice-warn">{t('product.mixedPeriods')}</p>}

      <div>
        <SectionHeading>{t('product.unitPicture')}</SectionHeading>
        <UnitBar price={entry.economics.price} unitCost={entry.economics.unitCost} currency={currency} />
        <p className="text-[12px] text-muted">{t('product.unitPictureHint')}</p>
      </div>

      <div>
        <SectionHeading>{t('product.breakEven')}</SectionHeading>
        {entry.breakEven.units === null ? (
          <p className="notice-warn">{t(blockedKey(entry.breakEven.blocked ?? 'no_price'))}</p>
        ) : (
          <>
            <p className="text-[13px]">
              {/* `count` is what picks the plural form; the catalogue has had
                  `Intl.PluralRules` all along and this sentence was not using
                  it, so a product covered by one sale read "1 Einheiten". */}
              {t('product.breakEvenSentence', {
                count: entry.breakEven.units ?? 0,
                units: String(entry.breakEven.units),
                fixed: asMoney(entry.breakEven.fixed, currency),
                months: String(HORIZON.months),
              })}
            </p>
            {!entry.breakEven.reachable && <p className="notice-warn">{t('product.blocked.over_capacity')}</p>}
          </>
        )}
      </div>

      <div>
        <SectionHeading>{t('product.capabilities')}</SectionHeading>
        <div className="flex flex-wrap gap-2">
          {(product.capabilities ?? []).map((capabilityId) => (
            <Chip key={capabilityId}>{capabilities.get(capabilityId) ?? t('product.unknownCapability')}</Chip>
          ))}
          {!(product.capabilities ?? []).length && <span className="text-[12px] text-muted">{t('product.noCapabilities')}</span>}
        </div>
      </div>

      <Contributors product={product} contributors={contributors} />

      <div>
        <SectionHeading>{t('product.retention')}</SectionHeading>
        {product.renewal === 'none' ? (
          <p className="text-[12.5px] text-muted">{t('product.retentionOneOff')}</p>
        ) : (
          <>
            <div className="kpi-row">
              <Stat
                label={t('product.expectedMonths')}
                value={retention.months === null ? '—' : String(Math.round(retention.months))}
                hint={product.churn_bps ? t('product.churnHint', { percent: String(product.churn_bps / 100) }) : t('product.noChurn')}
              />
              <Stat
                label={t('product.lifetimeValue')}
                value={retention.value === null ? '—' : asMoney(retention.value, currency)}
                hint={t('product.lifetimeValueHint')}
              />
              <Stat
                label={t('product.payback')}
                value={retention.payback === null ? '—' : t('product.paybackMonths', { months: String(retention.payback) })}
                hint={t('product.paybackHint', { cost: asMoney(product.acquisition_cost, currency) })}
              />
            </div>
            {/* The two disagreeing is the thing to look at, and the figure
                above no longer hides it: a twelve-month contract against 10%
                monthly churn used to read "stays 10 months". */}
            {retention.cappedByTerm && (
              <p className="notice-warn">
                {t('product.cappedByTerm', {
                  churn: String(Math.round(expectedMonths(product.churn_bps) ?? 0)),
                  term: String(product.term_months),
                })}
              </p>
            )}
            {curve.length > 0 && <RetentionBars curve={curve} caption={t('product.retentionCaption')} />}
          </>
        )}
      </div>

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(true)}>{t('product.edit')}</Button>
          {/*
            * Archiving and retiring are two different sentences and the product
            * carries both. `status: retired` says it is no longer sold and its
            * figures still count — a fact about the product. `archived` says
            * take it off my screen — a fact about the reader. Budgets carry the
            * same pair, and a product that had neither could only be deleted.
            */}
          <Button onClick={() => {
            update('product', product.id, { archived: product.archived ? 0 : 1 });
            toast(t(product.archived ? 'product.unarchived' : 'product.archived'));
          }}
          >
            {t(product.archived ? 'product.unarchive' : 'product.archive')}
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (!(await confirm(t('product.removeHint', { name: product.name })))) return;
              remove('product', product.id);
              toast(t('product.removed'));
              navigate('/products');
            }}
          >
            {t('action.delete')}
          </Button>
        </div>
      )}
      {editing && <ProductForm product={product} onClose={() => setEditing(false)} />}
      {dialog}
    </div>
  );
}

/** The external speakers and subcontractors, with what they are paid. */
function Contributors({ product, contributors }: { product: Product; contributors: ProductContributor[] }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<ProductContributor | null | undefined>(undefined);

  return (
    <div>
      <SectionHeading>{t('product.contributors')}</SectionHeading>
      <p className="text-[12px] text-muted">{t('product.contributorsHint')}</p>
      {contributors.length > 0 && (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('product.name')}</th>
                <th className="narrow">{t('product.role')}</th>
                <th className="narrow">{t('product.organisation')}</th>
                <th>{t('product.fee')}</th>
                <th>{t('product.basisLabel')}</th>
                {canWrite && <th className="actions" />}
              </tr>
            </thead>
            <tbody>
              {[...contributors].sort(byOrder).map((person) => (
                <tr key={person.id}>
                  <td>{person.email ? <a className="cell-link" href={`mailto:${person.email}`}>{person.name}</a> : person.name}</td>
                  <td className="narrow">{person.role ?? '—'}</td>
                  <td className="narrow">{person.organisation ?? '—'}</td>
                  <td>{asMoney(person.fee, product.currency, true)}</td>
                  <td>{t(basisKey(person.fee_basis))}</td>
                  {canWrite && (
                    <td className="actions">
                      <MenuButton
                        variant="ghost" size="iconSm"
                        label={t('common.moreActions')}
                        items={[
                        { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(person) },
                        {
                          id: 'delete',
                          label: t('action.delete'),
                          danger: true,
                          onSelect: async () => { if (await confirm(t('product.removeContributorHint'))) remove('productContributor', person.id); },
                        },
                        ]}
                      >
                        <Icon name="dots" size={14} />
                      </MenuButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <Button size="sm" onClick={() => setEditing(null)}>
          <Icon name="plus" size={13} /> {t('product.addContributor')}
        </Button>
      )}
      {editing !== undefined && (
        <ContributorForm product={product} person={editing} onClose={() => setEditing(undefined)} />
      )}
      {dialog}
    </div>
  );
}

function ContributorForm({ product, person, onClose }: {
  product: Product;
  person: ProductContributor | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({
    name: person?.name ?? '',
    role: person?.role ?? '',
    organisation: person?.organisation ?? '',
    email: person?.email ?? '',
    fee: person?.fee ?? 0,
    fee_basis: person?.fee_basis ?? ('delivery' as CostBasis),
    note: person?.note ?? '',
  });

  return (
    <Sheet
      title={person ? t('product.editContributor') : t('product.addContributor')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const patch = {
              product_id: product.id,
              name: form.name.trim(),
              role: form.role.trim() || null,
              organisation: form.organisation.trim() || null,
              email: form.email.trim() || null,
              fee: form.fee,
              fee_basis: form.fee_basis,
              note: form.note.trim() || null,
            };
            if (person) update('productContributor', person.id, patch);
            else create('productContributor', { ...patch, sort_order: orderKey() });
            toast(t('product.contributorSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field">
        <label htmlFor="co-name">{t('product.name')}</label>
        <Input id="co-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="co-role">{t('product.role')}</label>
          <Input id="co-role" value={form.role} placeholder={t('product.rolePlaceholder')} onChange={(event) => setForm({ ...form, role: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="co-org">{t('product.organisation')}</label>
          <Input id="co-org" value={form.organisation} onChange={(event) => setForm({ ...form, organisation: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="co-email">{t('product.email')}</label>
        <Input id="co-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="co-fee">{t('product.fee')}</label>
          <MoneyInput id="co-fee" value={form.fee} currency={product.currency} onChange={(fee) => setForm({ ...form, fee })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="co-basis">{t('product.basisLabel')}</label>
          <Select id="co-basis" value={form.fee_basis} onChange={(event) => setForm({ ...form, fee_basis: event.target.value as CostBasis })}>
            {COST_BASIS.map((basis) => <option key={basis} value={basis}>{t(basisKey(basis))}</option>)}
          </Select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="co-note">{t('product.note')}</label>
        <Textarea id="co-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ prices */

function Prices({ product }: { product: Product }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const prices = useQuery(() => list('productPrice', (row) => row.product_id === product.id), [product.id]);
  const [editing, setEditing] = useState<ProductPrice | null | undefined>(undefined);
  const [raising, setRaising] = useState<ProductPrice | null>(null);
  const day = today();
  const applied = useMemo(() => priceFor(prices, { on: day }), [prices, day]);
  /* The product's own term settles what a price that states none commits to,
     so two prices that mean the same commitment share a lane. */
  const history = useMemo(() => priceHistory(prices, product.term_months), [prices, product.term_months]);
  const clashes = useMemo(() => overlappingPrices(prices, product.term_months), [prices, product.term_months]);
  /** What is live now or still to come. The rest is the history below. */
  const current = useMemo(
    () => prices.filter((price) => !price.valid_to || price.valid_to >= day),
    [prices, day],
  );

  return (
    <div className="grid gap-3.5">
      <p className="text-[12px] text-muted">{t('product.pricesHint')}</p>
      {canWrite && (
        <div>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> {t('product.addPrice')}
          </Button>
        </div>
      )}
      {clashes.length > 0 && (
        <p className="notice-warn">
          {t('product.priceOverlap', { count: String(clashes.length) })}
        </p>
      )}
      {!prices.length ? (
        <Empty emoji="💶" title={t('product.noPrices')} hint={t('product.noPricesHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('product.priceName')}</th>
                <th className="narrow">{t('product.priceKindLabel')}</th>
                <th>{t('product.amount')}</th>
                <th className="narrow">{t('product.minQuantity')}</th>
                <th>{t('product.billingLabel')}</th>
                <th className="narrow">{t('product.priceTerm')}</th>
                <th className="narrow">{t('product.window')}</th>
                {canWrite && <th className="actions" />}
              </tr>
            </thead>
            <tbody>
              {[...current].sort(byOrder).map((price) => (
                <tr key={price.id}>
                  <td>
                    {price.name || t('product.unnamedPrice')}
                    {/* Which row actually applies today, at quantity one. Four
                        prices in a column and no mark is four prices somebody
                        has to work it out from. */}
                    {applied?.id === price.id && <> <Chip>{t('product.appliesNow')}</Chip></>}
                  </td>
                  <td className="narrow">{t(priceKindKey(price.kind))}</td>
                  <td>{asMoney(price.amount, product.currency)}</td>
                  <td className="narrow">{price.min_quantity}</td>
                  <td>{t(billingKey(price.recurrence))}</td>
                  {/* Without this column three prices at three terms are three
                      identical rows at three different amounts, which is what
                      made them look like a mistake. */}
                  <td className="narrow">{termLabel(t, price, product)}</td>
                  <td className="narrow">
                    {price.valid_from ? shortDate(price.valid_from) : '…'}
                    {' → '}
                    {price.valid_to ? shortDate(price.valid_to) : '…'}
                  </td>
                  {canWrite && (
                    <td className="actions">
                      <MenuButton
                        variant="ghost" size="iconSm"
                        label={t('common.moreActions')}
                        items={[
                        { id: 'change', label: t('product.change'), onSelect: () => setRaising(price) },
                        { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(price) },
                        {
                          id: 'delete',
                          label: t('action.delete'),
                          danger: true,
                          onSelect: async () => { if (await confirm(t('product.removePriceHint'))) remove('productPrice', price.id); },
                        },
                        ]}
                      >
                        <Icon name="dots" size={14} />
                      </MenuButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history.length > 0 && (
        <div>
          <SectionHeading>{t('product.priceHistory')}</SectionHeading>
          {/* Read off the rows rather than out of a versions table: a price is
              never overwritten, so a window that has closed already is the old
              price. See `priceHistory`. */}
          <p className="text-[12px] text-muted">{t('product.priceHistoryHint')}</p>
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>{t('product.changedOn')}</th>
                  <th>{t('product.priceName')}</th>
                  <th className="narrow">{t('product.wasAmount')}</th>
                  <th className="narrow">{t('product.becameAmount')}</th>
                  <th className="narrow">{t('product.changeBy')}</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((change) => (
                  <tr key={`${change.from.id}-${change.to.id}`}>
                    <td>{shortDate(change.on)}</td>
                    <td>{change.to.name || t('product.unnamedPrice')} <span className="text-[11px] text-muted">{t(priceKindKey(change.to.kind))} · {t(billingKey(change.to.recurrence))}</span></td>
                    <td className="narrow">{asMoney(change.from.amount, product.currency)}</td>
                    <td className="narrow">{asMoney(change.to.amount, product.currency)}</td>
                    {/*
                      * No colour on the direction, deliberately. The classes to
                      * hand are the budget's — `money-over` is red and means
                      * "past what was agreed" — and a price rise painted with it
                      * reads as a problem when for the seller it is the opposite.
                      * Whether a rise is good news depends on which side of the
                      * invoice the reader is on, which is not ours to decide; the
                      * sign and the percentage say what happened and stop there.
                      */}
                    <td className="narrow">
                      <span className="money-flat">
                        {change.delta > 0 ? '+' : ''}{asMoney(change.delta, product.currency, true)}
                        {change.deltaBps !== null && ` (${change.delta > 0 ? '+' : ''}${Math.round(change.deltaBps / 100)}%)`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing !== undefined && <PriceForm product={product} price={editing} onClose={() => setEditing(undefined)} />}
      {raising && <RaiseForm product={product} price={raising} onClose={() => setRaising(null)} />}
      {dialog}
    </div>
  );
}

/**
 * What a price's commitment reads as, and where the number came from.
 *
 * A price that states none is not blank: it commits to whatever the product
 * says, and showing nothing there would make an inherited twelve months look
 * like no commitment at all. The inherited figure is shown in the product's
 * own words with a mark, so the column can be read down without opening a row.
 */
/**
 * A commitment, as a chip stands on its own.
 *
 * `termLabel` below answers under a column headed "Term", where "none" reads
 * fine. A chip has no header over it, so it has to carry the noun itself.
 */
function termChip(t: ReturnType<typeof useT>, months: number): string {
  return months === 0 ? t('product.termFree') : t('product.termMonthsShort', { months: String(months) });
}

function termLabel(t: ReturnType<typeof useT>, price: ProductPrice, product: Product): string {
  const months = price.term_months ?? product.term_months;
  const said = months === 0 ? t('product.termNone') : t('product.termMonthsShort', { months: String(months) });
  return price.term_months === null ? `${said} *` : said;
}

/**
 * Change a price without leaving the old one live.
 *
 * Two rows in one step, which is the whole point: doing it by hand means
 * remembering to close the current window, and forgetting leaves two prices
 * open at once — `priceFor` then answers deterministically and nobody knows
 * which of the two won. `raisePrice` in `@kolibri/shared` decides the boundary
 * so that the client and MCP cannot disagree about it.
 */
function RaiseForm({ product, price, onClose }: { product: Product; price: ProductPrice; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [amount, setAmount] = useState(price.amount);
  const [on, setOn] = useState(today());
  const delta = amount - price.amount;
  /* Asked before the click rather than caught after it: `raisePrice` throws on
     a day the old window does not contain, and a date field can reach one. */
  const refusal = priceChangeRefusal(price, on);

  return (
    <Sheet
      title={t('product.raisePrice')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={amount === price.amount || !!refusal}
          onClick={() => {
            const { closes, opens } = raisePrice(price, { amount, on });
            update('productPrice', closes.id, { valid_to: closes.valid_to });
            create('productPrice', { ...opens, sort_order: orderKey() });
            toast(t('product.priceChanged'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <p className="text-[12.5px] text-muted">{t('product.raisePriceHint')}</p>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label>{t('product.wasAmount')}</label>
          <p className="text-[13px]">{asMoney(price.amount, product.currency)}</p>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="rp-amount">{t('product.becameAmount')}</label>
          <MoneyInput id="rp-amount" value={amount} currency={product.currency} onChange={setAmount} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="rp-on">{t('product.effectiveFrom')}</label>
          <Input id="rp-on" type="date" value={on} onChange={(event) => setOn(event.target.value)} />
        </div>
      </div>
      {refusal && (
        <p className="text-[12.5px] money-over">
          {t(refusal === 'before-start' ? 'product.raiseBeforeStart' : 'product.raiseAfterEnd', {
            date: shortDate((refusal === 'before-start' ? price.valid_from : price.valid_to) ?? on),
          })}
        </p>
      )}
      {/* What will actually be written, before it is. The closing date is the
          day before, and somebody should see that rather than discover it. */}
      {!refusal && (
        <p className="text-[12.5px] text-muted">
          {t('product.raisePreview', {
            old: asMoney(price.amount, product.currency),
            until: shortDate(dayBefore(on)),
            next: asMoney(amount, product.currency),
            from: shortDate(on),
          })}
        </p>
      )}
      {delta !== 0 && (
        <p className="text-[12.5px]">
          <span className="money-flat">
            {delta > 0 ? '+' : ''}{asMoney(delta, product.currency)}
            {price.amount !== 0 && ` (${delta > 0 ? '+' : ''}${Math.round((delta * 100) / price.amount)}%)`}
          </span>
        </p>
      )}
    </Sheet>
  );
}

function PriceForm({ product, price, onClose }: { product: Product; price: ProductPrice | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({
    name: price?.name ?? '',
    kind: price?.kind ?? ('list' as ProductPrice['kind']),
    amount: price?.amount ?? 0,
    min_quantity: price?.min_quantity ?? 1,
    recurrence: price?.recurrence ?? 'once',
    // Empty is null is "whatever the product says", the same way the two dates
    // in this form already work. A number here overrides it for this price.
    term_months: price?.term_months === null || price?.term_months === undefined ? '' : String(price.term_months),
    valid_from: price?.valid_from ?? '',
    valid_to: price?.valid_to ?? '',
    note: price?.note ?? '',
  });

  return (
    <Sheet
      title={price ? t('product.editPrice') : t('product.addPrice')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          onClick={() => {
            const patch = {
              product_id: product.id,
              name: form.name.trim(),
              kind: form.kind,
              amount: form.amount,
              min_quantity: form.min_quantity,
              recurrence: form.recurrence,
              term_months: form.term_months.trim() === '' ? null : Math.max(0, Number(form.term_months)),
              valid_from: form.valid_from || null,
              valid_to: form.valid_to || null,
              note: form.note.trim() || null,
            };
            if (price) update('productPrice', price.id, patch);
            else create('productPrice', { ...patch, sort_order: orderKey() });
            toast(t('product.priceSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field">
        <label htmlFor="pr-name">{t('product.priceName')}</label>
        <Input id="pr-name" value={form.name} placeholder={t('product.priceNamePlaceholder')} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-kind">{t('product.priceKindLabel')}</label>
          <Select id="pr-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ProductPrice['kind'] })}>
            {PRICE_KINDS.map((kind) => <option key={kind} value={kind}>{t(priceKindKey(kind))}</option>)}
          </Select>
          <span className="text-[12px] text-muted">{t('product.priceKindHint')}</span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-amount">{t('product.amount')}</label>
          <MoneyInput id="pr-amount" value={form.amount} currency={product.currency} onChange={(amount) => setForm({ ...form, amount })} />
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-min">{t('product.minQuantity')}</label>
          <Input id="pr-min" type="number" min={1} value={form.min_quantity}
            onChange={(event) => setForm({ ...form, min_quantity: Math.max(1, Number(event.target.value)) })} />
          <span className="text-[12px] text-muted">{t('product.minQuantityHint')}</span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-rec">{t('product.billingLabel')}</label>
          <Select id="pr-rec" value={form.recurrence} onChange={(event) => setForm({ ...form, recurrence: event.target.value as ProductPrice['recurrence'] })}>
            {COST_RECURRENCES.map((every) => <option key={every} value={every}>{t(billingKey(every))}</option>)}
          </Select>
        </div>
        {/* The field that lets one product be sold at several terms at once.
            Beside the period on purpose: how often it is charged and how long
            they are tied in are the two halves people confuse. */}
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-term">{t('product.priceTerm')}</label>
          <Input id="pr-term" type="number" min={0} value={form.term_months}
            placeholder={String(product.term_months)}
            onChange={(event) => setForm({ ...form, term_months: event.target.value })} />
          <span className="text-[12px] text-muted">
            {t('product.priceTermHint', { term: String(product.term_months) })}
          </span>
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-from">{t('product.validFrom')}</label>
          <Input id="pr-from" type="date" value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pr-to">{t('product.validTo')}</label>
          <Input id="pr-to" type="date" value={form.valid_to} onChange={(event) => setForm({ ...form, valid_to: event.target.value })} />
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------- costs */

function Costs({ product }: { product: Product }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const costs = useQuery(() => list('productCost', (row) => row.product_id === product.id), [product.id]);
  const contributors = useQuery(() => list('productContributor', (row) => row.product_id === product.id), [product.id]);
  const [editing, setEditing] = useState<ProductCost | null | undefined>(undefined);
  const categories = useMemo(() => costsByCategory(costs), [costs]);

  /** Per basis, contributors' fees included — the same fold `costStructure` does. */
  const perBasis = useMemo(() => {
    const out: Record<CostBasis, Minor> = { period: 0, delivery: 0, unit: 0 };
    for (const cost of costs) out[cost.basis] += cost.amount;
    for (const person of contributors) out[person.fee_basis] += person.fee;
    return out;
  }, [costs, contributors]);

  return (
    <div className="grid gap-3.5">
      <p className="text-[12px] text-muted">{t('product.costsHint')}</p>
      <div className="kpi-row">
        {BASES.map((basis) => (
          <Stat
            key={basis}
            label={t(basisKey(basis))}
            value={asMoney(perBasis[basis], product.currency, true)}
            hint={t(`product.basisHint.${basis}` as TranslationKey)}
          />
        ))}
      </div>
      {canWrite && (
        <div>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> {t('product.addCost')}
          </Button>
        </div>
      )}
      {!costs.length ? (
        <Empty emoji="🧾" title={t('product.noCosts')} hint={t('product.noCostsHint')} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>{t('product.name')}</th>
                  <th>{t('product.basisLabel')}</th>
                  <th className="narrow">{t('product.category')}</th>
                  <th>{t('product.amount')}</th>
                  <th className="narrow">{t('product.vendor')}</th>
                  {canWrite && <th className="actions" />}
                </tr>
              </thead>
              <tbody>
                {[...costs].sort(byOrder).map((cost) => (
                  <tr key={cost.id}>
                    <td>{cost.name}</td>
                    <td>{t(basisKey(cost.basis))}</td>
                    <td className="narrow">{t(categoryKey(cost.category))}</td>
                    <td>{asMoney(cost.amount, product.currency)}</td>
                    <td className="narrow">{cost.vendor ?? '—'}</td>
                    {canWrite && (
                      <td className="actions">
                        <MenuButton
                          variant="ghost" size="iconSm"
                          label={t('common.moreActions')}
                          items={[
                          { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(cost) },
                          {
                            id: 'delete',
                            label: t('action.delete'),
                            danger: true,
                            onSelect: async () => { if (await confirm(t('product.removeCostHint'))) remove('productCost', cost.id); },
                          },
                          ]}
                        >
                          <Icon name="dots" size={14} />
                        </MenuButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <SectionHeading>{t('product.byCategory')}</SectionHeading>
            <div className="bars">
              {categories.map((row) => (
                <div className="bar-row" key={row.category}>
                  <span className="bar-label truncate">{t(categoryKey(row.category))}</span>
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      style={{ width: `${(row.amount / Math.max(1, categories[0]?.amount ?? 1)) * 100}%`, background: 'var(--chart-1)' }}
                    />
                  </span>
                  <span className="bar-value">{asMoney(row.amount, product.currency, true)}</span>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-muted">{t('product.byCategoryHint')}</p>
          </div>
        </>
      )}
      {editing !== undefined && <CostForm product={product} cost={editing} onClose={() => setEditing(undefined)} />}
      {dialog}
    </div>
  );
}

function CostForm({ product, cost, onClose }: { product: Product; cost: ProductCost | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({
    name: cost?.name ?? '',
    basis: cost?.basis ?? ('unit' as CostBasis),
    category: cost?.category ?? ('other' as ProductCost['category']),
    amount: cost?.amount ?? 0,
    vendor: cost?.vendor ?? '',
    note: cost?.note ?? '',
  });

  return (
    <Sheet
      title={cost ? t('product.editCost') : t('product.addCost')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const patch = {
              product_id: product.id,
              name: form.name.trim(),
              basis: form.basis,
              category: form.category,
              amount: form.amount,
              vendor: form.vendor.trim() || null,
              note: form.note.trim() || null,
            };
            if (cost) update('productCost', cost.id, patch);
            else create('productCost', { ...patch, sort_order: orderKey() });
            toast(t('product.costSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field">
        <label htmlFor="pc-name">{t('product.name')}</label>
        <Input id="pc-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="pc-basis">{t('product.basisLabel')}</label>
        <Select id="pc-basis" value={form.basis} onChange={(event) => setForm({ ...form, basis: event.target.value as CostBasis })}>
          {COST_BASIS.map((basis) => <option key={basis} value={basis}>{t(basisKey(basis))}</option>)}
        </Select>
        <span className="text-[12px] text-muted">{t(`product.basisHint.${form.basis}` as TranslationKey)}</span>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="pc-cat">{t('product.category')}</label>
          <Select id="pc-cat" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as ProductCost['category'] })}>
            {COST_CATEGORIES.map((category) => <option key={category} value={category}>{t(categoryKey(category))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="pc-amount">{t('product.amount')}</label>
          <MoneyInput id="pc-amount" value={form.amount} currency={product.currency} onChange={(amount) => setForm({ ...form, amount })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pc-vendor">{t('product.vendor')}</label>
        <Input id="pc-vendor" value={form.vendor} onChange={(event) => setForm({ ...form, vendor: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------------- package */

function Package({ product, entry }: { product: Product; entry: CatalogueEntry }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const parts = useQuery(() => list('productPart', (row) => row.product_id === product.id), [product.id]);
  const products = useQuery(() => list('product', (row) => row.id !== product.id && !row.archived), [product.id]);
  const prices = useQuery(() => list('productPrice'), []);
  const capabilities = useCapabilityNames();
  const [adding, setAdding] = useState('');
  const day = today();

  const pricesOf = useMemo(() => {
    const out = new Map<string, ProductPrice[]>();
    for (const price of prices) {
      const listed = out.get(price.product_id) ?? [];
      listed.push(price);
      out.set(price.product_id, listed);
    }
    return out;
  }, [prices]);

  const value = useMemo(() => bundleValue({
    parts,
    pricesOf: (id) => pricesOf.get(id) ?? [],
    price: entry.economics.price,
    on: day,
  }), [parts, pricesOf, entry.economics.price, day]);

  const named = useMemo(() => new Map(products.map((row) => [row.id, row])), [products]);

  /* The union a customer actually gets: the package's own plus every part's. */
  const included = useMemo(() => {
    const out = new Set<string>(product.capabilities ?? []);
    for (const part of parts) for (const id of named.get(part.part_id)?.capabilities ?? []) out.add(id);
    return [...out].filter((id) => capabilities.has(id));
  }, [product.capabilities, parts, named, capabilities]);

  if (product.kind !== 'bundle' && !parts.length) {
    return (
      <Empty
        emoji="📦"
        title={t('product.notAPackage')}
        hint={t('product.notAPackageHint')}
        action={canWrite ? <Button onClick={() => update('product', product.id, { kind: 'bundle' })}>{t('product.makePackage')}</Button> : undefined}
      />
    );
  }

  return (
    <div className="grid gap-3.5">
      <div className="kpi-row">
        <Stat label={t('product.listValue')} value={asMoney(value.listValue, product.currency)} hint={t('product.listValueHint')} />
        <Stat
          label={t('product.packagePrice')}
          value={value.price === null ? '—' : asMoney(value.price, product.currency)}
        />
        <Stat
          label={value.saving !== null && value.saving < 0 ? t('product.premium') : t('product.saving')}
          value={value.saving === null ? '—' : asMoney(Math.abs(value.saving), product.currency)}
          hint={value.savingBps === null ? undefined : `${Math.round(Math.abs(value.savingBps) / 100)}%`}
        />
      </div>
      {value.unpriced > 0 && <p className="notice-warn">{t('product.unpricedParts', { count: String(value.unpriced) })}</p>}

      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th>{t('product.part')}</th>
              <th>{t('product.quantity')}</th>
              <th>{t('product.price')}</th>
              {canWrite && <th className="actions" />}
            </tr>
          </thead>
          <tbody>
            {[...parts].sort(byOrder).map((part) => {
              const child = named.get(part.part_id);
              const price = priceFor(pricesOf.get(part.part_id) ?? [], { quantity: part.quantity, on: day });
              return (
                <tr key={part.id}>
                  <td>{child ? <Link className="cell-link" to={`/products/${child.id}`}>{child.name}</Link> : t('product.unknownPart')}</td>
                  <td>{part.quantity}</td>
                  <td>
                    {price ? asMoney(price.amount * part.quantity, product.currency) : <span className="money-flat">—</span>}
                  </td>
                  {canWrite && (
                    <td className="actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async () => {
                          if (await confirm(t('product.removePartHint'))) {
                            remove('productPart', part.id);
                          }
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canWrite && (
        <div className="field-row">
          <Select className="flex-1 min-w-0" value={adding} aria-label={t('product.addPart')} onChange={(event) => setAdding(event.target.value)}>
            <option value="">{t('product.addPart')}</option>
            {products.filter((row) => !parts.some((part) => part.part_id === row.id))
              .map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
          <Button
            disabled={!adding}
            onClick={() => {
              create('productPart', { product_id: product.id, part_id: adding, quantity: 1, sort_order: orderKey() });
              if (product.kind !== 'bundle') update('product', product.id, { kind: 'bundle' });
              setAdding('');
            }}
          >
            {t('action.add')}
          </Button>
        </div>
      )}

      <div>
        <SectionHeading>{t('product.includedCapabilities')}</SectionHeading>
        <p className="text-[12px] text-muted">{t('product.includedCapabilitiesHint')}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {included.map((id) => <Chip key={id}>{capabilities.get(id)}</Chip>)}
          {!included.length && <span className="text-[12px] text-muted">{t('product.noCapabilities')}</span>}
        </div>
      </div>
      {dialog}
    </div>
  );
}

/* -------------------------------------------------------------- simulation */

function SimulationTab({ product }: { product: Product }) {
  const t = useT();
  const canWrite = useCanWrite();
  const [search] = useSearchParams();
  const prices = useQuery(() => list('productPrice', (row) => row.product_id === product.id), [product.id]);
  const costs = useQuery(() => list('productCost', (row) => row.product_id === product.id), [product.id]);
  const contributors = useQuery(() => list('productContributor', (row) => row.product_id === product.id), [product.id]);
  const promotions = useQuery(() => list('promotion'), []);
  const scenarios = useQuery(() => list('productScenario', (row) => !row.product_id || row.product_id === product.id), [product.id]);
  const [saving, setSaving] = useState(false);
  const day = today();

  const chosen = search.get('scenario');
  const saved = scenarios.find((row) => row.id === chosen);
  const [form, setForm] = useState<ProductAssumptions>(() => assumptionsOf(saved?.assumptions));

  /*
   * A link that names a scenario arrives before the scenario does.
   *
   * The rows come out of the local mirror, which is not populated on the first
   * render — so the lazy initial state above reads `undefined` and the form
   * opens on the defaults. It then *stays* on them, because a `useState`
   * initialiser runs once, and the screen quietly shows somebody a projection
   * that is not the one they followed a link to. Keyed on the id so that
   * editing the form afterwards is not undone on every render.
   */
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    if (!saved || adopted.current === saved.id) return;
    adopted.current = saved.id;
    setForm(assumptionsOf(saved.assumptions));
  }, [saved]);

  const result = useMemo(() => simulate({
    product, prices, costs, contributors, promotions, assumptions: form, today: day,
  }), [product, prices, costs, contributors, promotions, form, day]);

  const settled = assumptionsOf(form);
  /* Over the contract the projection actually ran at: picking the two-year
     price and reading a retention figured over the product's own term is two
     screens disagreeing about the same customer. */
  const retention = retentionOf({
    product, contribution: result.contribution, churnBps: settled.churn_bps, termMonths: result.termMonths,
  });

  return (
    <div className="grid gap-3.5">
      <p className="text-[12px] text-muted">{t('product.simulationHint')}</p>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="si-months">{t('product.months')}</label>
          <Input id="si-months" type="number" min={1} max={120} value={settled.months}
            onChange={(event) => setForm({ ...form, months: Number(event.target.value) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="si-units">{t('product.unitsFirstMonth')}</label>
          <Input id="si-units" type="number" min={0} value={settled.units}
            onChange={(event) => setForm({ ...form, units: Number(event.target.value) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="si-growth">{t('product.growth')}</label>
          <Input id="si-growth" type="number" value={settled.growth_bps / 100}
            onChange={(event) => setForm({ ...form, growth_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="si-deliveries">{t('product.deliveries')}</label>
          <Input id="si-deliveries" type="number" min={0} value={settled.deliveries}
            onChange={(event) => setForm({ ...form, deliveries: Number(event.target.value) })} />
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="si-price">{t('product.priceChange')}</label>
          <Input id="si-price" type="number" value={settled.price_bps / 100}
            onChange={(event) => setForm({ ...form, price_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="si-cost">{t('product.costChange')}</label>
          <Input id="si-cost" type="number" value={settled.cost_bps / 100}
            onChange={(event) => setForm({ ...form, cost_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
      </div>
      <div className="field">
        <label>{t('product.campaignsApplied')}</label>
        <div className="flex flex-wrap gap-2 pt-1">
          {promotions.map((promotion) => (
            <Chip
              key={promotion.id}
              tone={settled.promotions.includes(promotion.id) ? 'on' : 'default'}
              interactive
              onClick={() => setForm({
                ...form,
                promotions: settled.promotions.includes(promotion.id)
                  ? settled.promotions.filter((id) => id !== promotion.id)
                  : [...settled.promotions, promotion.id],
              })}
            >
              {promotion.name} <span className="text-[11px]">{t(phaseKey(promotionPhase(promotion, day)))}</span>
            </Chip>
          ))}
          {!promotions.length && <span className="text-[12px] text-muted">{t('product.noPromotionsYet')}</span>}
        </div>
      </div>

      <div className="kpi-row">
        <Stat
          label={t('product.revenue')}
          value={asMoney(result.revenue, result.currency, true)}
          hint={t('product.overMonths', { months: String(settled.months) })}
        />
        <Stat label={t('product.cost')} value={asMoney(result.cost, result.currency, true)} />
        <Stat
          label={t('product.marginTotal')}
          value={asMoney(result.margin, result.currency, true)}
          hint={result.price === null ? t('product.unpriced') : undefined}
        />
        <Stat
          label={t('product.breakEvenMonth')}
          value={result.breakEvenMonth ?? '—'}
          hint={result.breakEvenMonth ? undefined : t('product.neverBreaksEven')}
        />
      </div>

      {/* Two things the tiles cannot carry, and both change what somebody does
          next: units the business could not have delivered, and a price that is
          not the one on the price list. */}
      {result.turnedAway > 0 && (
        <p className="notice-warn">{t('product.turnedAway', { units: String(result.turnedAway) })}</p>
      )}
      {result.price !== null && result.listPrice !== null && result.price !== result.listPrice && (
        <p className="text-[12.5px] text-muted">
          {t('product.priceAfter', {
            list: asMoney(result.listPrice, result.currency),
            price: asMoney(result.price, result.currency),
          })}
        </p>
      )}

      <ProjectionChart simulation={result} caption={t('product.projectionCaption', { name: product.name })} />

      {product.renewal !== 'none' && (
        <p className="text-[12.5px] text-muted">
          {retention.months === null
            ? t('product.noChurn')
            : t('product.retentionSentence', {
              months: String(Math.round(retention.months)),
              value: retention.value === null ? '—' : asMoney(retention.value, result.currency),
            })}
        </p>
      )}

      {canWrite && (
        <div>
          <Button onClick={() => setSaving(true)}>{t('product.saveScenario')}</Button>
        </div>
      )}
      {saving && (
        <ScenarioForm
          scenario={null}
          products={[product]}
          productId={product.id}
          assumptions={form}
          onClose={() => setSaving(false)}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the form */

function ProductForm({ product, onClose }: { product?: Product; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const groups = useQuery(() => list('productGroup', (row) => !row.archived), []);
  const capabilities = useQuery(() => list('productCapability', (row) => !row.archived), []);
  /* What it already contains, because a product holding parts cannot honestly
     go back to being a single one — `unitCosts` recurses through them whatever
     the kind says, so the catalogue would carry a package's costs under a
     single product's name. */
  const parts = useQuery(() => (product ? list('productPart', (row) => row.product_id === product.id) : []), [product?.id]);
  const [form, setForm] = useState({
    name: product?.name ?? '',
    code: product?.code ?? '',
    description: product?.description ?? '',
    group_id: product?.group_id ?? '',
    status: product?.status ?? ('draft' as Product['status']),
    currency: product?.currency ?? 'EUR',
    unit_label: product?.unit_label ?? '',
    scope_amount: product?.scope_amount ?? 0,
    kind: product?.kind ?? ('single' as Product['kind']),
    scope_unit: product?.scope_unit ?? '',
    capacity: product?.capacity ?? null,
    term_months: product?.term_months ?? 0,
    renewal: product?.renewal ?? ('none' as Product['renewal']),
    churn_bps: product?.churn_bps ?? 0,
    acquisition_cost: product?.acquisition_cost ?? 0,
    capabilities: product?.capabilities ?? [],
  });
  const [newCapability, setNewCapability] = useState('');

  return (
    <Sheet
      title={product ? t('product.edit') : t('product.new')}
      onClose={onClose}
      wide
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const patch = {
              name: form.name.trim(),
              code: form.code.trim() || null,
              description: form.description.trim() || null,
              group_id: form.group_id || null,
              status: form.status,
              kind: form.kind,
              currency: form.currency.trim().toUpperCase() || 'EUR',
              unit_label: form.unit_label.trim() || null,
              scope_amount: form.scope_amount,
              scope_unit: form.scope_unit.trim() || null,
              capacity: form.capacity,
              term_months: form.term_months,
              renewal: form.renewal,
              churn_bps: form.churn_bps,
              acquisition_cost: form.acquisition_cost,
              capabilities: form.capabilities,
            };
            if (product) {
              update('product', product.id, patch);
              toast(t('product.saved'));
            } else {
              const id = create('product', { ...patch, archived: 0, sort_order: orderKey() });
              toast(t('product.saved'));
              /* A new package opens on the tab where its parts are chosen. It
                 used to land on the overview, and the only way on was a tab
                 that said "this is not a package" — which is how somebody
                 concluded the product could not be one. */
              navigate(form.kind === 'bundle' ? `/products/${id}?tab=package` : `/products/${id}`);
            }
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-name">{t('product.name')}</label>
          <Input id="p-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-code">{t('product.code')}</label>
          <Input id="p-code" value={form.code} placeholder={t('product.codePlaceholder')} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="p-desc">{t('product.description')}</label>
        <Textarea id="p-desc" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-group">{t('product.group')}</label>
          <Select id="p-group" value={form.group_id} onChange={(event) => setForm({ ...form, group_id: event.target.value })}>
            <option value="">{t('product.ungrouped')}</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-status">{t('product.statusLabel')}</label>
          <Select id="p-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Product['status'] })}>
            {PRODUCT_STATUS.map((status) => <option key={status} value={status}>{t(statusKey(status))}</option>)}
          </Select>
        </div>
        {/* Asked here rather than discovered later. `kind` used to be written
            as `single` on every create and changed only by a button inside the
            package tab's empty state — so the one screen that names packages
            was the one you reached by opening a tab that said this is not one. */}
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-kind">{t('product.kindLabel')}</label>
          <Select id="p-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Product['kind'] })}>
            {PRODUCT_KINDS.map((kind) => (
              <option key={kind} value={kind} disabled={kind === 'single' && parts.length > 0}>
                {t(kind === 'bundle' ? 'product.kindBundle' : 'product.kindSingle')}
              </option>
            ))}
          </Select>
          <span className="text-[12px] text-muted">
            {parts.length > 0
              ? t('product.kindLocked', { count: String(parts.length) })
              : t(form.kind === 'bundle' ? 'product.kindBundleHint' : 'product.kindSingleHint')}
          </span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-currency">{t('product.currency')}</label>
          {/* A list rather than three characters somebody types. ISO 4217 is
              closed, the server upper-cases and falls back to EUR anyway, and
              a typed "eur" that silently becomes EUR is a field that corrects
              you without saying so. A code this list does not carry stays
              selectable when the product already has it — see `CURRENCIES`. */}
          <Select id="p-currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
            {[...new Set([...CURRENCIES, form.currency].filter(Boolean))].map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </Select>
        </div>
      </div>

      <SectionHeading>{t('product.scope')}</SectionHeading>
      <p className="text-[12px] text-muted">{t('product.scopeHint')}</p>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-unit">{t('product.unitLabel')}</label>
          {/* Suggestions, not a closed list: what one unit is called is the
              organisation's word and nothing sums across products by it. A
              `datalist` keeps both — the common ones offered, anything typed. */}
          <Input id="p-unit" list="p-unit-options" value={form.unit_label} placeholder={t('product.unitPlaceholder')}
            onChange={(event) => setForm({ ...form, unit_label: event.target.value })} />
          <datalist id="p-unit-options">
            {UNIT_SUGGESTIONS.map((key) => <option key={key} value={t(`product.unitOption.${key}` as TranslationKey)} />)}
          </datalist>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-scope">{t('product.scopeAmount')}</label>
          <Input id="p-scope" type="number" min={0} value={form.scope_amount}
            onChange={(event) => setForm({ ...form, scope_amount: Math.max(0, Number(event.target.value)) })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-scope-unit">{t('product.scopeUnit')}</label>
          {/* Closed, unlike the one beside it, and for the reason a cost
              category is closed: the whole point of `scope_amount` is that two
              products can be compared by it, and "Monate" against "Monat"
              against "months" is three units in every table that tries. */}
          <Select id="p-scope-unit" value={form.scope_unit}
            onChange={(event) => setForm({ ...form, scope_unit: event.target.value })}>
            <option value="">{t('product.scopeUnitNone')}</option>
            {SCOPE_UNITS.map((key) => (
              <option key={key} value={t(`product.scopeUnit.${key}` as TranslationKey)}>
                {t(`product.scopeUnit.${key}` as TranslationKey)}
              </option>
            ))}
            {/* Whatever is already stored, so editing an older product does not
                silently blank a unit this list has never heard of. */}
            {form.scope_unit && !SCOPE_UNITS.some((key) => t(`product.scopeUnit.${key}` as TranslationKey) === form.scope_unit)
              && <option value={form.scope_unit}>{form.scope_unit}</option>}
          </Select>
        </div>
      </div>
      {/*
        * Capacity only where it is a ceiling.
        *
        * It is a ceiling *per delivery*, so for a product that is not delivered
        * — a licence, a subscription — it means nothing, and the first SaaS
        * anybody modelled here carried `capacity: 1` and forecast one sale a
        * month against forty. A field nobody should fill in is better not shown
        * than shown with a warning under it.
        */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={form.capacity !== null}
          onChange={(event) => setForm({ ...form, capacity: event.target.checked ? 12 : null })}
        />
        <span>
          <span>{t('product.capacityApplies')}</span>
          <span className="text-[12px] text-muted">{t('product.capacityAppliesHint')}</span>
        </span>
      </label>
      {form.capacity !== null && (
        <div className="field">
          <label htmlFor="p-capacity">{t('product.capacity')}</label>
          <Input
            id="p-capacity"
            type="number"
            min={1}
            value={form.capacity}
            onChange={(event) => setForm({ ...form, capacity: Math.max(1, Number(event.target.value) || 1) })}
          />
        </div>
      )}

      <SectionHeading>{t('product.retention')}</SectionHeading>
      <p className="text-[12px] text-muted">{t('product.retentionHint')}</p>
      {/* No billing period here, and the line below says where it went. The
          same product is sold monthly, yearly and two-yearly at once, so one
          select on the product was one answer to a question with several — it
          is a price's business and always was. */}
      <p className="text-[12px] text-muted">{t('product.billingMovedHint')}</p>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-renewal">{t('product.renewalLabel')}</label>
          <Select id="p-renewal" value={form.renewal} onChange={(event) => setForm({ ...form, renewal: event.target.value as Product['renewal'] })}>
            {RENEWALS.map((renewal) => <option key={renewal} value={renewal}>{t(renewalKey(renewal))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-term">{t('product.termMonths')}</label>
          <Input id="p-term" type="number" min={0} value={form.term_months}
            onChange={(event) => setForm({ ...form, term_months: Math.max(0, Number(event.target.value)) })} />
        </div>
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-churn">{t('product.churn')}</label>
          <Input id="p-churn" type="number" min={0} max={100} value={form.churn_bps / 100}
            onChange={(event) => setForm({ ...form, churn_bps: Math.round(Number(event.target.value) * 100) })} />
          <span className="text-[12px] text-muted">{t('product.churnFieldHint')}</span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="p-acq">{t('product.acquisitionCost')}</label>
          <MoneyInput id="p-acq" value={form.acquisition_cost} currency={form.currency} onChange={(acquisition_cost) => setForm({ ...form, acquisition_cost })} />
          <span className="text-[12px] text-muted">{t('product.acquisitionHint')}</span>
        </div>
      </div>

      <SectionHeading>{t('product.capabilities')}</SectionHeading>
      <p className="text-[12px] text-muted">{t('product.capabilitiesHint')}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        {capabilities.map((capability: ProductCapability) => (
          <Chip
            key={capability.id}
            tone={form.capabilities.includes(capability.id) ? 'on' : 'default'}
            interactive
            onClick={() => setForm({
              ...form,
              capabilities: form.capabilities.includes(capability.id)
                ? form.capabilities.filter((id) => id !== capability.id)
                : [...form.capabilities, capability.id],
            })}
          >
            {capability.name}
          </Chip>
        ))}
      </div>
      <div className="field-row pt-2">
        <Input
          className="flex-1 min-w-0"
          value={newCapability}
          placeholder={t('product.newCapability')}
          aria-label={t('product.newCapability')}
          onChange={(event) => setNewCapability(event.target.value)}
        />
        <Button
          disabled={!newCapability.trim()}
          onClick={() => {
            const id = create('productCapability', {
              name: newCapability.trim(), description: null, archived: 0, sort_order: orderKey(),
            });
            setForm({ ...form, capabilities: [...form.capabilities, id] });
            setNewCapability('');
          }}
        >
          {t('action.add')}
        </Button>
      </div>
    </Sheet>
  );
}

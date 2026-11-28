/** The catalogue tab: products grouped, with what each earns over the horizon. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { byGroup, orderKey, type Minor, type ProductGroup, type ProductKind } from '@kolibri/shared';
import { Health, Margin, billingKey, blockedKey, statusKey, useCatalogue } from './product';
import { Stat } from '../../kernel/design-system/ui/stat';
import { asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, checkRow, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useCanWrite } from '../../kernel/identity/session';
import { statRow } from '../../kernel/design-system/ui/stat';
import { cn } from '../../kernel/design-system/cn';
import { HORIZON, termChip } from './parts';

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
/**
 * The catalogue, or the half of it the caller asked for.
 *
 * Packages sat in the same list as the things they are made of, told apart by
 * a chip — so reading "what do we sell" meant reading past six rows that are
 * the other rows in a different arrangement, and reading "what do the packages
 * come to" meant opening all six. They are two questions and now two tabs.
 *
 * One component rather than two, filtered: the figures, the totals, the
 * archive toggle and the term chips are the same in both, and a second table
 * is a second place for them to drift apart.
 */
export function Catalogue({ only }: { only: ProductKind }) {
  const t = useT();
  const { entries: all } = useCatalogue(HORIZON);
  const entries = useMemo(() => all.filter((entry) => entry.product.kind === only), [all, only]);
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
        <div className={statRow} key={row.currency}>
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
                  {/* Only where every row is a package, and not `narrow`.
                      What the parts come to separately is the question this
                      tab exists for — folded away on a phone it would show
                      exactly what the catalogue shows, which is a tab that
                      earns nothing. Margin and break-even fold instead: those
                      are the comparing columns here. */}
                  {only === 'bundle' && <th>{t('product.listValue')}</th>}
                  {only === 'bundle' && <th>{t('product.saving')}</th>}
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
                        {entry.product.kind === 'bundle' && only !== 'bundle' && <> <Chip>{t('product.package')}</Chip></>}
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
                      {only === 'bundle' && (
                        <td>
                          {entry.bundle
                            ? asMoney(entry.bundle.listValue, entry.economics.currency, true)
                            : <span className="money-flat">—</span>}
                        </td>
                      )}
                      {only === 'bundle' && (
                        <td>
                          {/* A package dearer than its parts is a real state and
                              not an error — MAX asks 99 for 89 of parts because
                              one of them is unpriced. Negative is shown as it is
                              rather than hidden behind an absolute value. */}
                          {!entry.bundle || entry.bundle.saving === null
                            ? <span className="money-flat">—</span>
                            : (
                              <span className={entry.bundle.saving < 0 ? 'money-over' : ''}>
                                {asMoney(entry.bundle.saving, entry.economics.currency, true)}
                                {entry.bundle.unpriced > 0 && (
                                  <> <Chip>{t('product.unpricedShort', { count: String(entry.bundle.unpriced) })}</Chip></>
                                )}
                              </span>
                            )}
                        </td>
                      )}
                      <td><Health entry={entry} /></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="text-label text-muted">{t('product.horizonNote', { months: String(HORIZON.months) })}</p>
      {archivedCount > 0 && (
        <label className={checkRow}>
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <span><span>{t('product.showArchived', { count: String(archivedCount) })}</span></span>
        </label>
      )}
      <GroupAdmin groups={groups} />
    </div>
  );
}

/** The families, edited where they are used rather than in a settings screen. */
export function GroupAdmin({ groups }: { groups: ProductGroup[] }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState('');
  if (!canWrite) return null;

  return (
    <div>
      <SectionHeading>{t('product.groups')}</SectionHeading>
      <p className="text-label text-muted">{t('product.groupsHint')}</p>
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
                if (await confirm(t('product.removeGroupHint', { name: group.name }), t('action.remove'))) {
                  remove('productGroup', group.id);
                }
              }}
            >
              <Icon name="close" size={13} />
            </Button>
          </span>
        ))}
      </div>
      <div className={cn(formRow, 'pt-2')}>
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

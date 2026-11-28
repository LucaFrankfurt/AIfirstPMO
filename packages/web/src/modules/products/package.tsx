/** What is in a package, and what each part is worth inside it. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { orderKey, priceFor, type BundleValue, type CatalogueEntry, type Product, type ProductPrice } from '@kolibri/shared';
import { billingKey, useCapabilityNames } from './product';
import { Stat } from '../../kernel/design-system/ui/stat';
import { asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Select, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useCanWrite } from '../../kernel/identity/session';
import { statRow } from '../../kernel/design-system/ui/stat';
import { noticeWarn } from '../../kernel/design-system/ui/notice';
import { byOrder } from './parts';

export function Package({ product, entry }: { product: Product; entry: CatalogueEntry }) {
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

  /* Read off the entry rather than figured again here. `catalogue()` already
     has the parts and every part's prices, and a second assembly of the same
     number is the place the two come to disagree — which is not a worry but a
     thing that happened, one field at a time. */
  const value: BundleValue = entry.bundle
    ?? { listValue: 0, price: null, saving: null, savingBps: null, recurrence: null, periods: [], unpriced: 0 };

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
      <div className={statRow}>
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
      {value.unpriced > 0 && <p className={noticeWarn}>{t('product.unpricedParts', { count: String(value.unpriced) })}</p>}

      {/* Only when there is more than one, because a package billed one way is
          fully described by the three figures above. With two, those three
          describe the quoted period alone, and the rest would simply be absent
          from the screen — which is how a 450,00 € setup fee goes unseen. */}
      {value.periods.length > 1 && (
        <div>
          <SectionHeading>{t('product.periodsHeading')}</SectionHeading>
          <p className="text-label text-muted">{t('product.periodsHint')}</p>
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>{t('product.billingLabel')}</th>
                  {/* The two comparison columns drop on a phone, which is what
                      `narrow` is for. What is left answers the question
                      somebody opens this on a phone to ask: what does this
                      package cost me, and how often. */}
                  <th className="narrow">{t('product.listValue')}</th>
                  <th>{t('product.packagePrice')}</th>
                  <th className="narrow">{t('product.saving')}</th>
                  {/* The cost belongs beside the price it is subtracted from.
                      The figures above the table describe the quoted period
                      alone, so a one-off setup's cost is not in the margin —
                      and a column that never mentions it is the flattering
                      half of an honest split. */}
                  <th className="narrow">{t('product.unitCost')}</th>
                </tr>
              </thead>
              <tbody>
                {value.periods.map((line) => (
                  <tr key={line.recurrence}>
                    <td>
                      {t(billingKey(line.recurrence))}
                      {line.recurrence === value.recurrence && <> <Chip>{t('product.appliesNow')}</Chip></>}
                    </td>
                    <td className="narrow">{asMoney(line.listValue, product.currency)}</td>
                    <td>
                      {line.price === null
                        ? <span className="text-muted">{t('product.periodNotCharged')}</span>
                        : asMoney(line.price, product.currency)}
                    </td>
                    {/* No colour on the direction, the same reasoning the price
                        history gives: whether a premium is good news depends on
                        which side of the invoice the reader is on. */}
                    <td className="narrow">
                      {line.saving === null ? '—' : (
                        <span className="money-flat">
                          {line.saving > 0 ? '+' : ''}{asMoney(line.saving, product.currency, true)}
                          {line.savingBps !== null && ` (${line.saving > 0 ? '+' : ''}${Math.round(line.savingBps / 100)}%)`}
                        </span>
                      )}
                    </td>
                    <td className="narrow">
                      {(() => {
                        const spent = entry.economics.unitCostByPeriod
                          .find((row) => row.recurrence === line.recurrence);
                        return spent ? asMoney(spent.amount, product.currency) : '—';
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                          if (await confirm(t('product.removePartHint'), t('action.remove'))) {
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
        <div className={formRow}>
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
        <p className="text-label text-muted">{t('product.includedCapabilitiesHint')}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {included.map((id) => <Chip key={id}>{capabilities.get(id)}</Chip>)}
          {!included.length && <span className="text-label text-muted">{t('product.noCapabilities')}</span>}
        </div>
      </div>
      {dialog}
    </div>
  );
}

/* -------------------------------------------------------------- simulation */

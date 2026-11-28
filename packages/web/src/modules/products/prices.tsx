/** What a product costs to buy, over time, and raising it. */
import { useMemo, useState } from 'react';
import { COST_RECURRENCES, PRICE_KINDS, dayBefore, orderKey, overlappingPrices, priceChangeRefusal, priceFor, priceHistory, raisePrice, type Product, type ProductPrice } from '@kolibri/shared';
import { billingKey, priceKindKey } from './product';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { shortDate, today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { cn } from '../../kernel/design-system/cn';
import { noticeWarn } from '../../kernel/design-system/ui/notice';
import { byOrder, termLabel } from './parts';

export function Prices({ product }: { product: Product }) {
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
      <p className="text-label text-muted">{t('product.pricesHint')}</p>
      {canWrite && (
        <div>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> {t('product.addPrice')}
          </Button>
        </div>
      )}
      {clashes.length > 0 && (
        <p className={noticeWarn}>
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
                          onSelect: async () => { if (await confirm(t('product.removePriceHint'), t('action.remove'))) remove('productPrice', price.id); },
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
          <p className="text-label text-muted">{t('product.priceHistoryHint')}</p>
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
                    <td>{change.to.name || t('product.unnamedPrice')} <span className="text-caption text-muted">{t(priceKindKey(change.to.kind))} · {t(billingKey(change.to.recurrence))}</span></td>
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
 * Change a price without leaving the old one live.
 *
 * Two rows in one step, which is the whole point: doing it by hand means
 * remembering to close the current window, and forgetting leaves two prices
 * open at once — `priceFor` then answers deterministically and nobody knows
 * which of the two won. `raisePrice` in `@kolibri/shared` decides the boundary
 * so that the client and MCP cannot disagree about it.
 */
export function RaiseForm({ product, price, onClose }: { product: Product; price: ProductPrice; onClose: () => void }) {
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
      <p className="text-label text-muted">{t('product.raisePriceHint')}</p>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label>{t('product.wasAmount')}</label>
          <p className="text-body">{asMoney(price.amount, product.currency)}</p>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="rp-amount">{t('product.becameAmount')}</label>
          <MoneyInput id="rp-amount" value={amount} currency={product.currency} onChange={setAmount} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="rp-on">{t('product.effectiveFrom')}</label>
          <Input id="rp-on" type="date" value={on} onChange={(event) => setOn(event.target.value)} />
        </div>
      </div>
      {refusal && (
        <p className="text-label money-over">
          {t(refusal === 'before-start' ? 'product.raiseBeforeStart' : 'product.raiseAfterEnd', {
            date: shortDate((refusal === 'before-start' ? price.valid_from : price.valid_to) ?? on),
          })}
        </p>
      )}
      {/* What will actually be written, before it is. The closing date is the
          day before, and somebody should see that rather than discover it. */}
      {!refusal && (
        <p className="text-label text-muted">
          {t('product.raisePreview', {
            old: asMoney(price.amount, product.currency),
            until: shortDate(dayBefore(on)),
            next: asMoney(amount, product.currency),
            from: shortDate(on),
          })}
        </p>
      )}
      {delta !== 0 && (
        <p className="text-label">
          <span className="money-flat">
            {delta > 0 ? '+' : ''}{asMoney(delta, product.currency)}
            {price.amount !== 0 && ` (${delta > 0 ? '+' : ''}${Math.round((delta * 100) / price.amount)}%)`}
          </span>
        </p>
      )}
    </Sheet>
  );
}

export function PriceForm({ product, price, onClose }: { product: Product; price: ProductPrice | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const saveChanges = useSaveChanges('productPrice', price);
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
            if (price) saveChanges(patch);
            else create('productPrice', { ...patch, sort_order: orderKey() });
            toast(t('product.priceSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="pr-name">{t('product.priceName')}</label>
        <Input id="pr-name" value={form.name} placeholder={t('product.priceNamePlaceholder')} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-kind">{t('product.priceKindLabel')}</label>
          <Select id="pr-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ProductPrice['kind'] })}>
            {PRICE_KINDS.map((kind) => <option key={kind} value={kind}>{t(priceKindKey(kind))}</option>)}
          </Select>
          <span className="text-label text-muted">{t('product.priceKindHint')}</span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-amount">{t('product.amount')}</label>
          <MoneyInput id="pr-amount" value={form.amount} currency={product.currency} onChange={(amount) => setForm({ ...form, amount })} />
        </div>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-min">{t('product.minQuantity')}</label>
          <Input id="pr-min" type="number" min={1} value={form.min_quantity}
            onChange={(event) => setForm({ ...form, min_quantity: Math.max(1, Number(event.target.value)) })} />
          <span className="text-label text-muted">{t('product.minQuantityHint')}</span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-rec">{t('product.billingLabel')}</label>
          <Select id="pr-rec" value={form.recurrence} onChange={(event) => setForm({ ...form, recurrence: event.target.value as ProductPrice['recurrence'] })}>
            {COST_RECURRENCES.map((every) => <option key={every} value={every}>{t(billingKey(every))}</option>)}
          </Select>
        </div>
        {/* The field that lets one product be sold at several terms at once.
            Beside the period on purpose: how often it is charged and how long
            they are tied in are the two halves people confuse. */}
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-term">{t('product.priceTerm')}</label>
          <Input id="pr-term" type="number" min={0} value={form.term_months}
            placeholder={String(product.term_months)}
            onChange={(event) => setForm({ ...form, term_months: event.target.value })} />
          <span className="text-label text-muted">
            {t('product.priceTermHint', { term: String(product.term_months) })}
          </span>
        </div>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-from">{t('product.validFrom')}</label>
          <Input id="pr-from" type="date" value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pr-to">{t('product.validTo')}</label>
          <Input id="pr-to" type="date" value={form.valid_to} onChange={(event) => setForm({ ...form, valid_to: event.target.value })} />
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------- costs */

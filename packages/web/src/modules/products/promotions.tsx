/** Campaigns: what is being done to the catalogue, and what it costs to do it. */
import { useMemo, useState } from 'react';
import { PROMOTION_KINDS, PROMOTION_STATUS, orderKey, promotionPhase, promotionReach, stackedPromotions, type Product, type ProductGroup, type ProductPrice, type Promotion } from '@kolibri/shared';
import { phaseKey, promoKindKey, useCatalogue } from './product';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, Textarea, formField, formRow } from '../../kernel/design-system/ui/field';
import { shortDate, today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { cn } from '../../kernel/design-system/cn';
import { noticeWarn } from '../../kernel/design-system/ui/notice';
import { byOrder, payback } from './parts';

export function Promotions() {
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
        <p className={noticeWarn}>
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
                      {' '}<span className="text-caption text-muted">{t(promoKindKey(promotion.kind))}</span>
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
                            onSelect: async () => { if (await confirm(t('product.removePromotionHint'), t('action.remove'))) remove('promotion', promotion.id); },
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
export function PromotionDetail({ promotion, onClose }: { promotion: Promotion; onClose: () => void }) {
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
      <p className="text-label text-muted">{t('product.promoDetailHint')}</p>
      {!reached.length ? (
        <p className={noticeWarn}>{t('product.promoReachesNothing')}</p>
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
      <p className="text-label text-muted">
        {t('product.promoAssumption', {
          uplift: String(Math.round(promotion.uplift_bps / 100)),
          spend: asMoney(promotion.spend, promotion.currency, true),
        })}
      </p>
    </Sheet>
  );
}

export function PromotionForm({ promotion, products, groups, onClose }: {
  promotion: Promotion | null;
  products: Product[];
  groups: ProductGroup[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const saveChanges = useSaveChanges('promotion', promotion);
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
            if (promotion) saveChanges(patch);
            else create('promotion', { ...patch, sort_order: orderKey() });
            toast(t('product.promotionSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="pm-name">{t('product.name')}</label>
        <Input id="pm-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className={formField}>
        <label htmlFor="pm-desc">{t('product.description')}</label>
        <Textarea id="pm-desc" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pm-kind">{t('product.promoKindLabel')}</label>
          <Select id="pm-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Promotion['kind'], value: 0 })}>
            {PROMOTION_KINDS.map((kind) => <option key={kind} value={kind}>{t(promoKindKey(kind))}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
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
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pm-from">{t('product.startsOn')}</label>
          <Input id="pm-from" type="date" value={form.starts_on} onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pm-to">{t('product.endsOn')}</label>
          <Input id="pm-to" type="date" value={form.ends_on} onChange={(event) => setForm({ ...form, ends_on: event.target.value })} />
        </div>
      </div>
      <div className={formField} role="group" aria-labelledby="pr-applies">
        <label id="pr-applies">{t('product.appliesTo')}</label>
        <span className="text-label text-muted">{t('product.appliesToHint')}</span>
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
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pm-spend">{t('product.spend')}</label>
          <MoneyInput id="pm-spend" value={form.spend} currency={form.currency} onChange={(spend) => setForm({ ...form, spend })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pm-uplift">{t('product.uplift')}</label>
          <Input
            id="pm-uplift"
            type="number"
            value={form.uplift / 100}
            onChange={(event) => setForm({ ...form, uplift: Math.round(Number(event.target.value) * 100) })}
          />
          <span className="text-label text-muted">{t('product.upliftHint')}</span>
        </div>
      </div>
      <div className={formField}>
        <label htmlFor="pm-status">{t('product.statusLabel')}</label>
        <Select id="pm-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Promotion['status'] })}>
          {PROMOTION_STATUS.map((status) => (
            <option key={status} value={status}>{t(phaseKey(status))}</option>
          ))}
        </Select>
        <span className="text-label text-muted">{t('product.statusHint')}</span>
      </div>
    </Sheet>
  );
}

/* --------------------------------------------------------------- scenarios */

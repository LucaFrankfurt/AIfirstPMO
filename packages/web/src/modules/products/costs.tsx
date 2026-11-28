/** What a product costs to make and to sell. */
import { useMemo, useState } from 'react';
import { COST_BASIS, COST_CATEGORIES, costsByCategory, orderKey, type CostBasis, type Minor, type Product, type ProductCost } from '@kolibri/shared';
import { BASES, basisKey } from './product';
import { Stat } from '../../kernel/design-system/ui/stat';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { categoryKey } from '../budgets/budget';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { statRow } from '../../kernel/design-system/ui/stat';
import { cn } from '../../kernel/design-system/cn';
import { byOrder } from './parts';
import { DataTable, Td, Th, Tr } from '../../kernel/design-system/ui/data-table';

export function Costs({ product }: { product: Product }) {
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
      <p className="text-label text-muted">{t('product.costsHint')}</p>
      <div className={statRow}>
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
            <DataTable>
              <thead>
                <tr>
                  <Th>{t('product.name')}</Th>
                  <Th>{t('product.basisLabel')}</Th>
                  <Th optional>{t('product.category')}</Th>
                  <Th>{t('product.amount')}</Th>
                  <Th optional>{t('product.vendor')}</Th>
                  {canWrite && <Th />}
                </tr>
              </thead>
              <tbody>
                {[...costs].sort(byOrder).map((cost) => (
                  <Tr key={cost.id}>
                    <Td>{cost.name}</Td>
                    <Td>{t(basisKey(cost.basis))}</Td>
                    <Td optional>{t(categoryKey(cost.category))}</Td>
                    <Td>{asMoney(cost.amount, product.currency)}</Td>
                    <Td optional>{cost.vendor ?? '—'}</Td>
                    {canWrite && (
                      <Td>
                        <MenuButton
                          variant="ghost" size="iconSm"
                          label={t('common.moreActions')}
                          items={[
                          { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(cost) },
                          {
                            id: 'delete',
                            label: t('action.delete'),
                            danger: true,
                            onSelect: async () => { if (await confirm(t('product.removeCostHint'), t('action.remove'))) remove('productCost', cost.id); },
                          },
                          ]}
                        >
                          <Icon name="dots" size={14} />
                        </MenuButton>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </DataTable>
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
            <p className="text-label text-muted">{t('product.byCategoryHint')}</p>
          </div>
        </>
      )}
      {editing !== undefined && <CostForm product={product} cost={editing} onClose={() => setEditing(undefined)} />}
      {dialog}
    </div>
  );
}

export function CostForm({ product, cost, onClose }: { product: Product; cost: ProductCost | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const saveChanges = useSaveChanges('productCost', cost);
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
            if (cost) saveChanges(patch);
            else create('productCost', { ...patch, sort_order: orderKey() });
            toast(t('product.costSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="pc-name">{t('product.name')}</label>
        <Input id="pc-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className={formField}>
        <label htmlFor="pc-basis">{t('product.basisLabel')}</label>
        <Select id="pc-basis" value={form.basis} onChange={(event) => setForm({ ...form, basis: event.target.value as CostBasis })}>
          {COST_BASIS.map((basis) => <option key={basis} value={basis}>{t(basisKey(basis))}</option>)}
        </Select>
        <span className="text-label text-muted">{t(`product.basisHint.${form.basis}` as TranslationKey)}</span>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pc-cat">{t('product.category')}</label>
          <Select id="pc-cat" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as ProductCost['category'] })}>
            {COST_CATEGORIES.map((category) => <option key={category} value={category}>{t(categoryKey(category))}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="pc-amount">{t('product.amount')}</label>
          <MoneyInput id="pc-amount" value={form.amount} currency={product.currency} onChange={(amount) => setForm({ ...form, amount })} />
        </div>
      </div>
      <div className={formField}>
        <label htmlFor="pc-vendor">{t('product.vendor')}</label>
        <Input id="pc-vendor" value={form.vendor} onChange={(event) => setForm({ ...form, vendor: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------------- package */

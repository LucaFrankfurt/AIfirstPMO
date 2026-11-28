/** Making a product, and changing one. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PRODUCT_KINDS, PRODUCT_STATUS, RENEWALS, capabilityKey, orderKey, type Product, type ProductCapability } from '@kolibri/shared';
import { CURRENCIES, SCOPE_UNITS, UNIT_SUGGESTIONS, renewalKey, statusKey } from './product';
import { MoneyInput } from '../../kernel/design-system/ui/money';
import { Sheet, useDirty } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, Textarea, checkRow, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { cn } from '../../kernel/design-system/cn';

export function ProductForm({ product, onClose }: { product?: Product; onClose: () => void }) {
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
  const saveChanges = useSaveChanges('product', product);
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
  const dirty = useDirty({ form, newCapability });
  /* Same question, same answer, same function as the tool and the vocabulary
     screen — see `capabilityKey` in `@kolibri/shared`. */
  const duplicateCapability = useMemo(() => {
    const key = capabilityKey(newCapability);
    return !!key && capabilities.some((row: ProductCapability) => capabilityKey(row.name) === key);
  }, [newCapability, capabilities]);

  return (
    <Sheet
      title={product ? t('product.edit') : t('product.new')}
      onClose={onClose}
      dirty={dirty}
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
              saveChanges(patch);
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
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-name">{t('product.name')}</label>
          <Input id="p-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-code">{t('product.code')}</label>
          <Input id="p-code" value={form.code} placeholder={t('product.codePlaceholder')} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        </div>
      </div>
      <div className={formField}>
        <label htmlFor="p-desc">{t('product.description')}</label>
        <Textarea id="p-desc" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-group">{t('product.group')}</label>
          <Select id="p-group" value={form.group_id} onChange={(event) => setForm({ ...form, group_id: event.target.value })}>
            <option value="">{t('product.ungrouped')}</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-status">{t('product.statusLabel')}</label>
          <Select id="p-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Product['status'] })}>
            {PRODUCT_STATUS.map((status) => <option key={status} value={status}>{t(statusKey(status))}</option>)}
          </Select>
        </div>
        {/* Asked here rather than discovered later. `kind` used to be written
            as `single` on every create and changed only by a button inside the
            package tab's empty state — so the one screen that names packages
            was the one you reached by opening a tab that said this is not one. */}
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-kind">{t('product.kindLabel')}</label>
          <Select id="p-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Product['kind'] })}>
            {PRODUCT_KINDS.map((kind) => (
              <option key={kind} value={kind} disabled={kind === 'single' && parts.length > 0}>
                {t(kind === 'bundle' ? 'product.kindBundle' : 'product.kindSingle')}
              </option>
            ))}
          </Select>
          <span className="text-label text-muted">
            {parts.length > 0
              ? t('product.kindLocked', { count: String(parts.length) })
              : t(form.kind === 'bundle' ? 'product.kindBundleHint' : 'product.kindSingleHint')}
          </span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
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
      <p className="text-label text-muted">{t('product.scopeHint')}</p>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
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
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-scope">{t('product.scopeAmount')}</label>
          <Input id="p-scope" type="number" min={0} value={form.scope_amount}
            onChange={(event) => setForm({ ...form, scope_amount: Math.max(0, Number(event.target.value)) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
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
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={form.capacity !== null}
          onChange={(event) => setForm({ ...form, capacity: event.target.checked ? 12 : null })}
        />
        <span>
          <span>{t('product.capacityApplies')}</span>
          <span className="text-label text-muted">{t('product.capacityAppliesHint')}</span>
        </span>
      </label>
      {form.capacity !== null && (
        <div className={formField}>
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
      <p className="text-label text-muted">{t('product.retentionHint')}</p>
      {/* No billing period here, and the line below says where it went. The
          same product is sold monthly, yearly and two-yearly at once, so one
          select on the product was one answer to a question with several — it
          is a price's business and always was. */}
      <p className="text-label text-muted">{t('product.billingMovedHint')}</p>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-renewal">{t('product.renewalLabel')}</label>
          <Select id="p-renewal" value={form.renewal} onChange={(event) => setForm({ ...form, renewal: event.target.value as Product['renewal'] })}>
            {RENEWALS.map((renewal) => <option key={renewal} value={renewal}>{t(renewalKey(renewal))}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-term">{t('product.termMonths')}</label>
          <Input id="p-term" type="number" min={0} value={form.term_months}
            onChange={(event) => setForm({ ...form, term_months: Math.max(0, Number(event.target.value)) })} />
        </div>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-churn">{t('product.churn')}</label>
          <Input id="p-churn" type="number" min={0} max={100} value={form.churn_bps / 100}
            onChange={(event) => setForm({ ...form, churn_bps: Math.round(Number(event.target.value) * 100) })} />
          <span className="text-label text-muted">{t('product.churnFieldHint')}</span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="p-acq">{t('product.acquisitionCost')}</label>
          <MoneyInput id="p-acq" value={form.acquisition_cost} currency={form.currency} onChange={(acquisition_cost) => setForm({ ...form, acquisition_cost })} />
          <span className="text-label text-muted">{t('product.acquisitionHint')}</span>
        </div>
      </div>

      <SectionHeading>{t('product.capabilities')}</SectionHeading>
      <p className="text-label text-muted">{t('product.capabilitiesHint')}</p>
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
      <div className={cn(formRow, 'pt-2')}>
        <Input
          className="flex-1 min-w-0"
          value={newCapability}
          placeholder={t('product.newCapability')}
          aria-label={t('product.newCapability')}
          onChange={(event) => setNewCapability(event.target.value)}
        />
        <Button
          /* The third door onto the vocabulary, refusing what the other two
             refuse. This one used to create whatever was typed, which is how a
             second spelling gets in without anyone meaning to. */
          disabled={!newCapability.trim() || !!duplicateCapability}
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
      {duplicateCapability && (
        <span className="text-label text-danger">{t('product.capabilityTaken')}</span>
      )}
    </Sheet>
  );
}

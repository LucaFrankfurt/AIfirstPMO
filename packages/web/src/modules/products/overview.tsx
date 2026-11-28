/** A product's first tab: what it is, who it is shared with, how it is doing. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { COST_BASIS, expectedMonths, orderKey, priceFor, retentionCurve, type CatalogueEntry, type CostBasis, type Product, type ProductContributor } from '@kolibri/shared';
import { RetentionBars, UnitBar, basisKey, billingKey, blockedKey, useCapabilityNames } from './product';
import { Stat } from '../../kernel/design-system/ui/stat';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, Textarea, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { Attachments } from '../../kernel/files/Attachments';
import { today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { statRow } from '../../kernel/design-system/ui/stat';
import { cn } from '../../kernel/design-system/cn';
import { noticeWarn } from '../../kernel/design-system/ui/notice';
import { HORIZON, byOrder } from './parts';
import { ProductForm } from './product-form';

export function Overview({ product, entry }: { product: Product; entry: CatalogueEntry }) {
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
      {product.description && <p className="text-body text-muted">{product.description}</p>}

      <div className={statRow}>
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
        <p className="text-label text-muted">
          {t('product.periods')}: {entry.periods.map((every) => t(billingKey(every))).join(' · ')}
        </p>
      )}
      {entry.mixed && <p className={noticeWarn}>{t('product.mixedPeriods')}</p>}

      <div>
        <SectionHeading>{t('product.unitPicture')}</SectionHeading>
        <UnitBar price={entry.economics.price} unitCost={entry.economics.unitCost} currency={currency} />
        <p className="text-label text-muted">{t('product.unitPictureHint')}</p>
      </div>

      <div>
        <SectionHeading>{t('product.breakEven')}</SectionHeading>
        {entry.breakEven.units === null ? (
          <p className={noticeWarn}>{t(blockedKey(entry.breakEven.blocked ?? 'no_price'))}</p>
        ) : (
          <>
            <p className="text-body">
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
            {!entry.breakEven.reachable && <p className={noticeWarn}>{t('product.blocked.over_capacity')}</p>}
          </>
        )}
      </div>

      <div>
        <SectionHeading>{t('product.capabilities')}</SectionHeading>
        <div className="flex flex-wrap gap-2">
          {(product.capabilities ?? []).map((capabilityId) => (
            <Chip key={capabilityId}>{capabilities.get(capabilityId) ?? t('product.unknownCapability')}</Chip>
          ))}
          {!(product.capabilities ?? []).length && <span className="text-label text-muted">{t('product.noCapabilities')}</span>}
        </div>
      </div>

      <Contributors product={product} contributors={contributors} />

      {/* The datasheet, the price list as it went out, the licence terms. A
          catalogue that can model a price to the basis point and cannot hold
          the PDF the price was quoted in is only half a catalogue. */}
      <Attachments on={{ kind: 'product', id: product.id }} />

      <div>
        <SectionHeading>{t('product.retention')}</SectionHeading>
        {product.renewal === 'none' ? (
          <p className="text-label text-muted">{t('product.retentionOneOff')}</p>
        ) : (
          <>
            <div className={statRow}>
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
              <p className={noticeWarn}>
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
export function Contributors({ product, contributors }: { product: Product; contributors: ProductContributor[] }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<ProductContributor | null | undefined>(undefined);

  return (
    <div>
      <SectionHeading>{t('product.contributors')}</SectionHeading>
      <p className="text-label text-muted">{t('product.contributorsHint')}</p>
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
                          onSelect: async () => { if (await confirm(t('product.removeContributorHint'), t('action.remove'))) remove('productContributor', person.id); },
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

export function ContributorForm({ product, person, onClose }: {
  product: Product;
  person: ProductContributor | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const saveChanges = useSaveChanges('productContributor', person);
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
            if (person) saveChanges(patch);
            else create('productContributor', { ...patch, sort_order: orderKey() });
            toast(t('product.contributorSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="co-name">{t('product.name')}</label>
        <Input id="co-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="co-role">{t('product.role')}</label>
          <Input id="co-role" value={form.role} placeholder={t('product.rolePlaceholder')} onChange={(event) => setForm({ ...form, role: event.target.value })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="co-org">{t('product.organisation')}</label>
          <Input id="co-org" value={form.organisation} onChange={(event) => setForm({ ...form, organisation: event.target.value })} />
        </div>
      </div>
      <div className={formField}>
        <label htmlFor="co-email">{t('product.email')}</label>
        <Input id="co-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="co-fee">{t('product.fee')}</label>
          <MoneyInput id="co-fee" value={form.fee} currency={product.currency} onChange={(fee) => setForm({ ...form, fee })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="co-basis">{t('product.basisLabel')}</label>
          <Select id="co-basis" value={form.fee_basis} onChange={(event) => setForm({ ...form, fee_basis: event.target.value as CostBasis })}>
            {COST_BASIS.map((basis) => <option key={basis} value={basis}>{t(basisKey(basis))}</option>)}
          </Select>
        </div>
      </div>
      <div className={formField}>
        <label htmlFor="co-note">{t('product.note')}</label>
        <Textarea id="co-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ prices */

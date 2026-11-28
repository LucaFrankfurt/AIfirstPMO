/** Scenarios and the simulation a product runs them through. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { assumptionsOf, orderKey, promotionPhase, retentionOf, simulate, type Product, type ProductAssumptions, type ProductScenario } from '@kolibri/shared';
import { ProjectionChart, phaseKey } from './product';
import { Stat } from '../../kernel/design-system/ui/stat';
import { asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, formField, formRow } from '../../kernel/design-system/ui/field';
import { today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { statRow } from '../../kernel/design-system/ui/stat';
import { cn } from '../../kernel/design-system/cn';
import { noticeWarn } from '../../kernel/design-system/ui/notice';
import { byOrder } from './parts';

export function Scenarios() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const scenarios = useQuery(() => list('productScenario'), []);
  const products = useQuery(() => list('product'), []);
  const [editing, setEditing] = useState<ProductScenario | null | undefined>(undefined);
  const names = useMemo(() => new Map(products.map((row) => [row.id, row.name])), [products]);

  return (
    <div className="grid gap-3.5">
      <p className="text-label text-muted">{t('product.scenariosHint')}</p>
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
                            onSelect: async () => { if (await confirm(t('product.removeScenarioHint'), t('action.remove'))) remove('productScenario', scenario.id); },
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

export function ScenarioForm({ scenario, products, productId, assumptions, onClose }: {
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
  const saveChanges = useSaveChanges('productScenario', scenario);
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
            if (scenario) saveChanges(patch);
            else create('productScenario', { ...patch, description: null, sort_order: orderKey() });
            toast(t('product.scenarioSaved'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="sc-name">{t('product.name')}</label>
        <Input id="sc-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className={formField}>
        <label htmlFor="sc-product">{t('product.scenarioProduct')}</label>
        <Select id="sc-product" value={form.product_id} onChange={(event) => setForm({ ...form, product_id: event.target.value })}>
          <option value="">{t('product.wholeCatalogue')}</option>
          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </Select>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="sc-months">{t('product.months')}</label>
          <Input id="sc-months" type="number" min={1} max={120} value={form.months}
            onChange={(event) => setForm({ ...form, months: Number(event.target.value) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="sc-units">{t('product.unitsFirstMonth')}</label>
          <Input id="sc-units" type="number" min={0} value={form.units}
            onChange={(event) => setForm({ ...form, units: Number(event.target.value) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="sc-deliveries">{t('product.deliveries')}</label>
          <Input id="sc-deliveries" type="number" min={0} value={form.deliveries}
            onChange={(event) => setForm({ ...form, deliveries: Number(event.target.value) })} />
        </div>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="sc-growth">{t('product.growth')}</label>
          <Input id="sc-growth" type="number" value={form.growth_bps / 100}
            onChange={(event) => setForm({ ...form, growth_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="sc-price">{t('product.priceChange')}</label>
          <Input id="sc-price" type="number" value={form.price_bps / 100}
            onChange={(event) => setForm({ ...form, price_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="sc-cost">{t('product.costChange')}</label>
          <Input id="sc-cost" type="number" value={form.cost_bps / 100}
            onChange={(event) => setForm({ ...form, cost_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
      </div>
      <div className={formField}>
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
      <div className={formField} role="group" aria-labelledby="pf-campaigns">
        <label id="pf-campaigns">{t('product.campaignsApplied')}</label>
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

export function SimulationTab({ product }: { product: Product }) {
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
      <p className="text-label text-muted">{t('product.simulationHint')}</p>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="si-months">{t('product.months')}</label>
          <Input id="si-months" type="number" min={1} max={120} value={settled.months}
            onChange={(event) => setForm({ ...form, months: Number(event.target.value) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="si-units">{t('product.unitsFirstMonth')}</label>
          <Input id="si-units" type="number" min={0} value={settled.units}
            onChange={(event) => setForm({ ...form, units: Number(event.target.value) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="si-growth">{t('product.growth')}</label>
          <Input id="si-growth" type="number" value={settled.growth_bps / 100}
            onChange={(event) => setForm({ ...form, growth_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="si-deliveries">{t('product.deliveries')}</label>
          <Input id="si-deliveries" type="number" min={0} value={settled.deliveries}
            onChange={(event) => setForm({ ...form, deliveries: Number(event.target.value) })} />
        </div>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="si-price">{t('product.priceChange')}</label>
          <Input id="si-price" type="number" value={settled.price_bps / 100}
            onChange={(event) => setForm({ ...form, price_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="si-cost">{t('product.costChange')}</label>
          <Input id="si-cost" type="number" value={settled.cost_bps / 100}
            onChange={(event) => setForm({ ...form, cost_bps: Math.round(Number(event.target.value) * 100) })} />
        </div>
      </div>
      <div className={formField} role="group" aria-labelledby="ps-campaigns">
        <label id="ps-campaigns">{t('product.campaignsApplied')}</label>
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
              {promotion.name} <span className="text-caption">{t(phaseKey(promotionPhase(promotion, day)))}</span>
            </Chip>
          ))}
          {!promotions.length && <span className="text-label text-muted">{t('product.noPromotionsYet')}</span>}
        </div>
      </div>

      <div className={statRow}>
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
        <p className={noticeWarn}>{t('product.turnedAway', { units: String(result.turnedAway) })}</p>
      )}
      {result.price !== null && result.listPrice !== null && result.price !== result.listPrice && (
        <p className="text-label text-muted">
          {t('product.priceAfter', {
            list: asMoney(result.listPrice, result.currency),
            price: asMoney(result.price, result.currency),
          })}
        </p>
      )}

      <ProjectionChart simulation={result} caption={t('product.projectionCaption', { name: product.name })} />

      {product.renewal !== 'none' && (
        <p className="text-label text-muted">
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

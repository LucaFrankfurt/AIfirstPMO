/**
 * The estate's shared parts: how a component reads, how a cost reads, and the
 * forms behind both.
 *
 * Everything is computed from the local mirror through `landscape.ts`, so the
 * register works on a train and an assistant answering `landscape` over MCP
 * cannot quote a different estate from the one on screen.
 */
import { useMemo, useState } from 'react';
import {
  COMPONENT_KINDS, COST_RECURRENCES, ENVIRONMENTS, LIFECYCLES, MOVE_STATUS, VENDOR_KINDS,
  annualCost, flattenTree, formatMoney, livenessOn, noticeBy, oneOffCost, treeOf,
  type Component, type ComponentKind, type Lifecycle, type Liveness, type Move, type MoneyByCurrency,
  type Vendor,
} from '@kolibri/shared';
import { currentLocale, useT, type TranslationKey } from '../lib/i18n';
import { today } from '../lib/format';
import { create, update } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useMembers } from '../session';
import { Sheet } from './ui';
import { Button } from './ui/button';
import { Chip } from './ui/chip';
import { Input, Select, Textarea } from './ui/field';
import { MoneyInput } from './ui/money';

export const kindKey = (kind: string): TranslationKey => `estate.kind.${kind}` as TranslationKey;
export const envKey = (env: string): TranslationKey => `estate.env.${env}` as TranslationKey;
export const lifecycleKey = (state: string): TranslationKey => `estate.status.${state}` as TranslationKey;
export const vendorKindKey = (kind: string): TranslationKey => `estate.vendorKind.${kind}` as TranslationKey;
export const moveStatusKey = (status: string): TranslationKey => `estate.moveStatus.${status}` as TranslationKey;
export const livenessKey = (state: Liveness): TranslationKey => `estate.liveness.${state}` as TranslationKey;

/**
 * Written out rather than interpolated, so `check:css` can see the names. Only
 * the two that carry meaning get a colour: something on its way out, and
 * something that is not in any landscape yet.
 */
const LIFECYCLE_CLASS: Record<Lifecycle, string> = {
  planned: 'health-tight',
  live: 'health-healthy',
  retiring: 'stage-committed',
  retired: '',
};

export function Lifecycles({ status }: { status: Lifecycle }) {
  const t = useT();
  return <Chip className={LIFECYCLE_CLASS[status]}>{t(lifecycleKey(status))}</Chip>;
}

/** A list of amounts per currency. Nothing here adds two — see `Budget.currency`. */
export function Cost({ of, empty = '—', compact = false }: {
  of: MoneyByCurrency[];
  empty?: string;
  compact?: boolean;
}) {
  if (!of.length) return <span className="money-flat">{empty}</span>;
  return (
    <span className="tabular-nums">
      {of.map((row) => formatMoney(row.amount, row.currency, currentLocale(), { compact })).join(' + ')}
    </span>
  );
}

/** A delta, with the sign spelled out — colour is never the only channel. */
export function Delta({ of }: { of: MoneyByCurrency[] }) {
  const t = useT();
  if (!of.length) return <span className="money-flat">{t('estate.noChange')}</span>;
  return (
    <span className="tabular-nums">
      {of.map((row) => (
        <span key={row.currency} className={row.amount > 0 ? 'money-over' : 'money-under'}>
          {formatMoney(Math.abs(row.amount), row.currency, currentLocale(), { compact: true })}
          {' '}
          {row.amount > 0 ? t('estate.more') : t('estate.less')}
        </span>
      ))}
    </span>
  );
}

/** What one component costs in a year, or what it cost to buy. */
export function ComponentCost({ component }: { component: Component }) {
  const t = useT();
  const yearly = annualCost(component);
  if (yearly === null) {
    const once = oneOffCost(component);
    if (!once) return <span className="money-flat">—</span>;
    return (
      <span className="tabular-nums" title={t('estate.oneOffHint')}>
        {formatMoney(once, component.currency, currentLocale())} {t('estate.once')}
      </span>
    );
  }
  if (!yearly) return <span className="money-flat">—</span>;
  return (
    <span className="tabular-nums">{formatMoney(yearly, component.currency, currentLocale())}{t('estate.perYear')}</span>
  );
}

/* ------------------------------------------------------------------ rows */

export interface ComponentRow {
  component: Component;
  depth: number;
}

/**
 * The register as a tree, flattened to rows with a depth each.
 *
 * A component whose parent is filtered out comes back at the top rather than
 * disappearing with it — see `treeOf`. A register that hides a running instance
 * because somebody filtered its host is a register that is wrong about what is
 * running, which is the one thing it exists to be right about.
 */
export function useComponentRows(components: Component[]): ComponentRow[] {
  return useMemo(() => flattenTree(treeOf(components)), [components]);
}

export const useVendorMap = (): Map<string, Vendor> => {
  const vendors = useQuery(() => list('vendor'), []);
  return useMemo(() => new Map(vendors.map((row) => [row.id, row])), [vendors]);
};

/* ------------------------------------------------------------------ forms */

export function ComponentForm({ component, onClose }: { component: Component | null; onClose: () => void }) {
  const t = useT();
  const members = useMembers();
  const vendors = useQuery(() => list('vendor', (row) => !row.archived), []);
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const components = useQuery(() => list('component'), []);
  const budgets = useQuery(() => list('budget', (row) => !row.archived), []);
  const lines = useQuery(() => list('budgetLine'), []);

  const [form, setForm] = useState(() => ({
    name: component?.name ?? '',
    kind: component?.kind ?? ('server' as ComponentKind),
    environment: component?.environment ?? 'production',
    status: component?.status ?? 'live',
    vendor_id: component?.vendor_id ?? '',
    parent_id: component?.parent_id ?? '',
    live_from: component?.live_from ?? '',
    live_until: component?.live_until ?? '',
    location: component?.location ?? '',
    reference: component?.reference ?? '',
    amount: component?.amount ?? 0,
    recurrence: component?.recurrence ?? 'monthly',
    currency: component?.currency ?? 'EUR',
    line_id: component?.line_id ?? '',
    owner_id: component?.owner_id ?? '',
    note: component?.note ?? '',
  }));
  const [depends, setDepends] = useState<string[]>(component?.projects ?? []);

  /* A component cannot be its own parent, and the server refuses a longer loop
     — but offering the choice and then quietly ignoring it is worse than not
     offering it. Its own descendants are left out for the same reason. */
  const descendants = useMemo(() => {
    if (!component) return new Set<string>();
    const out = new Set<string>([component.id]);
    let added = true;
    while (added) {
      added = false;
      for (const row of components) {
        if (row.parent_id && out.has(row.parent_id) && !out.has(row.id)) { out.add(row.id); added = true; }
      }
    }
    return out;
  }, [component, components]);

  const lineName = (id: string) => {
    const line = lines.find((row) => row.id === id);
    const budget = budgets.find((row) => row.id === line?.budget_id);
    return line ? `${budget?.name ?? '—'} · ${line.name}` : '';
  };

  const save = () => {
    const patch = {
      name: form.name.trim(),
      kind: form.kind,
      environment: form.environment,
      status: form.status,
      vendor_id: form.vendor_id || null,
      parent_id: form.parent_id || null,
      live_from: form.live_from || null,
      live_until: form.live_until || null,
      location: form.location.trim() || null,
      reference: form.reference.trim() || null,
      amount: form.amount,
      recurrence: form.recurrence,
      currency: form.currency,
      line_id: form.line_id || null,
      owner_id: form.owner_id || null,
      projects: depends,
      note: form.note.trim() || null,
    };
    if (component) update('component', component.id, patch);
    else create('component', { ...patch, sort_order: 'V' });
    onClose();
  };

  /* Said on the form rather than discovered on the landscape screen: a planned
     component with no start date is in no landscape at all, present or future. */
  const inNoLandscape = livenessOn(
    { status: form.status as Lifecycle, live_from: form.live_from || null, live_until: form.live_until || null },
    today(),
  ) === 'undated';

  return (
    <Sheet
      title={component ? t('estate.component') : t('estate.addComponent')}
      wide
      onClose={onClose}
      footer={<Button variant="primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</Button>}
    >
      <div className="field">
        <label htmlFor="c-name">{t('estate.name')}</label>
        <Input
          id="c-name"
          autoFocus
          placeholder={t('estate.namePlaceholder')}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-kind">{t('estate.kindLabel')}</label>
          <Select id="c-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ComponentKind })}>
            {COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kindKey(kind))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-env">{t('estate.environment')}</label>
          <Select id="c-env" value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value as typeof form.environment })}>
            {ENVIRONMENTS.map((env) => <option key={env} value={env}>{t(envKey(env))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-status">{t('estate.statusLabel')}</label>
          <Select id="c-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Lifecycle })}>
            {LIFECYCLES.map((state) => <option key={state} value={state}>{t(lifecycleKey(state))}</option>)}
          </Select>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-vendor">{t('estate.vendor')}</label>
          <Select id="c-vendor" value={form.vendor_id} onChange={(event) => setForm({ ...form, vendor_id: event.target.value })}>
            <option value="">{t('estate.noVendor')}</option>
            {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-parent">{t('estate.runsOn')}</label>
          <Select id="c-parent" value={form.parent_id} onChange={(event) => setForm({ ...form, parent_id: event.target.value })}>
            <option value="">{t('estate.nothing')}</option>
            {components.filter((row) => !descendants.has(row.id)).map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-from">{t('estate.liveFrom')}</label>
          <Input id="c-from" type="date" value={form.live_from} onChange={(event) => setForm({ ...form, live_from: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-until">{t('estate.liveUntil')}</label>
          <Input id="c-until" type="date" value={form.live_until} onChange={(event) => setForm({ ...form, live_until: event.target.value })} />
        </div>
      </div>
      <p className={`text-[12px] ${inNoLandscape ? 'text-warn' : 'text-muted'}`}>
        {inNoLandscape ? t('estate.undatedWarning') : t('estate.datesHint')}
      </p>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-amount">{t('budget.amount')}</label>
          <MoneyInput id="c-amount" currency={form.currency} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-every">{t('budget.recurrence')}</label>
          <Select id="c-every" value={form.recurrence} onChange={(event) => setForm({ ...form, recurrence: event.target.value as typeof form.recurrence })}>
            {COST_RECURRENCES.map((every) => (
              <option key={every} value={every}>{t(`budget.recurrence.${every}` as TranslationKey)}</option>
            ))}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-currency">{t('budget.currency')}</label>
          <Input id="c-currency" maxLength={3} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} />
        </div>
      </div>

      {lines.length > 0 && (
        <div className="field">
          <label htmlFor="c-line">{t('estate.chargedTo')}</label>
          <Select id="c-line" value={form.line_id} onChange={(event) => setForm({ ...form, line_id: event.target.value })}>
            <option value="">{t('estate.notBudgeted')}</option>
            {lines.map((line) => <option key={line.id} value={line.id}>{lineName(line.id)}</option>)}
          </Select>
          <span className="text-[12px] text-muted">{t('estate.chargedToHint')}</span>
        </div>
      )}

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-location">{t('estate.location')}</label>
          <Input id="c-location" placeholder={t('estate.locationPlaceholder')} value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-ref">{t('estate.reference')}</label>
          <Input id="c-ref" placeholder={t('estate.referencePlaceholder')} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-owner">{t('estate.owner')}</label>
          <Select id="c-owner" value={form.owner_id} onChange={(event) => setForm({ ...form, owner_id: event.target.value })}>
            <option value="">{t('common.nobody')}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </Select>
        </div>
      </div>

      <div className="field">
        <label>{t('estate.dependsOn')}</label>
        <span className="text-[12px] text-muted">{t('estate.dependsOnHint')}</span>
        <div className="scope-picker">
          {projects.map((project) => (
            <label className="check-row" key={project.id}>
              <input
                type="checkbox"
                checked={depends.includes(project.id)}
                onChange={(event) => setDepends(event.target.checked
                  ? [...depends, project.id]
                  : depends.filter((id) => id !== project.id))}
              />
              <span><span>{project.name}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="c-note">{t('budget.adjNote')}</label>
        <Textarea id="c-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

export function VendorForm({ vendor, onClose }: { vendor: Vendor | null; onClose: () => void }) {
  const t = useT();
  const [form, setForm] = useState(() => ({
    name: vendor?.name ?? '',
    kind: vendor?.kind ?? 'cloud',
    website: vendor?.website ?? '',
    contact: vendor?.contact ?? '',
    contract_start: vendor?.contract_start ?? '',
    contract_end: vendor?.contract_end ?? '',
    notice_days: vendor?.notice_days ?? 0,
    note: vendor?.note ?? '',
  }));

  const notice = noticeBy({ contract_end: form.contract_end || null, notice_days: form.notice_days });

  return (
    <Sheet
      title={vendor ? t('estate.vendor') : t('estate.addVendor')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const patch = {
              name: form.name.trim(),
              kind: form.kind,
              website: form.website.trim() || null,
              contact: form.contact.trim() || null,
              contract_start: form.contract_start || null,
              contract_end: form.contract_end || null,
              notice_days: form.notice_days,
              note: form.note.trim() || null,
              archived: 0,
            };
            if (vendor) update('vendor', vendor.id, patch);
            else create('vendor', patch);
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-name">{t('estate.name')}</label>
          <Input id="v-name" autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-kind">{t('estate.kindLabel')}</label>
          <Select id="v-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as typeof form.kind })}>
            {VENDOR_KINDS.map((kind) => <option key={kind} value={kind}>{t(vendorKindKey(kind))}</option>)}
          </Select>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-site">{t('estate.website')}</label>
          <Input id="v-site" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-contact">{t('estate.contact')}</label>
          <Input id="v-contact" value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} />
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-start">{t('estate.contractStart')}</label>
          <Input id="v-start" type="date" value={form.contract_start} onChange={(event) => setForm({ ...form, contract_start: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-end">{t('estate.contractEnd')}</label>
          <Input id="v-end" type="date" value={form.contract_end} onChange={(event) => setForm({ ...form, contract_end: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="v-notice">{t('estate.noticeDays')}</label>
          <Input
            id="v-notice"
            type="number"
            min={0}
            value={form.notice_days || ''}
            onChange={(event) => setForm({ ...form, notice_days: Math.max(0, Number(event.target.value) || 0) })}
          />
        </div>
      </div>
      {/* The date that actually matters, worked out while somebody types the
          two numbers it comes from. A renewal that surprises anybody almost
          always surprised them on this day rather than on the end date. */}
      <p className="text-[12px] text-muted">
        {notice && form.notice_days ? t('estate.noticeBy', { date: notice }) : t('estate.noticeHint')}
      </p>

      <div className="field">
        <label htmlFor="v-note">{t('budget.adjNote')}</label>
        <Textarea id="v-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

export function MoveForm({ move, onClose }: { move: Move | null; onClose: () => void }) {
  const t = useT();
  const components = useQuery(() => list('component'), []);
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const [form, setForm] = useState(() => ({
    name: move?.name ?? '',
    description: move?.description ?? '',
    status: move?.status ?? 'proposed',
    target_date: move?.target_date ?? '',
    project_id: move?.project_id ?? '',
  }));
  const [leaving, setLeaving] = useState<string[]>(move?.leaving ?? []);
  const [arriving, setArriving] = useState<string[]>(move?.arriving ?? []);

  /** One picker, used twice. A component can be on both lists — a machine that
      is rebuilt rather than replaced legitimately leaves and arrives. */
  const picker = (chosen: string[], set: (next: string[]) => void, label: string) => (
    <div className="field">
      <label>{label}</label>
      <div className="scope-picker">
        {components.map((component) => (
          <label className="check-row" key={component.id}>
            <input
              type="checkbox"
              checked={chosen.includes(component.id)}
              onChange={(event) => set(event.target.checked
                ? [...chosen, component.id]
                : chosen.filter((id) => id !== component.id))}
            />
            <span>
              <span>{component.name}</span>
              <span className="text-[12px] text-muted">{t(kindKey(component.kind))}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <Sheet
      title={move ? t('estate.move') : t('estate.addMove')}
      wide
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() => {
            const patch = {
              name: form.name.trim(),
              description: form.description.trim() || null,
              status: form.status,
              leaving,
              arriving,
              target_date: form.target_date || null,
              project_id: form.project_id || null,
            };
            if (move) update('move', move.id, patch);
            else create('move', { ...patch, sort_order: 'V' });
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field">
        <label htmlFor="m-name">{t('estate.name')}</label>
        <Input
          id="m-name"
          autoFocus
          placeholder={t('estate.movePlaceholder')}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="m-desc">{t('budget.description')}</label>
        <Textarea id="m-desc" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="m-status">{t('estate.statusLabel')}</label>
          <Select id="m-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as typeof form.status })}>
            {MOVE_STATUS.map((status) => <option key={status} value={status}>{t(moveStatusKey(status))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="m-date">{t('estate.targetDate')}</label>
          <Input id="m-date" type="date" value={form.target_date} onChange={(event) => setForm({ ...form, target_date: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="m-project">{t('estate.doneBy')}</label>
          <Select id="m-project" value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value })}>
            <option value="">{t('estate.noProject')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </div>
      </div>

      {picker(leaving, setLeaving, t('estate.retires'))}
      {picker(arriving, setArriving, t('estate.bringsIn'))}
      <p className="text-[12px] text-muted">{t('estate.moveHint')}</p>
    </Sheet>
  );
}

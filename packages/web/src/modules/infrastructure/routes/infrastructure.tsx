/**
 * The estate: what runs, what it will run, and how you get from one to the
 * other.
 *
 * Four tabs, and the second is the one the feature exists for. **Landscape**
 * takes two dates and answers what goes, what arrives and what the difference
 * costs — because a landscape here is a date rather than a document, so
 * "current" and "future" are the same screen asked twice rather than two lists
 * somebody has to keep in step by hand. See `landscape.ts`.
 */
import { useMemo, useState } from 'react';
import {
  compareLandscapes, costOfLandscape, landscapeOn, livenessOn, moveProgress, noticeBy, noticeDue,
  type Component, type Move, type Vendor,
} from '@kolibri/shared';
import { useSearchParams } from 'react-router-dom';
import { Header } from '../../../kernel/design-system/AppShell';
import {
  ComponentCost, ComponentForm, Cost, Delta, Lifecycles, MoveForm, VendorForm,
  envKey, kindKey, moveStatusKey, useComponentRows, useVendorMap, vendorKindKey,
} from '../landscape';
import { Stat } from '../../planning/insights';
import { Empty, Icon, useConfirm } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Input, Select } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { shortDate, today } from '../../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { remove } from '../../../kernel/sync/mutations';
import { list, useQuery } from '../../../kernel/sync/store';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { useCanWrite, useFeature } from '../../../kernel/identity/session';

const TABS = ['register', 'landscape', 'moves', 'vendors'] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TranslationKey> = {
  register: 'estate.tabRegister',
  landscape: 'estate.tabLandscape',
  moves: 'estate.tabMoves',
  vendors: 'estate.tabVendors',
};

/** Six months out — far enough that a plan has happened, near enough to be real. */
const defaultFuture = (): string => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + 6);
  return date.toISOString().slice(0, 10);
};

export function Infrastructure() {
  const t = useT();
  const enabled = useFeature('infrastructure');
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(asked as Tab) ? asked as Tab : 'register');
  const strip = useTabStrip(tab);

  if (!enabled) {
    return (
      <>
        <Header title={t('estate.title')} />
        <Empty emoji="🔕" title={t('estate.offTitle')} hint={t('estate.offHint')} />
      </>
    );
  }

  return (
    <>
      <Header title={t('estate.title')} />
      <div ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {TABS.map((name) => (
          <button
            key={name}
            className={tab === name ? 'active' : ''}
            onClick={() => {
              setTab(name);
              setParams(name === 'register' ? {} : { tab: name }, { replace: true });
            }}
          >
            {t(TAB_KEY[name])}
          </button>
        ))}
      </div>
      {tab === 'register' && <Register />}
      {tab === 'landscape' && <Landscape />}
      {tab === 'moves' && <Moves />}
      {tab === 'vendors' && <Vendors />}
    </>
  );
}

/* --------------------------------------------------------------- register */

function Register() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const vendors = useVendorMap();
  const [editing, setEditing] = useState<Component | 'new' | null>(null);
  const [environment, setEnvironment] = useState('');
  const [showRetired, setShowRetired] = useState(false);

  const all = useQuery(() => list('component'), []);
  const filtered = useMemo(() => all
    .filter((row) => (environment ? row.environment === environment : true))
    // Retired components are kept and hidden by default: they are the answer to
    // "what used to run here", which somebody asks about twice a year.
    .filter((row) => (showRetired ? true : row.status !== 'retired')),
  [all, environment, showRetired]);
  const rows = useComponentRows(filtered);
  const cost = useMemo(() => costOfLandscape(landscapeOn(all, today())), [all]);

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="kpi-row">
        <Stat label={t('estate.running')} value={String(landscapeOn(all, today()).length)} hint={t('estate.runningHint')} />
        <div className="stat">
          <span className="stat-label">{t('estate.annualRunRate')}</span>
          <strong className="stat-value"><Cost of={cost.annual} compact /></strong>
          {cost.unpriced > 0 && <span className="stat-hint">{t('estate.unpriced', { count: cost.unpriced })}</span>}
        </div>
        <div className="stat">
          <span className="stat-label">{t('estate.bought')}</span>
          <strong className="stat-value"><Cost of={cost.oneOff} compact /></strong>
          <span className="stat-hint">{t('estate.oneOffHint')}</span>
        </div>
      </div>

      <div className="week-bar">
        <Select className="w-auto" aria-label={t('estate.environment')} value={environment} onChange={(event) => setEnvironment(event.target.value)}>
          <option value="">{t('estate.allEnvironments')}</option>
          {['production', 'staging', 'development', 'shared'].map((env) => (
            <option key={env} value={env}>{t(envKey(env))}</option>
          ))}
        </Select>
        <label className="target-field">
          <input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} />
          {t('estate.showRetired')}
        </label>
        <div className="flex-1 min-w-0" />
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('estate.addComponent')}
          </Button>
        )}
      </div>

      {!rows.length ? (
        <Empty emoji="🗄️" title={t('estate.emptyTitle')} hint={t('estate.emptyHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('estate.name')}</th>
                <th>{t('estate.kindLabel')}</th>
                <th>{t('estate.environment')}</th>
                <th>{t('estate.vendor')}</th>
                <th>{t('estate.statusLabel')}</th>
                <th>{t('estate.window')}</th>
                <th className="num">{t('estate.cost')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ component, depth }) => (
                <tr key={component.id} onClick={() => canWrite && setEditing(component)}>
                  <td className="title">
                    {/* Depth as padding rather than as a separate column: an
                        instance is a thing on a machine, not a different kind
                        of row. */}
                    <span style={{ paddingInlineStart: depth * 18 }}>
                      {depth > 0 && <span className="tree-branch" aria-hidden>└ </span>}
                      {component.name}
                    </span>
                    {component.reference && <span className="row-sub" style={{ paddingInlineStart: depth * 18 }}>{component.reference}</span>}
                  </td>
                  <td>{t(kindKey(component.kind))}</td>
                  <td>{t(envKey(component.environment))}</td>
                  <td>{vendors.get(component.vendor_id ?? '')?.name ?? <span className="text-muted">—</span>}</td>
                  <td><Lifecycles status={component.status} /></td>
                  <td className="text-[12px] text-muted">
                    {component.live_from ? shortDate(component.live_from) : '—'}
                    {component.live_until ? ` → ${shortDate(component.live_until)}` : ''}
                  </td>
                  <td className="num">
                    <ComponentCost component={component} />
                    {component.line_id && <span className="row-sub">{t('estate.budgeted')}</span>}
                  </td>
                  <td>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (await confirm(t('estate.deleteComponent', { name: component.name }))) {
                            remove('component', component.id);
                          }
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ComponentForm component={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {dialog}
    </div>
  );
}

/* -------------------------------------------------------------- landscape */

/**
 * Two dates, and everything that follows from them.
 *
 * The screen the feature exists for. Nothing here is stored: pick a day and the
 * estate as of that day falls out of the rows already in the register, so the
 * future never goes stale and nobody has to remember to move a component from
 * one list to another when the day arrives.
 */
function Landscape() {
  const t = useT();
  const vendors = useVendorMap();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(defaultFuture());
  const components = useQuery(() => list('component'), []);
  const diff = useMemo(() => compareLandscapes(components, from, to), [components, from, to]);

  const brief = (rows: Component[], tone: string) => (
    <ul className={`landscape-list ${tone}`}>
      {rows.map((component) => (
        <li key={component.id}>
          <span className="flex-1 min-w-0 truncate">{component.name}</span>
          <span className="text-[12px] text-muted">{t(kindKey(component.kind))}</span>
          <span className="text-[12px] text-muted">{vendors.get(component.vendor_id ?? '')?.name ?? ''}</span>
          <ComponentCost component={component} />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="week-bar">
        <label className="target-field">
          {t('estate.from')}
          <Input type="date" className="w-auto" value={from} onChange={(event) => setFrom(event.target.value || today())} />
        </label>
        <label className="target-field">
          {t('estate.to')}
          <Input type="date" className="w-auto" value={to} onChange={(event) => setTo(event.target.value || today())} />
        </label>
        <div className="flex-1 min-w-0" />
        <Button size="sm" onClick={() => { setFrom(today()); setTo(defaultFuture()); }}>{t('estate.reset')}</Button>
      </div>

      <div className="kpi-row">
        <div className="stat">
          <span className="stat-label">{t('estate.costNow')}</span>
          <strong className="stat-value"><Cost of={diff.costFrom.annual} compact /></strong>
          <span className="stat-hint">{t('estate.componentCount', { count: diff.costFrom.components })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('estate.costThen')}</span>
          <strong className="stat-value"><Cost of={diff.costTo.annual} compact /></strong>
          <span className="stat-hint">{t('estate.componentCount', { count: diff.costTo.components })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('estate.difference')}</span>
          <strong className="stat-value"><Delta of={diff.annualDelta} /></strong>
          <span className="stat-hint">{t('estate.perYearHint')}</span>
        </div>
      </div>

      {/* Said rather than left to be discovered. A planned component with no
          start date is in neither answer, and a screen that quietly left it out
          of both would stop describing the plan. */}
      {diff.undated.length > 0 && (
        <div className="notice-strip">
          <Icon name="help" size={14} />
          <span>{t('estate.undatedCount', { count: diff.undated.length })}</span>
          <span className="text-[12px] text-muted truncate">
            {diff.undated.map((component) => component.name).join(', ')}
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <SectionHeading tight>{t('estate.leaving', { count: diff.leaving.length })}</SectionHeading>
          {diff.leaving.length ? brief(diff.leaving, 'leaving') : <p className="text-[13px] text-muted">{t('estate.nothingLeaves')}</p>}
        </div>
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <SectionHeading tight>{t('estate.arriving', { count: diff.arriving.length })}</SectionHeading>
          {diff.arriving.length ? brief(diff.arriving, 'arriving') : <p className="text-[13px] text-muted">{t('estate.nothingArrives')}</p>}
        </div>
      </div>

      <p className="mt-3 text-[12px] text-muted">{t('estate.stayingCount', { count: diff.staying.length })}</p>
      <p className="text-[12px] text-muted">{t('estate.landscapeHint')}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ moves */

function Moves() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Move | 'new' | null>(null);
  const components = useQuery(() => list('component'), []);
  const moves = useQuery(() => list('move'), []);
  const byId = useMemo(() => new Map(components.map((row) => [row.id, row.name])), [components]);
  const day = today();

  const sorted = useMemo(
    () => [...moves].sort((a, b) => (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999')),
    [moves],
  );

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <p className="text-[12px] text-muted">{t('estate.movesHint')}</p>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('estate.addMove')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="🧭" title={t('estate.noMoves')} hint={t('estate.noMovesHint')} />
      ) : (
        <div className="scenario-list">
          {sorted.map((move) => {
            const progress = moveProgress(move, components, day);
            return (
              <div className="move-card" key={move.id}>
                <div className="move-head">
                  <strong className="flex-1 min-w-0 truncate">{move.name}</strong>
                  <Chip>{t(moveStatusKey(move.status))}</Chip>
                  {move.target_date && <span className="text-[12px] text-muted">{shortDate(move.target_date)}</span>}
                  {canWrite && (
                    <>
                      <Button variant="ghost" size="icon" aria-label={t('action.edit')} onClick={() => setEditing(move)}>
                        <Icon name="pencil" size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async () => {
                          if (await confirm(t('estate.deleteMove', { name: move.name }))) remove('move', move.id);
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    </>
                  )}
                </div>
                {move.description && <p className="move-desc">{move.description}</p>}
                <div className="move-lists">
                  {move.leaving.length > 0 && (
                    <span className="move-side">
                      <b>{t('estate.retires')}</b> {move.leaving.map((id) => byId.get(id) ?? id).join(', ')}
                    </span>
                  )}
                  {move.arriving.length > 0 && (
                    <span className="move-side">
                      <b>{t('estate.bringsIn')}</b> {move.arriving.map((id) => byId.get(id) ?? id).join(', ')}
                    </span>
                  )}
                </div>
                {progress.done !== null && (
                  <div className="move-progress">
                    <span className="bar-track">
                      {/* Nothing at all at zero. `.bar-fill` carries a 2px
                          minimum so a small share stays visible, which on a
                          move nobody has started draws a stub that says some
                          of it is done. */}
                      {progress.done > 0 && (
                        <span className="bar-fill" style={{ width: `${progress.done * 100}%`, background: 'var(--chart-2)' }} />
                      )}
                    </span>
                    <span className="text-[12px] text-muted">
                      {t('estate.moveDone', { done: progress.retired + progress.arrived, total: progress.retiring + progress.arriving })}
                    </span>
                  </div>
                )}
                {/* The register against the claim. A move marked done with a
                    server still running is the discrepancy this exists to find
                    — a plan nobody executed reads exactly like one that was. */}
                {progress.disagrees && (
                  <p className="move-warning">
                    <Icon name="help" size={13} /> {t('estate.moveDisagrees')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && <MoveForm move={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {dialog}
    </div>
  );
}

/* ---------------------------------------------------------------- vendors */

function Vendors() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);
  const vendors = useQuery(() => list('vendor', (row) => !row.archived), []);
  const components = useQuery(() => list('component'), []);
  const day = today();
  const due = useMemo(() => noticeDue(vendors, day, 90), [vendors, day]);

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      {/* Notice periods, first, because this is the one thing in the register
          with a deadline on it — and the date somebody misses is this one
          rather than the contract's end. */}
      {due.length > 0 && (
        <div className="notice-strip warn">
          <Icon name="bell" size={14} />
          <span>{t('estate.noticeDue', { count: due.length })}</span>
          <span className="text-[12px] truncate">
            {due.map((row) => `${row.vendor.name} — ${shortDate(row.by)}`).join(' · ')}
          </span>
        </div>
      )}

      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('estate.addVendor')}
          </Button>
        </div>
      )}

      {!vendors.length ? (
        <Empty emoji="🏷️" title={t('estate.noVendors')} hint={t('estate.noVendorsHint')} />
      ) : (
        <div className="table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>{t('estate.vendor')}</th>
                <th>{t('estate.kindLabel')}</th>
                <th className="num">{t('estate.components')}</th>
                <th className="num">{t('estate.annualRunRate')}</th>
                <th>{t('estate.contractEnd')}</th>
                <th>{t('estate.noticeByColumn')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vendors.map((vendor) => {
                const theirs = landscapeOn(components.filter((row) => row.vendor_id === vendor.id), day);
                const cost = costOfLandscape(theirs);
                const notice = noticeBy(vendor);
                return (
                  <tr key={vendor.id} onClick={() => canWrite && setEditing(vendor)}>
                    <td className="title">
                      {vendor.name}
                      {vendor.contact && <span className="row-sub">{vendor.contact}</span>}
                    </td>
                    <td>{t(vendorKindKey(vendor.kind))}</td>
                    <td className="num">{theirs.length}</td>
                    <td className="num"><Cost of={cost.annual} /></td>
                    <td>{vendor.contract_end ? shortDate(vendor.contract_end) : <span className="text-muted">—</span>}</td>
                    <td>{notice && vendor.notice_days ? shortDate(notice) : <span className="text-muted">—</span>}</td>
                    <td>
                      {canWrite && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('action.delete')}
                          onClick={async (event) => {
                            event.stopPropagation();
                            if (await confirm(t('estate.deleteVendor', { name: vendor.name }))) {
                              remove('vendor', vendor.id);
                            }
                          }}
                        >
                          <Icon name="trash" size={14} />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && <VendorForm vendor={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {dialog}
    </div>
  );
}

/** Whether a component is in any landscape at all. Used by the register's rows. */
export const inALandscape = (component: Component, day: string): boolean =>
  livenessOn(component, day) !== 'undated';

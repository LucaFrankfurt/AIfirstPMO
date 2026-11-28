/**
 * The KPI screens: what is being watched, what it reads, and what it has to
 * reach.
 *
 * The index leads with the list, worst first — see the note under Layout in
 * `docs/design.md` for why an index does that. The detail is three tabs in the
 * order somebody uses them: the picture, the readings behind it, and the
 * promises made about it.
 *
 * Everything is computed on render from the local mirror, so it works offline
 * and the server's MCP answer cannot differ from the screen — which matters
 * more here than anywhere else, because "on track" is a judgement and two
 * implementations of a judgement are two judgements.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  MEASURE_CADENCES, MEASURE_DIRECTIONS, MEASURE_HEALTH, MEASURE_UNITS,
  byMeasuredOn, coversProject, dueOn, orderKey, progressOf, projectScope, promisedBy,
  seriesOf, summarise, trendOf,
  type Kpi, type KpiReading, type KpiTarget, type MeasureCadence, type MeasureDirection,
  type MeasureUnit,
} from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import {
  Health, MeasureChart, MeasureInput, Pace, Trend,
  cadenceKey, directionKey, healthKey, measure, unitKey,
} from '../kpi';
import { Stat } from '../../../kernel/design-system/ui/stat';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { Sheet, useConfirm, useDirty } from '../../../kernel/design-system/ui/sheet';
import { useToast } from '../../../kernel/design-system/ui/toast';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input, Select, Textarea, formField, formRow } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { Attachments } from '../../../kernel/files/Attachments';
import { shortDate, today } from '../../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { create, remove, update } from '../../../kernel/sync/mutations';
import { list, useQuery, useRow } from '../../../kernel/sync/store';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { TabButton, TabList } from '../../../kernel/design-system/ui/tabs';
import { useSaveChanges } from '../../../kernel/design-system/row-form';
import { useCanWrite, useFeature } from '../../../kernel/identity/session';
import { pageBody } from '../../../kernel/design-system/ui/page';
import { statRow } from '../../../kernel/design-system/ui/stat';
import { cn } from '../../../kernel/design-system/cn';
import { noticeWarn } from '../../../kernel/design-system/ui/notice';
import { DataTable, Td, Th, Tr, cellLink, rowOpen } from '../../../kernel/design-system/ui/data-table';

function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('kpi.offTitle')} hint={t('kpi.offHint')} />;
}

/** Live KPIs, their readings, their targets and the milestones targets hang off. */
function useKpiData() {
  const kpis = useQuery(() => list('kpi', (row) => !row.archived), []);
  const readings = useQuery(() => list('kpiReading'), []);
  const targets = useQuery(() => list('kpiTarget'), []);
  const modules = useQuery(() => list('module'), []);
  return { kpis, readings, targets, modules };
}

/* ------------------------------------------------------------------ index */

export function KpiIndex() {
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('kpi');
  const [creating, setCreating] = useState(false);
  const { kpis, readings, targets, modules } = useKpiData();

  const rows = useMemo(
    () => summarise({ kpis, readings, targets, modules }),
    [kpis, readings, targets, modules],
  );

  if (!enabled) return <><Header title={t('kpi.title')} /><SwitchedOff /></>;

  return (
    <>
      <Header title={t('kpi.title')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('kpi.new')}</span>
          </Button>
        )}
      </Header>

      {!rows.length ? (
        <Empty emoji="🎯" title={t('kpi.emptyTitle')} hint={t('kpi.emptyHint')} />
      ) : (
        <div className={pageBody}>
          <div className="table-wrap">
            <DataTable>
              <thead>
                <tr>
                  <Th>{t('kpi.name')}</Th>
                  <Th numeric>{t('kpi.current')}</Th>
                  <Th numeric>{t('kpi.trend')}</Th>
                  <Th numeric>{t('kpi.target')}</Th>
                  <Th>{t('kpi.due')}</Th>
                  <Th>{t('kpi.pace')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ kpi, progress, trend }) => (
                  <Tr key={kpi.id} onClick={() => navigate(`/kpis/${kpi.id}`)}>
                    <Td lead>
                      <Link className={cellLink} to={`/kpis/${kpi.id}`}>{kpi.name}</Link>
                      {/* The row is seven columns wide and a phone shows two,
                          so what somebody came for goes under the name — and
                          only there. See `row-sub-sm` in the stylesheet.
                          The verdict is in it because it is the last column and
                          therefore the first thing off the edge of a phone,
                          which would have left the one fact that matters as the
                          one fact not shown. */}
                      <span className="row-sub row-sub-sm">
                        {measure(progress.value, kpi)}
                        {progress.target !== null && ` → ${measure(progress.target, kpi)}`}
                        {` · ${t(healthKey(progress.health))}`}
                      </span>
                    </Td>
                    <Td numeric>{measure(progress.value, kpi)}</Td>
                    <Td numeric><Trend change={trend.change} better={trend.better} kpi={kpi} /></Td>
                    <Td numeric>{measure(progress.target, kpi)}</Td>
                    <Td>{progress.due ? shortDate(progress.due) : <span className="text-muted">—</span>}</Td>
                    <Td><Pace progress={progress} /></Td>
                    <Td><Health health={progress.health} /></Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          </div>

          <SectionHeading>{t('kpi.summaryTitle')}</SectionHeading>
          <p className="text-label text-muted">{t('kpi.summaryHint')}</p>
          {/* All six, in the order the list is sorted. Showing only the four
              that are judgements would have made the sentence above this row
              false on its own screen — and dropping "not measured" from a count
              of KPIs is the exact omission this feature exists to refuse. */}
          <div className={statRow}>
            {MEASURE_HEALTH.map((health) => {
              const count = rows.filter((row) => row.progress.health === health).length;
              return <Stat key={health} label={t(`kpi.health.${health}` as TranslationKey)} value={String(count)} />;
            })}
          </div>
        </div>
      )}

      {creating && <KpiForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/kpis/${id}`)} />}
    </>
  );
}

/* ----------------------------------------------------------------- detail */

const TABS = ['overview', 'readings', 'targets', 'settings'] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TranslationKey> = {
  overview: 'kpi.tabOverview',
  readings: 'kpi.tabReadings',
  targets: 'kpi.tabTargets',
  settings: 'project.tabSettings',
};

export function KpiDetail() {
  const t = useT();
  const { id = '' } = useParams();
  const enabled = useFeature('kpi');
  const kpi = useRow('kpi', id);
  const [search, setSearch] = useSearchParams();
  const asked = search.get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(asked as Tab) ? asked as Tab : 'overview');
  const strip = useTabStrip(tab);

  const navigate = useNavigate();
  const readings = useQuery(() => list('kpiReading', (row) => row.kpi_id === id), [id]);
  const targets = useQuery(() => list('kpiTarget', (row) => row.kpi_id === id), [id]);
  const modules = useQuery(() => list('module'), []);

  const progress = useMemo(
    () => (kpi ? progressOf({ kpi, readings, targets, modules }) : null),
    [kpi, readings, targets, modules],
  );

  if (!enabled) return <><Header title={t('kpi.title')} /><SwitchedOff /></>;
  if (!kpi) {
    return (
      <>
        <Header title={t('kpi.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/kpis', label: t('kpi.title'), icon: <Icon name="target" size={13} /> }]} />
        </div>
        <Empty
          emoji="🎯" title={t('kpi.gone')}
          action={<Button onClick={() => navigate('/kpis')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const go = (next: Tab) => { setTab(next); setSearch({ tab: next }, { replace: true }); };

  return (
    <>
      <Header title={kpi.name}>
        {progress && <Health health={progress.health} />}
      </Header>
      {/* Above the tabs: the tabs are places inside this KPI, the trail is the
          way out of it, and mixing the two would read as a fifth tab. */}
      <div className="px-3 pt-3 sm:px-6">
        <Trail parts={[{ to: '/kpis', label: t('kpi.title'), icon: <Icon name="target" size={13} /> }]} />
      </div>
      <TabList ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {TABS.map((name) => (
          <TabButton key={name} active={tab === name} onClick={() => go(name)}>
            {t(TAB_KEY[name])}
          </TabButton>
        ))}
      </TabList>
      <div className={pageBody}>
        {tab === 'overview' && <Overview kpi={kpi} readings={readings} targets={targets} modules={modules} />}
        {tab === 'readings' && <Readings kpi={kpi} readings={readings} />}
        {tab === 'targets' && <Targets kpi={kpi} targets={targets} modules={modules} />}
        {tab === 'settings' && <KpiSettings kpi={kpi} />}
      </div>
    </>
  );
}

function Overview({ kpi, readings, targets, modules }: {
  kpi: Kpi;
  readings: KpiReading[];
  targets: KpiTarget[];
  modules: { id: string; target_date: string | null }[];
}) {
  const t = useT();
  const progress = useMemo(() => progressOf({ kpi, readings, targets, modules }), [kpi, readings, targets, modules]);
  const trend = useMemo(() => trendOf(kpi, readings), [kpi, readings]);
  const series = useMemo(() => seriesOf({ kpi, readings, targets, modules }), [kpi, readings, targets, modules]);

  return (
    <div className="grid gap-3.5">
      {kpi.description && <p className="text-body text-muted">{kpi.description}</p>}

      <div className={statRow}>
        <Stat
          label={t('kpi.current')}
          value={measure(progress.value, kpi)}
          hint={progress.measuredOn ? t('kpi.measuredHint', { when: shortDate(progress.measuredOn) }) : undefined}
        />
        <Stat
          label={t('kpi.target')}
          value={measure(progress.target, kpi)}
          hint={progress.due ? t('kpi.dueHint', { when: shortDate(progress.due) }) : undefined}
        />
        <Stat
          label={t('kpi.baseline')}
          value={measure(progress.baseline, kpi)}
          hint={progress.baselineImplied ? t('kpi.baselineImplied') : undefined}
        />
        {/* The arrow is not decoration: for a "lower is better" KPI the bare
            figure hides the only thing worth knowing about it. */}
        <Stat
          label={t('kpi.trend')}
          value={trend.change === null
            ? '—'
            : trend.change === 0
              /* The index says "No change" for this; a tile reading "↓ 0" would
                 be the same fact drawn as a fall. */
              ? t('kpi.unchanged')
              : `${trend.change > 0 ? '↑' : '↓'} ${measure(Math.abs(trend.change), kpi)}`}
          hint={t(`kpi.trendHint.${kpi.cadence}` as TranslationKey)}
        />
      </div>

      {/* The one sentence the tiles cannot carry: what the verdict is, and on
          what grounds. Stated rather than left to be inferred from a chip. */}
      {progress.health === 'stale' && progress.age !== null && (
        <p className={noticeWarn}>{t('kpi.staleSince', { days: String(progress.age) })}</p>
      )}
      {progress.achieved !== null && progress.expected !== null && progress.health !== 'stale' && (
        <p className="text-label text-muted">
          {progress.achieved < 0
            /* "−100 % of the way there" is arithmetically true and reads as
               nonsense. Going backwards gets its own sentence. */
            ? t('kpi.paceBackwards', { away: String(Math.abs(Math.round(progress.achieved / 100))) })
            : t('kpi.paceSentence', {
              achieved: String(Math.round(progress.achieved / 100)),
              expected: String(Math.round(progress.expected / 100)),
            })}
        </p>
      )}

      {readings.length > 0 ? (
        <div className="rounded border border-line bg-raised p-3.5">
          <h2 className="chart-title">{t('kpi.chartTitle')}</h2>
          <p className="text-label text-muted">{t('kpi.chartHint')}</p>
          <MeasureChart actual={series.actual} target={series.target} kpi={kpi} caption={t('kpi.chartCaption', { name: kpi.name })} />
        </div>
      ) : (
        <Empty emoji="📈" title={t('kpi.noReadings')} hint={t('kpi.noReadingsHint')} />
      )}

      {/* Where the number came from. A KPI is an assertion about a measurement,
          and the export, the dashboard screenshot or the survey behind it is
          the only thing that makes the assertion checkable a year later. */}
      <Attachments on={{ kind: 'kpi', id: kpi.id }} />
    </div>
  );
}

/* --------------------------------------------------------------- readings */

function Readings({ kpi, readings }: { kpi: Kpi; readings: KpiReading[] }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<KpiReading | 'new' | null>(null);
  const sorted = useMemo(() => byMeasuredOn(readings), [readings]);

  return (
    <div>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('kpi.addReading')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="📈" title={t('kpi.noReadings')} hint={t('kpi.noReadingsHint')} />
      ) : (
        <div className="table-wrap">
          <DataTable>
            <thead>
              <tr>
                <Th>{t('kpi.measuredOn')}</Th>
                <Th numeric>{t('kpi.value')}</Th>
                <Th>{t('kpi.source')}</Th>
                <Th>{t('kpi.note')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <Tr key={entry.id} onClick={() => canWrite && setEditing(entry)}>
                  <Td>{canWrite ? <button type="button" className={rowOpen}>{shortDate(entry.measured_on)}</button> : shortDate(entry.measured_on)}</Td>
                  <Td numeric>{measure(entry.value, kpi)}</Td>
                  <Td>{entry.source ?? <span className="text-muted">{t('kpi.noSource')}</span>}</Td>
                  <Td className="text-muted">{entry.note}</Td>
                  <Td>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const value = measure(entry.value, kpi);
                          if (await confirm(t('kpi.deleteReading', { value }))) remove('kpiReading', entry.id);
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}

      {editing && (
        <ReadingForm kpi={kpi} entry={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {dialog}
    </div>
  );
}

function ReadingForm({ kpi, entry, onClose }: { kpi: Kpi; entry: KpiReading | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const saveChanges = useSaveChanges('kpiReading', entry);
  const [form, setForm] = useState(() => ({
    measured_on: entry?.measured_on ?? today(),
    value: entry?.value ?? null as number | null,
    source: entry?.source ?? '',
    note: entry?.note ?? '',
  }));
  const dirty = useDirty(form);

  return (
    <Sheet
      title={entry ? t('kpi.editReading') : t('kpi.addReading')}
      onClose={onClose}
      dirty={dirty}
      footer={(
        <Button
          variant="primary"
          disabled={form.value === null}
          onClick={() => {
            if (form.value === null) return;
            const patch = {
              kpi_id: kpi.id,
              measured_on: form.measured_on || today(),
              value: form.value,
              source: form.source.trim() || null,
              note: form.note.trim() || null,
            };
            if (entry) saveChanges(patch);
            else create('kpiReading', patch);
            toast(t('kpi.recorded'));
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="r-on">{t('kpi.measuredOn')}</label>
          <Input
            id="r-on"
            type="date"
            value={form.measured_on}
            onChange={(event) => setForm({ ...form, measured_on: event.target.value })}
          />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="r-value">{t('kpi.value')}</label>
          <MeasureInput
            id="r-value"
            kpi={kpi}
            value={form.value}
            onChange={(value) => setForm({ ...form, value })}
          />
        </div>
      </div>
      <div className={formField}>
        <label htmlFor="r-source">{t('kpi.source')}</label>
        <Input
          id="r-source"
          value={form.source}
          placeholder={t('kpi.sourcePlaceholder')}
          onChange={(event) => setForm({ ...form, source: event.target.value })}
        />
        {/* Not a formality. A measurement nobody can trace is a number somebody
            will dispute and nobody can defend. */}
        <span className="text-label text-muted">{t('kpi.sourceHint')}</span>
      </div>
      <div className={formField}>
        <label htmlFor="r-note">{t('kpi.note')}</label>
        <Textarea id="r-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- targets */

function Targets({ kpi, targets, modules }: {
  kpi: Kpi;
  targets: KpiTarget[];
  modules: { id: string; name: string; target_date: string | null }[];
}) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<KpiTarget | 'new' | null>(null);
  const names = useMemo(() => new Map(modules.map((row) => [row.id, row.name])), [modules]);

  const sorted = useMemo(() => [...targets].sort((a, b) => {
    const left = dueOn(a, modules);
    const right = dueOn(b, modules);
    if (!left) return 1;
    if (!right) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  }), [targets, modules]);

  return (
    <div>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('kpi.addTarget')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="🎯" title={t('kpi.noTargets')} hint={t('kpi.noTargetsHint')} />
      ) : (
        <div className="table-wrap">
          <DataTable>
            <thead>
              <tr>
                <Th numeric>{t('kpi.value')}</Th>
                <Th>{t('kpi.due')}</Th>
                <Th>{t('kpi.milestone')}</Th>
                <Th>{t('kpi.note')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => {
                const due = dueOn(entry, modules);
                return (
                  <Tr key={entry.id} onClick={() => canWrite && setEditing(entry)}>
                    <Td numeric lead>
                      {canWrite ? <button type="button" className={rowOpen}>{measure(entry.value, kpi)}</button> : measure(entry.value, kpi)}
                    </Td>
                    <Td>{due ? shortDate(due) : <span className="text-muted">{t('kpi.undated')}</span>}</Td>
                    <Td>
                      {entry.module_id
                        ? (
                          <span className="kpi-linked">
                            <Icon name="target" size={13} />
                            {names.get(entry.module_id) ?? t('kpi.unknownMilestone')}
                          </span>
                        )
                        : <span className="text-muted">—</span>}
                    </Td>
                    <Td className="text-muted">{entry.note}</Td>
                    <Td>
                      {canWrite && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('action.delete')}
                          onClick={async (event) => {
                            event.stopPropagation();
                            const value = measure(entry.value, kpi);
                            if (await confirm(t('kpi.deleteTarget', { value }))) remove('kpiTarget', entry.id);
                          }}
                        >
                          <Icon name="trash" size={14} />
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}

      {/* Said once, on the screen where it matters: this is what the milestone
          column buys you. */}
      {sorted.some((entry) => entry.module_id) && (
        <p className="mt-3 text-label text-muted">{t('kpi.milestoneNote')}</p>
      )}

      {editing && (
        <TargetForm
          kpi={kpi}
          entry={editing === 'new' ? null : editing}
          modules={modules}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

function TargetForm({ kpi, entry, modules, onClose }: {
  kpi: Kpi;
  entry: KpiTarget | null;
  modules: { id: string; name: string; target_date: string | null }[];
  onClose: () => void;
}) {
  const t = useT();
  const saveChanges = useSaveChanges('kpiTarget', entry);
  const [form, setForm] = useState(() => ({
    value: entry?.value ?? null as number | null,
    due_on: entry?.due_on ?? '',
    module_id: entry?.module_id ?? '',
    note: entry?.note ?? '',
  }));
  const module = modules.find((row) => row.id === form.module_id);
  const dirty = useDirty(form);

  return (
    <Sheet
      title={entry ? t('kpi.editTarget') : t('kpi.addTarget')}
      onClose={onClose}
      dirty={dirty}
      footer={(
        <Button
          variant="primary"
          disabled={form.value === null}
          onClick={() => {
            if (form.value === null) return;
            const patch = {
              kpi_id: kpi.id,
              module_id: form.module_id || null,
              due_on: form.due_on || null,
              value: form.value,
              note: form.note.trim() || null,
            };
            if (entry) saveChanges(patch);
            else create('kpiTarget', { ...patch, sort_order: orderKey() });
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="t-value">{t('kpi.value')}</label>
        <MeasureInput id="t-value" kpi={kpi} value={form.value} onChange={(value) => setForm({ ...form, value })} />
      </div>
      <div className={formField}>
        <label htmlFor="t-module">{t('kpi.milestone')}</label>
        <Select
          id="t-module"
          value={form.module_id}
          onChange={(event) => setForm({ ...form, module_id: event.target.value })}
        >
          <option value="">{t('kpi.noMilestone')}</option>
          {modules.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </Select>
        <span className="text-label text-muted">{t('kpi.milestoneHint')}</span>
      </div>
      <div className={formField}>
        <label htmlFor="t-due">{t('kpi.due')}</label>
        <Input
          id="t-due"
          type="date"
          value={form.due_on}
          onChange={(event) => setForm({ ...form, due_on: event.target.value })}
        />
        {/* Which of the two dates is actually in force, while somebody is
            choosing — rather than after they have saved and wondered. */}
        <span className="text-label text-muted">
          {module?.target_date
            ? t('kpi.dueFromMilestone', { name: module.name, when: shortDate(module.target_date) })
            : t('kpi.dueHintPlain')}
        </span>
      </div>
      <div className={formField}>
        <label htmlFor="t-note">{t('kpi.note')}</label>
        <Textarea id="t-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/* --------------------------------------------------------------- settings */

function KpiSettings({ kpi }: { kpi: Kpi }) {
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();

  return (
    <div className="max-w-[620px]">
      <KpiFields
        kpi={kpi}
        disabled={!canWrite}
        onChange={(patch) => update('kpi', kpi.id, patch)}
      />
      {canWrite && (
        <>
          <SectionHeading>{t('kpi.dangerTitle')}</SectionHeading>
          <p className="text-label text-muted mb-2">{t('kpi.dangerHint')}</p>
          <Button
            variant="danger"
            onClick={async () => {
              if (await confirm(t('kpi.deleteKpi', { name: kpi.name }))) {
                remove('kpi', kpi.id);
                navigate('/kpis');
              }
            }}
          >
            <Icon name="trash" size={15} /> {t('kpi.delete')}
          </Button>
        </>
      )}
      {dialog}
    </div>
  );
}

/** The fields a KPI has, shared by the create sheet and the settings tab. */
function KpiFields({ kpi, disabled, onChange }: {
  kpi: Partial<Kpi>;
  disabled?: boolean;
  onChange: (patch: Partial<Kpi>) => void;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const scope = projectScope({ project: kpi.project_id ?? null, projects: kpi.projects ?? [] });

  return (
    <>
      <div className={formField}>
        <label htmlFor="k-name">{t('kpi.name')}</label>
        <Input
          id="k-name"
          disabled={disabled}
          value={kpi.name ?? ''}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>
      <div className={formField}>
        <label htmlFor="k-desc">{t('kpi.description')}</label>
        <Textarea
          id="k-desc"
          rows={3}
          disabled={disabled}
          value={kpi.description ?? ''}
          placeholder={t('kpi.descriptionPlaceholder')}
          onChange={(event) => onChange({ description: event.target.value || null })}
        />
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="k-unit">{t('kpi.unit')}</label>
          <Select
            id="k-unit"
            disabled={disabled}
            value={kpi.unit ?? 'number'}
            onChange={(event) => onChange({ unit: event.target.value as MeasureUnit })}
          >
            {MEASURE_UNITS.map((name) => <option key={name} value={name}>{t(unitKey(name))}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="k-label">{t('kpi.unitLabel')}</label>
          <Input
            id="k-label"
            disabled={disabled || kpi.unit !== 'number'}
            value={kpi.unit_label ?? ''}
            placeholder={t('kpi.unitLabelPlaceholder')}
            onChange={(event) => onChange({ unit_label: event.target.value || null })}
          />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="k-decimals">{t('kpi.decimals')}</label>
          <Select
            id="k-decimals"
            disabled={disabled}
            value={String(kpi.decimals ?? 0)}
            onChange={(event) => onChange({ decimals: Number(event.target.value) })}
          >
            {[0, 1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
          </Select>
        </div>
      </div>
      {/* The one field that cannot be changed lightly later, said where it is
          chosen: every value on the KPI is stored at this scale. */}
      <p className="text-label text-muted -mt-1 mb-3">{t('kpi.decimalsHint')}</p>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="k-direction">{t('kpi.directionLabel')}</label>
          <Select
            id="k-direction"
            disabled={disabled}
            value={kpi.direction ?? 'up'}
            onChange={(event) => onChange({ direction: event.target.value as MeasureDirection })}
          >
            {MEASURE_DIRECTIONS.map((name) => <option key={name} value={name}>{t(directionKey(name))}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="k-cadence">{t('kpi.cadenceLabel')}</label>
          <Select
            id="k-cadence"
            disabled={disabled}
            value={kpi.cadence ?? 'monthly'}
            onChange={(event) => onChange({ cadence: event.target.value as MeasureCadence })}
          >
            {MEASURE_CADENCES.map((name) => <option key={name} value={name}>{t(cadenceKey(name))}</option>)}
          </Select>
          <span className="text-label text-muted">{t('kpi.cadenceHint')}</span>
        </div>
      </div>

      <div className={formField}>
        <label htmlFor="k-baseline">{t('kpi.baseline')}</label>
        <MeasureInput
          id="k-baseline"
          disabled={disabled}
          kpi={{ unit: kpi.unit ?? 'number', unit_label: kpi.unit_label ?? null, decimals: kpi.decimals ?? 0 }}
          value={kpi.baseline ?? null}
          onChange={(value) => onChange({ baseline: value })}
        />
        <span className="text-label text-muted">{t('kpi.baselineHint')}</span>
      </div>

      <div className={formField}>
        <label htmlFor="k-scope">{t('kpi.scope')}</label>
        <Select
          id="k-scope"
          disabled={disabled}
          value={scope.project_id ?? ''}
          onChange={(event) => onChange(
            projectScope({ project: event.target.value || null, projects: [] }) as Partial<Kpi>,
          )}
        >
          <option value="">{t('kpi.wholeWorkspace')}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </Select>
      </div>
    </>
  );
}

function KpiForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Kpi>>({
    name: '',
    description: null,
    unit: 'number',
    unit_label: null,
    decimals: 0,
    direction: 'up',
    baseline: null,
    cadence: 'monthly',
    project_id: null,
    projects: [],
  });
  const dirty = useDirty(draft);

  return (
    <Sheet
      title={t('kpi.new')}
      onClose={onClose}
      dirty={dirty}
      footer={(
        <Button
          variant="primary"
          disabled={!draft.name?.trim()}
          onClick={() => {
            const id = create('kpi', {
              name: draft.name?.trim() || t('kpi.untitled'),
              description: draft.description ?? null,
              unit: draft.unit ?? 'number',
              unit_label: draft.unit_label ?? null,
              decimals: draft.decimals ?? 0,
              direction: draft.direction ?? 'up',
              baseline: draft.baseline ?? null,
              cadence: draft.cadence ?? 'monthly',
              project_id: draft.project_id ?? null,
              projects: draft.projects ?? [],
              sort_order: orderKey(),
            });
            onSaved(id);
          }}
        >
          {t('action.create')}
        </Button>
      )}
    >
      <KpiFields kpi={draft} onChange={(patch) => setDraft({ ...draft, ...patch })} />
    </Sheet>
  );
}

/* --------------------------------------------------- on a milestone's page */

/**
 * What has to be true by the time this milestone lands.
 *
 * The other direction through the same link, and the reason the link is worth
 * having: a milestone is usually described by what will be *built*, and this is
 * the list of what will have to be *true*. Nothing is shown when nothing has
 * been promised, rather than an empty frame.
 */
export function MilestoneKpis({ moduleId }: { moduleId: string }) {
  const t = useT();
  const enabled = useFeature('kpi');
  const { kpis, readings, targets, modules } = useKpiData();
  const rows = useMemo(
    () => (enabled ? promisedBy({ moduleId, kpis, readings, targets, modules }) : []),
    [enabled, moduleId, kpis, readings, targets, modules],
  );
  if (!rows.length) return null;

  return (
    <div className="mt-4">
      <SectionHeading>{t('kpi.onMilestone')}</SectionHeading>
      <p className="text-label text-muted">{t('kpi.onMilestoneHint')}</p>
      <div className="table-wrap">
        <DataTable>
          <thead>
            <tr>
              <Th>{t('kpi.name')}</Th>
              <Th numeric>{t('kpi.current')}</Th>
              <Th numeric>{t('kpi.target')}</Th>
              <Th>{t('kpi.pace')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ kpi, progress }) => (
              <Tr key={kpi.id}>
                <Td lead><Link to={`/kpis/${kpi.id}`}>{kpi.name}</Link></Td>
                <Td numeric>{measure(progress.value, kpi)}</Td>
                <Td numeric>{measure(progress.target, kpi)}</Td>
                <Td><Pace progress={progress} /></Td>
                <Td><Health health={progress.health} /></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}

/**
 * Every KPI that covers one project, as that project's own tab.
 *
 * A tab rather than a strip appended to Insights, matching the budget: both
 * answer "how is this project doing" in a currency the tasks list cannot, and
 * both are worth a heading of their own. It shows the empty state rather than
 * nothing, because a tab that renders blank is worse than one that says there
 * is nothing here yet.
 */
export function ProjectKpis({ projectId }: { projectId: string }) {
  const t = useT();
  const enabled = useFeature('kpi');
  const { kpis, readings, targets, modules } = useKpiData();
  const rows = useMemo(() => (enabled
    ? summarise({
      kpis: kpis.filter((kpi) => coversProject({ project_id: kpi.project_id, projects: kpi.projects }, projectId)),
      readings,
      targets,
      modules,
    })
    : []), [enabled, kpis, readings, targets, modules, projectId]);
  if (!rows.length) {
    return <Empty emoji="🎯" title={t('kpi.noneHere')} hint={t('kpi.noneHereHint')} />;
  }

  return (
    <div className={pageBody}>
      <div className="table-wrap">
        <DataTable>
          <thead>
            <tr>
              <Th>{t('kpi.name')}</Th>
              <Th numeric>{t('kpi.current')}</Th>
              <Th numeric>{t('kpi.target')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ kpi, progress }) => (
              <Tr key={kpi.id}>
                <Td lead><Link to={`/kpis/${kpi.id}`}>{kpi.name}</Link></Td>
                <Td numeric>{measure(progress.value, kpi)}</Td>
                <Td numeric>{measure(progress.target, kpi)}</Td>
                <Td><Health health={progress.health} /></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}

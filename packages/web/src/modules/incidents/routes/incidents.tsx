/**
 * The incident screens: what is burning, what was put out and still owes a
 * review, and the record of each one.
 *
 * The index leads with what is still active, worst first — priority, then a
 * major incident before an ordinary one, then the longest-running — because
 * the question somebody opens this screen with during an outage is "what do I
 * look at", and a list sorted by date answers a different one. The figures
 * above it are over the last thirty days and say what the record is worth:
 * how long incidents take to resolve, how many reviews are still owed, and
 * how many nobody put a cost on.
 *
 * The detail screen is laid out in the order an incident is worked: what and
 * how bad at the top, the timeline in the middle — where most of the typing
 * happens while it is live — and the resolution, the links and the review
 * underneath, which is where the work goes once it is over.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  INCIDENT_RESOLUTIONS, INCIDENT_STATUS, byIncidentUrgency, formatDuration, incidentClocks, incidentReport, isActive,
  type Incident, type IncidentResolution, type IncidentStatus, type Page, type Task,
} from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { MenuButton } from '../../../kernel/design-system/ui/menu-button';
import { useConfirm } from '../../../kernel/design-system/ui/sheet';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Input, Label, Select, Textarea } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { TabButton, TabList } from '../../../kernel/design-system/ui/tabs';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { useMinute } from '../../../kernel/design-system/minute';
import { useT } from '../../../kernel/i18n/i18n';
import { createTask, remove, update } from '../../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCanWrite, useFeature, useMe } from '../../../kernel/identity/session';
import { now } from '../../../kernel/sync/clock';
import { Attachments } from '../../../kernel/files/Attachments';
import { Stat } from '../../planning/insights';
import {
  IncidentFields, IncidentForm, IncidentRow, PriorityChip, StatusChip, categoryKey, resolutionKey, statusKey,
  useApplications, useImpactWords,
} from '../incident-parts';
import { Timeline, useChangeWords, useTimeline } from '../timeline';
import { ApplicationsPanel } from '../applications';
import { fileReview } from '../review';
import { statRow } from '../../../kernel/design-system/ui/stat';

function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('incident.offTitle')} hint={t('incident.offHint')} />;
}

/* ------------------------------------------------------------------ index */

type IndexTab = 'active' | 'review' | 'all' | 'applications';

export function IncidentIndex() {
  useMinute();
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('incidents');
  const [tab, setTab] = useState<IndexTab>('active');
  const strip = useTabStrip(tab);
  const [creating, setCreating] = useState(false);
  const incidents = useQuery(() => list('incident', (row) => !row.deleted_at), []);
  const sorted = useMemo(() => [...incidents].sort(byIncidentUrgency), [incidents]);
  const impact = useImpactWords();

  const month = useMemo(() => {
    const since = now() - 30 * 86_400_000;
    return incidentReport(incidents.filter((row) => (row.started_at ?? row.created_at) >= since));
  }, [incidents]);

  if (!enabled) return <><Header title={t('incident.title')} /><SwitchedOff /></>;

  const shown = tab === 'active' ? sorted.filter(isActive)
    : tab === 'review' ? sorted.filter((row) => row.status === 'resolved')
      : sorted;
  const active = sorted.filter(isActive);

  return (
    <>
      <Header title={t('incident.title')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('incident.new')}</span>
          </Button>
        )}
      </Header>

      <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <div className={statRow}>
          <Stat label={t('incident.statActive')} value={String(active.length)} onSelect={() => setTab('active')} active={tab === 'active'} />
          <Stat label={t('incident.statReview')} value={String(month.awaitingReview)} onSelect={() => setTab('review')} active={tab === 'review'} />
          <Stat label={t('incident.statMttr')} value={formatDuration(month.mttrMs)} hint={t('incident.last30')} />
          <Stat
            label={t('incident.statCost')}
            value={month.cost.length
              ? month.cost.map((one) => impact({ financial_impact: one.amount, currency: one.currency })).join(' + ')
              : '—'}
            hint={month.unpriced ? t('incident.unpriced', { count: month.unpriced }) : t('incident.last30')}
          />
        </div>

        <TabList ref={strip} className="tabs" aria-label={t('incident.title')}>
          {(['active', 'review', 'all', 'applications'] as const).map((one) => (
            <TabButton key={one} active={tab === one} onClick={() => setTab(one)}>
              {t(`incident.tab.${one}`)}
            </TabButton>
          ))}
        </TabList>

        {tab === 'applications' ? (
          <ApplicationsPanel />
        ) : !shown.length ? (
          <Empty
            emoji={tab === 'active' ? '🟢' : '🧯'}
            title={tab === 'active' ? t('incident.noneActive') : t('incident.emptyTitle')}
            hint={tab === 'active' ? t('incident.noneActiveHint') : t('incident.emptyHint')}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((incident) => <IncidentRow key={incident.id} incident={incident} />)}
          </div>
        )}
      </div>

      {creating && <IncidentForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/incidents/${id}`)} />}
    </>
  );
}

/* ----------------------------------------------------------------- detail */

export function IncidentDetail() {
  useMinute();
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('incidents');
  const me = useMe();
  const incident = useRow('incident', id);
  const timeline = useTimeline(id);
  const changeWords = useChangeWords();
  const impact = useImpactWords();
  const { confirm, dialog } = useConfirm();
  const apps = useApplications();

  if (!enabled) return <><Header title={t('incident.title')} /><SwitchedOff /></>;
  const trail = <Trail parts={[{ to: '/incidents', label: t('incident.title'), icon: <Icon name="alert" size={13} /> }]} />;
  if (!incident || incident.deleted_at) {
    return (
      <>
        <Header title={t('incident.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">{trail}</div>
        <Empty
          emoji="🧯" title={t('incident.gone')}
          action={<Button onClick={() => navigate('/incidents')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const clocks = incidentClocks(incident, now());
  const edit = (patch: Partial<Incident>) => update('incident', incident.id, patch);
  const hit = (incident.applications ?? []).map((one) => apps.find((app) => app.id === one)?.name).filter(Boolean);

  return (
    <>
      <Header title={`${incident.identifier || t('incident.unnumbered')} ${incident.summary}`}>
        {canWrite && (
          <Select
            inputSize="sm"
            className="w-auto max-w-[180px] flex-none"
            value={incident.status}
            aria-label={t('incident.status')}
            onChange={(event) => edit({ status: event.target.value as IncidentStatus })}
          >
            {INCIDENT_STATUS.map((one) => <option key={one} value={one}>{t(statusKey(one))}</option>)}
          </Select>
        )}
      </Header>

      <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {trail}

        <div className="flex flex-wrap items-center gap-2">
          <PriorityChip priority={incident.priority} />
          <StatusChip status={incident.status} />
          {!!incident.major && <Chip tone="on">{t('incident.major')}</Chip>}
          <Chip>{t(categoryKey(incident.category))}</Chip>
          {hit.length > 0 && <span className="text-label text-muted">{hit.join(', ')}</span>}
        </div>

        {/* The three clocks a review is about. Each says "—" when one of its
            ends was never written down rather than guessing one from when
            the record was opened. */}
        <div className={statRow}>
          <Stat
            label={t('incident.clock.impact')}
            value={formatDuration(clocks.impactMs)}
            hint={clocks.running ? t('incident.stillRunning') : undefined}
          />
          <Stat label={t('incident.clock.detect')} value={formatDuration(clocks.detectMs)} />
          <Stat label={t('incident.clock.resolve')} value={formatDuration(clocks.resolveMs)} />
          <Stat label={t('incident.financialImpact')} value={impact(incident)} />
        </div>

        <SectionHeading>{t('incident.timeline')}</SectionHeading>
        <Timeline incident={incident} />

        <SectionHeading>{t('incident.resolutionHeading')}</SectionHeading>
        <Resolution incident={incident} disabled={!canWrite} />

        <SectionHeading>{t('incident.links')}</SectionHeading>
        <Links incident={incident} disabled={!canWrite} />
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                const pageId = fileReview(incident, timeline, changeWords, t, me);
                navigate(`/pages/${pageId}`);
              }}
            >
              🧯 {t('incident.writeReview')}
            </Button>
          </div>
        )}

        {/* The evidence: the log excerpt, the screenshot of the error, the
            graph from the minute it fell over. */}
        <Attachments on={{ kind: 'incident', id: incident.id }} />

        <SectionHeading>{t('incident.details')}</SectionHeading>
        <IncidentFields incident={incident} onChange={edit} disabled={!canWrite} />

        {canWrite && (
          <div>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                if (await confirm(t('incident.deleteConfirm', { identifier: incident.identifier }))) {
                  remove('incident', incident.id);
                  navigate('/incidents');
                }
              }}
            >
              {t('action.delete')}
            </Button>
          </div>
        )}
      </div>
      {dialog}
    </>
  );
}

/**
 * How it ended.
 *
 * The button resolves rather than closes: resolved is "the service is back",
 * closed is "and the review is done", and pressing one button for both is how
 * the gap between them — where the root cause and the follow-ups live — gets
 * skipped. Closing is the status select at the top, on purpose a second step.
 */
function Resolution({ incident, disabled }: { incident: Incident; disabled: boolean }) {
  const t = useT();
  const edit = (patch: Partial<Incident>) => update('incident', incident.id, patch);
  return (
    <div className="flex flex-col gap-3">
      <Label label={t('incident.resolutionCode')}>
        <Select
          value={incident.resolution_code ?? ''}
          disabled={disabled}
          onChange={(event) => edit({ resolution_code: (event.target.value || null) as IncidentResolution | null })}
        >
          <option value="">{t('incident.notYet')}</option>
          {INCIDENT_RESOLUTIONS.map((one) => <option key={one} value={one}>{t(resolutionKey(one))}</option>)}
        </Select>
      </Label>
      <Label label={t('incident.resolutionText')}>
        <Textarea
          rows={3}
          value={incident.resolution ?? ''}
          placeholder={t('incident.resolutionPlaceholder')}
          disabled={disabled}
          onChange={(event) => edit({ resolution: event.target.value || null })}
        />
      </Label>
      <Label label={t('incident.rootCause')} hint={t('incident.rootCauseHint')}>
        <Textarea
          rows={3}
          value={incident.root_cause ?? ''}
          disabled={disabled}
          onChange={(event) => edit({ root_cause: event.target.value || null })}
        />
      </Label>
      {!disabled && isActive(incident) && (
        <div>
          <Button
            variant="primary"
            size="sm"
            disabled={!incident.resolution_code}
            title={incident.resolution_code ? undefined : t('incident.resolveNeedsCode')}
            onClick={() => edit({ status: 'resolved' })}
          >
            {t('incident.resolve')}
          </Button>
          {!incident.resolution_code && <span className="ml-2 text-label text-muted">{t('incident.resolveNeedsCode')}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * What this incident points at: the runbook, the knowledge-base article, the
 * review; and the follow-ups that stop it happening again.
 *
 * A page or task this device cannot see — private, or in a project the reader
 * is not on — is still linked and says so, rather than disappearing from the
 * list and looking like nobody wrote a runbook.
 */
function Links({ incident, disabled }: { incident: Incident; disabled: boolean }) {
  const t = useT();
  const me = useMe();
  const pages = useQuery(() => list('page', (page) => !page.deleted_at && !page.archived && !page.is_template), []);
  const tasks = useQuery(() => list('task', (task) => !task.deleted_at && !task.archived), []);
  const projects = useQuery(() => list('project', (project) => !project.deleted_at && !project.archived && !project.is_container), []);
  const linkedPages = incident.pages ?? [];
  const linkedTasks = incident.tasks ?? [];
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');

  const setPages = (next: string[]) => update('incident', incident.id, { pages: next });
  const setTasks = (next: string[]) => update('incident', incident.id, { tasks: next });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-muted">{t('incident.linkedPages')}</span>
        <ul className="flex list-none flex-col gap-1 p-0">
          {linkedPages.map((pageId) => {
            const page = byId('page', pageId) as Page | undefined;
            return (
              <li key={pageId} className="flex items-center gap-2 text-body">
                {page && !page.deleted_at
                  ? <Link to={`/pages/${pageId}`} className="inline-flex min-h-6 items-center">{page.icon ? `${page.icon} ` : ''}{page.title}</Link>
                  : <span className="text-muted">{t('incident.pageUnavailable')}</span>}
                {!disabled && (
                  <Button size="sm" aria-label={t('incident.unlink')} title={t('incident.unlink')} onClick={() => setPages(linkedPages.filter((one) => one !== pageId))}>
                    <Icon name="close" size={12} />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-label text-muted">{t('incident.followUps')}</span>
        <ul className="flex list-none flex-col gap-1 p-0">
          {linkedTasks.map((taskId) => {
            const task = byId('task', taskId) as Task | undefined;
            return (
              <li key={taskId} className="flex items-center gap-2 text-body">
                {task && !task.deleted_at
                  ? <Link to={`/t/${taskId}`} className="inline-flex min-h-6 items-center">{task.identifier} {task.title}{task.completed_at ? ` ✓` : ''}</Link>
                  : <span className="text-muted">{t('incident.taskUnavailable')}</span>}
                {!disabled && (
                  <Button size="sm" aria-label={t('incident.unlink')} title={t('incident.unlink')} onClick={() => setTasks(linkedTasks.filter((one) => one !== taskId))}>
                    <Icon name="close" size={12} />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {!disabled && (
          <>
            {/*
              * One button, two drawers. Pages and tasks are lists that grow
              * with the workspace, so they are drawers with a search box rather
              * than rows of a menu hanging off its button — a menu of three
              * hundred tasks is the bug `check:menus` was written about.
              */}
            <div>
              <MenuButton
                size="sm"
                label={t('incident.link')}
                items={[
                  {
                    id: 'pages',
                    label: t('incident.linkPage'),
                    icon: <Icon name="page" size={13} />,
                    search: true,
                    empty: t('incident.noPages'),
                    items: pages
                      .filter((page) => !linkedPages.includes(page.id))
                      .map((page) => ({ id: page.id, label: page.title || t('incident.untitledPage'), onSelect: () => setPages([...linkedPages, page.id]) })),
                  },
                  {
                    id: 'tasks',
                    label: t('incident.linkTask'),
                    icon: <Icon name="check" size={13} />,
                    search: true,
                    empty: t('incident.noTasks'),
                    items: tasks
                      .filter((task) => !linkedTasks.includes(task.id))
                      .map((task) => ({ id: task.id, label: `${task.identifier} ${task.title}`, onSelect: () => setTasks([...linkedTasks, task.id]) })),
                  },
                ]}
              >
                <Icon name="link" size={13} /> <span>{t('incident.link')}</span>
              </MenuButton>
            </div>
            {projects.length > 0 && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const chosen = projectId || projects[0].id;
                  if (!title.trim()) return;
                  const taskId = createTask({
                    project_id: chosen,
                    title: title.trim(),
                    description: `${incident.identifier}: ${incident.summary}`,
                    assignees: [me],
                  }, me);
                  setTasks([...linkedTasks, taskId]);
                  setTitle('');
                }}
              >
                <Label label={t('incident.followUpProject')}>
                  <Select inputSize="sm" value={projectId || projects[0].id} onChange={(event) => setProjectId(event.target.value)}>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.key} · {project.name}</option>)}
                  </Select>
                </Label>
                <Label label={t('incident.followUpTitle')} className="min-w-[200px] flex-1">
                  <Input inputSize="sm" value={title} placeholder={t('incident.followUpPlaceholder')} onChange={(event) => setTitle(event.target.value)} />
                </Label>
                <Button size="sm" type="submit" disabled={!title.trim()}>{t('incident.fileFollowUp')}</Button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

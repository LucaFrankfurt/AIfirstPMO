import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_WORKING_DAYS, orderKey, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { QuickAdd } from '../components/QuickAdd';
import { CycleProgress, DEFAULT_VIEW, TaskViews, useVisibleTasks, ViewControls, type ViewConfig } from '../components/views';
import { useSelection } from '../components/selection';
import { SelectionBar } from '../components/selection-bar';
import { ProjectTime } from '../components/time';
import { ForeignImportSheet, ImportSheet, type Inspection } from '../components/import';
import { ProjectInsights } from '../components/insights';
import { useTypes } from '../components/task-parts';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Avatar, Empty, GuideHint, Icon, MenuButton, Progress, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { shortDate, today } from '../lib/format';
import { useTabStrip } from '../lib/tab-strip';
import { byOrder, create, createPage, remove, update } from '../lib/mutations';
import { useOpenTask } from '../lib/navigation';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useCanWrite, useMe, useMembers, useSession } from '../session';
import { groupKey, roleKey, useT, type TranslationKey } from '../lib/i18n';
import { ProjectFields } from '../components/fields';
import { CopyProjectSheet } from '../components/copy-project';
import { configOf, useProjectDefaultView } from '../components/saved-views';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Input, Select, Textarea } from '../components/ui/field';
import { SectionHeading } from '../components/ui/section';
import { Chip, chipDot, chipVariants } from '../components/ui/chip';
import { Triage, useNewIntakeCount } from '../components/intake';

const VIEW_KEY = (projectId: string) => `kolibri.view.${projectId}`;

const TAB_KEY: Record<string, TranslationKey> = {
  tasks: 'project.tabTasks', cycles: 'project.tabCycles', modules: 'project.tabModules',
  pages: 'project.tabPages', intake: 'intake.tab', insights: 'insights.tab', settings: 'project.tabSettings',
};

const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;

/** Monday first, because a working week starts on one. `day` is getUTCDay. */
const WEEKDAYS: { day: number; key: TranslationKey }[] = [
  { day: 1, key: 'view.weekdayMon' }, { day: 2, key: 'view.weekdayTue' }, { day: 3, key: 'view.weekdayWed' },
  { day: 4, key: 'view.weekdayThu' }, { day: 5, key: 'view.weekdayFri' }, { day: 6, key: 'view.weekdaySat' },
  { day: 0, key: 'view.weekdaySun' },
];

/**
 * The view this project is being looked at through.
 *
 * Three answers, in order: what this device last chose, what the project was
 * pinned to open on, and the plain list. The device wins because a view is a
 * way of *looking* — somebody who switched to the board and came back tomorrow
 * meant it, and a project default that overruled them every morning would be a
 * setting that fights its users.
 */
function useStoredView(projectId: string): [ViewConfig, (next: ViewConfig) => void] {
  const me = useMe();
  const pinned = useProjectDefaultView(projectId, me);
  const [chosenHere] = useState<boolean>(() => {
    try {
      return !!localStorage.getItem(VIEW_KEY(projectId));
    } catch {
      return false;
    }
  });
  const [view, setView] = useState<ViewConfig>(() => {
    try {
      const raw = localStorage.getItem(VIEW_KEY(projectId));
      return raw ? { ...DEFAULT_VIEW, ...JSON.parse(raw) } : DEFAULT_VIEW;
    } catch {
      return DEFAULT_VIEW;
    }
  });

  // The pin arrives with the sync rather than with the first render, so it is
  // applied when it turns up — once, and never over a choice made on this
  // device, including one made in the second between the two.
  const applied = useRef('');
  useEffect(() => {
    if (chosenHere || !pinned || applied.current === projectId) return;
    applied.current = projectId;
    setView(configOf(pinned));
  }, [chosenHere, pinned, projectId]);

  return [
    view,
    (next: ViewConfig) => {
      setView(next);
      applied.current = projectId;
      localStorage.setItem(VIEW_KEY(projectId), JSON.stringify(next));
    },
  ];
}

/* --------------------------------------------------------------- overview */

export function ProjectList() {
  const t = useT();
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId), [workspaceId]);
  const canWrite = useCanWrite();

  return (
    <>
      <Header title={t('project.listTitle')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => navigate('/projects/new')}><Icon name="plus" size={14} /> {t('action.create')}</Button>
        )}
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((project) => <ProjectCard key={project.id} projectId={project.id} />)}
        </div>
        {!projects.length && (
          <Empty
            emoji="📁" title={t('project.emptyTitle')} hint={t('project.emptyHint')} guide="overview"
            action={canWrite
              ? <Button variant="primary" onClick={() => navigate('/projects/new')}>{t('project.createCta')}</Button>
              : undefined}
          />
        )}
      </div>
    </>
  );
}

function ProjectCard({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const project = useRow('project', projectId);
  const tasks = useQuery(() => list('task', (t) => t.project_id === projectId && !t.archived), [projectId]);
  const done = tasks.filter((task) => ['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? '')).length;
  if (!project) return null;

  return (
    <button className="rounded-[var(--radius)] border border-line bg-raised p-3.5 text-left cursor-pointer" onClick={() => navigate(`/projects/${projectId}`)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-lg">{project.icon ?? '📁'}</span>
        <strong className="flex-1 min-w-0 truncate">{project.name}</strong>
        <Chip className="font-mono">{project.key}</Chip>
      </div>
      {project.description && <p className="text-muted truncate text-[12.5px]">{project.description}</p>}
      <Progress value={done} total={tasks.length} />
      <div className="flex items-center gap-2 text-muted text-[12.5px] mt-1.5">
        <span>{t('project.doneCount', { done, total: tasks.length })}</span>
        <span className="flex-1 min-w-0" />
        {project.target_date && <span>{t('project.target', { date: shortDate(project.target_date) })}</span>}
      </div>
    </button>
  );
}

export function ProjectNew() {
  const t = useT();
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  // `?parent=` so "New sub-project" in a project's menu arrives here with the
  // answer already filled in, rather than asking again for something the
  // person has just said.
  const [search] = useSearchParams();
  const [form, setForm] = useState({
    name: '', key: '', description: '', icon: '🚀', visibility: 'public',
    parent_id: search.get('parent') ?? '',
  });
  const [busy, setBusy] = useState(false);

  const parents = useQuery(
    () => list('project', (row) => row.workspace_id === workspaceId && !row.archived)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      // Projects are created server-side so they get their workflow states,
      // labels and a unique key in one transaction.
      const project = await api.post<any>(`/api/workspaces/${workspaceId}/projects`, form);
      await pull();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('project.createFailed'));
      setBusy(false);
    }
  }

  return (
    <>
      <Header title={t('project.new')} />
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5" style={{ maxWidth: 560 }}>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="p-name">{t('project.name')}</label>
            <Input
              id="p-name" required autoFocus value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={t('project.namePlaceholder')}
            />
          </div>
          <div className="flex items-start gap-2.5">
            <div className="field" style={{ width: 120 }}>
              <label htmlFor="p-icon">{t('project.icon')}</label>
              <Input id="p-icon" value={form.icon} maxLength={4} onChange={(event) => setForm({ ...form, icon: event.target.value })} />
            </div>
            <div className="field flex-1 min-w-0">
              <label htmlFor="p-key">{t('project.key')}</label>
              <Input className="mono"
                id="p-key" value={form.key} maxLength={6} placeholder={t('project.keyAuto')}
                onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })}
              />
              <span className="text-[12px] text-muted">{t('project.keyHint')}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="p-desc">{t('project.description')}</label>
            <Textarea id="p-desc" style={{ minHeight: 80 }} value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="p-parent">{t('project.parent')}</label>
            <Select id="p-parent" value={form.parent_id}
              onChange={(event) => setForm({ ...form, parent_id: event.target.value })}
            >
              <option value="">{t('project.parentNone')}</option>
              {parents.map((other) => (
                <option key={other.id} value={other.id}>{other.icon} {other.name}</option>
              ))}
            </Select>
            <span className="text-[12px] text-muted">{t('project.parentHint')}</span>
          </div>
          <div className="field">
            <label htmlFor="p-vis">{t('project.visibility')}</label>
            <Select id="p-vis" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })}>
              <option value="public">{t('project.visibilityPublic')}</option>
              <option value="private">{t('project.visibilityPrivate')}</option>
            </Select>
          </div>
          {/* `type="submit"` is not decoration: `Button` defaults to
              `type="button"`, which is right everywhere except inside a form,
              and a submit button that quietly does nothing is exactly the bug
              that got here. `test/forms.test.ts` now refuses the next one. */}
          <Button variant="primary" size="lg" block type="submit" disabled={busy || !form.name.trim()}>
            {busy ? t('project.creating') : t('project.createSubmit')}
          </Button>
        </form>
      </div>
    </>
  );
}

/**
 * What sits under a container, as cards.
 *
 * Each child carries the only two numbers worth showing at this level: how much
 * of it is done, and whether anything in it is late. A container is a reading
 * screen — somebody opens it to see where things stand across four projects,
 * not to move a card.
 */
function ContainerChildren({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const children = useQuery(
    () => list('project', (row) => row.parent_id === projectId && !row.archived)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [projectId],
  );
  const tasks = useQuery(() => list('task', (task) => !task.archived), []);

  if (!children.length) {
    return (
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <Empty
          emoji="🗂️"
          title={t('project.containerEmpty')}
          hint={t('project.containerEmptyHint')}
        />
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <p className="text-muted text-[12.5px] mb-2.5">{t('project.containerCount', { count: children.length })}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {children.map((child) => {
          const mine = tasks.filter((task) => task.project_id === child.id);
          const done = mine.filter((task) => byId('state', task.state_id)?.group_key === 'completed').length;
          const late = mine.filter((task) => task.due_date && task.due_date < today
            && !['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? '')).length;
          return (
            <button
              key={child.id}
              type="button"
              className="rounded-[var(--radius)] border border-line bg-raised p-3.5 text-start"
              onClick={() => navigate(`/projects/${child.id}`)}
            >
              <span className="flex items-center gap-2 mb-2">
                <span className="text-lg">{child.icon ?? '📁'}</span>
                <span className="flex-1 min-w-0 truncate font-semibold">{child.name}</span>
                {child.is_container ? <Icon name="folder" size={14} /> : <Chip className="font-mono">{child.key}</Chip>}
              </span>
              {child.is_container ? (
                <span className="text-muted text-[12.5px]">{t('project.isContainer')}</span>
              ) : (
                <>
                  <Progress value={done} total={mine.length} />
                  <span className="flex items-center gap-2 mt-1.5 text-[12.5px] text-muted">
                    <span>{t('project.doneOf', { done, total: mine.length })}</span>
                    {late > 0 && <span className="text-danger">{t('portfolio.lateCount', { count: late })}</span>}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- project */

const TABS = ['tasks', 'cycles', 'modules', 'pages', 'intake', 'insights', 'settings'] as const;

/**
 * What a container shows instead.
 *
 * Cycles, modules, reports and insights are all about work, and a container has
 * none — a screen full of tabs that each say "nothing here" is worse than four
 * tabs that mean something. Pages stay, because a place to group projects is
 * exactly where the note explaining the grouping belongs.
 */
const CONTAINER_TABS = ['tasks', 'pages', 'settings'] as const;
type Tab = (typeof TABS)[number];

export function ProjectPage() {
  const t = useT();
  const openTask = useOpenTask();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const project = useRow('project', id);
  const [view, setView] = useStoredView(id);
  const selection = useSelection();
  const canWrite = useCanWrite();
  const isContainer = !!project?.is_container;
  // `?tab=` so a link can point at one — a notification about a report has to
  // land on the reports, not on the task list beside them.
  const [search, setSearch] = useSearchParams();
  const asked = search.get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(asked as Tab) ? asked as Tab : 'tasks');
  const strip = useTabStrip(tab);
  const [adding, setAdding] = useState(false);

  const tasks = useQuery(() => list('task', (t) => t.project_id === id && !t.parent_id), [id]);
  const visible = useVisibleTasks(tasks, view);
  const waitingReports = useNewIntakeCount(id);

  if (!project) {
    return (
      <>
        <Header title={t('nav.projects')} />
        <Empty emoji="🕳️" title={t('project.notFound')} hint={t('project.notFoundHint')} />
      </>
    );
  }

  return (
    <>
      <Header title={<span className="flex items-center gap-2" style={{ gap: 7 }}><span>{project.icon}</span> {project.name}</span>}>
        {tab === 'tasks' && !isContainer && <ViewControls view={view} onChange={setView} projectId={id} saveable />}
        {canWrite && (isContainer ? (
          // The button a container needs. "New task" on a screen with no board
          // is a button that files work where nobody will look for it.
          <Button variant="primary" size="sm" onClick={() => navigate(`/projects/new?parent=${id}`)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('project.newSub')}</span>
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('nav.newTask')}</span>
          </Button>
        ))}
      </Header>

      <div ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {/* Reports is always here, even for a project that will never use it.
            Hiding it until an intake link exists would make the one screen that
            explains how to get one the screen nobody can find. */}
        {(isContainer ? CONTAINER_TABS : TABS).map((name) => (
          <button
            key={name}
            className={tab === name ? 'active' : ''}
            onClick={() => {
              setTab(name);
              // The URL follows the tab, so a reload and a back button both
              // land where the person was rather than on the task list.
              setSearch(name === 'tasks' ? {} : { tab: name }, { replace: true });
            }}
          >
            {/* A container's first tab shows projects, not tasks — the label
                has to say what is behind it, not what it is behind on every
                other project. */}
            {t(isContainer && name === 'tasks' ? 'nav.projects' : TAB_KEY[name])}
            {name === 'intake' && waitingReports > 0 && <span className="tab-count">{waitingReports}</span>}
          </button>
        ))}
      </div>

      {tab === 'tasks' && isContainer && <ContainerChildren projectId={id} />}
      {tab === 'tasks' && !isContainer && (
        view.layout === 'board'
          ? <div style={{ height: 'calc(100dvh - var(--header-height) - 110px)' }}>
            <TaskViews tasks={visible} view={view} projectId={id} onOpen={openTask} />
          </div>
          : <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5" style={{ paddingInline: 0 }}>
            <TaskViews
              tasks={visible} view={view} projectId={id} onOpen={openTask}
              onChange={setView} selection={selection}
            />
          </div>
      )}
      {tab === 'tasks' && !isContainer && <SelectionBar selection={selection} tasks={visible} />}
      {tab === 'cycles' && <Cycles projectId={id} />}
      {tab === 'modules' && <Modules projectId={id} />}
      {tab === 'pages' && <ProjectPages projectId={id} />}
      {tab === 'intake' && <Triage projectId={id} />}
      {tab === 'insights' && <ProjectInsights projectId={id} />}
      {tab === 'settings' && <ProjectSettings projectId={id} />}

      {adding && <QuickAdd projectId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/* ----------------------------------------------------------------- cycles */

function Cycles({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const cycles = useQuery(
    () => list('cycle', (c) => c.project_id === projectId).sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '')),
    [projectId],
  );
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const day = today();

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px]">{t('cycle.title')}</h2>
        <span className="flex-1 min-w-0" />
        <Button size="sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> {t('cycle.new')}</Button>
      </div>

      {!cycles.length && <Empty emoji="🔁" title={t('cycle.emptyTitle')} hint={t('cycle.emptyHint')} guide="planning" />}

      <div className="grid gap-3 sm:grid-cols-2">
        {cycles.map((cycle) => {
          const active = cycle.start_date && cycle.end_date && cycle.start_date <= day && cycle.end_date >= day;
          return (
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" key={cycle.id}>
              <div className="flex items-center gap-2 mb-2">
                <strong className="flex-1 min-w-0 truncate">{cycle.name}</strong>
                {active && <span className={chipVariants()} style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>{t('cycle.active')}</span>}
                <MenuButton
                  variant="ghost" size="iconSm"
                  label={t('common.moreActions')}
                  items={[
                    { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(cycle.id) },
                    { id: 'open', label: t('cycle.showTasks'), onSelect: () => navigate(`/cycles/${cycle.id}`) },
                    { id: 'delete', label: t('action.delete'), danger: true, onSelect: () => remove('cycle', cycle.id) },
                  ]}
                >
                  <Icon name="dots" size={14} />
                </MenuButton>
              </div>
              <CycleProgress cycleId={cycle.id} />
              <Button size="sm" block className="mt-2.5" onClick={() => navigate(`/cycles/${cycle.id}`)}>{t('cycle.open')}</Button>
            </div>
          );
        })}
      </div>

      {editing && (
        <CycleEditor
          projectId={projectId}
          cycleId={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CycleEditor({ projectId, cycleId, onClose }: { projectId: string; cycleId?: string; onClose: () => void }) {
  const t = useT();
  const cycle = useRow('cycle', cycleId);
  const [form, setForm] = useState({
    name: cycle?.name ?? '',
    description: cycle?.description ?? '',
    start_date: cycle?.start_date ?? today(),
    end_date: cycle?.end_date ?? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  });

  const save = () => {
    if (!form.name.trim()) return;
    if (cycleId) update('cycle', cycleId, form);
    else create('cycle', { ...form, project_id: projectId });
    onClose();
  };

  return (
    <Sheet
      title={cycleId ? t('cycle.edit') : t('cycle.new')}
      onClose={onClose}
      footer={<Button variant="primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</Button>}
    >
      <div className="field">
        <label htmlFor="c-name">{t('cycle.name')}</label>
        <Input id="c-name" autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-start">{t('cycle.starts')}</label>
          <Input id="c-start" type="date" value={form.start_date ?? ''} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="c-end">{t('cycle.ends')}</label>
          <Input id="c-end" type="date" value={form.end_date ?? ''} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="c-desc">{t('cycle.goal')}</label>
        <Textarea id="c-desc" value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>
    </Sheet>
  );
}

export function CyclePage() {
  const t = useT();
  const openTask = useOpenTask();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const cycle = useRow('cycle', id);
  const [view, setView] = useState<ViewConfig>({ ...DEFAULT_VIEW, groupBy: 'state' });
  const [adding, setAdding] = useState(false);
  const tasks = useQuery(() => list('task', (t) => t.cycle_id === id), [id]);
  const visible = useVisibleTasks(tasks, view);

  const burndown = useMemo(() => {
    const done = tasks.filter((task) => ['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? '')).length;
    const points = tasks.reduce((sum, task) => sum + (task.estimate ?? 0), 0);
    const donePoints = tasks
      .filter((task) => ['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? ''))
      .reduce((sum, task) => sum + (task.estimate ?? 0), 0);
    return { done, total: tasks.length, points, donePoints };
  }, [tasks]);

  if (!cycle) return <Empty emoji="🕳️" title={t('cycle.notFound')} />;

  return (
    <>
      <Header title={cycle.name}>
        <ViewControls view={view} onChange={setView} projectId={cycle.project_id} />
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /></Button>
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <strong>{t('cycle.taskProgress', { done: burndown.done, total: burndown.total })}</strong>
              <div className="text-muted text-[12.5px]">
                {t('cycle.pointProgress', { done: burndown.donePoints, total: burndown.points })}
                {cycle.start_date && cycle.end_date && ` · ${shortDate(cycle.start_date)} – ${shortDate(cycle.end_date)}`}
              </div>
            </div>
          </div>
          <Progress value={burndown.done} total={burndown.total} />
          {cycle.description && <p className="text-muted mt-2 text-[12.5px]">{cycle.description}</p>}
        </div>
        <TaskViews tasks={visible} view={view} projectId={cycle.project_id} onOpen={openTask} />
      </div>
      {adding && <QuickAdd projectId={cycle.project_id} cycleId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/* ---------------------------------------------------------------- modules */

function Modules({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const members = useMembers();
  const modules = useQuery(() => list('module', (m) => m.project_id === projectId), [projectId]);
  const [name, setName] = useState('');

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px]">{t('module.title')}</h2>
        <span className="text-muted text-[12.5px]">{t('module.subtitle')}</span>
      </div>

      <form
        className="flex items-center gap-2 mb-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          create('module', { project_id: projectId, name: name.trim(), status: 'planned', sort_order: orderKey(null, null) });
          setName('');
        }}
      >
        <Input placeholder={t('module.placeholder')} value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit"><Icon name="plus" size={14} /></Button>
      </form>

      {!modules.length && <Empty emoji="🎯" title={t('module.emptyTitle')} hint={t('module.emptyHint')} guide="planning" />}

      <div className="grid gap-3 sm:grid-cols-2">
        {modules.map((module) => {
          const tasks = list('task', (task) => task.module_id === module.id);
          const done = tasks.filter((task) => ['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? '')).length;
          const lead = members.find((member) => member.id === module.lead_id);
          return (
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" key={module.id}>
              <div className="flex items-center gap-2 mb-1.5">
                <strong className="flex-1 min-w-0 truncate">{module.name}</strong>
                {lead && <Avatar user={lead} size={20} />}
                <MenuButton
                  variant="ghost" size="iconSm"
                  label={t('common.moreActions')}
                  items={[
                    ...members.map((member) => ({
                      id: member.id, section: t('project.lead'), label: member.name,
                      onSelect: () => update('module', module.id, { lead_id: member.id }),
                    })),
                    { id: 'delete', section: t('module.danger'), label: t('module.delete'), danger: true, onSelect: () => remove('module', module.id) },
                  ]}
                >
                  <Icon name="dots" size={14} />
                </MenuButton>
              </div>
              <Progress value={done} total={tasks.length} />
              <div className="flex items-center gap-2 text-muted text-[12.5px] mt-1.5">
                <span>{done}/{tasks.length}</span>
                <span className="flex-1 min-w-0" />
                <Input
                  inputSize="sm" type="date" style={{ width: 150, height: 28 }}
                  value={module.target_date ?? ''}
                  onChange={(event) => update('module', module.id, { target_date: event.target.value || null })}
                />
              </div>
              <Button size="sm" block className="mt-2" onClick={() => navigate(`/modules/${module.id}`)}>{t('action.open')}</Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ModulePage() {
  const t = useT();
  const openTask = useOpenTask();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const module = useRow('module', id);
  const [view, setView] = useState<ViewConfig>(DEFAULT_VIEW);
  const tasks = useQuery(() => list('task', (t) => t.module_id === id), [id]);
  const visible = useVisibleTasks(tasks, view);
  if (!module) return <Empty emoji="🕳️" title={t('module.notFound')} />;
  return (
    <>
      <Header title={module.name}>
        <ViewControls view={view} onChange={setView} projectId={module.project_id} />
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {module.description && <Markdown source={module.description} />}
        <TaskViews tasks={visible} view={view} projectId={module.project_id} onOpen={openTask} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------ pages + cfg */

function ProjectPages({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const me = useMe();
  const pages = useQuery(() => list('page', (p) => p.project_id === projectId && !p.archived), [projectId]);

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px]">{t('project.pagesTitle')}</h2>
        <span className="flex-1 min-w-0" />
        <Button size="sm" onClick={() => navigate(`/pages/${createPage({ project_id: projectId, title: t('common.untitled') }, me)}`)}>
          <Icon name="plus" size={14} /> {t('project.newPage')}
        </Button>
      </div>
      {!pages.length && <Empty emoji="📄" title={t('project.noPages')} hint={t('project.noPagesHint')} guide="pages" />}
      {pages.map((page) => (
        <button key={page.id} className="task-row text-left" style={{ width: '100%' }} onClick={() => navigate(`/pages/${page.id}`)}>
          <span>{page.icon ?? '📄'}</span>
          <span className="flex-1 min-w-0 truncate">{page.title}</span>
        </button>
      ))}
    </div>
  );
}

function ProjectSettings({ projectId }: { projectId: string }) {
  const t = useT();
  const project = useRow('project', projectId);
  const navigate = useNavigate();
  const members = useMembers();
  const toast = useToast();
  const { workspaceId } = useSession();
  const { confirm, dialog } = useConfirm();
  const states = useQuery(
    () => list('state', (s) => s.project_id === projectId).sort(byOrder),
    [projectId],
  );
  const labels = useQuery(() => list('label', (l) => l.project_id === projectId), [projectId]);
  const types = useTypes(projectId);
  const [newLabel, setNewLabel] = useState('');
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [foreign, setForeign] = useState<{ document: unknown; found: Inspection } | null>(null);

  /**
   * A project as a document: for moving it to another instance, and for reading
   * it. The download is built here rather than by navigating to the endpoint,
   * so it goes through the same authenticated fetch as everything else.
   */
  async function exportJson(): Promise<void> {
    try {
      const doc = await api.get<unknown>(`/api/workspaces/${workspaceId}/projects/${projectId}/export`);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(project?.key ?? 'project').toLowerCase()}.kolibri.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  /**
   * Read a file first, import it second.
   *
   * A Kolibri document goes straight in — it is this app's own shape and there
   * is nothing to warn anybody about. Anything from another tool is *converted*,
   * and what a converter leaves behind is the part worth reading before a
   * project appears, not after.
   */
  async function importJson(file: File): Promise<void> {
    try {
      const document_ = JSON.parse(await file.text());
      const found = await api.post<Inspection>(`/api/workspaces/${workspaceId}/import/json/inspect`, { document: document_ });
      if (found.from === 'kolibri') return finishJsonImport(document_);
      setForeign({ document: document_, found });
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  async function finishJsonImport(document_: unknown): Promise<void> {
    setForeign(null);
    try {
      const result = await api.post<{ project: { id: string }; counts: Record<string, number>; unmatched: string[] }>(
        `/api/workspaces/${workspaceId}/import/json`,
        { document: document_ },
      );
      await pull();
      const rows = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
      toast(result.unmatched.length
        ? t('transfer.importedWithGaps', { count: rows, names: result.unmatched.join(', ') })
        : t('transfer.imported', { count: rows }));
      navigate(`/projects/${result.project.id}`);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }
  // A project cannot be its own parent, and the server refuses a longer loop —
  // this list only keeps the obvious case out of the menu.
  const siblings = useQuery(
    () => list('project', (other) => other.id !== projectId && !other.archived && other.parent_id !== projectId),
    [projectId],
  );
  // Why the container box may be refused, said before it is clicked.
  const taskCount = useQuery(() => list('task', (task) => task.project_id === projectId).length, [projectId]);
  // Which project already holds this key, if any — the same comparison the
  // server makes, so the two agree about what a collision is.
  const keyTaken = useQuery(() => {
    const key = (byId('project', projectId)?.key ?? '').trim().toUpperCase();
    if (!key) return '';
    return list('project', (other) => other.id !== projectId && !other.archived
      && (other.key ?? '').trim().toUpperCase() === key)[0]?.name ?? '';
  }, [projectId, project?.key]);
  if (!project) return null;

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5" style={{ maxWidth: 620 }}>
      {/* Icon beside name, the shape the create form uses — the screen that
          makes a project and the screen that changes one should not lay the
          same two fields out differently. */}
      <div className="flex items-start gap-2.5">
        <div className="field" style={{ width: 120 }}>
          <label htmlFor="s-icon">{t('project.icon')}</label>
          <Input id="s-icon" value={project.icon ?? ''} maxLength={4}
            onChange={(event) => update('project', projectId, { icon: event.target.value })} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="s-name">{t('project.name')}</label>
          <Input id="s-name" value={project.name} onChange={(event) => update('project', projectId, { name: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="s-desc">{t('project.description')}</label>
        <Textarea id="s-desc" value={project.description ?? ''}
          onChange={(event) => update('project', projectId, { description: event.target.value })} />
      </div>

      {/*
        Both of these could only ever be chosen once, at the moment the project
        was created, and never again — so a project made private by accident
        stayed private, and one whose name changed kept a key that no longer
        matched it.

        The key is the sharper of the two, because changing it does not go back
        and rewrite the identifiers already minted from it: BUS-39 stays BUS-39
        while the next task becomes NEW-40. That is the honest behaviour — a
        pasted identifier has to keep pointing at what it pointed at — but it is
        only honest if it is said, so it is said under the field.
      */}
      <div className="field-row">
        <div className="field">
          <label htmlFor="s-key">{t('project.key')}</label>
          <Input className="mono" id="s-key" value={project.key ?? ''} maxLength={6}
            onChange={(event) => update('project', projectId, { key: event.target.value.toUpperCase() })} />
          {/* The server bounces a taken key back, which on its own is a field
              that refuses to be typed in for no stated reason. This is the
              reason, said while it is being typed. */}
          {keyTaken
            ? <span className="text-[12px]" style={{ color: 'var(--danger)' }}>{t('project.keyTaken', { name: keyTaken })}</span>
            : <span className="text-[12px] text-muted">{t('project.keyChangeHint')}</span>}
        </div>
        <div className="field">
          <label htmlFor="s-vis">{t('project.visibility')}</label>
          <Select id="s-vis" value={project.visibility ?? 'public'}
            onChange={(event) => update('project', projectId, { visibility: event.target.value })}>
            <option value="public">{t('project.visibilityPublic')}</option>
            <option value="private">{t('project.visibilityPrivate')}</option>
          </Select>
        </div>
      </div>
      {/*
        A container is refused by the server while the project still has tasks,
        and `forced` sends the old value back — so the box un-ticks itself. The
        sentence under it is why, said before somebody clicks rather than after.
      */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!project.is_container}
          onChange={(event) => update('project', projectId, { is_container: event.target.checked ? 1 : 0 })}
        />
        <span>
          {t('project.isContainer')}
          <span className="block text-[12px] text-muted">
            {taskCount > 0 ? t('project.isContainerBusy', { count: taskCount }) : t('project.isContainerHint')}
          </span>
        </span>
      </label>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="s-parent">{t('project.parent')}</label>
          <Select
            id="s-parent" value={project.parent_id ?? ''}
            onChange={(event) => update('project', projectId, { parent_id: event.target.value || null })}
          >
            <option value="">{t('project.parentNone')}</option>
            {siblings.map((other) => <option key={other.id} value={other.id}>{other.icon} {other.name}</option>)}
          </Select>
          <span className="text-[12px] text-muted">{t('project.parentHint')}</span>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="s-start">{t('project.startDate')}</label>
          <Input id="s-start" type="date" value={project.start_date ?? ''}
            onChange={(event) => update('project', projectId, { start_date: event.target.value || null })} />
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="s-lead">{t('project.lead')}</label>
          <Select id="s-lead" value={project.lead_id ?? ''} onChange={(event) => update('project', projectId, { lead_id: event.target.value || null })}>
            <option value="">{t('common.nobody')}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="s-target">{t('project.targetDate')}</label>
          <Input id="s-target" type="date" value={project.target_date ?? ''}
            onChange={(event) => update('project', projectId, { target_date: event.target.value || null })} />
        </div>
      </div>

      {/* Which days the *scheduler* counts. Not a lock: a bar dragged onto a
          Saturday stays there, because somebody who did that meant it. */}
      <div className="field">
        <label>{t('project.workingDays')}</label>
        <div className="flex items-center flex-wrap gap-1" role="group" aria-label={t('project.workingDays')}>
          {WEEKDAYS.map(({ day, key }) => {
            const days = project.working_days ?? DEFAULT_WORKING_DAYS;
            const on = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), on && 'bg-active text-fg')}
                style={on ? { background: 'var(--bg-active)' } : undefined}
                aria-pressed={on}
                onClick={() => update('project', projectId, {
                  working_days: on ? days.filter((d) => d !== day) : [...days, day].sort(),
                })}
              >
                {t(key)}
              </button>
            );
          })}
        </div>
        <span className="text-[12px] text-muted">{t('project.workingDaysHint')}</span>
      </div>

      <div className="flex items-center gap-2" style={{ margin: '18px 0 8px' }}>
        <SectionHeading tight>{t('project.workflowStates')}</SectionHeading>
        <span className="flex-1 min-w-0" />
        <GuideHint to="hierarchy" />
      </div>
      {states.map((state) => (
        <div className="stack-card" key={state.id}>
          {/* The name and the two ways to be rid of the state: everything that
              fits on one line at any width, on one line. */}
          <div className="flex items-center gap-2">
            <input
              type="color" value={state.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
              aria-label={t('project.stateColour')}
              onChange={(event) => update('state', state.id, { color: event.target.value })}
            />
            <Input className="flex-1 min-w-0" value={state.name} aria-label={t('project.name')}
              onChange={(event) => update('state', state.id, { name: event.target.value })} />
            <Button variant="ghost" size="icon" aria-label={t('project.deleteState')} onClick={async () => {
              if (states.length <= 1) return;
              if (await confirm(t('project.deleteStateConfirm', { name: state.name }))) remove('state', state.id);
            }}>
              <Icon name="trash" size={14} />
            </Button>
          </div>
          {/*
            The three settings were a 140px select and two labels sitting to the
            left of their own controls — so on a phone "Limit" put its box at one
            indent, "Who may move work here" wrapped onto two lines and put its
            box at another, and both selects cut their longest option in half.
            The same rows the form above uses fix all of it: label over control,
            one column when there is no room for two.
          */}
          <div className="field-row mt-2">
            <div className="field">
              <label htmlFor={`st-group-${state.id}`}>{t('view.groupState')}</label>
              <Select id={`st-group-${state.id}`} value={state.group_key}
                onChange={(event) => update('state', state.id, { group_key: event.target.value })}>
                {STATE_GROUPS.map((group) => (
                  <option key={group} value={group}>{t(groupKey(group))}</option>
                ))}
              </Select>
            </div>
            <div className="field">
              <label htmlFor={`st-wip-${state.id}`}>{t('state.wipLimit')}</label>
              {/* Two digits never need a full column; the label above it still
                  starts on the same edge as its neighbours, which is the part
                  that has to line up. */}
              <Input id={`st-wip-${state.id}`} type="number" min={0} max={99} style={{ maxWidth: 110 }}
                value={state.wip_limit || ''} placeholder="0"
                onChange={(event) => update('state', state.id, { wip_limit: Number(event.target.value) || 0 })}
              />
            </div>
            <div className="field">
              <label htmlFor={`st-roles-${state.id}`}>{t('state.allowedRoles')}</label>
              <Select id={`st-roles-${state.id}`}
                value={state.allowed_roles?.[0] ?? ''}
                onChange={(event) => update('state', state.id, { allowed_roles: event.target.value ? [event.target.value] : [] })}
              >
                <option value="">{t('state.allowedAnyone')}</option>
                {(['member', 'admin', 'owner'] as const).map((role) => (
                  <option key={role} value={role}>{t(roleKey(role))}</option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      ))}
      <p className="text-[12px] text-muted mt-1">{t('state.wipLimitHint')}</p>
      <p className="text-[12px] text-muted mb-2">{t('state.allowedHint')}</p>
      <Button size="sm" className="mt-1.5"
        onClick={() => create('state', {
          project_id: projectId, name: t('project.newStateName'), group_key: 'unstarted', color: '#64748b',
          sort_order: orderKey(states[states.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> {t('project.addState')}
      </Button>

      <SectionHeading>{t('type.settingsTitle')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('type.settingsHint')}</p>
      {types.map((type) => (
        <div className="flex items-center gap-2" key={type.id} style={{ gap: 8, padding: '5px 0' }}>
          <Input style={{ width: 56, textAlign: 'center' }} maxLength={4}
            aria-label={t('type.label')}
            value={type.icon ?? ''}
            onChange={(event) => update('taskType', type.id, { icon: event.target.value || null })}
          />
          <Input
            className="flex-1 min-w-0"
            value={type.name}
            aria-label={type.name}
            onChange={(event) => update('taskType', type.id, { name: event.target.value })}
          />
          <button
            className={cn(buttonVariants({ size: 'sm' }), type.is_default && 'bg-active text-fg')}
            style={type.is_default ? { background: 'var(--bg-active)' } : undefined}
            aria-pressed={!!type.is_default}
            title={t('type.makeDefault')}
            onClick={() => {
              // Exactly one default, so setting one clears the others.
              for (const other of types) {
                if (other.is_default && other.id !== type.id) update('taskType', other.id, { is_default: 0 });
              }
              update('taskType', type.id, { is_default: 1 });
            }}
          >
            {t('type.isDefault')}
          </button>
          <Button variant="ghost" size="iconSm" title={t('type.removeHint')} aria-label={t('type.removeHint')}
            onClick={() => remove('taskType', type.id)}>
            <Icon name="trash" size={13} />
          </Button>
        </div>
      ))}
      <Button size="sm"
        onClick={() => create('taskType', {
          project_id: projectId, name: t('type.newName'), icon: '◇', color: '#6366f1', is_default: 0,
          sort_order: orderKey(types[types.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> {t('type.add')}
      </Button>

      <SectionHeading>{t('field.settingsTitle')}</SectionHeading>
      <ProjectFields projectId={projectId} />

      <SectionHeading>{t('project.labels')}</SectionHeading>
      <div className="flex items-center flex-wrap gap-1.5 mb-2">
        {labels.map((label) => (
          <span className={chipVariants({ interactive: true })} key={label.id} onClick={() => remove('label', label.id)} title={t('project.labelRemoveHint')}>
            <span className={chipDot} style={{ background: label.color }} /> {label.name} ✕
          </span>
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newLabel.trim()) return;
          create('label', { project_id: projectId, name: newLabel.trim(), color: '#6366f1' });
          setNewLabel('');
        }}
      >
        <Input placeholder={t('project.newLabel')} value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
        <Button type="submit"><Icon name="plus" size={14} /></Button>
      </form>

      <SectionHeading>{t('time.title')}</SectionHeading>
      <ProjectTime projectId={projectId} />

      <SectionHeading>{t('import.title')}</SectionHeading>
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => setImporting(true)}>
          <Icon name="attach" size={14} /> {t('import.action')}
        </Button>
        <Button onClick={() => void exportJson()}>
          <Icon name="page" size={14} /> {t('transfer.export')}
        </Button>
        <label className={cn(buttonVariants({  }), 'cursor-pointer')}>
          <Icon name="plus" size={14} /> {t('transfer.import')}
          <input
            type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importJson(file);
            }}
          />
        </label>
      </div>
      <p className="text-[12px] text-muted mt-1.5">{t('transfer.hint')}</p>
      {importing && <ImportSheet projectId={projectId} onClose={() => setImporting(false)} />}
      {foreign && (
        <ForeignImportSheet
          found={foreign.found}
          onClose={() => setForeign(null)}
          onImport={() => void finishJsonImport(foreign.document)}
        />
      )}

      <SectionHeading>{t('copy.title')}</SectionHeading>
      <Button onClick={() => setCopying(true)}>
        <Icon name="copy" size={14} /> {t('copy.action')}
      </Button>
      {copying && (
        <CopyProjectSheet
          projectId={projectId}
          onClose={() => setCopying(false)}
          onCopied={(id) => navigate(`/projects/${id}`)}
        />
      )}

      <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />
      <div className="flex items-center gap-2">
        <Button onClick={() => update('project', projectId, { archived: project.archived ? 0 : 1 })}>
          <Icon name="archive" size={14} /> {project.archived ? t('project.unarchive') : t('project.archive')}
        </Button>
        <Button variant="danger"
          onClick={async () => {
            if (await confirm(t('project.deleteConfirm', { name: project.name }))) {
              remove('project', projectId);
              navigate('/');
            }
          }}
        >
          <Icon name="trash" size={14} /> {t('project.delete')}
        </Button>
      </div>
      {dialog}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_WORKING_DAYS, coversProject, excerpt, projectScope, orderKey, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { QuickAdd } from '../components/QuickAdd';
import { CycleProgress, DEFAULT_VIEW, TaskViews, useVisibleTasks, ViewControls, type ViewConfig } from '../components/views';
import { useSelection } from '../components/selection';
import { SelectionBar } from '../components/selection-bar';
import { ProjectTime } from '../components/time';
import { ForeignImportSheet, ImportSheet, type Inspection } from '../components/import';
import { ProjectInsights } from '../components/insights';
import { ProjectBudget } from '../components/budget';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Avatar, Empty, GuideHint, Icon, MenuButton, Progress, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { shortDate, today } from '../lib/format';
import { useTabStrip } from '../lib/tab-strip';
import { byOrder, create, createPage, remove, update } from '../lib/mutations';
import { useOpenTask } from '../lib/navigation';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useCanWrite, useFeature, useMe, useMembers, useSession } from '../session';
import { groupKey, roleKey, useT, type TranslationKey } from '../lib/i18n';
import { ProjectFields } from '../components/fields';
import { CopyProjectSheet } from '../components/copy-project';
import { configOf, useProjectDefaultView } from '../components/saved-views';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Input, Select } from '../components/ui/field';
import { SectionHeading } from '../components/ui/section';
import { Chip, chipDot, chipVariants } from '../components/ui/chip';
import { Triage, useNewIntakeCount } from '../components/intake';

const VIEW_KEY = (projectId: string) => `kolibri.view.${projectId}`;

const TAB_KEY: Record<string, TranslationKey> = {
  tasks: 'project.tabTasks', cycles: 'project.tabCycles', modules: 'project.tabModules',
  pages: 'project.tabPages', intake: 'intake.tab', insights: 'insights.tab', budget: 'budget.tab',
  settings: 'project.tabSettings',
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
      {/* Stripped, not rendered: this is one truncated line inside a card, and
          a heading or a list dropped into it would break the row rather than
          say anything. `excerpt` is the same function the pages index uses for
          the same reason — markdown out, the sentence left. */}
      {project.description && (
        <p className="text-muted truncate text-[12.5px]">{excerpt(project.description, 140)}</p>
      )}
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
            {/* No `htmlFor`: the editor is a toolbar and a textarea rather
                than one control, so the id would name whichever half happened
                to carry it. Same as the rule body in `automation.tsx`, which
                is the other markdown field inside a form. */}
            <label>{t('project.description')}</label>
            <MarkdownEditor
              value={form.description} minHeight={90}
              onChange={(value) => setForm({ ...form, description: value })}
            />
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

const TABS = ['tasks', 'cycles', 'modules', 'pages', 'intake', 'insights', 'budget', 'settings'] as const;

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
  const budgets = useFeature('budget');
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
        {(isContainer ? CONTAINER_TABS : TABS)
          // Budgets only when the workspace runs them. A tab that always says
          // "nothing charges this project" is a tab that teaches people to stop
          // reading the strip.
          .filter((name) => name !== 'budget' || budgets)
          .map((name) => (
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

      {/*
        The description, where the screen has room for it.

        Not above a board: the board is sized as the whole rest of the window
        (`100dvh` less the header and the tabs), so anything put above it pushes
        the bottom of every column off the screen. A board is the screen it is
        on. Every other layout — and a container, which has no board at all —
        scrolls, and a project that says what it is for at the top of it is
        worth more there than the two lines it costs.

        A project with no description gets nothing, which is most of them.
      */}
      {tab === 'tasks' && (isContainer || view.layout !== 'board') && project.description && (
        <div className="mx-auto max-w-[1180px] px-3 pt-4 sm:px-6 sm:pt-5 text-[13px]">
          <Markdown source={project.description} />
        </div>
      )}
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
      {tab === 'budget' && budgets && <ProjectBudget projectId={id} />}
      {tab === 'settings' && <ProjectSettings projectId={id} />}

      {adding && <QuickAdd projectId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/* ----------------------------------------------------------------- cycles */

function Cycles({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  // This project's own, plus the ones it shares: a cycle that names it, and a
  // cycle every project runs. `coversProject` is the one place that question is
  // answered, so this tab and the server's queries cannot drift apart.
  const cycles = useQuery(
    () => list('cycle', (c) => coversProject(c, projectId))
      .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '')),
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
                {/* Said on the card rather than only in the editor: deleting a
                    shared cycle takes it out of every project that is in it,
                    and the menu below offers exactly that. The chip counts the
                    projects when it covers some, because "Shared" alone leaves
                    the reader to guess whether that means two or twelve. */}
                {!cycle.project_id && (
                  <span
                    className={chipVariants()}
                    title={cycle.projects?.length ? t('cycle.sharedSomeHint') : t('cycle.sharedHint')}
                  >
                    {cycle.projects?.length
                      ? t('cycle.sharedCount', { count: cycle.projects.length })
                      : t('cycle.shared')}
                  </span>
                )}
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
  /* Scope is chosen once, when the cycle is made, and not changed here.
     Re-scoping a running cycle can strand work — tasks in a project the cycle
     no longer covers — and doing that behind a dropdown that looks like a
     setting is how data goes missing without anybody attributing it to the
     click. `update_cycle` over MCP will do it and reports what it stranded;
     this form does not offer it. */
  const [scope, setScope] = useState<'this' | 'some' | 'all'>('this');
  const [picked, setPicked] = useState<string[]>([projectId]);
  /* The same list QuickAdd offers, and scoped the same way: this workspace's
     (the local store holds the ones from before a switch too), not archived,
     and no containers — a container holds projects rather than tasks, so it is
     not somewhere a cycle's work can be. */
  const { workspaceId } = useSession();
  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived && !p.is_container)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );

  const save = () => {
    if (!form.name.trim()) return;
    if (cycleId) {
      update('cycle', cycleId, form);
    } else {
      // `projectScope` is what the server would apply anyway; applying it here
      // too means the row this device writes into its own store is already the
      // canonical shape, rather than one that changes under it on the next pull.
      const chosen = scope === 'this' ? { project: projectId }
        : scope === 'all' ? {}
          : { projects: picked };
      create('cycle', { ...form, ...projectScope(chosen) });
    }
    onClose();
  };

  return (
    <Sheet
      title={cycleId ? t('cycle.edit') : t('cycle.new')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          onClick={save}
          disabled={!form.name.trim() || (!cycleId && scope === 'some' && !picked.length)}
        >
          {t('action.save')}
        </Button>
      )}
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
        <label>{t('cycle.goal')}</label>
        <MarkdownEditor
          value={form.description ?? ''} minHeight={90}
          onChange={(value) => setForm({ ...form, description: value })}
        />
      </div>

      {/* Offered only when making one — see the note on `scope` above. */}
      {!cycleId && (
        <div className="field">
          <label htmlFor="c-scope">{t('cycle.scope')}</label>
          <Select id="c-scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="this">{t('cycle.scopeThis')}</option>
            <option value="some">{t('cycle.scopeSome')}</option>
            <option value="all">{t('cycle.scopeAll')}</option>
          </Select>
          <span className="text-[12px] text-muted mt-1">
            {scope === 'this' ? t('cycle.scopeThisHint') : scope === 'all' ? t('cycle.scopeAllHint') : t('cycle.scopeSomeHint')}
          </span>

          {scope === 'some' && (
            <div className="mt-2 grid gap-1">
              {projects.map((project) => (
                <label className="check-row" key={project.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(project.id)}
                    onChange={(event) => setPicked(
                      event.target.checked
                        ? [...picked, project.id]
                        : picked.filter((id) => id !== project.id),
                    )}
                  />
                  <span>{project.icon} {project.name}</span>
                </label>
              ))}
              {/* One project chosen from the list is the same cycle as "just
                  this project", and `projectScope` stores it that way — so the
                  empty case is the only one worth refusing. */}
              {!picked.length && <span className="text-[12px] text-danger">{t('cycle.scopePickOne')}</span>}
            </div>
          )}
        </div>
      )}
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
        {/* `?? undefined` on all three below, and it is the whole shared-cycle
            answer on this screen: a cycle several projects run has no single
            project to scope a view to or to file a new task into. QuickAdd
            already offers a picker when it is not told one, which is exactly
            the right question to ask here. */}
        <ViewControls view={view} onChange={setView} projectId={cycle.project_id ?? undefined} />
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
          {cycle.description && <div className="mt-2 text-[12.5px]"><Markdown source={cycle.description} /></div>}
        </div>
        <TaskViews tasks={visible} view={view} projectId={cycle.project_id ?? undefined} onOpen={openTask} implied={{ cycleId: cycle.id }} />
      </div>
      {adding && <QuickAdd projectId={cycle.project_id ?? undefined} cycleId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/* ---------------------------------------------------------------- modules */

function Modules({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const members = useMembers();
  const { workspaceId } = useSession();
  // This project's own, plus the ones it shares — the same rule, and the same
  // function, the Cycles tab beside it follows.
  const modules = useQuery(() => list('module', (m) => coversProject(m, projectId)), [projectId]);
  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived && !p.is_container)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );
  const [name, setName] = useState('');
  /* Chosen when the module is made and not changed here, as a cycle's is.
     Narrowing a running milestone strands the dropped projects' work in it, and
     doing that behind a control that looks like a setting is how data goes
     missing without anybody attributing it to the click. `update_module` over
     MCP will do it and reports what it stranded. */
  const [scope, setScope] = useState<'this' | 'some' | 'all'>('this');
  const [picked, setPicked] = useState<string[]>([projectId]);

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px]">{t('module.title')}</h2>
        <span className="text-muted text-[12.5px]">{t('module.subtitle')}</span>
      </div>

      <form
        className="mb-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          if (scope === 'some' && !picked.length) return;
          const chosen = scope === 'this' ? { project: projectId }
            : scope === 'all' ? {}
              : { projects: picked };
          create('module', {
            ...projectScope(chosen), name: name.trim(), status: 'planned', sort_order: orderKey(null, null),
          });
          setName('');
          setScope('this');
          setPicked([projectId]);
        }}
      >
        <div className="flex items-center gap-2">
          <Input placeholder={t('module.placeholder')} value={name} onChange={(event) => setName(event.target.value)} />
          <Select
            aria-label={t('module.scope')}
            value={scope}
            style={{ width: 168 }}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            <option value="this">{t('module.scopeThis')}</option>
            <option value="some">{t('module.scopeSome')}</option>
            <option value="all">{t('module.scopeAll')}</option>
          </Select>
          <Button type="submit"><Icon name="plus" size={14} /></Button>
        </div>
        <span className="text-[12px] text-muted mt-1 block">
          {scope === 'this' ? t('module.scopeThisHint') : scope === 'all' ? t('module.scopeAllHint') : t('module.scopeSomeHint')}
        </span>
        {scope === 'some' && (
          <div className="mt-2 grid gap-1">
            {projects.map((project) => (
              <label className="check-row" key={project.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(project.id)}
                  onChange={(event) => setPicked(
                    event.target.checked ? [...picked, project.id] : picked.filter((id) => id !== project.id),
                  )}
                />
                <span>{project.icon} {project.name}</span>
              </label>
            ))}
            {/* One project chosen from the list is the same module as "just
                this project", and `projectScope` stores it that way. */}
            {!picked.length && <span className="text-[12px] text-danger">{t('module.scopePickOne')}</span>}
          </div>
        )}
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
                {/* Said on the card, because deleting a shared module takes it
                    out of every project in it and the menu beside this offers
                    exactly that. Counted when it names some: "Shared" alone
                    leaves the reader to guess whether that is two or twelve. */}
                {!module.project_id && (
                  <span
                    className={chipVariants()}
                    title={module.projects?.length ? t('module.sharedSomeHint') : t('module.sharedHint')}
                  >
                    {module.projects?.length
                      ? t('module.sharedCount', { count: module.projects.length })
                      : t('module.shared')}
                  </span>
                )}
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
  const [editing, setEditing] = useState(false);
  const tasks = useQuery(() => list('task', (t) => t.module_id === id), [id]);
  const visible = useVisibleTasks(tasks, view);
  const canWrite = useCanWrite();
  if (!module) return <Empty emoji="🕳️" title={t('module.notFound')} />;
  return (
    <>
      <Header title={module.name}>
        {/* A module's description has always been rendered as markdown here and
            has never had an editor anywhere — it could only be set through the
            API, an import or an assistant. Same Edit/Done as a page, because it
            is the same job. */}
        {canWrite && (
          <Button size="sm" onClick={() => setEditing(!editing)}>
            {editing ? <><Icon name="check" size={14} /> {t('action.done')}</> : t('action.edit')}
          </Button>
        )}
        {/* `?? undefined` for the same reason the cycle page does it: a module
            several projects work on has no single project to scope a view to. */}
        <ViewControls view={view} onChange={setView} projectId={module.project_id ?? undefined} />
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {editing ? (
          <div className="mb-3.5">
            <MarkdownEditor
              value={module.description ?? ''} minHeight={130} autoFocus
              onChange={(value) => update('module', module.id, { description: value })}
            />
          </div>
        ) : module.description ? (
          <div className="mb-3.5"><Markdown source={module.description} /></div>
        ) : null}
        <TaskViews tasks={visible} view={view} projectId={module.project_id ?? undefined} onOpen={openTask} implied={{ moduleId: module.id }} />
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
  const [newLabel, setNewLabel] = useState('');
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [foreign, setForeign] = useState<{ document: unknown; found: Inspection } | null>(null);
  /**
   * A Kolibri file, waiting for one question: a new project, or this one?
   *
   * Asked rather than assumed, because the two are genuinely different
   * operations — one cannot damage anything and the other writes into work
   * people are doing — and because until now the answer was always "a new
   * one" whether that was wanted or not.
   */
  const [landing, setLanding] = useState<{ name: string; document?: unknown; archive?: ArrayBuffer } | null>(null);
  const [into, setInto] = useState<'new' | 'this'>('new');

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
      // An archive is not inspected first: its document is inside it, and
      // unpacking a .zip in the browser to look would be a second reader of a
      // format the server already reads. The question below is the same one.
      if (file.name.endsWith('.zip')) {
        setInto('new');
        setLanding({ name: file.name, archive: await file.arrayBuffer() });
        return;
      }
      const document_ = JSON.parse(await file.text());
      const found = await api.post<Inspection>(`/api/workspaces/${workspaceId}/import/json/inspect`, { document: document_ });
      if (found.from === 'kolibri') {
        setInto('new');
        setLanding({ name: String(found.name || file.name), document: document_ });
        return;
      }
      setForeign({ document: document_, found });
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  type ImportReport = {
    project: { id: string };
    counts: Record<string, number>;
    unmatched: string[];
    updated?: number;
    missingFiles?: string[];
  };

  async function finishJsonImport(document_: unknown, target?: string): Promise<void> {
    setForeign(null);
    setLanding(null);
    try {
      const result = await api.post<ImportReport>(
        `/api/workspaces/${workspaceId}/import/json`,
        { document: document_, project_id: target },
      );
      await report(result);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  /** The same for a `.zip`, which the server unpacks and reads for itself. */
  async function finishArchiveImport(archive: ArrayBuffer, target?: string): Promise<void> {
    setLanding(null);
    try {
      const query = new URLSearchParams({ workspace: workspaceId, ...(target ? { project_id: target } : {}) });
      await report(await api.postArchive<ImportReport>(`/api/import/archive?${query}`, archive));
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  /**
   * Say what landed — and, when it is not all of it, what did not.
   *
   * A count on its own is a lie by omission the moment anything was left
   * behind, which is why the missing files are named rather than counted.
   */
  async function report(result: ImportReport): Promise<void> {
    await pull();
    const rows = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
    if (result.missingFiles?.length) toast(t('transfer.missingFiles', { names: result.missingFiles.join(', ') }));
    if (result.updated) toast(t('transfer.merged', { count: result.updated, added: rows }));
    else {
      toast(result.unmatched.length
        ? t('transfer.importedWithGaps', { count: rows, names: result.unmatched.join(', ') })
        : t('transfer.imported', { count: rows }));
    }
    navigate(`/projects/${result.project.id}`);
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
        <label>{t('project.description')}</label>
        <MarkdownEditor
          value={project.description ?? ''} minHeight={110}
          onChange={(value) => update('project', projectId, { description: value })}
        />
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
      {states.map((state, at) => (
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
            {/* The order here is the order of the board's columns — the same
                fractional keys the cards use, applied one level up. */}
            <Button variant="ghost" size="icon" aria-label={t('state.moveUp')} disabled={at === 0}
              onClick={() => update('state', state.id, {
                sort_order: orderKey(states[at - 2]?.sort_order ?? null, states[at - 1]?.sort_order ?? null),
              })}>
              <Icon name="chevronUp" size={14} />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t('state.moveDown')} disabled={at === states.length - 1}
              onClick={() => update('state', state.id, {
                sort_order: orderKey(states[at + 1]?.sort_order ?? null, states[at + 2]?.sort_order ?? null),
              })}>
              <Icon name="chevronDown" size={14} />
            </Button>
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
        {/* The archive and the spreadsheet are ordinary downloads rather than
            a fetch into a blob: a project with its screenshots in it is large,
            and a same-origin navigation carries the session cookie anyway. */}
        <Button onClick={() => { window.location.href = `/api/workspaces/${workspaceId}/projects/${projectId}/export.zip`; }}>
          <Icon name="archive" size={14} /> {t('transfer.exportZip')}
        </Button>
        <Button onClick={() => { window.location.href = `/api/workspaces/${workspaceId}/export/tasks.csv?project_id=${projectId}`; }}>
          <Icon name="table" size={14} /> {t('transfer.exportCsv')}
        </Button>
        <label className={cn(buttonVariants({  }), 'cursor-pointer')}>
          <Icon name="plus" size={14} /> {t('transfer.import')}
          <input
            type="file" accept=".json,.zip,application/json,application/zip" style={{ display: 'none' }}
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
      {landing && (
        <Sheet
          title={t('transfer.import')}
          onClose={() => setLanding(null)}
          footer={
            <>
              <Button onClick={() => setLanding(null)}>{t('action.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const target = into === 'this' ? projectId : undefined;
                  if (landing.archive) void finishArchiveImport(landing.archive, target);
                  else void finishJsonImport(landing.document, target);
                }}
              >
                {t('data.importConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('data.importAbout', { name: landing.name })}</p>
          <div className="field">
            <label htmlFor="import-into">{t('transfer.into')}</label>
            <Select id="import-into" value={into} onChange={(event) => setInto(event.target.value as 'new' | 'this')}>
              <option value="new">{t('transfer.intoNew')}</option>
              <option value="this">{t('transfer.intoThis')}</option>
            </Select>
          </div>
          <p className="text-[13px] text-muted">
            {into === 'new' ? t('transfer.intoNewHint') : t('transfer.intoThisHint')}
          </p>
        </Sheet>
      )}
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

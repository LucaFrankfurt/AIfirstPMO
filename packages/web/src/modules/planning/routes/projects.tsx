
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { dueTone, excerpt, isDoneGroup, type Page } from '@kolibri/shared';
import { Header, Trail, type Crumb } from '../../../kernel/design-system/chrome';
import { QuickAdd } from '../../work/QuickAdd';
import { TaskViews, useVisibleTasks, ViewControls } from '../../work/views';
import { DEFAULT_VIEW, type ViewConfig } from '../../work/task-parts';
import { useSelection } from '../../../kernel/design-system/selection';
import { SelectionBar } from '../../work/selection-bar';
import { ProjectInsights } from '../insights';
import { Markdown, MarkdownEditor } from '../../pages/Markdown';
import { PageTree, usePageFolds } from '../../pages/PageTree';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { Progress } from '../../../kernel/design-system/ui/progress';
import { useToast } from '../../../kernel/design-system/ui/toast';
import { api } from '../../../kernel/sync/api';
import { shortDate, today } from '../../../kernel/design-system/format';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { TabButton, TabList } from '../../../kernel/design-system/ui/tabs';
import { createPage } from '../../../kernel/sync/mutations';
import { useOpenTask } from '../../../kernel/design-system/navigation';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { pull } from '../../../kernel/sync/sync';
import { useCanWrite, useFeature, useMe, useSession } from '../../../kernel/identity/session';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { configOf, useProjectDefaultView } from '../../work/saved-views';
import { Button } from '../../../kernel/design-system/ui/button';
import { cn } from '../../../kernel/design-system/cn';
import { Input, Select, formField } from '../../../kernel/design-system/ui/field';
import { EmojiPicker } from '../../../kernel/design-system/ui/emoji-picker';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Triage, useNewIntakeCount } from '../../intake/intake';
import { pageBody } from '../../../kernel/design-system/ui/page';
import { Cycles } from '../cycle-list';
import { Modules } from '../module-list';
import { ProjectSettings } from '../project-settings';
import { GuideHint } from '../../guide/hint';
import { ProjectFields } from '../../work/fields';
import { ProjectTime } from '../../time/time';
import { ProjectTransfer } from '../../../adapters/transfer/project-transfer';

/**
 * The KPI panels a project page and a milestone page host.
 *
 * Fetched rather than imported, because a static import here is what put the
 * whole KPI screen — 1 676 lines a workspace with the switch off never renders
 * — back into the first load, defeating the split in `App.tsx`. Both are behind
 * `useFeature('kpi')` at the call sites below, so nothing is fetched until a
 * workspace that has KPIs on opens a page that shows them.
 *
 * That a planning screen reaches into the KPI capability at all is finding 4 in
 * `docs/modules.md`. This makes the reach visible and cheap; it does not
 * pretend to remove it — the module contract's slots are what does that.
 */
const ProjectKpis = lazy(() => import('../../kpis/routes/kpis').then((m) => ({ default: m.ProjectKpis })));

/**
 * The budget panel a project page hosts. Fetched for the same reason the KPI
 * panels above are: a static import pulls every money component into the first
 * load of a workspace that has budgets switched off.
 */
const ProjectBudget = lazy(() => import('../../budgets/budget').then((m) => ({ default: m.ProjectBudget })));

const VIEW_KEY = (projectId: string) => `kolibri.view.${projectId}`;

const TAB_KEY: Record<string, TranslationKey> = {
  tasks: 'project.tabTasks', cycles: 'project.tabCycles', modules: 'project.tabModules',
  pages: 'project.tabPages', intake: 'intake.tab', insights: 'insights.tab', budget: 'budget.tab',
  kpis: 'kpi.title', settings: 'project.tabSettings',
};

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
      <div className={pageBody}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
  const done = tasks.filter((task) => isDoneGroup(byId('state', task.state_id)?.group_key)).length;
  if (!project) return null;

  return (
    <button className="rounded border border-line bg-raised p-3.5 text-left cursor-pointer" onClick={() => navigate(`/projects/${projectId}`)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-headline">{project.icon ?? '📁'}</span>
        <strong className="flex-1 min-w-0 truncate">{project.name}</strong>
        <Chip className="font-mono">{project.key}</Chip>
      </div>
      {/* Stripped, not rendered: this is one truncated line inside a card, and
          a heading or a list dropped into it would break the row rather than
          say anything. `excerpt` is the same function the pages index uses for
          the same reason — markdown out, the sentence left. */}
      {project.description && (
        <p className="text-muted truncate text-label">{excerpt(project.description, 140)}</p>
      )}
      <Progress value={done} total={tasks.length} />
      <div className="flex items-center gap-2 text-muted text-label mt-1.5">
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
      <div className={pageBody} style={{ maxWidth: 560 }}>
        <form onSubmit={submit}>
          <div className={formField}>
            <label htmlFor="p-name">{t('project.name')}</label>
            <Input
              id="p-name" required autoFocus value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={t('project.namePlaceholder')}
            />
          </div>
          <div className="flex items-start gap-2.5">
            <div className={formField} style={{ width: 60 }}>
              <label htmlFor="p-icon">{t('project.icon')}</label>
              <EmojiPicker
                id="p-icon" value={form.icon} fallback="🚀"
                onChange={(next) => setForm({ ...form, icon: next ?? '' })}
              />
            </div>
            <div className={cn(formField, 'flex-1 min-w-0')}>
              <label htmlFor="p-key">{t('project.key')}</label>
              <Input className="mono font-mono"
                id="p-key" value={form.key} maxLength={6} placeholder={t('project.keyAuto')}
                onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })}
              />
              <span className="text-label text-muted">{t('project.keyHint')}</span>
            </div>
          </div>
          <div className={formField}>
            <label htmlFor="p-desc">{t('project.description')}</label>
            <MarkdownEditor
              id="p-desc" value={form.description} minHeight={90}
              onChange={(value) => setForm({ ...form, description: value })}
            />
          </div>
          <div className={formField}>
            <label htmlFor="p-parent">{t('project.parent')}</label>
            <Select id="p-parent" value={form.parent_id}
              onChange={(event) => setForm({ ...form, parent_id: event.target.value })}
            >
              <option value="">{t('project.parentNone')}</option>
              {parents.map((other) => (
                <option key={other.id} value={other.id}>{other.icon} {other.name}</option>
              ))}
            </Select>
            <span className="text-label text-muted">{t('project.parentHint')}</span>
          </div>
          <div className={formField}>
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
      <div className={pageBody}>
        <Empty
          emoji="🗂️"
          title={t('project.containerEmpty')}
          hint={t('project.containerEmptyHint')}
        />
      </div>
    );
  }

  const day = today();

  return (
    <div className={pageBody}>
      <p className="text-muted text-label mb-2.5">{t('project.containerCount', { count: children.length })}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {children.map((child) => {
          const mine = tasks.filter((task) => task.project_id === child.id);
          const done = mine.filter((task) => byId('state', task.state_id)?.group_key === 'completed').length;
          const late = mine.filter((task) =>
            dueTone(task.due_date, byId('state', task.state_id)?.group_key, day) === 'overdue').length;
          return (
            <button
              key={child.id}
              type="button"
              className="rounded border border-line bg-raised p-3.5 text-start"
              onClick={() => navigate(`/projects/${child.id}`)}
            >
              <span className="flex items-center gap-2 mb-2">
                <span className="text-headline">{child.icon ?? '📁'}</span>
                <span className="flex-1 min-w-0 truncate font-semibold">{child.name}</span>
                {child.is_container ? <Icon name="folder" size={14} /> : <Chip className="font-mono">{child.key}</Chip>}
              </span>
              {child.is_container ? (
                <span className="text-muted text-label">{t('project.isContainer')}</span>
              ) : (
                <>
                  <Progress value={done} total={mine.length} />
                  <span className="flex items-center gap-2 mt-1.5 text-label text-muted">
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

const TABS = ['tasks', 'cycles', 'modules', 'pages', 'intake', 'insights', 'budget', 'kpis', 'settings'] as const;

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
  const kpis = useFeature('kpi');
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
        {/* Archived, deleted, or in a workspace this account left: all three
            open from a bookmark, and all three used to be a dead end. */}
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/projects', label: t('nav.projects'), icon: <Icon name="board" size={13} /> }]} />
        </div>
        <Empty
          emoji="🕳️" title={t('project.notFound')} hint={t('project.notFoundHint')}
          action={<Button onClick={() => navigate('/projects')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  // Projects nest, so the trail walks up the same way the wiki's does — and
  // stops on a parent it cannot see rather than looping on one that arrived
  // reparented over sync.
  const ancestors: typeof project[] = [];
  const seen = new Set<string>([project.id]);
  for (let at = project.parent_id ?? null; at && !seen.has(at);) {
    const parent = byId('project', at);
    if (!parent) break;
    seen.add(at);
    ancestors.unshift(parent);
    at = parent.parent_id ?? null;
  }
  const crumbs: Crumb[] = [
    { to: '/projects', label: t('nav.projects'), icon: <Icon name="board" size={13} /> },
    ...ancestors.map((one) => ({ to: `/projects/${one.id}`, label: one.name, icon: one.icon })),
  ];

  return (
    <>
      <Header title={<span className="flex items-center gap-2" style={{ gap: 7 }}><span>{project.icon}</span> {project.name}</span>}>
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

      {/* Above the tabs, not below: the tabs are places inside this project, and
          the trail is the way out of it. Mixing the two would read as a tenth
          tab. */}
      <div className="px-3 pt-3 sm:px-6">
        <Trail parts={crumbs} />
      </div>

      <TabList ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {/* Reports is always here, even for a project that will never use it.
            Hiding it until an intake link exists would make the one screen that
            explains how to get one the screen nobody can find. */}
        {(isContainer ? CONTAINER_TABS : TABS)
          // Budgets only when the workspace runs them. A tab that always says
          // "nothing charges this project" is a tab that teaches people to stop
          // reading the strip.
          .filter((name) => name !== 'budget' || budgets)
          .filter((name) => name !== 'kpis' || kpis)
          .map((name) => (
          <TabButton
            key={name}
            active={tab === name}
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
          </TabButton>
        ))}
      </TabList>

      {/*
        The description, where the screen has room for it.

        Not above a board: the board takes whatever height the screen has left
        (`.board-screen` in `app.css`), so anything put above it is taken out of
        every column. A board is the screen it is on. Every other layout — and a
        container, which has no board at all — scrolls, and a project that says
        what it is for at the top of it is worth more there than the two lines
        it costs.

        A project with no description gets nothing, which is most of them.
      */}
      {tab === 'tasks' && (isContainer || view.layout !== 'board') && project.description && (
        <div className="mx-auto max-w-[1180px] px-3 pt-4 sm:px-6 sm:pt-5 text-body">
          <Markdown source={project.description} />
        </div>
      )}
      {tab === 'tasks' && isContainer && <ContainerChildren projectId={id} />}
      {/* Against the board's own 12px inset for a board, which runs the width
          of the screen; inside the reading column for everything else. */}
      {tab === 'tasks' && !isContainer && (
        <ViewControls
          view={view} onChange={setView} projectId={id} saveable
          className={view.layout === 'board' ? 'px-3 pt-3' : 'mx-auto max-w-[1180px] px-3 pt-4 sm:px-6'}
        />
      )}
      {tab === 'tasks' && !isContainer && (
        view.layout === 'board'
          ? <div className="board-screen">
            <TaskViews tasks={visible} view={view} projectId={id} onOpen={openTask} />
          </div>
          : <div className={pageBody} style={{ paddingInline: 0 }}>
            <TaskViews
              tasks={visible} view={view} projectId={id} onOpen={openTask}
              onChange={setView} selection={selection}
            />
          </div>
      )}
      {tab === 'tasks' && !isContainer && <SelectionBar selection={selection} tasks={visible} />}
      {tab === 'cycles' && <Cycles projectId={id} Editor={MarkdownEditor} />}
      {tab === 'modules' && <Modules projectId={id} Editor={MarkdownEditor} />}
      {tab === 'pages' && <ProjectPages projectId={id} />}
      {tab === 'intake' && <Triage projectId={id} />}
      {tab === 'insights' && <ProjectInsights projectId={id} />}
      {tab === 'budget' && budgets && <Suspense fallback={null}><ProjectBudget projectId={id} /></Suspense>}
      {tab === 'kpis' && kpis && <Suspense fallback={null}><ProjectKpis projectId={id} /></Suspense>}
      {/* The route reaches into the other capabilities the settings tab shows,
          and hands them over — see `SettingsSlots`. */}
      {tab === 'settings' && (
        <ProjectSettings
          projectId={id}
          slots={{
            Editor: MarkdownEditor,
            hierarchyHint: <GuideHint to="hierarchy" />,
            fields: <ProjectFields projectId={id} />,
            time: <ProjectTime projectId={id} />,
            transfer: <ProjectTransfer projectId={id} />,
          }}
        />
      )}

      {adding && <QuickAdd projectId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/**
 * A project's pages, as the wiki draws them.
 *
 * It was a flat list in the store's order, with no status and the project's
 * templates mixed in as though they were content — a second, worse drawing of
 * rows the wiki already draws properly. Now it is the wiki's own tree, cut to
 * this project: a page whose parent sits in another project is drawn at the
 * top here, the way `PageTree` draws any page whose parent it was not given.
 */
function ProjectPages({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const me = useMe();
  const canWrite = useCanWrite();
  const folds = usePageFolds();
  const pages = useQuery(
    () => list('page', (p) => p.project_id === projectId && !p.archived && !p.is_template) as Page[],
    [projectId],
  );

  return (
    <div className={pageBody}>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-title">{t('project.pagesTitle')}</h2>
        <span className="flex-1 min-w-0" />
        {canWrite && (
          <Button size="sm" onClick={() => navigate(`/pages/${createPage({ project_id: projectId, title: t('common.untitled') }, me)}`)}>
            <Icon name="plus" size={14} /> {t('project.newPage')}
          </Button>
        )}
      </div>
      {!pages.length && <Empty emoji="📄" title={t('project.noPages')} hint={t('project.noPagesHint')} guide="pages" />}
      <PageTree pages={pages} canWrite={canWrite} folds={folds} marks />
    </div>
  );
}

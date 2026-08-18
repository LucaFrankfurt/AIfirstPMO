import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { orderKey, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { QuickAdd } from '../components/QuickAdd';
import { CycleProgress, DEFAULT_VIEW, TaskViews, useVisibleTasks, ViewControls, type ViewConfig } from '../components/views';
import { useSelection } from '../components/selection';
import { SelectionBar } from '../components/selection-bar';
import { ProjectTime } from '../components/time';
import { ImportSheet } from '../components/import';
import { ProjectInsights } from '../components/insights';
import { useTypes } from '../components/task-parts';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Avatar, Empty, GuideHint, Icon, MenuButton, Progress, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { shortDate, today } from '../lib/format';
import { byOrder, create, createPage, remove, update } from '../lib/mutations';
import { useOpenTask } from '../lib/navigation';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useMe, useMembers, useSession } from '../session';
import { groupKey, useT, type TranslationKey } from '../lib/i18n';

const VIEW_KEY = (projectId: string) => `kolibri.view.${projectId}`;

const TAB_KEY: Record<string, TranslationKey> = {
  tasks: 'project.tabTasks', cycles: 'project.tabCycles', modules: 'project.tabModules',
  pages: 'project.tabPages', insights: 'insights.tab', settings: 'project.tabSettings',
};

const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;

function useStoredView(projectId: string): [ViewConfig, (next: ViewConfig) => void] {
  const [view, setView] = useState<ViewConfig>(() => {
    try {
      const raw = localStorage.getItem(VIEW_KEY(projectId));
      return raw ? { ...DEFAULT_VIEW, ...JSON.parse(raw) } : DEFAULT_VIEW;
    } catch {
      return DEFAULT_VIEW;
    }
  });
  return [
    view,
    (next: ViewConfig) => {
      setView(next);
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

  return (
    <>
      <Header title={t('project.listTitle')}>
        <button className="btn primary sm" onClick={() => navigate('/projects/new')}><Icon name="plus" size={14} /> {t('action.create')}</button>
      </Header>
      <div className="page">
        <div className="grid two">
          {projects.map((project) => <ProjectCard key={project.id} projectId={project.id} />)}
        </div>
        {!projects.length && (
          <Empty
            emoji="📁" title={t('project.emptyTitle')} hint={t('project.emptyHint')} guide="overview"
            action={<button className="btn primary" onClick={() => navigate('/projects/new')}>{t('project.createCta')}</button>}
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
    <button className="card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate(`/projects/${projectId}`)}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 18 }}>{project.icon ?? '📁'}</span>
        <strong className="grow truncate">{project.name}</strong>
        <span className="chip mono">{project.key}</span>
      </div>
      {project.description && <p className="muted truncate" style={{ fontSize: 12.5 }}>{project.description}</p>}
      <Progress value={done} total={tasks.length} />
      <div className="row muted" style={{ fontSize: 12, marginTop: 6 }}>
        <span>{t('project.doneCount', { done, total: tasks.length })}</span>
        <span className="grow" />
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
  const [form, setForm] = useState({ name: '', key: '', description: '', icon: '🚀', visibility: 'public' });
  const [busy, setBusy] = useState(false);

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
      <div className="page" style={{ maxWidth: 560 }}>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="p-name">{t('project.name')}</label>
            <input
              id="p-name" className="input" required autoFocus value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={t('project.namePlaceholder')}
            />
          </div>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div className="field" style={{ width: 120 }}>
              <label htmlFor="p-icon">{t('project.icon')}</label>
              <input id="p-icon" className="input" value={form.icon} maxLength={4} onChange={(event) => setForm({ ...form, icon: event.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="p-key">{t('project.key')}</label>
              <input
                id="p-key" className="input mono" value={form.key} maxLength={6} placeholder={t('project.keyAuto')}
                onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })}
              />
              <span className="hint">{t('project.keyHint')}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="p-desc">{t('project.description')}</label>
            <textarea id="p-desc" className="textarea" style={{ minHeight: 80 }} value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="p-vis">{t('project.visibility')}</label>
            <select id="p-vis" className="select" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })}>
              <option value="public">{t('project.visibilityPublic')}</option>
              <option value="private">{t('project.visibilityPrivate')}</option>
            </select>
          </div>
          <button className="btn primary lg block" disabled={busy || !form.name.trim()}>
            {busy ? t('project.creating') : t('project.createSubmit')}
          </button>
        </form>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- project */

type Tab = 'tasks' | 'cycles' | 'modules' | 'pages' | 'insights' | 'settings';

export function ProjectPage() {
  const t = useT();
  const openTask = useOpenTask();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const project = useRow('project', id);
  const [view, setView] = useStoredView(id);
  const selection = useSelection();
  const [tab, setTab] = useState<Tab>('tasks');
  const [adding, setAdding] = useState(false);

  const tasks = useQuery(() => list('task', (t) => t.project_id === id && !t.parent_id), [id]);
  const visible = useVisibleTasks(tasks, view);

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
      <Header title={<span className="row" style={{ gap: 7 }}><span>{project.icon}</span> {project.name}</span>}>
        {tab === 'tasks' && <ViewControls view={view} onChange={setView} projectId={id} saveable />}
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> <span className="hide-sm">{t('nav.newTask')}</span>
        </button>
      </Header>

      <div className="tabs" style={{ padding: '0 12px' }}>
        {(['tasks', 'cycles', 'modules', 'pages', 'insights', 'settings'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {t(TAB_KEY[name])}
          </button>
        ))}
      </div>

      {tab === 'tasks' && (
        view.layout === 'board'
          ? <div style={{ height: 'calc(100dvh - var(--header-height) - 110px)' }}>
            <TaskViews tasks={visible} view={view} projectId={id} onOpen={openTask} />
          </div>
          : <div className="page" style={{ paddingInline: 0 }}>
            <TaskViews
              tasks={visible} view={view} projectId={id} onOpen={openTask}
              onChange={setView} selection={selection}
            />
          </div>
      )}
      {tab === 'tasks' && <SelectionBar selection={selection} tasks={visible} />}
      {tab === 'cycles' && <Cycles projectId={id} />}
      {tab === 'modules' && <Modules projectId={id} />}
      {tab === 'pages' && <ProjectPages projectId={id} />}
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
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15 }}>{t('cycle.title')}</h2>
        <span className="grow" />
        <button className="btn sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> {t('cycle.new')}</button>
      </div>

      {!cycles.length && <Empty emoji="🔁" title={t('cycle.emptyTitle')} hint={t('cycle.emptyHint')} guide="planning" />}

      <div className="grid two">
        {cycles.map((cycle) => {
          const active = cycle.start_date && cycle.end_date && cycle.start_date <= day && cycle.end_date >= day;
          return (
            <div className="card" key={cycle.id}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong className="grow truncate">{cycle.name}</strong>
                {active && <span className="chip" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>{t('cycle.active')}</span>}
                <MenuButton
                  className="btn ghost sm icon"
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
              <button className="btn sm block" style={{ marginTop: 10 }} onClick={() => navigate(`/cycles/${cycle.id}`)}>{t('cycle.open')}</button>
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
      footer={<button className="btn primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</button>}
    >
      <div className="field">
        <label htmlFor="c-name">{t('cycle.name')}</label>
        <input id="c-name" className="input" autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="c-start">{t('cycle.starts')}</label>
          <input id="c-start" className="input" type="date" value={form.start_date ?? ''} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
        </div>
        <div className="field grow">
          <label htmlFor="c-end">{t('cycle.ends')}</label>
          <input id="c-end" className="input" type="date" value={form.end_date ?? ''} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="c-desc">{t('cycle.goal')}</label>
        <textarea id="c-desc" className="textarea" value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value })} />
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
        <button className="btn primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /></button>
      </Header>
      <div className="page">
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="grow">
              <strong>{t('cycle.taskProgress', { done: burndown.done, total: burndown.total })}</strong>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t('cycle.pointProgress', { done: burndown.donePoints, total: burndown.points })}
                {cycle.start_date && cycle.end_date && ` · ${shortDate(cycle.start_date)} – ${shortDate(cycle.end_date)}`}
              </div>
            </div>
          </div>
          <Progress value={burndown.done} total={burndown.total} />
          {cycle.description && <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{cycle.description}</p>}
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
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15 }}>{t('module.title')}</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>{t('module.subtitle')}</span>
      </div>

      <form
        className="row" style={{ marginBottom: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          create('module', { project_id: projectId, name: name.trim(), status: 'planned', sort_order: orderKey(null, null) });
          setName('');
        }}
      >
        <input className="input" placeholder={t('module.placeholder')} value={name} onChange={(event) => setName(event.target.value)} />
        <button className="btn" type="submit"><Icon name="plus" size={14} /></button>
      </form>

      {!modules.length && <Empty emoji="🎯" title={t('module.emptyTitle')} hint={t('module.emptyHint')} guide="planning" />}

      <div className="grid two">
        {modules.map((module) => {
          const tasks = list('task', (task) => task.module_id === module.id);
          const done = tasks.filter((task) => ['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? '')).length;
          const lead = members.find((member) => member.id === module.lead_id);
          return (
            <div className="card" key={module.id}>
              <div className="row" style={{ marginBottom: 6 }}>
                <strong className="grow truncate">{module.name}</strong>
                {lead && <Avatar user={lead} size={20} />}
                <MenuButton
                  className="btn ghost sm icon"
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
              <div className="row muted" style={{ fontSize: 12, marginTop: 6 }}>
                <span>{done}/{tasks.length}</span>
                <span className="grow" />
                <input
                  className="input sm" type="date" style={{ width: 150, height: 28 }}
                  value={module.target_date ?? ''}
                  onChange={(event) => update('module', module.id, { target_date: event.target.value || null })}
                />
              </div>
              <button className="btn sm block" style={{ marginTop: 8 }} onClick={() => navigate(`/modules/${module.id}`)}>{t('action.open')}</button>
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
      <div className="page">
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
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15 }}>{t('project.pagesTitle')}</h2>
        <span className="grow" />
        <button className="btn sm" onClick={() => navigate(`/pages/${createPage({ project_id: projectId, title: t('common.untitled') }, me)}`)}>
          <Icon name="plus" size={14} /> {t('project.newPage')}
        </button>
      </div>
      {!pages.length && <Empty emoji="📄" title={t('project.noPages')} hint={t('project.noPagesHint')} guide="pages" />}
      {pages.map((page) => (
        <button key={page.id} className="task-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/pages/${page.id}`)}>
          <span>{page.icon ?? '📄'}</span>
          <span className="grow truncate">{page.title}</span>
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
  const { confirm, dialog } = useConfirm();
  const states = useQuery(
    () => list('state', (s) => s.project_id === projectId).sort(byOrder),
    [projectId],
  );
  const labels = useQuery(() => list('label', (l) => l.project_id === projectId), [projectId]);
  const types = useTypes(projectId);
  const [newLabel, setNewLabel] = useState('');
  const [importing, setImporting] = useState(false);
  if (!project) return null;

  return (
    <div className="page" style={{ maxWidth: 620 }}>
      <div className="field">
        <label htmlFor="s-name">{t('project.name')}</label>
        <input id="s-name" className="input" value={project.name} onChange={(event) => update('project', projectId, { name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="s-desc">{t('project.description')}</label>
        <textarea id="s-desc" className="textarea" value={project.description ?? ''}
          onChange={(event) => update('project', projectId, { description: event.target.value })} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="s-lead">{t('project.lead')}</label>
          <select id="s-lead" className="select" value={project.lead_id ?? ''} onChange={(event) => update('project', projectId, { lead_id: event.target.value || null })}>
            <option value="">{t('common.nobody')}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="s-target">{t('project.targetDate')}</label>
          <input id="s-target" className="input" type="date" value={project.target_date ?? ''}
            onChange={(event) => update('project', projectId, { target_date: event.target.value || null })} />
        </div>
      </div>

      <div className="row" style={{ margin: '18px 0 8px' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{t('project.workflowStates')}</h3>
        <span className="grow" />
        <GuideHint to="hierarchy" />
      </div>
      {states.map((state) => (
        <div className="row" key={state.id} style={{ padding: '5px 0' }}>
          <input
            type="color" value={state.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
            onChange={(event) => update('state', state.id, { color: event.target.value })}
          />
          <input className="input grow" value={state.name} onChange={(event) => update('state', state.id, { name: event.target.value })} />
          <select className="select" style={{ width: 140 }} value={state.group_key}
            onChange={(event) => update('state', state.id, { group_key: event.target.value })}>
            {STATE_GROUPS.map((group) => (
              <option key={group} value={group}>{t(groupKey(group))}</option>
            ))}
          </select>
          <button className="btn ghost icon" onClick={async () => {
            if (states.length <= 1) return;
            if (await confirm(t('project.deleteStateConfirm', { name: state.name }))) remove('state', state.id);
          }}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <button
        className="btn sm" style={{ marginTop: 6 }}
        onClick={() => create('state', {
          project_id: projectId, name: t('project.newStateName'), group_key: 'unstarted', color: '#64748b',
          sort_order: orderKey(states[states.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> {t('project.addState')}
      </button>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('type.settingsTitle')}</h3>
      <p className="hint" style={{ marginBottom: 8 }}>{t('type.settingsHint')}</p>
      {types.map((type) => (
        <div className="row" key={type.id} style={{ gap: 8, padding: '5px 0' }}>
          <input
            className="input" style={{ width: 56, textAlign: 'center' }} maxLength={4}
            aria-label={t('type.label')}
            value={type.icon ?? ''}
            onChange={(event) => update('taskType', type.id, { icon: event.target.value || null })}
          />
          <input
            className="input grow"
            value={type.name}
            aria-label={type.name}
            onChange={(event) => update('taskType', type.id, { name: event.target.value })}
          />
          <button
            className={`btn sm${type.is_default ? ' active' : ''}`}
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
          <button className="btn ghost sm icon" title={t('type.removeHint')} aria-label={t('type.removeHint')}
            onClick={() => remove('taskType', type.id)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
      <button
        className="btn sm"
        onClick={() => create('taskType', {
          project_id: projectId, name: t('type.newName'), icon: '◇', color: '#6366f1', is_default: 0,
          sort_order: orderKey(types[types.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> {t('type.add')}
      </button>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('project.labels')}</h3>
      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        {labels.map((label) => (
          <span className="chip button" key={label.id} onClick={() => remove('label', label.id)} title={t('project.labelRemoveHint')}>
            <span className="dot" style={{ background: label.color }} /> {label.name} ✕
          </span>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newLabel.trim()) return;
          create('label', { project_id: projectId, name: newLabel.trim(), color: '#6366f1' });
          setNewLabel('');
        }}
      >
        <input className="input" placeholder={t('project.newLabel')} value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
        <button className="btn" type="submit"><Icon name="plus" size={14} /></button>
      </form>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('time.title')}</h3>
      <ProjectTime projectId={projectId} />

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('import.title')}</h3>
      <button className="btn" onClick={() => setImporting(true)}>
        <Icon name="attach" size={14} /> {t('import.action')}
      </button>
      {importing && <ImportSheet projectId={projectId} onClose={() => setImporting(false)} />}

      <div className="divider" style={{ margin: '22px 0' }} />
      <div className="row">
        <button className="btn" onClick={() => update('project', projectId, { archived: project.archived ? 0 : 1 })}>
          <Icon name="archive" size={14} /> {project.archived ? t('project.unarchive') : t('project.archive')}
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            if (await confirm(t('project.deleteConfirm', { name: project.name }))) {
              remove('project', projectId);
              navigate('/');
            }
          }}
        >
          <Icon name="trash" size={14} /> {t('project.delete')}
        </button>
      </div>
      {dialog}
    </div>
  );
}

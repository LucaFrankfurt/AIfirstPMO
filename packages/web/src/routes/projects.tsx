import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { orderKey, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { QuickAdd } from '../components/QuickAdd';
import { CycleProgress, DEFAULT_VIEW, TaskViews, useVisibleTasks, ViewControls, type ViewConfig } from '../components/views';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Avatar, Empty, Icon, MenuButton, Progress, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { shortDate, today } from '../lib/format';
import { byOrder, create, createPage, remove, update } from '../lib/mutations';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useMe, useMembers, useSession } from '../session';

const VIEW_KEY = (projectId: string) => `kolibri.view.${projectId}`;

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
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId), [workspaceId]);

  return (
    <>
      <Header title="Projects">
        <button className="btn primary sm" onClick={() => navigate('/projects/new')}><Icon name="plus" size={14} /> New</button>
      </Header>
      <div className="page">
        <div className="grid two">
          {projects.map((project) => <ProjectCard key={project.id} projectId={project.id} />)}
        </div>
        {!projects.length && (
          <Empty
            emoji="📁" title="No projects yet" hint="A project holds tasks, cycles, modules and its own workflow states."
            action={<button className="btn primary" onClick={() => navigate('/projects/new')}>Create a project</button>}
          />
        )}
      </div>
    </>
  );
}

function ProjectCard({ projectId }: { projectId: string }) {
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
        <span>{done}/{tasks.length} done</span>
        <span className="grow" />
        {project.target_date && <span>Target {shortDate(project.target_date)}</span>}
      </div>
    </button>
  );
}

export function ProjectNew() {
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
      toast(err instanceof Error ? err.message : 'Could not create the project');
      setBusy(false);
    }
  }

  return (
    <>
      <Header title="New project" />
      <div className="page" style={{ maxWidth: 560 }}>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="p-name">Name</label>
            <input
              id="p-name" className="input" required autoFocus value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Website relaunch"
            />
          </div>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div className="field" style={{ width: 120 }}>
              <label htmlFor="p-icon">Icon</label>
              <input id="p-icon" className="input" value={form.icon} maxLength={4} onChange={(event) => setForm({ ...form, icon: event.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="p-key">Key</label>
              <input
                id="p-key" className="input mono" value={form.key} maxLength={6} placeholder="auto"
                onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })}
              />
              <span className="hint">Used for task identifiers, e.g. WEB-42.</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="p-desc">Description</label>
            <textarea id="p-desc" className="textarea" style={{ minHeight: 80 }} value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="p-vis">Visibility</label>
            <select id="p-vis" className="select" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })}>
              <option value="public">Everyone in the workspace</option>
              <option value="private">Only invited members</option>
            </select>
          </div>
          <button className="btn primary lg block" disabled={busy || !form.name.trim()}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </form>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- project */

type Tab = 'tasks' | 'cycles' | 'modules' | 'pages' | 'settings';

export function ProjectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const project = useRow('project', id);
  const [view, setView] = useStoredView(id);
  const [tab, setTab] = useState<Tab>('tasks');
  const [adding, setAdding] = useState(false);

  const tasks = useQuery(() => list('task', (t) => t.project_id === id && !t.parent_id), [id]);
  const visible = useVisibleTasks(tasks, view);

  if (!project) {
    return (
      <>
        <Header title="Project" />
        <Empty emoji="🕳️" title="Project not found" hint="It may have been deleted or you lost access." />
      </>
    );
  }

  return (
    <>
      <Header title={<span className="row" style={{ gap: 7 }}><span>{project.icon}</span> {project.name}</span>}>
        {tab === 'tasks' && <ViewControls view={view} onChange={setView} projectId={id} />}
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> <span className="hide-sm">New task</span>
        </button>
      </Header>

      <div className="tabs" style={{ padding: '0 12px' }}>
        {(['tasks', 'cycles', 'modules', 'pages', 'settings'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'tasks' && (
        view.layout === 'board'
          ? <div style={{ height: 'calc(100dvh - var(--header-height) - 110px)' }}>
            <TaskViews tasks={visible} view={view} projectId={id} onOpen={(task: Task) => navigate(`/t/${task.id}`)} />
          </div>
          : <div className="page" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <TaskViews tasks={visible} view={view} projectId={id} onOpen={(task: Task) => navigate(`/t/${task.id}`)} />
          </div>
      )}
      {tab === 'cycles' && <Cycles projectId={id} />}
      {tab === 'modules' && <Modules projectId={id} />}
      {tab === 'pages' && <ProjectPages projectId={id} />}
      {tab === 'settings' && <ProjectSettings projectId={id} />}

      {adding && <QuickAdd projectId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/* ----------------------------------------------------------------- cycles */

function Cycles({ projectId }: { projectId: string }) {
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
        <h2 style={{ fontSize: 15 }}>Cycles</h2>
        <span className="grow" />
        <button className="btn sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New cycle</button>
      </div>

      {!cycles.length && <Empty emoji="🔁" title="No cycles yet" hint="Cycles are time-boxed sprints. Tasks can move between them freely." />}

      <div className="grid two">
        {cycles.map((cycle) => {
          const active = cycle.start_date && cycle.end_date && cycle.start_date <= day && cycle.end_date >= day;
          return (
            <div className="card" key={cycle.id}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong className="grow truncate">{cycle.name}</strong>
                {active && <span className="chip" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>Active</span>}
                <MenuButton
                  className="btn ghost sm icon"
                  items={[
                    { id: 'edit', label: 'Edit', onSelect: () => setEditing(cycle.id) },
                    { id: 'open', label: 'Show tasks', onSelect: () => navigate(`/cycles/${cycle.id}`) },
                    { id: 'delete', label: 'Delete', danger: true, onSelect: () => remove('cycle', cycle.id) },
                  ]}
                >
                  <Icon name="dots" size={14} />
                </MenuButton>
              </div>
              <CycleProgress cycleId={cycle.id} />
              <button className="btn sm block" style={{ marginTop: 10 }} onClick={() => navigate(`/cycles/${cycle.id}`)}>Open cycle</button>
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
      title={cycleId ? 'Edit cycle' : 'New cycle'}
      onClose={onClose}
      footer={<button className="btn primary" onClick={save} disabled={!form.name.trim()}>Save</button>}
    >
      <div className="field">
        <label htmlFor="c-name">Name</label>
        <input id="c-name" className="input" autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="c-start">Starts</label>
          <input id="c-start" className="input" type="date" value={form.start_date ?? ''} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
        </div>
        <div className="field grow">
          <label htmlFor="c-end">Ends</label>
          <input id="c-end" className="input" type="date" value={form.end_date ?? ''} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="c-desc">Goal</label>
        <textarea id="c-desc" className="textarea" value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </div>
    </Sheet>
  );
}

export function CyclePage() {
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

  if (!cycle) return <Empty emoji="🕳️" title="Cycle not found" />;

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
              <strong>{burndown.done}/{burndown.total} tasks</strong>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {burndown.donePoints}/{burndown.points} points
                {cycle.start_date && cycle.end_date && ` · ${shortDate(cycle.start_date)} – ${shortDate(cycle.end_date)}`}
              </div>
            </div>
          </div>
          <Progress value={burndown.done} total={burndown.total} />
          {cycle.description && <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{cycle.description}</p>}
        </div>
        <TaskViews tasks={visible} view={view} projectId={cycle.project_id} onOpen={(task: Task) => navigate(`/t/${task.id}`)} />
      </div>
      {adding && <QuickAdd projectId={cycle.project_id} cycleId={id} onClose={() => setAdding(false)} />}
    </>
  );
}

/* ---------------------------------------------------------------- modules */

function Modules({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const members = useMembers();
  const modules = useQuery(() => list('module', (m) => m.project_id === projectId), [projectId]);
  const [name, setName] = useState('');

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15 }}>Modules</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>Longer-running workstreams inside this project</span>
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
        <input className="input" placeholder="New module, e.g. Checkout v2" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="btn" type="submit"><Icon name="plus" size={14} /></button>
      </form>

      {!modules.length && <Empty emoji="🎯" title="No modules yet" hint="Use modules for milestones that span several cycles." />}

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
                  items={[
                    ...members.map((member) => ({
                      id: member.id, section: 'Lead', label: member.name,
                      onSelect: () => update('module', module.id, { lead_id: member.id }),
                    })),
                    { id: 'delete', section: 'Danger', label: 'Delete module', danger: true, onSelect: () => remove('module', module.id) },
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
              <button className="btn sm block" style={{ marginTop: 8 }} onClick={() => navigate(`/modules/${module.id}`)}>Open</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ModulePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const module = useRow('module', id);
  const [view, setView] = useState<ViewConfig>(DEFAULT_VIEW);
  const tasks = useQuery(() => list('task', (t) => t.module_id === id), [id]);
  const visible = useVisibleTasks(tasks, view);
  if (!module) return <Empty emoji="🕳️" title="Module not found" />;
  return (
    <>
      <Header title={module.name}>
        <ViewControls view={view} onChange={setView} projectId={module.project_id} />
      </Header>
      <div className="page">
        {module.description && <Markdown source={module.description} />}
        <TaskViews tasks={visible} view={view} projectId={module.project_id} onOpen={(task: Task) => navigate(`/t/${task.id}`)} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------ pages + cfg */

function ProjectPages({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const me = useMe();
  const pages = useQuery(() => list('page', (p) => p.project_id === projectId && !p.archived), [projectId]);

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15 }}>Pages</h2>
        <span className="grow" />
        <button className="btn sm" onClick={() => navigate(`/pages/${createPage({ project_id: projectId, title: 'Untitled' }, me)}`)}>
          <Icon name="plus" size={14} /> New page
        </button>
      </div>
      {!pages.length && <Empty emoji="📄" title="No pages in this project" hint="Specs, notes and decisions live here." />}
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
  const project = useRow('project', projectId);
  const navigate = useNavigate();
  const members = useMembers();
  const { confirm, dialog } = useConfirm();
  const states = useQuery(
    () => list('state', (s) => s.project_id === projectId).sort(byOrder),
    [projectId],
  );
  const labels = useQuery(() => list('label', (l) => l.project_id === projectId), [projectId]);
  const [newLabel, setNewLabel] = useState('');
  if (!project) return null;

  return (
    <div className="page" style={{ maxWidth: 620 }}>
      <div className="field">
        <label htmlFor="s-name">Name</label>
        <input id="s-name" className="input" value={project.name} onChange={(event) => update('project', projectId, { name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="s-desc">Description</label>
        <textarea id="s-desc" className="textarea" value={project.description ?? ''}
          onChange={(event) => update('project', projectId, { description: event.target.value })} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="s-lead">Lead</label>
          <select id="s-lead" className="select" value={project.lead_id ?? ''} onChange={(event) => update('project', projectId, { lead_id: event.target.value || null })}>
            <option value="">Nobody</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="s-target">Target date</label>
          <input id="s-target" className="input" type="date" value={project.target_date ?? ''}
            onChange={(event) => update('project', projectId, { target_date: event.target.value || null })} />
        </div>
      </div>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>Workflow states</h3>
      {states.map((state) => (
        <div className="row" key={state.id} style={{ padding: '5px 0' }}>
          <input
            type="color" value={state.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
            onChange={(event) => update('state', state.id, { color: event.target.value })}
          />
          <input className="input grow" value={state.name} onChange={(event) => update('state', state.id, { name: event.target.value })} />
          <select className="select" style={{ width: 140 }} value={state.group_key}
            onChange={(event) => update('state', state.id, { group_key: event.target.value })}>
            {['backlog', 'unstarted', 'started', 'completed', 'cancelled'].map((group) => (
              <option key={group} value={group}>{group}</option>
            ))}
          </select>
          <button className="btn ghost icon" onClick={async () => {
            if (states.length <= 1) return;
            if (await confirm(`Delete the state “${state.name}”? Tasks keep their current state id.`)) remove('state', state.id);
          }}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <button
        className="btn sm" style={{ marginTop: 6 }}
        onClick={() => create('state', {
          project_id: projectId, name: 'New state', group_key: 'unstarted', color: '#64748b',
          sort_order: orderKey(states[states.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> Add state
      </button>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>Labels</h3>
      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        {labels.map((label) => (
          <span className="chip button" key={label.id} onClick={() => remove('label', label.id)} title="Click to remove">
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
        <input className="input" placeholder="New label" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
        <button className="btn" type="submit"><Icon name="plus" size={14} /></button>
      </form>

      <div className="divider" style={{ margin: '22px 0' }} />
      <div className="row">
        <button className="btn" onClick={() => update('project', projectId, { archived: project.archived ? 0 : 1 })}>
          <Icon name="archive" size={14} /> {project.archived ? 'Unarchive' : 'Archive'} project
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            if (await confirm(`Delete “${project.name}” and hide all of its tasks?`)) {
              remove('project', projectId);
              navigate('/');
            }
          }}
        >
          <Icon name="trash" size={14} /> Delete project
        </button>
      </div>
      {dialog}
    </div>
  );
}

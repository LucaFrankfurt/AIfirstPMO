import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { TaskRow } from '../components/task-parts';
import { TaskViews, useVisibleTasks, ViewControls, DEFAULT_VIEW, type ViewConfig } from '../components/views';
import { Avatar, Empty, Icon, useToast } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime, today } from '../lib/format';
import { excerpt } from '../lib/markdown';
import { markAllRead, markNotificationRead } from '../lib/mutations';
import { byId, list, useQuery } from '../lib/store';
import { useMe, useMemberMap, useSession } from '../session';

const openTask = (navigate: ReturnType<typeof useNavigate>) => (task: Task) => navigate(`/t/${task.id}`);

/* --------------------------------------------------------------- my work */

export function MyWork() {
  const me = useMe();
  const navigate = useNavigate();
  const { workspaceId } = useSession();
  const [view, setView] = useState<ViewConfig>({ ...DEFAULT_VIEW, groupBy: 'project', orderBy: 'due_date', showDone: false });

  const mine = useQuery(
    () => list('task', (t) => t.workspace_id === workspaceId && (t.assignees ?? []).includes(me)),
    [workspaceId, me],
  );
  const visible = useVisibleTasks(mine, view);
  const day = today();

  const buckets = useMemo(() => ({
    overdue: visible.filter((task) => task.due_date && task.due_date < day),
    today: visible.filter((task) => task.due_date === day),
  }), [visible, day]);

  const created = useQuery(
    () => list('task', (t) => t.created_by === me && !(t.assignees ?? []).includes(me)).slice(0, 8),
    [me],
  );

  return (
    <>
      <Header title="My work">
        <ViewControls view={view} onChange={setView} />
      </Header>
      <div className="page">
        {(buckets.overdue.length > 0 || buckets.today.length > 0) && (
          <div className="grid two" style={{ marginBottom: 18 }}>
            {buckets.overdue.length > 0 && (
              <div className="card">
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong className="due-overdue">Overdue</strong>
                  <span className="muted">{buckets.overdue.length}</span>
                </div>
                {buckets.overdue.slice(0, 5).map((task) => (
                  <TaskRow key={task.id} task={task} onOpen={openTask(navigate)} showProject />
                ))}
              </div>
            )}
            {buckets.today.length > 0 && (
              <div className="card">
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong className="due-today">Due today</strong>
                  <span className="muted">{buckets.today.length}</span>
                </div>
                {buckets.today.map((task) => (
                  <TaskRow key={task.id} task={task} onOpen={openTask(navigate)} showProject />
                ))}
              </div>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <Empty emoji="🎉" title="Nothing assigned to you" hint="Enjoy it, or pick something up from a project." />
        ) : (
          <TaskViews tasks={visible} view={view} onOpen={openTask(navigate)} showProject />
        )}

        {created.length > 0 && (
          <section style={{ marginTop: 26 }}>
            <h2 style={{ fontSize: 14, marginBottom: 6 }}>Created by you</h2>
            {created.map((task) => <TaskRow key={task.id} task={task} onOpen={openTask(navigate)} showProject />)}
          </section>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- inbox */

export function Inbox() {
  const me = useMe();
  const navigate = useNavigate();
  const members = useMemberMap();
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');

  const notifications = useQuery(
    () => list('notification', (n) => n.user_id === me && !n.archived_at)
      .sort((a, b) => b.created_at - a.created_at),
    [me],
  );
  const shown = filter === 'unread' ? notifications.filter((n) => !n.read_at) : notifications;

  return (
    <>
      <Header title="Inbox">
        <div className="tabs" style={{ border: 'none' }}>
          <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Unread</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
        </div>
        <button className="btn sm" onClick={() => markAllRead(me)} disabled={!notifications.some((n) => !n.read_at)}>
          <Icon name="check" size={14} /> <span className="hide-sm">Mark all read</span>
        </button>
      </Header>
      <div className="page">
        {shown.length === 0 ? (
          <Empty emoji="📭" title="Inbox zero" hint="Mentions, assignments and comments on your work land here." />
        ) : (
          shown.map((notification) => {
            const actor = members.get(notification.actor_id ?? '');
            return (
              <button
                key={notification.id}
                className="task-row"
                style={{ width: '100%', textAlign: 'left', opacity: notification.read_at ? 0.62 : 1 }}
                onClick={() => {
                  markNotificationRead(notification.id);
                  if (notification.task_id) navigate(`/t/${notification.task_id}`);
                  else if (notification.page_id) navigate(`/pages/${notification.page_id}`);
                }}
              >
                <Avatar user={actor} size={26} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <strong style={{ fontSize: 13.5 }}>{notification.title}</strong>
                    {!notification.read_at && <span className="badge-dot" />}
                  </span>
                  {notification.body && <span className="muted truncate" style={{ fontSize: 12.5 }}>{excerpt(notification.body, 90)}</span>}
                </span>
                <span className="muted" style={{ fontSize: 11.5 }}>{relativeTime(notification.created_at)}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- search */

export function Search() {
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [serverHits, setServerHits] = useState<any[]>([]);
  const toast = useToast();

  // Local results appear instantly (and offline); the server adds full-text
  // matches from descriptions and comments a moment later.
  const local = useQuery(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const tasks = list('task', (t) => `${t.identifier} ${t.title}`.toLowerCase().includes(needle)).slice(0, 25);
    const pages = list('page', (p) => p.title.toLowerCase().includes(needle)).slice(0, 10);
    return [
      ...tasks.map((task) => ({ kind: 'task', id: task.id, title: `${task.identifier} ${task.title}`, snippet: '' })),
      ...pages.map((page) => ({ kind: 'page', id: page.id, title: page.title, snippet: excerpt(page.content, 90) })),
    ];
  }, [query]);

  useEffect(() => {
    if (query.trim().length < 2 || !workspaceId) {
      setServerHits([]);
      return;
    }
    const handle = setTimeout(() => {
      api.search(workspaceId, query)
        .then((response) => setServerHits(response.results))
        .catch(() => setServerHits([]));
    }, 220);
    return () => clearTimeout(handle);
  }, [query, workspaceId]);

  const results = useMemo(() => {
    const seen = new Set(local.map((hit) => hit.id));
    return [...local, ...serverHits.filter((hit) => !seen.has(hit.id))];
  }, [local, serverHits]);

  const open = (hit: { kind: string; id: string }) => {
    if (hit.kind === 'task') navigate(`/t/${hit.id}`);
    else if (hit.kind === 'page') navigate(`/pages/${hit.id}`);
    else if (hit.kind === 'project') navigate(`/projects/${hit.id}`);
    else if (hit.kind === 'comment') {
      const comment = byId('comment', hit.id);
      if (comment?.task_id) navigate(`/t/${comment.task_id}`);
      else toast('That comment is not in this workspace any more');
    }
  };

  return (
    <>
      <Header title="Search" />
      <div className="page">
        <input
          className="input"
          autoFocus
          placeholder="Search tasks, pages, projects and comments…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ marginBottom: 14, fontSize: 16 }}
        />
        {query.trim().length < 2 ? (
          <Empty emoji="🔎" title="Type to search" hint="Titles match instantly from the local cache — full text comes from the server." />
        ) : results.length === 0 ? (
          <Empty emoji="🫙" title={`Nothing found for “${query}”`} />
        ) : (
          results.map((hit) => (
            <button key={`${hit.kind}-${hit.id}`} className="task-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => open(hit)}>
              <Icon name={hit.kind === 'task' ? 'check' : hit.kind === 'page' ? 'page' : 'folder'} size={15} />
              <span className="grow" style={{ minWidth: 0 }}>
                <div className="truncate">{hit.title}</div>
                {hit.snippet && <div className="muted truncate" style={{ fontSize: 12 }}>{hit.snippet}</div>}
              </span>
              <span className="muted" style={{ fontSize: 11.5 }}>{hit.kind}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------- mobile "more" */

export function More() {
  const navigate = useNavigate();
  const { session, workspaceId, setWorkspace, signOut, user } = useSession();
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);

  return (
    <>
      <Header title="More" />
      <div className="page">
        <div className="row" style={{ marginBottom: 16 }}>
          <Avatar user={user ?? undefined} size={40} />
          <div className="grow">
            <strong>{user?.name}</strong>
            <div className="muted" style={{ fontSize: 12.5 }}>{user?.email}</div>
          </div>
        </div>

        <div className="card" style={{ padding: 6, marginBottom: 14 }}>
          <button className="nav-item" onClick={() => navigate('/pages')}><Icon name="page" size={16} /> Pages</button>
          <button className="nav-item" onClick={() => navigate('/teams')}><Icon name="users" size={16} /> Teams</button>
          <button className="nav-item" onClick={() => navigate('/projects/new')}><Icon name="plus" size={16} /> New project</button>
          <button className="nav-item" onClick={() => navigate('/settings')}><Icon name="settings" size={16} /> Settings</button>
        </div>

        <div className="nav-section">Projects</div>
        <div className="card" style={{ padding: 6, marginBottom: 14 }}>
          {projects.map((project) => (
            <button key={project.id} className="nav-item" onClick={() => navigate(`/projects/${project.id}`)}>
              <span style={{ width: 18 }}>{project.icon ?? '•'}</span> {project.name}
            </button>
          ))}
        </div>

        {(session?.workspaces.length ?? 0) > 1 && (
          <>
            <div className="nav-section">Workspaces</div>
            <div className="card" style={{ padding: 6, marginBottom: 14 }}>
              {session?.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`nav-item${workspace.id === workspaceId ? ' active' : ''}`}
                  onClick={() => setWorkspace(workspace.id)}
                >
                  {workspace.name}
                </button>
              ))}
            </div>
          </>
        )}

        <button className="btn block danger" onClick={() => void signOut()}>
          <Icon name="logout" size={15} /> Sign out
        </button>
      </div>
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { excerpt, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { TaskRow } from '../components/task-parts';
import { TaskViews, useVisibleTasks, ViewControls, DEFAULT_VIEW, type ViewConfig } from '../components/views';
import { useSelection } from '../components/selection';
import { SelectionBar } from '../components/selection-bar';
import { Avatar, Empty, Icon, useToast } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime, today } from '../lib/format';

import { markAllRead, markNotificationRead } from '../lib/mutations';
import { useOpenTask } from '../lib/navigation';
import { byId, list, useQuery } from '../lib/store';
import { useMe, useMemberMap, useSession } from '../session';
import { useUnreadMessages } from './chat';
import { useT, type TranslationKey } from '../lib/i18n';
import { SetupChecklist } from '../components/tour';

const KIND_KEY: Record<string, TranslationKey> = {
  task: 'search.kindTask', page: 'search.kindPage',
  project: 'search.kindProject', comment: 'search.kindComment',
};



/* --------------------------------------------------------------- my work */

export function MyWork() {
  const t = useT();
  const me = useMe();
  const openTask = useOpenTask();
  const { workspaceId } = useSession();
  const [view, setView] = useState<ViewConfig>({ ...DEFAULT_VIEW, groupBy: 'project', orderBy: 'due_date', showDone: false });
  const selection = useSelection();

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
      <Header title={t('myWork.title')}>
        <ViewControls view={view} onChange={setView} saveable />
      </Header>
      <div className="page">
        <SetupChecklist />

        {(buckets.overdue.length > 0 || buckets.today.length > 0) && (
          <div className="grid two" style={{ marginBottom: 18 }}>
            {buckets.overdue.length > 0 && (
              <div className="card">
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong className="due-overdue">{t('myWork.overdue')}</strong>
                  <span className="muted">{buckets.overdue.length}</span>
                </div>
                {buckets.overdue.slice(0, 5).map((task) => (
                  <TaskRow key={task.id} task={task} onOpen={openTask} showProject />
                ))}
              </div>
            )}
            {buckets.today.length > 0 && (
              <div className="card">
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong className="due-today">{t('myWork.dueToday')}</strong>
                  <span className="muted">{buckets.today.length}</span>
                </div>
                {buckets.today.map((task) => (
                  <TaskRow key={task.id} task={task} onOpen={openTask} showProject />
                ))}
              </div>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <Empty emoji="🎉" title={t('myWork.emptyTitle')} hint={t('myWork.emptyHint')} guide="capture" />
        ) : (
          <TaskViews tasks={visible} view={view} onOpen={openTask} showProject onChange={setView} selection={selection} />
        )}

        <SelectionBar selection={selection} tasks={visible} />

        {created.length > 0 && (
          <section style={{ marginTop: 26 }}>
            <h2 style={{ fontSize: 14, marginBottom: 6 }}>{t('myWork.createdByYou')}</h2>
            {created.map((task) => <TaskRow key={task.id} task={task} onOpen={openTask} showProject />)}
          </section>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- inbox */

export function Inbox() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const openTask = useOpenTask();
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
      <Header title={t('inbox.title')}>
        <div className="tabs" style={{ border: 'none' }}>
          <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>{t('inbox.unread')}</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>{t('inbox.all')}</button>
        </div>
        <button className="btn sm" onClick={() => markAllRead(me)} disabled={!notifications.some((n) => !n.read_at)}>
          <Icon name="check" size={14} /> <span className="hide-sm">{t('inbox.markAllRead')}</span>
        </button>
      </Header>
      <div className="page">
        {shown.length === 0 ? (
          <Empty emoji="📭" title={t('inbox.emptyTitle')} hint={t('inbox.emptyHint')} guide="collab" />
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
                  if (notification.task_id) openTask({ id: notification.task_id });
                  else if (notification.page_id) navigate(`/pages/${notification.page_id}`);
                  // Something somebody said opens the conversation they said it
                  // in. Without this the row announces a message and then does
                  // nothing when pressed, which is worse than not sending it.
                  else if (notification.channel_id) navigate(`/chat/${notification.channel_id}`);
                  // A report from outside is about a project's queue rather
                  // than a row, so it opens the tab that holds it.
                  else if (notification.project_id) navigate(`/projects/${notification.project_id}?tab=intake`);
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
  const t = useT();
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const openTask = useOpenTask();
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
    if (hit.kind === 'task') openTask({ id: hit.id });
    else if (hit.kind === 'page') navigate(`/pages/${hit.id}`);
    else if (hit.kind === 'project') navigate(`/projects/${hit.id}`);
    else if (hit.kind === 'comment') {
      const comment = byId('comment', hit.id);
      if (comment?.task_id) openTask({ id: comment.task_id });
      else toast(t('search.commentGone'));
    } else if (hit.kind === 'message') {
      // The conversation, not the message: a stream has no anchor to scroll to
      // and pretending otherwise would be a link that lands in the wrong place.
      const message = byId('message', hit.id);
      if (message?.channel_id) navigate(`/chat/${message.channel_id}`);
      else toast(t('search.messageGone'));
    }
  };

  return (
    <>
      <Header title={t('search.title')} />
      <div className="page">
        <input
          className="input"
          autoFocus
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ marginBottom: 14, fontSize: 16 }}
        />
        {query.trim().length < 2 ? (
          <Empty emoji="🔎" title={t('search.promptTitle')} hint={t('search.promptHint')} />
        ) : results.length === 0 ? (
          <Empty emoji="🫙" title={t('search.noResults', { query })} />
        ) : (
          results.map((hit) => (
            <button key={`${hit.kind}-${hit.id}`} className="task-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => open(hit)}>
              <Icon name={hit.kind === 'task' ? 'check' : hit.kind === 'page' ? 'page' : 'folder'} size={15} />
              <span className="grow" style={{ minWidth: 0 }}>
                <div className="truncate">{hit.title}</div>
                {hit.snippet && <div className="muted truncate" style={{ fontSize: 12 }}>{hit.snippet}</div>}
              </span>
              <span className="muted" style={{ fontSize: 11.5 }}>{KIND_KEY[hit.kind] ? t(KIND_KEY[hit.kind]) : hit.kind}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------- mobile "more" */

export function More() {
  const t = useT();
  const navigate = useNavigate();
  const { session, workspaceId, setWorkspace, signOut, user } = useSession();
  const me = useMe();
  const unreadMessages = useUnreadMessages(me);
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);

  return (
    <>
      <Header title={t('nav.more')} />
      <div className="page">
        <div className="row" style={{ marginBottom: 16 }}>
          <Avatar user={user ?? undefined} size={40} />
          <div className="grow">
            <strong>{user?.name}</strong>
            <div className="muted" style={{ fontSize: 12.5 }}>{user?.email}</div>
          </div>
        </div>

        {/* Everything the sidebar has and the bottom bar does not. A phone has
            room for five things at the bottom, so this screen is the rest of
            the app — and anything missing here is unreachable on a phone
            rather than merely inconvenient. Chat was, for a while. */}
        {/* Links rather than buttons that navigate: a long-press to open in a
            new tab is a thing people do, and it also means "can a phone reach
            this?" is a question about hrefs that a test can ask. */}
        <div className="card" style={{ padding: 6, marginBottom: 14 }}>
          <Link className="nav-item" to="/chat">
            <Icon name="chat" size={16} /> <span className="grow">{t('nav.chat')}</span>
            {unreadMessages > 0 && <span className="count">{unreadMessages}</span>}
          </Link>
          <Link className="nav-item" to="/pages"><Icon name="page" size={16} /> {t('nav.pages')}</Link>
          <Link className="nav-item" to="/teams"><Icon name="users" size={16} /> {t('nav.teams')}</Link>
          <Link className="nav-item" to="/planner"><Icon name="users" size={16} /> {t('nav.planner')}</Link>
          <Link className="nav-item" to="/projects/new"><Icon name="plus" size={16} /> {t('nav.newProject')}</Link>
          <Link className="nav-item" to="/settings"><Icon name="settings" size={16} /> {t('nav.settings')}</Link>
          <Link className="nav-item" to="/guide"><Icon name="help" size={16} /> {t('nav.guide')}</Link>
        </div>

        <div className="nav-section">{t('nav.projects')}</div>
        <div className="card" style={{ padding: 6, marginBottom: 14 }}>
          {projects.map((project) => (
            <Link key={project.id} className="nav-item" to={`/projects/${project.id}`}>
              <span style={{ width: 18 }}>{project.icon ?? '•'}</span> {project.name}
            </Link>
          ))}
          {projects.length > 1 && (
            <Link className="nav-item" to="/portfolio">
              <Icon name="target" size={16} /> {t('nav.portfolio')}
            </Link>
          )}
        </div>

        {(session?.workspaces.length ?? 0) > 1 && (
          <>
            <div className="nav-section">{t('nav.workspaces')}</div>
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
          <Icon name="logout" size={15} /> {t('nav.signOut')}
        </button>
      </div>
    </>
  );
}

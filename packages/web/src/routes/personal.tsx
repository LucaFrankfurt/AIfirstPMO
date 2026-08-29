import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { excerpt, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { TaskRow } from '../components/task-parts';
import { TaskViews, useVisibleTasks, ViewControls } from '../components/views';
import { DEFAULT_VIEW, type ViewConfig } from '../components/task-parts';
import { useSelection } from '../components/selection';
import { SelectionBar } from '../components/selection-bar';
import { Avatar, Empty, Icon } from '../components/ui';
import { Stat } from '../components/insights';
import { isDone, relativeTime, today } from '../lib/format';
import { firstName, greetingKey, summarise } from '../lib/overview';
import { useRecentProjects } from '../lib/recents';

import { markAllRead, markNotificationRead } from '../lib/mutations';
import { useOpenTask } from '../lib/navigation';
import { byId, list, useQuery } from '../lib/store';
import { useFeatures, useMe, usePeople, useSession } from '../session';
import { useUnreadMessages } from './chat';
import { useT } from '../lib/i18n';
import { DESTINATIONS, enabled } from '../lib/nav';
import { Button } from '../components/ui/button';
import { navCount, navItem } from '../components/ui/nav';
import { SetupChecklist } from '../components/tour';
import { useTabStrip } from '../lib/tab-strip';

/* --------------------------------------------------------------- my work */

export function MyWork() {
  const t = useT();
  const me = useMe();
  const openTask = useOpenTask();
  const { workspaceId, user } = useSession();
  const [view, setView] = useState<ViewConfig>({ ...DEFAULT_VIEW, groupBy: 'project', orderBy: 'due_date', showDone: false });
  const selection = useSelection();

  // Archived work is left out here rather than downstream, because the figures
  // and the list are both drawn from this: the view drops archived tasks of its
  // own accord, so counting them would have put a number on the tile that the
  // rows it opens could never add up to.
  const mine = useQuery(
    () => list('task', (t) => t.workspace_id === workspaceId && !t.archived && (t.assignees ?? []).includes(me)),
    [workspaceId, me],
  );
  const visible = useVisibleTasks(mine, view);
  const day = today();

  const buckets = useMemo(() => ({
    overdue: visible.filter((task) => task.due_date && task.due_date < day),
    today: visible.filter((task) => task.due_date === day),
  }), [visible, day]);

  /**
   * The figures at the top.
   *
   * Counted over everything assigned to you rather than over what the view is
   * currently showing: the view hides finished work by default, and an
   * overview that reports zero finished because of a filter is a lie told by
   * arithmetic. `useQuery` rather than `useMemo` because whether a task counts
   * as done is a fact about its *state*, so renaming a column's group has to
   * move the numbers too.
   */
  const standing = useQuery(
    () => summarise(
      mine.map((task) => ({
        due_date: task.due_date,
        completed_at: task.completed_at,
        done: isDone(byId('state', task.state_id)?.group_key),
      })),
      day,
      Date.now(),
    ),
    [mine, day],
  );

  const recents = useRecentProjects(workspaceId, 4);

  /**
   * A figure is also the way into what it counted.
   *
   * `due` and `showDone` are the only parts of the view a tile touches — a
   * filter somebody set themselves survives being sent to the list, because
   * throwing it away would make the tile a reset button wearing a number.
   * Pressing the tile that is already on goes back to everything open, so the
   * row toggles instead of trapping you in one bucket.
   */
  const listTop = useRef<HTMLDivElement>(null);
  const bucket = view.showDone ? undefined : view.filters.due ?? 'open';
  const show = (next: 'open' | 'week' | 'none') => {
    const wanted = bucket === next ? 'open' : next;
    setView({
      ...view,
      showDone: false,
      filters: { ...view.filters, due: wanted === 'open' ? undefined : wanted },
    });
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Their first name, or no greeting at all. Addressing somebody as "" is
  // worse than opening with the list.
  const name = firstName(user?.name);

  const created = useQuery(
    () => list('task', (t) => t.created_by === me && !(t.assignees ?? []).includes(me)).slice(0, 8),
    [me],
  );

  return (
    <>
      <Header title={t('myWork.title')}>
        <ViewControls view={view} onChange={setView} saveable />
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {name && <h2 className="greeting mb-3.5">{t(greetingKey(new Date().getHours()), { name })}</h2>}

        <SetupChecklist />

        {mine.length > 0 && (
          <div className="kpi-row">
            <Stat
              label={t('overview.statOpen')} value={String(standing.open)}
              onSelect={() => show('open')} active={bucket === 'open'}
            />
            <Stat
              label={t('overview.statSoon')} value={String(standing.soon)}
              onSelect={() => show('week')} active={bucket === 'week'}
            />
            <Stat
              label={t('overview.statUnscheduled')} value={String(standing.unscheduled)}
              onSelect={() => show('none')} active={bucket === 'none'}
            />
            {/* Not pressable, and deliberately the odd one out. The figure is
                the last seven days; the list can filter to "finished" but not
                to "finished recently", so a press would open a set that does
                not match the number above it. */}
            <Stat label={t('overview.statDone')} value={String(standing.done)} hint={t('overview.lastDays')} />
          </div>
        )}

        {recents.length > 0 && (
          <section className="mb-[18px]">
            <h2 className="text-sm mb-1.5">{t('overview.recent')}</h2>
            <div className="recents">
              {recents.map((project) => (
                <Link key={project.id} className="recent-card" to={`/projects/${project.id}`}>
                  <span className="recent-icon">{project.icon ?? '\u2022'}</span>
                  <span className="recent-name">{project.name}</span>
                  <span className="recent-key">{project.key}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {(buckets.overdue.length > 0 || buckets.today.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2 mb-[18px]">
            {buckets.overdue.length > 0 && (
              <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
                <div className="flex items-center gap-2 mb-2">
                  <strong className="due-overdue">{t('myWork.overdue')}</strong>
                  <span className="text-muted">{buckets.overdue.length}</span>
                </div>
                {buckets.overdue.slice(0, 5).map((task) => (
                  <TaskRow key={task.id} task={task} onOpen={openTask} showProject />
                ))}
              </div>
            )}
            {buckets.today.length > 0 && (
              <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
                <div className="flex items-center gap-2 mb-2">
                  <strong className="due-today">{t('myWork.dueToday')}</strong>
                  <span className="text-muted">{buckets.today.length}</span>
                </div>
                {buckets.today.map((task) => (
                  <TaskRow key={task.id} task={task} onOpen={openTask} showProject />
                ))}
              </div>
            )}
          </div>
        )}

        <div ref={listTop} className="my-work-list">
          {visible.length === 0 ? (
            <Empty emoji="🎉" title={t('myWork.emptyTitle')} hint={t('myWork.emptyHint')} guide="capture" />
          ) : (
            <TaskViews tasks={visible} view={view} onOpen={openTask} showProject onChange={setView} selection={selection} />
          )}
        </div>

        <SelectionBar selection={selection} tasks={visible} />

        {created.length > 0 && (
          <section className="mt-[26px]">
            <h2 className="text-sm mb-1.5">{t('myWork.createdByYou')}</h2>
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
  // Everybody known rather than the workspace's members: a direct message can
  // come from somebody in none of your workspaces, and a notification from a
  // nameless "?" is worse than the message it announces.
  const members = usePeople();
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');
  const strip = useTabStrip(filter);

  const notifications = useQuery(
    () => list('notification', (n) => n.user_id === me && !n.archived_at)
      .sort((a, b) => b.created_at - a.created_at),
    [me],
  );
  const shown = filter === 'unread' ? notifications.filter((n) => !n.read_at) : notifications;

  return (
    <>
      <Header title={t('inbox.title')}>
        {/* The strip's line lives in an inset shadow now, not a border — this
            one sits inside the header, which draws its own. */}
        <div ref={strip} className="tabs" style={{ boxShadow: 'none' }}>
          <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>{t('inbox.unread')}</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>{t('inbox.all')}</button>
        </div>
        <Button size="sm" onClick={() => markAllRead(me)} disabled={!notifications.some((n) => !n.read_at)}>
          <Icon name="check" size={14} /> <span className="hide-sm">{t('inbox.markAllRead')}</span>
        </Button>
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
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
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <strong className="text-[13.5px]">{notification.title}</strong>
                    {!notification.read_at && <span className="size-1.5 flex-none rounded-full bg-accent" />}
                  </span>
                  {notification.body && <span className="text-muted truncate text-[12.5px]">{excerpt(notification.body, 90)}</span>}
                </span>
                <span className="text-muted text-[11.5px]">{relativeTime(notification.created_at)}</span>
              </button>
            );
          })
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
  const has = useFeatures();
  const unreadMessages = useUnreadMessages(me);
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);

  return (
    <>
      <Header title={t('nav.more')} />
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <div className="flex items-center gap-2 mb-4">
          <Avatar user={user ?? undefined} size={40} />
          <div className="flex-1 min-w-0">
            <strong>{user?.name}</strong>
            <div className="text-muted text-[12.5px]">{user?.email}</div>
          </div>
        </div>

        {/* Everything the sidebar has and the bottom bar does not. A phone has
            room for five things at the bottom, so this screen is the rest of
            the app — and anything missing here is unreachable on a phone
            rather than merely inconvenient. Chat was, for a while; budgets,
            the timesheet and the register were, from the day they shipped.
            Hence `lib/nav.ts`: the sidebar renders the same list, so a new
            destination arrives on both at once. */}
        {/* Links rather than buttons that navigate: a long-press to open in a
            new tab is a thing people do, and it also means "can a phone reach
            this?" is a question about hrefs that a test can ask. */}
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5" style={{ padding: 6 }}>
          {enabled(DESTINATIONS, has).map((item) => (
            <Link key={item.to} className={navItem()} to={item.to}>
              <Icon name={item.icon} size={16} />
              <span className="flex-1 min-w-0">{t(item.label)}</span>
              {item.to === '/chat' && unreadMessages > 0 && <span className={navCount}>{unreadMessages}</span>}
            </Link>
          ))}
          {/* Not destinations in the shared sense: one opens a form and the
              other is the account, and neither belongs in a sidebar that
              already has them elsewhere. */}
          <Link className={navItem()} to="/projects/new"><Icon name="plus" size={16} /> {t('nav.newProject')}</Link>
          <Link className={navItem()} to="/settings"><Icon name="settings" size={16} /> {t('nav.settings')}</Link>
        </div>

        <div className="nav-section">{t('nav.projects')}</div>
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5" style={{ padding: 6 }}>
          {projects.map((project) => (
            <Link key={project.id} className={navItem()} to={`/projects/${project.id}`}>
              <span style={{ width: 18 }}>{project.icon ?? '•'}</span> {project.name}
            </Link>
          ))}
          {projects.length > 1 && (
            <Link className={navItem()} to="/portfolio">
              <Icon name="target" size={16} /> {t('nav.portfolio')}
            </Link>
          )}
        </div>

        {(session?.workspaces.length ?? 0) > 1 && (
          <>
            <div className="nav-section">{t('nav.workspaces')}</div>
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5" style={{ padding: 6 }}>
              {session?.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={navItem({ active: workspace.id === workspaceId })}
                  onClick={() => setWorkspace(workspace.id)}
                >
                  {workspace.name}
                </button>
              ))}
            </div>
          </>
        )}

        <Button variant="danger" block onClick={() => void signOut()}>
          <Icon name="logout" size={15} /> {t('nav.signOut')}
        </Button>
      </div>
    </>
  );
}

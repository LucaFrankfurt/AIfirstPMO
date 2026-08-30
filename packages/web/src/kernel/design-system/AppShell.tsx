import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, type NavLinkProps } from 'react-router-dom';
import { byId as byIdStore, list, useQuery } from '../sync/store';
import { update } from '../sync/mutations';
import { pull, subscribeSync, type SyncStatus } from '../sync/sync';
import { useCanWrite, useFeatures, useMe, useSession } from '../identity/session';
import { currentLocale, useT, type TranslationKey } from '../i18n/i18n';
import { enabled, PLANNING_DESTINATIONS, WORKSPACE_DESTINATIONS } from './nav';
import { Avatar, Icon, MenuButton, type MenuItem } from './ui';
import { QuickAdd } from '../../modules/work/QuickAdd';
import { useActiveProject } from './active-project';
import { isDrag, idFrom, PROJECT_DRAG, startDrag, TASK_DRAG } from './drag';
import { useRecordVisits } from '../search/recents';
import { useRefile } from '../../modules/work/task-parts';
import { CommandPalette } from './CommandPalette';
import { Button } from './ui/button';
import { navCount, navItem } from './ui/nav';
import { chipDot } from './ui/chip';
import { useUnreadMessages } from '../../modules/chat/routes/chat';

/** Which project branches this device has folded. Never synced — see below. */
const COLLAPSED_KEY = 'kolibri.collapsed-projects';

/* ------------------------------------------------------------ sync status */

function SyncPill() {
  const t = useT();
  const [status, setStatus] = useState<SyncStatus>({ state: 'starting', pending: 0, lastSyncedAt: null });
  useEffect(() => subscribeSync(setStatus), []);

  const label =
    status.state === 'offline'
      ? (status.pending ? t('sync.offlineQueued', { count: status.pending }) : t('sync.offline'))
      : status.state === 'error' ? t('sync.issue')
        : status.pending ? t('sync.syncing', { count: status.pending })
          : t('sync.synced');

  return (
    <button
      className={`status-pill ${status.state}`}
      onClick={() => void pull()}
      // The word beside the dot is `hide-sm`, so on a phone this button is a
      // coloured dot and nothing else. The name has to come from somewhere.
      aria-label={`${label} — ${t('sync.now')}`}
      title={status.message ?? (status.lastSyncedAt
        ? t('sync.lastSynced', { time: new Date(status.lastSyncedAt).toLocaleTimeString(currentLocale()) })
        : t('sync.now'))}
    >
      {/* `dot` as well as the utilities: every colour this indicator has —
          green for synced, amber for offline, red for a failure, and the
          pulsing accent while it works — is keyed on `.status-pill .dot` in
          the stylesheet, and the class had been dropped. The dot was drawing
          nothing. On a desktop the word beside it covered for that; on a phone
          the word is hidden and the status was an empty circle. */}
      <span className={`dot ${chipDot}`} />
      <span className="hide-sm">{label}</span>
    </button>
  );
}

/* ----------------------------------------------------------------- themes */

type Theme = 'system' | 'light' | 'dark';

function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('kolibri.theme', theme);
}

export const THEME_KEY: Record<Theme, TranslationKey> = {
  system: 'profile.themeSystem', light: 'profile.themeLight', dark: 'profile.themeDark',
};

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('kolibri.theme') as Theme) ?? 'system');
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, setTheme];
}

/* ------------------------------------------------------------------ shell */

const Item = ({ to, icon, children, count }: { to: string; icon: string; children: React.ReactNode; count?: number } & Partial<NavLinkProps>) => (
  <NavLink to={to} className={navItem()} end={to === '/'}>
    <Icon name={icon} size={16} />
    <span className="flex-1 min-w-0 truncate">{children}</span>
    {count ? <span className={navCount}>{count}</span> : null}
  </NavLink>
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  const { session, workspaceId, setWorkspace, signOut, user } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [adding, setAdding] = useState(false);
  const activeProject = useActiveProject();
  // The shell outlives every route, so this is the one place that sees all of
  // them — including a project reached by a link inside a task sheet.
  useRecordVisits(workspaceId);
  const canWrite = useCanWrite();
  /* One predicate the nav list is filtered through, rather than a `const` per
     switch that has to be threaded to each place that renders one. */
  const has = useFeatures();
  const [palette, setPalette] = useState(false);
  // The same move the card's own menu makes — see `useRefile`.
  const refile = useRefile();

  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );
  // Sub-projects sit under their parent, and a project whose parent is archived
  // or invisible comes back to the top rather than disappearing with it.
  /**
   * Which branches are folded, kept on this device.
   *
   * Not synced, and that is the point: whether *I* have the marketing tree
   * collapsed is not a fact about the workspace, and pushing it as one would
   * mean two people fighting over a chevron.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleCollapsed = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private window */ }
    return next;
  });

  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const nested = useMemo(() => {
    const known = new Set(projects.map((project) => project.id));
    const children = new Map<string | null, typeof projects>();
    for (const project of projects) {
      const parent = project.parent_id && known.has(project.parent_id) ? project.parent_id : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(project);
    }
    const out: { project: (typeof projects)[number]; depth: number; hasChildren: boolean }[] = [];
    const walk = (parent: string | null, depth: number): void => {
      for (const project of children.get(parent) ?? []) {
        const hasChildren = (children.get(project.id) ?? []).length > 0;
        out.push({ project, depth, hasChildren });
        // A folded branch is not walked, so its children are absent from the
        // list rather than hidden by CSS — which is what keeps the keyboard
        // and a screen reader agreeing with what is on screen.
        if (hasChildren && !collapsed.has(project.id) && depth < 3) walk(project.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [projects, collapsed]);

  /**
   * Move the dragged project under another one, or out to the top.
   *
   * The two refusals are the whole of the rule: a project cannot be its own
   * parent, and it cannot be moved under something it already contains — that
   * makes a ring, and a ring is a sidebar that renders until the stack runs
   * out. The server refuses a longer loop as well; this is the half that can
   * refuse it before anything is written.
   */
  const reparent = (parentId: string | null) => {
    const id = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!id || id === parentId) return;

    if (parentId) {
      const byId = new Map(projects.map((project) => [project.id, project]));
      for (let at: string | null | undefined = parentId; at; at = byId.get(at)?.parent_id) {
        if (at === id) return;   // dropping a branch onto its own leaf
      }
    }
    if ((byIdStore('project', id) as { parent_id?: string | null } | undefined)?.parent_id === parentId) return;
    update('project', id, { parent_id: parentId });
  };
  const unread = useQuery(() => list('notification', (n) => n.user_id === me && !n.read_at).length, [me]);
  const unreadMessages = useUnreadMessages(me);
  const myOpen = useQuery(
    () => list('task', (t) => (t.assignees ?? []).includes(me) && !t.archived).length,
    [me],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      } else if (event.key === 'c' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setAdding(true);
      } else if (event.key === '?' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        navigate('/guide');
      }
    };
    // The setup checklist asks for the quick-add sheet from outside the shell.
    const openQuickAdd = () => setAdding(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('kolibri:new-task', openQuickAdd);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('kolibri:new-task', openQuickAdd);
    };
  }, [navigate]);

  const workspaceItems: MenuItem[] = [
    ...(session?.workspaces ?? []).map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      hint: workspace.id === workspaceId ? '✓' : workspace.role,
      onSelect: () => setWorkspace(workspace.id),
    })),
    { id: 'new', section: t('nav.workspaces'), label: t('nav.newWorkspace'), icon: <Icon name="plus" size={14} />, onSelect: () => navigate('/settings/workspaces') },
  ];

  const accountItems: MenuItem[] = [
    { id: 'guide', label: t('nav.guide'), icon: <Icon name="help" size={14} />, onSelect: () => navigate('/guide') },
    { id: 'profile', label: t('nav.settings'), icon: <Icon name="settings" size={14} />, onSelect: () => navigate('/settings') },
    {
      id: 'theme',
      label: t('nav.theme', { theme: t(THEME_KEY[theme]) }),
      icon: <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={14} />,
      onSelect: () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'),
    },
    { id: 'signout', label: t('nav.signOut'), icon: <Icon name="logout" size={14} />, danger: true, onSelect: () => void signOut() },
  ];

  return (
    <div className="shell">
      {/* Labelled, because a second `<aside>` appears on the chat screen and a
          rotor listing "complementary" twice tells nobody which is which. */}
      <aside className="sidebar" aria-label={t('nav.sidebar')}>
        <MenuButton items={workspaceItems} className={navItem()} title={t('nav.switchWorkspace')}>
          <img src="/icon.svg" alt="" width={20} height={20} style={{ borderRadius: 5 }} />
          <span className="flex-1 min-w-0 truncate font-semibold">
            {session?.workspaces.find((w) => w.id === workspaceId)?.name ?? t('app.name')}
          </span>
          <Icon name="chevronDown" size={14} />
        </MenuButton>

        {canWrite && (
          <Button variant="primary" style={{ margin: '6px 4px 10px' }} onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} /> {t('nav.newTask')}
          </Button>
        )}

        <Item to="/" icon="home" count={myOpen}>{t('nav.myWork')}</Item>
        <Item to="/inbox" icon="inbox" count={unread}>{t('nav.inbox')}</Item>
        <Item to="/search" icon="search">{t('nav.search')}</Item>
        {/* From `lib/nav.ts`, which the More screen renders too — see the note
            there about the screens a phone could not reach. */}
        {enabled(WORKSPACE_DESTINATIONS, has).map((item) => (
          <Item key={item.to} to={item.to} icon={item.icon} count={item.to === '/chat' ? unreadMessages : undefined}>
            {t(item.label)}
          </Item>
        ))}

        <div className="nav-section">
          {t('nav.projects')}
          <Button variant="ghost" size="iconSm" onClick={() => navigate('/projects/new')} title={t('nav.newProject')}>
            <Icon name="plus" size={13} />
          </Button>
        </div>
        {nested.map(({ project, depth, hasChildren }) => (
          <ProjectRow
            key={project.id}
            project={project}
            depth={depth}
            hasChildren={hasChildren}
            collapsed={collapsed.has(project.id)}
            onToggle={() => toggleCollapsed(project.id)}
            canWrite={canWrite}
            dropping={dropTarget === project.id}
            onDragStart={() => setDragging(project.id)}
            onDragEnd={() => { setDragging(null); setDropTarget(null); }}
            onDragOver={() => setDropTarget(project.id)}
            onDrop={() => reparent(project.id)}
            onTaskDrop={(taskId) => { setDropTarget(null); refile(taskId, project.id); }}
            dragging={dragging === project.id}
          />
        ))}
        {/* The only way to say "no parent" with a pointer. A row is a project,
            so dropping onto one nests; this strip is the outdent, and it only
            appears while something is actually being dragged. */}
        {dragging && (
          <div
            className={`nav-root-drop${dropTarget === '' ? ' over' : ''}`}
            /* Projects only. "Move to the top" is a thing a project can be and
               a task cannot — a task always belongs to one. */
            onDragOver={(event) => {
              if (!isDrag(event, PROJECT_DRAG)) return;
              event.preventDefault();
              setDropTarget('');
            }}
            onDrop={(event) => {
              if (!isDrag(event, PROJECT_DRAG)) return;
              event.preventDefault();
              reparent(null);
            }}
          >
            {t('nav.moveToTop')}
          </div>
        )}
        {projects.length > 1 && (
          <NavLink to="/portfolio" className={navItem()}>
            <Icon name="target" size={15} />
            <span className="flex-1 min-w-0 truncate">{t('nav.portfolio')}</span>
          </NavLink>
        )}
        {enabled(PLANNING_DESTINATIONS, has).map((item) => (
          <NavLink key={item.to} to={item.to} className={navItem()}>
            <Icon name={item.icon} size={15} />
            <span className="flex-1 min-w-0 truncate">{t(item.label)}</span>
          </NavLink>
        ))}
        {!projects.length && (
          <button className={navItem()} onClick={() => navigate('/projects/new')}>
            <Icon name="plus" size={15} /> {t('nav.firstProject')}
          </button>
        )}

        <div className="flex-1 min-w-0" />
        <div className="my-2 h-px bg-line" />
        <MenuButton items={accountItems} className={navItem()}>
          <Avatar user={user ?? undefined} size={22} />
          <span className="flex-1 min-w-0 truncate">{user?.name ?? t('nav.account')}</span>
          <Icon name="dots" size={14} />
        </MenuButton>
      </aside>

      <div className="main">
        {/* A real landmark rather than a styled `div`. "Skip to content" and
            every screen reader's jump-to-main both need something to aim at,
            and `.main` was only ever a class name. */}
        <main className="content" id="content">{children}</main>
        {/*
          * The bar's own words, not the sidebar's.
          *
          * A column in a sidebar can afford "Meine Aufgaben"; a sixth of a
          * 390px phone cannot, and it wrapped to two lines — which stretched
          * every other item to match and left the labels sitting at different
          * heights. `nav.bar.*` are the short forms, so the constraint is
          * something a translator can see rather than something they discover.
          */}
        <nav className="tabbar" aria-label={t('nav.tabbar')}>
          <NavLink to="/" end>
            <Icon name="home" size={20} />
            <span className="tab-label">{t('nav.bar.myWork')}</span>
          </NavLink>
          <NavLink to="/inbox">
            <Icon name="inbox" size={20} />
            {/* Out of the flow, or it pushes the label down and this one item
                stands a few pixels lower than the five beside it. */}
            {unread > 0 && <span className="badge-dot size-1.5 rounded-full bg-accent" />}
            <span className="tab-label">{t('nav.bar.inbox')}</span>
          </NavLink>
          {/* Beside the inbox, because they are the two surfaces other people
              write to. It was behind "More" — the one part of this app that is
              answered in seconds, filed under the menu you open last, on the
              device most likely to be the only one somebody has. */}
          <NavLink to="/chat">
            <Icon name="chat" size={20} />
            {unreadMessages > 0 && <span className="badge-dot size-1.5 rounded-full bg-accent" />}
            <span className="tab-label">{t('nav.bar.chat')}</span>
          </NavLink>
          <button
            className={navItem()} style={{ width: 'auto', justifyContent: 'center' }}
            onClick={() => setAdding(true)} aria-label={t('nav.newTask')}
            hidden={!canWrite}
          >
            <span style={{ background: 'var(--accent)', color: 'var(--accent-fg)', width: 34, height: 34, borderRadius: 12, display: 'grid', placeItems: 'center' }}>
              <Icon name="plus" size={19} />
            </span>
          </button>
          <NavLink to="/search">
            <Icon name="search" size={20} />
            <span className="tab-label">{t('nav.bar.search')}</span>
          </NavLink>
          <NavLink to="/more">
            <Icon name="menu" size={20} />
            <span className="tab-label">{t('nav.bar.more')}</span>
          </NavLink>
        </nav>
      </div>

      {/* The board's own button always knew which project it was on. This one —
          the keyboard shortcut, the phone's +, the header button — did not, and
          fell back to whichever project was used last. It reads the address bar
          now, and still falls back to the last one from a screen that is not
          about a project. */}
      {adding && <QuickAdd projectId={activeProject} onClose={() => setAdding(false)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

/**
 * One project in the sidebar.
 *
 * Three things a flat `NavLink` could not do, and all three are what the
 * complaint was about: fold a branch, drag a project under another, and reach
 * "new sub-project" without going through a settings page.
 *
 * The chevron sits in the same 16px slot whether or not there is anything to
 * fold, so a project with children and one without line up — a tree whose rows
 * shift sideways by the width of a chevron reads as two lists.
 */
function ProjectRow({
  project, depth, hasChildren, collapsed, onToggle, canWrite,
  dragging, dropping, onDragStart, onDragEnd, onDragOver, onDrop, onTaskDrop,
}: {
  project: { id: string; name: string; icon?: string | null; is_container?: number };
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  canWrite: boolean;
  dragging: boolean;
  dropping: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  /** A task was let go over this row. */
  onTaskDrop: (taskId: string) => void;
}) {
  const t = useT();
  const navigate = useNavigate();

  return (
    <div
      className={`nav-project${dropping ? ' drop-into' : ''}${dragging ? ' dragging' : ''}`}
      style={{ paddingInlineStart: depth * 13 }}
      draggable={canWrite}
      onDragStart={(event) => {
        startDrag(event, PROJECT_DRAG, project.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      /* Two kinds of thing can land here and they mean different things, so the
         row says which it will take before it takes it: `preventDefault` is
         what turns the cursor into a drop cursor, and skipping it is the only
         way to say no. A container holds projects, not tasks, and the row is
         allowed to refuse a task on that ground alone. */
      onDragOver={(event) => {
        if (isDrag(event, TASK_DRAG)) {
          if (!canWrite || project.is_container) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          onDragOver();
          return;
        }
        if (!isDrag(event, PROJECT_DRAG)) return;
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        if (isDrag(event, TASK_DRAG)) {
          event.preventDefault();
          onTaskDrop(idFrom(event, TASK_DRAG));
          return;
        }
        if (!isDrag(event, PROJECT_DRAG)) return;
        event.preventDefault();
        onDrop();
      }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="nav-twist"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('nav.expand', { name: project.name }) : t('nav.collapse', { name: project.name })}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={13} />
        </button>
      ) : (
        <span className="nav-twist" aria-hidden="true" />
      )}

      <NavLink to={`/projects/${project.id}`} className={navItem()}>
        <span style={{ width: 16, textAlign: 'center' }}>{project.icon ?? '•'}</span>
        <span className="flex-1 min-w-0 truncate">{project.name}</span>
      </NavLink>

      {canWrite && (
        <MenuButton
          className="nav-project-menu"
          variant="ghost"
          size="iconSm"
          label={t('common.moreActions')}
          items={[
            {
              id: 'sub',
              label: t('project.newSub'),
              icon: <Icon name="plus" size={13} />,
              onSelect: () => navigate(`/projects/new?parent=${project.id}`),
            },
            {
              id: 'settings',
              label: t('nav.projectSettings'),
              icon: <Icon name="settings" size={13} />,
              onSelect: () => navigate(`/projects/${project.id}?tab=settings`),
            },
          ]}
        >
          <Icon name="dots" size={13} />
        </MenuButton>
      )}
    </div>
  );
}

/** Page header used by every route. */
export function Header({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="header">
      {/* `min-w-[72px]`, not `min-w-0`: the header scrolls sideways rather than
          squeezing, so a title that may shrink to nothing shrinks to nothing —
          which is what it did, leaving a screen with no name on it. */}
      <h1 className="flex-1 min-w-[72px] truncate">{title}</h1>
      {children}
      <SyncPill />
    </header>
  );
}

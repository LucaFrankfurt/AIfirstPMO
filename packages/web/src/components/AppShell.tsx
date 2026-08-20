import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, type NavLinkProps } from 'react-router-dom';
import { list, useQuery } from '../lib/store';
import { pull, subscribeSync, type SyncStatus } from '../lib/sync';
import { useCanWrite, useMe, useSession } from '../session';
import { currentLocale, useT, type TranslationKey } from '../lib/i18n';
import { Avatar, Icon, MenuButton, type MenuItem } from './ui';
import { QuickAdd } from './QuickAdd';
import { CommandPalette } from './CommandPalette';
import { Button } from '../components/ui/button';
import { navCount, navItem } from './ui/nav';
import { chipDot } from './ui/chip';
import { useUnreadMessages } from '../routes/chat';

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
      title={status.message ?? (status.lastSyncedAt
        ? t('sync.lastSynced', { time: new Date(status.lastSyncedAt).toLocaleTimeString(currentLocale()) })
        : t('sync.now'))}
    >
      <span className={chipDot} />
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
  const canWrite = useCanWrite();
  const [palette, setPalette] = useState(false);

  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );
  // Sub-projects sit under their parent, and a project whose parent is archived
  // or invisible comes back to the top rather than disappearing with it.
  const nested = useMemo(() => {
    const known = new Set(projects.map((project) => project.id));
    const children = new Map<string | null, typeof projects>();
    for (const project of projects) {
      const parent = project.parent_id && known.has(project.parent_id) ? project.parent_id : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(project);
    }
    const out: { project: (typeof projects)[number]; depth: number }[] = [];
    const walk = (parent: string | null, depth: number): void => {
      for (const project of children.get(parent) ?? []) {
        out.push({ project, depth });
        if (depth < 3) walk(project.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [projects]);
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
      <aside className="sidebar">
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
        <Item to="/chat" icon="chat" count={unreadMessages}>{t('nav.chat')}</Item>
        <Item to="/pages" icon="page">{t('nav.pages')}</Item>
        <Item to="/teams" icon="users">{t('nav.teams')}</Item>
        <Item to="/guide" icon="help">{t('nav.guide')}</Item>

        <div className="nav-section">
          {t('nav.projects')}
          <Button variant="ghost" size="iconSm" onClick={() => navigate('/projects/new')} title={t('nav.newProject')}>
            <Icon name="plus" size={13} />
          </Button>
        </div>
        {nested.map(({ project, depth }) => (
          <NavLink
            key={project.id} to={`/projects/${project.id}`} className={navItem()}
            style={depth ? { paddingInlineStart: 10 + depth * 13 } : undefined}
          >
            <span style={{ width: 16, textAlign: 'center' }}>{project.icon ?? '•'}</span>
            <span className="flex-1 min-w-0 truncate">{project.name}</span>
          </NavLink>
        ))}
        {projects.length > 1 && (
          <NavLink to="/portfolio" className={navItem()}>
            <Icon name="target" size={15} />
            <span className="flex-1 min-w-0 truncate">{t('nav.portfolio')}</span>
          </NavLink>
        )}
        <NavLink to="/planner" className={navItem()}>
          <Icon name="users" size={15} />
          <span className="flex-1 min-w-0 truncate">{t('nav.planner')}</span>
        </NavLink>
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
        <div className="content">{children}</div>
        <nav className="tabbar">
          <NavLink to="/" end><Icon name="home" size={20} />{t('nav.myWork')}</NavLink>
          <NavLink to="/inbox">
            <Icon name="inbox" size={20} />
            {unread > 0 && <span className="size-1.5 flex-none rounded-full bg-accent" />}
            {t('nav.inbox')}
          </NavLink>
          <button
            className={navItem()} style={{ width: 'auto', justifyContent: 'center' }}
            onClick={() => setAdding(true)} aria-label={t('nav.newTask')}
            hidden={!canWrite}
          >
            <span style={{ background: 'var(--accent)', color: '#fff', width: 34, height: 34, borderRadius: 12, display: 'grid', placeItems: 'center' }}>
              <Icon name="plus" size={19} />
            </span>
          </button>
          <NavLink to="/search"><Icon name="search" size={20} />{t('nav.search')}</NavLink>
          <NavLink to="/more"><Icon name="menu" size={20} />{t('nav.more')}</NavLink>
        </nav>
      </div>

      {adding && <QuickAdd onClose={() => setAdding(false)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
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

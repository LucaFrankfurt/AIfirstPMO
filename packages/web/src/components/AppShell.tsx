import { useEffect, useState } from 'react';
import { NavLink, useNavigate, type NavLinkProps } from 'react-router-dom';
import { list, useQuery } from '../lib/store';
import { pull, subscribeSync, type SyncStatus } from '../lib/sync';
import { useMe, useSession } from '../session';
import { Avatar, Icon, MenuButton, type MenuItem } from './ui';
import { QuickAdd } from './QuickAdd';
import { CommandPalette } from './CommandPalette';

/* ------------------------------------------------------------ sync status */

function SyncPill() {
  const [status, setStatus] = useState<SyncStatus>({ state: 'starting', pending: 0, lastSyncedAt: null });
  useEffect(() => subscribeSync(setStatus), []);

  const label =
    status.state === 'offline' ? (status.pending ? `Offline · ${status.pending} queued` : 'Offline')
      : status.state === 'error' ? 'Sync issue'
        : status.pending ? `Syncing ${status.pending}`
          : 'Synced';

  return (
    <button
      className={`status-pill ${status.state}`}
      onClick={() => void pull()}
      title={status.message ?? (status.lastSyncedAt ? `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : 'Sync now')}
    >
      <span className="dot" />
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

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('kolibri.theme') as Theme) ?? 'system');
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, setTheme];
}

/* ------------------------------------------------------------------ shell */

const Item = ({ to, icon, children, count }: { to: string; icon: string; children: React.ReactNode; count?: number } & Partial<NavLinkProps>) => (
  <NavLink to={to} className="nav-item" end={to === '/'}>
    <Icon name={icon} size={16} />
    <span className="grow truncate">{children}</span>
    {count ? <span className="count">{count}</span> : null}
  </NavLink>
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, workspaceId, setWorkspace, signOut, user } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [adding, setAdding] = useState(false);
  const [palette, setPalette] = useState(false);

  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );
  const unread = useQuery(() => list('notification', (n) => n.user_id === me && !n.read_at).length, [me]);
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
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const workspaceItems: MenuItem[] = [
    ...(session?.workspaces ?? []).map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      hint: workspace.id === workspaceId ? '✓' : workspace.role,
      onSelect: () => setWorkspace(workspace.id),
    })),
    { id: 'new', section: 'More', label: 'New workspace…', icon: <Icon name="plus" size={14} />, onSelect: () => navigate('/settings/workspaces') },
  ];

  const accountItems: MenuItem[] = [
    { id: 'profile', label: 'Settings', icon: <Icon name="settings" size={14} />, onSelect: () => navigate('/settings') },
    {
      id: 'theme',
      label: `Theme: ${theme}`,
      icon: <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={14} />,
      onSelect: () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'),
    },
    { id: 'signout', label: 'Sign out', icon: <Icon name="logout" size={14} />, danger: true, onSelect: () => void signOut() },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <MenuButton items={workspaceItems} className="nav-item" title="Switch workspace">
          <img src="/icon.svg" alt="" width={20} height={20} style={{ borderRadius: 5 }} />
          <span className="grow truncate" style={{ fontWeight: 600 }}>
            {session?.workspaces.find((w) => w.id === workspaceId)?.name ?? 'Kolibri'}
          </span>
          <Icon name="chevronDown" size={14} />
        </MenuButton>

        <button className="btn primary" style={{ margin: '6px 4px 10px' }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> New task
        </button>

        <Item to="/" icon="home" count={myOpen}>My work</Item>
        <Item to="/inbox" icon="inbox" count={unread}>Inbox</Item>
        <Item to="/search" icon="search">Search</Item>
        <Item to="/pages" icon="page">Pages</Item>
        <Item to="/teams" icon="users">Teams</Item>

        <div className="nav-section">
          Projects
          <button className="btn ghost sm icon" onClick={() => navigate('/projects/new')} title="New project">
            <Icon name="plus" size={13} />
          </button>
        </div>
        {projects.map((project) => (
          <NavLink key={project.id} to={`/projects/${project.id}`} className="nav-item">
            <span style={{ width: 16, textAlign: 'center' }}>{project.icon ?? '•'}</span>
            <span className="grow truncate">{project.name}</span>
          </NavLink>
        ))}
        {!projects.length && (
          <button className="nav-item" onClick={() => navigate('/projects/new')}>
            <Icon name="plus" size={15} /> Create your first project
          </button>
        )}

        <div className="grow" />
        <div className="divider" />
        <MenuButton items={accountItems} className="nav-item">
          <Avatar user={user ?? undefined} size={22} />
          <span className="grow truncate">{user?.name ?? 'Account'}</span>
          <Icon name="dots" size={14} />
        </MenuButton>
      </aside>

      <div className="main">
        <div className="content">{children}</div>
        <nav className="tabbar">
          <NavLink to="/" end><Icon name="home" size={20} />My work</NavLink>
          <NavLink to="/inbox">
            <Icon name="inbox" size={20} />
            {unread > 0 && <span className="badge-dot" />}
            Inbox
          </NavLink>
          <button className="nav-item" style={{ width: 'auto', justifyContent: 'center' }} onClick={() => setAdding(true)} aria-label="New task">
            <span style={{ background: 'var(--accent)', color: '#fff', width: 34, height: 34, borderRadius: 12, display: 'grid', placeItems: 'center' }}>
              <Icon name="plus" size={19} />
            </span>
          </button>
          <NavLink to="/search"><Icon name="search" size={20} />Search</NavLink>
          <NavLink to="/more"><Icon name="menu" size={20} />More</NavLink>
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
      <h1 className="grow truncate">{title}</h1>
      {children}
      <SyncPill />
    </header>
  );
}

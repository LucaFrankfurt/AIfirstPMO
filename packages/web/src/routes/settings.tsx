import { useEffect, useState } from 'react';
import { Header, useTheme } from '../components/AppShell';
import { Avatar, Empty, Icon, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useSession } from '../session';

type Tab = 'profile' | 'notifications' | 'workspace' | 'members' | 'api' | 'data';

export function Settings() {
  const [tab, setTab] = useState<Tab>('profile');
  return (
    <>
      <Header title="Settings" />
      <div className="tabs" style={{ padding: '0 12px' }}>
        {(['profile', 'notifications', 'workspace', 'members', 'api', 'data'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {name === 'api' ? 'API & MCP' : name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      <div className="page" style={{ maxWidth: 680 }}>
        {tab === 'profile' && <Profile />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'workspace' && <WorkspaceSettings />}
        {tab === 'members' && <Members />}
        {tab === 'api' && <ApiSettings />}
        {tab === 'data' && <DataSettings />}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- profile */

function Profile() {
  const { user, refresh } = useSession();
  const [theme, setTheme] = useTheme();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [passwords, setPasswords] = useState({ current: '', next: '' });

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <Avatar user={user ?? undefined} size={48} />
        <div>
          <strong>{user?.name}</strong>
          <div className="muted" style={{ fontSize: 12.5 }}>{user?.email}</div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="me-name">Display name</label>
        <input id="me-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="me-bio">Bio</label>
        <textarea id="me-bio" className="textarea" style={{ minHeight: 70 }} value={bio ?? ''} onChange={(event) => setBio(event.target.value)} />
      </div>
      <button
        className="btn primary"
        onClick={async () => {
          await api.patch('/api/me', { name, bio });
          await refresh();
          toast('Profile saved');
        }}
      >
        Save profile
      </button>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>Appearance</h3>
      <div className="row" style={{ gap: 6 }}>
        {(['system', 'light', 'dark'] as const).map((option) => (
          <button
            key={option}
            className={`btn sm${theme === option ? ' primary' : ''}`}
            onClick={() => setTheme(option)}
          >
            <Icon name={option === 'dark' ? 'moon' : option === 'light' ? 'sun' : 'settings'} size={14} />
            {option}
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>Password</h3>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          className="input" type="password" placeholder="Current password" autoComplete="current-password"
          style={{ maxWidth: 220 }} value={passwords.current}
          onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
        />
        <input
          className="input" type="password" placeholder="New password" autoComplete="new-password"
          style={{ maxWidth: 220 }} value={passwords.next}
          onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
        />
        <button
          className="btn"
          disabled={passwords.next.length < 8}
          onClick={async () => {
            try {
              await api.post('/api/me/password', passwords);
              setPasswords({ current: '', next: '' });
              toast('Password changed — other devices were signed out');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not change the password');
            }
          }}
        >
          Change password
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------------- notifications */

interface MailStatus {
  enabled: boolean;
  /** 'test-inbox' means a capture tool — delivered, but nobody receives it. */
  mode: 'off' | 'relay' | 'test-inbox';
  host: string | null;
  from: string;
  batchSeconds: number;
  pending: number;
  preference: 'all' | 'important' | 'none';
}

const PREFERENCES: { value: MailStatus['preference']; label: string; hint: string }[] = [
  { value: 'all', label: 'Everything', hint: 'Assignments, mentions and comments on work you follow' },
  { value: 'important', label: 'Only what needs me', hint: 'Assignments and mentions' },
  { value: 'none', label: 'Nothing', hint: 'In-app inbox only' },
];

const batchWindow = (seconds: number): string => {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
};

function Notifications() {
  const toast = useToast();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<MailStatus>('/api/mail/status').then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    load();
  }, []);

  const choose = async (preference: MailStatus['preference']) => {
    setStatus((current) => (current ? { ...current, preference } : current));
    await api.patch('/api/me', { email_prefs: preference });
    toast('Notification settings saved');
  };

  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>
        Everything always lands in your in-app inbox. Email is an extra: updates are collected for{' '}
        {batchWindow(status?.batchSeconds ?? 120)} and sent as a single message, so a busy afternoon
        does not become twenty separate mails.
      </p>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>Email me about</h3>
      <div className="col" style={{ gap: 6 }}>
        {PREFERENCES.map((option) => (
          <button
            key={option.value}
            className="card"
            style={{
              textAlign: 'left',
              borderColor: status?.preference === option.value ? 'var(--accent)' : 'var(--line)',
              cursor: 'pointer',
            }}
            onClick={() => void choose(option.value)}
          >
            <div className="row">
              <strong className="grow">{option.label}</strong>
              {status?.preference === option.value && <Icon name="check" size={15} />}
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>{option.hint}</span>
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>Delivery</h3>
      {status?.mode === 'test-inbox' && (
        <div
          className="card"
          style={{ marginBottom: 10, borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <div className="row" style={{ gap: 7, marginBottom: 4 }}>
            <Icon name="bell" size={15} />
            <strong>This is a capture inbox, not a mail server</strong>
          </div>
          <span className="soft" style={{ fontSize: 12.5 }}>
            Messages are accepted by <span className="mono">{status.host}</span> and stop there — no
            recipient ever gets them. Read them in the local inbox (Mailpit, usually on port 8025),
            and set <span className="mono">KOLIBRI_SMTP_URL</span> to a real relay before this
            instance is used for actual work.
          </span>
        </div>
      )}
      {status?.enabled ? (
        <>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="row">
              <span className="grow">Relay</span>
              <strong className="mono">{status.host}</strong>
              {status.mode === 'test-inbox' && <span className="chip" style={{ color: 'var(--warn)' }}>capture</span>}
            </div>
            <div className="row"><span className="grow">Sender</span><strong className="mono">{status.from}</strong></div>
            <div className="row"><span className="grow">Waiting in the queue</span><strong>{status.pending}</strong></div>
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.post<{ to: string }>('/api/mail/test');
                toast(`Test email sent to ${result.to}`);
              } catch (err) {
                toast(err instanceof Error ? err.message : 'The relay refused the message');
              } finally {
                setBusy(false);
                load();
              }
            }}
          >
            <Icon name="send" size={14} /> Send a test email
          </button>
        </>
      ) : (
        <Empty
          emoji="✉️"
          title="No mail relay configured"
          hint="This instance sends nothing by email — notifications stay in the in-app inbox, which is the source of truth anyway. Set KOLIBRI_SMTP_URL to a relay and restart to turn delivery on."
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- workspace */

function WorkspaceSettings() {
  const { session, workspaceId, role, refresh, setWorkspace } = useSession();
  const toast = useToast();
  const workspace = session?.workspaces.find((w) => w.id === workspaceId);
  const [name, setName] = useState(workspace?.name ?? '');
  const [creating, setCreating] = useState('');

  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  const canEdit = role === 'owner' || role === 'admin';

  return (
    <>
      <div className="field">
        <label htmlFor="ws-name">Workspace name</label>
        <input id="ws-name" className="input" value={name} disabled={!canEdit} onChange={(event) => setName(event.target.value)} />
        {!canEdit && <span className="hint">Only admins can rename the workspace.</span>}
      </div>
      <button
        className="btn primary" disabled={!canEdit}
        onClick={async () => {
          await api.patch(`/api/workspaces/${workspaceId}`, { name });
          await refresh();
          toast('Workspace updated');
        }}
      >
        Save
      </button>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>Your workspaces</h3>
      {session?.workspaces.map((entry) => (
        <div className="row" key={entry.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <span className="grow">{entry.name}</span>
          <span className="chip">{entry.role}</span>
          {entry.id !== workspaceId && <button className="btn sm" onClick={() => setWorkspace(entry.id)}>Switch</button>}
        </div>
      ))}

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>New workspace</h3>
      <div className="row">
        <input className="input" placeholder="Name" value={creating} onChange={(event) => setCreating(event.target.value)} />
        <button
          className="btn"
          disabled={!creating.trim()}
          onClick={async () => {
            const result = await api.post<any>('/api/workspaces', { name: creating });
            setCreating('');
            await refresh();
            setWorkspace(result.workspace.id);
            toast('Workspace created');
          }}
        >
          Create
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- members */

function Members() {
  const { workspaceId, role } = useSession();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [members, setMembers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const canManage = role === 'owner' || role === 'admin';

  const load = () => {
    api.members(workspaceId).then(setMembers).catch(() => setMembers([]));
    if (canManage) api.invites(workspaceId).then(setInvites).catch(() => setInvites([]));
  };
  useEffect(() => {
    load();
  }, [workspaceId, canManage]);

  return (
    <>
      {members.map((member) => (
        <div className="row" key={member.user_id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
          <Avatar user={{ id: member.user_id, name: member.name, avatar_url: member.avatar_url }} size={30} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate">{member.name}</div>
            <div className="muted truncate" style={{ fontSize: 12 }}>{member.email}</div>
          </div>
          {member.last_seen_at && <span className="muted" style={{ fontSize: 11.5 }}>{relativeTime(member.last_seen_at)}</span>}
          {canManage ? (
            <select
              className="select" style={{ width: 110 }} value={member.role}
              onChange={async (event) => {
                await api.patch(`/api/workspaces/${workspaceId}/members/${member.user_id}`, { role: event.target.value });
                load();
              }}
            >
              {['owner', 'admin', 'member', 'guest'].map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <span className="chip">{member.role}</span>
          )}
          {canManage && (
            <button
              className="btn ghost sm icon"
              onClick={async () => {
                if (!(await confirm(`Remove ${member.name} from this workspace?`, 'Remove'))) return;
                await api.delete(`/api/workspaces/${workspaceId}/members/${member.user_id}`);
                load();
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      ))}

      {canManage && (
        <>
          <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>Invites</h3>
          <button
            className="btn"
            onClick={async () => {
              const invite = await api.createInvite(workspaceId, 'member');
              await navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
              toast('Invite link copied to clipboard');
              load();
            }}
          >
            <Icon name="link" size={14} /> Create invite link
          </button>
          {invites.map((invite) => (
            <div className="row" key={invite.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <code className="mono grow truncate">{location.origin}/invite/{invite.code}</code>
              <span className="chip">{invite.role}</span>
              <button
                className="btn ghost sm icon"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
                  toast('Copied');
                }}
              >
                <Icon name="copy" size={14} />
              </button>
            </div>
          ))}
        </>
      )}
      {dialog}
    </>
  );
}

/* ------------------------------------------------------------- api + mcp */

function ApiSettings() {
  const { workspaceId } = useSession();
  const toast = useToast();
  const [tokens, setTokens] = useState<any[]>([]);
  const [name, setName] = useState('Claude');
  const [created, setCreated] = useState<string | null>(null);

  const load = () => api.tokens().then(setTokens).catch(() => setTokens([]));
  useEffect(() => {
    load();
  }, []);

  const snippet = `{
  "mcpServers": {
    "kolibri": {
      "command": "npx",
      "args": ["-y", "@kolibri/mcp"],
      "env": {
        "KOLIBRI_URL": "${location.origin}",
        "KOLIBRI_TOKEN": "${created ?? 'kol_your_token_here'}"
      }
    }
  }
}`;

  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>
        Kolibri speaks the Model Context Protocol. Point an assistant at this instance and it can read the backlog,
        file tasks, move them through the workflow and write pages — with the same permissions as the token owner.
      </p>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>API tokens</h3>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input" placeholder="Token name" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="btn primary"
          onClick={async () => {
            const token = await api.createToken({ name, workspaceId });
            setCreated(token.token);
            load();
          }}
        >
          <Icon name="plus" size={14} /> Create
        </button>
      </div>

      {tokens.map((token) => (
        <div className="row" key={token.id} style={{ padding: '7px 0', borderTop: '1px solid var(--line)' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate">{token.name}</div>
            <div className="muted mono truncate">{token.prefix}… · {token.scopes}</div>
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {token.last_used_at ? `used ${relativeTime(token.last_used_at)}` : 'never used'}
          </span>
          <button
            className="btn ghost sm icon"
            onClick={async () => {
              await api.revokeToken(token.id);
              load();
              toast('Token revoked');
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {!tokens.length && <span className="muted" style={{ fontSize: 12.5 }}>No tokens yet.</span>}

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>Connect an MCP client</h3>
      <pre className="md" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', padding: 12, borderRadius: 10, overflowX: 'auto', fontSize: 12 }}>
        {snippet}
      </pre>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(snippet); toast('Config copied'); }}>
          <Icon name="copy" size={14} /> Copy config
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Or point a streamable-HTTP client straight at <code className="mono">{location.origin}/mcp</code>.
        </span>
      </div>

      {created && (
        <Sheet title="Copy your token now" onClose={() => setCreated(null)}>
          <p className="muted">This is the only time the token is shown. Store it somewhere safe.</p>
          <code className="mono" style={{ display: 'block', wordBreak: 'break-all', background: 'var(--bg-sunken)', padding: 12, borderRadius: 8 }}>
            {created}
          </code>
          <button
            className="btn primary block" style={{ marginTop: 12 }}
            onClick={() => { void navigator.clipboard?.writeText(created); toast('Token copied'); }}
          >
            <Icon name="copy" size={14} /> Copy token
          </button>
        </Sheet>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ data */

function DataSettings() {
  const { signOut } = useSession();
  const toast = useToast();
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    navigator.storage?.estimate?.().then(setEstimate).catch(() => undefined);
    navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined);
  }, []);

  const mb = (value?: number) => (value ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—');

  return (
    <>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>Offline copy</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        This device keeps a full copy of the workspace in IndexedDB. Changes you make offline are queued and
        merged field by field when you come back online, so nobody's edits get overwritten wholesale.
      </p>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row"><span className="grow">Local data</span><strong>{mb(estimate?.usage)}</strong></div>
        <div className="row"><span className="grow">Available</span><strong>{mb(estimate?.quota)}</strong></div>
        <div className="row"><span className="grow">Storage persisted</span><strong>{persisted === null ? '—' : persisted ? 'Yes' : 'Best effort'}</strong></div>
      </div>

      <div className="row wrap">
        <button
          className="btn"
          onClick={async () => {
            const registration = await navigator.serviceWorker?.getRegistration();
            await registration?.update();
            toast('Checked for updates');
          }}
        >
          <Icon name="refresh" size={14} /> Check for app update
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            await signOut();
            toast('Local copy cleared');
          }}
        >
          <Icon name="logout" size={14} /> Sign out and clear this device
        </button>
      </div>

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>Export</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Everything is plain data. <code className="mono">GET /api/workspaces/&lt;id&gt;/tasks</code> and its siblings
        return JSON for any collection, and the SQLite file under <code className="mono">/data</code> is yours to copy.
      </p>
      {!estimate && <Empty emoji="💾" title="Storage information unavailable" hint="Your browser does not expose quota details." />}
    </>
  );
}

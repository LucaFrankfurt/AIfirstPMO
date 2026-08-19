import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header, THEME_KEY, useTheme } from '../components/AppShell';
import { Avatar, Empty, GuideHint, Icon, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useSession } from '../session';
import { AutomationSettings } from './automation';
import { Trash } from '../components/trash';
import { AuditLog, Webhooks } from '../components/admin';
import { Sessions, TwoFactor } from '../components/security';
import { downscale } from '../components/Markdown';
import { LOCALE_NAMES, roleKey, useI18n, useT, type Locale, type TranslationKey, type Translate } from '../lib/i18n';
import { PushToggle } from '../components/push';

type Tab = 'profile' | 'notifications' | 'workspace' | 'members' | 'automation' | 'api' | 'data';

const TAB_KEY: Record<Tab, TranslationKey> = {
  profile: 'settings.tabProfile', notifications: 'settings.tabNotifications',
  workspace: 'settings.tabWorkspace', members: 'settings.tabMembers',
  automation: 'settings.tabAutomation', api: 'settings.tabApi', data: 'settings.tabData',
};

const ROLES = ['owner', 'admin', 'member', 'guest'] as const;

export function Settings() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  // `?tab=members` so the setup checklist can point at the screen it names.
  const requested = params.get('tab');
  const [tab, setTab] = useState<Tab>(() => (requested && requested in TAB_KEY ? requested as Tab : 'profile'));

  const choose = (next: Tab) => {
    setTab(next);
    setParams(next === 'profile' ? {} : { tab: next }, { replace: true });
  };
  return (
    <>
      <Header title={t('settings.title')} />
      <div className="tabs" style={{ padding: '0 12px' }}>
        {(Object.keys(TAB_KEY) as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => choose(name)}>
            {t(TAB_KEY[name])}
          </button>
        ))}
      </div>
      <div className="page" style={{ maxWidth: 680 }}>
        {tab === 'profile' && <Profile />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'workspace' && <WorkspaceSettings />}
        {tab === 'members' && <Members />}
        {tab === 'automation' && <AutomationSettings />}
        {tab === 'api' && <ApiSettings />}
        {tab === 'data' && <DataSettings />}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- profile */

function Profile() {
  const { t, locale, setLocale } = useI18n();
  const { user, refresh, workspaceId } = useSession();
  const [theme, setTheme] = useTheme();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [uploading, setUploading] = useState(false);

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <Avatar user={user ?? undefined} size={48} />
        <div className="grow">
          <strong>{user?.name}</strong>
          <div className="muted" style={{ fontSize: 12.5 }}>{user?.email}</div>
        </div>
        <label className="btn sm">
          {uploading ? t('editor.uploading') : t('profile.changePicture')}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file || !workspaceId) return;
              setUploading(true);
              try {
                // Through the same downscale as an inline image: a 4 MB photo
                // as a 24px avatar is bytes nobody asked for.
                const result = await api.upload(workspaceId, await downscale(file, 256), file.name);
                await api.patch('/api/me', { avatar_url: result.url });
                await refresh();
                toast(t('profile.pictureChanged'));
              } catch (error) {
                toast(error instanceof Error ? error.message : String(error));
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        {user?.avatar_url && (
          <button
            className="btn ghost sm"
            onClick={async () => {
              await api.patch('/api/me', { avatar_url: null });
              await refresh();
            }}
          >
            {t('profile.removePicture')}
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor="me-name">{t('profile.displayName')}</label>
        <input id="me-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="me-bio">{t('profile.bio')}</label>
        <textarea id="me-bio" className="textarea" style={{ minHeight: 70 }} value={bio ?? ''} onChange={(event) => setBio(event.target.value)} />
      </div>
      <button
        className="btn primary"
        onClick={async () => {
          await api.patch('/api/me', { name, bio });
          await refresh();
          toast(t('profile.saved'));
        }}
      >
        {t('profile.save')}
      </button>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('profile.language')}</h3>
      <select
        className="select"
        style={{ maxWidth: 220 }}
        value={locale}
        aria-label={t('profile.language')}
        onChange={async (event) => {
          const next = event.target.value as Locale;
          setLocale(next);
          // The server needs it too: notification emails are written per recipient.
          await api.patch('/api/me', { locale: next }).catch(() => undefined);
          await refresh();
        }}
      >
        {Object.entries(LOCALE_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <span className="hint" style={{ display: 'block', marginTop: 4 }}>{t('profile.languageHint')}</span>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('profile.appearance')}</h3>
      <div className="row" style={{ gap: 6 }}>
        {(['system', 'light', 'dark'] as const).map((option) => (
          <button
            key={option}
            className={`btn sm${theme === option ? ' primary' : ''}`}
            onClick={() => setTheme(option)}
          >
            <Icon name={option === 'dark' ? 'moon' : option === 'light' ? 'sun' : 'settings'} size={14} />
            {t(THEME_KEY[option])}
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('profile.password')}</h3>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          className="input" type="password" placeholder={t('profile.currentPassword')} autoComplete="current-password"
          style={{ maxWidth: 220 }} value={passwords.current}
          onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
        />
        <input
          className="input" type="password" placeholder={t('profile.newPassword')} autoComplete="new-password"
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
              toast(t('profile.passwordChanged'));
            } catch (err) {
              toast(err instanceof Error ? err.message : t('profile.passwordFailed'));
            }
          }}
        >
          {t('profile.changePassword')}
        </button>
      </div>

      <TwoFactor />
      <Sessions />
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

const PREFERENCES: { value: MailStatus['preference']; label: TranslationKey; hint: TranslationKey }[] = [
  { value: 'all', label: 'notify.all', hint: 'notify.allHint' },
  { value: 'important', label: 'notify.important', hint: 'notify.importantHint' },
  { value: 'none', label: 'notify.none', hint: 'notify.noneHint' },
];

const batchWindow = (t: Translate, seconds: number): string => {
  if (seconds < 60) return t('notify.windowSeconds', { count: seconds });
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? t('notify.windowMinute') : t('notify.windowMinutes', { count: minutes });
};

/**
 * Addresses the instance has stopped writing to.
 *
 * Shown rather than hidden, because "they never got the invite" is otherwise an
 * unanswerable question — and clearable, because a full mailbox is temporary
 * and the person it happened to is the one who knows it is fixed.
 */
function Suppressions() {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<{ email: string; reason: string; detail: string | null }[]>([]);

  const load = () => api.get<any[]>('/api/mail/suppressions').then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, []);

  if (!rows.length) return null;

  return (
    <>
      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('mail.suppressed')}</h3>
      <p className="hint" style={{ marginBottom: 8 }}>{t('mail.suppressedHint')}</p>
      {rows.map((row) => (
        <div className="row" key={row.email} style={{ gap: 8, padding: '5px 0' }}>
          <span className="grow truncate" style={{ fontSize: 13 }}>{row.email}</span>
          <span className="muted" style={{ fontSize: 12 }} title={row.detail ?? ''}>{row.reason}</span>
          <button
            className="btn sm"
            onClick={async () => {
              await api.delete(`/api/mail/suppressions/${encodeURIComponent(row.email)}`);
              toast(t('notify.saved'));
              void load();
            }}
          >
            {t('mail.allowAgain')}
          </button>
        </div>
      ))}
    </>
  );
}

function Notifications() {
  const t = useT();
  const toast = useToast();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const { user } = useSession();
  const [digest, setDigest] = useState<string>(user?.digest ?? 'off');

  const load = () => api.get<MailStatus>('/api/mail/status').then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    load();
  }, []);

  const choose = async (preference: MailStatus['preference']) => {
    setStatus((current) => (current ? { ...current, preference } : current));
    await api.patch('/api/me', { email_prefs: preference });
    toast(t('notify.saved'));
  };

  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('notify.intro', { window: batchWindow(t, status?.batchSeconds ?? 120) })}
      </p>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('notify.digest')}</h3>
      <p className="hint" style={{ marginBottom: 8 }}>{t('notify.digestHint')}</p>
      <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
        {(['off', 'daily', 'weekly'] as const).map((option) => (
          <button
            key={option}
            className={`btn sm${digest === option ? ' active' : ''}`}
            style={digest === option ? { background: 'var(--bg-active)' } : undefined}
            aria-pressed={digest === option}
            onClick={async () => {
              setDigest(option);
              await api.patch('/api/me', { digest: option });
              toast(t('notify.saved'));
            }}
          >
            {t(option === 'off' ? 'notify.digestOff' : option === 'daily' ? 'notify.digestDaily' : 'notify.digestWeekly')}
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('notify.emailAbout')}</h3>
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
              <strong className="grow">{t(option.label)}</strong>
              {status?.preference === option.value && <Icon name="check" size={15} />}
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>{t(option.hint)}</span>
          </button>
        ))}
      </div>

      <PushToggle />

      <Suppressions />

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('notify.delivery')}</h3>
      {status?.mode === 'test-inbox' && (
        <div
          className="card"
          style={{ marginBottom: 10, borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <div className="row" style={{ gap: 7, marginBottom: 4 }}>
            <Icon name="bell" size={15} />
            <strong>{t('notify.captureTitle')}</strong>
          </div>
          <span className="soft" style={{ fontSize: 12.5 }}>
            {t('notify.captureBody', { host: status.host ?? '' })}
          </span>
        </div>
      )}
      {status?.enabled ? (
        <>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="row">
              <span className="grow">{t('notify.relay')}</span>
              <strong className="mono">{status.host}</strong>
              {status.mode === 'test-inbox' && <span className="chip" style={{ color: 'var(--warn)' }}>{t('notify.captureChip')}</span>}
            </div>
            <div className="row"><span className="grow">{t('notify.sender')}</span><strong className="mono">{status.from}</strong></div>
            <div className="row"><span className="grow">{t('notify.queued')}</span><strong>{status.pending}</strong></div>
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.post<{ to: string }>('/api/mail/test');
                toast(t('notify.testSent', { email: result.to }));
              } catch (err) {
                toast(err instanceof Error ? err.message : t('notify.testFailed'));
              } finally {
                setBusy(false);
                load();
              }
            }}
          >
            <Icon name="send" size={14} /> {t('notify.sendTest')}
          </button>
        </>
      ) : (
        <Empty
          emoji="✉️"
          title={t('notify.noRelayTitle')}
          hint={t('notify.noRelayHint')}
          guide="collab"
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- workspace */

function WorkspaceSettings() {
  const t = useT();
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
        <label htmlFor="ws-name">{t('workspace.name')}</label>
        <input id="ws-name" className="input" value={name} disabled={!canEdit} onChange={(event) => setName(event.target.value)} />
        {!canEdit && <span className="hint">{t('workspace.adminOnly')}</span>}
      </div>
      <button
        className="btn primary" disabled={!canEdit}
        onClick={async () => {
          await api.patch(`/api/workspaces/${workspaceId}`, { name });
          await refresh();
          toast(t('workspace.updated'));
        }}
      >
        {t('action.save')}
      </button>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('workspace.yours')}</h3>
      {session?.workspaces.map((entry) => (
        <div className="row" key={entry.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <span className="grow">{entry.name}</span>
          <span className="chip">{t(roleKey(entry.role))}</span>
          {entry.id !== workspaceId && <button className="btn sm" onClick={() => setWorkspace(entry.id)}>{t('workspace.switch')}</button>}
        </div>
      ))}

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('workspace.new')}</h3>
      <div className="row">
        <input className="input" placeholder={t('common.name')} value={creating} onChange={(event) => setCreating(event.target.value)} />
        <button
          className="btn"
          disabled={!creating.trim()}
          onClick={async () => {
            const result = await api.post<any>('/api/workspaces', { name: creating });
            setCreating('');
            await refresh();
            setWorkspace(result.workspace.id);
            toast(t('workspace.created'));
          }}
        >
          {t('action.create')}
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- members */

function Members() {
  const t = useT();
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
              {ROLES.map((option) => <option key={option} value={option}>{t(roleKey(option))}</option>)}
            </select>
          ) : (
            <span className="chip">{t(roleKey(member.role))}</span>
          )}
          {canManage && (
            <button
              className="btn ghost sm icon"
              onClick={async () => {
                if (!(await confirm(t('members.remove', { name: member.name }), t('action.remove')))) return;
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
          <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('members.invites')}</h3>
          <button
            className="btn"
            onClick={async () => {
              const invite = await api.createInvite(workspaceId, 'member');
              await navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
              toast(t('members.inviteCopied'));
              load();
            }}
          >
            <Icon name="link" size={14} /> {t('members.createInvite')}
          </button>
          {invites.map((invite) => (
            <div className="row" key={invite.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <code className="mono grow truncate">{location.origin}/invite/{invite.code}</code>
              <span className="chip">{t(roleKey(invite.role))}</span>
              <button
                className="btn ghost sm icon"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
                  toast(t('members.copied'));
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
  const t = useT();
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
      <p className="muted" style={{ fontSize: 13 }}>{t('api.intro')}</p>
      <GuideHint to="assistant" />

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('api.tokens')}</h3>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input" placeholder={t('api.tokenName')} value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="btn primary"
          onClick={async () => {
            const token = await api.createToken({ name, workspaceId });
            setCreated(token.token);
            load();
          }}
        >
          <Icon name="plus" size={14} /> {t('action.create')}
        </button>
      </div>

      {tokens.map((token) => (
        <div className="row" key={token.id} style={{ padding: '7px 0', borderTop: '1px solid var(--line)' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate">{token.name}</div>
            <div className="muted mono truncate">{token.prefix}… · {token.scopes}</div>
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {token.last_used_at ? t('api.usedAgo', { time: relativeTime(token.last_used_at) }) : t('api.neverUsed')}
          </span>
          <button
            className="btn ghost sm icon"
            onClick={async () => {
              await api.revokeToken(token.id);
              load();
              toast(t('api.revoked'));
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {!tokens.length && <span className="muted" style={{ fontSize: 12.5 }}>{t('api.noTokens')}</span>}

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('api.connect')}</h3>
      <pre className="md" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', padding: 12, borderRadius: 10, overflowX: 'auto', fontSize: 12 }}>
        {snippet}
      </pre>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(snippet); toast(t('api.configCopied')); }}>
          <Icon name="copy" size={14} /> {t('api.copyConfig')}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {t('api.orDirect', { url: `${location.origin}/mcp` })}
        </span>
      </div>

      {created && (
        <Sheet title={t('api.copyNow')} onClose={() => setCreated(null)}>
          <p className="muted">{t('api.copyNowHint')}</p>
          <code className="mono" style={{ display: 'block', wordBreak: 'break-all', background: 'var(--bg-sunken)', padding: 12, borderRadius: 8 }}>
            {created}
          </code>
          <button
            className="btn primary block" style={{ marginTop: 12 }}
            onClick={() => { void navigator.clipboard?.writeText(created); toast(t('api.tokenCopied')); }}
          >
            <Icon name="copy" size={14} /> {t('api.copyToken')}
          </button>
        </Sheet>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ data */

function DataSettings() {
  const t = useT();
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
      <AuditLog />

      <div className="divider" style={{ margin: '22px 0' }} />

      <Webhooks />

      <div className="divider" style={{ margin: '22px 0' }} />

      <Trash />

      <div className="divider" style={{ margin: '22px 0' }} />

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t('data.offlineCopy')}</h3>
      <p className="muted" style={{ fontSize: 13 }}>{t('data.offlineIntro')}</p>
      <GuideHint to="sync" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row"><span className="grow">{t('data.localData')}</span><strong>{mb(estimate?.usage)}</strong></div>
        <div className="row"><span className="grow">{t('data.available')}</span><strong>{mb(estimate?.quota)}</strong></div>
        <div className="row">
          <span className="grow">{t('data.persisted')}</span>
          <strong>{persisted === null ? '—' : persisted ? t('data.persistedYes') : t('data.persistedBestEffort')}</strong>
        </div>
      </div>

      <div className="row wrap">
        <button
          className="btn"
          onClick={async () => {
            const registration = await navigator.serviceWorker?.getRegistration();
            await registration?.update();
            toast(t('data.updateChecked'));
          }}
        >
          <Icon name="refresh" size={14} /> {t('data.checkUpdate')}
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            await signOut();
            toast(t('data.cleared'));
          }}
        >
          <Icon name="logout" size={14} /> {t('data.signOutClear')}
        </button>
      </div>

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('data.export')}</h3>
      <p className="muted" style={{ fontSize: 13 }}>{t('data.exportHint')}</p>
      {!estimate && <Empty emoji="💾" title={t('data.storageUnavailable')} hint={t('data.storageUnavailableHint')} />}
    </>
  );
}

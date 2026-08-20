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
import { LOCALE_NAMES, UNREVIEWED, localeLabel, roleKey, useI18n, useT, type Locale, type TranslationKey, type Translate } from '../lib/i18n';
import { PushToggle } from '../components/push';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { TelegramConnection } from '../components/telegram';

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
      <div className="flex items-center gap-2" style={{ marginBottom: 18 }}>
        <Avatar user={user ?? undefined} size={48} />
        <div className="flex-1 min-w-0">
          <strong>{user?.name}</strong>
          <div className="text-muted" style={{ fontSize: 12.5 }}>{user?.email}</div>
        </div>
        <label className={buttonVariants({ size: 'sm' })}>
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
          <Button variant="ghost" size="sm"
            onClick={async () => {
              await api.patch('/api/me', { avatar_url: null });
              await refresh();
            }}
          >
            {t('profile.removePicture')}
          </Button>
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
      <Button variant="primary"
        onClick={async () => {
          await api.patch('/api/me', { name, bio });
          await refresh();
          toast(t('profile.saved'));
        }}
      >
        {t('profile.save')}
      </Button>

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
        {(Object.keys(LOCALE_NAMES) as Locale[]).map((value) => <option key={value} value={value}>{localeLabel(value)}</option>)}
      </select>
      <span className="text-[12px] text-muted" style={{ display: 'block', marginTop: 4 }}>{t('profile.languageHint')}</span>
      {/* Said where it is chosen, so nobody finds out from an odd sentence
          three screens later. */}
      {UNREVIEWED[locale] && (
        <span className="text-[12px] text-danger" style={{ display: 'block', marginTop: 2 }}>{t('profile.languageUnreviewed')}</span>
      )}

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('profile.appearance')}</h3>
      <div className="flex items-center gap-2" style={{ gap: 6 }}>
        {(['system', 'light', 'dark'] as const).map((option) => (
          <button
            key={option}
            className={cn(buttonVariants({ size: 'sm' }), theme === option && 'bg-accent text-accent-fg border-accent')}
            onClick={() => setTheme(option)}
          >
            <Icon name={option === 'dark' ? 'moon' : option === 'light' ? 'sun' : 'settings'} size={14} />
            {t(THEME_KEY[option])}
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('profile.password')}</h3>
      <div className="flex items-center gap-2 flex-wrap" style={{ gap: 8 }}>
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
        <Button
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
        </Button>
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
      <p className="text-[12px] text-muted" style={{ marginBottom: 8 }}>{t('mail.suppressedHint')}</p>
      {rows.map((row) => (
        <div className="flex items-center gap-2" key={row.email} style={{ gap: 8, padding: '5px 0' }}>
          <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>{row.email}</span>
          <span className="text-muted" style={{ fontSize: 12 }} title={row.detail ?? ''}>{row.reason}</span>
          <Button size="sm"
            onClick={async () => {
              await api.delete(`/api/mail/suppressions/${encodeURIComponent(row.email)}`);
              toast(t('notify.saved'));
              void load();
            }}
          >
            {t('mail.allowAgain')}
          </Button>
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
      <p className="text-muted" style={{ fontSize: 13 }}>
        {t('notify.intro', { window: batchWindow(t, status?.batchSeconds ?? 120) })}
      </p>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('notify.digest')}</h3>
      <p className="text-[12px] text-muted" style={{ marginBottom: 8 }}>{t('notify.digestHint')}</p>
      <div className="flex items-center gap-2 flex-wrap" style={{ gap: 6, marginBottom: 6 }}>
        {(['off', 'daily', 'weekly'] as const).map((option) => (
          <button
            key={option}
            className={cn(buttonVariants({ size: 'sm' }), digest === option && 'bg-active text-fg')}
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
      <div className="flex flex-col gap-2" style={{ gap: 6 }}>
        {PREFERENCES.map((option) => (
          <button
            key={option.value}
            className="rounded-[var(--radius)] border border-line bg-raised p-3.5"
            style={{
              textAlign: 'left',
              borderColor: status?.preference === option.value ? 'var(--accent)' : 'var(--line)',
              cursor: 'pointer',
            }}
            onClick={() => void choose(option.value)}
          >
            <div className="flex items-center gap-2">
              <strong className="flex-1 min-w-0">{t(option.label)}</strong>
              {status?.preference === option.value && <Icon name="check" size={15} />}
            </div>
            <span className="text-muted" style={{ fontSize: 12.5 }}>{t(option.hint)}</span>
          </button>
        ))}
      </div>

      <PushToggle />

      <TelegramConnection />

      <Suppressions />

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('notify.delivery')}</h3>
      {status?.mode === 'test-inbox' && (
        <div
          className="rounded-[var(--radius)] border border-line bg-raised p-3.5"
          style={{ marginBottom: 10, borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <div className="flex items-center gap-2" style={{ gap: 7, marginBottom: 4 }}>
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
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" style={{ marginBottom: 10 }}>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{t('notify.relay')}</span>
              <strong className="mono">{status.host}</strong>
              {status.mode === 'test-inbox' && <span className="chip" style={{ color: 'var(--warn)' }}>{t('notify.captureChip')}</span>}
            </div>
            <div className="flex items-center gap-2"><span className="flex-1 min-w-0">{t('notify.sender')}</span><strong className="mono">{status.from}</strong></div>
            <div className="flex items-center gap-2"><span className="flex-1 min-w-0">{t('notify.queued')}</span><strong>{status.pending}</strong></div>
          </div>
          <Button
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
          </Button>
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
        {!canEdit && <span className="text-[12px] text-muted">{t('workspace.adminOnly')}</span>}
      </div>
      <Button variant="primary" disabled={!canEdit}
        onClick={async () => {
          await api.patch(`/api/workspaces/${workspaceId}`, { name });
          await refresh();
          toast(t('workspace.updated'));
        }}
      >
        {t('action.save')}
      </Button>

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('workspace.yours')}</h3>
      {session?.workspaces.map((entry) => (
        <div className="flex items-center gap-2" key={entry.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <span className="flex-1 min-w-0">{entry.name}</span>
          <span className="chip">{t(roleKey(entry.role))}</span>
          {entry.id !== workspaceId && <Button size="sm" onClick={() => setWorkspace(entry.id)}>{t('workspace.switch')}</Button>}
        </div>
      ))}

      <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('workspace.new')}</h3>
      <div className="flex items-center gap-2">
        <input className="input" placeholder={t('common.name')} value={creating} onChange={(event) => setCreating(event.target.value)} />
        <Button
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
        </Button>
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
        <div className="flex items-center gap-2" key={member.user_id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
          <Avatar user={{ id: member.user_id, name: member.name, avatar_url: member.avatar_url }} size={30} />
          <div className="flex-1 min-w-0" style={{ minWidth: 0 }}>
            <div className="truncate">{member.name}</div>
            <div className="text-muted truncate" style={{ fontSize: 12 }}>{member.email}</div>
          </div>
          {member.last_seen_at && <span className="text-muted" style={{ fontSize: 11.5 }}>{relativeTime(member.last_seen_at)}</span>}
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
            <Button variant="ghost" size="iconSm"
              onClick={async () => {
                if (!(await confirm(t('members.remove', { name: member.name }), t('action.remove')))) return;
                await api.delete(`/api/workspaces/${workspaceId}/members/${member.user_id}`);
                load();
              }}
            >
              <Icon name="trash" size={14} />
            </Button>
          )}
        </div>
      ))}

      {canManage && (
        <>
          <h3 style={{ fontSize: 14, margin: '24px 0 8px' }}>{t('members.invites')}</h3>
          <Button
            onClick={async () => {
              const invite = await api.createInvite(workspaceId, 'member');
              await navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
              toast(t('members.inviteCopied'));
              load();
            }}
          >
            <Icon name="link" size={14} /> {t('members.createInvite')}
          </Button>
          {invites.map((invite) => (
            <div className="flex items-center gap-2" key={invite.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <code className="mono flex-1 min-w-0 truncate">{location.origin}/invite/{invite.code}</code>
              <span className="chip">{t(roleKey(invite.role))}</span>
              <Button variant="ghost" size="iconSm"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
                  toast(t('members.copied'));
                }}
              >
                <Icon name="copy" size={14} />
              </Button>
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

  /*
   * What somebody copies out of here has to work when they paste it.
   *
   * This used to be a stdio config pointing at `npx -y @kolibri/mcp`, which is
   * not published — the instruction failed with a 404 for everybody who tried
   * it. The command below needs nothing installed at all: the tools live in
   * this server, and a client that speaks HTTP can simply call it.
   */
  const token = created ?? 'kol_your_token_here';
  const snippet = `claude mcp add --transport http kolibri ${location.origin}/mcp \\
  --header "Authorization: Bearer ${token}"`;

  return (
    <>
      <p className="text-muted" style={{ fontSize: 13 }}>{t('api.intro')}</p>
      <GuideHint to="assistant" />

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('api.tokens')}</h3>
      <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
        <input className="input" placeholder={t('api.tokenName')} value={name} onChange={(event) => setName(event.target.value)} />
        <Button variant="primary"
          onClick={async () => {
            const token = await api.createToken({ name, workspaceId });
            setCreated(token.token);
            load();
          }}
        >
          <Icon name="plus" size={14} /> {t('action.create')}
        </Button>
      </div>

      {tokens.map((token) => (
        <div className="flex items-center gap-2" key={token.id} style={{ padding: '7px 0', borderTop: '1px solid var(--line)' }}>
          <div className="flex-1 min-w-0" style={{ minWidth: 0 }}>
            <div className="truncate">{token.name}</div>
            <div className="text-muted mono truncate">{token.prefix}… · {token.scopes}</div>
          </div>
          <span className="text-muted" style={{ fontSize: 11.5 }}>
            {token.last_used_at ? t('api.usedAgo', { time: relativeTime(token.last_used_at) }) : t('api.neverUsed')}
          </span>
          <Button variant="ghost" size="iconSm"
            onClick={async () => {
              await api.revokeToken(token.id);
              load();
              toast(t('api.revoked'));
            }}
          >
            <Icon name="trash" size={14} />
          </Button>
        </div>
      ))}
      {!tokens.length && <span className="text-muted" style={{ fontSize: 12.5 }}>{t('api.noTokens')}</span>}

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('api.connect')}</h3>
      <pre className="md" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', padding: 12, borderRadius: 10, overflowX: 'auto', fontSize: 12 }}>
        {snippet}
      </pre>
      <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(snippet); toast(t('api.configCopied')); }}>
          <Icon name="copy" size={14} /> {t('api.copyConfig')}
        </Button>
        <span className="text-muted" style={{ fontSize: 12 }}>
          {t('api.orDirect')}
        </span>
      </div>
      {/* Claude on the web has one box for a URL and nowhere to put a token, so
          it signs in instead. Nothing to configure here — the address is the
          whole of it. */}
      <p className="text-muted" style={{ fontSize: 12.5, marginTop: 12 }}>
        {t('api.onTheWeb', { url: location.origin })}
      </p>

      {created && (
        <Sheet title={t('api.copyNow')} onClose={() => setCreated(null)}>
          <p className="text-muted">{t('api.copyNowHint')}</p>
          <code className="mono" style={{ display: 'block', wordBreak: 'break-all', background: 'var(--bg-sunken)', padding: 12, borderRadius: 8 }}>
            {created}
          </code>
          <Button variant="primary" block style={{ marginTop: 12 }}
            onClick={() => { void navigator.clipboard?.writeText(created); toast(t('api.tokenCopied')); }}
          >
            <Icon name="copy" size={14} /> {t('api.copyToken')}
          </Button>
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
      <p className="text-muted" style={{ fontSize: 13 }}>{t('data.offlineIntro')}</p>
      <GuideHint to="sync" />
      <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" style={{ marginBottom: 14 }}>
        <div className="flex items-center gap-2"><span className="flex-1 min-w-0">{t('data.localData')}</span><strong>{mb(estimate?.usage)}</strong></div>
        <div className="flex items-center gap-2"><span className="flex-1 min-w-0">{t('data.available')}</span><strong>{mb(estimate?.quota)}</strong></div>
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0">{t('data.persisted')}</span>
          <strong>{persisted === null ? '—' : persisted ? t('data.persistedYes') : t('data.persistedBestEffort')}</strong>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={async () => {
            const registration = await navigator.serviceWorker?.getRegistration();
            await registration?.update();
            toast(t('data.updateChecked'));
          }}
        >
          <Icon name="refresh" size={14} /> {t('data.checkUpdate')}
        </Button>
        <Button variant="danger"
          onClick={async () => {
            await signOut();
            toast(t('data.cleared'));
          }}
        >
          <Icon name="logout" size={14} /> {t('data.signOutClear')}
        </Button>
      </div>

      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('data.export')}</h3>
      <p className="text-muted" style={{ fontSize: 13 }}>{t('data.exportHint')}</p>
      {!estimate && <Empty emoji="💾" title={t('data.storageUnavailable')} hint={t('data.storageUnavailableHint')} />}
    </>
  );
}

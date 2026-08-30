import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header, THEME_KEY, useTheme } from '../../../kernel/design-system/chrome';
import { Avatar, Empty, Icon, Sheet, useConfirm, useToast } from '../../../kernel/design-system/ui';
import { GuideHint } from '../../guide/hint';
import { api } from '../../../kernel/sync/api';
import { relativeTime } from '../../../kernel/design-system/format';
import { useFeature, useSeesMoney, useSession } from '../../../kernel/identity/session';
import { AutomationSettings } from '../../automation/settings';
import { Trash } from '../../trash/trash';
import { AuditLog, Webhooks } from '../admin';
import { Backups, PersonalExport, WorkspaceTransfer } from '../../../adapters/transfer/data';
import { Sessions, TwoFactor } from '../../../kernel/identity/security';
import { downscale } from '../../pages/Markdown';
import { LOCALE_NAMES, UNREVIEWED, localeLabel, roleKey, useI18n, useT, type Locale, type TranslationKey, type Translate } from '../../../kernel/i18n/i18n';
import { PushToggle } from '../../../adapters/push/push';
import { Button } from '../../../kernel/design-system/ui/button';
import { buttonVariants } from '../../../kernel/design-system/ui/button';
import { cn } from '../../../kernel/design-system/cn';
import { Input, Select, Textarea } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { RateSettings } from '../../time/rates';
import { Chip, chipVariants } from '../../../kernel/design-system/ui/chip';
import { TelegramConnection } from '../../../adapters/telegram/telegram';
import { InstanceSettings } from '../instance';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';

type Tab = 'profile' | 'notifications' | 'workspace' | 'members' | 'rates' | 'automation' | 'api' | 'data' | 'instance';

const TAB_KEY: Record<Tab, TranslationKey> = {
  profile: 'settings.tabProfile', notifications: 'settings.tabNotifications',
  workspace: 'settings.tabWorkspace', members: 'settings.tabMembers', rates: 'settings.tabRates',
  automation: 'settings.tabAutomation', api: 'settings.tabApi', data: 'settings.tabData',
  instance: 'settings.tabInstance',
};

const ROLES = ['owner', 'admin', 'member', 'guest'] as const;

export function Settings() {
  const t = useT();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  // `?tab=members` so the setup checklist can point at the screen it names.
  const requested = params.get('tab');
  const [tab, setTab] = useState<Tab>(() => (requested && requested in TAB_KEY ? requested as Tab : 'profile'));
  const strip = useTabStrip(tab);
  /**
   * The relay, the bot token and the model key belong to the server, so the
   * tab belongs to whoever holds the server — not to an owner of a workspace
   * inside it. The API refuses either way; this keeps the screen from offering
   * something that would only answer 403.
   */
  const instanceAdmin = !!session?.instanceAdmin;
  // Rates are owners' and admins' — and a workspace that does not track time
  // has nothing to apply one to, so the tab is not offered either.
  const seesMoney = useSeesMoney();
  const time = useFeature('time');
  const tabs = (Object.keys(TAB_KEY) as Tab[])
    .filter((name) => name !== 'instance' || instanceAdmin)
    .filter((name) => name !== 'rates' || (seesMoney && time));

  const choose = (next: Tab) => {
    setTab(next);
    setParams(next === 'profile' ? {} : { tab: next }, { replace: true });
  };
  return (
    <>
      <Header title={t('settings.title')} />
      <div ref={strip} className="tabs tabs-inset">
        {tabs.map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => choose(name)}>
            {t(TAB_KEY[name])}
          </button>
        ))}
      </div>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5" style={{ maxWidth: 680 }}>
        {tab === 'profile' && <Profile />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'workspace' && <WorkspaceSettings />}
        {tab === 'members' && <Members />}
        {tab === 'rates' && seesMoney && time && <RateSettings />}
        {tab === 'automation' && <AutomationSettings />}
        {tab === 'api' && <ApiSettings />}
        {tab === 'data' && <DataSettings />}
        {tab === 'instance' && instanceAdmin && <InstanceSettings />}
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
      <div className="flex items-center gap-2 mb-[18px]">
        <Avatar user={user ?? undefined} size={48} />
        <div className="flex-1 min-w-0">
          <strong>{user?.name}</strong>
          <div className="text-muted text-[12.5px]">{user?.email}</div>
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
        <Input id="me-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="me-bio">{t('profile.bio')}</label>
        <Textarea id="me-bio" style={{ minHeight: 70 }} value={bio ?? ''} onChange={(event) => setBio(event.target.value)} />
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

      <SectionHeading>{t('profile.language')}</SectionHeading>
      <Select
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
      </Select>
      <span className="text-[12px] text-muted mt-1" style={{ display: 'block' }}>{t('profile.languageHint')}</span>
      {/* Said where it is chosen, so nobody finds out from an odd sentence
          three screens later. */}
      {UNREVIEWED[locale] && (
        <span className="text-[12px] text-danger mt-0.5" style={{ display: 'block' }}>{t('profile.languageUnreviewed')}</span>
      )}

      <SectionHeading>{t('profile.appearance')}</SectionHeading>
      <div className="flex items-center gap-1.5">
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

      <SectionHeading>{t('profile.password')}</SectionHeading>
      <div className="flex items-center gap-2 flex-wrap">
        {/* Named as well as hinted. The placeholder is gone as soon as the
            first character is typed, which is precisely when somebody checking
            "which box am I in" most needs to be told. */}
        <Input type="password" placeholder={t('profile.currentPassword')} autoComplete="current-password"
          aria-label={t('profile.currentPassword')}
          style={{ maxWidth: 220 }} value={passwords.current}
          onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
        />
        <Input type="password" placeholder={t('profile.newPassword')} autoComplete="new-password"
          aria-label={t('profile.newPassword')}
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
  mode: 'off' | 'relay' | 'scaleway' | 'test-inbox';
  transport: 'off' | 'smtp' | 'scaleway';
  host: string | null;
  /** How the SMTP connection is protected; null when mail goes over the API. */
  encryption: 'none' | 'starttls' | 'tls' | null;
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
      <SectionHeading>{t('mail.suppressed')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('mail.suppressedHint')}</p>
      {rows.map((row) => (
        <div className="flex items-center gap-2" key={row.email} style={{ gap: 8, padding: '5px 0' }}>
          <span className="flex-1 min-w-0 truncate text-[13.5px]">{row.email}</span>
          <span className="text-muted text-[12.5px]" title={row.detail ?? ''}>{row.reason}</span>
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
      <p className="text-muted text-[13.5px]">
        {t('notify.intro', { window: batchWindow(t, status?.batchSeconds ?? 120) })}
      </p>

      <SectionHeading>{t('notify.digest')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('notify.digestHint')}</p>
      <div className="flex items-center flex-wrap gap-1.5 mb-1.5">
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

      <SectionHeading>{t('notify.emailAbout')}</SectionHeading>
      <div className="flex flex-col gap-1.5">
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
            <span className="text-muted text-[12.5px]">{t(option.hint)}</span>
          </button>
        ))}
      </div>

      <PushToggle />

      <TelegramConnection />

      <Suppressions />

      <SectionHeading>{t('notify.delivery')}</SectionHeading>
      {status?.mode === 'test-inbox' && (
        <div
          className="rounded-[var(--radius)] border border-line bg-raised p-3.5"
          style={{ marginBottom: 10, borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <div className="flex items-center gap-2 mb-1" style={{ gap: 7 }}>
            <Icon name="bell" size={15} />
            <strong>{t('notify.captureTitle')}</strong>
          </div>
          <span className="soft text-[12.5px]">
            {t('notify.captureBody', { host: status.host ?? '' })}
          </span>
        </div>
      )}
      {status?.enabled ? (
        <>
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-2.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{t(status.transport === 'scaleway' ? 'notify.api' : 'notify.relay')}</span>
              <strong className="mono">{status.host}</strong>
              {/* Said where somebody would look for it: an unencrypted relay is
                  a deliberate choice for a capture inbox and a mistake
                  everywhere else, and the settings screen is the only place it
                  is ever visible. */}
              {status.encryption === 'none' && (
                <span className={chipVariants()} style={{ color: 'var(--warn)' }}>{t('notify.noEncryption')}</span>
              )}
              {status.mode === 'test-inbox' && <span className={chipVariants()} style={{ color: 'var(--warn)' }}>{t('notify.captureChip')}</span>}
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
  /** Whether this server can reach a model at all — see `task-review.tsx`. */
  const [aiProvider, setAiProvider] = useState<string | null>(null);

  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  useEffect(() => {
    api.config().then((config) => setAiProvider(config.ai?.provider ?? null)).catch(() => setAiProvider(null));
  }, []);
  const canEdit = role === 'owner' || role === 'admin';

  return (
    <>
      <div className="field">
        <label htmlFor="ws-name">{t('workspace.name')}</label>
        <Input id="ws-name" value={name} disabled={!canEdit} onChange={(event) => setName(event.target.value)} />
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

      {/* Off by default and switched on here, because until an estimate carries
          a unit there is nothing to compare the logged time against — see
          `WorkspaceFeatures` in the registry. */}
      <SectionHeading>{t('workspace.features')}</SectionHeading>
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!workspace?.features?.time}
          disabled={!canEdit}
          onChange={async (event) => {
            await api.patch(`/api/workspaces/${workspaceId}`, { features: { time: event.target.checked } });
            await refresh();
            toast(t('workspace.updated'));
          }}
        />
        <span>
          <span>{t('workspace.featureTime')}</span>
          <span className="text-[12px] text-muted">{t('workspace.featureTimeHint')}</span>
        </span>
      </label>

      {/* The estate. Independent of budgets on purpose: what runs where is
          worth writing down whether or not anybody is costing it, and the two
          only meet when both are on. */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!workspace?.features?.infrastructure}
          disabled={!canEdit}
          onChange={async (event) => {
            await api.patch(`/api/workspaces/${workspaceId}`, { features: { infrastructure: event.target.checked } });
            await refresh();
            toast(t('workspace.updated'));
          }}
        />
        <span>
          <span>{t('workspace.featureEstate')}</span>
          <span className="text-[12px] text-muted">{t('workspace.featureEstateHint')}</span>
        </span>
      </label>

      {/* Off by default like the rest, and for a reason of its own: money is
          the one thing here that everybody in a workspace can see the moment
          it exists. Turning it off hides the screens; the figures stay. */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!workspace?.features?.budget}
          disabled={!canEdit}
          onChange={async (event) => {
            await api.patch(`/api/workspaces/${workspaceId}`, { features: { budget: event.target.checked } });
            await refresh();
            toast(t('workspace.updated'));
          }}
        />
        <span>
          <span>{t('workspace.featureBudget')}</span>
          <span className="text-[12px] text-muted">{t('workspace.featureBudgetHint')}</span>
        </span>
      </label>

      {/* Independent of the other three. A team measuring lead time is not
          thereby costing servers; the only thing KPIs borrow from elsewhere is
          the milestone, which every workspace already has. */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!workspace?.features?.kpi}
          disabled={!canEdit}
          onChange={async (event) => {
            await api.patch(`/api/workspaces/${workspaceId}`, { features: { kpi: event.target.checked } });
            await refresh();
            toast(t('workspace.updated'));
          }}
        />
        <span>
          <span>{t('workspace.featureKpi')}</span>
          <span className="text-[12px] text-muted">{t('workspace.featureKpiHint')}</span>
        </span>
      </label>

      {/* The workspace half of the two switches a review needs. The other half
          is a key in the environment, which is not a thing an admin can set
          from here — so when there is no model the row says who to ask rather
          than offering a switch that would do nothing. */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!workspace?.features?.ai}
          disabled={!canEdit || !aiProvider}
          onChange={async (event) => {
            await api.patch(`/api/workspaces/${workspaceId}`, { features: { ai: event.target.checked } });
            await refresh();
            toast(t('workspace.updated'));
          }}
        />
        <span>
          <span>{t('workspace.featureAi')}</span>
          <span className="text-[12px] text-muted">
            {aiProvider
              ? t('workspace.featureAiHint', { provider: aiProvider })
              : t('workspace.featureAiUnset')}
          </span>
        </span>
      </label>

      <SectionHeading>{t('workspace.yours')}</SectionHeading>
      {session?.workspaces.map((entry) => (
        <div className="flex items-center gap-2" key={entry.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <span className="flex-1 min-w-0">{entry.name}</span>
          <Chip>{t(roleKey(entry.role))}</Chip>
          {entry.id !== workspaceId && <Button size="sm" onClick={() => setWorkspace(entry.id)}>{t('workspace.switch')}</Button>}
        </div>
      ))}

      <SectionHeading>{t('workspace.new')}</SectionHeading>
      <div className="flex items-center gap-2">
        <Input placeholder={t('common.name')} value={creating} onChange={(event) => setCreating(event.target.value)} />
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
          <div className="flex-1 min-w-0">
            <div className="truncate">{member.name}</div>
            <div className="text-muted truncate text-[12.5px]">{member.email}</div>
          </div>
          {member.last_seen_at && <span className="text-muted text-[11.5px]">{relativeTime(member.last_seen_at)}</span>}
          {canManage ? (
            <Select style={{ width: 110 }} value={member.role}
              onChange={async (event) => {
                await api.patch(`/api/workspaces/${workspaceId}/members/${member.user_id}`, { role: event.target.value });
                load();
              }}
            >
              {ROLES.map((option) => <option key={option} value={option}>{t(roleKey(option))}</option>)}
            </Select>
          ) : (
            <Chip>{t(roleKey(member.role))}</Chip>
          )}
          {canManage && (
            <Button
              variant="ghost" size="iconSm"
              // A bin icon on a row, announcing as "button". Naming the person
              // as well as the verb matters here more than anywhere: the rows
              // are identical to a screen reader otherwise.
              aria-label={`${t('action.remove')} — ${member.name}`}
              title={`${t('action.remove')} — ${member.name}`}
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
          <SectionHeading>{t('members.invites')}</SectionHeading>
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
              <Chip>{t(roleKey(invite.role))}</Chip>
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

/**
 * The calendar feed.
 *
 * Deliberately not created until somebody presses the button. A subscribable
 * URL that exists before anybody wanted one is a URL that can leak before
 * anybody knew it was there — and a person who never opens this screen has no
 * feed to leak.
 */
function CalendarFeed() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [url, setUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.calendar().then((result) => { setUrl(result.url); setReady(true); }).catch(() => setReady(true));
  }, []);

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    toast(t('calendar.copied'));
  };

  if (!ready) return null;

  return (
    <>
      {dialog}
      <SectionHeading>{t('calendar.title')}</SectionHeading>
      <p className="text-muted text-[13px] mb-2">{t('calendar.intro')}</p>

      {!url ? (
        <Button onClick={async () => setUrl((await api.calendarOn()).url)}>
          <Icon name="calendar" size={14} /> {t('calendar.create')}
        </Button>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Input readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="flex-1 min-w-0 font-mono text-[12px]" aria-label={t('calendar.title')} />
            <Button size="sm" onClick={() => copy(url)}>
              <Icon name="copy" size={14} /> {t('action.copy')}
            </Button>
          </div>
          <p className="text-muted text-[12.5px] mt-2">{t('calendar.paste')}</p>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <Button size="sm" onClick={() => copy(`${url}?kind=todo`)}>
              <Icon name="list" size={14} /> {t('calendar.asTasks')}
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                if (!(await confirm(t('calendar.rotateWarning'), t('calendar.rotate')))) return;
                setUrl((await api.calendarRotate()).url);
                toast(t('calendar.rotated'));
              }}
            >
              <Icon name="refresh" size={14} /> {t('calendar.rotate')}
            </Button>
            <Button
              size="sm" variant="danger"
              onClick={async () => {
                if (!(await confirm(t('calendar.offWarning'), t('calendar.off')))) return;
                await api.calendarOff();
                setUrl(null);
              }}
            >
              {t('calendar.off')}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

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
      <p className="text-muted text-[13.5px]">{t('api.intro')}</p>
      <GuideHint to="assistant" />

      <SectionHeading>{t('api.tokens')}</SectionHeading>
      <div className="flex items-center gap-2 mb-3">
        <Input placeholder={t('api.tokenName')} value={name} onChange={(event) => setName(event.target.value)} />
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
          <div className="flex-1 min-w-0">
            <div className="truncate">{token.name}</div>
            <div className="text-muted mono truncate">{token.prefix}… · {token.scopes}</div>
          </div>
          <span className="text-muted text-[11.5px]">
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
      {!tokens.length && <span className="text-muted text-[12.5px]">{t('api.noTokens')}</span>}

      <SectionHeading>{t('api.connect')}</SectionHeading>
      <pre className="md text-[12.5px]" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', padding: 12, borderRadius: 10, overflowX: 'auto' }}>
        {snippet}
      </pre>
      <div className="flex items-center gap-2 mt-2">
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(snippet); toast(t('api.configCopied')); }}>
          <Icon name="copy" size={14} /> {t('api.copyConfig')}
        </Button>
        <span className="text-muted text-[12.5px]">
          {t('api.orDirect')}
        </span>
      </div>
      {/* Claude on the web has one box for a URL and nowhere to put a token, so
          it signs in instead. Nothing to configure here — the address is the
          whole of it. */}
      <p className="text-muted text-[12.5px] mt-3">
        {t('api.onTheWeb', { url: location.origin })}
      </p>

      <CalendarFeed />

      {created && (
        <Sheet title={t('api.copyNow')} onClose={() => setCreated(null)}>
          <p className="text-muted">{t('api.copyNowHint')}</p>
          <code className="mono" style={{ display: 'block', wordBreak: 'break-all', background: 'var(--bg-sunken)', padding: 12, borderRadius: 8 }}>
            {created}
          </code>
          <Button variant="primary" block className="mt-3"
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

      <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />

      <Webhooks />

      <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />

      <Trash />

      <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />

      <SectionHeading tight>{t('data.offlineCopy')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('data.offlineIntro')}</p>
      <GuideHint to="sync" />
      <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5">
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

      {!estimate && <Empty emoji="💾" title={t('data.storageUnavailable')} hint={t('data.storageUnavailableHint')} />}

      <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />

      <WorkspaceTransfer />

      <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />

      <PersonalExport />

      {/* Renders nothing at all unless this account administers the instance —
          the panel asks the server rather than guessing from a role held in
          one workspace. */}
      <Backups />
    </>
  );
}

/**
 * The settings that belong to the server rather than to a workspace.
 *
 * A relay, a bot token, a model key. All three used to live in a compose file,
 * which is the right place for a platform team and the wrong one for the
 * person who set this up on a Sunday and now wants password resets to arrive:
 * editing that file means finding the machine, changing a line and restarting
 * the container, and none of those steps is available from a phone.
 *
 * Two things this screen owes the person reading it. It says where each value
 * is *coming from*, because an instance whose compose file already sets a
 * relay is a different situation from an empty one and the difference is
 * invisible otherwise. And every group has a button that tries it: a
 * configuration you cannot try is one you find out about when somebody says
 * they never got their invite.
 */
import { useEffect, useState } from 'react';
import { api } from '../../kernel/sync/api';
import { cn } from '../../kernel/design-system/cn';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Icon, useToast } from '../../kernel/design-system/ui';

type Group = 'mail' | 'telegram' | 'ai';

interface SettingView {
  key: string;
  group: Group;
  kind: 'text' | 'secret' | 'number' | 'bool' | 'choice';
  choices?: string[];
  /** Always empty for a secret — those never leave the server. */
  value: string;
  set: boolean;
  source: 'app' | 'environment' | 'default';
}

interface Status {
  mail: { enabled: boolean; transport: string; mode: string; from: string; host: string };
  telegram: { enabled: boolean };
  ai: { provider: string; model: string };
}

interface State {
  settings: SettingView[];
  status: Status;
}

const GROUPS: { group: Group; title: TranslationKey; hint: TranslationKey }[] = [
  { group: 'mail', title: 'instance.mail', hint: 'instance.mailHint' },
  { group: 'telegram', title: 'instance.telegram', hint: 'instance.telegramHint' },
  { group: 'ai', title: 'instance.ai', hint: 'instance.aiHint' },
];

const LABEL: Record<string, TranslationKey> = {
  KOLIBRI_MAIL_TRANSPORT: 'instance.transport',
  KOLIBRI_SMTP_HOST: 'instance.smtpHost',
  KOLIBRI_SMTP_PORT: 'instance.smtpPort',
  KOLIBRI_SMTP_ENCRYPTION: 'instance.smtpEncryption',
  KOLIBRI_SMTP_USER: 'instance.smtpUser',
  KOLIBRI_SMTP_PASS: 'instance.smtpPass',
  KOLIBRI_SMTP_INSECURE: 'instance.smtpInsecure',
  KOLIBRI_MAIL_FROM: 'instance.mailFrom',
  KOLIBRI_MAIL_FROM_NAME: 'instance.mailFromName',
  KOLIBRI_MAIL_REPLY_TO: 'instance.mailReplyTo',
  KOLIBRI_SCALEWAY_SECRET_KEY: 'instance.scalewayKey',
  KOLIBRI_SCALEWAY_PROJECT_ID: 'instance.scalewayProject',
  KOLIBRI_TELEGRAM_BOT_TOKEN: 'instance.botToken',
  KOLIBRI_AI_PROVIDER: 'instance.aiProvider',
  KOLIBRI_AI_API_KEY: 'instance.aiKey',
  KOLIBRI_AI_MODEL: 'instance.aiModel',
  KOLIBRI_AI_BASE_URL: 'instance.aiBaseUrl',
};

/** `null` is "hand this one back to the environment"; a string is a new value. */
type Draft = Record<string, string | null>;

export function InstanceSettings() {
  const t = useT();
  const toast = useToast();
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<Group | null>(null);

  const load = () => api.get<State>('/api/instance/settings').then(setState).catch(() => setState(null));
  useEffect(() => {
    void load();
  }, []);

  if (!state) return <p className="text-muted">{t('common.loading')}</p>;

  const save = async (group: Group) => {
    const keys = state.settings.filter((setting) => setting.group === group).map((setting) => setting.key);
    const patch: Draft = {};
    for (const key of keys) if (key in draft) patch[key] = draft[key];
    if (!Object.keys(patch).length) return;
    setBusy(group);
    try {
      setState(await api.post<State>('/api/instance/settings', { settings: patch }));
      setDraft((current) => {
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      });
      toast(t('instance.saved'));
    } catch (error) {
      toast(error instanceof Error ? error.message : t('instance.saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const test = async (group: Group) => {
    setBusy(group);
    try {
      const result = await api.post<{ detail: string; delivered?: boolean }>(`/api/instance/test/${group}`);
      toast(
        group === 'mail' ? t('instance.testMailOk', { email: result.detail })
          : group === 'telegram'
            ? result.delivered ? t('instance.testTelegramSent', { bot: result.detail }) : t('instance.testTelegramOk', { bot: result.detail })
            : t('instance.testAiOk', { model: result.detail }),
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : t('instance.testFailed'));
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <>
      <p className="text-muted text-[13.5px]">{t('instance.intro')}</p>

      {GROUPS.map(({ group, title, hint }) => {
        const settings = state.settings.filter((setting) => setting.group === group);
        const changed = settings.some((setting) => setting.key in draft);
        return (
          <section key={group}>
            <SectionHeading>{t(title)}</SectionHeading>
            <div className="mb-2 flex items-center gap-2">
              <GroupState group={group} status={state.status} />
            </div>
            <p className="mb-2.5 text-[12px] text-muted">{t(hint)}</p>

            <div className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-line bg-raised p-3.5">
              {settings.map((setting) => (
                <Field
                  key={setting.key}
                  setting={setting}
                  draft={draft}
                  onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))}
                />
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={!changed || busy === group} onClick={() => void save(group)}>
                {t('instance.save')}
              </Button>
              <Button disabled={busy === group} onClick={() => void test(group)}>
                <Icon name="send" size={14} /> {t('instance.test')}
              </Button>
              {changed && <span className="text-[12px] text-muted">{t('instance.unsaved')}</span>}
            </div>
          </section>
        );
      })}
    </>
  );
}

/** What this group adds up to right now, in one chip. */
function GroupState({ group, status }: { group: Group; status: Status }) {
  const t = useT();
  if (group === 'mail') {
    if (!status.mail.enabled) return <Chip>{t('instance.off')}</Chip>;
    return (
      <>
        <Chip tone="on">{status.mail.transport}</Chip>
        <span className="mono truncate text-[12px] text-muted">{status.mail.host}</span>
      </>
    );
  }
  if (group === 'telegram') {
    return <Chip tone={status.telegram.enabled ? 'on' : 'default'}>{status.telegram.enabled ? t('instance.on') : t('instance.off')}</Chip>;
  }
  if (status.ai.provider === 'off') return <Chip>{t('instance.off')}</Chip>;
  return (
    <>
      <Chip tone="on">{status.ai.provider}</Chip>
      {status.ai.model && <span className="mono truncate text-[12px] text-muted">{status.ai.model}</span>}
    </>
  );
}

function Field({
  setting, draft, onChange,
}: {
  setting: SettingView;
  draft: Draft;
  onChange: (value: string | null) => void;
}) {
  const t = useT();
  const edited = setting.key in draft;
  const current = edited ? draft[setting.key] : null;

  return (
    <label className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-soft">{t(LABEL[setting.key])}</span>
        {/* The variable's own name, because it is what the documentation, the
            compose file and `.env.example` all call this — and somebody moving
            a setting from one to the other should not have to guess. */}
        <span className="mono text-[11px] text-muted">{setting.key}</span>
        {setting.source === 'environment' && !edited && (
          <span className="text-[11px] text-muted">{t('instance.fromEnvironment')}</span>
        )}
      </span>

      {setting.kind === 'choice' ? (
        // "Automatic" is what nothing-was-chosen looks like, and it is only
        // honest while nothing *has* been: a server started with
        // `KOLIBRI_SMTP_ENCRYPTION=none` has to read as none here, or the
        // screen quietly disagrees with the connection it is describing.
        <Select
          value={edited ? current ?? '' : setting.source === 'default' ? '' : setting.value}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{t('instance.automatic')}</option>
          {(setting.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </Select>
      ) : setting.kind === 'bool' ? (
        <div className="flex items-center gap-1.5">
          {['true', 'false'].map((option) => {
            const active = (edited ? current : setting.value) === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                className={cn(
                  'rounded-[var(--radius-sm)] border border-line px-2.5 py-1 text-[12.5px]',
                  active ? 'border-accent bg-accent-soft text-accent' : 'text-soft',
                )}
                onClick={() => onChange(option)}
              >
                {t(option === 'true' ? 'instance.yes' : 'instance.no')}
              </button>
            );
          })}
        </div>
      ) : (
        <span className="flex items-center gap-1.5">
          <Input
            type={setting.kind === 'secret' ? 'password' : setting.kind === 'number' ? 'number' : 'text'}
            autoComplete={setting.kind === 'secret' ? 'new-password' : 'off'}
            // A stored secret is shown as the fact that it exists, never as
            // its length: the field is empty, and leaving it empty keeps it.
            placeholder={setting.kind === 'secret' ? (setting.set ? t('instance.secretSet') : t('instance.secretUnset')) : ''}
            value={edited ? current ?? '' : setting.kind === 'secret' ? '' : setting.value}
            onChange={(event) => onChange(event.target.value)}
          />
          {/* Only where there is something here to clear. A value that came
              from the environment or from a default cannot be cleared from
              this screen, and a × that did nothing would say otherwise. */}
          {setting.source === 'app' && (
            <Button
              variant="ghost"
              size="iconSm"
              title={t('instance.clear')}
              aria-label={t('instance.clear')}
              onClick={() => onChange(null)}
            >
              <Icon name="close" size={14} />
            </Button>
          )}
        </span>
      )}
    </label>
  );
}

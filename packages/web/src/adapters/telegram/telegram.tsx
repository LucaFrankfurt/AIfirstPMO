/**
 * Connecting an account to Telegram.
 *
 * The whole flow is one button, and the reason it can be one button is that
 * the chat id never passes through here: pressing it asks the server for a
 * single-use code, and the link opens Telegram with that code attached. What
 * comes back is a conversation the person started themselves, which is the
 * only way a bot is allowed to message anybody.
 *
 * So there is nothing to type, nothing to paste, and no way to point somebody
 * else's notifications at your own chat.
 */
import { useEffect, useState } from 'react';
import { api } from '../../kernel/sync/api';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { Icon, useToast } from '../../kernel/design-system/ui';

interface Status {
  /** Whether an operator configured a bot on this instance at all. */
  enabled: boolean;
  /** Whether *this* account has a chat connected. */
  linked: boolean;
  linkedAt: number | null;
  preference: 'all' | 'important' | 'none';
}

const PREFERENCES: { value: Status['preference']; label: TranslationKey; hint: TranslationKey }[] = [
  { value: 'all', label: 'telegram.all', hint: 'telegram.allHint' },
  { value: 'important', label: 'telegram.important', hint: 'telegram.importantHint' },
  { value: 'none', label: 'telegram.none', hint: 'telegram.noneHint' },
];

export function TelegramConnection() {
  const t = useT();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  /** The link handed out, kept so somebody on a desktop can still reach it. */
  const [pending, setPending] = useState<{ url: string; expiresAt: number } | null>(null);

  const load = () => api.get<Status>('/api/telegram/status').then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, []);

  /**
   * The chat arrives over Telegram rather than through this page, so there is
   * nothing to await — poll for a short while and stop. A minute is longer
   * than tapping a link takes; beyond that the code has probably not been used
   * and a background poll is just noise.
   */
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      const next = await api.get<Status>('/api/telegram/status').catch(() => null);
      if (next?.linked) {
        setStatus(next);
        setPending(null);
        toast(t('telegram.nowConnected'));
      } else if (Date.now() - started > 60_000) {
        setPending(null);
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [pending, t, toast]);

  // An instance with no bot token has nothing to offer here, and a switch that
  // cannot do anything is worse than an absent one.
  if (!status?.enabled) return null;

  async function connect(): Promise<void> {
    setBusy(true);
    try {
      const link = await api.post<{ url: string; expiresAt: number }>('/api/telegram/link');
      setPending(link);
      // Opened rather than only shown: on a phone this hands straight over to
      // Telegram, which is where the rest of it happens.
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('telegram.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    try {
      await api.post('/api/telegram/unlink');
      setPending(null);
      await load();
      toast(t('telegram.disconnected'));
    } finally {
      setBusy(false);
    }
  }

  const choose = async (preference: Status['preference']) => {
    setStatus((current) => (current ? { ...current, preference } : current));
    await api.patch('/api/me', { telegram_prefs: preference });
    toast(t('notify.saved'));
  };

  return (
    <>
      <SectionHeading>{t('telegram.title')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('telegram.hint')}</p>

      {status.linked ? (
        <>
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-2.5">
            <div className="flex items-center gap-2" style={{ gap: 7 }}>
              <Icon name="check" size={15} />
              <strong className="flex-1 min-w-0">{t('telegram.connectedTitle')}</strong>
            </div>
            <span className="soft text-[12.5px]">{t('telegram.connectedBody')}</span>
          </div>

          <div className="flex items-center flex-wrap gap-1.5 mb-1">
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post('/api/telegram/test');
                  toast(t('telegram.testSent'));
                } catch (problem) {
                  toast(problem instanceof Error ? problem.message : t('telegram.failed'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Icon name="send" size={14} /> {t('telegram.sendTest')}
            </Button>
            <Button disabled={busy} onClick={() => void disconnect()}>
              {t('telegram.disconnect')}
            </Button>
          </div>

          <SectionHeading>{t('telegram.about')}</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {PREFERENCES.map((option) => (
              <button
                key={option.value}
                className="rounded-[var(--radius)] border border-line bg-raised p-3.5"
                style={{
                  textAlign: 'left',
                  borderColor: status.preference === option.value ? 'var(--accent)' : 'var(--line)',
                  cursor: 'pointer',
                }}
                onClick={() => void choose(option.value)}
              >
                <div className="flex items-center gap-2">
                  <strong className="flex-1 min-w-0">{t(option.label)}</strong>
                  {status.preference === option.value && <Icon name="check" size={15} />}
                </div>
                <span className="text-muted text-[12.5px]">{t(option.hint)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <Button variant="primary" disabled={busy} onClick={() => void connect()}>
            <Icon name="send" size={14} /> {busy ? t('action.working') : t('telegram.connect')}
          </Button>
          {pending && (
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mt-2.5">
              <span className="soft text-[12.5px]">{t('telegram.waiting')}</span>
              {/* The popup may have been blocked, and on a desktop without
                  Telegram installed the link is the only way through. */}
              <a href={pending.url} target="_blank" rel="noopener noreferrer" className="mono text-[12.5px]">
                {pending.url}
              </a>
            </div>
          )}
        </>
      )}
    </>
  );
}

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
import { api } from '../lib/api';
import { useT, type TranslationKey } from '../lib/i18n';
import { Button } from '../components/ui/button';
import { Icon, useToast } from './ui';

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
      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>{t('telegram.title')}</h3>
      <p className="text-[12px] text-muted" style={{ marginBottom: 8 }}>{t('telegram.hint')}</p>

      {status.linked ? (
        <>
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" style={{ marginBottom: 10 }}>
            <div className="flex items-center gap-2" style={{ gap: 7 }}>
              <Icon name="check" size={15} />
              <strong className="flex-1 min-w-0">{t('telegram.connectedTitle')}</strong>
            </div>
            <span className="soft" style={{ fontSize: 12.5 }}>{t('telegram.connectedBody')}</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap" style={{ gap: 6, marginBottom: 4 }}>
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

          <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('telegram.about')}</h3>
          <div className="flex flex-col gap-2" style={{ gap: 6 }}>
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
                <span className="text-muted" style={{ fontSize: 12.5 }}>{t(option.hint)}</span>
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
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" style={{ marginTop: 10 }}>
              <span className="soft" style={{ fontSize: 12.5 }}>{t('telegram.waiting')}</span>
              {/* The popup may have been blocked, and on a desktop without
                  Telegram installed the link is the only way through. */}
              <a href={pending.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>
                {pending.url}
              </a>
            </div>
          )}
        </>
      )}
    </>
  );
}

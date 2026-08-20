/**
 * Turning on notifications for *this device*.
 *
 * Deliberately per device rather than per account: permission belongs to a
 * browser, and somebody who wants banners on their phone rarely wants them on
 * the machine the app is already open on all day.
 *
 * Permission is asked for only when the switch is pressed. A site that asks on
 * load is a site people click "block" on, and a blocked permission cannot be
 * asked for again.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { buttonVariants } from '../components/ui/button';
import { SectionHeading } from './ui/section';
import { Icon, useToast } from './ui';

type State = 'unsupported' | 'off' | 'on' | 'denied' | 'working';

/** base64url → the bytes `pushManager.subscribe` insists on. */
function decodeKey(base64: string): ArrayBuffer {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export function PushToggle() {
  const t = useT();
  const toast = useToast();
  const [state, setState] = useState<State>('unsupported');
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) {
      setState('unsupported');
      return;
    }
    void (async () => {
      const config = await api.get<{ enabled: boolean; key: string | null }>('/api/push/key').catch(() => null);
      if (!config?.enabled || !config.key) {
        setState('unsupported');
        return;
      }
      setKey(config.key);
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      setState(existing ? 'on' : 'off');
    })();
  }, []);

  async function enable(): Promise<void> {
    if (!key) return;
    setState('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key),
      });
      await api.post('/api/push/subscribe', subscription.toJSON());
      setState('on');
      toast(t('push.on'));
    } catch (problem) {
      setState('off');
      toast(problem instanceof Error ? problem.message : t('push.failed'));
    }
  }

  async function disable(): Promise<void> {
    setState('working');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setState('off');
    } catch {
      setState('on');
    }
  }

  if (state === 'unsupported') return null;

  return (
    <>
      <SectionHeading>{t('push.title')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('push.hint')}</p>
      {state === 'denied' ? (
        <p className="text-muted text-[12.5px]">{t('push.denied')}</p>
      ) : (
        <button
          className={buttonVariants({ variant: state === 'on' ? 'secondary' : 'primary' })}
          disabled={state === 'working'}
          onClick={() => void (state === 'on' ? disable() : enable())}
        >
          <Icon name="bell" size={14} />
          {state === 'working' ? t('action.working') : state === 'on' ? t('push.turnOff') : t('push.turnOn')}
        </button>
      )}
    </>
  );
}

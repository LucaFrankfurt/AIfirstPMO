/**
 * Notifications on a phone running the packaged app.
 *
 * The browser's half of this module subscribes a service worker to web push,
 * and none of that exists in the app: neither WebView has the Push API. A phone
 * is woken by Apple or Google instead, through the relay — `adapters/push/app.ts`
 * on the server says what it is sent, which is a token and a language and never
 * what happened. So what this file does is ask the phone for a token, hand it to
 * this person's own Kolibri, and open the inbox when the banner is tapped.
 *
 * Per device and opt-in, as in a browser, and for the same reason: permission
 * is asked for when the switch is pressed and never on start, because a phone
 * that was asked unprompted is a phone that says no, and iOS does not ask twice.
 *
 * Two things are remembered on the phone: the token, and which session it was
 * registered on. The token, because Apple and Google may hand out a new one
 * whenever they like and the server has to be told; the session, because the
 * server forgets a phone when the session it registered on ends — so a phone
 * that has been signed out since is not quietly re-registered for whoever signs
 * in next. They have not asked.
 */
import { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { api } from '../../kernel/sync/api';
import { isPackaged, sessionToken } from '../../kernel/sync/server';
import { useT } from '../../kernel/i18n/i18n';
import { buttonVariants } from '../../kernel/design-system/ui/button';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { Icon, useToast } from '../../kernel/design-system/ui';

/**
 * Whether this Android build has Firebase in it — see `AppPushPlugin.java`.
 * Without it the push plugin's `register()` ends the app rather than failing.
 */
const AppPush = registerPlugin<{ available(): Promise<{ available: boolean }> }>('AppPush');

const STORED = 'kolibri.push.app';
/** The Android channel the relay's notifications land in; the manifest names it too. */
const CHANNEL = 'kolibri';
/** How long to wait for Apple or Google to issue a token before saying it did not work. */
const TOKEN_WAIT_MS = 20_000;

interface Opted {
  token: string;
  /** A digest of the session the token was registered on — never the session itself. */
  session: string;
}

const read = (): Opted | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORED) ?? 'null') as Opted | null;
    return parsed?.token && parsed.session ? parsed : null;
  } catch {
    return null;
  }
};

const keep = (opted: Opted | null): void => {
  try {
    if (opted) localStorage.setItem(STORED, JSON.stringify(opted));
    else localStorage.removeItem(STORED);
  } catch {
    /* The switch shows off next time; nothing worse. */
  }
};

/** Which session this is, as a digest: enough to recognise it, nothing to use. */
async function sessionDigest(): Promise<string> {
  const token = sessionToken();
  if (!token) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const platform = (): 'ios' | 'android' => (Capacitor.getPlatform() === 'ios' ? 'ios' : 'android');

/** Can this phone and this build be pushed to at all? */
async function deviceCanPush(): Promise<boolean> {
  // iOS needs nothing at build time beyond the entitlement, and a build
  // without it fails to register with an error rather than a crash.
  if (platform() === 'ios') return true;
  try {
    return (await AppPush.available()).available;
  } catch {
    return false;
  }
}

/* ------------------------------------------------- the token, as it arrives */

let waiting: { resolve: (token: string) => void; reject: (problem: Error) => void } | null = null;

/** Ask the phone for its token, and wait for it. */
function issueToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting = null;
      reject(new Error('no token'));
    }, TOKEN_WAIT_MS);
    waiting = {
      resolve: (token) => { clearTimeout(timer); resolve(token); },
      reject: (problem) => { clearTimeout(timer); reject(problem); },
    };
    PushNotifications.register().catch((problem: unknown) => {
      waiting?.reject(problem instanceof Error ? problem : new Error(String(problem)));
      waiting = null;
    });
  });
}

/**
 * A token arrived. Either somebody pressed the switch and is waiting for it,
 * or the phone was asked again on start and Apple or Google issued a new one —
 * in which case the server is told, and the old one forgotten there.
 */
async function onToken(token: string): Promise<void> {
  if (waiting) {
    waiting.resolve(token);
    waiting = null;
    return;
  }
  const opted = read();
  if (!opted || opted.token === token) return;
  await api.post('/api/push/app', { platform: platform(), token });
  await api.post('/api/push/app/forget', { token: opted.token }).catch(() => undefined);
  keep({ ...opted, token });
}

const channel = (name: string): Promise<void> =>
  (platform() === 'android'
    ? PushNotifications.createChannel({ id: CHANNEL, name, importance: 4 }).catch(() => undefined)
    : Promise.resolve());

/**
 * Open a path in the app as if it had been followed. React Router listens for
 * `popstate`, so pushing the address and announcing it is a navigation — the
 * one that does not reload the app, its cache and its live connection.
 */
function openInApp(url: unknown): void {
  const path = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/inbox';
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

let installed = false;

/**
 * Hung off the app by `wiring.ts`; nothing in a browser.
 *
 * The tap listener is here rather than on a screen because the tap that starts
 * the app arrives before any screen exists — the plugin keeps it until somebody
 * listens.
 */
export function installAppPush(channelName: () => string): void {
  if (installed || !isPackaged()) return;
  installed = true;
  // Each one caught: a listener that could not be added is a phone that is not
  // woken, which the switch in Settings will say — not a reason for the app to
  // start with an unhandled rejection.
  const quietly = (attempt: Promise<unknown>) => void attempt.catch(() => undefined);
  quietly(PushNotifications.addListener('registration', ({ value }) => quietly(onToken(value))));
  quietly(PushNotifications.addListener('registrationError', ({ error }) => {
    waiting?.reject(new Error(error));
    waiting = null;
  }));
  quietly(PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => openInApp(notification.data?.url)));
  quietly(refresh(channelName));
}

/** On start: ask again for a phone that opted in on this session, and let go of one that did not. */
async function refresh(channelName: () => string): Promise<void> {
  const opted = read();
  if (!opted) return;
  if (opted.session !== await sessionDigest()) {
    // Signed out since. The server already stopped waking it with that session.
    keep(null);
    return;
  }
  if ((await PushNotifications.checkPermissions()).receive !== 'granted') {
    // Turned off in the phone's settings. Nothing will arrive, so say so to the server.
    await api.post('/api/push/app/forget', { token: opted.token }).catch(() => undefined);
    keep(null);
    return;
  }
  await channel(channelName());
  // A token that changed arrives through `onToken`, which tells the server.
  await PushNotifications.register();
}

/* ---------------------------------------------------------------- the switch */

type State = 'unsupported' | 'off' | 'on' | 'denied' | 'working';

export function AppPushToggle() {
  const t = useT();
  const toast = useToast();
  const [state, setState] = useState<State>('unsupported');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const config = await api.get<{ app?: boolean }>('/api/push/key').catch(() => null);
      if (!config?.app || !(await deviceCanPush())) return;
      const permission = (await PushNotifications.checkPermissions().catch(() => null))?.receive;
      const opted = read();
      const next: State = permission === 'denied'
        ? 'denied'
        : opted && opted.session === await sessionDigest() && permission === 'granted' ? 'on' : 'off';
      if (alive) setState(next);
    })();
    return () => { alive = false; };
  }, []);

  async function enable(): Promise<void> {
    setState('working');
    try {
      const permission = (await PushNotifications.requestPermissions()).receive;
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      await channel(t('push.channel'));
      const token = await issueToken();
      await api.post('/api/push/app', { platform: platform(), token });
      keep({ token, session: await sessionDigest() });
      setState('on');
      toast(t('push.on'));
    } catch {
      setState('off');
      toast(t('push.failed'));
    }
  }

  async function disable(): Promise<void> {
    setState('working');
    const opted = read();
    try {
      if (opted) await api.post('/api/push/app/forget', { token: opted.token });
      keep(null);
      // Apple and Google are told too, so the token itself is over.
      await PushNotifications.unregister().catch(() => undefined);
      setState('off');
    } catch {
      setState('on');
    }
  }

  if (state === 'unsupported') return null;

  return (
    <>
      <SectionHeading>{t('push.title')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('push.appHint')}</p>
      {state === 'denied' ? (
        <p className="text-muted text-[12.5px]">{t('push.appDenied')}</p>
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

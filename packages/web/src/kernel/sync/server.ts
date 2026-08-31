/**
 * Which Kolibri this client talks to, and with what credential.
 *
 * In a browser both answers are "the page's own origin, with its cookie", and
 * nothing here changes that: `origin` stays empty, every request stays relative
 * and same-origin, and the session cookie keeps being `HttpOnly` where script
 * cannot reach it.
 *
 * A packaged app is the case this exists for. It loads from its own origin —
 * `capacitor://localhost` on iOS, `https://localhost` on Android — so a
 * relative `/api/…` addresses the app's own bundle and the server's cookie is
 * never sent. It has to be told where the server is, and it has to carry a
 * bearer token instead. `authenticate` on the server has accepted a session
 * token as a bearer all along, because SSE needs one; the app asks for one at
 * sign-in with `x-kolibri-client: native`.
 *
 * Both are stored rather than kept in memory: a phone kills a backgrounded app
 * whenever it likes, and being signed out by switching apps is not a session.
 */
const ORIGIN_KEY = 'kolibri.server';
const TOKEN_KEY = 'kolibri.token';

/* Reading storage can throw outright — Safari in private mode, a container
   with site data blocked — and a client that cannot remember where its server
   is should still start and say so, rather than fail to render. */
const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const remember = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Nothing to do about it, and nothing that should stop a sign-in. */
  }
};

let origin = stored(ORIGIN_KEY) ?? '';
let token = stored(TOKEN_KEY);

/**
 * Is this the packaged app rather than a browser?
 *
 * Capacitor puts itself on `window` before the bundle runs, which is the only
 * honest signal available: a build flag would have to be set correctly by
 * whoever builds, and a wrong one is an app that asks a browser for a server
 * address or a browser that never asks at all.
 *
 * It matters because an empty origin means two different things. In a browser
 * it means "this page's own origin", which is the answer. In the app it means
 * "nobody has said yet", which is a question.
 */
export const isPackaged = (): boolean => 'Capacitor' in globalThis;

/** Does this client still need to be told where its server is? */
export const needsServer = (): boolean => isPackaged() && !origin;

/** Where the server is. Empty in a browser, which means "wherever this page came from". */
export const serverOrigin = (): string => origin;

/** A path on that server. Pass the `/api/…` path exactly as it is written. */
export const serverUrl = (path: string): string => (origin && path.startsWith('/') ? origin + path : path);

/**
 * Point this client at a server. The packaged app calls it once, from the
 * screen that asks; a browser never does.
 *
 * A trailing slash is dropped rather than tolerated: `serverUrl` joins by
 * concatenation, and `https://host//api/session` is a 404 on some proxies and
 * a redirect on others, which is a bug that only appears in the field.
 */
export function useServer(next: string): void {
  origin = next.replace(/\/+$/, '');
  remember(ORIGIN_KEY, origin || null);
}

/** The bearer, if this client holds one. */
export const sessionToken = (): string | null => token;

/** Keep the token a sign-in returned, or forget it on the way out. */
export function useSessionToken(next: string | null): void {
  token = next;
  remember(TOKEN_KEY, next);
}

/** What every request adds. Empty in a browser, where the cookie does this job. */
export const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/**
 * What a sign-in has to send to be given a token at all.
 *
 * Only the packaged app sends it. The browser asking would mean a token in a
 * response body that script can read, which is the `HttpOnly` cookie's whole
 * point given away for nothing.
 */
export const clientHeaders = (): Record<string, string> => (origin ? { 'x-kolibri-client': 'native' } : {});

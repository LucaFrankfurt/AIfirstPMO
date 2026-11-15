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
 * Capacitor's native bridge puts itself on `window` before the bundle runs,
 * which is the only honest signal available: a build flag would have to be set
 * correctly by whoever builds, and a wrong one is an app that asks a browser for
 * a server address or a browser that never asks at all.
 *
 * Asked, not merely looked for. `@capacitor/core` also defines
 * `window.Capacitor` — in every environment, the moment anything imports it —
 * and the bundle imports it as soon as it uses a plugin. Checking that the name
 * exists was right while nothing did, and would have put every browser on the
 * server picker the day the first plugin arrived. The bridge answers
 * `isNativePlatform()` with true; the core, in a browser, with false.
 *
 * It matters because an empty origin means two different things. In a browser
 * it means "this page's own origin", which is the answer. In the app it means
 * "nobody has said yet", which is a question.
 */
export const isPackaged = (): boolean =>
  (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;

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

/**
 * What somebody typed into the picker, as the origin it means — or null.
 *
 * Phones are where addresses get typed by thumb and pasted out of a browser.
 * Two of those used to fail in a way that looked like success: a bare
 * `kolibri.example.com` stayed relative, so the check went to the app's own
 * bundle, which answers every path with `index.html` and a 200; and a pasted
 * `https://kolibri.example.com/inbox` became `…/inbox/api/session`, which is
 * the web build's fallback page rather than an API. A scheme is assumed when
 * none is given — https, because the address is where a bearer token goes —
 * and only the origin is kept, because Kolibri is served from the root of its
 * host: every route it has is written as an absolute path.
 */
export function serverAddress(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Did a Kolibri answer `/api/config`, or merely something?
 *
 * A 200 is not an answer to "is this a Kolibri". The app's own bundle gives
 * one for every path, and so do a captive portal, a parked domain and any
 * other single-page app behind the same proxy — and the client's `request`
 * turns a body it cannot parse into `{ message }` rather than an error. So the
 * picker asks for the two fields every version of the config has carried.
 */
export const isKolibriConfig = (answer: unknown): boolean =>
  !!answer && typeof answer === 'object'
  && typeof (answer as { version?: unknown }).version === 'string'
  && typeof (answer as { hasUsers?: unknown }).hasUsers === 'boolean';

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

/* ------------------------------------------------------- uploaded files */

/**
 * Uploaded files, in a client whose origin is not the server's.
 *
 * The server stores and returns every upload as a root-relative
 * `/files/<hash>/<name>`, and that route requires a session. In a browser both
 * are fine: the path is on the page's own origin and the cookie goes with it.
 * In the packaged app neither is — the path addresses the app's own bundle,
 * and an `<img>`, a CSS `url()` or an anchor cannot carry an `Authorization`
 * header. Measured against a seeded server: a bare GET is 401, the header is
 * 200, `?access_token=` is 200.
 *
 * So there are two answers, chosen by what the URL is for:
 *
 * - **Something drawn inside the WebView** — an image, an avatar, a cover —
 *   gets the server's origin and the session token in its query, the way the
 *   live stream already does because `EventSource` cannot set a header either.
 *   That URL never leaves the WebView. The token it carries is the one already
 *   in this app's storage, so it is no new exposure to script; the cost that
 *   is new is that a reverse proxy in front of the server may write it into an
 *   access log. `docs/mobile.md` says so where an operator will look.
 * - **Something opened** — an attachment link, "open original" — is never
 *   handed to the system browser with a token in it. The packaged app catches
 *   those links and fetches the file with the header instead; see
 *   `adapters/native/files.ts`.
 *
 * A browser gets every URL back exactly as it came in.
 */
const FILES = '/files/';
const TOKEN_PARAM = 'access_token';

/** An uploaded file's URL as an `<img>` or a CSS `url()` in this client can load it. */
export function fileSrc(url: string | null | undefined): string {
  if (!url) return '';
  if (!origin || !url.startsWith(FILES)) return url;
  if (!token) return origin + url;
  return `${origin}${url}${url.includes('?') ? '&' : '?'}${TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/** `src="…"` with a root-relative upload in it, in markup this app produced. */
const UPLOAD_SRC = /(<img\b[^>]*?\ssrc=)(["'])(\/files\/[^"']*)\2/gi;

/**
 * Rendered markup, with every uploaded image pointed where this client can load
 * it. For markdown, for HTML pages and for the HTML editor's surface — the three
 * places a string of markup becomes DOM — and nothing else: the markup that is
 * *stored* keeps saying `/files/…`, which is what every other client, the
 * export and the trash's reference counting read.
 */
export function withFileSources(html: string): string {
  if (!origin || !html.includes(FILES)) return html;
  return html.replace(UPLOAD_SRC, (_, before: string, quote: string, path: string) =>
    `${before}${quote}${fileSrc(path.replace(/&amp;/g, '&')).replace(/&/g, '&amp;')}${quote}`);
}

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The editor's way back: markup read out of an editable surface that
 * `withFileSources` wrote, as it should be stored.
 *
 * Without it the first save of an HTML page with a picture in it would have
 * written this device's session token into the page, for every reader of it and
 * every version after — and a URL on this server's origin instead of the path
 * that every other client resolves for itself.
 */
export function withoutFileSources(html: string): string {
  if (!origin || !html.includes(origin + FILES)) return html;
  const absolute = new RegExp(`(["'])${escapeForPattern(origin)}(/files/[^"']*)\\1`, 'g');
  return html.replace(absolute, (_, quote: string, rest: string) => {
    const path = filePath(rest.replace(/&amp;/g, '&')) ?? rest;
    return `${quote}${path.replace(/&/g, '&amp;')}${quote}`;
  });
}

/**
 * The upload an href names, as a root-relative path with no token in it — or
 * null when it names something else.
 *
 * Both spellings this client produces count: the stored `/files/…`, and what
 * `fileSrc` made of it on this server's origin. Anything else — another site,
 * a route in the app — is not a file and is left to whatever handles it.
 */
export function filePath(href: string | null | undefined): string | null {
  if (!href) return null;
  let rest: string;
  if (href.startsWith(FILES)) rest = href;
  else if (origin && href.startsWith(origin + FILES)) rest = href.slice(origin.length);
  else return null;
  const [path, query = ''] = rest.split('?', 2);
  const kept = query.split('&').filter((part) => part && !part.startsWith(`${TOKEN_PARAM}=`));
  return kept.length ? `${path}?${kept.join('&')}` : path;
}

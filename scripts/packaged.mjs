/**
 * The packaged app's way in, walked the way a phone loads it.
 *
 * A packaged app is served by Capacitor, not by Kolibri: the bundle comes from
 * `https://localhost` on Android and `capacitor://localhost` on iOS, and the
 * server is somewhere else. That much had been checked before, with the bundle
 * on one port and the API on another — and every fresh install still crashed
 * on its first frame, because the static server used for that check answered
 * `404` where Capacitor answers `200`. Both platforms' asset handlers serve
 * `index.html` for every path without an extension (`WebViewLocalServer` on
 * Android, the router behind `WebViewAssetHandler` on iOS). So the session
 * lookup that ran before anybody had named a server came back as a "session"
 * made of HTML, and `session.workspaces.find` ended the app on its error screen
 * before the server picker could draw.
 *
 * This walk answers the way Capacitor does — a file if there is one, otherwise
 * `index.html` with a 200 for anything extensionless — with `window.Capacitor`
 * present before the bundle runs, which is the signal `isPackaged` reads. What
 * it cannot be is a phone: the WebView here is Chromium's, and nothing about
 * signing, push or a launcher is reached from a browser.
 *
 * Nine claims:
 *
 *  - **A fresh install opens on the picker**, not on the error screen.
 *  - **A 200 is not a Kolibri.** The app's own origin answers `/api/config`
 *    with `index.html`; the picker has to refuse it, as it has to refuse a
 *    captive portal or a parked domain.
 *  - **An address pasted with a path keeps only its origin**, and sign-in names
 *    the host it is about to send a password to.
 *  - **Signing in leaves a bearer and sends nothing to the bundle** that was
 *    meant for the server.
 *  - **A cold start stays signed in**, because a phone kills a backgrounded app
 *    whenever it likes.
 *  - **An uploaded image draws**, from the server's origin with the session in
 *    its URL — an `<img>` cannot send a header, and `/files/…` on the bundle is
 *    a 404.
 *  - **A link to an upload is fetched with the header and the app stays put.**
 *    It is not routed as a screen, not navigated to on the bundle, and not
 *    handed to a browser with a token in it.
 *  - **An export is downloaded by the phone and handed to the share sheet** —
 *    with the session in a header, from the server rather than the bundle,
 *    under the name the server gives it, and with the app left where it was.
 *    It used to be a navigation, which took the whole app to `/api/…`.
 *  - **Signing out forgets the token, and the server can be changed** — which
 *    the picker promises and the sign-in screen once had no way to keep.
 *
 * Chromium's Local Network Access checks are switched off for the walk: they
 * treat a page fulfilled by Playwright as public and the API on loopback as
 * private, which is a fact about this harness and not about the app. Whether a
 * real WebView asks before reaching a LAN address is unmeasured — see
 * `docs/mobile.md`.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL, in English, and a web build
 * in `packages/web/dist`.
 * Run: node scripts/packaged.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = (process.env.KOLIBRI_URL ?? 'http://localhost:4400').replace(/\/+$/, '');
const DIST = fileURLToPath(new URL('../packages/web/dist/', import.meta.url));
const APP = 'https://localhost';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.log(`FAIL there is no web build in ${DIST} — run \`npm run build\` first`);
  process.exit(1);
}

const failures = [];
const check = (ok, label, detail) => {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.log(`FAIL ${label}\n       ${detail}`);
    failures.push(label);
  }
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults'],
});
// A phone's window, and no service worker: neither a WKWebView under
// `capacitor://` nor this harness would give the app one.
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
});
/* What the Android shell injects before the bundle: a bridge object, and the
   global the native bridge script defines. `@capacitor/core` reads the first to
   decide it is native — without it, the core that every plugin import brings in
   would report "web", and the app would be walked as a browser. Nothing answers
   on the bridge itself; the three plugins below answer through a recorder, and
   any other plugin call fails, which nothing this walk depends on makes. */
await context.addInitScript(() => {
  globalThis.androidBridge = { postMessage() {} };
  /*
   * The three plugins a file leaves the app through, answered by a recorder
   * standing where the native bridge would: `@capacitor/core` sends a plugin
   * call to `nativePromise` for any plugin the bridge lists in `PluginHeaders`.
   * Nothing is written and no sheet opens; what the walk gets is the exact
   * sequence of calls the app would have asked the phone to make, which is the
   * part of this that is ours. Every other plugin stays absent, as before.
   */
  const promised = (...names) => names.map((name) => ({ name, rtype: 'promise' }));
  globalThis.__native = [];
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    PluginHeaders: [
      { name: 'Filesystem', methods: promised('getUri', 'mkdir', 'rmdir', 'writeFile') },
      { name: 'FileTransfer', methods: promised('downloadFile') },
      { name: 'Share', methods: promised('share') },
    ],
    nativePromise: (plugin, method, options = {}) => {
      const seen = method === 'writeFile' ? { ...options, data: `${String(options.data ?? '').length} chars` } : options;
      globalThis.__native.push({ plugin, method, options: JSON.parse(JSON.stringify(seen)) });
      if (plugin === 'Filesystem' && (method === 'getUri' || method === 'writeFile')) {
        return Promise.resolve({ uri: `file:///cache/${options.path}` });
      }
      if (plugin === 'FileTransfer') return Promise.resolve({ path: options.path });
      return Promise.resolve({});
    },
  };
});

/** Paths under `/api/` or `/files/` that reached the bundle instead of the server. */
const misdirected = [];
await context.route(`${APP}/**`, (route) => {
  const { pathname } = new URL(route.request().url());
  if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) misdirected.push(pathname);
  const last = pathname.split('/').pop() ?? '';
  // Capacitor's rule, on both platforms: an extensionless path is the app.
  if (pathname === '/' || !last.includes('.')) {
    return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(DIST, 'index.html')) });
  }
  const file = join(DIST, decodeURIComponent(pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
});

const page = await context.newPage();
/* The screen boundary catches a render error and draws its own screen, so the
   page never sees an uncaught one: React reports it to the console instead. */
const crashes = [];
page.on('pageerror', (error) => crashes.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && /TypeError|ReferenceError/.test(message.text())) crashes.push(message.text().split('\n')[0]);
});
const stored = (key) => page.evaluate((k) => localStorage.getItem(k), key);

/**
 * Close the first-run guide, if it is open, and wait until it is gone.
 *
 * It opens over everything for a new device a moment after the screen does, and
 * while it is open the screen behind it is hidden from the accessibility tree
 * and its clicks land on the overlay. Not what this walk is about. `until` is
 * what the screen behind it should show once it is closed, so the wait is for
 * whichever of the two turns up rather than a glance that races the dialog.
 */
async function dismissGuide(until) {
  const skip = page.getByRole('button', { name: 'Skip' }).first();
  await skip.or(until).first().waitFor({ timeout: 15000 }).catch(() => undefined);
  if (await skip.isVisible()) {
    await skip.click().catch(() => undefined);
    await skip.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  }
}
const picker = () => page.getByRole('heading', { name: 'Which Kolibri?' });
const signInForm = () => page.locator('#email');

/* ------------------------------------------------------------ a fresh install */

await page.goto(`${APP}/`);
// Not the first frame, but the one after the network has settled: the picker
// used to draw and then be replaced, once the session lookup it raced came
// back from the bundle. A check that looked straight away passed with the bug.
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
const pickerShown = await picker().isVisible();
check(
  pickerShown && !crashes.length,
  'a fresh install opens on the server picker',
  crashes.length
    ? `the app threw before it drew: ${crashes[0]}`
    : 'no picker heading — the app is somewhere else, most likely its error screen',
);

/* Everything after this needs the picker, and asking a dead screen five more
   questions would report one fault as six. */
if (!pickerShown) {
  await browser.close();
  console.log('\nstopped: nothing past the picker can be walked without it');
  process.exit(1);
}

/* -------------------------------------------- a 200 that is not a Kolibri */

await page.locator('input').first().fill(APP).catch(() => undefined);
await page.locator('button[type=submit]').click().catch(() => undefined);
const refused = await page.getByRole('alert').waitFor({ timeout: 10000 }).then(() => true, () => false);
check(
  refused && !(await signInForm().count()) && (await stored('kolibri.server')) === null,
  'an address that answers 200 with a web page is refused',
  `the picker kept ${JSON.stringify(await stored('kolibri.server'))} — the app's own bundle was taken for a server`,
);

/* -------------------------------------- the real one, pasted with a path */

await page.locator('input').first().fill(`${base}/inbox?from=a-browser-tab`).catch(() => undefined);
await page.locator('button[type=submit]').click().catch(() => undefined);
await signInForm().waitFor({ timeout: 15000 }).catch(() => undefined);
const host = new URL(base).host;
check(
  (await stored('kolibri.server')) === new URL(base).origin
    && await page.getByText(`Signing in to ${host}`).isVisible().catch(() => false),
  'an address pasted with a path keeps only its origin, and sign-in names it',
  `stored ${JSON.stringify(await stored('kolibri.server'))}, expected ${JSON.stringify(new URL(base).origin)}`,
);

/* ------------------------------------------------------------- signing in */

misdirected.length = 0;
await signInForm().fill('ada@kolibri.dev', { timeout: 5000 }).catch(() => undefined);
await page.fill('#password', 'kolibri-demo', { timeout: 5000 }).catch(() => undefined);
await page.locator('button[type=submit]').click({ timeout: 5000 }).catch(() => undefined);
const signedIn = await page.waitForFunction(() => !document.querySelector('#email'), null, { timeout: 15000 })
  .then(() => true, () => false);
await page.waitForTimeout(1500);
check(
  signedIn && !!(await stored('kolibri.token')) && !misdirected.length,
  'signing in leaves a bearer, and nothing meant for the server goes to the bundle',
  !signedIn ? 'still on the sign-in form'
    : !(await stored('kolibri.token')) ? 'no token was kept — the server did not hand one back, or the client dropped it'
      : `went to the bundle: ${[...new Set(misdirected)].join(', ')}`,
);

/* -------------------------------------------------------------- cold start */

await page.goto(`${APP}/`);
await page.waitForTimeout(2500);
check(
  !(await signInForm().count()) && !(await picker().count()),
  'a cold start stays signed in',
  'the app asked again after a reload — the token or the address did not survive',
);

/* ---------------------------------------------------------- uploaded files */

// An image and a link to it, on a page, the way a person would write them.
const token = await stored('kolibri.token');
const workspace = await stored('kolibri.workspace');
const asApp = { authorization: `Bearer ${token}` };
const png = readFileSync(join(DIST, 'icon-192.png'));
const upload = await fetch(`${base}/api/workspaces/${workspace}/files`, {
  method: 'POST', headers: { ...asApp, 'content-type': 'image/png', 'x-filename': 'walk.png' }, body: png,
}).then((response) => response.json()).catch(() => ({}));
const made = await fetch(`${base}/api/workspaces/${workspace}/pages`, {
  method: 'POST', headers: { ...asApp, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Packaged walk', content: `![walk](${upload.url})\n\n[the original](${upload.url})\n` }),
}).then((response) => response.json()).catch(() => ({}));

misdirected.length = 0;
await page.goto(`${APP}/pages/${made.id}`);
const image = page.locator('.md img').first();
await dismissGuide(image);
await image.waitFor({ timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(1000);
const drawn = await image.evaluate((element) => ({ src: element.currentSrc, width: element.naturalWidth }))
  .catch(() => ({ src: '(no image on the page)', width: 0 }));
check(
  !!upload.url && drawn.width > 0 && drawn.src.startsWith(`${new URL(base).origin}/files/`) && !misdirected.length,
  'an uploaded image draws, from the server',
  !upload.url ? `the upload itself failed: ${JSON.stringify(upload).slice(0, 160)}`
    : `the image is ${drawn.width ? 'drawn' : 'not drawn'} from ${drawn.src}`
      + (misdirected.length ? `; asked of the bundle: ${[...new Set(misdirected)].join(', ')}` : ''),
);

const fetched = [];
// `allHeaders`, because `headers()` leaves out the security-related ones —
// `authorization` among them — and would report every fetch as anonymous.
page.on('request', (request) => {
  if (request.url().startsWith(`${base}/files/`)) void request.allHeaders().then((headers) => fetched.push(headers));
});
const opened = [];
context.on('page', (other) => opened.push(other.url()));
const before = page.url();
misdirected.length = 0;
await page.getByRole('link', { name: 'the original' }).click({ timeout: 5000 }).catch(() => undefined);
await page.waitForTimeout(1500);
const withHeader = fetched.some((headers) => headers.authorization === `Bearer ${token}`);
check(
  withHeader && page.url() === before && !opened.length && !misdirected.length,
  'a link to an upload is fetched with the header, and the app stays where it was',
  !withHeader ? 'the file was not fetched with the session header'
    : page.url() !== before ? `the app navigated to ${page.url()}`
      : opened.length ? `a window opened at ${opened[0]}`
        : `asked of the bundle: ${[...new Set(misdirected)].join(', ')}`,
);

/* ----------------------------------------------------------------- exports */

// The personal export: on every account, and streamed by the server like the
// archives and the backups, so it takes the same road they do.
misdirected.length = 0;
const exportButton = page.getByRole('button', { name: 'Download my data' });
await page.goto(`${APP}/settings?tab=data`);
await dismissGuide(exportButton);
const exportFrom = page.url();
const openedBefore = opened.length;
await page.evaluate(() => { globalThis.__native.length = 0; });
await exportButton.click({ timeout: 10000 }).catch(() => undefined);
await page.waitForTimeout(1500);
const calls = await page.evaluate(() => globalThis.__native);
const download = calls.find((call) => call.plugin === 'FileTransfer' && call.method === 'downloadFile');
const shared = calls.find((call) => call.plugin === 'Share' && call.method === 'share');
const exportName = `my-kolibri-data-${new Date().toISOString().slice(0, 10)}.json`;
check(
  download?.options.url === `${base}/api/me/export?download=1`
    && download.options.headers?.authorization === `Bearer ${token}`
    && download.options.path?.endsWith(`/${exportName}`)
    && shared?.options.files?.[0] === download.options.path
    && page.url() === exportFrom && opened.length === openedBefore && !misdirected.length,
  'an export is downloaded by the phone, with the session, and handed to the share sheet',
  !download ? `the phone was never asked to download it — the app asked for: ${calls.map((c) => `${c.plugin}.${c.method}`).join(', ') || 'nothing'}`
    : download.options.url !== `${base}/api/me/export?download=1` ? `it was asked to download ${download.options.url}`
      : download.options.headers?.authorization !== `Bearer ${token}` ? 'the download carries no session'
        : !download.options.path?.endsWith(`/${exportName}`) ? `it would be saved as ${download.options.path}`
          : !shared ? 'the file never reached the share sheet'
            : page.url() !== exportFrom ? `the app navigated to ${page.url()}`
              : `asked of the bundle: ${[...new Set(misdirected)].join(', ')}`,
);

/* ------------------------------------------ signing out, and moving server */

await page.goto(`${APP}/more`);
const signOut = page.getByRole('button', { name: 'Sign out' }).last();
await dismissGuide(signOut);
await signOut.click({ timeout: 10000 }).catch(() => undefined);
await signInForm().waitFor({ timeout: 15000 }).catch(() => undefined);
const tokenAfter = await stored('kolibri.token');
await page.getByRole('button', { name: 'Change server' }).click({ timeout: 5000 }).catch(() => undefined);
const backAtPicker = await picker().waitFor({ timeout: 10000 }).then(() => true, () => false);
check(
  tokenAfter === null && backAtPicker && (await stored('kolibri.server')) === null,
  'signing out forgets the token, and the server can be changed',
  tokenAfter !== null ? 'the token outlived the sign-out'
    : !backAtPicker ? 'no way back to the picker from the sign-in screen'
      : 'the old address was kept',
);

await browser.close();
console.log(failures.length
  ? `\n${failures.length} of 9 claims failed`
  : '\nthe packaged app finds its server, signs in, survives a cold start and lets go');
process.exit(failures.length ? 1 : 0);

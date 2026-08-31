import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The packaged app: the same bundle `vite build` writes, inside a native shell.
 *
 * There is no second client here. `webDir` is `dist`, so whatever the browser
 * gets is what the phone gets, and a screen fixed once is fixed in three
 * places. What the shell adds is a store listing, an icon on a home screen and
 * — later — a push token the web has no way to hold.
 *
 * The consequence that shapes the rest of the client is the origin. A packaged
 * app loads from `capacitor://localhost` on iOS and `https://localhost` on
 * Android, neither of which is the server, so a relative `/api/…` addresses the
 * app's own bundle and the session cookie is never sent. That is why the client
 * asks where its server is and carries a bearer token instead — see
 * `src/kernel/sync/server.ts`, which names these two origins for the same
 * reason.
 */
const config: CapacitorConfig = {
  /*
   * Reverse-DNS of a domain that is actually ours, and `client` because this
   * identifier names *this* program rather than the product: a server, an
   * agent or a second app would each want their own, and `day.kolibri` alone
   * would have spent the name on the first one to ship.
   *
   * Immutable once either store has seen it. Apple and Google both key an app's
   * identity, its signing and its purchase history off this string, and neither
   * lets you change it afterwards — a new one is a new app with no users.
   */
  appId: 'day.kolibri.client',
  appName: 'Kolibri',
  webDir: 'dist',
  server: {
    /*
     * Stated rather than left to the default, because `server.ts` documents
     * this exact origin as the reason the bearer path exists. If it ever
     * changed, the comment there would be wrong and nothing would say so.
     */
    androidScheme: 'https',
  },
  /*
   * The dark ground the manifest already declares, so the WebView paints it
   * instead of white while the bundle boots. Without it the first frame of a
   * cold start is a white flash on a dark phone.
   */
  backgroundColor: '#0b0d12',
  ios: {
    /*
     * The layout already handles the notch itself — `viewport-fit=cover` in
     * `index.html` and `env(safe-area-inset-*)` in six places in `app.css`. The
     * default inset would add the status bar height a second time, on top of
     * padding the CSS has already applied.
     */
    contentInset: 'never',
  },
};

export default config;

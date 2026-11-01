/**
 * The Content-Security-Policy the app serves on every response.
 *
 * Same-origin by design, so the policy can be strict.
 *
 * `style-src` has to allow inline: React writes `style` attributes, and the
 * board's moving card is positioned that way. Scripts are bundled files and
 * need no exception, which is the half that matters — a CSP that allows inline
 * script is a CSP that stops nothing. `img-src` allows `data:` and `blob:`
 * because uploads are previewed from a blob before they reach the server.
 *
 * The one thing that is not same-origin: with an object store and pre-signed
 * downloads, `/files/:hash` redirects the browser to MinIO or S3. That origin
 * has to be named or every attachment in the default docker-compose deployment
 * fails silently — the redirect is followed, the bytes arrive, and the policy
 * throws them away. This is why the policy is computed rather than a constant.
 */

/** The parts of the storage configuration the policy depends on. */
export interface StorageOrigin {
  kind: string;
  presign: boolean;
  publicEndpoint: string;
  s3: { endpoint: string };
}

/**
 * The origin the browser will be redirected to for a download, or null when
 * the app serves the bytes itself and the policy needs no exception.
 */
export function storageOrigin(storage: StorageOrigin): string | null {
  if (storage.kind !== 's3' || !storage.presign) return null;
  const endpoint = storage.publicEndpoint || storage.s3.endpoint;
  try {
    return new URL(endpoint).origin;
  } catch {
    // A malformed endpoint is the storage layer's problem to report, not a
    // reason to ship a policy with a hole in it.
    return null;
  }
}

export function buildCsp(storage: StorageOrigin): string {
  const store = storageOrigin(storage);
  const also = store ? ` ${store}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${also}`,
    "font-src 'self'",
    `connect-src 'self'${also}`,
    `media-src 'self' blob:${also}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * The policy for the one document that is not the app: the frame an artboard
 * on a canvas is drawn in (`web/public/artboard.html`).
 *
 * The opposite bargain to the app's. A board is somebody's whole HTML page —
 * Claude writes them with inline scripts and styles as a matter of course — so
 * scripts have to run, inline and through `eval`. What makes that safe is what
 * they are kept *from*:
 *
 * - `sandbox allow-scripts` gives the document an opaque origin, so it can read
 *   neither the app's cookies nor its storage nor its IndexedDB — where the
 *   offline copy of the whole workspace lives — and cannot reach into the page
 *   that holds it. The iframe carries the same attribute; this is the same
 *   promise for somebody who opens the file on its own.
 * - `connect-src 'none'`, and nothing but `data:` and `blob:` for pictures and
 *   fonts: a board cannot send what it shows anywhere, nor load a beacon.
 * - `frame-ancestors 'self'`: only this app may hold it.
 *
 * Measured in Chromium before it was written: inline script, inline handlers,
 * `eval` and styles all work, and every one of the escapes above is refused.
 * See `docs/canvas.md` for the table.
 */
export function buildFrameCsp({ popups = false }: { popups?: boolean } = {}): string {
  return [
    // A shared board has no app around it to open its links, so there it may
    // open them itself — in a new tab, outside the sandbox, which is what a
    // link on any page does. Inside the app the app opens them instead.
    popups ? 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox' : 'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Where the frame is served from, relative to the web build. */
export const FRAME_FILE = 'artboard.html';

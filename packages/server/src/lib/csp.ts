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

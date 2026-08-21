/**
 * What a browser may be told to render in place.
 *
 * An allowlist, not a denylist, because the uploader chooses the content type
 * and a document that can carry script — SVG, HTML, XML — is a document
 * whether or not it admits to being one. Everything outside this set is served
 * as a download with a neutral type.
 *
 * It lives on its own because two very different places have to agree about
 * it: the response this server writes when it serves the bytes, and the signed
 * URL it hands out when an object store serves them instead. The store obeys
 * whatever the URL says, so a URL that said `inline` for everything undid the
 * protection the moment anybody switched storage on — which is exactly what
 * happened.
 */
export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'application/pdf', 'text/plain', 'text/markdown', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg',
]);

/** What to do with this, and what to call it while doing it. */
export const disposition = (mime: string): { inline: boolean; type: string } =>
  (INLINE_TYPES.has(mime) ? { inline: true, type: mime } : { inline: false, type: 'application/octet-stream' });

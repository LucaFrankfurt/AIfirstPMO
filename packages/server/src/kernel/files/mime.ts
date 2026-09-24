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

/**
 * The `Content-Disposition` for a file called `name`, in a form any header can
 * carry: RFC 6266's pair whenever the name is not plain ASCII.
 *
 * Every download used to write the name straight in, and the header could not
 * always hold it. Node refuses any character above U+00FF there, so a file
 * called `Angebot – Firma.pdf` uploaded with a 200 and downloaded with a 500,
 * and a mail attachment called that could not be downloaded at all — while a
 * name the header could hold, `Müller.pdf`, went out as Latin-1 bytes for each
 * client to decode however it guessed. Now
 * `filename` carries an ASCII stand-in for clients that know nothing newer, and
 * `filename*` the name itself as UTF-8 (RFC 8187), which current browsers take.
 * The object store is told the same value, so both paths name a file alike.
 *
 * Whatever would end the header or its quoted string — a line break, a quote,
 * a backslash — is replaced first, in both, whoever called this.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const safe = name.replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const ascii = safe.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/gu, '_');
  const plain = `${kind}; filename="${ascii}"`;
  return ascii === safe ? plain : `${plain}; filename*=UTF-8''${extValue(safe)}`;
}

/** RFC 8187's `attr-char`: the only bytes a `filename*` may carry unencoded. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * The UTF-8 bytes, each outside `attr-char` percent-encoded. Bytes rather than
 * `encodeURIComponent`, which leaves `'`, `(`, `)` and `*` alone where the
 * grammar does not — and a bare `'` is what closes the charset — and which
 * throws on half a surrogate pair, where `Buffer` writes U+FFFD.
 */
const extValue = (value: string): string =>
  [...Buffer.from(value, 'utf8')]
    .map((byte) => String.fromCharCode(byte))
    .map((char) => (ATTR_CHAR.test(char) ? char : `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');

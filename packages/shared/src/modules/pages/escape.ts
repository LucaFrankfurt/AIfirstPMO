/**
 * The three string rules everything that produces markup here obeys.
 *
 * `escapeHtml` was written out three times over — the markdown renderer, the
 * page printer on the client, the share route on the server — and `safeUrl`
 * once, private to the renderer, which is why the printer and the share route
 * never checked one at all. Three copies that agree today are three copies, and
 * a rule about what may reach a browser is exactly the kind of thing where the
 * one somebody forgets to update is the one that lets something through.
 */

/** The five characters that can end a text run and start markup. */
export const escapeHtml = (text: string): string =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The exact inverse, for text that has to be read back. */
export const unescapeHtml = (text: string): string =>
  String(text ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name] ?? name));

/**
 * Only same-origin uploads and plain web links survive.
 *
 * An allowlist rather than a blocklist of `javascript:` and friends, because a
 * blocklist has to be right about every scheme a browser will ever invent and
 * about every way of spelling one — `java\tscript:`, `JaVaScRiPt:`, a leading
 * NUL. This has to be right about four.
 *
 * `data:` is refused along with everything else. It is tempting for an imported
 * document that carries its pictures inline, and it is also `data:text/html`,
 * which is a page of somebody else's choosing on this origin.
 */
export function safeUrl(raw: string): string | null {
  const url = String(raw ?? '').trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (url.startsWith('#')) return url;
  return null;
}

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
 *
 * **A path is checked as a URL parser would read it, not as it is written.**
 * `//evil.example` was always refused; `/\evil.example` was not, and a browser
 * resolves the two identically — for a special scheme the WHATWG parser treats
 * `\` as `/`, and it removes every tab and newline *before* it looks at
 * anything. So `/\evil.example`, `/\/evil.example` and `/<tab>/evil.example`
 * were three spellings of an off-site link wearing an internal one's clothes:
 * no `target="_blank"`, no `rel="noopener"`, and on a share page or in an
 * exported HTML file no router to intercept the click either. The decision is
 * taken on the parsed form; what is returned is what the author wrote, because
 * rewriting somebody's URL is a second surprise on top of the first.
 */
export function safeUrl(raw: string): string | null {
  // The leading and trailing bytes a URL parser strips before it does anything,
  // so a scheme cannot be spelled around the test below with a leading NUL.
  const url = String(raw ?? '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith('#')) return url;
  if (!url.startsWith('/')) return null;
  // What the browser will actually see: tabs and newlines gone, backslashes
  // read as slashes. Two of those and it is an authority, not a path.
  const parsed = url.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  return parsed.startsWith('//') ? null : url;
}

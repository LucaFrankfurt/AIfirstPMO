/**
 * HTML a page is allowed to be, and what it can be turned into.
 *
 * The markdown renderer next door escapes first and only ever emits tags it
 * wrote itself, which is why raw HTML never survives it. That is the right
 * answer for a chat message and the wrong one for a page somebody exported out
 * of Confluence, a mail they want to keep, or a table with a colspan in it that
 * markdown cannot spell. So a page may now *be* HTML — and the moment it can,
 * something has to decide what "HTML" means here.
 *
 * This does, in one place, three ways:
 *
 * - `parseHtml` reads the string into a tree. Tolerantly, the way a browser
 *   does: unbalanced tags close themselves, a `<p>` ends at the next block, and
 *   anything unrecognisable is text.
 * - `sanitizeHtml` writes that tree back out through an **allowlist**. Nothing
 *   reaches a reader that is not on it — no script, no style, no event handler,
 *   no `javascript:`, no `data:`, and no class that could reach the app's own
 *   stylesheet and cover the screen with it.
 * - `htmlToMarkdown` writes it out as markdown instead, which is what an import
 *   and a paste use, and what makes an HTML page exportable as text.
 *
 * All of it is pure string in, string out, and none of it needs a DOM: the
 * server sanitises a shared page with no browser anywhere near it, and the
 * client sanitises what a contenteditable hands back. One implementation, and
 * therefore one answer, is the entire point — a sanitiser that runs on one side
 * only is a sanitiser somebody will find the other way round.
 */

import { escapeHtml, safeUrl } from './escape.ts';
import { slugCounter, splitTarget, type Heading } from './links.ts';

/* --------------------------------------------------------------- the tree */

/** An element. `attrs` is what the source said, before any policy is applied. */
export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

/** A text run is a plain string; entities in it are still spelled as entities. */
export type HtmlNode = string | HtmlElement;

const isElement = (node: HtmlNode): node is HtmlElement => typeof node !== 'string';

/** The text of an element and everything under it, with no markup at all. */
const flatten = (nodes: HtmlNode[]): string =>
  nodes.map((node) => (isElement(node) ? flatten(node.children) : unescapeEntities(node))).join('');

/** Elements that never have children, however the author spelled them. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Elements whose content is text rather than markup.
 *
 * The parser has to know, or `<script>if (a < b) …</script>` opens an element
 * called `b`. They are dropped by every policy below — but they are dropped
 * *with their content*, and finding where that content ends is this set's job.
 */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** Block-level tags, for the one rule that says where an open `<p>` ends. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dt', 'dd', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Whether an open element ends because this one is starting.
 *
 * Real documents leave tags open — `<p>` almost never gets a `</p>` in hand
 * written HTML, and a `<li>` closed by the next `<li>` is how every list on the
 * web is written. Without this the tree comes out nested a hundred deep and the
 * markdown made from it is a staircase.
 */
function closedBy(open: string, next: string): boolean {
  switch (open) {
    case 'p': return BLOCK.has(next);
    case 'li': return next === 'li';
    case 'dt': case 'dd': return next === 'dt' || next === 'dd';
    case 'tr': return next === 'tr' || next === 'thead' || next === 'tbody' || next === 'tfoot';
    case 'td': case 'th': return next === 'td' || next === 'th' || next === 'tr' || next === 'tbody' || next === 'tfoot';
    case 'thead': case 'tbody': case 'tfoot': return next === 'thead' || next === 'tbody' || next === 'tfoot';
    case 'option': return next === 'option';
    default: return false;
  }
}

const OPEN_NAME = /^<([A-Za-z][\w:.-]*)/;
const CLOSE_TAG = /^<\/([A-Za-z][\w:.-]*)[^>]*>/;
const ATTRIBUTE = /([A-Za-z_:@][-\w:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'`<>]+))?/g;

/**
 * Where the tag opening at `from` ends, honouring quoted attribute values.
 *
 * A hand-written scan rather than the obvious one regex,
 * `(?:[^>"']|"[^"]*"|'[^']*')*>`. That form is correct and carries a quantifier
 * inside a quantifier, which on a document full of unbalanced quotes degrades
 * quadratically — and a page body is not a trusted length. A sanitiser that can
 * be made to hang the tab it is protecting has a denial of service in it.
 *
 * `-1` for a tag nobody closed, which the caller reads back as a literal `<`.
 */
function tagEnd(text: string, from: number): number {
  let quote = '';
  for (let at = from; at < text.length; at += 1) {
    const character = text[at];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return at;
  }
  return -1;
}

function attributesOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    let value = match[2] ?? '';
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    // First wins: a tag carrying `href` twice is somebody trying something, and
    // the browser's own answer (first one) is the one to agree with.
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/**
 * The document as a tree.
 *
 * Deliberately forgiving and deliberately not a browser: there is no implied
 * `<tbody>`, no foster parenting, no character-encoding sniffing. What it has
 * to be right about is where an element ends, because everything downstream —
 * the allowlist, the markdown, the plain text — walks what comes out of here.
 */
export function parseHtml(source: string): HtmlNode[] {
  const root: HtmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const text = String(source ?? '');
  let buffer = '';
  let at = 0;

  const flush = (): void => {
    if (!buffer) return;
    stack[stack.length - 1].children.push(buffer);
    buffer = '';
  };

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt === -1) {
      buffer += text.slice(at);
      break;
    }
    buffer += text.slice(at, lt);
    const rest = text.slice(lt);

    if (rest.startsWith('<!--')) {
      const end = text.indexOf('-->', lt + 4);
      at = end === -1 ? text.length : end + 3;
      continue;
    }
    // A doctype, a processing instruction, a CDATA section: all of them say
    // something about the document rather than in it.
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const end = text.indexOf('>', lt);
      at = end === -1 ? text.length : end + 1;
      continue;
    }

    const close = CLOSE_TAG.exec(rest);
    if (close) {
      const tag = close[1].toLowerCase();
      flush();
      // Up to the matching open, if there is one — and nothing at all if there
      // is not, because a stray `</div>` must not close the document.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag !== tag) continue;
        stack.length = i;
        break;
      }
      at = lt + close[0].length;
      continue;
    }

    const open = OPEN_NAME.exec(rest);
    const end = open ? tagEnd(text, lt + open[0].length) : -1;
    if (!open || end === -1) {
      // A `<` that starts nothing, or a tag nobody closed, is a `<`. Somebody
      // wrote `a < b`.
      buffer += '<';
      at = lt + 1;
      continue;
    }
    flush();
    const tag = open[1].toLowerCase();
    const raw = text.slice(lt + open[0].length, end);
    const element: HtmlElement = { tag, attrs: attributesOf(raw), children: [] };
    at = end + 1;

    while (stack.length > 1 && closedBy(stack[stack.length - 1].tag, tag)) stack.pop();
    stack[stack.length - 1].children.push(element);

    if (VOID.has(tag) || raw.trimEnd().endsWith('/')) continue;
    if (RAW_TEXT.has(tag)) {
      const end = text.toLowerCase().indexOf(`</${tag}`, at);
      element.children.push(text.slice(at, end === -1 ? text.length : end));
      at = end === -1 ? text.length : (text.indexOf('>', end) === -1 ? text.length : text.indexOf('>', end) + 1);
      continue;
    }
    stack.push(element);
  }
  flush();
  return root.children;
}

/* ------------------------------------------------------------ the allowlist */

/**
 * Elements that go, and take their content with them.
 *
 * The distinction from "unknown" matters. An unknown tag is unwrapped — a
 * `<font>` or Word's `<o:p>` around a sentence should leave the sentence. These
 * are different: whatever is inside a `<script>` or a `<head>` is not prose that
 * lost its wrapper, it is instructions, and unwrapping it would print them.
 */
const DROPPED = new Set([
  'script', 'style', 'head', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'button', 'select', 'option', 'optgroup', 'textarea', 'label', 'fieldset', 'legend',
  'template', 'noscript', 'svg', 'math', 'link', 'meta', 'base', 'canvas', 'audio', 'video',
  'source', 'track', 'map', 'area', 'dialog', 'slot', 'portal', 'title',
]);

/**
 * Everything a page may say, and the attributes each one may carry.
 *
 * `[]` means "the global attributes and nothing else". Adding a tag here is a
 * decision about what a document can do to the reader's screen, so the list is
 * short and every widening of it should have to be argued for.
 */
const ALLOWED: Record<string, readonly string[]> = {
  p: [], br: [], hr: [], div: [], span: [], section: [], article: [], main: [], aside: [],
  header: [], footer: [], nav: [], blockquote: ['cite'], pre: [], figure: [], figcaption: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ['start', 'reversed'], li: ['value'], dl: [], dt: [], dd: [],
  a: ['href'], strong: [], b: [], em: [], i: [], u: [], s: [], del: [], ins: [], mark: [],
  small: [], sub: [], sup: [], abbr: [], code: [], kbd: [], samp: [], var: [], q: ['cite'],
  cite: [], time: ['datetime'], bdi: [], bdo: [], wbr: [], ruby: [], rt: [], rp: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], caption: [], colgroup: [], col: ['span'],
  th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'],
  img: ['src', 'alt', 'width', 'height'],
  details: ['open'], summary: [],
  // A checkbox, and only ever a disabled one — see `attributeFor`. This is what
  // makes a task list survive the round trip through HTML, and it is the whole
  // reason a form control is on this list at all.
  input: ['type', 'checked', 'disabled'],
};

const GLOBAL = ['title', 'lang', 'dir', 'class', 'id', 'style'] as const;

/**
 * Classes a page may keep.
 *
 * Not "any class", and this is the trap worth naming: the app's stylesheet is
 * on the same document, so `class="fixed inset-0 z-50 bg-bg"` on a `<div>` is a
 * page painting itself over the interface — no script needed, and every
 * sanitiser that thinks about scripts alone lets it through. Two families
 * survive: the language of a code block, and the renderer's own `md-` marks.
 */
const CLASS_SHAPE = /^(?:language-[\w+#.-]{1,24}|md-[\w-]{1,24})$/;

/** The only declaration a page may set, and the only four values it may set it to. */
const ALIGNMENT = /^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i;

const NUMBER = /^\d{1,4}$/;

export interface SanitizeOptions {
  /**
   * Kept ids get this in front of them.
   *
   * Without it they are dropped. An id is a name in a namespace the whole
   * document shares, and a page that calls something `root` or `main-nav` is
   * one `getElementById` away from the app finding it instead of its own.
   */
  idPrefix?: string;
  /**
   * Given, every heading is *given* an id — `<prefix><slug>` — whatever id it
   * arrived with.
   *
   * The same contract `renderMarkdown` has, and the same slug maker behind it,
   * so an outline drawn beside an HTML page links to the same anchors it would
   * beside a markdown one. Overriding rather than keeping the author's id is
   * deliberate: `htmlOutline` computes the target from the heading's words, and
   * an outline whose links depend on whether the source happened to carry ids
   * is an outline that works on some pages.
   */
  headingPrefix?: string;
  /**
   * Where `[[Onboarding]]` points, when a page wants its wiki links resolved.
   *
   * The same contract `renderMarkdown` takes, and here for the same reason it
   * is there: `[[…]]` is meant to answer everywhere prose is rendered, and a
   * syntax that works in one box and not the next is a syntax nobody trusts.
   *
   * It was not only inconsistent, it was *wrong*: `linkGraph` reads `[[…]]` out
   * of any page's text, so a link written inside an HTML page counted in the
   * graph, appeared in the backlinks of the page it named, and showed up under
   * "linked to, not written yet" — while the page itself rendered it as four
   * literal brackets. The graph claimed a link that did not exist on screen.
   *
   * Left out, the brackets stay as the author typed them, which is what the
   * server wants when it renders for somebody with no workspace to link into.
   */
  pageHref?: (target: string, heading: string | null) => { href: string; missing?: boolean } | undefined;
  /** Whether an off-site link opens in a new tab. On by default. */
  externalLinks?: boolean;
  /** Block-level tags start on their own line — for a source editor to show. */
  pretty?: boolean;
}

/**
 * One attribute, as it will be written — or `null`, which is most of them.
 *
 * Everything arrives here: `onclick`, `srcdoc`, `formaction`, `xlink:href`,
 * whatever an attacker or Microsoft Word thought of. Anything this function
 * does not name explicitly is dropped, which is why an `on*` handler needs no
 * rule of its own.
 */
function attributeFor(tag: string, name: string, raw: string, opts: SanitizeOptions): string | null {
  const value = String(raw ?? '');
  switch (name) {
    case 'href': {
      if (tag !== 'a') return null;
      const url = safeUrl(value);
      return url ? `href="${escapeHtml(url)}"` : null;
    }
    case 'src': {
      if (tag !== 'img') return null;
      const url = safeUrl(value);
      return url ? `src="${escapeHtml(url)}" loading="lazy"` : null;
    }
    case 'class': {
      const kept = value.split(/\s+/).filter((one) => CLASS_SHAPE.test(one));
      return kept.length ? `class="${escapeHtml(kept.join(' '))}"` : null;
    }
    case 'id':
      return opts.idPrefix && /^[\w-]{1,64}$/.test(value) ? `id="${escapeHtml(opts.idPrefix + value)}"` : null;
    case 'style':
      return ALIGNMENT.test(value) ? `style="text-align:${value.split(':')[1].replace(/[^a-z]/gi, '')}"` : null;
    case 'dir':
      return /^(ltr|rtl|auto)$/i.test(value) ? `dir="${value.toLowerCase()}"` : null;
    case 'type':
      // The one type, so `input` cannot become a text field, a file picker or
      // a submit button by saying so.
      return tag === 'input' && value.toLowerCase() === 'checkbox' ? 'type="checkbox"' : null;
    case 'checked': case 'disabled': case 'reversed': case 'open':
      return name;
    case 'width': case 'height': case 'colspan': case 'rowspan': case 'start': case 'span': case 'value':
      return NUMBER.test(value) ? `${name}="${value}"` : null;
    case 'scope':
      return /^(row|col|rowgroup|colgroup)$/i.test(value) ? `scope="${value.toLowerCase()}"` : null;
    case 'cite': {
      const url = safeUrl(value);
      return url ? `cite="${escapeHtml(url)}"` : null;
    }
    case 'title': case 'alt': case 'lang': case 'datetime':
      return `${name}="${escapeHtml(value.slice(0, 300))}"`;
    default:
      return null;
  }
}

/**
 * Text, as text.
 *
 * `&` is only escaped where it is not already an entity, so a document that
 * says `&amp;` still says `&amp;` after a round trip instead of `&amp;amp;` —
 * which is what a naive escape does, and what turns every ampersand in an
 * imported document into a visible one more each time it is saved.
 */
const escapeText = (text: string): string =>
  text
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]{1,31};|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Elements whose text is quoted rather than written.
 *
 * Inside an `<a>` a second link cannot be nested; inside `<code>` and `<pre>`
 * the brackets are the point. Everywhere else a `[[…]]` in a text run is what
 * somebody meant.
 */
const LITERAL = new Set(['a', 'code', 'pre', 'kbd', 'samp']);

const WIKI_LINK = /\[\[([^[\]|\n]*)(?:\|([^[\]\n]*))?\]\]/g;

/**
 * A text run, escaped, with its `[[…]]` turned into links.
 *
 * Applied to text runs only — never to an attribute, never to markup — so
 * there is nothing here that can reach outside the text it was given. The
 * target arrives escaped, because escaping happens first, so it is decoded
 * before it is looked up: `[[Tools &amp; toys]]` is a link to the page called
 * `Tools & toys`, and skipping that step made it a link to a page nobody has.
 */
function textRun(text: string, opts: SanitizeOptions): string {
  const escaped = escapeText(text);
  if (!opts.pageHref) return escaped;
  return escaped.replace(WIKI_LINK, (match, raw: string, alias: string | undefined) => {
    const { target, heading } = splitTarget(unescapeEntities(raw));
    if (!target && !heading) return match;
    const found = opts.pageHref!(target, heading);
    if (!found) return match;
    // What it is called, when the author did not say: the section if the link
    // named one, otherwise the page — the same reading markdown gives it.
    const label = (alias ?? '').trim() || escapeText(heading || target);
    return `<a class="md-page${found.missing ? ' md-page-new' : ''}" href="${escapeHtml(found.href)}">${label}</a>`;
  });
}

/**
 * The document, written back out through the allowlist.
 *
 * Idempotent by construction — sanitising sanitised HTML changes nothing —
 * which is what lets the editor sanitise on every keystroke and the renderer
 * sanitise again before painting, without the two disagreeing.
 */
export function sanitizeHtml(source: string, options: SanitizeOptions = {}): string {
  const opts = { externalLinks: true, ...options };
  const out: string[] = [];
  const slug = slugCounter();
  /*
   * A break between blocks, and never two of them.
   *
   * Written as "add one unless there is one already" rather than as a
   * `\n{2,}` collapse over the finished string, which is what it was first and
   * was quietly wrong: that collapse cannot tell the newlines this function
   * added from the ones inside a `<pre>`, so tidying a page took the blank
   * lines out of its code blocks.
   */
  const newline = (): void => {
    if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n');
  };

  /** How deep inside an `<a>`, `<code>` or `<pre>` the walk currently is. */
  let literal = 0;

  const write = (nodes: HtmlNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node)) {
        out.push(literal ? escapeText(node) : textRun(node, opts));
        continue;
      }
      if (DROPPED.has(node.tag)) continue;
      const extra = ALLOWED[node.tag];
      // Unknown, so the tag goes and what it wrapped stays. `<html>`, `<body>`,
      // `<font>` and Word's `<o:p>` all land here, which is why pasting from a
      // word processor produces prose rather than a nest of dead wrappers.
      if (!extra) {
        write(node.children);
        continue;
      }
      // An `<input>` that is not a checkbox is a form control with no form.
      if (node.tag === 'input' && (node.attrs.type ?? '').toLowerCase() !== 'checkbox') continue;

      const attrs: string[] = [];
      const heading = opts.headingPrefix !== undefined && HEADINGS.has(node.tag);
      for (const name of [...extra, ...GLOBAL]) {
        if (!(name in node.attrs) || (heading && name === 'id')) continue;
        const written = attributeFor(node.tag, name, node.attrs[name], opts);
        if (written) attrs.push(written);
      }
      if (heading) attrs.push(`id="${escapeHtml(opts.headingPrefix + slug(flatten(node.children)))}"`);
      if (node.tag === 'a' && opts.externalLinks && /^https?:/i.test(node.attrs.href ?? '')) {
        attrs.push('target="_blank"', 'rel="noopener noreferrer"');
      }
      // Never interactive, however it arrived: the box is a picture of a state
      // the text holds, and a reader ticking one would be told a lie.
      if (node.tag === 'input') attrs.push('disabled');

      const breaks = opts.pretty && BLOCK.has(node.tag);
      if (breaks) newline();
      out.push(`<${node.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
      if (VOID.has(node.tag)) continue;
      if (LITERAL.has(node.tag)) literal += 1;
      write(node.children);
      if (LITERAL.has(node.tag)) literal -= 1;
      out.push(`</${node.tag}>`);
      if (breaks) newline();
    }
  };

  write(parseHtml(source));
  const html = out.join('');
  return opts.pretty ? html.trim() : html;
}

/** Sanitised and laid out to be read as source. What the HTML editor tidies with. */
export const formatHtml = (source: string): string => sanitizeHtml(source, { pretty: true });

/* --------------------------------------------------------------- plain text */

/**
 * What the document says, with none of how it says it.
 *
 * For the search index and for a preview line. Block boundaries become spaces,
 * because "…the end.Next heading" is one word to a tokeniser and two to a
 * reader, and the index should agree with the reader.
 */
export function htmlText(source: string): string {
  const parts: string[] = [];
  const walk = (nodes: HtmlNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node)) {
        parts.push(unescapeEntities(node));
        continue;
      }
      if (DROPPED.has(node.tag)) continue;
      if (BLOCK.has(node.tag) || node.tag === 'br') parts.push(' ');
      walk(node.children);
      if (BLOCK.has(node.tag)) parts.push(' ');
    }
  };
  walk(parseHtml(source));
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * The title a document carries, for an import that has to call it something.
 *
 * `<title>` first because that is where a saved web page keeps it, then the
 * first heading, which is where a fragment of a document keeps it. Neither is
 * the filename, which is the caller's fallback and a poor one — `export (3)`.
 */
export function htmlTitle(source: string): string | null {
  const nodes = parseHtml(source);
  const find = (list: HtmlNode[], want: (tag: string) => boolean): HtmlElement | null => {
    for (const node of list) {
      if (!isElement(node)) continue;
      if (want(node.tag)) return node;
      const deeper = find(node.children, want);
      if (deeper) return deeper;
    }
    return null;
  };
  for (const want of [(tag: string) => tag === 'title', (tag: string) => /^h[1-3]$/.test(tag)]) {
    const found = find(nodes, want);
    const text = found ? htmlText(serializeText(found.children)) : '';
    if (text.trim()) return text.trim().slice(0, 200);
  }
  return null;
}

/** The children of a node, back as a string. Only used to re-read a title. */
const serializeText = (nodes: HtmlNode[]): string =>
  nodes.map((node) => (isElement(node) ? serializeText(node.children) : node)).join('');

/**
 * The headings of an HTML page, for the outline beside it.
 *
 * The counterpart of `outlineOf` next door, down to the slug maker, because the
 * outline is the same control on both kinds of page and the anchors it points
 * at are written by `sanitizeHtml` from this same counting. Two implementations
 * of "what is this document's third heading called" would drift the first time
 * one of them learned about a duplicate title.
 */
export function htmlOutline(source: string): Heading[] {
  const slug = slugCounter();
  const out: Heading[] = [];
  const walk = (nodes: HtmlNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node) || DROPPED.has(node.tag)) continue;
      if (!HEADINGS.has(node.tag)) {
        walk(node.children);
        continue;
      }
      const text = flatten(node.children).replace(/\s+/g, ' ').trim();
      out.push({ level: Number(node.tag[1]), text, slug: slug(text) });
    }
  };
  walk(parseHtml(source));
  return out;
}

/**
 * Whether a string is a document rather than prose that mentions a tag.
 *
 * Asked of a pasted clipboard and of a dropped file, and wrong in both
 * directions is annoying: markdown treated as HTML loses its `#` headings, and
 * an HTML file treated as markdown is read as a page of angle brackets. So it
 * takes either an unmistakable envelope, or two different structural tags —
 * one `<br>` in a paragraph of markdown is not a document.
 */
export function looksLikeHtml(source: string): boolean {
  const text = String(source ?? '');
  if (/<!doctype html|<html[\s>]|<body[\s>]|<meta\s/i.test(text)) return true;
  const tags = new Set(
    [...text.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)].map((m) => m[1].toLowerCase())
      .filter((tag) => ALLOWED[tag] !== undefined && tag !== 'br'),
  );
  return tags.size >= 2;
}

/* ------------------------------------------------------------- to markdown */

/** The named entities worth knowing, plus every numeric one. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', bull: '•', middot: '·',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', euro: '€', pound: '£', deg: '°',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
};

const unescapeEntities = (text: string): string =>
  String(text ?? '').replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });

/** Characters that would mean something else once the text is markdown again. */
const escapeMarkdown = (text: string): string => text.replace(/([\\`*[\]])/g, '\\$1');

const childrenOf = (node: HtmlElement, tag: string): HtmlElement[] =>
  node.children.filter((child): child is HtmlElement => isElement(child) && child.tag === tag);

/** Every `tr` under a table, wherever its author put the row groups. */
function rowsOf(table: HtmlElement): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (nodes: HtmlNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      if (node.tag === 'tr') out.push(node);
      else if (node.tag === 'thead' || node.tag === 'tbody' || node.tag === 'tfoot') walk(node.children);
    }
  };
  walk(table.children);
  return out;
}

function inline(nodes: HtmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (!isElement(node)) {
      out += escapeMarkdown(unescapeEntities(node)).replace(/\s+/g, ' ');
      continue;
    }
    if (DROPPED.has(node.tag)) continue;
    const inner = inline(node.children);
    switch (node.tag) {
      case 'strong': case 'b': out += inner.trim() ? `**${inner.trim()}**` : ''; break;
      case 'em': case 'i': out += inner.trim() ? `_${inner.trim()}_` : ''; break;
      case 'del': case 's': case 'strike': out += inner.trim() ? `~~${inner.trim()}~~` : ''; break;
      // Backticks rather than `\``-escaped text: the content of a code span is
      // literal, so it is taken from the source flat and not through `inline`.
      case 'code': case 'kbd': case 'samp': case 'var': {
        const literal = flatten(node.children).replace(/\s+/g, ' ').trim();
        out += literal ? `\`${literal}\`` : '';
        break;
      }
      case 'br': out += '  \n'; break;
      case 'img': {
        const url = safeUrl(node.attrs.src ?? '');
        if (url) out += `![${unescapeEntities(node.attrs.alt ?? '').replace(/[[\]]/g, '')}](${url})`;
        break;
      }
      case 'a': {
        const url = safeUrl(node.attrs.href ?? '');
        const label = inner.trim() || (url ?? '');
        // A link with no usable target is its own words. Dropping the label with
        // the link is how an imported page loses whole sentences to a `#` href.
        out += url && label ? `[${label}](${url})` : label;
        break;
      }
      default: out += inner;
    }
  }
  return out;
}

/** A run of text put under something — a quote's `>`, a list item's indent. */
const prefixLines = (text: string, first: string, rest: string): string =>
  text.split('\n').map((line, at) => `${at === 0 ? first : rest}${line}`.trimEnd()).join('\n');

function listOf(node: HtmlElement, ordered: boolean): string {
  const start = ordered ? Math.max(1, Number(node.attrs.start ?? 1) || 1) : 0;
  const items = childrenOf(node, 'li');
  return items.map((item, at) => {
    const box = item.children.find((child): child is HtmlElement => isElement(child) && child.tag === 'input');
    const marker = ordered ? `${start + at}. ` : '- ';
    const ticked = box ? (('checked' in box.attrs) ? '[x] ' : '[ ] ') : '';
    const body = blocks(item.children.filter((child) => child !== box))
      .trim()
      // A list nested under a line of text is *tight* — no blank line between
      // the item and the list under it. `blocks` cannot know that, because it
      // separates every block from the next; here the blank line would make
      // markdown read the nesting as two lists with a gap in it. A genuinely
      // loose item, two paragraphs deep, keeps its blank line.
      .replace(/\n\n(?=\s*(?:[-*+]|\d+[.)])\s)/g, '\n');
    return prefixLines(`${ticked}${body}`, marker, ' '.repeat(marker.length));
  }).join('\n');
}

function tableOf(node: HtmlElement): string {
  const rows = rowsOf(node).map((tr) =>
    tr.children.filter((cell): cell is HtmlElement => isElement(cell) && (cell.tag === 'td' || cell.tag === 'th'))
      .map((cell) => inline(cell.children).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((cells) => cells.length));
  if (!width) return '';
  const pad = (cells: string[]): string => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  // A table whose first row is not a header still gets one: GitHub's dialect —
  // which is the one the renderer here speaks — has no way to write a table
  // without it, and an empty header row reads better than no table.
  const [header, ...body] = rows;
  return [pad(header), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(pad)].join('\n');
}

/**
 * Blocks, in order, separated by a blank line.
 *
 * Inline content between blocks is gathered up into a paragraph of its own —
 * which is what makes `<div>some text<p>more</p></div>` two paragraphs rather
 * than one run-together line.
 */
function blocks(nodes: HtmlNode[]): string {
  const out: string[] = [];
  let run: HtmlNode[] = [];

  const flushRun = (): void => {
    const text = inline(run).replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
    run = [];
    if (text) out.push(text);
  };

  for (const node of nodes) {
    if (!isElement(node) || (!BLOCK.has(node.tag) && node.tag !== 'figure' && node.tag !== 'details')) {
      run.push(node);
      continue;
    }
    if (DROPPED.has(node.tag)) continue;
    flushRun();
    switch (node.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = inline(node.children).replace(/\s+/g, ' ').trim();
        if (text) out.push(`${'#'.repeat(Number(node.tag[1]))} ${text}`);
        break;
      }
      case 'hr': out.push('---'); break;
      case 'ul': out.push(listOf(node, false)); break;
      case 'ol': out.push(listOf(node, true)); break;
      case 'table': out.push(tableOf(node)); break;
      case 'blockquote': out.push(prefixLines(blocks(node.children).trim(), '> ', '> ')); break;
      case 'pre': {
        const code = node.children.find((child): child is HtmlElement => isElement(child) && child.tag === 'code');
        const language = /language-([\w+#.-]+)/.exec((code?.attrs.class ?? '')) ?.[1] ?? '';
        const body = flatten(code ? code.children : node.children).replace(/\n+$/, '');
        out.push(`\`\`\`${language}\n${body}\n\`\`\``);
        break;
      }
      case 'dl': {
        // A definition list has no markdown of its own. A bold term and an
        // indented body is what every dialect that lacks one settles on.
        const lines: string[] = [];
        for (const child of node.children) {
          if (!isElement(child)) continue;
          const text = inline(child.children).replace(/\s+/g, ' ').trim();
          if (child.tag === 'dt' && text) lines.push(`**${text}**`);
          else if (child.tag === 'dd' && text) lines.push(prefixLines(text, ': ', '  '));
        }
        if (lines.length) out.push(lines.join('\n'));
        break;
      }
      case 'figure': case 'details': case 'td': case 'th': case 'tr': case 'li':
      default: {
        const body = blocks(node.children).trim();
        if (body) out.push(body);
      }
    }
  }
  flushRun();
  return out.filter(Boolean).join('\n\n');
}

/**
 * The document as markdown.
 *
 * What an import does with an HTML file the reader wants as a normal page, what
 * a paste from a browser or a word processor becomes, and how an HTML page is
 * exported into a markdown bundle. Lossy on purpose: a `<span style>` has no
 * markdown, and keeping it would mean the export was HTML with markdown in it.
 */
export function htmlToMarkdown(source: string): string {
  return blocks(parseHtml(source))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+$/gm, '')
    .trim();
}

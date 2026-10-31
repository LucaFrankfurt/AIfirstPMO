/**
 * An artboard's HTML, edited as text.
 *
 * An artboard on a canvas page is a whole HTML document — styles, scripts and
 * all — rendered in a sandboxed frame (see `docs/canvas.md`). People change it
 * two ways: by typing in its source, and by pointing at something in the
 * rendered board and saying "bigger", "move this up", "add a row". This file is
 * the second way, and it is deliberately the *first* way in disguise: every
 * visual edit here is a rewrite of the source string, which the editor then
 * hands to the same CRDT a keystroke goes through. There is no second model of
 * the document — no DOM that is saved, no block tree beside the text — so the
 * thing two people merge, the thing history keeps and the thing Claude writes
 * over MCP are one string, and a visual edit can never say something the source
 * cannot.
 *
 * ## How an element is named
 *
 * By its number in document order, `k`, counted over every start tag in the
 * source. Before a board is drawn for editing, `annotate` writes that number
 * into each element a person may pick as `data-k`; the frame reports clicks by
 * it, and the edit comes back here against *the same* source. Numbers are
 * therefore only good for one version of the text — the editor tags every
 * render with the text it was made from and drops a message about an older one
 * — and are never stored.
 *
 * ## What the parser is not
 *
 * It is not a browser. It finds where tags start and end and keeps the
 * offsets, which is the one thing `parseHtml` next door throws away and the one
 * thing an edit needs. It closes what HTML closes implicitly in the common
 * cases (a `<li>` by the next `<li>`, a cell by the next cell, a `<p>` by a
 * block) and is otherwise literal. A board somebody wrote with tags left open
 * in ways this does not know may get an edit that lands a level off — and the
 * edit is a plain text change, which the editor's undo takes back. (A board has
 * no saved history yet the way a page does; see `TODO.md`.) Boards Claude
 * writes are well-formed, which is the case this is for.
 */

import { escapeHtml, unescapeHtml } from './escape.ts';

/** Elements that never have content, however they are written. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text up to their own end tag, not markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

/** Never offered to a person to pick: they draw nothing, or draw it for somebody else. */
const HIDDEN = new Set([
  'html', 'head', 'body', 'meta', 'link', 'title', 'base', 'script', 'style', 'template', 'noscript',
]);

/** Blocks that end an open `<p>`, as a browser reads it. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

/** One attribute of a start tag, with where it sits. */
export interface SourceAttribute {
  name: string;
  value: string;
  /** The whole attribute, `name="value"`, as a half-open span. */
  start: number;
  end: number;
}

/** One element of the source, as offsets into it. */
export interface SourceElement {
  /** Its number in document order — what the frame calls it. */
  k: number;
  tag: string;
  /** The `<` of the start tag. */
  start: number;
  /** Just past the start tag's `>`. */
  openEnd: number;
  /** The `<` of the end tag; `end` when there is none to find. */
  closeStart: number;
  /** Just past the end tag, or the start tag for an element with no content. */
  end: number;
  parent: number | null;
  children: number[];
  attrs: SourceAttribute[];
  /** Whether the start tag ends in `/>`. */
  selfClosing: boolean;
  /** Whether a person may pick it: inside the body, drawn, and not part of a drawing. */
  editable: boolean;
}

export type Placement = 'before' | 'after' | 'inside';

/* ------------------------------------------------------------- the parser */

const NAME = /[A-Za-z][A-Za-z0-9:-]*/y;

/** The attributes of a start tag from `at` (just past its name), and where the tag ends. */
function readAttributes(source: string, at: number): { attrs: SourceAttribute[]; end: number; selfClosing: boolean } {
  const attrs: SourceAttribute[] = [];
  let i = at;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === '>') return { attrs, end: i + 1, selfClosing: false };
    if (source.startsWith('/>', i)) return { attrs, end: i + 2, selfClosing: true };
    if (source[i] === '/') { i++; continue; }
    const start = i;
    while (i < source.length && !/[\s=>]/.test(source[i]) && !source.startsWith('/>', i)) i++;
    const name = source.slice(start, i).toLowerCase();
    while (i < source.length && /\s/.test(source[i])) i++;
    let value = '';
    if (source[i] === '=') {
      i++;
      while (i < source.length && /\s/.test(source[i])) i++;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        const stop = close < 0 ? source.length : close;
        value = source.slice(i + 1, stop);
        i = Math.min(source.length, stop + 1);
      } else {
        const from = i;
        while (i < source.length && !/[\s>]/.test(source[i])) i++;
        value = source.slice(from, i);
      }
    }
    if (name) attrs.push({ name, value: unescapeHtml(value), start, end: i });
    else i++;
  }
  return { attrs, end: source.length, selfClosing: false };
}

/**
 * Every element in the source, in document order, with its offsets.
 *
 * `editable` is decided here rather than by each caller because the frame and
 * the inspector have to agree about it: an element the frame lets somebody
 * click and the inspector then refuses to describe is a bug in neither and a
 * broken editor in both. An element is editable when it is in the body (or
 * the document has no body, which is a fragment), is not one of `HIDDEN`, and
 * is not *inside* an SVG — the drawing as a whole can be picked, a path in it
 * cannot, because nobody means "the third path" when they click a chart.
 */
export function parse(source: string): SourceElement[] {
  const elements: SourceElement[] = [];
  const open: SourceElement[] = [];
  const hasBody = /<body[\s>]/i.test(source);
  let inBody = !hasBody;

  const close = (element: SourceElement, closeStart: number, end: number): void => {
    element.closeStart = closeStart;
    element.end = end;
  };
  /** Close everything above (and including) the deepest open element matching `stop`. */
  const closeUntil = (matches: (tag: string) => boolean, barrier: (tag: string) => boolean, at: number): void => {
    for (let depth = open.length - 1; depth >= 0; depth--) {
      const tag = open[depth].tag;
      if (barrier(tag)) return;
      if (matches(tag)) {
        while (open.length > depth) close(open.pop()!, at, at);
        return;
      }
    }
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) {
      const endComment = source.indexOf('-->', lt + 4);
      i = endComment < 0 ? source.length : endComment + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const gt = source.indexOf('>', lt);
      i = gt < 0 ? source.length : gt + 1;
      continue;
    }
    if (source[lt + 1] === '/') {
      NAME.lastIndex = lt + 2;
      const match = NAME.exec(source);
      const gt = source.indexOf('>', lt);
      const end = gt < 0 ? source.length : gt + 1;
      if (match) {
        const tag = match[0].toLowerCase();
        if (tag === 'body') inBody = false;
        const depth = open.map((element) => element.tag).lastIndexOf(tag);
        if (depth >= 0) {
          while (open.length > depth + 1) close(open.pop()!, lt, lt);
          close(open.pop()!, lt, end);
        }
      }
      i = end;
      continue;
    }
    NAME.lastIndex = lt + 1;
    const match = NAME.exec(source);
    if (!match) {
      i = lt + 1;
      continue;
    }
    const tag = match[0].toLowerCase();
    const { attrs, end: openEnd, selfClosing } = readAttributes(source, NAME.lastIndex);

    // What a browser closes for you, in the cases a hand-written board meets.
    if (tag === 'li') closeUntil((t) => t === 'li', (t) => t === 'ul' || t === 'ol', lt);
    if (tag === 'dt' || tag === 'dd') closeUntil((t) => t === 'dt' || t === 'dd', (t) => t === 'dl', lt);
    if (tag === 'td' || tag === 'th') closeUntil((t) => t === 'td' || t === 'th', (t) => t === 'tr' || t === 'table', lt);
    if (tag === 'tr') closeUntil((t) => t === 'tr', (t) => t === 'table' || t === 'thead' || t === 'tbody' || t === 'tfoot', lt);
    if (CLOSES_P.has(tag)) closeUntil((t) => t === 'p', (t) => !['p', 'span', 'em', 'strong', 'b', 'i', 'a'].includes(t), lt);

    const parent = open[open.length - 1] ?? null;
    const insideSvg = open.some((element) => element.tag === 'svg');
    const element: SourceElement = {
      k: elements.length,
      tag,
      start: lt,
      openEnd,
      closeStart: openEnd,
      end: openEnd,
      parent: parent ? parent.k : null,
      children: [],
      attrs,
      selfClosing,
      editable: inBody && !HIDDEN.has(tag) && !insideSvg && !open.some((element) => HIDDEN.has(element.tag) && element.tag !== 'html' && element.tag !== 'body'),
    };
    elements.push(element);
    parent?.children.push(element.k);
    if (tag === 'body') inBody = true;

    if (VOID.has(tag) || (selfClosing && (insideSvg || tag === 'svg'))) {
      i = openEnd;
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      const lower = source.toLowerCase();
      const endTag = lower.indexOf(`</${tag}`, openEnd);
      const stop = endTag < 0 ? source.length : endTag;
      const gt = endTag < 0 ? -1 : source.indexOf('>', endTag);
      close(element, stop, gt < 0 ? source.length : gt + 1);
      i = element.end;
      continue;
    }
    open.push(element);
    i = openEnd;
  }
  // Whatever is still open ends where the document does.
  while (open.length) close(open.pop()!, source.length, source.length);
  return elements;
}

/* ------------------------------------------------------------ annotating */

/** The attribute the frame finds an element by. Never stored: see `strip`. */
export const KEY_ATTRIBUTE = 'data-k';

/**
 * The source with every editable element numbered, for drawing in the editor.
 *
 * Written into the start tag just before its `>`, which is the one place that
 * is valid whatever the tag already says — after an unquoted value, a bare
 * `disabled`, or a `/` that closes an SVG element.
 */
export function annotate(source: string, elements: SourceElement[] = parse(source)): string {
  let out = source;
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index];
    if (!element.editable) continue;
    const at = element.openEnd - (element.selfClosing ? 2 : 1);
    out = `${out.slice(0, at)} ${KEY_ATTRIBUTE}="${element.k}"${out.slice(at)}`;
  }
  return out;
}

/**
 * Take the numbers back out of markup that came from the frame.
 *
 * What a person types into a paragraph comes back as the paragraph's inner
 * HTML, and a bold word inside it is still wearing the number it was drawn
 * with. Left in, the number would be saved, and the next render would carry
 * two of them.
 */
export const strip = (html: string): string => html.replace(/\sdata-k="\d+"/g, '');

/* ------------------------------------------------------------- reading */

/** What the inspector shows about one element. */
export interface ElementInfo {
  k: number;
  tag: string;
  /** Its text, when it holds nothing but text — the case that can be edited as a field. */
  text: string | null;
  style: Record<string, string>;
  attrs: Record<string, string>;
  /** The tags from the outermost editable ancestor down to this one, for a breadcrumb. */
  path: { k: number; tag: string }[];
  /** Where it sits in a table, when it is a cell or inside one. */
  cell: { table: number; row: number; column: number } | null;
}

const attribute = (element: SourceElement, name: string): string | null =>
  element.attrs.find((one) => one.name === name)?.value ?? null;

/** A `style` attribute as a map, in the order it was written. */
export function parseStyle(style: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(style ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

export const writeStyle = (style: Record<string, string>): string =>
  Object.entries(style).map(([name, value]) => `${name}: ${value}`).join('; ');

const ancestors = (elements: SourceElement[], k: number): SourceElement[] => {
  const out: SourceElement[] = [];
  for (let at = elements[k]?.parent ?? null; at !== null; at = elements[at].parent) out.push(elements[at]);
  return out;
};

function cellOf(elements: SourceElement[], k: number): ElementInfo['cell'] {
  const chain = [elements[k], ...ancestors(elements, k)];
  const cell = chain.find((element) => element.tag === 'td' || element.tag === 'th');
  if (!cell || cell.parent === null) return null;
  const row = elements[cell.parent];
  if (row.tag !== 'tr') return null;
  const table = ancestors(elements, row.k).find((element) => element.tag === 'table');
  if (!table) return null;
  return { table: table.k, row: rowsOf(elements, table.k).indexOf(row.k), column: cellsOf(elements, row.k).indexOf(cell.k) };
}

const rowsOf = (elements: SourceElement[], table: number): number[] =>
  elements.filter((element) => element.tag === 'tr' && ancestors(elements, element.k).find((one) => one.tag === 'table')?.k === table)
    .map((element) => element.k);

const cellsOf = (elements: SourceElement[], row: number): number[] =>
  elements[row].children.filter((k) => elements[k].tag === 'td' || elements[k].tag === 'th');

/** Everything the inspector needs about element `k`, or null when there is no such editable element. */
export function describe(source: string, k: number): ElementInfo | null {
  const elements = parse(source);
  const element = elements[k];
  if (!element || !element.editable) return null;
  const inner = source.slice(element.openEnd, element.closeStart);
  return {
    k,
    tag: element.tag,
    text: element.children.length === 0 && !VOID.has(element.tag) ? unescapeHtml(inner) : null,
    style: parseStyle(attribute(element, 'style')),
    attrs: Object.fromEntries(element.attrs.map((one) => [one.name, one.value])),
    path: [...ancestors(elements, k).reverse(), element]
      .filter((one) => one.editable)
      .map((one) => ({ k: one.k, tag: one.tag })),
    cell: cellOf(elements, k),
  };
}

/* ------------------------------------------------------------- writing */

const splice = (source: string, start: number, end: number, text: string): string =>
  `${source.slice(0, start)}${text}${source.slice(end)}`;


const lineStart = (source: string, at: number): number => source.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (source: string, at: number): number => {
  const newline = source.indexOf('\n', at);
  return newline < 0 ? source.length : newline;
};

/** Whether an element has its line to itself, so moving it can take the line along. */
function ownLine(source: string, element: SourceElement): boolean {
  return !source.slice(lineStart(source, element.start), element.start).trim()
    && !source.slice(element.end, lineEnd(source, element.end)).trim();
}

const indentOf = (source: string, element: SourceElement): string =>
  source.slice(lineStart(source, element.start), element.start);

/** The span to cut when an element leaves: the element, or its whole line when it has one. */
function cutSpan(source: string, element: SourceElement): [number, number] {
  if (!ownLine(source, element)) return [element.start, element.end];
  const from = lineStart(source, element.start);
  const to = lineEnd(source, element.end);
  // Take one newline with it, the one after — or the one before, at the end of the text.
  if (to < source.length) return [from, to + 1];
  return [Math.max(0, from - 1), to];
}

function editable(source: string, k: number): { elements: SourceElement[]; element: SourceElement } {
  const elements = parse(source);
  const element = elements[k];
  if (!element || !element.editable) throw new Error(`No editable element ${k}`);
  return { elements, element };
}

/** Replace what is inside element `k` with `html`. Markup from the frame is stripped of its numbers. */
export function setInner(source: string, k: number, html: string): string {
  const { element } = editable(source, k);
  if (VOID.has(element.tag)) return source;
  return splice(source, element.openEnd, element.closeStart, strip(html));
}

/** Replace what is inside element `k` with plain text. */
export const setText = (source: string, k: number, text: string): string => setInner(source, k, escapeHtml(text));

/** Set one attribute of element `k`, or take it away with `null`. */
export function setAttribute(source: string, k: number, name: string, value: string | null): string {
  const { element } = editable(source, k);
  const lower = name.toLowerCase();
  const existing = element.attrs.find((one) => one.name === lower);
  const written = value === null ? '' : `${lower}="${escapeHtml(value)}"`;
  if (existing) {
    if (value !== null) return splice(source, existing.start, existing.end, written);
    // Removing: take the whitespace in front of it as well, or the tag keeps a hole.
    let from = existing.start;
    while (from > element.start && /\s/.test(source[from - 1])) from--;
    return splice(source, from, existing.end, '');
  }
  if (value === null) return source;
  const at = element.openEnd - (element.selfClosing ? 2 : 1);
  return splice(source, at, at, ` ${written}`);
}

/**
 * Set one CSS property of element `k` through its `style` attribute; an empty
 * value takes the property away, and an emptied attribute goes with it.
 *
 * Inline style rather than a class, because inline style is the one place the
 * element's look is *its own*: a rule in a `<style>` block may be shared with
 * eleven other elements, and "make this one red" turning all twelve red is the
 * edit nobody asked for.
 */
export function setStyle(source: string, k: number, property: string, value: string): string {
  const { element } = editable(source, k);
  const style = parseStyle(attribute(element, 'style'));
  const name = property.trim().toLowerCase();
  if (value.trim()) style[name] = value.trim();
  else delete style[name];
  const written = writeStyle(style);
  return setAttribute(source, k, 'style', written || null);
}

/** Take element `k` out, with its line if it had one to itself. */
export function remove(source: string, k: number): string {
  const { element } = editable(source, k);
  const [from, to] = cutSpan(source, element);
  return splice(source, from, to, '');
}

/** Where `html` lands when it is placed relative to `target`, laid out the way its neighbours are. */
function placement(source: string, elements: SourceElement[], target: SourceElement, where: Placement, html: string): { at: number; text: string } {
  if (where === 'inside' && !VOID.has(target.tag) && !target.selfClosing) {
    const last = target.children.length ? elements[target.children[target.children.length - 1]] : null;
    if (last && ownLine(source, last)) return { at: last.end, text: `\n${indentOf(source, last)}${html}` };
    const inner = source.slice(target.openEnd, target.closeStart);
    if (!inner.trim() && ownLine(source, target)) {
      const indent = indentOf(source, target);
      return { at: target.openEnd, text: `\n${indent}  ${html}\n${indent}` };
    }
    return { at: target.closeStart, text: html };
  }
  const after = where !== 'before';
  if (ownLine(source, target)) {
    const indent = indentOf(source, target);
    return after ? { at: target.end, text: `\n${indent}${html}` } : { at: target.start, text: `${html}\n${indent}` };
  }
  return { at: after ? target.end : target.start, text: html };
}

/**
 * A rewrite that put something somewhere, and the number the thing has now —
 * so the editor can keep it selected after a move instead of losing it.
 */
export interface Placed {
  source: string;
  k: number | null;
}

/** The element that starts at `offset`, by its number in `source`. */
const keyAt = (source: string, offset: number): number | null =>
  parse(source).find((element) => element.start === offset)?.k ?? null;

function placed(source: string, at: number, text: string, html: string): Placed {
  const next = splice(source, at, at, text);
  return { source: next, k: keyAt(next, at + text.indexOf(html)) };
}

/** Put `html` before, after or at the end of element `k`. */
export function insert(source: string, k: number, where: Placement, html: string): Placed {
  const { elements, element } = editable(source, k);
  const { at, text } = placement(source, elements, element, where, html);
  return placed(source, at, text, html);
}

/** Put `html` at the end of the body, or of the document when it has none. */
export function append(source: string, html: string): Placed {
  const elements = parse(source);
  const body = elements.find((element) => element.tag === 'body');
  if (body) {
    // After the last child whatever it is — a board usually ends in its script,
    // and the new block belongs below what the body draws, laid out like it.
    const last = body.children.length ? elements[body.children[body.children.length - 1]] : null;
    const { at, text } = last
      ? placement(source, elements, last, 'after', html)
      : placement(source, elements, body, 'inside', html);
    return placed(source, at, text, html);
  }
  const trimmed = source.replace(/\s*$/, '');
  return placed(trimmed, trimmed.length, `${trimmed ? '\n' : ''}${html}\n`, html);
}

/** A second copy of element `k`, straight after it. */
export function duplicate(source: string, k: number): Placed {
  const { elements, element } = editable(source, k);
  const copy = source.slice(element.start, element.end);
  const { at, text } = placement(source, elements, element, 'after', copy);
  return placed(source, at, text, copy);
}

/** Whether `k` is `ancestor` or sits somewhere inside it. */
const within = (elements: SourceElement[], k: number, ancestor: number): boolean =>
  k === ancestor || ancestors(elements, k).some((element) => element.k === ancestor);

/**
 * Move element `k` before, after or into element `target`.
 *
 * The cut and the paste are computed against the same text and then applied
 * as one rewrite, so the history holds a move rather than a deletion followed
 * by somebody's paragraph appearing elsewhere. Refused, by returning the source
 * unchanged, when the target is the element or inside it — there is nowhere
 * for that to go.
 */
export function move(source: string, k: number, target: number, where: Placement): Placed {
  const { elements, element } = editable(source, k);
  const unchanged = { source, k };
  const to = elements[target];
  if (!to || !to.editable || within(elements, target, k)) return unchanged;
  const html = source.slice(element.start, element.end);
  const [from, until] = cutSpan(source, element);
  const { at, text } = placement(source, elements, to, where, html);
  const offset = text.indexOf(html);
  if (at <= from) {
    const next = splice(splice(source, from, until, ''), at, at, text);
    return { source: next, k: keyAt(next, at + offset) };
  }
  if (at >= until) {
    const next = splice(splice(source, at, at, text), from, until, '');
    return { source: next, k: keyAt(next, at + offset - (until - from)) };
  }
  return unchanged;
}

/** The previous or next editable sibling, for "move up" and "move down". */
export function sibling(source: string, k: number, direction: -1 | 1): number | null {
  const elements = parse(source);
  const element = elements[k];
  if (!element || element.parent === null) return null;
  const siblings = elements[element.parent].children.filter((one) => elements[one].editable);
  const at = siblings.indexOf(k);
  return siblings[at + direction] ?? null;
}

/* --------------------------------------------------------------- tables */

/** A cell's text emptied out, keeping its tag and attributes. */
const emptyCell = (source: string, cell: SourceElement): string =>
  `${source.slice(cell.start, cell.openEnd)}${cell.closeStart < cell.end ? source.slice(cell.closeStart, cell.end) : `</${cell.tag}>`}`;

/** Apply several insertions or cuts at once, from the back so the offsets hold. */
function spliceAll(source: string, edits: { from: number; to: number; text: string }[]): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) out = splice(out, edit.from, edit.to, edit.text);
  return out;
}

/** A new, empty row above or below the row that holds element `k`. */
export function addRow(source: string, k: number, where: 'above' | 'below'): string {
  const elements = parse(source);
  const cell = cellOf(elements, k);
  if (!cell) return source;
  const row = elements[rowsOf(elements, cell.table)[cell.row]];
  const cells = cellsOf(elements, row.k).map((one) => emptyCell(source, elements[one]).replace(/^<th\b/, '<td').replace(/<\/th>$/, '</td>'));
  const html = `${source.slice(row.start, row.openEnd)}${cells.join('')}</tr>`;
  const { at, text } = placement(source, elements, row, where === 'above' ? 'before' : 'after', html);
  return splice(source, at, at, text);
}

/** A new, empty column left or right of the cell that holds element `k`, in every row of its table. */
export function addColumn(source: string, k: number, where: 'left' | 'right'): string {
  const elements = parse(source);
  const cell = cellOf(elements, k);
  if (!cell) return source;
  const edits: { from: number; to: number; text: string }[] = [];
  for (const rowK of rowsOf(elements, cell.table)) {
    const cells = cellsOf(elements, rowK);
    const at = cells[Math.min(cell.column, cells.length - 1)];
    if (at === undefined) continue;
    const one = elements[at];
    const copy = emptyCell(source, one);
    edits.push(where === 'left' ? { from: one.start, to: one.start, text: copy } : { from: one.end, to: one.end, text: copy });
  }
  return spliceAll(source, edits);
}

/** Take out the row that holds element `k`. The last row of a table stays. */
export function removeRow(source: string, k: number): string {
  const elements = parse(source);
  const cell = cellOf(elements, k);
  if (!cell) return source;
  const rows = rowsOf(elements, cell.table);
  if (rows.length < 2) return source;
  const [from, to] = cutSpan(source, elements[rows[cell.row]]);
  return splice(source, from, to, '');
}

/** Take out the column that holds element `k`, in every row. The last column stays. */
export function removeColumn(source: string, k: number): string {
  const elements = parse(source);
  const cell = cellOf(elements, k);
  if (!cell) return source;
  const edits: { from: number; to: number; text: string }[] = [];
  for (const rowK of rowsOf(elements, cell.table)) {
    const cells = cellsOf(elements, rowK);
    if (cells.length < 2) return source;
    const one = elements[cells[cell.column]];
    if (one) edits.push({ from: one.start, to: one.end, text: '' });
  }
  return spliceAll(source, edits);
}

/* ---------------------------------------------------------------- reading out */

/**
 * The words on a board, for search, a preview line and an old client.
 *
 * Scripts and styles are dropped with their content, and so are the tags, so
 * what is left is what a person reading the board could read — less anything
 * a script draws, which no text search can see without running it.
 */
export function text(source: string): string {
  const elements = parse(source);
  const hidden: [number, number][] = elements
    .filter((element) => RAW_TEXT.has(element.tag) || element.tag === 'head' || element.tag === 'template')
    .map((element) => [element.start, element.end]);
  let out = '';
  let at = 0;
  for (const [from, to] of hidden.sort((a, b) => a[0] - b[0])) {
    if (from < at) continue;
    out += source.slice(at, from);
    at = to;
  }
  out += source.slice(at);
  return unescapeHtml(out.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

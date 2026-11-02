/**
 * A board that was not written for a phone, made to fit one — inside the board.
 *
 * Reported from a phone: a board page reflowed to the screen, and a row of
 * pipeline cards ran off its side. Reflowing helps a board written to reflow;
 * Claude's artifacts usually are, and one converted, pasted or hand-made often
 * is not — a grid of eight fixed columns, a row of cards that never wraps, a
 * container `1200px` wide, a table with no box to scroll in. Scaling such a
 * board down shows all of it at a third of its size; this makes it reflow.
 *
 * It looks only at what runs off the side, and loosens exactly that:
 *
 * - a grid of fixed columns becomes `repeat(auto-fill, minmax(…))` at its own
 *   narrowest column, so it wraps instead of overflowing;
 * - a row of flex items that never wraps, wraps;
 * - anything wider than the screen may be no wider than its container;
 * - a table — or preformatted text, or a layout of `display: table` — gets the
 *   scrolling box it was missing;
 * - a layout placed by position stands in one column, its pieces in the order
 *   a reader meets them;
 * - a line told never to break may break, and a box pushed off the side by a
 *   transform, a margin or an offset is brought back;
 * - and, last, long words may break.
 *
 * What fits is left alone, and so is everything inside a box that scrolls or
 * clips on purpose — a board that put its wide table in a scroller meant it.
 * Nothing is saved: these are styles on the drawn document, the source keeps
 * saying what its author wrote, and the editor and the designed view never
 * see them. A board this still cannot help is too wide afterwards, and the
 * page scales it down.
 *
 * **Self-contained, on purpose.** This function never runs where it is
 * written: its source is handed to a board's frame as text — by the app
 * (`frame.ts`) and by a shared link (`adapters/share/boards.ts`) — and run
 * there. So it reaches nothing outside its own body, not even a constant of
 * this file, and it touches the document through `globalThis`, because this
 * package is compiled without the DOM's types. Returns what it changed, as
 * `[place, property, value]` — `fitCss` turns that into a stylesheet.
 */
export function fitBoard(): [string, string, string][] {
  const g = globalThis as any;
  const doc = g.document;
  const root = doc && doc.documentElement;
  if (!root || !doc.body || !root.clientWidth) return [];
  const screen = root.clientWidth;
  const over = (): number => root.scrollWidth - root.clientWidth;
  /*
   * What was changed, by where: the element's place as child indices down from
   * the body (`0.3.2`, the body itself ''). A board whose scripts measured the
   * layout before any of this — a chart drawn to its box's width, columns
   * sized from the window — is drawn a second time with these as a stylesheet
   * from the start, so its scripts measure the layout that fits.
   */
  const changed = new Map<string, [string, string, string]>();
  const pathOf = (el: any): string => {
    const steps: number[] = [];
    for (let node = el; node && node !== doc.body && node.parentElement; node = node.parentElement) {
      steps.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return steps.join('.');
  };
  const set = (el: any, prop: string, value: string): void => {
    if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === 'important') return;
    el.style.setProperty(prop, value, 'important');
    const path = pathOf(el);
    changed.set(`${path} ${prop}`, [path, prop, value]);
  };
  /** Inside a box that scrolls or clips: what overflows there is the board's own business. */
  const boxed = (el: any): boolean => {
    for (let up = el.parentElement; up && up !== doc.body; up = up.parentElement) {
      if (g.getComputedStyle(up).overflowX !== 'visible') return true;
    }
    return false;
  };
  /** Held to the screen when too wide: pictures, embeds, form fields. */
  const SIZED = ' IMG VIDEO CANVAS IFRAME EMBED OBJECT SVG INPUT SELECT TEXTAREA ';
  // In passes, each reading everything before writing anything: a write
  // between two reads makes the browser lay the board out again for each.
  for (let pass = 0; pass < 5; pass += 1) {
    // Always looked at once: a fixed header too wide for the screen is cut at
    // its edge without making the page any wider, so a page that measures as
    // fitting can still be cutting something off. Content that merely runs on
    // past its own box is only a problem when the page itself does.
    const cut = over() > 1;
    if (pass > 0 && !cut) break;
    const found: { el: any; style: any; box: any; wide: boolean; placed: any[] | null }[] = [];
    const all = doc.body.querySelectorAll('*');
    for (let at = 0; at < all.length; at += 1) {
      const el = all[at];
      // An SVG's insides are drawn by the SVG; its box is what matters.
      if (el.ownerSVGElement) continue;
      // Two ways to run off the side: the box itself is too wide, or it fits
      // and what is inside it is not — a grid's box is as wide as its
      // container while its columns run on past it, which is how the grid
      // this was written for got past the first version of this check.
      const box = el.getBoundingClientRect();
      const wide = box.width > screen + 1 || box.right > screen + 1;
      const spills = cut && el.scrollWidth > el.clientWidth + 1;
      if (!wide && !spills) continue;
      const style = g.getComputedStyle(el);
      if (style.display === 'none') continue;
      // A fixed panel parked wholly off the side is a drawer waiting to slide
      // in, not content running off it.
      if (style.position === 'fixed' && box.left >= screen - 1) continue;
      // A box that scrolls or clips on purpose — a kanban, a wide table in its
      // own scroller, a line cut short with an ellipsis — keeps doing it, as
      // long as the box itself fits.
      if (!wide && style.overflowX !== 'visible') continue;
      if (boxed(el)) continue;
      // A table gets a box to scroll in; what is inside it stays as written.
      const tag = String(el.tagName).toUpperCase();
      if (tag !== 'TABLE' && tag !== 'PRE' && el.closest && el.closest('table, pre')) continue;
      // A layout placed by position — pieces at `left: 900px` — read before
      // anything moves: its pieces in the order a reader meets them, top to
      // bottom and then left to right, to stand in that order in one column.
      let placed: any[] | null = null;
      const kids: { kid: any; absolute: boolean; box: any }[] = [];
      for (let child = 0; child < el.children.length; child += 1) {
        const kid = el.children[child];
        const kidStyle = g.getComputedStyle(kid);
        if (kidStyle.display === 'none') continue;
        kids.push({ kid, absolute: kidStyle.position === 'absolute', box: kid.getBoundingClientRect() });
      }
      if (kids.some((one) => one.absolute && one.box.right > screen + 1)) {
        placed = kids
          .sort((a, b) => (Math.round(a.box.top / 8) - Math.round(b.box.top / 8)) || (a.box.left - b.box.left))
          .map((one) => one.kid);
      }
      found.push({ el, style, box, wide, placed });
    }
    if (!found.length) break;
    for (const { el, style, box, wide, placed } of found) {
      const tag = String(el.tagName).toUpperCase();
      const display = String(style.display);
      if (placed) {
        set(el, 'display', 'flex');
        set(el, 'flex-direction', 'column');
        set(el, 'gap', '12px');
        set(el, 'height', 'auto');
        set(el, 'min-height', '0');
        placed.forEach((kid: any, order: number) => {
          set(kid, 'position', 'relative');
          for (const side of ['left', 'top', 'right', 'bottom']) set(kid, side, 'auto');
          set(kid, 'transform', 'none');
          set(kid, 'order', String(order));
          set(kid, 'max-width', '100%');
        });
      } else if (display.indexOf('grid') >= 0) {
        const tracks = String(style.gridTemplateColumns).split(' ').map(parseFloat).filter((size) => size > 0);
        if (tracks.length > 1) {
          // Its own narrowest column, so a card keeps the width it was drawn
          // for — but never so narrow that its words stand one to a line.
          const least = Math.max(120, Math.min(...tracks));
          set(el, 'grid-template-columns', `repeat(auto-fill, minmax(min(100%, ${Math.round(least)}px), 1fr))`);
          // Named areas and placed items assume the columns that are gone.
          if (style.gridTemplateAreas && style.gridTemplateAreas !== 'none') set(el, 'grid-template-areas', 'none');
          for (let child = 0; child < el.children.length; child += 1) set(el.children[child], 'grid-area', 'auto');
        }
      } else if (display.indexOf('flex') >= 0 && String(style.flexDirection).indexOf('column') < 0 && style.flexWrap === 'nowrap') {
        set(el, 'flex-wrap', 'wrap');
      } else if (tag === 'TABLE' || tag === 'PRE' || display === 'table' || display === 'inline-table') {
        // A block that scrolls; a table inside it keeps laying itself out as one.
        set(el, 'display', 'block');
        set(el, 'overflow-x', 'auto');
      }
      // A line told never to break, where it does not fit.
      const space = String(style.whiteSpace);
      if (tag !== 'PRE' && (space === 'nowrap' || space === 'pre')) set(el, 'white-space', space === 'pre' ? 'pre-wrap' : 'normal');
      if (!wide) continue;
      // Pushed off the side rather than too wide for it: a transform, a
      // margin or an offset put it there, and takes it back.
      if (style.transform && style.transform !== 'none') set(el, 'transform', 'none');
      if (box.width <= screen + 1) {
        set(el, 'margin-left', '0');
        set(el, 'margin-right', '0');
        if (style.position !== 'static') {
          set(el, 'left', 'auto');
          set(el, 'right', 'auto');
        }
      }
      set(el, 'max-width', '100%');
      set(el, 'min-width', '0');
      set(el, 'box-sizing', 'border-box');
      // An SVG without a viewBox has no proportions to keep, so its height stays.
      if (SIZED.indexOf(` ${tag} `) >= 0 && (tag !== 'SVG' || el.getAttribute('viewBox'))) set(el, 'height', 'auto');
    }
  }
  if (over() > 1) set(doc.body, 'overflow-wrap', 'anywhere');
  return Array.from(changed.values());
}

/**
 * Rules `fitBoard` wrote, as a stylesheet a board can carry from its first
 * line — so its scripts lay it out already fitted.
 *
 * Rules arrive from places a stranger can write: the window's name in a
 * shared board or a downloaded file, a message from a frame running somebody's
 * code. So nothing passes that `fitBoard` could not have written itself: one
 * of its own properties; a value of letters, digits, spaces, brackets, commas,
 * dots, percent and hyphens — no colon, quote, semicolon, brace or backslash,
 * so no second declaration and no way out of the rule — calling no function
 * but the three it writes, so no `url()`; and a place made of child indices.
 * Self-contained like `fitBoard`, because it travels the same way.
 */
export function fitCss(rules: unknown): string {
  const props = ' grid-template-columns grid-template-areas grid-area flex-wrap display overflow-x white-space'
    + ' transform margin-left margin-right left right position order max-width min-width'
    + ' box-sizing height min-height gap flex-direction overflow-wrap ';
  if (!Array.isArray(rules)) return '';
  const out: string[] = [];
  for (const rule of rules.slice(0, 2000)) {
    if (!Array.isArray(rule) || rule.length !== 3) continue;
    const [path, prop, value] = rule.map(String);
    if (!/^(\d{1,4}(\.\d{1,4}){0,40})?$/.test(path)) continue;
    if (props.indexOf(` ${prop} `) < 0) continue;
    if (!/^[a-z0-9 ().,%-]{1,120}$/i.test(value)) continue;
    // The functions it writes, and no other — no `url()`, no `expression()`.
    if ((value.match(/[a-z-]+\s*\(/gi) || []).some((call) => !/^(repeat|minmax|min)\($/i.test(call.replace(/\s+/g, '')))) continue;
    const selector = path ? `body>${path.split('.').map((at) => `:nth-child(${Number(at) + 1})`).join('>')}` : 'body';
    out.push(`${selector}{${prop}:${value}!important}`);
  }
  return out.join('\n');
}

/**
 * Put markup at the top of a document's head — one way, for every place that
 * hands a board our script: the app's frame, a shared link, a download.
 */
export function intoHead(html: string, snippet: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${snippet}${html.slice(head.index + head[0].length)}`;
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${snippet}</head>${html.slice(root.index + root[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}${snippet}${html.slice(doctype[0].length)}`;
  return `<!doctype html><meta charset="utf-8">${snippet}${html}`;
}

/** What marks what we add to a document, so it can be found and taken out again. */
const FIT_MARK = 'data-kolibri-fit';

/**
 * A phone's browser lays out a page with no viewport of its own at a desktop
 * width — 980px — and zooms it out, so a downloaded board opened on a phone
 * was a small desktop page however well it reflowed. Measured: the board
 * that reflows to two columns in the app came out in six. Added only to a
 * document that says nothing about its viewport; inside a frame it is
 * ignored, so the app and a shared board are unchanged by it.
 */
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1" ${FIT_MARK}>`;

/**
 * What a document carries to fit itself, with no app around it: a shared
 * board, a downloaded file. Run once drawn, once more when the board's own
 * scripts have had a moment to add to it, and on every resize — a phone
 * turned on its side.
 *
 * A board with scripts of its own, or a `<canvas>`, may have measured itself
 * before it was fitted: a chart drawn to the width its box had, then shrunk
 * as a picture; a bar sized from a box that was then narrowed. Such a board is
 * loaded once more, with what `fitBoard` changed applied as a stylesheet
 * before anything of the board runs, so its scripts measure the layout it will
 * be shown in.
 *
 * What carries the rules across that reload depends on where the board is,
 * and was measured in Chromium, Firefox and WebKit rather than assumed:
 *
 * - **In a frame** — a shared link's, a downloaded canvas's `srcdoc` — the
 *   window's name. A frame keeps its name across a reload in all three. A
 *   `#hash` is no use there: reloading `about:srcdoc#…` loads an empty page.
 * - **On its own** — a downloaded board page, a shared board opened directly —
 *   the address's `#hash`, taken out again here before any of the board's
 *   scripts can see it, and the board's own hash put back. Firefox and WebKit
 *   forget a tab's name when a sandboxed page reloads (its origin is new each
 *   time); every engine keeps the address.
 *
 * Either is signed with the document, so rules written for one board reach no
 * other. And once, never in a loop: a load that says it is a reload or a step
 * back — ours, the reader's — never asks again, whether or not the rules
 * arrived with it. A load that says nothing about itself, which is what
 * WebKit's `srcdoc` frames do, is taken as fresh; there the name was measured
 * to arrive.
 */
export function fitInPlace(fit: () => [string, string, string][], css: (rules: unknown) => string, sign: string): void {
  const g = globalThis as any;
  const doc = g.document;
  const key = `kolibri-fit:${sign}:`;
  let alone = false;
  let done = false;
  try {
    alone = g.parent === g;
    let carried: { rules: unknown; hash?: string } | null = null;
    const hash = String(g.location.hash || '');
    if (alone && hash.indexOf(`#${key}`) === 0) {
      carried = JSON.parse(decodeURIComponent(hash.slice(key.length + 1)));
      // Ours, and gone again before the board's own scripts read the address.
      try { g.history.replaceState(g.history.state, '', String(g.location.href).split('#')[0] + (carried?.hash || '')); } catch { /* left in the address */ }
    } else if (!alone && String(g.name || '').indexOf(key) === 0) {
      carried = JSON.parse(String(g.name).slice(key.length));
    }
    if (carried) {
      done = true;
      const style = doc.createElement('style');
      style.setAttribute('data-kolibri-fit', '');
      style.textContent = css(carried.rules);
      (doc.head || doc.documentElement).appendChild(style);
    }
    const entry = g.performance && g.performance.getEntriesByType ? g.performance.getEntriesByType('navigation')[0] : null;
    if (entry && entry.type !== 'navigate') done = true;
  } catch {
    done = true;
  }
  /** The board draws or lays out in script: a canvas, or a script that is not one of ours. */
  const scripted = (): boolean => {
    if (doc.querySelector('canvas')) return true;
    const all = doc.scripts;
    for (let at = 0; at < all.length; at += 1) {
      if (!all[at].hasAttribute('data-kolibri-fit') && !all[at].hasAttribute('data-kolibri')) return true;
    }
    return false;
  };
  const run = (): void => {
    try {
      const rules = fit();
      if (done || !rules.length || !scripted()) return;
      done = true;
      if (alone) {
        const [base, own] = String(g.location.href).split('#');
        const address = `${base}#${key}${encodeURIComponent(JSON.stringify({ rules, hash: own ? `#${own}` : '' }))}`;
        // Past this an address is too long for some browser to keep; fitted afterwards, then.
        if (address.length > 32000) return;
        g.location.replace(address);
      } else {
        g.name = key + JSON.stringify({ rules });
      }
      g.location.reload();
    } catch { /* the board as written, then */ }
  };
  g.addEventListener('load', () => { run(); g.setTimeout(run, 600); });
  g.addEventListener('resize', run);
}

/**
 * A short signature of a document, so rules written for one are applied to
 * no other. Not a secret and not a defence — `fitCss` is that — only a name.
 */
function signature(html: string): string {
  let hash = 5381;
  for (let at = 0; at < html.length; at += 1) hash = ((hash * 33) ^ html.charCodeAt(at)) >>> 0;
  return `${hash.toString(36)}${html.length.toString(36)}`;
}

/**
 * `fitInPlace` as a script a document carries, with what it needs handed in
 * as source. Marked, because a document that leaves with it — a download —
 * may come back through *Import HTML…*, and the board it becomes should say
 * what its author wrote, not what we added.
 */
export function fitScript(sign = ''): string {
  const source = (fn: (...args: any[]) => unknown): string => fn.toString().replace(/<\/script/gi, '<\\/script');
  return `<script ${FIT_MARK}>(${source(fitInPlace)})(${source(fitBoard)}, ${source(fitCss)}, ${JSON.stringify(sign)});</script>`;
}

/** A document without what `withFit` added — what *Import HTML…* keeps of a download. */
export function stripFitScript(html: string): string {
  return html
    .replace(new RegExp(`<script ${FIT_MARK}>[\\s\\S]*?<\\/script>`, 'g'), '')
    .replace(new RegExp(`<meta [^>]*${FIT_MARK}[^>]*>`, 'g'), '');
}

/** A document that fits whatever screen opens it, carrying our additions once however often it is asked. */
export function withFit(html: string): string {
  const clean = stripFitScript(html);
  const viewport = /<meta[^>]+name\s*=\s*["']?viewport/i.test(clean) ? '' : VIEWPORT;
  return intoHead(clean, viewport + fitScript(signature(clean)));
}

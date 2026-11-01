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
 * - a table, or preformatted text, gets the scrolling box it was missing;
 * - and, last, long words may break.
 *
 * What fits is left alone, and so is everything inside a box that scrolls or
 * clips on purpose — a board that put its wide table in a scroller meant it.
 * Nothing is saved: these are styles on the drawn document, the source keeps
 * saying what its author wrote, and the editor and the designed view never
 * see them. A board this cannot help — a dashboard laid out by absolute
 * position — is still too wide afterwards, and the page scales it down.
 *
 * **Self-contained, on purpose.** This function never runs where it is
 * written: its source is handed to a board's frame as text — by the app
 * (`frame.ts`) and by a shared link (`adapters/share/boards.ts`) — and run
 * there. So it reaches nothing outside its own body, not even a constant of
 * this file, and it touches the document through `globalThis`, because this
 * package is compiled without the DOM's types. Returns how many styles it set.
 */
export function fitBoard(): number {
  const g = globalThis as any;
  const doc = g.document;
  const root = doc && doc.documentElement;
  if (!root || !doc.body || !root.clientWidth) return 0;
  const screen = root.clientWidth;
  const over = (): number => root.scrollWidth - root.clientWidth;
  if (over() <= 1) return 0;
  let touched = 0;
  const set = (el: any, prop: string, value: string): void => {
    if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === 'important') return;
    el.style.setProperty(prop, value, 'important');
    touched += 1;
  };
  /** Inside a box that scrolls or clips: what overflows there is the board's own business. */
  const boxed = (el: any): boolean => {
    for (let up = el.parentElement; up && up !== doc.body; up = up.parentElement) {
      if (g.getComputedStyle(up).overflowX !== 'visible') return true;
    }
    return false;
  };
  // In passes, each reading everything before writing anything: a write
  // between two reads makes the browser lay the board out again for each.
  for (let pass = 0; pass < 4 && over() > 1; pass += 1) {
    const found: { el: any; style: any; wide: boolean }[] = [];
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
      const spills = el.scrollWidth > el.clientWidth + 1;
      if (!wide && !spills) continue;
      const style = g.getComputedStyle(el);
      if (style.display === 'none' || style.position === 'fixed' || style.position === 'absolute') continue;
      // A box that scrolls on purpose — a kanban, a wide table in its own
      // scroller — keeps scrolling, as long as the box itself fits.
      if (!wide && style.overflowX !== 'visible') continue;
      if (boxed(el)) continue;
      found.push({ el, style, wide });
    }
    if (!found.length) break;
    for (const { el, style, wide } of found) {
      const tag = String(el.tagName).toUpperCase();
      if (String(style.display).indexOf('grid') >= 0) {
        const tracks = String(style.gridTemplateColumns).split(' ').map(parseFloat).filter((size) => size > 0);
        if (tracks.length > 1) {
          // Its own narrowest column, so a card keeps the width it was drawn
          // for — but never so narrow that its words stand one to a line.
          const least = Math.max(120, Math.min(...tracks));
          set(el, 'grid-template-columns', `repeat(auto-fill, minmax(min(100%, ${Math.round(least)}px), 1fr))`);
          for (let child = 0; child < el.children.length; child += 1) set(el.children[child], 'grid-column', 'auto');
        }
      } else if (String(style.display).indexOf('flex') >= 0 && String(style.flexDirection).indexOf('column') < 0 && style.flexWrap === 'nowrap') {
        set(el, 'flex-wrap', 'wrap');
      } else if (tag === 'TABLE' || tag === 'PRE') {
        set(el, 'display', 'block');
        set(el, 'overflow-x', 'auto');
      } else if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
        set(el, 'height', 'auto');
      }
      if (wide) {
        set(el, 'max-width', '100%');
        set(el, 'min-width', '0');
        set(el, 'box-sizing', 'border-box');
      }
    }
  }
  if (over() > 1) set(doc.body, 'overflow-wrap', 'anywhere');
  return touched;
}

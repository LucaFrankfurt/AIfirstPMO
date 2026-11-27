import { useEffect, useState } from 'react';

/**
 * Whether the window has room for a menu to hang off its button.
 *
 * The drawers that stopped menus being 195 rows long were checked at
 * 1400×900 and nowhere else, and on a phone every single one of them opened
 * outside the window: measured on a 390px screen, all 19 drawers in the app
 * landed between 35px and 147px to the left of it, which is a search box with
 * its left half cut off by the edge of the glass. The cause is geometry, not a
 * bug in the positioner — a drawer stands *beside* the menu it belongs to, and
 * 310px of menu plus 208px of drawer do not fit across 390px. Nothing about
 * where it is placed can make them.
 *
 * So below this width a menu stops hanging off its button: it comes up from
 * the bottom edge as a sheet, and a drawer opens *inside* it rather than
 * beside it.
 *
 * Not the 764px the chrome switches at. That one asks whether `.main` can hold
 * a busy toolbar, and `.main` is narrower than the window by the sidebar — it
 * is a container query, and a menu is portalled to `<body>`, where there is no
 * container to ask. This asks the only question a portal can answer and the
 * only one that matters here: can the window hold a menu and a drawer side by
 * side? The widest menu measured on a phone is 310px, a drawer is never
 * narrower than 13rem, and the popper keeps 10px off each edge — 544px, which
 * is the 34rem below. Two numbers that mean different things, deliberately not
 * shared.
 */
export const SHEET_BELOW = '34rem';

/** The media query, in one place, so the stylesheet and the hook cannot drift. */
export const SHEET_QUERY = `(max-width: ${SHEET_BELOW})`;

/**
 * True while the window is too narrow for a menu to stand beside a drawer.
 *
 * Subscribed rather than read once: a desktop window dragged narrow is the
 * same situation as a phone, and a menu that decided at first render which it
 * was would be wrong for the rest of the session. The initial read is guarded
 * because this also renders where there is no `matchMedia` — the test runner
 * mounts these components in a DOM that has none.
 */
export function useNarrow(): boolean {
  return useMedia(SHEET_QUERY);
}

/**
 * The window band where the navigation is a rail: wider than a phone held
 * upright, narrower than the 900px where the sidebar has room for words. A
 * tablet, a phone on its side, a window dragged half across a laptop. The
 * bottom bar is a phone's answer and wastes a landscape screen's scarcest
 * direction; the full sidebar would take a third of the width. Kept in step
 * with the `@media` band of the same name in `app.css`.
 */
export const RAIL_QUERY = '(min-width: 600px) and (max-width: 899.98px)';

/** Whether a media query matches, and again whenever that changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const list = matchMedia(query);
    const read = () => setMatches(list.matches);
    read();
    list.addEventListener('change', read);
    return () => list.removeEventListener('change', read);
  }, [query]);
  return matches;
}

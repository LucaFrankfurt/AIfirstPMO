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
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === 'function' && matchMedia(SHEET_QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(SHEET_QUERY);
    const read = () => setNarrow(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);
  return narrow;
}

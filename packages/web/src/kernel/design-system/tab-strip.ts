import { useEffect, useRef } from 'react';

/**
 * Keeps the tab you are on where you can see it.
 *
 * The strip scrolls sideways when the labels do not fit, which on a phone is
 * most of the time — seven project tabs want 506px and a 390px screen shows
 * four. Landing on `?tab=settings` there put the strip at scroll zero with the
 * active tab off the right-hand end: no underline anywhere on screen, the
 * settings page below it, and nothing to say the two were related.
 *
 * A strip that fits is left alone, which is the whole reason for the resize
 * observer: at a desktop width every strip fits and there is nothing to do, and
 * then the window narrows or a phone turns and the tab you are on is suddenly
 * past the end of a strip that has no reason to re-render. Watching the box
 * catches that; the `active` dependency alone would not.
 *
 * Two deliberate restraints. The clearance the tab lands with is the strip's
 * own `scroll-padding-inline`, set in CSS so it stops short of the fade at the
 * edge rather than under it. And `block: 'nearest'` keeps the page still: a
 * strip already on screen must not scroll the view vertically, which is what a
 * phone would otherwise do on every switch.
 */
export function useTabStrip(active: unknown) {
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;

    const show = () => {
      // Nothing hidden, nothing to scroll to — and no reason to touch the
      // scroll position of a strip that fits.
      if (el.scrollWidth <= el.clientWidth) return;
      el.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    };

    show();
    if (typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(show);
    watch.observe(el);
    return () => watch.disconnect();
  }, [active]);

  return strip;
}

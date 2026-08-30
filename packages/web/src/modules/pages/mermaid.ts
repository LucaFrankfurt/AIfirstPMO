/**
 * Diagrams in a page, a task or a message.
 *
 * Mermaid is by a wide margin the largest thing this app could depend on, so it
 * is never in the bundle: `import()` fetches its chunk the first time a screen
 * actually holds a diagram, and a workspace that never draws one never pays for
 * it. That chunk is served by the same Kolibri that served the app, so it is
 * offline like everything else here — no CDN, nothing to reach for.
 *
 * The renderer leaves a `mermaid` fence as ordinary readable code and marks it.
 * This upgrades the marked ones in place and keeps the source underneath, which
 * is what makes the two failure cases boring: a diagram with a typo in it, and
 * a diagram on a shared page, both show the text somebody wrote.
 */
import { useEffect, useSyncExternalStore, type RefObject } from 'react';

/** Which theme is actually on screen: the chosen one, or the system's. */
function darkNow(): boolean {
  const chosen = document.documentElement.getAttribute('data-theme');
  if (chosen) return chosen === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * A diagram is drawn once, into fixed colours, so it has to be told when the
 * theme moves under it — and the theme here is two separate things: an
 * attribute the app writes onto `<html>`, and the operating system's own
 * setting when nobody has chosen. Watching the attribute rather than asking to
 * be told keeps this out of the way of `useTheme`, which is local state in the
 * shell with no context around it.
 */
function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    media.removeEventListener('change', onChange);
    observer.disconnect();
  };
}

export const useDark = (): boolean => useSyncExternalStore(subscribe, darkNow, () => false);

/** Mermaid wants a unique id per drawing and does not care which. */
let seq = 0;

const WAITING = 'pre.md-mermaid:not([data-drawn])';

/**
 * Draw every `mermaid` fence inside `host`. Does nothing at all — not even a
 * fetch — on a screen that has none.
 *
 * The markdown is handed to React as one blob of HTML, so React owns this
 * subtree and puts it back the way it found it on any re-render: an SVG drawn
 * into it is gone the next time the page saves, or a colleague's edit merges
 * in, or the route re-renders for a reason of its own. Being the last writer is
 * not winnable. So this watches instead, and draws whatever is undrawn whenever
 * the markup underneath changes — including when the change was React undoing
 * the last drawing.
 */
export function useMermaid(host: RefObject<HTMLElement | null>, html: string): void {
  const dark = useDark();

  useEffect(() => {
    const root = host.current;
    if (!root || !root.querySelector('pre.md-mermaid')) return;

    // A drawing carries the theme it was made in, so a change of theme — which
    // is one of the two things that re-runs this — starts them all over.
    for (const node of root.querySelectorAll<HTMLElement>('pre.md-mermaid[data-drawn]')) {
      node.querySelector('.md-diagram')?.remove();
      delete node.dataset.drawn;
    }

    let live = true;
    let drawing = false;
    let again = false;

    const draw = async (): Promise<void> => {
      if (drawing) {
        // Something changed mid-draw. Finish this pass, then look again.
        again = true;
        return;
      }
      const waiting = [...root.querySelectorAll<HTMLElement>(WAITING)];
      if (!waiting.length) return;
      drawing = true;
      try {
        let mermaid;
        try {
          mermaid = (await import('mermaid')).default;
        } catch {
          // The chunk did not arrive. The source is still on the screen, which
          // is the whole reason it was left there.
          return;
        }
        if (!live) return;

        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          // The renderer escapes everything before it emits a tag; mermaid is
          // handed the same untrusted text and is told to do the same.
          securityLevel: 'strict',
          fontFamily: getComputedStyle(document.body).fontFamily,
          // Mermaid's own themes paint the label on an arrow onto a fixed pale
          // swatch, which on a dark page is a grey sticker over the line. The
          // page's own background is what that label is actually sitting on.
          themeVariables: { edgeLabelBackground: getComputedStyle(document.body).backgroundColor },
        });

        for (const node of waiting) {
          const source = node.querySelector('code')?.textContent ?? '';
          if (!source.trim() || !node.isConnected) continue;
          const id = `md-diagram-${seq++}`;
          try {
            // Asked whether it parses before asking it to draw, because a
            // `render` that throws leaves behind the scratch element it was
            // drawing into — which mermaid has by then filled with a large
            // cartoon bomb reading "Syntax error in text". A page being typed
            // into is invalid most of the time, so that would be most of the
            // time, stacked up at the bottom of the document.
            if (!(await mermaid.parse(source, { suppressErrors: true }))) continue;
            const { svg } = await mermaid.render(id, source);
            // React may have replaced this node while mermaid was working. A
            // drawing that lands somewhere no longer on the page is thrown
            // away — the observer has already asked for the next one.
            if (!live || !node.isConnected) continue;
            node.insertAdjacentHTML('beforeend', `<div class="md-diagram">${svg}</div>`);
            node.dataset.drawn = 'true';
          } catch {
            // A diagram half-typed is a draft, not an error worth a banner. The
            // code stays visible and stays readable, and the keystroke that
            // finishes it draws it.
          } finally {
            // ...and for anything `parse` waved through that `render` still
            // choked on, the scratch element goes either way.
            document.getElementById(`d${id}`)?.remove();
          }
        }
      } finally {
        drawing = false;
        if (again && live) {
          again = false;
          void draw();
        }
      }
    };

    // Marking a diagram drawn is itself a change, so this would wake on its own
    // work — except that the next pass finds nothing waiting and stops there.
    const observer = new MutationObserver(() => void draw());
    observer.observe(root, { childList: true, subtree: true });
    void draw();

    return () => {
      live = false;
      observer.disconnect();
    };
  }, [host, html, dark]);
}

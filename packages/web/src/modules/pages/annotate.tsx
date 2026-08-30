/**
 * Inline comments: select a passage, say something about it.
 *
 * The anchoring rule lives in `@kolibri/shared`; this is the part that has to
 * deal with a browser. Two jobs:
 *
 *   - turn a DOM selection inside the rendered page into an offset in the
 *     *source* markdown, which is what the anchor is expressed against;
 *   - paint the anchored passages back onto the rendered HTML afterwards.
 *
 * Both go through the rendered text rather than the markup, because a person
 * selects what they can see. The source offset is recovered by finding the
 * selected text in the source — which is the same search the anchor itself
 * uses, so a passage that cannot be located is simply not offered a comment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { findAnchor, makeAnchor, type Anchor, type Comment } from '@kolibri/shared';
import { useT } from '../../kernel/i18n/i18n';
import { Icon } from '../../kernel/design-system/ui';

export interface Pending {
  anchor: Anchor;
  /** Where to float the "comment on this" button. */
  x: number;
  y: number;
}

/** The plain text of an element, as the reader sees it. */
const textOf = (node: Node): string => node.textContent ?? '';

/**
 * Where the selection sits in the *source*, not in the rendering.
 *
 * The rendered text and the markdown differ — `**bold**` is four characters
 * longer — so rather than mapping character by character through the renderer,
 * the selected string is located in the source. Formatting inside the selection
 * makes that fail, and failing is the right answer: an anchor that cannot be
 * found now will not be findable later either.
 */
function sourceRange(source: string, selected: string, before: string): { start: number; end: number } | null {
  const needle = selected.trim();
  if (needle.length < 3) return null;

  const hits: number[] = [];
  let at = source.indexOf(needle);
  while (at !== -1 && hits.length < 200) {
    hits.push(at);
    at = source.indexOf(needle, at + 1);
  }
  if (!hits.length) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + needle.length };

  // Several matches: the one whose position in the document is closest to how
  // far through the rendered text the selection was.
  const ratio = before.length / Math.max(1, before.length + needle.length);
  const target = ratio * source.length;
  const best = hits.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
  return { start: best, end: best + needle.length };
}

/**
 * Watch for a selection inside `container` and offer to comment on it.
 *
 * Returns the pending anchor and a button to render; the caller decides what
 * "comment" means, because a page and a task detail put the thread in different
 * places.
 */
export function useSelectionAnchor(
  container: HTMLElement | null,
  source: string,
  onStart: (anchor: Anchor) => void,
): { pending: Pending | null; bubble: React.ReactNode } {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (!container) return;
    const onUp = (): void => {
      // A tick, so the selection has settled before it is read.
      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setPending(null);
          return;
        }
        const range = selection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) {
          setPending(null);
          return;
        }
        const selected = selection.toString();
        const upto = range.cloneRange();
        upto.selectNodeContents(container);
        upto.setEnd(range.startContainer, range.startOffset);

        const found = sourceRange(source, selected, textOf(upto.cloneContents()));
        if (!found) {
          setPending(null);
          return;
        }
        const anchor = makeAnchor(source, found.start, found.end);
        if (!anchor) {
          setPending(null);
          return;
        }
        const box = range.getBoundingClientRect();
        const frame = container.getBoundingClientRect();
        setPending({ anchor, x: box.left - frame.left + box.width / 2, y: box.top - frame.top });
      }, 0);
    };

    document.addEventListener('pointerup', onUp);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, [container, source]);

  const bubble = pending ? (
    <button
      className="anchor-bubble"
      style={{ insetInlineStart: pending.x, top: pending.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        onStart(pending.anchor);
        setPending(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      <Icon name="inbox" size={12} /> {t('annotate.comment')}
    </button>
  ) : null;

  return { pending, bubble };
}

/**
 * Paint the anchored passages onto the rendered HTML.
 *
 * Done to the DOM after the render rather than by rewriting the markup, because
 * the renderer produces plain HTML on purpose and a highlight is a *view* of a
 * comment, not part of the document.
 */
export function useHighlights(
  container: HTMLElement | null,
  source: string,
  comments: Comment[],
  active: string | null,
  onPick: (id: string) => void,
): void {
  const anchored = useMemo(
    () => comments
      .filter((comment) => comment.anchor?.quote)
      .map((comment) => ({ id: comment.id, found: findAnchor(source, comment.anchor), quote: comment.anchor!.quote }))
      .filter((entry) => entry.found),
    [comments, source],
  );

  const paint = useCallback(() => {
    if (!container) return;
    for (const old of container.querySelectorAll('mark.anchor')) {
      old.replaceWith(...old.childNodes);
    }
    container.normalize();
    if (!anchored.length) return;

    // Longest first, so a comment on a sentence does not get cut in half by a
    // comment on one word inside it.
    for (const entry of [...anchored].sort((a, b) => b.quote.length - a.quote.length)) {
      wrapFirst(container, entry.quote, entry.id, entry.id === active, onPick);
    }
  }, [container, anchored, active, onPick]);

  /**
   * Repaint when the highlights change — and not while somebody is selecting.
   *
   * This had no dependency array, so it ran after every render. `paint` unwraps
   * each `mark` and puts the text back, which replaces the very text nodes a
   * live Selection points at: the selection collapses and the page relays. The
   * render that selecting a passage *causes* — the one that offers the comment
   * button — was therefore the render that threw the selection away.
   *
   * `paint` is stable while nothing has changed (`anchored` comes from a
   * memoised query, `onPick` is a state setter), so the array alone stops the
   * repaint-on-every-render. The guard is for the other way in: a sync tick
   * arriving mid-drag changes the comments, and a repaint that lands then is
   * just as destructive. It waits for the selection to end, which is the only
   * moment at which redrawing costs nothing.
   */
  useEffect(() => {
    if (!container) return;
    if (!selecting(container)) {
      paint();
      return;
    }
    const later = (): void => {
      if (selecting(container)) return;
      document.removeEventListener('selectionchange', later);
      paint();
    };
    document.addEventListener('selectionchange', later);
    return () => document.removeEventListener('selectionchange', later);
  }, [container, paint]);
}

/** Is there a live selection with something in it, inside this element? */
function selecting(container: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return container.contains(selection.getRangeAt(0).commonAncestorContainer);
}

/** Wrap the first occurrence of `quote` in the container's text nodes. */
function wrapFirst(
  container: HTMLElement,
  quote: string,
  id: string,
  isActive: boolean,
  onPick: (id: string) => void,
): void {
  const needle = quote.replace(/\s+/g, ' ').trim();
  if (!needle) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const at = node.data.indexOf(needle);
    if (at !== -1) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const mark = document.createElement('mark');
      mark.className = `anchor${isActive ? ' active' : ''}`;
      mark.dataset.comment = id;
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        onPick(id);
      });
      try {
        range.surroundContents(mark);
      } catch {
        // The passage runs across an element boundary (half of it is bold, or
        // it spans two paragraphs). The comment still exists and still lists
        // its quote; it simply is not painted.
      }
      return;
    }
    node = walker.nextNode() as Text | null;
  }
}

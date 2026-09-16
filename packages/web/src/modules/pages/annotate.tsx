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
 * selects what they can see. Both are also the same question — the same copy of
 * the same passage, in the other spelling of the text — so both are `sameQuote`,
 * once in each direction. That matters for more than tidiness: the two used to
 * disagree, and a comment left on the second "Ask Grace" on a page was painted
 * under the first one, because the paint searched for the quote and took
 * whatever it hit first.
 *
 * What is still refused is a selection that crosses *markup*: half of it bold,
 * or a word that is a link. The rendered text of such a passage is not in the
 * source at all — `**important**` reads as `important` — and no amount of
 * searching finds it. Whitespace, which used to fail the same way and looked
 * like a length limit, does not: see `flatten` in `anchor.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { findAnchor, makeAnchor, sameQuote, type Anchor, type Comment, type Found } from '@kolibri/shared';
import { useT } from '../../kernel/i18n/i18n';
import { Icon } from '../../kernel/design-system/ui';

export interface Pending {
  anchor: Anchor;
  /** Where to float the "comment on this" button. */
  x: number;
  y: number;
}

/**
 * The page as a string, and the text nodes it was read out of.
 *
 * The string is every text node's data end to end, which is exactly what a
 * `Range` spanning the same nodes stringifies to — so an offset into one is an
 * offset into the other, and the selection needs no second measurement. The
 * runs are the way back: a passage that has to be underlined is a span of this
 * string, and underlining it means finding the nodes that span sits in.
 */
interface Reading {
  raw: string;
  runs: { node: Text; at: number }[];
}

function readPage(container: HTMLElement): Reading {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const runs: { node: Text; at: number }[] = [];
  let raw = '';
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    runs.push({ node, at: raw.length });
    raw += node.data;
  }
  return { raw, runs };
}

/** The shortest selection worth treating as one: below this it is a mis-click. */
const MIN_SELECTION = 3;

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

        // `range.toString()` rather than `selection.toString()`: the first is
        // the text nodes' data verbatim, which is what `readPage` reads, and
        // the second is a browser's idea of how that renders.
        const picked = range.toString();
        const needle = picked.trim();
        if (needle.replace(/\s+/g, ' ').length < MIN_SELECTION) {
          setPending(null);
          return;
        }
        const upto = range.cloneRange();
        upto.selectNodeContents(container);
        upto.setEnd(range.startContainer, range.startOffset);
        const at = upto.toString().length + (picked.length - picked.trimStart().length);

        const found = sameQuote({ text: readPage(container).raw, at }, source, needle);
        const anchor = found && makeAnchor(source, found.start, found.end);
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
      .map((comment) => ({
        id: comment.id,
        anchor: comment.anchor as Anchor,
        // Which copy the comment is *about*, decided in the source, where the
        // prefix and suffix it recorded are also expressed. The page only has
        // to be told where that copy reads.
        meant: findAnchor(source, comment.anchor),
      }))
      .filter((entry): entry is { id: string; anchor: Anchor; meant: Found } => entry.meant !== null),
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
    for (const entry of [...anchored].sort((a, b) => b.anchor.quote.length - a.anchor.quote.length)) {
      // Read the page again for each passage: underlining one splits the very
      // text nodes the next one would have been measured against.
      const page = readPage(container);
      const here = sameQuote({ text: source, at: entry.meant.start }, page.raw, entry.anchor.quote);
      if (!here) continue;
      underline(page, here, () => {
        const mark = document.createElement('mark');
        mark.className = `anchor${entry.id === active ? ' active' : ''}`;
        mark.dataset.comment = entry.id;
        mark.addEventListener('click', (event) => {
          event.stopPropagation();
          onPick(entry.id);
        });
        return mark;
      });
    }
  }, [container, anchored, source, active, onPick]);

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

/**
 * Underline `[found.start, found.end)` of the reading, node by node.
 *
 * A passage that crosses an element boundary — half of it bold, or a sentence
 * running into the next paragraph — cannot be wrapped in one element, and
 * `Range.surroundContents` says so by throwing. It used to be caught and the
 * passage simply went unpainted. A mark per node it crosses is what the browser
 * would have drawn anyway, and it is the same mark: the click, the id and the
 * active class are on each piece, so the comment behaves as one thing.
 */
function underline(page: Reading, found: Found, mark: () => HTMLElement): void {
  for (const run of page.runs) {
    const from = Math.max(found.start, run.at) - run.at;
    const to = Math.min(found.end, run.at + run.node.data.length) - run.at;
    if (to <= from) continue;
    // The newline between `</p>` and `<p>` is a character of the reading and
    // nothing on the page; a mark around it draws a stray rule between blocks.
    if (!run.node.data.slice(from, to).trim()) continue;

    let part = run.node;
    if (to < part.data.length) part.splitText(to);
    if (from > 0) part = part.splitText(from);
    const box = mark();
    part.before(box);
    box.append(part);
  }
}

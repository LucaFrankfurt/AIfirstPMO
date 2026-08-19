/**
 * Anchoring a comment to a passage of text.
 *
 * The hard part of an inline comment is not the comment: it is that the text it
 * points at keeps being edited. An offset is wrong the moment somebody types a
 * word above it, and an id embedded in the content changes what the content is.
 *
 * So an anchor is a *quote with its surroundings* — the same idea as the W3C
 * Web Annotation text-quote selector. Finding it again is a search, in this
 * order:
 *
 *   1. the quote appears exactly once → that is it, wherever it moved to;
 *   2. it appears several times → the copy whose neighbouring text matches best;
 *   3. it does not appear at all → the comment is *orphaned*, and says so.
 *
 * Point three is why this returns null rather than guessing. A comment silently
 * re-attached to the wrong sentence is worse than one that admits the sentence
 * it was about is gone.
 */

/** How much text either side is kept to tell two identical quotes apart. */
const CONTEXT = 40;

export interface Anchor {
  /** The selected text itself. */
  quote: string;
  /** The text immediately before and after it, for disambiguation. */
  prefix: string;
  suffix: string;
}

export interface Found {
  start: number;
  end: number;
  /** True when the quote was found by its neighbours rather than uniquely. */
  ambiguous: boolean;
}

/** Build an anchor for `text.slice(start, end)`. */
export function makeAnchor(text: string, start: number, end: number): Anchor | null {
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  return {
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

/** How many characters two strings share, reading from the given end. */
function overlap(a: string, b: string, fromEnd: boolean): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit) {
    const left = fromEnd ? a[a.length - 1 - count] : a[count];
    const right = fromEnd ? b[b.length - 1 - count] : b[count];
    if (left !== right) break;
    count++;
  }
  return count;
}

/** Every index at which `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let at = haystack.indexOf(needle);
  while (at !== -1 && out.length < 500) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * Find the passage an anchor points at in the current text.
 *
 * Returns null when the quote is gone — the caller shows the comment as
 * orphaned rather than pointing it at something else.
 */
export function findAnchor(text: string, anchor: Anchor | null | undefined): Found | null {
  if (!anchor?.quote) return null;
  const hits = occurrences(text, anchor.quote);
  if (!hits.length) return null;
  if (hits.length === 1) {
    return { start: hits[0], end: hits[0] + anchor.quote.length, ambiguous: false };
  }

  // Several copies of the same sentence: the right one is the one whose
  // neighbours look most like the neighbours we recorded.
  let best = hits[0];
  let bestScore = -1;
  for (const at of hits) {
    const before = text.slice(Math.max(0, at - CONTEXT), at);
    const after = text.slice(at + anchor.quote.length, at + anchor.quote.length + CONTEXT);
    const score = overlap(before, anchor.prefix ?? '', true) + overlap(after, anchor.suffix ?? '', false);
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return { start: best, end: best + anchor.quote.length, ambiguous: true };
}

/** A short, single-line version of the quote, for showing above the comment. */
export function anchorLabel(anchor: Anchor | null | undefined, max = 90): string {
  const quote = (anchor?.quote ?? '').replace(/\s+/g, ' ').trim();
  return quote.length > max ? `${quote.slice(0, max - 1)}…` : quote;
}

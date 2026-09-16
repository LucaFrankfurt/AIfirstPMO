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
 *
 * Every search here reads whitespace loosely, and that is not a nicety — see
 * `flatten` for the bug it was written for.
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

/**
 * The text as it reads, and where each character of that came from.
 *
 * `from` and `to` are what turn an answer back into an offset in the text that
 * was passed in. Both ends, not a shift: a whole run of whitespace stands
 * behind one space, so a character's span is not always one character wide.
 */
interface Flattened {
  text: string;
  /** For character `i` of `text`, the half-open span of the original it stands for. */
  from: number[];
  to: number[];
}

/** `\s`, which is also U+00A0 — `&nbsp;` comes back from a browser as one. */
const SPACE = /\s/;

/**
 * Read a text with its whitespace loosened, keeping the way back.
 *
 * A markdown source and the page rendered from it say the same sentence in two
 * spellings, and for a passage with no markup in it they differ by exactly one
 * thing: the runs of whitespace. `inlineBlock` joins a paragraph's lines with a
 * space and the browser collapses whatever is left, so
 * `We ship on Friday.\nAsk Grace.` in the source is
 * `We ship on Friday. Ask Grace.` on screen.
 *
 * Comparing the flattened forms is therefore comparing what a person actually
 * selected, and that is the whole of a bug that was reported as something else
 * entirely: a selection crossing a line break could not be found in the source,
 * so a comment could be left on anything up to the end of a source line and on
 * nothing past it. It looked exactly like a limit on how much text one is
 * allowed to select, and it was a newline.
 */
function flatten(text: string): Flattened {
  const out: Flattened = { text: '', from: [], to: [] };
  const keep = (char: string, at: number, until: number): void => {
    out.text += char;
    out.from.push(at);
    out.to.push(until);
  };
  let run = -1; // where the run of whitespace being read began
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (SPACE.test(char)) {
      if (run < 0) run = at;
      continue;
    }
    if (run >= 0) {
      keep(' ', run, at);
      run = -1;
    }
    keep(char, at, at + 1);
  }
  if (run >= 0) keep(' ', run, text.length);
  return out;
}

/** An answer in the flattened text, as offsets in the text it was flattened from. */
function span(hay: Flattened, at: number, length: number, ambiguous: boolean): Found {
  return { start: hay.from[at], end: hay.to[at + length - 1], ambiguous };
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
  if (!anchor?.quote?.trim()) return null;
  const hay = flatten(text);
  const quote = flatten(anchor.quote).text;
  const hits = occurrences(hay.text, quote);
  if (!hits.length) return null;
  if (hits.length === 1) return span(hay, hits[0], quote.length, false);

  // Several copies of the same sentence: the right one is the one whose
  // neighbours look most like the neighbours we recorded.
  const prefix = flatten(anchor.prefix ?? '').text;
  const suffix = flatten(anchor.suffix ?? '').text;
  let best = hits[0];
  let bestScore = -1;
  for (const at of hits) {
    const before = hay.text.slice(Math.max(0, at - CONTEXT), at);
    const after = hay.text.slice(at + quote.length, at + quote.length + CONTEXT);
    const score = overlap(before, prefix, true) + overlap(after, suffix, false);
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return span(hay, best, quote.length, true);
}

/**
 * The same copy of a passage, in the other spelling of the same text.
 *
 * An inline comment lives between two texts that say the same thing: the source
 * the anchor is expressed against, and the page as it reads, which is what
 * somebody points at with a mouse. Both directions are needed — a selection has
 * to become an offset in the source, and an anchor has to become a place on
 * screen — and both are the same question, so this is one function.
 *
 * The hard half is *which copy*. A page that says "Ask Grace" three times has
 * three, and picking the first is how a comment on the third one ends up
 * underlining the first. The honest bridge is the count: when both texts hold
 * the same number of copies, the nth here is the nth there, whatever markup
 * sits between them. When they do not — the quote also occurs inside a link
 * target, say — the nearest copy at the same relative depth through the text is
 * the closest thing to an answer, and it says it had to choose.
 */
export function sameQuote(from: { text: string; at: number }, to: string, quote: string): Found | null {
  const needle = flatten(quote).text;
  if (!needle.trim()) return null;
  const there = flatten(to);
  const hits = occurrences(there.text, needle);
  if (!hits.length) return null;

  const here = flatten(from.text);
  const mine = occurrences(here.text, needle);
  // Which copy the caller means: the one starting nearest the offset it gave.
  let nth = -1;
  let nearest = Infinity;
  mine.forEach((at, index) => {
    const gap = Math.abs(here.from[at] - from.at);
    if (gap < nearest) {
      nearest = gap;
      nth = index;
    }
  });

  if (nth >= 0 && mine.length === hits.length) {
    return span(there, hits[nth], needle.length, hits.length > 1);
  }
  const depth = here.text.length ? (nth >= 0 ? mine[nth] : 0) / here.text.length : 0;
  const target = depth * there.text.length;
  const best = hits.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
  return span(there, best, needle.length, true);
}

/** A short, single-line version of the quote, for showing above the comment. */
export function anchorLabel(anchor: Anchor | null | undefined, max = 90): string {
  const quote = (anchor?.quote ?? '').replace(/\s+/g, ' ').trim();
  return quote.length > max ? `${quote.slice(0, max - 1)}…` : quote;
}

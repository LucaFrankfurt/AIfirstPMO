/**
 * What somebody typed into the search box, read as a question.
 *
 * The box takes prose. It is the only thing most people will ever type into
 * it, and it has to work on its own — "rechnung letzte woche" is a search, not
 * a syntax error. On top of that there are three characters that open a list
 * of names: `@` for a person, `#` for a label, `+` for a project. Nothing has
 * to be memorised, because the list appears as soon as the character is typed
 * and says what it is offering.
 *
 * A filter is therefore never *typed*, only *picked* — this module only ever
 * recognises a name it was handed. `@anna` where nobody is called Anna stays
 * the words "@anna" and is searched for as text, which is what a filter
 * language cannot do and is exactly what somebody who does not know there is a
 * filter language expects.
 *
 * No React here on purpose: this is the part worth testing.
 */

export type FacetKind = 'person' | 'label' | 'project';

/** The character that opens each list, and the list each character opens. */
export const TRIGGER_OF: Record<FacetKind, string> = { person: '@', label: '#', project: '+' };
export const KIND_OF: Record<string, FacetKind> = { '@': 'person', '#': 'label', '+': 'project' };

/** Something that can be picked: a person, a label, a project. */
export interface FacetOption {
  kind: FacetKind;
  /**
   * Every row this name stands for. Two projects may both call a label
   * "Bug"; somebody filtering by "#Bug" means both of them, and a search that
   * silently picked one of the two would be wrong in a way nobody could see.
   */
  ids: string[];
  name: string;
  /** Shown beside the name — a project key, an address. Also searched. */
  hint?: string;
  color?: string;
}

/** A name that was recognised, and where in the text it sits. */
export interface Facet extends FacetOption {
  start: number;
  end: number;
}

export interface ParsedQuery {
  /** Everything that was not a filter, which is what gets searched for. */
  text: string;
  facets: Facet[];
}

/** The half-typed name under the caret, if there is one. */
export interface Trigger {
  kind: FacetKind;
  /** Index of the trigger character itself. */
  start: number;
  /** The caret — everything from `start + 1` to here is what was typed. */
  end: number;
  term: string;
}

export interface Suggestion {
  trigger: Trigger;
  options: FacetOption[];
}

/**
 * Case, accents and the two ways to write an accent, all made not to matter.
 *
 * "Jose" finds "José" and "MÜLLER" finds "Müller", because a search box where
 * the umlaut has to be right is a search box that half the people in a German
 * company will give up on.
 */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const isBoundary = (char: string | undefined): boolean => char === undefined || /[\s(,;]/.test(char);

/**
 * Read the whole box: which names are in it, and what is left over.
 *
 * A trigger character only counts at the start of a word, so an e-mail address
 * in a search is an e-mail address, and it only counts when a name it was
 * given actually follows — the longest one, so "@Anna Schmidt" beats a
 * colleague called "Anna" and the surname does not fall out into the text.
 */
export function parseQuery(input: string, options: FacetOption[]): ParsedQuery {
  const facets: Facet[] = [];
  let text = '';
  let index = 0;

  while (index < input.length) {
    const kind = KIND_OF[input[index]];
    if (kind && isBoundary(input[index - 1])) {
      const match = matchAt(input, index + 1, options, kind);
      if (match) {
        facets.push({ ...match.option, start: index, end: match.end });
        // A space, so "a@Bb" cannot be stitched into one word once the name in
        // the middle is lifted out of it.
        text += ' ';
        index = match.end;
        continue;
      }
    }
    text += input[index];
    index += 1;
  }

  return { text: text.replace(/\s+/g, ' ').trim(), facets };
}

/** The longest name of this kind that the text spells out at `from`. */
function matchAt(input: string, from: number, options: FacetOption[], kind: FacetKind): { option: FacetOption; end: number } | null {
  let best: { option: FacetOption; end: number } | null = null;
  for (const option of options) {
    if (option.kind !== kind || !option.name) continue;
    const end = from + option.name.length;
    if (best && end <= best.end) continue;
    // A name has to end where a word ends: "#bug" must not match inside
    // "#bugfix", which is a word somebody meant to search for.
    if (!isBoundary(input[end])) continue;
    if (fold(input.slice(from, end)) !== fold(option.name)) continue;
    best = { option, end };
  }
  return best;
}

/**
 * What to offer under the caret.
 *
 * Returns nothing at all rather than an empty list, because "no suggestions"
 * and "a popup with nothing in it" are different things on screen. The popup
 * closes on its own in the two cases that matter: the name is finished and a
 * space was typed after it, and what has been typed is no longer anybody's
 * name — at which point it is simply text again.
 */
export function suggest(input: string, caret: number, options: FacetOption[], limit = 8): Suggestion | null {
  const trigger = triggerAt(input, caret);
  if (!trigger) return null;
  const term = trigger.term;
  // A name, then a space: that filter is done. Anything else typed after it is
  // the next word of the search and not a further attempt at the name.
  if (/\s$/.test(term) && options.some((o) => o.kind === trigger.kind && fold(o.name) === fold(term.trim()))) return null;
  const matches = rank(options, trigger.kind, term, limit);
  return matches.length ? { trigger, options: matches } : null;
}

/** The trigger character the caret is still inside the word of. */
function triggerAt(input: string, caret: number): Trigger | null {
  // Long enough for "@Maria del Carmen", short enough that a paragraph with a
  // stray `@` in it does not keep a popup open to the end of the line.
  const floor = Math.max(0, caret - 40);
  for (let index = caret - 1; index >= floor; index -= 1) {
    const char = input[index];
    if (char === '\n') return null;
    const kind = KIND_OF[char];
    if (!kind) continue;
    if (!isBoundary(input[index - 1])) return null;
    return { kind, start: index, end: caret, term: input.slice(index + 1, caret) };
  }
  return null;
}

/**
 * Best guesses first: what starts with what was typed, then what merely
 * contains it, each alphabetically. Typing nothing after the trigger offers
 * the whole list, which is how somebody who does not know any of the names
 * finds out what there is.
 */
function rank(options: FacetOption[], kind: FacetKind, term: string, limit: number): FacetOption[] {
  const needle = fold(term.trim());
  const scored: { option: FacetOption; score: number }[] = [];
  for (const option of options) {
    if (option.kind !== kind) continue;
    if (!needle) {
      scored.push({ option, score: 1 });
      continue;
    }
    const name = fold(option.name);
    const hint = fold(option.hint ?? '');
    // "schmidt" should find "Anna Schmidt": a surname is a word of the name,
    // not the start of it.
    const score = name.startsWith(needle) ? 0
      : name.split(/\s+/).some((word) => word.startsWith(needle)) || hint.startsWith(needle) ? 1
        : name.includes(needle) || hint.includes(needle) ? 2
          : -1;
    if (score >= 0) scored.push({ option, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.option.name.localeCompare(b.option.name))
    .slice(0, limit)
    .map((entry) => entry.option);
}

/** Put a picked name into the text, and say where the caret goes after it. */
export function applySuggestion(input: string, trigger: Trigger, option: FacetOption): { value: string; caret: number } {
  const inserted = `${TRIGGER_OF[option.kind]}${option.name} `;
  const value = input.slice(0, trigger.start) + inserted + input.slice(trigger.end);
  return { value, caret: trigger.start + inserted.length };
}

/** Take a filter back out again — what the × on a chip does. */
export function removeFacet(input: string, facet: Facet): string {
  return `${input.slice(0, facet.start)}${input.slice(facet.end)}`.replace(/\s+/g, ' ').trim();
}

/**
 * The words the free text asks about.
 *
 * All of them have to appear, and each of them anywhere inside a word rather
 * than only at its start — deliberately a little wider than the server's index,
 * which matches on prefixes. The local answer is the one that appears while
 * somebody is still typing, and an answer that is there and then gone as the
 * server's narrower one replaces it reads as a bug.
 */
export const terms = (text: string): string[] => fold(text).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

export const matchesTerms = (haystack: string, words: string[]): boolean => {
  if (!words.length) return true;
  const folded = fold(haystack);
  // A single character is matched at the start of a word rather than anywhere
  // inside one. Anything else and the first keystroke of every search — the
  // `@` of a name most of all — matches almost every row there is, so the list
  // underneath flails while somebody is still typing the first word.
  const parts = folded.split(/[^\p{L}\p{N}_]+/u);
  return words.every((word) => (word.length > 1
    ? folded.includes(word)
    : parts.some((part) => part.startsWith(word))));
};

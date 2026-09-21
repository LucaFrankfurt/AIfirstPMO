/**
 * What somebody typed into a search box, read as terms.
 *
 * The box takes prose, and prose is what nearly everybody will ever put in it.
 * On top of that it understands three things, none of which has to be learnt
 * before the box is useful:
 *
 * - `"eine genaue wortfolge"` — the words, adjacent and in that order. This is
 *   the one the index cannot guess at: without it `rechnung 2024` finds every
 *   task that says "Rechnung" somewhere and "2024" somewhere else, and there is
 *   no way to say that they belong together.
 * - `-wort` — and not this. The cheapest way out of a search that is drowning
 *   in one obvious wrong answer.
 * - `FEE-1` — a task by the name people actually use for it. Without this rule
 *   the hyphen is a word boundary like any other and the search becomes "a word
 *   starting with fee AND a word starting with 1", which in a workspace of any
 *   size is most of it.
 *
 * Quoting a single word is not a mistake either: `"rechnung"` is the whole word
 * and finds neither `Rechnungsprüfung` nor `Rechnungen`, which is the other
 * half of what a quote is for.
 *
 * **One grammar, two readers.** The server compiles these terms to an FTS5
 * MATCH and the client matches them against the rows it already has, so the
 * instant answer and the indexed one agree about what was asked. They did not
 * have to: the box used to split on non-word characters in two places, and the
 * two spellings of "a word" were free to drift apart with nobody watching.
 *
 * Nothing here touches a database or a component on purpose — this is the part
 * worth testing, and it is tested in `packages/server/test/search.test.ts`.
 */

/** A word, a phrase, or a task somebody named outright. */
export interface SearchTerm {
  /** The words it is made of, folded. More than one only for a phrase. */
  words: string[];
  /**
   * Whether the last word may be the start of a longer one.
   *
   * True while typing, which is nearly always: `des` should already find
   * "Design". A closed quote is the way to say no.
   */
  prefix: boolean;
  /** Written with a `-` in front: whatever carries this is dropped. */
  negated: boolean;
  /** `FEE-1`, when the term was written as a task identifier. */
  identifier: string | null;
}

/**
 * Case, accents and the two ways to write an accent, all made not to matter.
 *
 * "Jose" finds "José" and "MÜLLER" finds "Müller", because a search box where
 * the umlaut has to be right is a search box that half the people in a German
 * company will give up on. The same normalisation the index does — `search_index`
 * is tokenised with `remove_diacritics 2`.
 */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Everything between two word characters is a boundary, as it is in the index. */
const wordsOf = (text: string): string[] => fold(text).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

/**
 * A quoted run is one token, and so is everything up to the next space.
 *
 * The closing quote is optional because somebody typing one has not reached it
 * yet — see `readToken` for what an open quote means.
 */
const TOKEN = /-?"[^"]*"?|[^\s"]+/g;

/**
 * More terms than this and the query is a paste rather than a question.
 *
 * FTS5 will happily run a forty-term MATCH; it will just take the time that
 * implies, once per keystroke, on the one thread the server has.
 */
const MAX_TERMS = 12;

/**
 * The shape of a task identifier, which is all this can honestly check.
 *
 * `markdown.ts` makes the same point at more length: `[A-Z]+-\d+` on its own
 * also matches `UTF-8`, `COVID-19` and `ISO-8601`. There the renderer is handed
 * the project keys that exist; here nothing is handed anything, and it does not
 * need to be — a search for `COVID-19` is a search for the words either way,
 * and the identifier only ever *adds* the one task that answers to that name.
 * If no task does, nothing happens. That is the same rule `@anna` follows: a
 * name nobody has stays a word.
 */
const IDENTIFIER = /^([\p{L}][\p{L}\p{N}]{0,9})-(\d{1,6})$/u;

/** `fee-1` -> `FEE-1`. Keys are stored upper-case; what was typed need not be. */
export function asIdentifier(token: string): string | null {
  const found = IDENTIFIER.exec(token.trim());
  return found ? `${found[1].toUpperCase()}-${found[2]}` : null;
}

/** `rechnung "design review" -intern FEE-1` -> four terms. */
export function parseTerms(input: string, limit = MAX_TERMS): SearchTerm[] {
  const out: SearchTerm[] = [];
  for (const [token] of String(input ?? '').matchAll(TOKEN)) {
    for (const term of readToken(token)) {
      out.push(term);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function readToken(raw: string): SearchTerm[] {
  const negated = raw.length > 1 && raw.startsWith('-');
  const text = negated ? raw.slice(1) : raw;

  if (text.startsWith('"')) {
    const closed = text.length > 1 && text.endsWith('"');
    const words = wordsOf(text.slice(1, closed ? -1 : undefined));
    // A quote still open is a phrase somebody is in the middle of typing.
    // Matched as far as it goes rather than not at all, so the list narrows
    // with every keystroke instead of standing empty until the second quote —
    // which is also what makes the quote discoverable by trying it.
    return words.length ? [{ words, prefix: !closed, negated, identifier: null }] : [];
  }

  const identifier = asIdentifier(text);
  // A phrase, because that is what an identifier is once the tokeniser has had
  // the hyphen: two words that have to be next to each other. Still a prefix,
  // so `WEB-1` on the way to `WEB-12` finds it rather than nothing.
  if (identifier) return [{ words: wordsOf(text), prefix: true, negated, identifier }];

  // Punctuation inside an unquoted word is a boundary, and each piece is its
  // own term — the way this has always read prose, and deliberately looser
  // than a phrase: `foo.bar` finding a page that says "bar of foo" is a fair
  // guess, where `"foo bar"` asking for it is a statement.
  return wordsOf(text).map((word) => ({ words: [word], prefix: true, negated, identifier: null }));
}

/** Every task named outright, in the order they were typed, once each. */
export const identifiersIn = (terms: readonly SearchTerm[]): string[] =>
  [...new Set(terms.filter((term) => term.identifier && !term.negated).map((term) => term.identifier as string))];

/**
 * The terms as one string, for a cache key or a dependency array.
 *
 * `words.join(' ')` on its own would make `-rechnung` and `rechnung` the same
 * key, and a memo that cannot tell a search from its opposite is worse than no
 * memo at all.
 */
export const termsKey = (terms: readonly SearchTerm[]): string =>
  terms.map((term) => `${term.negated ? '-' : ''}${term.words.join(' ')}${term.prefix ? '*' : ''}`).join('|');

/**
 * Whether this text answers every term.
 *
 * Deliberately a little wider than the index for a single word: it is matched
 * anywhere inside one rather than only at its start. The local answer is the
 * one that appears while somebody is still typing, and an answer that is there
 * and then gone as the server's narrower one replaces it reads as a bug. A
 * phrase is *not* widened that way — a quote is somebody being precise, and
 * answering something looser than what they asked is the one thing a quote
 * rules out.
 */
export function matchesTerms(haystack: string, terms: readonly SearchTerm[]): boolean {
  if (!terms.length) return true;
  const folded = fold(haystack);
  const parts = folded.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  return terms.every((term) => carries(folded, parts, term) !== term.negated);
}

function carries(folded: string, parts: string[], term: SearchTerm): boolean {
  if (term.words.length > 1) return adjacent(parts, term.words, term.prefix);
  const word = term.words[0];
  if (!term.prefix) return parts.includes(word);
  // A single character is matched at the start of a word rather than anywhere
  // inside one. Anything else and the first keystroke of every search — the
  // `@` of a name most of all — matches almost every row there is, so the list
  // underneath flails while somebody is still typing the first word.
  if (word.length === 1) return parts.some((part) => part.startsWith(word));
  return folded.includes(word);
}

/** The words, next to each other and in order — the last one open if `prefix`. */
function adjacent(parts: string[], words: string[], prefix: boolean): boolean {
  const last = words.length - 1;
  for (let at = 0; at + words.length <= parts.length; at += 1) {
    let all = true;
    for (let index = 0; index < words.length && all; index += 1) {
      all = index === last && prefix
        ? parts[at + index].startsWith(words[index])
        : parts[at + index] === words[index];
    }
    if (all) return true;
  }
  return false;
}

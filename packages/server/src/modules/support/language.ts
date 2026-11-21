/**
 * Which of the app's three languages a visitor writes in — or null, when the
 * words do not say.
 *
 * The prompt has always told the model to answer in the visitor's language,
 * and on a knowledge base that mixes languages it did not always: measured on
 * a live instance on 21 November 2026, a visitor's English question about
 * prices was answered in German, with a German page and a German greeting in
 * front of it. So the language is now decided here and said to the model as a
 * fact, and the same answer picks the language of the line a visitor is left
 * with when the model hands over without one.
 *
 * Counted, not guessed: words that are unambiguous in one language and do not
 * occur in the other two as everyday words. "was", "die", "a", "an", "son"
 * are left out on purpose — each is common in two of them. A line too short
 * to hold one of these words is undecided, and undecided means the model
 * decides, exactly as before this existed.
 */
export type VisitorLanguage = 'en' | 'de' | 'fr';

const WORDS: Record<VisitorLanguage, string[]> = {
  en: [
    'the', 'and', 'is', 'are', 'you', 'your', 'my', 'it', 'to', 'of', 'for', 'with', 'how', 'what', 'when',
    'where', 'why', 'can', 'could', 'do', 'does', 'have', 'there', 'this', 'please', 'thanks', 'hello', 'hi',
    'much', 'cost', 'need', 'want', 'would', 'should',
  ],
  de: [
    'der', 'das', 'und', 'ist', 'sind', 'ich', 'mein', 'meine', 'wie', 'wann', 'wo', 'warum', 'kann', 'können',
    'habe', 'hat', 'nicht', 'mit', 'für', 'ein', 'eine', 'ihr', 'euch', 'bitte', 'danke', 'hallo', 'gibt', 'es',
    'auf', 'zu', 'kostet', 'kosten', 'welche', 'welcher', 'wir', 'uns', 'sie', 'mir', 'mich', 'noch',
  ],
  fr: [
    'le', 'la', 'les', 'et', 'est', 'je', 'mon', 'ma', 'mes', 'vous', 'votre', 'comment', 'quand', 'où',
    'pourquoi', 'peux', 'pouvez', 'avec', 'pour', 'un', 'une', 'des', 'bonjour', 'merci', 'il', 'pas', 'ne',
    'combien', 'coûte', 'quel', 'quelle', 'nous', 'sur', 'dans',
  ],
};

/** Letters that belong to one language here, worth a word each. */
const LETTERS: [VisitorLanguage, RegExp][] = [['de', /[äöüß]/g], ['fr', /[éèêàçùœ]/g]];

function scores(text: string): Record<VisitorLanguage, number> {
  const words = String(text).toLowerCase().match(/[a-zäöüßéèêàçùœ']+/g) ?? [];
  const out: Record<VisitorLanguage, number> = { en: 0, de: 0, fr: 0 };
  for (const word of words) {
    for (const language of Object.keys(WORDS) as VisitorLanguage[]) {
      if (WORDS[language].includes(word)) out[language] += 1;
    }
  }
  for (const [language, pattern] of LETTERS) out[language] += (String(text).toLowerCase().match(pattern) ?? []).length;
  return out;
}

/** The language with the most, if it has more than either other; otherwise null. */
function winner(counted: Record<VisitorLanguage, number>): VisitorLanguage | null {
  const ranked = (Object.entries(counted) as [VisitorLanguage, number][]).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 && ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}

/**
 * The language of a visitor's lines, newest first.
 *
 * The newest line decides when it can — somebody who switches language is
 * answered in the one they switched to — and the few before it are asked only
 * when it cannot, a "ok?" or a "thanks" being nobody's language.
 */
export function visitorLanguage(newestFirst: string[]): VisitorLanguage | null {
  const lines = newestFirst.map((line) => String(line ?? '')).filter((line) => line.trim());
  if (!lines.length) return null;
  return winner(scores(lines[0])) ?? winner(scores(lines.slice(0, 3).join(' ')));
}

/** The language's name as the prompt says it. */
export const LANGUAGE_NAMES: Record<VisitorLanguage, string> = { en: 'English', de: 'German', fr: 'French' };

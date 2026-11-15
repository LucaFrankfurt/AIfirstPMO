/**
 * The one sentence a phone is shown, in the reader's language.
 *
 * Its own three entries rather than keys in `kernel/i18n`, because the relay
 * is a separate process with no database — and the server's catalogue reads
 * the database the moment it is imported, to know an instance's default
 * language. Three strings are cheaper than a relay that opens SQLite to say
 * "New activity".
 *
 * The sentence is fixed on purpose. A relay that would put whatever text it is
 * sent on a phone is a relay anybody who learns a token can write to that
 * phone with; one that only ever says this has nothing worth stealing.
 */
const WORDS = {
  en: { title: 'New activity', body: 'Open Kolibri to see what is new.' },
  de: { title: 'Neue Aktivität', body: 'Öffne Kolibri, um zu sehen, was neu ist.' },
  fr: { title: 'Nouvelle activité', body: 'Ouvrez Kolibri pour voir les nouveautés.' },
} as const;

export interface Words { title: string; body: string }

/** The sentence in this language, or in English for one the relay does not have. */
export const wakeWords = (locale: unknown): Words =>
  (typeof locale === 'string' && locale in WORDS ? WORDS[locale as keyof typeof WORDS] : WORDS.en);

/** Where the app opens when the notification is tapped: the list of what happened. */
export const WAKE_URL = '/inbox';

/**
 * What a burst collapses into: one banner, replaced rather than stacked. The
 * same word as the service worker's `tag`, so a browser and a phone behave
 * alike.
 */
export const COLLAPSE = 'kolibri';

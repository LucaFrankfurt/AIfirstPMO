/**
 * Translation, without a library.
 *
 * The English catalogue is the source of truth and every other locale is typed
 * as `typeof en`, so a missing or misspelled key is a compile error rather than
 * a `[missing]` in the interface. Interpolation is `{name}`; plurals pick
 * `key_one` / `key_other` through Intl.PluralRules.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type Catalogue } from './locales/en';

export type Locale = 'en' | 'de' | 'fr';
type RawKey = keyof typeof en;
/** `task.labelCount_one` / `_other` are addressed as `task.labelCount`. */
type PluralBase<K> = K extends `${infer B}_one` ? B : K extends `${infer B}_other` ? B : never;
export type TranslationKey = RawKey | PluralBase<RawKey>;

export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch', fr: 'Français' };

/**
 * Locales nobody has read back yet.
 *
 * Named rather than hidden: a translation written by a machine is worth having
 * and worth admitting to, and somebody choosing it should find that out in the
 * picker rather than in an odd sentence three screens later.
 */
export const UNREVIEWED: Partial<Record<Locale, boolean>> = { fr: true };

/**
 * The name to put in a picker.
 *
 * Plain: the warning about an unreviewed catalogue goes in a line *under* the
 * picker rather than inside it, because a closed `select` truncates and a
 * caveat that reads "Français — traduction autom…" is worse than none.
 */
export const localeLabel = (locale: Locale): string => LOCALE_NAMES[locale];

/**
 * Writing direction per locale. Both current locales are left-to-right, so this
 * is scaffolding rather than a feature — but the stylesheet is written with
 * logical properties throughout, so adding an RTL locale is a catalogue file
 * plus one entry here. Untested against a real RTL language; see docs/i18n.md.
 */
export const LOCALE_DIR: Record<Locale, 'ltr' | 'rtl'> = { en: 'ltr', de: 'ltr', fr: 'ltr' };

/* ------------------------------------------------------- fetching a catalogue */

/**
 * English ships with the app; the others are fetched when somebody wants one.
 *
 * Three catalogues of 2 249 keys is the largest thing in the bundle, and two of
 * them are, for any given reader, a file they will never render a word of. They
 * are still checked at build time — `de.ts` and `fr.ts` are typed as
 * `Catalogue`, so a missing key is a compile error whether the file is imported
 * statically or not, and `i18n.test.ts` reads all three off disk.
 *
 * English stays static for two reasons rather than one: it is the fallback
 * `translate` reaches for when a key is missing, and it is the catalogue the
 * key *type* is derived from. Neither survives being fetched.
 */
const loaded: Partial<Record<Locale, Catalogue>> = { en };

const FETCH: Record<Locale, () => Promise<Catalogue>> = {
  en: async () => en,
  de: () => import('./locales/de').then((module) => module.de),
  fr: () => import('./locales/fr').then((module) => module.fr),
};

/**
 * Have a catalogue ready, and say whether anything changed.
 *
 * A failed fetch is not an error anybody can act on — the network went away
 * mid-session, or the chunk is gone after a deploy — and the consequence is
 * already handled: `translate` falls back to English key by key, so the app
 * keeps working in a language the reader did not pick rather than not at all.
 */
export async function loadLocale(locale: Locale): Promise<boolean> {
  if (loaded[locale]) return false;
  try {
    loaded[locale] = await FETCH[locale]();
    return true;
  } catch {
    return false;
  }
}

/** What is in memory for this locale, which before its fetch lands is English. */
const catalogueOf = (locale: Locale): Record<string, string> =>
  (loaded[locale] ?? en) as Record<string, string>;

const STORAGE_KEY = 'kolibri.locale';

/** Whether this device has an explicit choice, as opposed to a detected one. */
export const hasStoredLocale = (): boolean => localStorage.getItem(STORAGE_KEY) !== null;

/** Stored choice first, then the browser's preference, then English. */
export function detectLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in LOCALE_NAMES) return stored as Locale;
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const base = candidate.toLowerCase().split('-')[0];
    if (base in LOCALE_NAMES) return base as Locale;
  }
  return 'en';
}

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Module-level state so non-React code (date formatting) can read the locale. */
let current: Locale = 'en';
export const currentLocale = (): Locale => current;

export function translate(locale: Locale, key: TranslationKey, vars?: Record<string, string | number>): string {
  const catalogue = catalogueOf(locale);
  let template = catalogue[key];

  if (vars && typeof vars.count === 'number') {
    const category = new Intl.PluralRules(locale).select(vars.count);
    template = catalogue[`${key}_${category}`] ?? catalogue[`${key}_other`] ?? template;
  }
  // Falling back to English is better than showing a key to a user.
  if (template === undefined) template = (en as Record<string, string>)[key] ?? key;

  return vars
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
    : template;
}

interface I18nValue {
  locale: Locale;
  /** An explicit choice on this device. Persisted, and wins over everything else. */
  setLocale: (locale: Locale) => void;
  /** Follow the account's language without turning it into a device choice. */
  adoptLocale: (locale: Locale) => void;
  t: Translate;
}

const Context = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const detected = detectLocale();
    current = detected;
    return detected;
  });
  /**
   * Bumped when a fetched catalogue lands, because nothing else would say so:
   * `loaded` is a module-level map, and swapping an entry in it changes what
   * `translate` returns without changing any prop React is watching.
   *
   * `main.tsx` fetches the detected locale before the first render, so this is
   * only reached when somebody *switches* language — and there a beat of
   * English is the honest thing to show while the words are on their way.
   */
  const [arrived, setArrived] = useState(0);

  useEffect(() => {
    current = locale;
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALE_DIR[locale];
    let live = true;
    void loadLocale(locale).then((changed) => {
      if (changed && live) setArrived((n) => n + 1);
    });
    return () => { live = false; };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    current = next;
    setLocaleState(next);
  }, []);

  const adoptLocale = useCallback((next: Locale) => {
    if (hasStoredLocale()) return; // a device choice outranks the account
    current = next;
    setLocaleState(next);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `arrived` is the signal
  const t = useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale, arrived]);
  const value = useMemo(() => ({ locale, setLocale, adoptLocale, t }), [locale, setLocale, adoptLocale, t]);

  // `createElement` rather than JSX so this module is plain TypeScript: the
  // sync engine and the API client import it, and both are exercised in tests
  // that run under Node, which strips types but does not compile JSX.
  return createElement(Context.Provider, { value }, children);
}

export function useI18n(): I18nValue {
  const value = useContext(Context);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export const useT = (): Translate => useI18n().t;

/* ------------------------------------------------------- key helpers */

/**
 * The casts live here rather than at every call site: these keys are built from
 * values that the type system already constrains (priority, state group, role).
 */
export const priorityKey = (priority: string): TranslationKey => `priority.${priority}` as TranslationKey;
export const groupKey = (group: string): TranslationKey => `group.${group}` as TranslationKey;
export const relationKey = (kind: string): TranslationKey => `relation.${kind}` as TranslationKey;
export const roleKey = (role: string): TranslationKey =>
  `members.role${role.charAt(0).toUpperCase()}${role.slice(1)}` as TranslationKey;

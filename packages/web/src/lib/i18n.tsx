/**
 * Translation, without a library.
 *
 * The English catalogue is the source of truth and every other locale is typed
 * as `typeof en`, so a missing or misspelled key is a compile error rather than
 * a `[missing]` in the interface. Interpolation is `{name}`; plurals pick
 * `key_one` / `key_other` through Intl.PluralRules.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from '../locales/en';
import { de } from '../locales/de';

export const LOCALES = { en, de } as const;
export type Locale = keyof typeof LOCALES;
type RawKey = keyof typeof en;
/** `task.labelCount_one` / `_other` are addressed as `task.labelCount`. */
type PluralBase<K> = K extends `${infer B}_one` ? B : K extends `${infer B}_other` ? B : never;
export type TranslationKey = RawKey | PluralBase<RawKey>;

export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch' };

/**
 * Writing direction per locale. Both current locales are left-to-right, so this
 * is scaffolding rather than a feature — but the stylesheet is written with
 * logical properties throughout, so adding an RTL locale is a catalogue file
 * plus one entry here. Untested against a real RTL language; see docs/i18n.md.
 */
export const LOCALE_DIR: Record<Locale, 'ltr' | 'rtl'> = { en: 'ltr', de: 'ltr' };

const STORAGE_KEY = 'kolibri.locale';

/** Whether this device has an explicit choice, as opposed to a detected one. */
export const hasStoredLocale = (): boolean => localStorage.getItem(STORAGE_KEY) !== null;

/** Stored choice first, then the browser's preference, then English. */
export function detectLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in LOCALES) return stored as Locale;
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const base = candidate.toLowerCase().split('-')[0];
    if (base in LOCALES) return base as Locale;
  }
  return 'en';
}

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Module-level state so non-React code (date formatting) can read the locale. */
let current: Locale = 'en';
export const currentLocale = (): Locale => current;

export function translate(locale: Locale, key: TranslationKey, vars?: Record<string, string | number>): string {
  const catalogue = LOCALES[locale] as Record<string, string>;
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

  useEffect(() => {
    current = locale;
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALE_DIR[locale];
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

  const t = useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
  const value = useMemo(() => ({ locale, setLocale, adoptLocale, t }), [locale, setLocale, adoptLocale, t]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
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

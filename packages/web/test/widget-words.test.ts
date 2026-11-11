/**
 * The support widget's own words, held to the app's.
 *
 * The visitor's window carries a catalogue of its own so that it does not
 * download the app's three thousand strings on the first click. The price is
 * a copy of the words it shares with the app's own threads — "Seen", "Today",
 * "Send" — and a copy drifts the day somebody rewords one side. This is what
 * notices.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../src/kernel/i18n/locales/en.ts';
import { de } from '../src/kernel/i18n/locales/de.ts';
import { fr } from '../src/kernel/i18n/locales/fr.ts';
import { COPIED_FROM, WIDGET_CATALOGUE, widgetLocale, widgetWords } from '../src/adapters/widget/words.ts';

const APP = { en, de, fr } as const;

describe('the widget\'s words', () => {
  for (const locale of Object.keys(WIDGET_CATALOGUE) as (keyof typeof WIDGET_CATALOGUE)[]) {
    it(`say what the app says, in ${locale}`, () => {
      for (const [word, key] of Object.entries(COPIED_FROM)) {
        assert.equal(
          WIDGET_CATALOGUE[locale][word as keyof (typeof WIDGET_CATALOGUE)['en']],
          (APP[locale] as Record<string, string>)[key],
          `${locale}: the widget's "${word}" has drifted from ${key}`,
        );
      }
    });
  }

  it('have every word in every language', () => {
    const words = Object.keys(WIDGET_CATALOGUE.en).sort();
    for (const locale of Object.keys(WIDGET_CATALOGUE) as (keyof typeof WIDGET_CATALOGUE)[]) {
      assert.deepEqual(Object.keys(WIDGET_CATALOGUE[locale]).sort(), words, locale);
    }
  });

  it('follow the browser, and fall back to English', () => {
    assert.equal(widgetLocale(['de-AT', 'en']), 'de');
    assert.equal(widgetLocale(['fr-CA']), 'fr');
    assert.equal(widgetLocale(['ja', 'pt-BR']), 'en');
    assert.equal(widgetWords('de').typingNamed('Ada'), 'Ada schreibt');
  });
});

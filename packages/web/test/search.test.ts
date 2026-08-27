/**
 * What the search box makes of what somebody typed.
 *
 * The rule the whole feature rests on is that a filter can only ever be
 * *picked*, never guessed: `@anna` is a filter when there is an Anna and three
 * words of prose when there is not. Everything below is a way of asking
 * whether that rule still holds — including the cases where it would be
 * tempting to be clever, like a name inside an e-mail address.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applySuggestion, matchesTerms, parseQuery, removeFacet, suggest, terms, type FacetOption,
} from '../src/lib/search-query.ts';

const options: FacetOption[] = [
  { kind: 'person', ids: ['u1'], name: 'Anna Schmidt', hint: 'anna@example.com' },
  { kind: 'person', ids: ['u2'], name: 'Anna', hint: 'anna.b@example.com' },
  { kind: 'person', ids: ['u3'], name: 'Jörg Müller', hint: 'joerg@example.com' },
  { kind: 'label', ids: ['l1', 'l2'], name: 'Bug' },
  { kind: 'label', ids: ['l3'], name: 'Design Review' },
  { kind: 'project', ids: ['p1'], name: 'Website', hint: 'WEB' },
];

describe('reading the box', () => {
  it('leaves prose alone', () => {
    const parsed = parseQuery('rechnung letzte woche', options);
    assert.equal(parsed.text, 'rechnung letzte woche');
    assert.deepEqual(parsed.facets, []);
  });

  it('recognises a name that was picked', () => {
    const parsed = parseQuery('@Anna Schmidt rechnung', options);
    assert.equal(parsed.text, 'rechnung');
    assert.deepEqual(parsed.facets.map((f) => f.ids), [['u1']]);
  });

  it('prefers the longer of two names that both fit', () => {
    // Both "Anna" and "Anna Schmidt" match at the same spot. Picking the short
    // one would filter by the wrong person *and* leave "Schmidt" in the text.
    assert.deepEqual(parseQuery('@Anna Schmidt', options).facets[0].ids, ['u1']);
    assert.deepEqual(parseQuery('@Anna', options).facets[0].ids, ['u2']);
  });

  it('keeps a name nobody has as words', () => {
    const parsed = parseQuery('@peter kunde', options);
    assert.equal(parsed.text, '@peter kunde');
    assert.deepEqual(parsed.facets, []);
  });

  it('does not find a filter inside an address', () => {
    const parsed = parseQuery('mail an anna@Anna', options);
    assert.deepEqual(parsed.facets, []);
    assert.equal(parsed.text, 'mail an anna@Anna');
  });

  it('does not match a name that only starts a longer word', () => {
    assert.deepEqual(parseQuery('#Bugfix im login', options).facets, []);
  });

  it('carries every row a name stands for', () => {
    // Two projects each with a label called "Bug": filtering by it means both.
    assert.deepEqual(parseQuery('#Bug', options).facets[0].ids, ['l1', 'l2']);
  });

  it('ignores case and accents', () => {
    assert.deepEqual(parseQuery('@jorg muller', options).facets[0].ids, ['u3']);
    assert.deepEqual(parseQuery('#BUG', options).facets[0].ids, ['l1', 'l2']);
  });

  it('reads several filters and the words between them', () => {
    const parsed = parseQuery('@Anna #Bug +Website absturz', options);
    assert.deepEqual(parsed.facets.map((f) => f.kind), ['person', 'label', 'project']);
    assert.equal(parsed.text, 'absturz');
  });
});

describe('what the popup offers', () => {
  it('offers everybody as soon as the trigger is typed', () => {
    const found = suggest('@', 1, options);
    assert.deepEqual(found?.options.map((o) => o.name), ['Anna', 'Anna Schmidt', 'Jörg Müller']);
  });

  it('offers nothing when there is no trigger', () => {
    assert.equal(suggest('rechnung', 8, options), null);
  });

  it('finds somebody by their surname', () => {
    assert.deepEqual(suggest('@schmidt', 8, options)?.options.map((o) => o.ids), [['u1']]);
  });

  it('finds a project by its key', () => {
    assert.deepEqual(suggest('+web', 4, options)?.options.map((o) => o.ids), [['p1']]);
  });

  it('offers only its own kind', () => {
    assert.deepEqual(suggest('#', 1, options)?.options.map((o) => o.name), ['Bug', 'Design Review']);
  });

  it('closes once the name is finished and a space was typed', () => {
    assert.ok(suggest('@Anna', 5, options));
    assert.equal(suggest('@Anna ', 6, options), null);
  });

  it('closes when what was typed is nobody', () => {
    assert.equal(suggest('@zzz', 4, options), null);
  });

  it('follows the caret rather than the end of the text', () => {
    const found = suggest('@Ann rechnung', 4, options);
    assert.deepEqual(found?.options.map((o) => o.name), ['Anna', 'Anna Schmidt']);
    assert.equal(suggest('@Ann rechnung', 13, options), null);
  });

  it('puts a picked name in, with room to keep typing', () => {
    const found = suggest('@Ann', 4, options)!;
    const applied = applySuggestion('@Ann', found.trigger, options[0]);
    assert.equal(applied.value, '@Anna Schmidt ');
    assert.equal(applied.caret, applied.value.length);
  });

  it('puts a picked name in the middle of what is already there', () => {
    const found = suggest('rechnung @Ann offen', 13, options)!;
    const applied = applySuggestion('rechnung @Ann offen', found.trigger, options[1]);
    assert.equal(applied.value, 'rechnung @Anna  offen');
    assert.equal(applied.caret, 15);
  });
});

describe('taking a filter back out', () => {
  it('removes the name and closes the gap', () => {
    const parsed = parseQuery('@Anna Schmidt rechnung', options);
    assert.equal(removeFacet('@Anna Schmidt rechnung', parsed.facets[0]), 'rechnung');
  });

  it('leaves the other filters alone', () => {
    const input = '@Anna #Bug absturz';
    const parsed = parseQuery(input, options);
    assert.equal(removeFacet(input, parsed.facets[0]), '#Bug absturz');
  });
});

describe('the words themselves', () => {
  it('wants all of them, anywhere', () => {
    assert.ok(matchesTerms('WEB-12 Rechnung prüfen', terms('rechnung web')));
    assert.ok(!matchesTerms('WEB-12 Rechnung prüfen', terms('rechnung angebot')));
  });

  it('is not stopped by an accent or by case', () => {
    assert.ok(matchesTerms('Rechnung prüfen', terms('PRUFEN')));
  });

  it('matches on a prefix, the way typing does', () => {
    assert.ok(matchesTerms('Design review', terms('des rev')));
  });

  it('asks nothing of a search with no words in it', () => {
    assert.ok(matchesTerms('anything', terms('   ')));
  });

  it('holds a single character to the start of a word', () => {
    // The first keystroke of `@Grace` is a lone "g". Matched anywhere inside a
    // word it finds nearly every task there is, and the list flails.
    assert.ok(matchesTerms('WEB-3 Grace notes', terms('g')));
    assert.ok(!matchesTerms('WEB-3 Ship dark mode', terms('g')));
    // A lone digit is usually the end of an identifier somebody is typing.
    assert.ok(matchesTerms('WEB-1 Redesign the pricing page', terms('web 1')));
  });
});

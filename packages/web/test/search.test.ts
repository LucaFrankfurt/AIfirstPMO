/**
 * What the search box makes of what somebody typed.
 *
 * The rule the whole feature rests on is that a filter can only ever be
 * *picked*, never guessed: `@anna` is a filter when there is an Anna and three
 * words of prose when there is not. Everything below is a way of asking
 * whether that rule still holds — including the cases where it would be
 * tempting to be clever, like a name inside an e-mail address.
 *
 * What the *rest* of the text asks for — words, phrases, exclusions and task
 * identifiers — is read by `parseTerms` in `@kolibri/shared` and tested beside
 * the MATCH it compiles to, in `packages/server/test/search.test.ts`. One
 * grammar, one place it is pinned.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryVocabulary } from '@kolibri/shared';
import {
  applySuggestion, narrowsByFilter, onlyWorkCanAnswer, parseFacets, readQuery, removeFacet,
  suggest, type FacetOption,
} from '../src/kernel/search/search-query.ts';

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
    const parsed = parseFacets('rechnung letzte woche', options);
    assert.equal(parsed.text, 'rechnung letzte woche');
    assert.deepEqual(parsed.facets, []);
  });

  it('recognises a name that was picked', () => {
    const parsed = parseFacets('@Anna Schmidt rechnung', options);
    assert.equal(parsed.text, 'rechnung');
    assert.deepEqual(parsed.facets.map((f) => f.ids), [['u1']]);
  });

  it('prefers the longer of two names that both fit', () => {
    // Both "Anna" and "Anna Schmidt" match at the same spot. Picking the short
    // one would filter by the wrong person *and* leave "Schmidt" in the text.
    assert.deepEqual(parseFacets('@Anna Schmidt', options).facets[0].ids, ['u1']);
    assert.deepEqual(parseFacets('@Anna', options).facets[0].ids, ['u2']);
  });

  it('keeps a name nobody has as words', () => {
    const parsed = parseFacets('@peter kunde', options);
    assert.equal(parsed.text, '@peter kunde');
    assert.deepEqual(parsed.facets, []);
  });

  it('does not find a filter inside an address', () => {
    const parsed = parseFacets('mail an anna@Anna', options);
    assert.deepEqual(parsed.facets, []);
    assert.equal(parsed.text, 'mail an anna@Anna');
  });

  it('does not match a name that only starts a longer word', () => {
    assert.deepEqual(parseFacets('#Bugfix im login', options).facets, []);
  });

  it('carries every row a name stands for', () => {
    // Two projects each with a label called "Bug": filtering by it means both.
    assert.deepEqual(parseFacets('#Bug', options).facets[0].ids, ['l1', 'l2']);
  });

  it('ignores case and accents', () => {
    assert.deepEqual(parseFacets('@jorg muller', options).facets[0].ids, ['u3']);
    assert.deepEqual(parseFacets('#BUG', options).facets[0].ids, ['l1', 'l2']);
  });

  it('reads several filters and the words between them', () => {
    const parsed = parseFacets('@Anna #Bug +Website absturz', options);
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
    const parsed = parseFacets('@Anna Schmidt rechnung', options);
    assert.equal(removeFacet('@Anna Schmidt rechnung', parsed.facets[0]), 'rechnung');
  });

  it('leaves the other filters alone', () => {
    const input = '@Anna #Bug absturz';
    const parsed = parseFacets(input, options);
    assert.equal(removeFacet(input, parsed.facets[0]), '#Bug absturz');
  });
});

/**
 * One line, read once, for both boxes.
 *
 * `readQuery` is the whole claim of the feature in one function: a name that
 * was picked and a clause that was typed have to end up in the same `Filters`,
 * or the task header and the search screen are back to meaning different
 * things by the same sentence. The cases below are the ways that could quietly
 * stop being true.
 */
describe('reading a whole line', () => {
  const vocabulary: QueryVocabulary = {
    meId: 'u1',
    states: [
      { id: 's-todo', name: 'Todo', group_key: 'unstarted' },
      { id: 's-done', name: 'Done', group_key: 'completed' },
    ],
    people: [{ id: 'u1', name: 'Anna Schmidt' }, { id: 'u2', name: 'Anna' }],
    labels: [{ id: 'l1', name: 'Bug' }],
    projects: [{ id: 'p1', key: 'WEB', name: 'Website' }],
  };

  it('a picked name and a typed clause land in the same filter', () => {
    const picked = readQuery('@Anna Schmidt', options, vocabulary);
    const typed = readQuery('assignee = "Anna Schmidt"', options, vocabulary);
    assert.deepEqual(picked.filters.assignee, ['u1']);
    assert.deepEqual(typed.filters.assignee, ['u1']);
  });

  it('carries names, clauses and prose in one line', () => {
    const parsed = readQuery('@Anna Schmidt #Bug state != Done absturz', options, vocabulary);
    assert.deepEqual(parsed.filters.assignee, ['u1']);
    assert.deepEqual(parsed.filters.label, ['l1', 'l2']);
    assert.deepEqual(parsed.filters.not?.state, ['s-done']);
    assert.equal(parsed.text, 'absturz');
    assert.deepEqual(parsed.errors, []);
  });

  /**
   * The one behaviour this change moves, pinned so it is a decision and not a
   * regression somebody finds later. The search screen used to match two names
   * with `every`, which read as "assigned to both"; `Filters` is a conjunction
   * of "is one of" everywhere else in the product, and cannot express the other
   * reading at all.
   */
  it('two of the same kind mean either, as every other filter does', () => {
    const parsed = readQuery('@Anna Schmidt @Anna', options, vocabulary);
    assert.deepEqual(parsed.filters.assignee, ['u1', 'u2']);
  });

  it('a name nobody has stays prose, and does not become an error', () => {
    const parsed = readQuery('@niemand rechnung', options, vocabulary);
    assert.equal(parsed.filters.assignee, undefined);
    assert.equal(parsed.text, '@niemand rechnung');
    assert.deepEqual(parsed.errors, []);
  });

  it('a clause nobody can resolve is an error, and the rest still asks', () => {
    const parsed = readQuery('state = Dnoe absturz', options, vocabulary);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Dnoe/);
    assert.equal(parsed.text, 'absturz');
  });

  it('a phrase keeps its quotes on the way to the text search', () => {
    assert.equal(readQuery('"design review"', options, vocabulary).text, '"design review"');
  });

  /** What `asked` and the work-only notice rest on, on the search screen. */
  it('knows which lines only work can answer', () => {
    assert.equal(onlyWorkCanAnswer(readQuery('absturz', options, vocabulary).filters), false);
    assert.equal(onlyWorkCanAnswer(readQuery('+Website', options, vocabulary).filters), false);
    assert.equal(onlyWorkCanAnswer(readQuery('@Anna', options, vocabulary).filters), true);
    assert.equal(onlyWorkCanAnswer(readQuery('due = overdue', options, vocabulary).filters), true);
    assert.equal(onlyWorkCanAnswer(readQuery('state != Done', options, vocabulary).filters), true);
  });

  /**
   * A line of nothing but words has not narrowed anything — it *is* the search.
   * `countFilters` cannot answer this, because it counts the words as a filter.
   */
  it('separates narrowing from searching', () => {
    assert.equal(narrowsByFilter(readQuery('absturz', options, vocabulary).filters), false);
    assert.equal(narrowsByFilter(readQuery('+Website', options, vocabulary).filters), true);
  });
});

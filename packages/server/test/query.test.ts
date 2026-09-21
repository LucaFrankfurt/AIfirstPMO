/**
 * A filter you can write down.
 *
 * Three things are worth pinning: it parses what people type, it prints back to
 * something that parses to the same thing, and — the one that matters most —
 * it says *no* clearly. A query language whose failure mode is "returns
 * nothing" is one people stare at; the errors below are the feature.
 *
 * A fourth since the free text became a search rather than a substring: what is
 * not a clause reaches `filters.text` as written, quotes and all, because
 * `parseTerms` is what reads it from there. The round trip is what that rests
 * on — a phrase that loses its quotes on the way through the printer is a
 * phrase that quietly stops being one the next time the box is opened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesTerms, parseQuery, parseTerms, printQuery, type QueryVocabulary } from '@kolibri/shared';

const vocabulary: QueryVocabulary = {
  meId: 'u-me',
  states: [
    { id: 's-todo', name: 'Todo', group_key: 'unstarted' },
    { id: 's-doing', name: 'In Progress', group_key: 'started' },
    { id: 's-done', name: 'Done', group_key: 'completed' },
  ],
  people: [
    { id: 'u-me', name: 'Grace Hopper', email: 'grace@example.com' },
    { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com' },
  ],
  labels: [{ id: 'l-design', name: 'design' }, { id: 'l-ops', name: 'ops' }],
  cycles: [{ id: 'c-1', name: 'Sprint 1' }],
  modules: [{ id: 'm-1', name: 'Launch' }],
  projects: [{ id: 'p-web', key: 'WEB', name: 'Website' }],
};

const parse = (text: string) => parseQuery(text, vocabulary);

describe('what a query can ask', () => {
  it('reads a conjunction of the obvious things', () => {
    const { filters, errors } = parse('assignee = me AND priority in (urgent, high) AND state = "In Progress"');
    assert.deepEqual(errors, []);
    assert.deepEqual(filters.assignee, ['u-me']);
    assert.deepEqual(filters.priority, ['urgent', 'high']);
    assert.deepEqual(filters.state, ['s-doing']);
  });

  it('reads a negation, which is the second thing anybody wants', () => {
    const { filters, errors } = parse('state != Done');
    assert.deepEqual(errors, []);
    assert.deepEqual(filters.not?.state, ['s-done']);
    assert.equal(filters.state, undefined, 'a negation is not also an inclusion');
  });

  it('reads `not in` for a list', () => {
    const { filters } = parse('priority not in (low, none)');
    assert.deepEqual(filters.not?.priority, ['low', 'none']);
  });

  it('takes a colon as well as an equals, because people type both', () => {
    assert.deepEqual(parse('label: design').filters.label, ['l-design']);
    assert.deepEqual(parse('label = design').filters.label, ['l-design']);
  });

  it('resolves a person by name or by address', () => {
    assert.deepEqual(parse('assignee = "Ada Lovelace"').filters.assignee, ['u-ada']);
    assert.deepEqual(parse('assignee = ada@example.com').filters.assignee, ['u-ada']);
  });

  it('resolves a project by key or by name', () => {
    assert.deepEqual(parse('project = WEB').filters.project, ['p-web']);
    assert.deepEqual(parse('project = Website').filters.project, ['p-web']);
  });

  it('knows the empty answer, which no name can express', () => {
    assert.deepEqual(parse('assignee = none').filters.assignee, ['']);
    assert.deepEqual(parse('cycle = none').filters.cycle, ['']);
  });

  it('reads `is:` as a state group, in the words people use', () => {
    assert.deepEqual(parse('is: done').filters.group, ['completed']);
    assert.deepEqual(parse('is: open').filters.group, ['unstarted']);
    assert.deepEqual(parse('is != done').filters.not?.group, ['completed']);
  });

  it('reads the four due buckets, and the comparisons people write for them', () => {
    assert.equal(parse('due = overdue').filters.due, 'overdue');
    assert.equal(parse('due < today').filters.due, 'overdue');
    assert.equal(parse('due <= 7d').filters.due, 'week');
    assert.equal(parse('due = none').filters.due, 'none');
  });

  it('treats bare words as a text search, which is what a filter box is for', () => {
    const { filters, errors } = parse('login loop');
    assert.deepEqual(errors, []);
    assert.equal(filters.text, 'login loop');
  });

  it('mixes a text search with a clause', () => {
    const { filters } = parse('login assignee = me');
    assert.equal(filters.text, 'login');
    assert.deepEqual(filters.assignee, ['u-me']);
  });

  it('keeps the quotes a phrase was written with', () => {
    // The scanner takes them off as delimiters. Without putting them back the
    // one thing they were for is gone before anything reads the text.
    assert.equal(parse('"design review"').filters.text, '"design review"');
    assert.equal(parse('text ~ "design review"').filters.text, '"design review"');
    assert.equal(parse('rechnung "design review" -entwurf').filters.text, 'rechnung "design review" -entwurf');
  });

  it('lets a quoted word be a word rather than a connector', () => {
    // `and` joins clauses; `"and"` is something somebody is looking for. The
    // check could not tell them apart and ate the second one.
    assert.equal(parse('"and"').filters.text, '"and"');
    assert.equal(parse('salt and pepper').filters.text, 'salt pepper');
  });

  it('does not need spaces around the operator', () => {
    const { filters, errors } = parse('state!=Done');
    assert.deepEqual(errors, []);
    assert.deepEqual(filters.not?.state, ['s-done']);
  });

  it('is case-insensitive about fields, operators and names', () => {
    const { filters, errors } = parse('STATE In (todo, DONE) and Priority = URGENT');
    assert.deepEqual(errors, []);
    assert.deepEqual(filters.state, ['s-todo', 's-done']);
    assert.deepEqual(filters.priority, ['urgent']);
  });
});

describe('what it refuses, and how', () => {
  it('names the value it could not find rather than returning nothing', () => {
    const { errors } = parse('state = Dnoe');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /No state here is called "Dnoe"/);
    // And points at it, so an editor can underline the right word.
    assert.equal(errors[0].at, 8);
    assert.equal(errors[0].length, 4);
  });

  it('explains that OR between fields is not something a view can hold', () => {
    const { errors } = parse('assignee = me OR priority = urgent');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /put the alternatives in one field/);
  });

  it('lists the priorities when one is wrong', () => {
    const { errors } = parse('priority = blocker');
    assert.match(errors[0].message, /not a priority — try urgent, high, medium, low, none/);
  });

  it('says a date comparison is not a thing a saved view holds', () => {
    const { errors } = parse('due < 2026-09-01');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /overdue, today, week or none/);
  });

  it('notices a clause with nothing after the operator', () => {
    const { errors } = parse('state =');
    assert.match(errors[0].message, /needs something after/);
  });

  it('notices an unclosed list', () => {
    const { errors } = parse('priority in (urgent, high');
    assert.match(errors[0].message, /missing its closing bracket/);
  });

  it('keeps the clauses it understood alongside the ones it did not', () => {
    // Half a query is more useful than none: the good clause still applies and
    // the error says which word to fix.
    const { filters, errors } = parse('assignee = me AND state = Nowhere');
    assert.deepEqual(filters.assignee, ['u-me']);
    assert.equal(errors.length, 1);
    // The unresolved one is kept rather than dropped. Dropping it would widen
    // the filter silently, which is worse than one that matches nothing and
    // says which word is wrong.
    assert.deepEqual(filters.state, ['Nowhere']);
  });
});

describe('printing one back', () => {
  const round = (text: string) => {
    const { filters, errors } = parse(text);
    assert.deepEqual(errors, [], `"${text}" did not parse`);
    const printed = printQuery(filters, vocabulary);
    const again = parseQuery(printed, vocabulary);
    assert.deepEqual(again.errors, [], `"${printed}" did not parse back`);
    assert.deepEqual(again.filters, filters, `"${text}" printed as "${printed}"`);
    return printed;
  };

  it('survives the round trip', () => {
    round('assignee = me AND priority in (urgent, high)');
    round('state != Done');
    round('project = WEB AND label in (design, ops)');
    round('is: done');
    round('due = overdue');
    round('cycle = none');
  });

  it('survives it with a search in it, quotes and minus and all', () => {
    // Printed as bare words rather than wrapped in `text ~ "…"`: a second pair
    // of quotes around `"design review"` is a different search, and the scanner
    // has no escape to spell its way back out of one.
    assert.equal(round('"design review"'), '"design review"');
    assert.equal(round('rechnung -entwurf'), 'rechnung -entwurf');
    assert.equal(round('state != Done AND "design review"'), 'state != Done AND "design review"');
    assert.equal(round('assignee = me AND WEB-12'), 'assignee = me AND WEB-12');
    round('"and"');
  });

  it('does not hand a connector back to the parser as a join', () => {
    // A filter written before the text was a search: `text ~ "salt and pepper"`
    // stored the three words unquoted, and printing them bare would lose the
    // middle one. Quoted on the way out, it stays the word it was.
    const printed = printQuery({ text: 'salt and pepper' }, vocabulary);
    assert.equal(printed, 'salt "and" pepper');
    assert.equal(parse(printed).filters.text, 'salt "and" pepper');
    assert.equal(printQuery(parse(printed).filters, vocabulary), printed, 'and settles there');
  });

  it('says `me` rather than an id, and quotes what needs quoting', () => {
    const { filters } = parse('assignee = me AND state = "In Progress"');
    const printed = printQuery(filters, vocabulary);
    assert.match(printed, /assignee = me/);
    assert.match(printed, /state = "In Progress"/);
  });

  it('prints an id that no longer resolves, because an id parses as itself', () => {
    const printed = printQuery({ state: ['s-deleted'] }, vocabulary);
    assert.equal(printed, 'state = s-deleted');
    assert.deepEqual(parseQuery(printed, vocabulary).filters.state, ['s-deleted']);
  });

  it('prints nothing at all for no filters', () => {
    assert.equal(printQuery({}, vocabulary), '');
  });

  it('prints in a fixed order, so two equal filters are the same text', () => {
    // Canonical rather than as-typed: it is what makes one of these diffable
    // against last week's, and what stops the box rewriting itself differently
    // every time somebody opens it.
    const a = parse('state != Done AND assignee = me').filters;
    const b = parse('assignee = me AND state != Done').filters;
    assert.equal(printQuery(a, vocabulary), printQuery(b, vocabulary));
    assert.equal(printQuery(a, vocabulary), 'assignee = me AND state != Done');
  });
});

/**
 * The other half: what the list does with the text once it has it.
 *
 * `useVisibleTasks` reads `filters.text` through `parseTerms` and asks
 * `matchesTerms`, so the two calls below are the filter box's search, minus
 * React. Each case is one the old `toLowerCase().includes()` got wrong.
 */
describe('the text a filter searches for', () => {
  const finds = (query: string, task: string): boolean =>
    matchesTerms(task, parseTerms(parse(query).filters.text ?? ''));

  const TASK = 'WEB-3 Ship dark mode across the marketing site';

  it('is not stopped by an umlaut somebody did not type', () => {
    assert.ok(finds('prufen', 'WEB-9 Rechnung prüfen'));
  });

  it('does not need the words adjacent, or in order', () => {
    assert.ok(finds('marketing dark', TASK));
    assert.ok(finds('des rev', 'WEB-4 Design review'));
  });

  it('does need them adjacent and in order when they are quoted', () => {
    assert.ok(finds('"dark mode"', TASK));
    assert.ok(!finds('"mode dark"', TASK));
  });

  it('leaves out what a minus names', () => {
    assert.ok(finds('dark', TASK));
    assert.ok(!finds('dark -mode', TASK));
  });

  it('finds a task by its number, hyphen or no hyphen', () => {
    assert.ok(finds('WEB-3', TASK));
    assert.ok(finds('web 3', TASK));
    assert.ok(!finds('WEB-4', TASK));
  });
});

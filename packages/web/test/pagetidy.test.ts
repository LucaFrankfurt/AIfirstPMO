/**
 * What a wiki says about itself when somebody finally asks.
 *
 * Every one of these findings was invisible before: the tree drew the same
 * confident answer whether a page's parent existed or not, and two pages with
 * one title looked like two pages rather than like one `[[link]]` target with a
 * silent winner. So the cases worth pinning are the ones where the screen used
 * to be *wrong* rather than merely quiet — a detached page reappearing at the
 * top level, and a duplicate title that moves other pages' links.
 *
 * Pure arithmetic over a list, like `pagetree.test.ts` beside it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tidyPages, type Problem, type TidyPage } from '../src/modules/pages/tidy.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

const page = (over: Partial<TidyPage> & { id: string }): TidyPage => ({
  title: over.id,
  content: 'Something written here.',
  format: 'markdown',
  parent_id: null,
  updated_at: NOW,
  created_at: NOW,
  ...over,
});

/** The ids reported for one finding, which is all these cases are about. */
const ids = (pages: readonly TidyPage[], problem: Problem, options = {}): string[] =>
  tidyPages(pages, { now: NOW, ...options }).findings.find((one) => one.problem === problem)?.pages.map((p) => p.id) ?? [];

describe('a page whose parent is gone', () => {
  // archived, deleted or turned into a template — the tree cannot tell, and
  // from the reader's side it does not matter: the page draws at the top level
  // as though somebody put it there.
  const pages = [page({ id: 'handbook' }), page({ id: 'tooling', parent_id: 'archived-chapter' })];
  const all = [...pages, page({ id: 'archived-chapter' })];

  it('is reported, because the tree silently draws it as a chapter', () => {
    assert.deepEqual(ids(pages, 'detached', { all }), ['tooling']);
  });

  it('is not reported when the parent is simply there', () => {
    const fine = [page({ id: 'handbook' }), page({ id: 'tooling', parent_id: 'handbook' })];
    assert.deepEqual(ids(fine, 'detached', { all: fine }), []);
  });

  it('is left alone when the parent is a page this reader cannot open', () => {
    // Nothing can be done about it from this screen, so saying so is noise.
    assert.deepEqual(ids(pages, 'detached', { all: pages }), []);
  });
});

describe('two pages with one title', () => {
  const pages = [
    page({ id: 'old-notes', title: 'Notes', created_at: NOW - 90 * DAY }),
    page({ id: 'new-notes', title: 'notes', created_at: NOW - 2 * DAY }),
    page({ id: 'unique', title: 'Decisions' }),
  ];

  it('reports both, folded the way a link resolves them', () => {
    assert.deepEqual(ids(pages, 'duplicate'), ['old-notes', 'new-notes']);
  });

  it('puts the one that wins first, because that is the one the links went to', () => {
    assert.equal(ids(pages, 'duplicate')[0], 'old-notes');
  });

  it('says nothing about a title only one page answers to', () => {
    assert.equal(ids(pages, 'duplicate').includes('unique'), false);
  });

  it('ignores a page with no title at all, which is a different finding', () => {
    const untitled = [page({ id: 'a', title: '' }), page({ id: 'b', title: '  ' })];
    assert.deepEqual(ids(untitled, 'duplicate'), []);
  });
});

describe('a page with nothing on it', () => {
  it('is reported', () => {
    assert.deepEqual(ids([page({ id: 'blank', content: '   \n' })], 'empty'), ['blank']);
  });

  it('is reported when its body is empty markup rather than empty text', () => {
    assert.deepEqual(ids([page({ id: 'blank', content: '<p></p>', format: 'html' })], 'empty'), ['blank']);
  });

  it('is not reported when it has sub-pages, because then it is a section', () => {
    const section = [page({ id: 'part-two', content: '' }), page({ id: 'chapter', parent_id: 'part-two' })];
    assert.deepEqual(ids(section, 'empty'), []);
  });
});

describe('a page nothing points at', () => {
  it('is reported when it is top-level, childless and unlinked', () => {
    assert.deepEqual(ids([page({ id: 'stray' })], 'isolated'), ['stray']);
  });

  it('is not reported once another page links to it', () => {
    const linked = [
      page({ id: 'stray', title: 'Stray' }),
      page({ id: 'index', title: 'Index', content: 'See [[Stray]] for the details.' }),
    ];
    assert.equal(ids(linked, 'isolated').includes('stray'), false);
  });

  it('is not reported when it sits in the tree', () => {
    const nested = [page({ id: 'handbook' }), page({ id: 'tooling', parent_id: 'handbook' })];
    assert.deepEqual(ids(nested, 'isolated'), []);
  });

  it('does not count a page linking to itself as somebody pointing at it', () => {
    // `linkGraph` draws no self-edge, which is what makes this true — a page
    // that names itself in its own text is a note to the reader.
    const selfish = [page({ id: 'stray', title: 'Stray', content: 'This is [[Stray]].' })];
    assert.deepEqual(ids(selfish, 'isolated'), ['stray']);
  });
});

describe('a page nobody has touched', () => {
  it('is reported past the threshold and not before it', () => {
    const pages = [
      page({ id: 'fresh', updated_at: NOW - 10 * DAY }),
      page({ id: 'old', updated_at: NOW - 200 * DAY }),
    ];
    assert.deepEqual(ids(pages, 'stale'), ['old']);
  });

  it('takes the threshold from the caller', () => {
    const pages = [page({ id: 'old', updated_at: NOW - 20 * DAY })];
    assert.deepEqual(ids(pages, 'stale', { staleDays: 14 }), ['old']);
    assert.deepEqual(ids(pages, 'stale', { staleDays: 30 }), []);
  });
});

describe('the whole report', () => {
  it('counts each page once however much is wrong with it', () => {
    const pages = [page({ id: 'bad', title: 'Notes', content: '', updated_at: NOW - 400 * DAY }),
      page({ id: 'bad-too', title: 'notes', content: '', updated_at: NOW - 400 * DAY })];
    const report = tidyPages(pages, { now: NOW });
    assert.equal(report.pages, 2, 'the number on the button has to be pages, not findings');
    assert.deepEqual(report.byPage.get('bad')?.sort(), ['duplicate', 'empty', 'isolated', 'stale']);
  });

  it('keeps the findings in the order they are worth working through', () => {
    const pages = [page({ id: 'bad', title: 'Notes', content: '', updated_at: NOW - 400 * DAY }),
      page({ id: 'bad-too', title: 'notes', content: '', updated_at: NOW - 400 * DAY })];
    assert.deepEqual(
      tidyPages(pages, { now: NOW }).findings.map((one) => one.problem),
      ['duplicate', 'empty', 'isolated', 'stale'],
    );
  });

  it('reports nothing at all about a wiki that is in order', () => {
    const pages = [
      page({ id: 'handbook', title: 'Handbook', content: 'Start at [[Tooling]].' }),
      page({ id: 'tooling', title: 'Tooling', parent_id: 'handbook' }),
    ];
    const report = tidyPages(pages, { now: NOW });
    assert.deepEqual(report.findings, []);
    assert.equal(report.pages, 0);
  });

  it('survives a tree that already loops', () => {
    // Two devices can each make a legal move that is a cycle together. The
    // screen has to draw something rather than hang.
    const looped = [page({ id: 'a', parent_id: 'b' }), page({ id: 'b', parent_id: 'a' })];
    assert.equal(tidyPages(looped, { now: NOW }).findings.length >= 0, true);
  });
});

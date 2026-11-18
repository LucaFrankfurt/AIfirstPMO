/**
 * The arithmetic under a wiki that is more than its tree: where a page stands
 * among siblings that share a key, what a dated entry is called, which labels a
 * page is offered, what a filter draws and how the index is cut into sections.
 *
 * Each case is a number the first real wiki on an instance produced: 41 pages
 * on one sort key at the top level, a menu of eight `Bug`s on a handbook page,
 * a label filter that drew sub-pages as chapters, and minutes filed under one
 * title every week. Pure functions, asked without a browser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  comparePages, entryDay, findSeries, labelApplies, labelsForPage, localDay, orderKey, seriesAbove, seriesEntryTitle, untie, pageKey,
} from '@kolibri/shared';
import { childrenOf, groupBranches, pagesWhere, type PageNode } from '../src/modules/pages/page-tree.ts';
import { tidyPages } from '../src/modules/pages/tidy.ts';

describe('siblings that share a key', () => {
  const tied = [
    { id: 'c', parent_id: null, sort_order: 'V', created_at: 3 },
    { id: 'a', parent_id: null, sort_order: 'V', created_at: 1 },
    { id: 'z', parent_id: null, sort_order: 'k', created_at: 0 },
    { id: 'b', parent_id: null, sort_order: 'V', created_at: 2 },
  ];

  it('are drawn in the order they were written, the same way on every device', () => {
    assert.deepEqual(childrenOf(tied, null).map((page) => page.id), ['a', 'b', 'c', 'z']);
    // The store's order is whatever it is; the answer must not depend on it.
    assert.deepEqual(childrenOf([...tied].reverse(), null).map((page) => page.id), ['a', 'b', 'c', 'z']);
  });

  it('are given keys of their own, in that order, and only the ones that need one', () => {
    const moved = untie(tied);
    assert.deepEqual(moved.map((patch) => patch.id), ['b', 'c'], 'the first of the run keeps its key');
    const keys = new Map(tied.map((page) => [page.id, page.sort_order]));
    for (const patch of moved) keys.set(patch.id, patch.sort_order);
    const order = [...tied].map((page) => ({ ...page, sort_order: keys.get(page.id)! })).sort(comparePages);
    assert.deepEqual(order.map((page) => page.id), ['a', 'b', 'c', 'z'], 'nothing visibly moves');
    assert.equal(new Set(keys.values()).size, 4);
  });

  it('untie nothing in a list that was never tied', () => {
    assert.deepEqual(untie([
      { id: 'a', sort_order: orderKey(null, null) },
      { id: 'b', sort_order: 'x' },
    ]), []);
  });

  it('can then take a page dropped between two of them', () => {
    const keys = new Map(tied.map((page) => [page.id, page.sort_order]));
    for (const patch of untie(tied)) keys.set(patch.id, patch.sort_order);
    const between = orderKey(keys.get('a')!, keys.get('b')!);
    assert.ok(keys.get('a')! < between && between < keys.get('b')!, 'it lands where it was dropped, not after the run');
  });
});

describe('a dated entry', () => {
  it('is dated in one format, in the given time zone', () => {
    // 23:30 UTC on the 17th is already the 18th in Berlin.
    const at = Date.UTC(2026, 10, 17, 23, 30);
    assert.equal(localDay(at, 'UTC'), '2026-11-17');
    assert.equal(localDay(at, 'Europe/Berlin'), '2026-11-18');
    assert.equal(localDay(at, 'Not/AZone'), '2026-11-17', 'an unknown zone falls back to UTC rather than failing');
  });

  it('never takes a title that is in use, as a link would read it', () => {
    const taken = new Set([pageKey('weekly · 2026-11-18')]);
    assert.equal(seriesEntryTitle('Weekly', '2026-11-18'), 'Weekly · 2026-11-18');
    assert.equal(seriesEntryTitle('Weekly', '2026-11-18', taken), 'Weekly · 2026-11-18 (2)');
  });

  it('finds its series by title, and not an archived one or a template', () => {
    const pages = [
      { id: 'old', title: 'Minutes: Weekly', series: 1, archived: 1, created_at: 1 },
      { id: 'form', title: 'Minutes: Weekly', series: 1, is_template: 1, created_at: 2 },
      { id: 'plain', title: 'Minutes: Weekly', series: 0, created_at: 3 },
      { id: 'live', title: 'minutes:  weekly', series: 1, created_at: 4 },
    ];
    assert.equal(findSeries(pages, 'Minutes: Weekly')?.id, 'live');
    assert.equal(findSeries(pages, 'Minutes: Monthly'), undefined);
  });
});

describe('where the next minutes go', () => {
  const pages = [
    { id: 'series', title: 'Retrospectives', series: 1, created_at: 1 },
    { id: 'retired', title: 'Old retros', series: 1, archived: 1, created_at: 0 },
    { id: 'one', title: 'Retro · 2026-10-01', parent_id: 'series' },
    { id: 'stray', title: 'Retro · 2026-09-01', parent_id: 'retired' },
  ];

  it('under the series the last minutes hang under, whatever it is called now', () => {
    assert.equal(seriesAbove(pages, ['one'])?.id, 'series');
  });

  it('past one whose series was archived, to the next that is live', () => {
    assert.equal(seriesAbove(pages, ['stray', 'one'])?.id, 'series');
    assert.equal(seriesAbove(pages, ['stray']), undefined);
  });

  it('dates an entry by the day in its title, not the day it was filed', () => {
    const late = Date.UTC(2026, 10, 20);
    assert.equal(entryDay({ title: 'Minutes: Weekly · 2026-11-04 (2)', created_at: late }), '2026-11-04');
    assert.equal(entryDay({ title: 'Written by hand', created_at: Date.UTC(2026, 10, 20, 12) }), localDay(Date.UTC(2026, 10, 20, 12)));
  });
});

describe('the labels a page is offered', () => {
  const labels = [
    { id: 'topic', project_id: null, applies_to: 'pages' as const },
    { id: 'kundenwunsch', project_id: null, applies_to: 'all' as const },
    { id: 'task-only', project_id: null, applies_to: 'tasks' as const },
    { id: 'bug-bus', project_id: 'BUS', applies_to: 'all' as const },
    { id: 'bug-cal', project_id: 'CAL' },
  ];

  it('a page in no project: the workspace\'s labels that apply to pages', () => {
    assert.deepEqual(labelsForPage({ project_id: null }, labels).map((label) => label.id), ['topic', 'kundenwunsch']);
  });

  it('a page in a project: those, and that project\'s — not every project\'s', () => {
    assert.deepEqual(labelsForPage({ project_id: 'BUS' }, labels).map((label) => label.id), ['topic', 'kundenwunsch', 'bug-bus']);
  });

  it('and whatever it already carries, so it can be taken off', () => {
    assert.ok(labelsForPage({ project_id: null, labels: ['bug-cal'] }, labels).some((label) => label.id === 'bug-cal'));
  });

  it('reads a label synced before the column as one for everything', () => {
    assert.equal(labelApplies({}, 'task'), true);
    assert.equal(labelApplies({}, 'page'), true);
    assert.equal(labelApplies({ applies_to: 'pages' }, 'task'), false);
  });
});

describe('a filtered tree', () => {
  type Row = PageNode & { title: string; label?: string };
  const pages: Row[] = [
    { id: 'pricing', parent_id: null, title: 'Pricing' },
    { id: 'v5', parent_id: 'pricing', title: 'Preismodell V5', label: 'prices' },
    { id: 'paper', parent_id: 'pricing', title: 'Pricing paper' },
    { id: 'sales', parent_id: null, title: 'Sales', label: 'prices' },
  ];

  it('keeps the path to a match a label found, as the box always did', () => {
    const { keep, matched } = pagesWhere(pages, (page) => page.label === 'prices', '');
    assert.deepEqual([...matched!].sort(), ['sales', 'v5']);
    assert.ok(keep!.has('pricing'), 'the parent is drawn as the way to its child');
    assert.ok(!keep!.has('paper'));
  });

  it('asks the box and the filters together', () => {
    const { matched } = pagesWhere(pages, (page) => page.label === 'prices', 'preis');
    assert.deepEqual([...matched!], ['v5']);
  });

  it('is no filter at all when nothing is asked', () => {
    assert.deepEqual(pagesWhere(pages, null, '  '), { keep: undefined, matched: undefined });
  });
});

describe('the index in sections', () => {
  const pages = [
    { id: 'handbook', parent_id: null, project: null },
    { id: 'leave', parent_id: 'handbook', project: 'HR' },
    { id: 'billing', parent_id: null, project: 'CAL' },
    { id: 'dunning', parent_id: 'billing', project: null },
    { id: 'orphan', parent_id: 'gone', project: 'CAL' },
  ];
  const groups = groupBranches(pages, (root) => root.project, [null, 'CAL', 'HR']);

  it('files a branch by where its top page is filed, and keeps it whole', () => {
    assert.deepEqual(groups.map((group) => group.key), [null, 'CAL'], 'no section for a project only a sub-page is in');
    assert.deepEqual(groups[0].pages.map((page) => page.id), ['handbook', 'leave']);
    assert.deepEqual(groups[1].pages.map((page) => page.id), ['billing', 'dunning', 'orphan']);
  });

  it('keeps a key the order did not name, rather than losing its pages', () => {
    const extra = groupBranches(pages, (root) => root.project, [null]);
    assert.deepEqual(extra.map((group) => group.key), [null, 'CAL']);
  });
});

describe('tidying a wiki with replaced pages in it', () => {
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  it('does not report a replaced page as untouched or unlinked — it is meant to be', () => {
    const found = tidyPages([
      { id: 'v4', title: 'Preismodell v4', content: 'old prices', parent_id: null, updated_at: old, statusKind: 'superseded' },
      { id: 'v3', title: 'Preistabelle', content: 'older prices', parent_id: null, updated_at: old, superseded_by: 'v4' },
      { id: 'live', title: 'Handbook', content: 'text', parent_id: null, updated_at: old },
    ]);
    assert.deepEqual(found.byPage.get('v4'), undefined);
    assert.deepEqual(found.byPage.get('v3'), undefined);
    assert.deepEqual(found.byPage.get('live'), ['isolated', 'stale']);
  });
});

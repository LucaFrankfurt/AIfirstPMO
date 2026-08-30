/**
 * Moving a page in the wiki tree.
 *
 * `sort_order` has been on `pages` since pages existed, written once when a
 * page was created and never again, and `parent_id` was only ever set by "add a
 * sub-page". So the tree was in the order things happened to be made, a page
 * written at the top level could never become a child of another, and two pages
 * could never swap. This is the arithmetic that fixes that, on its own: given
 * the pages and a drop, where does the dragged one land.
 *
 * The interesting cases are the ones a person reaches by accident — a page
 * dropped on itself, a page dropped inside its own subtree — because those are
 * the ones that produce a tree with a branch hanging off nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareOrder } from '@kolibri/shared';
import { childrenOf, moveTargets, plotMove, type PageNode } from '../src/modules/pages/pagetree.ts';

/**
 * A handbook three levels deep.
 *
 *   handbook          onboarding          policies
 *     ├ welcome         ├ day-one           └ leave
 *     └ tooling         └ week-one
 *         └ editors
 */
const tree = (): PageNode[] => [
  { id: 'handbook', parent_id: null, sort_order: 'a' },
  { id: 'onboarding', parent_id: null, sort_order: 'b' },
  { id: 'policies', parent_id: null, sort_order: 'c' },
  { id: 'welcome', parent_id: 'handbook', sort_order: 'a' },
  { id: 'tooling', parent_id: 'handbook', sort_order: 'b' },
  { id: 'editors', parent_id: 'tooling', sort_order: 'a' },
  { id: 'day-one', parent_id: 'onboarding', sort_order: 'a' },
  { id: 'week-one', parent_id: 'onboarding', sort_order: 'b' },
  { id: 'leave', parent_id: 'policies', sort_order: 'a' },
];

/** The ids of one parent's children, after applying a move to the list. */
function after(pages: PageNode[], id: string, patch: { parent_id: string | null; sort_order: string }): PageNode[] {
  return pages.map((page) => (page.id === id ? { ...page, ...patch } : page));
}

const idsUnder = (pages: PageNode[], parent: string | null) => childrenOf(pages, parent).map((page) => page.id);

describe('dropping a page beside another', () => {
  it('reorders siblings without changing their parent', () => {
    const pages = tree();
    const patch = plotMove('policies', 'handbook', 'before', pages)!;
    assert.ok(patch, 'the move was refused');
    assert.equal(patch.parent_id, null, 'a sibling move keeps the parent');
    assert.deepEqual(idsUnder(after(pages, 'policies', patch), null), ['policies', 'handbook', 'onboarding']);
  });

  it('lands after the target when dropped on its lower edge', () => {
    const pages = tree();
    const patch = plotMove('handbook', 'policies', 'after', pages)!;
    assert.deepEqual(idsUnder(after(pages, 'handbook', patch), null), ['onboarding', 'policies', 'handbook']);
  });

  it('moves between parents and into a position at once', () => {
    // One write, not two: the parent and the order are one gesture, and syncing
    // them separately puts the page somewhere nobody asked for in between.
    const pages = tree();
    const patch = plotMove('leave', 'welcome', 'after', pages)!;
    assert.equal(patch.parent_id, 'handbook');
    assert.deepEqual(idsUnder(after(pages, 'leave', patch), 'handbook'), ['welcome', 'leave', 'tooling']);
    assert.deepEqual(idsUnder(after(pages, 'leave', patch), 'policies'), []);
  });

  it('keeps the key strictly between its neighbours, so nothing is renumbered', () => {
    const pages = tree();
    const patch = plotMove('leave', 'welcome', 'after', pages)!;
    assert.ok(compareOrder('a', patch.sort_order) < 0, 'sorts after welcome');
    assert.ok(compareOrder(patch.sort_order, 'b') < 0, 'sorts before tooling');
    for (const page of pages) {
      if (page.id !== 'leave') assert.ok(page.sort_order, 'no sibling was rewritten');
    }
  });
});

describe('dropping a page onto another', () => {
  it('makes it the last child', () => {
    const pages = tree();
    const patch = plotMove('policies', 'handbook', 'inside', pages)!;
    assert.equal(patch.parent_id, 'handbook');
    assert.deepEqual(idsUnder(after(pages, 'policies', patch), 'handbook'), ['welcome', 'tooling', 'policies']);
  });

  it('nests under a page that has no children yet', () => {
    const pages = tree();
    const patch = plotMove('policies', 'week-one', 'inside', pages)!;
    assert.equal(patch.parent_id, 'week-one');
    assert.deepEqual(idsUnder(after(pages, 'policies', patch), 'week-one'), ['policies']);
  });

  it('carries the whole subtree with it, because the children point at the page', () => {
    const pages = tree();
    const moved = after(pages, 'tooling', plotMove('tooling', 'policies', 'inside', pages)!);
    assert.deepEqual(idsUnder(moved, 'policies'), ['leave', 'tooling']);
    assert.deepEqual(idsUnder(moved, 'tooling'), ['editors'], 'editors came along');
  });
});

describe('moves that are refused', () => {
  it('refuses a page dropped on itself', () => {
    for (const zone of ['before', 'inside', 'after'] as const) {
      assert.equal(plotMove('handbook', 'handbook', zone, tree()), null, zone);
    }
  });

  it('refuses a page dropped inside its own child', () => {
    // The one somebody reaches by accident, and the one that does real damage:
    // the branch detaches from the tree and is reachable only by its URL.
    assert.equal(plotMove('handbook', 'welcome', 'inside', tree()), null);
  });

  it('refuses a page dropped inside its own grandchild', () => {
    assert.equal(plotMove('handbook', 'editors', 'inside', tree()), null);
  });

  it('allows a page beside its own child, which closes no loop', () => {
    // `before` and `after` take the *target's* parent, so this is a move to
    // handbook's children — legal, and not the same question as `inside`.
    const patch = plotMove('policies', 'welcome', 'before', tree());
    assert.equal(patch?.parent_id, 'handbook');
  });

  it('refuses a target that is not in the list at all', () => {
    // An archived page, or one in a project this screen never loaded.
    assert.equal(plotMove('handbook', 'no-such-page', 'after', tree()), null);
  });

  it('terminates on a tree that already loops', () => {
    // Two devices each made a legal move offline and the merge closed a ring.
    // The screen that finds it has to say no, not spin.
    const looped: PageNode[] = [
      { id: 'a', parent_id: 'b', sort_order: 'a' },
      { id: 'b', parent_id: 'a', sort_order: 'a' },
      { id: 'c', parent_id: null, sort_order: 'a' },
    ];
    assert.equal(plotMove('a', 'b', 'inside', looped), null);
    assert.ok(plotMove('a', 'c', 'inside', looped), 'and a way out of the ring still works');
  });
});

describe('the four moves offered in the menu', () => {
  it('offers up, down and in for a middle child', () => {
    const pages = [
      ...tree(),
      { id: 'later', parent_id: 'handbook', sort_order: 'c' },
    ];
    const targets = moveTargets('tooling', pages);
    assert.equal(targets.up, 'welcome');
    assert.equal(targets.in, 'welcome', 'indenting goes under the page above');
    assert.equal(targets.down, 'later');
    assert.equal(targets.out, 'handbook');
  });

  it('offers no way up or in for a first child', () => {
    const targets = moveTargets('welcome', tree());
    assert.equal(targets.up, undefined);
    assert.equal(targets.in, undefined);
    assert.equal(targets.down, 'tooling');
    assert.equal(targets.out, 'handbook', 'but it can still come out a level');
  });

  it('offers no way out for a page at the top level', () => {
    assert.equal(moveTargets('handbook', tree()).out, undefined);
  });

  it('offers nothing at all for a page that is not there', () => {
    assert.deepEqual(moveTargets('no-such-page', tree()), {});
  });

  it('lands where the menu item says it will', () => {
    const pages = tree();
    const targets = moveTargets('tooling', pages);
    const out = after(pages, 'tooling', plotMove('tooling', targets.out!, 'after', pages)!);
    assert.deepEqual(idsUnder(out, null), ['handbook', 'tooling', 'onboarding', 'policies']);

    const indented = after(pages, 'tooling', plotMove('tooling', targets.in!, 'inside', pages)!);
    assert.deepEqual(idsUnder(indented, 'welcome'), ['tooling']);
  });
});

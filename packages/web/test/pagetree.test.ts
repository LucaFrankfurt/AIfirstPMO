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
import {
  ancestorsOf, childrenOf, descendantsOf, moveTargets, pagesMatching, plotMove, plotToTop, trailsOf,
  withAncestors, type PageNode,
} from '../src/modules/pages/pagetree.ts';

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

/**
 * The three questions the tree asks about itself once it can be tidied: what
 * is under this page, what is it under, and — given a filter — which rows have
 * to be drawn for a match to be findable at all.
 */
describe('reading the shape of the tree', () => {
  it('takes the whole subtree, level by level', () => {
    assert.deepEqual(
      descendantsOf(tree(), 'handbook').map((page) => page.id),
      ['welcome', 'tooling', 'editors'],
    );
  });

  it('does not include the page itself, because callers say “and its sub-pages”', () => {
    assert.equal(descendantsOf(tree(), 'handbook').some((page) => page.id === 'handbook'), false);
  });

  it('answers nothing for a leaf and for a page that is not there', () => {
    assert.deepEqual(descendantsOf(tree(), 'editors'), []);
    assert.deepEqual(descendantsOf(tree(), 'nowhere'), []);
  });

  it('walks up to the top, outermost first', () => {
    assert.deepEqual(ancestorsOf(tree(), 'editors').map((page) => page.id), ['handbook', 'tooling']);
    assert.deepEqual(ancestorsOf(tree(), 'handbook'), []);
  });

  it('stops at a parent that is not in the list rather than inventing one', () => {
    const orphan = [{ id: 'stray', parent_id: 'archived', sort_order: 'a' }];
    assert.deepEqual(ancestorsOf(orphan, 'stray'), []);
  });

  it('terminates on both ends of a tree that already loops', () => {
    const looped: PageNode[] = [
      { id: 'a', parent_id: 'b', sort_order: 'a' },
      { id: 'b', parent_id: 'a', sort_order: 'a' },
    ];
    assert.equal(descendantsOf(looped, 'a').length <= 2, true);
    assert.equal(ancestorsOf(looped, 'a').length <= 2, true);
  });

  it('keeps a match together with the path to it, so the filter still shows where', () => {
    const keep = withAncestors(tree(), ['editors']);
    assert.deepEqual([...keep].sort(), ['editors', 'handbook', 'tooling']);
  });

  it('keeps nothing for no matches, and merges overlapping paths once', () => {
    assert.equal(withAncestors(tree(), []).size, 0);
    assert.deepEqual(
      [...withAncestors(tree(), ['welcome', 'tooling'])].sort(),
      ['handbook', 'tooling', 'welcome'],
    );
  });
});

/**
 * Lifting a page out of the tree.
 *
 * The bulk bar used to do this with a bare `{ parent_id: null }` patch, so the
 * page kept a `sort_order` chosen among siblings it no longer sat with. These
 * are the two answers that replaces: a key after the current last root, and
 * "nothing to do" for a page that is already there.
 */
describe('lifting a page to the top level', () => {
  it('lands after the last page already at the top', () => {
    const patch = plotToTop('editors', tree());
    assert.ok(patch);
    assert.equal(patch.parent_id, null);
    // After `policies`, which is the last root in the fixture.
    assert.equal(compareOrder(patch.sort_order, 'c') > 0, true);
  });

  it('answers nothing for a page that is already at the top level', () => {
    assert.equal(plotToTop('handbook', tree()), null);
  });

  it('answers nothing for a page that is not in the list', () => {
    assert.equal(plotToTop('nowhere', tree()), null);
  });

  it('does not order itself against itself', () => {
    // A single child of a single root: once lifted there is one root to follow,
    // and it must not be the page being moved.
    const small: PageNode[] = [
      { id: 'top', parent_id: null, sort_order: 'm' },
      { id: 'child', parent_id: 'top', sort_order: 'm' },
    ];
    const patch = plotToTop('child', small);
    assert.ok(patch);
    assert.equal(compareOrder(patch.sort_order, 'm') > 0, true);
  });
});

/**
 * The filter both trees run.
 *
 * It was five identical lines in each of the two components, which is how two
 * trees come to disagree about what counts as a match — the one thing they have
 * to agree about.
 */
describe('filtering the tree by what somebody typed', () => {
  // `PageNode` is the least a *move* needs and carries no title, which is why
  // `pagesMatching` widens it rather than the other way round.
  const named = (): (PageNode & { title: string })[] => [
    { id: 'handbook', parent_id: null, sort_order: 'a', title: 'Handbook' },
    { id: 'tooling', parent_id: 'handbook', sort_order: 'a', title: 'Tooling' },
    { id: 'editors', parent_id: 'tooling', sort_order: 'a', title: 'Editors we use' },
    { id: 'leave', parent_id: null, sort_order: 'b', title: 'Leave policy' },
  ];

  it('keeps a deep match together with the path to it', () => {
    const { keep, matched } = pagesMatching(named(), 'editors');
    assert.deepEqual([...matched!].sort(), ['editors']);
    assert.deepEqual([...keep!].sort(), ['editors', 'handbook', 'tooling']);
  });

  it('answers “no filter” for an empty box rather than “everything”', () => {
    // `PageTree` reads `undefined` as "not filtering", which is what keeps a
    // cleared box from overriding the folds.
    assert.deepEqual(pagesMatching(named(), '   '), { keep: undefined, matched: undefined });
  });

  it('answers an empty keep for a word nothing is called', () => {
    const { keep, matched } = pagesMatching(named(), 'zzz');
    assert.equal(keep!.size, 0);
    assert.equal(matched!.size, 0);
  });

  it('reads the way the search boxes do, not as a lowercased substring', () => {
    // Two words, in either order, and neither of them adjacent in the title.
    assert.deepEqual([...pagesMatching(named(), 'use editors').matched!], ['editors']);
  });
});

/** Every page's path, built once rather than per row. */
describe('trails for the whole tree', () => {
  it('gives each page the same answer `ancestorsOf` gives it', () => {
    const trails = trailsOf(tree());
    for (const page of tree()) {
      assert.deepEqual(
        trails.get(page.id)?.map((one) => one.id),
        ancestorsOf(tree(), page.id).map((one) => one.id),
        `trail for ${page.id}`,
      );
    }
  });

  it('terminates on a tree that already loops', () => {
    const looped: PageNode[] = [
      { id: 'a', parent_id: 'b', sort_order: 'a' },
      { id: 'b', parent_id: 'a', sort_order: 'a' },
    ];
    const trails = trailsOf(looped);
    assert.equal(trails.size, 2);
    for (const trail of trails.values()) assert.equal(trail.length <= 2, true);
  });

  it('stops at a parent that is not in the list', () => {
    assert.deepEqual(trailsOf([{ id: 'stray', parent_id: 'gone', sort_order: 'a' }]).get('stray'), []);
  });
});

/**
 * Walking a task tree without falling into it.
 *
 * A task sheet listed its sub-tasks and never said what it was a sub-task of,
 * so the parent was never something a person could set — and nothing had to
 * refuse a loop. Now that the field exists, `A → B → A` is two clicks away, and
 * every walk over the tree has to terminate: the one that offers candidates,
 * the one that draws the breadcrumb, and the one that answers whether a choice
 * would close the circle.
 *
 * The last case in each group is the one that matters: a tree that *already*
 * loops, because two devices each made a legal move while offline. Refusing to
 * create one is not enough if finding one hangs the screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ancestry, descendants, wouldLoop, type Node } from '../src/kernel/design-system/family.ts';

/** epic ▸ story ▸ chore ▸ detail, and a `loner` off to one side. */
const TREE: Node[] = [
  { id: 'epic', parent_id: null },
  { id: 'story', parent_id: 'epic' },
  { id: 'sibling', parent_id: 'epic' },
  { id: 'chore', parent_id: 'story' },
  { id: 'detail', parent_id: 'chore' },
  { id: 'loner', parent_id: null },
];

/** Two tasks each other's parent — legal on two devices, impossible on one. */
const LOOPED: Node[] = [
  { id: 'a', parent_id: 'b' },
  { id: 'b', parent_id: 'a' },
  { id: 'under', parent_id: 'a' },
];

describe('everything at or under a task', () => {
  it('includes the task itself, so it cannot be offered as its own parent', () => {
    assert.ok(descendants('story', TREE).has('story'));
  });

  it('reaches all the way down, not just one level', () => {
    assert.deepEqual([...descendants('epic', TREE)].sort(), ['chore', 'detail', 'epic', 'sibling', 'story']);
  });

  it('is just the task when nothing is under it', () => {
    assert.deepEqual([...descendants('loner', TREE)], ['loner']);
  });

  it('terminates on a tree that already loops', () => {
    assert.deepEqual([...descendants('a', LOOPED)].sort(), ['a', 'b', 'under']);
  });
});

describe('whether a choice would close a circle', () => {
  it('refuses a task offered itself', () => {
    assert.equal(wouldLoop('story', 'story', TREE), true);
  });

  it('refuses a child, and a grandchild', () => {
    assert.equal(wouldLoop('epic', 'story', TREE), true);
    assert.equal(wouldLoop('epic', 'detail', TREE), true);
  });

  it('allows a parent, a sibling and a stranger', () => {
    assert.equal(wouldLoop('chore', 'epic', TREE), false, 'moving up a level');
    assert.equal(wouldLoop('chore', 'sibling', TREE), false);
    assert.equal(wouldLoop('chore', 'loner', TREE), false);
  });

  it('allows clearing the parent', () => {
    assert.equal(wouldLoop('story', null, TREE), false);
  });

  it('answers rather than spinning when the tree already loops', () => {
    assert.equal(wouldLoop('under', 'a', LOOPED), false, 'it is already under a; saying so again is not a new loop');
    assert.equal(wouldLoop('a', 'under', LOOPED), true);
  });
});

describe('the chain above a task', () => {
  it('runs from the top down and ends with the task itself', () => {
    assert.deepEqual(ancestry('detail', TREE), ['epic', 'story', 'chore', 'detail']);
  });

  it('is just the task when it has no parent', () => {
    assert.deepEqual(ancestry('epic', TREE), ['epic']);
  });

  it('stops at a parent that is not in the list rather than inventing one', () => {
    // A sub-task whose parent is archived, or in a project this screen did not
    // load. The trail is short rather than wrong.
    assert.deepEqual(ancestry('orphan', [{ id: 'orphan', parent_id: 'gone' }]), ['orphan']);
  });

  it('draws a short trail instead of freezing on a loop', () => {
    const chain = ancestry('under', LOOPED);
    assert.equal(new Set(chain).size, chain.length, 'no task appears twice');
    assert.equal(chain[chain.length - 1], 'under');
  });
});

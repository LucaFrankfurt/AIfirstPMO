/**
 * Closing a stack of task sheets.
 *
 * The reported bug: open a task, open a sub-task from it, and the close button
 * had to be pressed twice — each press revealing a sheet already finished with.
 * Three levels deep it was three presses.
 *
 * The rule that fixes it has two halves, and it is easy to fix one and break
 * the other: **close** pops the whole stack, **Back** still walks it one entry
 * at a time. Both are asserted below.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTaskLocation, nextTaskState, stackDepth } from '../src/lib/task-stack.ts';

const board = { pathname: '/projects/p1' };
const at = (pathname: string, state: unknown) => ({ pathname, state });

describe('opening a task', () => {
  it('remembers the screen it was opened over', () => {
    const state = nextTaskState(board);
    assert.equal(state.background, board);
    assert.equal(state.depth, 1);
  });

  it('keeps the *board* behind a sub-task, not the task it came from', () => {
    // The half that made closing land on the parent: if the background were
    // recomputed at each level, one close would step back one sheet.
    const first = nextTaskState(board);
    const second = nextTaskState(at('/t/parent', first));
    assert.equal(second.background, board, 'the sheet below is not the background');
    assert.equal(second.depth, 2);
  });

  it('counts every level', () => {
    let state = nextTaskState(board);
    for (const depth of [2, 3, 4, 5]) {
      state = nextTaskState(at('/t/whatever', state));
      assert.equal(state.depth, depth);
    }
    assert.equal(state.background, board, 'five deep and still the board behind it');
  });

  it('has no background at all when the link was opened cold', () => {
    // Straight to `/t/x` in a new tab: there is nothing behind it, so close
    // falls back to My work rather than going back into somebody else's history.
    const state = nextTaskState(at('/t/x', null));
    assert.equal(state.background, undefined);
    assert.equal(state.depth, 2);
  });
});

describe('closing one', () => {
  it('pops exactly as many entries as there are sheets', () => {
    let state = nextTaskState(board);
    assert.equal(stackDepth(at('/t/a', state)), 1);

    state = nextTaskState(at('/t/a', state));
    assert.equal(stackDepth(at('/t/b', state)), 2, 'one press, both sheets');

    state = nextTaskState(at('/t/b', state));
    assert.equal(stackDepth(at('/t/c', state)), 3);
  });

  it('never goes back by zero, whatever the state says', () => {
    // `navigate(0)` reloads instead of closing, which would look like a button
    // that does nothing.
    for (const broken of [null, undefined, {}, { depth: 0 }, { depth: -3 }, 'nonsense']) {
      assert.ok(stackDepth(at('/t/a', broken)) >= 1, `${JSON.stringify(broken)} produced a zero`);
    }
  });
});

describe('what counts as a task sheet', () => {
  it('is the /t/ route and nothing else', () => {
    assert.equal(isTaskLocation({ pathname: '/t/WEB-1' }), true);
    assert.equal(isTaskLocation({ pathname: '/projects/p1' }), false);
    assert.equal(isTaskLocation({ pathname: '/teams' }), false);
    // Not a task route, and the prefix check has to know it.
    assert.equal(isTaskLocation({ pathname: '/tasks' }), false);
  });
});

/**
 * What a `Filters` means against one task.
 *
 * This arithmetic ran for a long time without a test of its own, inside
 * `useVisibleTasks` where only a browser could reach it — which is how
 * `due = week` came to parse, show a chip, and filter nothing at all. It is a
 * pure function now, so the bucket that was wrong and the ones beside it can
 * simply be asked.
 *
 * The other reason it is pinned here: the search screen answers the same
 * question with the same function since the two boxes started speaking one
 * language. A change that quietly altered one of these rows would change what
 * a sentence means on two screens at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { passesFilters, type FilterLookup, type Filters, type Task } from '@kolibri/shared';

const GROUPS: Record<string, 'unstarted' | 'started' | 'completed'> = {
  's-todo': 'unstarted', 's-doing': 'started', 's-done': 'completed',
};

const at: FilterLookup = {
  groupOf: (id) => GROUPS[id],
  day: '2026-03-10',
  horizon: '2026-03-17',
};

const task = (): Task => ({
  id: 't1', workspace_id: 'w1', project_id: 'p1', number: 1, identifier: 'WEB-1',
  title: 'Redesign the header', description: null, state_id: 's-todo', priority: 'medium',
  assignees: ['u-ada'], labels: ['l-design'], subscribers: [], parent_id: null,
  cycle_id: 'c1', module_id: null, estimate: null, start_date: null, due_date: null,
  sort_order: 'a', completed_at: null, archived: 0, created_by: 'u-me',
  recurrence: null, recurred_from: null,
  created_at: 0, updated_at: 0, deleted_at: null,
}) as unknown as Task;

const passes = (filters: Filters, over: Partial<Task> = {}) => passesFilters({ ...task(), ...over } as Task, filters, at);

describe('what a filter asks of a task', () => {
  it('nothing asked lets everything through', () => {
    assert.equal(passes({}), true);
  });

  it('reads a list as "is one of"', () => {
    assert.equal(passes({ state: ['s-todo', 's-doing'] }), true);
    assert.equal(passes({ state: ['s-doing', 's-done'] }), false);
    assert.equal(passes({ assignee: ['u-ada', 'u-grace'] }), true);
    assert.equal(passes({ assignee: ['u-grace'] }), false);
  });

  it('asks the state table for a group', () => {
    assert.equal(passes({ group: ['unstarted'] }), true);
    assert.equal(passes({ group: ['completed'] }), false);
    assert.equal(passes({ group: ['completed'] }, { state_id: 's-done' }), true);
  });

  it('counts a task out when any of its values is excluded', () => {
    assert.equal(passes({ not: { assignee: ['u-ada'] } }), false);
    assert.equal(passes({ not: { assignee: ['u-grace'] } }), true);
    // Shared with somebody who is excluded is still excluded: "not Ada's" means
    // the ones Ada is not on, whoever else is.
    assert.equal(passes({ not: { assignee: ['u-ada'] } }, { assignees: ['u-ada', 'u-grace'] }), false);
    assert.equal(passes({ not: { state: ['s-todo'] } }), false);
  });

  it('treats a missing cycle or module as the empty answer, not as a pass', () => {
    assert.equal(passes({ cycle: ['c1'] }), true);
    assert.equal(passes({ module: ['m1'] }), false);
    assert.equal(passes({ module: ['m1'] }, { module_id: 'm1' }), true);
  });

  describe('the four due buckets', () => {
    it('overdue is before today, and a task with no date is not overdue', () => {
      assert.equal(passes({ due: 'overdue' }, { due_date: '2026-03-09' }), true);
      assert.equal(passes({ due: 'overdue' }, { due_date: '2026-03-10' }), false);
      assert.equal(passes({ due: 'overdue' }, { due_date: null }), false);
    });

    it('today is today', () => {
      assert.equal(passes({ due: 'today' }, { due_date: '2026-03-10' }), true);
      assert.equal(passes({ due: 'today' }, { due_date: '2026-03-11' }), false);
    });

    it('none is no date at all', () => {
      assert.equal(passes({ due: 'none' }, { due_date: null }), true);
      assert.equal(passes({ due: 'none' }, { due_date: '2026-03-10' }), false);
    });

    /**
     * The bucket that parsed from the day the language was written and did
     * nothing: the filter was accepted, the chip appeared, and every task
     * stayed on screen.
     */
    it('week is today through the horizon, and leaves overdue work out of it', () => {
      assert.equal(passes({ due: 'week' }, { due_date: '2026-03-10' }), true);
      assert.equal(passes({ due: 'week' }, { due_date: '2026-03-17' }), true);
      assert.equal(passes({ due: 'week' }, { due_date: '2026-03-18' }), false);
      assert.equal(passes({ due: 'week' }, { due_date: '2026-03-09' }), false);
      assert.equal(passes({ due: 'week' }, { due_date: null }), false);
    });
  });

  it('puts the clauses together with AND', () => {
    assert.equal(passes({ state: ['s-todo'], label: ['l-design'] }), true);
    assert.equal(passes({ state: ['s-todo'], label: ['l-ops'] }), false);
  });
});

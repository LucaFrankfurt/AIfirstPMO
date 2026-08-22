/**
 * The rule for moving a task between projects, on its own.
 *
 * `relocate.test.ts` in the server package drives this through the API and is
 * where the behaviour is proved. This is the other half: the shapes a real
 * workspace makes it awkward to arrange — a project with one column, a project
 * with none, two projects that share no vocabulary at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { relocate, type ProjectVocabulary, type Scoped } from '@kolibri/shared';

const state = (id: string, group: string, order = 'V') => ({ id, group_key: group as never, sort_order: order });
const type = (id: string, name: string, order = 'V', is_default = 0) => ({ id, name, is_default, sort_order: order });

const WEB: ProjectVocabulary = {
  states: [state('w-todo', 'unstarted', 'A'), state('w-doing', 'started', 'B'), state('w-done', 'completed', 'C')],
  types: [type('w-task', 'Task', 'A', 1), type('w-bug', 'Bug', 'B')],
  labels: [{ id: 'w-reg', name: 'Regression' }, { id: 'w-photo', name: 'needs-photography' }],
};

const API: ProjectVocabulary = {
  states: [state('a-backlog', 'backlog', 'A'), state('a-wip', 'started', 'B'), state('a-shipped', 'completed', 'C')],
  types: [type('a-chore', 'Chore', 'A'), type('a-bug', 'bug', 'B', 1)],
  labels: [{ id: 'a-reg', name: 'regression' }],
};

const carrying = (over: Partial<Scoped> = {}): Scoped =>
  ({ state_id: null, type_id: null, labels: [], cycle_id: null, module_id: null, ...over });

describe('what changes when a task is filed elsewhere', () => {
  it('lands in the column with the same meaning, whatever it is called', () => {
    assert.equal(relocate(carrying({ state_id: 'w-doing' }), WEB, API).state_id, 'a-wip');
  });

  it('falls back to the column the project names, when nothing matches by meaning', () => {
    const noBacklog: ProjectVocabulary = { ...API, states: [state('a-wip', 'started', 'B')], defaultStateId: 'a-wip' };
    // Coming from "unstarted", which this project simply does not have.
    assert.equal(relocate(carrying({ state_id: 'w-todo' }), WEB, noBacklog).state_id, 'a-wip');
  });

  it('takes the first column when the project names none', () => {
    assert.equal(relocate(carrying({ state_id: 'w-todo' }), WEB, API).state_id, 'a-backlog');
  });

  it('ignores a named default that is not a column of the destination', () => {
    // A stale `default_state_id` — the state it pointed at was deleted, or it
    // belongs to a project this one was copied from.
    const stale: ProjectVocabulary = { ...API, defaultStateId: 'w-todo' };
    assert.equal(relocate(carrying({ state_id: 'w-todo' }), WEB, stale).state_id, 'a-backlog');
  });

  it('answers null rather than an id from the wrong project when there are no columns', () => {
    const empty: ProjectVocabulary = { states: [], types: [], labels: [] };
    const landed = relocate(carrying({ state_id: 'w-doing', type_id: 'w-bug' }), WEB, empty);
    assert.equal(landed.state_id, null);
    assert.equal(landed.type_id, null);
  });

  it('matches the kind of work by name, ignoring case', () => {
    assert.equal(relocate(carrying({ type_id: 'w-bug' }), WEB, API).type_id, 'a-bug');
  });

  it('otherwise starts it as whatever the destination starts new work as', () => {
    // "Task" is not a kind of work the API project has; its default is `bug`.
    assert.equal(relocate(carrying({ type_id: 'w-task' }), WEB, API).type_id, 'a-bug');
  });

  it('carries the labels that exist on both sides and drops the rest', () => {
    const landed = relocate(carrying({ labels: ['w-reg', 'w-photo'] }), WEB, API);
    assert.deepEqual(landed.labels, ['a-reg']);
  });

  it('keeps no labels at all when the two projects share no words', () => {
    assert.deepEqual(relocate(carrying({ labels: ['w-photo'] }), WEB, API).labels, []);
  });

  it('always leaves the cycle and the module behind', () => {
    const landed = relocate(carrying({ cycle_id: 'sprint-12', module_id: 'checkout' }), WEB, API);
    assert.equal(landed.cycle_id, null);
    assert.equal(landed.module_id, null);
  });

  it('is not upset by a task pointing at things the source project no longer has', () => {
    // A state deleted while somebody was offline, say. It has to land
    // somewhere, and the top of the destination is somewhere.
    const landed = relocate(carrying({ state_id: 'gone', type_id: 'gone', labels: ['gone'] }), WEB, API);
    assert.equal(landed.state_id, 'a-backlog');
    assert.equal(landed.type_id, 'a-bug');
    assert.deepEqual(landed.labels, []);
  });
});

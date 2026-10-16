/**
 * The rule for moving a task between projects, on its own.
 *
 * `relocate.test.ts` in the server package drives this through the API and is
 * where the behaviour is proved. This is the other half: the shapes a real
 * workspace makes it awkward to arrange — a project with one column, a project
 * with none, two projects that share no vocabulary at all.
 *
 * The second half of the file is the client's own move, over the local mirror.
 * That path exists so the board reacts before any round trip, which is exactly
 * what a server test cannot see: there, the answer has already been through the
 * rules once. Here, nothing has run but the client.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { relocate, type ProjectVocabulary, type Scoped } from '@kolibri/shared';
import { installBrowser } from './browser.ts';

installBrowser();

const { applyChanges, byId, list, reset } = await import('../src/kernel/sync/store');
const { moveTaskToProject } = await import('../src/kernel/sync/mutations');

const state = (id: string, group: string, order = 'V') => ({ id, group_key: group as never, sort_order: order });

const WEB: ProjectVocabulary = {
  states: [state('w-todo', 'unstarted', 'A'), state('w-doing', 'started', 'B'), state('w-done', 'completed', 'C')],
  labels: [{ id: 'w-reg', name: 'Regression' }, { id: 'w-photo', name: 'needs-photography' }],
};

const API: ProjectVocabulary = {
  states: [state('a-backlog', 'backlog', 'A'), state('a-wip', 'started', 'B'), state('a-shipped', 'completed', 'C')],
  labels: [{ id: 'a-reg', name: 'regression' }],
};

const carrying = (over: Partial<Scoped> = {}): Scoped =>
  ({ state_id: null, labels: [], cycle_id: null, module_id: null, ...over });

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
    const empty: ProjectVocabulary = { states: [], labels: [] };
    assert.equal(relocate(carrying({ state_id: 'w-doing' }), WEB, empty).state_id, null);
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
    const landed = relocate(carrying({ state_id: 'gone', labels: ['gone'] }), WEB, API);
    assert.equal(landed.state_id, 'a-backlog');
    assert.deepEqual(landed.labels, []);
  });
});

/**
 * The same move, performed by the client on its own mirror.
 *
 * A sub-task is part of the work above it, so it goes where its parent goes.
 * The server does this too — it has to, for a `PATCH` that never came from a
 * screen — but a client that waited for the answer would show the parent gone
 * from the board and its three children still sitting on it, which is the
 * half-move nobody would attribute to the drag.
 */
describe('what the client moves when a task is refiled', () => {
  const project = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, workspace_id: 'w', archived: 0, is_container: 0, ...extra });
  const task = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, title: id, workspace_id: 'w', project_id: 'web', parent_id: null, labels: [], sort_order: 'V', ...extra });

  beforeEach(() => {
    reset();
    applyChanges({
      project: [project('web'), project('api'), project('folder', { is_container: 1 }), project('old', { archived: 1 })],
      state: [
        { id: 'w-doing', project_id: 'web', group_key: 'started', sort_order: 'B' },
        { id: 'a-backlog', project_id: 'api', group_key: 'backlog', sort_order: 'A' },
        { id: 'a-wip', project_id: 'api', group_key: 'started', sort_order: 'B' },
      ],
      label: [
        { id: 'w-reg', project_id: 'web', name: 'Regression' },
        { id: 'a-reg', project_id: 'api', name: 'regression' },
      ],
    } as any);
  });

  it('takes the sub-tree and says how many rows that was', () => {
    applyChanges({
      task: [task('parent'), task('child', { parent_id: 'parent' }), task('grandchild', { parent_id: 'child' })],
    } as any);

    assert.equal(moveTaskToProject(byId('task', 'parent')!, 'api'), 3, 'the parent and two below it');
    for (const id of ['parent', 'child', 'grandchild']) {
      assert.equal(byId('task', id)!.project_id, 'api', id);
    }
  });

  it('leaves everything that is not under it alone', () => {
    applyChanges({ task: [task('parent'), task('child', { parent_id: 'parent' }), task('stranger')] } as any);

    moveTaskToProject(byId('task', 'parent')!, 'api');

    assert.equal(byId('task', 'stranger')!.project_id, 'web');
  });

  it('puts them in at the top, parent first', () => {
    applyChanges({
      task: [
        task('sitting', { project_id: 'api', sort_order: 'V' }),
        task('parent'), task('child', { parent_id: 'parent' }),
      ],
    } as any);

    moveTaskToProject(byId('task', 'parent')!, 'api');

    const order = list('task', (row) => row.project_id === 'api')
      .sort((a, b) => (a.sort_order! < b.sort_order! ? -1 : 1))
      .map((row) => row.id);
    assert.deepEqual(order, ['parent', 'child', 'sitting'],
      'the tree arrives in its own order, above what was already there');
  });

  it('puts each row through the rule, not only the one that was dragged', () => {
    applyChanges({
      task: [
        task('parent', { state_id: 'w-doing' }),
        task('child', { parent_id: 'parent', state_id: 'w-doing', labels: ['w-reg'] }),
      ],
    } as any);

    moveTaskToProject(byId('task', 'parent')!, 'api');

    const child = byId('task', 'child')!;
    assert.equal(child.state_id, 'a-wip', 'the column that means the same thing in the new project');
    assert.deepEqual(child.labels, ['a-reg'], 'and the destination’s row for the same word');
  });

  it('reaches past a row that was already filed there', () => {
    applyChanges({
      task: [
        task('parent'),
        task('child', { parent_id: 'parent', project_id: 'api' }),
        task('grandchild', { parent_id: 'child' }),
      ],
    } as any);

    assert.equal(moveTaskToProject(byId('task', 'parent')!, 'api'), 2, 'the parent and the grandchild; the child was there');
    assert.equal(byId('task', 'grandchild')!.project_id, 'api');
  });

  it('refuses a container, an archived project and the one it is already in', () => {
    applyChanges({ task: [task('lonely')] } as any);
    const row = () => byId('task', 'lonely')!;

    assert.equal(moveTaskToProject(row(), 'folder'), 0, 'a container holds projects, not tasks');
    assert.equal(moveTaskToProject(row(), 'old'), 0, 'an archived project is not a destination');
    assert.equal(moveTaskToProject(row(), 'web'), 0, 'and a drop onto its own project is not a move');
    assert.equal(row().project_id, 'web');
  });

  it('terminates on a tree that arrived looped from two offline devices', () => {
    // Each write was legal where it was made; together they are a ring. The
    // walk is bounded by `seen`, so this returns rather than hanging.
    applyChanges({
      task: [task('a', { parent_id: 'b' }), task('b', { parent_id: 'a' })],
    } as any);

    assert.equal(moveTaskToProject(byId('task', 'a')!, 'api'), 2);
    assert.equal(byId('task', 'b')!.project_id, 'api');
  });
});

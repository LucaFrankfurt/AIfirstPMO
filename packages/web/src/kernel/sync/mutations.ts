/**
 * The write API used by the UI. Every call updates the local cache first and
 * queues the change for the server — so the interface never waits on a network
 * round trip, online or off.
 */
import {
  compareOrder, descendants, orderKey, relocate,
  type EntityName, type PageFormat, type Priority, type ProjectVocabulary, type Task,
} from '@kolibri/shared';
import { now } from './clock';
import * as idb from './idb';
import { byId, list, patchLocal, tables } from './store';
import { currentWorkspace, enqueue } from './sync';

function persistLocal(entity: EntityName, id: string, patch: Record<string, unknown>): Record<string, any> {
  const row = patchLocal(entity, id, patch);
  void idb.put(entity, row);
  return row;
}

export function update(entity: EntityName, id: string, patch: Record<string, unknown>): void {
  persistLocal(entity, id, patch);
  enqueue(entity, id, patch);
}

export function create(entity: EntityName, patch: Record<string, unknown>, id: string = crypto.randomUUID()): string {
  const full = { workspace_id: currentWorkspace(), created_at: now(), deleted_at: null, ...patch, id };
  persistLocal(entity, id, full);
  enqueue(entity, id, full);
  return id;
}

export function remove(entity: EntityName, id: string): void {
  persistLocal(entity, id, { deleted_at: now() });
  enqueue(entity, id, {}, 'delete');
}

export function restore(entity: EntityName, id: string): void {
  persistLocal(entity, id, { deleted_at: null });
  enqueue(entity, id, { deleted_at: null });
}

/* -------------------------------------------------------------------- tasks */

export interface NewTask {
  project_id: string;
  title: string;
  description?: string;
  state_id?: string;
  priority?: Priority;
  assignees?: string[];
  labels?: string[];
  cycle_id?: string | null;
  module_id?: string | null;
  parent_id?: string | null;
  due_date?: string | null;
  estimate?: number | null;
  /** `weekly:2` and friends — see `scheduler.ts`. */
  recurrence?: string | null;
}

export function createTask(input: NewTask, actorId: string): string {
  const stateId = input.state_id ?? defaultStateId(input.project_id);
  const first = list('task', (t) => t.project_id === input.project_id).sort(byOrder)[0];
  return create('task', {
    project_id: input.project_id,
    title: input.title.trim(),
    description: input.description ?? null,
    state_id: stateId,
    priority: input.priority ?? 'none',
    assignees: input.assignees ?? [],
    labels: input.labels ?? [],
    subscribers: [actorId],
    cycle_id: input.cycle_id ?? null,
    module_id: input.module_id ?? null,
    parent_id: input.parent_id ?? null,
    due_date: input.due_date ?? null,
    estimate: input.estimate ?? null,
    recurrence: input.recurrence ?? null,
    archived: 0,
    created_by: actorId,
    // Optimistic placeholder — the server hands back the real identifier.
    identifier: `${byId('project', input.project_id)?.key ?? '…'}-?`,
    sort_order: orderKey(null, first?.sort_order ?? null),
  });
}

export const byOrder = (a: { sort_order?: string }, b: { sort_order?: string }) =>
  compareOrder(a.sort_order ?? '', b.sort_order ?? '');

export function defaultStateId(projectId: string): string | undefined {
  const project = byId('project', projectId);
  if (project?.default_state_id && byId('state', project.default_state_id)) return project.default_state_id;
  return list('state', (s) => s.project_id === projectId).sort(byOrder)[0]?.id;
}

/** Drop a task between two neighbours, optionally into a different column. */
export function moveTask(task: Task, before: Task | undefined, after: Task | undefined, patch: Record<string, unknown> = {}): void {
  update('task', task.id, { ...patch, sort_order: orderKey(before?.sort_order ?? null, after?.sort_order ?? null) });
}

/**
 * What a project offers, read out of the local mirror.
 *
 * Assembled here rather than inside `relocate` so the rule itself stays a pure
 * function the server can run too — the same code, over rows read from two very
 * different places.
 */
function vocabularyOf(projectId: string): ProjectVocabulary {
  return {
    states: list('state', (row) => row.project_id === projectId)
      .map((row) => ({ id: row.id, group_key: row.group_key, sort_order: row.sort_order })),
    labels: list('label', (row) => row.project_id === projectId)
      .map((row) => ({ id: row.id, name: row.name })),
    defaultStateId: byId('project', projectId)?.default_state_id ?? null,
  };
}

/**
 * File a task under a different project, sub-tasks and all.
 *
 * Applied locally rather than left to the server, for the same reason a new
 * task is: the board has to lose the card and the destination has to gain it
 * the moment the pointer is released, online or not. The server applies the
 * same rule when the change arrives, so a client that is out of date about the
 * destination's columns cannot leave the row in one that does not exist.
 *
 * **The sub-tree moves, not the one card.** A sub-task is not filed on its
 * own — it is part of the work above it, and the only list that shows it
 * beside its siblings is that parent's. Leaving the children behind splits one
 * job across two boards, each child wearing the old project's columns and
 * labels and a breadcrumb pointing at a parent that is no longer there. The
 * server does the same thing for a move that does not come from here; see
 * `followParent` in the work rules.
 *
 * Returns how many tasks moved, so the caller can name the number — and zero
 * when there was nothing to do, which is how a drop onto the project the task
 * was already in stays quiet.
 */
export function moveTaskToProject(task: Task, projectId: string): number {
  const destination = byId('project', projectId);
  if (!destination || destination.archived || destination.is_container) return 0;
  if (task.project_id === projectId) return 0;

  // Every task in the mirror, not just this project's: a sub-tree may already
  // span two projects, because a parent could be moved before this walk
  // existed and `parent_id` has never been required to stay in one place.
  const moving = [...descendants(task.id, list('task'))]
    .map((id) => byId('task', id))
    .filter((row): row is Task => !!row && row.project_id !== projectId);

  const to = vocabularyOf(projectId);
  const vocabularies = new Map<string, ProjectVocabulary>();
  const from = (id: string): ProjectVocabulary => {
    let known = vocabularies.get(id);
    if (!known) vocabularies.set(id, known = vocabularyOf(id));
    return known;
  };

  // They arrive at the top of their new project rather than wherever their old
  // keys happen to fall: two projects' orderings are unrelated, and a task
  // landing in the middle of a list it has never been in is a task nobody sees
  // arrive. `descendants` answers parents before children, so the keys below
  // keep the tree's own order rather than inverting it.
  const top = list('task', (row) => row.project_id === projectId).sort(byOrder)[0]?.sort_order ?? null;
  let previous: string | null = null;

  for (const row of moving) {
    previous = orderKey(previous, top);
    update('task', row.id, {
      ...relocate(row, from(row.project_id), to),
      project_id: projectId,
      sort_order: previous,
    });
  }
  return moving.length;
}

export function toggleAssignee(task: Task, userId: string): void {
  const assignees = task.assignees ?? [];
  update('task', task.id, {
    assignees: assignees.includes(userId) ? assignees.filter((id) => id !== userId) : [...assignees, userId],
  });
}

export function toggleLabel(task: Task, labelId: string): void {
  const labels = task.labels ?? [];
  update('task', task.id, {
    labels: labels.includes(labelId) ? labels.filter((id) => id !== labelId) : [...labels, labelId],
  });
}

/* -------------------------------------------------------------------- pages */

export function createPage(
  input: {
    title?: string; project_id?: string | null; parent_id?: string | null;
    content?: string; format?: PageFormat; icon?: string;
  },
  actorId: string,
): string {
  const siblings = list('page', (p) => (p.parent_id ?? null) === (input.parent_id ?? null)).sort(byOrder);
  return create('page', {
    title: input.title ?? 'Untitled',
    icon: input.icon ?? '📄',
    content: input.content ?? '',
    format: input.format ?? 'markdown',
    project_id: input.project_id ?? null,
    parent_id: input.parent_id ?? null,
    access: 'workspace',
    archived: 0,
    created_by: actorId,
    sort_order: orderKey(siblings[siblings.length - 1]?.sort_order ?? null, null),
  });
}

/* ----------------------------------------------------------------- comments */

export function comment(
  target: { task_id?: string; page_id?: string },
  body: string,
  actorId: string,
  anchor: unknown = null,
): string {
  return create('comment', {
    task_id: target.task_id ?? null,
    page_id: target.page_id ?? null,
    body,
    author_id: actorId,
    reactions: {},
    anchor,
  });
}

/* ------------------------------------------------------------ notifications */

export function markNotificationRead(id: string, read = true): void {
  update('notification', id, { read_at: read ? now() : null });
}

export function markAllRead(userId: string): void {
  for (const row of tables.notification.values()) {
    if (row.user_id === userId && !row.read_at && !row.deleted_at) markNotificationRead(row.id);
  }
}

/**
 * The write API used by the UI. Every call updates the local cache first and
 * queues the change for the server — so the interface never waits on a network
 * round trip, online or off.
 */
import {
  compareOrder, orderKey, relocate,
  type EntityName, type Priority, type ProjectVocabulary, type Task,
} from '@kolibri/shared';
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
  const full = { workspace_id: currentWorkspace(), created_at: Date.now(), deleted_at: null, ...patch, id };
  persistLocal(entity, id, full);
  enqueue(entity, id, full);
  return id;
}

export function remove(entity: EntityName, id: string): void {
  persistLocal(entity, id, { deleted_at: Date.now() });
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
  /** The kind of work. Left out, the project's default is used. */
  type_id?: string | null;
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
  // The same fallback the server applies, applied here too. Not because the
  // server would get it wrong — it fills the type in on arrival either way —
  // but because the row is drawn from the local store the moment it is made,
  // and a task that shows no kind of work for as long as the round trip takes
  // is a task that looks like it was created wrong.
  const typeId = input.type_id ?? defaultTypeId(input.project_id);
  const first = list('task', (t) => t.project_id === input.project_id).sort(byOrder)[0];
  return create('task', {
    project_id: input.project_id,
    title: input.title.trim(),
    description: input.description ?? null,
    state_id: stateId,
    type_id: typeId ?? null,
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

/**
 * The kind of work a new task starts as.
 *
 * Whichever the project marked default, or simply the first one — the same
 * order the server uses, so the row drawn here and the row that comes back
 * agree. A project can legitimately have no types at all (it predates them),
 * and then a task has none either.
 */
export function defaultTypeId(projectId: string): string | undefined {
  const types = list('taskType', (type) => type.project_id === projectId);
  return [...types].sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default) || byOrder(a, b))[0]?.id;
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
    types: list('taskType', (row) => row.project_id === projectId)
      .map((row) => ({ id: row.id, name: row.name, is_default: row.is_default, sort_order: row.sort_order })),
    labels: list('label', (row) => row.project_id === projectId)
      .map((row) => ({ id: row.id, name: row.name })),
    defaultStateId: byId('project', projectId)?.default_state_id ?? null,
  };
}

/**
 * File a task under a different project.
 *
 * Applied locally rather than left to the server, for the same reason a new
 * task is: the board has to lose the card and the destination has to gain it
 * the moment the pointer is released, online or not. The server applies the
 * same rule when the change arrives, so a client that is out of date about the
 * destination's columns cannot leave the row in one that does not exist.
 *
 * Returns false when there is nothing to do, so the caller can stay quiet about
 * a drop onto the project the task was already in.
 */
export function moveTaskToProject(task: Task, projectId: string): boolean {
  const destination = byId('project', projectId);
  if (!destination || destination.archived || destination.is_container) return false;
  if (task.project_id === projectId) return false;

  const first = list('task', (t) => t.project_id === projectId).sort(byOrder)[0];
  update('task', task.id, {
    ...relocate(task, vocabularyOf(task.project_id), vocabularyOf(projectId)),
    project_id: projectId,
    // It arrives at the top of its new project rather than wherever its old key
    // happens to fall: two projects' orderings are unrelated, and a task
    // landing in the middle of a list it has never been in is a task nobody
    // sees arrive.
    sort_order: orderKey(null, first?.sort_order ?? null),
  });
  return true;
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

export function createPage(input: { title?: string; project_id?: string | null; parent_id?: string | null; content?: string }, actorId: string): string {
  const siblings = list('page', (p) => (p.parent_id ?? null) === (input.parent_id ?? null)).sort(byOrder);
  return create('page', {
    title: input.title ?? 'Untitled',
    icon: '📄',
    content: input.content ?? '',
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
  update('notification', id, { read_at: read ? Date.now() : null });
}

export function markAllRead(userId: string): void {
  for (const row of tables.notification.values()) {
    if (row.user_id === userId && !row.read_at && !row.deleted_at) markNotificationRead(row.id);
  }
}

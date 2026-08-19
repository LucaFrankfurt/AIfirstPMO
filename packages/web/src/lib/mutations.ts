/**
 * The write API used by the UI. Every call updates the local cache first and
 * queues the change for the server — so the interface never waits on a network
 * round trip, online or off.
 */
import { compareOrder, orderKey, type EntityName, type Priority, type Task } from '@kolibri/shared';
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
  priority?: Priority;
  assignees?: string[];
  labels?: string[];
  cycle_id?: string | null;
  module_id?: string | null;
  parent_id?: string | null;
  due_date?: string | null;
  estimate?: number | null;
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

export function comment(target: { task_id?: string; page_id?: string }, body: string, actorId: string): string {
  return create('comment', {
    task_id: target.task_id ?? null,
    page_id: target.page_id ?? null,
    body,
    author_id: actorId,
    reactions: {},
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

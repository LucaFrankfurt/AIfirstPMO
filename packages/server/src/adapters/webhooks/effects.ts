/**
 * Which writes become an outgoing call, and what a receiver is handed.
 *
 * `repo.ts` used to build these payloads itself — the task shape, the three
 * events a task write can be, the extra `task.moved` that fires *in addition*
 * to whichever of them did. None of that is the write path's business: it is
 * this adapter's contract with somebody else's server, and it belongs beside
 * the delivery that honours it.
 *
 * On `onCommitted`, not `onWrite`: a call that has left cannot be rolled back,
 * so inside a wrapped transaction it waits for the commit.
 */
import type { EntityName } from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { env } from '../../kernel/platform/env.ts';
import {
  displayName, onCommitted, parseIds, type WriteOpts,
} from '../../kernel/write-path/repo.ts';
import { dispatch } from './webhooks.ts';

/**
 * Tell anybody who asked that something happened.
 *
 * After the write, never before: a slow receiver must not slow down the person
 * who pressed the button, and a webhook that can fail a write is a webhook that
 * takes the app down when somebody else's endpoint dies.
 */
function fireWebhooks(
  entity: EntityName,
  row: Row,
  before: Row | undefined,
  changed: Record<string, unknown>,
  opts: WriteOpts,
): void {
  const workspaceId = String(row.workspace_id ?? opts.workspaceId);

  // Said before the early return that keeps every other event about rows which
  // still exist. A deletion is the one thing a receiver cannot find out later:
  // what it would go back and read is a tombstone.
  if (opts.op === 'delete' || row.deleted_at) {
    if (entity === 'task' && !before?.deleted_at) {
      dispatch(workspaceId, 'task.deleted', {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        project_id: row.project_id,
        ...who(opts),
      });
    }
    return;
  }

  if (entity === 'task') {
    const state = row.state_id ? get<Row>(`SELECT name, group_key FROM states WHERE id = ?`, row.state_id) : undefined;
    const wasState = before?.state_id
      ? get<Row>(`SELECT name, group_key FROM states WHERE id = ?`, before.state_id)
      : undefined;
    const finished = state?.group_key === 'completed';
    const wasFinished = wasState?.group_key === 'completed';
    const payload = taskPayload(row, state, changed, opts);

    if (!before) dispatch(workspaceId, 'task.created', payload);
    else if (finished && !wasFinished) dispatch(workspaceId, 'task.completed', payload);
    else dispatch(workspaceId, 'task.updated', payload);

    // In *addition* to whichever of those three fired, never instead of one.
    // "When it reaches In Review" is the archetypal workflow and cannot be
    // written against `task.updated`, which does not say what it left — but a
    // hook already subscribed to `task.updated` must not go quiet because this
    // event was added underneath it.
    if (before && before.state_id !== row.state_id) {
      dispatch(workspaceId, 'task.moved', {
        ...payload,
        from: wasState ? { id: before.state_id, name: wasState.name, group: wasState.group_key } : null,
        to: state ? { id: row.state_id, name: state.name, group: state.group_key } : null,
      });
    }
    return;
  }

  if (entity === 'comment' && !before) {
    dispatch(workspaceId, 'comment.created', {
      id: row.id, task_id: row.task_id, page_id: row.page_id, author_id: row.author_id,
      body: String(row.body ?? '').slice(0, 500), project_id: null,
      // Where a person would go to read it, which is the task or the page — not
      // the comment, which has no screen of its own.
      url: env.publicUrl
        ? row.task_id ? `${env.publicUrl}/t/${row.task_id}`
          : row.page_id ? `${env.publicUrl}/pages/${row.page_id}` : null
        : null,
      ...who(opts),
    });
    return;
  }

  if (entity === 'page') {
    // A page fires on creation, and on an edit only when the *text* changed —
    // moving one in the tree is not news to a receiver. The body itself is not
    // sent: it is a document, and a receiver that wants it can read it.
    if (!before) {
      dispatch(workspaceId, 'page.created', {
        id: row.id, title: row.title, project_id: row.project_id, parent_id: row.parent_id ?? null,
        url: env.publicUrl ? `${env.publicUrl}/pages/${row.id}` : null,
        ...who(opts),
      });
    } else if (changed.content !== undefined) {
      dispatch(workspaceId, 'page.updated', {
        id: row.id, title: row.title, project_id: row.project_id,
        url: env.publicUrl ? `${env.publicUrl}/pages/${row.id}` : null,
        changed: Object.keys(changed),
        ...who(opts),
      });
    }
    return;
  }

  // A cycle and a module are what a report is usually *about*: the sprint that
  // ended, the milestone whose date moved. `changed` carries which fields did,
  // so a workflow can watch the one it cares about without a second call.
  if (entity === 'cycle' || entity === 'module') {
    dispatch(workspaceId, before ? `${entity}.updated` : `${entity}.created`, {
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      status: row.status ?? null,
      start_date: row.start_date ?? null,
      end_date: row.end_date ?? row.target_date ?? null,
      changed: Object.keys(changed),
      ...who(opts),
    });
    return;
  }

  if (entity === 'budget') {
    dispatch(workspaceId, before ? 'budget.updated' : 'budget.created', {
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      currency: row.currency,
      approved: Number(row.approved ?? 0),
      status: row.status ?? null,
      period_start: row.period_start ?? null,
      period_end: row.period_end ?? null,
      changed: Object.keys(changed),
      ...who(opts),
    });
    return;
  }

  // Every write, not only the first: an invoice that moves from committed to
  // paid is the event a ledger is waiting for, and correcting an amount is the
  // event an approval workflow is.
  if (entity === 'budgetActual' && !row.deleted_at) {
    dispatch(workspaceId, 'budget.spent', {
      id: row.id,
      budget_id: row.budget_id,
      line_id: row.line_id ?? null,
      description: row.description ?? '',
      category: row.category,
      amount: Number(row.amount ?? 0),
      currency: get<Row>(`SELECT currency FROM budgets WHERE id = ?`, row.budget_id)?.currency ?? null,
      spent_on: row.spent_on,
      stage: row.stage,
      vendor: row.vendor ?? null,
      reference: row.reference ?? null,
      changed: Object.keys(changed),
      ...who(opts),
    });
    return;
  }

  if (entity === 'timeEntry' && !before) {
    dispatch(workspaceId, 'time.logged', {
      id: row.id, task_id: row.task_id, project_id: row.project_id, user_id: row.user_id,
      minutes: row.minutes, spent_on: row.spent_on, billable: row.billable ?? 0,
      note: String(row.note ?? '').slice(0, 200) || null,
      ...who(opts),
    });
  }
}

/** Who did it: the id for a workflow, the name for a chat window. */
const who = (opts: WriteOpts): { actor_id: string; actor: string } =>
  ({ actor_id: opts.actorId, actor: displayName(opts.actorId) });

/**
 * A task as a receiver sees it.
 *
 * Wide enough that a workflow building a report does not have to call back for
 * the name of the state or the project, and no wider. The description is left
 * out because it is somebody's writing and can be six thousand characters; the
 * assignees are ids rather than names because a receiver that needs the names
 * reads them once from `/api/workspaces/:id/members` instead of being handed
 * everybody's, on every event, forever.
 *
 * `state` stays the *group* it has always been. The name arrived later and got
 * its own field rather than taking that one over, because a receiver reading
 * `state === 'completed'` today has to go on working.
 */
function taskPayload(
  row: Row,
  state: Row | undefined,
  changed: Record<string, unknown>,
  opts: WriteOpts,
): Record<string, unknown> {
  const labels = parseIds(row.labels);
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    project_id: row.project_id,
    project: get<Row>(`SELECT name FROM projects WHERE id = ?`, row.project_id)?.name ?? null,
    state: state?.group_key ?? null,
    state_id: row.state_id ?? null,
    state_name: state?.name ?? null,
    priority: row.priority,
    assignee_ids: parseIds(row.assignees),
    labels: labelNames(labels),
    cycle_id: row.cycle_id ?? null,
    module_id: row.module_id ?? null,
    parent_id: row.parent_id ?? null,
    estimate: row.estimate ?? null,
    start_date: row.start_date ?? null,
    due_date: row.due_date ?? null,
    completed_at: row.completed_at ?? null,
    changed: Object.keys(changed),
    url: env.publicUrl ? `${env.publicUrl}/t/${row.id}` : null,
    ...who(opts),
  };
}

/** Labels by name, because a name is what a workflow filters on. */
function labelNames(ids: string[]): string[] {
  if (!ids.length) return [];
  return all<Row>(
    `SELECT name FROM labels WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    ...ids,
  ).map((row) => String(row.name));
}

/** Hung off the write path by `wiring.ts`. */
export const installWebhookEvents = (): void => onCommitted(fireWebhooks);

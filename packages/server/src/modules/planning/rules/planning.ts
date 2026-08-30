/**
 * Dates that move other dates.
 *
 * A task's dates changing, or a `blocks` link gaining a wait, moves everything
 * downstream of it. The interface already does this itself so a Gantt works
 * offline; this is the same rule where the interface is not the caller — a
 * `PATCH` over REST, an MCP call, an import, an automation.
 */

import { reschedule } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';

let cascading = false;

function cascadeSchedule(row: Row, opts: WriteOpts): void {
  // A cascade writes tasks, which would cascade again. One level is all that is
  // wanted: `reschedule` already walks the whole chain in one pass.
  if (cascading) return;

  const projectId = String(row.project_id ?? '');
  if (!projectId) return;

  const links = all<Row>(
    `SELECT r.task_id, r.related_task_id, r.lag FROM task_relations r
      JOIN tasks t ON t.id = r.task_id
     WHERE r.kind = 'blocks' AND r.deleted_at IS NULL AND t.workspace_id = ?`,
    opts.workspaceId,
  );
  if (!links.length) return;

  // Only the tasks the graph actually mentions, plus the one that moved. A
  // workspace's whole dated backlog would be read on every date anybody types.
  const involved = new Set<string>([String(row.id)]);
  for (const link of links) {
    involved.add(String(link.task_id));
    involved.add(String(link.related_task_id));
  }
  const ids = [...involved];
  const tasks = all<Row>(
    `SELECT id, project_id, start_date, due_date FROM tasks
      WHERE id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL AND archived = 0
        AND (start_date IS NOT NULL OR due_date IS NOT NULL)`,
    ...ids,
  );
  const projectOf = new Map(tasks.map((task) => [String(task.id), String(task.project_id ?? '')]));
  const calendars = new Map<string, number[] | null>();
  const workingDays = (taskId: string): number[] | null => {
    const project = projectOf.get(taskId) ?? '';
    if (!calendars.has(project)) {
      const raw = get<Row>(`SELECT working_days FROM projects WHERE id = ?`, project)?.working_days;
      let days: number[] | null = null;
      try {
        const parsed = JSON.parse(String(raw ?? 'null'));
        if (Array.isArray(parsed)) days = parsed.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      } catch { /* a project with an unreadable calendar works every day */ }
      calendars.set(project, days);
    }
    return calendars.get(project) ?? null;
  };

  const moves = reschedule(
    [String(row.id)],
    tasks.map((task) => ({
      id: String(task.id),
      start_date: (task.start_date as string) ?? null,
      due_date: (task.due_date as string) ?? null,
    })),
    links.map((link) => ({
      from: String(link.task_id),
      to: String(link.related_task_id),
      lag: Number(link.lag ?? 0),
    })),
    { workingDays },
  );
  if (!moves.length) return;

  cascading = true;
  try {
    for (const move of moves) {
      // `system`, because the schedule moving a task is not a person editing
      // it: it earns no activity entry, no notification and no rule of its own.
      writeEntity('task', move.id, { start_date: move.start_date, due_date: move.due_date }, {
        ...opts, op: 'upsert', system: true, silent: true,
      });
    }
  } finally {
    cascading = false;
  }
}



export const planningRules = {
  entities: ['task', 'relation', 'timeEntry'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'timeEntry') {
      setForced('user_id', opts.actorId);
      if (!values.spent_on) setForced('spent_on', new Date().toISOString().slice(0, 10));
    }
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'task' && (changed.start_date !== undefined || changed.due_date !== undefined)) {
      cascadeSchedule(row, opts);
    }
    // A new `blocks` link, or a wait somebody put on one, is a change to the
    // plan as much as a date is — and the blocker is where the cascade starts.
    if (entity === 'relation' && row.kind === 'blocks' && !row.deleted_at
      && (changed.lag !== undefined || changed.related_task_id !== undefined || changed.kind !== undefined)) {
      const blocker = get<Row>(`SELECT id, project_id FROM tasks WHERE id = ?`, row.task_id);
      if (blocker) cascadeSchedule(blocker, opts);
    }
  },
} satisfies EntityRule;

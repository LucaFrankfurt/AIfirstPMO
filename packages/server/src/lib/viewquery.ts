/**
 * A saved view's filters, as SQL.
 *
 * This used to live inside `share.ts`, because a shared link was the only thing
 * outside the app that had to resolve a view server-side. The calendar feed is
 * the second, and two copies of a filter translation is how a shared link and a
 * subscribed calendar end up disagreeing about what a view contains.
 *
 * The mapping is the whole of it: a saved view names things the way the
 * interface does — `state`, `type`, `cycle` — and the table names them
 * `state_id` and so on. Getting that wrong shows somebody *more* tasks than the
 * view they made it from, which is the failure that matters here, because both
 * callers show the result to people who are not in the workspace.
 */
import { all, get, type Row } from '../db/index.ts';

/** The shape a saved view stores, loosely — it is JSON somebody wrote. */
export type Filters = Record<string, unknown>;

export interface ViewQuery {
  /** Everything is scoped to one workspace, always. */
  workspaceId: string;
  /** Narrow to one project, or leave out for the whole workspace. */
  projectId?: string | null;
  filters?: Filters;
  /** Whether finished work is in it. */
  includeDone?: boolean;
  /** Only tasks that have a due date — what a calendar wants. */
  withDueDate?: boolean;
  /** Only tasks this person is on. */
  assignedTo?: string;
  limit?: number;
  orderBy?: 'sort_order' | 'due_date';
}

/** `state` → `state_id`, and the five others that need the same treatment. */
const COLUMNS: Record<string, string> = {
  state: 'state_id', cycle: 'cycle_id', module: 'module_id',
  project: 'project_id', priority: 'priority',
};

/** A view's `filters` column, which is JSON and may be anything at all. */
export const readFilters = (raw: unknown): Filters => {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed as Filters : {};
  } catch {
    return {};
  }
};

/**
 * The tasks a view resolves to, with their state's name and group alongside.
 *
 * Never crosses a workspace: `workspace_id` is in the `WHERE` whether or not a
 * project narrows it further, so a filter naming a project id from somewhere
 * else returns nothing rather than somebody else's board.
 */
export function tasksMatching(query: ViewQuery): Row[] {
  const where = ['t.deleted_at IS NULL', 't.archived = 0', 't.workspace_id = ?'];
  const params: unknown[] = [query.workspaceId];

  if (query.projectId) {
    where.push('t.project_id = ?');
    params.push(query.projectId);
  }
  if (!query.includeDone) where.push(`(s.group_key IS NULL OR s.group_key NOT IN ('completed', 'cancelled'))`);
  if (query.withDueDate) where.push(`t.due_date IS NOT NULL AND t.due_date != ''`);
  if (query.assignedTo) {
    // `assignees` is a JSON array of ids. `json_each` is how SQLite asks
    // whether one is in it without a `LIKE` that would match a prefix.
    where.push(`EXISTS (SELECT 1 FROM json_each(t.assignees) WHERE json_each.value = ?)`);
    params.push(query.assignedTo);
  }

  for (const [key, values] of Object.entries(query.filters ?? {})) {
    const column = COLUMNS[key];
    if (!column || !Array.isArray(values) || !values.length) continue;
    where.push(`t.${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values.map(String));
  }

  // The same questions the other way round. `IS NOT` rather than `NOT IN`,
  // because SQL's `NOT IN` is false rather than true when the column is null —
  // so "not in the Done column" would silently drop every task with no state.
  const not = (query.filters?.not ?? {}) as Record<string, unknown>;
  for (const [key, values] of Object.entries(not)) {
    const column = COLUMNS[key];
    if (!column || !Array.isArray(values) || !values.length) continue;
    where.push(`(t.${column} IS NULL OR t.${column} NOT IN (${values.map(() => '?').join(', ')}))`);
    params.push(...values.map(String));
  }
  if (Array.isArray(not.group) && not.group.length) {
    where.push(`(s.group_key IS NULL OR s.group_key NOT IN (${not.group.map(() => '?').join(', ')}))`);
    params.push(...not.group.map(String));
  }
  for (const key of ['assignee', 'label'] as const) {
    const values = not[key];
    if (!Array.isArray(values) || !values.length) continue;
    const column = key === 'assignee' ? 'assignees' : 'labels';
    where.push(`NOT EXISTS (SELECT 1 FROM json_each(t.${column})
      WHERE json_each.value IN (${values.map(() => '?').join(', ')}))`);
    params.push(...values.map(String));
  }

  // Custom fields live in a table of their own. Each field is a separate
  // condition, because two fields are an AND and two answers to one are an OR.
  const filters = query.filters ?? {};
  const fieldFilters = (filters.field && typeof filters.field === 'object' ? filters.field : {}) as Record<string, unknown>;
  for (const [fieldId, wanted] of Object.entries(fieldFilters)) {
    if (!Array.isArray(wanted) || !wanted.length) continue;
    const kind = get<Row>(`SELECT kind FROM custom_fields WHERE id = ? AND deleted_at IS NULL`, fieldId)?.kind;
    if (!kind) continue;
    const clauses: string[] = [];
    const answers = wanted.map(String);
    const exists = (test: string) => `EXISTS (SELECT 1 FROM field_values fv WHERE fv.task_id = t.id
        AND fv.field_id = ? AND fv.deleted_at IS NULL AND fv.value IS NOT NULL AND fv.value != '' AND (${test}))`;

    if (answers.includes('')) {
      clauses.push(`NOT ${exists('1 = 1')}`);
      params.push(fieldId);
    }
    if (answers.includes('*')) {
      clauses.push(exists('1 = 1'));
      params.push(fieldId);
    }
    const values = answers.filter((value) => value !== '' && value !== '*');
    if (values.length) {
      // A multi-select is stored as a JSON array, so membership is a LIKE on
      // the quoted value rather than equality. Ugly, and correct: the quotes
      // are what stop `"do"` matching `"done"`.
      const test = String(kind) === 'multi_select'
        ? values.map(() => `fv.value LIKE ?`).join(' OR ')
        : `fv.value IN (${values.map(() => '?').join(', ')})`;
      clauses.push(exists(test));
      params.push(fieldId, ...(String(kind) === 'multi_select' ? values.map((value) => `%"${value}"%`) : values));
    }
    if (clauses.length) where.push(`(${clauses.join(' OR ')})`);
  }

  const order = query.orderBy === 'due_date' ? 't.due_date, t.sort_order' : 't.sort_order';
  return all<Row>(
    `SELECT t.*, s.name AS state_name, s.group_key, p.name AS project_name, p.key AS project_key
       FROM tasks t
       LEFT JOIN states s ON s.id = t.state_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT ?`,
    ...params, Math.min(Math.max(1, query.limit ?? 500), 2000),
  );
}

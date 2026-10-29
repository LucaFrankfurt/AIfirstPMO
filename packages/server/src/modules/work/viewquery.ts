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
import {
  HORIZON_DAYS, matchesTerms, parseTerms, passesFilters,
  type FilterLookup, type Filters as TaskFilters, type StateGroup, type Task,
} from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';

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
  /**
   * Whose calendar `due` is read in. "Overdue" is a day, and a day is
   * somebody's: the person who shared the view, or whose feed it is. UTC
   * without one, which is what the scheduler counts in.
   */
  zone?: string | null;
  limit?: number;
  orderBy?: 'sort_order' | 'due_date';
}

/** `state` → `state_id`, and the five others that need the same treatment. */
const COLUMNS: Record<string, string> = {
  state: 'state_id', cycle: 'cycle_id', module: 'module_id',
  project: 'project_id', priority: 'priority',
};

/**
 * Whether a JSON list column holds any of `values`, as SQL — `holdsAny` in
 * shared's `kernel/search/filters.ts`, spelt for SQLite, and it has to stay the
 * same question.
 *
 * `''` is the empty answer: nobody on it, no label. A list never contains it,
 * so it is asked as "the list is empty" rather than looked for. The ids go
 * through `json_each` for the reason the `assignedTo` clause below gives: a
 * `LIKE` on the text would let one id match the prefix of another.
 */
function listHolds(column: 'assignees' | 'labels', values: string[], params: unknown[]): string {
  const clauses: string[] = [];
  if (values.includes('')) clauses.push(`json_array_length(COALESCE(t.${column}, '[]')) = 0`);
  const ids = values.filter((value) => value !== '');
  if (ids.length) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(t.${column}) WHERE json_each.value IN (${ids.map(() => '?').join(', ')}))`);
    params.push(...ids);
  }
  return `(${clauses.join(' OR ')})`;
}

/** The calendar day in a zone, as `YYYY-MM-DD`. A zone this runtime does not know reads as UTC. */
function dayIn(zone: string | null | undefined, at = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

const plusDays = (day: string, count: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);

const strings = (value: unknown): string[] | undefined =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined);

/**
 * A saved view's JSON, narrowed to the shape `passesFilters` reads.
 *
 * The column is whatever a client sent, and the shared function trusts its
 * argument: a string where a list belongs would reach `.some` and take the
 * shared page down with it. Lists stay lists, `due` stays one of its four
 * words, and everything else is dropped rather than guessed at.
 */
function taskFilters(raw: Filters): TaskFilters {
  const lists = (from: Record<string, unknown>) => {
    const out: Record<string, string[]> = {};
    for (const key of ['state', 'group', 'priority', 'assignee', 'label', 'cycle', 'module', 'project']) {
      const values = strings(from[key]);
      if (values?.length) out[key] = values;
    }
    return out;
  };
  const not = raw.not && typeof raw.not === 'object' ? lists(raw.not as Record<string, unknown>) : {};
  return {
    ...lists(raw),
    ...(Object.keys(not).length ? { not } : {}),
    ...(['overdue', 'today', 'week', 'none'].includes(String(raw.due)) ? { due: raw.due as TaskFilters['due'] } : {}),
    ...(typeof raw.text === 'string' && raw.text.trim() ? { text: raw.text } : {}),
  } as TaskFilters;
}

/** A JSON list column, read for the second pass. A broken one is an empty list. */
function listColumn(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

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

  for (const [key, raw] of Object.entries(query.filters ?? {})) {
    const column = COLUMNS[key];
    // Strings only, as `taskFilters` keeps them: the two passes have to read
    // a malformed view the same way, or one hides what the other shows.
    const values = strings(raw);
    if (!column || !values?.length) continue;
    // `''` is the empty answer — `cycle = none` — and a column that holds
    // nothing holds `NULL`, which no `IN` list ever matches.
    const blank = values.includes('') ? ` OR t.${column} IS NULL OR t.${column} = ''` : '';
    where.push(`(t.${column} IN (${values.map(() => '?').join(', ')})${blank})`);
    params.push(...values);
  }
  // `group` asks the state's group, which the join already carries — `is:
  // open` saved as a view. Only its `not` form was written, so the positive
  // one showed every column.
  const group = strings(query.filters?.group);
  if (group?.length) {
    where.push(`s.group_key IN (${group.map(() => '?').join(', ')})`);
    params.push(...group);
  }
  // The four due buckets, in the day of whoever's view it is — the same
  // arithmetic `passesFilters` does below, written once more so `LIMIT`
  // counts the right rows.
  const day = dayIn(query.zone);
  const horizon = plusDays(day, HORIZON_DAYS);
  const due = query.filters?.due;
  if (due === 'overdue') { where.push(`t.due_date IS NOT NULL AND t.due_date != '' AND t.due_date < ?`); params.push(day); }
  if (due === 'today') { where.push(`t.due_date = ?`); params.push(day); }
  if (due === 'week') { where.push(`t.due_date >= ? AND t.due_date <= ?`); params.push(day, horizon); }
  if (due === 'none') where.push(`(t.due_date IS NULL OR t.due_date = '')`);
  // The two lists, which `COLUMNS` cannot name because a task holds several of
  // each. They were simply skipped when they asked "is one of" — only the
  // `not` form below was ever written — so a view of one person's work, shared
  // or subscribed to, handed over the whole project.
  for (const key of ['assignee', 'label'] as const) {
    const values = strings(query.filters?.[key]);
    if (!values?.length) continue;
    where.push(listHolds(key === 'assignee' ? 'assignees' : 'labels', values, params));
  }

  // The same questions the other way round. `IS NOT` rather than `NOT IN`,
  // because SQL's `NOT IN` is false rather than true when the column is null —
  // so "not in the Done column" would silently drop every task with no state.
  const not = (query.filters?.not ?? {}) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(not)) {
    const column = COLUMNS[key];
    const values = strings(raw);
    if (!column || !values?.length) continue;
    // `!= none` is "something is set", which a `NULL` is not.
    const empty = values.includes('') ? `(t.${column} IS NOT NULL AND t.${column} != '') AND ` : `t.${column} IS NULL OR `;
    where.push(`(${empty}t.${column} NOT IN (${values.map(() => '?').join(', ')}))`);
    params.push(...values);
  }
  const notGroup = strings(not.group);
  if (notGroup?.length) {
    where.push(`(s.group_key IS NULL OR s.group_key NOT IN (${notGroup.map(() => '?').join(', ')}))`);
    params.push(...notGroup);
  }
  for (const key of ['assignee', 'label'] as const) {
    const values = strings(not[key]);
    if (!values?.length) continue;
    where.push(`NOT ${listHolds(key === 'assignee' ? 'assignees' : 'labels', values, params)}`);
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
  const limit = Math.min(Math.max(1, query.limit ?? 500), 2000);
  const wanted = taskFilters(query.filters ?? {});
  // The words cannot be asked in SQL — they are the search grammar, folded
  // accents and all — so a view with words is read whole and cut after.
  const terms = parseTerms(wanted.text ?? '');
  const rows = all<Row>(
    `SELECT t.*, s.name AS state_name, s.group_key, p.name AS project_name, p.key AS project_key
       FROM tasks t
       LEFT JOIN states s ON s.id = t.state_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}${terms.length ? '' : ' LIMIT ?'}`,
    ...params, ...(terms.length ? [] : [limit]),
  );

  /*
   * The last word goes to the function the board reads its filters with.
   *
   * Everything above is this file's translation of a `Filters` into SQL, and
   * every gap in that translation was a leak: `assignee` and `label` were
   * skipped when they asked "is one of", `group`, `due` and `text` were never
   * written, and each one showed a stranger with a link more than the view
   * they were sent. The SQL stays — it is what keeps `LIMIT` honest — but no row
   * leaves here that the board would not have shown.
   */
  const groups = new Map(rows.map((row) => [String(row.state_id), row.group_key as StateGroup | undefined]));
  const at: FilterLookup = { groupOf: (id) => groups.get(id), day, horizon };
  return rows.filter((row) => {
    const task = { ...row, assignees: listColumn(row.assignees), labels: listColumn(row.labels) } as unknown as Task;
    if (!passesFilters(task, wanted, at)) return false;
    // As the board reads it, exclusions alone included: see `useVisibleTasks`.
    return !terms.length || matchesTerms(`${row.identifier} ${row.title} ${row.description ?? ''}`, terms);
  }).slice(0, limit);
}

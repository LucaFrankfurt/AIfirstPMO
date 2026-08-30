/**
 * A task list as a spreadsheet.
 *
 * The other direction has existed since the beginning, which made the missing
 * half conspicuous: a tool people are asked to trust with their work should be
 * able to hand it back in the format every office on earth can open. This is
 * also the answer to half the reporting questions that would otherwise want a
 * feature — somebody who can get the list into a spreadsheet can pivot it
 * themselves.
 *
 * The columns are **the ones the importer reads**, under the header names it
 * recognises, so a list exported here and imported again lands where it
 * started. That is not a nicety: a round trip that silently loses the
 * assignees is how a "backup" turns out to have been nothing of the kind. The
 * few extra columns at the end (project, cycle, module, dates it recorded
 * rather than dates somebody set) are ignored on the way back in, which is
 * why they are last.
 */
import { writeCsv, type Delimiter } from '@kolibri/shared';
import { all, type Row } from '../../kernel/platform/db/index.ts';

/** Header names chosen so `guessMapping` maps every one of them back. */
const HEADERS = [
  'Key', 'Title', 'Description', 'State', 'Priority', 'Assignee', 'Labels',
  'Start date', 'Due date', 'Estimate', 'Parent', 'Blocks', 'Blocked by',
  // Beyond here is context, not input: no importer column claims these names.
  'Project', 'Cycle', 'Module', 'Created', 'Completed', 'Archived',
] as const;

export interface TaskCsvOptions {
  /** `;` for a German Excel, which splits on that and nothing else. */
  delimiter?: Delimiter;
  /** Include tasks somebody has archived. Off by default, as everywhere else. */
  archived?: boolean;
}

/**
 * Write the tasks matching a `WHERE` fragment as CSV.
 *
 * The fragment is built by the caller from parameters it has already
 * validated — the same shape the list endpoint uses — and is never assembled
 * from a query string here.
 */
export function tasksToCsv(
  workspaceId: string,
  where: string,
  params: unknown[],
  options: TaskCsvOptions = {},
): string {
  const tasks = all<Row>(
    `SELECT t.*, p.name AS project_name, s.name AS state_name, c.name AS cycle_name, m.name AS module_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN states s ON s.id = t.state_id
       LEFT JOIN cycles c ON c.id = t.cycle_id
       LEFT JOIN modules m ON m.id = t.module_id
      WHERE t.workspace_id = ? AND t.deleted_at IS NULL
        ${options.archived ? '' : 'AND t.archived = 0'}
        AND ${where}
      ORDER BY p.name, t.number`,
    workspaceId, ...params,
  );

  if (!tasks.length) return writeCsv([...HEADERS], [], { delimiter: options.delimiter });

  /* Names, once, for every id any of these rows mentions. Three queries
     rather than three per row: a thousand-task export otherwise runs four
     thousand statements to write four thousand words. */
  const names = new Map<string, string>();
  const remember = (rows: Row[]) => { for (const row of rows) names.set(String(row.id), String(row.name)); };
  remember(all<Row>(
    `SELECT u.id, u.name FROM users u
       JOIN workspace_members m ON m.user_id = u.id
      WHERE m.workspace_id = ?`,
    workspaceId,
  ));
  remember(all<Row>(`SELECT id, name FROM labels WHERE workspace_id = ?`, workspaceId));

  /**
   * `identifier` is what a person types to name a task, so a parent or a
   * blocker is written as one. Read for the whole workspace rather than for
   * the exported set: a task in this file can be blocked by one that is not,
   * and `BETA-3` is still the useful answer.
   */
  const identifiers = new Map(
    all<Row>(`SELECT id, identifier FROM tasks WHERE workspace_id = ?`, workspaceId)
      .map((row) => [String(row.id), String(row.identifier)]),
  );
  const identifierOf = (id: unknown): string => (id ? identifiers.get(String(id)) ?? '' : '');

  const ids = new Set(tasks.map((task) => String(task.id)));
  const blocks = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  /* Every blocking link in the workspace, filtered here rather than in an
     `IN (?, ?, …)` of five thousand placeholders — which is a statement SQLite
     is entitled to refuse, and a cliff that only appears on the export big
     enough to matter. */
  for (const relation of all<Row>(
    `SELECT task_id, related_task_id FROM task_relations
      WHERE workspace_id = ? AND deleted_at IS NULL AND kind = 'blocks'`,
    workspaceId,
  )) {
    const from = String(relation.task_id);
    const target = String(relation.related_task_id);
    if (ids.has(from)) {
      if (!blocks.has(from)) blocks.set(from, []);
      blocks.get(from)!.push(identifierOf(target));
    }
    if (ids.has(target)) {
      if (!blockedBy.has(target)) blockedBy.set(target, []);
      blockedBy.get(target)!.push(identifierOf(from));
    }
  }

  const named = (raw: unknown): string => list(raw).map((id) => names.get(id) ?? '').filter(Boolean).join(', ');
  const day = (at: unknown): string => (at ? new Date(Number(at)).toISOString().slice(0, 10) : '');

  const rows = tasks.map((task) => [
    task.identifier,
    task.title,
    task.description,
    task.state_name,
    task.priority === 'none' ? '' : task.priority,
    named(task.assignees),
    named(task.labels),
    task.start_date,
    task.due_date,
    task.estimate,
    identifierOf(task.parent_id),
    (blocks.get(String(task.id)) ?? []).join(', '),
    (blockedBy.get(String(task.id)) ?? []).join(', '),
    task.project_name,
    task.cycle_name,
    task.module_name,
    day(task.created_at),
    day(task.completed_at),
    task.archived ? 'yes' : '',
  ]);

  return writeCsv([...HEADERS], rows, { delimiter: options.delimiter });
}

const list = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

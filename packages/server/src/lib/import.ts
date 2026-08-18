/**
 * Importing a backlog from somewhere else.
 *
 * The single biggest reason a team does not move: nobody re-types four hundred
 * tasks. So this errs towards getting rows *in* — a row with a title and
 * nothing else is a valid task — and towards saying exactly what it could not
 * read rather than refusing the file.
 *
 * Two passes, always. The first is a dry run that changes nothing and reports
 * what would happen; the interface shows it before the button says Import. An
 * import you cannot preview is one people run once and then undo by hand.
 */
import { all, get, type Row } from '../db/index.ts';
import {
  MAX_ROWS, orderKey, parseCsv, readDate, readPriority,
  type ImportField, type ImportResult, type Mapping, type Priority,
} from '@kolibri/shared';
import { uid } from './ids.ts';
import { writeEntity, type WriteOpts } from './repo.ts';

/** A person, by email, full name or first name — the same handles a mention accepts. */
function resolvePerson(workspaceId: string, value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  const members = all<Row>(
    `SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
    workspaceId,
  );
  for (const member of members) {
    const email = String(member.email ?? '').toLowerCase();
    const name = String(member.name ?? '').toLowerCase();
    if (text === email || text === name || text === email.split('@')[0] || text === name.split(/\s+/)[0]) {
      return member.id;
    }
  }
  return null;
}

/* --------------------------------------------------------------- import */

export interface ImportOptions {
  workspaceId: string;
  projectId: string;
  actorId: string;
  mapping: Mapping;
  /** Parse only and report; nothing is written. */
  dryRun: boolean;
  delimiter?: string;
  opts: WriteOpts;
}

export function importCsv(text: string, options: ImportOptions): ImportResult {
  const table = parseCsv(text, options.delimiter);
  const result: ImportResult = { total: table.rows.length, created: 0, skipped: 0, problems: [], preview: [] };
  if (!table.rows.length) return result;
  if (table.rows.length > MAX_ROWS) {
    result.problems.push({ row: 0, message: `${table.rows.length} rows is more than the ${MAX_ROWS} this accepts at once` });
    return result;
  }

  const byField = new Map<ImportField, string>();
  for (const [column, field] of Object.entries(options.mapping)) {
    if (!byField.has(field)) byField.set(field, column);
  }
  const titleColumn = byField.get('title');
  if (!titleColumn) {
    result.problems.push({ row: 0, message: 'No column is mapped to the title, and a task without one is nothing' });
    return result;
  }

  const states = all<Row>(
    `SELECT id, name, group_key FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
    options.projectId,
  );
  const project = get<Row>(`SELECT default_state_id FROM projects WHERE id = ?`, options.projectId);
  const fallbackState = project?.default_state_id ?? states[0]?.id ?? null;

  const types = all<Row>(
    `SELECT id, name FROM task_types WHERE project_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, sort_order`,
    options.projectId,
  );

  // Labels created during a run are remembered, so a thousand rows tagged
  // "bug" produce one label rather than a thousand.
  const labelCache = new Map<string, string>();
  const personCache = new Map<string, string | null>();
  let previous = lastSortOrder(options.projectId);

  for (const [index, row] of table.rows.entries()) {
    const line = index + 2; // header is row 1, as a spreadsheet counts
    const title = (row[titleColumn] ?? '').trim();
    if (!title) {
      result.skipped++;
      result.problems.push({ row: line, column: titleColumn, message: 'No title — skipped' });
      continue;
    }

    const values: Record<string, unknown> = {
      workspace_id: options.workspaceId,
      project_id: options.projectId,
      title,
      created_by: options.actorId,
    };

    const description = read(row, byField, 'description');
    const externalId = read(row, byField, 'external_id');
    if (description || externalId) {
      // The original key is kept in the body rather than thrown away: it is
      // what somebody searches for when they ask "where did this come from".
      values.description = [description, externalId ? `\n\nImported from ${externalId}` : ''].join('').trim() || null;
    }

    const stateName = read(row, byField, 'state');
    if (stateName) {
      const match = states.find((state) => String(state.name).toLowerCase() === stateName.toLowerCase());
      if (match) {
        values.state_id = match.id;
      } else {
        values.state_id = fallbackState;
        result.problems.push({
          row: line, column: byField.get('state'),
          message: `No state called "${stateName}" in this project — used the default`,
        });
      }
    } else {
      values.state_id = fallbackState;
    }

    const typeName = read(row, byField, 'type');
    let typeLabel: string | null = null;
    if (typeName) {
      const match = types.find((type) => String(type.name).toLowerCase() === typeName.toLowerCase());
      if (match) {
        values.type_id = match.id;
        typeLabel = String(match.name);
      } else {
        // Left to the project default rather than invented: a file full of
        // "Story" and "Epic" should not quietly add two kinds of work nobody
        // agreed to.
        result.problems.push({
          row: line, column: byField.get('type'),
          message: `No kind of work called "${typeName}" in this project — used the default`,
        });
      }
    }

    const priorityText = read(row, byField, 'priority');
    if (priorityText) {
      const priority = readPriority(priorityText);
      if (priority) values.priority = priority;
      else result.problems.push({ row: line, column: byField.get('priority'), message: `Cannot read "${priorityText}" as a priority` });
    }

    const assignee = read(row, byField, 'assignee');
    let assignedName: string | null = null;
    if (assignee) {
      if (!personCache.has(assignee)) personCache.set(assignee, resolvePerson(options.workspaceId, assignee));
      const userId = personCache.get(assignee) ?? null;
      if (userId) {
        values.assignees = [userId];
        assignedName = get<Row>(`SELECT name FROM users WHERE id = ?`, userId)?.name ?? assignee;
      } else {
        result.problems.push({
          row: line, column: byField.get('assignee'),
          message: `Nobody in this workspace matches "${assignee}" — left unassigned`,
        });
      }
    }

    const labelText = read(row, byField, 'labels');
    const labelNames = labelText ? labelText.split(/[,;|]/).map((name) => name.trim()).filter(Boolean) : [];

    for (const [field, key] of [['due_date', 'due_date'], ['start_date', 'start_date']] as const) {
      const raw = read(row, byField, field);
      if (!raw) continue;
      const parsed = readDate(raw);
      if ('error' in parsed) result.problems.push({ row: line, column: byField.get(field), message: parsed.error });
      else if (parsed.date) values[key] = parsed.date;
    }

    const estimateText = read(row, byField, 'estimate');
    if (estimateText) {
      const estimate = Number(estimateText.replace(',', '.'));
      if (Number.isFinite(estimate)) values.estimate = Math.round(estimate);
      else result.problems.push({ row: line, column: byField.get('estimate'), message: `Cannot read "${estimateText}" as a number` });
    }

    if (result.preview.length < 5) {
      result.preview.push({
        title,
        state: states.find((state) => state.id === values.state_id)?.name ?? null,
        // Falls back to what the project will actually give it.
        type: typeLabel ?? (types[0] ? String(types[0].name) : null),
        priority: (values.priority as Priority) ?? 'none',
        // Who it will actually go to, not what the cell said: showing an
        // address that resolved to nobody promises an assignment that is not
        // going to happen.
        assignee: assignedName,
        labels: labelNames,
        due: (values.due_date as string) ?? null,
      });
    }

    if (options.dryRun) {
      result.created++;
      continue;
    }

    if (labelNames.length) {
      values.labels = labelNames.map((name) => resolveLabel(name, options, labelCache));
    }
    previous = orderKey(previous, null);
    values.sort_order = previous;
    writeEntity('task', uid(), values, options.opts);
    result.created++;
  }

  return result;
}

const read = (row: Record<string, string>, byField: Map<ImportField, string>, field: ImportField): string => {
  const column = byField.get(field);
  return column ? (row[column] ?? '').trim() : '';
};

function resolveLabel(name: string, options: ImportOptions, cache: Map<string, string>): string {
  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const existing = get<Row>(
    `SELECT id FROM labels WHERE workspace_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
       AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
    options.workspaceId, name, options.projectId,
  );
  const id = existing?.id ?? writeEntity('label', uid(), {
    workspace_id: options.workspaceId, project_id: options.projectId, name, color: '#6366f1',
  }, options.opts).row.id;
  cache.set(key, id);
  return id;
}

const lastSortOrder = (projectId: string): string | null =>
  get<Row>(
    `SELECT sort_order FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order DESC LIMIT 1`,
    projectId,
  )?.sort_order ?? null;

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
  const result: ImportResult = { total: table.rows.length, created: 0, skipped: 0, linked: 0, problems: [], preview: [] };

  /**
   * What each row turned into, so the second pass can resolve the references
   * a spreadsheet can only express as text: a parent, and what blocks what.
   */
  const made: {
    line: number;
    id: string;
    externalId: string;
    title: string;
    parent: string;
    blocks: string[];
    blockedBy: string[];
  }[] = [];
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
    // An issue type column becomes a label. Every tracker worth importing from
    // has one, Kolibri has one way of saying what sort of thing a task is, and
    // dropping the column would throw away the most useful word in the file.
    // Deduplicated by name, so a row tagged "bug" that is also of type "Bug"
    // arrives with one label rather than two.
    const typeName = read(row, byField, 'type');
    const labelNames = [...new Set([
      ...(labelText ? labelText.split(/[,;|]/).map((name) => name.trim()) : []),
      ...(typeName ? [typeName.trim()] : []),
    ].filter(Boolean))];

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
        priority: (values.priority as Priority) ?? 'none',
        // Who it will actually go to, not what the cell said: showing an
        // address that resolved to nobody promises an assignment that is not
        // going to happen.
        assignee: assignedName,
        labels: labelNames,
        due: (values.due_date as string) ?? null,
      });
    }

    const refs = {
      line,
      externalId,
      title,
      parent: read(row, byField, 'parent'),
      blocks: splitRefs(read(row, byField, 'blocks')),
      blockedBy: splitRefs(read(row, byField, 'blocked_by')),
    };

    if (options.dryRun) {
      made.push({ ...refs, id: `dry-${line}` });
      result.created++;
      continue;
    }

    if (labelNames.length) {
      values.labels = labelNames.map((name) => resolveLabel(name, options, labelCache));
    }
    previous = orderKey(previous, null);
    values.sort_order = previous;
    const id = uid();
    writeEntity('task', id, values, options.opts);
    made.push({ ...refs, id });
    result.created++;
  }

  linkUp(made, result, options);
  return result;
}

/** A cell naming several tasks: `WEB-1, WEB-2` or `WEB-1; WEB-2`. */
const splitRefs = (raw: string): string[] =>
  raw.split(/[,;]/).map((part) => part.trim()).filter(Boolean);

/**
 * The second pass: parents and blockers.
 *
 * A spreadsheet can only name a task in words — its key, or its title — and
 * neither exists as a row until the first pass has run. Anything that names
 * something outside the file is reported rather than guessed at: a parent link
 * to the wrong task is harder to notice than a missing one.
 */
function linkUp(
  made: { line: number; id: string; externalId: string; title: string; parent: string; blocks: string[]; blockedBy: string[] }[],
  result: ImportResult,
  options: ImportOptions,
): void {
  const byRef = new Map<string, string>();
  for (const row of made) {
    if (row.externalId) byRef.set(row.externalId.toLowerCase(), row.id);
    // A title is a weaker key than an identifier, so it never overwrites one.
    const title = row.title.toLowerCase();
    if (!byRef.has(title)) byRef.set(title, row.id);
  }

  const find = (ref: string): string | undefined => byRef.get(ref.trim().toLowerCase());

  for (const row of made) {
    if (row.parent) {
      const parent = find(row.parent);
      if (!parent) {
        result.problems.push({ row: row.line, message: `Nothing in this file is called "${row.parent}" — left without a parent` });
      } else if (parent === row.id) {
        result.problems.push({ row: row.line, message: 'A task cannot be its own parent — left without one' });
      } else {
        if (!options.dryRun) writeEntity('task', row.id, { parent_id: parent }, options.opts);
        result.linked++;
      }
    }

    for (const [kind, refs] of [['blocks', row.blocks], ['blocked_by', row.blockedBy]] as const) {
      for (const ref of refs) {
        const other = find(ref);
        if (!other || other === row.id) {
          result.problems.push({ row: row.line, message: `Nothing in this file is called "${ref}" — that link was not made` });
          continue;
        }
        // Stored one way round: `blocks` from the blocker to the blocked.
        const from = kind === 'blocks' ? row.id : other;
        const to = kind === 'blocks' ? other : row.id;
        if (!options.dryRun) {
          writeEntity('relation', uid(), {
            workspace_id: options.workspaceId, task_id: from, related_task_id: to, kind: 'blocks',
          }, options.opts);
        }
        result.linked++;
      }
    }
  }
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

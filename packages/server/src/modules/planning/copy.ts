/**
 * Copying a project.
 *
 * This is what "project template" means here: any project can be the template,
 * because a project that has been used for six months is a better description
 * of how a team works than a form somebody filled in once.
 *
 * The whole thing is one transaction on the server rather than a hundred writes
 * from a client. Copying is not an offline-first operation — half a project is
 * worse than none — and the identifiers, the ordering and the cross-references
 * between the copied rows all have to agree.
 */
import type { EntityName } from '@kolibri/shared';
import { all, get, tx, type Row } from '../../kernel/platform/db/index.ts';
import { badRequest, notFound } from '../../kernel/platform/http.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { createProject, serverClock } from '../../kernel/write-path/bootstrap.ts';
import { writeEntity } from '../../kernel/write-path/repo.ts';

export interface CopyOptions {
  name: string;
  key?: string;
  /** Sit the copy under a parent. */
  parentId?: string | null;
  teamId?: string | null;
  /** What to bring across beyond the structure. */
  include?: {
    /** Members of the source project. The person copying is always a lead. */
    members?: boolean;
    /** Templates and the rules that file them. */
    automations?: boolean;
    /** Pages, keeping the tree they were in. */
    pages?: boolean;
    /** Tasks, without their history: no comments, no time, no attachments. */
    tasks?: boolean;
    /** Tasks that are finished or cancelled. Only read when tasks are copied. */
    doneTasks?: boolean;
  };
}

export interface CopyReport {
  project: Row;
  counts: Record<string, number>;
}

/**
 * What is copied, in the order it has to happen for the references to resolve —
 * with the column each table is actually ordered by, since a label has no
 * position of its own.
 */
const STRUCTURE: [EntityName, string, string][] = [
  ['state', 'states', 'sort_order'],
  ['label', 'labels', 'created_at'],
  ['field', 'custom_fields', 'sort_order'],
];

export function copyProject(
  workspaceId: string,
  actorId: string,
  sourceId: string,
  options: CopyOptions,
): CopyReport {
  const source = get<Row>(`SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`, sourceId);
  if (!source || source.workspace_id !== workspaceId) throw notFound('Project not found');
  if (!options.name?.trim()) throw badRequest('The copy needs a name');

  const include = options.include ?? {};

  return tx(() => {
    const hlc = () => serverClock.now();
    const opts = () => ({ workspaceId, actorId, hlc: hlc(), system: true });
    const counts: Record<string, number> = {};
    const bump = (what: string) => { counts[what] = (counts[what] ?? 0) + 1; };

    // `withDefaults: false` — the states, types and labels come from the source,
    // and a copy that arrived with an extra set of English defaults on top would
    // be worse than useless.
    const project = createProject(workspaceId, actorId, {
      name: options.name.trim(),
      key: options.key,
      description: source.description ?? undefined,
      icon: source.icon ?? undefined,
      color: source.color ?? undefined,
      visibility: source.visibility as 'public' | 'private',
      teamId: options.teamId !== undefined ? options.teamId : source.team_id,
      withDefaults: false,
    });
    const projectId = String(project.id);
    if (options.parentId !== undefined) {
      writeEntity('project', projectId, { parent_id: options.parentId }, opts());
    }

    /** Old id → new id, for every row copied so far. */
    const map = new Map<string, string>();
    const mapped = (id: unknown): string | null => (id ? map.get(String(id)) ?? null : null);

    for (const [entity, table, order] of STRUCTURE) {
      for (const row of all<Row>(`SELECT * FROM ${table} WHERE project_id = ? AND deleted_at IS NULL ORDER BY ${order}`, sourceId)) {
        const id = uid();
        map.set(String(row.id), id);
        const { id: _id, created_at: _c, updated_at: _u, seq: _s, clocks: _k, deleted_at: _d, ...rest } = row;
        writeEntity(entity, id, { ...rest, project_id: projectId, workspace_id: workspaceId }, opts());
        bump(table);
      }
    }

    // The default state travelled as an id into the old project's list.
    if (source.default_state_id) {
      writeEntity('project', projectId, { default_state_id: mapped(source.default_state_id) }, opts());
    }

    if (include.members) {
      for (const row of all<Row>(`SELECT * FROM project_members WHERE project_id = ? AND deleted_at IS NULL`, sourceId)) {
        if (row.user_id === actorId) continue; // already a lead on the copy
        writeEntity('projectMember', uid(), {
          workspace_id: workspaceId, project_id: projectId, user_id: row.user_id, role: row.role,
        }, opts());
        bump('project_members');
      }
    }

    if (include.automations) {
      for (const row of all<Row>(`SELECT * FROM templates WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order`, sourceId)) {
        const id = uid();
        map.set(String(row.id), id);
        const { id: _i, created_at: _c, updated_at: _u, seq: _s, clocks: _k, deleted_at: _d, ...rest } = row;
        writeEntity('template', id, {
          ...rest,
          project_id: projectId,
          workspace_id: workspaceId,
          // A template that files into a *different* project keeps pointing
          // there on purpose; one that filed into this project follows the copy.
          target_project_id: row.target_project_id === sourceId ? projectId : row.target_project_id,
        }, opts());
        bump('templates');
      }
      for (const row of all<Row>(`SELECT * FROM automations WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order`, sourceId)) {
        const { id: _i, created_at: _c, updated_at: _u, seq: _s, clocks: _k, deleted_at: _d, ...rest } = row;
        writeEntity('automation', uid(), {
          ...rest,
          project_id: projectId,
          workspace_id: workspaceId,
          trigger_state_id: mapped(row.trigger_state_id),
          template_id: mapped(row.template_id),
        }, opts());
        bump('automations');
      }
    }

    if (include.pages) {
      // Parents before children, so a child's new parent id already exists.
      const pages = all<Row>(`SELECT * FROM pages WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order`, sourceId);
      for (const row of inTreeOrder(pages)) {
        const id = uid();
        map.set(String(row.id), id);
        const { id: _i, created_at: _c, updated_at: _u, seq: _s, clocks: _k, deleted_at: _d, ...rest } = row;
        writeEntity('page', id, {
          ...rest,
          project_id: projectId,
          workspace_id: workspaceId,
          parent_id: mapped(row.parent_id),
          created_by: actorId,
        }, opts());
        bump('pages');
      }
    }

    if (include.tasks) {
      const finished = new Set(
        all<Row>(`SELECT id FROM states WHERE project_id = ? AND group_key IN ('completed', 'cancelled')`, sourceId)
          .map((state) => String(state.id)),
      );
      const tasks = all<Row>(
        `SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY sort_order`,
        sourceId,
      ).filter((task) => include.doneTasks || !finished.has(String(task.state_id)));

      for (const row of inTreeOrder(tasks)) {
        const id = uid();
        map.set(String(row.id), id);
        const {
          id: _i, created_at: _c, updated_at: _u, seq: _s, clocks: _k, deleted_at: _d,
          number: _n, identifier: _ident, completed_at: _done, ...rest
        } = row;
        writeEntity('task', id, {
          ...rest,
          project_id: projectId,
          workspace_id: workspaceId,
          state_id: mapped(row.state_id),
          parent_id: mapped(row.parent_id),
          labels: remapList(row.labels, map),
          // A copy starts unscheduled: cycles and modules belong to the project
          // that ran them, and dragging last quarter's sprint along is noise.
          cycle_id: null,
          module_id: null,
          created_by: actorId,
        }, opts());
        bump('tasks');
      }

      // Relations, once both ends exist.
      for (const row of all<Row>(
        `SELECT r.* FROM task_relations r JOIN tasks t ON t.id = r.task_id
          WHERE t.project_id = ? AND r.deleted_at IS NULL`, sourceId,
      )) {
        const from = mapped(row.task_id);
        const to = mapped(row.related_task_id);
        if (!from || !to) continue; // one end was not copied
        writeEntity('relation', uid(), {
          workspace_id: workspaceId, task_id: from, related_task_id: to, kind: row.kind,
        }, opts());
        bump('relations');
      }

      // And the answers to the copied fields, for the copied tasks.
      for (const row of all<Row>(`SELECT * FROM field_values WHERE project_id = ? AND deleted_at IS NULL`, sourceId)) {
        const task = mapped(row.task_id);
        const field = mapped(row.field_id);
        if (!task || !field) continue;
        writeEntity('fieldValue', `${task}.${field}`, {
          workspace_id: workspaceId, project_id: projectId, task_id: task, field_id: field, value: row.value,
        }, opts());
        bump('field_values');
      }
    }

    return { project: get<Row>(`SELECT * FROM projects WHERE id = ?`, projectId)!, counts };
  });
}

/** Rows sorted so that every parent comes before its children. */
function inTreeOrder(rows: Row[]): Row[] {
  const byParent = new Map<string | null, Row[]>();
  const known = new Set(rows.map((row) => String(row.id)));
  for (const row of rows) {
    // A parent that is not in the set (archived, or in another project) is not a
    // parent here — the row is a root of this copy rather than an orphan.
    const parent = row.parent_id && known.has(String(row.parent_id)) ? String(row.parent_id) : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(row);
  }
  const out: Row[] = [];
  const walk = (parent: string | null): void => {
    for (const row of byParent.get(parent) ?? []) {
      out.push(row);
      walk(String(row.id));
    }
  };
  walk(null);
  return out;
}

/** A JSON list of ids, with each id put through the map. */
function remapList(raw: unknown, map: Map<string, string>): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => map.get(String(id))).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

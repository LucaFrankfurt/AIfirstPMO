/**
 * The rules a task, a project and the things hung off them live by.
 *
 * `guardTransition` goes through the `guards` hook for the same reason chat's
 * three do: a column can name the roles allowed to receive work, which is a
 * permission check and is skipped for the server's own writes.
 */

import { type ProjectVocabulary, relocate } from '@kolibri/shared';
import { all, get, type Row, run } from '../../db/index.ts';
import { badRequest, forbidden } from '../http.ts';
import { type EntityRule, parseIds, wouldLoop, writeEntity, type WriteOpts } from '../repo.ts';

const asId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const ROLE_RANK: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * Who may move a task into a column.
 *
 * A state can name the workspace roles allowed to receive work — "only a lead
 * marks something done". Empty means anybody who can write, which is every
 * column until somebody says otherwise. Checked here rather than in the
 * interface, because the interface is not the only way in: REST, MCP and a
 * phone that was offline all come through this function.
 *
 * Rules never apply to the server's own writes: an automation, an import or a
 * recurrence rolling a task forward is not a person moving a card.
 */
function guardTransition(stateId: string, opts: WriteOpts): void {
  const state = get<Row>(`SELECT name, allowed_roles FROM states WHERE id = ?`, stateId);
  if (!state) return;
  let allowed: string[] = [];
  try {
    const parsed = JSON.parse(String(state.allowed_roles ?? '[]'));
    if (Array.isArray(parsed)) allowed = parsed.map(String);
  } catch { /* a column with an unreadable rule is a column with no rule */ }
  if (!allowed.length) return;

  const role = get<Row>(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    opts.workspaceId, opts.actorId,
  )?.role as string | undefined;
  // A role that outranks every role named is allowed: naming "member" and
  // meaning "and not an owner" is not what anybody writes down.
  const bar = Math.min(...allowed.map((name) => ROLE_RANK[name] ?? 99));
  if (role && (allowed.includes(role) || (ROLE_RANK[role] ?? -1) >= bar)) return;

  throw forbidden(`Only ${allowed.join(' or ')} may move work into “${state.name}”`);
}
function applyTaskInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  const stateId = (values.state_id ?? existing?.state_id) as string | undefined;
  if (values.state_id !== undefined && stateId) {
    const state = get<{ group_key: string }>(`SELECT group_key FROM states WHERE id = ?`, stateId);
    const done = state?.group_key === 'completed' || state?.group_key === 'cancelled';
    const wasDone = existing?.completed_at != null;
    if (done && !wasDone) {
      values.completed_at = Date.now();
      forced.completed_at = values.completed_at;
    } else if (!done && wasDone) {
      values.completed_at = null;
      forced.completed_at = null;
    }
  }
}
/**
 * What a project offers, read out of SQLite.
 *
 * The mirror image of the interface's own reader — the rule that consumes this
 * is one shared function, so the two cannot drift apart about what "the same
 * column in another project" means.
 */
function vocabularyOf(projectId: string): ProjectVocabulary {
  return {
    states: all<Row>(
      `SELECT id, group_key, sort_order FROM states WHERE project_id = ? AND deleted_at IS NULL`, projectId,
    ).map((row) => ({ id: String(row.id), group_key: row.group_key as never, sort_order: String(row.sort_order ?? '') })),
    labels: all<Row>(
      `SELECT id, name FROM labels WHERE project_id = ? AND deleted_at IS NULL`, projectId,
    ).map((row) => ({ id: String(row.id), name: String(row.name ?? '') })),
    defaultStateId: asId(get<Row>(`SELECT default_state_id FROM projects WHERE id = ?`, projectId)?.default_state_id),
  };
}
/**
 * A field that is gone takes its answers with it.
 *
 * Tombstones rather than a `DELETE`, because every other device has those rows
 * too and only a tombstone tells them. Written through the same path, so they
 * get a sequence number and reach the clients on the next pull.
 */
function tombstoneValuesOf(field: Row, opts: WriteOpts): void {
  const values = all<Row>(`SELECT id FROM field_values WHERE field_id = ? AND deleted_at IS NULL`, field.id);
  for (const value of values) {
    writeEntity('fieldValue', String(value.id), {}, { ...opts, op: 'delete', system: true, silent: true });
  }
}



export const workRules = {
  entities: ['task', 'project', 'comment', 'attachment', 'view', 'field'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'task') {
      const project = get<Row>(`SELECT * FROM projects WHERE id = ?`, values.project_id);
      if (!project) throw badRequest('task.project_id must reference an existing project');
      if (project.workspace_id !== opts.workspaceId) throw badRequest('project belongs to another workspace');
      if (values.number === undefined || values.identifier === undefined) {
        const number = Number(project.next_number ?? 1);
        run(`UPDATE projects SET next_number = ? WHERE id = ?`, number + 1, project.id);
        setForced('number', number);
        setForced('identifier', `${project.key}-${number}`);
      }
      if (!values.state_id) {
        const fallback = project.default_state_id
          ?? get<Row>(`SELECT id FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, project.id)?.id;
        if (fallback) setForced('state_id', fallback);
      }
      if (!values.created_by) setForced('created_by', opts.actorId);
      if (!values.sort_order) setForced('sort_order', 'V');
      if (!values.subscribers) values.subscribers = JSON.stringify([opts.actorId]);
    }
    if (entity === 'comment' && !values.author_id) setForced('author_id', opts.actorId);
    if (entity === 'attachment' && !values.uploaded_by) setForced('uploaded_by', opts.actorId);
    if (entity === 'view' && !values.owner_id) setForced('owner_id', opts.actorId);
    if (entity === 'project') {
      if (!values.key) setForced('key', `P${id.slice(0, 4).toUpperCase()}`);
      if (!values.name) setForced('name', 'Untitled project');
    }
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'task' && values.state_id !== undefined) guardTransition(String(values.state_id), opts);
  },
  invariants(entity, id, values, existing, forced, opts) {
    /**
     * A sub-task cannot sit under itself, directly or at any remove.
     *
     * Nothing could build one until the parent became a field a person can set:
     * sub-tasks were only ever created *under* something. Now that it can be
     * chosen, `A → B → A` is two clicks away, and a tree that loops is not a tree
     * — the breadcrumb above the title walks it, and so does anything that ever
     * rolls a child up into its parent.
     *
     * Refused the way a project loop is: the old value comes back through
     * `forced` rather than thrown, because this write may be one row of a batch
     * from a device that has been away.
     */
    if (entity === 'task' && values.parent_id !== undefined && existing) {
      const wanted = values.parent_id as string | null;
      if (wanted === existing.id || wouldLoop('tasks', String(existing.id), wanted)) {
        values.parent_id = existing.parent_id ?? null;
        forced.parent_id = values.parent_id;
      }
    }
    /**
     * A task that changed projects, and everything on it that belonged to the old
     * one.
     *
     * The interface performs the move itself so the board reacts without a round
     * trip; this is the same rule applied where the interface is not the caller —
     * a `PATCH {project_id}` over REST, an MCP call, an import, an automation,
     * any of which would otherwise leave the row in a column its new board does
     * not have and wearing labels nothing can render.
     *
     * Each field is checked rather than overwritten, so a client that already did
     * the work is left alone and only what is actually wrong comes back `forced`.
     */
    if (entity === 'task' && existing && typeof values.project_id === 'string'
        && values.project_id !== existing.project_id) {
      const destination = values.project_id;
      const landing = relocate(
        {
          state_id: asId(existing.state_id),
          labels: parseIds(existing.labels),
          cycle_id: asId(existing.cycle_id),
          module_id: asId(existing.module_id),
        },
        vocabularyOf(String(existing.project_id)),
        vocabularyOf(destination),
      );
      const effective = (field: string): unknown => (values[field] !== undefined ? values[field] : existing[field]);
      const belongs = (table: 'states' | 'labels', value: unknown): boolean =>
        typeof value === 'string' && !!get<Row>(
          `SELECT 1 AS found FROM ${table} WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
          value, destination,
        );

      /**
       * The same question for a cycle or a module, which are not one project's.
       *
       * Both may cover several projects or all of them, so `project_id = ?` is
       * the wrong test: a shared fortnight has no owner at all, so a task moved
       * from Web to Mobile *inside that fortnight* failed the check and was
       * silently dropped out of it. Nobody would have attributed that to the
       * move. `coversProject` is the rule in TypeScript; this is it in SQL.
       */
      const covers = (table: 'cycles' | 'modules', value: unknown): boolean =>
        typeof value === 'string' && !!get<Row>(
          `SELECT 1 AS found FROM ${table}
            WHERE id = ? AND deleted_at IS NULL
              AND ((json_array_length(projects) = 0 AND (project_id IS NULL OR project_id = ?))
                   OR EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value = ?))`,
          value, destination, destination,
        );
      const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };

      if (!belongs('states', effective('state_id'))) settle('state_id', landing.state_id);
      if (parseIds(effective('labels')).some((label) => !belongs('labels', label))) {
        settle('labels', JSON.stringify(landing.labels));
      }
      // Cleared only when the destination really is outside them — a shared one
      // follows the task across, which is the whole point of it being shared.
      if (asId(effective('cycle_id')) && !covers('cycles', effective('cycle_id'))) settle('cycle_id', null);
      if (asId(effective('module_id')) && !covers('modules', effective('module_id'))) settle('module_id', null);
    }
    // A project cannot sit under itself, directly or at any remove. Two devices
    // can each make a legal move that is a loop together, so this is checked on
    // write rather than trusted to the interface.
    if (entity === 'project' && values.parent_id !== undefined && existing) {
      if (wouldLoop('projects', String(existing.id), values.parent_id as string | null)) {
        values.parent_id = existing.parent_id ?? null;
        forced.parent_id = values.parent_id;
      }
    }
    /**
     * A container holds projects, not tasks — so one with tasks in it cannot
     * become a container.
     *
     * Refused rather than obeyed, because the alternative is a screen with no
     * board on it and work behind it that nobody can reach. `forced` is how the
     * client is told: the value it sent comes back changed, and the interface
     * says why. Turning a container back into an ordinary project is always
     * allowed — there is nothing to hide.
     */
    if (entity === 'project' && Number(values.is_container ?? 0) === 1 && existing) {
      const open = get<Row>(
        `SELECT 1 AS found FROM tasks WHERE project_id = ? AND deleted_at IS NULL LIMIT 1`,
        existing.id,
      );
      if (open) {
        values.is_container = existing.is_container ?? 0;
        forced.is_container = values.is_container;
      }
    }
    /**
     * One key, one project.
     *
     * A key is the prefix of every identifier a project mints, so two projects
     * holding `WEB` make `WEB-42` name two tasks — and the client resolving a
     * pasted identifier takes whichever it finds first. It became reachable when
     * the settings screen learned to change a key that until then could only be
     * chosen once.
     *
     * Refused the way a container is: the old value comes back through `forced`
     * rather than thrown, because this write may be one row in a sync push from a
     * device that has been offline, and one bad key should not take the batch
     * down with it. The screen checks as you type and says which project has it,
     * so the bounce is the backstop rather than the explanation.
     *
     * Upper-cased on the way in whatever was typed: `web` and `WEB` are one
     * prefix, and storing both would be storing the collision.
     */
    if (entity === 'project' && typeof values.key === 'string') {
      const wanted = values.key.trim().toUpperCase();
      // `existing` on an update, the incoming row on a create — this runs on both.
      const workspace = (existing?.workspace_id ?? values.workspace_id) as string | undefined;
      const taken = wanted && workspace ? get<Row>(
        `SELECT name FROM projects
          WHERE workspace_id = ? AND id != ? AND deleted_at IS NULL AND UPPER(key) = ?`,
        workspace, id, wanted,
      ) : undefined;
      const settled = !wanted || taken ? (existing?.key as string | undefined) ?? values.key : wanted;
      if (settled !== values.key) {
        values.key = settled;
        forced.key = settled;
      }
    }
    if (entity === 'task') applyTaskInvariants(values, existing, forced);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'field' && row.deleted_at && !before?.deleted_at) tombstoneValuesOf(row, opts);
  },
} satisfies EntityRule;

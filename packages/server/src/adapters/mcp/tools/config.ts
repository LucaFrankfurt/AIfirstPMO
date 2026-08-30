/**
 * The vocabulary a project is described in: its states and its labels.
 */
import { orderKey, STATE_GROUPS } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { colour, findLabel, findProject, findState, labelView, McpError, requireWrite, stateGroup, stateView, str, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

export const configTools: ToolDef[] = [
  {
    /**
     * The states a project actually has, before something is put into one.
     *
     * The two writers treat an unknown state name differently, and this list
     * is how to avoid finding out which. `create_task` falls back silently to
     * the project's default column, so a misspelled state files the task
     * somewhere unintended and reports success. `update_task` refuses with an
     * error. (An earlier version of this text claimed both fell back — wrong,
     * and worth being precise about here of all places, because this
     * description ships into every client's tool listing and is what an
     * assistant believes over the code.)
     *
     * `group_key` is the part worth reading rather than the name. Every project
     * may name its columns whatever it likes; the group is the fixed vocabulary
     * underneath — backlog, unstarted, started, completed, cancelled — and it is
     * what every count and filter in Kolibri is actually computed from. Match on
     * that when the name is not an exact hit.
     */
    name: 'list_states',
    title: 'List workflow states',
    description: "A project's workflow states in board order, with the group each belongs to and how many open tasks sit in it. Read this before setting a state: names are per project, and create_task silently falls back to the default column on a name it does not recognise (update_task refuses instead).",
    readOnly: true,
    schema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', description: 'Project id, key or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = findProject(String(args.project), workspaceId, ctx);
      const rows = all<Row>(
        `SELECT * FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
        project.id,
      );
      // Where a stateless create lands: the server prefers the project's own
      // `default_state_id` and only then the first in board order
      // (`applyCreateDefaults` in repo.ts). Mirrored verbatim — including the
      // stale case, where a default pointing at a deleted state means no row
      // here is the default, which is also exactly what the server would do.
      const lands = project.default_state_id ?? rows[0]?.id;
      return rows.map((state) => ({
        ...stateView(state),
        is_default: state.id === lands,
        tasks: Number(get<Row>(
          `SELECT count(*) c FROM tasks WHERE state_id = ? AND deleted_at IS NULL AND archived = 0`,
          state.id,
        )?.c ?? 0),
      }));
    },
  },
  {
    /**
     * Add a column to a project's board.
     *
     * Appended at the end, which is where the interface puts one too — a new
     * column arriving in the middle of somebody's board would move every card
     * to the right of it while they were looking at it.
     */
    name: 'create_state',
    title: 'Create workflow state',
    description: 'Add a workflow state (Kanban column) to a project. It is appended after the existing columns.',
    schema: {
      type: 'object',
      required: ['project', 'name', 'group'],
      properties: {
        project: { type: 'string', description: 'Project id, key or name' },
        name: { type: 'string', description: 'What the column is called, e.g. "In QA"' },
        group: {
          type: 'string',
          enum: [...STATE_GROUPS],
          description: 'Which of the five categories this column counts as. Everything Kolibri counts as finished is `completed` or `cancelled`.',
        },
        color: { type: 'string', description: 'Hex, e.g. #3b82f6' },
        wip_limit: { type: 'integer', minimum: 0, maximum: 99, description: 'Warn above this many tasks; 0 for no limit' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = findProject(String(args.project), workspaceId, ctx);
      const name = str(args.name);
      if (!name) throw new McpError('A state needs a name');

      // Two columns with one name is a board where "move it to Review" has two
      // answers, and the caller cannot tell which one it got.
      const clash = get<Row>(
        `SELECT name FROM states WHERE project_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)`,
        project.id, name,
      );
      if (clash) throw new McpError(`${project.key} already has a state called "${clash.name}"`);

      const last = get<Row>(
        `SELECT sort_order FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order DESC LIMIT 1`,
        project.id,
      );
      const { row } = writeEntity('state', uid(), {
        workspace_id: workspaceId,
        project_id: project.id,
        name,
        group_key: stateGroup(args.group, true),
        color: colour(args.color) ?? '#64748b',
        wip_limit: typeof args.wip_limit === 'number' ? Math.max(0, Math.min(99, Math.round(args.wip_limit))) : 0,
        sort_order: orderKey(last?.sort_order ?? null, null),
      }, writeOpts(workspaceId, ctx));

      return stateView(row);
    },
  },
  {
    /**
     * Rename a column, recolour it, or change what it counts as.
     *
     * Changing the group is the consequential one and is worth being deliberate
     * about: it does not move any task, but it changes what every count in the
     * app says about the tasks already sitting there. Moving a column from
     * `started` to `completed` marks that work finished everywhere at once —
     * the project digest, the cycle burn-down, the label counts, `my_work`.
     */
    name: 'update_state',
    title: 'Update workflow state',
    description: "Change a workflow state's name, colour, group or WIP limit. Changing the group does not move any task, but it changes what every count in Kolibri says about the tasks already in that column.",
    schema: {
      type: 'object',
      required: ['state_id'],
      properties: {
        state_id: { type: 'string', description: 'From list_states' },
        name: { type: 'string' },
        color: { type: 'string', description: 'Hex, e.g. #3b82f6' },
        group: { type: 'string', enum: [...STATE_GROUPS] },
        wip_limit: { type: 'integer', minimum: 0, maximum: 99 },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const state = findState(String(args.state_id), workspaceId, ctx);

      const patch: Record<string, unknown> = {};
      const name = str(args.name);
      if (name) {
        const clash = get<Row>(
          `SELECT name FROM states WHERE project_id = ? AND id != ? AND deleted_at IS NULL AND lower(name) = lower(?)`,
          state.project_id, state.id, name,
        );
        if (clash) throw new McpError(`That project already has a state called "${clash.name}"`);
        patch.name = name;
      }
      const tint = colour(args.color);
      if (tint) patch.color = tint;
      const group = stateGroup(args.group, false);
      if (group) patch.group_key = group;
      if (typeof args.wip_limit === 'number') patch.wip_limit = Math.max(0, Math.min(99, Math.round(args.wip_limit)));
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — pass name, color, group or wip_limit');

      const { row } = writeEntity('state', String(state.id), patch, writeOpts(workspaceId, ctx));
      return stateView(row);
    },
  },
  {
    /**
     * What this workspace calls things.
     *
     * The missing half of label support over MCP: `create_task` has always
     * taken label *names* and created the ones it did not recognise, which
     * without a way to see the list means an assistant inventing `bugs`
     * alongside the `bug` that was already there. Case is already forgiven;
     * a plural is not, and nothing but this list can prevent it.
     *
     * The count is here for the same reason it is on `list_members`: a label
     * used twice in a year and a label used on half the backlog are different
     * things, and only one number tells them apart.
     */
    name: 'list_labels',
    title: 'List labels',
    description: 'Labels in the workspace, with how many open tasks carry each. Use before setting labels on a task, so an existing one is reused rather than a near-duplicate created.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only labels usable in this project — its own, plus the workspace-wide ones' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : undefined;
      const rows = project
        ? all<Row>(
          `SELECT * FROM labels WHERE workspace_id = ? AND deleted_at IS NULL
             AND (project_id IS NULL OR project_id = ?) ORDER BY name`,
          workspaceId, project.id,
        )
        : all<Row>(`SELECT * FROM labels WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name`, workspaceId);

      return rows.map((label) => ({
        id: String(label.id),
        name: String(label.name),
        color: label.color ?? null,
        description: label.description ?? null,
        // Null rather than a project id means every project here may use it.
        project_id: label.project_id ?? null,
        open_tasks: Number(get<Row>(
          `SELECT count(*) c FROM tasks t LEFT JOIN states s ON s.id = t.state_id
            WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND t.archived = 0
              AND (s.group_key IS NULL OR s.group_key NOT IN ('completed','cancelled'))
              AND EXISTS (SELECT 1 FROM json_each(t.labels) WHERE json_each.value = ?)`,
          workspaceId, label.id,
        )?.c ?? 0),
      }));
    },
  },
  {
    /**
     * Make a label deliberately, rather than by mentioning it.
     *
     * `create_task` already invents a label it does not recognise, which is
     * what makes `bugs` appear next to `bug`. This is the other half: a label
     * made on purpose, with a colour and a description, and **refused if one
     * by that name already exists in scope** — which is exactly the collision
     * the accidental path cannot see.
     *
     * Scope matters and is easy to get wrong. A label with no project is
     * usable by every project in the workspace; one with a project belongs to
     * that project alone. A workspace-wide `bug` and a project-local `bug` are
     * two labels that look identical on a task, so the check covers both.
     */
    name: 'create_label',
    title: 'Create label',
    description: 'Create a label with a colour. Workspace-wide unless `project` is given. Refused if a label by that name is already usable in that scope — call list_labels first.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        color: { type: 'string', description: 'Hex, e.g. #3b82f6' },
        description: { type: 'string' },
        project: { type: 'string', description: 'Project id, key or name. Omit for a label every project can use.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const name = str(args.name);
      if (!name) throw new McpError('A label needs a name');
      const project = str(args.project) ? findProject(String(args.project), workspaceId, ctx) : null;

      /*
       * Anything the new label would collide with, in either direction.
       *
       * Scoped to a project, it collides with that project's own labels and
       * the workspace-wide ones — the set `create_task` matches against.
       * Workspace-wide, it collides with *every* label of that name, because
       * it would become usable in whichever project already has one — the
       * first version checked only other workspace-wide labels, and let a
       * global `bug` be created over a project's `bug`, putting two
       * indistinguishable chips on that project's tasks.
       */
      const clash = project
        ? get<Row>(
          `SELECT name, project_id FROM labels
            WHERE workspace_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
              AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
          workspaceId, name, project.id,
        )
        : get<Row>(
          `SELECT name, project_id FROM labels
            WHERE workspace_id = ? AND deleted_at IS NULL AND lower(name) = lower(?) LIMIT 1`,
          workspaceId, name,
        );
      if (clash) {
        throw new McpError(
          `A label called "${clash.name}" already exists${clash.project_id ? ' in a project this one would cover' : ' workspace-wide'} — use update_label, or a different name`,
        );
      }

      // The colour column is NOT NULL with a default; an explicit null defeats
      // the default and the insert fails with a raw constraint error. Omitted,
      // the default applies — which is what the accidental path
      // (resolveLabels) has done all along.
      const tint = colour(args.color);
      const { row } = writeEntity('label', uid(), {
        workspace_id: workspaceId,
        project_id: project?.id ?? null,
        name,
        ...(tint ? { color: tint } : {}),
        description: str(args.description) ?? null,
      }, writeOpts(workspaceId, ctx));
      return labelView(row);
    },
  },
  {
    /**
     * Rename a label, recolour it, or move it between scopes.
     *
     * Addressed by id or by name — an assistant that has just read
     * `list_labels` has both, and a name is what it will have if it read the
     * task instead.
     *
     * Widening a project label to the whole workspace is allowed; narrowing a
     * workspace-wide one to a single project is not, because the tasks in every
     * *other* project that already carry it would keep a label they are no
     * longer allowed to have. Deleting it deliberately is a different act with
     * a different tool, and this one should not do it by implication.
     */
    name: 'update_label',
    title: 'Update label',
    description: "Change a label's name, colour or description, or widen a project label to the whole workspace.",
    schema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string', description: 'Label id, or its current name' },
        name: { type: 'string', description: 'A new name' },
        color: { type: 'string', description: 'Hex, e.g. #3b82f6' },
        description: { type: 'string' },
        workspace_wide: { type: 'boolean', description: 'Detach from its project so every project may use it' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const label = findLabel(String(args.label), workspaceId);

      const patch: Record<string, unknown> = {};
      const name = str(args.name);
      if (name) patch.name = name;

      /*
       * The clash check runs against where the label is *going* — its final
       * name in its final scope — because a rename and a widening can arrive in
       * one call, and each changes what the other collides with. A
       * workspace-wide destination collides with every label of that name; a
       * project one with its project's own plus the workspace-wide set.
       */
      if (name || args.workspace_wide === true) {
        const finalName = name ?? String(label.name);
        const finalProject = args.workspace_wide === true ? null : label.project_id ?? null;
        const clash = finalProject === null
          ? get<Row>(
            `SELECT name FROM labels WHERE workspace_id = ? AND id != ? AND deleted_at IS NULL AND lower(name) = lower(?) LIMIT 1`,
            workspaceId, label.id, finalName,
          )
          : get<Row>(
            `SELECT name FROM labels WHERE workspace_id = ? AND id != ? AND deleted_at IS NULL AND lower(name) = lower(?)
              AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
            workspaceId, label.id, finalName, finalProject,
          );
        if (clash) throw new McpError(`A label called "${clash.name}" is already usable there`);
      }
      const tint = colour(args.color);
      if (tint) patch.color = tint;
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (args.workspace_wide === true) patch.project_id = null;
      if (args.workspace_wide === false && !label.project_id) {
        throw new McpError('A workspace-wide label cannot be narrowed to one project — the tasks in the others already carry it');
      }
      if (!Object.keys(patch).length) {
        throw new McpError('Nothing to change — pass name, color, description or workspace_wide');
      }

      const { row } = writeEntity('label', String(label.id), patch, writeOpts(workspaceId, ctx));
      return labelView(row);
    },
  },
];

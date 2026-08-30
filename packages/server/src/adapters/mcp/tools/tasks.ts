/**
 * The backlog: reading it, filing into it, and moving things through it.
 */
import { PRIORITIES, readFieldValue, RELATION_KINDS, type RelationKind } from '@kolibri/shared';
import { all, get, type Row, tx } from '../../../kernel/platform/db/index.ts';
import { deleteEntity, visibleProjectIds, withEffectsHeld, writeEntity } from '../../../kernel/write-path/repo.ts';
import { searchWorkspace } from '../../../kernel/search/search.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { blockingLoop, fileTask, findModule, findProject, findTask, INVERSE_RELATION, isoDay, McpError, requireWrite, resolveCycle, resolveLabels, resolveState, resolveUsers, str, taskView, type ToolDef, workspaceOf, writeCustomFields, writeOpts } from '../kit.ts';

export const taskTools: ToolDef[] = [
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'Query tasks by project, state, state group, assignee, priority, cycle, module, label or free text.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        project: { type: 'string', description: 'Project id, key or name' },
        state: { type: 'string', description: 'State name or group: backlog, unstarted, started, completed, cancelled' },
        assignee: { type: 'string', description: 'User id, email or name; use "me" for the token owner' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        cycle: { type: 'string', description: 'Cycle id or name, or "current"' },
        module: { type: 'string', description: 'Module id or name' },
        label: {
          type: 'string',
          description: 'Label id or name — use list_labels to see what exists. Matched across the workspace, so a per-project label of the same name is found too.',
        },
        query: { type: 'string', description: 'Full-text filter' },
        due_before: { type: 'string', description: 'ISO date' },
        limit: { type: 'number', default: 50 },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const where = ['t.workspace_id = ?', 't.deleted_at IS NULL', 't.archived = 0'];
      const params: unknown[] = [workspaceId];
      let project: Row | undefined;

      if (args.project) {
        project = findProject(String(args.project), workspaceId, ctx);
        where.push('t.project_id = ?');
        params.push(project.id);
      }
      if (args.state) {
        const state = project ? resolveState(project.id, String(args.state)) : undefined;
        if (state) {
          where.push('t.state_id = ?');
          params.push(state.id);
        } else {
          where.push(`EXISTS (SELECT 1 FROM states s WHERE s.id = t.state_id AND (s.group_key = lower(?) OR lower(s.name) = lower(?)))`);
          params.push(String(args.state), String(args.state));
        }
      }
      if (args.assignee) {
        const userId = args.assignee === 'me' ? ctx.auth.userId : resolveUsers(workspaceId, [args.assignee])[0];
        if (!userId) throw new McpError(`Unknown assignee ${args.assignee}`);
        where.push(`EXISTS (SELECT 1 FROM json_each(t.assignees) WHERE json_each.value = ?)`);
        params.push(userId);
      }
      if (args.priority) {
        where.push('t.priority = ?');
        params.push(String(args.priority));
      }
      if (args.due_before) {
        where.push('t.due_date IS NOT NULL AND t.due_date <= ?');
        params.push(String(args.due_before));
      }
      if (args.label) {
        // Advertised by this tool's own description since it was written, and
        // never implemented: an assistant passed `label` and got an unfiltered
        // list back, described as filtered. By name across the workspace, like
        // `type` above — "show me the bugs" should not need the id of each
        // project's own `bug` row.
        const ids = all<Row>(
          `SELECT id FROM labels WHERE workspace_id = ? AND deleted_at IS NULL AND (id = ? OR lower(name) = lower(?))`,
          workspaceId, String(args.label), String(args.label),
        ).map((row) => String(row.id));
        if (!ids.length) throw new McpError(`No label in this workspace is called "${args.label}" — list_labels shows what there is`);
        where.push(`EXISTS (SELECT 1 FROM json_each(t.labels) WHERE json_each.value IN (${ids.map(() => '?').join(', ')}))`);
        params.push(...ids);
      }
      if (args.cycle) {
        const cycle = args.cycle === 'current'
          ? get<Row>(`SELECT * FROM cycles WHERE workspace_id = ? AND deleted_at IS NULL AND start_date <= date('now') AND end_date >= date('now') ORDER BY start_date DESC LIMIT 1`, workspaceId)
          : get<Row>(`SELECT * FROM cycles WHERE workspace_id = ? AND (id = ? OR lower(name) = lower(?)) AND deleted_at IS NULL`, workspaceId, args.cycle, args.cycle);
        if (!cycle) throw new McpError(`Cycle ${args.cycle} not found`);
        where.push('t.cycle_id = ?');
        params.push(cycle.id);
      }
      if (args.module) {
        // `findModule` rather than a lookup that can miss: a name nobody
        // recognises would otherwise filter nothing and answer with the whole
        // backlog, which reads as "no tasks are in that milestone".
        where.push('t.module_id = ?');
        params.push(findModule(String(args.module), workspaceId, ctx).id);
      }
      if (args.query) {
        const hits = searchWorkspace(workspaceId, ctx.auth.userId, String(args.query), 200, ['task']);
        if (!hits.length) return [];
        where.push(`t.id IN (${hits.map(() => '?').join(',')})`);
        params.push(...hits.map((h) => h.id));
      }

      const limit = Math.min(Number(args.limit ?? 50) || 50, 200);
      const visible = visibleProjectIds(ctx.auth.userId, workspaceId);
      return all<Row>(
        `SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC LIMIT ?`,
        ...params, limit,
      ).filter((t) => visible.has(t.project_id)).map(taskView);
    },
  },
  {
    name: 'get_task',
    title: 'Get task',
    description: 'Full detail for one task: description, comments, sub-tasks, relations and recent activity.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['task'],
      properties: { task: { type: 'string', description: 'Task id or identifier like KOL-42' }, workspace_id: { type: 'string' } },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const task = findTask(String(args.task), workspaceId, ctx);
      return {
        ...taskView(task),
        description: task.description,
        created_at: task.created_at,
        completed_at: task.completed_at,
        project: get<Row>(`SELECT id, key, name FROM projects WHERE id = ?`, task.project_id),
        fields: all<Row>(
          `SELECT f.id, f.name, f.kind, v.value
             FROM custom_fields f
             LEFT JOIN field_values v ON v.field_id = f.id AND v.task_id = ? AND v.deleted_at IS NULL
            WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.archived = 0
            ORDER BY f.sort_order`,
          task.id, task.project_id,
        )
          .map((field) => ({ name: field.name, kind: field.kind, value: readFieldValue(field.kind, field.value) })),
        subtasks: all<Row>(`SELECT * FROM tasks WHERE parent_id = ? AND deleted_at IS NULL`, task.id).map(taskView),
        relations: all<Row>(
          `SELECT r.kind, t.id, t.identifier, t.title FROM task_relations r JOIN tasks t ON t.id = r.related_task_id
            WHERE r.task_id = ? AND r.deleted_at IS NULL`, task.id,
        ),
        comments: all<Row>(
          `SELECT c.id, c.body, c.created_at, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.author_id
            WHERE c.task_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at`, task.id,
        ),
        activity: all<Row>(
          `SELECT verb, field, old_value, new_value, created_at, actor_id FROM activities
            WHERE task_id = ? ORDER BY created_at DESC LIMIT 20`, task.id,
        ),
      };
    },
  },
  {
    name: 'create_task',
    title: 'Create task',
    description: 'File a new task. Returns the created task including its identifier.',
    schema: {
      // Neither is required on its own: `quick_add` can carry both the title
      // and — through `#KEY` — the project. One of the two has to say which.
      type: 'object',
      required: [],
      properties: {
        project: { type: 'string', description: 'Project id, key or name. Required unless quick_add names one with #KEY' },
        title: { type: 'string', description: 'Required unless quick_add is given' },
        /**
         * Opt-in, and deliberately not applied to `title` on its own.
         *
         * A tool with a schema should mean what the schema says: an assistant
         * that writes "Discuss with @ada" as a title means those words, and a
         * parser that quietly removed them and assigned the task would be a
         * surprise nobody asked for. This is for the other case — relaying a
         * line a person actually typed, sigils and all.
         */
        quick_add: {
          type: 'string',
          description: 'A one-line task in quick-add syntax, e.g. "Redraw the empty state !high @ada #WEB *design due:friday". Overrides title, priority, assignees, labels and due_date where it names them. Use `title` for an ordinary title, even one containing @ or #.',
        },
        description: { type: 'string', description: 'Markdown' },
        state: { type: 'string' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        assignees: { type: 'array', items: { type: 'string' }, description: 'User ids, emails or names' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names; unknown ones are created' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        estimate: { type: 'number' },
        parent: { type: 'string', description: 'Parent task id or identifier' },
        cycle: { type: 'string' },
        module: { type: 'string', description: 'Module id or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      return taskView(fileTask(args, workspaceId, ctx, str(args.project)));
    },
  },
  {
    /**
     * File many tasks in one call.
     *
     * The point is not the round trips — it is that a plan arrives as a plan.
     * Twenty separate `create_task` calls can fail on the eleventh and leave
     * ten tasks behind that nobody asked for on their own, and an assistant
     * that then retries the whole list makes ten more. So the whole batch is
     * one transaction: every task or none.
     *
     * Each entry takes what `create_task` takes, through the same code, so a
     * batch cannot quietly follow different rules from a single call. `project`
     * names the project once; an entry may still override it, which is how one
     * call files a feature into WEB and its infrastructure work into OPS.
     */
    name: 'create_tasks_batch',
    title: 'Create several tasks',
    description: 'File a list of tasks in one call, as one transaction — if any entry is rejected, none of them are created. Each entry takes the same fields as create_task. Use this for a plan or a checklist rather than calling create_task repeatedly.',
    schema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        project: { type: 'string', description: 'Project for every task that does not name its own' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Up to 100. Each entry takes the fields create_task takes.',
          items: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Overrides the call-level project' },
              title: { type: 'string' },
              quick_add: { type: 'string', description: 'One-line quick-add syntax; see create_task' },
              description: { type: 'string' },
              state: { type: 'string' },
              priority: { type: 'string', enum: [...PRIORITIES] },
              assignees: { type: 'array', items: { type: 'string' } },
              labels: { type: 'array', items: { type: 'string' } },
              due_date: { type: 'string', description: 'YYYY-MM-DD' },
              estimate: { type: 'number' },
              parent: { type: 'string', description: 'Parent task id or identifier' },
              cycle: { type: 'string' },
              module: { type: 'string' },
            },
          },
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const entries = Array.isArray(args.tasks) ? args.tasks : null;
      if (!entries?.length) throw new McpError('`tasks` must be a non-empty array', -32602);
      // A cap rather than a stream. Everything here is one synchronous
      // transaction, and a runaway list would hold the write lock for as long
      // as it took — with the rest of the workspace waiting behind it.
      if (entries.length > 100) {
        throw new McpError(`${entries.length} tasks in one call is too many — 100 at a time`, -32602);
      }

      const fallback = str(args.project);
      // `tx` rolls back on a throw, so a rejected entry takes the whole batch
      // with it — and `withEffectsHeld` extends that promise to the effects a
      // rollback cannot reach: webhooks and pushes for the early entries wait
      // for the commit, instead of announcing tasks that end up never existing.
      const order = new Map<string, { prev: string | null; bound: string | null }>();
      const rows = withEffectsHeld(() => tx(() => entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          throw new McpError(`tasks[${index}] is not an object`, -32602);
        }
        try {
          return fileTask(entry as Record<string, any>, workspaceId, ctx, fallback, order);
        } catch (error) {
          // Which one failed, out of a hundred. Without the index this reads
          // as "a task needs a title" against a list nobody can point at.
          const detail = error instanceof Error ? error.message : String(error);
          throw new McpError(`tasks[${index}]: ${detail}`, error instanceof McpError ? error.code : -32602);
        }
      })));

      return { created: rows.length, tasks: rows.map(taskView) };
    },
  },
  {
    name: 'update_task',
    title: 'Update task',
    description: 'Change any field of a task: title, description, state, priority, assignees, dates, cycle, module, parent.',
    schema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        state: { type: 'string' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        assignees: { type: 'array', items: { type: 'string' } },
        labels: { type: 'array', items: { type: 'string' } },
        due_date: { type: ['string', 'null'] },
        start_date: { type: ['string', 'null'] },
        estimate: { type: ['number', 'null'] },
        cycle: { type: ['string', 'null'] },
        module: { type: ['string', 'null'], description: 'Module id or name, or null to take it out of one' },
        archived: { type: 'boolean' },
        fields: {
          type: 'object',
          description: "The project's own fields, by name — e.g. {\"Severity\": \"Major\"}. Null clears one.",
          additionalProperties: true,
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const task = findTask(String(args.task), workspaceId, ctx);
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.description !== undefined) patch.description = args.description;
      if (args.priority !== undefined) patch.priority = args.priority;
      // `isoDay` maps null to null, so clearing still works; what it refuses
      // is a date the app's string comparisons would silently mis-sort.
      if (args.due_date !== undefined) patch.due_date = isoDay(args.due_date, 'due_date');
      if (args.start_date !== undefined) patch.start_date = args.start_date;
      if (args.estimate !== undefined) patch.estimate = args.estimate;
      if (args.archived !== undefined) patch.archived = args.archived ? 1 : 0;
      if (args.assignees !== undefined) patch.assignees = resolveUsers(workspaceId, args.assignees);
      if (args.labels !== undefined) patch.labels = resolveLabels(workspaceId, task.project_id, args.labels, ctx);
      if (args.state !== undefined) {
        const state = resolveState(task.project_id, String(args.state));
        if (!state) throw new McpError(`No state matching "${args.state}" in this project`);
        patch.state_id = state.id;
      }
      if (args.module !== undefined) {
        patch.module_id = args.module === null ? null : String(findModule(String(args.module), workspaceId, ctx).id);
      }
      if (args.cycle !== undefined) {
        patch.cycle_id = args.cycle === null ? null : resolveCycle(workspaceId, String(args.cycle))?.id ?? null;
      }
      const { row } = writeEntity('task', task.id, patch, writeOpts(workspaceId, ctx));
      if (args.fields && typeof args.fields === 'object') writeCustomFields(row, args.fields, workspaceId, ctx);
      return taskView(row);
    },
  },
  {
    name: 'delete_task',
    title: 'Delete task',
    description: 'Soft-delete a task. It disappears from every client but stays recoverable in the database.',
    schema: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const task = findTask(String(args.task), workspaceId, ctx);
      deleteEntity('task', task.id, writeOpts(workspaceId, ctx));
      return { deleted: task.identifier };
    },
  },
  {
    name: 'comment_task',
    title: 'Comment on a task',
    description: 'Add a markdown comment; assignees and subscribers get a notification.',
    schema: {
      type: 'object',
      required: ['task', 'body'],
      properties: { task: { type: 'string' }, body: { type: 'string' }, workspace_id: { type: 'string' } },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const task = findTask(String(args.task), workspaceId, ctx);
      const { row } = writeEntity('comment', uid(), {
        workspace_id: workspaceId, task_id: task.id, body: String(args.body), author_id: ctx.auth.userId,
      }, writeOpts(workspaceId, ctx));
      return { id: row.id, task: task.identifier, created_at: row.created_at };
    },
  },
  {
    /**
     * Link two tasks.
     *
     * One row, one direction. The interface derives the other side when it
     * reads — a `blocks` row shows as "blocked by" on the task at the far end —
     * so writing both directions would show every link twice and let the two
     * halves disagree the moment one is deleted.
     *
     * `blocks` is load-bearing beyond the task detail: the planner and the
     * Gantt chart schedule from it, so a loop there is not a cosmetic mistake.
     * There is no guard on the pair anywhere else in the server, because until
     * now the only way to make one was by hand in the interface, one link at a
     * time, looking at both tasks. An assistant working from a list can build a
     * ten-task ring without ever seeing it, so the check lives here.
     */
    name: 'create_task_relation',
    title: 'Link two tasks',
    description: 'Relate two tasks: blocks, blocked_by, relates_to, duplicates or duplicated_by. One row is written; the other task shows the mirror image automatically. blocked_by is stored as the equivalent blocks row, which is the direction everything that schedules reads.',
    schema: {
      type: 'object',
      required: ['source_task', 'target_task', 'type'],
      properties: {
        source_task: { type: 'string', description: 'Task id or identifier, e.g. WEB-12' },
        target_task: { type: 'string', description: 'Task id or identifier' },
        type: {
          type: 'string',
          enum: [...RELATION_KINDS],
          description: 'Read as "source <type> target": WEB-1 blocks WEB-2 means WEB-2 waits for WEB-1',
        },
        lag: {
          type: 'integer',
          minimum: 0,
          maximum: 365,
          description: 'Working days the target waits after the source finishes. Only meaningful for `blocks`, and only the blocker owns it.',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const first = findTask(String(args.source_task), workspaceId, ctx);
      const second = findTask(String(args.target_task), workspaceId, ctx);

      if (first.id === second.id) throw new McpError('A task cannot be related to itself');

      // `duplicate` is not one of the five, and is the obvious thing to reach
      // for. Naming the alternatives beats "invalid enum value".
      const asked = String(args.type ?? '').toLowerCase();
      let kind = (asked === 'duplicate' ? 'duplicates' : asked) as RelationKind;
      if (!RELATION_KINDS.includes(kind)) {
        throw new McpError(`Unknown relation ${args.type}. One of: ${RELATION_KINDS.join(', ')}`);
      }

      /*
       * `blocked_by` is stored as the flipped `blocks` row.
       *
       * The two spellings are one statement, but only one of them is read by
       * everything that schedules: the planner, the Gantt chart and the
       * server-side cascade all filter `kind = 'blocks'`. A `blocked_by` row
       * stored verbatim *displayed* correctly — the task detail derives the
       * mirror image — and drew no edge and cascaded nothing, while this tool's
       * own description promised scheduling. The importer has always normalised
       * this way (`import.ts`), so this is joining a convention, not adding
       * one. It also lets `lag` mean something: after the flip the blocker owns
       * the row, which is the side lag lives on.
       */
      let [source, target] = [first, second];
      if (kind === 'blocked_by') {
        [source, target] = [second, first];
        kind = 'blocks';
      }

      // Already linked, in either direction, counting the mirror image: a
      // `blocks` row from A to B and a `blocked_by` row from B to A are the
      // same statement, and both would be drawn.
      const mirror = INVERSE_RELATION[kind];
      const existing = get<Row>(
        `SELECT * FROM task_relations
          WHERE workspace_id = ? AND deleted_at IS NULL
            AND ((task_id = ? AND related_task_id = ? AND kind = ?)
              OR (task_id = ? AND related_task_id = ? AND kind = ?))
          LIMIT 1`,
        workspaceId, source.id, target.id, kind, target.id, source.id, mirror,
      );
      if (existing) {
        return { id: String(existing.id), kind: String(existing.kind), already: true,
          source: source.identifier, target: target.identifier };
      }

      if (kind === 'blocks' && blockingLoop(workspaceId, source, target, kind)) {
        throw new McpError(
          `${source.identifier} and ${target.identifier} would block each other in a circle, and nothing in that circle could ever start`,
        );
      }

      const { row } = writeEntity('relation', uid(), {
        workspace_id: workspaceId,
        task_id: source.id,
        related_task_id: target.id,
        kind,
        // `NOT NULL DEFAULT 0`, and clamped to the same 0–365 whole days the
        // interface allows. Negative would be a lead time — "may start before
        // its blocker ends" — which is the one rule the scheduler exists to
        // keep, and a fractional working day means nothing to it.
        lag: kind === 'blocks' && typeof args.lag === 'number'
          ? Math.max(0, Math.min(365, Math.round(args.lag)))
          : 0,
      }, writeOpts(workspaceId, ctx));

      return {
        id: String(row.id),
        kind,
        lag: Number(row.lag ?? 0),
        source: { id: String(source.id), identifier: source.identifier, title: source.title },
        target: { id: String(target.id), identifier: target.identifier, title: target.title },
      };
    },
  },
  {
    name: 'my_work',
    title: 'My work',
    description: 'Everything assigned to the token owner across the workspace, split into overdue, today, upcoming and unscheduled.',
    readOnly: true,
    schema: { type: 'object', properties: { workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const visible = visibleProjectIds(ctx.auth.userId, workspaceId);
      const rows = all<Row>(
        `SELECT t.* FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key NOT IN ('completed','cancelled')
            AND EXISTS (SELECT 1 FROM json_each(t.assignees) WHERE json_each.value = ?)
          ORDER BY t.due_date IS NULL, t.due_date, t.priority`,
        workspaceId, ctx.auth.userId,
      ).filter((t) => visible.has(t.project_id)).map(taskView);
      const today = new Date().toISOString().slice(0, 10);
      return {
        overdue: rows.filter((t) => t.due_date && t.due_date < today),
        today: rows.filter((t) => t.due_date === today),
        upcoming: rows.filter((t) => t.due_date && t.due_date > today),
        unscheduled: rows.filter((t) => !t.due_date),
      };
    },
  },

  /* --------------------------------------------------------------- rates --
   *
   * Four tools over what an hour is worth. Every one of them is refused for
   * anybody below admin — a rate is close enough to somebody's pay that the
   * restriction has to hold on every door, and a total is a rate anybody can
   * divide back out.
   */
];

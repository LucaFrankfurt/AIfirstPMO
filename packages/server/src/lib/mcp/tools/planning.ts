/**
 * Cycles, milestones, templates and logged time.
 */
import { coversProject, type Move, orderKey, parseDuration, PROJECT_STATUS } from '@kolibri/shared';
import { all, get, type Row } from '../../../db/index.ts';
import { env } from '../../../env.ts';
import { instantiateTemplate } from '../../automation.ts';
import { canSeeProject, deleteEntity, read, serialize, visibleProjectIds, writeEntity } from '../../repo.ts';
import { uid } from '../../ids.ts';
import { CYCLE_STATUS, cycleView, findCycle, findMember, findModule, findProject, findTask, holes, isoDay, McpError, moduleView, requireFeature, requireWrite, resolveScope, str, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

export const planningTools: ToolDef[] = [
  {
    name: 'list_cycles',
    title: 'List cycles',
    description:
      "Cycles with progress counts. Given a project: that project's own cycles plus the workspace-wide ones it can use. Without one: every cycle in the workspace.",
    readOnly: true,
    schema: { type: 'object', properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      return all<Row>(
        /* Its own, the ones every project runs, and the ones that name it.
           `coversProject` says the same thing in TypeScript for the client; this
           is the half SQLite has to answer so a big workspace does not send
           every cycle to be filtered in memory. */
        `SELECT * FROM cycles WHERE workspace_id = ? AND deleted_at IS NULL ${project ? `AND (
             (json_array_length(projects) = 0 AND (project_id IS NULL OR project_id = ?))
             OR EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value = ?)
           )` : ''} ORDER BY start_date DESC`,
        ...(project ? [workspaceId, project.id, project.id] : [workspaceId]),
      ).map((cycle) => ({
        ...cycleView(cycle),
        total: Number(get<Row>(`SELECT count(*) c FROM tasks WHERE cycle_id = ? AND deleted_at IS NULL`, cycle.id)?.c ?? 0),
        done: Number(get<Row>(
          `SELECT count(*) c FROM tasks t JOIN states s ON s.id = t.state_id
            WHERE t.cycle_id = ? AND t.deleted_at IS NULL AND s.group_key IN ('completed','cancelled')`, cycle.id,
        )?.c ?? 0),
      }));
    },
  },
  {
    name: 'create_cycle',
    title: 'Create cycle',
    description:
      'Create a sprint/cycle. `project` scopes it to one; `projects` scopes it to exactly those; neither makes it a cycle every project in the workspace can put work in.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        project: { type: 'string', description: 'Key or name, for a cycle one project owns.' },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keys or names, for a cycle exactly those projects run. Omit both for every project.',
        },
        name: { type: 'string' },
        start_date: { type: 'string' }, end_date: { type: 'string' },
        description: { type: 'string' }, workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const scope = resolveScope(args, workspaceId, ctx);
      const { row } = writeEntity('cycle', uid(), {
        workspace_id: workspaceId, ...scope, name: String(args.name),
        description: str(args.description) ?? null, start_date: str(args.start_date) ?? null, end_date: str(args.end_date) ?? null,
      }, writeOpts(workspaceId, ctx));
      // `cycleView`, as `list_cycles` and `update_cycle` both return — so the
      // shape an assistant gets back from creating one is the shape it will
      // see again, `scope` included. It was `serialize` here alone.
      return cycleView(row);
    },
  },
  {
    /**
     * Change a cycle's dates, name, description or status.
     *
     * **A note on `status`.** The column exists and this writes it, but nothing
     * in Kolibri reads it yet: the app works out which cycle is current from
     * the dates — `start_date <= today <= end_date` — and that is what
     * `cycle: "current"` resolves through, what the burn-down uses, and what
     * the project digest reports. So setting a status records an intention and
     * changes no behaviour today. The dates are the part with teeth.
     *
     * It is written rather than refused because the field is in the model and
     * an assistant asked to close a sprint should have somewhere to say so.
     */
    name: 'update_cycle',
    title: 'Update cycle',
    description: "Change a cycle's name, dates, description, status, or which projects it covers. Note that which cycle is *current* is worked out from the dates rather than the status — the status is recorded but nothing reads it yet.",
    schema: {
      type: 'object',
      required: ['cycle'],
      properties: {
        cycle: { type: 'string', description: 'Cycle id or name' },
        name: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        description: { type: 'string' },
        status: { type: 'string', enum: [...CYCLE_STATUS] },
        project: { type: 'string', description: 'Move it to one project. Mutually exclusive with `projects`.' },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'The projects it covers. An empty array makes it every project. Work already in it is never removed — see the note in the result.',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const cycle = findCycle(String(args.cycle), workspaceId, ctx);

      const patch: Record<string, unknown> = {};
      if (str(args.name)) patch.name = str(args.name);
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (args.start_date !== undefined) patch.start_date = isoDay(args.start_date, 'start_date');
      if (args.end_date !== undefined) patch.end_date = isoDay(args.end_date, 'end_date');
      if (args.status !== undefined) {
        const status = str(args.status)?.toLowerCase();
        if (!CYCLE_STATUS.includes(status as (typeof CYCLE_STATUS)[number])) {
          throw new McpError(`Unknown status "${args.status}". One of: ${CYCLE_STATUS.join(', ')}`);
        }
        patch.status = status;
      }
      /* Re-scoping. Offered here and not in the interface, where the toggle is
         create-only: an assistant asked to "add Mobile to the fortnight" has
         somewhere to do it, and gets told what it did to the work.

         Tasks already in the cycle are **not** touched. Dropping a project
         could orphan its tasks from a cycle somebody deliberately put them in,
         and doing that silently as a side effect of an edit is the kind of
         data loss nobody attributes to the right action. The count comes back
         instead, so the caller can decide. */
      let stranded: Row[] = [];
      if (args.project !== undefined || args.projects !== undefined) {
        const scope = resolveScope(args, workspaceId, ctx);
        patch.project_id = scope.project_id;
        patch.projects = scope.projects;
        /* Only the ones the caller can see. A private project this token is
           not in may have work in the cycle, and naming `PRIV-42` here would
           disclose it as surely as any report would — the projects that can be
           *named* are already limited to the visible ones by `findProject`, so
           this is the other half of the same rule. Nothing is moved either
           way, so the unseen tasks are no worse off for going unmentioned. */
        const visible = visibleProjectIds(ctx.auth.userId, workspaceId);
        stranded = all<Row>(
          `SELECT t.identifier, t.project_id FROM tasks t
            WHERE t.cycle_id = ? AND t.deleted_at IS NULL`,
          cycle.id,
        ).filter((task) => visible.has(String(task.project_id)) && !coversProject(
          { project_id: scope.project_id, projects: scope.projects },
          String(task.project_id),
        ));
      }

      if (!Object.keys(patch).length) {
        throw new McpError('Nothing to change — pass name, start_date, end_date, description, status, project or projects');
      }

      // A sprint that ends before it starts is not a sprint, and every date
      // window in the app reads the pair rather than one of them. `in` rather
      // than `??`: a date being *cleared* is in the patch as null, and `??`
      // would resurrect the old value and refuse an update whose final state
      // is perfectly legal.
      const from = ('start_date' in patch ? patch.start_date : cycle.start_date) as string | null;
      const to = ('end_date' in patch ? patch.end_date : cycle.end_date) as string | null;
      if (from && to && from > to) throw new McpError(`A cycle cannot end (${to}) before it starts (${from})`);

      const { row } = writeEntity('cycle', String(cycle.id), patch, writeOpts(workspaceId, ctx));
      return {
        ...cycleView(row),
        ...(stranded.length
          ? {
            // Named, not counted: "3 tasks" is a number somebody has to go and
            // find, and these are the ones they would be looking for.
            stranded_tasks: stranded.map((t) => String(t.identifier)),
            note: 'These tasks are still in the cycle but their project is no longer covered by it. Nothing was removed — move them or widen the cycle.',
          }
          : {}),
      };
    },
  },
  {
    /**
     * Delete a cycle.
     *
     * A soft delete, the same one the interface does: the row goes to the trash
     * and can be restored for `KOLIBRI_TRASH_DAYS`. That is what makes this
     * safe enough for an assistant to call — "delete or archive" is one action
     * here, because a deleted thing is an archived thing until the trash is
     * emptied.
     *
     * Tasks in the cycle are left alone rather than deleted with it. They keep
     * pointing at a cycle that is gone, and the repository settles that to
     * `null` the next time each one is written — which is the existing
     * behaviour for every reference to a deleted row, not something invented
     * here. The count comes back in the answer so the caller knows how many
     * tasks just lost their sprint.
     */
    name: 'delete_cycle',
    title: 'Delete cycle',
    description: 'Delete a cycle. It goes to the trash and can be restored; tasks in it are kept and simply lose their cycle.',
    schema: {
      type: 'object',
      required: ['cycle'],
      properties: {
        cycle: { type: 'string', description: 'Cycle id or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const cycle = findCycle(String(args.cycle), workspaceId, ctx);
      const orphaned = Number(get<Row>(
        `SELECT count(*) c FROM tasks WHERE cycle_id = ? AND deleted_at IS NULL`, cycle.id,
      )?.c ?? 0);

      deleteEntity('cycle', String(cycle.id), writeOpts(workspaceId, ctx));
      return { deleted: String(cycle.name), id: String(cycle.id), tasks_released: orphaned };
    },
  },
  /* ---------------------------------------------------------------- modules
     A cycle answers *when* and a module answers *what is this part of*. Both
     are scoped the same way, so these read like the cycle tools above on
     purpose — one idea, spelled once. */
  {
    name: 'list_modules',
    title: 'List modules',
    description:
      "Modules (milestones) with progress counts. Given a project: that project's own modules plus the shared ones it works on. Without one: every module in the workspace.",
    readOnly: true,
    schema: { type: 'object', properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const visible = [...visibleProjectIds(ctx.auth.userId, workspaceId)];
      const scoped = project ? [String(project.id)] : visible;
      if (!scoped.length) return [];
      /* Its own, the ones every project shares, and the ones that name it —
         `coversProject` in SQL. Without a project it is still every *visible*
         project rather than the whole table: a module belonging only to a
         private project is not this token's to list. */
      return all<Row>(
        `SELECT * FROM modules WHERE workspace_id = ? AND deleted_at IS NULL
           AND ((json_array_length(projects) = 0
                 AND (project_id IS NULL OR project_id IN (${holes(scoped.length)})))
                OR EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value IN (${holes(scoped.length)})))
         ORDER BY target_date IS NULL, target_date, sort_order`,
        workspaceId, ...scoped, ...scoped,
      ).map((module) => ({
        ...moduleView(module),
        total: Number(get<Row>(`SELECT count(*) c FROM tasks WHERE module_id = ? AND deleted_at IS NULL`, module.id)?.c ?? 0),
        done: Number(get<Row>(
          `SELECT count(*) c FROM tasks t JOIN states s ON s.id = t.state_id
            WHERE t.module_id = ? AND t.deleted_at IS NULL AND s.group_key IN ('completed','cancelled')`, module.id,
        )?.c ?? 0),
      }));
    },
  },
  {
    name: 'create_module',
    title: 'Create module',
    description:
      'Create a module (milestone). `project` scopes it to one; `projects` scopes it to exactly those; neither makes it one every project in the workspace works on.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        project: { type: 'string', description: 'Key or name, for a module one project owns.' },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keys or names, for a milestone exactly those projects work towards. Omit both for every project.',
        },
        name: { type: 'string' },
        description: { type: 'string' },
        lead: { type: 'string', description: 'Name or email of the person who owns it' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_date: { type: 'string', description: 'YYYY-MM-DD' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const scope = resolveScope(args, workspaceId, ctx);
      const start = args.start_date === undefined ? null : isoDay(args.start_date, 'start_date');
      const target = args.target_date === undefined ? null : isoDay(args.target_date, 'target_date');
      if (start && target && start > target) {
        throw new McpError(`A module cannot be due (${target}) before it starts (${start})`);
      }
      const { row } = writeEntity('module', uid(), {
        workspace_id: workspaceId, ...scope, name: String(args.name),
        description: str(args.description) ?? null,
        lead_id: str(args.lead) ? findMember(String(args.lead), workspaceId).id : null,
        start_date: start, target_date: target,
        status: 'planned', sort_order: orderKey(null, null),
      }, writeOpts(workspaceId, ctx));
      return moduleView(row);
    },
  },
  {
    /**
     * Change a module's name, dates, lead, description, status or scope.
     *
     * **A note on `status`.** The column exists and this writes it, and nothing
     * in Kolibri reads it — the progress a module reports is counted from its
     * tasks, and the date it is judged against is `target_date`. So setting a
     * status records an intention and changes no behaviour today, exactly as it
     * does on a cycle. It is written rather than refused because the field is
     * in the model and an assistant asked to close a milestone should have
     * somewhere to say so.
     */
    name: 'update_module',
    title: 'Update module',
    description: "Change a module's name, description, lead, dates, status, or which projects work on it. Note that progress is counted from its tasks and nothing reads the status yet.",
    schema: {
      type: 'object',
      required: ['module'],
      properties: {
        module: { type: 'string', description: 'Module id or name' },
        name: { type: 'string' },
        description: { type: 'string' },
        lead: { type: ['string', 'null'], description: 'Name or email, or null to clear' },
        start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        target_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        status: { type: 'string', enum: [...PROJECT_STATUS] },
        project: { type: 'string', description: 'Move it to one project. Mutually exclusive with `projects`.' },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'The projects it covers. An empty array makes it every project. Work already in it is never removed — see the note in the result.',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const module = findModule(String(args.module), workspaceId, ctx);

      const patch: Record<string, unknown> = {};
      if (str(args.name)) patch.name = str(args.name);
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (args.start_date !== undefined) patch.start_date = isoDay(args.start_date, 'start_date');
      if (args.target_date !== undefined) patch.target_date = isoDay(args.target_date, 'target_date');
      if (args.lead !== undefined) {
        patch.lead_id = args.lead === null ? null : findMember(String(args.lead), workspaceId).id;
      }
      if (args.status !== undefined) {
        const status = str(args.status)?.toLowerCase();
        if (!PROJECT_STATUS.includes(status as (typeof PROJECT_STATUS)[number])) {
          throw new McpError(`Unknown status "${args.status}". One of: ${PROJECT_STATUS.join(', ')}`);
        }
        patch.status = status;
      }

      /* Re-scoping, offered here and not in the interface for the reason the
         cycle tool gives: an assistant asked to "add Mobile to the launch" has
         somewhere to do it, and is told what it did to the work. Tasks already
         in the module are never moved — dropping a project could orphan work
         somebody deliberately filed under a milestone, and doing that silently
         as a side effect of an edit is data loss nobody attributes correctly. */
      let stranded: Row[] = [];
      if (args.project !== undefined || args.projects !== undefined) {
        const scope = resolveScope(args, workspaceId, ctx);
        patch.project_id = scope.project_id;
        patch.projects = scope.projects;
        // Only what this token could see anyway: naming a private project's
        // identifiers here would disclose it, as it would in any report.
        const visible = visibleProjectIds(ctx.auth.userId, workspaceId);
        stranded = all<Row>(
          `SELECT t.identifier, t.project_id FROM tasks t WHERE t.module_id = ? AND t.deleted_at IS NULL`,
          module.id,
        ).filter((task) => visible.has(String(task.project_id)) && !coversProject(
          { project_id: scope.project_id, projects: scope.projects },
          String(task.project_id),
        ));
      }

      if (!Object.keys(patch).length) {
        throw new McpError('Nothing to change — pass name, description, lead, start_date, target_date, status, project or projects');
      }

      // A milestone due before it starts is not a milestone. `in` rather than
      // `??`, so clearing a date is not confused with leaving it alone.
      const from = ('start_date' in patch ? patch.start_date : module.start_date) as string | null;
      const to = ('target_date' in patch ? patch.target_date : module.target_date) as string | null;
      if (from && to && from > to) throw new McpError(`A module cannot be due (${to}) before it starts (${from})`);

      const { row } = writeEntity('module', String(module.id), patch, writeOpts(workspaceId, ctx));
      return {
        ...moduleView(row),
        ...(stranded.length
          ? {
            stranded_tasks: stranded.map((t) => String(t.identifier)),
            note: 'These tasks are still in the module but their project is no longer covered by it. Nothing was removed — move them or widen the module.',
          }
          : {}),
      };
    },
  },
  {
    name: 'delete_module',
    title: 'Delete module',
    description: 'Delete a module. It goes to the trash and can be restored; tasks in it are kept and simply lose their module.',
    schema: {
      type: 'object',
      required: ['module'],
      properties: {
        module: { type: 'string', description: 'Module id or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const module = findModule(String(args.module), workspaceId, ctx);
      const orphaned = Number(get<Row>(
        `SELECT count(*) c FROM tasks WHERE module_id = ? AND deleted_at IS NULL`, module.id,
      )?.c ?? 0);
      deleteEntity('module', String(module.id), writeOpts(workspaceId, ctx));
      return { deleted: String(module.name), id: String(module.id), tasks_released: orphaned };
    },
  },
  /**
   * The agenda, assembled rather than asked for six times.
   *
   * Every number here already had a tool. What did not exist was the *order* —
   * a weekly meeting is not six reports, it is what happened, then what is
   * about to go wrong, then what is stuck, then who is carrying it. Six calls
   * and a person arranging the answers is the work this saves, and arranging
   * them the same way every week is most of what makes the meeting short.
   *
   * Each section is the tool's own answer, called through `report` below rather
   * than re-queried, so there is one source of truth per number and this cannot
   * drift from the tool it claims to be showing.
   */
  {
    name: 'log_time',
    title: 'Log time on a task',
    description:
      'Record time already spent. Accepts "90", "1h30", "1.5h" or "1:30". '
      + 'Defaults to today and to the calling token\'s own user.',
    schema: {
      type: 'object',
      required: ['task', 'amount'],
      properties: {
        task: { type: 'string' },
        amount: { type: 'string', description: 'How long, e.g. 45m, 1h30, 2h' },
        spent_on: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'time');
      const task = findTask(String(args.task), workspaceId, ctx);
      const minutes = parseDuration(String(args.amount));
      // An unparseable duration must not become a silent zero-minute entry.
      if (minutes === null || minutes <= 0) throw new McpError(`Cannot read "${args.amount}" as a duration`);
      const spentOn = args.spent_on ? String(args.spent_on) : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) throw new McpError('spent_on must be YYYY-MM-DD');

      const { row } = writeEntity('timeEntry', uid(), {
        workspace_id: workspaceId,
        project_id: task.project_id,
        task_id: task.id,
        user_id: ctx.auth.userId,
        minutes,
        spent_on: spentOn,
        note: args.note ? String(args.note) : null,
        started_at: null,
        billable: 1,
      }, writeOpts(workspaceId, ctx));
      return { id: row.id, task: task.identifier, minutes, spent_on: spentOn };
    },
  },
  {
    name: 'list_time',
    title: 'List logged time',
    description: 'Time logged, optionally narrowed to one task, one project or a date range.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        project: { type: 'string', description: 'Project key or name' },
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        mine: { type: 'boolean', description: 'Only the calling user\'s own entries' },
        limit: { type: 'number', default: 100 },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'time');
      const where: string[] = ['t.workspace_id = ?', 't.deleted_at IS NULL'];
      const params: unknown[] = [workspaceId];

      if (args.task) {
        where.push('t.task_id = ?');
        params.push(findTask(String(args.task), workspaceId, ctx).id);
      }
      if (args.project) {
        where.push('t.project_id = ?');
        params.push(findProject(String(args.project), workspaceId, ctx).id);
      }
      if (args.from) { where.push('t.spent_on >= ?'); params.push(String(args.from)); }
      if (args.to) { where.push('t.spent_on <= ?'); params.push(String(args.to)); }
      if (args.mine) { where.push('t.user_id = ?'); params.push(ctx.auth.userId); }

      const rows = all<Row>(
        `SELECT t.id, t.minutes, t.spent_on, t.note, t.started_at, t.user_id,
                u.name AS user_name, k.identifier AS task, p.name AS project
           FROM time_entries t
           LEFT JOIN users u ON u.id = t.user_id
           LEFT JOIN tasks k ON k.id = t.task_id
           LEFT JOIN projects p ON p.id = t.project_id
          WHERE ${where.join(' AND ')}
          ORDER BY t.spent_on DESC, t.created_at DESC
          LIMIT ?`,
        ...params, Math.min(Number(args.limit ?? 100) || 100, 500),
      );
      return {
        entries: rows.map((row) => ({ ...row, running: !!row.started_at })),
        total_minutes: rows.reduce((sum, row) => sum + Number(row.minutes ?? 0), 0),
      };
    },
  },
  {
    name: 'list_templates',
    title: 'List task templates',
    description: 'Pre-written tasks that can be filed with apply_template, including the checklist each one carries.',
    readOnly: true,
    schema: { type: 'object', properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      return all<Row>(
        `SELECT * FROM templates
          WHERE workspace_id = ? AND archived = 0 AND deleted_at IS NULL
            ${project ? 'AND (project_id IS NULL OR project_id = ?)' : ''}
          ORDER BY name`,
        ...(project ? [workspaceId, project.id] : [workspaceId]),
      ).map((template) => ({
        id: template.id,
        name: template.name,
        kind: template.kind,
        project_id: template.project_id,
        title: template.title,
        description: template.description,
        subtasks: JSON.parse(String(template.subtasks ?? '[]')),
      }));
    },
  },
  {
    name: 'apply_template',
    title: 'File a task from a template',
    description: 'Creates a real task from a template, with its checklist as sub-tasks. Same path the automations use.',
    schema: {
      type: 'object',
      required: ['template'],
      properties: {
        template: { type: 'string', description: 'Template id or exact name' },
        project: { type: 'string', description: 'Project key or name; defaults to the template\'s own project' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'User ids' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const needle = String(args.template);
      const template = get<Row>(
        `SELECT * FROM templates WHERE workspace_id = ? AND deleted_at IS NULL AND (id = ? OR name = ?) LIMIT 1`,
        workspaceId, needle, needle,
      );
      if (!template) throw new McpError(`No template called ${needle}`);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const projectId = project?.id ?? template.target_project_id ?? template.project_id;
      if (!projectId) throw new McpError('This template has no project — pass one');
      if (!canSeeProject(ctx.auth.userId, String(projectId))) throw new McpError('Project is private');

      const row = get<Row>(`SELECT name FROM projects WHERE id = ?`, projectId);
      const actor = get<Row>(`SELECT name FROM users WHERE id = ?`, ctx.auth.userId);
      const task = instantiateTemplate(template, {
        workspaceId,
        actorId: ctx.auth.userId,
        projectId: String(projectId),
        assignees: Array.isArray(args.assignees) ? (args.assignees as string[]) : undefined,
        vars: { project: String(row?.name ?? ''), actor: String(actor?.name ?? '') },
      });
      return { id: task.id, identifier: task.identifier, title: task.title, url: `${env.publicUrl}/t/${task.id}` };
    },
  },
];

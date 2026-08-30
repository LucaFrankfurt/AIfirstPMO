/**
 * Workspaces and projects: the outer boundary, and the things inside it.
 */
import { PROJECT_STATUS, type ProjectStatus } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { createProject } from '../../../kernel/write-path/bootstrap.ts';
import { serialize, visibleProjectIds, writeEntity } from '../../../kernel/write-path/repo.ts';
import { searchWorkspace } from '../../../kernel/search/search.ts';
import { countTasks, findProject, isoDay, McpError, requireWrite, resolveUsers, str, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

export const workspaceTools: ToolDef[] = [
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'List the workspaces this account can access, with the caller\'s role.',
    readOnly: true,
    schema: { type: 'object', properties: {} },
    run: (_args, ctx) =>
      all<Row>(
        `SELECT w.id, w.name, w.slug FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
          WHERE m.user_id = ? AND m.deleted_at IS NULL AND w.deleted_at IS NULL`,
        ctx.auth.userId,
      ).map((w) => ({ ...w, role: ctx.auth.memberships.get(w.id) })),
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List projects in a workspace, including open/done task counts.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Defaults to the token workspace' },
        include_archived: { type: 'boolean' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const visible = visibleProjectIds(ctx.auth.userId, workspaceId);
      return all<Row>(
        `SELECT * FROM projects WHERE workspace_id = ? AND deleted_at IS NULL ${args.include_archived ? '' : 'AND archived = 0'} ORDER BY sort_order`,
        workspaceId,
      )
        .filter((p) => visible.has(p.id))
        .map((p) => ({
          id: p.id, key: p.key, name: p.name, description: p.description, status: p.status,
          lead_id: p.lead_id, target_date: p.target_date, icon: p.icon,
          open_tasks: countTasks(p.id, false),
          done_tasks: countTasks(p.id, true),
        }));
    },
  },
  {
    name: 'create_project',
    title: 'Create project',
    description: 'Create a project with the default workflow states and labels.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        key: { type: 'string', description: 'Short prefix for task identifiers, e.g. WEB' },
        description: { type: 'string' },
        workspace_id: { type: 'string' },
        private: { type: 'boolean' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = createProject(workspaceId, ctx.auth.userId, {
        name: String(args.name), key: str(args.key), description: str(args.description),
        visibility: args.private ? 'private' : 'public',
      });
      return serialize('project', project);
    },
  },
  {
    /**
     * Project metadata.
     *
     * Everything except the **key**, which is deliberately not here. A key is
     * the prefix of every identifier the project has ever minted, so changing
     * it does not rename `WEB-42` — it leaves that task named after a prefix
     * the project no longer has. The settings screen allows it because a person
     * changing it is looking at the project and can see what happens; that is
     * not the position an assistant is in, and the server bounces a duplicate
     * key silently through `forced` rather than throwing, so a refusal would
     * not even reach the caller as an error.
     */
    name: 'update_project',
    title: 'Update project',
    description: "Change a project's name, icon, description, status, lead or dates. The project key is deliberately not settable here — it is the prefix of every identifier the project has already minted.",
    schema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', description: 'Project id, key or name' },
        name: { type: 'string' },
        icon: { type: 'string', description: 'A single emoji' },
        description: { type: 'string', description: 'Markdown' },
        status: { type: 'string', enum: [...PROJECT_STATUS] },
        lead: { type: 'string', description: 'User id, email or name' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_date: { type: 'string', description: 'YYYY-MM-DD' },
        archived: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = findProject(String(args.project), workspaceId, ctx);

      const patch: Record<string, unknown> = {};
      if (str(args.name)) patch.name = str(args.name);
      if (args.icon !== undefined) patch.icon = str(args.icon) ?? null;
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (args.status !== undefined) {
        // `cancelled` here too, for the reason in `stateGroup`.
        const raw = str(args.status)?.toLowerCase();
        const status = (raw === 'canceled' ? 'cancelled' : raw) as ProjectStatus;
        if (!PROJECT_STATUS.includes(status)) {
          throw new McpError(`Unknown status "${args.status}". One of: ${PROJECT_STATUS.join(', ')}`);
        }
        patch.status = status;
      }
      if (args.lead !== undefined) {
        // Refused, not guessed. `resolveUsers` drops what it does not recognise,
        // so a typo'd name was silently *clearing* the lead while reporting
        // success — the assistant then tells somebody the wrong person owns the
        // project. Null is the one honest way to say "no lead".
        if (args.lead === null || args.lead === '') {
          patch.lead_id = null;
        } else {
          const lead = resolveUsers(workspaceId, [args.lead])[0];
          if (!lead) throw new McpError(`No member matching "${args.lead}" — pass null to clear the lead`);
          patch.lead_id = lead;
        }
      }
      if (args.start_date !== undefined) patch.start_date = isoDay(args.start_date, 'start_date');
      if (args.target_date !== undefined) patch.target_date = isoDay(args.target_date, 'target_date');
      if (typeof args.archived === 'boolean') patch.archived = args.archived ? 1 : 0;
      if (!Object.keys(patch).length) throw new McpError('Nothing to change');

      // `in`, not `??` — see the same check on update_cycle.
      const from = ('start_date' in patch ? patch.start_date : project.start_date) as string | null;
      const to = ('target_date' in patch ? patch.target_date : project.target_date) as string | null;
      if (from && to && from > to) throw new McpError(`A project cannot target ${to} and start ${from}`);

      const { row } = writeEntity('project', String(project.id), patch, writeOpts(workspaceId, ctx));
      return {
        id: String(row.id),
        key: String(row.key),
        name: String(row.name),
        icon: row.icon ?? null,
        description: row.description ?? null,
        status: row.status ?? null,
        lead_id: row.lead_id ?? null,
        start_date: row.start_date ?? null,
        target_date: row.target_date ?? null,
        archived: !!row.archived,
      };
    },
  },
  {
    name: 'list_members',
    title: 'List members',
    description: 'People in the workspace, with their role and open task count.',
    readOnly: true,
    schema: { type: 'object', properties: { workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      return all<Row>(
        `SELECT u.id, u.name, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? AND m.deleted_at IS NULL ORDER BY u.name`,
        workspaceId,
      ).map((member) => ({
        ...member,
        open_tasks: Number(get<Row>(
          `SELECT count(*) c FROM tasks t JOIN states s ON s.id = t.state_id
            WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND s.group_key NOT IN ('completed','cancelled')
              AND EXISTS (SELECT 1 FROM json_each(t.assignees) WHERE json_each.value = ?)`,
          workspaceId, member.id,
        )?.c ?? 0),
      }));
    },
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Full-text search across tasks, pages, projects, cycles and comments.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: ['task', 'page', 'project', 'comment', 'cycle', 'module'] } },
        limit: { type: 'number', default: 20 },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      return searchWorkspace(workspaceId, ctx.auth.userId, String(args.query), Math.min(Number(args.limit ?? 20) || 20, 100), args.kinds);
    },
  },
];

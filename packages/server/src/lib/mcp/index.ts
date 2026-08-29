/**
 * Model Context Protocol server.
 *
 * Kolibri speaks MCP natively so an assistant can run the board: read the
 * backlog, file issues, move them, write pages. It is a plain JSON-RPC 2.0
 * handler — the HTTP route and the stdio bridge in `packages/mcp` both call
 * `handleRpc`, so tools only exist in one place.
 *
 * What is *here* is the envelope: the protocol version, the request shape, the
 * prompts, and the dispatch. The tools themselves are eleven files under
 * `tools/`, one per group, built out of `kit.ts`. They were one array in one
 * file for a long time, and the file reached 5 464 lines — at which point
 * "where do the budget tools live" and "what would removing them cost" had the
 * same unhappy answer. See `docs/modules.md`.
 */
import { type EntityName } from '@kolibri/shared';
import { all, get, type Row } from '../../db/index.ts';
import { read } from '../repo.ts';
import { holes, type McpCtx, McpError, type ToolDef } from './kit.ts';
import { workspaceTools } from './tools/workspace.ts';
import { taskTools } from './tools/tasks.ts';
import { attachmentTools } from './tools/attachments.ts';
import { planningTools } from './tools/planning.ts';
import { configTools } from './tools/config.ts';
import { pageTools } from './tools/pages.ts';
import { kpiTools } from './tools/kpis.ts';
import { budgetTools } from './tools/budgets.ts';
import { rateTools } from './tools/rates.ts';
import { infrastructureTools } from './tools/infrastructure.ts';
import { reportTools } from './tools/reports.ts';

/** The route and the stdio bridge both hand one of these to `handleRpc`. */
export type { McpCtx };

export const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'kolibri', title: 'Kolibri', version: '0.1.0' };

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

/* ---------------------------------------------------------------- tools */

/**
 * Every tool, in the order a reader would look for them.
 *
 * This list is the whole of what `lib/mcp.ts` used to be. Adding a group is a
 * file and a line here; a group that is never imported is a group that does not
 * exist, which is the property the old 5 464-line array could not have.
 *
 * The order is the groups' order rather than the one the array happened to grow
 * in — `search` used to sit between `list_time` and `list_templates`. Nothing
 * depends on it: `tools/list` is a set to every client, and the two tests that
 * read it ask by name.
 */
const TOOLS: ToolDef[] = [
  ...workspaceTools,
  ...taskTools,
  ...attachmentTools,
  ...planningTools,
  ...configTools,
  ...pageTools,
  ...kpiTools,
  ...budgetTools,
  ...rateTools,
  ...infrastructureTools,
  ...reportTools,
];

/* ---------------------------------------------------------------- prompts */

/**
 * The prompts, which are the "add from Kolibri" menu in a client rather than
 * the tool list — a person picks one, it becomes their message, and the model
 * calls the tools from there.
 *
 * `project` is optional on every one of them. It was required, which meant none
 * of these could answer for a workspace: "what do we talk about on Monday" is
 * not a question about one project, and somebody in four of them had to run the
 * same prompt four times and add it up. That is the same thing the report tools
 * were changed for, and this is the half that was left behind.
 */
const inScope = (project?: string) => (project ? `"${project}"` : 'the whole workspace');

const PROMPTS = [
  {
    name: 'weekly_review',
    title: 'Prepare the weekly meeting',
    description: 'The agenda for a weekly: what shipped, what is at risk, what is stuck, and who is carrying it.',
    arguments: [
      { name: 'project', description: 'Project key or name. Leave it out for the whole workspace.', required: false },
      { name: 'days', description: 'How far back "since last time" reaches. Defaults to 7.', required: false },
    ],
    build: (args: Record<string, string>) =>
      `Call prepare_meeting for ${inScope(args.project)}${args.days ? ` with days=${args.days}` : ''}. Turn the agenda into something a person can read out: lead with the headline numbers in one sentence, then a short section per heading, naming people and task identifiers rather than counts wherever the detail has them. Say plainly if a section is empty — a quiet week is worth hearing. Put anything needing a decision in a closing list, and do not change anything.`,
  },
  {
    name: 'standup',
    title: 'Daily standup',
    description: 'Summarise what moved yesterday, what is in flight and what is blocked.',
    arguments: [{ name: 'project', description: 'Project key or name. Leave it out for the whole workspace.', required: false }],
    build: (args: Record<string, string>) =>
      `Use changes_since with days=1 and blocked_tasks for ${inScope(args.project)}, and list_tasks with state=started. Write a short standup: what completed since yesterday, what is in progress and who owns it, what is overdue or unassigned, and the single most important risk. Keep it under 200 words.`,
  },
  {
    name: 'sprint_planning',
    title: 'Plan the next cycle',
    description: 'Propose a cycle scope from the backlog.',
    arguments: [
      { name: 'project', description: 'Project key or name. Leave it out for the whole workspace.', required: false },
      { name: 'capacity', description: 'Total estimate points available', required: false },
    ],
    build: (args: Record<string, string>) =>
      `Read the backlog of ${inScope(args.project)} with list_tasks (state=backlog) and the last cycle with list_cycles. Propose a scope for the next cycle that fits ${args.capacity ?? 'the team\'s recent throughput'}, ordered by priority and dependencies. A cycle can cover several projects — say so if the scope you are proposing spans more than one. Explain trade-offs, then ask before calling update_task to assign the cycle.`,
  },
  {
    name: 'meeting_notes',
    title: 'Write up meeting notes',
    description: 'Start a page from a notes template and fill it in from what actually happened.',
    arguments: [
      { name: 'template', description: 'Template title, from list_page_templates. Asked for if left out.', required: false },
      { name: 'project', description: 'Project key or name. Leave it out for the whole workspace.', required: false },
    ],
    build: (args: Record<string, string>) =>
      `${args.template
        ? `Make a page from the "${args.template}" template with create_page_from_template.`
        : 'Show me list_page_templates and ask which one to use, then make a page from it with create_page_from_template.'} Title it for today's meeting. Then fill the template's sections in from prepare_meeting for ${inScope(args.project)} — keep the template's own headings and structure, and put the real numbers and task identifiers under them. Leave any section it has no data for as an empty heading rather than deleting it or inventing content, and file decisions as tasks only after I say so.`,
  },
  {
    name: 'triage',
    title: 'Triage inbox',
    description: 'Clean up untriaged work.',
    arguments: [{ name: 'project', description: 'Project key or name. Leave it out for the whole workspace.', required: false }],
    build: (args: Record<string, string>) =>
      `List tasks in ${inScope(args.project)} that are unassigned or have priority "none". For each, suggest a priority, an owner from list_members, and a label. Present a table first and only apply changes with update_task after I confirm.`,
  },
];

/* ------------------------------------------------------------- JSON-RPC */

const toolList = () =>
  TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.schema,
    annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: tool.name === 'delete_task' },
  }));

/**
 * The pages a client may attach, across every workspace this token can reach.
 *
 * Not one workspace. This listed `defaultWorkspace ?? the first membership`,
 * which for an unpinned token means whichever workspace happened to come back
 * first — so somebody in two of them saw one's pages in the picker and no way
 * to ask for the other's. Every tool takes `workspace_id` and can be pointed
 * somewhere else; a resource list takes no arguments, so what it omits is
 * simply unreachable from that menu.
 *
 * `readResource` already allowed any workspace in `memberships`, so those pages
 * were readable by URI the whole time and only missing from the list. Listed
 * and readable disagreeing is the part that made this a bug rather than a
 * default.
 *
 * A token pinned to one workspace still sees only that one — that pin is a
 * boundary somebody set on purpose, not a default to widen.
 */
function resourceList(ctx: McpCtx) {
  const workspaces = ctx.defaultWorkspace ? [ctx.defaultWorkspace] : [...ctx.auth.memberships.keys()];
  if (!workspaces.length) return [];
  const pages = all<Row>(
    `SELECT p.id, p.title, p.icon, w.name AS workspace FROM pages p JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.workspace_id IN (${holes(workspaces.length)}) AND p.deleted_at IS NULL AND p.archived = 0
        AND (p.access <> 'private' OR p.created_by = ?)
      ORDER BY p.updated_at DESC LIMIT 100`,
    ...workspaces, ctx.auth.userId,
  );
  // The workspace named only when there is more than one to confuse: two pages
  // called "Notes" in a flat list are otherwise the same row twice.
  const many = workspaces.length > 1;
  return pages.map((page) => ({
    uri: `kolibri://page/${page.id}`,
    name: String(page.title),
    title: `${page.icon ?? '📄'} ${page.title}${many ? ` — ${page.workspace}` : ''}`,
    mimeType: 'text/markdown',
  }));
}

function readResource(uri: string, ctx: McpCtx) {
  const match = /^kolibri:\/\/(page|task)\/(.+)$/.exec(uri);
  if (!match) throw new McpError(`Unsupported resource ${uri}`);
  const [, kind, id] = match;
  if (kind === 'page') {
    const page = read('page', id);
    if (!page || !ctx.auth.memberships.has(page.workspace_id as string)) throw new McpError('Page not found');
    return [{ uri, mimeType: 'text/markdown', text: `# ${page.title}\n\n${page.content}` }];
  }
  const task = read('task', id);
  if (!task || !ctx.auth.memberships.has(task.workspace_id as string)) throw new McpError('Task not found');
  return [{ uri, mimeType: 'text/markdown', text: `# ${task.identifier} ${task.title}\n\n${task.description ?? ''}` }];
}

export async function handleRpc(request: RpcRequest, ctx: McpCtx): Promise<Record<string, unknown> | null> {
  const { method, id } = request;
  const params = request.params ?? {};
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });

  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false }, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Kolibri is a project and task tracker. Tasks are addressed by identifier (e.g. WEB-12) or id. ' +
            'Prefer list_tasks/project_status to understand state before writing, and confirm destructive changes with the user.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolList() });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) throw new McpError(`Unknown tool ${params.name}`);
        const result = await tool.run((params.arguments ?? {}) as Record<string, any>, ctx);
        return ok({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result },
        });
      }
      case 'resources/list':
        return ok({ resources: resourceList(ctx) });
      case 'resources/read':
        return ok({ contents: readResource(String(params.uri ?? ''), ctx) });
      case 'prompts/list':
        return ok({ prompts: PROMPTS.map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a })) });
      case 'prompts/get': {
        const prompt = PROMPTS.find((p) => p.name === params.name);
        if (!prompt) throw new McpError(`Unknown prompt ${params.name}`);
        return ok({
          description: prompt.description,
          messages: [{ role: 'user', content: { type: 'text', text: prompt.build((params.arguments ?? {}) as Record<string, string>) } }],
        });
      }
      default:
        if (method?.startsWith('notifications/')) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    const code = err instanceof McpError ? err.code : -32603;
    const message = err instanceof Error ? err.message : 'Internal error';
    if (id === undefined || id === null) return null;
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

export const toolNames = (): string[] => TOOLS.map((t) => t.name);
export type { EntityName };

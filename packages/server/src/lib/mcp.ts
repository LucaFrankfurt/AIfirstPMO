/**
 * Model Context Protocol server.
 *
 * Kolibri speaks MCP natively so an assistant can run the board: read the
 * backlog, file issues, move them, write pages. It is a plain JSON-RPC 2.0
 * handler — the HTTP route and the stdio bridge in `packages/mcp` both call
 * `handleRpc`, so tools only exist in one place.
 */
import {
  PRIORITIES, PROJECT_STATUS, RELATION_KINDS, STATE_GROUPS, fieldValueId, orderKey, parseDuration,
  parseQuickAdd, readFieldValue, writeFieldValue,
  type EntityName, type ProjectStatus, type RelationKind, type StateGroup, type Vocabulary,
} from '@kolibri/shared';
import { all, get, tx, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import type { Auth } from './auth.ts';
import { createProject, serverClock } from './bootstrap.ts';
import { instantiateTemplate } from './automation.ts';
import { hasFeature } from './features.ts';
import { canSeeProject, deleteEntity, read, serialize, visibleProjectIds, withEffectsHeld, writeEntity } from './repo.ts';
import { storeFile } from '../routes/files.ts';
import { searchWorkspace } from '../routes/search.ts';
import { uid } from './ids.ts';

export const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'kolibri', title: 'Kolibri', version: '0.1.0' };

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: Record<string, unknown>;
  readOnly?: boolean;
  /**
   * May return a promise. Almost none do — every tool here reads and writes
   * SQLite, which `node:sqlite` does synchronously — but `upload_attachment`
   * puts bytes in a store that may be an object store across a network, and
   * one tool that has to wait is enough to make the whole path awaitable.
   */
  run: (args: Record<string, any>, ctx: McpCtx) => unknown | Promise<unknown>;
}

export interface McpCtx {
  auth: Auth;
  /** Workspace the token is pinned to, if any. */
  defaultWorkspace: string | null;
}

class McpError extends Error {
  code: number;

  constructor(message: string, code = -32602) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ helpers */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function workspaceOf(args: Record<string, any>, ctx: McpCtx): string {
  const explicit = str(args.workspace_id) ?? ctx.defaultWorkspace ?? undefined;
  if (explicit) {
    if (!ctx.auth.memberships.has(explicit)) throw new McpError(`Not a member of workspace ${explicit}`);
    return explicit;
  }
  const first = [...ctx.auth.memberships.keys()][0];
  if (!first) throw new McpError('This account has no workspace yet');
  return first;
}

/**
 * Accepts an id or a human identifier such as `KOL-42`.
 *
 * Both branches are scoped to the workspace, and the second one is why. An
 * identifier is only meaningful inside a workspace, so that lookup was always
 * scoped; a uuid is meaningful everywhere, and looking one up unscoped turned
 * "I know a task's id" into "I may have that task". The guard underneath
 * refuses it now too — this is the belt to that pair of braces, and it belongs
 * here because a query for a row in another workspace is already wrong before
 * anybody asks who is calling.
 */
function findTask(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(ref)
    ? get<Row>(`SELECT * FROM tasks WHERE workspace_id = ? AND identifier = ? AND deleted_at IS NULL`, workspaceId, ref.toUpperCase())
    : get<Row>(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceId, ref);
  if (!row) throw new McpError(`Task ${ref} not found`);
  if (!canSeeProject(ctx.auth.userId, row.project_id)) throw new McpError('That project is private');
  return row;
}

function findProject(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = get<Row>(
    `SELECT * FROM projects WHERE workspace_id = ? AND (id = ? OR key = ? OR lower(name) = lower(?)) AND deleted_at IS NULL`,
    workspaceId, ref, ref.toUpperCase(), ref,
  );
  if (!row) throw new McpError(`Project ${ref} not found`);
  if (!canSeeProject(ctx.auth.userId, row.id)) throw new McpError('That project is private');
  return row;
}

/**
 * The projects a report may read, and the workspace they are in.
 *
 * Every analysis tool below answers for one project when given one and for the
 * whole workspace when not — and every one of them has to drop the private
 * projects this token cannot see. Resolving that once is what stops six tools
 * disagreeing about it: a report that leaks a single row of a private project
 * has leaked it, however small the row and however aggregate the number it
 * was hiding in.
 */
function reportScope(
  args: Record<string, any>,
  ctx: McpCtx,
): { workspaceId: string; projectIds: string[]; project: Row | null } {
  const workspaceId = workspaceOf(args, ctx);
  const ref = str(args.project);
  // `findProject` refuses a project this token cannot see, so the single-project
  // path needs no second check.
  if (ref) {
    const project = findProject(ref, workspaceId, ctx);
    return { workspaceId, projectIds: [String(project.id)], project };
  }
  return {
    workspaceId,
    projectIds: [...visibleProjectIds(ctx.auth.userId, workspaceId)],
    project: null,
  };
}

/** `?, ?, ?` for an `IN` list. Never called with zero — see `reportScope` users. */
const holes = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * A window in whole days, clamped.
 *
 * Unbounded, `days` is a way to ask one SQLite process to walk every activity
 * a workspace has ever recorded. A year is past the point where anybody is
 * reading the answer rather than skimming it.
 */
function windowDays(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.min(365, Math.max(1, n));
}

/**
 * The compact shape reports return, small enough to put fifty of in one answer.
 *
 * `names` is passed in rather than looked up here: a report resolves every
 * assignee it is about in one query, where doing it per row would be one query
 * per task. Without it the ids still come back — a report is not worth failing
 * over a missing name — but an assistant asked to write a standup can only
 * quote a uuid, which is the same as not knowing who.
 */
const brief = (row: Row, names: Record<string, string> = {}) => {
  const assignees = safeList(row.assignees);
  return {
    identifier: row.identifier,
    title: row.title,
    state: row.state_name ?? get<Row>(`SELECT name FROM states WHERE id = ?`, row.state_id)?.name ?? null,
    priority: row.priority,
    assignees,
    assignee_names: assignees.map((id) => names[id] ?? id),
    due_date: row.due_date ?? null,
    estimate: row.estimate ?? null,
    url: `${env.publicUrl}/t/${row.id}`,
  };
};

/** Every assignee across a set of rows, resolved in one query. */
const assigneeNames = (rows: Row[]): Record<string, string> => namesOf(rows.flatMap((r) => safeList(r.assignees)));

/** Names for a list of user ids, so a report reads as people rather than uuids. */
function namesOf(ids: string[]): Record<string, string> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const rows = all<Row>(`SELECT id, name, email FROM users WHERE id IN (${holes(unique.length)})`, ...unique);
  return Object.fromEntries(rows.map((r) => [String(r.id), String(r.name || r.email || r.id)]));
}

/**
 * File one task, from the arguments `create_task` takes.
 *
 * Shared with `create_tasks_batch` so the two cannot drift: a batch that
 * quietly ignored `quick_add`, or resolved labels differently, would be the
 * same tool with different rules depending on how many tasks you asked for.
 *
 * `fallbackProject` is what the batch passes down — the project named once for
 * the whole call, which each entry may still override.
 */
function fileTask(
  args: Record<string, any>,
  workspaceId: string,
  ctx: McpCtx,
  fallbackProject?: string,
  /**
   * Threaded through by `create_tasks_batch`, per project, so a list arrives
   * in the order it was given. A single create places the new task at the top
   * of the board; each entry of a batch doing that landed the whole batch
   * *reversed*, because every insert became the top the next insert went
   * above. The chain keeps the batch as a block at the top, in order: the
   * first entry takes the old top as its bound, and each later one slots
   * between its predecessor and that same bound.
   */
  order?: Map<string, { prev: string | null; bound: string | null }>,
): Row {
  const quick = str(args.quick_add) ? parseQuickAdd(String(args.quick_add), vocabularyFor(workspaceId)) : null;
  const title = (quick?.title ?? str(args.title) ?? '').trim();
  if (!title) throw new McpError('A task needs a title — pass `title`, or a `quick_add` line with words in it', -32602);
  const named = quick?.projectId ?? str(args.project) ?? fallbackProject;
  if (!named) throw new McpError('Which project? Pass `project`, or name one in `quick_add` with #KEY', -32602);
  const project = findProject(named, workspaceId, ctx);
  const state = resolveState(project.id, str(args.state));
  const parent = args.parent ? findTask(String(args.parent), workspaceId, ctx) : undefined;

  let sort: string;
  const anchor = order?.get(project.id);
  if (anchor) {
    sort = orderKey(anchor.prev, anchor.bound);
    anchor.prev = sort;
  } else {
    const first = get<Row>(
      `SELECT sort_order FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`,
      project.id,
    );
    sort = orderKey(null, first?.sort_order ?? null);
    order?.set(project.id, { prev: sort, bound: first?.sort_order ?? null });
  }

  const { row } = writeEntity('task', uid(), {
    workspace_id: workspaceId,
    project_id: project.id,
    title: title.slice(0, 500),
    description: str(args.description) ?? null,
    state_id: state?.id,
    priority: quick?.priority ?? (PRIORITIES.includes(args.priority) ? args.priority : 'none'),
    assignees: quick?.assignees.length ? quick.assignees : resolveUsers(workspaceId, args.assignees),
    labels: quick?.labels.length ? quick.labels : resolveLabels(workspaceId, project.id, args.labels, ctx),
    // Validated here and not only in update_cycle: every date comparison in
    // the app — `due_before`, the overdue lists, `date('now')` in SQL — is a
    // string comparison, where a malformed date sorts wrongly instead of
    // failing. Quick-add dates arrive already normalised by the parser.
    due_date: quick?.dueDate ?? isoDay(args.due_date, 'due_date'),
    recurrence: quick?.recurrence ?? null,
    estimate: typeof args.estimate === 'number' ? args.estimate : null,
    parent_id: parent?.id ?? null,
    cycle_id: str(args.cycle) ? resolveCycle(workspaceId, String(args.cycle))?.id ?? null : null,
    sort_order: sort,
  }, writeOpts(workspaceId, ctx));
  return row;
}

/**
 * A content type from a file name, for callers that did not say.
 *
 * Deliberately short. Guessing wrong is cheap — the type only decides whether a
 * browser renders the file in place or downloads it, and `disposition()` in
 * `mime.ts` already refuses to render anything outside its allowlist — so this
 * covers what an assistant actually produces and lets everything else be an
 * honest `application/octet-stream`.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  html: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  pdf: 'application/pdf', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
};

const mimeFromName = (name: string): string =>
  MIME_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * A colour Kolibri is willing to store.
 *
 * Everything that paints one — the state dot, the label chip, the board column
 * — writes it straight into a `style`, and the interface only ever produces
 * `#rrggbb` because it uses `<input type="color">`. A caller typing prose into
 * the field would put that prose in the stylesheet, so this is checked rather
 * than trusted.
 */
const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function colour(value: unknown, field = 'color'): string | undefined {
  const raw = str(value);
  if (raw === undefined) return undefined;
  if (!HEX_COLOUR.test(raw)) throw new McpError(`\`${field}\` must be a hex colour like #3b82f6, not "${raw}"`);
  return raw.toLowerCase();
}

/**
 * A state group, spelled the way this codebase spells it.
 *
 * `cancelled`, with two Ls. The American spelling is accepted because it is the
 * obvious thing to type and the alternative is storing a value that nothing
 * matches: every "what is finished" count in Kolibri — the board, the project
 * digest, the cycle burn-down, `list_tasks`, the label counts — is
 * `group_key IN ('completed','cancelled')`. A state written as `canceled`
 * would look right in the settings screen and be silently absent from all of
 * them.
 *
 * `backlog` is here too. It is one of the five the app has and the group its
 * own first column belongs to, so leaving it out would make the default column
 * the one kind of column MCP could not create.
 */
function stateGroup(value: unknown, required: boolean): StateGroup | undefined {
  const raw = str(value)?.toLowerCase();
  if (raw === undefined) {
    if (required) throw new McpError(`\`group\` is required — one of: ${STATE_GROUPS.join(', ')}`);
    return undefined;
  }
  const spelled = (raw === 'canceled' ? 'cancelled' : raw) as StateGroup;
  if (!STATE_GROUPS.includes(spelled)) {
    throw new McpError(`Unknown group "${value}". One of: ${STATE_GROUPS.join(', ')}`);
  }
  return spelled;
}

/**
 * What a cycle's status may say.
 *
 * Not in `@kolibri/shared` because nothing else has an opinion about it — the
 * column is written by this tool and read by nobody, which the tool's own note
 * explains. It lives here until something in the app depends on it, at which
 * point it belongs next to `PROJECT_STATUS`.
 */
const CYCLE_STATUS = ['upcoming', 'active', 'completed', 'archived'] as const;

/**
 * A cycle the caller may see, by id or by name.
 *
 * `resolveCycle` also understands `"current"`, which is worked out from the
 * dates — so "update the current cycle" means what somebody would expect it to
 * mean without them having to look the id up first.
 */
function findCycle(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = resolveCycle(workspaceId, ref);
  if (!row) throw new McpError(`Cycle ${ref} not found`);
  if (!canSeeProject(ctx.auth.userId, row.project_id)) throw new McpError('That project is private');
  return row;
}

/** One label, the same shape from every tool that returns one. */
const labelView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  name: String(row.name),
  color: row.color ?? null,
  description: row.description ?? null,
  // Null means every project in the workspace may use it.
  project_id: row.project_id ?? null,
});

/** One cycle, as `list_cycles` and the writers both report it. */
const cycleView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  project_id: String(row.project_id),
  name: String(row.name),
  description: row.description ?? null,
  start_date: row.start_date ?? null,
  end_date: row.end_date ?? null,
  status: row.status ?? null,
});

/**
 * A date, as the rest of the app stores one.
 *
 * Every date column here is a `YYYY-MM-DD` string compared with `date('now')`
 * in SQL, so anything else — a timestamp, `"next friday"`, an ISO datetime —
 * sorts and compares wrongly rather than failing. Cheaper to refuse it.
 */
function isoDay(value: unknown, field: string): string | null {
  const raw = str(value);
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new McpError(`\`${field}\` must be YYYY-MM-DD, not "${raw}"`);
  if (Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new McpError(`\`${field}\` is not a real date: "${raw}"`);
  return raw;
}

/** One state, the same shape wherever it is returned. */
const stateView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  project_id: String(row.project_id),
  name: String(row.name),
  group: String(row.group_key),
  color: row.color ?? null,
  wip_limit: Number(row.wip_limit ?? 0),
});

/** A state in a project the caller may see. */
function findState(id: string, workspaceId: string, ctx: McpCtx): Row {
  const row = get<Row>(`SELECT * FROM states WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, id, workspaceId);
  if (!row) throw new McpError(`State ${id} not found`);
  if (!canSeeProject(ctx.auth.userId, row.project_id)) throw new McpError('That project is private');
  return row;
}

/**
 * A page the caller may see, by id or exact title.
 *
 * The same rule `get_page` applies, in one place, because `list_attachments`
 * shipped without it: the page branch checked only workspace and not-deleted,
 * so the files on a private page — names, sizes and working URLs — were
 * listable by anybody in the workspace who could not read the page itself.
 */
function findPage(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const page = get<Row>(
    `SELECT * FROM pages WHERE workspace_id = ? AND (id = ? OR lower(title) = lower(?)) AND deleted_at IS NULL LIMIT 1`,
    workspaceId, ref, ref,
  );
  if (!page) throw new McpError(`Page ${ref} not found`);
  if (page.access === 'private' && page.created_by !== ctx.auth.userId) throw new McpError('That page is private');
  return page;
}

/** A label in this workspace, by id or by name. */
function findLabel(ref: string, workspaceId: string): Row {
  const row = get<Row>(
    `SELECT * FROM labels WHERE workspace_id = ? AND deleted_at IS NULL AND (id = ? OR lower(name) = lower(?)) LIMIT 1`,
    workspaceId, ref, ref,
  );
  if (!row) throw new McpError(`Label ${ref} not found`);
  return row;
}

/**
 * The other side of a relation.
 *
 * Mirrors `INVERSE` in the web client's `Relations.tsx`. Two copies of five
 * pairs is not ideal; `@kolibri/shared` is the better home the day a third
 * caller wants it.
 */
const INVERSE_RELATION: Record<RelationKind, RelationKind> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates_to: 'relates_to',
  duplicates: 'duplicated_by',
  duplicated_by: 'duplicates',
};

/**
 * Would this link close a circle of blockers?
 *
 * The new link says *waiter waits for blocker*. That closes a ring exactly
 * when the blocker already waits, directly or through others, on the waiter —
 * so the walk starts at the **blocker** and follows "waits for" edges looking
 * for the waiter.
 *
 * Written the other way round first, starting at the waiter, which finds
 * nothing: a task about to be given a new blocker is by definition not yet
 * waiting on it, so the search set was empty and every loop was allowed
 * through. The test that caught it builds A → B → C and then asks for C → A.
 *
 * Both stored directions mean the same edge — a `blocks` row from A to B and a
 * `blocked_by` row from B to A both say "B waits for A" — so the walk reads
 * both rather than trusting one convention to have been used throughout.
 *
 * Bounded at 5000 steps. A workspace whose blocking graph is larger than that
 * has a worse problem than this query, and an unbounded walk over a graph that
 * is *already* looped — imported before this check existed — would not return.
 */
function blockingLoop(workspaceId: string, source: Row, target: Row, kind: RelationKind): boolean {
  // Who ends up waiting for whom.
  const waiter = kind === 'blocks' ? String(target.id) : String(source.id);
  const blocker = kind === 'blocks' ? String(source.id) : String(target.id);

  const seen = new Set<string>([blocker]);
  const queue = [blocker];
  let steps = 0;
  while (queue.length && steps++ < 5000) {
    const at = queue.shift() as string;
    if (at === waiter) return true;
    // Everything `at` is already waiting for.
    for (const row of all<Row>(
      `SELECT task_id, related_task_id, kind FROM task_relations
        WHERE workspace_id = ? AND deleted_at IS NULL
          AND ((related_task_id = ? AND kind = 'blocks') OR (task_id = ? AND kind = 'blocked_by'))`,
      workspaceId, at, at,
    )) {
      const upstream = String(row.kind === 'blocks' ? row.task_id : row.related_task_id);
      if (!seen.has(upstream)) {
        seen.add(upstream);
        queue.push(upstream);
      }
    }
  }
  return false;
}

function resolveState(projectId: string, name?: string): Row | undefined {
  if (!name) return undefined;
  return get<Row>(
    `SELECT * FROM states WHERE project_id = ? AND deleted_at IS NULL AND (id = ? OR lower(name) = lower(?) OR group_key = lower(?)) ORDER BY sort_order LIMIT 1`,
    projectId, name, name, name,
  );
}

/**
 * What quick-add syntax can name in this workspace.
 *
 * Read fresh rather than cached: an assistant that just created a project and
 * then files a task into it by key should find it, and a cache that is one call
 * stale would be a bug nobody could reproduce twice.
 */
function vocabularyFor(workspaceId: string): Vocabulary {
  return {
    today: new Date().toISOString().slice(0, 10),
    people: all<Row>(
      `SELECT u.id, u.name FROM users u
         JOIN workspace_members m ON m.user_id = u.id
        WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
      workspaceId,
    ).map((row) => ({ id: String(row.id), name: String(row.name ?? '') })),
    projects: all<Row>(
      // A container holds projects, not tasks, so `#KEY` naming one would file
      // work somewhere it cannot be seen.
      `SELECT id, key, name FROM projects WHERE workspace_id = ? AND deleted_at IS NULL AND is_container = 0`,
      workspaceId,
    ).map((row) => ({ id: String(row.id), key: row.key ? String(row.key) : null, name: String(row.name ?? '') })),
    labels: all<Row>(
      `SELECT id, name FROM labels WHERE workspace_id = ? AND deleted_at IS NULL`,
      workspaceId,
    ).map((row) => ({ id: String(row.id), name: String(row.name ?? '') })),
  };
}

function resolveUsers(workspaceId: string, refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string') continue;
    const user = get<Row>(
      `SELECT u.id FROM users u JOIN workspace_members m ON m.user_id = u.id
        WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND (u.id = ? OR lower(u.email) = lower(?) OR lower(u.name) = lower(?))`,
      workspaceId, ref, ref, ref,
    );
    if (user) out.push(user.id);
  }
  return out;
}

const writeOpts = (workspaceId: string, ctx: McpCtx) => ({
  workspaceId,
  actorId: ctx.auth.userId,
  hlc: serverClock.now(),
  origin: 'mcp',
});

/**
 * May this caller write to this workspace?
 *
 * Two different questions, and both used to be asked only halfway. The scope is
 * the token's: a read-only token is refused whatever its owner may do. The role
 * is the person's, and it was not being asked at all — REST refuses a guest
 * with "Guests cannot create content" on every content write, but a guest
 * could mint themselves a write-scoped token (tokens only require membership)
 * and walk straight past that through MCP. The two doors now agree.
 *
 * Takes the workspace because a role is per workspace; every write tool
 * resolves it first anyway.
 */
function requireWrite(ctx: McpCtx, workspaceId: string): void {
  if (!ctx.auth.scopes.has('write')) throw new McpError('This token is read-only', -32000);
  const role = ctx.auth.memberships.get(workspaceId);
  if (role === 'guest') throw new McpError('Guests cannot create content', -32000);
}

/**
 * A feature the workspace has not switched on is not a tool that half works.
 *
 * An assistant that logs time into a workspace where nobody can see it has
 * done something worse than refuse: the row exists, the person who asked
 * believes it was recorded, and no screen will ever show it.
 */
function requireFeature(workspaceId: string, name: 'time'): void {
  if (!hasFeature(workspaceId, name)) {
    throw new McpError('Time tracking is switched off in this workspace (Settings → Workspace)', -32000);
  }
}

/** A JSON column read straight from SQLite, without trusting it to be valid. */
const safeList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const taskView = (row: Row) => ({
  id: row.id,
  identifier: row.identifier,
  title: row.title,
  state: get<Row>(`SELECT name, group_key FROM states WHERE id = ?`, row.state_id)?.name ?? null,
  priority: row.priority,
  assignees: JSON.parse(row.assignees ?? '[]'),
  labels: JSON.parse(row.labels ?? '[]'),
  due_date: row.due_date,
  estimate: row.estimate,
  cycle_id: row.cycle_id,
  module_id: row.module_id,
  parent_id: row.parent_id,
  project_id: row.project_id,
  updated_at: row.updated_at,
  url: `${env.publicUrl}/t/${row.id}`,
});

/**
 * Answers to a project's own fields, addressed by name because a name is what
 * an assistant has been told. An unknown name is an error rather than a silent
 * no-op: a rule that quietly writes nothing is worse than one that complains.
 */
function writeCustomFields(task: Row, answers: Record<string, unknown>, workspaceId: string, ctx: McpCtx): void {
  const fields = all<Row>(
    `SELECT * FROM custom_fields WHERE project_id = ? AND deleted_at IS NULL AND archived = 0`,
    task.project_id,
  );
  for (const [name, value] of Object.entries(answers)) {
    const field = fields.find((f) => String(f.name).toLowerCase() === name.toLowerCase() || f.id === name);
    if (!field) throw new McpError(`No field called "${name}" in this project`);
    writeEntity(
      'fieldValue',
      fieldValueId(String(task.id), String(field.id)),
      {
        project_id: task.project_id,
        task_id: task.id,
        field_id: field.id,
        value: writeFieldValue(field.kind, value),
      },
      writeOpts(workspaceId, ctx),
    );
  }
}

/* -------------------------------------------------------------------- tools */

const TOOLS: ToolDef[] = [
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
    name: 'list_tasks',
    title: 'List tasks',
    description: 'Query tasks by project, state, state group, assignee, priority, cycle, label or free text.',
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
    description: 'Change any field of a task: title, description, state, priority, assignees, dates, cycle, parent.',
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
    /**
     * Put a file on a task.
     *
     * The gap this closes is not a convenience. An assistant could already
     * write a task, comment on it and move it, but anything it *produced* — a
     * CSV, a screenshot, a generated report — had nowhere to go except pasted
     * into a comment as text. Everything else in Kolibri that carries a file
     * hangs off the attachment row this writes, so a file put here appears in
     * the task's own Files section rather than in a place only an assistant
     * knows about.
     *
     * Base64 because MCP carries JSON. That is a real cost — the encoding adds
     * a third again, and the whole thing is a string in memory on both sides —
     * so the limit below is enforced against the *decoded* size, and checked
     * before decoding rather than after.
     */
    name: 'upload_attachment',
    title: 'Attach a file to a task',
    description: "Upload a file and attach it to a task, where it appears in the task's Files section. Content is base64. Use this for anything you have produced — a report, an export, an image — rather than pasting it into a comment.",
    schema: {
      type: 'object',
      required: ['task', 'name', 'content_base64'],
      properties: {
        task: { type: 'string', description: 'Task id or identifier, e.g. WEB-12' },
        name: { type: 'string', description: 'File name as it should appear, e.g. "burndown.csv"' },
        content_base64: { type: 'string', description: 'The file, base64 encoded' },
        mime: {
          type: 'string',
          description: 'Content type, e.g. text/csv. Guessed from the file name when omitted.',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: async (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const task = findTask(String(args.task), workspaceId, ctx);

      const name = str(args.name);
      if (!name) throw new McpError('A file needs a name');
      const encoded = typeof args.content_base64 === 'string' ? args.content_base64.trim() : '';
      if (!encoded) throw new McpError('`content_base64` is empty');

      /*
       * Refuse an oversized upload before decoding it, not after.
       *
       * Base64 is four characters for every three bytes, so the decoded length
       * is knowable from the string. Decoding first to measure would mean
       * allocating the very buffer the limit exists to prevent — a 200 MB
       * string against a 25 MB limit would be rejected, having already been
       * held in memory twice.
       */
      const approx = Math.floor((encoded.length * 3) / 4);
      if (approx > env.maxUploadBytes) {
        throw new McpError(
          `That file is about ${Math.round(approx / 1024 / 1024)} MB and the limit is ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB`,
        );
      }

      /*
       * And check that it really is base64.
       *
       * `Buffer.from(x, 'base64')` never fails: it skips anything outside the
       * alphabet and stops at the first byte it cannot use. Hand it a JSON
       * document by mistake and it returns a short buffer of nonsense, which
       * would be stored, attached, and downloaded later as a corrupt file with
       * nothing anywhere saying so.
       */
      if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
        throw new McpError('`content_base64` is not base64 — send the file encoded, not as raw text');
      }
      const body = Buffer.from(encoded, 'base64');
      if (!body.length) throw new McpError('That decodes to no bytes at all');
      if (body.length > env.maxUploadBytes) {
        throw new McpError(`That file is larger than the ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB limit`);
      }

      const stored = await storeFile({
        workspaceId,
        userId: ctx.auth.userId,
        name,
        mime: str(args.mime) ?? mimeFromName(name),
        body,
        taskId: String(task.id),
      });

      return {
        task: task.identifier,
        name: stored.name,
        mime: stored.mime,
        size: stored.size,
        url: stored.url,
        attachment: stored.attachment,
      };
    },
  },
  {
    /**
     * What is already attached, and where to fetch it.
     *
     * `page` as well as `task`, because the model hangs attachments off either
     * and a tool that could only see half of them would send an assistant
     * looking for a file that is plainly there.
     *
     * The URL is the same one the interface uses and needs the same
     * credentials — it is not a public link, and an object-store deployment
     * turns it into a short-lived signed one at the moment it is followed.
     */
    name: 'list_attachments',
    title: 'List attachments',
    description: "Files attached to a task or a page, with the URL to fetch each. The URL needs the same authorisation as this call — it is not a public link.",
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task id or identifier' },
        page: { type: 'string', description: 'Page id — give this or `task`, not both' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const taskRef = str(args.task);
      const pageRef = str(args.page);
      if (!taskRef && !pageRef) throw new McpError('Which one? Pass `task` or `page`');
      if (taskRef && pageRef) throw new McpError('Pass `task` or `page`, not both');

      // Both branches carry the owner's access rule: a private task's project
      // and a private page refuse here exactly as get_task and get_page do —
      // an attachment listing is the page's content with a download URL on it.
      const where: [string, string] = taskRef
        ? ['task_id', String(findTask(taskRef, workspaceId, ctx).id)]
        : ['page_id', String(findPage(String(pageRef), workspaceId, ctx).id)];

      return all<Row>(
        `SELECT * FROM attachments WHERE workspace_id = ? AND ${where[0]} = ? AND deleted_at IS NULL ORDER BY created_at`,
        workspaceId, where[1],
      ).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        mime: row.mime ?? null,
        size: Number(row.size ?? 0),
        url: row.url ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        uploaded_by: row.uploaded_by ?? null,
        created_at: Number(row.created_at ?? 0),
      }));
    },
  },
  {
    /**
     * Detach a file.
     *
     * This removes the attachment — the row that puts the file on the task —
     * and not the bytes. Storage is content-addressed and shared: the same
     * bytes uploaded to two workspaces are one blob with two rows, so deleting
     * the blob here would take the file out from under somebody else. Sweeping
     * blobs that no row points at any more is a separate job, and deliberately
     * not this one.
     *
     * Soft, like every other delete here: it goes to the trash and can be
     * restored.
     */
    name: 'delete_attachment',
    title: 'Delete attachment',
    description: 'Remove a file from the task or page it is attached to. Soft — it goes to the trash and can be restored. The stored bytes are shared and are not deleted.',
    schema: {
      type: 'object',
      required: ['attachment_id'],
      properties: {
        attachment_id: { type: 'string', description: 'From list_attachments' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const row = get<Row>(
        `SELECT * FROM attachments WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        String(args.attachment_id), workspaceId,
      );
      if (!row) throw new McpError(`Attachment ${args.attachment_id} not found`);
      // An attachment inherits the privacy of whatever it hangs on — and it can
      // hang on a task, a page, or a comment (which itself hangs on one of the
      // other two). Checking only the task branch left files on private pages
      // deletable by people who could not read the page.
      if (row.task_id) findTask(String(row.task_id), workspaceId, ctx);
      if (row.page_id) findPage(String(row.page_id), workspaceId, ctx);
      if (row.comment_id) {
        const comment = get<Row>(`SELECT task_id, page_id FROM comments WHERE id = ?`, row.comment_id);
        if (comment?.task_id) findTask(String(comment.task_id), workspaceId, ctx);
        if (comment?.page_id) findPage(String(comment.page_id), workspaceId, ctx);
      }

      deleteEntity('attachment', String(row.id), writeOpts(workspaceId, ctx));
      return { deleted: String(row.name), id: String(row.id) };
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
  {
    name: 'list_cycles',
    title: 'List cycles',
    description: 'Sprints/cycles of a project with progress counts.',
    readOnly: true,
    schema: { type: 'object', properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      return all<Row>(
        `SELECT * FROM cycles WHERE workspace_id = ? ${project ? 'AND project_id = ?' : ''} AND deleted_at IS NULL ORDER BY start_date DESC`,
        ...(project ? [workspaceId, project.id] : [workspaceId]),
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
    description: 'Create a sprint/cycle for a project.',
    schema: {
      type: 'object',
      required: ['project', 'name'],
      properties: {
        project: { type: 'string' }, name: { type: 'string' },
        start_date: { type: 'string' }, end_date: { type: 'string' },
        description: { type: 'string' }, workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = findProject(String(args.project), workspaceId, ctx);
      const { row } = writeEntity('cycle', uid(), {
        workspace_id: workspaceId, project_id: project.id, name: String(args.name),
        description: str(args.description) ?? null, start_date: str(args.start_date) ?? null, end_date: str(args.end_date) ?? null,
      }, writeOpts(workspaceId, ctx));
      return serialize('cycle', row);
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
    description: "Change a cycle's name, dates, description or status. Note that which cycle is *current* is worked out from the dates rather than the status — the status is recorded but nothing reads it yet.",
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
      if (!Object.keys(patch).length) {
        throw new McpError('Nothing to change — pass name, start_date, end_date, description or status');
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
      return cycleView(row);
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
  {
    name: 'list_pages',
    title: 'List pages',
    description: 'List wiki pages, optionally scoped to a project.',
    readOnly: true,
    schema: { type: 'object', properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      return all<Row>(
        `SELECT id, title, icon, project_id, parent_id, updated_at, created_by FROM pages
          WHERE workspace_id = ? ${project ? 'AND project_id = ?' : ''} AND deleted_at IS NULL AND archived = 0
            AND (access <> 'private' OR created_by = ?)
          ORDER BY updated_at DESC LIMIT 200`,
        ...(project ? [workspaceId, project.id, ctx.auth.userId] : [workspaceId, ctx.auth.userId]),
      );
    },
  },
  {
    name: 'get_page',
    title: 'Get page',
    description: 'Read a wiki page by id or exact title, including its markdown body.',
    readOnly: true,
    schema: { type: 'object', required: ['page'], properties: { page: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const page = findPage(String(args.page), workspaceId, ctx);
      return serialize('page', page);
    },
  },
  {
    name: 'create_page',
    title: 'Create page',
    description: 'Create a wiki page from markdown.',
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' }, content: { type: 'string' }, project: { type: 'string' },
        parent: { type: 'string' }, icon: { type: 'string' }, workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const { row } = writeEntity('page', uid(), {
        workspace_id: workspaceId,
        project_id: project?.id ?? null,
        parent_id: str(args.parent) ?? null,
        title: String(args.title),
        icon: str(args.icon) ?? '📄',
        content: String(args.content ?? ''),
        created_by: ctx.auth.userId,
      }, writeOpts(workspaceId, ctx));
      return serialize('page', row);
    },
  },
  {
    name: 'update_page',
    title: 'Update page',
    description: 'Replace or append to a page body. The previous revision is kept in the page history.',
    schema: {
      type: 'object',
      required: ['page'],
      properties: {
        page: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
        append: { type: 'string', description: 'Markdown appended to the end instead of replacing' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const page = get<Row>(
        `SELECT * FROM pages WHERE workspace_id = ? AND (id = ? OR lower(title) = lower(?)) AND deleted_at IS NULL LIMIT 1`,
        workspaceId, args.page, args.page,
      );
      if (!page) throw new McpError(`Page ${args.page} not found`);
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.content !== undefined) patch.content = String(args.content);
      if (args.append) patch.content = `${page.content ?? ''}\n\n${args.append}`;
      const { row } = writeEntity('page', page.id, patch, writeOpts(workspaceId, ctx));
      return serialize('page', row);
    },
  },
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
    name: 'project_status',
    title: 'Project status report',
    description: 'A digest for standups and reports: counts by state group and priority, overdue items, recent activity and the active cycle.',
    readOnly: true,
    schema: { type: 'object', required: ['project'], properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = findProject(String(args.project), workspaceId, ctx);
      const byGroup = all<Row>(
        `SELECT s.group_key, count(*) AS count FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.archived = 0 GROUP BY s.group_key`,
        project.id,
      );
      const byPriority = all<Row>(
        `SELECT priority, count(*) AS count FROM tasks
          WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 GROUP BY priority`,
        project.id,
      );
      return {
        project: { id: project.id, key: project.key, name: project.name, status: project.status, target_date: project.target_date },
        by_state_group: Object.fromEntries(byGroup.map((r) => [r.group_key, Number(r.count)])),
        by_priority: Object.fromEntries(byPriority.map((r) => [r.priority, Number(r.count)])),
        overdue: all<Row>(
          `SELECT t.* FROM tasks t JOIN states s ON s.id = t.state_id
            WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < date('now')
              AND s.group_key NOT IN ('completed','cancelled') ORDER BY t.due_date LIMIT 25`,
          project.id,
        ).map(taskView),
        unassigned: Number(get<Row>(
          `SELECT count(*) c FROM tasks WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND assignees = '[]'`,
          project.id,
        )?.c ?? 0),
        active_cycle: get<Row>(
          `SELECT id, name, start_date, end_date FROM cycles
            WHERE project_id = ? AND deleted_at IS NULL AND start_date <= date('now') AND end_date >= date('now') LIMIT 1`,
          project.id,
        ) ?? null,
        recent_activity: all<Row>(
          `SELECT a.verb, a.field, a.new_value, a.created_at, u.name AS actor FROM activities a
            LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.project_id = ? ORDER BY a.created_at DESC LIMIT 20`,
          project.id,
        ),
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

  /* ------------------------------------------------------------- reports --
   *
   * Six read-only questions that were answerable before only by pulling the
   * backlog and doing the arithmetic in the model. Each is one query the
   * database is better at, and each returns a *reason* rather than a bare
   * list — "overdue" is a fact anybody can compute, "due Thursday, still in
   * Backlog, nobody on it" is the sentence somebody acts on.
   */

  {
    name: 'changes_since',
    title: 'What changed',
    description:
      'Everything that happened in a window — the last seven days unless told otherwise — grouped by person, by kind of change, and by task. The answer to "what did we get done last week".',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How far back to look. Default 7, clamped to 1–365.' },
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, projectIds, project } = reportScope(args, ctx);
      const days = windowDays(args.days, 7);
      const since = Date.now() - days * 86_400_000;
      const empty = { window_days: days, since: new Date(since).toISOString(), project: project?.key ?? null };
      if (!projectIds.length) return { ...empty, total: 0, by_person: {}, by_kind: {}, completed: [], created: [], busiest_tasks: [] };

      /* Activity with no project is workspace-level — a page outside any
         project, most often — and belongs in a workspace-wide answer and not
         in a project's. */
      const scope = project
        ? { clause: `a.project_id IN (${holes(projectIds.length)})`, params: projectIds }
        : { clause: `(a.project_id IN (${holes(projectIds.length)}) OR a.project_id IS NULL)`, params: projectIds };

      const rows = all<Row>(
        `SELECT a.verb, a.field, a.actor_id, a.task_id, a.created_at
           FROM activities a
          WHERE a.workspace_id = ? AND a.created_at >= ? AND ${scope.clause}
          ORDER BY a.created_at DESC
          LIMIT 5000`,
        workspaceId, since, ...scope.params,
      );

      const tally = (key: (r: Row) => string) => {
        const out: Record<string, number> = {};
        for (const row of rows) {
          const k = key(row);
          if (k) out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      };
      const names = namesOf(rows.map((r) => String(r.actor_id ?? '')));
      const byPerson: Record<string, number> = {};
      for (const [id, count] of Object.entries(tally((r) => String(r.actor_id ?? '')))) {
        byPerson[names[id] ?? 'somebody who has since been removed'] = count;
      }

      // The tasks that moved most — where an assistant should look first.
      const touches = tally((r) => String(r.task_id ?? ''));
      const busiest = Object.entries(touches)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => {
          const task = get<Row>(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`, id);
          return task ? { ...brief(task, names), changes: count } : null;
        })
        .filter(Boolean);

      /* Finished and filed come from the tasks themselves rather than from the
         activity log: a task completed offline syncs with the timestamp of the
         moment it was completed, and counting log rows would date it to when
         the connection came back. */
      const inScope = `project_id IN (${holes(projectIds.length)})`;
      const completed = all<Row>(
        `SELECT * FROM tasks WHERE ${inScope} AND deleted_at IS NULL
           AND completed_at IS NOT NULL AND completed_at >= ?
         ORDER BY completed_at DESC LIMIT 50`,
        ...projectIds, since,
      );
      const created = all<Row>(
        `SELECT * FROM tasks WHERE ${inScope} AND deleted_at IS NULL AND created_at >= ?
         ORDER BY created_at DESC LIMIT 50`,
        ...projectIds, since,
      );
      const taskNames = assigneeNames([...completed, ...created]);
      return {
        ...empty,
        total: rows.length,
        truncated: rows.length === 5000,
        by_person: byPerson,
        by_kind: tally((r) => (r.field ? `${r.verb}:${r.field}` : String(r.verb))),
        completed: completed.map((row) => brief(row, taskNames)),
        created: created.map((row) => brief(row, taskNames)),
        busiest_tasks: busiest,
      };
    },
  },

  {
    name: 'deadlines_at_risk',
    title: 'Deadlines at risk',
    description:
      'Dated work that is unlikely to land, each with the reason: already overdue, waiting on an unfinished blocker, due soon and not started, or due soon with nobody on it. Sorted worst first.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How far ahead to look. Default 14, clamped to 1–365.' },
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { projectIds, project } = reportScope(args, ctx);
      const days = windowDays(args.days, 14);
      if (!projectIds.length) return { horizon_days: days, project: project?.key ?? null, at_risk: [], counts: {} };

      /* Open, dated, and either already past or inside the horizon. `archived`
         is excluded because an archived task is one somebody has decided about;
         its date is a record, not a promise. */
      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name, s.group_key
           FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id IN (${holes(projectIds.length)})
            AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key NOT IN ('completed', 'cancelled')
            AND t.due_date IS NOT NULL
            AND t.due_date <= date('now', '+' || ? || ' days')
          ORDER BY t.due_date`,
        ...projectIds, days,
      );
      if (!rows.length) return { horizon_days: days, project: project?.key ?? null, at_risk: [], counts: {} };

      /* Unfinished blockers, in one query rather than one per task. A `blocks`
         row is stored in one direction only — `task_id` blocks
         `related_task_id` — so the waiting task is the *related* one. */
      const ids = rows.map((r) => String(r.id));
      const blockers = all<Row>(
        `SELECT r.related_task_id AS waiting, b.identifier, b.title, s.name AS state_name
           FROM task_relations r
           JOIN tasks b ON b.id = r.task_id
           JOIN states s ON s.id = b.state_id
          WHERE r.kind = 'blocks' AND r.deleted_at IS NULL
            AND b.deleted_at IS NULL AND s.group_key NOT IN ('completed', 'cancelled')
            AND r.related_task_id IN (${holes(ids.length)})`,
        ...ids,
      );
      const blocking = new Map<string, { identifier: string; title: string; state: string }[]>();
      for (const row of blockers) {
        const list = blocking.get(String(row.waiting)) ?? [];
        list.push({ identifier: String(row.identifier), title: String(row.title), state: String(row.state_name) });
        blocking.set(String(row.waiting), list);
      }

      const today = new Date().toISOString().slice(0, 10);
      const dayMs = 86_400_000;
      const names = assigneeNames(rows);
      const at_risk = rows.map((row) => {
        const due = String(row.due_date);
        const until = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs);
        const assignees = safeList(row.assignees);
        const blocked = blocking.get(String(row.id)) ?? [];

        /* Reasons, most severe first. A task can carry several — "overdue and
           blocked" is a different conversation from either alone, so both are
           reported rather than the first one found. */
        const reasons: string[] = [];
        if (until < 0) reasons.push('overdue');
        if (blocked.length) reasons.push('blocked');
        if (until >= 0 && (row.group_key === 'backlog' || row.group_key === 'unstarted')) reasons.push('not_started');
        if (!assignees.length) reasons.push('unassigned');

        return {
          ...brief(row, names),
          days_until_due: until,
          reasons,
          blocked_by: blocked,
          // A number to sort and threshold on, since "worst" is otherwise a
          // judgement the caller has to re-derive from the reasons.
          severity:
            (until < 0 ? 100 + Math.min(60, -until) : Math.max(0, 40 - until * 2)) +
            (blocked.length ? 25 : 0) +
            (reasons.includes('not_started') ? 15 : 0) +
            (assignees.length ? 0 : 10),
        };
      })
        .filter((t) => t.reasons.length)
        .sort((a, b) => b.severity - a.severity);

      const counts: Record<string, number> = {};
      for (const task of at_risk) for (const reason of task.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
      return { horizon_days: days, project: project?.key ?? null, counts, at_risk };
    },
  },

  {
    name: 'workload',
    title: 'Who is carrying what',
    description:
      'Open work per person: how many tasks, how many overdue, how much is due this week, and the points they add up to. Unassigned work is counted separately rather than hidden.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, projectIds, project } = reportScope(args, ctx);
      if (!projectIds.length) return { project: project?.key ?? null, people: [], unassigned: null };

      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id IN (${holes(projectIds.length)})
            AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key NOT IN ('completed', 'cancelled')`,
        ...projectIds,
      );

      const today = new Date().toISOString().slice(0, 10);
      const weekEnd = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const names = assigneeNames(rows);
      const blank = () => ({ open: 0, overdue: 0, due_this_week: 0, unestimated: 0, points: 0, most_urgent: null as any });
      const buckets = new Map<string, ReturnType<typeof blank>>();
      const unassigned = blank();

      for (const row of rows) {
        const due = row.due_date ? String(row.due_date) : null;
        const assignees = safeList(row.assignees);
        // A task with two people on it counts for both, the way the app's own
        // per-person chart does. The totals therefore exceed the task count,
        // which is the honest answer to "how much is on you".
        for (const target of assignees.length ? assignees.map((id) => {
          if (!buckets.has(id)) buckets.set(id, blank());
          return buckets.get(id)!;
        }) : [unassigned]) {
          target.open += 1;
          if (due && due < today) target.overdue += 1;
          if (due && due >= today && due <= weekEnd) target.due_this_week += 1;
          if (row.estimate == null) target.unestimated += 1;
          else target.points += Number(row.estimate);
          const current = target.most_urgent;
          if (due && (!current?.due_date || due < current.due_date)) target.most_urgent = brief(row, names);
        }
      }

      const people = namesOf([...buckets.keys()]);
      const members = new Set(
        all<Row>(`SELECT user_id FROM workspace_members WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
          .map((r) => String(r.user_id)),
      );
      return {
        project: project?.key ?? null,
        people: [...buckets.entries()]
          .map(([id, stats]) => ({
            user_id: id,
            name: people[id] ?? id,
            // Work still assigned to somebody who has left the workspace is
            // work nobody is doing, and it looks assigned on every board.
            still_a_member: members.has(id),
            ...stats,
          }))
          .sort((a, b) => b.open - a.open),
        unassigned,
      };
    },
  },

  {
    name: 'blocked_tasks',
    title: 'What is waiting on what',
    description:
      'Open work held up by an unfinished blocker, and — separately — links whose blocker is already finished, which are the ones nobody remembers to remove.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { projectIds, project } = reportScope(args, ctx);
      if (!projectIds.length) return { project: project?.key ?? null, blocked: [], stale_links: [] };

      /* Both sides in one query. `w` is the task that waits — a `blocks` row
         reads `task_id` blocks `related_task_id` — and the join to the blocker
         is deliberately not filtered by project: work is routinely held up by
         a task in another project, and dropping those would report the waiting
         task as unblocked. */
      const rows = all<Row>(
        `SELECT w.id AS waiting_id, w.identifier AS waiting, w.title AS waiting_title,
                w.due_date, w.priority, w.assignees, w.estimate, w.state_id,
                b.identifier AS blocker, b.title AS blocker_title, b.due_date AS blocker_due,
                bs.name AS blocker_state, bs.group_key AS blocker_group, r.lag
           FROM task_relations r
           JOIN tasks w ON w.id = r.related_task_id
           JOIN tasks b ON b.id = r.task_id
           JOIN states ws ON ws.id = w.state_id
           JOIN states bs ON bs.id = b.state_id
          WHERE r.kind = 'blocks' AND r.deleted_at IS NULL
            AND w.deleted_at IS NULL AND b.deleted_at IS NULL AND w.archived = 0
            AND ws.group_key NOT IN ('completed', 'cancelled')
            AND w.project_id IN (${holes(projectIds.length)})
          ORDER BY w.due_date IS NULL, w.due_date`,
        ...projectIds,
      );

      const names = assigneeNames(rows);
      const blocked = new Map<string, any>();
      const stale: any[] = [];
      for (const row of rows) {
        const link = {
          identifier: String(row.blocker),
          title: String(row.blocker_title),
          state: String(row.blocker_state),
          due_date: row.blocker_due ?? null,
          lag_days: Number(row.lag ?? 0),
        };
        const done = row.blocker_group === 'completed' || row.blocker_group === 'cancelled';
        if (done) {
          stale.push({ waiting: String(row.waiting), blocker: link });
          continue;
        }
        const entry = blocked.get(String(row.waiting_id)) ?? {
          ...brief({ ...row, id: row.waiting_id, identifier: row.waiting, title: row.waiting_title }, names),
          blocked_by: [] as typeof link[],
        };
        entry.blocked_by.push(link);
        blocked.set(String(row.waiting_id), entry);
      }

      return {
        project: project?.key ?? null,
        blocked: [...blocked.values()],
        // Not an error, and not something to fix automatically — somebody may
        // be about to reopen the blocker. It is a list worth reading.
        stale_links: stale,
      };
    },
  },

  {
    name: 'stale_tasks',
    title: 'Work that has stopped moving',
    description:
      'Tasks sitting in an in-progress state that nothing has touched for a while. The usual causes are work that finished without being marked and work that quietly stopped.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How quiet counts as stale. Default 14, clamped to 1–365.' },
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { projectIds, project } = reportScope(args, ctx);
      const days = windowDays(args.days, 14);
      if (!projectIds.length) return { quiet_for_days: days, project: project?.key ?? null, stale: [] };

      const cutoff = Date.now() - days * 86_400_000;
      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id IN (${holes(projectIds.length)})
            AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key = 'started'
            AND t.updated_at < ?
          ORDER BY t.updated_at
          LIMIT 100`,
        ...projectIds, cutoff,
      );
      const now = Date.now();
      const names = assigneeNames(rows);
      return {
        quiet_for_days: days,
        project: project?.key ?? null,
        stale: rows.map((row) => ({
          ...brief(row, names),
          // `updated_at` is when the change was *made*, not when it synced, so
          // this stays true for work done on a device that was offline.
          silent_days: Math.floor((now - Number(row.updated_at)) / 86_400_000),
        })),
      };
    },
  },

  {
    name: 'cycle_review',
    title: 'How a cycle went',
    description:
      'What a cycle held, what got finished, what did not, and what was added after it started. Defaults to the cycle running now. Retro material rather than a progress bar.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', description: 'Key or name.' },
        cycle: { type: 'string', description: 'Cycle name or id. Default the one running now.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = findProject(String(args.project ?? ''), workspaceId, ctx);

      const ref = str(args.cycle);
      const cycle = ref
        ? get<Row>(
            `SELECT * FROM cycles WHERE project_id = ? AND deleted_at IS NULL AND (id = ? OR lower(name) = lower(?))`,
            project.id, ref, ref,
          )
        : get<Row>(
            `SELECT * FROM cycles WHERE project_id = ? AND deleted_at IS NULL
               AND start_date <= date('now') AND end_date >= date('now') LIMIT 1`,
            project.id,
          );
      if (!cycle) {
        throw new McpError(ref ? `No cycle called "${ref}" in ${project.key}` : `No cycle is running in ${project.key} right now`);
      }

      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name, s.group_key FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.cycle_id = ? AND t.deleted_at IS NULL`,
        cycle.id,
      );
      const done = rows.filter((r) => r.group_key === 'completed');
      const cancelled = rows.filter((r) => r.group_key === 'cancelled');
      const open = rows.filter((r) => r.group_key !== 'completed' && r.group_key !== 'cancelled');
      const points = (list: Row[]) => list.reduce((sum, r) => sum + (r.estimate == null ? 0 : Number(r.estimate)), 0);

      /* Scope added after the window opened. A cycle that grew mid-flight is
         the single most useful thing a retro can be handed, and it is invisible
         on a burn-down — which is why the app draws a burn-*up*. */
      const startedAt = Date.parse(`${String(cycle.start_date)}T00:00:00Z`);
      const addedLate = rows.filter((r) => Number(r.created_at) > startedAt);
      const names = assigneeNames(rows);

      return {
        project: project.key,
        cycle: { id: cycle.id, name: cycle.name, start_date: cycle.start_date, end_date: cycle.end_date },
        finished: cycle.end_date ? String(cycle.end_date) < new Date().toISOString().slice(0, 10) : false,
        totals: {
          tasks: rows.length,
          completed: done.length,
          cancelled: cancelled.length,
          carried: open.length,
          points_planned: points(rows),
          points_completed: points(done),
          unestimated: rows.filter((r) => r.estimate == null).length,
        },
        completed: done.map((row) => brief(row, names)),
        // What has to go somewhere before the cycle closes.
        carried_over: open.map((row) => brief(row, names)),
        cancelled: cancelled.map((row) => brief(row, names)),
        added_after_start: addedLate.map((row) => ({
          ...brief(row, names),
          added_on: new Date(Number(row.created_at)).toISOString().slice(0, 10),
        })),
      };
    },
  },
];

function resolveCycle(workspaceId: string, ref: string): Row | undefined {
  if (ref === 'current') {
    return get<Row>(
      `SELECT * FROM cycles WHERE workspace_id = ? AND deleted_at IS NULL
        AND start_date <= date('now') AND end_date >= date('now') ORDER BY start_date DESC LIMIT 1`,
      workspaceId,
    );
  }
  return get<Row>(`SELECT * FROM cycles WHERE workspace_id = ? AND (id = ? OR lower(name) = lower(?)) AND deleted_at IS NULL`, workspaceId, ref, ref);
}

function resolveLabels(workspaceId: string, projectId: string, refs: unknown, ctx: McpCtx): string[] {
  if (!Array.isArray(refs)) return [];
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const existing = get<Row>(
      `SELECT id FROM labels WHERE workspace_id = ? AND deleted_at IS NULL AND (id = ? OR lower(name) = lower(?))
        AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
      workspaceId, ref, ref, projectId,
    );
    if (existing) {
      out.push(existing.id);
      continue;
    }
    const { row } = writeEntity('label', uid(), { workspace_id: workspaceId, project_id: projectId, name: ref.trim() },
      writeOpts(workspaceId, ctx));
    out.push(row.id);
  }
  return out;
}

const countTasks = (projectId: string, done: boolean): number =>
  Number(get<Row>(
    `SELECT count(*) c FROM tasks t JOIN states s ON s.id = t.state_id
      WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.archived = 0
        AND s.group_key ${done ? 'IN' : 'NOT IN'} ('completed','cancelled')`,
    projectId,
  )?.c ?? 0);

/* ---------------------------------------------------------------- prompts */

const PROMPTS = [
  {
    name: 'standup',
    title: 'Daily standup',
    description: 'Summarise what moved yesterday, what is in flight and what is blocked.',
    arguments: [{ name: 'project', description: 'Project key or name', required: true }],
    build: (args: Record<string, string>) =>
      `Use project_status for "${args.project}" and list_tasks with state=started. Write a short standup: what completed since yesterday, what is in progress and who owns it, what is overdue or unassigned, and the single most important risk. Keep it under 200 words.`,
  },
  {
    name: 'sprint_planning',
    title: 'Plan the next cycle',
    description: 'Propose a cycle scope from the backlog.',
    arguments: [
      { name: 'project', description: 'Project key or name', required: true },
      { name: 'capacity', description: 'Total estimate points available', required: false },
    ],
    build: (args: Record<string, string>) =>
      `Read the backlog of "${args.project}" with list_tasks (state=backlog) and the last cycle with list_cycles. Propose a scope for the next cycle that fits ${args.capacity ?? 'the team\'s recent throughput'}, ordered by priority and dependencies. Explain trade-offs, then ask before calling update_task to assign the cycle.`,
  },
  {
    name: 'triage',
    title: 'Triage inbox',
    description: 'Clean up untriaged work.',
    arguments: [{ name: 'project', description: 'Project key or name', required: true }],
    build: (args: Record<string, string>) =>
      `List tasks in "${args.project}" that are unassigned or have priority "none". For each, suggest a priority, an owner from list_members, and a label. Present a table first and only apply changes with update_task after I confirm.`,
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

function resourceList(ctx: McpCtx) {
  const workspaceId = ctx.defaultWorkspace ?? [...ctx.auth.memberships.keys()][0];
  if (!workspaceId) return [];
  const pages = all<Row>(
    `SELECT id, title, icon FROM pages WHERE workspace_id = ? AND deleted_at IS NULL AND archived = 0
       AND (access <> 'private' OR created_by = ?) ORDER BY updated_at DESC LIMIT 100`,
    workspaceId, ctx.auth.userId,
  );
  return pages.map((page) => ({
    uri: `kolibri://page/${page.id}`,
    name: page.title,
    title: `${page.icon ?? '📄'} ${page.title}`,
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

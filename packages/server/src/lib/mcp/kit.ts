/**
 * Everything the MCP tools are built out of, and nothing that is a tool.
 *
 * The tools used to live in one 5 464-line file with these helpers on top of
 * them, and the helpers are the reason the split works at all: they are what
 * the eleven groups share, so pulling them out here leaves each group as a
 * plain array of tool definitions that reads like a list of what an assistant
 * can do — which is what it is.
 *
 * Two kinds of thing are here. The **contract** — `ToolDef`, `McpCtx`,
 * `McpError` — which is what a tool group and the JSON-RPC envelope in
 * `index.ts` agree on. And the **vocabulary**: resolving a project by key or
 * name, deciding whether this token may write, turning a row into the shape
 * every tool that returns one uses. Everything is exported, because the point
 * of the file is to be imported from.
 */
import { annualCost, type Budget, type BudgetActual, type BudgetLine, type BudgetRollUp, type BudgetScenario, type Component, fieldValueId, formatMeasure, formatMoney, type Kpi, type KpiReading, type KpiTarget, type LandscapeCost, livenessOn, normaliseAllocations, oneOffCost, orderKey, parseMoney, parseQuickAdd, PRIORITIES, progressOf, projectScope, type Rate, type RelationKind, rollUp, STATE_GROUPS, type StateGroup, type TimeEntry, trendOf, type Vendor, type Vocabulary, writeFieldValue } from '@kolibri/shared';
import { all, get, type Row } from '../../db/index.ts';
import { env } from '../../env.ts';
import { type Auth } from '../auth.ts';
import { serverClock } from '../bootstrap.ts';
import { hasFeature } from '../features.ts';
import { canSeeBudget, canSeeKpi, canSeeProject, serialize, visibleProjectIds, writeEntity } from '../repo.ts';
import { uid } from '../ids.ts';

export interface ToolDef {
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

export class McpError extends Error {
  code: number;

  constructor(message: string, code = -32602) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ helpers */

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function workspaceOf(args: Record<string, any>, ctx: McpCtx): string {
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
export function findTask(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(ref)
    ? get<Row>(`SELECT * FROM tasks WHERE workspace_id = ? AND identifier = ? AND deleted_at IS NULL`, workspaceId, ref.toUpperCase())
    : get<Row>(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceId, ref);
  if (!row) throw new McpError(`Task ${ref} not found`);
  if (!canSeeProject(ctx.auth.userId, row.project_id)) throw new McpError('That project is private');
  return row;
}

export function findProject(ref: string, workspaceId: string, ctx: McpCtx): Row {
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
export function reportScope(
  args: Record<string, any>,
  ctx: McpCtx,
): { workspaceId: string; projectIds: string[]; project: Row | null; keyOf: Record<string, string> } {
  const workspaceId = workspaceOf(args, ctx);
  const ref = str(args.project);
  // `findProject` refuses a project this token cannot see, so the single-project
  // path needs no second check.
  const projectIds = ref
    ? [String(findProject(ref, workspaceId, ctx).id)]
    : [...visibleProjectIds(ctx.auth.userId, workspaceId)];

  /* The key of every project in scope, resolved here so a workspace-wide
     answer can say which project each row is in. Reading it off the front of
     `WEB-42` happens to work today and is not something a caller should have
     to rely on: an identifier is a label, not a foreign key. */
  const keyOf = Object.fromEntries(
    projectIds.length
      ? all<Row>(`SELECT id, key FROM projects WHERE id IN (${holes(projectIds.length)})`, ...projectIds)
          .map((r) => [String(r.id), String(r.key)])
      : [],
  );
  return {
    workspaceId,
    projectIds,
    project: ref ? get<Row>(`SELECT * FROM projects WHERE id = ?`, projectIds[0]) ?? null : null,
    keyOf,
  };
}

/**
 * Count something per project, keyed by the key people type rather than by id.
 *
 * Every workspace-wide report carries one. Without it the answer to "which
 * project is on fire" is a list the caller has to re-aggregate, which is the
 * work these tools exist to have already done.
 */
export function perProject<T>(rows: T[], keyOf: Record<string, string>, idOf: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf[idOf(row)];
    if (key) out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** `?, ?, ?` for an `IN` list. Never called with zero — see `reportScope` users. */
export const holes = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * A window in whole days, clamped.
 *
 * Unbounded, `days` is a way to ask one SQLite process to walk every activity
 * a workspace has ever recorded. A year is past the point where anybody is
 * reading the answer rather than skimming it.
 */
export function windowDays(raw: unknown, fallback: number): number {
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
export const brief = (row: Row, names: Record<string, string> = {}, keyOf: Record<string, string> = {}) => {
  const assignees = safeList(row.assignees);
  return {
    identifier: row.identifier,
    title: row.title,
    // Named on every row, not only when the report spans projects: a caller
    // that has to branch on whether the field is there will read it wrong on
    // one of the two paths.
    project: keyOf[String(row.project_id ?? '')] ?? null,
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
export const assigneeNames = (rows: Row[]): Record<string, string> => namesOf(rows.flatMap((r) => safeList(r.assignees)));

/** Names for a list of user ids, so a report reads as people rather than uuids. */
export function namesOf(ids: string[]): Record<string, string> {
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
export function fileTask(
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
    // Refused rather than dropped if it does not exist: a task filed into a
    // milestone that turns out to be a typo, reported as a success, is how a
    // release plan ends up missing the thing somebody thought they had added.
    module_id: str(args.module) ? String(findModule(String(args.module), workspaceId, ctx).id) : null,
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
export const MIME_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  html: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  pdf: 'application/pdf', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
};

export const mimeFromName = (name: string): string =>
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
export const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function colour(value: unknown, field = 'color'): string | undefined {
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
export function stateGroup(value: unknown, required: boolean): StateGroup | undefined {
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
export const CYCLE_STATUS = ['upcoming', 'active', 'completed', 'archived'] as const;

/**
 * A cycle the caller may see, by id or by name.
 *
 * `resolveCycle` also understands `"current"`, which is worked out from the
 * dates — so "update the current cycle" means what somebody would expect it to
 * mean without them having to look the id up first.
 */
export function findCycle(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = resolveCycle(workspaceId, ref);
  if (!row) throw new McpError(`Cycle ${ref} not found`);
  if (!canSeeProject(ctx.auth.userId, row.project_id)) throw new McpError('That project is private');
  return row;
}

/**
 * A module the caller may see, by id or by name.
 *
 * No `"current"` here, unlike a cycle: a cycle is a window and today decides
 * which one you mean, while a milestone is a thing you name.
 */
export function findModule(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = get<Row>(
    `SELECT * FROM modules WHERE workspace_id = ? AND (id = ? OR lower(name) = lower(?)) AND deleted_at IS NULL`,
    workspaceId, ref, ref,
  );
  if (!row) throw new McpError(`Module ${ref} not found`);
  // A module owned by nobody belongs to more than one project, and
  // `canSeeProject` of a null is not the question to ask about it — whether any
  // covered project is visible is, and `list_modules` answers that in SQL.
  if (row.project_id && !canSeeProject(ctx.auth.userId, row.project_id)) throw new McpError('That project is private');
  return row;
}

/** One module, as every tool that returns one reports it. */
export const moduleView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  project_id: row.project_id ? String(row.project_id) : null,
  projects: safeList(row.projects),
  scope: row.project_id ? 'project' : (safeList(row.projects).length ? 'projects' : 'workspace'),
  name: String(row.name),
  description: row.description ?? null,
  lead_id: row.lead_id ? String(row.lead_id) : null,
  start_date: row.start_date ?? null,
  target_date: row.target_date ?? null,
  status: row.status ?? null,
});

/** One label, the same shape from every tool that returns one. */
export const labelView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  name: String(row.name),
  color: row.color ?? null,
  description: row.description ?? null,
  // Null means every project in the workspace may use it.
  project_id: row.project_id ?? null,
});

/** One cycle, as `list_cycles` and the writers both report it. */
export const cycleView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  // Not `String(row.project_id)`: a workspace cycle has none, and stringifying
  // it hands the caller the four characters `null` as if they were an id.
  project_id: row.project_id ? String(row.project_id) : null,
  projects: safeList(row.projects),
  scope: row.project_id ? 'project' : (safeList(row.projects).length ? 'projects' : 'workspace'),
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
export function isoDay(value: unknown, field: string): string | null {
  const raw = str(value);
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new McpError(`\`${field}\` must be YYYY-MM-DD, not "${raw}"`);
  if (Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new McpError(`\`${field}\` is not a real date: "${raw}"`);
  return raw;
}

/** One state, the same shape wherever it is returned. */
export const stateView = (row: Row): Record<string, unknown> => ({
  id: String(row.id),
  project_id: String(row.project_id),
  name: String(row.name),
  group: String(row.group_key),
  color: row.color ?? null,
  wip_limit: Number(row.wip_limit ?? 0),
});

/** A state in a project the caller may see. */
export function findState(id: string, workspaceId: string, ctx: McpCtx): Row {
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
export function findPage(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const page = get<Row>(
    `SELECT * FROM pages WHERE workspace_id = ? AND (id = ? OR lower(title) = lower(?)) AND deleted_at IS NULL LIMIT 1`,
    workspaceId, ref, ref,
  );
  if (!page) throw new McpError(`Page ${ref} not found`);
  if (page.access === 'private' && page.created_by !== ctx.auth.userId) throw new McpError('That page is private');
  return page;
}

/** A label in this workspace, by id or by name. */
export function findLabel(ref: string, workspaceId: string): Row {
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
export const INVERSE_RELATION: Record<RelationKind, RelationKind> = {
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
export function blockingLoop(workspaceId: string, source: Row, target: Row, kind: RelationKind): boolean {
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

export function resolveState(projectId: string, name?: string): Row | undefined {
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
export function vocabularyFor(workspaceId: string): Vocabulary {
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

export function resolveUsers(workspaceId: string, refs: unknown): string[] {
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

/**
 * One person, by id, email or name — and refused if there is no such person.
 *
 * `resolveUsers` drops what it cannot match, which is right for a list of
 * assignees where the caller sees who ended up on the task. It is wrong for a
 * single field: a misspelt lead would come back as no lead at all, reported as
 * a success, and the module would look like nobody had claimed it.
 */
export function findMember(ref: string, workspaceId: string): Row {
  const user = get<Row>(
    `SELECT u.id, u.name FROM users u JOIN workspace_members m ON m.user_id = u.id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL
        AND (u.id = ? OR lower(u.email) = lower(?) OR lower(u.name) = lower(?))`,
    workspaceId, ref, ref, ref,
  );
  if (!user) throw new McpError(`Nobody in this workspace matches "${ref}"`);
  return user;
}

export const writeOpts = (workspaceId: string, ctx: McpCtx) => ({
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
export function requireWrite(ctx: McpCtx, workspaceId: string): void {
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
export function requireFeature(workspaceId: string, name: 'time' | 'budget' | 'infrastructure' | 'kpi'): void {
  if (!hasFeature(workspaceId, name)) {
    const what = {
      time: 'Time tracking',
      budget: 'Budgets',
      infrastructure: 'The infrastructure register',
      kpi: 'KPIs',
    }[name];
    throw new McpError(`${what} is switched off in this workspace (Settings → Workspace)`, -32000);
  }
}

/** A JSON column read straight from SQLite, without trusting it to be valid. */
export const safeList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

export const taskView = (row: Row) => ({
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
export function writeCustomFields(task: Row, answers: Record<string, unknown>, workspaceId: string, ctx: McpCtx): void {
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

/* ---------------------------------------------------------------- landscape */

export const componentsOf = (workspaceId: string): Component[] =>
  all<Row>(`SELECT * FROM components WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order`, workspaceId)
    .map((row) => serialize('component', row) as unknown as Component);

export const vendorsOf = (workspaceId: string): Vendor[] =>
  all<Row>(`SELECT * FROM vendors WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name`, workspaceId)
    .map((row) => serialize('vendor', row) as unknown as Vendor);

export function findComponent(ref: string, workspaceId: string): Component {
  const wanted = ref.trim().toLowerCase();
  const found = componentsOf(workspaceId).find((row) => row.id === ref
    || row.name.toLowerCase() === wanted
    || (row.reference ?? '').toLowerCase() === wanted);
  if (!found) throw new McpError(`No component "${ref}" in this workspace`);
  return found;
}

export function findVendor(ref: string, workspaceId: string): Vendor {
  const wanted = ref.trim().toLowerCase();
  const found = vendorsOf(workspaceId).find((row) => row.id === ref || row.name.toLowerCase() === wanted);
  if (!found) throw new McpError(`No vendor "${ref}" in this workspace`);
  return found;
}

/**
 * The vendor by that name, or a new one.
 *
 * The one place here that creates a row the caller did not ask for by name, and
 * it is deliberate: an assistant writing down an estate should not have to
 * create eleven suppliers before it can record a server. The alternative is a
 * register where every component is filed under nothing.
 */
export function ensureVendor(name: string, workspaceId: string, ctx: McpCtx): Vendor {
  const wanted = name.trim().toLowerCase();
  const existing = vendorsOf(workspaceId).find((row) => row.name.toLowerCase() === wanted);
  if (existing) return existing;
  const { row } = writeEntity('vendor', uid(), {
    workspace_id: workspaceId, name: name.trim(), kind: 'other', notice_days: 0, archived: 0,
  }, writeOpts(workspaceId, ctx));
  return serialize('vendor', row) as unknown as Vendor;
}

/** The bottom of the register, so a new row lands under the last one. */
export const lastComponentOrder = (workspaceId: string): string | null =>
  (get<Row>(
    `SELECT sort_order FROM components WHERE workspace_id = ? AND deleted_at IS NULL
      ORDER BY sort_order DESC LIMIT 1`, workspaceId,
  )?.sort_order as string | undefined) ?? null;

/** One component, as every landscape tool reports it. */
export function componentView(component: Component, vendors: Vendor[], day?: string) {
  const yearly = annualCost(component);
  const parent = component.parent_id
    ? get<Row>(`SELECT name FROM components WHERE id = ?`, component.parent_id)?.name ?? null
    : null;
  return {
    id: component.id,
    name: component.name,
    kind: component.kind,
    environment: component.environment,
    status: component.status,
    vendor: vendors.find((row) => row.id === component.vendor_id)?.name ?? null,
    parent,
    live_from: component.live_from,
    live_until: component.live_until,
    reference: component.reference,
    location: component.location,
    /* Both figures, for the reason the budget tools return both: a model asked
       for "the cost" quotes whichever it sees first, and one of the two
       readings is out by a factor of a hundred. */
    annual_cost: yearly,
    annual_cost_text: yearly === null ? null : formatMoney(yearly, component.currency, 'en'),
    one_off_cost_text: oneOffCost(component)
      ? formatMoney(oneOffCost(component), component.currency, 'en')
      : null,
    liveness: day ? livenessOn(component, day) : undefined,
    budgeted: !!component.line_id,
  };
}

/** What a set of components comes to, both ways, per currency. */
export const costView = (cost: LandscapeCost) => ({
  annual_cost: moneyList(cost.annual),
  one_off_cost: moneyList(cost.oneOff),
  /* Components nobody has priced. Counted rather than treated as free — the
     same decision `unrated` makes for time and `unallocated` for budgets. */
  unpriced: cost.unpriced,
});

/* -------------------------------------------------------------------- rates */

/**
 * Rates, and every figure computed from one, are owners' and admins' business.
 *
 * The same rule the pull applies in SQL and the REST routes apply per request.
 * Named here rather than repeated at five call sites, because a cost tool that
 * forgets it does not fail — it answers, with the number the restriction
 * exists to withhold.
 */
export function requireAdmin(ctx: McpCtx, workspaceId: string): void {
  const role = ctx.auth.memberships.get(workspaceId);
  if (role !== 'owner' && role !== 'admin') {
    throw new McpError('Rates and cost are visible to owners and admins', -32000);
  }
}

export const ratesOf = (workspaceId: string): Rate[] =>
  all<Row>(`SELECT * FROM rates WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
    .map((row) => serialize('rate', row) as unknown as Rate);

/** Time entries in a window, already narrowed to what the caller may see. */
export function entriesIn(workspaceId: string, ctx: McpCtx, args: Record<string, any>): TimeEntry[] {
  const where: string[] = ['t.workspace_id = ?', 't.deleted_at IS NULL', 't.minutes > 0'];
  const params: unknown[] = [workspaceId];
  if (args.from) { where.push('t.spent_on >= ?'); params.push(String(args.from)); }
  if (args.to) { where.push('t.spent_on <= ?'); params.push(String(args.to)); }
  if (args.project) {
    where.push('t.project_id = ?');
    params.push(findProject(String(args.project), workspaceId, ctx).id);
  }
  if (args.user) { where.push('t.user_id = ?'); params.push(findMember(String(args.user), workspaceId).id); }
  return all<Row>(`SELECT t.* FROM time_entries t WHERE ${where.join(' AND ')}`, ...params)
    // A private project's hours are not everybody's, even for an admin who is
    // not on it — the same rule every other report here follows.
    .filter((row) => canSeeProject(ctx.auth.userId, row.project_id as string | null))
    .map((row) => serialize('timeEntry', row) as unknown as TimeEntry);
}

/** Money both ways, as the budget tools return it. */
export const moneyList = (rows: { currency: string; amount: number }[]) =>
  rows.map((row) => ({ ...row, amount_text: formatMoney(row.amount, row.currency, 'en') }));

export const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

/* ------------------------------------------------------------------ budgets */

/** The scope pair a budget carries, in the shape `coversProject` reads. */
export const scopeOf = (row: Row): { project_id: string | null; projects: string[] } =>
  ({ project_id: (row.project_id as string | null) ?? null, projects: safeList(row.projects) });

/**
 * Every budget this caller may see, already filtered.
 *
 * `canSeeBudget` is the one function that knows the scoping rule — a budget
 * covering three projects has no `project_id` for the usual filter to test —
 * and asking it here means no budget tool can forget to.
 */
export const visibleBudgets = (workspaceId: string, ctx: McpCtx): Row[] =>
  all<Row>(`SELECT * FROM budgets WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`, workspaceId)
    .filter((row) => canSeeBudget(ctx.auth.userId, String(row.id)));

/* --------------------------------------------------------------------- KPIs */

/** Every KPI this caller may see, already filtered. See `canSeeKpi`. */
export const visibleKpis = (workspaceId: string, ctx: McpCtx): Row[] =>
  all<Row>(`SELECT * FROM kpis WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`, workspaceId)
    .filter((row) => canSeeKpi(ctx.auth.userId, String(row.id)));

export function findKpi(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const wanted = ref.trim().toLowerCase();
  const found = visibleKpis(workspaceId, ctx)
    .find((row) => row.id === ref || String(row.name).toLowerCase() === wanted);
  if (!found) throw new McpError(`No KPI "${ref}" in this workspace`);
  return found;
}

export const kpiChildren = (table: 'kpi_targets' | 'kpi_readings', kpis: Row[]): Row[] => (kpis.length
  ? all<Row>(
    `SELECT * FROM ${table} WHERE kpi_id IN (${holes(kpis.length)}) AND deleted_at IS NULL`,
    ...kpis.map((row) => row.id),
  )
  : []);

export const asKpi = (row: Row): Kpi => serialize('kpi', row) as unknown as Kpi;

/**
 * One KPI's answer, in the shape every KPI tool returns it.
 *
 * Both the number to compute with and the text to quote, for the reason the
 * budget tools do it: a model asked for a figure picks whichever it sees first,
 * and here the two readings differ by a factor of ten to the `decimals`.
 */
/**
 * The rows every KPI report needs, fetched once for a whole list.
 *
 * `kpiReport` used to gather its own, which is correct for one KPI and five
 * queries too many for sixty: three per KPI, one of them the entire modules
 * table re-read each time. `kpiChildren` already took a batch and was only ever
 * handed one row.
 */
export function kpiContext(rows: Row[], workspaceId: string) {
  const readings = new Map<string, KpiReading[]>();
  for (const entry of kpiChildren('kpi_readings', rows)) {
    const reading = serialize('kpiReading', entry) as unknown as KpiReading;
    const list = readings.get(reading.kpi_id);
    if (list) list.push(reading); else readings.set(reading.kpi_id, [reading]);
  }
  const targets = new Map<string, KpiTarget[]>();
  for (const entry of kpiChildren('kpi_targets', rows)) {
    const target = serialize('kpiTarget', entry) as unknown as KpiTarget;
    const list = targets.get(target.kpi_id);
    if (list) list.push(target); else targets.set(target.kpi_id, [target]);
  }
  const modules = all<Row>(
    `SELECT id, target_date FROM modules WHERE workspace_id = ? AND deleted_at IS NULL`,
    workspaceId,
  ).map((entry) => ({ id: String(entry.id), target_date: (entry.target_date as string | null) ?? null }));
  return { readings, targets, modules };
}

export type KpiContext = ReturnType<typeof kpiContext>;

export function kpiReport(row: Row, workspaceId: string, asOf?: string, context?: KpiContext) {
  const kpi = asKpi(row);
  const shared = context ?? kpiContext([row], workspaceId);
  const readings = shared.readings.get(String(row.id)) ?? [];
  const targets = shared.targets.get(String(row.id)) ?? [];
  const modules = shared.modules;

  const progress = progressOf({ kpi, readings, targets, modules, asOf });
  const trend = trendOf(kpi, readings, asOf);
  const text = (value: number | null) => (value === null ? null : formatMeasure(value, kpi, 'en'));
  return {
    kpi, readings, targets, modules, progress, trend,
    summary: {
      id: row.id,
      name: row.name,
      direction: row.direction,
      cadence: row.cadence,
      health: progress.health,
      value: progress.value,
      value_text: text(progress.value),
      measured_on: progress.measuredOn,
      /* Days since the reading. A model reporting "we are at 94%" needs to know
         it is quoting March, and `health: stale` says so only once somebody has
         read the enum. */
      age_days: progress.age,
      target: progress.target,
      target_text: text(progress.target),
      due: progress.due,
      baseline: progress.baseline,
      baseline_text: text(progress.baseline),
      baseline_implied: progress.baselineImplied,
      achieved_pct: progress.achieved === null ? null : Math.round(progress.achieved / 100),
      expected_pct: progress.expected === null ? null : Math.round(progress.expected / 100),
      change: trend.change,
      change_text: trend.change === null ? null : text(trend.change),
      change_better: trend.better,
    },
  };
}

export function findBudget(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const wanted = ref.trim().toLowerCase();
  const found = visibleBudgets(workspaceId, ctx)
    .find((row) => row.id === ref || String(row.name).toLowerCase() === wanted);
  if (!found) throw new McpError(`No budget "${ref}" in this workspace`);
  return found;
}

/** The live rows of one table belonging to any of these budgets. */
export function budgetChildren(table: 'budget_lines' | 'budget_actuals' | 'budget_scenarios', budgets: Row[]): Row[] {
  if (!budgets.length) return [];
  return all<Row>(
    `SELECT * FROM ${table} WHERE budget_id IN (${holes(budgets.length)}) AND deleted_at IS NULL`,
    ...budgets.map((row) => String(row.id)),
  );
}

/**
 * One budget, added up — through the same `rollUp` the dashboard calls.
 *
 * The rows go through `serialize` first, which is what turns the JSON columns
 * back into arrays. Skipping that step gives `rollUp` an allocation list that
 * is still a string, which does not throw: it reads as unallocated, and every
 * per-project figure silently comes out zero.
 */
export function rollUpBudget(budget: Row, options: { scenario?: Row | null; asOf?: string } = {}): BudgetRollUp {
  return rollUp({
    budget: serialize('budget', budget) as unknown as Budget,
    lines: budgetChildren('budget_lines', [budget]).map((row) => serialize('budgetLine', row) as unknown as BudgetLine),
    actuals: budgetChildren('budget_actuals', [budget]).map((row) => serialize('budgetActual', row) as unknown as BudgetActual),
    scenario: options.scenario
      ? (serialize('budgetScenario', options.scenario) as unknown as BudgetScenario)
      : null,
    asOf: options.asOf,
  });
}

/**
 * An amount, both ways.
 *
 * Every money figure a budget tool returns goes through here, so each appears
 * as `x` in minor units and `x_text` already formatted. A model asked for "the
 * variance" will quote whichever it sees first, and one of the two readings is
 * out by a factor of a hundred — so both are present and the units are in the
 * name.
 */
export function money(currency: string, figures: Record<string, number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(figures)) {
    out[key] = value;
    out[`${key}_text`] = formatMoney(value, currency, 'en');
  }
  return out;
}

/** An amount a caller typed, or a complaint naming the field. */
export function requireMoney(raw: unknown, field: string): number {
  const parsed = parseMoney(String(raw ?? ''));
  if (parsed === null) throw new McpError(`Cannot read "${raw}" as an amount for ${field}`);
  return parsed;
}

/**
 * `{"WEB": 60, "OPS": 40}` as the stored split.
 *
 * Percentages in, basis points out, projects resolved by the key or name an
 * assistant was told rather than by an id it would have to look up first. An
 * unknown project is an error: a split that quietly drops one of its halves
 * charges the whole cost to the other, which is a wrong number nobody would
 * think to question.
 */
export function allocationsFromArgs(raw: unknown, workspaceId: string, ctx: McpCtx): string {
  if (!raw || typeof raw !== 'object') return '[]';
  const out: { project_id: string; share: number }[] = [];
  for (const [ref, percent] of Object.entries(raw as Record<string, unknown>)) {
    const value = Number(percent);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({ project_id: String(findProject(ref, workspaceId, ctx).id), share: Math.round(value * 100) });
  }
  return JSON.stringify(normaliseAllocations(out));
}

/** The bottom of a budget's plan, so a new line lands under the last one. */
export const lastLineOrder = (budgetId: string): string | null =>
  (get<Row>(
    `SELECT sort_order FROM budget_lines WHERE budget_id = ? AND deleted_at IS NULL
      ORDER BY sort_order DESC LIMIT 1`, budgetId,
  )?.sort_order as string | undefined) ?? null;

/** Project ids to names, for an answer that has to say which project a row is in. */
export const projectNames = (workspaceId: string): Record<string, string> => Object.fromEntries(
  all<Row>(`SELECT id, name FROM projects WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
    .map((row) => [String(row.id), String(row.name)]),
);

/* -------------------------------------------------------------------- tools */


/**
 * Turn `project` / `projects` arguments into the pair that gets stored.
 *
 * Shared by cycles, modules and budgets, which are scoped identically. Each name is
 * resolved through `findProject`, so a project this token cannot see is refused
 * here rather than silently dropped — one that quietly covers fewer projects
 * than asked for is worse than one that fails to be made. `projectScope` then
 * normalises: a list of one collapses to an owner, a list of several clears the
 * owner, and neither means every project.
 */
export function resolveScope(
  args: Record<string, any>,
  workspaceId: string,
  ctx: McpCtx,
): { project_id: string | null; projects: string[] } {
  // Refused rather than resolved: `projectScope` would let the list win, and a
  // caller who passed both meant one of them. Which one is not ours to guess.
  if (str(args.project) && Array.isArray(args.projects)) {
    throw new McpError('Pass `project` for one project\'s own, or `projects` for the projects it covers — not both');
  }
  const listed = Array.isArray(args.projects)
    ? args.projects.filter((r: unknown) => typeof r === 'string' && r.trim())
      .map((ref: string) => String(findProject(ref.trim(), workspaceId, ctx).id))
    : [];
  const owner = str(args.project) ? String(findProject(String(args.project), workspaceId, ctx).id) : null;
  return projectScope({ project: owner, projects: listed });
}

export function resolveCycle(workspaceId: string, ref: string): Row | undefined {
  if (ref === 'current') {
    return get<Row>(
      `SELECT * FROM cycles WHERE workspace_id = ? AND deleted_at IS NULL
        AND start_date <= date('now') AND end_date >= date('now') ORDER BY start_date DESC LIMIT 1`,
      workspaceId,
    );
  }
  return get<Row>(`SELECT * FROM cycles WHERE workspace_id = ? AND (id = ? OR lower(name) = lower(?)) AND deleted_at IS NULL`, workspaceId, ref, ref);
}

export function resolveLabels(workspaceId: string, projectId: string, refs: unknown, ctx: McpCtx): string[] {
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

export const countTasks = (projectId: string, done: boolean): number =>
  Number(get<Row>(
    `SELECT count(*) c FROM tasks t JOIN states s ON s.id = t.state_id
      WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.archived = 0
        AND s.group_key ${done ? 'IN' : 'NOT IN'} ('completed','cancelled')`,
    projectId,
  )?.c ?? 0);

import {
  ENTITY_NAMES,
  ENTITIES,
  entityDef,
  isCrossWorkspace,
  isGuestWritable,
  type ChangeSet,
  type EntityName,
  type Mutation,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from '@kolibri/shared';
import { all, currentSeq, get, run, tx, type Row } from '../db/index.ts';
import { hasRole, requireAuth, requireWorkspace } from '../lib/auth.ts';
import { badRequest, forbidden, readJson, type Ctx, type Router } from '../lib/http.ts';
import { serialize, writeEntity } from '../lib/repo.ts';
import { subscribe } from '../lib/bus.ts';
import { snapshot, subscribePresence, touch, visiblePeople } from '../lib/presence.ts';

/** Activities are history, not state: they are read on demand, never mirrored. */
const SYNCED: EntityName[] = ENTITY_NAMES.filter((name) => name !== 'activity');

const PAGE_SIZE = 2000;

/** Projects the caller is allowed to see, as a subquery to keep pulls in SQL. */
const VISIBLE_PROJECTS = `
  SELECT p.id FROM projects p
   WHERE p.workspace_id = ?1
     AND (p.visibility = 'public'
          OR EXISTS (SELECT 1 FROM project_members m
                      WHERE m.project_id = p.id AND m.user_id = ?2 AND m.deleted_at IS NULL))`;

interface Scope {
  workspaceId: string;
  userId: string;
}

/** Extra WHERE clause per entity so a pull never returns rows the user may not see. */
function filterFor(entity: EntityName): string {
  const table = ENTITIES[entity].table;
  switch (entity) {
    // Somebody in this workspace — or somebody you are in a direct conversation
    // with, who may be in none of yours. Without the second half their name
    // never reaches this device and the conversation is titled with a raw id.
    // It is not a directory: you only learn about people you are already
    // talking to.
    case 'user':
      return `AND (EXISTS (SELECT 1 FROM workspace_members wm
                            WHERE wm.user_id = ${table}.id AND wm.workspace_id = ?1 AND wm.deleted_at IS NULL)
                   OR EXISTS (SELECT 1 FROM channels c
                               WHERE c.kind = 'direct' AND c.deleted_at IS NULL
                                 AND EXISTS (SELECT 1 FROM json_each(c.members) WHERE json_each.value = ${table}.id)
                                 AND EXISTS (SELECT 1 FROM json_each(c.members) WHERE json_each.value = ?2)))`;
    case 'notification':
      return `AND ${table}.user_id = ?2`;
    case 'intake':
      // A report about a project is only visible to people who can see the
      // project — the same rule the tasks it may become already follow.
    case 'task':
    case 'state':
    case 'field':
    case 'fieldValue':
    case 'baseline':
    case 'projectMember':
      return `AND ${table}.project_id IN (${VISIBLE_PROJECTS})`;
    case 'project':
      return `AND ${table}.id IN (${VISIBLE_PROJECTS})`;
    /*
     * A cycle or a module reaches a device when *any* project it covers does.
     *
     * Three shapes, and each needs its own half of this: one project's own
     * follows that project; one with no owner and no list is every project's
     * and follows the workspace; one with a list follows any project on it.
     * The last is what `json_each` is for, the same way a private channel's
     * membership is read below.
     *
     * Getting this wrong is quiet in the worst way. Before the workspace case
     * was added here, a shared cycle existed on the server, was returned by
     * REST and by MCP, and reached no client at all — every project's Cycles
     * tab was simply empty of it. `coversProject` in `@kolibri/shared` is the
     * same rule in TypeScript, and both entities are scoped by both of them.
     */
    case 'cycle':
    case 'module':
      return `AND ((json_array_length(${table}.projects) = 0
                    AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS})))
                   OR EXISTS (SELECT 1 FROM json_each(${table}.projects)
                               WHERE json_each.value IN (${VISIBLE_PROJECTS})))`;
    /*
     * A budget is scoped exactly as those two are, so it gets the same clause —
     * one project's own follows that project, one with no owner and no list is
     * the workspace's, one with a list follows any project on it.
     *
     * Note that this is *not* the same question as which projects a budget's
     * money is charged to. A central infrastructure budget is workspace-wide,
     * so everybody sees it, and still allocates 40% of itself to one team's
     * project. Visibility is the scope; `allocations` is the arithmetic. Making
     * them one field would mean either hiding a shared budget from the people
     * paying for it or showing every project's figures to everybody.
     */
    case 'budget':
      return `AND ((json_array_length(${table}.projects) = 0
                    AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS})))
                   OR EXISTS (SELECT 1 FROM json_each(${table}.projects)
                               WHERE json_each.value IN (${VISIBLE_PROJECTS})))`;
    /*
     * Lines, invoices and scenarios inherit their budget's answer, exactly —
     * `deleted_at` included, the way a message inherits its channel's. Leaving
     * that out is the bug that shipped for chat: a deleted budget went on
     * sending its lines to devices that no longer had anything to put them in.
     */
    case 'budgetLine':
    case 'budgetActual':
    case 'budgetScenario':
      return `AND EXISTS (
                SELECT 1 FROM budgets b
                 WHERE b.id = ${table}.budget_id
                   AND b.deleted_at IS NULL
                   AND ((json_array_length(b.projects) = 0
                         AND (b.project_id IS NULL OR b.project_id IN (${VISIBLE_PROJECTS})))
                        OR EXISTS (SELECT 1 FROM json_each(b.projects)
                                    WHERE json_each.value IN (${VISIBLE_PROJECTS}))))`;
    case 'label':
    case 'view':
    case 'webhook':
    case 'share':
    case 'timeEntry':
      // Time is not private: a lead has to be able to add up the project. It is
      // scoped to the project like everything else, and an entry with no
      // project is the writer's own loose time.
      return `AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS}))`;
    case 'page':
      return `AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS}))
              AND (${table}.access <> 'private' OR ${table}.created_by = ?2)`;
    // A conversation is visible when it is not private, or when the person is
    // named in it. A channel tied to a project follows that project as well:
    // an open channel inside a project people cannot see is still not theirs.
    case 'channel':
      return `AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS}))
              AND (${table}.is_private = 0
                   OR EXISTS (SELECT 1 FROM json_each(${table}.members) WHERE json_each.value = ?2))`;
    // Messages inherit their channel's answer, exactly — including `deleted_at`.
    // Leaving that out was a real bug: a deleted conversation kept sending its
    // messages to members whose devices no longer had a channel to put them in.
    case 'message':
      return `AND EXISTS (
                SELECT 1 FROM channels c
                 WHERE c.id = ${table}.channel_id
                   AND c.deleted_at IS NULL
                   AND (c.project_id IS NULL OR c.project_id IN (${VISIBLE_PROJECTS}))
                   AND (c.is_private = 0
                        OR EXISTS (SELECT 1 FROM json_each(c.members) WHERE json_each.value = ?2)))`;
    case 'channelRead':
      return `AND ${table}.user_id = ?2`;
    case 'comment':
    case 'attachment':
      return `AND (${table}.task_id IS NULL OR EXISTS (
                SELECT 1 FROM tasks t WHERE t.id = ${table}.task_id AND t.project_id IN (${VISIBLE_PROJECTS})))`;
    case 'relation':
      return `AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${table}.task_id AND t.project_id IN (${VISIBLE_PROJECTS}))`;
    default:
      return '';
  }
}

/**
 * Which workspace a row has to be in to come down this pull.
 *
 * This one, for almost everything. Two exceptions, and both are old news by
 * now: a `user` is not owned by a workspace, and neither is a direct
 * conversation — it is between two people who may share no workspace at all,
 * so it carries none and arrives whichever one the device happens to have
 * open. The entities that may do that say so in the registry rather than
 * being listed here, so the next one cannot be forgotten.
 *
 * The `filterFor` clause is what keeps that safe: a workspace-less channel is
 * always private and always has exactly two members, so "no workspace" widens
 * *where* it is delivered, never *to whom*.
 */
function workspaceClause(entity: EntityName, table: string): string {
  if (entity === 'user') return '';
  if (isCrossWorkspace(entity)) return `AND (${table}.workspace_id = ?1 OR ${table}.workspace_id IS NULL)`;
  return `AND ${table}.workspace_id = ?1`;
}

function fetchChanges(scope: Scope, since: number, upto: number): { changes: ChangeSet; cursor: number; hasMore: boolean } {
  const raw = new Map<EntityName, Row[]>();
  let cursor = upto;

  for (const entity of SYNCED) {
    const table = ENTITIES[entity].table;
    const ws = workspaceClause(entity, table);
    const rows = all<Row>(
      `SELECT ${table}.* FROM ${table}
        WHERE ${table}.seq > ?3 AND ${table}.seq <= ?4 ${ws} ${filterFor(entity)}
        ORDER BY ${table}.seq LIMIT ?5`,
      scope.workspaceId, scope.userId, since, upto, PAGE_SIZE + 1,
    );
    if (rows.length > PAGE_SIZE) {
      // This entity is behind: stop the whole pull at its last complete seq so
      // the client can simply ask again from the returned cursor.
      rows.length = PAGE_SIZE;
      cursor = Math.min(cursor, Number(rows[rows.length - 1].seq));
    }
    raw.set(entity, rows);
  }

  const changes: ChangeSet = {};
  for (const [entity, rows] of raw) {
    const included = rows.filter((row) => Number(row.seq) <= cursor).map((row) => serialize(entity, row)!);
    if (included.length) (changes as Record<string, unknown[]>)[entity] = included;
  }
  // The server is the only side that knows it truncated: it asked for one row
  // more than a page and got it. The client used to infer this from a page
  // being exactly full, which is right until a workspace has exactly PAGE_SIZE
  // changes — and a wrong guess there means a client silently stops syncing.
  return { changes, cursor, hasMore: cursor < upto };
}

export function registerSyncRoutes(router: Router): void {
  /** Delta pull. `since=0` bootstraps a fresh client. */
  router.get('/api/sync/pull', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const workspaceId = ctx.query.get('workspace') ?? '';
    requireWorkspace(ctx, workspaceId);
    const since = Number(ctx.query.get('since') ?? 0) || 0;
    const upto = currentSeq();
    const { changes, cursor, hasMore } = fetchChanges({ workspaceId, userId: auth.userId }, since, upto);
    const response: PullResponse = { changes, cursor, hasMore, now: Date.now(), reset: since === 0 };
    return response;
  });

  /** Batched mutation push from the offline queue. */
  router.post('/api/sync/push', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<PushRequest>(ctx);
    const workspaceId = body.workspaceId;
    const role = requireWorkspace(ctx, workspaceId);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    // A guest writes nothing except the rows that are entirely about themselves
    // — see `guestWritable` in the registry. Refused per mutation rather than
    // per push: a read marker batched beside something a guest may not write
    // should still go, and the rejection of the rest already has a shape the
    // client understands.
    const guest = !hasRole(role, 'member');
    if (!Array.isArray(body.mutations)) throw badRequest('mutations must be an array');
    if (body.mutations.length > 500) throw badRequest('Too many mutations in one push (max 500)');

    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    const patched: ChangeSet = {};

    for (const mutation of body.mutations) {
      try {
        if (guest && !isGuestWritable(mutation.entity as EntityName)) {
          throw forbidden('Guests cannot modify this workspace');
        }
        const result = applyMutation(mutation, workspaceId, auth.userId, body.clientId);
        accepted.push(mutation.id);
        if (result) {
          const list = ((patched as Record<string, Row[]>)[mutation.entity] ??= []);
          list.push(result);
        }
      } catch (err) {
        rejected.push({ id: mutation.id, reason: err instanceof Error ? err.message : 'failed' });
      }
    }

    const response: PushResponse = { accepted, rejected, patched, cursor: currentSeq() };
    return response;
  });

  /**
   * Heartbeat. "I am still here, and I am typing in this conversation."
   *
   * A POST rather than a message up the stream because the stream only goes one
   * way, and adding a second socket to carry three bytes every 25 seconds is a
   * worse trade than a request the browser already knows how to retry.
   */
  router.post('/api/presence', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ typing?: string | null }>(ctx).catch(() => ({}) as { typing?: string | null });
    // `undefined` means "just a heartbeat, leave the typing state alone";
    // `null` means "I stopped". They are not the same and the distinction is
    // the whole reason the composer can clear the indicator the moment it
    // empties instead of waiting eight seconds for it to expire.
    touch(auth.userId, body?.typing === undefined ? undefined : (body.typing || null));
    return { ok: true };
  });

  /** Realtime nudge: "the workspace moved to seq N, pull again". */
  router.get('/api/sync/stream', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const workspaceId = ctx.query.get('workspace') ?? '';
    requireWorkspace(ctx, workspaceId);
    const clientId = ctx.query.get('client') ?? '';

    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    ctx.res.write(`retry: 3000\n`);
    ctx.res.write(`event: hello\ndata: ${JSON.stringify({ cursor: currentSeq(), userId: auth.userId })}\n\n`);

    // Opening the stream is itself a sign of life, so the first heartbeat is
    // free and a name lights up the moment the app loads rather than 25
    // seconds later.
    touch(auth.userId);

    // Whom this connection may hear about. Recomputed at most twice a minute,
    // and only when somebody unknown turns up — a new direct conversation is
    // the one thing that can widen this set, and it is rare enough that a
    // query per presence event would be pure waste.
    let visible = visiblePeople(auth.userId);
    let visibleAt = Date.now();
    const mayHearAbout = (userId: string): boolean => {
      if (visible.has(userId)) return true;
      if (Date.now() - visibleAt < 30_000) return false;
      visible = visiblePeople(auth.userId);
      visibleAt = Date.now();
      return visible.has(userId);
    };

    ctx.res.write(`event: presence\ndata: ${JSON.stringify({ people: snapshot(visible) })}\n\n`);

    const unsubscribe = subscribe(workspaceId, (event) => {
      if (event.origin && event.origin === clientId) return; // do not echo the sender
      ctx.res.write(`event: change\ndata: ${JSON.stringify({ cursor: event.seq, kind: event.kind })}\n\n`);
    });

    // Presence rides this connection but carries no cursor and never touches
    // one: it is a separate event, and a client that ignores it loses nothing.
    const unwatch = subscribePresence((event) => {
      if (event.userId === auth.userId) return; // you know whether you are typing
      if (!mayHearAbout(event.userId)) return;
      ctx.res.write(`event: presence\ndata: ${JSON.stringify({ people: [event] })}\n\n`);
    });

    const keepAlive = setInterval(() => ctx.res.write(`: ping\n\n`), 25_000);
    const stop = () => {
      clearInterval(keepAlive);
      unsubscribe();
      unwatch();
      ctx.res.end();
    };
    ctx.req.on('close', stop);
    ctx.req.on('error', stop);
    return undefined; // response is streamed
  });
}

export function applyMutation(mutation: Mutation, workspaceId: string, actorId: string, clientId?: string): Row | null {
  if (!mutation?.id || !mutation.entity || !mutation.entityId) throw badRequest('Malformed mutation');
  const def = entityDef(mutation.entity);
  if (!def) throw badRequest(`Unknown entity ${mutation.entity}`);

  return tx(() => {
    const seen = get(`SELECT id FROM applied_mutations WHERE id = ?`, mutation.id);
    if (seen) return null; // retried push, already applied
    run(`INSERT INTO applied_mutations (id, workspace_id, applied_at) VALUES (?, ?, ?)`, mutation.id, workspaceId, Date.now());

    if (def.readOnly && !(mutation.entity === 'notification')) throw forbidden(`${mutation.entity} is read-only`);
    if (mutation.entity === 'notification') {
      // Users may only flip read/archived state on their own notifications.
      const row = get<Row>(`SELECT user_id FROM notifications WHERE id = ?`, mutation.entityId);
      if (!row || row.user_id !== actorId) throw forbidden('Not your notification');
    }

    const { row, forced } = writeEntity(mutation.entity as EntityName, mutation.entityId, mutation.patch ?? {}, {
      workspaceId,
      actorId,
      hlc: mutation.hlc,
      op: mutation.op === 'delete' ? 'delete' : 'upsert',
      origin: clientId,
    });

    return Object.keys(forced).length ? { id: row.id, ...forced, seq: row.seq, updated_at: row.updated_at } : null;
  });
}

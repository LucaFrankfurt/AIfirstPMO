import {
  ENTITY_NAMES,
  ENTITIES,
  entityDef,
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
    case 'user':
      return `AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = ${table}.id AND wm.workspace_id = ?1 AND wm.deleted_at IS NULL)`;
    case 'notification':
      return `AND ${table}.user_id = ?2`;
    case 'task':
    case 'state':
    case 'taskType':
    case 'field':
    case 'fieldValue':
    case 'cycle':
    case 'module':
    case 'projectMember':
      return `AND ${table}.project_id IN (${VISIBLE_PROJECTS})`;
    case 'project':
      return `AND ${table}.id IN (${VISIBLE_PROJECTS})`;
    case 'label':
    case 'view':
    case 'webhook':
    case 'timeEntry':
      // Time is not private: a lead has to be able to add up the project. It is
      // scoped to the project like everything else, and an entry with no
      // project is the writer's own loose time.
      return `AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS}))`;
    case 'page':
      return `AND (${table}.project_id IS NULL OR ${table}.project_id IN (${VISIBLE_PROJECTS}))
              AND (${table}.access <> 'private' OR ${table}.created_by = ?2)`;
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

function fetchChanges(scope: Scope, since: number, upto: number): { changes: ChangeSet; cursor: number; hasMore: boolean } {
  const raw = new Map<EntityName, Row[]>();
  let cursor = upto;

  for (const entity of SYNCED) {
    const table = ENTITIES[entity].table;
    const ws = entity === 'user' ? '' : `AND ${table}.workspace_id = ?1`;
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
    if (!hasRole(role, 'member')) throw forbidden('Guests cannot modify this workspace');
    if (!Array.isArray(body.mutations)) throw badRequest('mutations must be an array');
    if (body.mutations.length > 500) throw badRequest('Too many mutations in one push (max 500)');

    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    const patched: ChangeSet = {};

    for (const mutation of body.mutations) {
      try {
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

    const unsubscribe = subscribe(workspaceId, (event) => {
      if (event.origin && event.origin === clientId) return; // do not echo the sender
      ctx.res.write(`event: change\ndata: ${JSON.stringify({ cursor: event.seq, kind: event.kind })}\n\n`);
    });

    const keepAlive = setInterval(() => ctx.res.write(`: ping\n\n`), 25_000);
    const stop = () => {
      clearInterval(keepAlive);
      unsubscribe();
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

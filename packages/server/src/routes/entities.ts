import {
  COLLECTIONS, ENTITIES, IMPORT_FIELDS, convert, detectFormat, isGuestWritable,
  type EntityName, type ImportField, type Mapping,
} from '@kolibri/shared';
import { all, get, type Row } from '../db/index.ts';
import { hasRole, requireAuth, requireWorkspace } from '../lib/auth.ts';
import { serverClock, createProject } from '../lib/bootstrap.ts';
import { badRequest, flag, forbidden, notFound, readJson, type Ctx, type Router } from '../lib/http.ts';
import { uid } from '../lib/ids.ts';
import { automationRuns, instantiateTemplate } from '../lib/automation.ts';
import { importCsv } from '../lib/import.ts';
import { copyProject, type CopyOptions } from '../lib/copy.ts';
import { exportProject, importProject, type ProjectDoc } from '../lib/transfer.ts';
import { canSeeChannel, canSeeProject, deleteEntity, serialize, writeEntity } from '../lib/repo.ts';
import { emptyTrash, purgeable } from '../lib/trash.ts';
import { env } from '../env.ts';

/**
 * URL segment -> entity. Everything the sync engine knows is also plain REST.
 *
 * Derived from the shared `COLLECTIONS` map rather than written out again, so a
 * new entity is one line in one file. `user`, `member` and `activity` are read
 * through their own routes and are not in this table.
 */
export const REST_ENTITIES: Record<string, EntityName> = Object.fromEntries(
  (Object.entries(COLLECTIONS) as [EntityName, string][])
    .filter(([entity]) => entity !== 'user' && entity !== 'member' && entity !== 'activity')
    .map(([entity, segment]) => [segment, entity]),
);

const resolve = (segment: string): EntityName => {
  const entity = REST_ENTITIES[segment];
  if (!entity) throw notFound(`Unknown collection ${segment}`);
  return entity;
};

const workspaceOf = (entity: EntityName, id: string): Row => {
  const row = get<Row>(`SELECT * FROM ${ENTITIES[entity].table} WHERE id = ?`, id);
  if (!row) throw notFound(`${entity} not found`);
  return row;
};

/** A project row guards itself; everything else guards through its project. */
const projectOf = (entity: EntityName, row: Row): string | null =>
  (entity === 'project' ? row.id : row.project_id) ?? null;

function guardProject(userId: string, entity: EntityName, row: Row): void {
  if (!canSeeProject(userId, projectOf(entity, row))) throw forbidden('Project is private');
}

/**
 * A conversation guards itself, and its messages and read markers guard through
 * it.
 *
 * The write paths already refuse through `repo.ts`; this is the read side,
 * which has no write to refuse. Reading a row by its id is the one way into a
 * private channel that does not go through a list, so it is the one that has
 * to be closed explicitly.
 */
function guardChat(userId: string, entity: EntityName, row: Row): void {
  if (entity === 'channel' && !canSeeChannel(userId, String(row.id))) {
    throw forbidden('You are not in that conversation');
  }
  if ((entity === 'message' || entity === 'channelRead') && !canSeeChannel(userId, String(row.channel_id))) {
    throw forbidden('You are not in that conversation');
  }
  if (entity === 'channelRead' && row.user_id !== userId) {
    throw forbidden('That read marker is somebody else\'s');
  }
}

export function registerEntityRoutes(router: Router): void {
  /* ----------------------------------------------------- audit log */

  /**
   * What happened in this workspace.
   *
   * Activity has always been recorded per task; this is the same rows read
   * across the whole workspace, which is the question an auditor actually asks.
   * Admins only — "who did what" is not something every member should browse,
   * and the per-task trail is already visible to anybody who can see the task.
   */
  router.get('/api/workspaces/:ws/audit', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const role = requireWorkspace(ctx, ctx.params.ws, 'admin');
    void role;

    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 500);
    const before = Number(ctx.query.get('before') ?? 0) || Date.now() + 1;
    const actor = ctx.query.get('actor');
    const project = ctx.query.get('project');

    const where = ['a.workspace_id = ?', 'a.deleted_at IS NULL', 'a.created_at < ?'];
    const params: unknown[] = [ctx.params.ws, before];
    if (actor) { where.push('a.actor_id = ?'); params.push(actor); }
    if (project) { where.push('a.project_id = ?'); params.push(project); }

    const rows = all<Row>(
      `SELECT a.*, u.name AS actor_name, t.identifier AS task_identifier, t.title AS task_title,
              p.title AS page_title, pr.name AS project_name
         FROM activities a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN tasks t ON t.id = a.task_id
         LEFT JOIN pages p ON p.id = a.page_id
         LEFT JOIN projects pr ON pr.id = a.project_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT ?`,
      ...params, limit,
    );
    // The private projects this admin is not a member of stay out: being an
    // admin is not the same as being invited.
    const visible = rows.filter((row) => !row.project_id || canSeeProject(auth.userId, String(row.project_id)));
    return { entries: visible, oldest: visible[visible.length - 1]?.created_at ?? null };
  });

  /* -------------------------------------------------------- import */

  /**
   * CSV import. Always run twice by the interface: once with `dry_run` to show
   * what would happen, once without to do it.
   *
   * The file is parsed here rather than trusting rows the client assembled, so
   * what the preview promised and what lands are the same code path.
   */
  router.post('/api/workspaces/:ws/import', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');

    const body = await readJson<{
      csv?: string;
      project_id?: string;
      mapping?: Record<string, string>;
      delimiter?: string;
      dry_run?: boolean;
    }>(ctx, 12 * 1024 * 1024);

    if (typeof body.csv !== 'string' || !body.csv.trim()) throw badRequest('csv is required');
    if (!body.project_id) throw badRequest('project_id is required');
    const project = get<Row>(
      `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      body.project_id, ctx.params.ws,
    );
    if (!project) throw notFound('Project not found');
    if (!canSeeProject(auth.userId, project.id)) throw forbidden('That project is private');

    // Only the fields the importer knows; anything else is a column to ignore,
    // not a way to write a column the registry does not expose.
    const mapping: Mapping = {};
    for (const [column, field] of Object.entries(body.mapping ?? {})) {
      if ((IMPORT_FIELDS as readonly string[]).includes(field)) mapping[column] = field as ImportField;
    }

    return importCsv(body.csv, {
      workspaceId: ctx.params.ws,
      projectId: project.id,
      actorId: auth.userId,
      mapping,
      dryRun: body.dry_run !== false,
      delimiter: body.delimiter,
      opts: { workspaceId: ctx.params.ws, actorId: auth.userId, hlc: serverClock.now() },
    });
  });

  /** List: `/api/workspaces/:ws/tasks?project_id=…&state_id=…&limit=100`. */
  /**
   * Copy a project.
   *
   * Any project can be a template — a project that has been run for six months
   * describes how a team works better than a form somebody filled in once. One
   * transaction on the server, because half a copied project is worse than none.
   */
  router.post('/api/workspaces/:ws/projects/:id/copy', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const source = get<Row>(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      ctx.params.id, ctx.params.ws);
    if (!source) throw notFound('Project not found');
    if (!canSeeProject(auth.userId, source.id)) throw forbidden('That project is private');

    const body = await readJson<CopyOptions>(ctx);
    const report = copyProject(ctx.params.ws, auth.userId, String(source.id), {
      name: String(body.name ?? ''),
      key: body.key,
      parentId: body.parentId,
      teamId: body.teamId,
      include: body.include,
    });
    return { project: serialize('project', report.project), counts: report.counts };
  });

  /**
   * A project as a JSON document — for moving it to another instance, and for
   * reading it. Deliberately not the backup format: `kolibri backup` copies the
   * database because a backup has to be exact, while this is a portable
   * description that survives a schema that has moved on.
   */
  router.get('/api/workspaces/:ws/projects/:id/export', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws);
    const project = get<Row>(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      ctx.params.id, ctx.params.ws);
    if (!project) throw notFound('Project not found');
    if (!canSeeProject(auth.userId, project.id)) throw forbidden('That project is private');
    return exportProject(ctx.params.ws, String(project.id));
  });

  /**
   * Read such a document back, as a new project — or one of the other tools'.
   *
   * A Jira search response, a Linear query result, a Plane issue list or an
   * OpenProject collection is recognised by its shape and converted first. The
   * conversion's notes come back with the report, because "1 204 tasks
   * imported" without "and 84 custom fields were dropped" is a lie by omission.
   */
  router.post('/api/workspaces/:ws/import/json', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const body = await readJson<{ document?: unknown; name?: string; key?: string; match_people?: boolean }>(ctx, 24 * 1024 * 1024);

    let document = body.document;
    let notes: string[] = [];
    let from: string | null = null;
    if (detectFormat(document)) {
      const converted = convert(document);
      document = converted.document;
      notes = converted.notes;
      from = converted.format;
    }

    const report = importProject(ctx.params.ws, auth.userId, document as ProjectDoc, {
      name: body.name,
      key: body.key,
      matchPeople: body.match_people !== false,
    });
    return {
      project: serialize('project', report.project),
      counts: report.counts,
      unmatched: report.unmatched,
      from,
      notes,
    };
  });

  /**
   * What a file is, before anybody imports it. A dry run for the JSON path,
   * matching the one CSV already has: nothing is written.
   */
  router.post('/api/workspaces/:ws/import/json/inspect', async (ctx: Ctx) => {
    requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    const body = await readJson<{ document?: unknown }>(ctx, 24 * 1024 * 1024);
    const doc = body.document as Record<string, unknown> | undefined;
    if (doc && typeof doc.format === 'string' && doc.format.startsWith('kolibri.project/')) {
      return {
        from: 'kolibri',
        name: (doc.project as Record<string, unknown>)?.name ?? '',
        tasks: Array.isArray(doc.tasks) ? doc.tasks.length : 0,
        notes: [] as string[],
      };
    }
    if (!detectFormat(body.document)) throw badRequest('That file is not an export this can read');
    const converted = convert(body.document);
    const project = converted.document.project as Record<string, unknown>;
    return {
      from: converted.format,
      name: project.name ?? '',
      tasks: (converted.document.tasks as unknown[]).length,
      notes: converted.notes,
    };
  });

  /**
   * Accept a report, or decline it.
   *
   * Accepting is what turns it into a task — which is why it is a route rather
   * than a field somebody sets: a task has to be created, numbered and told to
   * whoever is on it, and none of that is a patch on an intake row.
   */
  router.post('/api/intakes/:id/:verb', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const verb = ctx.params.verb;
    if (verb !== 'accept' && verb !== 'decline') throw notFound('Unknown action');

    const intake = get<Row>(`SELECT * FROM intakes WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
    if (!intake) throw notFound('Not found');
    requireWorkspace(ctx, String(intake.workspace_id), 'member');
    if (!canSeeProject(auth.userId, intake.project_id)) throw forbidden('That project is private');
    if (intake.status !== 'new') throw badRequest('That report has already been dealt with');

    const hlc = serverClock.now();
    const done = { status: verb === 'accept' ? 'accepted' : 'declined', handled_by: auth.userId, handled_at: Date.now() };

    if (verb === 'decline') {
      writeEntity('intake', String(intake.id), done, { workspaceId: String(intake.workspace_id), actorId: auth.userId, hlc, system: true });
      return { intake: serialize('intake', get<Row>(`SELECT * FROM intakes WHERE id = ?`, intake.id)!) };
    }

    const body = await readJson<{ title?: string; state_id?: string; type_id?: string; assignees?: string[] }>(ctx);
    // The reporter's words are the description, credited. Their name is not a
    // user here and never will be, so it is prose rather than a foreign key.
    const credit = [intake.reporter, intake.email].filter(Boolean).join(' · ');
    const { row: task } = writeEntity('task', uid(), {
      workspace_id: intake.workspace_id,
      project_id: intake.project_id,
      title: String(body.title ?? intake.title),
      description: [intake.body, credit ? `\n\n— reported by ${credit}` : ''].filter(Boolean).join(''),
      state_id: body.state_id,
      type_id: body.type_id,
      assignees: body.assignees ?? [],
      created_by: auth.userId,
    }, { workspaceId: String(intake.workspace_id), actorId: auth.userId, hlc: serverClock.now() });

    writeEntity('intake', String(intake.id), { ...done, task_id: task.id }, {
      workspaceId: String(intake.workspace_id), actorId: auth.userId, hlc, system: true,
    });
    return {
      intake: serialize('intake', get<Row>(`SELECT * FROM intakes WHERE id = ?`, intake.id)!),
      task: serialize('task', task),
    };
  });

  /**
   * What is waiting in the trash, and how much disk it is holding.
   *
   * `days` asks the same question of an age — "what would a thirty-day policy
   * take", so the number in the confirmation is the number that will go.
   */
  router.get('/api/workspaces/:ws/trash', (ctx: Ctx) => {
    requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'admin');
    const days = Math.max(0, Number(ctx.query.get('days') ?? 0) || 0);
    const before = days ? Date.now() - days * 86_400_000 : Date.now();
    return { ...purgeable(ctx.params.ws, before), retentionDays: env.trashDays };
  });

  /**
   * Empty it. Admins only, and not because the interface says so: a delete is
   * reversible until this runs, and this is the one call in the app that ends
   * that.
   */
  router.post('/api/workspaces/:ws/trash/empty', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'admin');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const body = await readJson<{ days?: number }>(ctx);
    const days = Math.max(0, Number(body.days ?? 0) || 0);
    const before = days ? Date.now() - days * 86_400_000 : Date.now();
    return emptyTrash(ctx.params.ws, 'manual', before);
  });

  /**
   * The newest thing this person has not read, for the service worker.
   *
   * One row, already worded for them, so a push can carry nothing and the
   * worker can still show a sentence rather than "something happened".
   */
  router.get('/api/notifications/latest', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const row = get<Row>(
      `SELECT * FROM notifications
        WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      auth.userId,
    );
    if (!row) return null;
    return {
      title: row.title,
      body: row.body,
      url: row.task_id ? `/t/${row.task_id}`
        : row.page_id ? `/pages/${row.page_id}`
          : row.project_id ? `/projects/${row.project_id}?tab=intake`
            : '/inbox',
      unread: Number(get<Row>(
        `SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
        auth.userId,
      )?.n ?? 0),
    };
  });

  router.get('/api/workspaces/:ws/:collection', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws);
    const entity = resolve(ctx.params.collection);
    const def = ENTITIES[entity];
    const filters: string[] = [`workspace_id = ?`];
    const params: unknown[] = [ctx.params.ws];

    for (const field of def.fields) {
      const value = ctx.query.get(field);
      if (value === null) continue;
      if (value === 'null') filters.push(`${field} IS NULL`);
      else {
        filters.push(`${field} = ?`);
        params.push(value);
      }
    }
    if (!flag(ctx.query, 'include_deleted')) filters.push('deleted_at IS NULL');
    if (entity === 'notification' || entity === 'channelRead') {
      filters.push('user_id = ?');
      params.push(auth.userId);
    }
    // A private conversation is not listed to somebody who is not in it. In SQL
    // rather than only in the filter below, so `limit` counts rows the caller
    // may actually have — a page trimmed afterwards is a page that lies about
    // how much is left.
    if (entity === 'channel') {
      filters.push(`(is_private = 0 OR EXISTS (SELECT 1 FROM json_each(channels.members) WHERE json_each.value = ?))`);
      params.push(auth.userId);
    }
    if (entity === 'message') {
      filters.push(`EXISTS (SELECT 1 FROM channels c
                             WHERE c.id = messages.channel_id AND c.deleted_at IS NULL
                               AND (c.is_private = 0
                                    OR EXISTS (SELECT 1 FROM json_each(c.members) WHERE json_each.value = ?)))`);
      params.push(auth.userId);
    }

    const limit = Math.min(Number(ctx.query.get('limit') ?? 200) || 200, 1000);
    const offset = Math.max(Number(ctx.query.get('offset') ?? 0) || 0, 0);
    const sortable = new Set([...def.fields, 'created_at', 'updated_at', 'seq']);
    const orderField = ctx.query.get('order_by') ?? 'created_at';
    const order = sortable.has(orderField) ? orderField : 'created_at';
    const direction = (ctx.query.get('order') ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const rows = all<Row>(
      `SELECT * FROM ${def.table} WHERE ${filters.join(' AND ')} ORDER BY ${order} ${direction} LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
    return rows
      .filter((row) => canSeeProject(auth.userId, projectOf(entity, row)))
      // A message carries no project of its own, so its project answer is its
      // channel's. Asked here rather than folded into the SQL above because it
      // is the same question `canSeeChannel` already answers for every write.
      .filter((row) => entity !== 'message' || canSeeChannel(auth.userId, row.channel_id))
      .map((row) => serialize(entity, row));
  });

  /** Create. Projects get their default states/labels for free. */
  router.post('/api/workspaces/:ws/:collection', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const role = requireWorkspace(ctx, ctx.params.ws);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const entity = resolve(ctx.params.collection);
    // A guest may write the rows that are only about themselves — a read marker
    // is not content, it is a note somebody keeps about their own position in
    // one. Everything else is still refused.
    if (!hasRole(role, 'member') && !isGuestWritable(entity)) throw forbidden('Guests cannot create content');
    const body = await readJson<Record<string, unknown>>(ctx);

    if (entity === 'project') {
      const project = createProject(ctx.params.ws, auth.userId, {
        name: String(body.name ?? 'Untitled project'),
        key: body.key as string | undefined,
        description: body.description as string | undefined,
        teamId: (body.team_id as string) ?? null,
        icon: body.icon as string | undefined,
        color: body.color as string | undefined,
        visibility: body.visibility === 'private' ? 'private' : 'public',
      });
      return serialize('project', project);
    }

    const id = typeof body.id === 'string' ? body.id : uid();
    const { row } = writeEntity(entity, id, { ...body, workspace_id: ctx.params.ws }, {
      workspaceId: ctx.params.ws,
      actorId: auth.userId,
      hlc: serverClock.now(),
    });
    return serialize(entity, row);
  });

  router.get('/api/:collection/:id', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const entity = resolve(ctx.params.collection);
    const row = workspaceOf(entity, ctx.params.id);
    requireWorkspace(ctx, row.workspace_id);
    guardProject(auth.userId, entity, row);
    guardChat(auth.userId, entity, row);
    if (entity === 'notification' && row.user_id !== auth.userId) throw forbidden('Not your notification');
    return serialize(entity, row);
  });

  router.patch('/api/:collection/:id', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const entity = resolve(ctx.params.collection);
    const row = workspaceOf(entity, ctx.params.id);
    const role = requireWorkspace(ctx, row.workspace_id);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    if (!hasRole(role, 'member') && !isGuestWritable(entity)) throw forbidden('Guests cannot edit content');
    guardProject(auth.userId, entity, row);
    guardChat(auth.userId, entity, row);
    if (entity === 'notification' && row.user_id !== auth.userId) throw forbidden('Not your notification');
    const body = await readJson<Record<string, unknown>>(ctx);
    const { row: updated } = writeEntity(entity, ctx.params.id, body, {
      workspaceId: row.workspace_id,
      actorId: auth.userId,
      hlc: serverClock.now(),
    });
    return serialize(entity, updated);
  });

  router.delete('/api/:collection/:id', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const entity = resolve(ctx.params.collection);
    const row = workspaceOf(entity, ctx.params.id);
    requireWorkspace(ctx, row.workspace_id, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    guardProject(auth.userId, entity, row);
    guardChat(auth.userId, entity, row);
    deleteEntity(entity, ctx.params.id, {
      workspaceId: row.workspace_id, actorId: auth.userId, hlc: serverClock.now(),
    });
    return { ok: true };
  });

  /* --------------------------------------------------- task extras */

  /** What a rule has actually done, so one that never fires is not a mystery. */
  router.get('/api/automations/:id/runs', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const rule = workspaceOf('automation', ctx.params.id);
    requireWorkspace(ctx, String(rule.workspace_id));
    guardProject(auth.userId, 'automation', rule);
    return automationRuns(ctx.params.id, Number(ctx.query.get('limit') ?? 25));
  });

  /**
   * Make a real task out of a template by hand. The same code path an
   * automation uses, so what you get from the button is what the rule files.
   */
  router.post('/api/templates/:id/apply', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const template = workspaceOf('template', ctx.params.id);
    const role = requireWorkspace(ctx, String(template.workspace_id), 'member');
    if (!hasRole(role, 'member')) throw forbidden('Guests cannot create content');

    const body = await readJson<{ project_id?: string; assignees?: string[] }>(ctx);
    const projectId = body.project_id ?? template.target_project_id ?? template.project_id;
    if (!projectId) throw badRequest('This template has no project — pass project_id');
    if (!canSeeProject(auth.userId, String(projectId))) throw forbidden('Project is private');

    const project = get<Row>(`SELECT * FROM projects WHERE id = ?`, projectId);
    const actor = get<Row>(`SELECT name FROM users WHERE id = ?`, auth.userId);
    const task = instantiateTemplate(template, {
      workspaceId: String(template.workspace_id),
      actorId: auth.userId,
      projectId: String(projectId),
      assignees: Array.isArray(body.assignees) ? body.assignees : undefined,
      // A template used by hand has no source task, so only the names that can
      // be known are filled; the rest stay as written rather than becoming holes.
      vars: { project: String(project?.name ?? ''), actor: String(actor?.name ?? '') },
    });
    return serialize('task', task);
  });

  router.get('/api/tasks/:id/activity', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const task = workspaceOf('task', ctx.params.id);
    requireWorkspace(ctx, task.workspace_id);
    guardProject(auth.userId, 'task', task);
    return all<Row>(
      `SELECT * FROM activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 200`,
      ctx.params.id,
    ).map((row) => serialize('activity', row));
  });

  router.get('/api/tasks/:id/children', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const task = workspaceOf('task', ctx.params.id);
    requireWorkspace(ctx, task.workspace_id);
    guardProject(auth.userId, 'task', task);
    return all<Row>(`SELECT * FROM tasks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order`, ctx.params.id)
      .map((row) => serialize('task', row));
  });

  /** Look a task up the way humans refer to it: `KOL-42`. */
  router.get('/api/workspaces/:ws/by-identifier/:identifier', (ctx: Ctx) => {
    requireWorkspace(ctx, ctx.params.ws);
    const row = get<Row>(
      `SELECT * FROM tasks WHERE workspace_id = ? AND identifier = ? AND deleted_at IS NULL`,
      ctx.params.ws, ctx.params.identifier.toUpperCase(),
    );
    if (!row) throw notFound(`No task ${ctx.params.identifier}`);
    guardProject(requireAuth(ctx).userId, 'task', row);
    return serialize('task', row);
  });

  /* --------------------------------------------------- page history */

  router.get('/api/pages/:id/versions', (ctx: Ctx) => {
    const page = workspaceOf('page', ctx.params.id);
    requireWorkspace(ctx, page.workspace_id);
    return all<Row>(
      `SELECT id, title, author_id, created_at, length(content) AS size FROM page_versions
        WHERE page_id = ? ORDER BY created_at DESC LIMIT 100`,
      ctx.params.id,
    );
  });

  router.get('/api/pages/:id/versions/:versionId', (ctx: Ctx) => {
    const page = workspaceOf('page', ctx.params.id);
    requireWorkspace(ctx, page.workspace_id);
    const version = get<Row>(`SELECT * FROM page_versions WHERE id = ? AND page_id = ?`, ctx.params.versionId, ctx.params.id);
    if (!version) throw notFound('Version not found');
    return version;
  });

  router.post('/api/pages/:id/versions', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const page = workspaceOf('page', ctx.params.id);
    requireWorkspace(ctx, page.workspace_id, 'member');
    const body = await readJson<{ restore?: string }>(ctx);
    if (body.restore) {
      const version = get<Row>(`SELECT * FROM page_versions WHERE id = ? AND page_id = ?`, body.restore, ctx.params.id);
      if (!version) throw notFound('Version not found');
      const { row } = writeEntity('page', ctx.params.id, { content: version.content, title: version.title }, {
        workspaceId: page.workspace_id, actorId: auth.userId, hlc: serverClock.now(),
      });
      return serialize('page', row);
    }
    throw badRequest('Pass { restore: versionId } to restore a version');
  });

  /* --------------------------------------------------- bulk helpers */

  /** One round trip for "move these five tasks to In Progress". */
  router.post('/api/workspaces/:ws/tasks/bulk', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    const body = await readJson<{ ids?: string[]; patch?: Record<string, unknown>; op?: 'update' | 'delete' }>(ctx);
    if (!Array.isArray(body.ids) || !body.ids.length) throw badRequest('ids is required');
    if (body.ids.length > 500) throw badRequest('Too many ids (max 500)');
    const updated: Row[] = [];
    for (const id of body.ids) {
      const task = get<Row>(`SELECT * FROM tasks WHERE id = ? AND workspace_id = ?`, id, ctx.params.ws);
      if (!task) continue;
      const { row } = writeEntity('task', id, body.op === 'delete' ? {} : body.patch ?? {}, {
        workspaceId: ctx.params.ws, actorId: auth.userId, hlc: serverClock.now(),
        op: body.op === 'delete' ? 'delete' : 'upsert',
      });
      updated.push(serialize('task', row)!);
    }
    return { updated: updated.length, tasks: updated };
  });
}

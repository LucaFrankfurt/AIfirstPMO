import { ENTITIES, entityDef, hlcGreater, type EntityName } from '@kolibri/shared';
import { all, get, nextSeq, run, tx, type Row } from '../db/index.ts';
import { badRequest, notFound } from './http.ts';
import { uid } from './ids.ts';
import { publish } from './bus.ts';
import { runAutomations } from './automation.ts';
import { translatorFor } from './i18n.ts';

type Translator = ReturnType<typeof translatorFor>;

export interface WriteOpts {
  workspaceId: string;
  actorId: string;
  hlc: string;
  /** Internal callers may set server-managed fields (identifiers, counters). */
  system?: boolean;
  /** Client id that produced the change; echoed on the event stream. */
  origin?: string;
  op?: 'upsert' | 'delete';
  silent?: boolean;
}

export interface WriteResult {
  row: Row;
  /** Fields the server decided itself — pushed back to the client verbatim. */
  forced: Record<string, unknown>;
  created: boolean;
}

const JSON_DEFAULTS: Record<string, string> = { assignees: '[]', labels: '[]', subscribers: '[]', reactions: '{}', filters: '{}' };

const isJsonField = (entity: EntityName, field: string): boolean =>
  ((ENTITIES[entity] as { json?: readonly string[] }).json ?? []).includes(field);

/** Turn a stored row into the shape clients and the API speak. */
export function serialize(entity: EntityName, row: Row | undefined): Row | undefined {
  if (!row) return undefined;
  const def = ENTITIES[entity];
  const out: Row = { id: row.id };
  for (const field of [...def.fields, ...((def as { serverOnly?: readonly string[] }).serverOnly ?? [])]) {
    let value = row[field];
    if (isJsonField(entity, field)) {
      try {
        value = JSON.parse(value ?? JSON_DEFAULTS[field] ?? 'null');
      } catch {
        value = JSON.parse(JSON_DEFAULTS[field] ?? 'null');
      }
    }
    out[field] = value ?? null;
  }
  out.created_at = row.created_at;
  out.updated_at = row.updated_at;
  out.deleted_at = row.deleted_at ?? null;
  out.seq = row.seq;
  return out;
}

export function readRaw(entity: EntityName, id: string): Row | undefined {
  return get<Row>(`SELECT * FROM ${ENTITIES[entity].table} WHERE id = ?`, id);
}

export function read(entity: EntityName, id: string): Row | undefined {
  return serialize(entity, readRaw(entity, id));
}

export function readOrThrow(entity: EntityName, id: string): Row {
  const row = read(entity, id);
  if (!row || row.deleted_at) throw notFound(`${entity} ${id} not found`);
  return row;
}

/**
 * The single write path for every entity: REST, sync push, MCP and the seeder
 * all funnel through here, so merge semantics and side effects can never drift
 * apart between them.
 *
 * Per-field last-writer-wins: a field is only overwritten when the incoming HLC
 * stamp is newer than the stamp stored for that same field. Two offline clients
 * editing different fields therefore both keep their change.
 */
export function writeEntity(entity: EntityName, id: string, patch: Record<string, unknown>, opts: WriteOpts): WriteResult {
  const def = entityDef(entity);
  if (!def) throw badRequest(`Unknown entity ${entity}`);
  if (def.readOnly && !opts.system) throw badRequest(`${entity} is managed by the server`);

  return tx(() => {
    const table = def.table;
    const existing = get<Row>(`SELECT * FROM ${table} WHERE id = ?`, id);
    const clocks: Record<string, string> = existing?.clocks ? safeJson(existing.clocks) : {};
    const now = Date.now();
    const created = !existing;

    const writable = new Set<string>(def.fields);
    if (opts.system) for (const f of def.serverOnly ?? []) writable.add(f);
    else for (const f of def.serverOnly ?? []) writable.delete(f);

    const values: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (!writable.has(field)) continue;
      if (!opts.system && !hlcGreater(opts.hlc, clocks[field])) continue; // stale write, drop it
      values[field] = isJsonField(entity, field) && typeof value === 'object' ? JSON.stringify(value) : normalize(value);
      clocks[field] = opts.hlc;
    }

    const deleting = opts.op === 'delete';
    if (deleting && (opts.system || hlcGreater(opts.hlc, clocks.__deleted))) {
      values.deleted_at = now;
      clocks.__deleted = opts.hlc;
    } else if (!deleting && existing?.deleted_at && (opts.system || hlcGreater(opts.hlc, clocks.__deleted))) {
      values.deleted_at = null; // an edit resurrects a row deleted concurrently elsewhere
      clocks.__deleted = opts.hlc;
    }

    if (!created && Object.keys(values).length === 0) {
      return { row: existing!, forced: {}, created: false };
    }

    const forced = created ? applyCreateDefaults(entity, id, values, opts) : {};
    applyInvariants(entity, values, existing, forced);

    const seq = nextSeq();
    const row = created
      ? insertRow(table, { ...values, id, workspace_id: opts.workspaceId, created_at: now, updated_at: now, seq, clocks: JSON.stringify(clocks) })
      : updateRow(table, id, { ...values, updated_at: now, seq, clocks: JSON.stringify(clocks) });

    afterWrite(entity, row, existing, values, opts);
    if (!opts.silent) publish({ workspaceId: opts.workspaceId, seq, origin: opts.origin, kind: entity });
    return { row, forced, created };
  });
}

export function deleteEntity(entity: EntityName, id: string, opts: Omit<WriteOpts, 'op'>): WriteResult {
  return writeEntity(entity, id, {}, { ...opts, op: 'delete' });
}

/* ------------------------------------------------------------------ helpers */

const safeJson = (raw: string): Record<string, string> => {
  try { return JSON.parse(raw) as Record<string, string>; } catch { return {}; }
};

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  return value;
}

function insertRow(table: string, data: Record<string, unknown>): Row {
  const cols = Object.keys(data);
  run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => data[c]),
  );
  return get<Row>(`SELECT * FROM ${table} WHERE id = ?`, data.id)!;
}

function updateRow(table: string, id: string, data: Record<string, unknown>): Row {
  const cols = Object.keys(data);
  run(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    ...cols.map((c) => data[c]), id,
  );
  return get<Row>(`SELECT * FROM ${table} WHERE id = ?`, id)!;
}

/* ----------------------------------------------------------------- defaults */

function applyCreateDefaults(entity: EntityName, id: string, values: Record<string, unknown>, opts: WriteOpts): Record<string, unknown> {
  const forced: Record<string, unknown> = {};
  const setForced = (field: string, value: unknown) => {
    values[field] = value;
    forced[field] = value;
  };

  if (entity === 'task') {
    const project = get<Row>(`SELECT * FROM projects WHERE id = ?`, values.project_id);
    if (!project) throw badRequest('task.project_id must reference an existing project');
    if (project.workspace_id !== opts.workspaceId) throw badRequest('project belongs to another workspace');
    if (values.number === undefined || values.identifier === undefined) {
      const number = Number(project.next_number ?? 1);
      run(`UPDATE projects SET next_number = ? WHERE id = ?`, number + 1, project.id);
      setForced('number', number);
      setForced('identifier', `${project.key}-${number}`);
    }
    if (!values.state_id) {
      const fallback = project.default_state_id
        ?? get<Row>(`SELECT id FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, project.id)?.id;
      if (fallback) setForced('state_id', fallback);
    }
    if (!values.created_by) setForced('created_by', opts.actorId);
    if (!values.sort_order) setForced('sort_order', 'V');
    if (!values.subscribers) values.subscribers = JSON.stringify([opts.actorId]);
  }

  if (entity === 'page' && !values.created_by) setForced('created_by', opts.actorId);
  if (entity === 'comment' && !values.author_id) setForced('author_id', opts.actorId);
  if (entity === 'attachment' && !values.uploaded_by) setForced('uploaded_by', opts.actorId);
  if (entity === 'view' && !values.owner_id) setForced('owner_id', opts.actorId);
  // Time is logged by whoever is logging it. Filing it under somebody else is
  // a timesheet-approval feature, not a field a client gets to set casually.
  if (entity === 'timeEntry') {
    setForced('user_id', opts.actorId);
    if (!values.spent_on) setForced('spent_on', new Date().toISOString().slice(0, 10));
  }
  if (entity === 'project') {
    if (!values.key) setForced('key', `P${id.slice(0, 4).toUpperCase()}`);
    if (!values.name) setForced('name', 'Untitled project');
  }
  return forced;
}

/** Rules the server enforces regardless of what a client sent. */
function applyInvariants(entity: EntityName, values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  if (entity !== 'task') return;
  const stateId = (values.state_id ?? existing?.state_id) as string | undefined;
  if (values.state_id !== undefined && stateId) {
    const state = get<{ group_key: string }>(`SELECT group_key FROM states WHERE id = ?`, stateId);
    const done = state?.group_key === 'completed' || state?.group_key === 'cancelled';
    const wasDone = existing?.completed_at != null;
    if (done && !wasDone) {
      values.completed_at = Date.now();
      forced.completed_at = values.completed_at;
    } else if (!done && wasDone) {
      values.completed_at = null;
      forced.completed_at = null;
    }
  }
}

/* -------------------------------------------------------------- side effects */

function afterWrite(entity: EntityName, row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  indexForSearch(entity, row);
  if (entity === 'page' && before && changed.content !== undefined) snapshotPage(before, opts.actorId);
  if (opts.system) return;
  recordActivity(entity, row, before, changed, opts);
  notify(entity, row, before, changed, opts);
  runAutomations(entity, row, before, changed, opts);
}

/**
 * Page history: we store the *previous* revision whenever content changes, and
 * collapse edits by the same author inside a short window so a typing session
 * does not produce hundreds of versions.
 */
const VERSION_WINDOW_MS = 10 * 60 * 1000;

function snapshotPage(before: Row, actorId: string): void {
  if (!before.content) return;
  const latest = get<Row>(
    `SELECT content, author_id, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    before.id,
  );
  if (latest?.content === before.content) return;
  if (latest && latest.author_id === actorId && Date.now() - Number(latest.created_at) < VERSION_WINDOW_MS) return;
  run(
    `INSERT INTO page_versions (id, page_id, content, title, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    uid(), before.id, before.content, before.title ?? '', actorId, Date.now(),
  );
}

const SEARCHABLE: Partial<Record<EntityName, (row: Row) => { title: string; body: string }>> = {
  task: (row) => ({ title: `${row.identifier ?? ''} ${row.title ?? ''}`.trim(), body: row.description ?? '' }),
  page: (row) => ({ title: row.title ?? '', body: row.content ?? '' }),
  project: (row) => ({ title: `${row.key ?? ''} ${row.name ?? ''}`.trim(), body: row.description ?? '' }),
  comment: (row) => ({ title: '', body: row.body ?? '' }),
  cycle: (row) => ({ title: row.name ?? '', body: row.description ?? '' }),
  module: (row) => ({ title: row.name ?? '', body: row.description ?? '' }),
};

function indexForSearch(entity: EntityName, row: Row): void {
  const project = SEARCHABLE[entity];
  if (!project) return;
  run(`DELETE FROM search_index WHERE kind = ? AND ref_id = ?`, entity, row.id);
  if (row.deleted_at) return;
  const { title, body } = project(row);
  run(
    `INSERT INTO search_index (kind, ref_id, workspace_id, project_id, title, body) VALUES (?, ?, ?, ?, ?, ?)`,
    entity, row.id, row.workspace_id, row.project_id ?? null, title, stripMarkdown(body).slice(0, 20_000),
  );
}

const stripMarkdown = (text: string): string =>
  String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ');

const TRACKED_FIELDS = new Set(['title', 'state_id', 'priority', 'assignees', 'due_date', 'cycle_id', 'module_id', 'estimate', 'parent_id', 'archived', 'labels']);

function recordActivity(entity: EntityName, row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  if (entity !== 'task' && entity !== 'page' && entity !== 'project') return;
  const base = {
    workspace_id: opts.workspaceId,
    project_id: entity === 'project' ? row.id : row.project_id ?? null,
    task_id: entity === 'task' ? row.id : null,
    page_id: entity === 'page' ? row.id : null,
    actor_id: opts.actorId,
  };
  const push = (verb: string, field: string | null, oldValue: unknown, newValue: unknown) => {
    run(
      `INSERT INTO activities (id, workspace_id, project_id, task_id, page_id, actor_id, verb, field, old_value, new_value, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      uid(), base.workspace_id, base.project_id, base.task_id, base.page_id, base.actor_id,
      verb, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue),
      Date.now(), Date.now(), nextSeq(),
    );
  };

  if (!before) {
    push('created', null, null, row.title ?? row.name ?? null);
    return;
  }
  if (row.deleted_at && !before.deleted_at) {
    push('deleted', null, null, null);
    return;
  }
  for (const field of Object.keys(changed)) {
    if (!TRACKED_FIELDS.has(field)) continue;
    if (String(before[field] ?? '') === String(row[field] ?? '')) continue;
    push('updated', field, before[field], row[field]);
  }
}

/**
 * Notification titles are written in the recipient's language, not the actor's:
 * a row belongs to exactly one person, so it can be rendered once, at the
 * moment it is created, and never needs translating again.
 */
function notify(entity: EntityName, row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  const targets = new Map<string, { kind: string; title: (t: Translator) => string; body: string | null }>();

  if (entity === 'task' && changed.assignees !== undefined) {
    const now = parseIds(row.assignees);
    const previous = new Set(parseIds(before?.assignees));
    for (const userId of now) {
      if (previous.has(userId) || userId === opts.actorId) continue;
      targets.set(userId, {
        kind: 'assigned',
        title: (t) => t('notify.assigned', { identifier: row.identifier, title: row.title }),
        body: null,
      });
    }
  }

  // Where a mention can be written: a comment, a task's description, a page's
  // body. Anything else is a field nobody writes prose into.
  const mentionField = entity === 'comment' ? 'body' : entity === 'task' ? 'description' : entity === 'page' ? 'content' : null;
  const mentionSource = mentionField ? changed[mentionField] : undefined;
  if (mentionField && mentionSource !== undefined) {
    const context = entity === 'comment' ? commentContext(row) : row;
    // Only handles that were not there before. A page autosaves while you type,
    // so notifying on every write would ping the same person once a second for
    // a name they were already told about.
    const already = new Set(before ? findMentions(opts.workspaceId, String(before[mentionField] ?? '')) : []);
    for (const userId of findMentions(opts.workspaceId, String(mentionSource ?? ''))) {
      if (userId === opts.actorId || already.has(userId)) continue;
      targets.set(userId, {
        kind: 'mention',
        title: (t) => t('notify.mentionedIn', { context: context?.identifier ?? context?.title ?? 'Kolibri' }),
        body: String(mentionSource ?? '').slice(0, 280),
      });
    }
  }

  if (entity === 'comment' && !before && row.task_id) {
    const task = get<Row>(`SELECT * FROM tasks WHERE id = ?`, row.task_id);
    if (task) {
      const audience = new Set([...parseIds(task.assignees), ...parseIds(task.subscribers), task.created_by]);
      for (const userId of audience) {
        if (!userId || userId === opts.actorId) continue;
        if (targets.get(userId)?.kind === 'mention') continue; // a mention is the stronger signal
        targets.set(userId, {
          kind: 'comment',
          title: (t) => t('notify.newComment', { identifier: task.identifier }),
          body: String(row.body ?? '').slice(0, 280),
        });
      }
    }
  }

  // A page has no assignees to fall back on, so its audience is the people who
  // have shown up: whoever wrote it, and whoever has said something on it.
  // Everybody who *can* see a page is the whole workspace, and notifying them
  // would teach people to ignore the bell.
  if (entity === 'comment' && !before && row.page_id) {
    const page = get<Row>(`SELECT id, title, created_by FROM pages WHERE id = ?`, row.page_id);
    if (page) {
      const talkers = all<Row>(
        `SELECT DISTINCT author_id FROM comments WHERE page_id = ? AND deleted_at IS NULL`,
        row.page_id,
      ).map((entry) => entry.author_id);
      for (const userId of new Set([page.created_by, ...talkers])) {
        if (!userId || userId === opts.actorId) continue;
        if (targets.get(userId)?.kind === 'mention') continue;
        targets.set(userId, {
          kind: 'comment',
          title: (t) => t('notify.newPageComment', { title: page.title }),
          body: String(row.body ?? '').slice(0, 280),
        });
      }
    }
  }

  if (entity === 'task' && !before && parseIds(row.assignees).length) {
    for (const userId of parseIds(row.assignees)) {
      if (userId === opts.actorId) continue;
      targets.set(userId, {
        kind: 'assigned',
        title: (t) => t('notify.assigned', { identifier: row.identifier, title: row.title }),
        body: null,
      });
    }
  }

  for (const [userId, payload] of targets) {
    run(
      `INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, task_id, page_id, actor_id, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      uid(), opts.workspaceId, userId, payload.kind, payload.title(translatorFor(userId)), payload.body,
      entity === 'task' ? row.id : row.task_id ?? null,
      entity === 'page' ? row.id : row.page_id ?? null,
      opts.actorId, Date.now(), Date.now(), nextSeq(),
    );
  }
}

/** What a comment is about — a task or a page — for a notification title. */
function commentContext(row: Row): Row | undefined {
  if (row.task_id) return get<Row>(`SELECT identifier, title FROM tasks WHERE id = ?`, row.task_id);
  if (row.page_id) return get<Row>(`SELECT title FROM pages WHERE id = ?`, row.page_id);
  return undefined;
}

/**
 * Resolve `@handles` in a body to workspace members. People type what they see:
 * a first name, a display name without spaces, or an email address — so all
 * three are accepted, and unknown handles are simply left alone.
 */
export function findMentions(workspaceId: string, text: string): string[] {
  const body = String(text ?? '');
  if (!body.includes('@')) return [];

  const handles = new Map<string, string>();
  const members = all<Row>(
    `SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
    workspaceId,
  );
  for (const member of members) {
    const email = String(member.email ?? '').toLowerCase();
    const name = String(member.name ?? '').toLowerCase();
    for (const handle of [email, email.split('@')[0], name.replace(/\s+/g, ''), name.split(/\s+/)[0]]) {
      if (handle && handle.length > 1 && !handles.has(handle)) handles.set(handle, member.id);
    }
  }

  const found = new Set<string>();
  for (const match of body.matchAll(/@([\w.+-]+(?:@[\w.-]+\.[a-z]{2,})?)/gi)) {
    const userId = handles.get(match[1].toLowerCase());
    if (userId) found.add(userId);
  }
  return [...found];
}

export function parseIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.startsWith('[')) {
    try { return (JSON.parse(value) as unknown[]).filter((v): v is string => typeof v === 'string'); } catch { return []; }
  }
  return [];
}

/* ------------------------------------------------------------- visibility */

/** Ids of projects the user may see: public ones plus private ones they joined. */
export function visibleProjectIds(userId: string, workspaceId: string): Set<string> {
  const rows = all<{ id: string }>(
    `SELECT p.id FROM projects p
      WHERE p.workspace_id = ?
        AND (p.visibility = 'public'
             OR EXISTS (SELECT 1 FROM project_members m
                         WHERE m.project_id = p.id AND m.user_id = ? AND m.deleted_at IS NULL))`,
    workspaceId, userId,
  );
  return new Set(rows.map((r) => r.id));
}

export function canSeeProject(userId: string, projectId: string | null | undefined): boolean {
  if (!projectId) return true;
  const project = get<Row>(`SELECT workspace_id, visibility FROM projects WHERE id = ?`, projectId);
  if (!project) return false;
  if (project.visibility === 'public') return true;
  return !!get(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL`, projectId, userId);
}

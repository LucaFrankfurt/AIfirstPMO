import {
  ENTITIES,
  canManageMembers,
  crdt,
  directMembers,
  entityDef,
  excerpt,
  findMentions as mentionsIn,
  hlcGreater,
  normaliseChannelName,
  relocate,
  reschedule,
  type CrdtState,
  type EntityName,
  type ProjectVocabulary,
} from '@kolibri/shared';
import { all, get, nextSeq, run, tx, type Row } from '../db/index.ts';
import { badRequest, forbidden, notFound } from './http.ts';
import { shareToken, token, uid } from './ids.ts';
import { publish } from './bus.ts';
import { runAutomations } from './automation.ts';
import { createNotification } from './notify.ts';
import { translatorFor } from './i18n.ts';
import { env } from '../env.ts';
import { dispatch } from './webhooks.ts';

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

const JSON_DEFAULTS: Record<string, string> = { assignees: '[]', labels: '[]', subscribers: '[]', reactions: '{}', filters: '{}', projects: '[]' };

const isJsonField = (entity: EntityName, field: string): boolean =>
  ((ENTITIES[entity] as { json?: readonly string[] }).json ?? []).includes(field);

/** Turn a stored row into the shape clients and the API speak. */
export function serialize(entity: EntityName, row: Row | undefined): Row | undefined {
  if (!row) return undefined;
  const def = ENTITIES[entity];
  const out: Row = { id: row.id };
  // `secret` fields are absent by construction rather than deleted afterwards:
  // a field that is never added cannot be forgotten in one code path.
  const hidden = new Set((def as { secret?: readonly string[] }).secret ?? []);
  for (const field of [...def.fields, ...((def as { serverOnly?: readonly string[] }).serverOnly ?? [])]) {
    if (hidden.has(field)) continue;
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
    // Which workspace a row is in is never the client's to say — it comes from
    // the scope the write arrived in. It matters more now that a row is allowed
    // to have *no* workspace: left writable, a client could file an open
    // channel outside every workspace, and the pull would then hand it to
    // everybody on the instance. Only the invariants below may set this.
    if (!opts.system) writable.delete('workspace_id');

    const merging = new Set<string>(def.crdt ?? []);
    const values: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (!writable.has(field)) continue;
      // A merged field has no stale write. Two devices that edited the same
      // page while apart both have something to contribute, and whichever
      // arrives second is not the loser — that is the whole point of it.
      if (merging.has(field)) {
        values[field] = mergeCrdt(existing?.[field], value);
        clocks[field] = opts.hlc;
        continue;
      }
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

    if (entity === 'task' && values.state_id !== undefined && !opts.system) {
      guardTransition(String(values.state_id), opts);
    }
    if (entity === 'channel' && !opts.system) {
      guardChannelWrite(id, values, existing, opts);
    }
    if (entity === 'message' && !opts.system) {
      guardMessageWrite(id, values, existing, opts);
    }
    if (entity === 'channelRead' && !opts.system) {
      guardReadStateWrite(id, values, existing, opts);
    }

    if (!opts.system) guardReferences(entity, values, opts);

    const forced = created ? applyCreateDefaults(entity, id, values, opts) : {};
    applyInvariants(entity, id, values, existing, forced, opts);

    const seq = nextSeq();
    // The write's own workspace, unless something above decided otherwise: a
    // direct conversation has none, and its messages follow it.
    const workspaceId = 'workspace_id' in values ? (values.workspace_id as string | null) : opts.workspaceId;
    const row = created
      ? insertRow(table, { ...values, id, workspace_id: workspaceId, created_at: now, updated_at: now, seq, clocks: JSON.stringify(clocks) })
      : updateRow(table, id, { ...values, updated_at: now, seq, clocks: JSON.stringify(clocks) });

    afterWrite(entity, row, existing, values, opts);
    if (!opts.silent) publish({ workspaceId: opts.workspaceId, seq, origin: opts.origin, kind: entity });
    return { row, forced, created };
  });
}

/**
 * A row may only point at rows in its own workspace.
 *
 * This was not checked, and it was reachable: a page in workspace B could be
 * given `parent_id` of a page in workspace A. The page tree in A is filtered by
 * workspace and never showed it — but a *public share* of the A page renders
 * its children, and it rendered that one, on somebody else's link under
 * somebody else's name. Anyone with an account and a page id could publish
 * text on a stranger's share.
 *
 * So the check goes here rather than in the share renderer. The share was where
 * it became visible; the write is where it became wrong, and there is no reason
 * for a cross-workspace reference to exist at all.
 *
 * Written out, in the manner of `REFERENCES` in `trash.ts`: a column that names
 * a row somewhere else is a line here, and a new one is a line to add. The list
 * is deliberately only the columns a *client* may write — `created_by` and
 * friends are set by the server and never come off the wire.
 */
const SCOPED_REFERENCES: Record<string, string> = {
  parent_id: '',            // same table as the row being written
  project_id: 'projects',
  task_id: 'tasks',
  page_id: 'pages',
  comment_id: 'comments',
  cycle_id: 'cycles',
  module_id: 'modules',
  state_id: 'states',
  team_id: 'teams',
  view_id: 'views',
  field_id: 'custom_fields',
  template_id: 'templates',
  related_task_id: 'tasks',
  target_project_id: 'projects',
  trigger_state_id: 'states',
  default_state_id: 'states',
  default_view_id: 'views',
  automation_id: 'automations',
  share_id: 'shares',
};

function guardReferences(entity: EntityName, values: Record<string, unknown>, opts: WriteOpts): void {
  const def = entityDef(entity);
  if (!def) return;
  for (const [column, referenced] of Object.entries(SCOPED_REFERENCES)) {
    const value = values[column];
    if (value === undefined || value === null || value === '') continue;
    const table = referenced || def.table;
    const row = get<Row>(`SELECT workspace_id FROM ${table} WHERE id = ?`, String(value));
    // A row that is not there is somebody else's error to report — a dangling
    // reference is a 404 elsewhere, not a leak. Only a row that exists *and*
    // lives in another workspace is refused here.
    if (!row) continue;
    // `null` is a workspace of its own: a direct conversation belongs to none,
    // and nothing in a workspace may point into one.
    if (row.workspace_id !== opts.workspaceId) {
      throw badRequest(`${entity}.${column} refers to another workspace`);
    }
  }
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
  if (entity === 'webhook') {
    // Outgoing: what the receiver verifies the signature with. Incoming: the
    // unguessable part of the URL. Minted here either way, because a secret a
    // client chose is a secret somebody else can guess.
    setForced('secret', token());
    if (!values.created_by) setForced('created_by', opts.actorId);
    // An incoming hook has no URL to post to — it *is* one.
    if (!values.url) setForced('url', '');
  }
  if (entity === 'share') {
    // The token is the whole of the authorisation, so it is minted here from
    // the system's randomness — never taken from whoever asked for the link.
    setForced('token', shareToken());
    if (!values.created_by) setForced('created_by', opts.actorId);
  }
  if (entity === 'channel') {
    if (!values.created_by) setForced('created_by', opts.actorId);
    // Whoever opened it is in it. A private channel its own creator cannot see
    // is a row nobody will ever find again — but an import restoring an open
    // channel is not somebody opening one, so it is not put in the list.
    const members = parseIds(values.members);
    if (!opts.system && values.kind !== 'direct' && !members.includes(opts.actorId)) {
      members.push(opts.actorId);
      setForced('members', JSON.stringify(members));
    }
  }
  if (entity === 'message') {
    // Said by whoever is saying it. This is not a field a *client* gets to
    // choose: the whole of "who wrote this" is the session it arrived on. An
    // import is the exception, and only because it has already done the work
    // of deciding — it matches people by email and falls back to the importer
    // itself. Overriding it here would have thrown that away silently.
    if (!opts.system || !values.author_id) setForced('author_id', opts.actorId);
  }
  if (entity === 'channelRead') {
    setForced('user_id', opts.actorId);
    if (!values.notify) {
      // Being written to directly is the case where silence would be wrong.
      const kind = get<Row>(`SELECT kind FROM channels WHERE id = ?`, values.channel_id ?? '')?.kind;
      setForced('notify', kind === 'direct' ? 'all' : 'mentions');
    }
  }
  return forced;
}

/** Rules the server enforces regardless of what a client sent. */
function applyInvariants(entity: EntityName, id: string, values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>, opts: WriteOpts): void {

  /**
   * A sub-task cannot sit under itself, directly or at any remove.
   *
   * Nothing could build one until the parent became a field a person can set:
   * sub-tasks were only ever created *under* something. Now that it can be
   * chosen, `A → B → A` is two clicks away, and a tree that loops is not a tree
   * — the breadcrumb above the title walks it, and so does anything that ever
   * rolls a child up into its parent.
   *
   * Refused the way a project loop is: the old value comes back through
   * `forced` rather than thrown, because this write may be one row of a batch
   * from a device that has been away.
   */
  if (entity === 'task' && values.parent_id !== undefined && existing) {
    const wanted = values.parent_id as string | null;
    if (wanted === existing.id || wouldLoop('tasks', String(existing.id), wanted)) {
      values.parent_id = existing.parent_id ?? null;
      forced.parent_id = values.parent_id;
    }
  }

  /**
   * A task that changed projects, and everything on it that belonged to the old
   * one.
   *
   * The interface performs the move itself so the board reacts without a round
   * trip; this is the same rule applied where the interface is not the caller —
   * a `PATCH {project_id}` over REST, an MCP call, an import, an automation,
   * any of which would otherwise leave the row in a column its new board does
   * not have and wearing labels nothing can render.
   *
   * Each field is checked rather than overwritten, so a client that already did
   * the work is left alone and only what is actually wrong comes back `forced`.
   */
  if (entity === 'task' && existing && typeof values.project_id === 'string'
      && values.project_id !== existing.project_id) {
    const destination = values.project_id;
    const landing = relocate(
      {
        state_id: asId(existing.state_id),
        labels: parseIds(existing.labels),
        cycle_id: asId(existing.cycle_id),
        module_id: asId(existing.module_id),
      },
      vocabularyOf(String(existing.project_id)),
      vocabularyOf(destination),
    );
    const effective = (field: string): unknown => (values[field] !== undefined ? values[field] : existing[field]);
    const belongs = (table: 'states' | 'labels', value: unknown): boolean =>
      typeof value === 'string' && !!get<Row>(
        `SELECT 1 AS found FROM ${table} WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
        value, destination,
      );

    /**
     * The same question for a cycle or a module, which are not one project's.
     *
     * Both may cover several projects or all of them, so `project_id = ?` is
     * the wrong test: a shared fortnight has no owner at all, so a task moved
     * from Web to Mobile *inside that fortnight* failed the check and was
     * silently dropped out of it. Nobody would have attributed that to the
     * move. `coversProject` is the rule in TypeScript; this is it in SQL.
     */
    const covers = (table: 'cycles' | 'modules', value: unknown): boolean =>
      typeof value === 'string' && !!get<Row>(
        `SELECT 1 AS found FROM ${table}
          WHERE id = ? AND deleted_at IS NULL
            AND ((json_array_length(projects) = 0 AND (project_id IS NULL OR project_id = ?))
                 OR EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value = ?))`,
        value, destination, destination,
      );
    const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };

    if (!belongs('states', effective('state_id'))) settle('state_id', landing.state_id);
    if (parseIds(effective('labels')).some((label) => !belongs('labels', label))) {
      settle('labels', JSON.stringify(landing.labels));
    }
    // Cleared only when the destination really is outside them — a shared one
    // follows the task across, which is the whole point of it being shared.
    if (asId(effective('cycle_id')) && !covers('cycles', effective('cycle_id'))) settle('cycle_id', null);
    if (asId(effective('module_id')) && !covers('modules', effective('module_id'))) settle('module_id', null);
  }

  // A project cannot sit under itself, directly or at any remove. Two devices
  // can each make a legal move that is a loop together, so this is checked on
  // write rather than trusted to the interface.
  if (entity === 'project' && values.parent_id !== undefined && existing) {
    if (wouldLoop('projects', String(existing.id), values.parent_id as string | null)) {
      values.parent_id = existing.parent_id ?? null;
      forced.parent_id = values.parent_id;
    }
  }
  /**
   * A container holds projects, not tasks — so one with tasks in it cannot
   * become a container.
   *
   * Refused rather than obeyed, because the alternative is a screen with no
   * board on it and work behind it that nobody can reach. `forced` is how the
   * client is told: the value it sent comes back changed, and the interface
   * says why. Turning a container back into an ordinary project is always
   * allowed — there is nothing to hide.
   */
  if (entity === 'project' && Number(values.is_container ?? 0) === 1 && existing) {
    const open = get<Row>(
      `SELECT 1 AS found FROM tasks WHERE project_id = ? AND deleted_at IS NULL LIMIT 1`,
      existing.id,
    );
    if (open) {
      values.is_container = existing.is_container ?? 0;
      forced.is_container = values.is_container;
    }
  }
  /**
   * One key, one project.
   *
   * A key is the prefix of every identifier a project mints, so two projects
   * holding `WEB` make `WEB-42` name two tasks — and the client resolving a
   * pasted identifier takes whichever it finds first. It became reachable when
   * the settings screen learned to change a key that until then could only be
   * chosen once.
   *
   * Refused the way a container is: the old value comes back through `forced`
   * rather than thrown, because this write may be one row in a sync push from a
   * device that has been offline, and one bad key should not take the batch
   * down with it. The screen checks as you type and says which project has it,
   * so the bounce is the backstop rather than the explanation.
   *
   * Upper-cased on the way in whatever was typed: `web` and `WEB` are one
   * prefix, and storing both would be storing the collision.
   */
  if (entity === 'project' && typeof values.key === 'string') {
    const wanted = values.key.trim().toUpperCase();
    // `existing` on an update, the incoming row on a create — this runs on both.
    const workspace = (existing?.workspace_id ?? values.workspace_id) as string | undefined;
    const taken = wanted && workspace ? get<Row>(
      `SELECT name FROM projects
        WHERE workspace_id = ? AND id != ? AND deleted_at IS NULL AND UPPER(key) = ?`,
      workspace, id, wanted,
    ) : undefined;
    const settled = !wanted || taken ? (existing?.key as string | undefined) ?? values.key : wanted;
    if (settled !== values.key) {
      values.key = settled;
      forced.key = settled;
    }
  }
  if (entity === 'task') applyTaskInvariants(values, existing, forced);
  if (entity === 'page') applyPageInvariants(values, existing, forced);
  if (entity === 'channel') applyChannelInvariants(id, values, existing, forced);
  if (entity === 'message') applyMessageInvariants(values, existing, forced, opts);
  if (entity === 'message' || entity === 'channelRead') followChannelWorkspace(values, existing);
}

/**
 * A message belongs where its conversation belongs.
 *
 * Which for a direct conversation is nowhere: it has no workspace, so neither
 * do the things said in it. Without this the channel would sit outside every
 * workspace while its messages sat inside the sender's, and the other person —
 * who may not be in that workspace — would receive a conversation with nothing
 * in it. Not forced through `forced`, because the client never sent a value
 * here worth correcting out loud; it is bookkeeping, not a refused write.
 */
function followChannelWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const channelId = String(values.channel_id ?? existing?.channel_id ?? '');
  if (!channelId) return;
  const channel = get<Row>(`SELECT workspace_id FROM channels WHERE id = ?`, channelId);
  if (channel) values.workspace_id = channel.workspace_id ?? null;
}

/**
 * What a conversation is allowed to be.
 *
 * A direct channel is the pair it names and nothing else. Its id already
 * encodes its members — that is what makes two people opening one at the same
 * time converge — so the members are read back *from the id* rather than
 * trusted from the payload. A client that sent a different list was either
 * confused or trying something; either way the id wins, because the id is what
 * the other device will have derived too.
 */
function applyChannelInvariants(id: string, values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  const kind = String(values.kind ?? existing?.kind ?? 'channel');

  if (kind === 'direct') {
    const pair = directMembers(id);
    if (pair) {
      const members = JSON.stringify(pair);
      if (String(values.members ?? existing?.members ?? '') !== members) {
        values.members = members;
        forced.members = pair;
      }
    }
    // And it belongs to no workspace. Two people may have none in common, or
    // several; filing their conversation under one of them would mean it
    // vanished when either switched, and would make "can we talk at all" a
    // question about org charts. See `crossWorkspace` in the registry.
    if (values.workspace_id !== null) {
      values.workspace_id = null;
      forced.workspace_id = null;
    }
    // Always private, and never named: what to call it depends on who is
    // looking at it, so it has no name to store.
    if (Number(values.is_private ?? existing?.is_private ?? 0) !== 1) {
      values.is_private = 1;
      forced.is_private = 1;
    }
    return;
  }

  // A named channel keeps its name in the one shape that makes two of them
  // impossible to confuse.
  if (values.name !== undefined) {
    const tidy = normaliseChannelName(String(values.name ?? ''));
    if (tidy !== values.name) {
      values.name = tidy;
      forced.name = tidy;
    }
  }
  // An open channel has no member list; a private one that lost its last
  // member would be invisible to everybody including its author.
  if (values.is_private !== undefined && !Number(values.is_private)) {
    values.members = '[]';
    forced.members = [];
  }
}

/**
 * A message is written once and then it is somebody's words.
 *
 * The body may be edited by its author — that is what `edited_at` records, and
 * it is stamped here rather than trusted, because "edited" is a claim about
 * this server's clock. Everything else about a message is fixed: it cannot
 * change channel, it cannot change who said it, and it cannot change what it
 * answered — an edit rewrites the words, not the conversation around them.
 */
function applyMessageInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>, opts: WriteOpts): void {
  if (!existing) return;
  for (const fixed of ['channel_id', 'author_id', 'reply_to'] as const) {
    if (values[fixed] !== undefined && values[fixed] !== existing[fixed]) {
      values[fixed] = existing[fixed];
      forced[fixed] = existing[fixed];
    }
  }
  if (values.body !== undefined && String(values.body) !== String(existing.body ?? '')) {
    values.edited_at = Date.now();
    forced.edited_at = values.edited_at;
  }
  if (values.reactions !== undefined && !opts.system) {
    const settled = JSON.stringify(reconcileReactions(values.reactions, existing.reactions, opts.actorId));
    if (settled !== values.reactions) {
      values.reactions = settled;
      forced.reactions = JSON.parse(settled);
    }
  }
}

/**
 * A reaction is your own name in a list, and only yours is yours to move.
 *
 * The client sends the whole map because that is the field it holds, and a
 * field merges last-writer-wins — so two people reacting in the same moment
 * used to end with one of the two reactions, and an offline device could
 * arrive holding a map from before somebody else's. Worse, nothing stopped a
 * doctored map from removing everybody else's reactions, because "only the
 * reactions field changed" was the whole of the check.
 *
 * So the incoming map is not taken as the answer. It is read for one thing —
 * whether *this* person is on each emoji — and everybody else's entries are
 * carried across from the row as it stands. Concurrent reactions merge, and
 * the only reaction a write can move is the writer's own.
 */
function reconcileReactions(incoming: unknown, existing: unknown, actorId: string): Record<string, string[]> {
  const before = parseReactionMap(existing);
  const wanted = parseReactionMap(incoming);
  const merged: Record<string, string[]> = {};
  for (const emoji of new Set([...Object.keys(before), ...Object.keys(wanted)])) {
    const others = (before[emoji] ?? []).filter((userId) => userId !== actorId);
    const people = (wanted[emoji] ?? []).includes(actorId) ? [...others, actorId] : others;
    // An emoji nobody uses any more leaves rather than lingering as an empty
    // list, so the row does not fill up with invisible entries.
    if (people.length) merged[emoji] = people;
  }
  return merged;
}

function parseReactionMap(value: unknown): Record<string, string[]> {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [emoji, people] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(people)) out[emoji] = [...new Set(people.map(String))];
  }
  return out;
}

/**
 * Keep a page's text and its CRDT saying the same thing.
 *
 * Two directions, and which one applies is decided by what the writer sent:
 *
 * - A **`body`** means an editor that understands the CRDT. `content` is
 *   whatever the merged state reads as, and any `content` sent alongside is
 *   ignored — it was computed before the merge and is now out of date.
 * - A **`content`** on its own means somebody who does not: the API, MCP, an
 *   import, a rule. That is a replacement and it says so — the CRDT is rebuilt
 *   from the text, because a caller who sent a whole document meant the whole
 *   document, and quietly merging it into somebody's half-finished paragraph
 *   would be the surprising reading of it.
 */
function applyPageInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  if (values.body !== undefined && values.body !== null) {
    const text = crdt.textOf(safeCrdt(values.body));
    values.content = text;
    forced.content = text;
    return;
  }
  if (values.content !== undefined) {
    const state = crdt.fromText(String(values.content ?? ''), 'server');
    values.body = JSON.stringify(state);
    forced.body = state;
  } else if (existing && !existing.body && existing.content) {
    // A page written before any of this existed gets its CRDT the first time
    // anything else about it is touched, rather than on a migration that would
    // have to rewrite every row at once.
    values.body = JSON.stringify(crdt.fromText(String(existing.content), 'server'));
  }
}

const safeCrdt = (value: unknown): CrdtState | null => {
  if (typeof value !== 'string') return (value ?? null) as CrdtState | null;
  try { return JSON.parse(value) as CrdtState; } catch { return null; }
};

const ROLE_RANK: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

const isWorkspaceAdmin = (workspaceId: string, userId: string): boolean => !!get(
  `SELECT 1 FROM workspace_members
    WHERE workspace_id = ? AND user_id = ? AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
  workspaceId, userId,
);

/**
 * Who may change a conversation.
 *
 * The membership list is an ordinary synced field, which is what makes adding
 * somebody to a channel work offline — and would also make *adding yourself*
 * work, if this were not here. Only somebody already in a conversation may
 * change it. A private channel's id is a UUID nobody can guess, so this is the
 * second lock rather than the only one, but a membership list that anybody can
 * append their own name to is not a membership list.
 *
 * On creation there is only one rule: a direct conversation must be one the
 * person is actually in. Its id names its two members, so anything else is a
 * row about two other people.
 */
function guardChannelWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (!existing) {
    const pair = directMembers(id);
    if (String(values.kind ?? '') === 'direct' || pair) {
      if (!pair) throw badRequest('A direct conversation\'s id is dm.<a>.<b>');
      if (!pair.includes(opts.actorId)) throw forbidden('That conversation is between two other people');
    }
    return;
  }
  if (!canSeeChannel(opts.actorId, id)) throw forbidden('You are not in that conversation');

  // The membership list is the one field with its own rule, set per channel:
  // `members` lets anybody in it invite, `admins` narrows that to its creator
  // and the workspace's owners. Being in the channel is required either way —
  // `admins` widens who counts, it never lets an outsider manage a room.
  if (values.members !== undefined) {
    const before = parseIds(existing.members);
    const after = parseIds(values.members);
    // Leaving is always yours to do. Somebody who can only take their own name
    // off the list is not managing the room, and a room you cannot leave
    // without asking permission is not one anybody should be added to.
    const onlyLeaving = before.includes(opts.actorId)
      && !after.includes(opts.actorId)
      && before.every((id) => id === opts.actorId || after.includes(id))
      && after.every((id) => before.includes(id));

    if (!onlyLeaving && !canManageMembers(
      { ...existing, members: before } as never,
      opts.actorId,
      isWorkspaceAdmin(String(existing.workspace_id), opts.actorId),
    )) {
      throw forbidden('Only an admin of this conversation can change who is in it');
    }
    // The last person out cannot leave the room standing with nobody in it:
    // it would be invisible to everybody and impossible to reopen.
    if (Number(existing.is_private) && !after.length) {
      throw badRequest('A private conversation needs at least one person in it');
    }
  }
  // Who may invite is itself an admin decision, or the setting protects nothing.
  if (values.invite_policy !== undefined
    && existing.created_by !== opts.actorId
    && !isWorkspaceAdmin(String(existing.workspace_id), opts.actorId)) {
    throw forbidden('Only the person who opened this conversation, or an admin, can change that');
  }
}

/**
 * Whether this person may say this here.
 *
 * Two separate refusals, and they are separate on purpose. Writing into a
 * conversation somebody cannot see is the one that matters — the sync filter
 * would never have shown it to them, so a message arriving for it is either a
 * confused client or somebody trying it. Editing is narrower still: a message
 * is somebody's words, and the only person who may change them is the person
 * who said them.
 */
function guardMessageWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (existing) {
    if (!existing.author_id || existing.author_id === opts.actorId) return;
    // A reaction is the one thing you may do to somebody else's words, and it
    // is not a change to them: it is your own name in a list beside them. So
    // it is allowed, and only it — anything alongside it is an edit.
    const reactingOnly = Object.keys(values).every((field) => field === 'reactions');
    if (!reactingOnly) throw forbidden('Only the author can change a message');
    if (!canSeeChannel(opts.actorId, String(existing.channel_id))) {
      throw forbidden('You are not in that conversation');
    }
    return;
  }
  const channelId = String(values.channel_id ?? '');
  if (!canSeeChannel(opts.actorId, channelId)) {
    throw forbidden('You are not in that conversation');
  }
  const channel = get<Row>(`SELECT archived_at FROM channels WHERE id = ?`, channelId);
  if (channel?.archived_at) throw badRequest('That conversation is archived');
  // A reply answers something said in the same conversation. The client only
  // offers replies to what is on screen, so anything else arriving here is a
  // stale draft or somebody probing — and a quote resolved across rooms would
  // read words to people who may not see the room they were said in.
  if (values.reply_to != null) {
    const answered = get<Row>(`SELECT channel_id FROM messages WHERE id = ?`, String(values.reply_to));
    if (!answered || String(answered.channel_id) !== channelId) {
      throw badRequest('A reply must answer a message in the same conversation');
    }
  }
}

/**
 * A read marker belongs to exactly one person and says so in its id.
 *
 * The id is `<channel>::<user>` so two of somebody's devices marking the same
 * conversation read converge on one row instead of racing to make two. That
 * makes the id load-bearing, so it is checked rather than assumed: an id
 * naming somebody else is refused outright rather than quietly rewritten,
 * because rewriting it would leave the client believing something else.
 */
function guardReadStateWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  const separator = id.lastIndexOf('::');
  if (separator < 0) throw badRequest('A read marker id is <channel>::<user>');
  const channelId = id.slice(0, separator);
  const userId = id.slice(separator + 2);
  if (userId !== opts.actorId) throw forbidden('That read marker is somebody else\'s');
  if (!existing && !canSeeChannel(opts.actorId, channelId)) {
    throw forbidden('You are not in that conversation');
  }
  values.channel_id = channelId;
}

/**
 * Who may move a task into a column.
 *
 * A state can name the workspace roles allowed to receive work — "only a lead
 * marks something done". Empty means anybody who can write, which is every
 * column until somebody says otherwise. Checked here rather than in the
 * interface, because the interface is not the only way in: REST, MCP and a
 * phone that was offline all come through this function.
 *
 * Rules never apply to the server's own writes: an automation, an import or a
 * recurrence rolling a task forward is not a person moving a card.
 */
function guardTransition(stateId: string, opts: WriteOpts): void {
  const state = get<Row>(`SELECT name, allowed_roles FROM states WHERE id = ?`, stateId);
  if (!state) return;
  let allowed: string[] = [];
  try {
    const parsed = JSON.parse(String(state.allowed_roles ?? '[]'));
    if (Array.isArray(parsed)) allowed = parsed.map(String);
  } catch { /* a column with an unreadable rule is a column with no rule */ }
  if (!allowed.length) return;

  const role = get<Row>(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    opts.workspaceId, opts.actorId,
  )?.role as string | undefined;
  // A role that outranks every role named is allowed: naming "member" and
  // meaning "and not an owner" is not what anybody writes down.
  const bar = Math.min(...allowed.map((name) => ROLE_RANK[name] ?? 99));
  if (role && (allowed.includes(role) || (ROLE_RANK[role] ?? -1) >= bar)) return;

  throw forbidden(`Only ${allowed.join(' or ')} may move work into “${state.name}”`);
}

/**
 * Whether making `parentId` the parent of `id` closes a circle.
 *
 * The same walk for a project tree and a task tree — two tables, one rule. Both
 * are written by devices that may be offline, so two moves that are each legal
 * can be a loop together, and only the side that sees both can say so.
 */
function wouldLoop(table: 'projects' | 'tasks', id: string, parentId: string | null): boolean {
  let cursor = parentId;
  for (let hops = 0; cursor && hops < 50; hops++) {
    if (cursor === id) return true;
    cursor = get<Row>(`SELECT parent_id FROM ${table} WHERE id = ?`, cursor)?.parent_id ?? null;
  }
  // A chain longer than fifty is a loop somebody already made; refuse to add to it.
  return !!cursor;
}

function applyTaskInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
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

const asId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * What a project offers, read out of SQLite.
 *
 * The mirror image of the interface's own reader — the rule that consumes this
 * is one shared function, so the two cannot drift apart about what "the same
 * column in another project" means.
 */
function vocabularyOf(projectId: string): ProjectVocabulary {
  return {
    states: all<Row>(
      `SELECT id, group_key, sort_order FROM states WHERE project_id = ? AND deleted_at IS NULL`, projectId,
    ).map((row) => ({ id: String(row.id), group_key: row.group_key as never, sort_order: String(row.sort_order ?? '') })),
    labels: all<Row>(
      `SELECT id, name FROM labels WHERE project_id = ? AND deleted_at IS NULL`, projectId,
    ).map((row) => ({ id: String(row.id), name: String(row.name ?? '') })),
    defaultStateId: asId(get<Row>(`SELECT default_state_id FROM projects WHERE id = ?`, projectId)?.default_state_id),
  };
}

/* -------------------------------------------------------------- side effects */

function afterWrite(entity: EntityName, row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  indexForSearch(entity, row);
  if (entity === 'page' && before && changed.content !== undefined) snapshotPage(before, opts.actorId);
  if (entity === 'field' && row.deleted_at && !before?.deleted_at) tombstoneValuesOf(row, opts);
  if (entity === 'task' && (changed.start_date !== undefined || changed.due_date !== undefined)) {
    cascadeSchedule(row, opts);
  }
  // A new `blocks` link, or a wait somebody put on one, is a change to the
  // plan as much as a date is — and the blocker is where the cascade starts.
  if (entity === 'relation' && row.kind === 'blocks' && !row.deleted_at
    && (changed.lag !== undefined || changed.related_task_id !== undefined || changed.kind !== undefined)) {
    const blocker = get<Row>(`SELECT id, project_id FROM tasks WHERE id = ?`, row.task_id);
    if (blocker) cascadeSchedule(blocker, opts);
  }
  // Opening a direct conversation with somebody outside your workspaces makes
  // the two of you visible to each other for the first time. Being allowed to
  // see a row is not the same as receiving it — see `resendUser` — so both
  // names are sent again, or the conversation arrives titled with a raw id.
  if (entity === 'channel' && !before && row.kind === 'direct') {
    for (const userId of parseIds(row.members)) resendUser(userId);
  }
  if (opts.system) return;
  recordActivity(entity, row, before, changed, opts);
  /*
   * The two effects that leave the process — notifications reach phones and
   * webhooks reach other people's servers — honour the deferral window below.
   * Everything above them is a database write, which a rollback takes back;
   * these two cannot be taken back, so inside a wrapped transaction they wait
   * for the commit. `runAutomations` stays inline on purpose: what it *writes*
   * must land inside the transaction, and what those writes notify comes back
   * through here and queues itself.
   */
  const external = (): void => {
    notify(entity, row, before, changed, opts);
    fireWebhooks(entity, row, before, changed, opts);
  };
  if (pendingEffects) {
    pendingEffects.push(external);
    runAutomations(entity, row, before, changed, opts);
  } else {
    notify(entity, row, before, changed, opts);
    runAutomations(entity, row, before, changed, opts);
    fireWebhooks(entity, row, before, changed, opts);
  }
}

/* ------------------------------------------------------- deferred effects */

let pendingEffects: (() => void)[] | null = null;

/**
 * Hold the irreversible side effects of every write inside `fn` until it
 * returns, then release them; a throw discards them along with the writes.
 *
 * This exists for `create_tasks_batch`, whose promise is "every task or none".
 * The database half of that promise was a transaction; the other half was not:
 * `afterWrite` fired webhooks and push notifications inline, so a batch of
 * twenty that failed on the twentieth had already told Slack about nineteen
 * tasks that, after the rollback, never existed — and the retry the
 * transaction makes safe told it about them all again.
 *
 * The queue is released *after* `fn` returns — after the transaction inside it
 * has committed — so a webhook can never describe an uncommitted row. Nested
 * windows join the outer one, exactly as nested `tx` calls do.
 */
export function withEffectsHeld<T>(fn: () => T): T {
  if (pendingEffects) return fn();
  const queue: (() => void)[] = [];
  pendingEffects = queue;
  let out: T;
  try {
    out = fn();
  } finally {
    // Cleared either way; on a throw the queue is simply never released.
    pendingEffects = null;
  }
  for (const effect of queue) effect();
  return out;
}

/**
 * Move a date, and everything waiting on it moves too.
 *
 * The interface already does this — it writes each shifted task itself, so the
 * Gantt works offline. This is the same rule applied where the interface is not
 * the caller: a date set over REST, over MCP, by an import or by an automation
 * used to leave every dependent task sitting behind its blocker, which made the
 * promise a Gantt chart is only true when it was a Gantt chart doing the
 * moving.
 *
 * The rule and the arithmetic are `@kolibri/shared`'s, so there is exactly one
 * of each. What is here is reading the rows and writing the answers back.
 */
/**
 * Combine two states of a merged field.
 *
 * Stored as text because that is what the column holds, and parsed on the way
 * in and out rather than kept as an object: this runs once per page save, not
 * once per keystroke, and a column that is sometimes a string and sometimes an
 * object is a bug waiting for a Tuesday.
 */
function mergeCrdt(stored: unknown, incoming: unknown): string | null {
  const parse = (value: unknown): CrdtState | null => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as CrdtState; } catch { return null; }
    }
    return value as CrdtState;
  };
  const next = parse(incoming);
  const before = parse(stored);
  if (!next) return before ? JSON.stringify(before) : null;
  return JSON.stringify(crdt.merge(before, next));
}

let cascading = false;

function cascadeSchedule(row: Row, opts: WriteOpts): void {
  // A cascade writes tasks, which would cascade again. One level is all that is
  // wanted: `reschedule` already walks the whole chain in one pass.
  if (cascading) return;

  const projectId = String(row.project_id ?? '');
  if (!projectId) return;

  const links = all<Row>(
    `SELECT r.task_id, r.related_task_id, r.lag FROM task_relations r
      JOIN tasks t ON t.id = r.task_id
     WHERE r.kind = 'blocks' AND r.deleted_at IS NULL AND t.workspace_id = ?`,
    opts.workspaceId,
  );
  if (!links.length) return;

  // Only the tasks the graph actually mentions, plus the one that moved. A
  // workspace's whole dated backlog would be read on every date anybody types.
  const involved = new Set<string>([String(row.id)]);
  for (const link of links) {
    involved.add(String(link.task_id));
    involved.add(String(link.related_task_id));
  }
  const ids = [...involved];
  const tasks = all<Row>(
    `SELECT id, project_id, start_date, due_date FROM tasks
      WHERE id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL AND archived = 0
        AND (start_date IS NOT NULL OR due_date IS NOT NULL)`,
    ...ids,
  );
  const projectOf = new Map(tasks.map((task) => [String(task.id), String(task.project_id ?? '')]));
  const calendars = new Map<string, number[] | null>();
  const workingDays = (taskId: string): number[] | null => {
    const project = projectOf.get(taskId) ?? '';
    if (!calendars.has(project)) {
      const raw = get<Row>(`SELECT working_days FROM projects WHERE id = ?`, project)?.working_days;
      let days: number[] | null = null;
      try {
        const parsed = JSON.parse(String(raw ?? 'null'));
        if (Array.isArray(parsed)) days = parsed.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      } catch { /* a project with an unreadable calendar works every day */ }
      calendars.set(project, days);
    }
    return calendars.get(project) ?? null;
  };

  const moves = reschedule(
    [String(row.id)],
    tasks.map((task) => ({
      id: String(task.id),
      start_date: (task.start_date as string) ?? null,
      due_date: (task.due_date as string) ?? null,
    })),
    links.map((link) => ({
      from: String(link.task_id),
      to: String(link.related_task_id),
      lag: Number(link.lag ?? 0),
    })),
    { workingDays },
  );
  if (!moves.length) return;

  cascading = true;
  try {
    for (const move of moves) {
      // `system`, because the schedule moving a task is not a person editing
      // it: it earns no activity entry, no notification and no rule of its own.
      writeEntity('task', move.id, { start_date: move.start_date, due_date: move.due_date }, {
        ...opts, op: 'upsert', system: true, silent: true,
      });
    }
  } finally {
    cascading = false;
  }
}

/**
 * A field that is gone takes its answers with it.
 *
 * Tombstones rather than a `DELETE`, because every other device has those rows
 * too and only a tombstone tells them. Written through the same path, so they
 * get a sequence number and reach the clients on the next pull.
 */
function tombstoneValuesOf(field: Row, opts: WriteOpts): void {
  const values = all<Row>(`SELECT id FROM field_values WHERE field_id = ? AND deleted_at IS NULL`, field.id);
  for (const value of values) {
    writeEntity('fieldValue', String(value.id), {}, { ...opts, op: 'delete', system: true, silent: true });
  }
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

export const SEARCHABLE: Partial<Record<EntityName, (row: Row) => { title: string; body: string }>> = {
  task: (row) => ({ title: `${row.identifier ?? ''} ${row.title ?? ''}`.trim(), body: row.description ?? '' }),
  page: (row) => ({ title: row.title ?? '', body: row.content ?? '' }),
  project: (row) => ({ title: `${row.key ?? ''} ${row.name ?? ''}`.trim(), body: row.description ?? '' }),
  comment: (row) => ({ title: '', body: row.body ?? '' }),
  cycle: (row) => ({ title: row.name ?? '', body: row.description ?? '' }),
  module: (row) => ({ title: row.name ?? '', body: row.description ?? '' }),
  // Indexed, but not findable by everybody — the index has no idea who may read
  // a conversation, so `searchWorkspace` checks each message hit against its
  // channel before returning it. See `search.ts`.
  message: (row) => ({ title: '', body: row.body ?? '' }),
};

export function indexForSearch(entity: EntityName, row: Row): void {
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
  const targets = new Map<string, { kind: string; title: (t: Translator) => string; body: string | null; channelId?: string }>();

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

  // Somebody watching a page hears about a change to its body. Not about every
  // field: renaming a page or moving it between projects is bookkeeping, and a
  // notification for it teaches people to ignore the bell.
  if (entity === 'page' && before && changed.content !== undefined && String(before.content ?? '') !== String(row.content ?? '')) {
    for (const userId of parseIds(row.watchers)) {
      if (!userId || userId === opts.actorId) continue;
      if (targets.has(userId)) continue; // a mention in the same edit is the stronger signal
      targets.set(userId, {
        kind: 'page_changed',
        title: (t) => t('notify.pageChanged', { title: row.title }),
        body: null,
      });
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
      for (const userId of new Set([page.created_by, ...talkers, ...parseIds(page.watchers)])) {
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

  // A message. The default is deliberately not "tell everyone about every
  // line": a channel that pings its whole membership on every message is a
  // channel people mute, and a muted channel tells nobody anything. So a
  // channel notifies whoever was *named*, plus whoever asked for all of it;
  // a direct message notifies the other person, because being written to
  // directly is exactly the case where silence would be wrong.
  if (entity === 'message' && !before && !row.deleted_at) {
    const channel = get<Row>(`SELECT * FROM channels WHERE id = ?`, row.channel_id);
    if (channel && !channel.deleted_at) {
      const direct = String(channel.kind) === 'direct';
      const named = new Set(findMentions(opts.workspaceId, String(row.body ?? '')));
      const audience = direct
        ? parseIds(channel.members)
        : [...new Set([...named, ...subscribersOf(String(channel.id))])];

      for (const userId of audience) {
        if (!userId || userId === opts.actorId) continue;
        if (notifyLevel(String(channel.id), userId, direct) === 'none') continue;
        if (!direct && !named.has(userId) && notifyLevel(String(channel.id), userId, direct) !== 'all') continue;
        targets.set(userId, {
          kind: 'message',
          title: (t) => (direct
            ? t('notify.directMessage', { name: displayName(opts.actorId) })
            : t('notify.message', { name: displayName(opts.actorId), channel: `#${channel.name}` })),
          // Through `excerpt` rather than sliced raw: a push notification
          // renders no markdown, and a phone buzzing with `**` and `](` reads
          // as a bug in exactly the moment the message was urgent enough to
          // buzz for.
          body: excerpt(String(row.body ?? ''), 280),
          // Without this the notification says something happened and then has
          // nowhere to take you, which is worse than not sending it.
          channelId: String(channel.id),
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
    createNotification({
      // A notification about a direct message has to reach somebody who may
      // not be in this workspace, so it belongs outside one exactly as the
      // conversation does. Everything else belongs where it happened.
      // `??` would be wrong here: null is the *answer* for a direct message,
      // not a missing value, and coalescing it would file the notification in
      // the sender's workspace where the other person cannot reach it.
      workspaceId: (row.workspace_id === undefined ? opts.workspaceId : row.workspace_id) as string | null,
      userId,
      kind: payload.kind,
      title: payload.title(translatorFor(userId)),
      body: payload.body,
      taskId: entity === 'task' ? row.id : row.task_id ?? null,
      pageId: entity === 'page' ? row.id : row.page_id ?? null,
      channelId: payload.channelId ?? null,
      actorId: opts.actorId,
    });
  }
}

/** People who asked to hear about everything in this channel. */
const subscribersOf = (channelId: string): string[] =>
  all<Row>(
    `SELECT user_id FROM channel_reads WHERE channel_id = ? AND notify = 'all' AND deleted_at IS NULL`,
    channelId,
  ).map((row) => String(row.user_id));

/**
 * What one person wants from one conversation.
 *
 * No row means they have never opened it, which is not the same as having
 * opted out — so the answer is the default for that kind rather than silence.
 */
function notifyLevel(channelId: string, userId: string, direct: boolean): string {
  const row = get<Row>(
    `SELECT notify FROM channel_reads WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL`,
    channelId, userId,
  );
  return String(row?.notify ?? (direct ? 'all' : 'mentions'));
}

const displayName = (userId: string | undefined): string =>
  String(get<Row>(`SELECT name FROM users WHERE id = ?`, userId ?? '')?.name ?? 'Somebody');

/** What a comment is about — a task or a page — for a notification title. */
function commentContext(row: Row): Row | undefined {
  if (row.task_id) return get<Row>(`SELECT identifier, title FROM tasks WHERE id = ?`, row.task_id);
  if (row.page_id) return get<Row>(`SELECT title FROM pages WHERE id = ?`, row.page_id);
  return undefined;
}

/**
 * Tell anybody who asked that something happened.
 *
 * After the write, never before: a slow receiver must not slow down the person
 * who pressed the button, and a webhook that can fail a write is a webhook that
 * takes the app down when somebody else's endpoint dies.
 */
function fireWebhooks(
  entity: EntityName,
  row: Row,
  before: Row | undefined,
  changed: Record<string, unknown>,
  opts: WriteOpts,
): void {
  if (opts.op === 'delete' || row.deleted_at) return;
  const workspaceId = String(row.workspace_id ?? opts.workspaceId);

  if (entity === 'task') {
    const state = row.state_id ? get<Row>(`SELECT group_key FROM states WHERE id = ?`, row.state_id) : undefined;
    const finished = state?.group_key === 'completed';
    const wasFinished = before?.state_id
      ? get<Row>(`SELECT group_key FROM states WHERE id = ?`, before.state_id)?.group_key === 'completed'
      : false;
    const payload = {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      project_id: row.project_id,
      state: state?.group_key ?? null,
      priority: row.priority,
      url: env.publicUrl ? `${env.publicUrl}/t/${row.id}` : null,
      actor_id: opts.actorId,
    };
    if (!before) dispatch(workspaceId, 'task.created', payload);
    else if (finished && !wasFinished) dispatch(workspaceId, 'task.completed', payload);
    else dispatch(workspaceId, 'task.updated', payload);
    return;
  }

  if (entity === 'comment' && !before) {
    dispatch(workspaceId, 'comment.created', {
      id: row.id, task_id: row.task_id, page_id: row.page_id, author_id: row.author_id,
      body: String(row.body ?? '').slice(0, 500), project_id: null, actor_id: opts.actorId,
    });
    return;
  }

  if (entity === 'page' && before && changed.content !== undefined) {
    dispatch(workspaceId, 'page.updated', {
      id: row.id, title: row.title, project_id: row.project_id, actor_id: opts.actorId,
    });
  }
}

/**
 * Resolve `@handles` in a body to workspace members. People type what they see:
 * a first name, a display name without spaces, or an email address — so all
 * three are accepted, and unknown handles are simply left alone.
 */
/**
 * Who this text names, among the people of this workspace.
 *
 * The reading of a handle lives in `@kolibri/shared` because the screen asks
 * the same question — a channel set to "only when I am named" has to know
 * whether a message names you before it counts towards a badge — and a rule
 * written twice is a rule that drifts. This half is the part only the server
 * can do: which people there are.
 */
export function findMentions(workspaceId: string, text: string): string[] {
  if (!String(text ?? '').includes('@')) return [];
  const members = all<Row>(
    `SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
    workspaceId,
  );
  return mentionsIn(
    members.map((member) => ({ id: String(member.id), name: member.name as string, email: member.email as string })),
    text,
  );
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

/**
 * Whether somebody may read a conversation — and therefore write into it.
 *
 * The same rule the sync filter applies, in the one place a write path can ask
 * it. They are written twice on purpose: the filter has to be SQL so a pull
 * stays one query, and a guard has to be a function so it can refuse. They are
 * tested against each other rather than trusted to stay in step.
 */
/**
 * Send somebody's `user` row out again, unchanged.
 *
 * Being *allowed* to see a row is not the same as receiving it. A delta pull
 * carries rows whose `seq` is past the device's cursor, so an account that
 * existed before it became visible has a sequence everybody already walked past
 * while the row was still hidden from them — and it arrives as an id with no
 * name behind it. Restamping the sequence is the whole fix: nothing about the
 * person changed, only who may now see them.
 *
 * Two things widen that: joining a workspace, and opening a direct conversation
 * with somebody from outside it. Both call this.
 */
export function resendUser(userId: string): void {
  run(`UPDATE users SET seq = ? WHERE id = ?`, nextSeq(), userId);
}

export function canSeeChannel(userId: string, channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  const channel = get<Row>(`SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, channelId);
  if (!channel) return false;
  // Leaving the workspace does not take your name out of the channels you were
  // in — the member list is a synced field, not a foreign key. Every caller
  // today also checks workspace membership, so this is the second lock rather
  // than the only one; it is here so that the *next* caller cannot forget.
  //
  // A direct conversation has no workspace to be a member of. Its lock is its
  // id: the members are read back out of it on every write, so "is this person
  // in it" is a question the id itself answers and cannot be talked out of.
  if (channel.workspace_id) {
    const stillHere = get(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
      channel.workspace_id, userId,
    );
    if (!stillHere) return false;
  }
  if (!canSeeProject(userId, channel.project_id)) return false;
  if (!Number(channel.is_private)) return true;
  return parseIds(channel.members).includes(userId);
}

/**
 * Whether this person may see this project.
 *
 * **"Public" means everyone in the project's own workspace.** The screen that
 * sets it says so — *Everyone in the workspace* — and it has never meant
 * everyone with an account on the instance. This used to return `true` for a
 * public project without asking whose workspace it was in, which is only ever
 * safe because most callers had already scoped the query by workspace before
 * asking. Most is not all: an MCP lookup by raw id had not, and a stranger
 * holding a task's uuid could read, change and delete it.
 *
 * So membership is checked here, at the one place every caller goes through,
 * rather than trusted to hold at twenty of them. A project id is a claim about
 * a row anywhere in the database; this is the function that turns it into a
 * question about the person asking.
 */
export function canSeeProject(userId: string, projectId: string | null | undefined): boolean {
  if (!projectId) return true;
  const project = get<Row>(`SELECT workspace_id, visibility FROM projects WHERE id = ?`, projectId);
  if (!project) return false;
  const member = get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    project.workspace_id, userId,
  );
  if (!member) return false;
  if (project.visibility === 'public') return true;
  return !!get(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL`, projectId, userId);
}

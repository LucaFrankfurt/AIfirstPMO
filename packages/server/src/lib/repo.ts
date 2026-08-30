import {
  ENTITIES,
  crdt,
  entityDef,
  excerpt,
  findMentions as mentionsIn,
  hlcGreater,
  type CrdtState,
  type EntityName,
} from '@kolibri/shared';
import { all, get, nextSeq, run, tx, type Row } from '../db/index.ts';
import { badRequest, notFound } from './http.ts';
import { shareToken, token, uid } from './ids.ts';
import { publish } from './bus.ts';
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

    if (!opts.system) {
      for (const rule of rulesFor(entity)) rule.guards?.(entity, id, values, existing, opts);
      guardReferences(entity, values, opts);
    }

    const forced = created ? applyCreateDefaults(entity, id, values, opts) : {};
    // What the server enforces regardless of what a client sent. It used to be
    // a 194-line switch here; the rules belong to the modules that own the
    // entities now, and this is the whole of what is left of the dispatch.
    for (const rule of rulesFor(entity)) rule.invariants?.(entity, id, values, existing, forced, opts);

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
  budget_id: 'budgets',
  line_id: 'budget_lines',
  vendor_id: 'vendors',
  component_id: 'components',
  kpi_id: 'kpis',
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

export const safeJson = (raw: string): Record<string, string> => {
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


  // Time is logged by whoever is logging it. Filing it under somebody else is
  // a timesheet-approval feature, not a field a client gets to set casually.
  // A measurement with no date is a measurement of nothing. Today rather than a
  // refusal, for the same reason the rest of these are corrections: this
  // arrives in sync batches from devices that have been away.
  // A rate with no start applies from today rather than from the beginning of
  // time: backdating one restates every report that has ever been run, so it is
  // something somebody types on purpose.
  // Who filed the invoice. Never the client's to claim: "somebody recorded
  // this" is the one line of an audit trail this table has.
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
  for (const rule of rulesFor(entity)) rule.defaults?.(entity, id, values, opts, setForced);
  return forced;
}














/**
 * Whether making `parentId` the parent of `id` closes a circle.
 *
 * The same walk for a project tree and a task tree — two tables, one rule. Both
 * are written by devices that may be offline, so two moves that are each legal
 * can be a loop together, and only the side that sees both can say so.
 */
export function wouldLoop(table: 'projects' | 'tasks' | 'components', id: string, parentId: string | null): boolean {
  let cursor = parentId;
  for (let hops = 0; cursor && hops < 50; hops++) {
    if (cursor === id) return true;
    cursor = get<Row>(`SELECT parent_id FROM ${table} WHERE id = ?`, cursor)?.parent_id ?? null;
  }
  // A chain longer than fifty is a loop somebody already made; refuse to add to it.
  return !!cursor;
}




/* -------------------------------------------------------------- side effects */

function afterWrite(entity: EntityName, row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  indexForSearch(entity, row);
  // A budget takes its lines with it; a line leaves its invoices behind. See
  // both functions for why the two cascades go opposite ways.
  // Nothing in the register cascades a *deletion*, and that is the point: a
  // vendor going out of the list does not switch off the servers, and deleting
  // a machine's row does not delete the instances on it. What it does is
  // detach, so no row is left pointing at something that is not there.
  // A KPI takes its readings and targets with it: unlike an invoice, a
  // measurement of a metric nobody keeps is not independent evidence of
  // anything — it is a number with no unit, no direction and no owner.
  // A milestone that is gone leaves the promises made against it standing.
  for (const rule of rulesFor(entity)) rule.effects?.(entity, row, before, changed, opts);
  if (opts.system) return;
  recordActivity(entity, row, before, changed, opts);
  /*
   * The two effects that leave the process — notifications reach phones and
   * webhooks reach other people's servers — honour the deferral window below.
   * Everything above them is a database write, which a rollback takes back;
   * these two cannot be taken back, so inside a wrapped transaction they wait
   * for the commit. The listeners stay inline on purpose — the rules engine is
   * one, and what it *writes* must land inside the transaction, while what
   * those writes notify comes back through here and queues itself. See
   * `onWrite` below for why this is a list of functions rather than the bus.
   */
  const external = (): void => {
    notify(entity, row, before, changed, opts);
    fireWebhooks(entity, row, before, changed, opts);
  };
  const heard = (): void => {
    for (const listener of listeners) listener(entity, row, before, changed, opts);
  };
  if (pendingEffects) {
    pendingEffects.push(external);
    heard();
  } else {
    notify(entity, row, before, changed, opts);
    heard();
    fireWebhooks(entity, row, before, changed, opts);
  }
}

/* ------------------------------------------------------------ entity rules */

/**
 * What a module knows about the rows it owns, offered to the write path.
 *
 * `writeEntity` has always had three moments where a domain gets a say: filling
 * in what a create left out, correcting what arrived, and reacting once the row
 * is written. All three used to be a chain of `if (entity === ...)` inside this
 * file, which is how a 2 370-line write path ends up holding the budget rules,
 * the KPI cascades and the landscape detachments — none of which the write path
 * has any business knowing about.
 *
 * A rule names the entities it speaks for and fills in whichever of the three
 * moments it cares about. Registration happens in `lib/wiring.ts`, beside the
 * write listeners, and the shape is deliberately the same idea one floor down:
 * synchronous, in order, inside the transaction.
 *
 * **Why appending is not a reordering.** One write is one entity, so two rules
 * for different entities never both run and their relative order cannot matter.
 * What has to be preserved is the order *within* an entity, and that is the
 * order they are registered in — which is the order they were branches in.
 */
export interface EntityRule {
  /** Which entities this rule speaks for. A rule may listen to another module's. */
  entities: readonly EntityName[];
  /** Fill in what a create left out. Only called on create. */
  defaults?(
    entity: EntityName, id: string, values: Record<string, unknown>, opts: WriteOpts,
    setForced: (field: string, value: unknown) => void,
  ): void;
  /**
   * Correct what arrived, in place. Anything put in `forced` is sent back so
   * the client learns what was changed rather than silently disagreeing.
   */
  invariants?(
    entity: EntityName, id: string, values: Record<string, unknown>,
    existing: Row | undefined, forced: Record<string, unknown>, opts: WriteOpts,
  ): void;
  /**
   * A refusal. Throws, and nothing is written.
   *
   * Only asked of a write that came from outside — the write path skips this
   * for `opts.system`, exactly as it did when these were four `if` branches,
   * because an import, a restore or a transfer is the server moving its own
   * rows and has already decided. The skip lives here rather than in each rule
   * on purpose: a permission check a module has to remember to gate is a
   * permission check that will be forgotten.
   */
  guards?(
    entity: EntityName, id: string, values: Record<string, unknown>,
    existing: Row | undefined, opts: WriteOpts,
  ): void;
  /** What else has to change now this row has. Inside the same transaction. */
  effects?(
    entity: EntityName, row: Row, before: Row | undefined,
    changed: Record<string, unknown>, opts: WriteOpts,
  ): void;
}

const entityRules: EntityRule[] = [];

/** Register a rule. Registering the same one twice is a no-op, as with `onWrite`. */
export function onEntity(rule: EntityRule): void {
  if (!entityRules.includes(rule)) entityRules.push(rule);
}

const rulesFor = (entity: EntityName): EntityRule[] =>
  entityRules.filter((rule) => rule.entities.includes(entity));

/* --------------------------------------------------------- write listeners */

/**
 * Something that wants to know a row changed, and may write in response.
 *
 * The arguments are `afterWrite`'s own, and they are handed over unchanged: the
 * entity, the row as it now stands, what it was, which fields moved, and who
 * moved them.
 */
export type WriteListener = (
  entity: EntityName,
  row: Row,
  before: Row | undefined,
  changed: Record<string, unknown>,
  opts: WriteOpts,
) => void;

const listeners: WriteListener[] = [];

/**
 * Ask to hear about every write, from inside the transaction that made it.
 *
 * This exists so the write path does not have to know what a rule engine is.
 * It used to `import { runAutomations }` directly, and `automation.ts` imports
 * `writeEntity` right back — three files that could all reach each other, so
 * none of them could be read, tested or replaced alone.
 *
 * What it is emphatically **not** is a message bus. `lib/bus.ts` is next door
 * and would have been the obvious thing to reach for, and it is the wrong
 * answer: publishing there would make the call asynchronous, and a rule's
 * writes have to land inside the transaction that triggered them or
 * `create_tasks_batch`'s "every task or none" stops holding for exactly the
 * rows a rule generated. So this is an ordinary array of functions, called in
 * order, synchronously, where `runAutomations` used to be. Only the direction
 * of the import changed.
 *
 * Registering twice is a no-op, because more than one entry point wires this
 * up and a test may import them both.
 */
export function onWrite(listener: WriteListener): void {
  if (!listeners.includes(listener)) listeners.push(listener);
}

/** For a test that needs the write path with nothing hanging off it. */
export function clearWriteListeners(): void {
  listeners.length = 0;
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
  /*
   * A budget, on the same terms as a message and for the same reason.
   *
   * The index carries one `project_id`, and a budget covering three projects
   * carries none — so the index's own filter would read that as "belongs to no
   * project", which it treats as visible to the whole workspace. That is right
   * for a workspace-wide budget and wrong for one scoped to two private
   * projects, and the two are indistinguishable by the time a row reaches the
   * index. `searchWorkspace` asks `canSeeBudget` about each hit instead.
   */
  budget: (row) => ({ title: row.name ?? '', body: row.description ?? '' }),
};

/**
 * Put a row into the full-text index, or take it out. Answers whether it is in.
 *
 * Archived rows are out, and that is a correction rather than a preference.
 * Every list in the interface hides what is archived, including the local
 * instant search — so a query answered from the client omitted an archived page
 * and the same query answered by this index returned it. Which half you got
 * depended on how fast the server was, and the archive view is where those
 * pages are meant to be found now.
 *
 * The row stays in its table either way. Unarchiving writes it, `afterWrite`
 * calls this again, and it comes straight back.
 */
export function indexForSearch(entity: EntityName, row: Row): boolean {
  const project = SEARCHABLE[entity];
  if (!project) return false;
  run(`DELETE FROM search_index WHERE kind = ? AND ref_id = ?`, entity, row.id);
  if (row.deleted_at || row.archived) return false;
  const { title, body } = project(row);
  run(
    `INSERT INTO search_index (kind, ref_id, workspace_id, project_id, title, body) VALUES (?, ?, ?, ?, ?, ?)`,
    entity, row.id, row.workspace_id, row.project_id ?? null, title, stripMarkdown(body).slice(0, 20_000),
  );
  return true;
}

const stripMarkdown = (text: string): string =>
  String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ');

/**
 * The fields whose change is worth a line in the activity trail.
 *
 * `access`, `project_id` and `is_template` were added when pages got a history
 * screen. A page's text is deliberately *not* here and never will be: every
 * body edit already writes a `page_versions` row, which carries the text itself
 * and can be compared and restored — an "updated content" line beside it would
 * be the same event said twice, worse.
 */
const TRACKED_FIELDS = new Set([
  'title', 'state_id', 'priority', 'assignees', 'due_date', 'cycle_id', 'module_id', 'estimate',
  'parent_id', 'archived', 'labels', 'access', 'project_id', 'is_template',
]);

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
  const workspaceId = String(row.workspace_id ?? opts.workspaceId);

  // Said before the early return that keeps every other event about rows which
  // still exist. A deletion is the one thing a receiver cannot find out later:
  // what it would go back and read is a tombstone.
  if (opts.op === 'delete' || row.deleted_at) {
    if (entity === 'task' && !before?.deleted_at) {
      dispatch(workspaceId, 'task.deleted', {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        project_id: row.project_id,
        ...who(opts),
      });
    }
    return;
  }

  if (entity === 'task') {
    const state = row.state_id ? get<Row>(`SELECT name, group_key FROM states WHERE id = ?`, row.state_id) : undefined;
    const wasState = before?.state_id
      ? get<Row>(`SELECT name, group_key FROM states WHERE id = ?`, before.state_id)
      : undefined;
    const finished = state?.group_key === 'completed';
    const wasFinished = wasState?.group_key === 'completed';
    const payload = taskPayload(row, state, changed, opts);

    if (!before) dispatch(workspaceId, 'task.created', payload);
    else if (finished && !wasFinished) dispatch(workspaceId, 'task.completed', payload);
    else dispatch(workspaceId, 'task.updated', payload);

    // In *addition* to whichever of those three fired, never instead of one.
    // "When it reaches In Review" is the archetypal workflow and cannot be
    // written against `task.updated`, which does not say what it left — but a
    // hook already subscribed to `task.updated` must not go quiet because this
    // event was added underneath it.
    if (before && before.state_id !== row.state_id) {
      dispatch(workspaceId, 'task.moved', {
        ...payload,
        from: wasState ? { id: before.state_id, name: wasState.name, group: wasState.group_key } : null,
        to: state ? { id: row.state_id, name: state.name, group: state.group_key } : null,
      });
    }
    return;
  }

  if (entity === 'comment' && !before) {
    dispatch(workspaceId, 'comment.created', {
      id: row.id, task_id: row.task_id, page_id: row.page_id, author_id: row.author_id,
      body: String(row.body ?? '').slice(0, 500), project_id: null,
      // Where a person would go to read it, which is the task or the page — not
      // the comment, which has no screen of its own.
      url: env.publicUrl
        ? row.task_id ? `${env.publicUrl}/t/${row.task_id}`
          : row.page_id ? `${env.publicUrl}/pages/${row.page_id}` : null
        : null,
      ...who(opts),
    });
    return;
  }

  if (entity === 'page') {
    // A page fires on creation, and on an edit only when the *text* changed —
    // moving one in the tree is not news to a receiver. The body itself is not
    // sent: it is a document, and a receiver that wants it can read it.
    if (!before) {
      dispatch(workspaceId, 'page.created', {
        id: row.id, title: row.title, project_id: row.project_id, parent_id: row.parent_id ?? null,
        url: env.publicUrl ? `${env.publicUrl}/pages/${row.id}` : null,
        ...who(opts),
      });
    } else if (changed.content !== undefined) {
      dispatch(workspaceId, 'page.updated', {
        id: row.id, title: row.title, project_id: row.project_id,
        url: env.publicUrl ? `${env.publicUrl}/pages/${row.id}` : null,
        changed: Object.keys(changed),
        ...who(opts),
      });
    }
    return;
  }

  // A cycle and a module are what a report is usually *about*: the sprint that
  // ended, the milestone whose date moved. `changed` carries which fields did,
  // so a workflow can watch the one it cares about without a second call.
  if (entity === 'cycle' || entity === 'module') {
    dispatch(workspaceId, before ? `${entity}.updated` : `${entity}.created`, {
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      status: row.status ?? null,
      start_date: row.start_date ?? null,
      end_date: row.end_date ?? row.target_date ?? null,
      changed: Object.keys(changed),
      ...who(opts),
    });
    return;
  }

  if (entity === 'budget') {
    dispatch(workspaceId, before ? 'budget.updated' : 'budget.created', {
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      currency: row.currency,
      approved: Number(row.approved ?? 0),
      status: row.status ?? null,
      period_start: row.period_start ?? null,
      period_end: row.period_end ?? null,
      changed: Object.keys(changed),
      ...who(opts),
    });
    return;
  }

  // Every write, not only the first: an invoice that moves from committed to
  // paid is the event a ledger is waiting for, and correcting an amount is the
  // event an approval workflow is.
  if (entity === 'budgetActual' && !row.deleted_at) {
    dispatch(workspaceId, 'budget.spent', {
      id: row.id,
      budget_id: row.budget_id,
      line_id: row.line_id ?? null,
      description: row.description ?? '',
      category: row.category,
      amount: Number(row.amount ?? 0),
      currency: get<Row>(`SELECT currency FROM budgets WHERE id = ?`, row.budget_id)?.currency ?? null,
      spent_on: row.spent_on,
      stage: row.stage,
      vendor: row.vendor ?? null,
      reference: row.reference ?? null,
      changed: Object.keys(changed),
      ...who(opts),
    });
    return;
  }

  if (entity === 'timeEntry' && !before) {
    dispatch(workspaceId, 'time.logged', {
      id: row.id, task_id: row.task_id, project_id: row.project_id, user_id: row.user_id,
      minutes: row.minutes, spent_on: row.spent_on, billable: row.billable ?? 0,
      note: String(row.note ?? '').slice(0, 200) || null,
      ...who(opts),
    });
  }
}

/** Who did it: the id for a workflow, the name for a chat window. */
const who = (opts: WriteOpts): { actor_id: string; actor: string } =>
  ({ actor_id: opts.actorId, actor: displayName(opts.actorId) });

/**
 * A task as a receiver sees it.
 *
 * Wide enough that a workflow building a report does not have to call back for
 * the name of the state or the project, and no wider. The description is left
 * out because it is somebody's writing and can be six thousand characters; the
 * assignees are ids rather than names because a receiver that needs the names
 * reads them once from `/api/workspaces/:id/members` instead of being handed
 * everybody's, on every event, forever.
 *
 * `state` stays the *group* it has always been. The name arrived later and got
 * its own field rather than taking that one over, because a receiver reading
 * `state === 'completed'` today has to go on working.
 */
function taskPayload(
  row: Row,
  state: Row | undefined,
  changed: Record<string, unknown>,
  opts: WriteOpts,
): Record<string, unknown> {
  const labels = parseIds(row.labels);
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    project_id: row.project_id,
    project: get<Row>(`SELECT name FROM projects WHERE id = ?`, row.project_id)?.name ?? null,
    state: state?.group_key ?? null,
    state_id: row.state_id ?? null,
    state_name: state?.name ?? null,
    priority: row.priority,
    assignee_ids: parseIds(row.assignees),
    labels: labelNames(labels),
    cycle_id: row.cycle_id ?? null,
    module_id: row.module_id ?? null,
    parent_id: row.parent_id ?? null,
    estimate: row.estimate ?? null,
    start_date: row.start_date ?? null,
    due_date: row.due_date ?? null,
    completed_at: row.completed_at ?? null,
    changed: Object.keys(changed),
    url: env.publicUrl ? `${env.publicUrl}/t/${row.id}` : null,
    ...who(opts),
  };
}

/** Labels by name, because a name is what a workflow filters on. */
function labelNames(ids: string[]): string[] {
  if (!ids.length) return [];
  return all<Row>(
    `SELECT name FROM labels WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    ...ids,
  ).map((row) => String(row.name));
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

/**
 * Can this person see this budget, and therefore its lines and its invoices?
 *
 * A budget is scoped the way a cycle is — one project's own, the whole
 * workspace's, or exactly some projects — so the question is "can they see any
 * project it covers", with a workspace-wide budget answering yes to every
 * member.
 *
 * It exists as a function because three places have to agree on the answer:
 * the pull filter in `sync.ts`, the REST guard in `routes/entities.ts`, and
 * every budget tool over MCP. `guardReferences` will not do the job on its own
 * — a line names its budget and nothing else, so without this a workspace
 * member holding a budget id could read the plan for a project they are not on.
 */
export function canSeeBudget(userId: string, budgetId: string | null | undefined): boolean {
  if (!budgetId) return false;
  const budget = get<Row>(`SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL`, budgetId);
  if (!budget) return false;
  const member = get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    budget.workspace_id, userId,
  );
  if (!member) return false;
  const listed = parseIds(budget.projects);
  if (listed.length) return listed.some((projectId) => canSeeProject(userId, projectId));
  // No list and no owner is the whole workspace, and membership was the test.
  return budget.project_id ? canSeeProject(userId, String(budget.project_id)) : true;
}

/**
 * Whether somebody may see a KPI. The same three-state scope as a budget.
 *
 * Not restricted by role, unlike a rate. A number the team has undertaken to
 * move is a number the team should be able to see: a target everybody is
 * working toward and nobody may read is a target in name only.
 */
export function canSeeKpi(userId: string, kpiId: string | null | undefined): boolean {
  if (!kpiId) return false;
  const kpi = get<Row>(`SELECT * FROM kpis WHERE id = ? AND deleted_at IS NULL`, kpiId);
  if (!kpi) return false;
  const member = get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    kpi.workspace_id, userId,
  );
  if (!member) return false;
  const listed = parseIds(kpi.projects);
  if (listed.length) return listed.some((projectId) => canSeeProject(userId, projectId));
  return kpi.project_id ? canSeeProject(userId, String(kpi.project_id)) : true;
}

/** The budget a line, an actual or a scenario hangs off. */
export const budgetOf = (row: Row): string | null => (row.budget_id as string | null) ?? null;

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

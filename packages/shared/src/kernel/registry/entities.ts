/**
 * The single source of truth for everything that syncs.
 *
 * Server and client both derive their storage, validation and merge rules from
 * this registry, so adding a field is a one-line change in one place.
 */

export type EntityName =
  | 'user'
  | 'member'
  | 'team'
  | 'teamMember'
  | 'project'
  | 'projectMember'
  | 'state'
  | 'field'
  | 'fieldValue'
  | 'baseline'
  | 'budget'
  | 'budgetLine'
  | 'budgetActual'
  | 'budgetScenario'
  | 'rate'
  | 'vendor'
  | 'component'
  | 'move'
  | 'share'
  | 'label'
  | 'task'
  | 'relation'
  | 'cycle'
  | 'module'
  | 'kpi'
  | 'kpiTarget'
  | 'kpiReading'
  | 'page'
  | 'comment'
  | 'attachment'
  | 'view'
  | 'timeEntry'
  | 'template'
  | 'automation'
  | 'webhook'
  | 'notification'
  | 'activity'
  | 'intake'
  | 'channel'
  | 'message'
  | 'channelRead'
  | 'mailbox'
  | 'purge';

export interface EntityDef {
  /** SQL table name. */
  table: string;
  /** Mutable fields that participate in last-writer-wins merging. */
  fields: readonly string[];
  /** Fields only the server may write. Clients that try are ignored. */
  serverOnly?: readonly string[];
  /**
   * Fields that never leave the server at all — not written by a client and
   * not sent to one. A signing secret is the case: the receiver has it, and
   * nobody's browser needs it.
   */
  secret?: readonly string[];
  /** Entity rows are never created or edited by clients. */
  readOnly?: boolean;
  /** Rows belong to a single user and are not shared with the workspace. */
  private?: boolean;
  /**
   * Writable by a guest, who may otherwise write nothing at all.
   *
   * Only for a row that is **entirely about the person writing it** and is not
   * content anybody else will read. A read marker is the case: it says "I have
   * got this far", it is private to them, and without it a guest's unread count
   * climbs and can never come down — a number that cannot reach zero is worse
   * than no number.
   *
   * This is deliberately narrow. It is not "guests may write some things"; it
   * is "a note somebody keeps about themselves is not content".
   */
  guestWritable?: boolean;
  /**
   * A row of this entity may belong to **no workspace at all**.
   *
   * Almost everything here is inside an organisation: a task, a page, a label
   * only mean anything within one, and `workspace_id` is how sync, permissions
   * and export all find them. A direct conversation is not. It is between two
   * people, who may have no workspace in common and may each have several, and
   * filing it under one of them would mean it disappeared when they switched —
   * or, worse, that it could not exist at all until somebody invited somebody.
   *
   * So a direct channel carries `workspace_id = NULL`, and so do its messages
   * and read markers. Named here rather than special-cased in the four places
   * that ask, so that the *next* query cannot forget the case.
   */
  crossWorkspace?: boolean;
  /** Columns holding JSON-encoded values. */
  json?: readonly string[];
  /**
   * Columns that are **merged** rather than replaced.
   *
   * Last-writer-wins is right for almost everything: a title has one value and
   * the newer one is it. A page body does not — two people typing at once want
   * both changes, and picking one of them is a merge in name only. A field
   * named here carries a state-based CRDT and is combined with what is already
   * stored, on the server and on every device. See `text-crdt.ts`.
   */
  crdt?: readonly string[];
}

export const ENTITIES = {
  user: {
    table: 'users',
    fields: ['name', 'email', 'avatar_url', 'timezone', 'locale', 'bio', 'digest'],
    readOnly: true,
  },
  member: {
    table: 'workspace_members',
    fields: ['workspace_id', 'user_id', 'role'],
    readOnly: true,
  },
  team: {
    table: 'teams',
    fields: ['workspace_id', 'name', 'key', 'description', 'icon', 'color', 'archived'],
  },
  teamMember: {
    table: 'team_members',
    fields: ['workspace_id', 'team_id', 'user_id', 'role'],
  },
  project: {
    table: 'projects',
    fields: [
      'workspace_id', 'team_id', 'parent_id', 'name', 'key', 'description', 'icon', 'color',
      'lead_id', 'start_date', 'target_date', 'status', 'visibility', 'archived',
      'default_state_id', 'default_view_id', 'working_days', 'sort_order', 'is_container',
    ],
    json: ['working_days'],
  },
  projectMember: {
    table: 'project_members',
    fields: ['workspace_id', 'project_id', 'user_id', 'role'],
  },
  state: {
    table: 'states',
    fields: [
      'workspace_id', 'project_id', 'name', 'group_key', 'color', 'sort_order',
      'wip_limit', 'allowed_roles',
    ],
    json: ['allowed_roles'],
  },
  /** A field a project adds to its tasks. Every task in the project is asked. */
  field: {
    table: 'custom_fields',
    fields: [
      'workspace_id', 'project_id', 'name', 'kind', 'options',
      'help', 'required', 'show_in_table', 'archived', 'sort_order',
    ],
    json: ['options'],
  },
  /**
   * One task's answer to one field. Its own row rather than a map on the task,
   * so two people filling in two different fields on the same task merge
   * instead of overwriting each other. The id is derived from the pair, so two
   * devices answering the same field offline converge on one row rather than
   * two.
   */
  fieldValue: {
    table: 'field_values',
    fields: ['workspace_id', 'project_id', 'task_id', 'field_id', 'value'],
  },
  label: {
    table: 'labels',
    fields: ['workspace_id', 'project_id', 'name', 'color', 'description'],
  },
  task: {
    table: 'tasks',
    fields: [
      'workspace_id', 'project_id', 'title', 'description', 'state_id', 'priority',
      'assignees', 'labels', 'parent_id', 'cycle_id', 'module_id', 'estimate',
      'start_date', 'due_date', 'sort_order', 'completed_at', 'archived', 'created_by',
      'subscribers', 'recurrence', 'recurred_from',
    ],
    serverOnly: ['number', 'identifier'],
    json: ['assignees', 'labels', 'subscribers'],
  },
  /**
   * A plan, kept. Dates as they were on the day it was taken, so the chart can
   * draw what was promised behind what is happening.
   */
  baseline: {
    table: 'baselines',
    fields: ['workspace_id', 'project_id', 'name', 'taken_at', 'entries'],
    json: ['entries'],
  },
  /**
   * An envelope of money over a period, scoped exactly as a cycle is:
   * `project_id` set is one project's own, `project_id` null with an empty
   * `projects` is the whole workspace, and `projects` non-empty is exactly
   * those. See `coversProject` in `scope.ts`.
   */
  budget: {
    table: 'budgets',
    fields: [
      'workspace_id', 'project_id', 'projects', 'name', 'description', 'currency',
      'approved', 'period_start', 'period_end', 'status', 'owner_id', 'archived', 'sort_order',
    ],
    json: ['projects'],
  },
  /**
   * One planned cost. Its own row rather than an array on the budget, so two
   * people editing two lines from two devices merge instead of one of them
   * winning the whole plan — the same reason `fieldValue` is a row.
   */
  budgetLine: {
    table: 'budget_lines',
    fields: [
      'workspace_id', 'budget_id', 'name', 'category', 'kind', 'amount', 'recurrence',
      'starts_on', 'ends_on', 'vendor', 'confidence', 'allocations', 'note', 'sort_order',
    ],
    json: ['allocations'],
  },
  /** Money that actually moved. `line_id` null is a cost nobody planned for. */
  budgetActual: {
    table: 'budget_actuals',
    fields: [
      'workspace_id', 'budget_id', 'line_id', 'description', 'category', 'amount',
      'spent_on', 'stage', 'vendor', 'reference', 'allocations', 'note',
    ],
    /** Who filed it. Not the client's to claim — see `applyCreateDefaults`. */
    serverOnly: ['recorded_by'],
    json: ['allocations'],
  },
  /** A what-if over the plan. Never edits a line; see `applyScenario`. */
  budgetScenario: {
    table: 'budget_scenarios',
    fields: [
      'workspace_id', 'budget_id', 'name', 'description', 'adjustments', 'weights', 'sort_order',
    ],
    json: ['adjustments', 'weights'],
  },
  /**
   * A link that lets somebody outside the workspace read one thing.
   *
   * The token is the whole of the authorisation, so it is generated by the
   * server and never accepted from a client — a share whose secret the caller
   * chose is a share somebody else can guess.
   */
  share: {
    table: 'shares',
    fields: [
      'workspace_id', 'project_id', 'kind', 'page_id', 'view_id',
      'name', 'expires_at', 'include_done', 'allow_comments', 'created_by',
    ],
    serverOnly: ['token', 'views', 'last_seen_at'],
  },
  relation: {
    table: 'task_relations',
    fields: ['workspace_id', 'task_id', 'related_task_id', 'kind', 'lag'],
  },
  /**
   * A sprint. `project_id` set is one project's own; `project_id` null with an
   * empty `projects` is every project in the workspace; `projects` non-empty is
   * exactly those. See `coversProject` in `cycles.ts` — the empty list meaning
   * *everything* is the same rule `channel.members` follows.
   */
  cycle: {
    table: 'cycles',
    fields: ['workspace_id', 'project_id', 'projects', 'name', 'description', 'start_date', 'end_date', 'status'],
    json: ['projects'],
  },
  /**
   * A milestone. Scoped exactly as a cycle is: `project_id` set is one
   * project's own, `project_id` null with an empty `projects` is every project
   * in the workspace, and `projects` non-empty is exactly those. See
   * `coversProject` in `scope.ts`.
   */
  /**
   * A number somebody watches. The definition only — the measurements and the
   * targets are rows of their own, for the reason `budgetLine` is a row: two
   * people recording two readings from two devices should merge, not overwrite.
   */
  kpi: {
    table: 'kpis',
    fields: [
      'workspace_id', 'project_id', 'projects', 'name', 'description', 'unit', 'unit_label',
      'decimals', 'direction', 'baseline', 'cadence', 'owner_id', 'archived', 'sort_order',
    ],
    json: ['projects'],
  },
  /** What it has to reach, and by when. `module_id` set means "by that milestone". */
  kpiTarget: {
    table: 'kpi_targets',
    fields: ['workspace_id', 'kpi_id', 'module_id', 'due_on', 'value', 'note', 'sort_order'],
  },
  /** One measurement. */
  kpiReading: {
    table: 'kpi_readings',
    fields: ['workspace_id', 'kpi_id', 'measured_on', 'value', 'source', 'note'],
  },
  module: {
    table: 'modules',
    fields: [
      'workspace_id', 'project_id', 'projects', 'name', 'description', 'lead_id',
      'start_date', 'target_date', 'status', 'sort_order',
    ],
    json: ['projects'],
  },
  page: {
    table: 'pages',
    fields: [
      'workspace_id', 'project_id', 'parent_id', 'title', 'icon', 'content', 'body',
      'sort_order', 'archived', 'access', 'labels', 'watchers', 'is_template',
      'created_by', 'cover_url',
    ],
    json: ['labels', 'watchers', 'body'],
    /**
     * `body` is the page text as a CRDT and `content` is what it reads as.
     * Keeping both means every other thing that touches a page — search, export,
     * the share document, the markdown renderer, the API — carries on reading
     * plain text and knows nothing about any of this.
     */
    crdt: ['body'],
  },
  comment: {
    table: 'comments',
    fields: ['workspace_id', 'task_id', 'page_id', 'parent_id', 'body', 'author_id', 'guest_name', 'reactions', 'anchor'],
    json: ['reactions', 'anchor'],
  },
  attachment: {
    table: 'attachments',
    fields: [
      'workspace_id', 'task_id', 'page_id', 'comment_id', 'name', 'mime', 'size',
      'url', 'thumb_url', 'width', 'height', 'uploaded_by',
    ],
  },
  view: {
    table: 'views',
    fields: [
      'workspace_id', 'project_id', 'team_id', 'name', 'icon', 'layout',
      'filters', 'group_by', 'order_by', 'show_done', 'shared', 'owner_id', 'sort_order',
    ],
    json: ['filters'],
  },
  /**
   * What an hour is worth, from a date. Never edited in place — a new rate is
   * a new row, so what last quarter cost stays what last quarter cost.
   *
   * The one entity in this registry that does not reach every member: a rate
   * is close enough to somebody's pay that it goes only to owners and admins,
   * and so does every figure derived from it. See `filterFor` in `sync.ts`.
   */
  rate: {
    table: 'rates',
    fields: [
      'workspace_id', 'user_id', 'project_id', 'kind', 'amount', 'currency', 'starts_on', 'note',
    ],
  },
  /** Somebody you buy from. A component names one; the register groups by it. */
  vendor: {
    table: 'vendors',
    fields: [
      'workspace_id', 'name', 'kind', 'website', 'contact',
      'contract_start', 'contract_end', 'notice_days', 'note', 'archived',
    ],
  },
  /**
   * One thing in the estate, nested through `parent_id` so a server holds its
   * instances. Which components make up the landscape on a day is not stored —
   * it falls out of `live_from` and `live_until`. See `landscape.ts`.
   */
  component: {
    table: 'components',
    fields: [
      'workspace_id', 'vendor_id', 'parent_id', 'name', 'kind', 'environment', 'status',
      'live_from', 'live_until', 'location', 'reference', 'amount', 'recurrence', 'currency',
      'line_id', 'owner_id', 'projects', 'note', 'sort_order',
    ],
    json: ['projects'],
  },
  /** A documented step between two landscapes: what goes, what arrives. */
  move: {
    table: 'moves',
    fields: [
      'workspace_id', 'name', 'description', 'status', 'leaving', 'arriving',
      'target_date', 'owner_id', 'project_id', 'sort_order',
    ],
    json: ['leaving', 'arriving'],
  },
  timeEntry: {
    table: 'time_entries',
    fields: [
      'workspace_id', 'project_id', 'task_id', 'user_id', 'minutes', 'spent_on',
      'note', 'started_at', 'billable',
    ],
  },
  template: {
    table: 'templates',
    fields: [
      'workspace_id', 'project_id', 'name', 'kind', 'icon', 'title', 'description',
      'priority', 'labels', 'assignees', 'estimate', 'subtasks', 'target_project_id',
      'due_in_days', 'archived', 'sort_order',
    ],
    json: ['labels', 'assignees', 'subtasks'],
  },
  automation: {
    table: 'automations',
    fields: [
      'workspace_id', 'project_id', 'name', 'enabled', 'trigger_kind', 'trigger_state_id',
      'trigger_days', 'action_kind', 'action_patch',
      'trigger_group', 'template_id', 'recipients', 'fan_out', 'exclude_actor',
      'link_kind', 'apply_to_generated', 'once', 'sort_order',
    ],
    json: ['recipients'],
  },
  webhook: {
    table: 'webhooks',
    fields: ['workspace_id', 'project_id', 'name', 'url', 'events', 'enabled', 'direction', 'format'],
    /** The delivery result is worth showing; it is just not the client's to set. */
    serverOnly: ['last_status', 'last_error', 'last_sent_at'],
    /** The signing secret is the receiver's and this server's. Nobody else's. */
    secret: ['secret'],
  },
  notification: {
    table: 'notifications',
    fields: ['workspace_id', 'user_id', 'kind', 'title', 'body', 'task_id', 'page_id', 'project_id', 'channel_id', 'actor_id', 'read_at', 'archived_at'],
    serverOnly: ['workspace_id', 'user_id', 'kind', 'title', 'body', 'task_id', 'page_id', 'channel_id', 'actor_id'],
    private: true,
    // A notification about a direct message has no workspace either: it has to
    // reach somebody who may not be in the one it was written from.
    crossWorkspace: true,
  },
  /**
   * A conversation. Either a named channel or the direct one between two
   * people — see `chat.ts` for why a direct channel's id is derived from its
   * members rather than invented.
   *
   * `members` empty means *the workspace*, not nobody: an open channel is
   * open, and writing every member into every channel would mean keeping that
   * list correct as people join and leave.
   */
  channel: {
    table: 'channels',
    fields: [
      'workspace_id', 'project_id', 'kind', 'name', 'topic', 'is_private', 'members',
      'invite_policy', 'archived_at', 'created_by',
    ],
    json: ['members'],
    crossWorkspace: true,
  },
  message: {
    table: 'messages',
    fields: ['workspace_id', 'channel_id', 'author_id', 'body', 'reply_to', 'reactions', 'edited_at'],
    json: ['reactions'],
    crossWorkspace: true,
  },
  /**
   * How far somebody has read, and what they want to hear about. One row per
   * person per conversation, private to them: where you have got to in a
   * channel is nobody else's business, and a read receipt is a feature this
   * has deliberately not got.
   */
  channelRead: {
    table: 'channel_reads',
    fields: ['workspace_id', 'channel_id', 'user_id', 'last_read_at', 'notify'],
    serverOnly: ['user_id'],
    private: true,
    guestWritable: true,
    crossWorkspace: true,
  },
  activity: {
    table: 'activities',
    fields: ['workspace_id', 'project_id', 'task_id', 'page_id', 'actor_id', 'verb', 'field', 'old_value', 'new_value'],
    readOnly: true,
  },
  /**
   * Something reported from outside, before anybody has decided it is work.
   *
   * Written by an anonymous form and never by a client, so `readOnly`: the
   * things a member does to one — accept it, decline it — go through their own
   * route, because accepting is a task being created and that is not a field.
   */
  intake: {
    table: 'intakes',
    fields: [
      'workspace_id', 'project_id', 'share_id', 'reporter', 'email',
      'title', 'body', 'status', 'task_id', 'handled_by', 'handled_at',
    ],
    readOnly: true,
  },
  /**
   * A mail account this workspace has connected, not a folder inside one.
   *
   * `support@calendoora.de` with a host, a login and a password, so that three
   * people can search one inbox without any of them holding its credentials.
   * The messages are deliberately **not** entities: a mailbox has forty
   * thousand of them, and syncing that into every device's mirror to make an
   * assistant's search work would be paying the largest storage cost in the
   * product for the one reader that is not a browser. They live in server-only
   * tables and are reached over the API and MCP — the shape `email_queue` and
   * `webhook_deliveries` already use.
   *
   * `access` and `members` are the channel rule rather than the project rule,
   * because an inbox is entrusted rather than joined — see `canReadMailbox`,
   * which is the one place that decides, and note that an empty `members` on a
   * restricted mailbox means nobody.
   *
   * The password is `secret`: the settings screen shows whether one is set and
   * never what it is, the sync feed omits the column entirely, and a copied
   * database is not a copied inbox — it is sealed with the instance key the
   * same way an SMTP password in `instance_settings` is.
   */
  mailbox: {
    table: 'mailboxes',
    fields: [
      'workspace_id', 'address', 'name', 'host', 'port', 'encryption', 'username',
      'folders', 'access', 'members', 'enabled', 'sync_days', 'created_by',
    ],
    /** What the poller found out. Worth showing; not the client's to claim. */
    serverOnly: ['last_sync_at', 'last_error', 'last_status', 'message_count'],
    secret: ['password'],
    json: ['members', 'folders'],
  },
  /**
   * A tombstone that has itself been thrown away.
   *
   * Deleting a row here means stamping `deleted_at` and letting the tombstone
   * keep syncing — that is the only way two devices ever agree something is
   * gone. So emptying the trash cannot simply drop the row: a device that has
   * it would show it in *its* trash forever and could put it back.
   *
   * This is the marker that says the tombstone is finished with. It syncs like
   * anything else, and a client that receives one deletes its copy of the row
   * it names. Tiny, and kept: it is the only record that the thing ever existed.
   */
  purge: {
    table: 'purges',
    fields: ['workspace_id', 'entity', 'row_id', 'reason'],
    readOnly: true,
  },
} as const satisfies Record<EntityName, EntityDef>;

export const ENTITY_NAMES = Object.keys(ENTITIES) as EntityName[];

/** What somebody with the guest role may still write. See `guestWritable`. */
export const GUEST_WRITABLE: readonly EntityName[] = ENTITY_NAMES.filter(
  (name) => (ENTITIES[name] as { guestWritable?: boolean }).guestWritable === true,
);

export const isGuestWritable = (entity: EntityName): boolean => GUEST_WRITABLE.includes(entity);

/** Entities whose rows may sit outside any workspace. See `crossWorkspace`. */
export const CROSS_WORKSPACE: readonly EntityName[] = ENTITY_NAMES.filter(
  (name) => (ENTITIES[name] as { crossWorkspace?: boolean }).crossWorkspace === true,
);

export const isCrossWorkspace = (entity: EntityName): boolean => CROSS_WORKSPACE.includes(entity);

/** Columns present on every syncable table. */
export const SYSTEM_FIELDS = ['id', 'created_at', 'updated_at', 'deleted_at', 'seq', 'clocks'] as const;

export function entityDef(name: string): EntityDef | undefined {
  return (ENTITIES as Record<string, EntityDef>)[name];
}

export function tableFor(name: EntityName): string {
  return ENTITIES[name].table;
}

/**
 * The URL segment each entity is served under.
 *
 * Here rather than in the server's routes because the client needs it too: when
 * the server rejects a mutation, the client has to re-read the row it was wrong
 * about, and it can only do that if both sides agree on the word.
 */
export const COLLECTIONS: Record<EntityName, string> = {
  user: 'users',
  member: 'members',
  team: 'teams',
  teamMember: 'team-members',
  project: 'projects',
  projectMember: 'project-members',
  state: 'states',
  field: 'fields',
  fieldValue: 'field-values',
  baseline: 'baselines',
  budget: 'budgets',
  budgetLine: 'budget-lines',
  budgetActual: 'budget-actuals',
  budgetScenario: 'budget-scenarios',
  rate: 'rates',
  vendor: 'vendors',
  component: 'components',
  move: 'moves',
  share: 'shares',
  label: 'labels',
  task: 'tasks',
  relation: 'relations',
  cycle: 'cycles',
  kpi: 'kpis',
  kpiTarget: 'kpi-targets',
  kpiReading: 'kpi-readings',
  module: 'modules',
  page: 'pages',
  comment: 'comments',
  attachment: 'attachments',
  view: 'views',
  timeEntry: 'time-entries',
  template: 'templates',
  automation: 'automations',
  webhook: 'webhooks',
  notification: 'notifications',
  channel: 'channels',
  message: 'messages',
  channelRead: 'channel-reads',
  mailbox: 'mailboxes',
  activity: 'activities',
  intake: 'intakes',
  purge: 'purges',
};

/**
 * URL segment -> entity, for the five routes every entity gets.
 *
 * Derived from `COLLECTIONS` rather than written out again, so a new entity is
 * one line in one file and it appears in the REST surface. Three are left out
 * because they are read through their own routes: `user` and `member` come back
 * shaped by who is asking, and `activity` is a log rather than a collection.
 *
 * It lives here beside the map it filters, not beside the routes that use it,
 * because it is a fact about the registry — and because the OpenAPI generator
 * has to be able to ask which collections exist without starting a server.
 */
export const REST_ENTITIES: Record<string, EntityName> = Object.fromEntries(
  (Object.entries(COLLECTIONS) as [EntityName, string][])
    .filter(([entity]) => entity !== 'user' && entity !== 'member' && entity !== 'activity')
    .map(([entity, segment]) => [segment, entity]),
);

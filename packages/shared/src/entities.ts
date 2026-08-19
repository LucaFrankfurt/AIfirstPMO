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
  | 'taskType'
  | 'field'
  | 'fieldValue'
  | 'baseline'
  | 'share'
  | 'label'
  | 'task'
  | 'relation'
  | 'cycle'
  | 'module'
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
      'default_state_id', 'default_view_id', 'working_days', 'sort_order',
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
  taskType: {
    table: 'task_types',
    fields: ['workspace_id', 'project_id', 'name', 'icon', 'color', 'is_default', 'sort_order'],
  },
  /**
   * A field a project adds to its tasks. `type_ids` is what OpenProject calls a
   * type-dependent field: empty means every work item type, otherwise only
   * those — a Bug asks for steps to reproduce, a Feature does not.
   */
  field: {
    table: 'custom_fields',
    fields: [
      'workspace_id', 'project_id', 'name', 'kind', 'options', 'type_ids',
      'help', 'required', 'show_in_table', 'archived', 'sort_order',
    ],
    json: ['options', 'type_ids'],
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
      'workspace_id', 'project_id', 'title', 'description', 'state_id', 'type_id', 'priority',
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
  cycle: {
    table: 'cycles',
    fields: ['workspace_id', 'project_id', 'name', 'description', 'start_date', 'end_date', 'status'],
  },
  module: {
    table: 'modules',
    fields: [
      'workspace_id', 'project_id', 'name', 'description', 'lead_id',
      'start_date', 'target_date', 'status', 'sort_order',
    ],
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
  },
  message: {
    table: 'messages',
    fields: ['workspace_id', 'channel_id', 'author_id', 'body', 'reply_to', 'reactions', 'edited_at'],
    json: ['reactions'],
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
  taskType: 'task-types',
  field: 'fields',
  fieldValue: 'field-values',
  baseline: 'baselines',
  share: 'shares',
  label: 'labels',
  task: 'tasks',
  relation: 'relations',
  cycle: 'cycles',
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
  activity: 'activities',
  intake: 'intakes',
  purge: 'purges',
};

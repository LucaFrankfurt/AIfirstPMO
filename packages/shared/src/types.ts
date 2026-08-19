import type { EntityName } from './entities.ts';
import type { HLC } from './hlc.ts';

export type ID = string;
export type ISODate = string;

/* ------------------------------------------------------------------ enums */

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;
export type StateGroup = (typeof STATE_GROUPS)[number];

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const PROJECT_ROLES = ['lead', 'member', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const RELATION_KINDS = ['blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicated_by'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const LAYOUTS = ['list', 'board', 'calendar', 'table', 'gantt'] as const;
export type Layout = (typeof LAYOUTS)[number];

export const PROJECT_STATUS = ['planned', 'in_progress', 'paused', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUS)[number];

/**
 * What a custom field holds. Deliberately short: every kind here is one input
 * a person already knows how to use, and each has an obvious empty value. A
 * formula or a rollup is a different feature wearing the same word.
 */
export const FIELD_KINDS = ['text', 'long_text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'person'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/* ------------------------------------------------- templates + automation */

/** What a template is for. Only affects the icon and how it is grouped. */
export const TEMPLATE_KINDS = ['feedback', 'review', 'task', 'bug', 'checklist'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const AUTOMATION_TRIGGERS = [
  'state_entered', 'state_group_entered', 'task_created',
  /** A number of days before the due date — the one trigger a clock fires. */
  'due_in',
  /** Somebody edited a page's body. */
  'page_changed',
  /** Somebody commented on a task. */
  'comment_added',
] as const;

/** What a rule does when it fires. */
export const AUTOMATION_ACTIONS = ['file_template', 'set_fields'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGERS)[number];

/**
 * Who gets the task an automation creates.
 *
 * Deliberately a list of *selectors* rather than a list of user ids: a rule
 * that says "the people working on it and whoever leads the project" keeps
 * meaning that after the team changes, which a list of ids does not. Several
 * selectors combine, and the result is de-duplicated.
 */
export const RECIPIENT_KINDS = ['user', 'assignees', 'creator', 'actor', 'lead', 'team', 'role'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export interface Recipient {
  kind: RecipientKind;
  /** User id for `user`, team id for `team`, role name for `role`. */
  ref?: ID | WorkspaceRole | null;
}

/** One task with everybody on it, or one task each. */
export const FAN_OUT = ['single', 'each'] as const;
export type FanOut = (typeof FAN_OUT)[number];

/* -------------------------------------------------------------- base rows */

export interface Base {
  id: ID;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** Server-assigned, workspace-monotonic sync cursor. */
  seq: number;
}

export interface User extends Base {
  name: string;
  email: string;
  avatar_url: string | null;
  timezone: string | null;
  /** Interface and email language, e.g. `en` or `de`. Empty means "ask the browser". */
  locale: string | null;
  bio: string | null;
  /** `off` | `daily` | `weekly` — how often the inbox is summarised by email. */
  digest: string;
}

export interface Member extends Base {
  workspace_id: ID;
  user_id: ID;
  role: WorkspaceRole;
}

export interface Workspace {
  id: ID;
  name: string;
  slug: string;
  logo_url: string | null;
  created_at: number;
}

export interface Team extends Base {
  workspace_id: ID;
  name: string;
  key: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  archived: number;
}

export interface TeamMember extends Base {
  workspace_id: ID;
  team_id: ID;
  user_id: ID;
  role: string;
}

export interface Project extends Base {
  workspace_id: ID;
  team_id: ID | null;
  name: string;
  key: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  lead_id: ID | null;
  start_date: ISODate | null;
  target_date: ISODate | null;
  status: ProjectStatus;
  visibility: 'public' | 'private';
  archived: number;
  default_state_id: ID | null;
  sort_order: string;
}

export interface ProjectMember extends Base {
  workspace_id: ID;
  project_id: ID;
  user_id: ID;
  role: ProjectRole;
}

export interface State extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  group_key: StateGroup;
  color: string;
  sort_order: string;
}

/**
 * What kind of thing a task is — a bug, a feature, a chore.
 *
 * Per project, like the workflow states, because two projects disagree about
 * this the same way they disagree about their columns. It changes what a task
 * is called and how it groups, not which fields it has: forms that change per
 * type are custom fields, which is a much larger idea.
 */
export interface TaskType extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  icon: string | null;
  color: string;
  /** The one new tasks get. Exactly one per project should carry it. */
  is_default: number;
  sort_order: string;
}

export interface Field extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  kind: FieldKind;
  /** Choices, for the two select kinds. Ignored by every other kind. */
  options: string[];
  /** Which work item types show this field. Empty means all of them. */
  type_ids: ID[];
  help: string | null;
  /**
   * A prompt, not a gate. Nothing refuses to save a task without it: a task
   * created offline, by a rule or over the API would otherwise be impossible
   * to write, and a required field that only sometimes applies teaches people
   * to type a full stop into it.
   */
  required: number;
  /** Offer it as a column in the table view. */
  show_in_table: number;
  archived: number;
  sort_order: string;
}

export interface FieldValue extends Base {
  workspace_id: ID;
  project_id: ID;
  task_id: ID;
  field_id: ID;
  /** Always text on the wire; `readFieldValue` turns it back into its kind. */
  value: string | null;
}

export interface Label extends Base {
  workspace_id: ID;
  project_id: ID | null;
  name: string;
  color: string;
  description: string | null;
}

export interface Task extends Base {
  workspace_id: ID;
  project_id: ID;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  state_id: ID;
  /** Which kind of work this is. Null on tasks that predate the project's types. */
  type_id: ID | null;
  priority: Priority;
  assignees: ID[];
  labels: ID[];
  subscribers: ID[];
  parent_id: ID | null;
  cycle_id: ID | null;
  module_id: ID | null;
  estimate: number | null;
  start_date: ISODate | null;
  due_date: ISODate | null;
  sort_order: string;
  completed_at: number | null;
  archived: number;
  created_by: ID;
  /**
   * How this repeats, if it does: `daily`, `weekly:2`, `monthly`.
   *
   * The next one is created when this one is finished, not on a calendar. A
   * weekly task nobody did four times is one task that is late, not four.
   */
  recurrence: string | null;
  /** The task this one was created from, when it is a repeat. */
  recurred_from: ID | null;
}

export interface Relation extends Base {
  workspace_id: ID;
  task_id: ID;
  related_task_id: ID;
  kind: RelationKind;
}

export interface Cycle extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  description: string | null;
  start_date: ISODate | null;
  end_date: ISODate | null;
  status: string | null;
}

export interface Module extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  description: string | null;
  lead_id: ID | null;
  start_date: ISODate | null;
  target_date: ISODate | null;
  status: string;
  sort_order: string;
}

export interface Page extends Base {
  workspace_id: ID;
  project_id: ID | null;
  parent_id: ID | null;
  title: string;
  icon: string | null;
  content: string;
  sort_order: string;
  archived: number;
  access: 'workspace' | 'project' | 'private';
  labels: ID[];
  /** Who asked to hear about changes — a page has no assignees to fall back on. */
  watchers: ID[];
  /** A page kept as a starting point rather than as content. */
  is_template: number;
  created_by: ID;
  cover_url: string | null;
}

export interface Comment extends Base {
  workspace_id: ID;
  task_id: ID | null;
  page_id: ID | null;
  parent_id: ID | null;
  body: string;
  author_id: ID;
  reactions: Record<string, ID[]>;
}

export interface Attachment extends Base {
  workspace_id: ID;
  task_id: ID | null;
  page_id: ID | null;
  comment_id: ID | null;
  name: string;
  mime: string;
  size: number;
  url: string;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
  uploaded_by: ID;
}

export interface Filters {
  state?: ID[];
  type?: ID[];
  group?: StateGroup[];
  priority?: Priority[];
  assignee?: ID[];
  label?: ID[];
  cycle?: ID[];
  module?: ID[];
  project?: ID[];
  created_by?: ID[];
  text?: string;
  due?: 'overdue' | 'today' | 'week' | 'none';
}

/**
 * Time actually spent, as opposed to `Task.estimate`, which is time guessed.
 *
 * A row with `started_at` set and `minutes` still 0 is a running timer;
 * stopping it writes the minutes and clears `started_at`. Keeping both in one
 * row means a timer survives a reload, a second device and being offline —
 * it is a fact about the past, not a piece of interface state.
 */
export interface TimeEntry extends Base {
  workspace_id: ID;
  project_id: ID | null;
  task_id: ID | null;
  user_id: ID;
  /** Whole minutes. Nobody logs seconds and everybody argues about decimals. */
  minutes: number;
  /** The day the work happened, which is not always the day it was entered. */
  spent_on: ISODate;
  note: string | null;
  /** Epoch millis while a timer is running, null otherwise. */
  started_at: number | null;
  billable: number;
}

export interface View extends Base {
  workspace_id: ID;
  project_id: ID | null;
  team_id: ID | null;
  name: string;
  icon: string | null;
  layout: Layout;
  filters: Filters;
  group_by: string;
  order_by: string;
  /** Whether completed and cancelled tasks are part of the view. */
  show_done: number;
  /** 0 keeps it to its owner; 1 offers it to everyone who can see the project. */
  shared: number;
  owner_id: ID;
  sort_order: string;
}

/**
 * A task, pre-written. Used by hand ("new task from template") and by the
 * automations below, which is why the two are separate entities: a template is
 * useful without a rule, and a rule needs a template to have something to say.
 */
export interface Template extends Base {
  workspace_id: ID;
  /** Null means the whole workspace can use it. */
  project_id: ID | null;
  name: string;
  kind: TemplateKind;
  icon: string | null;
  /** Both support `{identifier}`, `{title}`, `{project}`, `{actor}`, `{state}`, `{url}`. */
  title: string;
  description: string | null;
  priority: Priority;
  labels: ID[];
  /** Always assigned on top of whatever an automation resolves. */
  assignees: ID[];
  estimate: number | null;
  /** One sub-task per line, created with the task. */
  subtasks: string[];
  /** Null means "the project the source task is in". */
  target_project_id: ID | null;
  /** Days from creation; null leaves the due date empty. */
  due_in_days: number | null;
  archived: number;
  sort_order: string;
}

/** When something happens to a task, make a task from a template. */
export interface Automation extends Base {
  workspace_id: ID;
  /** Null means every project in the workspace. */
  project_id: ID | null;
  name: string;
  enabled: number;
  trigger_kind: AutomationTriggerKind;
  /** For `state_entered`. */
  trigger_state_id: ID | null;
  /** For `state_group_entered`. */
  trigger_group: StateGroup | null;
  /** For `due_in`: how many days before the due date. */
  trigger_days: number;
  /** What it does when it fires. */
  action_kind: AutomationAction;
  /** For `set_fields`: the patch to apply to the task that triggered it. */
  action_patch: Record<string, unknown>;
  /** Required for `file_template`; empty otherwise. */
  template_id: ID;
  recipients: Recipient[];
  fan_out: FanOut;
  /** Leave out whoever caused the trigger — you rarely review your own work. */
  exclude_actor: number;
  /** How the new task is linked back to the one that triggered it; '' for none. */
  link_kind: RelationKind | '';
  /** Whether the rule also applies to tasks an automation created. Off by default. */
  apply_to_generated: number;
  /** Fire at most once per task, rather than on every entry. */
  once: number;
  sort_order: string;
}

/** An HTTP call out when something happens. Rules act inwards; this acts out. */
export interface Webhook extends Base {
  workspace_id: ID;
  project_id: ID | null;
  name: string;
  url: string;
  /** Comma-separated event names. */
  events: string;
  enabled: number;
  last_status: number | null;
  last_error: string | null;
  last_sent_at: number | null;
}

export interface Notification extends Base {
  workspace_id: ID;
  user_id: ID;
  kind: string;
  title: string;
  body: string | null;
  task_id: ID | null;
  page_id: ID | null;
  actor_id: ID | null;
  read_at: number | null;
  archived_at: number | null;
}

export interface Activity extends Base {
  workspace_id: ID;
  project_id: ID | null;
  task_id: ID | null;
  page_id: ID | null;
  actor_id: ID;
  verb: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
}

export interface EntityMap {
  user: User;
  member: Member;
  team: Team;
  teamMember: TeamMember;
  project: Project;
  projectMember: ProjectMember;
  state: State;
  label: Label;
  taskType: TaskType;
  field: Field;
  fieldValue: FieldValue;
  task: Task;
  relation: Relation;
  cycle: Cycle;
  module: Module;
  page: Page;
  comment: Comment;
  attachment: Attachment;
  view: View;
  timeEntry: TimeEntry;
  template: Template;
  automation: Automation;
  webhook: Webhook;
  notification: Notification;
  activity: Activity;
}

/* --------------------------------------------------------- sync protocol */

export interface Mutation {
  /** Client-generated, so retries are idempotent. */
  id: ID;
  entity: EntityName;
  entityId: ID;
  op: 'upsert' | 'delete';
  /** Only the fields the user actually touched. */
  patch: Record<string, unknown>;
  hlc: HLC;
}

export interface PushRequest {
  workspaceId: ID;
  clientId: string;
  mutations: Mutation[];
}

export interface PushResponse {
  /** Mutation ids that were applied or already known. */
  accepted: ID[];
  rejected: { id: ID; reason: string }[];
  /** Server-side values for rows the server rewrote (e.g. task identifiers). */
  patched: ChangeSet;
  cursor: number;
}

export type ChangeSet = { [K in EntityName]?: Record<string, unknown>[] };

export interface PullResponse {
  changes: ChangeSet;
  cursor: number;
  /**
   * The server truncated this page and has more to give from `cursor`.
   *
   * Stated rather than inferred: a client guessing from "was any page exactly
   * full" is right until a workspace has exactly a page of changes, and being
   * wrong there means it silently stops syncing.
   */
  hasMore?: boolean;
  /** Server asks the client to drop its cache and re-pull from zero. */
  reset?: boolean;
  now: number;
}

export interface SessionInfo {
  /** `two_factor` is derived rather than stored on the row: the secret itself never leaves the server. */
  user: User & { two_factor?: boolean };
  workspaces: (Workspace & { role: WorkspaceRole })[];
  token?: string;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

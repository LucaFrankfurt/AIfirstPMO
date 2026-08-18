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
  shared: number;
  owner_id: ID;
  sort_order: string;
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
  task: Task;
  relation: Relation;
  cycle: Cycle;
  module: Module;
  page: Page;
  comment: Comment;
  attachment: Attachment;
  view: View;
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
  /** Server asks the client to drop its cache and re-pull from zero. */
  reset?: boolean;
  now: number;
}

export interface SessionInfo {
  user: User;
  workspaces: (Workspace & { role: WorkspaceRole })[];
  token?: string;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

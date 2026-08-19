-- Kolibri schema. Every syncable table carries the same six system columns:
--   id, workspace_id, created_at, updated_at, deleted_at, seq, clocks
-- `seq` is a globally monotonic cursor used by the sync engine, `clocks` holds
-- the per-field HLC stamps used for last-writer-wins merging.

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  avatar_url    TEXT,
  timezone      TEXT,
  locale        TEXT,
  bio           TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER,
  digest        TEXT NOT NULL DEFAULT 'off',
  -- Second factor. `totp_secret` is set the moment somebody starts setting one
  -- up; `totp_confirmed_at` only once they have typed a code that worked, so an
  -- abandoned setup never locks anybody out.
  totp_secret   TEXT,
  totp_confirmed_at INTEGER,
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  seq           INTEGER NOT NULL DEFAULT 0,
  clocks        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS users_seq ON users (seq);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  logo_url   TEXT,
  owner_id   TEXT NOT NULL,
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}',
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_seq ON workspace_members (workspace_id, seq);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  workspace_id TEXT,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'read,write',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_user ON api_tokens (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'member',
  code         TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  accepted_at  INTEGER,
  accepted_by  TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  key          TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  color        TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS teams_seq ON teams (workspace_id, seq);

CREATE TABLE IF NOT EXISTS team_members (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  team_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS team_members_seq ON team_members (workspace_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_unique ON team_members (team_id, user_id);

CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  team_id          TEXT,
  -- A project under another one. Nesting is a way of reading the list, not a
  -- permission boundary: a sub-project keeps its own members and visibility.
  parent_id        TEXT,
  name             TEXT NOT NULL,
  key              TEXT NOT NULL,
  description      TEXT,
  icon             TEXT,
  color            TEXT,
  lead_id          TEXT,
  start_date       TEXT,
  target_date      TEXT,
  status           TEXT NOT NULL DEFAULT 'in_progress',
  visibility       TEXT NOT NULL DEFAULT 'public',
  archived         INTEGER NOT NULL DEFAULT 0,
  default_state_id TEXT,
  default_view_id  TEXT,
  sort_order       TEXT NOT NULL DEFAULT 'V',
  next_number      INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  seq              INTEGER NOT NULL DEFAULT 0,
  clocks           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS projects_seq ON projects (workspace_id, seq);

CREATE TABLE IF NOT EXISTS project_members (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS project_members_seq ON project_members (workspace_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS project_members_unique ON project_members (project_id, user_id);

CREATE TABLE IF NOT EXISTS states (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  group_key    TEXT NOT NULL DEFAULT 'backlog',
  color        TEXT NOT NULL DEFAULT '#94a3b8',
  sort_order   TEXT NOT NULL DEFAULT 'V',
  -- How many tasks may sit in this column at once; 0 means no limit.
  wip_limit    INTEGER NOT NULL DEFAULT 0,
  -- Workspace roles allowed to move a task *into* it. Empty means anybody.
  allowed_roles TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS states_seq ON states (workspace_id, seq);

-- What kind of thing a task is: a bug, a feature, a chore. Per project, like
-- the workflow states, because a design project and an API project disagree
-- about this the same way they disagree about their columns.
--
-- Deliberately *not* type-dependent forms. A type here changes what a task is
-- called and how it is grouped, not which fields it has; fields that appear and
-- disappear per type are a much larger idea and would arrive as custom fields.
CREATE TABLE IF NOT EXISTS task_types (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  icon         TEXT,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  is_default   INTEGER NOT NULL DEFAULT 0,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS task_types_seq ON task_types (workspace_id, seq);
CREATE INDEX IF NOT EXISTS task_types_project ON task_types (project_id);

-- A field a project adds to its tasks. `type_ids` is the type-dependent part:
-- empty means every work item type, otherwise only the ones listed.
CREATE TABLE IF NOT EXISTS custom_fields (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'text',
  options       TEXT NOT NULL DEFAULT '[]',
  type_ids      TEXT NOT NULL DEFAULT '[]',
  help          TEXT,
  required      INTEGER NOT NULL DEFAULT 0,
  show_in_table INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  sort_order    TEXT NOT NULL DEFAULT 'V',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  seq           INTEGER NOT NULL DEFAULT 0,
  clocks        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS custom_fields_seq ON custom_fields (workspace_id, seq);
CREATE INDEX IF NOT EXISTS custom_fields_project ON custom_fields (project_id);

-- One task's answer to one field. A row of its own rather than a map on the
-- task, so two people filling in two different fields on the same task merge
-- instead of overwriting each other.
CREATE TABLE IF NOT EXISTS field_values (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  field_id     TEXT NOT NULL,
  value        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS field_values_seq ON field_values (workspace_id, seq);
CREATE INDEX IF NOT EXISTS field_values_task ON field_values (task_id);

-- A plan as it stood on one day, so the timeline can draw what was promised
-- behind what is happening. Whole snapshots rather than per-task history: a
-- baseline is a thing somebody *took*, and it is read all at once.
CREATE TABLE IF NOT EXISTS baselines (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  taken_at     INTEGER NOT NULL DEFAULT 0,
  entries      TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS baselines_seq ON baselines (workspace_id, seq);
CREATE INDEX IF NOT EXISTS baselines_project ON baselines (project_id);

-- Read-only links to one page or one filtered task list. The token is the whole
-- of the authorisation, so it is generated here and never taken from a client.
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  kind         TEXT NOT NULL DEFAULT 'page',
  page_id      TEXT,
  view_id      TEXT,
  name         TEXT NOT NULL DEFAULT '',
  token        TEXT NOT NULL DEFAULT '',
  expires_at   INTEGER,
  include_done INTEGER NOT NULL DEFAULT 1,
  views        INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_token ON shares (token);
CREATE INDEX IF NOT EXISTS shares_seq ON shares (workspace_id, seq);

CREATE TABLE IF NOT EXISTS labels (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS labels_seq ON labels (workspace_id, seq);

CREATE TABLE IF NOT EXISTS cycles (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  start_date   TEXT,
  end_date     TEXT,
  status       TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS cycles_seq ON cycles (workspace_id, seq);

CREATE TABLE IF NOT EXISTS modules (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  lead_id      TEXT,
  start_date   TEXT,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'planned',
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS modules_seq ON modules (workspace_id, seq);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  number       INTEGER NOT NULL DEFAULT 0,
  identifier   TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT,
  state_id     TEXT,
  type_id      TEXT,
  -- How this task repeats, if it does: 'daily' | 'weekly' | 'monthly' with an
  -- interval, e.g. `weekly:2`. Empty means it happens once.
  recurrence   TEXT,
  -- Set on the copy so the chain can be followed back.
  recurred_from TEXT,
  priority     TEXT NOT NULL DEFAULT 'none',
  assignees    TEXT NOT NULL DEFAULT '[]',
  labels       TEXT NOT NULL DEFAULT '[]',
  subscribers  TEXT NOT NULL DEFAULT '[]',
  parent_id    TEXT,
  cycle_id     TEXT,
  module_id    TEXT,
  estimate     REAL,
  start_date   TEXT,
  due_date     TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  completed_at INTEGER,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS tasks_seq ON tasks (workspace_id, seq);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, deleted_at);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks (state_id);
CREATE INDEX IF NOT EXISTS tasks_cycle ON tasks (cycle_id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_identifier ON tasks (workspace_id, identifier);

CREATE TABLE IF NOT EXISTS task_relations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  related_task_id TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'relates_to',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  seq             INTEGER NOT NULL DEFAULT 0,
  clocks          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS relations_seq ON task_relations (workspace_id, seq);
CREATE INDEX IF NOT EXISTS relations_task ON task_relations (task_id);

CREATE TABLE IF NOT EXISTS pages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  parent_id    TEXT,
  title        TEXT NOT NULL DEFAULT 'Untitled',
  icon         TEXT,
  content      TEXT NOT NULL DEFAULT '',
  sort_order   TEXT NOT NULL DEFAULT 'V',
  archived     INTEGER NOT NULL DEFAULT 0,
  access       TEXT NOT NULL DEFAULT 'workspace',
  labels       TEXT NOT NULL DEFAULT '[]',
  -- Who asked to hear about changes. A page has no assignees, so this is the
  -- only way somebody can follow one they did not write.
  watchers     TEXT NOT NULL DEFAULT '[]',
  is_template  INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  cover_url    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS pages_seq ON pages (workspace_id, seq);
CREATE INDEX IF NOT EXISTS pages_parent ON pages (parent_id);

CREATE TABLE IF NOT EXISTS page_versions (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  title      TEXT NOT NULL,
  author_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS page_versions_page ON page_versions (page_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id      TEXT,
  page_id      TEXT,
  parent_id    TEXT,
  body         TEXT NOT NULL DEFAULT '',
  author_id    TEXT,
  reactions    TEXT NOT NULL DEFAULT '{}',
  -- The passage a comment is about, when it was made on a selection: the quote
  -- plus its surroundings, so it can be found again after an edit.
  anchor       TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS comments_seq ON comments (workspace_id, seq);
CREATE INDEX IF NOT EXISTS comments_task ON comments (task_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id      TEXT,
  page_id      TEXT,
  comment_id   TEXT,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL DEFAULT 0,
  url          TEXT NOT NULL,
  thumb_url    TEXT,
  width        INTEGER,
  height       INTEGER,
  checksum     TEXT,
  uploaded_by  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS attachments_seq ON attachments (workspace_id, seq);
CREATE INDEX IF NOT EXISTS attachments_task ON attachments (task_id);

-- Time actually spent, as opposed to `tasks.estimate`, which is time guessed.
-- One row per stretch of work. A row with `started_at` set and no minutes yet
-- is a timer that is still running; stopping it fills the minutes in.
CREATE TABLE IF NOT EXISTS time_entries (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  task_id      TEXT,
  user_id      TEXT NOT NULL,
  minutes      INTEGER NOT NULL DEFAULT 0,
  spent_on     TEXT NOT NULL,
  note         TEXT,
  started_at   INTEGER,
  billable     INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS time_entries_seq ON time_entries (workspace_id, seq);
CREATE INDEX IF NOT EXISTS time_entries_task ON time_entries (task_id);
CREATE INDEX IF NOT EXISTS time_entries_user ON time_entries (user_id, spent_on);

CREATE TABLE IF NOT EXISTS views (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  team_id      TEXT,
  name         TEXT NOT NULL,
  icon         TEXT,
  layout       TEXT NOT NULL DEFAULT 'list',
  filters      TEXT NOT NULL DEFAULT '{}',
  group_by     TEXT NOT NULL DEFAULT 'state',
  order_by     TEXT NOT NULL DEFAULT 'manual',
  show_done    INTEGER NOT NULL DEFAULT 1,
  shared       INTEGER NOT NULL DEFAULT 1,
  owner_id     TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS views_seq ON views (workspace_id, seq);

-- A task, pre-written. Usable by hand and by the automations below.
CREATE TABLE IF NOT EXISTS templates (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  project_id        TEXT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'task',
  icon              TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  priority          TEXT NOT NULL DEFAULT 'none',
  labels            TEXT NOT NULL DEFAULT '[]',
  assignees         TEXT NOT NULL DEFAULT '[]',
  estimate          REAL,
  subtasks          TEXT NOT NULL DEFAULT '[]',
  target_project_id TEXT,
  due_in_days       INTEGER,
  archived          INTEGER NOT NULL DEFAULT 0,
  sort_order        TEXT NOT NULL DEFAULT 'V',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  seq               INTEGER NOT NULL DEFAULT 0,
  clocks            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS templates_seq ON templates (workspace_id, seq);

-- When something happens to a task, make a task from a template.
-- What the scheduler has already done. Not synced: it is bookkeeping, and the
-- effect it guards (a notification, a task) is the thing people see.
-- Outgoing webhooks. Rules act inwards; this is the way out.
CREATE TABLE IF NOT EXISTS webhooks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  name         TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL,
  -- Comma-separated: task.created, task.updated, comment.created, page.updated.
  events       TEXT NOT NULL DEFAULT 'task.created,task.updated',
  -- Signs the body so the receiver can tell it came from here.
  secret       TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- 'out' posts to somebody else; 'in' gives another service a URL to post to.
  direction    TEXT NOT NULL DEFAULT 'out',
  -- The message shape: 'kolibri' is the signed JSON; 'slack' and 'discord' are
  -- what those two will actually render.
  format       TEXT NOT NULL DEFAULT 'kolibri',
  created_by   TEXT,
  last_status  INTEGER,
  last_error   TEXT,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS webhooks_seq ON webhooks (workspace_id, seq);

CREATE TABLE IF NOT EXISTS reminders (
  marker     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (marker, user_id)
);

CREATE TABLE IF NOT EXISTS automations (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  project_id         TEXT,
  name               TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  trigger_kind       TEXT NOT NULL DEFAULT 'state_entered',
  trigger_state_id   TEXT,
  trigger_group      TEXT,
  -- For `due_in`: how many days before the due date it fires.
  trigger_days       INTEGER NOT NULL DEFAULT 1,
  -- What it does: file a template, or set fields on the task that triggered it.
  action_kind        TEXT NOT NULL DEFAULT 'file_template',
  -- For `set_fields`: a JSON patch, e.g. {"priority":"urgent"}.
  action_patch       TEXT NOT NULL DEFAULT '{}',
  -- `template_id` is only required for `file_template`.
  template_id        TEXT NOT NULL DEFAULT '',
  recipients         TEXT NOT NULL DEFAULT '[]',
  fan_out            TEXT NOT NULL DEFAULT 'single',
  exclude_actor      INTEGER NOT NULL DEFAULT 1,
  link_kind          TEXT NOT NULL DEFAULT 'relates_to',
  apply_to_generated INTEGER NOT NULL DEFAULT 0,
  once               INTEGER NOT NULL DEFAULT 0,
  -- The last day a `due_in` rule swept, so a restart does not re-fire it.
  last_run_day       TEXT,
  sort_order         TEXT NOT NULL DEFAULT 'V',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  seq                INTEGER NOT NULL DEFAULT 0,
  clocks             TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS automations_seq ON automations (workspace_id, seq);

-- What a rule actually did, including when it decided to do nothing. Server-side
-- bookkeeping: not synced, but readable so a rule that never fires is not a
-- mystery. `skipped` holds the reason, empty when a task was created.
CREATE TABLE IF NOT EXISTS automation_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  automation_id   TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  created_task_id TEXT,
  actor_id        TEXT,
  skipped         TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_runs_rule ON automation_runs (automation_id, created_at);
CREATE INDEX IF NOT EXISTS automation_runs_task ON automation_runs (task_id);
CREATE INDEX IF NOT EXISTS automation_runs_created ON automation_runs (created_task_id);

CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  task_id      TEXT,
  page_id      TEXT,
  -- Where to go when the notification is not about one task or one page. A
  -- report from outside is about a project's queue, not a row.
  project_id   TEXT,
  actor_id     TEXT,
  read_at      INTEGER,
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, seq);

-- A tombstone that was itself thrown away. Emptying the trash removes the row
-- and leaves one of these, because a device holding the tombstone would
-- otherwise keep it in its own trash and be able to put it back.
-- Something reported from outside the workspace. Deliberately not a task:
-- letting an anonymous form write into the backlog points a stranger's keyboard
-- at the thing the team reads every morning. It becomes a task when somebody
-- accepts it.
CREATE TABLE IF NOT EXISTS intakes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  share_id     TEXT,
  reporter     TEXT,
  email        TEXT,
  title        TEXT NOT NULL,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  task_id      TEXT,
  handled_by   TEXT,
  handled_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_intakes_workspace ON intakes(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_intakes_project ON intakes(project_id, status);

CREATE TABLE IF NOT EXISTS purges (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity       TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT 'manual',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_purges_workspace ON purges(workspace_id, seq);

CREATE TABLE IF NOT EXISTS activities (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  task_id      TEXT,
  page_id      TEXT,
  actor_id     TEXT,
  verb         TEXT NOT NULL,
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS activities_seq ON activities (workspace_id, seq);
CREATE INDEX IF NOT EXISTS activities_task ON activities (task_id, created_at);

CREATE TABLE IF NOT EXISTS applied_mutations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  applied_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS applied_mutations_at ON applied_mutations (applied_at);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5 (
  kind UNINDEXED,
  ref_id UNINDEXED,
  workspace_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Content-addressed blob store. Uploading the same image twice costs one row.
CREATE TABLE IF NOT EXISTS files (
  hash         TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_workspace ON files (workspace_id);

-- Outgoing mail. Queued rather than sent inline so a slow or broken relay can
-- never block a request, and a failed send can be retried with backoff.
-- Devices that asked to be woken. A subscription is a URL the push service
-- gave the browser; it is not a secret of ours, and it is thrown away the
-- moment that service says it is gone.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT,
  auth         TEXT,
  failures     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

-- Addresses that must not be written to again: a hard bounce or a complaint.
-- Keyed by address rather than by user, because an invite goes to somebody who
-- has no account yet and bounces just the same.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'bounce',
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_queue (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  workspace_id TEXT,
  to_email     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  body_html    TEXT,
  headers      TEXT NOT NULL DEFAULT '{}',
  kind         TEXT NOT NULL DEFAULT 'notification',
  send_after   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  sent_at      INTEGER,
  failed_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_queue_pending ON email_queue (sent_at, failed_at, send_after);

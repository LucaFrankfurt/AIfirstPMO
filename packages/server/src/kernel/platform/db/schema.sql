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
  -- Telegram. `telegram_chat_id` is set once the person has started the bot
  -- themselves; until then there is nowhere to send to and the channel is off
  -- regardless of the preference.
  telegram_chat_id TEXT,
  telegram_prefs TEXT NOT NULL DEFAULT 'all',
  -- The secret in a calendar feed URL. Null until somebody asks for the URL,
  -- because a subscribable link that exists before anybody wanted one is a
  -- link that can leak before anybody knew it was there. Revoking is writing
  -- a new one; the old URL then answers 404 like any other wrong token.
  calendar_token TEXT UNIQUE,
  telegram_linked_at INTEGER,
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

-- OAuth clients that registered themselves (RFC 7591).
--
-- Registration is open, and it has to be: a remote assistant has no way to
-- exist here before somebody pastes this instance's URL into it, and there is
-- no admin standing by to approve an app nobody has heard of yet. Registering
-- grants nothing — a client is a name and a set of redirect URIs. What grants
-- anything is a person signing in and pressing Allow, which is the step this
-- whole table exists to lead up to.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  uri           TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- One authorization code, in flight. Single use and short-lived: it is handed
-- back through a browser redirect, which means through the address bar, the
-- history and possibly a referrer header.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash    TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  workspace_id TEXT,
  redirect_uri TEXT NOT NULL,
  -- PKCE, S256 only. A public client cannot keep a secret, so the proof that
  -- the caller redeeming the code is the one that asked for it is this.
  challenge    TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'read,write',
  resource     TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

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
  -- A project that only holds other projects: no board, no task button, and
  -- out of every "which project?" picker. See `Project.is_container`.
  is_container     INTEGER NOT NULL DEFAULT 0,
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


-- A field a project adds to its tasks. Every task in the project is asked; the
-- questions belong to the project, not to a kind of task.
CREATE TABLE IF NOT EXISTS custom_fields (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'text',
  options       TEXT NOT NULL DEFAULT '[]',
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

-- ---------------------------------------------------------------- budgets --
--
-- Every amount below is an INTEGER of minor units — 1250 is €12.50 — and never
-- a REAL. SQLite would store a float happily and the error would not show up
-- until a column of them was added two different ways and came out a cent
-- apart, months later, in front of somebody's finance team. See `Minor` in
-- `@kolibri/shared`.

-- An envelope of money over a period. Scoped exactly as a cycle is: an owner
-- and an empty list is that project's own; no owner and an empty list is the
-- whole workspace; a list is exactly those projects. See `coversProject`.
CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  projects     TEXT NOT NULL DEFAULT '[]',
  name         TEXT NOT NULL,
  description  TEXT,
  -- ISO 4217. One per budget, and nothing anywhere converts between two: a
  -- rate is a fact about a day, and a report that quietly picks today's to add
  -- up last year's is worse than one that shows two totals.
  currency     TEXT NOT NULL DEFAULT 'EUR',
  -- What was signed off. 0 means nobody has, which is different from an
  -- approved budget of nothing.
  approved     INTEGER NOT NULL DEFAULT 0,
  period_start TEXT,
  period_end   TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',
  owner_id     TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS budgets_seq ON budgets (workspace_id, seq);
CREATE INDEX IF NOT EXISTS budgets_project ON budgets (project_id);

-- One planned cost. The plan is the sum of these; no total is stored anywhere,
-- because a stored total is stale the moment somebody edits a line offline.
CREATE TABLE IF NOT EXISTS budget_lines (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  budget_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'other',
  kind         TEXT NOT NULL DEFAULT 'opex',
  -- Per occurrence, not for the window. Twelve months of hosting is one row
  -- with `recurrence = 'monthly'`, not twelve rows somebody has to keep aligned.
  amount       INTEGER NOT NULL DEFAULT 0,
  recurrence   TEXT NOT NULL DEFAULT 'once',
  starts_on    TEXT,
  ends_on      TEXT,
  vendor       TEXT,
  confidence   TEXT NOT NULL DEFAULT 'likely',
  -- `[{project_id, share}]`, shares in basis points summing to 10000. Empty is
  -- unallocated, which is a real state and not a mistake.
  allocations  TEXT NOT NULL DEFAULT '[]',
  note         TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS budget_lines_seq ON budget_lines (workspace_id, seq);
CREATE INDEX IF NOT EXISTS budget_lines_budget ON budget_lines (budget_id);

-- Money that actually moved. `line_id` is nullable on purpose: an invoice
-- nobody planned for is the most interesting row in the system, and a model
-- that forced every actual to name a plan line would have people filing it
-- under whichever line was closest.
CREATE TABLE IF NOT EXISTS budget_actuals (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  budget_id    TEXT NOT NULL,
  line_id      TEXT,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'other',
  amount       INTEGER NOT NULL DEFAULT 0,
  spent_on     TEXT NOT NULL,
  -- committed | invoiced | paid. Committed is the one that ruins a month: a
  -- purchase order is money already gone, and a report counting only paid
  -- invoices says a budget is healthy right up until they arrive.
  stage        TEXT NOT NULL DEFAULT 'paid',
  vendor       TEXT,
  reference    TEXT,
  -- Empty inherits the line's split. See `allocationsFor`.
  allocations  TEXT NOT NULL DEFAULT '[]',
  note         TEXT,
  recorded_by  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS budget_actuals_seq ON budget_actuals (workspace_id, seq);
CREATE INDEX IF NOT EXISTS budget_actuals_budget ON budget_actuals (budget_id, spent_on);
CREATE INDEX IF NOT EXISTS budget_actuals_line ON budget_actuals (line_id);

-- A what-if. Never edits a line: it is a list of adjustments applied on the way
-- to a total, so the plan the team is working to survives the meeting.
CREATE TABLE IF NOT EXISTS budget_scenarios (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  budget_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  adjustments  TEXT NOT NULL DEFAULT '[]',
  -- How much of an unsigned cost this scenario carries, per confidence level,
  -- in basis points. Null is "all of it" — the plan as written.
  weights      TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS budget_scenarios_seq ON budget_scenarios (workspace_id, seq);
CREATE INDEX IF NOT EXISTS budget_scenarios_budget ON budget_scenarios (budget_id);

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
  -- Whether strangers may leave a note. Off by default: an unauthenticated
  -- write is something somebody opts into.
  allow_comments INTEGER NOT NULL DEFAULT 0,
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
  -- Null means this cycle is not one project's. Together with `projects` it
  -- says which projects run it: an owner and an empty list is that project's
  -- own cycle; no owner and an empty list is every project; a list is exactly
  -- those. See `cycleCovers` in `@kolibri/shared`.
  project_id   TEXT,
  -- Empty means *every* project, not none — the same rule `channels.members`
  -- follows, and for the same reason: writing every project into every shared
  -- cycle would mean keeping that list correct forever, for no gain.
  projects     TEXT NOT NULL DEFAULT '[]',
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
  -- Null means this module is not one project's. Together with `projects` it
  -- says which run it: an owner and an empty list is that project's own; no
  -- owner and an empty list is every project; a list is exactly those. The
  -- same three states a cycle has, answered by the same `coversProject`.
  project_id   TEXT,
  -- Empty means *every* project, not none. See the note on `cycles.projects`.
  projects     TEXT NOT NULL DEFAULT '[]',
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

-- A number somebody has undertaken to watch.
--
-- Not a query over the rows in this database: the figures a PMO reports on —
-- uptime, churn, NPS, lead time out of a system that is not this one — are
-- typed in or posted over MCP, and a KPI feature that could only measure what
-- happened to be stored here would cover almost none of them. So this is the
-- definition, and the measurements and targets are rows against it.
CREATE TABLE IF NOT EXISTS kpis (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- Scoped exactly as a cycle, a module and a budget are. See `coversProject`.
  project_id   TEXT,
  projects     TEXT NOT NULL DEFAULT '[]',
  name         TEXT NOT NULL,
  description  TEXT,
  -- How to render it, not what it means. There is no `currency` member: money
  -- already has a system in here, and a second half-built one whose totals
  -- cannot be added to the first is worse than a link to a budget.
  unit         TEXT NOT NULL DEFAULT 'number',
  unit_label   TEXT,
  -- Where the decimal point goes. Values are integers scaled by 10^decimals,
  -- for the reason money is minor units: 99.95 as a float, averaged over twelve
  -- readings, is not 99.95, and this figure gets compared against a target.
  decimals     INTEGER NOT NULL DEFAULT 0,
  -- 'up' or 'down'. A band needs a second bound on every target and is written
  -- down as a limit rather than half-built; see docs/kpi.md.
  direction    TEXT NOT NULL DEFAULT 'up',
  -- Where it stood before anybody started, if that is known. NULL is honest and
  -- common: most KPIs are defined halfway through, and progress then runs from
  -- the first reading instead.
  baseline     INTEGER,
  -- How often somebody has undertaken to measure it. This is what makes
  -- staleness answerable, which is the one thing a KPI cannot say for itself.
  cadence      TEXT NOT NULL DEFAULT 'monthly',
  owner_id     TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS kpis_seq ON kpis (workspace_id, seq);
CREATE INDEX IF NOT EXISTS kpis_project ON kpis (project_id);

-- What it has to reach, and by when. Its own row because a target is rarely one
-- number: "85% by June, 90% by December" is the ordinary case.
CREATE TABLE IF NOT EXISTS kpi_targets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kpi_id       TEXT NOT NULL,
  -- The milestone it is due by. A link rather than a copied date on purpose:
  -- the sentence was "90% by the time we ship", so a milestone that slips drags
  -- its targets with it. Copying the date would turn every slip into a miss.
  module_id    TEXT,
  due_on       TEXT,
  value        INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS kpi_targets_seq ON kpi_targets (workspace_id, seq);
CREATE INDEX IF NOT EXISTS kpi_targets_kpi ON kpi_targets (kpi_id);
CREATE INDEX IF NOT EXISTS kpi_targets_module ON kpi_targets (module_id);

-- One measurement. `source` is where the number came from, and saying so is
-- most of what makes a KPI worth arguing with.
CREATE TABLE IF NOT EXISTS kpi_readings (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kpi_id       TEXT NOT NULL,
  measured_on  TEXT NOT NULL,
  value        INTEGER NOT NULL DEFAULT 0,
  source       TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS kpi_readings_seq ON kpi_readings (workspace_id, seq);
CREATE INDEX IF NOT EXISTS kpi_readings_kpi ON kpi_readings (kpi_id, measured_on);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  number       INTEGER NOT NULL DEFAULT 0,
  identifier   TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT,
  state_id     TEXT,
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
  -- Working days of breathing room on a `blocks` link. Never negative.
  lag             INTEGER NOT NULL DEFAULT 0,
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
  -- What the page says. Derived from `body` when there is one, so that search,
  -- export, sharing and the API all carry on reading plain text.
  content      TEXT NOT NULL DEFAULT '',
  -- The same text as a CRDT. Merged rather than replaced on write, which is
  -- what makes two people typing at once a merge instead of a race.
  body         TEXT,
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
  -- Who said it, when nobody here said it: a name typed into a public share
  -- link's comment box. Never verified, and shown as unverified.
  guest_name   TEXT,
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

-- What an hour is worth, from a day. Amounts are INTEGER minor units, as
-- everywhere money is stored here.
--
-- Never edited in place: raising a rate is inserting a row with a later
-- `starts_on`, so what last quarter cost stays what last quarter cost. There is
-- no end date — the next row's start is the end.
--
-- The one table here that does not reach every member. A rate is close enough
-- to somebody's pay that it goes to owners and admins only, and so does
-- everything computed from it: a total is a rate anybody can divide back out.
CREATE TABLE IF NOT EXISTS rates (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- Null is anybody's; null project is everywhere. Most specific wins — see
  -- `resolveRate` in @kolibri/shared.
  user_id      TEXT,
  project_id   TEXT,
  -- cost | billable. What the hour costs, and what it is charged at.
  kind         TEXT NOT NULL DEFAULT 'cost',
  amount       INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  starts_on    TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS rates_seq ON rates (workspace_id, seq);
CREATE INDEX IF NOT EXISTS rates_lookup ON rates (workspace_id, kind, starts_on);

-- ------------------------------------------------------------ landscape --
--
-- The estate: who you buy from, what runs where, and the documented steps from
-- one shape of it to the next.
--
-- There is deliberately no "landscape" table. Which components make up the
-- estate on a given day falls out of `live_from` and `live_until`, so current
-- and future are the same query with two dates rather than two sets of rows
-- somebody has to keep in step by hand. See `landscape.ts`.

CREATE TABLE IF NOT EXISTS vendors (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'other',
  website        TEXT,
  contact        TEXT,
  contract_start TEXT,
  contract_end   TEXT,
  -- Days of notice before `contract_end`. Its own column because it is the one
  -- thing about a contract with a deadline attached — the day you stop being
  -- able to leave — and nothing can compute that from a note.
  notice_days    INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  seq            INTEGER NOT NULL DEFAULT 0,
  clocks         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS vendors_seq ON vendors (workspace_id, seq);

-- One thing in the estate. `parent_id` nests it: a machine holds its instances,
-- an account holds its seats. Amounts are INTEGER minor units, as everywhere.
CREATE TABLE IF NOT EXISTS components (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  vendor_id    TEXT,
  parent_id    TEXT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'server',
  environment  TEXT NOT NULL DEFAULT 'production',
  -- A label. The dates below are what actually decide whether this is in the
  -- landscape on a day; this answers only where a date is missing.
  status       TEXT NOT NULL DEFAULT 'live',
  live_from    TEXT,
  live_until   TEXT,
  location     TEXT,
  reference    TEXT,
  -- Per occurrence, speaking the same vocabulary a budget line does, so the two
  -- figures can be compared without one of them being converted first.
  amount       INTEGER NOT NULL DEFAULT 0,
  recurrence   TEXT NOT NULL DEFAULT 'monthly',
  currency     TEXT NOT NULL DEFAULT 'EUR',
  -- The plan line this is charged to. Null is a cost nobody has budgeted.
  line_id      TEXT,
  owner_id     TEXT,
  -- Projects that depend on this. A dependency, not a cost split — the split
  -- lives on the budget line.
  projects     TEXT NOT NULL DEFAULT '[]',
  note         TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS components_seq ON components (workspace_id, seq);
CREATE INDEX IF NOT EXISTS components_vendor ON components (vendor_id);
CREATE INDEX IF NOT EXISTS components_parent ON components (parent_id);
CREATE INDEX IF NOT EXISTS components_line ON components (line_id);

-- A documented step from one landscape to the next: what goes, what arrives.
-- Two lists rather than prose, so the same thing that makes it readable makes
-- it checkable against the register — see `moveProgress`.
CREATE TABLE IF NOT EXISTS moves (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'proposed',
  leaving      TEXT NOT NULL DEFAULT '[]',
  arriving     TEXT NOT NULL DEFAULT '[]',
  target_date  TEXT,
  owner_id     TEXT,
  project_id   TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS moves_seq ON moves (workspace_id, seq);

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
  -- Comma-separated. The list of names is `WEBHOOK_EVENTS` in @kolibri/shared,
  -- which is where the screen offering the checkboxes reads it from too.
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
  -- Null when the row belongs to no workspace at all. That is a direct
  -- conversation and everything about it: two people may share no workspace,
  -- or several, and filing their conversation under one of them would make it
  -- vanish when either switched. See `crossWorkspace` in the entity registry.
  workspace_id TEXT,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  task_id      TEXT,
  page_id      TEXT,
  -- Where to go when the notification is not about one task or one page. A
  -- report from outside is about a project's queue, not a row; a message is
  -- about a conversation.
  project_id   TEXT,
  channel_id   TEXT,
  actor_id     TEXT,
  read_at      INTEGER,
  archived_at  INTEGER,
  -- Telegram delivery, tracked on the notification rather than in a second
  -- queue: the row already exists, already belongs to one recipient, and is
  -- the thing being delivered. `telegram_sent_at` null with attempts below the
  -- limit is what the retry sweep looks for.
  telegram_sent_at INTEGER,
  telegram_attempts INTEGER NOT NULL DEFAULT 0,
  telegram_error TEXT,
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

-- Conversations. A named channel, or the direct one between two people.
--
-- A direct channel's id is derived from its members (`dm.<a>.<b>`, sorted), so
-- two people opening a conversation with each other while both are offline end
-- up in one conversation rather than two holding half the history each. See
-- packages/shared/src/chat.ts.
--
-- `members` empty means the workspace rather than nobody: an open channel is
-- open, and the alternative is writing every member into every channel and then
-- keeping that list right as people join and leave.
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  -- Null when the row belongs to no workspace at all. That is a direct
  -- conversation and everything about it: two people may share no workspace,
  -- or several, and filing their conversation under one of them would make it
  -- vanish when either switched. See `crossWorkspace` in the entity registry.
  workspace_id TEXT,
  -- A channel can belong to a project, and then it is only visible to people
  -- who can see that project. Null is a workspace-wide channel.
  project_id   TEXT,
  kind         TEXT NOT NULL DEFAULT 'channel',
  name         TEXT NOT NULL DEFAULT '',
  topic        TEXT,
  is_private   INTEGER NOT NULL DEFAULT 0,
  members      TEXT NOT NULL DEFAULT '[]',
  -- Who may add and remove people here: 'members' (anybody already in it) or
  -- 'admins' (whoever opened it, plus a workspace owner or admin). Per channel
  -- rather than per instance, because a team channel and a channel a client
  -- can see want different answers and both exist in the same workspace.
  invite_policy TEXT NOT NULL DEFAULT 'members',
  archived_at  INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS channels_seq ON channels (workspace_id, seq);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  -- Null when the row belongs to no workspace at all. That is a direct
  -- conversation and everything about it: two people may share no workspace,
  -- or several, and filing their conversation under one of them would make it
  -- vanish when either switched. See `crossWorkspace` in the entity registry.
  workspace_id TEXT,
  channel_id   TEXT NOT NULL,
  author_id    TEXT,
  body         TEXT NOT NULL DEFAULT '',
  -- The message this one answers, for a short thread inside the stream. Not a
  -- separate thread view: a conversation that needs one is a page.
  reply_to     TEXT,
  -- { "👍": [userId, …] }, the same shape comments have used since the first
  -- release. Counting is the point; who reacted is a tooltip.
  reactions    TEXT NOT NULL DEFAULT '{}',
  edited_at    INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_seq ON messages (workspace_id, seq);
CREATE INDEX IF NOT EXISTS messages_channel ON messages (channel_id, created_at);

-- How far one person has read one conversation, and what they want told to
-- them about it. Private: where somebody has got to is nobody else's business,
-- and a read receipt is deliberately not a feature here.
--
-- The id is `<channel>::<user>` so two devices marking the same conversation
-- read converge on one row instead of racing to create two.
CREATE TABLE IF NOT EXISTS channel_reads (
  id           TEXT PRIMARY KEY,
  -- Null when the row belongs to no workspace at all. That is a direct
  -- conversation and everything about it: two people may share no workspace,
  -- or several, and filing their conversation under one of them would make it
  -- vanish when either switched. See `crossWorkspace` in the entity registry.
  workspace_id TEXT,
  channel_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  -- 'all' | 'mentions' | 'none'. The default is 'mentions' for a channel and
  -- 'all' for a direct conversation — being written to directly is the case
  -- where silence would be wrong.
  notify       TEXT NOT NULL DEFAULT 'mentions',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS channel_reads_seq ON channel_reads (workspace_id, seq);
CREATE INDEX IF NOT EXISTS channel_reads_user ON channel_reads (user_id, channel_id);

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
-- One blob, one row per workspace that holds it.
--
-- Uploads are content-addressed, so two workspaces sending identical bytes
-- share the stored object. They must not share the *row*: it carries the
-- workspace, and with `hash` alone as the key the second uploader got no row
-- at all — and then a 403 reading back the file they had just sent.
CREATE TABLE IF NOT EXISTS files (
  hash         TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (hash, workspace_id)
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

-- One call out, and what became of it.
--
-- The webhook row used to carry one slot — the last status, the last error —
-- which answers "is this endpoint alive" and nothing else. A workflow that
-- files an invoice needs the other question answered: did *that* event arrive.
--
-- So a delivery is a row, in the shape `email_queue` already proved: due when
-- `send_after` passes, finished when `sent_at` or `failed_at` is stamped. The
-- body is stored rather than rebuilt, because a replay has to be the same call
-- — a body rebuilt an hour later would carry the task as it is now, signed as
-- though it were what happened then.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  webhook_id   TEXT NOT NULL,
  event        TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  send_after   INTEGER NOT NULL,
  sent_at      INTEGER,
  failed_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries (sent_at, failed_at, send_after);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);

-- One-time codes that connect a Kolibri account to a Telegram chat.
--
-- The account holder starts the conversation from their own Telegram, which is
-- the only way round that works: the server cannot message a chat it has never
-- heard of, and asking somebody to paste a numeric chat id is asking them to
-- find something Telegram does not show. So Kolibri hands out a code, the
-- person taps a link that sends `/start <code>` to the bot, and the update
-- carries the chat id with it.
--
-- Short-lived and single-use. A code that survived would be a way to point
-- somebody else's notifications at your own chat.
CREATE TABLE IF NOT EXISTS telegram_links (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_links_user ON telegram_links (user_id);

-- Where the long poll got to. One row, id 1: `getUpdates` is a cursor, and
-- losing it would replay every update the bot ever received.
CREATE TABLE IF NOT EXISTS telegram_cursor (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  offset    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Settings an admin typed into the app, which win over the environment.
--
-- The key is the environment variable's own name — `KOLIBRI_SMTP_HOST` and the
-- rest — because there is no second vocabulary to learn and the documentation
-- already names them. A row here is an override; deleting it hands the setting
-- back to whatever the container was started with.
--
-- `secret` marks a value that is stored sealed rather than in the clear: an
-- SMTP password, a bot token, a model key. The seal is AES-256-GCM under a key
-- derived from the instance secret, which lives in a file next to this
-- database rather than inside it — so a stolen database alone is not a stolen
-- relay. See `lib/settings.ts`.
CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  secret     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- A mail account this workspace has connected. Syncable, so the settings
-- screen and the client's mailbox list come down the same pull as everything
-- else — but note what is *not* here: the password. That lives in
-- `mailbox_credentials`, sealed, and is never selected into a sync feed.
CREATE TABLE IF NOT EXISTS mailboxes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  address      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL DEFAULT '',
  port         INTEGER NOT NULL DEFAULT 993,
  encryption   TEXT NOT NULL DEFAULT 'tls',
  username     TEXT NOT NULL DEFAULT '',
  -- Which folders to read. Empty means INBOX alone, which is what almost every
  -- shared inbox wants: Sent and Archive double the storage and are usually
  -- the same conversations seen from the other end.
  folders      TEXT NOT NULL DEFAULT '[]',
  -- 'workspace' or 'members'. See `canReadMailbox`, which is the one place the
  -- question is answered, and note that an empty `members` list on a
  -- restricted mailbox means nobody rather than everybody.
  access       TEXT NOT NULL DEFAULT 'workspace',
  members      TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- How far back the first pass reaches. 0 is everything, which on a ten-year
  -- inbox is a long first night and exactly what somebody hunting for old tax
  -- documents asked for.
  sync_days    INTEGER NOT NULL DEFAULT 365,
  created_by   TEXT,
  last_sync_at INTEGER,
  last_error   TEXT,
  last_status  TEXT NOT NULL DEFAULT 'never',
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS mailboxes_seq ON mailboxes (workspace_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_address ON mailboxes (workspace_id, address) WHERE deleted_at IS NULL;

-- The password, in its own table and sealed.
--
-- Its own table rather than a column on `mailboxes` because of what the sync
-- feed does: it selects whole rows. `serialize` drops `secret` fields on the
-- way out and that is a real guard, but it is one line standing between a
-- credential and every device in the workspace, and the credential is for
-- somebody else's mail server. A column that is never selected is a stronger
-- statement than a column that is selected and then deleted — and the day a
-- new read path forgets, this one has nothing to forget.
--
-- The seal is the same one `instance_settings` uses: AES-256-GCM under a key
-- derived from the instance secret, which lives beside the database rather
-- than inside it, so a copied backup is not a copied inbox.
CREATE TABLE IF NOT EXISTS mailbox_credentials (
  mailbox_id TEXT PRIMARY KEY,
  secret     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- One message, as it was found in a mailbox.
--
-- Not an entity, and the reason is worth stating where the rows are: a mailbox
-- has tens of thousands of these, and syncing them into every device's mirror
-- to make an assistant's search work would be the largest storage cost in the
-- product paid for the one reader that is not a browser. They are read over the
-- API and MCP, both of which check `canReadMailbox` first.
--
-- `uid` is the mailbox's own number for the message within a folder, and
-- `(mailbox_id, folder, uid)` is what makes a re-poll idempotent: IMAP promises
-- a UID is stable and never reused while `uidvalidity` holds, so the poller
-- fetches "everything above the highest UID I have" and a restart mid-fetch
-- costs a duplicate of nothing.
CREATE TABLE IF NOT EXISTS mail_messages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mailbox_id   TEXT NOT NULL,
  folder       TEXT NOT NULL DEFAULT 'INBOX',
  uid          INTEGER NOT NULL,
  -- The `Message-ID` header. Not unique here on purpose: the same message
  -- arrives in `support@` and in `info@` when somebody was in Cc, and both
  -- copies are real — a search for it should say it went to both.
  message_id   TEXT NOT NULL DEFAULT '',
  -- What ties a reply to what it answers: the first id in `References`, or the
  -- message's own when it started the conversation.
  thread_key   TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  from_name    TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT '',
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  sent_at      INTEGER NOT NULL,
  seen         INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size         INTEGER NOT NULL DEFAULT 0,
  -- The first couple of hundred characters, so a result list needs no second
  -- query and a hundred hits do not drag a hundred bodies into memory.
  snippet      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  fetched_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_uid ON mail_messages (mailbox_id, folder, uid);
CREATE INDEX IF NOT EXISTS mail_messages_sent ON mail_messages (mailbox_id, sent_at);
CREATE INDEX IF NOT EXISTS mail_messages_from ON mail_messages (workspace_id, from_address);
CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages (workspace_id, thread_key);

-- What was attached, without the bytes.
--
-- The bytes are fetched from the mail server on demand rather than copied here,
-- which is the one place this differs from how attachments on a task work. Two
-- reasons: a mailbox is somebody else's store and already holds them, and an
-- invoice PDF that has been copied into this database is a second copy to keep,
-- to back up and to delete on request. `part` is the MIME section number, which
-- is all IMAP needs to hand back one part of one message.
CREATE TABLE IF NOT EXISTS mail_attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  part       TEXT NOT NULL DEFAULT '1'
);
CREATE INDEX IF NOT EXISTS mail_attachments_message ON mail_attachments (message_id);
CREATE INDEX IF NOT EXISTS mail_attachments_name ON mail_attachments (mailbox_id, filename);

-- Mail has its own index rather than a corner of `search_index`.
--
-- Not a workaround for the visibility rule — that one is answered the same way
-- either side. It is that the two corpora want different queries: everything in
-- `search_index` is found by words, and mail is found by words *and* by who
-- sent it, when, and whether it had a PDF attached. Folding those filters into
-- a table whose other rows have no sender would mean four unindexed columns on
-- every task and page ever written.
--
-- The filename is indexed with the body, which is what makes the search this
-- exists for work at all: `Rechnung_2024_08.pdf` is a stronger claim about a
-- message than anything in its subject line.
CREATE VIRTUAL TABLE IF NOT EXISTS mail_index USING fts5 (
  message_id UNINDEXED,
  mailbox_id UNINDEXED,
  workspace_id UNINDEXED,
  subject,
  correspondents,
  body,
  filenames,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Every table as it was first created, and nothing it has gained since.
--
-- Generated and append-only: `npm run schema -- --fix` records a table this
-- file has never seen and never re-records one it has. Do not hand-edit — a
-- table rewritten here is a column that no longer has to be in the upgrade
-- list, which is the one thing this file exists to make impossible.
--
-- See scripts/schema.mjs.

CREATE TABLE activities (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  task_id      TEXT,
  page_id      TEXT,
  -- Which secret was read, set, rotated. The only entry kind that records a
  -- *read*: everything else here is a write, and for a credential the read is
  -- the event worth keeping.
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

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  workspace_id TEXT,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'read,write',
  -- Whether `workspace_id` above is a boundary or only a default. It has always
  -- been a default: a call naming another workspace is answered for that one,
  -- and the settings screen says so. Off keeps every token that predates this
  -- reaching exactly what it did; on cuts the membership map down to that one
  -- workspace, which is what every gate in the server reads.
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE applied_mutations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  applied_at   INTEGER NOT NULL
);

CREATE TABLE attachments (
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

CREATE TABLE automation_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  automation_id   TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  created_task_id TEXT,
  actor_id        TEXT,
  skipped         TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE TABLE automations (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  project_id         TEXT,
  name               TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  trigger_kind       TEXT NOT NULL DEFAULT 'state_entered',
  trigger_state_id   TEXT,
  trigger_group      TEXT,
  -- For `due_in`: how many days before the due date it fires.
  template_id        TEXT NOT NULL DEFAULT '',
  recipients         TEXT NOT NULL DEFAULT '[]',
  fan_out            TEXT NOT NULL DEFAULT 'single',
  exclude_actor      INTEGER NOT NULL DEFAULT 1,
  link_kind          TEXT NOT NULL DEFAULT 'relates_to',
  apply_to_generated INTEGER NOT NULL DEFAULT 0,
  once               INTEGER NOT NULL DEFAULT 0,
  -- The last day a `due_in` rule swept, so a restart does not re-fire it.
  sort_order         TEXT NOT NULL DEFAULT 'V',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  seq                INTEGER NOT NULL DEFAULT 0,
  clocks             TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE baselines (
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

CREATE TABLE budget_actuals (
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

CREATE TABLE budget_lines (
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

CREATE TABLE budget_scenarios (
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

CREATE TABLE budgets (
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

CREATE TABLE channel_reads (
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

CREATE TABLE channels (
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
  archived_at  INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE comments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id      TEXT,
  page_id      TEXT,
  parent_id    TEXT,
  body         TEXT NOT NULL DEFAULT '',
  author_id    TEXT,
  -- Who said it, when nobody here said it: a name typed into a public share
  -- link's comment box. Never verified, and shown as unverified.
  reactions    TEXT NOT NULL DEFAULT '{}',
  -- The passage a comment is about, when it was made on a selection: the quote
  -- plus its surroundings, so it can be found again after an edit.
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE components (
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

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE custom_fields (
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

CREATE TABLE cycles (
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

CREATE TABLE decision_options (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  decision_id  TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  description  TEXT,
  tally        INTEGER NOT NULL DEFAULT 0,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE decision_votes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  decision_id  TEXT NOT NULL,
  option_id    TEXT NOT NULL,
  voter_id     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE decisions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  task_id      TEXT,
  question     TEXT NOT NULL DEFAULT '',
  description  TEXT,
  mode         TEXT NOT NULL DEFAULT 'single',
  visibility   TEXT NOT NULL DEFAULT 'open',
  status       TEXT NOT NULL DEFAULT 'open',
  closes_at    INTEGER,
  created_by   TEXT,
  -- When the workspace was told this ballot exists. A marker rather than a date
  -- anybody reads: what it prevents is a second announcement when a third
  -- option is added. Null until the question is answerable — see `announce` in
  -- `notifications/effects.ts` for why it is not stamped on creation.
  voters       INTEGER NOT NULL DEFAULT 0,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE email_queue (
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

CREATE TABLE email_suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'bounce',
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE environments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT,
  -- 'member', 'admin' or 'owner'. 'member' is no restriction: a guest is
  -- refused the vault before this is ever asked.
  min_role     TEXT NOT NULL DEFAULT 'member',
  sort_order   TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE field_values (
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

CREATE TABLE files (
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

CREATE TABLE instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  secret     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE intakes (
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

CREATE TABLE invites (
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

CREATE TABLE kpi_readings (
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

CREATE TABLE kpi_targets (
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

CREATE TABLE kpis (
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

CREATE TABLE labels (
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

CREATE TABLE mail_attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  part       TEXT NOT NULL DEFAULT '1'
);

CREATE TABLE mail_messages (
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

CREATE TABLE mailbox_credentials (
  mailbox_id TEXT PRIMARY KEY,
  -- The long-lived credential, sealed: a password, or an OAuth refresh token.
  -- One column for both because they are the same thing to everything that
  -- touches this row — the secret that outlives a session and must never be
  -- read back out — and `kind` is what tells them apart where it matters.
  secret     TEXT NOT NULL,
  -- 'password' or 'oauth'.
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE mailboxes (
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

CREATE TABLE messages (
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
  edited_at    INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE modules (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- Null means this module is not one project's. Together with `projects` it
  -- says which run it: an owner and an empty list is that project's own; no
  -- owner and an empty list is every project; a list is exactly those. The
  -- same three states a cycle has, answered by the same `coversProject`.
  project_id   TEXT,
  -- Empty means *every* project, not none. See the note on `cycles.projects`.
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

CREATE TABLE moves (
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

CREATE TABLE notifications (
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
  actor_id     TEXT,
  read_at      INTEGER,
  archived_at  INTEGER,
  -- Telegram delivery, tracked on the notification rather than in a second
  -- queue: the row already exists, already belongs to one recipient, and is
  -- the thing being delivered. `telegram_sent_at` null with attempts below the
  -- limit is what the retry sweep looks for.
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  uri           TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE TABLE oauth_codes (
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

CREATE TABLE page_versions (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  title      TEXT NOT NULL,
  author_id  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE pages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  parent_id    TEXT,
  title        TEXT NOT NULL DEFAULT 'Untitled',
  icon         TEXT,
  -- What the page says. Derived from `body` when there is one, so that search,
  -- export, sharing and the API all carry on reading plain text.
  content      TEXT NOT NULL DEFAULT '',
  -- Which of the two languages `content` is in: 'markdown' or 'html'. Stored
  -- rather than sniffed, so a page cannot render one way here and the other way
  -- in the editor.
  sort_order   TEXT NOT NULL DEFAULT 'V',
  archived     INTEGER NOT NULL DEFAULT 0,
  access       TEXT NOT NULL DEFAULT 'workspace',
  created_by   TEXT,
  cover_url    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE project_members (
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

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  team_id          TEXT,
  -- A project under another one. Nesting is a way of reading the list, not a
  -- permission boundary: a sub-project keeps its own members and visibility.
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
  default_state_id TEXT,
  sort_order       TEXT NOT NULL DEFAULT 'V',
  next_number      INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  seq              INTEGER NOT NULL DEFAULT 0,
  clocks           TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE purges (
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

CREATE TABLE push_subscriptions (
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

CREATE TABLE rates (
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

CREATE TABLE reminders (
  marker     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (marker, user_id)
);

CREATE TABLE secrets (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  project_id        TEXT,
  name              TEXT NOT NULL,
  description       TEXT,
  kind              TEXT NOT NULL DEFAULT 'password',
  -- Sealed. Never selected into anything a client can see.
  value             TEXT NOT NULL DEFAULT '',
  -- 'workspace', 'project' or 'private' — the same three words a page uses.
  access            TEXT NOT NULL DEFAULT 'workspace',
  created_by        TEXT,
  -- 0 means nobody has undertaken to rotate it, which is a state and not a fault.
  rotate_after_days INTEGER NOT NULL DEFAULT 0,
  rotated_at        INTEGER,
  last_used_at      INTEGER,
  last_used_by      TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  seq               INTEGER NOT NULL DEFAULT 0,
  clocks            TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE shares (
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
  views        INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE states (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  group_key    TEXT NOT NULL DEFAULT 'backlog',
  color        TEXT NOT NULL DEFAULT '#94a3b8',
  sort_order   TEXT NOT NULL DEFAULT 'V',
  -- How many tasks may sit in this column at once; 0 means no limit.
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE task_relations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  related_task_id TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'relates_to',
  -- Working days of breathing room on a `blocks` link. Never negative.
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  seq             INTEGER NOT NULL DEFAULT 0,
  clocks          TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE tasks (
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

CREATE TABLE team_members (
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

CREATE TABLE teams (
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

CREATE TABLE telegram_cursor (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  offset    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE telegram_links (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE templates (
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

CREATE TABLE time_entries (
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

-- users.calendar_token: added by the upgrade list, but held by an
-- index or a constraint and so undroppable — recorded here as original.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  avatar_url    TEXT,
  timezone      TEXT,
  bio           TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER,
  calendar_token TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  seq           INTEGER NOT NULL DEFAULT 0,
  clocks        TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE vendors (
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

CREATE TABLE views (
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
  shared       INTEGER NOT NULL DEFAULT 1,
  owner_id     TEXT,
  sort_order   TEXT NOT NULL DEFAULT 'V',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE webhook_deliveries (
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

CREATE TABLE webhooks (
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
  last_status  INTEGER,
  last_error   TEXT,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0,
  clocks       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE workspace_members (
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

CREATE TABLE workspaces (
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

import type { EntityName } from './entities.ts';
import type { CrdtState } from '../../modules/pages/text-crdt.ts';
import type { HLC } from './hlc.ts';
import type { Anchor } from '../../modules/pages/anchor.ts';
import type { ChannelKind, ChannelNotify, InvitePolicy } from '../../modules/chat/chat.ts';

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

/* ----------------------------------------------------------------- budgets */

/**
 * What a planned cost *is*, in the words a finance report uses.
 *
 * Deliberately a fixed list rather than free text: the whole point of a
 * category is that two people writing down the same cost pick the same word,
 * and a text box guarantees they will not — "AWS", "aws", "Cloud" and
 * "Infrastruktur" are four rows in every chart that groups by it.
 *
 * `contingency` is here because a budget without one is a budget that will be
 * wrong, and a PMO that hides its buffer inside the other lines cannot answer
 * how much of it is left.
 */
export const COST_CATEGORIES = [
  'infrastructure', 'investment', 'people', 'licences', 'services',
  'travel', 'training', 'contingency', 'other',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/**
 * Money spent to run, or money spent to build.
 *
 * The one accounting distinction that changes who has to approve a line and
 * which report it lands in, so it is a field rather than something inferred
 * from the category — a server is infrastructure whether it is rented by the
 * month or bought outright, and only the team knows which they did.
 */
export const COST_KINDS = ['opex', 'capex'] as const;
export type CostKind = (typeof COST_KINDS)[number];

/**
 * How often a planned cost repeats inside its window.
 *
 * `once` is an amount; everything else is an amount *per period*, expanded
 * across the line's window when the plan is added up. This is what makes a
 * monthly hosting bill one row instead of twelve, and it is why the forecast
 * can say what is still to come rather than only what a spreadsheet totalled.
 */
export const COST_RECURRENCES = ['once', 'monthly', 'quarterly', 'yearly'] as const;
export type CostRecurrence = (typeof COST_RECURRENCES)[number];

/**
 * How sure the plan is that this money will be spent.
 *
 * A forecast that treats a signed contract and somebody's guess as the same
 * number is not a forecast. Committed is contracted; likely is expected and
 * unsigned; possible is on the list because leaving it off would be worse.
 * Nothing here is weighted automatically — a scenario decides what to do with
 * the three, because how much of a maybe to carry is a judgement, not a fact.
 */
export const COST_CONFIDENCE = ['committed', 'likely', 'possible'] as const;
export type CostConfidence = (typeof COST_CONFIDENCE)[number];

/**
 * How far real money has got.
 *
 * `committed` is the one people forget and the one that ruins a month: a
 * purchase order raised against next quarter's budget is money that is already
 * gone, and a report that counts only paid invoices says a budget is healthy
 * right up until the invoices arrive.
 */
export const SPEND_STAGES = ['committed', 'invoiced', 'paid'] as const;
export type SpendStage = (typeof SPEND_STAGES)[number];

export const BUDGET_STATUS = ['draft', 'active', 'closed'] as const;
export type BudgetStatus = (typeof BUDGET_STATUS)[number];

/* --------------------------------------------------------------------- KPI */

/**
 * How a measurement is rendered, and nothing else.
 *
 * Deliberately about *shape* rather than about meaning: `percent` puts a sign
 * after it, `duration` reads minutes as hours and minutes, `number` takes
 * whatever word the KPI supplies in `unit_label`. There is no `currency`
 * member, because money already has a system in here — an amount, a code, and
 * one currency per container — and a second half-built one whose totals cannot
 * be added to the first is worse than sending somebody to a budget.
 */
export const MEASURE_UNITS = ['number', 'percent', 'duration', 'score'] as const;
export type MeasureUnit = (typeof MEASURE_UNITS)[number];

/**
 * Which way is better.
 *
 * Two members and not three. A KPI that has to land inside a band — a stock
 * level, a response time with a floor as well as a ceiling — needs a second
 * bound on every target, and every screen would then carry a second figure for
 * the sake of a case that is rare here. `range` is written down as a limit
 * rather than half-built; see `docs/kpi.md`.
 */
export const MEASURE_DIRECTIONS = ['up', 'down'] as const;
export type MeasureDirection = (typeof MEASURE_DIRECTIONS)[number];

/**
 * How often somebody has undertaken to measure it.
 *
 * This exists to make staleness answerable. A KPI is the one kind of figure
 * that looks equally confident whether it was taken this morning or in March,
 * and "we are at 94%" from a reading nobody has refreshed in two quarters is
 * not a fact about today. Without a stated cadence there is no honest way to
 * say so, so every KPI carries one.
 */
export const MEASURE_CADENCES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;
export type MeasureCadence = (typeof MEASURE_CADENCES)[number];

/**
 * Where a KPI stands, under one rule used everywhere.
 *
 * Listed worst first, which is also the order the index sorts by and the order
 * a summary row reads in. The three that are not judgements sit in the middle
 * rather than at either end: `no_data`, `no_target` and `stale` are the states
 * a dashboard usually paints green by omission, and none of them is a crisis or
 * a success — nobody has measured it, nobody has said what it should be, or the
 * last measurement is too old to stand for today.
 */
export const MEASURE_HEALTH = ['off_track', 'at_risk', 'stale', 'no_target', 'no_data', 'on_track'] as const;
export type MeasureHealth = (typeof MEASURE_HEALTH)[number];

/**
 * A number somebody has undertaken to watch.
 *
 * Scoped exactly as a budget, a cycle and a module are, so `coversProject`
 * answers for this too. What it is *not* is a query over Kolibri's own rows:
 * the numbers a PMO actually reports on — uptime, churn, NPS, headcount, lead
 * time out of a system that is not this one — are typed in or posted over MCP,
 * and a KPI feature that could only measure what happened to be in this
 * database would cover almost none of them. So a KPI is a definition, and the
 * measurements are rows against it: the same shape as a budget, where the plan
 * and what actually happened are two lists that get compared.
 */
export interface Kpi extends Base {
  workspace_id: ID;
  /** The project that owns it, or null when it is shared. See `coversProject`. */
  project_id: ID | null;
  /** The projects it covers. Empty means *every* project, not none. */
  projects: ID[];
  name: string;
  description: string | null;
  unit: MeasureUnit;
  /** The word after the figure when `unit` is `number`. "Tickets", "customers". */
  unit_label: string | null;
  /**
   * Where the decimal point goes, for every value on this KPI and its targets.
   *
   * Values are integers scaled by `10 ** decimals`, for the reason money is:
   * 99.95 stored as a float and summed twice is not 99.95, and these figures
   * get averaged and compared against a target. `parseMeasure` and
   * `formatMeasure` are the only two places a decimal point exists.
   */
  decimals: number;
  direction: MeasureDirection;
  /**
   * Where it stood before anybody started, if that is known.
   *
   * Null is honest and common — most KPIs are defined halfway through. Progress
   * then runs from the first reading instead, and the screens say which.
   */
  baseline: number | null;
  cadence: MeasureCadence;
  owner_id: ID | null;
  archived: number;
  sort_order: string;
}

/**
 * What it has to reach, and by when.
 *
 * Its own row rather than a field on the KPI because a target is rarely one
 * number: "85% by June, 90% by December" is the ordinary case, and a single
 * column would make the June figure unrecoverable the moment somebody typed
 * the December one.
 *
 * `module_id` is the milestone link, and it is a link rather than a copied
 * date on purpose: a target tied to a milestone *moves with it*. A milestone
 * that slips a month drags its targets along, because the sentence was never
 * "90% by 30 June" — it was "90% by the time we ship".
 */
export interface KpiTarget extends Base {
  workspace_id: ID;
  kpi_id: ID;
  /** The milestone this is due by. When set, its date wins over `due_on`. */
  module_id: ID | null;
  due_on: ISODate | null;
  value: number;
  note: string | null;
  sort_order: string;
}

/** One measurement. `source` is where the number came from, and saying so is the point. */
export interface KpiReading extends Base {
  workspace_id: ID;
  kpi_id: ID;
  measured_on: ISODate;
  value: number;
  source: string | null;
  note: string | null;
}

/**
 * What an hour is worth, in the two senses a team needs at once.
 *
 * `cost` is what the hour costs the organisation; `billable` is what it is
 * charged at. Both, rather than one, because the interesting figure is the
 * difference and a single rate cannot produce it — and because a team that
 * bills nobody still wants to know what a project cost, while an agency needs
 * both columns on the same screen.
 */
export const RATE_KINDS = ['cost', 'billable'] as const;
export type RateKind = (typeof RATE_KINDS)[number];

/* ------------------------------------------------------------- landscape */

/** What sort of thing you buy from somebody. Only affects grouping and an icon. */
export const VENDOR_KINDS = ['cloud', 'saas', 'hosting', 'licence', 'service', 'other'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

/**
 * What a component *is*.
 *
 * `server` and `instance` are both here and both needed: a machine is a thing
 * you pay for and a thing that holds other things, and an instance running on
 * it is a thing you can move somewhere else without touching the machine. The
 * nesting is `parent_id`, so a cluster holding nodes holding databases is the
 * same shape as a project holding projects.
 */
export const COMPONENT_KINDS = [
  'server', 'instance', 'database', 'saas', 'service', 'storage', 'network', 'endpoint', 'other',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const ENVIRONMENTS = ['production', 'staging', 'development', 'shared'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Where a component is in its life.
 *
 * A label rather than the mechanism: which components make up the landscape on
 * a given day is decided by `live_from` and `live_until`, not by this. See
 * `livenessOn` — the two agree for anything with dates on it, and this is what
 * answers when the dates are missing.
 */
export const LIFECYCLES = ['planned', 'live', 'retiring', 'retired'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** How far a documented step between two landscapes has got. */
export const MOVE_STATUS = ['proposed', 'agreed', 'in_progress', 'done', 'abandoned'] as const;
export type MoveStatus = (typeof MOVE_STATUS)[number];

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

/**
 * What a workspace has switched on.
 *
 * Off by default, all of it. A feature that is on for everybody until they
 * find the switch is a feature that has already cluttered the screen of every
 * team that did not want it — and the ones who do want it are the ones who
 * will go looking.
 */
export interface WorkspaceFeatures {
  /**
   * Logging time on a task, the timer, and the totals that come with them.
   *
   * Off by default because estimates here are in points: until an estimate
   * carries a unit, "spent versus estimated" cannot be shown, and a team that
   * turns this on gets a number they cannot compare to anything. The data and
   * the API stay whatever the switch says — turning it off hides the feature,
   * it does not throw anything away.
   */
  time?: boolean;
  /**
   * Asking a model to review a task before anybody else has to read it.
   *
   * Two switches guard this rather than one, because it is the only feature
   * that sends a workspace's own words to somebody else's computer: the
   * operator supplies a key in the environment, and a workspace admin turns it
   * on here. Either one off means no button and no request.
   */
  ai?: boolean;
  /**
   * Budgets: what things cost, what was planned, and what has actually gone.
   *
   * Off by default like the rest, and for a reason of its own: money is the
   * one thing in here that everybody in a workspace can see the moment it
   * exists, and a team that has not decided to track it should not find a
   * half-filled budget screen in their sidebar. Switching it off hides the
   * screens and makes MCP refuse to write; the rows are untouched, so a
   * workspace that turns it back on finds its figures where it left them.
   */
  budget?: boolean;
  /**
   * The estate: vendors, what runs where, and the moves between one shape of it
   * and the next.
   *
   * Off by default like the rest. Independent of `budget` on purpose — an
   * estate is worth writing down whether or not anybody is costing it — and
   * the two only meet when both are on, where a component names the plan line
   * it is charged to.
   */
  infrastructure?: boolean;
  /**
   * KPIs: numbers somebody has undertaken to watch, and what they have to reach.
   *
   * Off by default like the rest. Independent of `budget` and `infrastructure`
   * — a team measuring lead time is not thereby costing servers — and the only
   * thing it borrows from elsewhere is the milestone: a target can be due by a
   * module, which every workspace already has.
   */
  kpi?: boolean;
  /**
   * Connected mailboxes: shared inboxes, searchable from one place and from an
   * assistant.
   *
   * Off by default, and this is the switch with the most behind it. Turning it
   * on means this instance holds a credential to somebody else's mail server
   * and a copy of what is in it — which is a decision about the company rather
   * than about a screen, and the only feature here where switching it off is
   * not enough to undo it. So the switch hides the screens and makes MCP refuse
   * to read, and the mailbox settings screen says in as many words that
   * disconnecting a mailbox is what removes the messages.
   */
  mail?: boolean;
}

export interface Workspace {
  id: ID;
  name: string;
  slug: string;
  logo_url: string | null;
  created_at: number;
  features?: WorkspaceFeatures;
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
  /** The project this one sits under. Nesting is for reading, not for access. */
  parent_id: ID | null;
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
  /**
   * A project that only holds other projects.
   *
   * A flag rather than a separate "folder" entity, because a folder would need
   * its own sync, permissions, trash, REST and MCP surface — and would make
   * every tree in the app ask whether a parent is a folder or a project. A
   * container is an ordinary project that has said it has no work of its own,
   * so it keeps all of that for free and can be turned back at any time.
   */
  is_container: number;
  archived: number;
  default_state_id: ID | null;
  /**
   * The saved view this project opens on. On the project rather than a flag on
   * the view, so that two people pinning two different views merge into one
   * answer instead of two rows both claiming to be the default.
   */
  default_view_id: ID | null;
  /**
   * Which weekdays this project works on, as `Date.getUTCDay()` numbers. On the
   * project rather than the workspace because a support rota and an office team
   * can genuinely disagree inside one company. Empty means every day counts.
   */
  working_days: number[] | null;
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
  /** How many tasks may sit here at once. 0 means no limit. */
  wip_limit: number;
  /**
   * Who may move a task *into* this column. Empty means anybody who can write.
   * Workspace roles, so "only a lead signs work off" is one entry.
   */
  allowed_roles: WorkspaceRole[];
}

/** What a share link points at. */
/**
 * `intake` is the odd one: every other share hands a stranger something to
 * *read*, and this one hands them a form to write into. It lives here anyway,
 * because it is the same idea — one link, scoped to one project, minted by the
 * server and revocable by deleting a row — and one place to reason about
 * anonymous access is worth more than a tidy noun.
 */
export const SHARE_KINDS = ['page', 'tasks', 'intake'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export interface Share extends Base {
  workspace_id: ID;
  project_id: ID | null;
  kind: ShareKind;
  page_id: ID | null;
  view_id: ID | null;
  name: string;
  /** Epoch millis, or null for a link that does not expire on its own. */
  expires_at: number | null;
  include_done: number;
  /**
   * Whether strangers may leave a note on a shared page. Off by default: an
   * unauthenticated write is a thing somebody opts into, not a default.
   */
  allow_comments: number;
  created_by: ID | null;
  /** Server-side only: the secret in the URL. */
  token?: string;
  views?: number;
  last_seen_at?: number | null;
}

/**
 * Something somebody outside the workspace reported.
 *
 * Deliberately *not* a task. Letting an anonymous form write straight into the
 * backlog points a stranger's keyboard at the thing the team looks at every
 * morning; a report becomes a task when a person says so, and until then it
 * sits in one queue that only people who asked for it are looking at.
 */
export interface Intake extends Base {
  workspace_id: ID;
  project_id: ID;
  share_id: ID | null;
  /** What the reporter typed about themselves. Neither is verified. */
  reporter: string | null;
  email: string | null;
  title: string;
  body: string | null;
  status: 'new' | 'accepted' | 'declined';
  /** The task it became, once somebody accepted it. */
  task_id: ID | null;
  handled_by: ID | null;
  handled_at: number | null;
}

/** Dates as they were when somebody said "this is the plan". */
export interface Baseline extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  taken_at: number;
  /** `taskId → [start, due]`, with `null` for a date the task did not have. */
  entries: Record<ID, [ISODate | null, ISODate | null]>;
}

export interface Field extends Base {
  workspace_id: ID;
  project_id: ID;
  name: string;
  kind: FieldKind;
  /** Choices, for the two select kinds. Ignored by every other kind. */
  options: string[];
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
  /**
   * Working days of breathing room, on a `blocks` link. Never negative — see
   * `schedule.ts`. Ignored on the other kinds, which say nothing about time.
   */
  lag: number;
}

export interface Cycle extends Base {
  workspace_id: ID;
  /** The project that owns it, or null when several run it. See `coversProject`. */
  project_id: ID | null;
  /** The projects that run it. Empty means *every* project, not none. */
  projects: ID[];
  name: string;
  description: string | null;
  start_date: ISODate | null;
  end_date: ISODate | null;
  status: string | null;
}

export interface Module extends Base {
  workspace_id: ID;
  /** The project that owns it, or null when several share it. See `coversProject`. */
  project_id: ID | null;
  /** The projects it covers. Empty means *every* project, not none. */
  projects: ID[];
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
  /**
   * What the page says. Derived from `body` whenever there is one, so that
   * everything reading a page — search, export, the share document, the
   * renderer, the API — carries on reading plain text.
   */
  content: string;
  /**
   * The same text as a CRDT, which is what makes two people typing at once a
   * merge rather than a race. Merged rather than replaced on write; see
   * `text-crdt.ts`. Null on a page nobody has edited since this existed.
   */
  body: CrdtState | null;
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
  /**
   * Who said it, when nobody here said it.
   *
   * Set only on a comment left through a public share link, where there is no
   * account behind it. Never verified, and shown as unverified everywhere: a
   * name in a box is a name in a box.
   */
  guest_name: string | null;
  reactions: Record<string, ID[]>;
  /**
   * The passage this comment is about, for a comment made on a selection.
   * A quote with its surroundings rather than an offset, because an offset is
   * wrong the moment somebody types a word above it. See `anchor.ts`.
   */
  anchor: Anchor | null;
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
  /**
   * Custom field answers: the field's id, then the answers that pass. Two
   * reserved tokens let a filter ask about a field with no list of options —
   * `''` is "nothing here" and `'*'` is "something here". See `fields.ts`.
   */
  field?: Record<ID, string[]>;
  text?: string;
  due?: 'overdue' | 'today' | 'week' | 'none';
  /**
   * The same questions, asked the other way round.
   *
   * `Filters` is otherwise a conjunction of "is one of", which cannot say
   * *not* — and "everything except the done column" is the second thing
   * anybody wants from a filter. A field named here excludes rather than
   * includes; for a field that holds a list (assignees, labels) a task is
   * excluded when **any** of its values is named.
   */
  not?: {
    state?: ID[];
    group?: StateGroup[];
    priority?: Priority[];
    assignee?: ID[];
    label?: ID[];
    cycle?: ID[];
    module?: ID[];
    project?: ID[];
  };
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

/* ----------------------------------------------------------------- budgets */

/**
 * Money is stored in **minor units as an integer**, everywhere, without
 * exception: 1250 in a budget whose currency is EUR is €12.50.
 *
 * Not a style preference. `0.1 + 0.2` is not `0.3` in any language with IEEE
 * doubles, and a budget is a column of numbers that get added up thousands of
 * times and then compared to another column that was added up differently. A
 * cent of drift is a report somebody has to reconcile by hand, and SQLite
 * would happily store the drift forever. Integers cannot drift.
 *
 * The conversion lives at the two edges — `parseMoney` reads what somebody
 * typed, `formatMoney` writes what they read — and nothing in between ever
 * sees a decimal point. See `budget.ts`.
 */
export type Minor = number;

/**
 * How much of a cost lands on which project.
 *
 * This is the difference between a budget tracker and a spreadsheet with a
 * project column. A Kubernetes cluster is not "for" one project; it is 60% the
 * platform rebuild and 40% everything else, and both of those numbers have to
 * appear in both projects' figures without the money being counted twice.
 *
 * `share` is in **basis points** — 10000 is the whole cost — for the same
 * reason the amount is in cents: three projects splitting a cost equally is
 * 3333 + 3333 + 3334, which is exact, whereas 1/3 three times is not. Shares
 * on one line must add up to 10000; the server normalises them if they do not,
 * because a cost that is 90% allocated is a cost 10% of which has silently
 * left the report.
 *
 * An empty list is not "nobody". It is *unallocated* — a real and common
 * state, and one worth showing rather than forcing somebody to invent an owner
 * for the office coffee machine on the day they enter it.
 */
export interface Allocation {
  project_id: ID;
  /** Basis points of the cost. The list sums to 10000. */
  share: number;
}

/**
 * An envelope of money over a period.
 *
 * Scoped exactly the way a cycle and a module are — `project_id` set is one
 * project's own, `project_id` null with an empty `projects` is the whole
 * workspace, `projects` non-empty is exactly those — so `coversProject` in
 * `scope.ts` answers for this too. That scope is about *who sees it*; the
 * per-line `allocations` are about whose figures it lands in, and the two are
 * deliberately different questions: a central infrastructure budget is
 * workspace-wide and still charges 40% of itself to one project.
 */
export interface Budget extends Base {
  workspace_id: ID;
  /** The project that owns it, or null when it is shared. See `coversProject`. */
  project_id: ID | null;
  /** The projects it covers. Empty means *every* project, not none. */
  projects: ID[];
  name: string;
  description: string | null;
  /**
   * ISO 4217, upper case. One currency per budget and no conversion anywhere:
   * a rate is a fact about a day, and a report that silently picks today's to
   * add up last year's is worse than one that declines to add them at all. Two
   * currencies in a portfolio are shown as two totals.
   */
  currency: string;
  /**
   * What was signed off, if anything. `0` means nobody has approved a number
   * and the plan is the only figure there is — which is honest, and different
   * from an approved budget of nothing.
   */
  approved: Minor;
  period_start: ISODate | null;
  period_end: ISODate | null;
  status: BudgetStatus;
  owner_id: ID | null;
  archived: number;
  sort_order: string;
}

/**
 * One planned cost. The plan is the sum of these; nothing stores a total.
 *
 * A stored total is a number that goes stale the moment somebody edits a line
 * offline, and two devices that each edited a different line would then have
 * two totals and no way to merge them. Adding up nine rows costs nothing.
 */
export interface BudgetLine extends Base {
  workspace_id: ID;
  budget_id: ID;
  name: string;
  category: CostCategory;
  kind: CostKind;
  /** Per occurrence, not for the whole window. See `recurrence`. */
  amount: Minor;
  recurrence: CostRecurrence;
  /** The line's own window. Null falls back to the budget's period. */
  starts_on: ISODate | null;
  ends_on: ISODate | null;
  vendor: string | null;
  confidence: CostConfidence;
  /** Whose figures this lands in. Empty is unallocated — see `Allocation`. */
  allocations: Allocation[];
  note: string | null;
  sort_order: string;
}

/**
 * Money that actually moved, or is about to.
 *
 * `line_id` is nullable on purpose. An invoice nobody planned for is the most
 * interesting row in the whole system, and a model that forces every actual to
 * name a plan line would have people filing it under "other" — which is how a
 * budget report stops describing reality.
 */
export interface BudgetActual extends Base {
  workspace_id: ID;
  budget_id: ID;
  /** The plan line this pays for, or null when nothing planned it. */
  line_id: ID | null;
  description: string;
  category: CostCategory;
  amount: Minor;
  /** The day the money moved, which is not the day somebody typed it in. */
  spent_on: ISODate;
  stage: SpendStage;
  vendor: string | null;
  /** Invoice or purchase-order number — what an auditor asks for. */
  reference: string | null;
  /** Empty inherits the line's split; see `allocationsFor` in `budget.ts`. */
  allocations: Allocation[];
  note: string | null;
  recorded_by: ID | null;
}

/**
 * A what-if, kept beside the plan rather than instead of it.
 *
 * A scenario never edits a line. It is a list of adjustments applied on the
 * way to a total, so "what if the migration slips a quarter and we drop the
 * training" is a thing somebody can show a steering committee on Tuesday and
 * throw away on Wednesday — and the plan the team is working to is untouched
 * either way.
 */
export interface BudgetScenario extends Base {
  workspace_id: ID;
  budget_id: ID;
  name: string;
  description: string | null;
  /**
   * What to do differently. Applied in order; a line named twice takes both.
   * See `applyScenario` in `budget.ts`.
   */
  adjustments: ScenarioAdjustment[];
  /**
   * How much of an unsigned cost this scenario carries, in basis points, per
   * confidence level. Absent means "all of it" — the plan as written.
   */
  weights: Partial<Record<CostConfidence, number>> | null;
  sort_order: string;
}

/**
 * One move in a scenario.
 *
 * `line_id` empty means every line the filters match, which is what makes
 * "cut all travel by a third" one adjustment rather than eleven.
 */
export interface ScenarioAdjustment {
  /** One line, or empty for every line matching `category` / `kind`. */
  line_id?: ID | null;
  category?: CostCategory | null;
  kind?: CostKind | null;
  /** Basis points of the original amount. 12000 is "20% more". */
  factor?: number | null;
  /** Added after the factor, in minor units. Negative takes money out. */
  delta?: Minor | null;
  /** Move the line's window by whole months. Negative pulls it earlier. */
  shift_months?: number | null;
  /** Take the line out of this scenario entirely. */
  drop?: boolean;
  /** Why. Shown beside the number, because a number alone is not an argument. */
  note?: string | null;
}

/**
 * What an hour is worth, from a date, for somebody or for everybody.
 *
 * **Dated, and that is the whole point.** A rate stored as one current number
 * means raising it in April silently rewrites what March cost — every report
 * anybody has ever exported stops matching the screen, and nothing announces
 * it. So a rate is valid *from* a day and an entry is costed at whatever was
 * in force on the day the work happened. Changing a rate is writing a new row,
 * not editing the old one.
 *
 * **Most specific wins**, in one fixed order — this person on this project,
 * then this person anywhere, then anybody on this project, then the
 * workspace's own — so "Ada is more expensive on the client work" is one row
 * rather than a rate on every project she is not on. See `resolveRate`.
 *
 * A rate is **not** a salary and must not be read as one: it is a planning
 * figure a workspace agrees on, usually rounded, often a blended team number.
 * It is nonetheless close enough to pay that it is owner-and-admin-only, along
 * with everything computed from it.
 */
export interface Rate extends Base {
  workspace_id: ID;
  /** Whose hour. Null is anybody's — the workspace's own default. */
  user_id: ID | null;
  /** Where. Null is everywhere. */
  project_id: ID | null;
  kind: RateKind;
  /** Per hour, in minor units. See `Minor`. */
  amount: Minor;
  /** ISO 4217. A workspace mixing two is shown two totals, never a sum. */
  currency: string;
  /** Valid from this day. There is no end: the next row's start is the end. */
  starts_on: ISODate;
  note: string | null;
}

/* ------------------------------------------------------------- landscape */

/** Somebody you buy from. A component names one; the register groups by it. */
export interface Vendor extends Base {
  workspace_id: ID;
  name: string;
  kind: VendorKind;
  website: string | null;
  contact: string | null;
  /** When the contract runs to. The date a renewal is a surprise without. */
  contract_start: ISODate | null;
  contract_end: ISODate | null;
  /**
   * How many days before `contract_end` you have to give notice.
   *
   * Its own field rather than a line in the note, because it is the one thing
   * about a contract that has a *deadline* attached: the day you stop being
   * able to leave is `contract_end` minus this, and nothing can compute that
   * from prose.
   */
  notice_days: number;
  note: string | null;
  archived: number;
}

/**
 * One thing in the estate: a server, an instance on it, a SaaS subscription.
 *
 * Nested through `parent_id`, so a machine holds its instances and an account
 * holds its seats — the same shape a project or a page already uses, and the
 * server refuses a loop rather than trusting the interface.
 *
 * The cost fields deliberately speak the same vocabulary a budget line does —
 * an amount per occurrence plus a recurrence — so a component can be turned
 * into a plan line without a translation step, and so the two figures can be
 * compared without one of them having been converted first.
 */
export interface Component extends Base {
  workspace_id: ID;
  vendor_id: ID | null;
  /** The server this runs on, or the account this seat belongs to. */
  parent_id: ID | null;
  name: string;
  kind: ComponentKind;
  environment: Environment;
  status: Lifecycle;
  /**
   * When it joined the estate and when it leaves. These, not `status`, are what
   * decide whether it is in the landscape on a given day — see `livenessOn`.
   */
  live_from: ISODate | null;
  live_until: ISODate | null;
  /** Where it physically is: a region, a data centre, a rack. */
  location: string | null;
  /** What it is called where it lives — a hostname, an account, an ARN. */
  reference: string | null;
  /** Per occurrence, like a budget line's. `0` means nobody has priced it. */
  amount: Minor;
  recurrence: CostRecurrence;
  currency: string;
  /** The plan line this is charged to, so the two can be reconciled. */
  line_id: ID | null;
  owner_id: ID | null;
  /**
   * Projects that depend on this. A dependency, not a cost split — the split
   * lives on the budget line, and this answers "who breaks if it goes".
   */
  projects: ID[];
  note: string | null;
  sort_order: string;
}

/**
 * A documented step from one landscape to the next.
 *
 * The "how do we get there" half. It names what goes and what arrives rather
 * than describing it in prose, so the same two lists that make it readable also
 * make it checkable: a move is finished when everything in `leaving` has a
 * `live_until` in the past and everything in `arriving` is live.
 */
export interface Move extends Base {
  workspace_id: ID;
  name: string;
  description: string | null;
  status: MoveStatus;
  /** Components this retires. */
  leaving: ID[];
  /** Components this brings in. */
  arriving: ID[];
  target_date: ISODate | null;
  owner_id: ID | null;
  /** The project doing the work, when somebody has made one. */
  project_id: ID | null;
  sort_order: string;
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
/**
 * Which way an integration points.
 *
 * `out` posts to somebody else when something happens here. `in` gives another
 * service a URL to post *to* — the same row, because both are "this workspace
 * talks to that service", and one screen for both beats two that look alike.
 */
export const HOOK_DIRECTIONS = ['out', 'in'] as const;
export type HookDirection = (typeof HOOK_DIRECTIONS)[number];

/** The shape of the message, for receivers that will not read ours. */
export const HOOK_FORMATS = ['kolibri', 'slack', 'discord'] as const;
export type HookFormat = (typeof HOOK_FORMATS)[number];

/**
 * What a receiver can subscribe to.
 *
 * Here rather than on the server because the screen that offers the checkboxes
 * and the code that fires them have to agree, and they used to agree by having
 * been typed twice.
 *
 * Two rules hold the list together. Every name is `subject.verb`, past tense,
 * because a receiver reacts to something that already happened. And a name is
 * only added when a workflow could not be written without it: `task.moved`
 * exists because "when it reaches In Review" cannot be reconstructed from
 * `task.updated` without the state it left, and that is the archetypal
 * automation. Anything a workflow can fetch for itself over the API is not an
 * event — a hook that fires on everything is a hook somebody switches off.
 *
 * A state change fires `task.moved` **in addition to** `task.updated` or
 * `task.completed`, rather than instead of them: the classification a hook
 * already subscribed to does not change under it.
 */
export const WEBHOOK_EVENTS = [
  'task.created', 'task.updated', 'task.moved', 'task.completed', 'task.deleted',
  'comment.created',
  'page.created', 'page.updated',
  'cycle.created', 'cycle.updated',
  'module.created', 'module.updated',
  'time.logged',
  'intake.created',
  /*
   * Money. `budget.spent` fires when an invoice or a commitment is recorded,
   * because that is the moment a finance system has something to reconcile
   * against — and it is the one event here that a workflow cannot reconstruct
   * by polling, since an actual recorded and then corrected looks identical to
   * one that was always right.
   */
  'budget.created', 'budget.updated', 'budget.spent',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook extends Base {
  workspace_id: ID;
  project_id: ID | null;
  name: string;
  url: string;
  /** Comma-separated event names. */
  events: string;
  enabled: number;
  direction: HookDirection;
  format: HookFormat;
  last_status: number | null;
  last_error: string | null;
  last_sent_at: number | null;
  /** Incoming hooks only, and only for the person who can already see the row. */
  secret?: string;
}

export interface Notification extends Base {
  workspace_id: ID;
  user_id: ID;
  kind: string;
  title: string;
  body: string | null;
  task_id: ID | null;
  page_id: ID | null;
  /** Where to go when it is about neither one task nor one page. */
  project_id: ID | null;
  /** The conversation, when it is about something somebody said in one. */
  channel_id: ID | null;
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

/**
 * A tombstone that was itself thrown away.
 *
 * Emptying the trash cannot simply drop the row: deletion here *is* the
 * tombstone, and a device holding one would keep offering to put the thing back.
 * So the row goes and this marker takes its place — small enough to keep, and
 * enough for every device to forget the same thing.
 */
export interface Purge extends Base {
  workspace_id: ID;
  entity: EntityName;
  row_id: ID;
  /** `manual` if somebody pressed the button, `retention` if the clock did. */
  reason: 'manual' | 'retention';
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
  field: Field;
  fieldValue: FieldValue;
  baseline: Baseline;
  budget: Budget;
  budgetLine: BudgetLine;
  budgetActual: BudgetActual;
  budgetScenario: BudgetScenario;
  rate: Rate;
  vendor: Vendor;
  component: Component;
  move: Move;
  share: Share;
  task: Task;
  relation: Relation;
  cycle: Cycle;
  module: Module;
  kpi: Kpi;
  kpiTarget: KpiTarget;
  kpiReading: KpiReading;
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
  intake: Intake;
  channel: Channel;
  message: Message;
  channelRead: ChannelRead;
  mailbox: Mailbox;
  purge: Purge;
}

/* ------------------------------------------------------------------- chat */

/**
 * A conversation: a named channel, or the direct one between two people.
 *
 * A direct channel's `id` is derived from its two members rather than invented
 * — see `chat.ts`. That is what lets two people open a conversation with each
 * other while both are offline and still end up in one conversation.
 */
export interface Channel extends Base {
  workspace_id: ID;
  /** Set to tie the channel to a project; it then follows that project's visibility. */
  project_id: ID | null;
  kind: ChannelKind;
  /** Lowercase and dash-joined. Empty for a direct conversation, which has no name of its own. */
  name: string;
  topic: string | null;
  is_private: number;
  /** Who can see it. Empty means the workspace, not nobody. */
  members: ID[];
  /** Who may change that list: anybody in it, or only its creator and workspace admins. */
  invite_policy: InvitePolicy;
  archived_at: number | null;
  created_by: ID | null;
}

export interface Message extends Base {
  workspace_id: ID;
  channel_id: ID;
  author_id: ID | null;
  body: string;
  /** The message this one answers, for a short thread inside the stream. */
  reply_to: ID | null;
  /** `{ "👍": [userId, …] }` — the same shape comments use. */
  reactions: Record<string, ID[]>;
  /** Stamped by the server when the body changes, never taken from a client. */
  edited_at: number | null;
}

/**
 * How far one person has read one conversation.
 *
 * Private to them: where somebody has got to is nobody else's business, and a
 * read receipt is deliberately not a feature here.
 */
export interface ChannelRead extends Base {
  workspace_id: ID;
  channel_id: ID;
  user_id: ID;
  last_read_at: number;
  notify: ChannelNotify;
}

/* ------------------------------------------------------------------- mail */

/** How the connection to a mail server is protected. Same three as the relay. */
export type MailEncryption = 'none' | 'starttls' | 'tls';

/** Who may read a mailbox — see `canReadMailbox`, which is the one place that decides. */
export type MailboxAccessLevel = 'workspace' | 'members';

/** What the poller made of its last attempt. */
export type MailboxStatus = 'never' | 'ok' | 'failing';

/**
 * A mail account this workspace has connected.
 *
 * The credential is not here. `password` is a `secret` in the registry, so it
 * is never sent to a client and never written by one — it goes in through its
 * own admin-only route, sealed with the instance key, and the screen shows only
 * whether one is set. See `docs/mail.md`.
 */
export interface Mailbox extends Base {
  workspace_id: ID;
  /** The address itself, folded to lower case. `support@calendoora.de`. */
  address: string;
  /** What to call it on screen. Empty means show the address. */
  name: string;
  host: string;
  port: number;
  encryption: MailEncryption;
  /** Usually the address, sometimes not — Microsoft and a few hosts differ. */
  username: string;
  /** Which folders to read. Empty means INBOX alone. */
  folders: string[];
  access: MailboxAccessLevel;
  /** Who may read it, when `access` is `members`. Empty means nobody. */
  members: ID[];
  enabled: number;
  /** How far back to fetch on the first pass. 0 means everything. */
  sync_days: number;
  created_by: ID | null;
  last_sync_at: number | null;
  last_error: string | null;
  last_status: MailboxStatus;
  message_count: number;
}

/**
 * One message, as it is handed to a reader.
 *
 * Not an entity and deliberately not synced — see the registry's note on
 * `mailbox`. This is the shape the API and MCP return, which is why the body is
 * optional: a search returns a hundred of these and none of them carry one.
 */
export interface MailMessage {
  id: ID;
  mailbox_id: ID;
  /** The address of the mailbox it was found in, so a result set can say where. */
  mailbox: string;
  folder: string;
  message_id: string;
  /** The header that ties a reply to what it answers, when there was one. */
  thread_key: string;
  subject: string;
  from_name: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  /** When the message says it was sent, as epoch milliseconds. */
  sent_at: number;
  seen: number;
  has_attachments: number;
  size: number;
  snippet: string;
  body?: string;
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  id: ID;
  message_id: ID;
  filename: string;
  mime: string;
  size: number;
  /** Where in the message it is, so the bytes can be fetched on demand. */
  part: string;
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
  /**
   * Whoever holds the *instance* — the account that claimed the server, not an
   * owner of a workspace inside it. It is what decides whether Settings shows
   * the relay, the bot token and the model key at all.
   */
  instanceAdmin?: boolean;
}

/* ------------------------------------------------------------ task review */

/**
 * What a review can say about, and what happens when it is applied.
 *
 * `title` and `description` are the two fields a suggestion may rewrite, and
 * they are named here rather than left as a free string so that a model
 * inventing a third one is caught by the parser instead of by `update()`.
 */
export type ReviewField = 'title' | 'description';

export const REVIEW_FIELDS: ReviewField[] = ['title', 'description'];

/**
 * What a finding is about. The kind is a label for the reader — nothing
 * branches on it — so a model naming a kind nobody thought of is not an error.
 */
export type ReviewKind = 'title' | 'description' | 'acceptance' | 'scope' | 'other';

export interface ReviewFinding {
  kind: ReviewKind;
  /** What is unclear, in one sentence, addressed to whoever wrote the task. */
  problem: string;
  /**
   * The field this finding offers to rewrite, and the text to put there.
   *
   * Both or neither. A finding with no replacement is an observation somebody
   * has to act on themselves — worth showing, and shown without a button,
   * because a button that does nothing is worse than no button.
   */
  field?: ReviewField;
  replacement?: string;
}

export interface TaskReview {
  verdict: 'clear' | 'needs-work';
  /** One sentence. The thing somebody reads before deciding to read the rest. */
  summary: string;
  findings: ReviewFinding[];
  /**
   * What only a person can answer.
   *
   * Kept apart from the findings on purpose: a model that cannot tell which
   * export is meant must ask rather than pick one and write it into the
   * description with confidence. These are offered as a comment, so the
   * ambiguity lands on the person who can settle it.
   */
  questions: string[];
  /**
   * The task as it was when this was written.
   *
   * Echoed back so the panel can notice it is talking about text that has since
   * been edited, rather than offering a replacement for a paragraph that is no
   * longer there.
   */
  reviewed_at: number;
  /** Which model answered, so the panel can say so without guessing. */
  model: string;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

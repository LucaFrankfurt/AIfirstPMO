/**
 * Templates and automations.
 *
 * A template is a task, pre-written. An automation is "when this happens to a
 * task, make one of those and give it to these people". The two are separate
 * entities because a template is useful on its own — you can pick one in the
 * quick-add sheet — and a rule needs something to say.
 *
 * Three things this has to get right, none of them obvious:
 *
 *   1. **Recipients are selectors, not ids.** "Whoever leads the project" keeps
 *      meaning that after the lead changes; a stored id does not. Selectors
 *      combine and de-duplicate, so a rule can name two people, the assignees
 *      and a team at once.
 *   2. **It must not feed itself.** A rule that files a review task would
 *      otherwise file a review task for the review task. Generated tasks are
 *      recognisable from `automation_runs`, and rules skip them unless somebody
 *      deliberately asks otherwise.
 *   3. **Doing nothing has to be visible.** A rule whose recipients all resolve
 *      to nobody — the only candidate was the person who moved the task — must
 *      not silently do nothing, or it looks broken. Every decision, including
 *      the ones to skip, is written to `automation_runs` with a reason.
 */
import {
  type EntityName, type FanOut, type Recipient, type RelationKind, type StateGroup,
} from '@kolibri/shared';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { serverClock } from './bootstrap.ts';
import { uid } from './ids.ts';
import { canSeeProject, writeEntity, type WriteOpts } from './repo.ts';

/** Why a run produced nothing. Empty string means it produced a task. */
type SkipReason = 'no-fields' | 'no-recipients' | 'already-run' | 'generated-task' | 'no-template' | '';

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return Array.isArray(raw) ? (raw as T) : fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/* --------------------------------------------------------------- recipients */

/**
 * Turn the selectors on a rule into a list of user ids.
 *
 * Everyone who comes out of this has to be able to *see* the project the task
 * lands in — assigning a private project's review to somebody outside it would
 * create a task they cannot open.
 */
export function resolveRecipients(
  recipients: Recipient[],
  context: { workspaceId: string; task: Row; project: Row | undefined; actorId: string; excludeActor: boolean; targetProjectId: string },
): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  };

  for (const recipient of recipients) {
    switch (recipient.kind) {
      case 'user':
        add(recipient.ref);
        break;
      case 'assignees':
        parseJson<string[]>(context.task.assignees, []).forEach(add);
        break;
      case 'creator':
        add(context.task.created_by);
        break;
      case 'actor':
        add(context.actorId);
        break;
      case 'lead':
        add(context.project?.lead_id);
        break;
      case 'team':
        all<Row>(
          `SELECT user_id FROM team_members WHERE team_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
          recipient.ref ?? '', context.workspaceId,
        ).forEach((member) => add(member.user_id));
        break;
      case 'role':
        all<Row>(
          `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = ? AND deleted_at IS NULL`,
          context.workspaceId, recipient.ref ?? '',
        ).forEach((member) => add(member.user_id));
        break;
    }
  }

  // `actor` asks for the actor on purpose, so an explicit selector wins over
  // the blanket exclusion — otherwise the two options would contradict.
  const wantsActor = recipients.some((recipient) => recipient.kind === 'actor');
  const filtered = context.excludeActor && !wantsActor
    ? out.filter((id) => id !== context.actorId)
    : out;

  return filtered.filter((id) => canSeeProject(id, context.targetProjectId));
}

/* ---------------------------------------------------------------- templates */

/** Values a template's text can refer to. Unknown names are left alone. */
export function templateVars(task: Row, project: Row | undefined, actor: Row | undefined, state: Row | undefined): Record<string, string> {
  const base = env.publicUrl || '';
  return {
    identifier: String(task.identifier ?? ''),
    title: String(task.title ?? ''),
    project: String(project?.name ?? ''),
    actor: String(actor?.name ?? ''),
    state: String(state?.name ?? ''),
    url: base ? `${base}/t/${task.id}` : `/t/${task.id}`,
  };
}

export const fillTemplate = (text: string, vars: Record<string, string>): string =>
  String(text ?? '').replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? vars[name] : match));

const isoInDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export interface InstantiateOptions {
  workspaceId: string;
  actorId: string;
  /** Where the task goes. Falls back to the template's target, then the source. */
  projectId: string;
  assignees?: string[];
  vars?: Record<string, string>;
  /** Written onto the new task; the source task for an automation. */
  parentId?: string | null;
}

/**
 * Create one real task from a template, plus its sub-tasks.
 *
 * Written as an ordinary actor write rather than a system one, so the people it
 * lands on get the same inbox entry they would from being assigned by hand.
 */
export function instantiateTemplate(template: Row, options: InstantiateOptions): Row {
  const vars = options.vars ?? {};
  const opts = (): WriteOpts => ({
    workspaceId: options.workspaceId,
    actorId: options.actorId,
    hlc: serverClock.now(),
  });

  const dueDays = template.due_in_days == null ? null : Number(template.due_in_days);
  const { row } = writeEntity('task', uid(), {
    workspace_id: options.workspaceId,
    project_id: options.projectId,
    title: fillTemplate(String(template.title ?? template.name ?? ''), vars) || String(template.name ?? ''),
    description: template.description ? fillTemplate(String(template.description), vars) : null,
    priority: template.priority ?? 'none',
    labels: parseJson<string[]>(template.labels, []),
    assignees: options.assignees ?? parseJson<string[]>(template.assignees, []),
    estimate: template.estimate ?? null,
    due_date: dueDays == null ? null : isoInDays(dueDays),
    parent_id: options.parentId ?? null,
  }, opts());

  for (const line of parseJson<string[]>(template.subtasks, [])) {
    const title = fillTemplate(line, vars).trim();
    if (!title) continue;
    writeEntity('task', uid(), {
      workspace_id: options.workspaceId,
      project_id: options.projectId,
      title,
      parent_id: row.id,
    }, opts());
  }

  return row;
}

/* --------------------------------------------------------------- the engine */

/** Which of a rule's triggers this write matches, if any. */
interface TriggerEvent {
  created: boolean;
  stateChanged: boolean;
  groupChanged: boolean;
  stateId: string | null;
  group: StateGroup | null;
  /** Set for the triggers that are not about a task changing state. */
  kind?: 'page_changed' | 'comment_added' | 'due_in';
}

function matches(rule: Row, event: TriggerEvent): boolean {
  if (event.kind) return rule.trigger_kind === event.kind;
  switch (rule.trigger_kind) {
    case 'task_created':
      return event.created;
    case 'state_entered':
      return event.stateChanged && !!rule.trigger_state_id && rule.trigger_state_id === event.stateId;
    case 'state_group_entered':
      // Only when the group actually changes: moving between two `started`
      // states is not "entering in progress" a second time.
      return event.groupChanged && !!rule.trigger_group && rule.trigger_group === event.group;
    default:
      return false;
  }
}

const wasGeneratedByAutomation = (taskId: string): boolean =>
  !!get(`SELECT id FROM automation_runs WHERE created_task_id = ? LIMIT 1`, taskId);

const hasRunBefore = (automationId: string, taskId: string): boolean =>
  !!get(`SELECT id FROM automation_runs WHERE automation_id = ? AND task_id = ? AND skipped = '' LIMIT 1`, automationId, taskId);

function record(rule: Row, task: Row, actorId: string, createdTaskId: string | null, skipped: SkipReason): void {
  run(
    `INSERT INTO automation_runs (id, workspace_id, automation_id, task_id, created_task_id, actor_id, skipped, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uid(), rule.workspace_id, rule.id, task.id, createdTaskId, actorId, skipped, Date.now(),
  );
}

/**
 * Belt and braces on top of the generated-task check: even a rule somebody
 * deliberately set to apply to generated tasks cannot recurse for ever.
 */
let depth = 0;
const MAX_DEPTH = 3;

/** Called from the write path for every non-system task write. */
export function runAutomations(
  entity: EntityName,
  row: Row,
  before: Row | undefined,
  changed: Record<string, unknown>,
  opts: WriteOpts,
): void {
  if (opts.op === 'delete' || row.deleted_at) return;
  if (depth >= MAX_DEPTH) return;

  // Rules that watch something other than a task changing state. The task the
  // rule acts on is the one the page or comment hangs off; a page comment has
  // no task, so those rules simply find nothing to act on.
  if (entity === 'page' || entity === 'comment') {
    const kind = entity === 'page' ? 'page_changed' : 'comment_added';
    if (entity === 'page' && (before === undefined || changed.content === undefined)) return;
    if (entity === 'comment' && before !== undefined) return;
    const task = entity === 'comment' && row.task_id
      ? get<Row>(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`, row.task_id)
      : undefined;
    const subject = task ?? (entity === 'page' ? row : undefined);
    if (!subject) return;

    for (const rule of watchingRules(String(row.workspace_id), subject.project_id, kind)) {
      fireOne(rule, subject, opts.actorId, { kind });
    }
    return;
  }

  if (entity !== 'task') return;

  const created = !before;
  const stateChanged = !created && changed.state_id !== undefined && before?.state_id !== row.state_id;
  const stateOf = (id: unknown) => (id ? get<Row>(`SELECT * FROM states WHERE id = ?`, id) : undefined);
  const newState = stateChanged || created ? stateOf(row.state_id) : undefined;
  const oldGroup = stateChanged ? stateOf(before?.state_id)?.group_key : undefined;
  const event = {
    created,
    stateChanged,
    groupChanged: stateChanged && newState?.group_key !== oldGroup,
    stateId: (row.state_id as string) ?? null,
    group: (newState?.group_key as StateGroup) ?? null,
  };
  if (!event.created && !event.stateChanged) return;

  const rules = all<Row>(
    `SELECT * FROM automations
      WHERE workspace_id = ? AND enabled = 1 AND deleted_at IS NULL
        AND (project_id IS NULL OR project_id = ?)
      ORDER BY sort_order, created_at`,
    row.workspace_id, row.project_id,
  );
  if (!rules.length) return;

  depth++;
  try {
    for (const rule of rules) runOneRule(rule, row, opts.actorId, event);
  } finally {
    depth--;
  }
}

/**
 * One rule against one task.
 *
 * Shared by the write path and the daily sweep, so a `due_in` rule and a
 * `state_entered` rule behave identically once they have decided to fire.
 */
function runOneRule(rule: Row, row: Row, actorId: string, event: TriggerEvent): void {
  const generated = wasGeneratedByAutomation(row.id as string);
  const project = get<Row>(`SELECT * FROM projects WHERE id = ?`, row.project_id);
  const actor = get<Row>(`SELECT name FROM users WHERE id = ?`, actorId);
  const newState = row.state_id ? get<Row>(`SELECT * FROM states WHERE id = ?`, row.state_id) : undefined;
  const vars = templateVars(row, project, actor, newState);
  const opts = { actorId };

    if (!matches(rule, event)) return;
    if (generated && !rule.apply_to_generated) {
      record(rule, row, opts.actorId, null, 'generated-task');
      return;
    }
    if (rule.once && hasRunBefore(rule.id as string, row.id as string)) {
      record(rule, row, opts.actorId, null, 'already-run');
      return;
    }

    // A rule that changes the task it watched rather than filing a new one.
    // Deliberately narrow: only fields whose value is a plain scalar, and
    // never `state_id`, because a rule that moves a task can trigger a rule
    // that moves it back, and two rules editing one row is a merge problem
    // rather than a feature flag.
    if (rule.action_kind === 'set_fields') {
      const patch = actionPatch(parseJson<Record<string, unknown>>(rule.action_patch, {}), row);
      if (!Object.keys(patch).length) {
        record(rule, row, opts.actorId, null, 'no-fields');
        return;
      }
      writeEntity('task', String(row.id), patch, {
        workspaceId: String(row.workspace_id), actorId: opts.actorId, hlc: serverClock.now(), system: true,
      });
      record(rule, row, opts.actorId, String(row.id), '');
      return;
    }

    const template = get<Row>(`SELECT * FROM templates WHERE id = ? AND deleted_at IS NULL`, rule.template_id);
    if (!template) {
      record(rule, row, opts.actorId, null, 'no-template');
      return;
    }

    const targetProjectId = String(template.target_project_id ?? row.project_id);
    const people = resolveRecipients(parseJson<Recipient[]>(rule.recipients, []), {
      workspaceId: String(row.workspace_id),
      task: row,
      project,
      actorId: opts.actorId,
      // "Skip whoever triggered it" means nothing when a clock did. A
      // `due_in` rule that excluded the actor would exclude the task's
      // creator, who is usually the only recipient such a rule has.
      excludeActor: !!rule.exclude_actor && event.kind !== 'due_in',
      targetProjectId,
    });

    // A ticket nobody is on is a ticket nobody reads. Say so instead.
    if (!people.length) {
      record(rule, row, opts.actorId, null, 'no-recipients');
      return;
    }

    const groups = (rule.fan_out as FanOut) === 'each' ? people.map((id) => [id]) : [people];
    for (const assignees of groups) {
      const task = instantiateTemplate(template, {
        workspaceId: String(row.workspace_id),
        actorId: opts.actorId,
        projectId: targetProjectId,
        assignees,
        vars,
      });
      if (rule.link_kind) {
        writeEntity('relation', uid(), {
          workspace_id: row.workspace_id,
          task_id: task.id,
          related_task_id: row.id,
          kind: rule.link_kind as RelationKind,
        }, { workspaceId: String(row.workspace_id), actorId: opts.actorId, hlc: serverClock.now(), system: true });
      }
      record(rule, row, opts.actorId, String(task.id), '');
    }

}


/**
 * The fields a `set_fields` rule is allowed to write.
 *
 * A short list on purpose. `state_id` is missing because a rule that moves a
 * task can trigger a rule that moves it back; the depth guard would stop the
 * loop, but the task would still end up somewhere nobody chose.
 */
const SETTABLE = new Set(['priority', 'assignees', 'labels', 'due_date', 'estimate', 'type_id', 'archived']);

/**
 * What a `set_fields` rule actually writes.
 *
 * Two of the four things people want are not fields at all. "Add a label" is an
 * append, not an assignment — a rule that *replaced* the labels would quietly
 * strip whatever somebody had put there. And "due in three days" is a date that
 * depends on when the rule ran, which is a calculation rather than a value.
 * Both are resolved here, against the row as it stands.
 */
function actionPatch(stored: Record<string, unknown>, row: Row): Record<string, unknown> {
  const out = settableFields(stored);

  const add = Array.isArray(stored.add_labels) ? stored.add_labels.map(String).filter(Boolean) : [];
  if (add.length) {
    const already = parseJson<string[]>(row.labels, []);
    const merged = [...already];
    for (const id of add) if (!merged.includes(id)) merged.push(id);
    out.labels = merged;
  }

  if (typeof stored.due_in_days === 'number' && Number.isFinite(stored.due_in_days)) {
    const when = new Date(Date.now() + stored.due_in_days * 86_400_000);
    out.due_date = when.toISOString().slice(0, 10);
  }

  return out;
}

function settableFields(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!SETTABLE.has(field)) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
      out[field] = value;
    }
  }
  return out;
}

/**
 * The rules a clock fires: `due_in`, once per task per day.
 *
 * Swept rather than triggered, because nothing happens to a task when a date
 * arrives — that is the whole difficulty with a time trigger, and the reason
 * this is the only one.
 */
export function runAutomationsForDue(today: string): number {
  const rules = all<Row>(
    `SELECT * FROM automations
      WHERE enabled = 1 AND deleted_at IS NULL AND trigger_kind = 'due_in'
        AND (last_run_day IS NULL OR last_run_day <> ?)`,
    today,
  );
  if (!rules.length) return 0;

  let fired = 0;
  for (const rule of rules) {
    const days = Math.max(0, Number(rule.trigger_days ?? 1));
    const target = new Date(new Date(`${today}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
    const tasks = all<Row>(
      `SELECT t.* FROM tasks t
        WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND t.archived = 0
          AND t.due_date = ? AND t.completed_at IS NULL
          AND (? IS NULL OR t.project_id = ?)`,
      rule.workspace_id, target, rule.project_id, rule.project_id,
    );
    for (const task of tasks) {
      fireOne(rule, task, String(task.created_by ?? ''), { kind: 'due_in' });
      fired++;
    }
    // Marked whether or not anything matched: a rule that swept today has
    // swept today, and a restart must not run it again.
    run(`UPDATE automations SET last_run_day = ? WHERE id = ?`, today, rule.id);
  }
  return fired;
}

/** Enabled rules of one kind that cover a project. */
const watchingRules = (workspaceId: string, projectId: unknown, kind: string): Row[] =>
  all<Row>(
    `SELECT * FROM automations
      WHERE workspace_id = ? AND enabled = 1 AND deleted_at IS NULL AND trigger_kind = ?
        AND (project_id IS NULL OR project_id = ?)
      ORDER BY sort_order, created_at`,
    workspaceId, kind, projectId ?? null,
  );

/** Run one rule against one task, outside the write path. */
function fireOne(rule: Row, row: Row, actorId: string, event: Partial<TriggerEvent>): void {
  if (depth >= MAX_DEPTH) return;
  depth++;
  try {
    runOneRule(rule, row, actorId, {
      created: false, stateChanged: false, groupChanged: false, stateId: null, group: null, ...event,
    });
  } finally {
    depth--;
  }
}

/** What a rule has done lately, newest first. */
export const automationRuns = (automationId: string, limit = 25): Row[] =>
  all<Row>(
    `SELECT r.*, t.identifier AS task_identifier, t.title AS task_title,
            c.identifier AS created_identifier, c.title AS created_title
       FROM automation_runs r
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN tasks c ON c.id = r.created_task_id
      WHERE r.automation_id = ?
      ORDER BY r.created_at DESC LIMIT ?`,
    automationId, limit,
  );

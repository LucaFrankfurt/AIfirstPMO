/**
 * The rules an incident, its timeline and the application list live by.
 *
 * Four of them are the feature, and each is here rather than in a screen
 * because a client that got it wrong would get it wrong for everybody:
 *
 * **The number is counted here.** `INC-7` is the maximum this workspace has
 * ever handed out plus one, tombstones included, inside the write's own
 * transaction. A device offline cannot know which number is next, and two that
 * guessed would both mint `INC-7` — the one collision a number exists to make
 * impossible. Deleted incidents keep theirs, so a number quoted in last month's
 * email still names exactly one thing.
 *
 * **The status stamps its own times.** `resolved_at` and `closed_at` are the
 * moments the status said so, and nobody types them: a report of how long
 * incidents took to resolve is worth nothing if the end of each one is a field
 * somebody filled in afterwards. Reopening clears them — an incident that came
 * back was not resolved, and the clock it reports should say so.
 *
 * **The timeline writes itself.** A change of status, priority or manager adds
 * a `change` line, so the record is complete without anybody remembering to
 * say "moved to monitoring" — which is exactly the line nobody writes at three
 * in the morning and everybody looks for at the review.
 *
 * **People are members.** The manager and the responders are narrowed to the
 * workspace's members, because a guest is never sent an incident (see the sync
 * filter), and a name on an incident whose owner cannot open it is a
 * responsibility nobody can take. Narrowed rather than refused, for the reason
 * the meeting rules give: these arrive in sync batches from devices that have
 * been away, and a person who left since is no reason to lose the rest.
 */
import {
  APPLICATION_CRITICALITY, INCIDENT_CATEGORIES, INCIDENT_IMPACTS, INCIDENT_PRIORITIES, INCIDENT_RESOLUTIONS,
  INCIDENT_STATUS, INCIDENT_UPDATE_KINDS, INCIDENT_URGENCIES, incidentIdentifier, isActive, isIncidentImpact,
  isIncidentUrgency, priorityFor, type IncidentStatus,
} from '@kolibri/shared';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';

const incidentRow = (id: unknown): Row | undefined =>
  (id ? get<Row>(`SELECT * FROM incidents WHERE id = ?`, String(id)) : undefined);

/** Somebody who is sent incidents at all: in the workspace, and not as a guest. */
const isMember = (workspaceId: string, userId: string): boolean => !!get(
  `SELECT 1 FROM workspace_members
    WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL AND role IN ('owner', 'admin', 'member')`,
  workspaceId, userId,
);

/** A JSON list column as it arrives at an invariant: already a string, or not yet. */
function idsIn(raw: unknown): string[] | null {
  if (raw === undefined) return null;
  if (raw === null) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? [...new Set(parsed.map(String).filter(Boolean))] : [];
  } catch {
    return [];
  }
}

/** The next number this workspace hands out. Tombstones count: a number is never reused. */
function nextNumber(workspaceId: string): number {
  const row = get<Row>(`SELECT MAX(number) AS top FROM incidents WHERE workspace_id = ?`, workspaceId);
  return Number(row?.top ?? 0) + 1;
}

function applyIncidentInvariants(
  entity: string,
  values: Record<string, unknown>,
  existing: Row | undefined,
  forced: Record<string, unknown>,
  workspaceId: string,
): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  const oneOf = (field: string, allowed: readonly string[], fallback: string | null) => {
    if (values[field] === undefined) return;
    if (values[field] === null && fallback === null) return;
    if (!allowed.includes(String(values[field] ?? ''))) settle(field, fallback);
  };
  /** An instant as epoch milliseconds, or null — never zero, which is a real moment in 1970. */
  const instant = (field: string) => {
    if (values[field] === undefined || values[field] === null) return;
    const at = Math.round(Number(values[field]));
    if (!(Number.isFinite(at) && at > 0) || at !== values[field]) settle(field, Number.isFinite(at) && at > 0 ? at : null);
  };
  /** A count or an amount: a whole number, or null for "nobody said". */
  const whole = (field: string, min: number) => {
    if (values[field] === undefined || values[field] === null || values[field] === '') {
      if (values[field] === '') settle(field, null);
      return;
    }
    const n = Math.round(Number(values[field]));
    if (!Number.isFinite(n) || n < min) settle(field, null);
    else if (n !== values[field]) settle(field, n);
  };
  const narrow = (field: string, exists: (id: string) => boolean) => {
    const ids = idsIn(values[field]);
    if (ids === null) return;
    const kept = ids.filter(exists);
    values[field] = JSON.stringify(kept);
    forced[field] = kept;
  };

  if (entity === 'application') {
    oneOf('criticality', APPLICATION_CRITICALITY, 'medium');
    if (values.archived !== undefined) settle('archived', values.archived ? 1 : 0);
  }

  if (entity === 'incidentUpdate') {
    oneOf('kind', INCIDENT_UPDATE_KINDS, 'update');
    instant('occurred_at');
    if (values.occurred_at === null) settle('occurred_at', Date.now());
  }

  if (entity !== 'incident') return;

  oneOf('status', INCIDENT_STATUS, 'new');
  oneOf('priority', INCIDENT_PRIORITIES, 'p3');
  oneOf('impact', INCIDENT_IMPACTS, 'medium');
  oneOf('urgency', INCIDENT_URGENCIES, 'medium');
  oneOf('category', INCIDENT_CATEGORIES, 'other');
  oneOf('resolution_code', INCIDENT_RESOLUTIONS, null);
  if (values.major !== undefined) settle('major', values.major ? 1 : 0);
  for (const field of ['started_at', 'detected_at', 'ended_at']) instant(field);
  // A loss, so not below zero: an outage that made money is a different report.
  whole('financial_impact', 0);
  whole('affected_users', 0);
  if (values.currency !== undefined) {
    const code = String(values.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) settle('currency', existing?.currency ?? 'EUR');
    else if (code !== values.currency) settle('currency', code);
  }

  if (values.manager_id !== undefined && values.manager_id !== null && !isMember(workspaceId, String(values.manager_id))) {
    settle('manager_id', null);
  }
  narrow('responders', (id) => isMember(workspaceId, id));
  narrow('applications', (id) => !!get(
    `SELECT 1 FROM applications WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, id, workspaceId,
  ));
  narrow('pages', (id) => !!get(`SELECT 1 FROM pages WHERE id = ? AND workspace_id = ?`, id, workspaceId));
  narrow('tasks', (id) => !!get(`SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ?`, id, workspaceId));

  stampStatusTimes(values, existing, settle);
}

/**
 * The two moments the status decides, and the end of the impact when nobody
 * said.
 *
 * Resolving with no `ended_at` sets it to now: "the service is back" is the
 * end of the impact unless somebody says it ended earlier, and an incident
 * resolved with its impact still running would report as an outage that never
 * stopped. Going back to an active status clears both stamps — the incident
 * came back, so it was not resolved, and leaving the old stamp would make the
 * next resolution look minutes long.
 */
function stampStatusTimes(
  values: Record<string, unknown>,
  existing: Row | undefined,
  settle: (field: string, value: unknown) => void,
): void {
  if (values.status === undefined) return;
  const next = String(values.status) as IncidentStatus;
  const before = existing ? String(existing.status) as IncidentStatus : null;
  if (next === before) return;
  const now = Date.now();
  const has = (field: string) => (values[field] ?? existing?.[field] ?? null) !== null;

  if (isActive({ status: next })) {
    if (existing?.resolved_at) settle('resolved_at', null);
    if (existing?.closed_at) settle('closed_at', null);
    return;
  }
  if (next === 'resolved' || next === 'closed') {
    if (!existing?.resolved_at || (before !== null && isActive({ status: before }))) settle('resolved_at', now);
    if (!has('ended_at')) settle('ended_at', now);
  }
  if (next === 'closed' && !existing?.closed_at) settle('closed_at', now);
  if (next === 'resolved' && existing?.closed_at) settle('closed_at', null);
}

/**
 * Only the server writes a change line, and only its author edits an update.
 *
 * A `change` line is the record that the status moved; a client that could
 * write one could claim an incident was resolved an hour before it was, and
 * one that could edit somebody else's update could change what the team was
 * told during the outage. Both are refusals rather than corrections: there is
 * no honest guess at what was meant.
 */
function guardUpdate(values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  const incident = incidentRow(values.incident_id ?? existing?.incident_id);
  if (!incident || incident.deleted_at) throw badRequest('That incident is not here');
  if (existing) {
    if (String(existing.kind) === 'change') throw forbidden('A change line is the record; it is not edited');
    if (existing.author_id && String(existing.author_id) !== opts.actorId) {
      throw forbidden('That update belongs to somebody else');
    }
    if (values.incident_id !== undefined && String(values.incident_id) !== String(existing.incident_id)) {
      throw badRequest('An update stays on the incident it was written on');
    }
  }
  if (values.kind === 'change') throw forbidden('Change lines are written by the server');
}

/** A timeline line follows its incident's workspace — the `kpiTarget` rule, verbatim in shape. */
function followIncidentWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const incident = incidentRow(values.incident_id ?? existing?.incident_id);
  if (incident) values.workspace_id = incident.workspace_id;
}

/** The fields whose moves the timeline records on its own. */
const TRACKED = ['status', 'priority', 'manager_id'] as const;

/**
 * Write down what moved.
 *
 * One line per field, in the same transaction as the change, through the write
 * path so it reaches every device. A create writes one line — opened, at the
 * status it was opened in — so the timeline starts where the incident did.
 */
function recordChanges(row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  const write = (field: string, oldValue: unknown, newValue: unknown) => {
    writeEntity('incidentUpdate', uid(), {
      incident_id: row.id,
      kind: 'change',
      body: null,
      occurred_at: Date.now(),
      field,
      old_value: oldValue === null || oldValue === undefined ? null : String(oldValue),
      new_value: newValue === null || newValue === undefined ? null : String(newValue),
      author_id: opts.actorId,
    }, { ...opts, op: undefined, system: true, silent: true });
  };
  if (!before) {
    write('status', null, row.status);
    return;
  }
  for (const field of TRACKED) {
    if (changed[field] === undefined) continue;
    if (String(before[field] ?? '') === String(row[field] ?? '')) continue;
    write(field, before[field], row[field]);
  }
}

export const incidentRules = {
  entities: ['application', 'incident', 'incidentUpdate'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'application') {
      if (!values.name) setForced('name', 'Untitled application');
      if (!values.criticality) setForced('criticality', 'medium');
    }
    if (entity === 'incident') {
      // Who opened it. The one line of provenance an incident starts with.
      if (!values.created_by) setForced('created_by', opts.actorId);
      if (!values.summary) setForced('summary', 'Untitled incident');
      if (!values.status) setForced('status', 'new');
      const impact = isIncidentImpact(values.impact) ? values.impact : 'medium';
      const urgency = isIncidentUrgency(values.urgency) ? values.urgency : 'medium';
      if (!values.impact) setForced('impact', impact);
      if (!values.urgency) setForced('urgency', urgency);
      // The matrix's suggestion, for an incident that arrived without a
      // priority. One that arrived with one keeps it — see `priorityFor`.
      if (!values.priority) setForced('priority', priorityFor(impact, urgency));
      // Somebody is writing it down now, so it was noticed by now at the latest.
      if (values.detected_at === undefined || values.detected_at === null) setForced('detected_at', Date.now());
      const workspaceId = String(values.workspace_id ?? opts.workspaceId);
      const number = nextNumber(workspaceId);
      setForced('number', number);
      setForced('identifier', incidentIdentifier(number));
    }
    if (entity === 'incidentUpdate') {
      // Whoever the write arrived as, unless the server is writing a change
      // line on somebody's behalf and has said who.
      if (!opts.system || !values.author_id) setForced('author_id', opts.actorId);
      if (!values.kind) setForced('kind', 'update');
      if (values.occurred_at === undefined || values.occurred_at === null) setForced('occurred_at', Date.now());
    }
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'incidentUpdate') guardUpdate(values, existing, opts);
  },
  invariants(entity, id, values, existing, forced, opts) {
    if (entity === 'incidentUpdate') followIncidentWorkspace(values, existing);
    const workspaceId = String(values.workspace_id ?? existing?.workspace_id ?? opts.workspaceId);
    applyIncidentInvariants(entity, values, existing, forced, workspaceId);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'incident' && !row.deleted_at) recordChanges(row, before, changed, opts);
  },
} satisfies EntityRule;

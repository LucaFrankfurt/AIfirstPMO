/**
 * Incidents: what stopped working, who is running it, what was said while it
 * was down, and what is owed afterwards.
 *
 * Two things are worth reading before the tools.
 *
 * **An incident is named the way people name it.** Every tool takes `INC-12`,
 * `12`, `#12` or the id — whatever was pasted from the email subject or the
 * chat — and every tool that names people or applications takes the words an
 * assistant was given rather than ids it would have to look up first. An
 * application named that the workspace does not list yet is *added* to the
 * list rather than refused, for the reason `record_component` creates a
 * vendor: an assistant writing down an outage at speed should not have to stop
 * and curate a dropdown first, and a list with the name spelled once beats an
 * incident filed against nothing.
 *
 * **The server writes the record, not the assistant.** The number, the moment
 * it was resolved and the `change` lines on the timeline are the write path's
 * — see the incident rules. A tool here that moves the status gets the timeline
 * line for free, and none of them can backdate a resolution or claim a change
 * nobody made.
 */
import {
  APPLICATION_CRITICALITY, INCIDENT_CATEGORIES, INCIDENT_IMPACTS, INCIDENT_PRIORITIES, INCIDENT_RESOLUTIONS,
  INCIDENT_STATUS, INCIDENT_URGENCIES, byCriticality, byIncidentUrgency, byOccurrence, formatDuration, formatMoney,
  incidentClocks, incidentNumberOf, incidentReport, isActive, orderKey, reviewMarkdown,
  type Application, type Incident, type IncidentUpdate,
} from '@kolibri/shared';
import { all, get, tx, type Row } from '../../../kernel/platform/db/index.ts';
import { serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { env } from '../../../kernel/platform/env.ts';
import { localeOf, translatorFor } from '../../../kernel/i18n/i18n.ts';
import {
  fileTask, findMember, findPage, findTask, McpError, namesOf, requireFeature, requireMoney, requireWrite,
  str, type McpCtx, type ToolDef, workspaceOf, writeOpts,
} from '../kit.ts';

const asIncident = (row: Row): Incident => serialize('incident', row) as unknown as Incident;
const asUpdate = (row: Row): IncidentUpdate => serialize('incidentUpdate', row) as unknown as IncidentUpdate;
const asApplication = (row: Row): Application => serialize('application', row) as unknown as Application;

/**
 * Incidents are for members, here as at the pull.
 *
 * A guest's token reaches MCP like anybody's, and every read tool below would
 * otherwise hand a client the record the sync filter keeps from their device.
 */
function enter(args: Record<string, any>, ctx: McpCtx, writing = false): string {
  const workspaceId = workspaceOf(args, ctx);
  requireFeature(workspaceId, 'incidents');
  if (ctx.auth.memberships.get(workspaceId) === 'guest') {
    throw new McpError('Incidents are for members of the workspace', -32000);
  }
  if (writing) requireWrite(ctx, workspaceId);
  return workspaceId;
}

const incidentsIn = (workspaceId: string): Incident[] =>
  all<Row>(`SELECT * FROM incidents WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId).map(asIncident);

const applicationsIn = (workspaceId: string): Application[] =>
  all<Row>(`SELECT * FROM applications WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId).map(asApplication);

/** `INC-12`, `12`, `#12` or the id. The same answer for "none" and "not yours", as everywhere. */
function findIncident(ref: string, workspaceId: string): Incident {
  const number = incidentNumberOf(ref);
  const row = number !== null
    ? get<Row>(`SELECT * FROM incidents WHERE workspace_id = ? AND number = ? AND deleted_at IS NULL`, workspaceId, number)
    : get<Row>(`SELECT * FROM incidents WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceId, String(ref).trim());
  if (!row) throw new McpError(`No incident "${ref}" in this workspace`);
  return asIncident(row);
}

/**
 * Application names as ids, adding the ones the list does not have yet.
 *
 * Matched without case, because "crm" and "CRM" are one system to the person
 * reporting it. Archived ones match too — an outage of something being retired
 * is still an outage of it — rather than minting a second row with its name.
 */
function applicationIds(raw: unknown, workspaceId: string, ctx: McpCtx): string[] {
  if (raw === undefined || raw === null) return [];
  const names = (Array.isArray(raw) ? raw : [raw]).map((one) => String(one).trim()).filter(Boolean);
  const known = all<Row>(`SELECT id, name FROM applications WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId);
  const ids: string[] = [];
  for (const name of names) {
    const found = known.find((row) => row.id === name || String(row.name).toLowerCase() === name.toLowerCase());
    if (found) { ids.push(String(found.id)); continue; }
    const last = get<Row>(
      `SELECT sort_order FROM applications WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order DESC LIMIT 1`,
      workspaceId,
    );
    const { row } = writeEntity('application', uid(), {
      name, description: null, owner_id: null, criticality: 'medium', component_id: null, archived: 0,
      sort_order: orderKey(last?.sort_order ?? null, null),
    }, writeOpts(workspaceId, ctx));
    known.push(row);
    ids.push(String(row.id));
  }
  return [...new Set(ids)];
}

/**
 * An instant from an assistant: an ISO string with its zone, or epoch
 * milliseconds. Refused when it cannot be read — a start time that silently
 * became "unknown" is a duration that silently became wrong.
 */
function instantArg(raw: unknown, field: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const at = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (!Number.isFinite(at) || at <= 0) throw new McpError(`Cannot read "${raw}" as a time for ${field} — use ISO 8601 with a zone, or epoch milliseconds`);
  return Math.round(at);
}

/** One of a fixed list, or a refusal naming the list. */
function oneOf<T extends string>(raw: unknown, list: readonly T[], field: string): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!(list as readonly string[]).includes(value)) throw new McpError(`${field} is one of: ${list.join(', ')}`);
  return value as T;
}

/**
 * The fields a create and an update share, read off the arguments.
 *
 * Only what was passed comes back, so an update changes what it was asked to
 * and nothing else.
 */
function incidentPatch(args: Record<string, any>, workspaceId: string, ctx: McpCtx): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (str(args.summary)) patch.summary = str(args.summary);
  if (args.description !== undefined) patch.description = str(args.description) ?? null;
  const status = oneOf(args.status, INCIDENT_STATUS, 'status');
  if (status) patch.status = status;
  const priority = oneOf(args.priority, INCIDENT_PRIORITIES, 'priority');
  if (priority) patch.priority = priority;
  const impact = oneOf(args.impact, INCIDENT_IMPACTS, 'impact');
  if (impact) patch.impact = impact;
  const urgency = oneOf(args.urgency, INCIDENT_URGENCIES, 'urgency');
  if (urgency) patch.urgency = urgency;
  const category = oneOf(args.category, INCIDENT_CATEGORIES, 'category');
  if (category) patch.category = category;
  if (typeof args.major === 'boolean') patch.major = args.major ? 1 : 0;
  if (args.applications !== undefined) patch.applications = applicationIds(args.applications, workspaceId, ctx);
  if (args.manager !== undefined) patch.manager_id = str(args.manager) ? String(findMember(String(args.manager), workspaceId).id) : null;
  if (args.responders !== undefined) {
    patch.responders = (Array.isArray(args.responders) ? args.responders : [args.responders])
      .map((ref: unknown) => String(findMember(String(ref), workspaceId).id));
  }
  if (args.reported_by !== undefined) patch.reported_by = str(args.reported_by) ?? null;
  for (const field of ['started_at', 'detected_at', 'ended_at'] as const) {
    const at = instantArg(args[field], field);
    if (at !== undefined) patch[field] = at;
  }
  if (args.financial_impact !== undefined) {
    patch.financial_impact = args.financial_impact === null || args.financial_impact === ''
      ? null
      : requireMoney(args.financial_impact, 'financial_impact');
  }
  if (str(args.currency)) patch.currency = String(args.currency).trim().toUpperCase();
  if (args.affected_users !== undefined) {
    patch.affected_users = args.affected_users === null ? null : Math.max(0, Math.round(Number(args.affected_users)));
    if (Number.isNaN(patch.affected_users)) throw new McpError('affected_users is a number of people');
  }
  const resolution = oneOf(args.resolution_code, INCIDENT_RESOLUTIONS, 'resolution_code');
  if (resolution) patch.resolution_code = resolution;
  if (args.resolution !== undefined) patch.resolution = str(args.resolution) ?? null;
  if (args.root_cause !== undefined) patch.root_cause = str(args.root_cause) ?? null;
  return patch;
}

/** The names, titles and identifiers an incident points at, resolved once for a whole answer. */
function lookups(incidents: Incident[], workspaceId: string) {
  const people = namesOf(incidents.flatMap((one) => [one.manager_id ?? '', ...(one.responders ?? [])]).filter(Boolean));
  const applications = new Map(applicationsIn(workspaceId).map((app) => [app.id, app]));
  return { people, applications };
}

/** One incident as a list shows it: enough to triage, nothing that needs a second query. */
function incidentBrief(incident: Incident, context: ReturnType<typeof lookups>, now = Date.now()) {
  const clocks = incidentClocks(incident, now);
  return {
    id: incident.id,
    identifier: incident.identifier,
    summary: incident.summary,
    status: incident.status,
    active: isActive(incident),
    priority: incident.priority,
    major: !!incident.major,
    category: incident.category,
    applications: (incident.applications ?? []).map((id) => context.applications.get(id)?.name ?? id),
    manager: incident.manager_id ? context.people[incident.manager_id] ?? incident.manager_id : null,
    started_at: incident.started_at,
    impact_duration: formatDuration(clocks.impactMs),
    impact_ongoing: clocks.running,
    financial_impact: incident.financial_impact === null
      ? null
      : formatMoney(incident.financial_impact, incident.currency),
  };
}

/** One incident in full, with its timeline and everything it links to. */
function incidentFull(incident: Incident, workspaceId: string, ctx: McpCtx) {
  const context = lookups([incident], workspaceId);
  const updates = all<Row>(`SELECT * FROM incident_updates WHERE incident_id = ? AND deleted_at IS NULL`, incident.id)
    .map(asUpdate).sort(byOccurrence);
  const authors = namesOf(updates.map((update) => update.author_id ?? '').filter(Boolean));
  const clocks = incidentClocks(incident);
  const pages = (incident.pages ?? []).map((id) => {
    const page = get<Row>(`SELECT id, title, access, created_by, deleted_at FROM pages WHERE id = ?`, id);
    // A private page somebody else wrote is linked, and not yours to read the title of.
    if (!page || page.deleted_at) return { id, title: null, gone: true };
    if (page.access === 'private' && page.created_by !== ctx.auth.userId) return { id, title: null, private: true };
    return { id, title: String(page.title), url: `${env.publicUrl}/pages/${id}` };
  });
  const tasks = (incident.tasks ?? []).map((id) => {
    const task = get<Row>(`SELECT identifier, title, completed_at, deleted_at FROM tasks WHERE id = ?`, id);
    if (!task || task.deleted_at) return { id, identifier: null, gone: true };
    return { id, identifier: String(task.identifier), title: String(task.title), done: task.completed_at !== null };
  });
  return {
    ...incidentBrief(incident, context),
    description: incident.description,
    impact: incident.impact,
    urgency: incident.urgency,
    responders: (incident.responders ?? []).map((id) => context.people[id] ?? id),
    reported_by: incident.reported_by,
    detected_at: incident.detected_at,
    ended_at: incident.ended_at,
    resolved_at: incident.resolved_at,
    closed_at: incident.closed_at,
    time_to_detect: formatDuration(clocks.detectMs),
    time_to_resolve: formatDuration(clocks.resolveMs),
    currency: incident.currency,
    financial_impact_minor: incident.financial_impact,
    affected_users: incident.affected_users,
    resolution_code: incident.resolution_code,
    resolution: incident.resolution,
    root_cause: incident.root_cause,
    pages,
    tasks,
    timeline: updates.map((update) => ({
      at: update.occurred_at,
      kind: update.kind,
      author: update.author_id ? authors[update.author_id] ?? null : null,
      ...(update.kind === 'change'
        ? { field: update.field, from: update.old_value, to: update.new_value }
        : { text: update.body }),
    })),
    url: `${env.publicUrl}/incidents/${incident.id}`,
  };
}

/** Add an id to one of an incident's link lists, or take it off. */
function relink(incident: Incident, field: 'pages' | 'tasks', id: string, remove: boolean, workspaceId: string, ctx: McpCtx): void {
  const current = incident[field] ?? [];
  const next = remove ? current.filter((one) => one !== id) : [...new Set([...current, id])];
  if (next.length === current.length && next.every((one, at) => one === current[at])) return;
  writeEntity('incident', incident.id, { [field]: next }, writeOpts(workspaceId, ctx));
}

const PERSON = { type: 'string', description: 'A member, by name, email or id' };
const WHEN = { type: 'string', description: 'ISO 8601 with a zone (2026-11-27T14:02:00+01:00), or epoch milliseconds' };

/** The fields create and update both take. `summary` is required on create only. */
const INCIDENT_FIELDS = {
  summary: { type: 'string', description: 'One line: what is broken, as the people affected would say it' },
  description: { type: 'string', description: 'What is known: symptoms, error messages, scope' },
  status: { type: 'string', enum: [...INCIDENT_STATUS] },
  priority: { type: 'string', enum: [...INCIDENT_PRIORITIES], description: 'p1 is critical. Left out on create, it is suggested from impact × urgency' },
  impact: { type: 'string', enum: [...INCIDENT_IMPACTS], description: 'How many are hit' },
  urgency: { type: 'string', enum: [...INCIDENT_URGENCIES], description: 'How fast it hurts' },
  category: { type: 'string', enum: [...INCIDENT_CATEGORIES] },
  major: { type: 'boolean', description: 'A major incident: its own call, its own communication, its own review' },
  applications: { type: 'array', items: { type: 'string' }, description: 'Affected applications by name. Names the workspace does not list yet are added to its list' },
  manager: PERSON,
  responders: { type: 'array', items: { type: 'string' }, description: 'Members working on it, by name, email or id' },
  reported_by: { type: 'string', description: 'Who reported it: a person, a customer, a monitor' },
  started_at: { ...WHEN, description: `When people were first hurt. ${WHEN.description}` },
  detected_at: { ...WHEN, description: `When somebody here noticed. Defaults to now on create. ${WHEN.description}` },
  ended_at: { ...WHEN, description: `When the hurting stopped. Set to now on resolve if left empty. ${WHEN.description}` },
  financial_impact: { type: 'string', description: 'What it cost, as an amount ("12 500,00" or "12500.00"). Leave out rather than guess: an unpriced incident is reported as unpriced, not as free' },
  currency: { type: 'string', description: 'ISO 4217, e.g. EUR' },
  affected_users: { type: 'number', description: 'People or customers affected, where somebody counted' },
  resolution_code: { type: 'string', enum: [...INCIDENT_RESOLUTIONS] },
  resolution: { type: 'string', description: 'What was done to restore the service' },
  root_cause: { type: 'string', description: 'Why it happened, once known' },
  workspace_id: { type: 'string' },
};

export const incidentTools: ToolDef[] = [
  {
    name: 'list_incidents',
    title: 'List incidents',
    description:
      'Incidents in the workspace, worst first: still active before resolved, then by priority, a major '
      + 'incident before an ordinary one, then the longest-running. `state` "active" (the default) is '
      + 'everything still being worked — new, investigating, identified, monitoring, on hold; "review" is '
      + 'resolved but not closed, i.e. a post-incident review is still owed. `impact_duration` is still '
      + 'counting when `impact_ongoing` is true.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['active', 'review', 'resolved', 'closed', 'all'], description: 'Defaults to active' },
        priority: { type: 'string', enum: [...INCIDENT_PRIORITIES] },
        application: { type: 'string', description: 'Only incidents affecting this application, by name or id' },
        manager: PERSON,
        days: { type: 'number', description: 'Only incidents opened in the last this many days' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const state = str(args.state) ?? 'active';
      let rows = incidentsIn(workspaceId);
      if (state === 'active') rows = rows.filter(isActive);
      else if (state === 'review') rows = rows.filter((one) => one.status === 'resolved');
      else if (state === 'resolved') rows = rows.filter((one) => one.status === 'resolved' || one.status === 'closed');
      else if (state === 'closed') rows = rows.filter((one) => one.status === 'closed');
      const priority = oneOf(args.priority, INCIDENT_PRIORITIES, 'priority');
      if (priority) rows = rows.filter((one) => one.priority === priority);
      if (str(args.application)) {
        const wanted = String(args.application).toLowerCase();
        const app = applicationsIn(workspaceId).find((one) => one.id === args.application || one.name.toLowerCase() === wanted);
        if (!app) throw new McpError(`No application "${args.application}" in this workspace`);
        rows = rows.filter((one) => (one.applications ?? []).includes(app.id));
      }
      if (str(args.manager)) {
        const manager = String(findMember(String(args.manager), workspaceId).id);
        rows = rows.filter((one) => one.manager_id === manager);
      }
      if (typeof args.days === 'number' && args.days > 0) {
        const since = Date.now() - args.days * 86_400_000;
        rows = rows.filter((one) => (one.started_at ?? one.created_at) >= since);
      }
      rows.sort(byIncidentUrgency);
      const context = lookups(rows, workspaceId);
      return {
        incidents: rows.map((one) => incidentBrief(one, context)),
        active: incidentsIn(workspaceId).filter(isActive).length,
      };
    },
  },
  {
    name: 'get_incident',
    title: 'One incident in full',
    description:
      'One incident with its timeline, the people on it, what it links to and its three clocks: '
      + '`impact_duration` (started → ended), `time_to_detect` (started → detected) and '
      + '`time_to_resolve` (detected → service back, i.e. ended, once resolved). A clock is "—" when one of its ends was never written '
      + 'down, never guessed. Timeline lines of kind "change" were written by the server when the '
      + 'status, priority or manager moved.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        incident: { type: 'string', description: 'INC-12, 12, or its id' },
        workspace_id: { type: 'string' },
      },
      required: ['incident'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      return incidentFull(findIncident(String(args.incident), workspaceId), workspaceId, ctx);
    },
  },
  {
    name: 'create_incident',
    title: 'Open an incident',
    description:
      'Open an incident. The number (INC-n) is assigned by the server. Pass what is known and leave the '
      + 'rest: priority is suggested from impact × urgency when left out, `detected_at` defaults to now. '
      + 'A P1 or a major incident tells every member of the workspace once; the manager and the '
      + 'responders are told they were put on it.',
    schema: {
      type: 'object',
      properties: { ...INCIDENT_FIELDS, first_update: { type: 'string', description: 'A first line for the timeline, if there is something to say already' } },
      required: ['summary'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      if (!str(args.summary)) throw new McpError('An incident needs a summary', -32602);
      return tx(() => {
        const patch = incidentPatch(args, workspaceId, ctx);
        const id = uid();
        writeEntity('incident', id, patch, writeOpts(workspaceId, ctx));
        if (str(args.first_update)) {
          writeEntity('incidentUpdate', uid(), { incident_id: id, kind: 'update', body: str(args.first_update) }, writeOpts(workspaceId, ctx));
        }
        return incidentFull(findIncident(id, workspaceId), workspaceId, ctx);
      });
    },
  },
  {
    name: 'update_incident',
    title: 'Change an incident',
    description:
      'Change any of an incident\'s fields; only what is passed changes. Moving the status, the priority '
      + 'or the manager writes its own line on the timeline. Resolving stamps `resolved_at` and, if '
      + '`ended_at` is empty, sets it to now; going back to an active status clears the stamps. To say '
      + 'something on the timeline, use add_incident_update; to resolve with the paperwork in one go, '
      + 'use resolve_incident.',
    schema: {
      type: 'object',
      properties: { incident: { type: 'string', description: 'INC-12, 12, or its id' }, ...INCIDENT_FIELDS },
      required: ['incident'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const incident = findIncident(String(args.incident), workspaceId);
      const patch = incidentPatch(args, workspaceId, ctx);
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — pass at least one field', -32602);
      writeEntity('incident', incident.id, patch, writeOpts(workspaceId, ctx));
      return incidentFull(findIncident(incident.id, workspaceId), workspaceId, ctx);
    },
  },
  {
    name: 'add_incident_update',
    title: 'Say something on an incident\'s timeline',
    description:
      'A line on the timeline. `kind` "update" is for whoever is waiting — what is known, what is next; '
      + '"note" is a working note among the people fixing it. `occurred_at` backdates the line, for '
      + 'putting a timeline together afterwards ("14:02, the alerts fired"). `status` moves the incident '
      + 'in the same call — the usual shape of a status-page update.',
    schema: {
      type: 'object',
      properties: {
        incident: { type: 'string', description: 'INC-12, 12, or its id' },
        body: { type: 'string' },
        kind: { type: 'string', enum: ['update', 'note'] },
        occurred_at: WHEN,
        status: { type: 'string', enum: [...INCIDENT_STATUS] },
        workspace_id: { type: 'string' },
      },
      required: ['incident', 'body'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const incident = findIncident(String(args.incident), workspaceId);
      const body = str(args.body);
      if (!body) throw new McpError('An update needs something to say', -32602);
      const kind = oneOf(args.kind, ['update', 'note'] as const, 'kind') ?? 'update';
      const status = oneOf(args.status, INCIDENT_STATUS, 'status');
      return tx(() => {
        const at = instantArg(args.occurred_at, 'occurred_at');
        writeEntity('incidentUpdate', uid(), {
          incident_id: incident.id, kind, body, ...(at ? { occurred_at: at } : {}),
        }, writeOpts(workspaceId, ctx));
        if (status && status !== incident.status) writeEntity('incident', incident.id, { status }, writeOpts(workspaceId, ctx));
        return incidentFull(findIncident(incident.id, workspaceId), workspaceId, ctx);
      });
    },
  },
  {
    name: 'resolve_incident',
    title: 'Resolve an incident',
    description:
      'Mark an incident resolved — the service is back — with how it ended. `close: true` closes it '
      + 'instead, which says the review is done too. `resolution` is what was done; `root_cause` is why it '
      + 'happened, if known yet. Leaving the root cause empty on a resolve is honest and common; closing '
      + 'without one is allowed and worth asking about first.',
    schema: {
      type: 'object',
      properties: {
        incident: { type: 'string', description: 'INC-12, 12, or its id' },
        resolution_code: INCIDENT_FIELDS.resolution_code,
        resolution: INCIDENT_FIELDS.resolution,
        root_cause: INCIDENT_FIELDS.root_cause,
        ended_at: INCIDENT_FIELDS.ended_at,
        financial_impact: INCIDENT_FIELDS.financial_impact,
        close: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
      required: ['incident', 'resolution_code', 'resolution'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const incident = findIncident(String(args.incident), workspaceId);
      const patch = incidentPatch({
        resolution_code: args.resolution_code,
        resolution: args.resolution,
        root_cause: args.root_cause,
        ended_at: args.ended_at,
        financial_impact: args.financial_impact,
      }, workspaceId, ctx);
      if (!patch.resolution_code) throw new McpError(`resolution_code is one of: ${INCIDENT_RESOLUTIONS.join(', ')}`, -32602);
      patch.status = args.close === true ? 'closed' : 'resolved';
      writeEntity('incident', incident.id, patch, writeOpts(workspaceId, ctx));
      return incidentFull(findIncident(incident.id, workspaceId), workspaceId, ctx);
    },
  },
  {
    name: 'link_to_incident',
    title: 'Link a page or a task to an incident',
    description:
      'Link a page — the runbook, the knowledge-base article, the review — or a task — a follow-up — to '
      + 'an incident, or take the link off with `remove: true`. Pass `page` or `task`, or both.',
    schema: {
      type: 'object',
      properties: {
        incident: { type: 'string', description: 'INC-12, 12, or its id' },
        page: { type: 'string', description: 'A page, by id or exact title' },
        task: { type: 'string', description: 'A task, by identifier (WEB-12) or id' },
        remove: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
      required: ['incident'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      if (!str(args.page) && !str(args.task)) throw new McpError('Pass a page or a task to link', -32602);
      const remove = args.remove === true;
      return tx(() => {
        if (str(args.page)) {
          const page = findPage(String(args.page), workspaceId, ctx);
          relink(findIncident(String(args.incident), workspaceId), 'pages', String(page.id), remove, workspaceId, ctx);
        }
        if (str(args.task)) {
          const task = findTask(String(args.task), workspaceId, ctx);
          relink(findIncident(String(args.incident), workspaceId), 'tasks', String(task.id), remove, workspaceId, ctx);
        }
        return incidentFull(findIncident(String(args.incident), workspaceId), workspaceId, ctx);
      });
    },
  },
  {
    name: 'create_incident_follow_up',
    title: 'File a follow-up task from an incident',
    description:
      'File a task that stops the incident happening again, in a project, and link it to the incident. '
      + 'The task\'s description names the incident, so the reason for the work travels with it.',
    schema: {
      type: 'object',
      properties: {
        incident: { type: 'string', description: 'INC-12, 12, or its id' },
        project: { type: 'string', description: 'Where the task goes, by key, id or name' },
        title: { type: 'string' },
        description: { type: 'string' },
        assignees: { type: 'array', items: { type: 'string' } },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'] },
        workspace_id: { type: 'string' },
      },
      required: ['incident', 'project', 'title'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const incident = findIncident(String(args.incident), workspaceId);
      return tx(() => {
        const origin = `${incident.identifier}: ${incident.summary} — ${env.publicUrl}/incidents/${incident.id}`;
        const task = fileTask({
          ...args,
          description: [str(args.description), origin].filter(Boolean).join('\n\n'),
        }, workspaceId, ctx);
        relink(incident, 'tasks', String(task.id), false, workspaceId, ctx);
        return { task: { id: task.id, identifier: task.identifier, title: task.title }, incident: incident.identifier };
      });
    },
  },
  {
    name: 'write_incident_review',
    title: 'Write the post-incident review',
    description:
      'File a post-incident review as a page and link it to the incident. Everything the record knows is '
      + 'filled in — the times, the three clocks, the timeline, the follow-ups, the cost — and what only '
      + 'a person can write (the impact in words, the lessons) is left under its heading, marked as still '
      + 'to be written. Do not fill those in yourself. Calling it again rewrites the same page.',
    schema: {
      type: 'object',
      properties: {
        incident: { type: 'string', description: 'INC-12, 12, or its id' },
        parent: { type: 'string', description: 'A page to file it under, by id or exact title' },
        workspace_id: { type: 'string' },
      },
      required: ['incident'],
    },
    destructive: true,
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const incident = findIncident(String(args.incident), workspaceId);
      const t = translatorFor(ctx.auth.userId);
      const zone = String(get<Row>(`SELECT timezone FROM users WHERE id = ?`, ctx.auth.userId)?.timezone ?? '') || 'UTC';
      const formatTime = (at: number): string => {
        const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
        try { return new Intl.DateTimeFormat(localeOf(ctx.auth.userId), { ...options, timeZone: zone }).format(at); }
        catch { return new Intl.DateTimeFormat(localeOf(ctx.auth.userId), { ...options, timeZone: 'UTC' }).format(at); }
      };
      const full = incidentFull(incident, workspaceId, ctx);
      const content = reviewMarkdown({
        incident,
        timeline: full.timeline.map((line) => ({
          at: line.at,
          text: 'field' in line
            ? `${line.field}: ${line.from ?? '—'} → ${line.to ?? '—'}`
            : `${line.author ? `${line.author}: ` : ''}${line.text ?? ''}`,
        })),
        managerName: full.manager,
        applicationNames: full.applications,
        followUps: full.tasks.filter((task) => task.identifier).map((task) => `${task.identifier} ${task.title ?? ''}`.trim()),
        statusLabel: incident.status,
        priorityLabel: incident.priority.toUpperCase(),
        cost: incident.financial_impact === null ? null : formatMoney(incident.financial_impact, incident.currency, localeOf(ctx.auth.userId)),
        formatTime,
      }, {
        title: t('review.title'), summary: t('review.summary'), impact: t('review.impact'), timeline: t('review.timeline'),
        rootCause: t('review.rootCause'), resolution: t('review.resolution'), followUps: t('review.followUps'),
        lessons: t('review.lessons'), priority: t('review.priority'), status: t('review.status'),
        manager: t('review.manager'), applications: t('review.applications'), started: t('review.started'),
        detected: t('review.detected'), ended: t('review.ended'), duration: t('review.duration'),
        timeToDetect: t('review.timeToDetect'), timeToResolve: t('review.timeToResolve'),
        financialImpact: t('review.financialImpact'), affectedUsers: t('review.affectedUsers'),
        none: t('review.none'), toBeWritten: t('review.toBeWritten'),
      });
      const title = `${t('review.title')}: ${incident.identifier} ${incident.summary}`;
      const opts = writeOpts(workspaceId, ctx);

      return tx(() => {
        // The review this tool wrote last time, if it is still linked and still there.
        const existing = (incident.pages ?? [])
          .map((id) => get<Row>(`SELECT id, title, deleted_at FROM pages WHERE id = ?`, id))
          .find((page) => page && !page.deleted_at && String(page.title).startsWith(`${t('review.title')}: ${incident.identifier} `));
        if (existing) {
          writeEntity('page', String(existing.id), { content }, opts);
          return { page_id: existing.id, url: `${env.publicUrl}/pages/${existing.id}`, rewritten: true };
        }
        const parent = str(args.parent) ? findPage(String(args.parent), workspaceId, ctx) : null;
        const { row } = writeEntity('page', uid(), {
          workspace_id: workspaceId,
          project_id: parent?.project_id ?? null,
          parent_id: parent ? String(parent.id) : null,
          title,
          icon: '🧯',
          content,
          format: 'markdown',
          created_by: ctx.auth.userId,
        }, opts);
        relink(incident, 'pages', String(row.id), false, workspaceId, ctx);
        return { page_id: row.id, url: `${env.publicUrl}/pages/${row.id}`, rewritten: false };
      });
    },
  },
  {
    name: 'incident_report',
    title: 'What the incidents add up to',
    description:
      'Incidents over a window, counted: how many, how many still active, how many still owe a review, '
      + 'by priority, category and resolution, the mean time to detect and to resolve, and what they '
      + 'cost per currency. `unpriced` is how many nobody put a figure on — they are not counted as '
      + 'free. Cancelled incidents count towards `total` only. Per application, the same counts.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'The window, by when each incident started. Defaults to 30' },
        application: { type: 'string', description: 'Only this application, by name or id' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : 30;
      const since = Date.now() - days * 86_400_000;
      const apps = applicationsIn(workspaceId);
      let rows = incidentsIn(workspaceId).filter((one) => (one.started_at ?? one.created_at) >= since);
      if (str(args.application)) {
        const wanted = String(args.application).toLowerCase();
        const app = apps.find((one) => one.id === args.application || one.name.toLowerCase() === wanted);
        if (!app) throw new McpError(`No application "${args.application}" in this workspace`);
        rows = rows.filter((one) => (one.applications ?? []).includes(app.id));
      }
      const report = incidentReport(rows);
      const perApplication = apps
        .map((app) => ({ app, hits: rows.filter((one) => (one.applications ?? []).includes(app.id)) }))
        .filter(({ hits }) => hits.length)
        .map(({ app, hits }) => {
          const part = incidentReport(hits);
          return { application: app.name, criticality: app.criticality, incidents: part.total, active: part.active, mttr: formatDuration(part.mttrMs) };
        })
        .sort((a, b) => b.incidents - a.incidents);
      return {
        days,
        ...report,
        mttr: formatDuration(report.mttrMs),
        mttd: formatDuration(report.mttdMs),
        cost: report.cost.map((one) => ({ ...one, formatted: formatMoney(one.amount, one.currency) })),
        per_application: perApplication,
      };
    },
  },
  {
    name: 'list_applications',
    title: 'List the applications incidents are filed against',
    description:
      'The workspace\'s list of applications — the dropdown an incident\'s affected applications are '
      + 'chosen from — most critical first, with how many active incidents each has right now.',
    readOnly: true,
    schema: { type: 'object', properties: { include_archived: { type: 'boolean' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const active = incidentsIn(workspaceId).filter(isActive);
      const apps = applicationsIn(workspaceId).filter((app) => args.include_archived === true || !app.archived).sort(byCriticality);
      const owners = namesOf(apps.map((app) => app.owner_id ?? '').filter(Boolean));
      return {
        applications: apps.map((app) => ({
          id: app.id,
          name: app.name,
          description: app.description,
          criticality: app.criticality,
          owner: app.owner_id ? owners[app.owner_id] ?? app.owner_id : null,
          archived: !!app.archived,
          active_incidents: active.filter((one) => (one.applications ?? []).includes(app.id)).map((one) => one.identifier),
        })),
      };
    },
  },
  {
    name: 'create_application',
    title: 'Add an application to the list',
    description:
      'Add something that can break to the list incidents are filed against: an application, a service, a '
      + 'system people would name when it stops working. Matched without case, so adding one that '
      + 'exists returns the existing one.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        criticality: { type: 'string', enum: [...APPLICATION_CRITICALITY] },
        owner: PERSON,
        workspace_id: { type: 'string' },
      },
      required: ['name'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const name = str(args.name);
      if (!name) throw new McpError('An application needs a name', -32602);
      const criticality = oneOf(args.criticality, APPLICATION_CRITICALITY, 'criticality');
      const owner = str(args.owner) ? String(findMember(String(args.owner), workspaceId).id) : undefined;
      return tx(() => {
        const [id] = applicationIds([name], workspaceId, ctx);
        const patch: Record<string, unknown> = {};
        if (args.description !== undefined) patch.description = str(args.description) ?? null;
        if (criticality) patch.criticality = criticality;
        if (owner) patch.owner_id = owner;
        if (Object.keys(patch).length) writeEntity('application', id, patch, writeOpts(workspaceId, ctx));
        const app = asApplication(get<Row>(`SELECT * FROM applications WHERE id = ?`, id)!);
        return { id: app.id, name: app.name, criticality: app.criticality, description: app.description };
      });
    },
  },
];

/**
 * Something that stopped working, and what the record of it adds up to.
 *
 * The shape `decision.ts` and `meeting.ts` already use: the rows are plain, and
 * every question asked of them more than once is a pure function here, so the
 * screen, the start page and the assistant cannot disagree about which
 * incidents are still burning or how long the last one took to put out.
 *
 * Three rules are decisions rather than mechanics, and worth reading first:
 *
 * **Priority is suggested, not computed.** `priorityFor` is ServiceNow's matrix
 * — impact against urgency — and it is what a new incident starts with. After
 * that the priority is whatever the person running it says. A derived column
 * nobody may correct is the one an incident manager overrides in a side channel
 * at three in the morning, and then the record says P3 about an outage the
 * whole company was on a call for.
 *
 * **Active is a status, not a time.** An incident whose `ended_at` has passed
 * but which nobody moved to resolved is still on the start page, because the
 * question that page answers is "who is still working on something", and a
 * forgotten status is exactly the thing worth seeing there.
 *
 * **A figure nobody entered is not zero.** An incident with no
 * `financial_impact` is unpriced, and `incidentReport` counts it as such rather
 * than adding nothing to the total — the same rule `unallocated` follows in
 * budgets. A month that "cost nothing" because nobody costed it is the report
 * flattering itself.
 */
import {
  INCIDENT_CATEGORIES, INCIDENT_IMPACTS, INCIDENT_PRIORITIES, INCIDENT_RESOLUTIONS, INCIDENT_STATUS,
  INCIDENT_URGENCIES, APPLICATION_CRITICALITY,
  type ApplicationCriticality, type Incident, type IncidentCategory, type IncidentImpact,
  type IncidentPriority, type IncidentResolution, type IncidentStatus, type IncidentUpdate,
  type IncidentUrgency, type Minor,
} from '../../kernel/registry/types.ts';

/** The prefix every incident number wears. One word, so a pasted `INC-12` is found anywhere. */
export const INCIDENT_PREFIX = 'INC';

export const incidentIdentifier = (number: number): string => `${INCIDENT_PREFIX}-${number}`;

/**
 * `INC-12`, `inc 12`, `#12` or `12`, read back as the number.
 *
 * An assistant is handed whatever somebody pasted, and a person pastes the
 * identifier from the email subject as often as the bare number from a chat.
 */
export function incidentNumberOf(ref: string): number | null {
  const match = /^\s*(?:inc[\s-]*|#)?(\d+)\s*$/i.exec(String(ref ?? ''));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

const member = <T extends string>(list: readonly T[]) =>
  (value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

export const isIncidentStatus = member(INCIDENT_STATUS);
export const isIncidentPriority = member(INCIDENT_PRIORITIES);
export const isIncidentImpact = member(INCIDENT_IMPACTS);
export const isIncidentUrgency = member(INCIDENT_URGENCIES);
export const isIncidentCategory = member(INCIDENT_CATEGORIES);
export const isIncidentResolution = member(INCIDENT_RESOLUTIONS);
export const isApplicationCriticality = member(APPLICATION_CRITICALITY);

/**
 * The statuses that still need somebody.
 *
 * `on_hold` is in: waiting for a vendor is still an outage somebody owns.
 * `resolved` is out even though the paperwork is not done — the service is
 * back, and the start page is for what is still down. See `needsReview` for
 * the other half.
 */
const ACTIVE = new Set<IncidentStatus>(['new', 'investigating', 'identified', 'monitoring', 'on_hold']);

export const isActive = (incident: Pick<Incident, 'status'>): boolean => ACTIVE.has(incident.status);

/** Back, but not closed: the review, the root cause and the follow-ups are still owed. */
export const needsReview = (incident: Pick<Incident, 'status'>): boolean => incident.status === 'resolved';

/**
 * ServiceNow's impact × urgency matrix, folded onto four priorities.
 *
 *              urgency high   medium   low
 *   impact high       P1       P2      P3
 *        medium       P2       P3      P4
 *           low       P3       P4      P4
 *
 * Its bottom-right corner is P5, "planning", which is not an incident; it
 * lands on P4 here. A suggestion for a new incident — see the docblock above
 * for why nothing recomputes it afterwards.
 */
export function priorityFor(impact: IncidentImpact, urgency: IncidentUrgency): IncidentPriority {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const sum = rank[impact] + rank[urgency];
  return INCIDENT_PRIORITIES[Math.min(sum, INCIDENT_PRIORITIES.length - 1)];
}

const PRIORITY_RANK = new Map(INCIDENT_PRIORITIES.map((priority, index) => [priority, index]));
const priorityRank = (priority: IncidentPriority): number => PRIORITY_RANK.get(priority) ?? INCIDENT_PRIORITIES.length;

/** Whether a priority is the kind that wakes people up. */
export const isCritical = (incident: Pick<Incident, 'priority' | 'major'>): boolean =>
  incident.priority === 'p1' || !!incident.major;

/**
 * What to look at first.
 *
 * Still burning before put out; then the worse priority; then a major incident
 * before an ordinary one of the same priority; then the one that has been
 * going longest, because an outage in its third hour is a different
 * conversation from one in its third minute. Once they are over, the most
 * recently resolved first — that is the one somebody is about to ask about.
 */
export function byIncidentUrgency(
  a: Pick<Incident, 'status' | 'priority' | 'major' | 'started_at' | 'created_at' | 'resolved_at' | 'number'>,
  b: Pick<Incident, 'status' | 'priority' | 'major' | 'started_at' | 'created_at' | 'resolved_at' | 'number'>,
): number {
  const active = Number(isActive(b)) - Number(isActive(a));
  if (active) return active;
  if (isActive(a)) {
    const priority = priorityRank(a.priority) - priorityRank(b.priority);
    if (priority) return priority;
    const major = Number(!!b.major) - Number(!!a.major);
    if (major) return major;
    return (a.started_at ?? a.created_at) - (b.started_at ?? b.created_at);
  }
  const ended = (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at);
  return ended || (b.number ?? 0) - (a.number ?? 0);
}

/** The timeline, oldest first, as it happened rather than as it was typed. */
export const byOccurrence = (
  a: Pick<IncidentUpdate, 'occurred_at' | 'created_at'>,
  b: Pick<IncidentUpdate, 'occurred_at' | 'created_at'>,
): number => a.occurred_at - b.occurred_at || a.created_at - b.created_at;

/** Applications by how much they matter, then by name — the order the dropdown offers them in. */
export function byCriticality(
  a: { criticality: ApplicationCriticality; name: string },
  b: { criticality: ApplicationCriticality; name: string },
): number {
  const rank = (value: ApplicationCriticality) => (APPLICATION_CRITICALITY as readonly string[]).indexOf(value);
  return rank(a.criticality) - rank(b.criticality) || a.name.localeCompare(b.name);
}

/* -------------------------------------------------------------- the clocks */

export interface IncidentClocks {
  /** How long people were hurt: `started_at` to `ended_at`, or to now while it goes on. */
  impactMs: number | null;
  /** How long it took somebody here to notice. */
  detectMs: number | null;
  /**
   * From noticing — or from the start, when nobody wrote down noticing — to
   * the service being back: `ended_at`, or the resolution stamp when nobody
   * said when it ended. Null while the incident is still active.
   */
  resolveMs: number | null;
  /** Whether `impactMs` is still counting. */
  running: boolean;
}

/**
 * The three durations a review is about.
 *
 * Each is null when one of its ends was never written down, rather than
 * guessed from `created_at`: the row was created when somebody opened the
 * form, which is neither when it started nor when it was noticed, and a
 * duration measured from it would be a measurement of the paperwork.
 *
 * The start of `resolveMs` falls back from detection to the impact's start —
 * both are moments somebody claimed, and a time to resolve with no beginning
 * is the figure people most want.
 *
 * Its end is `ended_at` before `resolved_at`, and that order was measured
 * rather than chosen: an incident written up the next morning is resolved
 * when somebody presses the button, hours after the service came back, and
 * the first walk through the screens reported a mean time to resolve of a day
 * and five hours for an outage that lasted three. Live, the two agree — the
 * write path sets `ended_at` to the moment of resolving when nobody said
 * otherwise — so the stamp is only ever the fallback.
 */
export function incidentClocks(
  incident: Pick<Incident, 'status' | 'started_at' | 'detected_at' | 'ended_at' | 'resolved_at'>,
  now: number = Date.now(),
): IncidentClocks {
  const span = (from: number | null, to: number | null): number | null =>
    from === null || to === null ? null : Math.max(0, to - from);
  const active = isActive(incident);
  const running = incident.ended_at === null && active;
  return {
    impactMs: span(incident.started_at, incident.ended_at ?? (running ? now : null)),
    detectMs: span(incident.started_at, incident.detected_at),
    resolveMs: active ? null : span(incident.detected_at ?? incident.started_at, incident.ended_at ?? incident.resolved_at),
    running,
  };
}

/**
 * A duration as a person says it: `45 min`, `3 h 20 min`, `2 d 4 h`.
 *
 * Two units at most, because "2 days, 4 hours and 13 minutes" is precision
 * nobody acts on, and the units are the short international ones so that the
 * same string reads in all three catalogues.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/* -------------------------------------------------------------- the report */

export interface IncidentReport {
  total: number;
  active: number;
  /** Resolved but not closed: reviews still owed. */
  awaitingReview: number;
  major: number;
  byPriority: Record<IncidentPriority, number>;
  byCategory: Partial<Record<IncidentCategory, number>>;
  byResolution: Partial<Record<IncidentResolution, number>>;
  /** Mean time to resolve, over the incidents that have both ends. Null when none have. */
  mttrMs: number | null;
  /** Mean time to detect, likewise. */
  mttdMs: number | null;
  /** Summed per currency — two currencies are never added together. */
  cost: { currency: string; amount: Minor }[];
  /** Incidents nobody put a figure on. Counted, never costed at zero. */
  unpriced: number;
}

/**
 * What a set of incidents adds up to.
 *
 * The caller chooses the set — a month, an application, a priority — and this
 * only adds. Cancelled incidents are counted in `total` and nowhere else: a
 * false alarm is worth knowing the number of, and is not an outage.
 */
export function incidentReport(
  incidents: readonly Pick<Incident,
    'status' | 'priority' | 'major' | 'category' | 'resolution_code' | 'started_at' | 'detected_at'
    | 'ended_at' | 'resolved_at' | 'financial_impact' | 'currency'>[],
): IncidentReport {
  const byPriority = Object.fromEntries(INCIDENT_PRIORITIES.map((p) => [p, 0])) as Record<IncidentPriority, number>;
  const byCategory: Partial<Record<IncidentCategory, number>> = {};
  const byResolution: Partial<Record<IncidentResolution, number>> = {};
  const cost = new Map<string, Minor>();
  const resolve: number[] = [];
  const detect: number[] = [];
  let active = 0;
  let awaitingReview = 0;
  let major = 0;
  let unpriced = 0;

  for (const incident of incidents) {
    if (isActive(incident)) active++;
    if (needsReview(incident)) awaitingReview++;
    if (incident.status === 'cancelled') continue;
    if (incident.major) major++;
    byPriority[incident.priority] = (byPriority[incident.priority] ?? 0) + 1;
    byCategory[incident.category] = (byCategory[incident.category] ?? 0) + 1;
    if (incident.resolution_code) byResolution[incident.resolution_code] = (byResolution[incident.resolution_code] ?? 0) + 1;
    const clocks = incidentClocks(incident);
    if (clocks.resolveMs !== null) resolve.push(clocks.resolveMs);
    if (clocks.detectMs !== null) detect.push(clocks.detectMs);
    if (incident.financial_impact === null || incident.financial_impact === undefined) unpriced++;
    else cost.set(incident.currency, (cost.get(incident.currency) ?? 0) + incident.financial_impact);
  }

  const mean = (values: number[]): number | null =>
    (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);
  return {
    total: incidents.length,
    active,
    awaitingReview,
    major,
    byPriority,
    byCategory,
    byResolution,
    mttrMs: mean(resolve),
    mttdMs: mean(detect),
    cost: [...cost].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)),
    unpriced,
  };
}

/* ------------------------------------------------------- the review page */

/** The words a post-incident review is written in. Handed in, so each side can use its own catalogue. */
export interface ReviewWords {
  title: string;
  summary: string;
  impact: string;
  timeline: string;
  rootCause: string;
  resolution: string;
  followUps: string;
  lessons: string;
  priority: string;
  status: string;
  manager: string;
  applications: string;
  started: string;
  detected: string;
  ended: string;
  duration: string;
  timeToDetect: string;
  timeToResolve: string;
  financialImpact: string;
  affectedUsers: string;
  none: string;
  toBeWritten: string;
}

export interface ReviewInput {
  incident: Pick<Incident,
    'identifier' | 'summary' | 'description' | 'priority' | 'status' | 'started_at' | 'detected_at'
    | 'ended_at' | 'resolved_at' | 'affected_users' | 'root_cause' | 'resolution'>;
  /** The timeline as it should be printed, already in order and in words. */
  timeline: { at: number; text: string }[];
  managerName: string | null;
  applicationNames: string[];
  /** Follow-ups as they should be linked, already formatted (`WEB-12 Add a retry`). */
  followUps: string[];
  /** Words for the values the page prints: the status and priority as the reader calls them. */
  statusLabel: string;
  priorityLabel: string;
  /** The financial impact, already formatted, or null when nobody costed it. */
  cost: string | null;
  /** How an instant is printed, in the reader's zone and language. */
  formatTime: (at: number) => string;
}

/**
 * A post-incident review, as a page somebody finishes rather than starts.
 *
 * Everything the record already knows is filled in — the times, the durations,
 * the timeline, the follow-ups — and what only a person can write is left as a
 * heading with a prompt under it, rather than as an empty section that reads
 * as finished. The lessons are never filled: an assistant writing "we learned
 * to monitor better" is the review that changes nothing.
 *
 * Markdown, because a page is, and because a review is a document people
 * comment on line by line.
 */
export function reviewMarkdown(input: ReviewInput, words: ReviewWords): string {
  const { incident } = input;
  const clocks = incidentClocks({ ...incident, status: incident.status });
  const when = (at: number | null) => (at === null ? words.none : input.formatTime(at));
  const owed = `_${words.toBeWritten}_`;
  const lines: string[] = [];

  lines.push(`# ${words.title}: ${incident.identifier} ${incident.summary}`, '');
  lines.push(`| | |`, `|---|---|`);
  lines.push(`| ${words.priority} | ${input.priorityLabel} |`);
  lines.push(`| ${words.status} | ${input.statusLabel} |`);
  lines.push(`| ${words.manager} | ${input.managerName ?? words.none} |`);
  lines.push(`| ${words.applications} | ${input.applicationNames.length ? input.applicationNames.join(', ') : words.none} |`);
  lines.push(`| ${words.started} | ${when(incident.started_at)} |`);
  lines.push(`| ${words.detected} | ${when(incident.detected_at)} |`);
  lines.push(`| ${words.ended} | ${when(incident.ended_at)} |`);
  lines.push(`| ${words.duration} | ${formatDuration(clocks.impactMs)} |`);
  lines.push(`| ${words.timeToDetect} | ${formatDuration(clocks.detectMs)} |`);
  lines.push(`| ${words.timeToResolve} | ${formatDuration(clocks.resolveMs)} |`);
  lines.push(`| ${words.financialImpact} | ${input.cost ?? words.none} |`);
  lines.push(`| ${words.affectedUsers} | ${incident.affected_users ?? words.none} |`, '');

  lines.push(`## ${words.summary}`, '', incident.description?.trim() || owed, '');
  lines.push(`## ${words.impact}`, '', owed, '');
  lines.push(`## ${words.timeline}`, '');
  if (input.timeline.length) {
    for (const entry of input.timeline) lines.push(`- **${input.formatTime(entry.at)}** — ${entry.text.replace(/\s*\n\s*/g, ' ')}`);
  } else {
    lines.push(owed);
  }
  lines.push('');
  lines.push(`## ${words.rootCause}`, '', incident.root_cause?.trim() || owed, '');
  lines.push(`## ${words.resolution}`, '', incident.resolution?.trim() || owed, '');
  lines.push(`## ${words.followUps}`, '');
  if (input.followUps.length) for (const task of input.followUps) lines.push(`- [ ] ${task}`);
  else lines.push(owed);
  lines.push('');
  lines.push(`## ${words.lessons}`, '', owed, '');
  return lines.join('\n');
}

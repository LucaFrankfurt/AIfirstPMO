/**
 * A meeting, its agenda, and what is left of both afterwards.
 *
 * The rows are plain — a meeting, and one row per point on its agenda — and
 * the rules here are the three things a screen and an assistant both have to
 * get the same: the order the points are read out in, what carrying the
 * unfinished ones over to the next meeting writes, and what the minutes say.
 * The browser files the minutes as a page from this and so does MCP, so the
 * two cannot produce different documents of the same meeting.
 *
 * **A meeting is not over because its hour has passed.** `status` is what
 * somebody said, the way a decision's `closed` is. A meeting on Tuesday that
 * nobody closed is still on the list on Thursday, because that is the honest
 * description of it: it happened, and nobody wrote down what came out of it.
 *
 * **Carrying over is idempotent by construction.** The point it creates in the
 * next meeting has an id derived from the next meeting and from the point it
 * continues — see `carriedItemId` — so two people pressing the button on two
 * devices, or one person pressing it twice on a train, write the same rows
 * rather than an agenda with every topic on it twice.
 */
import { compareOrder, orderKey } from '../../kernel/registry/order.ts';
import type {
  AgendaItem, AgendaStatus, ID, Meeting,
} from '../../kernel/registry/types.ts';

/** What a new meeting is made of, before the write path adds who and when. */
export type MeetingDraft = Pick<Meeting, 'title' | 'description' | 'location' | 'attendees' | 'starts_at' | 'status' | 'minutes_page_id'>;

/**
 * The order the points are read out in.
 *
 * `compareOrder` and not `localeCompare`, for the reason `byBallotOrder` gives
 * at length: a `sort_order` is a base-62 fraction and only means anything
 * compared byte for byte. `created_at` breaks a tie, which two people adding a
 * topic at the same moment against the same last key can produce.
 */
export const byAgendaOrder = (
  a: Pick<AgendaItem, 'sort_order' | 'created_at'>,
  b: Pick<AgendaItem, 'sort_order' | 'created_at'>,
): number => compareOrder(a.sort_order, b.sort_order) || a.created_at - b.created_at;

/** The live points of one meeting, in agenda order. */
export const agendaOf = (meetingId: ID, items: readonly AgendaItem[]): AgendaItem[] =>
  items.filter((item) => item.meeting_id === meetingId && !item.deleted_at).sort(byAgendaOrder);

/** The highest key on an agenda, or null for an empty one. */
const lastKey = (agenda: readonly Pick<AgendaItem, 'sort_order'>[]): string | null =>
  agenda.reduce<string | null>((last, item) => (last === null || compareOrder(item.sort_order, last) > 0 ? item.sort_order : last), null);

/**
 * The key that puts a new point at the end of an agenda.
 *
 * The highest key rather than the last row's, so a caller that has not sorted
 * — or sorted by something else — still appends rather than landing a topic in
 * the middle of somebody else's.
 */
export const nextAgendaKey = (agenda: readonly Pick<AgendaItem, 'sort_order'>[]): string =>
  orderKey(lastKey(agenda), null);

/** How many points are in each state. `total` is the live ones. */
export function agendaTally(items: readonly Pick<AgendaItem, 'status' | 'deleted_at'>[]): Record<AgendaStatus, number> & { total: number } {
  const out = { open: 0, discussed: 0, deferred: 0, total: 0 };
  for (const item of items) {
    if (item.deleted_at) continue;
    out.total += 1;
    out[item.status in out ? item.status : 'open'] += 1;
  }
  return out;
}

/**
 * The list as it is read: what is still ahead first, soonest first; then what
 * is done, latest first.
 *
 * A meeting with no time yet sorts after the dated ones on the open side,
 * because "Thursday at ten" is more pressing than "some time". A meeting in
 * the past that nobody closed stays on the open side — see the file docblock.
 */
export function meetingsInOrder<T extends Pick<Meeting, 'status' | 'starts_at' | 'created_at' | 'deleted_at'>>(
  meetings: readonly T[],
): { open: T[]; done: T[] } {
  const live = meetings.filter((meeting) => !meeting.deleted_at);
  const when = (meeting: T) => meeting.starts_at ?? null;
  const open = live.filter((meeting) => meeting.status !== 'done').sort((a, b) => {
    const at = when(a);
    const bt = when(b);
    if (at === bt) return a.created_at - b.created_at;
    if (at === null) return 1;
    if (bt === null) return -1;
    return at - bt;
  });
  const done = live.filter((meeting) => meeting.status === 'done')
    .sort((a, b) => (when(b) ?? b.created_at) - (when(a) ?? a.created_at));
  return { open, done };
}

/**
 * Whether a meeting is still open and its day is over — the "nobody closed
 * this" case.
 *
 * Twelve hours rather than the start time itself, so a meeting does not turn
 * into a reproach while people are still sitting in it.
 */
export const isOverdue = (meeting: Pick<Meeting, 'status' | 'starts_at'>, now: number = Date.now()): boolean =>
  meeting.status !== 'done' && meeting.starts_at !== null && meeting.starts_at < now - 12 * 3_600_000;

/**
 * The meeting the unfinished points of `current` would go to.
 *
 * The earliest one still planned that starts after it. Undated meetings are
 * not candidates: "the next meeting" is a question about time, and guessing
 * that a meeting without one comes next would file the points somewhere
 * nobody is looking.
 */
export function nextMeeting<T extends Pick<Meeting, 'id' | 'status' | 'starts_at' | 'deleted_at'>>(
  meetings: readonly T[],
  current: Pick<Meeting, 'id' | 'starts_at'>,
  now: number = Date.now(),
): T | undefined {
  const after = current.starts_at ?? now;
  return meetings
    .filter((meeting) => meeting.id !== current.id && !meeting.deleted_at && meeting.status !== 'done'
      && meeting.starts_at !== null && meeting.starts_at > after)
    .sort((a, b) => (a.starts_at ?? 0) - (b.starts_at ?? 0))[0];
}

/** A week, which is the cadence a meeting with a follow-up nearly always has. */
export const FOLLOW_UP_MS = 7 * 86_400_000;

/**
 * The next meeting of the same kind, when there is not one yet.
 *
 * Same title, place and people, a week later. The description goes too — it
 * says what the meeting is *for*, which a follow-up shares. The minutes do
 * not: they belong to the meeting that had them.
 */
export function followUp(
  meeting: Pick<Meeting, 'title' | 'description' | 'location' | 'attendees' | 'starts_at'>,
  now: number = Date.now(),
): MeetingDraft {
  return {
    title: meeting.title,
    description: meeting.description ?? null,
    location: meeting.location ?? null,
    attendees: [...(meeting.attendees ?? [])],
    starts_at: (meeting.starts_at ?? now) + FOLLOW_UP_MS,
    status: 'planned',
    minutes_page_id: null,
  };
}

/**
 * The topic a point continues, all the way back to where it was first raised.
 *
 * A carried point's id is `<meeting>.<origin>` — see `carriedItemId` — so the
 * origin is whatever follows the first dot. An id with no dot was raised where
 * it is. Ids minted anywhere else here are UUIDs, which have none.
 */
export const originOf = (itemId: ID): ID => {
  const dot = itemId.indexOf('.');
  return dot === -1 ? itemId : itemId.slice(dot + 1);
};

/**
 * The id of a point carried into `meetingId`.
 *
 * Derived rather than random, for the reason `voteId` is: the same point
 * carried into the same meeting from two devices is one row, and pressing the
 * button again is a no-op rather than a duplicate. Built from the *origin*
 * rather than from the point being carried, so a topic deferred five weeks
 * running has an id one meeting long instead of five, and the same topic
 * reaching the same meeting by two routes still lands once.
 */
export const carriedItemId = (meetingId: ID, itemId: ID): ID => `${meetingId}.${originOf(itemId)}`;

/** What one point becomes in the next meeting. */
export interface CarriedPoint {
  id: ID;
  patch: Pick<AgendaItem, 'meeting_id' | 'title' | 'description' | 'projects' | 'assignees' | 'status' | 'carried_from' | 'sort_order'>;
}

/**
 * What carrying the unfinished points of one meeting into another writes.
 *
 * Everything that was not discussed goes — open and deferred alike — and
 * arrives open, at the end of the next agenda, in the order it had. Its notes
 * stay where they were written: they are the record of *that* meeting, and the
 * new point links back to them through `carried_from` rather than copying a
 * conversation into a room that did not have it.
 *
 * A point that was still `open` is marked `deferred` where it was, because
 * that is what happened to it. One already in the next meeting — carried
 * before, from this device or another — is left alone, so running this twice
 * neither duplicates a topic nor moves it.
 */
export function carryOver(
  from: readonly AgendaItem[],
  target: ID,
  already: readonly AgendaItem[],
): { create: CarriedPoint[]; defer: ID[] } {
  const present = new Set(already.filter((item) => !item.deleted_at).map((item) => item.id));
  const unfinished = from.filter((item) => !item.deleted_at && item.status !== 'discussed').sort(byAgendaOrder);
  const create: CarriedPoint[] = [];
  let last = lastKey(already.filter((item) => !item.deleted_at));

  for (const item of unfinished) {
    const id = carriedItemId(target, item.id);
    if (id === item.id || present.has(id)) continue;
    const key = orderKey(last, null);
    last = key;
    create.push({
      id,
      patch: {
        meeting_id: target,
        title: item.title,
        description: item.description ?? null,
        projects: [...(item.projects ?? [])],
        // Whoever was responsible for it still is: a topic deferred is not a
        // topic handed back.
        assignees: [...(item.assignees ?? [])],
        status: 'open',
        carried_from: item.id,
        sort_order: key,
      },
    });
  }

  return {
    create,
    defer: unfinished.filter((item) => item.status === 'open').map((item) => item.id),
  };
}

/* ----------------------------------------------------------------- minutes */

/**
 * The words the minutes are written in.
 *
 * Passed in rather than looked up, because the two callers have two different
 * catalogues — the browser's and the server's — and this file belongs to
 * neither. Everything a person reads goes through here; the markup does not.
 */
export interface MinutesWords {
  /** The meeting's time, already formatted for the reader. Empty for none. */
  when: string;
  attendees: string;
  projects: string;
  assignees: string;
  broughtBy: string;
  notes: string;
  tasks: string;
  continued: string;
  empty: string;
  status: Record<AgendaStatus, string>;
}

/** A task as the minutes list it. */
export interface MinutesTask {
  agenda_item_id: ID | null;
  identifier: string;
  title: string;
  /** Its state's name, and the people on it — both already resolved. */
  state: string;
  assignees: string[];
}

/**
 * The minutes of one meeting, as markdown for a page.
 *
 * One section per point, numbered in agenda order, carrying what the screen
 * shows: where it got to, the projects it is about, who is responsible for
 * it, who brought it, what was written in it and the tasks that came out of
 * it. A point with nothing
 * written and nothing filed still gets its heading and its state — "we did not
 * get to it" is a line of minutes too.
 *
 * Task lines are plain list items and deliberately not `- [ ]` checkboxes. A
 * checkbox on a page is ticked *on the page*, and the minutes would then claim
 * work was done that the task itself says is not.
 *
 * What is passed in is what gets published. Both callers hand over only the
 * tasks and project names of public projects, because the minutes are a
 * workspace page and a private project's work is not the wiki's to show; a
 * project missing from `projects` is left off the point rather than printed
 * as an id.
 */
export function minutesMarkdown(input: {
  meeting: Pick<Meeting, 'title' | 'description' | 'location' | 'attendees'>;
  items: readonly AgendaItem[];
  tasks: readonly MinutesTask[];
  /** User id -> name. Anybody missing is left out rather than shown as an id. */
  people: ReadonlyMap<ID, string>;
  /** Project id -> how it is called in prose, usually its key. */
  projects: ReadonlyMap<ID, string>;
  words: MinutesWords;
}): string {
  const { meeting, people, projects, words } = input;
  const lines: string[] = [];
  // Only the time is bold. The place is often the link to a call, and a link
  // inside `**…**` takes the closing marks with it — the first minutes filed
  // came out bold from the top of the page to the bottom.
  const head = [words.when ? `**${words.when}**` : '', meeting.location?.trim() ?? ''].filter(Boolean).join(' · ');
  if (head) lines.push(head, '');

  const present = (meeting.attendees ?? []).map((id) => people.get(id)).filter((name): name is string => !!name);
  if (present.length) lines.push(`**${words.attendees}:** ${present.join(', ')}`, '');
  if (meeting.description?.trim()) lines.push(meeting.description.trim(), '');

  const agenda = [...input.items].filter((item) => !item.deleted_at).sort(byAgendaOrder);
  if (!agenda.length) lines.push(`_${words.empty}_`, '');

  agenda.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.title.trim() || '—'}`, '');
    const facts = [`_${words.status[item.status] ?? words.status.open}_`];
    const named = (item.projects ?? []).map((id) => projects.get(id)).filter((name): name is string => !!name);
    if (named.length) facts.push(`${words.projects}: ${named.join(', ')}`);
    const owners = (item.assignees ?? []).map((id) => people.get(id)).filter((name): name is string => !!name);
    if (owners.length) facts.push(`${words.assignees}: ${owners.join(', ')}`);
    const by = item.created_by ? people.get(item.created_by) : undefined;
    if (by) facts.push(`${words.broughtBy}: ${by}`);
    if (item.carried_from) facts.push(words.continued);
    lines.push(facts.join(' · '), '');

    if (item.description?.trim()) lines.push(item.description.trim(), '');
    if (item.notes?.trim()) lines.push(`### ${words.notes}`, '', item.notes.trim(), '');

    const filed = input.tasks.filter((task) => task.agenda_item_id === item.id);
    if (filed.length) {
      lines.push(`### ${words.tasks}`, '');
      for (const task of filed) {
        const who = task.assignees.length ? ` (${task.assignees.join(', ')})` : '';
        lines.push(`- ${task.identifier} ${task.title} — ${task.state}${who}`);
      }
      lines.push('');
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

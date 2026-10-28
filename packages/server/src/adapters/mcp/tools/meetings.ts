/**
 * Meetings: the agenda, the notes written in it, and what came out of it.
 *
 * Two things worth reading before the tools.
 *
 * **The notes are appended, not rewritten, unless you ask.** An agenda point's
 * notes are a text CRDT that people may be typing into while an assistant
 * writes. `update_agenda_item` takes `notes` to replace them and `append_notes`
 * to add a paragraph, and the second is the one an assistant taking minutes
 * wants: the write path turns a replacement into the smallest edit that reaches
 * the new text, so appending is an insertion at the end and somebody's
 * half-written sentence above it survives.
 *
 * **Carrying over and filing the minutes are the browser's rules, run here.**
 * `carryOver` and `minutesMarkdown` in `@kolibri/shared` are what the meeting
 * screen calls, so an assistant that carries the unfinished points forward
 * writes the same rows a person pressing the button would — the same derived
 * ids included, so doing both is not doing it twice.
 */
import {
  AGENDA_STATUS, MEETING_STATUS, agendaOf, agendaTally, carryOver, followUp, isOverdue, meetingsInOrder,
  minutesMarkdown, nextAgendaKey, nextMeeting,
  type AgendaItem, type AgendaStatus, type Meeting, type MinutesTask,
} from '@kolibri/shared';
import { all, get, tx, type Row } from '../../../kernel/platform/db/index.ts';
import { canSeeProject, serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { env } from '../../../kernel/platform/env.ts';
import { localeOf, translatorFor } from '../../../kernel/i18n/i18n.ts';
import {
  fileTask, findProject, McpError, namesOf, requireFeature, requireWrite, resolveUsers, safeList, str, taskView,
  type McpCtx, type ToolDef, workspaceOf, writeOpts,
} from '../kit.ts';

const asMeeting = (row: Row): Meeting => serialize('meeting', row) as unknown as Meeting;
const asItem = (row: Row): AgendaItem => serialize('agendaItem', row) as unknown as AgendaItem;

/**
 * Meetings are for members, here as at the pull.
 *
 * A guest's token reaches MCP like anybody's, and every read tool below would
 * otherwise hand a client the agenda the sync filter keeps from their device.
 */
function requireMember(ctx: McpCtx, workspaceId: string): void {
  if (ctx.auth.memberships.get(workspaceId) === 'guest') {
    throw new McpError('Meetings are for members of the workspace', -32000);
  }
}

/** The gate every tool here starts with: the switch, then who is asking. */
function enter(args: Record<string, any>, ctx: McpCtx, writing = false): string {
  const workspaceId = workspaceOf(args, ctx);
  requireFeature(workspaceId, 'meetings');
  requireMember(ctx, workspaceId);
  if (writing) requireWrite(ctx, workspaceId);
  return workspaceId;
}

const meetingsIn = (workspaceId: string): Meeting[] =>
  all<Row>(`SELECT * FROM meetings WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId).map(asMeeting);

const itemsOf = (meetingId: string): AgendaItem[] =>
  agendaOf(meetingId, all<Row>(`SELECT * FROM agenda_items WHERE meeting_id = ? AND deleted_at IS NULL`, meetingId).map(asItem));

/**
 * A meeting by id, or by title.
 *
 * A weekly has the same title every week, so a title alone is ambiguous by
 * design. It resolves the way a person means it: the next one still open, and
 * failing that the most recent one closed.
 */
function findMeeting(ref: string, workspaceId: string): Meeting {
  const meetings = meetingsIn(workspaceId);
  const byId = meetings.find((meeting) => meeting.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const { open, done } = meetingsInOrder(meetings.filter((meeting) => meeting.title.toLowerCase() === wanted));
  const now = Date.now();
  const found = open.find((meeting) => (meeting.starts_at ?? now) >= now - 12 * 3_600_000) ?? open[0] ?? done[0];
  if (!found) throw new McpError(`No meeting "${ref}" in this workspace`);
  return found;
}

function findItem(ref: string, workspaceId: string): AgendaItem {
  const row = get<Row>(`SELECT * FROM agenda_items WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, ref, workspaceId);
  if (!row) throw new McpError(`No agenda point "${ref}" in this workspace`);
  const meeting = get<Row>(`SELECT deleted_at FROM meetings WHERE id = ?`, String(row.meeting_id));
  if (!meeting || meeting.deleted_at) throw new McpError('That agenda point belongs to a meeting that is gone');
  return asItem(row);
}

/** A time as an assistant sends one: an ISO string, or epoch milliseconds. */
function instant(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const at = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(at) || at <= 0) throw new McpError(`${field} is not a time — pass an ISO date-time such as 2026-11-03T10:00:00+01:00`);
  return Math.round(at);
}

/** Project keys in, project ids out — refused when one is not there, rather than dropped. */
const projectIds = (refs: unknown, workspaceId: string, ctx: McpCtx): string[] =>
  (Array.isArray(refs) ? refs : []).map((ref) => String(findProject(String(ref), workspaceId, ctx).id));

/**
 * Who a list of tasks and project names is for.
 *
 * A meeting is workspace-wide and a task is not: one filed from a point into a
 * private project is still that project's. So the report names a task, or a
 * project, only where the caller can see it — and the minutes only where
 * *everybody* can, because the minutes are a workspace page and filing them
 * publishes them to whoever reads the wiki, guests included.
 */
type Audience = { caller: string } | 'everybody';

const shows = (audience: Audience, projectId: string, visibility: unknown): boolean =>
  audience === 'everybody' ? visibility === 'public' : canSeeProject(audience.caller, projectId);

/** The tasks that came out of these points, as the minutes and the report list them. */
function tasksFrom(items: AgendaItem[], workspaceId: string, audience: Audience): Row[] {
  if (!items.length) return [];
  return all<Row>(
    `SELECT t.*, p.visibility AS project_visibility FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.agenda_item_id IN (${items.map(() => '?').join(', ')}) AND t.workspace_id = ? AND t.deleted_at IS NULL
      ORDER BY t.created_at`,
    ...items.map((item) => item.id), workspaceId,
  ).filter((task) => shows(audience, String(task.project_id), task.project_visibility));
}

const projectKeys = (workspaceId: string, audience: Audience): Map<string, string> => new Map(
  all<Row>(`SELECT id, key, name, visibility FROM projects WHERE workspace_id = ?`, workspaceId)
    .filter((row) => shows(audience, String(row.id), row.visibility))
    .map((row) => [String(row.id), String(row.key || row.name)]),
);

function meetingSummary(meeting: Meeting) {
  const tally = agendaTally(itemsOf(meeting.id));
  const names = namesOf(meeting.attendees);
  return {
    id: meeting.id,
    title: meeting.title,
    starts_at: meeting.starts_at === null ? null : new Date(meeting.starts_at).toISOString(),
    location: meeting.location,
    status: meeting.status,
    // The case worth naming: it happened, and nobody wrote down what came of it.
    unclosed: isOverdue(meeting),
    attendees: meeting.attendees.map((id) => names[id] ?? id),
    agenda: tally,
    minutes_page_id: meeting.minutes_page_id,
    url: `${env.publicUrl}/meetings/${meeting.id}`,
  };
}

/** One meeting with everything on its agenda, as an assistant reads it. */
function meetingReport(meeting: Meeting, ctx: McpCtx) {
  const audience = { caller: ctx.auth.userId };
  const items = itemsOf(meeting.id);
  const tasks = tasksFrom(items, meeting.workspace_id, audience);
  const keys = projectKeys(meeting.workspace_id, audience);
  const names = namesOf(items.map((item) => item.created_by ?? ''));
  return {
    ...meetingSummary(meeting),
    description: meeting.description,
    items: items.map((item, index) => ({
      number: index + 1,
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status,
      // A project the caller cannot see is left out rather than shown as an id:
      // the id is not theirs to have either.
      projects: item.projects.map((id) => keys.get(id)).filter((key): key is string => !!key),
      brought_by: item.created_by ? names[item.created_by] ?? null : null,
      notes: item.notes ?? '',
      carried_from: item.carried_from,
      tasks: tasks.filter((task) => task.agenda_item_id === item.id).map(taskView),
    })),
  };
}

/** A meeting's time in the reader's own zone and language, for the minutes. */
function spokenTime(at: number | null, userId: string): string {
  if (at === null) return '';
  const zone = String(get<Row>(`SELECT timezone FROM users WHERE id = ?`, userId)?.timezone ?? '') || 'UTC';
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat(localeOf(userId), { ...options, timeZone: zone }).format(at);
  } catch {
    // A zone this runtime does not know is a stale profile, not a reason to
    // file no minutes.
    return new Intl.DateTimeFormat(localeOf(userId), { ...options, timeZone: 'UTC' }).format(at);
  }
}

export const meetingTools: ToolDef[] = [
  {
    name: 'list_meetings',
    title: 'List meetings',
    description:
      'Every meeting in the workspace: still open first, soonest first, then the closed ones, latest '
      + 'first. `agenda` counts the points by state. `unclosed` is true for a meeting whose day is '
      + 'over and that nobody closed — it happened, and nobody wrote down what came of it, which '
      + 'is worth saying differently from one that is still ahead.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...MEETING_STATUS], description: 'Only meetings in this state' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const { open, done } = meetingsInOrder(meetingsIn(workspaceId));
      const wanted = str(args.status);
      const rows = wanted === 'planned' ? open : wanted === 'done' ? done : [...open, ...done];
      return { meetings: rows.map(meetingSummary), open: open.length };
    },
  },
  {
    name: 'get_meeting',
    title: 'One meeting in full',
    description:
      'A meeting with its agenda in order: each point\'s state, the projects it is about, who '
      + 'brought it, the notes written in it, and the tasks filed from it. `carried_from` names '
      + 'the point it continues when it was carried over from an earlier meeting. A title several '
      + 'meetings share — a weekly — means the next one still open.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        meeting: { type: 'string', description: 'Its id, or its title' },
        workspace_id: { type: 'string' },
      },
      required: ['meeting'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      return meetingReport(findMeeting(String(args.meeting), workspaceId), ctx);
    },
  },
  {
    name: 'create_meeting',
    title: 'Call a meeting',
    description:
      'A meeting with a time, a place and the people expected, and optionally its first topics. '
      + '`starts_at` is an ISO date-time with its offset. `attendees` are ids, emails or names of '
      + 'people in the workspace; anybody who does not match is left off rather than invented.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        starts_at: { type: 'string', description: 'ISO date-time, e.g. 2026-11-03T10:00:00+01:00' },
        location: { type: 'string', description: 'A room, or the link to a call' },
        description: { type: 'string', description: 'What it is for' },
        attendees: { type: 'array', items: { type: 'string' } },
        topics: { type: 'array', items: { type: 'string' }, description: 'Agenda points to start with, in order' },
        workspace_id: { type: 'string' },
      },
      required: ['title'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const opts = writeOpts(workspaceId, ctx);
      const id = uid();
      const people = Array.isArray(args.attendees) ? args.attendees : [];
      tx(() => {
        writeEntity('meeting', id, {
          title: String(args.title).trim() || 'Meeting',
          description: str(args.description) ?? null,
          starts_at: instant(args.starts_at, 'starts_at'),
          location: str(args.location) ?? null,
          attendees: people.length ? resolveUsers(workspaceId, people) : [ctx.auth.userId],
          status: 'planned',
        }, opts);
        const added: AgendaItem[] = [];
        for (const topic of Array.isArray(args.topics) ? args.topics : []) {
          const title = String(topic).trim();
          if (!title) continue;
          const { row } = writeEntity('agendaItem', uid(), {
            meeting_id: id, title, description: null, projects: [], status: 'open', sort_order: nextAgendaKey(added),
          }, opts);
          added.push(asItem(row));
        }
      });
      return meetingReport(findMeeting(id, workspaceId), ctx);
    },
  },
  {
    name: 'update_meeting',
    title: 'Change or close a meeting',
    description:
      'Move a meeting, rename it, change who is expected, or close it with `status: "done"`. '
      + 'Closing is what turns an agenda into a record; reopening is offered because closing the '
      + 'wrong week is the ordinary mistake.',
    schema: {
      type: 'object',
      properties: {
        meeting: { type: 'string', description: 'Its id, or its title' },
        title: { type: 'string' },
        starts_at: { type: 'string', description: 'ISO date-time' },
        location: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'The whole list, replacing the one there' },
        status: { type: 'string', enum: [...MEETING_STATUS] },
        workspace_id: { type: 'string' },
      },
      required: ['meeting'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const meeting = findMeeting(String(args.meeting), workspaceId);
      const patch: Record<string, unknown> = {};
      if (str(args.title)) patch.title = str(args.title);
      if (args.starts_at !== undefined) patch.starts_at = instant(args.starts_at, 'starts_at');
      if (args.location !== undefined) patch.location = str(args.location) ?? null;
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (Array.isArray(args.attendees)) patch.attendees = resolveUsers(workspaceId, args.attendees);
      if (str(args.status)) patch.status = str(args.status);
      writeEntity('meeting', meeting.id, patch, writeOpts(workspaceId, ctx));
      return meetingReport(findMeeting(meeting.id, workspaceId), ctx);
    },
  },
  {
    name: 'add_agenda_item',
    title: 'Put a topic on the agenda',
    description:
      'A point at the end of a meeting\'s agenda, as whoever this token belongs to. `projects` are '
      + 'the projects it is about, by key, id or name — any number, and none is fine.',
    schema: {
      type: 'object',
      properties: {
        meeting: { type: 'string', description: 'Its id, or its title' },
        title: { type: 'string' },
        description: { type: 'string' },
        projects: { type: 'array', items: { type: 'string' } },
        workspace_id: { type: 'string' },
      },
      required: ['meeting', 'title'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const meeting = findMeeting(String(args.meeting), workspaceId);
      const title = String(args.title).trim();
      if (!title) throw new McpError('A topic needs a title');
      const { row } = writeEntity('agendaItem', uid(), {
        meeting_id: meeting.id,
        title,
        description: str(args.description) ?? null,
        projects: projectIds(args.projects, workspaceId, ctx),
        status: 'open',
        sort_order: nextAgendaKey(itemsOf(meeting.id)),
      }, writeOpts(workspaceId, ctx));
      return { item: asItem(row), meeting: meetingSummary(meeting) };
    },
  },
  {
    name: 'update_agenda_item',
    title: 'Work on an agenda point',
    description:
      'Change a point\'s state, title, description or projects, or write in its notes. '
      + '`append_notes` adds a paragraph after what is there and is what to use while people may '
      + 'be typing in the same point; `notes` replaces them, and the previous text is gone from '
      + 'the point. `status` is "open", "discussed" or "deferred".',
    schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The agenda point id' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: [...AGENDA_STATUS] },
        projects: { type: 'array', items: { type: 'string' }, description: 'The whole list, replacing the one there' },
        notes: { type: 'string', description: 'Replaces the notes' },
        append_notes: { type: 'string', description: 'Added as a new paragraph after the notes' },
        workspace_id: { type: 'string' },
      },
      required: ['item'],
    },
    destructive: true,
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const item = findItem(String(args.item), workspaceId);
      const patch: Record<string, unknown> = {};
      if (str(args.title)) patch.title = str(args.title);
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (str(args.status)) patch.status = str(args.status) as AgendaStatus;
      if (Array.isArray(args.projects)) patch.projects = projectIds(args.projects, workspaceId, ctx);
      if (typeof args.notes === 'string') patch.notes = args.notes;
      if (str(args.append_notes)) {
        const before = String(patch.notes ?? item.notes ?? '').trimEnd();
        patch.notes = before ? `${before}\n\n${String(args.append_notes).trim()}` : String(args.append_notes).trim();
      }
      const { row } = writeEntity('agendaItem', item.id, patch, writeOpts(workspaceId, ctx));
      return asItem(row);
    },
  },
  {
    name: 'create_task_from_agenda_item',
    title: 'File a task from an agenda point',
    description:
      'A task that came out of a meeting, remembered as having come out of it: the meeting shows '
      + 'it under the point, the minutes list it, and the task links back. `project` defaults to '
      + 'the first project the point is about; `title` defaults to the point\'s own. Otherwise it '
      + 'takes what create_task takes.',
    schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The agenda point id' },
        title: { type: 'string' },
        project: { type: 'string', description: 'Project id, key or name' },
        description: { type: 'string', description: 'Markdown' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'User ids, emails or names' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        priority: { type: 'string' },
        workspace_id: { type: 'string' },
      },
      required: ['item'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const item = findItem(String(args.item), workspaceId);
      const project = str(args.project) ?? item.projects[0];
      if (!project) throw new McpError('Which project? This point is about none — pass `project`');
      const task = fileTask(
        { ...args, title: str(args.title) ?? item.title, quick_add: undefined },
        workspaceId, ctx, project, undefined, { agenda_item_id: item.id },
      );
      return taskView(task);
    },
  },
  {
    name: 'carry_over_agenda',
    title: 'Carry the unfinished points forward',
    description:
      'Everything on a meeting\'s agenda that was not discussed goes onto the next meeting\'s, at '
      + 'the end and open, and what was still open here is marked deferred. Its notes stay where '
      + 'they were written. `to` names the meeting to carry into; left out, it is the next one '
      + 'still planned after this, and if there is none a follow-up is called a week later with '
      + 'the same title, place and people. Running it twice does not carry anything twice.',
    schema: {
      type: 'object',
      properties: {
        meeting: { type: 'string', description: 'Its id, or its title' },
        to: { type: 'string', description: 'The meeting to carry into, by id or title' },
        workspace_id: { type: 'string' },
      },
      required: ['meeting'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const from = findMeeting(String(args.meeting), workspaceId);
      const opts = writeOpts(workspaceId, ctx);
      return tx(() => {
        let target = str(args.to) ? findMeeting(String(args.to), workspaceId) : nextMeeting(meetingsIn(workspaceId), from);
        let called = false;
        if (!target) {
          const id = uid();
          writeEntity('meeting', id, { ...followUp(from) }, opts);
          target = findMeeting(id, workspaceId);
          called = true;
        }
        if (target.id === from.id) throw new McpError('A meeting cannot be carried into itself');
        const plan = carryOver(itemsOf(from.id), target.id, itemsOf(target.id));
        for (const point of plan.create) writeEntity('agendaItem', point.id, { ...point.patch }, opts);
        for (const id of plan.defer) writeEntity('agendaItem', id, { status: 'deferred' }, opts);
        return { carried: plan.create.length, deferred: plan.defer.length, called_follow_up: called, into: meetingReport(target, ctx) };
      });
    },
  },
  {
    name: 'file_meeting_minutes',
    title: 'File the minutes as a page',
    description:
      'Writes the meeting up as a wiki page — each point with its state, projects, who brought '
      + 'it, the notes and the tasks filed from it — and links the page from the meeting. Filed '
      + 'again, the same page is rewritten from the meeting as it now stands, and the previous '
      + 'text stays in that page\'s history. The page is a workspace page, so it follows the '
      + 'wiki\'s rules about who can read it, not the meeting\'s.',
    schema: {
      type: 'object',
      properties: {
        meeting: { type: 'string', description: 'Its id, or its title' },
        workspace_id: { type: 'string' },
      },
      required: ['meeting'],
    },
    destructive: true,
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const meeting = findMeeting(String(args.meeting), workspaceId);
      const t = translatorFor(ctx.auth.userId);
      const items = itemsOf(meeting.id);
      const tasks = tasksFrom(items, workspaceId, 'everybody');
      const people = new Map(Object.entries(namesOf([
        ...meeting.attendees, ...items.map((item) => item.created_by ?? ''), ...tasks.flatMap((task) => safeList(task.assignees)),
      ])));
      const states = new Map(all<Row>(`SELECT id, name FROM states WHERE workspace_id = ?`, workspaceId)
        .map((row) => [String(row.id), String(row.name)]));
      const content = minutesMarkdown({
        meeting,
        items,
        tasks: tasks.map((task): MinutesTask => ({
          agenda_item_id: task.agenda_item_id,
          identifier: String(task.identifier),
          title: String(task.title),
          state: states.get(String(task.state_id)) ?? '',
          assignees: safeList(task.assignees).map((id) => people.get(id)).filter((name): name is string => !!name),
        })),
        people,
        projects: projectKeys(workspaceId, 'everybody'),
        words: {
          when: spokenTime(meeting.starts_at, ctx.auth.userId),
          attendees: t('minutes.attendees'),
          projects: t('minutes.projects'),
          broughtBy: t('minutes.broughtBy'),
          notes: t('minutes.notes'),
          tasks: t('minutes.tasks'),
          continued: t('minutes.continued'),
          empty: t('minutes.empty'),
          status: { open: t('minutes.open'), discussed: t('minutes.discussed'), deferred: t('minutes.deferred') },
        },
      });

      const opts = writeOpts(workspaceId, ctx);
      const existing = meeting.minutes_page_id
        ? get<Row>(`SELECT id, deleted_at FROM pages WHERE id = ?`, meeting.minutes_page_id)
        : undefined;
      return tx(() => {
        let pageId = existing && !existing.deleted_at ? String(existing.id) : null;
        if (pageId) {
          writeEntity('page', pageId, { content }, opts);
        } else {
          pageId = uid();
          writeEntity('page', pageId, {
            title: t('minutes.title', { title: meeting.title }),
            icon: '📝',
            content,
            format: 'markdown',
            access: 'workspace',
            project_id: null,
            parent_id: null,
            created_by: ctx.auth.userId,
          }, opts);
          writeEntity('meeting', meeting.id, { minutes_page_id: pageId }, opts);
        }
        return { page_id: pageId, url: `${env.publicUrl}/pages/${pageId}`, rewritten: !!existing && !existing.deleted_at };
      });
    },
  },
];


/**
 * Due dates, where somebody already looks.
 *
 * A subscribable `.ics` URL, so work with a date on it appears in whatever
 * calendar a person already has open — Google, Apple, Outlook, Thunderbird,
 * DAVx5 on a phone. It is the smallest possible answer to "it does not fit my
 * life", and it is deliberately *not* CalDAV: CalDAV is a write protocol with
 * discovery, ETags and sync-collection reports, and a read-only feed is a
 * fraction of it that covers most of what people actually want.
 *
 * **The URL is the authorisation**, like a share link, and unlike a share link
 * it is pasted into somebody else's software and fetched forever by a machine.
 * So: the token is per person and generated only when asked for, the feed is
 * rate limited by address, it is never cached by anything in between, and
 * regenerating it is one button that makes every copy of the old URL a 404.
 *
 * What it never does is widen what somebody can see. Every query runs as the
 * person the token belongs to, through the same `tasksMatching` a shared link
 * uses, scoped to a workspace they are a member of.
 */
import { all, get, run, type Row } from '../db/index.ts';
import { requireAuth } from '../lib/auth.ts';
import { buildCalendar, ICAL_PRIORITY, type CalendarEntry } from '../lib/ical.ts';
import { forbidden, notFound, type Ctx, type Router } from '../lib/http.ts';
import { token as randomToken } from '../lib/ids.ts';
import { publicOrigin } from '../lib/origin.ts';
import { byAddress, enforce, LIMITS } from '../lib/ratelimit.ts';
import { readFilters, tasksMatching } from '../lib/viewquery.ts';

/** What a state group means to a calendar client. */
const STATUS: Record<string, CalendarEntry['status']> = {
  backlog: 'NEEDS-ACTION',
  unstarted: 'NEEDS-ACTION',
  started: 'IN-PROCESS',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
};

const ics = (ctx: Ctx, body: string, filename: string): undefined => {
  ctx.res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `inline; filename="${filename}"`,
    // A calendar a client re-fetches on a schedule must not be served from
    // anybody's cache: the whole point is that it is current.
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  });
  ctx.res.end(body);
  return undefined;
};

/** The person a feed token belongs to, or nothing. */
const holder = (token: string): Row | undefined =>
  (token.length >= 16
    ? get<Row>(`SELECT id, name, locale FROM users WHERE calendar_token = ? AND deleted_at IS NULL`, token)
    : undefined);

const memberships = (userId: string): string[] =>
  all<Row>(
    `SELECT workspace_id FROM workspace_members WHERE user_id = ? AND deleted_at IS NULL`,
    userId,
  ).map((row) => String(row.workspace_id));

function entriesFor(tasks: Row[], origin: string): CalendarEntry[] {
  return tasks
    .filter((task) => task.due_date)
    .map((task) => ({
      // The task id, so a client updates its copy instead of adding a second
      // one every time the feed is fetched.
      uid: `${task.id}@kolibri`,
      summary: `${task.identifier ? `${task.identifier} ` : ''}${String(task.title ?? '')}`,
      description: [String(task.description ?? '').slice(0, 900), `${origin}/t/${task.id}`]
        .filter(Boolean).join('\n\n'),
      url: `${origin}/t/${task.id}`,
      start: task.start_date ? String(task.start_date) : null,
      due: String(task.due_date),
      status: STATUS[String(task.group_key ?? '')] ?? 'NEEDS-ACTION',
      priority: ICAL_PRIORITY[String(task.priority ?? 'none')] || undefined,
      categories: [String(task.project_name ?? '')].filter(Boolean),
      updatedAt: Number(task.updated_at) || undefined,
    }));
}

export function registerCalendarRoutes(router: Router): void {
  /**
   * The URL to paste into a calendar, and the button that revokes it.
   *
   * `POST` rather than `GET` for both, because both can *create* a token —
   * asking for the URL is what brings it into existence, and a fresh one is
   * what "regenerate" means.
   */
  router.post('/api/me/calendar', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const existing = get<Row>(`SELECT calendar_token FROM users WHERE id = ?`, auth.userId)?.calendar_token;
    const token = existing ? String(existing) : randomToken(24);
    if (!existing) run(`UPDATE users SET calendar_token = ? WHERE id = ?`, token, auth.userId);
    return { url: `${publicOrigin(ctx)}/calendar/${token}.ics` };
  });

  router.post('/api/me/calendar/rotate', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const token = randomToken(24);
    run(`UPDATE users SET calendar_token = ? WHERE id = ?`, token, auth.userId);
    return { url: `${publicOrigin(ctx)}/calendar/${token}.ics` };
  });

  router.delete('/api/me/calendar', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    run(`UPDATE users SET calendar_token = NULL WHERE id = ?`, auth.userId);
    return { url: null };
  });

  /** Whether there is one, for the settings screen — without minting one. */
  router.get('/api/me/calendar', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const existing = get<Row>(`SELECT calendar_token FROM users WHERE id = ?`, auth.userId)?.calendar_token;
    return { url: existing ? `${publicOrigin(ctx)}/calendar/${existing}.ics` : null };
  });

  /**
   * Everything with a due date that is on this person, across every workspace
   * they are in.
   *
   * `?kind=todo` writes `VTODO` instead of `VEVENT`, for a client that wants
   * tasks as tasks rather than as blocks in a grid. `?done=1` includes finished
   * work, which most people want off and some want on for the record.
   */
  router.get('/calendar/:token', (ctx: Ctx) => {
    // The token is unguessable; "unguessable" is not "un-hammerable".
    enforce(ctx, byAddress(ctx, LIMITS.invite, 'calendar'));
    // The `.ics` is for the client, which decides what to do with a URL by
    // looking at the end of it. The router does not care and neither does this.
    const user = holder(String(ctx.params.token ?? '').replace(/\.ics$/, ''));
    if (!user) throw notFound('No such calendar');

    const origin = publicOrigin(ctx);
    const includeDone = ctx.query.get('done') === '1';
    const tasks = memberships(String(user.id)).flatMap((workspaceId) => tasksMatching({
      workspaceId,
      assignedTo: String(user.id),
      withDueDate: true,
      includeDone,
      orderBy: 'due_date',
      limit: 1000,
    }));

    return ics(ctx, buildCalendar({
      name: `Kolibri — ${user.name}`,
      kind: ctx.query.get('kind') === 'todo' ? 'todo' : 'event',
      entries: entriesFor(tasks, origin),
    }), 'kolibri.ics');
  });

  /**
   * One saved view, as a calendar.
   *
   * A view is a question somebody already wrote down — "everything in this
   * cycle", "all the bugs" — so it is the natural second thing to subscribe to,
   * and it costs one lookup on top of the feed that already exists.
   */
  router.get('/calendar/:token/:view', (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.invite, 'calendar'));
    const user = holder(String(ctx.params.token ?? '').replace(/\.ics$/, ''));
    if (!user) throw notFound('No such calendar');

    const viewId = String(ctx.params.view ?? '').replace(/\.ics$/, '');
    const view = get<Row>(`SELECT * FROM views WHERE id = ? AND deleted_at IS NULL`, viewId);
    // Membership, not just existence: the token says who is asking, and a view
    // in a workspace they left is not theirs to read.
    if (!view || !memberships(String(user.id)).includes(String(view.workspace_id))) {
      throw notFound('No such calendar');
    }

    const tasks = tasksMatching({
      workspaceId: String(view.workspace_id),
      projectId: view.project_id ? String(view.project_id) : null,
      filters: readFilters(view.filters),
      includeDone: !!view.show_done,
      withDueDate: true,
      orderBy: 'due_date',
      limit: 1000,
    });

    return ics(ctx, buildCalendar({
      name: `Kolibri — ${String(view.name ?? 'View')}`,
      kind: ctx.query.get('kind') === 'todo' ? 'todo' : 'event',
      entries: entriesFor(tasks, publicOrigin(ctx)),
    }), `${viewId}.ics`);
  });
}

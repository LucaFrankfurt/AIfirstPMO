/**
 * The way in.
 *
 * A commit message that says `fixes WEB-12` should reach WEB-12. That is the
 * one incoming integration worth having, and it is the opposite direction from
 * the webhooks that already exist — so it shares their row (`direction = 'in'`)
 * and their screen, because both are "this workspace talks to that service".
 *
 * The URL is the authorisation: the row's secret is the path. Nothing here
 * reads a signature, because GitHub and GitLab sign differently and a shared
 * secret in an unguessable URL is the same strength as a shared secret in a
 * header — as long as the URL is only ever given to the service that needs it.
 *
 * What arrives is somebody else's JSON, so nothing is trusted: only commit
 * messages are read, only task identifiers are taken out of them, and the most
 * that can happen is a comment and a move to a Done column.
 */
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { serverClock } from '../../../kernel/write-path/bootstrap.ts';
import { requireWorkspace } from '../../../kernel/identity/auth.ts';
import { env } from '../../../kernel/platform/env.ts';
import { badRequest, HttpError, notFound, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { byAddress, enforce, LIMITS } from '../../../kernel/identity/ratelimit.ts';
import { writeEntity } from '../../../kernel/write-path/repo.ts';
import { deliveriesOf, replayDelivery, testHook } from '../webhooks.ts';

/** `WEB-12`, `fixes WEB-12`, `Closes web-12.` — anything that names a task. */
const REFERENCE = /\b([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})\b/g;
/** The words that mean "and it is done", in the two languages this speaks. */
const CLOSING = /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved|erledigt|schließt|schliesst|behebt)\b/i;

interface Commit {
  message: string;
  url?: string;
  author?: string;
}

/**
 * The commits in a push, from GitHub, GitLab or anybody willing to send the
 * same three fields. Deliberately shallow: this reads what it recognises and
 * ignores the rest of somebody else's payload.
 */
function commitsIn(body: any): Commit[] {
  const raw = Array.isArray(body?.commits) ? body.commits : [];
  return raw
    .map((commit: any) => ({
      message: String(commit?.message ?? commit?.title ?? ''),
      url: typeof commit?.url === 'string' ? commit.url : undefined,
      author: String(commit?.author?.name ?? commit?.author?.username ?? commit?.author_name ?? '') || undefined,
    }))
    .filter((commit: Commit) => commit.message.trim());
}

export function registerInboundRoutes(router: Router): void {
  router.post('/api/hooks/:token', async (ctx: Ctx) => {
    // The token is unguessable, but "unguessable" is not "un-hammerable".
    enforce(ctx, byAddress(ctx, LIMITS.invite, 'inbound'));

    const hook = get<Row>(
      `SELECT * FROM webhooks WHERE secret = ? AND direction = 'in' AND enabled = 1 AND deleted_at IS NULL`,
      ctx.params.token,
    );
    if (!hook) throw notFound('No such hook');

    const body = await readJson<any>(ctx, 2 * 1024 * 1024);
    const commits = commitsIn(body);
    if (!commits.length) {
      // A ping, a branch deletion, an event this does not read: accepted and
      // ignored, because answering an error trains people to turn the hook off.
      return { ok: true, linked: 0, closed: 0, ignored: true };
    }

    const opts = () => ({
      workspaceId: String(hook.workspace_id),
      actorId: String(hook.created_by ?? ''),
      hlc: serverClock.now(),
      system: true as const,
    });

    // Only tasks this hook is allowed to touch: its project, or the workspace.
    const tasks = all<Row>(
      hook.project_id
        ? `SELECT id, identifier, project_id, state_id FROM tasks WHERE project_id = ? AND deleted_at IS NULL`
        : `SELECT id, identifier, project_id, state_id FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL`,
      hook.project_id ?? hook.workspace_id,
    );
    const byIdentifier = new Map(tasks.map((task) => [String(task.identifier).toUpperCase(), task]));

    let linked = 0;
    let closed = 0;
    const seen = new Set<string>();

    for (const commit of commits) {
      const first = commit.message.split('\n')[0];
      for (const match of commit.message.matchAll(REFERENCE)) {
        const identifier = `${match[1].toUpperCase()}-${match[2]}`;
        const task = byIdentifier.get(identifier);
        if (!task) continue;

        // One comment per task per push, however many commits mention it.
        const key = `${task.id}:${commit.url ?? first}`;
        if (seen.has(key)) continue;
        seen.add(key);

        writeEntity('comment', uid(), {
          workspace_id: hook.workspace_id,
          task_id: task.id,
          author_id: hook.created_by ?? null,
          body: [
            `**${commit.author ? `${commit.author} ` : ''}committed**: ${first}`,
            commit.url ? `\n\n${commit.url}` : '',
          ].join(''),
        }, opts());
        linked++;

        // "fixes WEB-12" moves it; a bare mention only links.
        const before = commit.message.slice(0, match.index ?? 0);
        if (!CLOSING.test(before.slice(-30))) continue;
        const done = get<Row>(
          `SELECT id FROM states WHERE project_id = ? AND group_key = 'completed' AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`,
          task.project_id,
        );
        if (!done || done.id === task.state_id) continue;
        writeEntity('task', String(task.id), { state_id: done.id }, opts());
        closed++;
      }
    }

    return { ok: true, linked, closed };
  });

  /**
   * The hook's secret, asked for rather than synced.
   *
   * An outgoing hook's secret is what the receiver checks the signature with;
   * an incoming hook's *is* the URL. Either way it is the whole of the
   * authorisation, so it stays off the sync stream — a token that rides along
   * to every device in the workspace is a token in more places than it needs
   * to be — and is handed over once, to an admin, on request.
   */
  router.get('/api/webhooks/:id/secret', (ctx: Ctx) => {
    const hook = get<Row>(`SELECT * FROM webhooks WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
    if (!hook) throw notFound('Hook not found');
    requireWorkspace(ctx, String(hook.workspace_id), 'admin');
    return {
      secret: String(hook.secret ?? ''),
      url: hook.direction === 'in' ? `${env.publicUrl}/api/hooks/${hook.secret}` : null,
    };
  });

  /**
   * What this hook has called out, and what became of each one.
   *
   * Admin, like the secret, and for a milder version of the same reason: a
   * delivery names tasks, and being able to read the log is being able to read
   * them without being in the projects they came from.
   */
  router.get('/api/webhooks/:id/deliveries', (ctx: Ctx) => {
    const hook = hookForAdmin(ctx);
    return { deliveries: deliveriesOf(String(hook.id), Number(ctx.query.get('limit') ?? 20)) };
  });

  /**
   * Send one again.
   *
   * The case this is for: the receiver was down, the retries ran out, somebody
   * fixed it, and the event that was lost is the one the month's numbers need.
   * A replay sends the body as it was recorded — the event, not the row as it
   * has since become — so it is a redelivery and not a new claim about now.
   */
  router.post('/api/webhooks/:id/deliveries/:delivery/replay', (ctx: Ctx) => {
    const hook = hookForAdmin(ctx);
    const row = get<Row>(
      `SELECT id FROM webhook_deliveries WHERE id = ? AND webhook_id = ?`,
      ctx.params.delivery, hook.id,
    );
    if (!row) throw notFound('No such delivery');
    return { delivery: replayDelivery(String(row.id)) };
  });

  /**
   * Try it, now, and say what happened.
   *
   * The same shape as `/api/instance/test/:group` for the relay, the bot and
   * the model: a real request, answered with the sentence the far end gave.
   * A 200 here is the whole of "the URL is right, the address is allowed, and
   * something is listening" — which until now could only be found out by going
   * and changing a task.
   */
  router.post('/api/webhooks/:id/test', async (ctx: Ctx) => {
    const hook = hookForAdmin(ctx);
    if (hook.direction === 'in') throw badRequest('An incoming hook is a URL to be posted to, not one to call');
    const result = await testHook(hook);
    if (!result.ok) throw new HttpError(400, result.detail, 'hook_test_failed');
    return { ok: true, detail: result.detail };
  });
}

/** Both routes above answer to an admin of the hook's workspace, or to nobody. */
function hookForAdmin(ctx: Ctx): Row {
  const hook = get<Row>(`SELECT * FROM webhooks WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
  if (!hook) throw notFound('Hook not found');
  requireWorkspace(ctx, String(hook.workspace_id), 'admin');
  return hook;
}

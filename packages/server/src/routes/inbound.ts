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
import { all, get, type Row } from '../db/index.ts';
import { serverClock } from '../lib/bootstrap.ts';
import { requireWorkspace } from '../lib/auth.ts';
import { env } from '../env.ts';
import { notFound, readJson, type Ctx, type Router } from '../lib/http.ts';
import { uid } from '../lib/ids.ts';
import { byAddress, enforce, LIMITS } from '../lib/ratelimit.ts';
import { writeEntity } from '../lib/repo.ts';

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
}

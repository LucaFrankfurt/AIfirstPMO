/**
 * Workspaces, who is in them, and how somebody gets in.
 *
 * Split out of `auth.ts`, which had grown to eight concerns in one file. This
 * is the one that is still identity: a membership is a fact about a person, and
 * every endpoint here either reads one or changes one. Signing in is next door;
 * mail, Telegram and push moved to their own adapters.
 *
 * `/api/people` sits here rather than with chat because it answers "who has an
 * account on this instance", which is a membership question — see the note on
 * the handler for why the answer is not "who shares a workspace with you".
 */
import type { WorkspaceFeatures, WorkspaceRole } from '@kolibri/shared';
import { all, get, run, type Row } from '../../platform/db/index.ts';
import { env } from '../../platform/env.ts';
import { requireAuth, requireWorkspace, sessionInfo } from '../auth.ts';
import { addMember, createProject, createWorkspace, serverClock } from '../../write-path/bootstrap.ts';
import { featuresOf } from '../../platform/features.ts';
import { badRequest, conflict, forbidden, notFound, readJson, type Router } from '../../platform/http.ts';
import { shortCode, uid } from '../../platform/ids.ts';
import { isEmailAddress } from '../../mail/address.ts';
import { byAddress, enforce, LIMITS } from '../ratelimit.ts';
import { queueInvite } from '../../../adapters/mail/mail.ts';
import { writeEntity } from '../../write-path/repo.ts';

export function registerWorkspaceRoutes(router: Router): void {
  router.post('/api/workspaces', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ name?: string; slug?: string }>(ctx);
    if (!body.name?.trim()) throw badRequest('Workspace name is required');
    const workspace = createWorkspace(body.name, auth.userId, body.slug);
    createProject(workspace.id, auth.userId, { name: 'Getting started', key: 'GET', icon: '👋' });
    return { workspace, session: sessionInfo(auth.userId) };
  });

  router.patch('/api/workspaces/:id', async (ctx) => {
    requireWorkspace(ctx, ctx.params.id, 'admin');
    const body = await readJson<{ name?: string; logo_url?: string; features?: WorkspaceFeatures }>(ctx);
    const fields = ['name', 'logo_url'].filter((f) => body[f as 'name'] !== undefined);
    if (fields.length) {
      run(
        `UPDATE workspaces SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...fields.map((f) => body[f as 'name']), Date.now(), ctx.params.id,
      );
    }
    if (body.features) {
      // Merged rather than replaced: a client that knows about one switch must
      // not turn off the ones it has never heard of.
      const row = get<Row>(`SELECT settings FROM workspaces WHERE id = ?`, ctx.params.id);
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(String(row?.settings ?? '{}')) as Record<string, unknown>; } catch { settings = {}; }
      settings.features = { ...(settings.features as WorkspaceFeatures ?? {}), ...body.features };
      run(`UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ?`, JSON.stringify(settings), Date.now(), ctx.params.id);
    }
    const updated = get<Row>(`SELECT * FROM workspaces WHERE id = ?`, ctx.params.id)!;
    return { ...updated, features: featuresOf(updated) };
  });

  router.get('/api/workspaces/:id/members', (ctx) => {
    requireWorkspace(ctx, ctx.params.id);
    return all<Row>(
      `SELECT m.id, m.role, m.created_at, u.id AS user_id, u.name, u.email, u.avatar_url, u.last_seen_at
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.deleted_at IS NULL
        ORDER BY u.name`,
      ctx.params.id,
    );
  });

  router.patch('/api/workspaces/:id/members/:userId', async (ctx) => {
    requireWorkspace(ctx, ctx.params.id, 'admin');
    const body = await readJson<{ role?: WorkspaceRole }>(ctx);
    const member = get<Row>(`SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, ctx.params.id, ctx.params.userId);
    if (!member) throw notFound('Member not found');
    const owners = all<Row>(`SELECT id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND deleted_at IS NULL`, ctx.params.id);
    if (member.role === 'owner' && owners.length === 1 && body.role !== 'owner') throw conflict('A workspace needs at least one owner');
    writeEntity('member', member.id, { role: body.role ?? 'member' }, {
      workspaceId: ctx.params.id, actorId: requireAuth(ctx).userId, hlc: serverClock.now(), system: true,
    });
    return { ok: true };
  });

  router.delete('/api/workspaces/:id/members/:userId', (ctx) => {
    const auth = requireAuth(ctx);
    if (auth.userId !== ctx.params.userId) requireWorkspace(ctx, ctx.params.id, 'admin');
    const member = get<Row>(`SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, ctx.params.id, ctx.params.userId);
    if (!member) throw notFound('Member not found');
    const owners = all<Row>(`SELECT id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND deleted_at IS NULL`, ctx.params.id);
    if (member.role === 'owner' && owners.length === 1) throw conflict('A workspace needs at least one owner');
    writeEntity('member', member.id, {}, {
      workspaceId: ctx.params.id, actorId: auth.userId, hlc: serverClock.now(), system: true, op: 'delete',
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- people */

  /**
   * Everybody with an account here.
   *
   * A direct conversation is between two people rather than inside an
   * organisation, so who you can write to is not "who shares a workspace with
   * you" — that would mean two colleagues on the same instance had to be put in
   * the same project before they could say hello. It is everybody on the
   * instance, which is what a self-hosted instance *is*: a set of people who
   * work together, with sign-up closed once they all have an account.
   *
   * Two limits on that, both deliberate:
   *
   * - **A guest gets nothing.** The only thing this list is for is starting a
   *   conversation, and a guest cannot write one. Handing them the instance's
   *   address book instead would be a straight leak.
   * - **It is a search, not a dump.** A hundred rows at a time, ordered by
   *   name, so this is a way to find somebody rather than a way to take the
   *   list away.
   */
  router.get('/api/people', (ctx) => {
    const auth = requireAuth(ctx);
    const colleague = get(
      `SELECT 1 FROM workspace_members
        WHERE user_id = ? AND role <> 'guest' AND deleted_at IS NULL`,
      auth.userId,
    );
    if (!colleague) throw forbidden('Guests cannot start conversations');

    const query = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const like = `%${query.replace(/[%_]/g, '')}%`;
    return all<Row>(
      `SELECT id, name, email, avatar_url FROM users
        WHERE deleted_at IS NULL AND id <> ?1
          AND (?2 = '' OR lower(name) LIKE ?3 OR lower(email) LIKE ?3)
        ORDER BY name LIMIT 100`,
      auth.userId, query, like,
    );
  });

  /* --------------------------------------------------------------- invites */

  router.get('/api/workspaces/:id/invites', (ctx) => {
    requireWorkspace(ctx, ctx.params.id, 'admin');
    return all<Row>(
      `SELECT id, email, role, code, created_at, expires_at, accepted_at FROM invites
        WHERE workspace_id = ? AND accepted_at IS NULL ORDER BY created_at DESC`,
      ctx.params.id,
    );
  });

  router.post('/api/workspaces/:id/invites', async (ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.id, 'admin');
    const body = await readJson<{ email?: string; role?: WorkspaceRole; expiresInDays?: number }>(ctx);
    const code = shortCode(10);
    // Validated, and not only because a typo is worth catching: this address
    // is handed to a mail relay, and until now anything at all could be typed
    // into it — including the carriage return that turns one recipient into a
    // relay command. `smtp.ts` refuses it at the socket now too; this is the
    // half that tells the person who typed it.
    const email = body.email?.trim().toLowerCase() || null;
    if (email && !isEmailAddress(email)) throw badRequest('A valid email address is required');
    run(
      `INSERT INTO invites (id, workspace_id, email, role, code, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uid(), ctx.params.id, email, body.role ?? 'member', code, auth.userId,
      Date.now(), Date.now() + (body.expiresInDays ?? 14) * 86_400_000,
    );

    let mailed = false;
    if (email && env.mailEnabled) {
      const workspace = get<Row>(`SELECT name FROM workspaces WHERE id = ?`, ctx.params.id);
      const inviter = get<Row>(`SELECT name, locale FROM users WHERE id = ?`, auth.userId);
      queueInvite({
        code, email,
        workspaceId: ctx.params.id,
        workspaceName: workspace?.name ?? 'a workspace',
        inviterName: inviter?.name ?? 'Someone',
        // The invitee has no account yet, so the inviter's language is the best guess.
        locale: inviter?.locale ?? undefined,
      });
      mailed = true;
    }
    return { code, url: `${env.publicUrl}/invite/${code}`, mailed };
  });

  router.get('/api/invites/:code', (ctx) => {
    // Unauthenticated, and it says whether a code exists — so this, not accept,
    // is where guessing actually happens.
    enforce(ctx, byAddress(ctx, LIMITS.invite, 'invite'));
    const invite = get<Row>(
      `SELECT i.code, i.role, i.email, i.expires_at, i.accepted_at, w.name AS workspace_name
         FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.code = ?`,
      ctx.params.code,
    );
    if (!invite) throw notFound('Invite not found');
    return invite;
  });

  router.post('/api/invites/:code/accept', (ctx) => {
    // Invite codes are short, so guessing them is worth somebody's time.
    enforce(ctx, byAddress(ctx, LIMITS.invite, 'invite'));
    const auth = requireAuth(ctx);
    const workspaceId = acceptInvite(ctx.params.code, auth.userId);
    return { workspaceId, session: sessionInfo(auth.userId) };
  });
}

export function acceptInvite(code: string, userId: string): string {
  const invite = get<Row>(`SELECT * FROM invites WHERE code = ?`, code);
  if (!invite) throw notFound('Invite not found');
  if (invite.accepted_at) throw conflict('This invite has already been used');
  if (invite.expires_at && invite.expires_at < Date.now()) throw conflict('This invite has expired');
  addMember(invite.workspace_id, userId, invite.role);
  run(`UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?`, Date.now(), userId, invite.id);
  return invite.workspace_id;
}

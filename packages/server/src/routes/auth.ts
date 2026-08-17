import type { SessionInfo, WorkspaceRole } from '@kolibri/shared';
import { all, get, run, tx, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import {
  SESSION_COOKIE, createSession, destroySession, hashPassword, hashToken,
  loadMemberships, requireAuth, requireWorkspace, verifyPassword,
} from '../lib/auth.ts';
import { addMember, createProject, createWorkspace, serverClock } from '../lib/bootstrap.ts';
import { badRequest, conflict, cookie, forbidden, notFound, parseCookies, readJson, unauthorized, type Ctx, type Router } from '../lib/http.ts';
import { shortCode, token, uid } from '../lib/ids.ts';
import { pendingCount, queueInvite, queueTestMail, verifyUnsubscribe } from '../lib/mail.ts';
import { serialize, writeEntity } from '../lib/repo.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (row: Row | undefined) => (row ? serialize('user', row) : null);

function sessionInfo(userId: string): SessionInfo {
  const user = get<Row>(`SELECT * FROM users WHERE id = ?`, userId);
  if (!user) throw unauthorized();
  const memberships = loadMemberships(userId);
  const workspaces = all<Row>(
    `SELECT w.* FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = ? AND m.deleted_at IS NULL AND w.deleted_at IS NULL
     ORDER BY w.created_at`,
    userId,
  ).map((w) => ({
    id: w.id, name: w.name, slug: w.slug, logo_url: w.logo_url ?? null, created_at: w.created_at,
    role: (memberships.get(w.id) ?? 'member') as WorkspaceRole,
  }));
  return { user: publicUser(user) as SessionInfo['user'], workspaces };
}

function setSessionCookie(ctx: Ctx, raw: string): void {
  const secure = (ctx.req.headers['x-forwarded-proto'] ?? '').includes('https') || ctx.url.protocol === 'https:';
  ctx.res.setHeader('set-cookie', cookie(SESSION_COOKIE, raw, { maxAge: env.sessionDays * 86_400, secure }));
}

export function registerAuthRoutes(router: Router): void {
  router.get('/api/config', () => ({
    allowSignup: env.allowSignup,
    hasUsers: !!get(`SELECT id FROM users LIMIT 1`),
    maxUploadBytes: env.maxUploadBytes,
    mailEnabled: env.mailEnabled,
    storage: env.storage.kind,
    version: '0.1.0',
  }));

  router.post('/api/auth/register', async (ctx) => {
    const body = await readJson<{ email?: string; name?: string; password?: string; workspace?: string; invite?: string }>(ctx);
    const email = (body.email ?? '').trim().toLowerCase();
    const name = (body.name ?? '').trim() || email.split('@')[0];
    const password = body.password ?? '';
    if (!EMAIL_RE.test(email)) throw badRequest('A valid email address is required');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');

    const firstUser = !get(`SELECT id FROM users LIMIT 1`);
    if (!firstUser && !env.allowSignup && !body.invite) throw forbidden('Sign-up is disabled on this instance');
    if (get(`SELECT id FROM users WHERE email = ?`, email)) throw conflict('That email is already registered');

    const user = tx(() => {
      const id = uid();
      const now = Date.now();
      run(
        `INSERT INTO users (id, email, name, password_hash, is_admin, created_at, updated_at, seq, clocks)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}')`,
        id, email, name, hashPassword(password), firstUser ? 1 : 0, now, now,
      );
      writeEntity('user', id, { name, email }, { workspaceId: '', actorId: id, hlc: serverClock.now(), system: true, silent: true });

      if (body.invite) {
        acceptInvite(body.invite, id);
      } else {
        const workspace = createWorkspace(body.workspace?.trim() || `${name}'s workspace`, id);
        createProject(workspace.id, id, { name: 'Getting started', key: 'GET', icon: '👋' });
      }
      return get<Row>(`SELECT * FROM users WHERE id = ?`, id)!;
    });

    setSessionCookie(ctx, createSession(user.id, ctx.req.headers['user-agent']));
    return sessionInfo(user.id);
  });

  router.post('/api/auth/login', async (ctx) => {
    const body = await readJson<{ email?: string; password?: string }>(ctx);
    const email = (body.email ?? '').trim().toLowerCase();
    const user = get<Row>(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, email);
    if (!user || !verifyPassword(body.password ?? '', user.password_hash)) {
      throw unauthorized('Email or password is incorrect');
    }
    setSessionCookie(ctx, createSession(user.id, ctx.req.headers['user-agent']));
    return sessionInfo(user.id);
  });

  router.post('/api/auth/logout', (ctx) => {
    const raw = parseCookies(ctx.req)[SESSION_COOKIE];
    if (raw) destroySession(raw);
    ctx.res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 }));
    return { ok: true };
  });

  router.get('/api/session', (ctx) => sessionInfo(requireAuth(ctx).userId));

  router.patch('/api/me', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<Record<string, unknown>>(ctx);
    const patch: Record<string, unknown> = {};
    for (const field of ['name', 'avatar_url', 'timezone', 'bio'] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length) {
      writeEntity('user', auth.userId, patch, { workspaceId: '', actorId: auth.userId, hlc: serverClock.now(), system: true });
    }
    // Email preference is not part of the synced profile: it is private to the
    // account and lives only on the server.
    if (typeof body.email_prefs === 'string' && ['all', 'important', 'none'].includes(body.email_prefs)) {
      run(`UPDATE users SET email_prefs = ? WHERE id = ?`, body.email_prefs, auth.userId);
    }
    return sessionInfo(auth.userId);
  });

  router.post('/api/me/password', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ current?: string; next?: string }>(ctx);
    const user = get<Row>(`SELECT * FROM users WHERE id = ?`, auth.userId)!;
    if (!verifyPassword(body.current ?? '', user.password_hash)) throw unauthorized('Current password is incorrect');
    if ((body.next ?? '').length < 8) throw badRequest('New password must be at least 8 characters');
    run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, hashPassword(body.next!), Date.now(), auth.userId);
    run(`DELETE FROM sessions WHERE user_id = ?`, auth.userId); // sign other devices out
    setSessionCookie(ctx, createSession(auth.userId, ctx.req.headers['user-agent']));
    return { ok: true };
  });

  /* ------------------------------------------------------------ API tokens */

  router.get('/api/tokens', (ctx) => {
    const auth = requireAuth(ctx);
    return all<Row>(
      `SELECT id, name, prefix, scopes, workspace_id, created_at, last_used_at, expires_at, revoked_at
         FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      auth.userId,
    );
  });

  /** The plaintext token is returned exactly once — we only store its hash. */
  router.post('/api/tokens', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ name?: string; workspaceId?: string; scopes?: string; expiresInDays?: number }>(ctx);
    if (body.workspaceId) requireWorkspace(ctx, body.workspaceId);
    const raw = `kol_${token(24)}`;
    const id = uid();
    run(
      `INSERT INTO api_tokens (id, user_id, workspace_id, name, token_hash, prefix, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, auth.userId, body.workspaceId ?? null, body.name?.trim() || 'API token', hashToken(raw), raw.slice(0, 12),
      (body.scopes ?? 'read,write'), Date.now(),
      body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null,
    );
    return { id, token: raw, name: body.name ?? 'API token' };
  });

  router.delete('/api/tokens/:id', (ctx) => {
    const auth = requireAuth(ctx);
    run(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?`, Date.now(), ctx.params.id, auth.userId);
    return { ok: true };
  });

  /* ------------------------------------------------------------ workspaces */

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
    const body = await readJson<{ name?: string; logo_url?: string }>(ctx);
    const fields = ['name', 'logo_url'].filter((f) => body[f as 'name'] !== undefined);
    if (fields.length) {
      run(
        `UPDATE workspaces SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...fields.map((f) => body[f as 'name']), Date.now(), ctx.params.id,
      );
    }
    return get<Row>(`SELECT * FROM workspaces WHERE id = ?`, ctx.params.id);
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
    const email = body.email?.trim().toLowerCase() || null;
    run(
      `INSERT INTO invites (id, workspace_id, email, role, code, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uid(), ctx.params.id, email, body.role ?? 'member', code, auth.userId,
      Date.now(), Date.now() + (body.expiresInDays ?? 14) * 86_400_000,
    );

    let mailed = false;
    if (email && env.mailEnabled) {
      const workspace = get<Row>(`SELECT name FROM workspaces WHERE id = ?`, ctx.params.id);
      const inviter = get<Row>(`SELECT name FROM users WHERE id = ?`, auth.userId);
      queueInvite({
        code, email,
        workspaceId: ctx.params.id,
        workspaceName: workspace?.name ?? 'a workspace',
        inviterName: inviter?.name ?? 'Someone',
      });
      mailed = true;
    }
    return { code, url: `${env.publicUrl}/invite/${code}`, mailed };
  });

  router.get('/api/invites/:code', (ctx) => {
    const invite = get<Row>(
      `SELECT i.code, i.role, i.email, i.expires_at, i.accepted_at, w.name AS workspace_name
         FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.code = ?`,
      ctx.params.code,
    );
    if (!invite) throw notFound('Invite not found');
    return invite;
  });

  router.post('/api/invites/:code/accept', (ctx) => {
    const auth = requireAuth(ctx);
    const workspaceId = acceptInvite(ctx.params.code, auth.userId);
    return { workspaceId, session: sessionInfo(auth.userId) };
  });

  /* ----------------------------------------------------------------- mail */

  /**
   * One-click unsubscribe. Signed with the instance secret so the link works
   * from an inbox without a session, and cannot be guessed for someone else.
   */
  const unsubscribe = (ctx: Ctx) => {
    if (!verifyUnsubscribe(ctx.params.userId, ctx.params.token)) throw forbidden('This unsubscribe link is not valid');
    run(`UPDATE users SET email_prefs = 'none' WHERE id = ?`, ctx.params.userId);
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    ctx.res.end(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
       <body style="font-family:system-ui;padding:48px;max-width:36em;margin:0 auto;line-height:1.6">
       <h1 style="font-size:20px">Email notifications are off</h1>
       <p>You will still see everything in your Kolibri inbox. You can turn email back on
       under Settings → Notifications.</p>
       <p><a href="${env.publicUrl || '/'}">Back to Kolibri</a></p>`,
    );
    return undefined;
  };
  router.get('/api/unsubscribe/:userId/:token', unsubscribe);
  router.post('/api/unsubscribe/:userId/:token', unsubscribe);

  /** Admin diagnostics: is mail configured, and does the relay actually accept? */
  router.get('/api/mail/status', (ctx) => {
    const auth = requireAuth(ctx);
    const user = get<Row>(`SELECT email_prefs FROM users WHERE id = ?`, auth.userId);
    return {
      enabled: env.mailEnabled,
      host: env.mailEnabled ? `${env.mail.host}:${env.mail.port}` : null,
      from: env.mail.from,
      batchSeconds: env.mail.batchSeconds,
      pending: pendingCount(),
      preference: user?.email_prefs ?? 'important',
    };
  });

  router.post('/api/mail/test', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.mailEnabled) throw badRequest('No SMTP relay is configured on this instance');
    const user = get<Row>(`SELECT email FROM users WHERE id = ?`, auth.userId);
    queueTestMail(user!.email);
    const { flushQueue } = await import('../lib/mail.ts');
    const result = await flushQueue(5);
    if (!result.sent) {
      const failure = get<Row>(
        `SELECT last_error FROM email_queue WHERE kind = 'test' ORDER BY created_at DESC LIMIT 1`,
      );
      throw badRequest(failure?.last_error ?? 'The relay did not accept the message');
    }
    return { sent: true, to: user!.email };
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

export { sessionInfo };

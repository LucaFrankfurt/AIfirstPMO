import type { SessionInfo, WorkspaceRole } from '@kolibri/shared';
import { all, get, run, tx, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import {
  SESSION_COOKIE, createSession, destroySession, hashPassword, hashToken,
  loadMemberships, requireAuth, requireWorkspace, verifyPassword,
} from '../lib/auth.ts';
import { addMember, createProject, createWorkspace, serverClock } from '../lib/bootstrap.ts';
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyCode } from '../lib/totp.ts';
import {
  authorizeUrl, discover, emailFrom, enabled as oidcEnabled, exchangeCode, groupsFrom, nameFrom,
  parseRoleMap, roleFor, startFlow, verifyIdToken,
} from '../lib/oidc.ts';
import {
  HttpError, badRequest, conflict, cookie, forbidden, notFound, parseCookies, readJson, unauthorized, type Ctx, type Router } from '../lib/http.ts';
import { shortCode, token, uid } from '../lib/ids.ts';
import { byAddress, byValue, enforce, LIMITS } from '../lib/ratelimit.ts';
import { defaultLocale, isLocale, translate } from '../lib/i18n.ts';
import {
  pendingCount, queueInvite, queueTestMail, suppress, suppressions, unsuppress, verifyUnsubscribe,
} from '../lib/mail.ts';
import { keys as pushKeys, subscribe as subscribeDevice, unsubscribe as unsubscribeDevice } from '../lib/push.ts';
import { serialize, writeEntity } from '../lib/repo.ts';
import {
  isPreference as isTelegramPreference,
  sendTest as sendTelegramTest,
  startLink,
  unlink as unlinkTelegram,
} from '../lib/telegram.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (row: Row | undefined) => (row ? serialize('user', row) : null);

/** Recovery codes are stored hashed, as a JSON array. */
function readCodes(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

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
  return {
    // `two_factor` rather than the secret: the registry keeps `totp_secret` and
    // the recovery codes out of the serialised user, and they stay out.
    user: { ...(publicUser(user) as SessionInfo['user']), two_factor: !!user.totp_confirmed_at },
    workspaces,
  };
}

function setSessionCookie(ctx: Ctx, raw: string): void {
  const secure = (ctx.req.headers['x-forwarded-proto'] ?? '').includes('https') || ctx.url.protocol === 'https:';
  ctx.res.setHeader('set-cookie', cookie(SESSION_COOKIE, raw, { maxAge: env.sessionDays * 86_400, secure }));
}

/**
 * Make an account, with its first workspace or against an invite.
 *
 * Shared by the sign-up form and by single sign-on so the two cannot drift:
 * an account made through a provider gets the same starter project, in the
 * same language, as one made with a password.
 */
/**
 * The workspace accounts made through the provider join.
 *
 * Named explicitly if somebody said so; otherwise the instance's *only*
 * workspace, because on a self-hosted instance with one workspace and a company
 * directory pointed at it, "join the one that is here" is the only thing
 * anybody means. With several and no setting, the account gets its own — the
 * same as signing up — rather than this guessing which company you meant.
 */
function ssoWorkspace(): string | null {
  const asked = env.oidc.workspace.trim();
  if (asked) {
    const row = get<Row>(
      `SELECT id FROM workspaces WHERE (id = ? OR slug = ?) AND deleted_at IS NULL`, asked, asked,
    );
    return row ? String(row.id) : null;
  }
  const all_ = all<Row>(`SELECT id FROM workspaces WHERE deleted_at IS NULL LIMIT 2`);
  return all_.length === 1 ? String(all_[0].id) : null;
}

/**
 * Put somebody's workspace role where the directory says it should be.
 *
 * Only when a role map is configured — otherwise the provider has said nothing
 * about roles and Kolibri's own answer stands. When it *is* configured the
 * directory is the authority, which means this demotes as well as promotes:
 * losing a group has to mean losing the access, or the map is decoration.
 *
 * With one exception, and it is not a policy so much as a locked door: the last
 * owner of a workspace is never demoted. A misspelt group name should cost
 * somebody an afternoon, not the instance.
 */
function applyProviderRole(userId: string, role: string, mapped: boolean): void {
  if (!mapped) return;
  for (const membership of all<Row>(
    `SELECT id, workspace_id, role FROM workspace_members WHERE user_id = ? AND deleted_at IS NULL`, userId,
  )) {
    if (membership.role === role) continue;
    if (membership.role === 'owner') {
      const owners = all<Row>(
        `SELECT id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND deleted_at IS NULL`,
        membership.workspace_id,
      ).length;
      if (owners <= 1) continue;
    }
    writeEntity('member', String(membership.id), { role }, {
      workspaceId: String(membership.workspace_id), actorId: userId, hlc: serverClock.now(), system: true,
    });
  }
}

function createAccount(input: {
  email: string;
  name: string;
  /** Null for an account that can only ever sign in through a provider. */
  password: string | null;
  locale: string | null;
  invite?: string;
  workspace?: string;
  /** Join this workspace instead of getting one of your own. */
  joinWorkspace?: string;
  joinAs?: string;
}): Row {
  const firstUser = !get(`SELECT id FROM users LIMIT 1`);
  return tx(() => {
    const id = uid();
    const now = Date.now();
    // The language goes in with the row, not after it: the starter project's
    // workflow, labels and templates are seeded a few lines below, and they
    // read the creator's locale. Setting it afterwards would be too late.
    const locale = isLocale(input.locale) ? input.locale : null;
    run(
      `INSERT INTO users (id, email, name, password_hash, locale, is_admin, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '{}')`,
      id, input.email, input.name, input.password === null ? null : hashPassword(input.password),
      locale, firstUser ? 1 : 0, now, now,
    );
    writeEntity('user', id, { name: input.name, email: input.email, locale },
      { workspaceId: '', actorId: id, hlc: serverClock.now(), system: true, silent: true });

    if (input.invite) {
      acceptInvite(input.invite, id);
    } else if (input.joinWorkspace) {
      // No starter project: this workspace already has whatever it has, and a
      // "Getting started" project per new colleague is noise in a shared one.
      addMember(input.joinWorkspace, id, input.joinAs ?? 'member');
    } else {
      const workspace = createWorkspace(input.workspace?.trim() || `${input.name}'s workspace`, id);
      createProject(workspace.id, id, { name: translate(locale ?? defaultLocale(), 'seed.starterProject'), key: 'GET', icon: '👋' });
    }
    return get<Row>(`SELECT * FROM users WHERE id = ?`, id)!;
  });
}

/** Password sign-in is off when the instance is configured for SSO only. */
const ssoOnly = (): boolean => oidcEnabled() && env.oidc.only;

export function registerAuthRoutes(router: Router): void {
  router.get('/api/config', () => ({
    allowSignup: env.allowSignup,
    hasUsers: !!get(`SELECT id FROM users LIMIT 1`),
    maxUploadBytes: env.maxUploadBytes,
    mailEnabled: env.mailEnabled,
    storage: env.storage.kind,
    sso: oidcEnabled() ? { label: env.oidc.label, only: env.oidc.only } : null,
    version: '0.1.0',
  }));

  router.post('/api/auth/register', async (ctx) => {
    if (ssoOnly()) throw forbidden('This instance signs in through single sign-on');
    enforce(ctx, byAddress(ctx, LIMITS.register, 'register'));
    const body = await readJson<{
      email?: string; name?: string; password?: string; workspace?: string; invite?: string; locale?: string;
    }>(ctx);
    const email = (body.email ?? '').trim().toLowerCase();
    const name = (body.name ?? '').trim() || email.split('@')[0];
    const password = body.password ?? '';
    if (!EMAIL_RE.test(email)) throw badRequest('A valid email address is required');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');

    const firstUser = !get(`SELECT id FROM users LIMIT 1`);
    if (!firstUser && !env.allowSignup && !body.invite) throw forbidden('Sign-up is disabled on this instance');
    if (get(`SELECT id FROM users WHERE email = ?`, email)) throw conflict('That email is already registered');

    const user = createAccount({ email, name, password, locale: body.locale ?? null, invite: body.invite, workspace: body.workspace });

    setSessionCookie(ctx, createSession(user.id, ctx.req.headers['user-agent']));
    return sessionInfo(user.id);
  });

  router.post('/api/auth/login', async (ctx) => {
    // On a single sign-on only instance a password is not a way in — not even
    // for accounts that still carry one from before the switch.
    if (ssoOnly()) throw forbidden('This instance signs in through single sign-on');
    const body = await readJson<{ email?: string; password?: string; code?: string }>(ctx);
    const email = (body.email ?? '').trim().toLowerCase();
    // Two buckets: one machine working through a password list, and a thousand
    // machines working through one account. An IP limit alone is blind to the
    // second, which is the one that gets accounts taken over.
    enforce(ctx, [...byAddress(ctx, LIMITS.login, 'login'), byValue(LIMITS.login, 'login-user', email)]);

    const user = get<Row>(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, email);
    if (!user || !verifyPassword(body.password ?? '', user.password_hash)) {
      throw unauthorized('Email or password is incorrect');
    }

    // Only a *confirmed* second factor gates the door. A half-finished setup
    // must never be able to lock somebody out of their own account.
    if (user.totp_confirmed_at && user.totp_secret) {
      const code = String(body.code ?? '').trim();
      if (!code) throw new HttpError(401, 'A code from your authenticator is needed', 'totp_required');
      if (!verifyCode(String(user.totp_secret), code)) {
        // A recovery code is one use: it is removed whether or not the rest of
        // the sign-in succeeds, because it has been said out loud by then.
        const codes = readCodes(user.recovery_codes);
        const index = codes.indexOf(hashToken(code.toLowerCase().replace(/\s/g, '')));
        if (index === -1) throw unauthorized('That code is not right');
        codes.splice(index, 1);
        run(`UPDATE users SET recovery_codes = ? WHERE id = ?`, JSON.stringify(codes), user.id);
      }
    }

    setSessionCookie(ctx, createSession(user.id, ctx.req.headers['user-agent']));
    return sessionInfo(user.id);
  });

  /* ------------------------------------------------------ single sign-on */

  /**
   * Pending sign-ins, in memory.
   *
   * They live for ten minutes and are used once. In memory because Kolibri is
   * one process by design, and because a half-finished sign-in surviving a
   * restart is not a property worth a table.
   */
  const pending = new Map<string, ReturnType<typeof startFlow>>();
  const PENDING_TTL = 10 * 60_000;

  const redirectUri = (ctx: Ctx): string => {
    const base = env.publicUrl || `http://${ctx.req.headers.host ?? 'localhost'}`;
    return `${base}/api/auth/oidc/callback`;
  };

  router.get('/api/auth/oidc/start', async (ctx) => {
    if (!oidcEnabled()) throw notFound('Single sign-on is not configured');
    enforce(ctx, byAddress(ctx, LIMITS.login, 'oidc'));

    const flow = startFlow(ctx.query.get('next') ?? '/');
    for (const [key, value] of pending) if (Date.now() - value.created_at > PENDING_TTL) pending.delete(key);
    pending.set(flow.state, flow);

    const document = await discover();
    ctx.res.writeHead(302, { location: authorizeUrl(document, flow, redirectUri(ctx)) });
    ctx.res.end();
    return undefined;
  });

  router.get('/api/auth/oidc/callback', async (ctx) => {
    if (!oidcEnabled()) throw notFound('Single sign-on is not configured');

    const fail = (message: string) => {
      // Back to the sign-in screen with something readable rather than a bare
      // 400 in a tab the person cannot get out of.
      ctx.res.writeHead(302, { location: `/?sso_error=${encodeURIComponent(message)}` });
      ctx.res.end();
      return undefined;
    };

    const error = ctx.query.get('error');
    if (error) return fail(ctx.query.get('error_description') ?? error);

    const state = ctx.query.get('state') ?? '';
    const flow = pending.get(state);
    // One use, whatever happens next: a state that can be replayed is a state
    // worth stealing.
    pending.delete(state);
    if (!flow || Date.now() - flow.created_at > PENDING_TTL) return fail('That sign-in took too long — try again');

    try {
      const document = await discover();
      const tokens = await exchangeCode(document, ctx.query.get('code') ?? '', flow.verifier, redirectUri(ctx));
      const claims = await verifyIdToken(document, tokens.id_token, flow.nonce);
      const email = emailFrom(claims);

      const groups = groupsFrom(claims, env.oidc.groupsClaim);
      const map = parseRoleMap(env.oidc.roleMap);
      const asked = roleFor(groups, map);
      // "Only these groups may sign in", written as a default of `none`.
      if (map.size && !asked && env.oidc.defaultRole === 'none') {
        return fail('Your account is not in a group that may use this instance');
      }
      const role = asked ?? (map.size ? env.oidc.defaultRole : 'member');

      let user = get<Row>(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, email);
      if (!user) {
        if (!env.oidc.autoCreate) return fail('There is no account for that address here');
        // No password: this account can only ever be signed into through the
        // provider, which is the point.
        user = createAccount({
          email, name: nameFrom(claims), password: null, locale: null,
          joinWorkspace: ssoWorkspace() ?? undefined,
          joinAs: role,
        });
      }
      applyProviderRole(String(user.id), role, map.size > 0);

      setSessionCookie(ctx, createSession(user.id, ctx.req.headers['user-agent']));
      ctx.res.writeHead(302, { location: flow.next });
      ctx.res.end();
      return undefined;
    } catch (problem) {
      return fail(problem instanceof Error ? problem.message : 'Single sign-on failed');
    }
  });

  router.post('/api/auth/logout', (ctx) => {
    const raw = parseCookies(ctx.req)[SESSION_COOKIE];
    if (raw) destroySession(raw);
    ctx.res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 }));
    return { ok: true };
  });

  router.get('/api/session', (ctx) => sessionInfo(requireAuth(ctx).userId));

  /**
   * The devices signed in as you.
   *
   * The token itself is never returned — only its hash is stored — so the
   * current session is marked by comparing hashes rather than by handing one
   * back and asking the client to match it.
   */
  /**
   * Start setting up a second factor. Returns the secret and the URI to scan;
   * nothing is enforced until a code has been typed back.
   */
  router.post('/api/me/2fa', (ctx) => {
    const auth = requireAuth(ctx);
    const user = get<Row>(`SELECT email, totp_confirmed_at FROM users WHERE id = ?`, auth.userId)!;
    if (user.totp_confirmed_at) throw badRequest('Two-factor is already on');

    const secret = generateSecret();
    run(`UPDATE users SET totp_secret = ? WHERE id = ?`, secret, auth.userId);
    return { secret, uri: otpauthUri(secret, String(user.email)) };
  });

  /** Confirm it by typing a code, and get the recovery codes once. */
  router.post('/api/me/2fa/confirm', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ code?: string }>(ctx);
    const user = get<Row>(`SELECT totp_secret, totp_confirmed_at FROM users WHERE id = ?`, auth.userId)!;
    if (!user.totp_secret) throw badRequest('Start the setup first');
    if (user.totp_confirmed_at) throw badRequest('Two-factor is already on');
    if (!verifyCode(String(user.totp_secret), String(body.code ?? ''))) throw badRequest('That code is not right');

    // Shown once, stored hashed like any other credential.
    const codes = generateRecoveryCodes();
    run(
      `UPDATE users SET totp_confirmed_at = ?, recovery_codes = ? WHERE id = ?`,
      Date.now(), JSON.stringify(codes.map(hashToken)), auth.userId,
    );
    return { recovery_codes: codes };
  });

  /** Turn it off. The current password is required, not just the session. */
  router.post('/api/me/2fa/off', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ password?: string }>(ctx);
    const user = get<Row>(`SELECT password_hash FROM users WHERE id = ?`, auth.userId)!;
    if (!verifyPassword(body.password ?? '', user.password_hash)) throw unauthorized('That password is not right');
    run(
      `UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL, recovery_codes = '[]' WHERE id = ?`,
      auth.userId,
    );
    return { ok: true };
  });

  router.get('/api/sessions', (ctx) => {
    const auth = requireAuth(ctx);
    const raw = parseCookies(ctx.req)[SESSION_COOKIE];
    const mine = raw ? hashToken(raw) : '';
    return all<Row>(
      `SELECT id, user_agent, created_at, expires_at, last_used_at, token_hash
         FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`,
      auth.userId, Date.now(),
    ).map(({ token_hash, ...row }) => ({ ...row, current: token_hash === mine }));
  });

  router.delete('/api/sessions/:id', (ctx) => {
    const auth = requireAuth(ctx);
    const raw = parseCookies(ctx.req)[SESSION_COOKIE];
    const session = get<Row>(`SELECT * FROM sessions WHERE id = ? AND user_id = ?`, ctx.params.id, auth.userId);
    if (!session) throw notFound('Session not found');

    run(`DELETE FROM sessions WHERE id = ?`, ctx.params.id);
    // Revoking the one you are using signs you out here too, which is what
    // somebody means when they revoke it from this list.
    if (raw && session.token_hash === hashToken(raw)) {
      ctx.res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 }));
    }
    return { ok: true };
  });

  router.patch('/api/me', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<Record<string, unknown>>(ctx);
    const patch: Record<string, unknown> = {};
    for (const field of ['name', 'avatar_url', 'timezone', 'bio'] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    // An unknown locale would silently disable translation, so it is rejected
    // rather than stored: the interface only ever sends one it knows.
    if (body.locale !== undefined) {
      if (body.locale !== null && !isLocale(body.locale)) throw badRequest('Unsupported locale');
      patch.locale = body.locale;
    }
    if (Object.keys(patch).length) {
      writeEntity('user', auth.userId, patch, { workspaceId: '', actorId: auth.userId, hlc: serverClock.now(), system: true });
    }
    // Email preference is not part of the synced profile: it is private to the
    // account and lives only on the server.
    if (typeof body.digest === 'string' && ['off', 'daily', 'weekly'].includes(body.digest)) {
      run(`UPDATE users SET digest = ? WHERE id = ?`, body.digest, auth.userId);
    }
    if (typeof body.email_prefs === 'string' && ['all', 'important', 'none'].includes(body.email_prefs)) {
      run(`UPDATE users SET email_prefs = ? WHERE id = ?`, body.email_prefs, auth.userId);
    }
    if (isTelegramPreference(body.telegram_prefs)) {
      run(`UPDATE users SET telegram_prefs = ? WHERE id = ?`, body.telegram_prefs, auth.userId);
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
      mode: env.mailMode,
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
    const user = get<Row>(`SELECT email, locale FROM users WHERE id = ?`, auth.userId);
    queueTestMail(user!.email, user!.locale ?? undefined);
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

  /* --------------------------------------------------------------- Telegram */

  /**
   * What this account's Telegram connection looks like right now.
   *
   * `enabled` is about the instance — whether an operator configured a bot at
   * all — and `linked` is about this person. Both are needed: "no bot token"
   * and "you have not connected yet" are different problems with different
   * people to talk to, and one message covering both helps neither.
   */
  router.get('/api/telegram/status', (ctx) => {
    const auth = requireAuth(ctx);
    const user = get<Row>(
      `SELECT telegram_chat_id, telegram_prefs, telegram_linked_at FROM users WHERE id = ?`,
      auth.userId,
    );
    return {
      enabled: env.telegramEnabled,
      linked: !!user?.telegram_chat_id,
      linkedAt: user?.telegram_linked_at ?? null,
      preference: user?.telegram_prefs ?? 'all',
    };
  });

  /**
   * Hand out a code and the link that carries it.
   *
   * The chat id never comes from the client — it arrives with the update the
   * person's own Telegram sends. So there is nothing here to forge: the worst
   * a stolen code does is connect the thief's chat to the account it was
   * issued for, which is why it lasts fifteen minutes and is used once.
   */
  router.post('/api/telegram/link', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.telegramEnabled) throw badRequest('No Telegram bot is configured on this instance');
    try {
      const link = await startLink(auth.userId);
      return { url: link.url, code: link.code, expiresAt: link.expiresAt };
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  router.post('/api/telegram/unlink', (ctx) => {
    const auth = requireAuth(ctx);
    unlinkTelegram(auth.userId);
    return { ok: true };
  });

  router.post('/api/telegram/test', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.telegramEnabled) throw badRequest('No Telegram bot is configured on this instance');
    try {
      await sendTelegramTest(auth.userId);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    return { sent: true };
  });

  /* ------------------------------------------------------------ push */

  /**
   * What a browser needs to subscribe, and where to say it did.
   *
   * The key is public by definition — it is what the push service checks the
   * signature against — so this is readable by anybody with a session.
   */
  router.get('/api/push/key', (ctx) => {
    requireAuth(ctx);
    return { enabled: env.push.enabled, key: env.push.enabled ? pushKeys().publicKey : null };
  });

  router.post('/api/push/subscribe', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.push.enabled) throw badRequest('Push is turned off on this instance');
    const body = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(ctx);
    if (!body.endpoint) throw badRequest('endpoint is required');
    subscribeDevice(auth.userId, body as { endpoint: string });
    return { ok: true };
  });

  router.post('/api/push/unsubscribe', async (ctx) => {
    requireAuth(ctx);
    const body = await readJson<{ endpoint?: string }>(ctx);
    if (body.endpoint) unsubscribeDevice(body.endpoint);
    return { ok: true };
  });

  /* --------------------------------------------------------- bounces */

  /**
   * Bounce and complaint reports from a mail provider.
   *
   * Guarded by a shared secret rather than a per-provider signature, because
   * every provider signs differently and this endpoint does one thing: it
   * reads an address and stops writing to it. The shapes below are Postmark's
   * and Amazon SES's, plus the obvious generic one.
   */
  router.post('/api/mail/bounces', async (ctx) => {
    if (!env.bounceToken) throw notFound('Bounce reporting is not configured');
    const offered = String(ctx.req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (offered !== env.bounceToken) throw unauthorized('Wrong token');

    const body = await readJson<any>(ctx, 512 * 1024);
    const reports = readBounces(body);
    for (const report of reports) suppress(report.email, report.reason, report.detail);
    return { ok: true, suppressed: reports.length };
  });

  /** What is being refused, and a way to allow an address again. */
  router.get('/api/mail/suppressions', (ctx) => {
    requireAuth(ctx);
    return suppressions();
  });

  router.delete('/api/mail/suppressions/:email', (ctx) => {
    const auth = requireAuth(ctx);
    // Anybody may un-suppress their own address; an admin may clear any of
    // them. A bounce is usually a full mailbox, and the person it happened to
    // is the one who knows it is fixed.
    const address = decodeURIComponent(ctx.params.email).toLowerCase();
    const me = get<Row>(`SELECT email FROM users WHERE id = ?`, auth.userId);
    const mine = String(me?.email ?? '').toLowerCase() === address;
    if (!mine && !auth.isAdmin && ![...auth.memberships.values()].some((role) => role === 'owner' || role === 'admin')) {
      throw forbidden('Only an admin can clear somebody else’s address');
    }
    unsuppress(address);
    return { ok: true };
  });
}

/**
 * The address and the verdict, out of whichever shape arrived.
 *
 * Only *hard* bounces and complaints suppress: a full mailbox or a greylisting
 * is a bad afternoon, and cutting somebody off for one is worse than the
 * retry.
 */
function readBounces(body: any): { email: string; reason: 'bounce' | 'complaint'; detail?: string }[] {
  const out: { email: string; reason: 'bounce' | 'complaint'; detail?: string }[] = [];
  const add = (email: unknown, reason: 'bounce' | 'complaint', detail?: unknown) => {
    if (typeof email === 'string' && email.includes('@')) {
      out.push({ email, reason, detail: typeof detail === 'string' ? detail : undefined });
    }
  };

  // Postmark: one object, `RecordType` and `Type`.
  if (typeof body?.Type === 'string' || typeof body?.RecordType === 'string') {
    const type = String(body.Type ?? body.RecordType);
    if (/spam|complaint/i.test(type)) add(body.Email ?? body.Recipient, 'complaint', body.Description);
    else if (/hardbounce|bademail|blocked|unsubscribe/i.test(type)) add(body.Email ?? body.Recipient, 'bounce', body.Description);
    return out;
  }

  // Amazon SES via SNS: the interesting part is a JSON string inside `Message`.
  if (typeof body?.Message === 'string') {
    try {
      const inner = JSON.parse(body.Message);
      const kind = String(inner?.notificationType ?? '');
      if (kind === 'Complaint') {
        for (const entry of inner?.complaint?.complainedRecipients ?? []) add(entry?.emailAddress, 'complaint');
      } else if (kind === 'Bounce' && String(inner?.bounce?.bounceType) === 'Permanent') {
        for (const entry of inner?.bounce?.bouncedRecipients ?? []) {
          add(entry?.emailAddress, 'bounce', entry?.diagnosticCode);
        }
      }
    } catch {
      // Not JSON after all. Nothing to do, and nothing worth failing over.
    }
    return out;
  }

  // The obvious shape, for anybody wiring this up by hand.
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    const kind = String(entry?.type ?? entry?.event ?? 'bounce');
    if (/soft|transient|deferred/i.test(kind)) continue;
    add(entry?.email ?? entry?.recipient, /complaint|spam/i.test(kind) ? 'complaint' : 'bounce', entry?.reason);
  }
  return out;
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

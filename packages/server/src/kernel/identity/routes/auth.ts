/**
 * Signing in, and everything about the account you signed in as.
 *
 * Seventeen endpoints: registration, password and single sign-on, the session
 * cookie, two-factor, the device list, the profile, and API tokens. It was
 * forty-one, because eight concerns had collected in one file — workspaces and
 * invites are `workspaces.ts` now, and mail, Telegram and push are route files
 * of their own beside the adapters they belong to.
 *
 * What is left is one concern with one thread through it: proving who somebody
 * is, and letting them change what that proof is.
 */
import { all, get, run, tx, type Row } from '../../platform/db/index.ts';
import { env } from '../../platform/env.ts';
import { overTls } from '../../platform/origin.ts';
import { leave } from '../../../modules/chat/presence.ts';
import {
  createSession, destroySession, hashPassword, hashToken, requireAuth, requireWorkspace,
  sessionInfo, SESSION_COOKIE, verifyPassword,
} from '../auth.ts';
import { acceptInvite } from './workspaces.ts';
import { addMember, createProject, createWorkspace, serverClock } from '../../write-path/bootstrap.ts';
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyCode } from '../totp.ts';
import {
  authorizeUrl, discover, emailFrom, enabled as oidcEnabled, exchangeCode, groupsFrom, nameFrom,
  parseRoleMap, roleFor, startFlow, verifyIdToken,
} from '../../../adapters/oauth/oidc.ts';
import {
  HttpError, badRequest, conflict, cookie, forbidden, notFound, parseCookies, readJson, unauthorized, type Ctx, type Router } from '../../platform/http.ts';
import { token, uid } from '../../platform/ids.ts';
import { isEmailAddress } from '../../../adapters/mail/address.ts';
import { byAddress, byValue, enforce, LIMITS } from '../ratelimit.ts';
import { defaultLocale, isLocale, translate } from '../../i18n/i18n.ts';
import { writeEntity } from '../../write-path/repo.ts';
import { isPreference as isTelegramPreference } from '../../../adapters/telegram/telegram.ts';



/** Recovery codes are stored hashed, as a JSON array. */
function readCodes(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function setSessionCookie(ctx: Ctx, raw: string): void {
  // `overTls` rather than `x-forwarded-proto` directly: a proxy that forwards
  // the host and not the scheme used to leave this `false`, and a session
  // cookie without `Secure` is one a browser will send over plain HTTP. It is
  // the same question the OAuth metadata asks, so it is now the same answer.
  ctx.res.setHeader('set-cookie', cookie(SESSION_COOKIE, raw, { maxAge: env.sessionDays * 86_400, secure: overTls(ctx) }));
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
    // Half of what the review button needs: a model exists on this server. The
    // other half is the workspace's own switch, which travels with the
    // workspace rather than with the instance.
    ai: env.aiEnabled ? { provider: env.aiProvider } : null,
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
    if (!isEmailAddress(email)) throw badRequest('A valid email address is required');
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
    // Read who it was before the session is gone, so signing out drops the
    // green dot immediately instead of leaving it lit for another minute.
    const who = raw ? destroySession(raw) : null;
    if (who) leave(who);
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
    /* Keyed to the account and not the address: whoever is guessing here is
       already holding this person's session, so the address tells us nothing
       and charging it would only catch an office behind one NAT. The account
       is the thing being attacked, and the thing worth bounding. */
    enforce(ctx, [byValue(LIMITS.password, 'password-user', auth.userId)]);
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
    // The same guessing surface as `2fa/off`, and the bigger prize: getting the
    // current password right here signs every other device out.
    enforce(ctx, [byValue(LIMITS.password, 'password-user', auth.userId)]);
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
}

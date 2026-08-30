import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { forbidden, unauthorized, type Ctx, parseCookies } from './http.ts';
import { featuresOf } from './features.ts';
import { serialize } from './repo.ts';
import { token, uid } from './ids.ts';
import type { SessionInfo, WorkspaceRole } from '@kolibri/shared';

export const SESSION_COOKIE = 'kolibri_session';

/* --------------------------------------------------------------- passwords */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Tokens are stored hashed so a database leak does not hand out sessions. */
export const hashToken = (value: string): string =>
  createHash('sha256').update(`${value}${env.secret}`).digest('hex');

/**
 * Compare two secrets without leaking where they first differ.
 *
 * `a !== b` returns at the first differing byte, which is a measurable answer
 * to "how much of this did I get right" and therefore a way to learn a secret
 * one byte at a time. The window is small over a network and the fix is one
 * line, so there is no case for the version that only usually works.
 *
 * Lives here rather than beside any one caller because there were two of these
 * already — in `oauth.ts` and in `mail.ts` — and a third route compared with
 * `!==`, which is exactly what happens to a helper nobody can find.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ---------------------------------------------------------------- sessions */

export function createSession(userId: string, userAgent?: string): string {
  const raw = token(32);
  const now = Date.now();
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uid(), userId, hashToken(raw), userAgent?.slice(0, 200) ?? null,
    now, now + env.sessionDays * 86_400_000, now,
  );
  return raw;
}

/** Returns whose session it was, so callers can act on the departure. */
export function destroySession(raw: string): string | null {
  const hash = hashToken(raw);
  const row = get<Row>(`SELECT user_id FROM sessions WHERE token_hash = ?`, hash);
  run(`DELETE FROM sessions WHERE token_hash = ?`, hash);
  return row ? String(row.user_id) : null;
}

/* -------------------------------------------------------------------- auth */

export interface Auth {
  userId: string;
  isAdmin: boolean;
  /** Present for API-token requests. */
  tokenId?: string;
  scopes: Set<string>;
  memberships: Map<string, WorkspaceRole>;
}

export function loadMemberships(userId: string): Map<string, WorkspaceRole> {
  const rows = all<{ workspace_id: string; role: WorkspaceRole }>(
    `SELECT workspace_id, role FROM workspace_members WHERE user_id = ? AND deleted_at IS NULL`,
    userId,
  );
  return new Map(rows.map((r) => [r.workspace_id, r.role]));
}

/** The user as anybody may see them — the registry decides which fields that is. */
const publicUser = (row: Row | undefined) => (row ? serialize('user', row) : null);

/**
 * Everything the client needs to know about who it is talking as.
 *
 * Here rather than in `routes/auth.ts` because two route files answer with it —
 * signing in, and creating or joining a workspace, which changes the list below
 * and therefore has to hand back the new one.
 */
export function sessionInfo(userId: string): SessionInfo {
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
    features: featuresOf(w),
    role: (memberships.get(w.id) ?? 'member') as WorkspaceRole,
  }));
  return {
    // `two_factor` rather than the secret: the registry keeps `totp_secret` and
    // the recovery codes out of the serialised user, and they stay out.
    user: { ...(publicUser(user) as SessionInfo['user']), two_factor: !!user.totp_confirmed_at },
    workspaces,
    instanceAdmin: !!user.is_admin,
  };
}

function bearer(ctx: Ctx): string | null {
  const header = ctx.req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // EventSource cannot set headers, so SSE passes the token as a query param.
  return ctx.query.get('access_token');
}

export function authenticate(ctx: Ctx): Auth | null {
  const raw = bearer(ctx);
  if (raw) {
    const hash = hashToken(raw);
    const now = Date.now();
    const apiToken = get<{ id: string; user_id: string; scopes: string; expires_at: number | null; revoked_at: number | null }>(
      `SELECT id, user_id, scopes, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?`, hash,
    );
    if (apiToken && !apiToken.revoked_at && (!apiToken.expires_at || apiToken.expires_at > now)) {
      run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now, apiToken.id);
      return build(apiToken.user_id, apiToken.scopes.split(','), apiToken.id);
    }
    const session = get<{ id: string; user_id: string; expires_at: number }>(
      `SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?`, hash,
    );
    if (session && session.expires_at > now) {
      run(`UPDATE sessions SET last_used_at = ? WHERE id = ?`, now, session.id);
      return build(session.user_id, ['read', 'write']);
    }
    return null;
  }

  const cookieValue = parseCookies(ctx.req)[SESSION_COOKIE];
  if (!cookieValue) return null;
  const session = get<{ id: string; user_id: string; expires_at: number }>(
    `SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?`, hashToken(cookieValue),
  );
  if (!session || session.expires_at <= Date.now()) return null;
  return build(session.user_id, ['read', 'write']);
}

function build(userId: string, scopes: string[], tokenId?: string): Auth | null {
  const user = get<{ id: string; is_admin: number; deleted_at: number | null }>(
    `SELECT id, is_admin, deleted_at FROM users WHERE id = ?`, userId,
  );
  if (!user || user.deleted_at) return null;
  run(`UPDATE users SET last_seen_at = ? WHERE id = ?`, Date.now(), userId);
  return {
    userId,
    isAdmin: !!user.is_admin,
    tokenId,
    scopes: new Set(scopes.map((s) => s.trim()).filter(Boolean)),
    memberships: loadMemberships(userId),
  };
}

export function requireAuth(ctx: Ctx): Auth {
  if (!ctx.auth) throw unauthorized();
  return ctx.auth;
}

export function requireWorkspace(ctx: Ctx, workspaceId: string, minRole: WorkspaceRole = 'guest'): WorkspaceRole {
  const auth = requireAuth(ctx);
  const role = auth.memberships.get(workspaceId);
  if (!role) throw forbidden('You are not a member of this workspace');
  if (!hasRole(role, minRole)) throw forbidden(`Requires ${minRole} role`);
  return role;
}

const RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
export const hasRole = (role: WorkspaceRole, min: WorkspaceRole): boolean => RANK[role] >= RANK[min];

export function requireWrite(ctx: Ctx): Auth {
  const auth = requireAuth(ctx);
  if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
  return auth;
}

/**
 * Whoever holds the instance, rather than whoever runs a workspace inside it.
 *
 * `is_admin` is the account that claimed the server — the first to sign up, or
 * the one the provisioning variables named. A workspace owner is not that: on
 * an instance where anybody may sign up, everybody is an owner of something,
 * and the relay every workspace sends through is not theirs to point somewhere
 * else.
 */
export function requireInstanceAdmin(ctx: Ctx): Auth {
  const auth = requireWrite(ctx);
  if (!auth.isAdmin) throw forbidden('Only an administrator of this instance may change this');
  return auth;
}

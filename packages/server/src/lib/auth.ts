import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { forbidden, unauthorized, type Ctx, parseCookies } from './http.ts';
import { token, uid } from './ids.ts';
import type { WorkspaceRole } from '@kolibri/shared';

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

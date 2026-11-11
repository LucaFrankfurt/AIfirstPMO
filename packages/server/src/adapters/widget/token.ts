/**
 * The two tokens a widget deals in.
 *
 * **The host's.** A site whose visitors are signed in vouches for them with an
 * HS256 JWT signed with the widget's secret on its own server — every language
 * has a library that makes one, which is the only reason it is a JWT and not
 * something smaller. Verified by hand with `node:crypto`; HS256 only, so a
 * token claiming `alg: none` is refused rather than believed.
 *
 * **Ours.** What the visitor holds afterwards: the conversation it may read,
 * until when, signed with the instance secret. Stateless — no table of
 * sessions for strangers to fill.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../kernel/platform/env.ts';
import { HttpError } from '../../kernel/platform/http.ts';

export interface HostClaims {
  sub: string;
  name: string | null;
  email: string | null;
}

/**
 * The longest a host token may live.
 *
 * The loader asks the host for a token on the first click, so an hour is
 * plenty; a day leaves room for a clock that is off. A token valid for a year
 * is a password in a page's source, and refusing it says so before it leaks.
 */
const MAX_LIFETIME_MS = 24 * 3600_000;

const refuse = (message: string) => new HttpError(401, message, 'invalid_token');

const sign = (key: string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function decode(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* falls through */ }
  throw refuse('The token is not a JWT');
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

export function verifyHostToken(secret: string, jwt: string, now = Date.now()): HostClaims {
  if (!secret) throw refuse('This widget has no secret');
  const parts = String(jwt ?? '').trim().split('.');
  if (parts.length !== 3) throw refuse('The token is not a JWT');
  const [head, body, signature] = parts;
  if (decode(head).alg !== 'HS256') throw refuse('The token must be signed with HS256');
  if (!sameBytes(sign(secret, `${head}.${body}`), Buffer.from(signature, 'base64url'))) {
    throw refuse('The token is not signed with this widget\'s secret');
  }
  const claims = decode(body);
  const exp = Number(claims.exp) * 1000;
  if (!Number.isFinite(exp)) throw refuse('The token has no expiry');
  if (exp <= now) throw refuse('The token has expired');
  if (exp - now > MAX_LIFETIME_MS) throw refuse('The token lives longer than a day; sign a shorter one');
  const sub = text(claims.sub, 200);
  if (!sub) throw refuse('The token names no user (sub)');
  const email = text(claims.email, 254);
  return { sub, name: text(claims.name, 200), email: email && email.includes('@') ? email : null };
}

/* ---------------------------------------------------------------- session */

export interface Session {
  /** Widget id. */
  w: string;
  /** Conversation id. */
  c: string;
  /** Expiry, in milliseconds. */
  exp: number;
}

const SESSION_PURPOSE = 'widget-session:';

export function signSession(session: Session): string {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${body}.${sign(env.secret, SESSION_PURPOSE + body).toString('base64url')}`;
}

/** The session, if it is ours, unexpired and for this widget; otherwise null. */
export function readSession(token: string | null | undefined, widgetId: string, now = Date.now()): Session | null {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;
  if (!sameBytes(sign(env.secret, SESSION_PURPOSE + body), Buffer.from(signature, 'base64url'))) return null;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
    if (session.w !== widgetId || !(session.exp > now) || typeof session.c !== 'string') return null;
    return session;
  } catch {
    return null;
  }
}

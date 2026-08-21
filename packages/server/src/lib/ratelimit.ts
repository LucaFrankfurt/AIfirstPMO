/**
 * Rate limiting for the handful of routes that are worth guessing at.
 *
 * A token bucket per key, in memory. That is the right size for this: Kolibri
 * is one process by design, so there is nothing to share, and a limiter that
 * needs Redis to protect a login form would be the tail wagging the dog.
 *
 * Two keys are checked for a login, not one:
 *
 *   - **per IP**, which stops one machine working through a password list;
 *   - **per account**, which stops a botnet working through *one* account from
 *     a thousand addresses — the case an IP limit is blind to.
 *
 * Both have to have room. A refusal costs a token either way, so a client that
 * keeps hammering after a 429 stays locked out rather than resetting the clock.
 */
import { env } from '../env.ts';
import { HttpError, type Ctx } from './http.ts';

interface Bucket {
  /** Fractional tokens; refilled lazily on read rather than by a timer. */
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

/** Buckets are tiny, but a long-lived process should not grow one per attacker. */
const MAX_KEYS = 20_000;

export interface Limit {
  /** Attempts allowed in a burst. */
  burst: number;
  /** Seconds to earn one token back. */
  everySeconds: number;
  /**
   * Whether a refused attempt still costs a token.
   *
   * True for anything that guards a credential: somebody guessing passwords
   * should be pushed further away by guessing more, and `Retry-After` is a
   * courtesy they have not earned.
   *
   * False where the caller is a program doing something legitimate that we are
   * merely pacing. A client that is told "wait 120 seconds", waits, and is then
   * told to wait again has been lied to — and it will keep retrying, which with
   * this on drives the bucket to `-burst` and turns a two-minute pause into
   * twenty. That is what locked the OAuth registration endpoint.
   */
  deepens?: boolean;
}

/**
 * How much wider the socket-level bucket is than the per-address one.
 *
 * Behind a proxy every legitimate request shares one socket address, so this
 * bucket has to hold the whole instance's traffic — hence the factor. It is not
 * meant to bind in normal use; it is the ceiling on what header spoofing can
 * buy, and a finite ceiling is the entire point.
 */
const SHARED_FACTOR = 20;

/** Deliberately strict: these are the routes where guessing is the attack. */
export const LIMITS = {
  login: { burst: 10, everySeconds: 30 },
  /** Signing up for an account. A credential endpoint: refusals deepen. */
  register: { burst: 5, everySeconds: 120 },
  /**
   * Registering an OAuth client, which is not the same thing at all.
   *
   * Claude on the web registers a fresh client for every connection — its own
   * dialog says so — and every one of those arrives from a handful of shared
   * egress addresses. Five per two minutes for a whole instance is not a
   * safeguard, it is an outage: the fourth person to connect is refused, and
   * because refusals used to deepen the bucket, retrying made it worse.
   *
   * The abuse this needs to stop is not request rate but unbounded rows, and
   * that is handled where it belongs — `pruneClients` in `oauth.ts` caps how
   * many unused registrations may exist at all. So this is generous, honest
   * about its wait, and no longer the thing standing between a person and
   * their connector.
   */
  oauthClient: { burst: 30, everySeconds: 10, deepens: false },
  invite: { burst: 20, everySeconds: 30 },
  /**
   * Submitting an intake form. Tighter than everything else, because it is the
   * only place in the app where somebody with no account at all can write a
   * row — and because nobody reports five bugs a minute by hand.
   */
  intake: { burst: 5, everySeconds: 120 },
} as const satisfies Record<string, Limit>;

function take(key: string, limit: Limit, now: number): boolean {
  const bucket = buckets.get(key) ?? { tokens: limit.burst, updated: now };
  bucket.tokens = Math.min(limit.burst, bucket.tokens + (now - bucket.updated) / (limit.everySeconds * 1000));
  bucket.updated = now;

  const allowed = bucket.tokens >= 1;
  // A refusal still costs by default, so hammering after a 429 does not reset
  // the clock. Where `deepens` is off it costs nothing: the wait we promised
  // stays the wait, however many times the caller asks.
  if (allowed || limit.deepens !== false) bucket.tokens = Math.max(-limit.burst, bucket.tokens - 1);

  if (buckets.size >= MAX_KEYS && !buckets.has(key)) sweep(now);
  buckets.set(key, bucket);
  return allowed;
}

/** Drop everything that has refilled to full; they are indistinguishable from new. */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updated > 60 * 60_000) buckets.delete(key);
  }
}

/**
 * The address the request claims to come from.
 *
 * `x-forwarded-for` is trusted only when the instance is configured to sit
 * behind a proxy. Even then it is a claim, not a fact — see `byAddress`.
 */
export function clientIp(ctx: Ctx): string {
  if (env.trustProxy) {
    const forwarded = ctx.req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return ctx.req.socket.remoteAddress ?? 'unknown';
}

/** One bucket to check, with the allowance that applies to it. */
export interface Check {
  key: string;
  limit: Limit;
}

/**
 * The address checks for a route: what the request claims, and where it really
 * came from.
 *
 * `KOLIBRI_TRUST_PROXY` defaults to on because the shipped compose file puts
 * Caddy in front. That default is also a hole: an instance published directly
 * will believe `x-forwarded-for`, and then anybody gets a fresh bucket per
 * request simply by counting upwards in a header — a limit that an attacker
 * opts out of is not a limit.
 *
 * So the claimed address is charged at the stated limit and the socket address
 * is charged at a much wider one. Behind a real proxy the wide bucket carries
 * every user at once and never binds; with no proxy in front it is the thing
 * that actually stops the attack.
 */
export function byAddress(ctx: Ctx, limit: Limit, prefix: string): Check[] {
  const claimed = clientIp(ctx);
  const peer = ctx.req.socket.remoteAddress ?? 'unknown';
  const checks: Check[] = [{ key: `${prefix}:${claimed}`, limit }];
  // When the header is not trusted the two are the same address; charging it
  // twice would just make the stated limit a lie.
  if (peer !== claimed) {
    checks.push({
      key: `${prefix}-peer:${peer}`,
      limit: {
        burst: limit.burst * SHARED_FACTOR,
        everySeconds: Math.max(1, Math.round(limit.everySeconds / SHARED_FACTOR)),
      },
    });
  }
  return checks;
}

/** An account, a code — anything that is not an address. */
export const byValue = (limit: Limit, prefix: string, value: string): Check => ({ key: `${prefix}:${value}`, limit });

/**
 * Refuse the request if any of the given buckets is out of tokens.
 *
 * The message says how long to wait rather than just "too many": a person who
 * mistyped their password twice deserves better than a wall.
 */
export function enforce(ctx: Ctx, checks: Check[]): void {
  const now = Date.now();
  // Check every bucket — a short-circuit would let the others refill for free.
  const results = checks.map((check) => ({ check, allowed: take(check.key, check.limit, now) }));
  const refused = results.filter((result) => !result.allowed);
  if (!refused.length) return;

  // Whichever refused wants the longest wait decides what we promise.
  const seconds = Math.max(...refused.map((result) => result.check.limit.everySeconds));
  ctx.res.setHeader('retry-after', String(seconds));
  throw new HttpError(429, `Too many attempts — wait ${seconds} seconds and try again`, 'rate_limited');
}

/** Tests need a clean slate between cases. */
export const resetRateLimits = (): void => buckets.clear();

/** So a test can look at what a refusal did to the bucket, rather than infer it. */
export const rateLimitInternals = { buckets };

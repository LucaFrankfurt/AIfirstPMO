/**
 * Rate limiting and the response headers.
 *
 * The interesting case for a limiter is not "does it say 429" but whether it
 * closes the hole an IP limit alone leaves open: one account guessed at from
 * many addresses. And whether a person who mistyped their password is let back
 * in without an administrator.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-security-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits, LIMITS, byAddress, enforce, rateLimitInternals } = await import('../src/lib/ratelimit.ts');
const { buildCsp } = await import('../src/lib/csp.ts');

const DISK = { kind: 'disk', presign: false, publicEndpoint: '', s3: { endpoint: '' } };
const MINIO = { kind: 's3', presign: true, publicEndpoint: '', s3: { endpoint: 'http://minio:9000' } };

let base = '';

/** Raw so a status can be asserted without an exception in the way. */
async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // One real account to guess at.
  await call('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  resetRateLimits();
});
after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('rate limiting', () => {
  it('lets a few wrong passwords through and then stops', async () => {
    resetRateLimits();
    const seen: number[] = [];
    for (let attempt = 0; attempt < LIMITS.login.burst + 3; attempt++) {
      seen.push((await call('/api/auth/login', { email: 'ada@example.com', password: 'wrong' })).status);
    }
    assert.equal(seen.filter((s) => s === 401).length, LIMITS.login.burst, 'the burst is allowed');
    assert.ok(seen.slice(-3).every((s) => s === 429), 'and then it is refused');
  });

  it('says how long to wait rather than just refusing', async () => {
    resetRateLimits();
    for (let attempt = 0; attempt < LIMITS.login.burst; attempt++) {
      await call('/api/auth/login', { email: 'ada@example.com', password: 'wrong' });
    }
    const refused = await call('/api/auth/login', { email: 'ada@example.com', password: 'wrong' });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), String(LIMITS.login.everySeconds));
    assert.match(refused.body.message, /\d+ seconds/);
    assert.equal(refused.body.error, 'rate_limited');
  });

  it('limits one account across many addresses, not just one address', async () => {
    resetRateLimits();
    // Every attempt claims a different origin. An IP-only limiter sees one
    // attempt per attacker and lets the whole list through.
    for (let attempt = 0; attempt < LIMITS.login.burst; attempt++) {
      await call('/api/auth/login', { email: 'ada@example.com', password: 'wrong' },
        { 'x-forwarded-for': `10.0.0.${attempt}` });
    }
    const next = await call('/api/auth/login', { email: 'ada@example.com', password: 'wrong' },
      { 'x-forwarded-for': '10.0.0.250' });
    assert.equal(next.status, 429, 'the account bucket caught what the IP buckets missed');
  });

  it('does not let one account lock everybody else out', async () => {
    resetRateLimits();
    for (let attempt = 0; attempt < LIMITS.login.burst + 2; attempt++) {
      await call('/api/auth/login', { email: 'victim@example.com', password: 'wrong' },
        { 'x-forwarded-for': `10.1.0.${attempt}` });
    }
    // A different account from a fresh address is unaffected: its own bucket is
    // untouched, and the shared limit is per address rather than global.
    const other = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' },
      { 'x-forwarded-for': '10.9.9.9' });
    assert.equal(other.status, 200, 'the right password still works for somebody else');
  });

  it('guards registration and invite lookup too', async () => {
    resetRateLimits();
    const registrations: number[] = [];
    for (let attempt = 0; attempt < LIMITS.register.burst + 2; attempt++) {
      registrations.push((await call('/api/auth/register', {
        email: `spam${attempt}@example.com`, name: 'Spam', password: 'a long enough password',
      })).status);
    }
    assert.ok(registrations.slice(-2).every((s) => s === 429), 'registration is limited');

    resetRateLimits();
    const lookups: number[] = [];
    for (let attempt = 0; attempt < LIMITS.invite.burst + 2; attempt++) {
      lookups.push((await call(`/api/invites/guess${attempt}`)).status);
    }
    assert.ok(lookups.slice(0, 3).every((s) => s === 404), 'a wrong code is simply not found');
    assert.ok(lookups.slice(-2).every((s) => s === 429), 'guessing at codes is limited');
  });

  /**
   * The sign-in form is not the only place a password is checked.
   *
   * Changing a password and turning two-factor off both re-ask for the current
   * one, which is the point of them — and both did it without a limit. Whoever
   * had a borrowed session cookie could work through a list at whatever rate
   * the machine allowed, and turning two-factor off was the reward.
   *
   * It is also the one unbounded way to spend this process's CPU: each of those
   * checks is scrypt, tens of milliseconds, on the single thread that serves
   * everybody.
   */
  it('limits the password checks behind a session, not only the sign-in form', async () => {
    resetRateLimits();
    const session = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse battery' }),
    });
    assert.equal(session.status, 200);
    const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0];

    for (const [route, body] of [
      ['/api/me/password', { current: 'wrong', next: 'a long enough password' }],
      ['/api/me/2fa/off', { password: 'wrong' }],
    ] as const) {
      resetRateLimits();
      const seen: number[] = [];
      for (let attempt = 0; attempt < LIMITS.password.burst + 2; attempt++) {
        seen.push((await call(route, body, { cookie })).status);
      }
      assert.equal(seen.filter((s) => s === 401).length, LIMITS.password.burst, `${route} allows the burst`);
      assert.ok(seen.slice(-2).every((s) => s === 429), `${route} then refuses`);
    }

    // The limit stands between guesses, not between this person and their own
    // account. Asserted through `2fa/off` rather than by changing the password,
    // because the tests after this one still sign in as Ada — and turning off a
    // second factor that was never on changes nothing.
    resetRateLimits();
    const right = await call('/api/me/2fa/off', { password: 'correct horse battery' }, { cookie });
    assert.equal(right.status, 200, 'the real password still works');
  });
});

/**
 * The limiter's own memory.
 *
 * A bucket is created per key and a key contains an address, which is free to
 * invent — with `KOLIBRI_TRUST_PROXY` on, which is the default, it is a header.
 * So the map is attacker-sized unless something bounds it, and a limiter that
 * answers a flood by exhausting the process has picked the wrong loser.
 *
 * `MAX_KEYS` was that bound in name only: the sweep behind it deleted buckets
 * untouched for an hour, which during a flood is none of them.
 */
describe('the limiter under a flood', () => {
  /** A request from an address, without the network in the way. */
  const from = (ip: string) => ({
    res: { setHeader() {} },
    req: { headers: {}, socket: { remoteAddress: ip } },
  }) as any;

  const flood = (count: number) => {
    for (let i = 0; i < count; i++) {
      const ctx = from(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      try { enforce(ctx, byAddress(ctx, LIMITS.login, 'login')); } catch { /* the 429 is the point */ }
    }
  };

  it('holds a hard ceiling on how many buckets it will keep', () => {
    resetRateLimits();
    flood(60_000);
    assert.ok(
      rateLimitInternals.buckets.size <= 20_000,
      `the map grew to ${rateLimitInternals.buckets.size} from 60,000 addresses inside one hour`,
    );
  });

  it('drops the buckets closest to full, and never one that is still holding somebody', () => {
    resetRateLimits();
    // One address that has spent everything it had. It must survive whatever
    // the flood does to the map, or the flood is a way out of a limit.
    const attacker = from('203.0.113.7');
    for (let i = 0; i < LIMITS.login.burst + 5; i++) {
      try { enforce(attacker, byAddress(attacker, LIMITS.login, 'login')); } catch { /* expected */ }
    }
    assert.throws(() => enforce(attacker, byAddress(attacker, LIMITS.login, 'login')), /Too many/);

    flood(60_000);

    assert.throws(
      () => enforce(attacker, byAddress(attacker, LIMITS.login, 'login')),
      /Too many/,
      'a flood from other addresses evicted the bucket that was doing the work',
    );
  });

  it('gives the socket-level bucket the same rules as the one it stands behind', () => {
    // `oauthClient` says refusals must not deepen — Claude on the web registers
    // a client per connection, and deepening turned a two-minute wait into
    // twenty. Behind a proxy the peer bucket is a second bucket, and it was
    // built from two fields rather than from the limit, so it lost that.
    const behindProxy = {
      req: { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '10.1.1.1' } },
    } as any;
    for (const check of byAddress(behindProxy, LIMITS.oauthClient, 'oauth-register')) {
      assert.equal(check.limit.deepens, false, `${check.key} does not carry the limit it was made from`);
    }
  });
});

describe('response headers', () => {
  it('sends a policy that would stop an injected script', async () => {
    resetRateLimits();
    const response = await call('/api/health');
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline script is not allowed — that is the point');
    assert.ok(!/script-src[^;]*unsafe-eval/.test(csp));
    assert.match(csp, /frame-ancestors 'none'/, 'and it cannot be framed');
    assert.match(csp, /object-src 'none'/);

    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  });

  it('still allows the inline styles and blob previews the app actually uses', async () => {
    const csp = (await call('/api/health')).headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src [^;]*'unsafe-inline'/, 'React writes style attributes');
    assert.match(csp, /img-src [^;]*blob:/, 'uploads are previewed from a blob');
  });
});

describe('the policy and the object store', () => {
  // `/files/:hash` redirects to a pre-signed URL when an object store is
  // configured. The bytes arrive either way; without the origin in the policy
  // the browser discards them, and an attachment simply never appears.
  it('names the object store so attachments survive it', () => {
    const csp = buildCsp(MINIO);
    assert.match(csp, /img-src [^;]*http:\/\/minio:9000/);
    assert.match(csp, /connect-src [^;]*http:\/\/minio:9000/);
    assert.match(csp, /media-src [^;]*http:\/\/minio:9000/);
    assert.ok(!/script-src[^;]*minio/.test(csp), 'it may serve pictures, not code');
  });

  it('signs for the host the browser reaches, not the one the server does', () => {
    // The usual compose setup: the server talks to `minio:9000` over the
    // container network, the browser to a public name. The policy has to name
    // the second one or it blocks exactly the URL that gets handed out.
    const csp = buildCsp({ ...MINIO, publicEndpoint: 'https://files.example.com' });
    assert.match(csp, /img-src [^;]*https:\/\/files\.example\.com/);
    assert.ok(!csp.includes('minio:9000'), 'the internal host is never reached by a browser');
  });

  it('stays closed when nothing redirects off-origin', () => {
    const csp = buildCsp(DISK);
    assert.equal(csp.match(/img-src ([^;]*)/)?.[1], "'self' data: blob:");
    assert.equal(csp.match(/connect-src ([^;]*)/)?.[1], "'self'");
  });

  it('does not widen the policy for an endpoint it cannot parse', () => {
    // A broken endpoint is a configuration error to report elsewhere. Emitting
    // a policy with a hole in it because a URL failed to parse is worse.
    const csp = buildCsp({ ...MINIO, publicEndpoint: 'not a url' });
    assert.equal(csp.match(/img-src ([^;]*)/)?.[1], "'self' data: blob:");
  });

  it('serves no exception when pre-signing is off — the app proxies the bytes', () => {
    const csp = buildCsp({ ...MINIO, presign: false });
    assert.ok(!csp.includes('minio'), 'same-origin again, so the policy tightens back up');
  });
});

describe('a forwarded address is a claim, not a fact', () => {
  // `KOLIBRI_TRUST_PROXY` is on by default because the shipped compose file
  // puts Caddy in front. An instance published without one still believes the
  // header, so the limit has to survive a client that simply invents an
  // address per request.
  const ctxWith = (headers: Record<string, string>, peer = '203.0.113.7') =>
    ({ req: { headers, socket: { remoteAddress: peer } } }) as never;

  it('charges the socket as well when the two disagree', () => {
    const checks = byAddress(ctxWith({ 'x-forwarded-for': '10.0.0.1' }), LIMITS.register, 'register');
    assert.equal(checks.length, 2);
    assert.equal(checks[0].key, 'register:10.0.0.1');
    assert.equal(checks[1].key, 'register-peer:203.0.113.7');
  });

  it('gives the shared bucket room for a whole instance but not for a flood', () => {
    const [claimed, peer] = byAddress(ctxWith({ 'x-forwarded-for': '10.0.0.1' }), LIMITS.register, 'register');
    assert.equal(claimed.limit.burst, LIMITS.register.burst);
    // Wide enough that real users behind one proxy never meet it, finite enough
    // that inventing addresses buys a bounded number of attempts rather than
    // an unlimited one.
    assert.ok(peer.limit.burst > LIMITS.register.burst * 5, 'a proxy carries everybody');
    assert.ok(Number.isFinite(peer.limit.burst), 'and it is still a ceiling');
    assert.ok(peer.limit.everySeconds >= 1, 'refill stays a whole number of seconds');
  });

  it('does not charge twice when there is no proxy in the way', () => {
    const checks = byAddress(ctxWith({}), LIMITS.login, 'login');
    assert.equal(checks.length, 1, 'the stated limit would otherwise be a lie');
    assert.equal(checks[0].key, 'login:203.0.113.7');
  });
});

describe('a forged cross-site post', () => {
  // SameSite=Lax already stops the cookie travelling, and that is one browser
  // default away from being the only thing standing there. A cross-site form
  // can only produce three content types; none of them is accepted.
  it('is refused when it dresses up as a form', async () => {
    resetRateLimits();
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: 'email=ada@example.com&password=correct+horse+battery',
      });
      assert.equal(response.status, 415, `${type} is not a way in`);
    }
  });

  it('still accepts the real thing', async () => {
    resetRateLimits();
    const ok = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' });
    assert.equal(ok.status, 200);
  });
});

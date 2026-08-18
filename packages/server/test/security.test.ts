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
const { resetRateLimits, LIMITS, byAddress } = await import('../src/lib/ratelimit.ts');
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

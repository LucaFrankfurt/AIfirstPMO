/**
 * What the instance says about the connection it is on.
 *
 * Two things depend on that answer and they must not disagree: the OAuth
 * metadata, whose `issuer` a client is required to check against the URL it
 * fetched the document from, and the `Secure` flag on the session cookie.
 *
 * They used to work it out separately and both got it wrong the same way, by
 * asking `x-forwarded-proto` and falling back to the socket — which is plain
 * HTTP behind every proxy. Behind one that forwards the host and not the
 * scheme, that published `http://the-real-domain` as the issuer, which every
 * OAuth client is obliged to reject, and dropped `Secure` from the session
 * cookie, which is a session token a browser will send over plain HTTP.
 *
 * These speak raw HTTP because `Host` is the whole point of them, and `fetch`
 * takes `Host` from the URL and will not be argued with.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-transport-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let port = 0;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const raw = (path: string, headers: Record<string, string>, body?: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers, setHost: false },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });

const signIn = (headers: Record<string, string>) => {
  const body = JSON.stringify({ email: 'ada@example.com', password: 'correct horse battery' });
  return raw('/api/auth/login', {
    ...headers,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  }, body);
};

const cookieOf = (answer: Answer): string => String([answer.headers['set-cookie'] ?? []].flat()[0] ?? '');

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
  resetRateLimits();
  const body = JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  await raw('/api/auth/register', {
    host: 'localhost', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
  }, body);
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a proxy that forwards the host and not the scheme', () => {
  it('still marks the session cookie Secure', async () => {
    resetRateLimits();
    const answer = await signIn({ host: 'app.example.com' });
    assert.match(cookieOf(answer), /Secure/, 'a cookie without Secure is one a browser sends over plain HTTP');
  });

  it('still insists on TLS for the next visit', async () => {
    const answer = await raw('/api/health', { host: 'app.example.com' });
    assert.match(String(answer.headers['strict-transport-security'] ?? ''), /max-age=\d+/);
  });

  it('and the issuer says the same thing the cookie does', async () => {
    const answer = await raw('/.well-known/oauth-authorization-server', { host: 'app.example.com' });
    assert.equal(JSON.parse(answer.body).issuer, 'https://app.example.com');
  });
});

describe('a laptop', () => {
  it('gets no Secure flag, because there is no TLS to be secure over', async () => {
    resetRateLimits();
    const answer = await signIn({ host: `localhost:${port}` });
    assert.doesNotMatch(cookieOf(answer), /Secure/);
  });

  it('is not locked to https for six months by a header it cannot honour', async () => {
    const answer = await raw('/api/health', { host: `localhost:${port}` });
    assert.equal(answer.headers['strict-transport-security'], undefined);
  });
});

describe('a proxy that says http outright', () => {
  it('is believed, over any guess', async () => {
    resetRateLimits();
    const answer = await signIn({ host: 'app.example.com', 'x-forwarded-proto': 'http' });
    assert.doesNotMatch(cookieOf(answer), /Secure/);

    const meta = await raw('/.well-known/oauth-authorization-server', { host: 'app.example.com', 'x-forwarded-proto': 'http' });
    assert.equal(JSON.parse(meta.body).issuer, 'http://app.example.com');
    assert.equal(meta.headers['strict-transport-security'], undefined, 'nor sent where there is no TLS');
  });
});

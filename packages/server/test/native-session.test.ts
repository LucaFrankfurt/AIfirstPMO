/**
 * How a packaged app signs in, when it cannot hold a cookie.
 *
 * The app loads from its own origin — `capacitor://localhost` — so the session
 * cookie set for the server's origin is never sent with its requests. It has to
 * carry a bearer instead, and `authenticate` has accepted a session token as
 * one all along because SSE needs it. What was missing was a way to be given
 * one, and the danger in adding it is the browser: its cookie is `HttpOnly`
 * precisely so script cannot read it, and a token in a response body hands that
 * back to cross-site scripting. So it is opt-in, and these cases are about who
 * gets one and who does not.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-native-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');

let base = '';
const NATIVE = { 'x-kolibri-client': 'native' };

/** No cookie jar anywhere in here: that is the point of the whole exercise. */
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const account = (n: number) => ({ email: `native-${n}@kolibri.test`, name: `Native ${n}`, password: 'kolibri-demo-1' });

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a client that asks for a token', () => {
  it('is given one at sign-up, and it authenticates without a cookie', async () => {
    const made = await post('/api/auth/register', { ...account(1), workspace: 'Native' }, NATIVE);
    assert.equal(made.status, 200);
    assert.equal(typeof made.body.token, 'string', 'sign-up returned no token to a native client');

    const session = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${made.body.token}` } });
    assert.equal(session.status, 200);
    assert.equal((await session.json() as { user: { email: string } }).user.email, account(1).email);
  });

  it('is given one at sign-in too', async () => {
    await post('/api/auth/register', { ...account(2), workspace: 'Native' }, NATIVE);
    const back = await post('/api/auth/login', { email: account(2).email, password: account(2).password }, NATIVE);
    assert.equal(back.status, 200);
    assert.equal(typeof back.body.token, 'string');

    const session = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${back.body.token}` } });
    assert.equal(session.status, 200);
  });

  /*
   * Changing a password deletes every session for the account, including the
   * one making the request. A browser gets a fresh cookie and never notices; a
   * client holding a token would have been signed out by its own action.
   */
  it('is given a fresh one when a password change deletes the old', async () => {
    const made = await post('/api/auth/register', { ...account(3), workspace: 'Native' }, NATIVE);
    const first = made.body.token;

    const changed = await post('/api/me/password', { current: account(3).password, next: 'kolibri-demo-2' },
      { ...NATIVE, authorization: `Bearer ${first}` });
    assert.equal(changed.status, 200);
    assert.equal(typeof changed.body.token, 'string');
    assert.notEqual(changed.body.token, first, 'the same token came back, so the old session was not replaced');

    const old = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${first}` } });
    assert.equal(old.status, 401, 'the token from before the password change still works');
    const now = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${changed.body.token}` } });
    assert.equal(now.status, 200, 'the token the password change returned does not work');
  });
});

describe('a browser, which did not ask', () => {
  it('gets a cookie and no token, so script has nothing to steal', async () => {
    const made = await post('/api/auth/register', { ...account(4), workspace: 'Native' });
    assert.equal(made.status, 200);
    assert.equal(made.body.token, undefined, 'a browser was handed a session token in the response body');
    assert.match(made.headers.get('set-cookie') ?? '', /HttpOnly/i, 'the session cookie is readable by script');

    const back = await post('/api/auth/login', { email: account(4).email, password: account(4).password });
    assert.equal(back.body.token, undefined);
  });
});

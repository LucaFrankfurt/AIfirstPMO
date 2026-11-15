/**
 * Which server this client talks to, and with what credential.
 *
 * In a browser the answer is "this page's origin, with its cookie" and every
 * request stays relative — that is the case that must not change, because the
 * session cookie is `HttpOnly` and a bearer in reach of script is not. A
 * packaged app is the other case: it loads from `capacitor://localhost`, so a
 * relative `/api/…` addresses its own bundle and the server's cookie is never
 * sent.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { installBrowser } from './browser.ts';

installBrowser();

const {
  authHeaders, clientHeaders, isKolibriConfig, isPackaged, needsServer, serverAddress, serverOrigin, serverUrl, sessionToken,
  useServer, useSessionToken,
} = await import('../src/kernel/sync/server');

beforeEach(() => {
  useServer('');
  useSessionToken(null);
});

describe('in a browser, nothing changes', () => {
  it('keeps every path relative and same-origin', () => {
    assert.equal(serverOrigin(), '');
    assert.equal(serverUrl('/api/session'), '/api/session');
  });

  it('sends no bearer and does not ask for a token', () => {
    assert.deepEqual(authHeaders(), {});
    assert.deepEqual(clientHeaders(), {});
  });
});

describe('pointed at a server', () => {
  it('addresses that server instead', () => {
    useServer('https://kolibri.example');
    assert.equal(serverUrl('/api/session'), 'https://kolibri.example/api/session');
  });

  /*
   * `serverUrl` joins by concatenation, and a trailing slash makes
   * `https://host//api/session`, which some proxies 404 and others redirect —
   * a bug that only shows up against somebody else's deployment.
   */
  it('drops a trailing slash, however many were typed', () => {
    useServer('https://kolibri.example///');
    assert.equal(serverUrl('/api/session'), 'https://kolibri.example/api/session');
  });

  it('asks for a token, because a cookie will not reach it', () => {
    useServer('https://kolibri.example');
    assert.deepEqual(clientHeaders(), { 'x-kolibri-client': 'native' });
  });

  it('carries the token it was given, and forgets it on the way out', () => {
    useSessionToken('a-session-token');
    assert.deepEqual(authHeaders(), { authorization: 'Bearer a-session-token' });
    useSessionToken(null);
    assert.deepEqual(authHeaders(), {});
    assert.equal(sessionToken(), null);
  });

  it('survives the app being killed in the background', async () => {
    useServer('https://kolibri.example');
    useSessionToken('kept');
    // What a cold start does: the module is evaluated again, and reads storage.
    const again = await import(`../src/kernel/sync/server.ts?cold=${Date.now()}`);
    assert.equal(again.serverOrigin(), 'https://kolibri.example');
    assert.equal(again.sessionToken(), 'kept');
  });
});

describe('when the device refuses to remember anything', () => {
  /*
   * Safari in private mode throws from `localStorage` rather than returning
   * null, and a client that cannot remember its server should still start and
   * say so rather than fail to render.
   */
  it('still works, in memory, for as long as the app is open', () => {
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } },
      writable: true, configurable: true,
    });
    try {
      useServer('https://kolibri.example');
      useSessionToken('in-memory-only');
      assert.equal(serverUrl('/api/session'), 'https://kolibri.example/api/session');
      assert.deepEqual(authHeaders(), { authorization: 'Bearer in-memory-only' });
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, writable: true, configurable: true });
    }
  });
});

describe('who has to be asked where the server is', () => {
  const withCapacitor = (run: () => void) => {
    Object.defineProperty(globalThis, 'Capacitor', { value: {}, configurable: true });
    try { run(); } finally { delete (globalThis as Record<string, unknown>).Capacitor; }
  };

  it('never a browser: an empty origin there is the answer, not a question', () => {
    useServer('');
    assert.equal(isPackaged(), false);
    assert.equal(needsServer(), false, 'a browser would have been shown the picker');
  });

  it('the packaged app, until it has been told', () => {
    withCapacitor(() => {
      useServer('');
      assert.equal(isPackaged(), true);
      assert.equal(needsServer(), true);
    });
  });

  it('and not again once it has', () => {
    withCapacitor(() => {
      useServer('https://kolibri.example');
      assert.equal(needsServer(), false);
    });
  });
});

describe('what the picker makes of an address typed on a phone', () => {
  /*
   * A bare host used to stay relative, so the check went to the app's own
   * bundle — which answers every path with `index.html` and a 200 — and the
   * picker kept an address that was not one.
   */
  it('assumes https when no scheme was typed', () => {
    assert.equal(serverAddress('kolibri.example.com'), 'https://kolibri.example.com');
    assert.equal(serverAddress('  kolibri.example.com:8443 '), 'https://kolibri.example.com:8443');
  });

  it('keeps plain http when somebody asked for it, for the laptop on the same wifi', () => {
    assert.equal(serverAddress('http://192.168.1.20:4000'), 'http://192.168.1.20:4000');
  });

  /* Pasted out of a browser tab: Kolibri is served from the root of its host. */
  it('keeps only the origin of an address pasted with a path', () => {
    assert.equal(serverAddress('https://kolibri.example.com/inbox?x=1#y'), 'https://kolibri.example.com');
  });

  it('refuses what cannot be a server', () => {
    for (const typed of ['', '   ', 'https://', 'ftp://kolibri.example.com', 'javascript://alert(1)', 'http://']) {
      assert.equal(serverAddress(typed), null, typed);
    }
  });
});

describe('whether a Kolibri answered, or merely something', () => {
  it('accepts the config every version has sent', () => {
    assert.equal(isKolibriConfig({ version: '0.1.0', hasUsers: true, allowSignup: false }), true);
  });

  /*
   * What `request` makes of an HTML page that came back 200 — the app's own
   * bundle, a captive portal, a parked domain.
   */
  it('refuses a page that only said 200', () => {
    assert.equal(isKolibriConfig({ message: '<!doctype html><html>' }), false);
    assert.equal(isKolibriConfig(null), false);
    assert.equal(isKolibriConfig('ok'), false);
    assert.equal(isKolibriConfig({ version: 1, hasUsers: true }), false);
  });
});

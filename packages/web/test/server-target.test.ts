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
  authHeaders, clientHeaders, filePath, fileSrc, isKolibriConfig, isPackaged, needsServer, serverAddress, serverOrigin,
  serverUrl, sessionToken, useServer, useSessionToken, withFileSources, withoutFileSources,
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
    Object.defineProperty(globalThis, 'Capacitor', { value: { isNativePlatform: () => true }, configurable: true });
    try { run(); } finally { delete (globalThis as Record<string, unknown>).Capacitor; }
  };

  it('never a browser: an empty origin there is the answer, not a question', () => {
    useServer('');
    assert.equal(isPackaged(), false);
    assert.equal(needsServer(), false, 'a browser would have been shown the picker');
  });

  /*
   * `@capacitor/core` defines `window.Capacitor` wherever it is imported, a
   * browser included, and the bundle imports it as soon as it uses a plugin.
   * Looking for the name alone put every browser on the server picker.
   */
  it('not a browser that has merely loaded Capacitor\'s core', () => {
    Object.defineProperty(globalThis, 'Capacitor', { value: { isNativePlatform: () => false }, configurable: true });
    try {
      useServer('');
      assert.equal(isPackaged(), false);
      assert.equal(needsServer(), false);
    } finally {
      delete (globalThis as Record<string, unknown>).Capacitor;
    }
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

describe('an uploaded file, in a browser', () => {
  /* The cookie does the work there, and the session token is `HttpOnly`: a
     token in a URL would be the one thing that cookie exists to prevent. */
  it('is left exactly as the server said it', () => {
    useSessionToken('never-used-here');
    assert.equal(fileSrc('/files/ab/px.png'), '/files/ab/px.png');
    const html = '<p><img src="/files/ab/px.png" alt=""></p>';
    assert.equal(withFileSources(html), html);
    assert.equal(withoutFileSources(html), html);
  });
});

describe('an uploaded file, in the packaged app', () => {
  beforeEach(() => {
    useServer('https://kolibri.example');
    useSessionToken('tok_en-123');
  });

  /*
   * Measured against a seeded server: a bare GET of `/files/…` is 401, and
   * `?access_token=` is 200. An `<img>` cannot send a header.
   */
  it('is drawn from the server, with the session an image cannot otherwise send', () => {
    assert.equal(fileSrc('/files/ab/px.png'), 'https://kolibri.example/files/ab/px.png?access_token=tok_en-123');
    assert.equal(fileSrc('/files/ab/px.png?w=64'), 'https://kolibri.example/files/ab/px.png?w=64&access_token=tok_en-123');
  });

  it('leaves alone what is not an upload', () => {
    for (const url of ['https://elsewhere.example/a.png', 'data:image/png;base64,AAAA', 'blob:https://localhost/1', '/t/WEB-1']) {
      assert.equal(fileSrc(url), url);
    }
    assert.equal(fileSrc(null), '');
  });

  it('rewrites the images in rendered markup, and only the images', () => {
    const html = '<p><img src="/files/ab/px.png" alt="x" loading="lazy" /> <a href="/files/ab/report.pdf">report</a></p>';
    assert.equal(
      withFileSources(html),
      '<p><img src="https://kolibri.example/files/ab/px.png?access_token=tok_en-123" alt="x" loading="lazy" /> '
        + '<a href="/files/ab/report.pdf">report</a></p>',
    );
  });

  /*
   * The HTML editor draws a page with `withFileSources` and reads it back out
   * of the DOM. Without the way back, the first save of a page with a picture
   * in it would have written this device's token into the page — for every
   * reader, and every version after.
   */
  it('round-trips through the editor without the token reaching what is stored', () => {
    const stored = '<p><img src="/files/ab/px.png" alt=""></p><p><img src="/files/cd/q.png?w=64" alt=""></p>';
    const shown = withFileSources(stored);
    assert.ok(shown.includes('access_token'));
    // What a browser serialises an attribute's `&` as when reading innerHTML.
    assert.equal(withoutFileSources(shown), stored);
    assert.ok(!withoutFileSources(shown).includes('tok_en'));
  });

  it('knows a file link in either spelling, and names it without the token', () => {
    assert.equal(filePath('/files/ab/report.pdf'), '/files/ab/report.pdf');
    assert.equal(filePath('https://kolibri.example/files/ab/px.png?access_token=tok_en-123'), '/files/ab/px.png');
    assert.equal(filePath('https://kolibri.example/files/ab/px.png?w=64&access_token=t'), '/files/ab/px.png?w=64');
  });

  it('and does not mistake anything else for one', () => {
    for (const href of [null, '', '/t/WEB-1', 'https://elsewhere.example/files/ab/x.png', '/filesystem', '#files']) {
      assert.equal(filePath(href), null, String(href));
    }
  });
});

// The service worker's copies of files: offline only, and gone with the session (WEB-16).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installBrowser } from './browser.ts';

installBrowser();

/** CacheStorage as maps keyed by URL — all `sw.js` and the sign-out touch. */
class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const store = this.stores.get(name)!;
    return {
      match: async (request: Request) => store.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { store.set(request.url, response); },
      delete: async (request: Request) => store.delete(request.url),
    };
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name: string) { return this.stores.delete(name); }
}

const ORIGIN = 'https://kolibri.example';
const workerCaches = new FakeCaches();
const server = { online: true, status: 200 };
const handlers = new Map<string, (event: any) => void>();
runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
  self: { addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler), location: { origin: ORIGIN } },
  caches: workerCaches,
  URL,
  Response,
  fetch: async () => {
    if (!server.online) throw new TypeError('Failed to fetch');
    return new Response('bytes', { status: server.status });
  },
});

function ask(path: string): Promise<Response> {
  let answer: Promise<Response> | undefined;
  handlers.get('fetch')!({ request: new Request(`${ORIGIN}${path}`), respondWith: (promise: Promise<Response>) => { answer = promise; } });
  assert.ok(answer, 'the worker did not answer for a file');
  return answer;
}

const FILES = 'kolibri-v3-files';
const stored = (path: string): boolean => !!workerCaches.stores.get(FILES)?.has(`${ORIGIN}${path}`);

describe('a file through the service worker', () => {
  it('is the server\'s answer while online, and the copy only offline', async () => {
    server.online = true;
    server.status = 200;
    assert.equal((await ask('/files/a/a.png')).status, 200);
    assert.ok(stored('/files/a/a.png'));
    server.status = 403;
    assert.equal((await ask('/files/a/a.png')).status, 403, 'a copy answered for a file the server now refuses');
    assert.ok(!stored('/files/a/a.png'), 'the refused copy was kept');

    server.status = 200;
    await ask('/files/b/b.png');
    server.online = false;
    assert.equal(await (await ask('/files/b/b.png')).text(), 'bytes');
  });

  it('drops every copy once the server says the session is gone', async () => {
    server.online = true;
    server.status = 200;
    await ask('/files/c/c.png');
    server.status = 401;
    assert.equal((await ask('/files/d/d.png')).status, 401);
    assert.equal(workerCaches.stores.has(FILES), false);
    server.online = false;
    await assert.rejects(ask('/files/c/c.png'), 'a copy outlived the session');
  });
});

describe('signing out', () => {
  it('takes the offline copies of files with it, and leaves the app shell', async () => {
    const windowCaches = new FakeCaches();
    await windowCaches.open(FILES);
    await windowCaches.open('kolibri-v3-shell');
    Object.defineProperty(globalThis, 'caches', { value: windowCaches, writable: true, configurable: true });
    const sync = await import('../src/kernel/sync/sync');
    await sync.signOutLocal('ada');
    assert.deepEqual(await windowCaches.keys(), ['kolibri-v3-shell']);
  });
});

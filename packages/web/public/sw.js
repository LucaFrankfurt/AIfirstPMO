/* Kolibri service worker.
 *
 * The app shell is precached so a cold start works offline; data never touches
 * the HTTP cache because it lives in IndexedDB and syncs through /api/sync.
 * Uploaded files are content-addressed, so they are safe to cache forever.
 */
const VERSION = 'kolibri-v1';
const SHELL = `${VERSION}-shell`;
const FILES = `${VERSION}-files`;
const PRECACHE = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API traffic is always live; the client handles offline itself.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')) return;

  if (url.pathname.startsWith('/files/')) {
    event.respondWith(
      caches.open(FILES).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Navigations: network first so a deploy is picked up, cache as the fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit ?? new Response('Offline', { status: 503 }))),
    );
    return;
  }

  // Fingerprinted assets: cache first.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname))) {
        cache.put(request, response.clone());
      }
      return response;
    }),
  );
});

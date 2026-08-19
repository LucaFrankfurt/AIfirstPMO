/* Kolibri service worker.
 *
 * The app shell is precached so a cold start works offline; data never touches
 * the HTTP cache because it lives in IndexedDB and syncs through /api/sync.
 * Uploaded files are content-addressed, so they are safe to cache forever.
 */
const VERSION = 'kolibri-v2';
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

/* A push carries nothing.
 *
 * The server sends an empty notification on purpose: encrypting a payload would
 * mean a whole cryptography stack on the server to deliver a sentence this
 * worker can simply ask for. Same origin, same session — so the message is
 * fetched here, and never sits encrypted on a push service's disk.
 */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Kolibri';
    let body = 'Something happened in your workspace.';
    let url = '/inbox';

    try {
      const response = await fetch('/api/notifications/latest', { credentials: 'include' });
      if (response.ok) {
        const latest = await response.json();
        if (!latest || !latest.title) return; // nothing unread: say nothing
        title = latest.title;
        body = latest.body || '';
        url = latest.url || '/inbox';
      }
    } catch {
      // Offline, or signed out. The generic line above is still true, and a
      // silent push is worse than a vague one.
    }

    await self.registration.showNotification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      // One at a time: a phone that was off for an hour should not stack
      // fifteen identical banners.
      tag: 'kolibri',
      renotify: true,
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/inbox';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A tab that is already open is focused rather than a second one opened.
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
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

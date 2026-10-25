// Tabula service worker: makes the app installable and the shell load fast and offline.
// Data never goes through the cache: /api and /mcp always hit the network (they need the token
// and must be fresh — agents write while the app is open).
const SHELL = 'tabula-shell-v1';
const ASSETS = 'tabula-assets-v1';
const MAX_ASSETS = 60;
const PRECACHE = ['/', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/mcp') || url.pathname === '/healthz') return;

  // The page: network first so a deploy shows up at once; the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? new Response('Tabula is offline.', { status: 503, headers: { 'content-type': 'text/plain' } })),
    );
    return;
  }

  // Build assets have content hashes in their names: cache first, they never change.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then(async (c) => {
                await c.put(req, copy);
                await trim(c);
              });
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Icons, manifest: whatever is fresh, the cache when offline.
  event.respondWith(fetch(req).catch(async () => (await caches.match(req)) ?? Response.error()));
});

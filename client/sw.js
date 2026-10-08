// Service worker: precaches the app shell so solo mode works offline.
// App code is network-first (always fresh when online); fonts and icons are cache-first.
const CACHE = 'ludo-shell-v1';
const STATIC = /\.(woff2|png)$/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const res = await fetch('/precache.json', { cache: 'no-store' });
    const { files } = await res.json();
    const cache = await caches.open(CACHE);
    await cache.addAll(files.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(fallbackUrl || req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(fallbackUrl || req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline');
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/ws' || url.pathname === '/healthz' || url.pathname === '/precache.json') return;
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/'));
  } else if (STATIC.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  } else {
    e.respondWith(networkFirst(req));
  }
});

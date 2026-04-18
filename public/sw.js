// pquote Service Worker v4
// Network-first for app files, cache for offline fallback only.
// Precaches a branded /offline.html that's served when a navigation
// request misses both network and cache.
const CACHE_NAME = 'qmach-v4';
const OFFLINE_URL = '/offline.html';

// On install: precache the offline fallback and activate immediately.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.add(OFFLINE_URL)).catch(() => {})
  );
  self.skipWaiting();
});

// On activate: delete ALL old caches.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for everything, cache as offline fallback.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache API calls
  if (url.pathname.startsWith('/api/')) return;

  // Never cache mapbox tiles (too large, causes memory issues)
  if (url.hostname.includes('mapbox.com') || url.hostname.includes('tiles.mapbox')) return;

  e.respondWith(
    fetch(e.request).then(resp => {
      // Only cache successful GET requests for our own origin
      if (resp.ok && e.request.method === 'GET' && url.origin === location.origin) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(async () => {
      // Offline: try the cache for the exact request
      const cached = await caches.match(e.request);
      if (cached) return cached;
      // Navigation requests fall back to the branded offline page
      if (e.request.mode === 'navigate') {
        const fallback = await caches.match(OFFLINE_URL);
        if (fallback) return fallback;
      }
      // Last resort — let the browser render its native error
      return Response.error();
    })
  );
});

// QUOTE machine Service Worker v3
// Network-first for app files, cache for offline fallback only
const CACHE_NAME = 'qmach-v3';

// On install: skip waiting to activate immediately
self.addEventListener('install', () => {
  self.skipWaiting();
});

// On activate: delete ALL old caches
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

// Fetch: network-first for everything
// Only cache successful responses as offline fallback
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache API calls
  if (url.pathname.startsWith('/api/')) return;

  // Never cache mapbox tiles (too large, causes memory issues)
  if (url.hostname.includes('mapbox.com') || url.hostname.includes('tiles.mapbox')) return;

  // Network first, cache fallback
  e.respondWith(
    fetch(e.request).then(resp => {
      // Only cache successful GET requests for our own origin
      if (resp.ok && e.request.method === 'GET' && url.origin === location.origin) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(() => {
      // Offline: try cache
      return caches.match(e.request);
    })
  );
});

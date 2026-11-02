// NAS-Sync v1.4.0 — Minimal Realtime-Safe PWA Service Worker
const CACHE_NAME = 'nas-sync-pwa-v1.4.0';
const STATIC_PWA_ASSETS = [
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/icons/apple-touch-icon.svg',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_PWA_ASSETS))
      .catch(() => {
        // Ignore transient offline errors during initial SW install
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith('nas-sync-pwa-') && key !== CACHE_NAME
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Never intercept non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // Only inspect same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // SECURITY & REALTIME SAFETY:
  // Never intercept authenticated API endpoints, streaming downloads, or Socket.IO
  if (
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/socket.io' ||
    url.pathname.startsWith('/socket.io/')
  ) {
    return;
  }

  // Network-first with cache fallback strictly for static PWA manifest & icons
  const isPwaStaticAsset =
    url.pathname === '/manifest.webmanifest' ||
    url.pathname.startsWith('/icons/');

  if (!isPwaStaticAsset) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResp) => {
        if (networkResp && networkResp.ok) {
          const cloned = networkResp.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, cloned))
            .catch(() => {});
        }
        return networkResp;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) {
          return cached;
        }
        throw new Error('Network unavailable and asset not cached');
      })
  );
});

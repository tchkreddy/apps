/**
 * B401 Meter PWA — Service Worker (sw.js)
 * Caches app shell for offline use.
 * Live data always fetched fresh (no caching of API responses).
 */

const CACHE_NAME = 'b401-meter-v12';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon.svg',
];

// ── Install: pre-cache app shell ──────────────────────
self.addEventListener('install', event => {
  // Take over immediately — don't wait for old SW to finish
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
});

// ── Activate: claim all clients immediately ───────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // take over all open tabs now
  );
});

// ── Fetch: API calls always network, shell = cache-first
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Apps Script proxy + any external → always network, never cache
  if (!url.href.startsWith(self.location.origin)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell → cache first, fall back to network
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

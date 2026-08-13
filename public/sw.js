// pi-inspect service worker — network-first for dynamic data, cache-first for static shell.
const VERSION = 'pi-inspect-v7';
// Resolve relative to the SW scope so this works under any subpath (e.g. GitHub Pages).
const BASE = new URL('./', self.registration?.scope || self.location.href).pathname;
const SHELL = ['', 'index.html', 'style.css', 'app.js', 'share.js', 'manifest.webmanifest', 'icon.svg'].map((p) => BASE + p);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or SSE — always go to network.
  if (url.pathname.startsWith('/api/')) return;

  // Static shell: cache-first, fall back to network, then update cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});

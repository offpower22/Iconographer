/* Iconographer service worker.
   Strategy:
   - App shell (HTML/CSS/JS/icons): cache-first, so an installed app opens instantly
     and works offline for everything except the live analysis call.
   - /api/*: network-only. Analysis needs the server; we never cache or fake it.
   - Navigations that fail offline fall back to a cached offline page.
*/

const VERSION = 'v2';
const SHELL_CACHE = `iconographer-shell-${VERSION}`;

/**
 * Never cache dev-server or module-graph URLs. If these get cached they are
 * served cache-first forever and source edits stop reaching the browser.
 * Query strings are excluded too, since Vite cache-busts with ?t= / ?v=.
 */
function isNotCacheable(url) {
  return (
    url.search !== '' ||
    /^\/(src|@vite|@id|@fs|node_modules)\//.test(url.pathname) ||
    url.pathname === '/@vite/client'
  );
}

// Core files that make up the installable app shell. The built CSS/JS are
// hashed by Astro, so we also cache successful same-origin GETs at runtime.
const SHELL_ASSETS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Don't let one missing asset abort the whole install.
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let POST (the analyze upload) go straight to the network.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API calls — they must hit the network.
  if (url.pathname.startsWith('/api/')) {
    return; // default browser behavior (network)
  }

  // Only manage same-origin requests.
  if (url.origin !== self.location.origin) return;

  // Let dev/module URLs go straight to the network, always.
  if (isNotCacheable(url)) return;

  // Navigations: network-first, fall back to cache, then offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match('/') || caches.match('/offline.html'))
        )
    );
    return;
  }

  // Static assets: cache-first, then network (and cache the result).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});

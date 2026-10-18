// Offline app shell for BookrReader.
// Hand-written service worker (no build step): Vite copies public/ verbatim to
// the build root, so this file ships as /sw.js and can be updated on its own.
const CACHE = 'bookr-shell-v2';
const SHELL_URL = '/';
// Scripts, styles and modulepreloads emitted by Vite, e.g. /assets/index-abc.js.
const SHELL_ASSET_PATTERN = /(?:src|href)="(\/assets\/[^"]+)"/g;

function extractShellAssets(html) {
  const assets = new Set();
  for (const match of html.matchAll(SHELL_ASSET_PATTERN)) {
    assets.add(match[1]);
  }
  return [...assets];
}

// The first load happens before this worker controls the page, so the install
// step must seed the cache itself: the HTML plus every asset it references.
async function precacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(SHELL_URL, { cache: 'reload' });
  if (!response.ok) {
    throw new Error(`Failed to precache ${SHELL_URL}: ${response.status}`);
  }
  await cache.put(SHELL_URL, response.clone());
  const assets = extractShellAssets(await response.text());
  // A missing optional asset must not abort the whole installation.
  await Promise.allSettled(
    assets.map((url) =>
      fetch(url).then((assetResponse) => {
        if (assetResponse.ok) return cache.put(url, assetResponse);
      }),
    ),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only same-origin GETs are cached. API calls (including the SSE stream) and
  // health checks always go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/healthz') return;
  // Never answer the worker script itself from the cache, so updates land.
  if (url.pathname === '/sw.js') return;

  // Navigations: network first, falling back to the cached shell so the SPA can
  // boot offline and resolve the route client-side.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(SHELL_URL, copy));
          }
          return response;
        })
        .catch(() => caches.match(SHELL_URL).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Static runtime assets (hashed bundles, pdf.js worker, cmaps, fonts):
  // cache first, then network; only successful responses are stored.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

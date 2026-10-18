// Offline app shell for BookrReader.
// Hand-written service worker (no build step): Vite copies public/ verbatim to
// the build root, so this file ships as /sw.js and can be updated on its own.
const CACHE = 'bookr-shell-v3';
const SHELL_URL = '/';
// Scripts, styles and modulepreloads emitted by Vite, e.g. /assets/index-abc.js.
const SHELL_ASSET_PATTERN = /(?:src|href)="(\/assets\/[^"]+)"/g;
// pdf.js loads its worker lazily, so it never appears in index.html; the path
// is baked into the main bundle as a string instead.
const PDF_WORKER_PATTERN = /(\/assets\/pdf\.worker\.min-[A-Za-z0-9_-]+\.mjs)/g;

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

  // Fetch the shell assets, and scan every JS chunk for the pdf.js worker path
  // so it is available even when no PDF was opened online before going offline.
  const pdfWorkers = new Set();
  await Promise.allSettled(
    assets.map(async (url) => {
      const assetResponse = await fetch(url);
      if (!assetResponse.ok) return;
      if (url.endsWith('.js')) {
        const source = await assetResponse.clone().text();
        for (const match of source.matchAll(PDF_WORKER_PATTERN)) {
          pdfWorkers.add(match[1]);
        }
      }
      await cache.put(url, assetResponse);
    }),
  );

  // A missing optional asset must not abort the whole installation.
  await Promise.allSettled(
    [...pdfWorkers].map((url) =>
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

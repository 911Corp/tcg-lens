// Service worker (v9). Shell: network first (fresh code), cache fallback offline.
// Recognition assets — calibrated index, catalogue metadata, AI model and OCR/barcode engines (all
// versioned URLs) — are cache-first, so the scanner starts instantly from the second launch.
const SHELL_CACHE = 'tcg-lens-shell-v12';
const ASSET_CACHE = 'tcg-lens-assets-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app-1.js', '/app-2.js', '/app-3.js', '/app-4.js', '/sealed.js', '/app-shell.js', '/lens/index.js', '/manifest.json', '/icon.svg',
  '/fonts/barlow-semi-condensed-latin-600-normal.woff2', '/fonts/barlow-semi-condensed-latin-700-normal.woff2', '/fonts/barlow-latin-400-normal.woff2', '/fonts/barlow-latin-500-normal.woff2'];
const ASSET = url =>
  /^\/data\/(deep-|visual-index-)/.test(url.pathname) && url.origin === self.location.origin
  || /^(cdn\.jsdelivr\.net|tfhub\.dev|www\.kaggle\.com|storage\.googleapis\.com)$/.test(url.hostname);

self.addEventListener('install', event => { self.skipWaiting(); event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL))); });
self.addEventListener('activate', event => {
  self.clients.claim();
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE).map(k => caches.delete(k)))));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (ASSET(url)) {
    event.respondWith(caches.open(ASSET_CACHE).then(async cache => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok || res.type === 'opaque') {
        cache.put(event.request, res.clone());
        // Versioned index file (?v=…): drop the copies of older versions.
        if (url.searchParams.has('v')) for (const old of await cache.keys()) { const o = new URL(old.url); if (o.pathname === url.pathname && o.search !== url.search) cache.delete(old); }
      }
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(SHELL_CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match('/index.html'))));
});

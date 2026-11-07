// Service worker dasar: cangkang aplikasi tersedia luring; API selalu ke jaringan dulu.
const VERSION = 'kolab-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhook/')) {
    // GET API: jaringan dulu, salinan terakhir sebagai cadangan luring.
    if (url.pathname === '/api/stream') return;
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok && (url.pathname === '/api/my/tasks' || url.pathname === '/api/me')) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || new Response(JSON.stringify({ error: 'Luring' }), { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});

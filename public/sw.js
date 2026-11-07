// Service worker dasar: cangkang aplikasi tersedia luring; API selalu ke jaringan dulu.
const VERSION = 'kolab-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/offline.js', '/icon.svg', '/manifest.webmanifest'];

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
      // Salinan untuk dibaca saat luring: tugas, akun, detail kartu, dan papan. Dihapus saat sesi berakhir.
      if (res.ok && (url.pathname === '/api/my/tasks' || url.pathname === '/api/me' || /^\/api\/(cards|boards)\/[^/]+$/.test(url.pathname))) {
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

// ---------- Web Push (Fase 2) ----------
const sameOrigin = (u) => { try { const x = new URL(u || '/', self.location.origin); return x.origin === self.location.origin ? x.href : self.location.origin + '/'; } catch { return self.location.origin + '/'; } };

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kolab-Hub', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/icon.svg', badge: '/icon.svg', data: { url: sameOrigin(d.url) },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = sameOrigin(e.notification.data?.url);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
    for (const c of list) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      if ('navigate' in c) return c.navigate(url);
      return c.postMessage({ type: 'open', url });
    }
    return self.clients.openWindow(url);
  }));
});

// Peramban dapat mengganti langganan (mis. kunci diputar); daftarkan ulang memakai sesi yang masih aktif.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const res = await fetch('/api/push/key', { credentials: 'same-origin' });
    if (!res.ok) return;
    const key = await res.json();
    if (!key.enabled) return;
    const raw = atob(key.public_key.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-kolab-csrf': '1' }, body: JSON.stringify({ subscription: sub.toJSON(), device: 'diperbarui otomatis' }) });
  })().catch(() => {}));
});

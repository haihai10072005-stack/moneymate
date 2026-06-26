/* MoneyMate service worker — app shell cache (PWA) */
const CACHE = 'mm-v1';
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API: luôn dùng mạng (không cache), để dữ liệu/đăng nhập luôn mới
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  // HTML điều hướng: network-first (luôn lấy bản mới), rớt mạng thì dùng cache
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('/index.html', cp)); return r; })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Tài nguyên khác (font, Chart.js CDN, icon): cache-first cho mượt + offline
  e.respondWith(
    caches.match(req).then(c => c || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(ch => ch.put(req, cp)); return r; }).catch(() => c))
  );
});

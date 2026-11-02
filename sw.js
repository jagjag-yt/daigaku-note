// オフラインでも起動できるように、アプリ本体を端末にキャッシュする。
// 中身を変えたら VERSION を上げる。
const VERSION = 'daigaku-note-v6';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/model.js', 'js/pdf.js', 'js/sync.js',
  'js/ink.js', 'js/templates.js', 'js/search.js', 'js/webdav.js', 'js/goodnotes.js',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// キャッシュを先に返し、裏で新しい版を取りに行く
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});

/* 金脆鍋貼 PWA Service Worker
   - 本站檔案：先用快取、背景更新（離線可開啟）
   - 外部資源（CDN、字型、圖片）：先用快取、背景更新
   - 換頁（navigate）離線時回傳快取的首頁
   更新網站內容後，請調高 VERSION 以清除舊快取。 */
const VERSION = 'v3';
const CACHE = `gyoza-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('gyoza-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  // 預約連結等外部導覽不處理
  if (req.mode === 'navigate' && url.origin !== self.location.origin) return;

  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  const network = fetch(req)
    .then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (cached) { network.catch(() => {}); return cached; }
  const res = await network;
  if (res) return res;
  if (req.mode === 'navigate') {
    const shell = await cache.match('./index.html') || await cache.match('./');
    if (shell) return shell;
  }
  return new Response('目前離線，且此內容尚未快取。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

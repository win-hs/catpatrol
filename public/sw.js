// ⚠️ 每次改動 shell 檔案（html/css/js）後都必須改這個版本號，
// 否則已安裝的裝置會一直吃舊快取，更新永遠送不出去。
const VERSION = 'v8';
const SHELL_CACHE = `catpatrol-shell-${VERSION}`;
const TILE_CACHE = 'catpatrol-tiles';
const TILE_LIMIT = 500;

const SHELL = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/store.js',
  'js/form.js',
  'js/map.js',
  'js/camera.js',
  'js/cam-config.js',
  'js/api.js',
  'js/sync.js',
  'lib/leaflet/leaflet.js',
  'lib/leaflet/leaflet.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('catpatrol-shell-') && n !== SHELL_CACHE)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/** 圖磚超過上限時丟掉最舊的一批（cache 的插入順序即為最舊在前） */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => cache.delete(k)));
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 雲端 API（同網域 Worker 代轉）：一律走網路，失敗交給上傳佇列處理，絕不快取
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // OSM 圖磚：先給快取、背景更新，巡檢前看過的區域離線仍可見
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(request);
      const network = fetch(request).then(res => {
        if (res.ok) cache.put(request, res.clone()).then(() => trimTiles(cache));
        return res;
      }).catch(() => hit);
      return hit || network;
    })());
    return;
  }

  // App shell：快取優先
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const hit = await caches.match(request, { ignoreSearch: false });
      if (hit) return hit;
      try {
        return await fetch(request);
      } catch (err) {
        // 導覽請求離線時退回首頁，避免顯示瀏覽器錯誤頁
        if (request.mode === 'navigate') return caches.match('index.html');
        throw err;
      }
    })());
  }
});

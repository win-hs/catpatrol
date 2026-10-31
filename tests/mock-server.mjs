// 本機畫面測試用：供 public/ 靜態檔，並模擬 Cloudflare Worker 的 /api。
// 執行：node tests/mock-server.mjs（預設 port 4330）
//   /__writes          看 App 送出的寫入
//   /__photos          看 /api/photo 被打了幾次（快取命中就不會出現）
//   /__station?id=&to= 改某台的樣點編號（模擬在試算表手動修改）
//   /__expire?on=1     之後的 /api 都回 302（模擬登入過期）
//   /__clear           清空雲端資料（模擬 clearAllData）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT || 4330);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };

const pad = n => String(n).padStart(2, '0');
const daysAgo = n => {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 10:00`;
};
const cfg = { mode: '照片', photoQuality: '32MP', burst: 3, videoQuality: '', videoSec: null, sensitivity: '中', interval: 0, workHours: '全天', note: '' };
const dev = (id, stationId, i, days, extra = {}) => ({
  id, projectId: 'P1', stationId, qrCode: id, cameraModel: 'Meidase P70', lng: 121.0 + i * 0.002, lat: 23.5 + i * 0.002,
  sdCard: '野1' + i, batteryType: '鋰電', batteryPct: 75, config: cfg, createdBy: '王小明', createdAt: daysAgo(200),
  lastPatrolAt: daysAgo(days), lastInspector: '王小明', running: true, lastNote: '', retired: false, ...extra,
});

const state = {
  projects: [{ id: 'P1', name: '測試專案', createdAt: '2026-10-01 10:00', status: '進行中' }],
  fieldDefs: [],
  devices: [
    dev('CAM-1', 'S-01', 0, 5),
    dev('CAM-2', 'S-02', 1, 70),
    dev('CAM-3', 'S-03', 2, 100, { lastPhotoId: 'PH-3' }),
    dev('CAM-4', 'S-04', 3, 130),
    dev('CAM-5', 'S-05', 4, 10, { running: false, lastNote: '相機被偷，<b>需補</b>' }),
  ],
};
const writes = [];
const photoHits = []; // 看 Service Worker 有沒有快取照片（快取命中就不會再打到這裡）
let expired = false;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/__writes') return send(res, 200, JSON.stringify(writes), { 'Content-Type': 'application/json' });
  if (url.pathname === '/__photos') return send(res, 200, JSON.stringify(photoHits), { 'Content-Type': 'application/json' });
  if (url.pathname === '/__station') { // 模擬在試算表上手動改樣點編號
    const d = state.devices.find(x => x.id === url.searchParams.get('id'));
    if (d) d.stationId = url.searchParams.get('to');
    return send(res, 200, 'ok');
  }
  if (url.pathname === '/__expire') { expired = url.searchParams.get('on') === '1'; return send(res, 200, `expired=${expired}`); }
  if (url.pathname === '/__clear') { state.projects = []; state.devices = []; state.fieldDefs = []; return send(res, 200, 'cleared'); }

  if (url.pathname.startsWith('/api/')) {
    if (expired) return send(res, 302, '', { Location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login/x' });
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      const me = { email: 'field@x.org', name: '王小明' };
      return send(res, 200, JSON.stringify({ ok: true, me, ...state }), { 'Content-Type': 'application/json' });
    }
    if (req.method === 'GET' && url.pathname === '/api/photo') {
      const id = url.searchParams.get('id');
      photoHits.push(id);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#4a7c59"/>`
        + `<text x="200" y="160" font-size="40" text-anchor="middle" fill="#fff">${id}</text></svg>`;
      return send(res, 200, JSON.stringify({ ok: true, mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') }),
        { 'Content-Type': 'application/json' });
    }
    if (req.method === 'POST' && url.pathname === '/api/write') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        writes.push({ action: msg.action, payload: msg.payload, photos: (msg.photos || []).length });
        send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
      });
      return;
    }
    return send(res, 404, '{"ok":false}', { 'Content-Type': 'application/json' });
  }

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
}).listen(PORT, () => console.log(`mock on http://localhost:${PORT}`));

// 本機畫面測試用：供 public/ 靜態檔，並模擬 Cloudflare Worker 的 /api。
// 執行：node tests/mock-server.mjs（預設 port 4330）
//   /__writes          看 App 送出的寫入
//   /__photos          看 /api/photo 被打了幾次（快取命中就不會出現）
//   /__station?id=&to= 改某台的樣點編號（模擬在試算表手動修改）
//   /__version?v=      雲端程式版本（空字串＝舊 Apps Script，App 應在首頁警告）
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
  sdCard: 'SD01' + i, batteryType: '鋰電', batteryPct: 75, config: cfg, createdBy: '王小明', createdAt: daysAgo(200),
  lastPatrolAt: daysAgo(days), lastInspector: '王小明', running: true, lastNote: '', retired: false, ...extra,
});

// 巡檢紀錄（v0.4 起 bootstrap 會帶）：履歷與統計用
const dayOnly = n => daysAgo(n).slice(0, 10);
const rec = (n, deviceId, inspector, extra = {}) => ({
  recordId: `REC-${deviceId}-${n}`, patrolAt: daysAgo(n), projectId: 'P1', deviceId, inspector, running: true,
  sdChanged: false, sdNew: '', sdRetrieved: '', batteryChanged: false, batteryTypeNew: '', batteryPct: 75,
  configChanged: false, locationChanged: false, note: '', cameraSwapped: false, newDeviceId: '', newCameraModel: '',
  swapReason: '', stationId: '', stoppedMidway: false, stoppedAt: '', stopReason: '', ...extra,
});
const stop = (n, stopReason) => ({ stoppedMidway: true, stoppedAt: dayOnly(n), stopReason });

const state = {
  projects: [{ id: 'P1', name: '測試專案', createdAt: '2026-10-01 10:00', status: '進行中' }],
  fieldDefs: [],
  devices: [
    dev('CA001', 'S-01', 0, 5, { batteryChangedAt: daysAgo(45) }),
    dev('CA002', 'S-02', 1, 70, { config: { ...cfg, mode: '照片+影片', videoQuality: '1080p', videoSec: 30, videoSecNight: 15,
      ironCase: true, locked: true, rainCover: false, mount: '角鋼' } }),
    dev('CA003', 'S-03', 2, 100, { lastPhotoId: 'PH-3', prevSdCard: 'SD008', batteryPct: 25 }),
    dev('CA010', 'S-04', 3, 130, { retired: true, running: false }), // 130 天前被 CA004 換下
    dev('CA004', 'S-04', 3, 130, { createdAt: daysAgo(130), config: { ...cfg, locked: false } }),
    dev('CA005', 'S-05', 4, 10, { running: false, lastNote: '相機被偷，<b>需補</b>' }),
    // 資料檢查用：樣點和 CA002 重複、記憶卡和 CA002 同一張（SD011）；另一台編號格式看不懂
    dev('CA006', 's-02', 5, 20, { sdCard: 'SD011', config: { ...cfg, ironCase: true, locked: true, rainCover: true, mount: '綁帶' } }),
    dev('ABC', 'S-07', 6, 15, { sdCard: 'X-9' }),
    // N＝另一批相機（格式正確）；12 和 CA012 在設備分頁各一列（撞號，雲端沒改）
    dev('CA024N', 'S-24', 7, 12, { sdCard: 'SD024' }),
    dev('12', 'S-12', 8, 12, { sdCard: 'SD040' }),
    dev('CA012', 'S-13', 9, 12, { sdCard: 'SD041' }),
  ],
  records: [
    rec(150, 'CA001', '林小華', { sdChanged: true, sdNew: 'SD011', sdRetrieved: 'SD010' }),
    rec(100, 'CA001', '王小明', { batteryChanged: true, batteryTypeNew: '鋰電', sdChanged: true, sdNew: 'SD010', sdRetrieved: 'SD011', ...stop(112, '沒電') }),
    rec(45, 'CA001', '林小華', { batteryChanged: true, batteryTypeNew: '鋰電', sdChanged: true, sdNew: 'SD011', sdRetrieved: 'SD010' }),
    rec(5, 'CA001', '王小明', { sdChanged: true, sdNew: 'SD010', sdRetrieved: 'SD011', note: '支架鬆了，已鎖緊' }),
    rec(140, 'CA002', '王小明', { sdChanged: true, sdNew: 'SD021', sdRetrieved: 'SD020' }),
    rec(70, 'CA002', '林小華', { sdChanged: true, sdNew: 'SD020', sdRetrieved: 'SD021', ...stop(80, '記憶卡滿') }),
    rec(160, 'CA003', '林小華', { batteryChanged: true, batteryTypeNew: '鋰電' }),
    rec(100, 'CA003', '王小明', { sdChanged: true, sdNew: 'SD012', sdRetrieved: 'SD008', batteryPct: 25, ...stop(115, '記憶卡滿') }),
    rec(170, 'CA010', '王小明', { sdChanged: true, sdNew: 'SD031', sdRetrieved: 'SD030' }),
    rec(130, 'CA010', '林小華', { running: false, cameraSwapped: true, newDeviceId: 'CA004', newCameraModel: 'Meidase P70',
      swapReason: '進水故障', batteryChanged: true, batteryTypeNew: '鋰電', sdChanged: true, sdNew: 'SD013', sdRetrieved: 'SD031',
      note: '舊機鏡頭起霧進水', ...stop(150, '其他') }),
    rec(60, 'CA005', '王小明', { batteryChanged: true, batteryTypeNew: '鋰電', sdChanged: true, sdNew: 'SD015', sdRetrieved: 'SD014' }),
    rec(10, 'CA005', '林小華', { running: false, note: '相機被偷，<b>需補</b>', ...stop(20, '其他') }),
  ],
};
const writes = [];
const photoHits = [];
let expired = false;
let backendVersion = 'v0.6'; // /__version?v= 改掉（空字串＝模擬還沒部署新版的舊 Apps Script）

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/__writes') return send(res, 200, JSON.stringify(writes), { 'Content-Type': 'application/json' });
  if (url.pathname === '/__photos') return send(res, 200, JSON.stringify(photoHits), { 'Content-Type': 'application/json' });
  if (url.pathname === '/__version') { backendVersion = url.searchParams.get('v') || ''; return send(res, 200, `version=${backendVersion}`); }
  if (url.pathname === '/__station') { // 模擬在試算表上手動改樣點編號
    const d = state.devices.find(x => x.id === url.searchParams.get('id'));
    if (d) d.stationId = url.searchParams.get('to');
    return send(res, 200, 'ok');
  }
  if (url.pathname === '/__expire') { expired = url.searchParams.get('on') === '1'; return send(res, 200, `expired=${expired}`); }
  if (url.pathname === '/__clear') {
    state.projects = []; state.devices = []; state.fieldDefs = []; state.records = [];
    return send(res, 200, 'cleared');
  }

  if (url.pathname.startsWith('/api/')) {
    if (expired) return send(res, 302, '', { Location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login/x' });
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      const me = { email: 'field@x.org', name: '王小明' };
      const version = backendVersion ? { version: backendVersion } : {};
      return send(res, 200, JSON.stringify({ ok: true, ...version, me, ...state }), { 'Content-Type': 'application/json' });
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
        // 上傳的巡檢紀錄留在雲端，下次拉資料時履歷才看得到（和真的試算表一樣）
        if (msg.action === 'addRecord' || msg.action === 'updateRecord') {
          const { photoIds, deviceState, customFields, config, ...r } = msg.payload;
          state.records = state.records.filter(x => x.recordId !== r.recordId).concat(r);
        }
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

import * as db from './db.js';

const LS = {
  inspector: 'catpatrol.inspector', // 舊版手動輸入的姓名，登入身分還沒取得時的備援
  me: 'catpatrol.me',
  uploadRule: 'catpatrol.uploadRule',
  project: 'catpatrol.project',
};

export const settings = {
  /** 登入身分 {email, name}：Cloudflare 登入的 email，姓名來自試算表「白名單」分頁 */
  get me() {
    try { return JSON.parse(localStorage.getItem(LS.me)) || {}; } catch { return {}; }
  },
  set me(v) { localStorage.setItem(LS.me, JSON.stringify(v)); },
  /** 紀錄上的巡檢人員：白名單有姓名用姓名，沒有就用 email；同一個帳號在每台裝置都一樣 */
  get inspector() {
    const me = settings.me;
    return me.name || me.email || localStorage.getItem(LS.inspector) || '';
  },
  get uploadRule() { return localStorage.getItem(LS.uploadRule) || 'wifi'; },
  set uploadRule(v) { localStorage.setItem(LS.uploadRule, v); },
  get projectId() { return localStorage.getItem(LS.project) || ''; },
  set projectId(v) { localStorage.setItem(LS.project, v); },
};

/* ---------- 時間與 id ---------- */

const pad = n => String(n).padStart(2, '0');

export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateOnly(s) {
  return (s || '').slice(0, 10);
}

export function daysSince(s) {
  if (!s) return Infinity;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
}

const rand = () => Math.random().toString(36).slice(2, 5);

export function makeRecordId(d = new Date()) {
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
           + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `REC-${ts}-${rand()}`;
}

export const makeProjectId = () => `PRJ-${Date.now().toString(36)}-${rand()}`;
export const makeFieldId = () => `FLD-${Date.now().toString(36)}-${rand()}`;
export const makeQueueId = () => `Q-${Date.now().toString(36)}-${rand()}`;

/* ---------- 設備狀態 ---------- */

/** 地圖與清單用的名稱：樣點編號優先，舊資料沒有樣點編號時用設備序號 */
export const stationLabel = d => d.stationId || d.id;

/** 優先順序：相機故障 > 未巡天數（一個月以 30 天計）> 電量低 > 正常 */
export function deviceStatus(d) {
  if (d.running === false) return '相機故障';
  const days = daysSince(d.lastPatrolAt);
  if (days > 120) return '逾4個月未巡';
  if (days > 90) return '逾3個月未巡';
  if (days > 60) return '逾2個月未巡';
  if (d.batteryPct != null && d.batteryPct <= 25) return '電量低';
  return '正常';
}

export function deviceSummary(d) {
  const status = deviceStatus(d);
  const when = `上次巡檢 ${dateOnly(d.lastPatrolAt)}`;
  if (status === '相機故障') return `${when} · 相機故障或沒電 · ${d.lastInspector || ''}`;
  return `${when} · 電量 ${d.batteryPct ?? '—'}% · ${d.lastInspector || ''}`;
}

/* ---------- 讀取 ---------- */

export const getProjects = () => db.all('projects');
export const getFieldDefs = projectId =>
  db.byIndex('fieldDefs', 'projectId', projectId).then(f => f.sort((a, b) => a.order - b.order));
// 已撤下（被更換掉）的相機不再出現在清單、地圖與巡檢選單
export const getDevices = projectId =>
  db.byIndex('devices', 'projectId', projectId).then(ds => ds.filter(d => !d.retired));
export const getDevice = id => db.get('devices', id);
export const getQueue = () => db.all('queue');

export async function getLastRecord(deviceId) {
  const records = await db.byIndex('records', 'deviceId', deviceId);
  return records.sort((a, b) => b.patrolAt.localeCompare(a.patrolAt))[0] || null;
}

/* ---------- 寫入 ---------- */

/** extra 可覆寫 id/createdAt/createdMs：修改巡檢紀錄時沿用原本的佇列位置 */
async function enqueue(type, payload, photoIds = [], extra = {}) {
  await db.put('queue', {
    id: makeQueueId(),
    type,
    payload,
    photoIds,
    createdAt: stamp(),
    createdMs: Date.now(), // 上傳需嚴格依序（紀錄要在設備之後），createdAt 只到分鐘不夠精確
    status: 'pending',
    retries: 0,
    ...extra,
  });
}

export async function addProject(name) {
  const project = { id: makeProjectId(), name, createdAt: stamp(), status: '進行中' };
  await db.put('projects', project);
  await enqueue('addProject', project);
  return project;
}

export async function saveFieldDef(def) {
  await db.put('fieldDefs', def);
  await enqueue('saveFieldDef', def);
}

export async function deleteFieldDef(id) {
  await db.del('fieldDefs', id);
  await enqueue('deleteFieldDef', { id });
}

export async function addDevice(device, photoIds = []) {
  const full = {
    ...device,
    createdBy: settings.inspector,
    createdAt: stamp(),
    lastPatrolAt: stamp(),
    lastInspector: settings.inspector,
    running: true,
  };
  await db.put('devices', full);
  await enqueue('addDevice', full, photoIds);
  return full;
}

/** type：'addRecord' 新紀錄；'updateRecord' 修改已上傳的紀錄（雲端照送來的內容覆蓋） */
export async function addRecord(record, photoIds = [], queueMeta = {}, type = 'addRecord') {
  await db.put('records', { ...record, photoIds });

  const device = await getDevice(record.deviceId);
  const updated = {
    ...device,
    lastPatrolAt: record.patrolAt,
    lastInspector: record.inspector,
    running: record.running,
    batteryPct: record.batteryPct,
    lastNote: record.note,
  };
  if (record.sdChanged) updated.sdCard = record.sdNew;
  if (record.batteryChanged) updated.batteryType = record.batteryTypeNew;
  if (record.configChanged) updated.config = record.config;
  if (record.locationChanged) { updated.lng = record.lng; updated.lat = record.lat; }

  if (record.cameraSwapped) {
    // 舊相機撤下；新相機接手位置、耗材與設定，之後的巡檢都對新編號（後端收到這筆紀錄時做同樣的事）
    await db.put('devices', {
      ...device,
      lastPatrolAt: record.patrolAt,
      lastInspector: record.inspector,
      running: record.running,
      lastNote: record.note,
      retired: true,
    });
    Object.assign(updated, {
      id: record.newDeviceId,
      qrCode: record.newDeviceId,
      cameraModel: record.newCameraModel,
      running: true,
      createdBy: record.inspector,
      createdAt: record.patrolAt,
    });
  }
  await db.put('devices', updated);

  // undo：巡檢前的設備現況，刪除或修改這筆紀錄時用來還原。
  // 修改已上傳的紀錄時連同算好的設備現況一起送，雲端不必自己推算「改回去」該是什麼
  const payload = type === 'updateRecord' ? { ...record, photoIds, deviceState: updated } : { ...record, photoIds };
  await enqueue(type, payload, photoIds, { undo: { device }, ...queueMeta });
  return updated;
}

const RECORD_TYPES = ['addRecord', 'updateRecord'];

/**
 * 能不能修改：佇列裡還留著（已上傳的保留 7 天）、有 undo（舊版建立的沒有）、不是上傳中，
 * 而且之後沒有同一台（或換上的新相機）的紀錄，否則還原會蓋掉後面那筆的結果。
 * 已上傳的換機紀錄不能改：雲端已經另起新相機那一列，改了對不回去。
 */
export function canModifyRecord(item, queue) {
  if (!RECORD_TYPES.includes(item.type) || !item.undo || item.status === 'uploading') return false;
  if (item.status === 'done' && item.payload.cameraSwapped) return false;
  const ids = [item.payload.deviceId, item.payload.newDeviceId].filter(Boolean);
  return !queue.some(q => RECORD_TYPES.includes(q.type) && q.id !== item.id
    && (q.createdMs ?? 0) > (item.createdMs ?? 0) && ids.includes(q.payload.deviceId));
}

/** 只有還沒上傳過的新紀錄能刪；已上傳過的（包括修改後待上傳的）雲端已經有了，只能改 */
export const canDeleteRecord = (item, queue) =>
  item.type === 'addRecord' && item.status !== 'done' && canModifyRecord(item, queue);

/** 這筆是不是已經上傳過（修改它會覆蓋雲端） */
export const isUploadedRecord = item => item.status === 'done' || item.type === 'updateRecord';

/** 撤銷一筆還沒上傳的巡檢紀錄對本機設備現況的影響（照片與佇列項目由呼叫端決定） */
export async function revertRecord(item) {
  const p = item.payload;
  const current = await getDevice(p.deviceId);
  // 設備現況仍是這筆紀錄造成的才還原；已被雲端較新的資料蓋過就不動
  if (current?.lastPatrolAt === p.patrolAt) await db.put('devices', item.undo.device);
  if (p.cameraSwapped && p.newDeviceId) await db.del('devices', p.newDeviceId);
  await db.del('records', p.recordId);
}

export async function deletePendingRecord(item) {
  await revertRecord(item);
  for (const photoId of item.photoIds || []) await db.del('photos', photoId);
  await db.del('queue', item.id);
}

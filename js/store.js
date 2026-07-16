import * as db from './db.js';

const LS = {
  inspector: 'catpatrol.inspector',
  uploadRule: 'catpatrol.uploadRule',
  project: 'catpatrol.project',
  apiUrl: 'catpatrol.apiUrl',
  apiToken: 'catpatrol.apiToken',
};

export const settings = {
  get inspector() { return localStorage.getItem(LS.inspector) || ''; },
  set inspector(v) { localStorage.setItem(LS.inspector, v); },
  get uploadRule() { return localStorage.getItem(LS.uploadRule) || 'wifi'; },
  set uploadRule(v) { localStorage.setItem(LS.uploadRule, v); },
  get projectId() { return localStorage.getItem(LS.project) || ''; },
  set projectId(v) { localStorage.setItem(LS.project, v); },
  get apiUrl() { return localStorage.getItem(LS.apiUrl) || ''; },
  set apiUrl(v) { localStorage.setItem(LS.apiUrl, v); },
  get apiToken() { return localStorage.getItem(LS.apiToken) || ''; },
  set apiToken(v) { localStorage.setItem(LS.apiToken, v); },
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

export const STALE_DAYS = 60;

export function deviceStatus(d) {
  if (d.running === false) return '異常';
  if (daysSince(d.lastPatrolAt) > STALE_DAYS) return '待巡檢';
  if (d.batteryPct != null && d.batteryPct <= 40) return '電量低';
  return '正常';
}

export function deviceSummary(d) {
  const status = deviceStatus(d);
  const when = `上次巡檢 ${dateOnly(d.lastPatrolAt)}`;
  if (status === '異常') return `${when} · 停止運作 · ${d.lastInspector || ''}`;
  if (status === '待巡檢') return `${when} · 超過 ${STALE_DAYS} 天未巡檢`;
  return `${when} · 電量 ${d.batteryPct ?? '—'}% · ${d.lastInspector || ''}`;
}

/* ---------- 讀取 ---------- */

export const getProjects = () => db.all('projects');
export const getFieldDefs = projectId =>
  db.byIndex('fieldDefs', 'projectId', projectId).then(f => f.sort((a, b) => a.order - b.order));
export const getDevices = projectId => db.byIndex('devices', 'projectId', projectId);
export const getDevice = id => db.get('devices', id);
export const getQueue = () => db.all('queue');

export async function getLastRecord(deviceId) {
  const records = await db.byIndex('records', 'deviceId', deviceId);
  return records.sort((a, b) => b.patrolAt.localeCompare(a.patrolAt))[0] || null;
}

export async function findDeviceByCode(code) {
  const devices = await db.all('devices');
  return devices.find(d => d.id === code || d.qrCode === code) || null;
}

/* ---------- 寫入 ---------- */

async function enqueue(type, payload, photoIds = []) {
  await db.put('queue', {
    id: makeQueueId(),
    type,
    payload,
    photoIds,
    createdAt: stamp(),
    createdMs: Date.now(), // 上傳需嚴格依序（紀錄要在設備之後），createdAt 只到分鐘不夠精確
    status: 'pending',
    retries: 0,
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

export async function addRecord(record, photoIds = []) {
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
  await db.put('devices', updated);

  await enqueue('addRecord', { ...record, photoIds }, photoIds);
  return updated;
}

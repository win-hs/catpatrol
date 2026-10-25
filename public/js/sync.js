import * as db from './db.js';
import * as store from './store.js';
import * as api from './api.js';

const MAX_BACKOFF_MS = 10 * 60 * 1000;

let running = false;
let onChange = () => {};

export const setOnChange = fn => { onChange = fn; };

/** 目前的上傳規則允不允許現在上傳 */
export function canUploadNow() {
  if (!navigator.onLine) return false;
  const rule = store.settings.uploadRule;
  if (rule === 'manual') return false;
  if (rule === 'any') return true;

  // 僅 WiFi：無法判斷連線類型的裝置退化為「有網路就上傳」
  const conn = navigator.connection;
  return !conn?.type || conn.type === 'wifi';
}

export const canDetectWifi = () => !!navigator.connection?.type;

const backoff = retries => Math.min(2 ** retries * 5000, MAX_BACKOFF_MS);

async function photosFor(item) {
  const photos = [];
  for (const [i, photoId] of (item.photoIds || []).entries()) {
    const row = await db.get('photos', photoId);
    if (!row) continue;
    photos.push({
      photoId,
      name: photoName(item, i + 1),
      dataBase64: await api.blobToBase64(row.blob),
    });
  }
  return photos;
}

function photoName(item, seq) {
  const p = item.payload;
  const stamp = String(p.patrolAt || p.createdAt || '');
  const day = stamp.slice(0, 10).replace(/-/g, '');
  const time = stamp.slice(11, 16).replace(':', '');
  const deviceId = p.deviceId || p.id;
  return `${deviceId}_${day}_${time}_${String(seq).padStart(2, '0')}.jpg`;
}

/**
 * 依序上傳佇列。順序很重要：紀錄必須在它的設備之後上傳，
 * 因此任何一筆失敗就停下，等下次再從那一筆繼續。
 */
export async function syncNow({ force = false } = {}) {
  if (running) return { skipped: '同步中' };

  running = true;
  const result = { uploaded: 0, failed: 0 };
  try {
    await purgeDone();
    if (!force && !canUploadNow()) return { skipped: '目前的上傳規則不允許上傳' };
    const queue = (await store.getQueue())
      .filter(q => q.status !== 'done')
      .sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));

    for (const item of queue) {
      if (!force && item.nextRetryAt && item.nextRetryAt > Date.now()) break;

      await save(item, { status: 'uploading' });
      try {
        await api.send(item.type, item.payload, await photosFor(item));
        for (const photoId of item.photoIds || []) await db.del('photos', photoId);
        await db.del('queue', item.id); // 資料已在雲端，佇列只留待上傳的
        onChange();
        result.uploaded += 1;
      } catch (err) {
        const retries = item.retries + 1;
        await save(item, {
          status: 'error',
          retries,
          error: String(err.message || err),
          nextRetryAt: Date.now() + backoff(retries),
        });
        result.failed += 1;
        result.error = String(err.message || err);
        result.loginExpired = err instanceof api.LoginExpiredError;
        break;
      }
    }
  } finally {
    running = false;
    onChange();
  }
  return result;
}

async function save(item, patch) {
  Object.assign(item, patch);
  await db.put('queue', item);
  onChange();
}

/** 舊版會把已上傳的項目在佇列留 7 天；現在上傳成功就移除，這裡清掉舊版留下的 */
async function purgeDone() {
  for (const item of await store.getQueue()) {
    if (item.status === 'done') await db.del('queue', item.id);
  }
}

/**
 * 從雲端拉最新資料合併進本機；本機有較新的巡檢時不覆蓋。
 * 雲端已沒有的專案、欄位、設備（例如擁有者清空了試算表）本機也移除，讓每支手機都跟雲端一致；
 * 還在佇列等上傳的不動，否則離線新增的資料會在上傳前被刪掉。
 */
export async function pull() {
  const data = await api.bootstrap();

  const keep = { projects: new Set(), fieldDefs: new Set(), devices: new Set() };
  for (const { type, payload: p } of (await store.getQueue()).filter(q => q.status !== 'done')) {
    if (type === 'addProject') keep.projects.add(p.id);
    if (type === 'saveFieldDef') keep.fieldDefs.add(p.id);
    if (type === 'addDevice') keep.devices.add(p.id);
    if (type === 'addRecord') keep.devices.add(p.deviceId).add(p.newDeviceId);
    if (p.projectId) keep.projects.add(p.projectId);
  }

  for (const project of data.projects) await db.put('projects', project);
  for (const def of data.fieldDefs) await db.put('fieldDefs', def);
  for (const device of data.devices) {
    const local = await db.get('devices', device.id);
    if (local && (local.lastPatrolAt || '') > (device.lastPatrolAt || '')) continue;
    await db.put('devices', device);
  }

  await dropMissing('projects', data.projects, keep.projects);
  await dropMissing('fieldDefs', data.fieldDefs, keep.fieldDefs);
  await dropMissing('devices', data.devices, keep.devices);
  return data;
}

async function dropMissing(storeName, remote, keep) {
  const remoteIds = new Set(remote.map(r => r.id));
  for (const row of await db.all(storeName)) {
    if (!remoteIds.has(row.id) && !keep.has(row.id)) await db.del(storeName, row.id);
  }
}

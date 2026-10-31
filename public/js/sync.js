import * as db from './db.js';
import * as store from './store.js';
import * as api from './api.js';

const KEEP_DONE_DAYS = 7;
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

    for (const queued of queue) {
      // 重讀一次：上傳途中使用者可能刪除或修改了後面還沒輪到的項目
      const item = await db.get('queue', queued.id);
      if (!item || item.status === 'done') continue;
      if (!force && item.nextRetryAt && item.nextRetryAt > Date.now()) break;

      await save(item, { status: 'uploading' });
      try {
        await api.send(item.type, item.payload, await photosFor(item));
        for (const photoId of item.photoIds || []) await db.del('photos', photoId);
        await save(item, { status: 'done', error: '', doneAt: Date.now() });
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

/** 清掉已上傳的項目：同步時自動清超過 7 天的；同步分頁「清除已上傳」按鈕傳 0 清全部 */
export async function purgeDone(keepDays = KEEP_DONE_DAYS) {
  const cutoff = Date.now() - keepDays * 86400000;
  for (const item of await store.getQueue()) {
    if (item.status === 'done' && (item.doneAt ?? 0) <= cutoff) await db.del('queue', item.id);
  }
  onChange();
}

/**
 * 從雲端拉最新資料合併進本機；設備有還沒上傳的紀錄時保留本機版本。
 * 雲端已沒有的專案、欄位、設備（例如擁有者清空了試算表）本機也移除，讓每支手機都跟雲端一致；
 * 還在佇列等上傳的不動，否則離線新增的資料會在上傳前被刪掉。
 */
export async function pull() {
  const data = await api.bootstrap();
  if (data.me) store.settings.me = data.me;

  const keep = { projects: new Set(), fieldDefs: new Set(), devices: new Set() };
  for (const { type, payload: p } of (await store.getQueue()).filter(q => q.status !== 'done')) {
    if (type === 'addProject') keep.projects.add(p.id);
    if (type === 'saveFieldDef') keep.fieldDefs.add(p.id);
    if (type === 'addDevice') keep.devices.add(p.id);
    if (type === 'addRecord' || type === 'updateRecord') keep.devices.add(p.deviceId).add(p.newDeviceId);
    if (p.projectId) keep.projects.add(p.projectId);
  }

  for (const project of data.projects) await db.put('projects', project);
  for (const def of data.fieldDefs) await db.put('fieldDefs', def);
  for (const device of data.devices) {
    // 有還沒上傳的變動才保留本機版本；其餘一律以雲端為準（在試算表上手動改的也會同步下來）
    if (keep.devices.has(device.id) && await db.get('devices', device.id)) continue;
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

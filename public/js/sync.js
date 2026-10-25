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
  if (!force && !canUploadNow()) return { skipped: '目前的上傳規則不允許上傳' };

  running = true;
  const result = { uploaded: 0, failed: 0 };
  try {
    await purgeDone();
    const queue = (await store.getQueue())
      .filter(q => q.status !== 'done')
      .sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));

    for (const item of queue) {
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

async function purgeDone() {
  const cutoff = Date.now() - KEEP_DONE_DAYS * 86400000;
  for (const item of await store.getQueue()) {
    if (item.status === 'done' && (item.doneAt ?? 0) < cutoff) await db.del('queue', item.id);
  }
}

/** 從雲端拉最新資料合併進本機；本機有較新的巡檢時不覆蓋 */
export async function pull() {
  const data = await api.bootstrap();
  for (const project of data.projects) await db.put('projects', project);

  const remoteFieldIds = new Set(data.fieldDefs.map(f => f.id));
  for (const def of data.fieldDefs) await db.put('fieldDefs', def);
  // 雲端已刪除的欄位，本機也移除（本機仍待上傳的新欄位不受影響）
  const pendingFieldIds = new Set(
    (await store.getQueue())
      .filter(q => q.status !== 'done' && q.type === 'saveFieldDef')
      .map(q => q.payload.id)
  );
  for (const def of await db.all('fieldDefs')) {
    if (!remoteFieldIds.has(def.id) && !pendingFieldIds.has(def.id)) {
      await db.del('fieldDefs', def.id);
    }
  }

  for (const device of data.devices) {
    const local = await db.get('devices', device.id);
    if (local && (local.lastPatrolAt || '') > (device.lastPatrolAt || '')) continue;
    await db.put('devices', device);
  }
  return data;
}

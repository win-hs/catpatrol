const DB_NAME = 'catpatrol';
const DB_VERSION = 1;

const OPEN_TIMEOUT_MS = 10000;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // 開啟被佔用時瀏覽器可能連 blocked 都不發，只是無限期停住；
    // 少了這個看門狗，App 會白畫面卡死且完全沒有訊息
    const watchdog = setTimeout(
      () => reject(new Error('開啟逾時，可能被其他 CATPatrol 分頁佔用')),
      OPEN_TIMEOUT_MS
    );
    const settle = (fn, value) => { clearTimeout(watchdog); fn(value); };

    req.onblocked = () => settle(reject, new Error('資料庫被其他 CATPatrol 分頁佔用'));
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });

      const devices = db.createObjectStore('devices', { keyPath: 'id' });
      devices.createIndex('projectId', 'projectId');

      const records = db.createObjectStore('records', { keyPath: 'recordId' });
      records.createIndex('deviceId', 'deviceId');

      const fieldDefs = db.createObjectStore('fieldDefs', { keyPath: 'id' });
      fieldDefs.createIndex('projectId', 'projectId');

      db.createObjectStore('queue', { keyPath: 'id' });
      db.createObjectStore('photos', { keyPath: 'photoId' });
    };
    req.onsuccess = () => settle(resolve, req.result);
    req.onerror = () => settle(reject, req.error);
  });
  dbPromise.catch(() => { dbPromise = null; }); // 失敗後允許重試
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const put = (store, value) => run(store, 'readwrite', s => s.put(value));
export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const all = store => run(store, 'readonly', s => s.getAll());
export const byIndex = (store, index, value) =>
  run(store, 'readonly', s => s.index(index).getAll(value));

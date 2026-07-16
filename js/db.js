const DB_NAME = 'catpatrol';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

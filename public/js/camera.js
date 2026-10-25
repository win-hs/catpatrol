import * as db from './db.js';

const MAX_EDGE = 1600;
const QUALITY = 0.8;

export async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
}

const makePhotoId = () =>
  `PHO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

/**
 * 將照片區塊接上相機：拍照 → 壓縮 → 存 IndexedDB → 縮圖預覽。
 * 回傳 { ids, take, reset } 供表單存檔時取用。
 */
export function photoGrid(container) {
  let items = [];
  let busy = 0;
  let pending = Promise.resolve();

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.multiple = true;
  input.hidden = true;
  container.append(input);

  function render() {
    container.querySelectorAll('.ph').forEach(el => el.remove());
    const addBtn = container.querySelector('.add');
    for (const item of items) {
      const cell = document.createElement('div');
      cell.className = 'ph';
      cell.innerHTML = `<img src="${item.url}" alt="">`
        + `<button class="ph-del" type="button" data-photo="${item.photoId}" title="刪除">✕</button>`;
      container.insertBefore(cell, addBtn);
    }
    for (let i = 0; i < busy; i++) {
      const cell = document.createElement('div');
      cell.className = 'ph busy';
      cell.textContent = '⏳';
      container.insertBefore(cell, addBtn);
    }
  }

  container.addEventListener('click', async e => {
    if (e.target.closest('.add')) return input.click();

    const del = e.target.closest('[data-photo]');
    if (!del) return;
    const { photo } = del.dataset;
    const item = items.find(i => i.photoId === photo);
    if (item) URL.revokeObjectURL(item.url);
    items = items.filter(i => i.photoId !== photo);
    await db.del('photos', photo);
    render();
  });

  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    busy += files.length;
    render();

    // 串接處理：存檔時以 ready() 等待，避免壓縮未完成就送出而漏掉照片
    pending = pending.then(async () => {
      for (const file of files) {
        const blob = await compressImage(file);
        const photoId = makePhotoId();
        await db.put('photos', { photoId, blob, capturedAt: new Date().toISOString() });
        items.push({ photoId, url: URL.createObjectURL(blob) });
        busy--;
        render();
      }
    });
  });

  return {
    /** 等待所有進行中的壓縮完成 */
    ready: () => pending,
    ids: () => items.map(i => i.photoId),
    /** 存檔時呼叫：交出 id 並清空預覽（blob 保留給上傳佇列） */
    take() {
      const ids = items.map(i => i.photoId);
      items.forEach(i => URL.revokeObjectURL(i.url));
      items = [];
      render();
      return ids;
    },
    /** 放棄表單時呼叫：連同 blob 一起刪除 */
    async reset() {
      await pending;
      for (const item of items) {
        URL.revokeObjectURL(item.url);
        await db.del('photos', item.photoId);
      }
      items = [];
      render();
    },
  };
}

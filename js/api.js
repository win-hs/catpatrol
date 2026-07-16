import * as store from './store.js';

export const isConfigured = () => !!store.settings.apiUrl;

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function parse(res) {
  if (!res.ok) throw new Error(`伺服器回應 HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Apps Script 未設「所有人可存取」時會回傳登入頁 HTML
    throw new Error('雲端回傳的不是 JSON，請檢查部署設定的「誰可以存取」是否為「所有人」');
  }
  if (!data.ok) throw new Error(data.error || '雲端回傳未知錯誤');
  return data;
}

export async function bootstrap() {
  const url = `${store.settings.apiUrl}?action=bootstrap`
    + `&token=${encodeURIComponent(store.settings.apiToken)}`;
  return parse(await fetch(url, { method: 'GET' }));
}

export async function send(action, payload, photos = []) {
  // 用 text/plain 送 JSON 字串：避開 CORS preflight（Apps Script 無法回應 OPTIONS）
  const res = await fetch(store.settings.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: store.settings.apiToken, action, payload, photos }),
  });
  return parse(res);
}

// 雲端 API 一律經同網域的 Cloudflare Worker（/api/*）代轉，Apps Script 網址與 token 不在手機上

/** 登入（Cloudflare Access）過期：Worker 回 401，或請求被導去登入頁 */
export class LoginExpiredError extends Error {
  constructor() {
    super('登入已過期，請到「同步」分頁按「重新登入」（資料仍安全存在手機）');
    this.name = 'LoginExpiredError';
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function parse(res) {
  if (res.type === 'opaqueredirect' || res.status === 401) throw new LoginExpiredError();
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`伺服器回應 HTTP ${res.status}，內容不是 JSON`);
  }
  if (!data.ok) throw new Error(data.error || '雲端回傳未知錯誤');
  return data;
}

// redirect: 'manual'：登入過期時 Access 會 302 到登入頁，不能讓 fetch 自己跟過去
export async function bootstrap() {
  return parse(await fetch('api/bootstrap', { redirect: 'manual', cache: 'no-store' }));
}

export async function send(action, payload, photos = []) {
  const res = await fetch('api/write', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload, photos }),
  });
  return parse(res);
}

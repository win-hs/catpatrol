/**
 * CATPatrol Worker：/api/* 代轉到 Apps Script，其餘交給 public/ 靜態檔。
 * Apps Script 網址與 token 只存在 Worker 的 secrets，手機上看不到，也不在 repo 裡。
 *
 *   GET  /api/bootstrap   → Apps Script ?action=bootstrap
 *   GET  /api/photo?id=…  → Apps Script ?action=photo&id=…（巡檢時顯示上次的照片）
 *   POST /api/write       → Apps Script doPost（body 原封不動轉送）
 */

const keys = new Map(); // Access 簽章公鑰快取：kid → CryptoKey

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // workers.dev 前面已有 Access 擋著；這裡再驗一次憑證，避免日後多了沒保護的網址就直接漏資料
    const auth = await verifyAccess(request, env);
    if (auth.status === 'mismatch') {
      // 不能回 401：App 會當成登入過期，使用者重新登入也沒用
      return json({ ok: false, error: 'Worker 的 Access 設定（wrangler.jsonc 的 ACCESS_TEAM_DOMAIN / ACCESS_AUD）與目前的 Cloudflare Access 不符' }, 500);
    }
    if (auth.status !== 'ok') return json({ ok: false, error: '登入已過期，請重新登入' }, 401);
    if (!env.APPS_SCRIPT_URL || !env.API_TOKEN) {
      return json({ ok: false, error: 'Worker 尚未設定 APPS_SCRIPT_URL / API_TOKEN' }, 500);
    }

    const target = new URL(env.APPS_SCRIPT_URL);
    target.searchParams.set('token', env.API_TOKEN);
    // 驗證過的登入 email：Apps Script 用它查白名單姓名，同一個人在每台裝置都是同一個身分
    target.searchParams.set('user', auth.email);

    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      target.searchParams.set('action', 'bootstrap');
      return relay(await fetch(target));
    }
    if (request.method === 'GET' && url.pathname === '/api/photo') {
      target.searchParams.set('action', 'photo');
      target.searchParams.set('id', url.searchParams.get('id') || '');
      return relay(await fetch(target));
    }
    if (request.method === 'POST' && url.pathname === '/api/write') {
      // 不解析 body：照片 base64 動輒數 MB，免費方案每次只有 10ms CPU
      return relay(await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: await request.arrayBuffer(),
      }));
    }
    return json({ ok: false, error: '未知的 API 路徑' }, 404);
  },
};

async function relay(res) {
  // Apps Script 存取權沒設「所有人」時會回 Google 登入頁 HTML
  if (!(res.headers.get('Content-Type') || '').includes('json')) {
    return json({ ok: false, error: 'Apps Script 回傳的不是 JSON，請檢查部署的「誰可以存取」是否為「所有人」' }, 502);
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* ════════ Cloudflare Access 憑證驗證 ════════ */

/**
 * status：'ok'｜'invalid'（沒帶、過期或簽章不對）｜'mismatch'（憑證屬於別的團隊或應用程式：多半是設定沒跟著改）
 * email：status 為 'ok' 時才有
 */
async function verifyAccess(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const parts = jwt ? jwt.split('.') : [];
  if (parts.length !== 3) return { status: 'invalid' };

  try {
    const [head, body, sig] = parts;
    const header = JSON.parse(b64urlText(head));
    const claims = JSON.parse(b64urlText(body));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== env.ACCESS_TEAM_DOMAIN || !aud.includes(env.ACCESS_AUD)) return { status: 'mismatch' };
    if (!claims.exp || claims.exp * 1000 < Date.now()) return { status: 'invalid' };

    const key = await accessKey(env, header.kid);
    if (!key) return { status: 'invalid' };
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${head}.${body}`)
    );
    return valid ? { status: 'ok', email: String(claims.email || '').toLowerCase() } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

async function accessKey(env, kid) {
  if (!keys.has(kid)) {
    // 首次使用或 Access 輪替金鑰後重抓
    const res = await fetch(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const { keys: list = [] } = await res.json();
    keys.clear();
    for (const jwk of list) {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
      ));
    }
  }
  return keys.get(kid);
}

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

const b64urlText = s => new TextDecoder().decode(b64urlBytes(s));

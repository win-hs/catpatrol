/** 使用者輸入的文字（備註、樣點編號）放進 innerHTML 前先跳脫 */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ---------- 編號：相機 CA＋3 碼、記憶卡 SD＋3 碼（code.gs 的 camId_ / sdId_ 規則相同） ---------- */

const code = (re, prefix) => v => {
  const m = String(v ?? '').trim().match(re);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 999 ? prefix + String(n).padStart(3, '0') : v;
};
/** 1、132、ca-78 → CA001、CA132、CA078；只認 1–999，看不懂的原樣回傳 */
export const camId = code(/^(?:ca)?[\s\-_]*(\d+)$/i, 'CA');
/** 野12、Wv12、12 → SD012（野／Wv 意思一樣） */
export const sdId = code(/^(?:sd|野|wv)?[\s\-_]*(\d+)$/i, 'SD');
export const isCamId = v => /^CA\d{3}$/.test(String(v));
export const isSdId = v => /^SD\d{3}$/.test(String(v));

/** 只填數字的編號欄（前面固定顯示 CA／SD）：存檔用的完整編號，填錯回 null */
export function codeValue(el) {
  const prefix = el.dataset.code;
  const full = (prefix === 'SD' ? sdId : camId)(el.value);
  return (prefix === 'SD' ? isSdId : isCamId)(full) && /^\d+$/.test(el.value.trim()) ? full : null;
}

/** 已存的編號填回只填數字的欄位（CA012 → 012） */
export const codeDigits = v => String(v ?? '').replace(/^\D+/, '');

export function requireCode(el, label) {
  if (codeValue(el)) return true;
  markError(el, el.value.trim() ? `${label}只能填 1–999 的數字` : `請輸入${label}`);
  return false;
}

/* ---------- 驗證 ---------- */

export function clearErrors(scope) {
  scope.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  scope.querySelectorAll('.field-err').forEach(el => el.remove());
}

export function markError(el, msg) {
  el.classList.add('invalid');
  const note = document.createElement('p');
  note.className = 'field-err';
  note.textContent = msg;
  el.insertAdjacentElement('afterend', note);
}

export function require(el, msg) {
  if (String(el.value).trim()) return true;
  markError(el, msg);
  return false;
}

/**
 * 座標一格寫「緯度, 經度」（和 Google 地圖複製出來的一樣，貼進 Google 搜尋也能直接用）。
 * 逗號（全形半形都可）或空白分隔；格式不對回 null。
 */
export function parseCoord(text) {
  const parts = String(text).trim().split(/[\s,，]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [lat, lng] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export const formatCoord = (lat, lng) =>
  (Number.isFinite(lat) && Number.isFinite(lng) ? `${lat}, ${lng}` : '—');

export function requireCoord(el) {
  if (parseCoord(el.value)) return true;
  // 最常見的錯：經度寫在前面（台灣經度約 120，超過緯度上限 90）
  const first = Number(String(el.value).trim().split(/[\s,，]+/)[0]);
  markError(el, Math.abs(first) > 90
    ? '緯度要寫在前面，例：23.51234, 120.30772'
    : '請輸入「緯度, 經度」，例：23.51234, 120.30772，或按 GPS 定位');
  return false;
}

/* ---------- 專案自訂欄位 ---------- */

export function renderCustomFields(container, defs, values = {}) {
  container.innerHTML = '';
  if (!defs.length) {
    container.innerHTML = '<p class="sec-note" style="margin:0;">此專案尚未設定自訂欄位。</p>';
    return;
  }

  for (const def of defs) {
    const value = values[def.name];
    const req = def.required ? ' <span class="req">*</span>' : '';

    if (def.type === '勾選') {
      const row = document.createElement('div');
      row.className = 'tgl-row';
      row.innerHTML = `<span>${def.name}</span>`;
      const tgl = document.createElement('button');
      tgl.type = 'button';
      tgl.className = 'tgl' + (value ? ' on' : '');
      tgl.dataset.tgl = '';
      tgl.dataset.fieldId = def.id;
      row.append(tgl);
      container.append(row);
      continue;
    }

    const label = document.createElement('label');
    label.className = 'f';
    label.innerHTML = def.name + req;
    container.append(label);

    let input;
    if (def.type === '單選') {
      input = document.createElement('select');
      input.innerHTML = '<option value="">請選擇…</option>'
        + def.options.map(o => `<option${o === value ? ' selected' : ''}>${o}</option>`).join('');
    } else {
      input = document.createElement('input');
      input.type = def.type === '數字' ? 'number' : 'text';
      if (value != null) input.value = value;
    }
    input.dataset.fieldId = def.id;
    container.append(input);
  }
}

export function collectCustomFields(container, defs) {
  const values = {};
  for (const def of defs) {
    const el = container.querySelector(`[data-field-id="${def.id}"]`);
    if (!el) continue;
    if (def.type === '勾選') values[def.name] = el.classList.contains('on');
    else if (def.type === '數字') values[def.name] = el.value === '' ? null : Number(el.value);
    else values[def.name] = el.value.trim();
  }
  return values;
}

export function validateCustomFields(container, defs) {
  let ok = true;
  for (const def of defs) {
    if (!def.required || def.type === '勾選') continue;
    const el = container.querySelector(`[data-field-id="${def.id}"]`);
    if (el && !String(el.value).trim()) {
      markError(el, `請填寫${def.name}`);
      ok = false;
    }
  }
  return ok;
}

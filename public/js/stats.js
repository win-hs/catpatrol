// 相機履歷、出發準備、統計（漏拍、工作量）、資料檢查的計算。純函式：不碰畫面也不碰資料庫，可以直接在 Node 測試
import { stationLabel } from './store.js';
import { sdId, isCamId, isSdId } from './form.js';

const DAY = 86400000;
const key = id => String(id);
const byTime = (a, b) => String(a.patrolAt).localeCompare(String(b.patrolAt));
const hasId = v => v != null && v !== '';

/** 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm'（手機的本地時間）→ 毫秒；只有日期時算當天 0 點 */
export function toMs(s) {
  const t = String(s || '').trim();
  if (!t) return NaN;
  return new Date(t.length <= 10 ? `${t}T00:00` : t.replace(' ', 'T')).getTime();
}

/* ═══════════ 相機履歷 ═══════════ */

/** 換機前後算同一個樣點：往回找被換掉的舊相機，回傳 [最舊…目前] 的設備序號 */
export function chainIds(id, records) {
  const prev = new Map();
  records.forEach(r => { if (r.cameraSwapped && hasId(r.newDeviceId)) prev.set(key(r.newDeviceId), r.deviceId); });
  const ids = [id];
  const seen = new Set([key(id)]);
  let cur = id;
  while (prev.has(key(cur)) && !seen.has(key(prev.get(key(cur))))) {
    cur = prev.get(key(cur));
    seen.add(key(cur));
    ids.unshift(cur);
  }
  return ids;
}

/** 一個樣點（含換機前的舊相機）的巡檢紀錄，新的在前 */
export function stationHistory(id, records) {
  const ids = new Set(chainIds(id, records).map(key));
  return records.filter(r => ids.has(key(r.deviceId))).sort(byTime).reverse();
}

/* ═══════════ 漏拍 ═══════════ */

/**
 * 沒在拍的區段 {deviceId, start, end, reason, ongoing}：
 *  - 中間有停：停止時間 → 這次巡檢（原因＝沒電／記憶卡滿／其他）
 *  - 相機故障或沒電（巡檢時現場就是壞的、也沒換機）：這次巡檢 → 同一台的下一次巡檢；還沒再巡過就算到現在
 */
export function downtimes(records, now = Date.now()) {
  const byDevice = new Map();
  [...records].sort(byTime).forEach(r => {
    const k = key(r.deviceId);
    if (!byDevice.has(k)) byDevice.set(k, []);
    byDevice.get(k).push(r);
  });
  const out = [];
  byDevice.forEach(list => list.forEach((r, i) => {
    const at = toMs(r.patrolAt);
    if (r.stoppedMidway && r.stoppedAt) {
      const start = toMs(r.stoppedAt);
      if (start < at) out.push({ deviceId: r.deviceId, start, end: at, reason: r.stopReason || '其他' });
    }
    if (r.running === false && !r.cameraSwapped) {
      const next = list[i + 1];
      const end = next ? toMs(next.patrolAt) : now;
      if (end > at) out.push({ deviceId: r.deviceId, start: at, end, reason: '未運作', ongoing: !next });
    }
  }));
  return out;
}

/** 各台在 [from, to) 內漏拍的毫秒數（重疊的區段只算一次）→ Map(序號 → {deviceId, ms, reasons, ongoing}) */
export function lostByDevice(intervals, from = -Infinity, to = Infinity) {
  const groups = new Map();
  intervals.forEach(iv => {
    const start = Math.max(iv.start, from);
    const end = Math.min(iv.end, to);
    if (!(end > start)) return;
    const k = key(iv.deviceId);
    if (!groups.has(k)) groups.set(k, { deviceId: iv.deviceId, parts: [], reasons: [], ongoing: false });
    const g = groups.get(k);
    g.parts.push([start, end]);
    if (!g.reasons.includes(iv.reason)) g.reasons.push(iv.reason);
    if (iv.ongoing) g.ongoing = true;
  });
  const out = new Map();
  groups.forEach((g, k) => {
    g.parts.sort((a, b) => a[0] - b[0]);
    let ms = 0;
    let [s0, e0] = g.parts[0];
    g.parts.slice(1).forEach(([s, e]) => {
      if (s > e0) { ms += e0 - s0; [s0, e0] = [s, e]; } else e0 = Math.max(e0, e);
    });
    ms += e0 - s0;
    out.set(k, { deviceId: g.deviceId, ms, reasons: g.reasons, ongoing: g.ongoing });
  });
  return out;
}

/**
 * 漏拍統計，期間 [from, to)，只算到現在為止：
 *  expected＝各台在現場的天數加總（架設 → 被換下或現在）；lost＝沒在拍的天數；cams＝這段期間在現場的相機數；
 *  rows＝依樣點彙整（換機前後算同一個樣點）、漏得多的在前，deviceId 是目前在那個樣點的相機
 */
export function downtimeReport(devices, records, from, to, now = Date.now()) {
  const end = Math.min(to, now);
  const result = { expected: 0, lost: 0, cams: 0, rows: [] };
  if (!(end > from)) return result;

  const swapAt = new Map(records.filter(r => r.cameraSwapped).map(r => [key(r.deviceId), toMs(r.patrolAt)]));
  devices.forEach(d => {
    const s = toMs(d.createdAt);
    const e = d.retired ? (swapAt.get(key(d.id)) ?? toMs(d.lastPatrolAt)) : now;
    const ov = Math.min(e, end) - Math.max(s, from);
    if (ov > 0) {
      result.expected += ov;
      result.cams++;
    }
  });

  const devById = new Map(devices.map(d => [key(d.id), d]));
  const rows = new Map();
  lostByDevice(downtimes(records, now), from, end).forEach(({ deviceId, ms, reasons, ongoing }) => {
    const d = devById.get(key(deviceId));
    if (!d) return; // 別的專案的設備，或已從試算表刪掉
    result.lost += ms;
    const label = stationLabel(d);
    const row = rows.get(label) || { label, ms: 0, reasons: [], ongoing: false };
    row.ms += ms;
    reasons.forEach(x => { if (!row.reasons.includes(x)) row.reasons.push(x); });
    row.ongoing = row.ongoing || (ongoing && !d.retired);
    rows.set(label, row);
  });
  result.rows = [...rows.values()]
    .map(r => ({ ...r, days: r.ms / DAY, deviceId: devices.find(d => !d.retired && stationLabel(d) === r.label)?.id ?? null }))
    .sort((a, b) => b.ms - a.ms);
  result.expected /= DAY;
  result.lost /= DAY;
  return result;
}

/** 有在拍的比例（0–1）；這段期間沒有相機在現場時為 null */
export const workingRate = rep => (rep.expected > 0 ? Math.min(1, Math.max(0, 1 - rep.lost / rep.expected)) : null);

/* ═══════════ 工作量 ═══════════ */

/**
 * 工作量，期間 [from, to)：每人的出勤日（不同日期數）、台次（巡檢筆數）、換電、換卡、換機；
 * 合計的出勤日是「有人出去的天數」（兩人同一天去算 1 天）；電池用量依新電池類型；出勤明細依日期
 */
export function workload(records, from, to) {
  const people = new Map();
  const battery = new Map();
  const detail = new Map();
  const days = new Set();
  const total = { count: 0, battery: 0, sd: 0, swap: 0 };

  records.forEach(r => {
    const t = toMs(r.patrolAt);
    if (!(t >= from && t < to)) return;
    const name = String(r.inspector ?? '').trim() || '（未填）';
    const day = String(r.patrolAt).slice(0, 10);
    const p = people.get(name) || { name, days: new Set(), count: 0, battery: 0, sd: 0, swap: 0 };
    p.days.add(day);
    p.count++;
    total.count++;
    if (r.batteryChanged) {
      p.battery++;
      total.battery++;
      const type = r.batteryTypeNew || '（未填類型）';
      battery.set(type, (battery.get(type) || 0) + 1);
    }
    if (r.sdChanged) { p.sd++; total.sd++; }
    if (r.cameraSwapped) { p.swap++; total.swap++; }
    people.set(name, p);
    days.add(day);
    const dk = `${day}|${name}`;
    detail.set(dk, { day, name, n: (detail.get(dk)?.n || 0) + 1 });
  });

  return {
    people: [...people.values()].map(p => ({ ...p, days: p.days.size }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    total: { ...total, days: days.size },
    battery: [...battery].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
    detail: [...detail.values()].sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name)),
  };
}

/* ═══════════ 出發準備 ═══════════ */

/** 怎麼帶（出發準備上面三排）：電池 all＝全部換／low＝50% 以下才換；記憶卡 each／half／third；防護 full＝整套／gaps＝補缺漏 */
export const PACK_DEFAULTS = { battery: 'all', sd: 'each', guard: 'full' };

/** 現場防護三樣；沒記為「有」的都算缺（還沒填過的也算，寧可多帶） */
export const GUARD_ITEMS = [['ironCase', '鐵殼', '個'], ['locked', '鎖', '個'], ['rainCover', '遮雨板', '片']];
export const missingGuards = d => GUARD_ITEMS.filter(([key]) => (d.config || {})[key] !== true).map(([key]) => key);

/**
 * 這台要帶什麼：
 *  battery＝電池類型（不用帶為 null；外接電源一律不帶）：全部換＝每台都帶，50% 以下才換＝電量 ≤ 50% 或離開時未運作
 *  spare＝未運作要帶備用相機；guards＝缺的防護
 */
export function packNeeds(d, opts = PACK_DEFAULTS) {
  const down = d.running === false;
  const low = d.batteryPct != null && d.batteryPct !== '' && Number(d.batteryPct) <= 50;
  const wantBattery = opts.battery === 'all' || down || low;
  return {
    battery: d.batteryType !== '外接電源' && wantBattery ? (d.batteryType || '（未填類型）') : null,
    spare: down,
    guards: missingGuards(d),
  };
}

/** 記憶卡張數：每台一張、備一半、備 1/3（無條件進位） */
export const sdCount = (n, mode) => (mode === 'half' ? Math.ceil(n / 2) : mode === 'third' ? Math.ceil(n / 3) : n);

/**
 * 勾選的相機合起來要帶的東西（labels 依傳入順序）：
 *  battery＝[{type, labels}]、batteryTotal＝共幾組；sd＝張數；spare＝[{label, model}]；
 *  guard.kits＝要整套的相機（全部上防護）；guard.items＝各樣要帶到哪幾台；guard.total＝套數或件數
 */
export function packSummary(devices, opts = PACK_DEFAULTS) {
  const battery = new Map();
  const kits = [];
  const items = Object.fromEntries(GUARD_ITEMS.map(([key]) => [key, []]));
  const spare = [];
  devices.forEach(d => {
    const need = packNeeds(d, opts);
    const label = stationLabel(d);
    if (need.battery) battery.set(need.battery, [...(battery.get(need.battery) || []), label]);
    if (need.spare) spare.push({ label, model: d.cameraModel || '' });
    if (!need.guards.length) return;
    kits.push(label);
    // 全部上防護：三樣都帶；補缺漏：只帶缺的
    (opts.guard === 'gaps' ? need.guards : GUARD_ITEMS.map(([key]) => key)).forEach(key => items[key].push(label));
  });
  const batteryList = [...battery].map(([type, labels]) => ({ type, labels }));
  return {
    count: devices.length,
    battery: batteryList,
    batteryTotal: batteryList.reduce((n, b) => n + b.labels.length, 0),
    sd: sdCount(devices.length, opts.sd),
    spare,
    guard: {
      mode: opts.guard === 'gaps' ? 'gaps' : 'full',
      kits,
      items,
      total: opts.guard === 'gaps' ? Object.values(items).reduce((n, l) => n + l.length, 0) : kits.length,
    },
  };
}

/* ═══════════ 資料檢查 ═══════════ */

/** 樣點編號比對用：不分大小寫、忽略空白（s-03＝S-03） */
export const stationKey = s => String(s ?? '').replace(/\s+/g, '').toUpperCase();

/** 同一組 key 出現在兩台以上的 → [{key, devices}]（key 空白的不算） */
function duplicates(devices, keyOf) {
  const groups = new Map();
  devices.forEach(d => {
    const k = keyOf(d);
    if (!k) return;
    groups.set(k, [...(groups.get(k) || []), d]);
  });
  return [...groups].filter(([, list]) => list.length > 1).map(([k, list]) => ({ key: k, devices: list }));
}

/**
 * 這個專案還在用的相機（不含已撤下）的資料問題：
 *  stations＝樣點編號重複、cards＝記憶卡重複（野12／Wv12／SD012 算同一張）、
 *  badIds／badCards＝編號不是 CA＋3 碼（可帶 N）／SD＋3 碼（改編號時看不懂或撞號、留給人工改的）
 */
export function dataIssues(devices) {
  const active = devices.filter(d => !d.retired);
  return {
    stations: duplicates(active, d => stationKey(d.stationId)),
    cards: duplicates(active, d => (d.sdCard ? String(sdId(d.sdCard)) : '')),
    badIds: active.filter(d => !isCamId(d.id)),
    badCards: active.filter(d => d.sdCard && !isSdId(d.sdCard)),
  };
}

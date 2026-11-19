// 相機履歷、出發準備、統計（漏拍、續航、工作量）的計算。純函式：不碰畫面也不碰資料庫，可以直接在 Node 測試
import { stationLabel, daysSince } from './store.js';

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
      if (end > at) out.push({ deviceId: r.deviceId, start: at, end, reason: '故障', ongoing: !next });
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

/* ═══════════ 續航 ═══════════ */

/** 拍攝設定的短說明（「換卡後幾天滿」分組用）：照片 32MP ×3 連拍／影片 1080p · 日30秒/夜15秒 */
export function shootLabel(cfg) {
  if (!cfg) return '（沒有設定）';
  const photo = `照片 ${cfg.photoQuality || '—'}${cfg.burst > 1 ? ` ×${cfg.burst} 連拍` : ''}`;
  const night = cfg.videoSecNight != null && cfg.videoSecNight !== cfg.videoSec;
  const sec = night ? `日${cfg.videoSec ?? '—'}秒/夜${cfg.videoSecNight}秒` : `${cfg.videoSec ?? '—'}秒`;
  const video = `影片 ${cfg.videoQuality || '—'} · ${sec}`;
  if (cfg.mode === '影片') return video;
  if (cfg.mode === '照片+影片') return `${photo} ＋ ${video}`;
  return photo;
}

/**
 * 續航：換電池（kind='battery'）或換記憶卡（kind='sd'）後，撐了幾天就「中間有停」（沒電／記憶卡滿）。
 * 只算得到真的停過的那幾次。起算時間和設備清單的電池天數同一套：沒換過＝架設時間，換機的新相機沿用舊相機的。
 * 回傳依「型號＋電池類型」（或「型號＋拍攝設定」）分組的 [{model, sub, n, min, median}]，天數為小數
 */
export function lifeStats(devices, records, kind) {
  const devById = new Map(devices.map(d => [key(d.id), d]));
  const reason = kind === 'battery' ? '沒電' : '記憶卡滿';
  const since = new Map(); // 序號 → { at, type }
  const startOf = k => since.get(k) || { at: toMs(devById.get(k)?.createdAt), type: devById.get(k)?.batteryType || '' };
  const groups = new Map();

  [...records].sort(byTime).forEach(r => {
    const k = key(r.deviceId);
    const cur = startOf(k);
    const d = devById.get(k);
    if (d && r.stoppedMidway && r.stopReason === reason) {
      const days = (toMs(r.stoppedAt) - cur.at) / DAY;
      const sub = kind === 'battery' ? (cur.type || '（未填類型）') : shootLabel(d.config);
      if (days > 0 && sub !== '外接電源') {
        const model = d.cameraModel || '（未填型號）';
        const gk = `${model}|${sub}`;
        if (!groups.has(gk)) groups.set(gk, { model, sub, days: [] });
        groups.get(gk).days.push(days);
      }
    }
    const changed = kind === 'battery' ? r.batteryChanged : r.sdChanged;
    if (changed) since.set(k, { at: toMs(r.patrolAt), type: r.batteryTypeNew || cur.type });
    if (r.cameraSwapped && hasId(r.newDeviceId)) since.set(key(r.newDeviceId), since.get(k) || cur);
  });

  return [...groups.values()].map(g => {
    const s = [...g.days].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return { model: g.model, sub: g.sub, n: s.length, min: s[0], median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 };
  }).sort((a, b) => a.model.localeCompare(b.model) || a.sub.localeCompare(b.sub));
}

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

/** 預設要去的：逾 60 天沒巡（和地圖變黃同一條線），或相機故障／沒電 */
export const isDue = d => d.running === false || daysSince(d.lastPatrolAt) > 60;

/**
 * 這台要帶什麼：換電池＝上次電量 ≤ 50%，或相機故障／沒電（外接電源不算）；記憶卡每台一張；
 * 故障要帶備機；現場防護記為「沒有」的（不是沒填）帶過去補
 */
export function packNeeds(d) {
  const down = d.running === false;
  const cfg = d.config || {};
  const low = d.batteryPct != null && d.batteryPct !== '' && Number(d.batteryPct) <= 50;
  return {
    battery: d.batteryType !== '外接電源' && (down || low) ? (d.batteryType || '（未填類型）') : null,
    sd: true,
    spare: down,
    iron: cfg.ironCase === false,
    lock: cfg.locked === false,
    rain: cfg.rainCover === false,
  };
}

/** 勾選的相機合起來要帶的東西（labels 依傳入順序） */
export function packSummary(devices) {
  const battery = new Map();
  const out = { count: devices.length, battery: [], sd: devices.length, spare: [], iron: [], lock: [], rain: [] };
  devices.forEach(d => {
    const need = packNeeds(d);
    const label = stationLabel(d);
    if (need.battery) battery.set(need.battery, [...(battery.get(need.battery) || []), label]);
    if (need.spare) out.spare.push({ label, model: d.cameraModel || '' });
    if (need.iron) out.iron.push(label);
    if (need.lock) out.lock.push(label);
    if (need.rain) out.rain.push(label);
  });
  out.battery = [...battery].map(([type, labels]) => ({ type, labels }));
  return out;
}

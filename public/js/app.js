import * as map from './map.js';
import * as store from './store.js';
import * as form from './form.js';
import * as camera from './camera.js';
import * as sync from './sync.js';
import * as api from './api.js';
import * as stats from './stats.js';
import { configForm, configSummary, missingFields, MODEL_OPTIONS, MOUNTS } from './cam-config.js';

// 與 sw.js 的 VERSION 一起改：顯示在標題旁，用來確認手機上是不是已經換成新版
const APP_VERSION = 'v0.5';
// 這版網頁需要的 Apps Script 版本（code.gs 的 VERSION）；雲端比這舊就在首頁提醒重新部署
const BACKEND_NEEDED = 'v0.5';
let backendVersion = '';

const versionParts = v => String(v || '0').replace(/^v/, '').split('.').map(Number);
const olderThan = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
};

const $ = id => document.getElementById(id);
const { esc } = form;
const screens = $('screens');

const addPhotos = camera.photoGrid($('add-photos'));
const patrolPhotos = camera.photoGrid($('pt-photos'));
const addCfg = configForm('add');
const ptCfg = configForm('pt');

// 正在修改的那筆還沒上傳的巡檢紀錄（佇列項目）；null＝一般新增
let editing = null;
// 設備清單／地圖上選取的相機；離開設備分頁就取消
let selectedId = null;
// 打開履歷的相機（只會是選取中的那台）；historyAll＝顯示全部筆數
let historyId = null;
let historyAll = false;
// 從統計點樣點回到清單時，畫好後把那張卡片捲進畫面
let scrollToSelected = false;

/* ═══════════ 導覽 ═══════════ */

/**
 * auto：進巡檢分頁時依 GPS 自動選最近的樣點；deviceId：直接開這台（從設備清單點進來）
 */
export function go(screenId, { auto = true, deviceId } = {}) {
  if (editing && screenId !== 'scr-patrol') cancelEdit();
  if (screenId !== 'scr-home') selectedId = null;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
  // 出發準備是從設備分頁進去的，底下仍亮「設備」
  const navId = screenId === 'scr-pack' ? 'scr-home' : screenId;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === navId));
  screens.scrollTop = 0;
  if (screenId === 'scr-home') { map.resizeMap(); renderHome(); }
  if (screenId === 'scr-add') refreshAddMeta();
  if (screenId === 'scr-patrol') renderPatrol({ auto: auto && !deviceId, deviceId });
  if (screenId === 'scr-sync') renderSync();
  if (screenId === 'scr-pack') renderPack({ reset: true });
  if (screenId === 'scr-stats') renderStats();
}

// 在設備分頁選了相機再按「巡檢」＝巡檢那台；沒選就照常依 GPS 選最近的
document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => go(btn.dataset.screen,
    btn.dataset.screen === 'scr-patrol' && selectedId ? { deviceId: selectedId } : undefined));
});

/* ═══════════ 共用 UI 行為 ═══════════ */

const setSeg = (el, value) => el.querySelectorAll('button')
  .forEach(b => b.classList.toggle('on', b.dataset.value === value));

document.addEventListener('click', e => {
  const goTarget = e.target.closest('[data-go]');
  if (goTarget) return go(goTarget.dataset.go);

  const tgl = e.target.closest('[data-tgl]');
  if (tgl) {
    const on = tgl.classList.toggle('on');
    if (tgl.dataset.reveal) $(tgl.dataset.reveal.slice(1)).hidden = !on;
    return;
  }

  const segBtn = e.target.closest('.seg[data-seg] button');
  if (segBtn) {
    segBtn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === segBtn));
    if (segBtn.parentElement.id === 'upload-rule') store.settings.uploadRule = segBtn.dataset.value;
  }
});

// 相機／記憶卡編號欄：離開時補成 3 碼（填 1 顯示 001）
document.addEventListener('focusout', e => {
  if (!e.target.dataset?.code) return;
  const full = form.codeValue(e.target);
  if (full) e.target.value = full.slice(2);
});

// 以 form 的 submit 取代 dialog 的 close 事件：close 在部分 WebView 不觸發
function openDialog(dialogId) {
  return new Promise(resolve => {
    const dlg = $(dialogId);
    const formEl = dlg.querySelector('form');
    const done = value => {
      formEl.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('cancel', onCancel);
      resolve(value);
    };
    const onSubmit = e => done(e.submitter?.value || 'cancel');
    const onCancel = () => done('cancel');
    formEl.addEventListener('submit', onSubmit);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

function fillGps(coordEl, btn) {
  if (!navigator.geolocation) return alert('此裝置無法取得 GPS 位置');
  const original = btn.textContent;
  btn.textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(
    p => {
      coordEl.value = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`;
      btn.textContent = `📍 已定位（±${Math.round(p.coords.accuracy)}m）`;
      setTimeout(() => { btn.textContent = original; }, 3000);
    },
    err => {
      btn.textContent = original;
      alert(`無法取得位置：${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/** 樣點編號自然排序（S-2 排在 S-10 前面） */
const byStation = (a, b) =>
  store.stationLabel(a).localeCompare(store.stationLabel(b), 'zh-Hant', { numeric: true });

/* ═══════════ 設備清單 ═══════════ */

async function renderProjectSelects() {
  const projects = await store.getProjects();
  if (projects.length && !projects.some(p => p.id === store.settings.projectId)) {
    store.settings.projectId = projects[0].id;
  }
  const options = projects.map(p =>
    `<option value="${p.id}"${p.id === store.settings.projectId ? ' selected' : ''}>${esc(p.name)}</option>`
  ).join('') || '<option value="">（尚無專案）</option>';
  $('project-select').innerHTML = options;
  $('add-project').innerHTML = options;
  return projects;
}

const BADGE_CLASS = {
  '正常': 'ok', '電量低': 'warn', '逾2個月未巡': 'yellow',
  '逾3個月未巡': 'warn', '逾4個月未巡': 'bad', '相機故障': 'purple',
};

async function renderHome() {
  const projects = await renderProjectSelects();
  const list = $('device-list');

  if (!projects.length) {
    list.innerHTML = '<div class="hint">還沒有任何專案。請點上方的「＋ 新專案」建立第一個。</div>';
    $('data-warn').hidden = true;
    map.renderDevices([]);
    return;
  }

  const devices = (await store.getDevices(store.settings.projectId)).sort(byStation);
  const dupIds = renderDataWarn(devices);
  if (!devices.length) {
    list.innerHTML = '<div class="hint">此專案還沒有設備，點下方「＋ 新增設備」建立第一台。</div>';
    map.renderDevices([]);
    return;
  }

  list.innerHTML = devices.map(d => {
    const status = store.deviceStatus(d);
    const camera = `序號 ${esc(d.id)}${d.cameraModel ? ` · ${esc(d.cameraModel)}` : ''}`;
    const memo = d.lastNote ? `<small class="memo">📝 ${esc(d.lastNote)}</small>` : '';
    const dup = dupIds.get(String(d.id));
    return `<div class="dev" data-device="${esc(d.id)}">
      <div class="icon">📷</div>
      <div class="info"><b>${esc(store.stationLabel(d))}</b><small>${camera}</small>`
      + (dup ? `<small class="dup">⚠ ${esc(dup.join('、'))}</small>` : '')
      + `<small>${esc(store.deviceSummary(d))}</small>${memo}`
      + `<div class="acts"><button type="button" class="btn small" data-patrol="${esc(d.id)}">✅ 巡檢這台</button>`
      + `<button type="button" class="btn small ghost" data-hist="${esc(d.id)}">📜 履歷 ▾</button></div></div>
      <span class="badge ${BADGE_CLASS[status]}">${status}</span>
    </div>`;
  }).join('');

  map.renderDevices(devices.map(d => ({
    id: d.id,
    label: store.stationLabel(d),
    model: d.cameraModel || '',
    lat: d.lat,
    lng: d.lng,
    status: store.deviceStatus(d),
    note: store.deviceSummary(d),
    memo: d.lastNote || '',
  })));
  // 雲端資料更新時清單會重畫：還在的話維持選取（履歷也重畫，雲端可能有新紀錄）
  if (devices.some(d => d.id === selectedId)) {
    selectDevice(selectedId, { scroll: false });
    await showHistory();
    if (scrollToSelected) selectedCard()?.scrollIntoView({ block: 'start' });
  } else {
    selectedId = null;
    closeHistory();
  }
  scrollToSelected = false;
}

/**
 * 首頁紅字：樣點編號重複、記憶卡重複、編號格式不對（雲端改編號時看不懂、要人工改的）。
 * 回傳 Map(設備序號 → 這台的問題)，卡片上也標出來
 */
function renderDataWarn(devices) {
  const issues = stats.dataIssues(devices);
  const flags = new Map();
  const flag = (d, text) => flags.set(String(d.id), [...(flags.get(String(d.id)) || []), text]);
  const lines = [];
  issues.stations.forEach(g => {
    lines.push(`樣點重複：${g.devices[0].stationId}（${g.devices.map(d => d.id).join('、')}）`);
    g.devices.forEach(d => flag(d, '樣點重複'));
  });
  issues.cards.forEach(g => {
    lines.push(`記憶卡重複：${g.key}（${g.devices.map(d => `${store.stationLabel(d)} ${d.id}`).join('、')}）`);
    g.devices.forEach(d => flag(d, '記憶卡重複'));
  });
  // 雲端還沒改編號（舊版）時每台都會是舊寫法，不提醒
  if (backendVersion && !olderThan(backendVersion, 'v0.5')) {
    const bad = [...issues.badIds.map(d => d.id), ...issues.badCards.map(d => `${store.stationLabel(d)} 的 ${d.sdCard}`)];
    if (bad.length) lines.push(`編號不是 CA／SD＋3 碼，請到試算表修改：${bad.join('、')}`);
  }
  const el = $('data-warn');
  el.hidden = !lines.length;
  el.innerHTML = lines.map(t => `⚠️ ${esc(t)}`).join('<br>');
  return flags;
}

/**
 * 選取一台相機：清單卡片標亮並出現「巡檢這台」，地圖移過去標藍框；這時按下方「巡檢」也是巡檢這台。
 * id 為 null＝取消選取、地圖框回全部。
 * fromMap：在地圖上點的，地圖不必再移；scroll：把地圖捲進畫面（手機上清單在地圖下面）
 */
function selectDevice(id, { fromMap = false, scroll = !fromMap } = {}) {
  if (String(id) !== String(historyId)) closeHistory();
  selectedId = id;
  // 卡片上的 data-device 是字串，設備序號在試算表可能是數字
  document.querySelectorAll('#device-list .dev').forEach(c => c.classList.toggle('sel', id != null && c.dataset.device === String(id)));
  map.selectDevice(id, !fromMap);
  if (!id) map.fitAll();
  if (id && scroll) $('devmap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('project-select').addEventListener('change', e => {
  store.settings.projectId = e.target.value;
  renderHome();
});

// 建立專案必須是獨立按鈕：放在 select 裡當選項時，若它是唯一選項就已處於選中狀態，
// 使用者再選它不會觸發 change，等於永遠按不動（新使用者第一步就卡死）
$('project-new').addEventListener('click', async () => {
  const project = await askNewProject();
  if (!project) return;
  store.settings.projectId = project.id;
  await renderHome();
});

// 點卡片＝選取（再點一次取消）；按卡片裡的「巡檢這台」才進巡檢、「履歷」展開歷次巡檢
$('device-list').addEventListener('click', e => {
  const patrol = e.target.closest('[data-patrol]');
  if (patrol) return go('scr-patrol', { deviceId: patrol.dataset.patrol });
  const hist = e.target.closest('[data-hist]');
  if (hist) return toggleHistory(hist.dataset.hist);
  if (e.target.closest('.hist')) {
    // 點履歷內容不取消選取；「顯示較早的」展開全部
    if (e.target.closest('[data-hist-all]')) { historyAll = true; showHistory(); }
    return;
  }
  const card = e.target.closest('[data-device]');
  if (card) selectDevice(card.dataset.device === String(selectedId) ? null : card.dataset.device);
});

/* ═══════════ 相機履歷 ═══════════ */

const HISTORY_SHOWN = 4;
const DAY_MS = 86400000;
let historyToken = 0;

const selectedCard = () => [...document.querySelectorAll('#device-list .dev')]
  .find(c => c.dataset.device === String(selectedId));

/** 今年的只寫月/日，其他年份寫完整日期 */
function shortDate(s) {
  const d = store.dateOnly(String(s || ''));
  return d.startsWith(String(new Date().getFullYear())) ? d.slice(5).replace('-', '/') : d.replace(/-/g, '/');
}

function closeHistory() {
  historyId = null;
  historyAll = false;
  historyToken++;
  document.querySelectorAll('#device-list .hist').forEach(el => el.remove());
  document.querySelectorAll('#device-list [data-hist]').forEach(b => { b.textContent = '📜 履歷 ▾'; });
}

function toggleHistory(id) {
  if (historyId != null && String(historyId) === String(id)) return closeHistory();
  closeHistory();
  historyId = id;
  showHistory();
}

/** 在選取的卡片裡畫出履歷（換機前的舊相機也算同一個樣點） */
async function showHistory() {
  const token = ++historyToken;
  if (historyId == null) return;
  const [records, devices, queue] = await Promise.all([
    store.getAllRecords(), store.getProjectDevicesAll(store.settings.projectId), store.getQueue(),
  ]);
  const card = selectedCard();
  // 等資料的時候使用者可能已經關掉或換了一台
  if (token !== historyToken || !card || card.dataset.device !== String(historyId)) return;
  const device = devices.find(d => String(d.id) === String(historyId));
  if (!device) return;
  const pending = new Set(queue.filter(q => q.status !== 'done' && q.payload?.recordId).map(q => String(q.payload.recordId)));
  card.querySelector('.hist')?.remove();
  card.insertAdjacentHTML('beforeend', historyHtml(device, records, devices, pending));
  card.querySelector('[data-hist]').textContent = '📜 履歷 ▴';
}

function historyHtml(device, records, devices, pending) {
  const list = stats.stationHistory(device.id, records);
  const ids = stats.chainIds(device.id, records).map(String);
  const installed = devices.filter(d => ids.includes(String(d.id))).map(d => d.createdAt).filter(Boolean).sort()[0]
    || device.createdAt;
  const lost = [...stats.lostByDevice(stats.downtimes(list)).values()].reduce((sum, x) => sum + x.ms, 0) / DAY_MS;
  const swaps = list.filter(r => r.cameraSwapped).length;
  const pills = [
    installed ? `<span class="pill">架設 ${esc(store.dateOnly(installed))}</span>` : '',
    `<span class="pill">巡檢 ${list.length} 次</span>`,
    `<span class="pill${lost >= 0.5 ? ' bad' : ''}">漏拍 ${Math.round(lost)} 天</span>`,
    swaps ? `<span class="pill">換機 ${swaps} 次</span>` : '',
  ].join('');
  if (!list.length) {
    return `<div class="hist"><div class="hist-sum">${pills}</div><p class="sec-note" style="margin:0;">還沒有巡檢紀錄。</p></div>`;
  }
  const shown = historyAll ? list : list.slice(0, HISTORY_SHOWN);
  const more = list.length - shown.length;
  return `<div class="hist"><div class="hist-sum">${pills}</div>`
    + `<ul class="tl">${shown.map(r => historyItem(r, pending)).join('')}</ul>`
    + (more ? `<button type="button" class="more" data-hist-all>顯示較早的 ${more} 筆 ▾</button>` : '')
    + '</div>';
}

function historyItem(r, pending) {
  const what = [];
  if (r.cameraSwapped) {
    what.push(`🔁 換機 ${esc(r.deviceId)} → ${esc(r.newDeviceId)}`
      + `${r.newCameraModel ? `（${esc(r.newCameraModel)}）` : ''}${r.swapReason ? `：${esc(r.swapReason)}` : ''}`);
  } else if (r.running === false) {
    what.push('⚠️ 相機故障或沒電');
  }
  if (r.batteryChanged) what.push(`🔋 換${esc(r.batteryTypeNew || '電池')}`);
  if (r.sdChanged) what.push(`💾 換卡 ${r.sdRetrieved ? `${esc(r.sdRetrieved)} → ` : ''}${esc(r.sdNew)}`);
  if (!r.batteryChanged && r.batteryPct != null && r.batteryPct !== '') what.push(`電量 ${esc(r.batteryPct)}%`);
  if (r.configChanged) what.push('⚙️ 改設定');
  if (r.locationChanged) what.push('📍 改位置');

  const stopped = r.stoppedMidway && r.stoppedAt;
  const stopDays = stopped ? Math.max(0, Math.round((stats.toMs(r.patrolAt) - stats.toMs(r.stoppedAt)) / DAY_MS)) : 0;
  const cls = r.cameraSwapped ? 'swap' : (stopped || r.running === false ? 'stop' : '');
  return `<li class="${cls}"><span class="when">${shortDate(r.patrolAt)}</span><span class="who">${esc(r.inspector)}</span>`
    + (pending.has(String(r.recordId)) ? '<span class="pill wait">待上傳</span>' : '')
    + `<div class="what">${what.join(' · ') || '巡檢'}</div>`
    + (stopped ? `<div class="stopline">⏸ 中間有停：${shortDate(r.stoppedAt)} ${esc(r.stopReason || '其他')}（漏 ${stopDays} 天）</div>` : '')
    + (r.note ? `<div class="memo">📝 ${esc(r.note)}</div>` : '')
    + '</li>';
}

/** 從統計點樣點：回設備清單、選取那台並打開履歷 */
function openStationHistory(id) {
  selectedId = id;
  historyId = id;
  historyAll = false;
  scrollToSelected = true;
  go('scr-home');
}

/* ═══════════ 出發準備 ═══════════ */

let packSel = null; // 勾選的設備序號（字串）

async function renderPack({ reset = false } = {}) {
  const devices = (await store.getDevices(store.settings.projectId)).sort(byStation);
  const due = devices.filter(stats.isDue);
  if (reset || !packSel) packSel = new Set(due.map(d => String(d.id)));
  const chosen = devices.filter(d => packSel.has(String(d.id)));
  const sum = stats.packSummary(chosen);

  $('pack-summary').innerHTML = packSummaryHtml(sum);
  const same = list => list.length === chosen.length && list.every(d => packSel.has(String(d.id)));
  const preset = (name, label, list) =>
    `<button type="button" data-preset="${name}"${same(list) && list.length ? ' class="on"' : ''}>${label}</button>`;
  const guard = devices.filter(stats.lacksGuard);
  $('pack-presets').innerHTML = preset('due', `逾 60 天＋故障（${due.length}）`, due)
    + preset('guard', `缺防護（${guard.length}）`, guard)
    + preset('all', `全部（${devices.length}）`, devices) + '<button type="button" data-preset="none">清除</button>';
  $('pack-list').innerHTML = devices.length
    ? devices.map(d => packRow(d, packSel.has(String(d.id)))).join('')
    : '<p class="sec-note" style="margin:10px 0;">此專案還沒有設備。</p>';
}

function packRow(d, on) {
  const need = stats.packNeeds(d);
  const cfg = d.config || {};
  const bits = [`上次 ${shortDate(d.lastPatrolAt)}`,
    d.running === false ? '相機故障' : `${d.batteryType || '電池'} ${d.batteryPct ?? '—'}%`];
  if (cfg.ironCase === false) bits.push('沒鐵殼');
  if (cfg.locked === false) bits.push('沒上鎖');
  if (cfg.rainCover === false) bits.push('沒遮雨板');
  const icons = (need.spare ? '📷' : '') + (need.battery ? '🔋' : '') + '💾'
    + (need.iron ? '🛡' : '') + (need.lock ? '🔒' : '') + (need.rain ? '☂' : '');
  return `<div class="pick${on ? '' : ' off'}" data-pick="${esc(d.id)}" role="checkbox" aria-checked="${on}">`
    + `<span class="box${on ? ' on' : ''}">${on ? '✓' : ''}</span>`
    + `<div class="who"><b>${esc(store.stationLabel(d))}</b><small>${esc(bits.join(' · '))}</small></div>`
    + `<span class="need">${icons}</span></div>`;
}

/** [名稱, 數量, 哪幾台] */
function packLines(s) {
  const lines = s.battery.map(b => [`🔋 ${b.type}`, `${b.labels.length} 台份`, b.labels.join('、')]);
  lines.push(['💾 記憶卡', `${s.sd} 張`, '每台一張']);
  if (s.spare.length) {
    lines.push(['📷 備機', `${s.spare.length} 台`, s.spare.map(x => `${x.label}${x.model ? `（${x.model}）` : ''}`).join('、')]);
  }
  if (s.iron.length) lines.push(['🛡 鐵殼', `${s.iron.length} 個`, s.iron.join('、')]);
  if (s.lock.length) lines.push(['🔒 鎖', `${s.lock.length} 個`, s.lock.join('、')]);
  if (s.rain.length) lines.push(['☂ 遮雨板', `${s.rain.length} 片`, s.rain.join('、')]);
  return lines;
}

function packSummaryHtml(s) {
  if (!s.count) return '<h3>還沒勾選相機</h3><p class="sec-note" style="margin:0;">從下面勾這趟要去的相機。</p>';
  return `<h3>這趟 ${s.count} 台，要帶：</h3><ul class="take">`
    + packLines(s).map(([n, q, who]) => `<li><span class="n">${esc(n)}</span>${esc(q)}<small>${esc(who)}</small></li>`).join('')
    + '</ul><button type="button" class="btn sub" id="pack-copy" style="margin-top:10px;">📋 複製清單</button>';
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 舊瀏覽器或沒有剪貼簿權限時的備援
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const original = btn.textContent;
  btn.textContent = '✓ 已複製';
  setTimeout(() => { btn.textContent = original; }, 2000);
}

$('scr-pack').addEventListener('click', async e => {
  const pick = e.target.closest('[data-pick]');
  const preset = e.target.closest('[data-preset]');
  if (pick) {
    const id = pick.dataset.pick;
    if (packSel.has(id)) packSel.delete(id); else packSel.add(id);
    return renderPack();
  }
  if (preset) {
    const devices = await store.getDevices(store.settings.projectId);
    const list = { due: devices.filter(stats.isDue), guard: devices.filter(stats.lacksGuard), all: devices, none: [] }[preset.dataset.preset];
    packSel = new Set(list.map(d => String(d.id)));
    return renderPack();
  }
  if (e.target.closest('#pack-copy')) {
    const devices = (await store.getDevices(store.settings.projectId)).sort(byStation);
    const chosen = devices.filter(d => packSel.has(String(d.id)));
    const s = stats.packSummary(chosen);
    const head = `🎒 ${shortDate(store.stamp())} 出發準備（${s.count} 台：${chosen.map(store.stationLabel).join('、')}）`;
    const text = [head, ...packLines(s).map(([n, q, who]) => `${n} ${q}${who && who !== '每台一張' ? `：${who}` : ''}`)].join('\n');
    copyText(text, e.target.closest('#pack-copy'));
  }
});

/* ═══════════ 統計 ═══════════ */

const REASON_COLOR = { '沒電': 'var(--red)', '故障': '#7b2cbf', '記憶卡滿': 'var(--amber)' };
const statsState = { tab: 'down', span: 'month', y: null, m: null };
let workTsv = '';

const r0 = x => Math.round(x);
const fmtDays = x => (x > 0 && x < 0.5 ? '不到 1' : String(Math.round(x)));

/** 目前的期間 [from, to)（毫秒） */
function statsPeriod({ y, m, span } = statsState) {
  return span === 'year'
    ? [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()]
    : [new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()];
}

function shiftPeriod(step) {
  if (statsState.span === 'year') statsState.y += step;
  else {
    const d = new Date(statsState.y, statsState.m + step, 1);
    statsState.y = d.getFullYear();
    statsState.m = d.getMonth();
  }
  renderStats();
}

async function renderStats() {
  const now = new Date();
  if (statsState.y == null) {
    statsState.y = now.getFullYear();
    statsState.m = now.getMonth();
  }
  const { tab, span, y, m } = statsState;
  const pid = store.settings.projectId;
  const project = (await store.getProjects()).find(p => p.id === pid);
  $('stats-title').textContent = `統計${project ? ` · ${project.name}` : ''}`;
  $('stats-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));

  $('stats-label').textContent = span === 'year' ? `${y} 年` : `${y} 年 ${m + 1} 月`;
  $('stats-span').textContent = span === 'year' ? '看單月' : '看全年';
  $('stats-next').disabled = statsPeriod()[1] > now.getTime();

  const old = backendVersion && olderThan(backendVersion, BACKEND_NEEDED);
  $('stats-note').hidden = !old;
  $('stats-note').textContent = old ? '⚠️ 雲端的 Apps Script 還是舊版，統計只含這支手機自己記過的巡檢紀錄。' : '';

  const [devices, allRecords] = await Promise.all([store.getProjectDevicesAll(pid), store.getAllRecords()]);
  const records = allRecords.filter(r => r.projectId === pid);
  const [from, to] = statsPeriod();
  $('stats-body').innerHTML = !project
    ? '<div class="hint">還沒有任何專案。</div>'
    : tab === 'down' ? downHtml(devices, records, from, to)
    : workHtml(records, from, to, project.name);
}

function downHtml(devices, records, from, to) {
  const rep = stats.downtimeReport(devices, records, from, to);
  const rate = stats.workingRate(rep);
  const kpi = rep.cams
    ? `<div class="big">${rate == null ? '—' : `${r0(rate * 100)}<small>%</small>`}</div>`
      + `<div class="txt">有在拍的相機日<br><b>${r0(rep.expected - rep.lost)}</b> ／ 應拍 <b>${r0(rep.expected)}</b>（${rep.cams} 台）`
      + `<br>漏拍 <b class="red">${fmtDays(rep.lost)} 天</b></div>`
    : '<div class="txt">這段期間沒有相機在現場。</div>';

  const max = rep.rows[0]?.days || 1;
  const rows = rep.rows.map(r => `<li><span class="lab${r.deviceId != null ? ' link' : ''}"${r.deviceId != null ? ` data-open="${esc(r.deviceId)}"` : ''}>`
    + `${esc(r.label)}</span><span class="track"><span class="fill" style="width:${Math.max(3, (r.days / max) * 100)}%;`
    + `background:${REASON_COLOR[r.reasons[0]] || 'var(--muted)'}"></span></span>`
    + `<span class="val"><b>${fmtDays(r.days)} 天</b> ${esc(r.reasons.join('、'))}</span></li>`).join('');
  const ongoing = rep.rows.filter(r => r.ongoing).map(r => r.label);
  const notes = [
    ongoing.length ? `${ongoing.join('、')} 還沒修好，之後會繼續算。` : '',
    rep.cams > rep.rows.length && rep.rows.length ? '其餘相機沒有回報停過。' : '',
  ].filter(Boolean).join('');
  const which = rep.rows.length
    ? `<ul class="bars">${rows}</ul>${notes ? `<p class="foot" style="margin:6px 0 0;">${esc(notes)}</p>` : ''}`
    : '<p class="sec-note" style="margin:0;">這段期間沒有相機回報停過。</p>';

  return `<div class="card"><div class="kpi">${kpi}</div></div>`
    + `<div class="card"><h3>哪幾台漏拍</h3>${which}</div>`
    + trendHtml(devices, records)
    + '<p class="foot">漏拍＝「中間有停」的停止日 → 下次巡檢；「相機故障或沒電」→ 修好或換機的那次巡檢。跨月的會拆到各月。點樣點可看履歷。<br>'
    + '⚠ 還沒巡到的相機不知道有沒有停過，要等下次巡檢填了才補進來，所以最近一兩個月的數字之後可能會往下修。</p>';
}

/** 單月：近 6 個月；全年：那一年的 12 個月 */
function trendHtml(devices, records) {
  const { span, y, m } = statsState;
  const months = span === 'year'
    ? Array.from({ length: 12 }, (_, i) => [y, i])
    : Array.from({ length: 6 }, (_, i) => { const d = new Date(y, m - 5 + i, 1); return [d.getFullYear(), d.getMonth()]; });
  const cols = months.map(([yy, mm]) => {
    const [from, to] = statsPeriod({ y: yy, m: mm, span: 'month' });
    const rate = stats.workingRate(stats.downtimeReport(devices, records, from, to));
    const cur = span === 'month' && yy === y && mm === m ? ' class="cur"' : '';
    const bar = rate == null ? '<span style="height:0"><em>—</em></span>'
      : `<span style="height:${Math.max(2, rate * 64)}px"><em>${r0(rate * 100)}%</em></span>`;
    return `<div${cur}>${bar}${mm + 1}月</div>`;
  }).join('');
  return `<div class="card"><h3>${span === 'year' ? `${y} 年各月` : '近 6 個月'}</h3><div class="cols">${cols}</div></div>`;
}

function workHtml(records, from, to, projectName) {
  const w = stats.workload(records, from, to);
  const title = `${$('stats-label').textContent} 巡檢工作量（${projectName}）`;
  const tsvRows = [[title], [], ['人員', '出勤日', '台次', '換電', '換卡', '換機'],
    ...w.people.map(p => [p.name, p.days, p.count, p.battery, p.sd, p.swap]),
    ['合計', w.total.days, w.total.count, w.total.battery, w.total.sd, w.total.swap]];
  if (w.battery.length) tsvRows.push([], ['電池類型', '台份'], ...w.battery.map(b => [b.type, b.n]));
  tsvRows.push([], ['日期', '人員', '台數'], ...w.detail.map(x => [x.day, x.name, x.n]));
  workTsv = tsvRows.map(r => r.join('\t')).join('\n');

  if (!w.total.count) return '<div class="card"><p class="sec-note" style="margin:0;">這段期間沒有巡檢紀錄。</p></div>';
  const td = v => `<td>${esc(v)}</td>`;
  const people = '<table class="t"><tr><th>人員</th><th>出勤日</th><th>台次</th><th>換電</th><th>換卡</th><th>換機</th></tr>'
    + w.people.map(p => `<tr>${[p.name, p.days, p.count, p.battery, p.sd, p.swap].map(td).join('')}</tr>`).join('')
    + `<tr class="sum">${['合計', w.total.days, w.total.count, w.total.battery, w.total.sd, w.total.swap].map(td).join('')}</tr></table>`;
  const battery = w.battery.length
    ? `<div class="card"><h3>電池用量</h3><table class="t"><tr><th>類型</th><th>台份</th></tr>`
      + w.battery.map(b => `<tr>${td(b.type)}${td(b.n)}</tr>`).join('') + '</table></div>'
    : '';
  const detail = '<table class="t"><tr><th>日期</th><th>人員</th><th>台數</th></tr>'
    + w.detail.map(x => `<tr>${td(shortDate(x.day))}${td(x.name)}${td(x.n)}</tr>`).join('') + '</table>';

  return `<div class="card"><h3>每人</h3>${people}<p class="foot" style="margin:6px 0 0;">合計的出勤日是「有人出去的天數」，兩人同一天去算 1 天。</p></div>`
    + battery
    + `<div class="card"><h3>出勤明細</h3>${detail}</div>`
    + '<button type="button" class="btn sub" id="work-copy">📋 複製到 Excel</button>';
}

$('scr-stats').addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { statsState.tab = tab.dataset.tab; return renderStats(); }
  if (e.target.closest('#stats-prev')) return shiftPeriod(-1);
  if (e.target.closest('#stats-next')) return shiftPeriod(1);
  if (e.target.closest('#stats-span')) {
    statsState.span = statsState.span === 'year' ? 'month' : 'year';
    return renderStats();
  }
  const open = e.target.closest('[data-open]');
  if (open) {
    // data-* 一律是字串；設備序號在試算表可能是數字，要找回原本的值，選取才對得上
    return store.getDevices(store.settings.projectId).then(devices => {
      const d = devices.find(x => String(x.id) === open.dataset.open);
      if (d) openStationHistory(d.id);
    });
  }
  if (e.target.closest('#work-copy')) copyText(workTsv, e.target.closest('#work-copy'));
});

/* ═══════════ 新增設備 ═══════════ */

function refreshAddMeta() {
  renderProjectSelects();
  $('add-inspector').value = store.settings.inspector;
  $('add-created-at').value = store.stamp();
}

$('add-model').innerHTML = MODEL_OPTIONS;
$('add-model').addEventListener('change', e => addCfg.setModel(e.target.value));
addCfg.setModel('');

$('add-gps').addEventListener('click', e => fillGps($('add-coord'), e.target));
$('add-pick').addEventListener('click', () => pickInto($('add-coord')));

/** 在地圖上選位置，寫回座標欄；地圖先停在欄位裡的座標（沒填就用 fallback） */
async function pickInto(coordEl, fallback = null) {
  const cur = form.parseCoord(coordEl.value) || fallback;
  const devices = (await store.getDevices(store.settings.projectId))
    .map(d => ({ label: store.stationLabel(d), lat: d.lat, lng: d.lng }));
  const start = cur && Number.isFinite(cur.lat) && Number.isFinite(cur.lng) ? [cur.lat, cur.lng] : null;
  const picked = await map.pickLocation({ start, devices });
  if (picked) coordEl.value = `${picked[0].toFixed(5)}, ${picked[1].toFixed(5)}`;
}

/** 同專案還在用的相機已經用了這個樣點編號 → 那台；沒有回 null（exceptId：自己那台不算） */
async function stationOwner(projectId, station, exceptId = null) {
  const key = stats.stationKey(station);
  return (await store.getDevices(projectId))
    .find(d => String(d.id) !== String(exceptId) && stats.stationKey(d.stationId) === key) || null;
}

$('add-save').addEventListener('click', async () => {
  const scope = $('scr-add');
  form.clearErrors(scope);

  let ok = form.require($('add-station'), '請輸入樣點編號');
  ok = form.requireCode($('add-device-id'), '相機編號') && ok;
  ok = form.require($('add-model'), '請選擇相機型號') && ok;
  ok = form.requireCode($('add-sd'), '記憶卡編號') && ok;
  ok = form.requireCoord($('add-coord')) && ok;
  ok = addCfg.validate() && ok;
  if (!$('add-project').value) { alert('請先建立專案'); ok = false; }
  if (!ok) return;

  const id = form.codeValue($('add-device-id'));
  if (await store.getDevice(id)) {
    form.markError($('add-device-id'), `${id} 已經存在`);
    return;
  }
  const owner = await stationOwner($('add-project').value, $('add-station').value);
  if (owner) {
    form.markError($('add-station'), `這個樣點已經有 ${owner.id}，樣點編號不能重複`);
    return;
  }

  await addPhotos.ready();
  const photoIds = addPhotos.ids();
  await store.addDevice({
    id,
    projectId: $('add-project').value,
    stationId: $('add-station').value.trim(),
    qrCode: id,
    cameraModel: $('add-model').value,
    ...form.parseCoord($('add-coord').value),
    sdCard: form.codeValue($('add-sd')),
    batteryType: $('add-battery-type').value,
    batteryPct: Number($('add-battery-pct').value),
    config: addCfg.read(),
  }, photoIds);

  addPhotos.take();
  ['add-station', 'add-device-id', 'add-sd', 'add-coord', 'add-config-note'].forEach(k => { $(k).value = ''; });
  $('add-battery-pct').value = '100';
  await updateSyncChip();
  go('scr-home');
  syncInBackground();
});

/* ═══════════ 巡檢 ═══════════ */

let patrolDefs = [];
let patrolTouched = false; // 使用者動過表單後，定位結果回來也不自動換樣點（免得清掉填到一半的內容）
let nearestToken = 0;

const patrolOptionLabel = d => (d.stationId ? `${d.stationId}（${d.id}）` : d.id);
const patrolBaseDevice = async () => (editing ? editing.undo.device : store.getDevice($('patrol-device').value));

function distanceM([lat1, lng1], [lat2, lng2]) {
  const rad = x => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const fmtDist = m => (m < 1000 ? `${Math.round(m)} 公尺` : `${(m / 1000).toFixed(1)} 公里`);

/** distances 有值時依距離排序並標出距離；保留目前的選擇 */
function fillPatrolOptions(devices, distances) {
  const select = $('patrol-device');
  const current = select.value;
  const list = distances
    ? [...devices].sort((a, b) => (distances.get(a.id) ?? Infinity) - (distances.get(b.id) ?? Infinity))
    : [...devices].sort(byStation);
  select.innerHTML = list.map(d => {
    const dist = distances?.get(d.id);
    return `<option value="${esc(d.id)}">${esc(patrolOptionLabel(d))}${dist != null ? ` · ${fmtDist(dist)}` : ''}</option>`;
  }).join('');
  if (list.some(d => d.id === current)) select.value = current;
}

function showNearest(text, muted = false) {
  const el = $('nearest-hint');
  el.textContent = text;
  el.classList.toggle('muted', muted);
  el.hidden = false;
}

/** 依目前 GPS 選最近的樣點，並醒目提示 */
function pickNearest(devices) {
  if (!navigator.geolocation) return;
  const token = ++nearestToken;
  showNearest('📍 定位中，稍後自動選擇最近的樣點…', true);
  navigator.geolocation.getCurrentPosition(
    async pos => {
      if (token !== nearestToken || editing) return;
      const here = [pos.coords.latitude, pos.coords.longitude];
      const ranked = devices
        .filter(d => Number.isFinite(d.lat) && Number.isFinite(d.lng))
        .map(d => ({ d, dist: distanceM(here, [d.lat, d.lng]) }))
        .sort((a, b) => a.dist - b.dist);
      if (!ranked.length) return showNearest('此專案的設備都還沒有座標，請手動選擇樣點', true);

      fillPatrolOptions(devices, new Map(ranked.map(r => [r.d.id, r.dist])));
      const nearest = ranked[0];
      const label = `${store.stationLabel(nearest.d)}（約 ${fmtDist(nearest.dist)}）`;
      if (patrolTouched) return showNearest(`📍 最近的樣點是 ${label}`);
      if ($('patrol-device').value !== nearest.d.id) {
        $('patrol-device').value = nearest.d.id;
        await loadPatrolDevice(nearest.d.id);
      }
      showNearest(`📍 已自動選擇最近的樣點：${label}`);
    },
    () => { if (token === nearestToken) showNearest('無法取得目前位置，請手動選擇樣點', true); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

async function renderPatrol({ auto = false, deviceId } = {}) {
  const select = $('patrol-device');
  nearestToken++; // 作廢還在等的定位結果
  $('nearest-hint').hidden = true;
  $('edit-banner').hidden = !editing;
  select.disabled = !!editing;

  if (editing) {
    const d = editing.undo.device;
    select.innerHTML = `<option value="${esc(d.id)}">${esc(patrolOptionLabel(d))}</option>`;
    $('edit-banner-text').textContent = store.isUploadedRecord(editing)
      ? `✏️ 正在修改已上傳的紀錄（${editing.payload.patrolAt}），存檔後覆蓋雲端`
      : `✏️ 正在修改 ${editing.payload.patrolAt} 的巡檢紀錄`;
    $('patrol-empty').hidden = true;
    $('patrol-form').hidden = false;
    await loadPatrolDevice(d.id);
    return;
  }

  const devices = await store.getDevices(store.settings.projectId);
  $('patrol-empty').hidden = devices.length > 0;
  $('patrol-form').hidden = devices.length === 0;
  if (!devices.length) { select.innerHTML = ''; return; }

  fillPatrolOptions(devices);
  if (deviceId && devices.some(d => d.id === deviceId)) select.value = deviceId;
  if (!devices.some(d => d.id === select.value)) select.value = [...devices].sort(byStation)[0].id;
  await loadPatrolDevice(select.value);
  if (auto) pickNearest(devices);
}

/* ── 舊設備沒填過的欄位：這次巡檢補問（必填）── */

const ASK_LABEL = { ironCase: '鐵殼', locked: '上鎖', rainCover: '遮雨板', mount: '固定方式' };
const ASK_CONFIG_KEYS = ['videoSecNight', 'ironCase', 'locked', 'rainCover', 'mount'];

/** prev：修改紀錄時，上次存的答案 */
function renderAsk(device, prev = {}) {
  const missing = missingFields(device);
  $('ask-box').hidden = !missing.length;
  $('ask-fields').innerHTML = missing.map(key => {
    const v = prev[key];
    if (key === 'stationId') {
      return `<label class="f">樣點編號</label><input type="text" data-ask="stationId" value="${esc(v ?? '')}" placeholder="例：S-03">`;
    }
    if (key === 'cameraModel') return `<label class="f">相機型號</label><select data-ask="cameraModel">${MODEL_OPTIONS}</select>`;
    if (key === 'videoSecNight') {
      return `<label class="f">夜間影片秒數</label><input type="number" data-ask="videoSecNight" min="1" inputmode="numeric" value="${v ?? ''}">`;
    }
    const opts = key === 'mount' ? MOUNTS.map(m => [m, m]) : [['true', '有'], ['false', '沒有']];
    return `<div class="ask-row"><span>${ASK_LABEL[key]}</span><div class="seg" data-ask="${key}">`
      + opts.map(([val, text]) => `<button type="button" data-value="${val}"${v != null && String(v) === val ? ' class="on"' : ''}>${text}</button>`).join('')
      + '</div></div>';
  }).join('');
  const modelSel = $('ask-fields').querySelector('[data-ask="cameraModel"]');
  if (modelSel) modelSel.value = prev.cameraModel || '';
}

$('ask-fields').addEventListener('click', e => {
  const btn = e.target.closest('.seg button');
  if (btn) btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
});

/** 補問的答案 { 欄位: 值 }；沒回答的是 undefined */
function readAsk() {
  const out = {};
  $('ask-fields').querySelectorAll('[data-ask]').forEach(el => {
    const key = el.dataset.ask;
    if (el.classList.contains('seg')) {
      const v = el.querySelector('button.on')?.dataset.value;
      out[key] = v == null ? undefined : key === 'mount' ? v : v === 'true';
    } else if (key === 'videoSecNight') {
      out[key] = Number(el.value) > 0 ? Number(el.value) : undefined;
    } else {
      out[key] = el.value.trim() || undefined;
    }
  });
  return out;
}

/** 都要回答；換機時不必回答相機型號（用新相機的）；樣點編號不能和別台重複 */
async function validateAsk(answers, device, swapped) {
  let ok = true;
  for (const el of $('ask-fields').querySelectorAll('[data-ask]')) {
    const key = el.dataset.ask;
    if (key === 'cameraModel' && swapped) continue;
    if (answers[key] === undefined) {
      form.markError(el, key === 'videoSecNight' ? '請填夜間影片秒數' : '請回答');
      ok = false;
    } else if (key === 'stationId') {
      const owner = await stationOwner(device.projectId, answers.stationId, device.id);
      if (owner) { form.markError(el, `這個樣點已經有 ${owner.id}，樣點編號不能重複`); ok = false; }
    }
  }
  return ok;
}

async function loadPatrolDevice(deviceId) {
  // 修改模式：比對卡與預設值用「這筆紀錄之前」的設備狀態
  const device = editing ? editing.undo.device : await store.getDevice(deviceId);
  if (!device) return;

  $('last-title').textContent =
    `📋 上次巡檢狀態（${device.lastPatrolAt || '—'} · ${device.lastInspector || '—'}）`;
  $('last-body').innerHTML = [
    ['運作狀態', device.running === false ? '⛔ 相機故障或沒電' : '✅ 正常運作'],
    ['樣點 / 序號', `${device.stationId || '—'} / ${device.id}`],
    ['相機型號', device.cameraModel || '—'],
    ['記憶卡', `${device.sdCard || '—'}${device.prevSdCard ? `（上一張 ${device.prevSdCard}）` : ''}`],
    ['電池', batteryText(device)],
    ['設定', configSummary(device.config)],
    ['座標', form.formatCoord(device.lat, device.lng)],
    ['備註', device.lastNote || '—'],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
  renderLastVisual(device);

  const when = editing ? editing.payload.patrolAt : store.stamp();
  const who = editing ? editing.payload.inspector : store.settings.inspector;
  $('patrol-meta').textContent = `${when} · ${who}`;
  $('pt-sd-retrieved').textContent = `取回卡：${device.sdCard || '—'}（自動記錄）`;
  $('pt-swap-note').textContent =
    `${store.stationLabel(device)} 的 ${device.id} 會標為「已撤下」，新相機沿用此樣點的位置與設定。`;

  ['pt-down', 'pt-swap', 'pt-sd-changed', 'pt-stopped', 'pt-bat-changed', 'pt-cfg-changed', 'pt-loc-changed']
    .forEach(id => $(id).classList.remove('on'));
  ['swap-new', 'sd-new', 'stop-new', 'bat-new', 'cfg-new', 'loc-new'].forEach(id => { $(id).hidden = true; });

  $('pt-new-id').value = '';
  $('pt-new-model').value = '';
  $('pt-swap-reason').value = '';
  $('pt-sd-new').value = '';
  $('pt-stop-date').value = '';
  $('pt-stop-time').value = '';
  $('pt-stop-reason').selectedIndex = 0;
  // 電量預設沿用上次，不一樣再改
  $('pt-battery-pct').value = [100, 75, 50, 25].includes(device.batteryPct) ? String(device.batteryPct) : '';
  $('pt-note').value = '';
  $('pt-bat-type').value = device.batteryType || '鹼性';
  ptCfg.fill(device.config, device.cameraModel);
  renderAsk(device, editing ? { ...(editing.payload.config || {}), ...(editing.payload.fill || {}) } : {});
  $('pt-coord').value = '';

  // 修改已上傳的紀錄：換機不能在這時才加（雲端不會補建新相機），原本的照片已在雲端、本機沒有
  const uploaded = !!editing && store.isUploadedRecord(editing);
  $('pt-swap').closest('.tgl-row').hidden = uploaded;
  $('pt-photos-uploaded').hidden = !uploaded;

  await patrolPhotos.reset();
  patrolDefs = await store.getFieldDefs(device.projectId);
  form.renderCustomFields($('pt-custom'), patrolDefs, editing ? editing.payload.customFields : {});
  if (editing) {
    fillFromRecord(editing.payload, device);
    // 已上傳的照片本機已刪；修改後待上傳的（updateRecord）則是補拍的那些，還在本機
    if (editing.status !== 'done') await patrolPhotos.load(editing.photoIds || []);
  }
  form.clearErrors($('scr-patrol'));
  patrolTouched = false;
}

/** 例：鋰電 · 75% · 已用 45 天（2026-10-05 換） */
function batteryText(device) {
  const days = store.batteryDays(device);
  const since = days == null ? '' : ` · 已用 ${days} 天（${store.dateOnly(store.batteryChangedAt(device))} 換）`;
  return `${device.batteryType || '—'} · ${device.batteryPct ?? '—'}%${since}`;
}

/** 比對卡左邊：醒目的大字樣點編號（上次的照片先不顯示，後端 /api/photo 保留著） */
function renderLastVisual(device) {
  $('last-station').textContent = store.stationLabel(device);
}

/** 修改模式：把原紀錄的內容填回表單 */
function fillFromRecord(p, device) {
  const set = (id, on, reveal) => {
    $(id).classList.toggle('on', !!on);
    if (reveal) $(reveal).hidden = !on;
  };
  set('pt-down', p.running === false);
  set('pt-swap', p.cameraSwapped, 'swap-new');
  $('pt-new-id').value = form.codeDigits(p.newDeviceId);
  $('pt-new-model').value = p.newCameraModel || '';
  $('pt-swap-reason').value = p.swapReason || '';
  set('pt-sd-changed', p.sdChanged, 'sd-new');
  if (p.sdChanged) $('pt-sd-new').value = form.codeDigits(p.sdNew);
  set('pt-stopped', p.stoppedMidway, 'stop-new');
  if (p.stoppedMidway) {
    const [day, time = ''] = String(p.stoppedAt || '').split(' ');
    $('pt-stop-date').value = day;
    $('pt-stop-time').value = time;
    $('pt-stop-reason').value = p.stopReason;
  }
  set('pt-bat-changed', p.batteryChanged, 'bat-new');
  if (p.batteryChanged) $('pt-bat-type').value = p.batteryTypeNew;
  $('pt-battery-pct').value = String(p.batteryPct ?? '');
  set('pt-cfg-changed', p.configChanged, 'cfg-new');
  if (p.configChanged) ptCfg.fill(p.config, p.cameraSwapped ? p.newCameraModel : device.cameraModel);
  set('pt-loc-changed', p.locationChanged, 'loc-new');
  if (p.locationChanged) $('pt-coord').value = form.formatCoord(p.lat, p.lng);
  $('pt-note').value = p.note || '';
}

$('patrol-form').addEventListener('input', () => { patrolTouched = true; });
$('patrol-form').addEventListener('click', e => {
  if (e.target.closest('button, input, select, textarea')) patrolTouched = true;
});

$('patrol-device').addEventListener('change', e => {
  nearestToken++;
  $('nearest-hint').hidden = true;
  loadPatrolDevice(e.target.value);
});
$('pt-gps').addEventListener('click', e => fillGps($('pt-coord'), e.target));
// 地圖先停在相機原本的位置
$('pt-pick').addEventListener('click', async () => {
  const device = await patrolBaseDevice();
  pickInto($('pt-coord'), device ? { lat: device.lat, lng: device.lng } : null);
});

$('pt-new-model').innerHTML = MODEL_OPTIONS;

/** 換成不同型號時畫質選項不同，打開「設定有變動」讓巡檢員重新確認新相機的設定 */
function openConfigForModel(model) {
  ptCfg.setModel(model);
  $('pt-cfg-changed').classList.add('on');
  $('cfg-new').hidden = false;
}

$('pt-new-model').addEventListener('change', async e => {
  const device = await patrolBaseDevice();
  if (e.target.value && e.target.value !== device.cameraModel) openConfigForModel(e.target.value);
});

function cancelEdit() {
  editing = null;
  patrolPhotos.reset(); // 只刪修改時新拍的，原紀錄的照片保留
}

$('edit-cancel').addEventListener('click', () => {
  cancelEdit();
  go('scr-sync');
});

$('pt-save').addEventListener('click', async () => {
  const scope = $('scr-patrol');
  form.clearErrors(scope);

  const deviceId = $('patrol-device').value;
  const device = await patrolBaseDevice();
  const swapped = $('pt-swap').classList.contains('on');
  const newId = form.codeValue($('pt-new-id'));
  const newModel = $('pt-new-model').value;
  const sdChanged = $('pt-sd-changed').classList.contains('on');
  const stopped = $('pt-stopped').classList.contains('on');
  const locChanged = $('pt-loc-changed').classList.contains('on');
  const patrolAt = editing ? editing.payload.patrolAt : store.stamp();
  const answers = readAsk();

  // 補填了相機型號（舊設備沒填過）也算換了型號：畫質選項要照新型號重新確認
  const model = swapped && newModel ? newModel : (answers.cameraModel || device.cameraModel);
  ptCfg.setModel(model); // 選了新型號又關掉「更換相機」時，退回原型號的選項
  if (model !== device.cameraModel) openConfigForModel(model);
  const cfgChanged = $('pt-cfg-changed').classList.contains('on');

  let ok = form.require($('pt-battery-pct'), '請選擇目前電量');
  ok = await validateAsk(answers, device, swapped) && ok;
  if (swapped) {
    ok = form.requireCode($('pt-new-id'), '新相機編號') && ok;
    ok = form.require($('pt-new-model'), '請選擇新相機型號') && ok;
    ok = form.require($('pt-swap-reason'), '請寫更換原因') && ok;
    // 修改時，原本換上的那台（本機已存在）不算重複
    const ownNewId = editing?.payload.newDeviceId;
    if (newId && newId !== ownNewId && (newId === deviceId || await store.getDevice(newId))) {
      form.markError($('pt-new-id'), `${newId} 已經存在`);
      ok = false;
    }
  }
  if (sdChanged) ok = form.requireCode($('pt-sd-new'), '新記憶卡編號') && ok;
  if (stopped) {
    // 停的時間要落在上次巡檢和這次之間（日期格式 YYYY-MM-DD 可以直接比大小）
    const day = $('pt-stop-date').value;
    const since = store.dateOnly(device.lastPatrolAt);
    if (!day) {
      form.markError($('pt-stop-date'), '請填停止日期');
      ok = false;
    } else if (day > store.dateOnly(patrolAt) || (since && day < since)) {
      form.markError($('pt-stop-date'), `要在上次巡檢（${since || '—'}）到今天之間`);
      ok = false;
    }
  }
  if (cfgChanged) ok = ptCfg.validate() && ok;
  if (locChanged) {
    ok = form.requireCoord($('pt-coord')) && ok;
  }
  ok = form.validateCustomFields($('pt-custom'), patrolDefs) && ok;
  if (!ok) return;

  // 補問的答案：設定類的併進這次的設定（沒開「設定有變動」就用原本的設定加上答案），樣點／型號寫回設備
  const cfgAnswers = Object.fromEntries(ASK_CONFIG_KEYS.filter(k => answers[k] !== undefined).map(k => [k, answers[k]]));
  const answeredCfg = Object.keys(cfgAnswers).length > 0;
  const fill = {};
  if (answers.stationId) fill.stationId = answers.stationId;
  if (answers.cameraModel && !swapped) fill.cameraModel = answers.cameraModel;

  const record = {
    recordId: editing ? editing.payload.recordId : store.makeRecordId(),
    patrolAt,
    projectId: device.projectId,
    deviceId,
    stationId: fill.stationId || device.stationId || '',
    fill: Object.keys(fill).length ? fill : null,
    inspector: editing ? editing.payload.inspector : store.settings.inspector,
    running: !$('pt-down').classList.contains('on'),
    cameraSwapped: swapped,
    newDeviceId: swapped ? newId : '',
    newCameraModel: swapped ? newModel : '',
    swapReason: swapped ? $('pt-swap-reason').value.trim() : '',
    sdChanged,
    sdNew: sdChanged ? form.codeValue($('pt-sd-new')) : '',
    sdRetrieved: sdChanged ? (device.sdCard || '') : '',
    stoppedMidway: stopped,
    stoppedAt: stopped ? [$('pt-stop-date').value, $('pt-stop-time').value].filter(Boolean).join(' ') : '',
    stopReason: stopped ? $('pt-stop-reason').value : '',
    batteryChanged: $('pt-bat-changed').classList.contains('on'),
    batteryTypeNew: $('pt-bat-changed').classList.contains('on') ? $('pt-bat-type').value : '',
    batteryPct: Number($('pt-battery-pct').value),
    configChanged: cfgChanged || answeredCfg,
    config: cfgChanged || answeredCfg ? { ...(cfgChanged ? ptCfg.read() : device.config), ...cfgAnswers } : null,
    locationChanged: locChanged,
    lat: locChanged ? form.parseCoord($('pt-coord').value).lat : null,
    lng: locChanged ? form.parseCoord($('pt-coord').value).lng : null,
    note: $('pt-note').value.trim(),
    customFields: form.collectCustomFields($('pt-custom'), patrolDefs),
  };

  await patrolPhotos.ready();
  if (editing) {
    // 存檔前重讀一次：修改途中這筆可能剛被背景上傳（上傳完成的話改成覆蓋雲端即可）
    const queue = await store.getQueue();
    const item = queue.find(q => q.id === editing.id);
    if (item?.status === 'uploading') return alert('這筆正在上傳，請等幾秒再按一次存檔。');
    if (!item || !store.canModifyRecord(item, queue)) {
      alert('這筆紀錄已經不能修改（可能已從佇列清除），修改內容沒有儲存。');
      cancelEdit();
      return go('scr-sync');
    }
    const type = item.type === 'addRecord' && item.status !== 'done' ? 'addRecord' : 'updateRecord';
    await store.revertRecord(item);
    await store.addRecord(record, patrolPhotos.take(),
      { id: item.id, createdAt: item.createdAt, createdMs: item.createdMs }, type);
    editing = null;
  } else {
    await store.addRecord(record, patrolPhotos.take());
  }
  await updateSyncChip();
  go('scr-sync');
  syncInBackground();
});

/* ═══════════ 同步與設定 ═══════════ */

const QUEUE_LABEL = {
  addRecord: '巡檢紀錄', updateRecord: '修改巡檢紀錄', addDevice: '新增設備', addProject: '建立專案',
  saveFieldDef: '自訂欄位', deleteFieldDef: '刪除自訂欄位',
};
const QUEUE_ICON = {
  addRecord: '📝', updateRecord: '✏️', addDevice: '📷', addProject: '📁',
  saveFieldDef: '🏷️', deleteFieldDef: '🗑️',
};
const STATUS_LABEL = { pending: ['待上傳', 'wait'], uploading: ['上傳中', 'up'], done: ['✓ 已上傳', 'done'], error: ['上傳失敗', 'err'] };

// Cloudflare Access 登入過期時上傳與拉資料都會失敗，需要使用者重新登入
let loginExpired = false;

function noteSyncError(err) {
  if (err instanceof api.LoginExpiredError) loginExpired = true;
}

function netHintText() {
  if (!navigator.onLine) return '📡 目前離線 — 紀錄已安全存在手機，連上網路後依下方規則上傳。';
  if (loginExpired) return '🔒 登入已過期 — 紀錄仍安全存在手機，請按下方「重新登入」後再上傳。';
  if (store.settings.uploadRule === 'manual') return '📶 目前在線 — 上傳規則為「手動」，請按下方按鈕上傳。';
  if (store.settings.uploadRule === 'wifi' && !sync.canDetectWifi()) {
    return '📶 目前在線 — 此裝置無法判斷是否為 WiFi，「僅 WiFi」模式下會視為可上傳。';
  }
  return '📶 目前在線 — 依下方規則自動上傳待送資料。';
}

async function renderSync() {
  $('net-hint').textContent = netHintText();
  $('relogin').hidden = !(loginExpired && navigator.onLine);

  const queue = (await store.getQueue()).sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));
  $('queue-list').innerHTML = queue.length
    ? queue.map(q => {
        const [label, cls] = STATUS_LABEL[q.status] || STATUS_LABEL.pending;
        const p = q.payload;
        const target = p.stationId || p.deviceId || p.name || p.id || '';
        const photos = q.photoIds?.length ? ` · 含 ${q.photoIds.length} 張照片` : '';
        const err = q.status === 'error' ? `<br><span class="q-err">${esc(q.error)}（第 ${q.retries} 次失敗，將自動重試）</span>` : '';
        const buttons = [
          store.canModifyRecord(q, queue) ? `<button type="button" data-edit="${q.id}">✏️ 修改</button>` : '',
          store.canDeleteRecord(q, queue) ? `<button type="button" class="danger" data-del="${q.id}">🗑 刪除</button>` : '',
        ].join('');
        const actions = buttons ? `<div class="q-actions">${buttons}</div>` : '';
        return `<div class="q-item">${QUEUE_ICON[q.type] || '📄'}
          <div>${esc(target)} ${QUEUE_LABEL[q.type] || q.type}<small>${q.createdAt}${photos}${err}</small>${actions}</div>
          <span class="st ${cls}">${label}</span></div>`;
      }).join('')
    : '<p class="sec-note" style="margin:0;">目前沒有待上傳的資料。</p>';
  $('clear-done').hidden = !queue.some(q => q.status === 'done');

  setSeg($('upload-rule'), store.settings.uploadRule);
  const me = store.settings.me;
  $('me-text').textContent = me.email
    ? `${me.name || '（白名單未設定姓名）'}　${me.email}`
    : '尚未取得登入身分（連上網路開啟一次即可；一直這樣代表雲端 Apps Script 還是舊版）';
  $('versions').textContent = `網頁 ${APP_VERSION} · 雲端程式 ${backendVersion || '（尚未連線或舊版）'}`;
  await renderFieldDefs();
}

async function startEdit(itemId) {
  const queue = await store.getQueue();
  const item = queue.find(q => q.id === itemId);
  if (!item || !store.canModifyRecord(item, queue)) return alert('這筆紀錄正在上傳，或之後還有同一台的紀錄，現在不能修改');
  editing = item;
  store.settings.projectId = item.payload.projectId;
  go('scr-patrol', { auto: false });
}

$('queue-list').addEventListener('click', async e => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return startEdit(edit.dataset.edit);

  const del = e.target.closest('[data-del]');
  if (!del) return;
  const queue = await store.getQueue();
  const item = queue.find(q => q.id === del.dataset.del);
  if (!item || !store.canDeleteRecord(item, queue)) return alert('這筆紀錄正在上傳或已上傳，不能刪除');
  const where = item.payload.stationId || item.payload.deviceId;
  if (!confirm(`確定刪除 ${where} 在 ${item.payload.patrolAt} 的巡檢紀錄？照片也會一起刪除。`)) return;
  await store.deletePendingRecord(item);
  await renderSync();
  await updateSyncChip();
});

async function renderFieldDefs() {
  const projects = await store.getProjects();
  const project = projects.find(p => p.id === store.settings.projectId);
  $('fields-title').textContent = `專案自訂欄位${project ? `（${project.name}）` : ''}`;

  const defs = await store.getFieldDefs(store.settings.projectId);
  const icon = { '勾選': '☑️', '單選': '🔘', '文字': '✏️', '數字': '🔢' };
  $('fields-list').innerHTML = defs.length
    ? defs.map(d => `<div class="cf">${icon[d.type]} ${esc(d.name)}${d.required ? ' <span class="req">*</span>' : ''}
        <span class="type">${d.type}${d.options?.length ? '：' + esc(d.options.join('/')) : ''}</span>
        <button class="cf-del" type="button" data-field="${d.id}" title="刪除">✕</button></div>`).join('')
    : '<p class="sec-note" style="margin:0;">尚未設定自訂欄位。</p>';
}

// 帶一個每次不同的參數，Service Worker 的快取對不到，請求才會真的送到 Cloudflare 而被導去登入頁
$('relogin').addEventListener('click', () => {
  location.href = `./?relogin=${Date.now()}`;
});

$('fields-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-field]');
  if (!btn) return;
  if (!confirm('確定刪除此自訂欄位？已上傳的紀錄不受影響。')) return;
  await store.deleteFieldDef(btn.dataset.field);
  renderFieldDefs();
});

$('field-add').addEventListener('click', async () => {
  if (!store.settings.projectId) return alert('請先建立專案');
  $('dlg-field-name').value = '';
  $('dlg-field-options').value = '';
  $('dlg-field-type').value = '勾選';
  $('dlg-field-options-wrap').hidden = true;
  $('dlg-field-required').classList.remove('on');

  if (await openDialog('dlg-field') !== 'ok') return;
  const name = $('dlg-field-name').value.trim();
  if (!name) return;

  const type = $('dlg-field-type').value;
  const defs = await store.getFieldDefs(store.settings.projectId);
  await store.saveFieldDef({
    id: store.makeFieldId(),
    projectId: store.settings.projectId,
    name,
    type,
    options: type === '單選'
      ? $('dlg-field-options').value.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    required: $('dlg-field-required').classList.contains('on'),
    order: defs.length + 1,
  });
  await renderFieldDefs();
  await updateSyncChip();
});

$('dlg-field-type').addEventListener('change', e => {
  $('dlg-field-options-wrap').hidden = e.target.value !== '單選';
});

// 已上傳的資料都在雲端了，清掉的只是手機上的佇列紀錄
$('clear-done').addEventListener('click', async () => {
  await sync.purgeDone(0);
  await renderSync();
});

$('upload-now').addEventListener('click', async e => {
  const btn = e.target;
  btn.textContent = '上傳中…';
  btn.disabled = true;
  const result = await sync.syncNow({ force: true });
  noteSyncResult(result);
  btn.textContent = '立即全部上傳';
  btn.disabled = false;

  await renderSync();
  await updateSyncChip();
  if (result.skipped) alert(result.skipped);
  else if (result.failed) alert(`已上傳 ${result.uploaded} 筆，${result.error}`);
  else alert(result.uploaded ? `已上傳 ${result.uploaded} 筆` : '沒有待上傳的資料');
});

/* ═══════════ 專案建立 dialog ═══════════ */

async function askNewProject() {
  $('dlg-project-name').value = '';
  if (await openDialog('dlg-project') !== 'ok') return null;
  const name = $('dlg-project-name').value.trim();
  if (!name) return null;
  const project = await store.addProject(name);
  await updateSyncChip();
  return project;
}

/* ═══════════ 雲端同步 ═══════════ */

let lastPullAt = 0;

function setCloudHint(text, warn = false) {
  const el = $('cloud-hint');
  el.textContent = text;
  el.classList.toggle('warn', warn);
  el.hidden = !text;
}

/** 拉雲端最新資料：開啟 App、切回這個分頁、重新連上網路時。結果顯示在首頁，看得出是不是最新的 */
async function refreshFromCloud() {
  if (!navigator.onLine) return setCloudHint('📡 離線中，顯示的是這台裝置上的資料', true);
  setCloudHint('☁️ 正在取得雲端最新資料…');
  try {
    const data = await sync.pull();
    loginExpired = false;
    lastPullAt = Date.now();
    backendVersion = data.version || '';
    // Apps Script 只存檔沒「部署新版本」時，網址上跑的還是舊程式：新欄位（例如樣點編號）不會出現
    if (!backendVersion || olderThan(backendVersion, BACKEND_NEEDED)) {
      setCloudHint(`⚠️ 雲端的 Apps Script 還是舊版（${backendVersion || 'v0.1 以前'}，需要 ${BACKEND_NEEDED}）`
        + '，新功能（例如履歷、統計、中間有停）拿不到或存不進試算表。請到 Apps Script「管理部署作業」把現有的部署改成新版本。', true);
    } else {
      setCloudHint(`☁️ 已與雲端同步（${store.stamp().slice(11)}）`);
    }
    await renderHome();
    const active = document.querySelector('.screen.active').id;
    if (active === 'scr-sync') await renderSync();
    if (active === 'scr-stats') await renderStats();
    if (active === 'scr-pack') await renderPack();
  } catch (err) {
    noteSyncError(err);
    setCloudHint(err instanceof api.LoginExpiredError
      ? '🔒 登入已過期，顯示的是這台裝置上的資料 — 請到「同步」分頁按「重新登入」'
      : `⚠️ 無法取得雲端資料（${err.message}），顯示的是這台裝置上的資料`, true);
  }
}

async function updateSyncChip() {
  const queue = await store.getQueue();
  const pending = queue.filter(q => q.status !== 'done');
  const chip = $('sync-chip');
  chip.hidden = pending.length === 0;
  chip.querySelector('.dot').classList.toggle('ok', pending.every(q => q.status === 'uploading'));
  $('sync-chip-text').textContent = pending.some(q => q.status === 'uploading')
    ? `上傳中 ${pending.length} 筆`
    : `待上傳 ${pending.length} 筆`;
}

function noteSyncResult(result) {
  if (result.loginExpired) loginExpired = true;
  else if (result.uploaded) loginExpired = false;
}

/** 背景上傳：不擋 UI，完成後刷新畫面 */
function syncInBackground(options) {
  sync.syncNow(options).then(async result => {
    noteSyncResult(result);
    await updateSyncChip();
    if (document.querySelector('.screen.active').id === 'scr-sync') await renderSync();
  });
}

/* ═══════════ 初始化 ═══════════ */

window.addEventListener('online', () => { renderSync(); refreshFromCloud(); syncInBackground(); });
window.addEventListener('offline', () => { renderSync(); refreshFromCloud(); });
// 電腦上分頁常常開著不關：切回來時順便更新（一分鐘內拉過就不重拉）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastPullAt < 60000) return;
  refreshFromCloud();
  syncInBackground();
});

sync.setOnChange(updateSyncChip);

$('app-ver').textContent = APP_VERSION;
map.initMap({
  onSelect: id => selectDevice(id, { fromMap: true }),
  onPatrol: id => go('scr-patrol', { deviceId: id }),
});
try {
  await renderHome();
  await updateSyncChip();
} catch (err) {
  // 本機資料庫是所有功能的根基，開不起來就只能明確告知，不能靜默停在空畫面
  alert(`無法開啟本機資料庫：${err.message}\n\n請關閉其他 CATPatrol 分頁後重新開啟本 App。`);
}

// 重新登入回來：拿掉網址上的 relogin 參數，並立刻補傳（不等失敗重試的退避時間）
const relogin = location.search.includes('relogin');
if (relogin) history.replaceState(null, '', './');

// 開啟時先拉雲端最新資料，再送出待上傳佇列
refreshFromCloud();
if (navigator.onLine) syncInBackground(relogin ? { force: true } : undefined);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

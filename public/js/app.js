import { initMap, renderDevices, resizeMap } from './map.js';
import * as store from './store.js';
import * as form from './form.js';
import * as camera from './camera.js';
import * as sync from './sync.js';
import * as api from './api.js';
import { configForm, configSummary, MODEL_OPTIONS } from './cam-config.js';

// 與 sw.js 的 VERSION 一起改：顯示在標題旁，用來確認手機上是不是已經換成新版
const APP_VERSION = 'v0.2';
// 這版網頁需要的 Apps Script 版本（code.gs 的 VERSION）；雲端比這舊就在首頁提醒重新部署
const BACKEND_NEEDED = 'v0.2';
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

/* ═══════════ 導覽 ═══════════ */

/**
 * auto：進巡檢分頁時依 GPS 自動選最近的樣點；deviceId：直接開這台（從設備清單點進來）
 */
export function go(screenId, { auto = true, deviceId } = {}) {
  if (editing && screenId !== 'scr-patrol') cancelEdit();
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === screenId));
  screens.scrollTop = 0;
  if (screenId === 'scr-home') { resizeMap(); renderHome(); }
  if (screenId === 'scr-add') refreshAddMeta();
  if (screenId === 'scr-patrol') renderPatrol({ auto: auto && !deviceId, deviceId });
  if (screenId === 'scr-sync') renderSync();
}

document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => go(btn.dataset.screen));
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
    renderDevices([]);
    return;
  }

  const devices = (await store.getDevices(store.settings.projectId)).sort(byStation);
  if (!devices.length) {
    list.innerHTML = '<div class="hint">此專案還沒有設備，點下方「＋ 新增設備」建立第一台。</div>';
    renderDevices([]);
    return;
  }

  list.innerHTML = devices.map(d => {
    const status = store.deviceStatus(d);
    const camera = `序號 ${esc(d.id)}${d.cameraModel ? ` · ${esc(d.cameraModel)}` : ''}`;
    const memo = d.lastNote ? `<small class="memo">📝 ${esc(d.lastNote)}</small>` : '';
    return `<div class="dev" data-device="${esc(d.id)}">
      <div class="icon">📷</div>
      <div class="info"><b>${esc(store.stationLabel(d))}</b><small>${camera}</small>`
      + `<small>${esc(store.deviceSummary(d))}</small>${memo}</div>
      <span class="badge ${BADGE_CLASS[status]}">${status}</span>
    </div>`;
  }).join('');

  renderDevices(devices.map(d => ({
    id: d.id,
    label: store.stationLabel(d),
    model: d.cameraModel || '',
    lat: d.lat,
    lng: d.lng,
    status: store.deviceStatus(d),
    note: store.deviceSummary(d),
    memo: d.lastNote || '',
  })));
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

$('device-list').addEventListener('click', e => {
  const card = e.target.closest('[data-device]');
  if (card) go('scr-patrol', { deviceId: card.dataset.device });
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

$('add-save').addEventListener('click', async () => {
  const scope = $('scr-add');
  form.clearErrors(scope);

  let ok = form.require($('add-station'), '請輸入樣點編號');
  ok = form.require($('add-device-id'), '請輸入設備序號') && ok;
  ok = form.require($('add-model'), '請選擇相機型號') && ok;
  ok = form.require($('add-sd'), '請輸入記憶卡號碼') && ok;
  ok = form.requireCoord($('add-coord')) && ok;
  ok = addCfg.validate() && ok;
  if (!$('add-project').value) { alert('請先建立專案'); ok = false; }
  if (!ok) return;

  const id = $('add-device-id').value.trim();
  if (await store.getDevice(id)) {
    form.markError($('add-device-id'), '此設備序號已存在');
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
    sdCard: form.sdValue($('add-sd-prefix'), $('add-sd')),
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

const splitSd = card => {
  const prefix = form.sdPrefixOf(card);
  const text = String(card || '');
  return { prefix, num: text.startsWith(prefix) ? text.slice(prefix.length) : text };
};

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
    ['電池', `${device.batteryType || '—'} · ${device.batteryPct ?? '—'}%`],
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

  ['pt-down', 'pt-swap', 'pt-sd-changed', 'pt-bat-changed', 'pt-cfg-changed', 'pt-loc-changed']
    .forEach(id => $(id).classList.remove('on'));
  ['swap-new', 'sd-new', 'bat-new', 'cfg-new', 'loc-new'].forEach(id => { $(id).hidden = true; });

  $('pt-new-id').value = '';
  $('pt-new-model').value = '';
  $('pt-swap-reason').value = '';
  $('pt-sd-new-prefix').value = form.sdPrefixOf(device.sdCard);
  $('pt-sd-new').value = '';
  // 電量預設沿用上次，不一樣再改
  $('pt-battery-pct').value = [100, 75, 50, 25].includes(device.batteryPct) ? String(device.batteryPct) : '';
  $('pt-note').value = '';
  $('pt-bat-type').value = device.batteryType || '鹼性';
  ptCfg.fill(device.config, device.cameraModel);
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
  $('pt-new-id').value = p.newDeviceId || '';
  $('pt-new-model').value = p.newCameraModel || '';
  $('pt-swap-reason').value = p.swapReason || '';
  set('pt-sd-changed', p.sdChanged, 'sd-new');
  if (p.sdChanged) {
    const { prefix, num } = splitSd(p.sdNew);
    $('pt-sd-new-prefix').value = prefix;
    $('pt-sd-new').value = num;
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
  const newId = $('pt-new-id').value.trim();
  const newModel = $('pt-new-model').value;
  const sdChanged = $('pt-sd-changed').classList.contains('on');
  const locChanged = $('pt-loc-changed').classList.contains('on');

  const model = swapped && newModel ? newModel : device.cameraModel;
  ptCfg.setModel(model); // 選了新型號又關掉「更換相機」時，退回原型號的選項
  if (model !== device.cameraModel) openConfigForModel(model);
  const cfgChanged = $('pt-cfg-changed').classList.contains('on');

  let ok = form.require($('pt-battery-pct'), '請選擇目前電量');
  if (swapped) {
    ok = form.require($('pt-new-id'), '請輸入新設備序號') && ok;
    ok = form.require($('pt-new-model'), '請選擇新相機型號') && ok;
    ok = form.require($('pt-swap-reason'), '請寫更換原因') && ok;
    // 修改時，原本換上的那台（本機已存在）不算重複
    const ownNewId = editing?.payload.newDeviceId;
    if (newId && newId !== ownNewId && (newId === deviceId || await store.getDevice(newId))) {
      form.markError($('pt-new-id'), '此設備序號已存在');
      ok = false;
    }
  }
  if (sdChanged) ok = form.require($('pt-sd-new'), '請輸入新記憶卡號碼') && ok;
  if (cfgChanged) ok = ptCfg.validate() && ok;
  if (locChanged) {
    ok = form.requireCoord($('pt-coord')) && ok;
  }
  ok = form.validateCustomFields($('pt-custom'), patrolDefs) && ok;
  if (!ok) return;

  const record = {
    recordId: editing ? editing.payload.recordId : store.makeRecordId(),
    patrolAt: editing ? editing.payload.patrolAt : store.stamp(),
    projectId: device.projectId,
    deviceId,
    stationId: device.stationId || '',
    inspector: editing ? editing.payload.inspector : store.settings.inspector,
    running: !$('pt-down').classList.contains('on'),
    cameraSwapped: swapped,
    newDeviceId: swapped ? newId : '',
    newCameraModel: swapped ? newModel : '',
    swapReason: swapped ? $('pt-swap-reason').value.trim() : '',
    sdChanged,
    sdNew: sdChanged ? form.sdValue($('pt-sd-new-prefix'), $('pt-sd-new')) : '',
    sdRetrieved: sdChanged ? (device.sdCard || '') : '',
    batteryChanged: $('pt-bat-changed').classList.contains('on'),
    batteryTypeNew: $('pt-bat-changed').classList.contains('on') ? $('pt-bat-type').value : '',
    batteryPct: Number($('pt-battery-pct').value),
    configChanged: cfgChanged,
    config: cfgChanged ? ptCfg.read() : null,
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
        + '，樣點編號等新功能不會生效。請到 Apps Script「管理部署作業」把現有的部署改成新版本。', true);
    } else {
      setCloudHint(`☁️ 已與雲端同步（${store.stamp().slice(11)}）`);
    }
    await renderHome();
    if (document.querySelector('.screen.active').id === 'scr-sync') await renderSync();
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
initMap();
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

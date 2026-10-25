import { initMap, renderDevices, resizeMap } from './map.js';
import * as store from './store.js';
import * as form from './form.js';
import * as camera from './camera.js';
import * as sync from './sync.js';
import * as api from './api.js';
import { configForm, configSummary, MODEL_OPTIONS } from './cam-config.js';

const $ = id => document.getElementById(id);
const screens = $('screens');

const addPhotos = camera.photoGrid($('add-photos'));
const patrolPhotos = camera.photoGrid($('pt-photos'));
const addCfg = configForm('add');
const ptCfg = configForm('pt');

/* ═══════════ 導覽 ═══════════ */

export function go(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === screenId));
  screens.scrollTop = 0;
  if (screenId === 'scr-home') { resizeMap(); renderHome(); }
  if (screenId === 'scr-add') refreshAddMeta();
  if (screenId === 'scr-patrol') renderPatrol();
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

function fillGps(lngEl, latEl, btn) {
  if (!navigator.geolocation) return alert('此裝置無法取得 GPS 位置');
  const original = btn.textContent;
  btn.textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(
    p => {
      lngEl.value = p.coords.longitude.toFixed(5);
      latEl.value = p.coords.latitude.toFixed(5);
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

/* ═══════════ 設備清單 ═══════════ */

async function renderProjectSelects() {
  const projects = await store.getProjects();
  if (projects.length && !projects.some(p => p.id === store.settings.projectId)) {
    store.settings.projectId = projects[0].id;
  }
  const options = projects.map(p =>
    `<option value="${p.id}"${p.id === store.settings.projectId ? ' selected' : ''}>${p.name}</option>`
  ).join('') || '<option value="">（尚無專案）</option>';
  $('project-select').innerHTML = options;
  $('add-project').innerHTML = options;
  return projects;
}

async function renderHome() {
  const projects = await renderProjectSelects();
  const list = $('device-list');

  if (!projects.length) {
    list.innerHTML = '<div class="hint">還沒有任何專案。請點上方的「＋ 新專案」建立第一個。</div>';
    renderDevices([]);
    return;
  }

  const devices = await store.getDevices(store.settings.projectId);
  if (!devices.length) {
    list.innerHTML = '<div class="hint">此專案還沒有設備，點下方「＋ 新增設備」建立第一台。</div>';
    renderDevices([]);
    return;
  }

  const badgeClass = { '正常': 'ok', '電量低': 'warn', '待巡檢': 'warn', '異常': 'bad' };
  list.innerHTML = devices.map(d => {
    const status = store.deviceStatus(d);
    return `<div class="dev" data-device="${d.id}">
      <div class="icon">📷</div>
      <div class="info"><b>${d.id}</b><small>${store.deviceSummary(d)}</small></div>
      <span class="badge ${badgeClass[status]}">${status}</span>
    </div>`;
  }).join('');

  renderDevices(devices.map(d => ({
    id: d.id, lat: d.lat, lng: d.lng,
    status: store.deviceStatus(d),
    note: store.deviceSummary(d),
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
  if (!card) return;
  go('scr-patrol');
  $('patrol-device').value = card.dataset.device;
  loadPatrolDevice(card.dataset.device);
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

$('add-gps').addEventListener('click', e => fillGps($('add-lng'), $('add-lat'), e.target));

$('add-save').addEventListener('click', async () => {
  const scope = $('scr-add');
  form.clearErrors(scope);

  let ok = form.require($('add-device-id'), '請輸入設備編號');
  ok = form.require($('add-model'), '請選擇相機型號') && ok;
  ok = form.require($('add-sd'), '請輸入記憶卡編號') && ok;
  ok = form.requireCoord($('add-lng'), 180, '請輸入經度數字（例：120.30772）或按 GPS 定位') && ok;
  ok = form.requireCoord($('add-lat'), 90, '請輸入緯度數字（例：23.51234）或按 GPS 定位') && ok;
  ok = addCfg.validate() && ok;
  if (!$('add-project').value) { alert('請先建立專案'); ok = false; }
  if (!ok) return;

  const id = $('add-device-id').value.trim();
  if (await store.getDevice(id)) {
    form.markError($('add-device-id'), '此設備編號已存在');
    return;
  }

  await addPhotos.ready();
  const photoIds = addPhotos.ids();
  await store.addDevice({
    id,
    projectId: $('add-project').value,
    qrCode: id,
    cameraModel: $('add-model').value,
    lng: Number($('add-lng').value),
    lat: Number($('add-lat').value),
    sdCard: $('add-sd').value.trim(),
    batteryType: $('add-battery-type').value,
    batteryPct: Number($('add-battery-pct').value),
    config: addCfg.read(),
  }, photoIds);

  addPhotos.take();
  ['add-device-id', 'add-sd', 'add-lng', 'add-lat', 'add-config-note'].forEach(k => { $(k).value = ''; });
  $('add-battery-pct').value = '100';
  await updateSyncChip();
  go('scr-home');
  syncInBackground();
});

/* ═══════════ 巡檢 ═══════════ */

let patrolDefs = [];

async function renderPatrol() {
  const devices = await store.getDevices(store.settings.projectId);
  const select = $('patrol-device');

  $('patrol-empty').hidden = devices.length > 0;
  $('patrol-form').hidden = devices.length === 0;
  if (!devices.length) { select.innerHTML = ''; return; }

  const previous = select.value;
  select.innerHTML = devices.map(d => `<option value="${d.id}">${d.id}</option>`).join('');
  select.value = devices.some(d => d.id === previous) ? previous : devices[0].id;
  await loadPatrolDevice(select.value);
}

async function loadPatrolDevice(deviceId) {
  const device = await store.getDevice(deviceId);
  if (!device) return;

  $('last-title').textContent =
    `📋 上次巡檢狀態（${store.dateOnly(device.lastPatrolAt)} · ${device.lastInspector || '—'}）`;
  $('last-body').innerHTML = [
    ['運作狀態', device.running === false ? '⛔ 相機中斷' : '✅ 正常運作'],
    ['相機型號', device.cameraModel || '—'],
    ['記憶卡', device.sdCard || '—'],
    ['電池', `${device.batteryType || '—'} · ${device.batteryPct ?? '—'}%`],
    ['設定', configSummary(device.config)],
    ['座標', `${device.lng ?? '—'}, ${device.lat ?? '—'}`],
    ['備註', device.lastNote || '—'],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  $('patrol-meta').textContent = `${store.stamp()} · ${store.settings.inspector}`;
  $('pt-sd-retrieved').textContent = `取回卡：${device.sdCard || '—'}（自動記錄）`;
  $('pt-swap-note').textContent = `${device.id} 會標為「已撤下」，新相機沿用此處的位置與設定。`;

  ['pt-down', 'pt-swap', 'pt-sd-changed', 'pt-bat-changed', 'pt-cfg-changed', 'pt-loc-changed']
    .forEach(id => $(id).classList.remove('on'));
  ['swap-new', 'sd-new', 'bat-new', 'cfg-new', 'loc-new'].forEach(id => { $(id).hidden = true; });

  $('pt-new-id').value = '';
  $('pt-new-model').value = '';
  $('pt-sd-new').value = '';
  $('pt-battery-pct').value = '';
  $('pt-note').value = '';
  $('pt-bat-type').value = device.batteryType || '鹼性';
  ptCfg.fill(device.config, device.cameraModel);
  $('pt-lng').value = '';
  $('pt-lat').value = '';

  await patrolPhotos.reset();
  patrolDefs = await store.getFieldDefs(device.projectId);
  form.renderCustomFields($('pt-custom'), patrolDefs);
  form.clearErrors($('scr-patrol'));
}

$('patrol-device').addEventListener('change', e => loadPatrolDevice(e.target.value));
$('pt-gps').addEventListener('click', e => fillGps($('pt-lng'), $('pt-lat'), e.target));

$('pt-new-model').innerHTML = MODEL_OPTIONS;

/** 換成不同型號時畫質選項不同，打開「設定有變動」讓巡檢員重新確認新相機的設定 */
function openConfigForModel(model) {
  ptCfg.setModel(model);
  $('pt-cfg-changed').classList.add('on');
  $('cfg-new').hidden = false;
}

$('pt-new-model').addEventListener('change', async e => {
  const device = await store.getDevice($('patrol-device').value);
  if (e.target.value && e.target.value !== device.cameraModel) openConfigForModel(e.target.value);
});

$('pt-save').addEventListener('click', async () => {
  const scope = $('scr-patrol');
  form.clearErrors(scope);

  const deviceId = $('patrol-device').value;
  const device = await store.getDevice(deviceId);
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
    ok = form.require($('pt-new-id'), '請輸入新相機編號') && ok;
    ok = form.require($('pt-new-model'), '請選擇新相機型號') && ok;
    if (newId && (newId === deviceId || await store.getDevice(newId))) {
      form.markError($('pt-new-id'), '此設備編號已存在');
      ok = false;
    }
  }
  if (sdChanged) ok = form.require($('pt-sd-new'), '請輸入新記憶卡編號') && ok;
  if (cfgChanged) ok = ptCfg.validate() && ok;
  if (locChanged) {
    ok = form.requireCoord($('pt-lng'), 180, '請輸入經度數字（例：120.30772）或按 GPS 定位') && ok;
    ok = form.requireCoord($('pt-lat'), 90, '請輸入緯度數字（例：23.51234）或按 GPS 定位') && ok;
  }
  ok = form.validateCustomFields($('pt-custom'), patrolDefs) && ok;
  if (!ok) return;

  const record = {
    recordId: store.makeRecordId(),
    patrolAt: store.stamp(),
    projectId: device.projectId,
    deviceId,
    inspector: store.settings.inspector,
    running: !$('pt-down').classList.contains('on'),
    cameraSwapped: swapped,
    newDeviceId: swapped ? newId : '',
    newCameraModel: swapped ? newModel : '',
    sdChanged,
    sdNew: sdChanged ? $('pt-sd-new').value.trim() : '',
    sdRetrieved: sdChanged ? (device.sdCard || '') : '',
    batteryChanged: $('pt-bat-changed').classList.contains('on'),
    batteryTypeNew: $('pt-bat-changed').classList.contains('on') ? $('pt-bat-type').value : '',
    batteryPct: Number($('pt-battery-pct').value),
    configChanged: cfgChanged,
    config: cfgChanged ? ptCfg.read() : null,
    locationChanged: locChanged,
    lng: locChanged ? Number($('pt-lng').value) : null,
    lat: locChanged ? Number($('pt-lat').value) : null,
    note: $('pt-note').value.trim(),
    customFields: form.collectCustomFields($('pt-custom'), patrolDefs),
  };

  await patrolPhotos.ready();
  await store.addRecord(record, patrolPhotos.take());
  await updateSyncChip();
  go('scr-sync');
  syncInBackground();
});

/* ═══════════ 同步與設定 ═══════════ */

const QUEUE_LABEL = {
  addRecord: '巡檢紀錄', addDevice: '新增設備', addProject: '建立專案',
  saveFieldDef: '自訂欄位', deleteFieldDef: '刪除自訂欄位',
};
const QUEUE_ICON = {
  addRecord: '📝', addDevice: '📷', addProject: '📁',
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
        const target = q.payload.deviceId || q.payload.name || q.payload.id || '';
        const photos = q.photoIds?.length ? ` · 含 ${q.photoIds.length} 張照片` : '';
        const err = q.status === 'error' ? `<br><span class="q-err">${q.error}（第 ${q.retries} 次失敗，將自動重試）</span>` : '';
        return `<div class="q-item">${QUEUE_ICON[q.type] || '📄'}
          <div>${target} ${QUEUE_LABEL[q.type] || q.type}<small>${q.createdAt}${photos}${err}</small></div>
          <span class="st ${cls}">${label}</span></div>`;
      }).join('')
    : '<p class="sec-note" style="margin:0;">目前沒有待上傳的資料。</p>';

  setSeg($('upload-rule'), store.settings.uploadRule);
  $('inspector-input').value = store.settings.inspector;
  await renderFieldDefs();
}

async function renderFieldDefs() {
  const projects = await store.getProjects();
  const project = projects.find(p => p.id === store.settings.projectId);
  $('fields-title').textContent = `專案自訂欄位${project ? `（${project.name}）` : ''}`;

  const defs = await store.getFieldDefs(store.settings.projectId);
  const icon = { '勾選': '☑️', '單選': '🔘', '文字': '✏️', '數字': '🔢' };
  $('fields-list').innerHTML = defs.length
    ? defs.map(d => `<div class="cf">${icon[d.type]} ${d.name}${d.required ? ' <span class="req">*</span>' : ''}
        <span class="type">${d.type}${d.options?.length ? '：' + d.options.join('/') : ''}</span>
        <button class="cf-del" type="button" data-field="${d.id}" title="刪除">✕</button></div>`).join('')
    : '<p class="sec-note" style="margin:0;">尚未設定自訂欄位。</p>';
}

$('inspector-save').addEventListener('click', () => {
  const name = $('inspector-input').value.trim();
  if (!name) return alert('請輸入巡檢人員姓名');
  store.settings.inspector = name;
  alert(`已儲存：${name}`);
});

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

/* ═══════════ 初始化 ═══════════ */

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

async function askInspector() {
  while (!store.settings.inspector) {
    await openDialog('dlg-inspector');
    store.settings.inspector = $('dlg-inspector-name').value.trim();
  }
  refreshAddMeta();
}

window.addEventListener('online', () => { renderSync(); syncInBackground(); });
window.addEventListener('offline', renderSync);

sync.setOnChange(updateSyncChip);

initMap();
try {
  await renderHome();
  await updateSyncChip();
  if (!store.settings.inspector) askInspector();
} catch (err) {
  // 本機資料庫是所有功能的根基，開不起來就只能明確告知，不能靜默停在空畫面
  alert(`無法開啟本機資料庫：${err.message}\n\n請關閉其他 CATPatrol 分頁後重新開啟本 App。`);
}

// 重新登入回來：拿掉網址上的 relogin 參數，並立刻補傳（不等失敗重試的退避時間）
const relogin = location.search.includes('relogin');
if (relogin) history.replaceState(null, '', './');

// 開啟時先拉雲端最新資料，再送出待上傳佇列
if (navigator.onLine) {
  sync.pull()
    .then(() => { loginExpired = false; return renderHome(); })
    .catch(noteSyncError);
  syncInBackground(relogin ? { force: true } : undefined);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

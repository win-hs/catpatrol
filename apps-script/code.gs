/**
 * CATPatrol 雲端後端（Google Apps Script）
 * 部署步驟見同資料夾的 DEPLOY.md。首次請先於編輯器執行 setup() 授權並建立試算表／資料夾；
 * 之後更新程式若有新增欄位，也要再執行一次 setup() 補上標題列。
 * App 不直接呼叫這裡：一律經 Cloudflare Worker 代轉，token 只存在 Worker 的 secrets。
 */

const TOKEN = 'CHANGE_ME';               // ← 部署前改成自訂字串，並填入 Cloudflare Worker 的 API_TOKEN
const SS_NAME = 'CATPatrol_資料庫';
const PHOTO_ROOT = 'CATPatrol_照片';
const STALE_DAYS = 60;
const RETIRED = '已撤下';                 // 被更換掉的相機，「設備」分頁的狀態欄

// 欄位只能往最右邊加，不能插欄或改名（CATBase 也讀這份試算表）
const HEADERS = {
  '專案': ['project_id', '專案名稱', '建立日期', '狀態'],
  '設備': ['device_id', 'project_id', 'QR碼內容', '經度', '緯度', '記憶卡編號', '電池類型', '電量%',
    '拍攝模式', '連拍張數', '感度', '間隔秒', '設定備註', '建立人員', '建立時間',
    '最後巡檢時間', '最後巡檢人員', '持續運作', '最後備註', '狀態',
    '相機型號', '照片畫質', '影片畫質', '影片秒數', '工作時間', '樣點編號'],
  '巡檢紀錄': ['record_id', '巡檢時間', 'project_id', 'device_id', '巡檢人員', '持續運作', '更換記憶卡',
    '新記憶卡編號', '取回記憶卡編號', '更換電池', '新電池類型', '電量%', '設定有變動', '新設定摘要',
    '位置有變動', '經度', '緯度', '照片張數', '照片資料夾連結', '備註', '自訂欄位JSON', '上傳時間',
    '更換相機', '新設備編號', '新相機型號', '更換原因', '樣點編號'],
  '自訂欄位定義': ['project_id', '欄位名稱', '類型', '選項', '必填', '排序', 'field_id'],
  '照片索引': ['photo_id', 'record_id', 'device_id', '拍攝時間', 'Drive檔案連結', '檔名'],
  // 人工維護：登入 email 對應的姓名（App 紀錄上的巡檢人員）；CATBase 也用這張表當白名單
  '白名單': ['email', '姓名', '加入日期', '備註'],
};

/** 設備分頁欄位索引 */
const D = {
  id: 0, projectId: 1, qrCode: 2, lng: 3, lat: 4, sdCard: 5, batteryType: 6, batteryPct: 7,
  mode: 8, burst: 9, sensitivity: 10, interval: 11, configNote: 12, createdBy: 13, createdAt: 14,
  lastPatrolAt: 15, lastInspector: 16, running: 17, lastNote: 18, status: 19,
  cameraModel: 20, photoQuality: 21, videoQuality: 22, videoSec: 23, workHours: 24, stationId: 25,
};

/* ════════ 進入點 ════════ */

function doGet(e) {
  try {
    if (e.parameter.token !== TOKEN) return json_({ ok: false, error: 'token 不正確' });
    if (e.parameter.action === 'bootstrap') return json_(bootstrap_(e.parameter.user));
    return json_({ ok: false, error: '未知的 action：' + e.parameter.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = JSON.parse(e.postData.contents);
    // Cloudflare Worker 把 token 放在網址參數（不必解析整包照片資料）；body.token 為舊版 App 相容
    if ((e.parameter.token || body.token) !== TOKEN) return json_({ ok: false, error: 'token 不正確' });

    const handlers = {
      addProject: addProject_,
      saveFieldDef: saveFieldDef_,
      deleteFieldDef: deleteFieldDef_,
      addDevice: addDevice_,
      addRecord: addRecord_,
    };
    const handler = handlers[body.action];
    if (!handler) return json_({ ok: false, error: '未知的 action：' + body.action });
    return json_(handler(body));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ════════ 動作 ════════ */

/** user：Cloudflare Worker 驗證過的登入 email */
function bootstrap_(user) {
  const ss = getSS_();
  return {
    ok: true,
    me: { email: user || '', name: memberName_(ss, user) },
    projects: rows_(ss, '專案').map(r => ({
      id: r[0], name: r[1], createdAt: cell_(r[2]), status: r[3],
    })),
    fieldDefs: rows_(ss, '自訂欄位定義').map(r => ({
      projectId: r[0],
      name: r[1],
      type: r[2],
      options: String(r[3] || '').split(',').map(s => s.trim()).filter(String),
      required: r[4] === true || String(r[4]).toUpperCase() === 'TRUE',
      order: Number(r[5]) || 0,
      id: r[6],
    })),
    devices: rows_(ss, '設備').map(r => ({
      id: r[D.id],
      projectId: r[D.projectId],
      qrCode: r[D.qrCode],
      stationId: r[D.stationId],
      cameraModel: r[D.cameraModel],
      lng: numOrNull_(r[D.lng]),
      lat: numOrNull_(r[D.lat]),
      sdCard: r[D.sdCard],
      batteryType: r[D.batteryType],
      batteryPct: numOrNull_(r[D.batteryPct]),
      config: {
        mode: r[D.mode],
        photoQuality: r[D.photoQuality],
        burst: numOrNull_(r[D.burst]),
        videoQuality: r[D.videoQuality],
        videoSec: numOrNull_(r[D.videoSec]),
        sensitivity: r[D.sensitivity],
        interval: numOrNull_(r[D.interval]),
        workHours: r[D.workHours] || '全天',
        note: r[D.configNote],
      },
      createdBy: r[D.createdBy],
      createdAt: cell_(r[D.createdAt]),
      lastPatrolAt: cell_(r[D.lastPatrolAt]),
      lastInspector: r[D.lastInspector],
      running: r[D.running] !== false && String(r[D.running]).toUpperCase() !== 'FALSE',
      lastNote: r[D.lastNote],
      retired: r[D.status] === RETIRED,
    })),
  };
}

function addProject_(body) {
  const p = body.payload;
  const ss = getSS_();
  if (findRowIndex_(ss.getSheetByName('專案'), p.id) > 0) return { ok: true, dedup: true };
  ss.getSheetByName('專案').appendRow([p.id, p.name, cell_(p.createdAt), p.status || '進行中']);
  return { ok: true, id: p.id };
}

function saveFieldDef_(body) {
  const f = body.payload;
  const sheet = getSS_().getSheetByName('自訂欄位定義');
  const row = [f.projectId, f.name, f.type, (f.options || []).join(','), !!f.required, f.order || 0, f.id];
  const idx = findRowIndex_(sheet, f.id, 7); // field_id 在第 7 欄
  if (idx > 0) sheet.getRange(idx, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true, id: f.id };
}

function deleteFieldDef_(body) {
  const sheet = getSS_().getSheetByName('自訂欄位定義');
  const idx = findRowIndex_(sheet, body.payload.id, 7);
  if (idx > 0) sheet.deleteRow(idx);
  return { ok: true, id: body.payload.id };
}

function addDevice_(body) {
  const d = body.payload;
  const ss = getSS_();
  const sheet = ss.getSheetByName('設備');
  if (findRowIndex_(sheet, d.id) > 0) return { ok: true, dedup: true };

  const cfg = d.config || {};
  const row = [];
  row[D.id] = d.id;
  row[D.projectId] = d.projectId;
  row[D.qrCode] = d.qrCode || d.id;
  row[D.stationId] = d.stationId || '';
  row[D.cameraModel] = d.cameraModel || '';
  row[D.lng] = d.lng;
  row[D.lat] = d.lat;
  row[D.sdCard] = d.sdCard;
  row[D.batteryType] = d.batteryType;
  row[D.batteryPct] = d.batteryPct;
  writeConfig_(row, cfg);
  row[D.createdBy] = d.createdBy;
  row[D.createdAt] = d.createdAt;
  row[D.lastPatrolAt] = d.lastPatrolAt;
  row[D.lastInspector] = d.lastInspector;
  row[D.running] = d.running !== false;
  row[D.lastNote] = d.lastNote || '';
  row[D.status] = calcStatus_(d.running !== false, d.batteryPct, d.lastPatrolAt);
  sheet.appendRow(row);

  savePhotos_(ss, body.photos, d.projectId, d.id, String(d.createdAt).slice(0, 10), '');
  return { ok: true, id: d.id };
}

function addRecord_(body) {
  const rec = body.payload;
  const ss = getSS_();
  const sheet = ss.getSheetByName('巡檢紀錄');

  // 以 record_id 去重：離線重送時不會重複寫入
  if (findRowIndex_(sheet, rec.recordId) > 0) {
    return { ok: true, dedup: true, recordId: rec.recordId };
  }

  const day = String(rec.patrolAt).slice(0, 10);
  const folderUrl = savePhotos_(ss, body.photos, rec.projectId, rec.deviceId, day, rec.recordId);

  sheet.appendRow([
    rec.recordId, rec.patrolAt, rec.projectId, rec.deviceId, rec.inspector,
    !!rec.running, !!rec.sdChanged, rec.sdNew || '', rec.sdRetrieved || '',
    !!rec.batteryChanged, rec.batteryTypeNew || '', rec.batteryPct,
    !!rec.configChanged, configSummary_(rec.config),
    !!rec.locationChanged, rec.lng == null ? '' : rec.lng, rec.lat == null ? '' : rec.lat,
    (body.photos || []).length, folderUrl, rec.note || '',
    JSON.stringify(rec.customFields || {}), now_(),
    !!rec.cameraSwapped, rec.newDeviceId || '', rec.newCameraModel || '',
    rec.swapReason || '', rec.stationId || '',
  ]);

  applyRecordToDevice_(ss, rec);
  return { ok: true, recordId: rec.recordId };
}

/** 把巡檢結果寫回「設備」分頁的現況；較舊的紀錄不覆蓋較新的現況 */
function applyRecordToDevice_(ss, rec) {
  const sheet = ss.getSheetByName('設備');
  const idx = findRowIndex_(sheet, rec.deviceId);
  if (idx < 0) return;

  const width = HEADERS['設備'].length;
  const row = sheet.getRange(idx, 1, 1, width).getValues()[0];
  const stale = cell_(row[D.lastPatrolAt]) > rec.patrolAt;
  if (stale && !rec.cameraSwapped) return;

  if (!stale) {
    row[D.lastPatrolAt] = rec.patrolAt;
    row[D.lastInspector] = rec.inspector;
    row[D.running] = !!rec.running;
    row[D.lastNote] = rec.note || '';
  }

  if (rec.cameraSwapped) {
    // 舊相機撤下（其餘欄位保留撤下當時的樣子）；新相機另起一列，接手位置、耗材與設定
    const fresh = row.slice();
    row[D.status] = RETIRED;
    sheet.getRange(idx, 1, 1, width).setValues([row]);

    fresh[D.id] = rec.newDeviceId;
    fresh[D.qrCode] = rec.newDeviceId;
    fresh[D.cameraModel] = rec.newCameraModel;
    fresh[D.createdBy] = rec.inspector;
    fresh[D.createdAt] = rec.patrolAt;
    fresh[D.lastPatrolAt] = rec.patrolAt;
    fresh[D.lastInspector] = rec.inspector;
    fresh[D.running] = true;
    fresh[D.lastNote] = rec.note || '';
    applyChanges_(fresh, rec);
    fresh[D.status] = calcStatus_(true, rec.batteryPct, rec.patrolAt);
    const existing = findRowIndex_(sheet, rec.newDeviceId);
    if (existing > 0) sheet.getRange(existing, 1, 1, width).setValues([fresh]);
    else sheet.appendRow(fresh);
    return;
  }

  applyChanges_(row, rec);
  row[D.status] = calcStatus_(!!rec.running, rec.batteryPct, rec.patrolAt);
  sheet.getRange(idx, 1, 1, width).setValues([row]);
}

/** 巡檢時的電量，以及有變動的記憶卡、電池、設定、位置 */
function applyChanges_(row, rec) {
  row[D.batteryPct] = rec.batteryPct;
  if (rec.sdChanged) row[D.sdCard] = rec.sdNew;
  if (rec.batteryChanged) row[D.batteryType] = rec.batteryTypeNew;
  if (rec.configChanged && rec.config) writeConfig_(row, rec.config);
  if (rec.locationChanged) {
    row[D.lng] = rec.lng;
    row[D.lat] = rec.lat;
  }
}

function writeConfig_(row, cfg) {
  row[D.mode] = cfg.mode;
  row[D.photoQuality] = cfg.photoQuality || '';
  row[D.burst] = blank_(cfg.burst);
  row[D.videoQuality] = cfg.videoQuality || '';
  row[D.videoSec] = blank_(cfg.videoSec);
  row[D.sensitivity] = cfg.sensitivity;
  row[D.interval] = cfg.interval;
  row[D.workHours] = cfg.workHours || '全天';
  row[D.configNote] = cfg.note || '';
}

/* ════════ 照片 ════════ */

function savePhotos_(ss, photos, projectId, deviceId, day, recordId) {
  if (!photos || !photos.length) return '';

  const projectRow = findRow_(ss.getSheetByName('專案'), projectId);
  const projectName = projectRow ? projectRow[1] : projectId;
  const folder = childFolder_(childFolder_(childFolder_(photoRoot_(), projectName), deviceId), day);
  const index = ss.getSheetByName('照片索引');

  photos.forEach((p, i) => {
    const name = p.name || (deviceId + '_' + day.replace(/-/g, '') + '_' + pad2_(i + 1) + '.jpg');
    const blob = Utilities.newBlob(Utilities.base64Decode(p.dataBase64), 'image/jpeg', name);
    const file = folder.createFile(blob);
    index.appendRow([p.photoId || '', recordId, deviceId, now_(), file.getUrl(), name]);
  });
  return folder.getUrl();
}

/* ════════ 工具 ════════ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSS_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SS_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* 已刪除，重建 */ }
  }
  const ss = SpreadsheetApp.create(SS_NAME);
  props.setProperty('SS_ID', ss.getId());
  initSheets_(ss);
  return ss;
}

function initSheets_(ss) {
  Object.keys(HEADERS).forEach(name => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  const first = ss.getSheets()[0];
  if (!HEADERS[first.getName()]) ss.deleteSheet(first);
}

function photoRoot_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* 已刪除，重建 */ }
  }
  const it = DriveApp.getFoldersByName(PHOTO_ROOT);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_ROOT);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function rows_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS[name].length).getValues();
}

/** 白名單分頁查姓名；分頁還沒建（舊試算表沒重跑 setup）或查不到時回空字串 */
function memberName_(ss, email) {
  const sheet = ss.getSheetByName('白名單');
  if (!email || !sheet || sheet.getLastRow() < 2) return '';
  const key = String(email).trim().toLowerCase();
  const hit = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues()
    .find(r => String(r[0]).trim().toLowerCase() === key);
  return hit ? String(hit[1]).trim() : '';
}

/** 回傳列號（1-based，含標題列），找不到為 -1 */
function findRowIndex_(sheet, value, column) {
  if (sheet.getLastRow() < 2) return -1;
  const col = column || 1;
  const found = sheet.getRange(2, col, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return found ? found.getRow() : -1;
}

function findRow_(sheet, value) {
  const idx = findRowIndex_(sheet, value);
  return idx > 0 ? sheet.getRange(idx, 1, 1, sheet.getLastColumn()).getValues()[0] : null;
}

function calcStatus_(running, batteryPct, lastPatrolAt) {
  if (!running) return '異常';
  if (daysSince_(lastPatrolAt) > STALE_DAYS) return '待巡檢';
  if (batteryPct !== '' && batteryPct != null && Number(batteryPct) <= 25) return '電量低';
  return '正常';
}

function daysSince_(stamp) {
  if (!stamp) return Number.MAX_VALUE;
  const t = new Date(String(stamp).replace(' ', 'T')).getTime();
  return isNaN(t) ? Number.MAX_VALUE : (Date.now() - t) / 86400000;
}

/** 格式與前端 cam-config.js 的 configSummary 相同 */
function configSummary_(cfg) {
  if (!cfg) return '';
  const parts = [cfg.mode];
  if (cfg.mode !== '影片') parts.push('照片' + (cfg.photoQuality || '—'), '連拍' + blank_(cfg.burst));
  if (cfg.mode === '影片' || cfg.mode === '照片+影片') {
    parts.push('影片' + (cfg.videoQuality || '—') + ' ' + blank_(cfg.videoSec) + '秒');
  }
  parts.push('感度' + cfg.sensitivity, '間隔' + cfg.interval + 's', '工作時間' + (cfg.workHours || '全天'));
  return parts.join(' · ');
}

function cell_(v) {
  return v instanceof Date
    ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    : String(v == null ? '' : v);
}

function now_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

const numOrNull_ = v => (v === '' || v == null ? null : Number(v));
const blank_ = v => (v == null ? '' : v);
const pad2_ = n => (n < 10 ? '0' + n : String(n));

/* ════════ 首次設定 ════════ */

/** 於編輯器手動執行一次：授權、建立試算表與照片資料夾，並印出網址。 */
function setup() {
  const ss = getSS_();
  initSheets_(ss);
  const folder = photoRoot_();
  Logger.log('試算表：' + ss.getUrl());
  Logger.log('照片資料夾：' + folder.getUrl());
  return { spreadsheet: ss.getUrl(), folder: folder.getUrl() };
}

/**
 * ⚠️ 清空所有資料列與所有照片（保留標題列、資料夾本身與白名單）。測試完畢想從乾淨狀態開始時，
 * 於編輯器手動執行。無法從網路呼叫，只有你本人在編輯器能執行。
 */
function clearAllData() {
  const ss = getSS_();
  // 白名單是人員名單不是測試資料，保留
  Object.keys(HEADERS).filter(name => name !== '白名單').forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    }
  });
  const root = photoRoot_();
  const folders = root.getFolders();
  while (folders.hasNext()) folders.next().setTrashed(true);
  const files = root.getFiles();
  while (files.hasNext()) files.next().setTrashed(true);
  Logger.log('已清空所有資料列與照片。');
}

/**
 * ⚠️ 刪除指定設備的所有資料：設備列、巡檢紀錄、照片索引，以及照片資料夾（移到垃圾桶）。
 * 把要刪的設備序號填進 IDS（不分大小寫），於編輯器手動執行；執行記錄會列出實際刪了什麼。
 * 各手機下次開啟 App 時會跟著移除這些設備。
 */
function deleteDevices() {
  const IDS = ['132', 'Ca-78'];

  const ss = getSS_();
  const wanted = IDS.map(id => String(id).trim().toLowerCase());
  const match = v => wanted.indexOf(String(v).trim().toLowerCase()) >= 0;

  // 照片資料夾路徑要用專案名稱，刪設備列之前先記下來
  const projects = {};
  rows_(ss, '專案').forEach(r => { projects[r[0]] = r[1]; });
  const devices = rows_(ss, '設備').filter(r => match(r[D.id]));

  // [分頁, device_id 所在欄（0-based）]；由下往上刪，列號才不會跑掉
  [['設備', D.id], ['巡檢紀錄', 3], ['照片索引', 2]].forEach(([name, col]) => {
    const sheet = ss.getSheetByName(name);
    const values = rows_(ss, name);
    let count = 0;
    for (let i = values.length - 1; i >= 0; i--) {
      if (match(values[i][col])) { sheet.deleteRow(i + 2); count++; }
    }
    Logger.log(name + '：刪除 ' + count + ' 列');
  });

  devices.forEach(r => {
    const projectName = projects[r[D.projectId]] || r[D.projectId];
    const projectFolders = photoRoot_().getFoldersByName(projectName);
    if (!projectFolders.hasNext()) return;
    const deviceFolders = projectFolders.next().getFoldersByName(r[D.id]);
    while (deviceFolders.hasNext()) deviceFolders.next().setTrashed(true);
    Logger.log('照片資料夾已移到垃圾桶：' + projectName + '/' + r[D.id]);
  });

  const found = devices.map(r => String(r[D.id]).toLowerCase());
  const missing = IDS.filter(id => found.indexOf(String(id).trim().toLowerCase()) < 0);
  if (missing.length) Logger.log('設備分頁找不到：' + missing.join('、') + '（請確認序號）');
}

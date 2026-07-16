/**
 * CATPatrol 雲端後端（Google Apps Script）
 * 部署步驟見同資料夾的 DEPLOY.md。首次請先於編輯器執行 setup() 授權並建立試算表／資料夾。
 */

const TOKEN = 'CHANGE_ME';               // ← 部署前改成自訂字串，並填入 App 設定頁
const SS_NAME = 'CATPatrol_資料庫';
const PHOTO_ROOT = 'CATPatrol_照片';
const STALE_DAYS = 60;

const HEADERS = {
  '專案': ['project_id', '專案名稱', '建立日期', '狀態'],
  '設備': ['device_id', 'project_id', 'QR碼內容', '經度', '緯度', '記憶卡編號', '電池類型', '電量%',
    '拍攝模式', '連拍張數', '感度', '間隔秒', '設定備註', '建立人員', '建立時間',
    '最後巡檢時間', '最後巡檢人員', '持續運作', '最後備註', '狀態'],
  '巡檢紀錄': ['record_id', '巡檢時間', 'project_id', 'device_id', '巡檢人員', '持續運作', '更換記憶卡',
    '新記憶卡編號', '取回記憶卡編號', '更換電池', '新電池類型', '電量%', '設定有變動', '新設定摘要',
    '位置有變動', '經度', '緯度', '照片張數', '照片資料夾連結', '備註', '自訂欄位JSON', '上傳時間'],
  '自訂欄位定義': ['project_id', '欄位名稱', '類型', '選項', '必填', '排序', 'field_id'],
  '照片索引': ['photo_id', 'record_id', 'device_id', '拍攝時間', 'Drive檔案連結', '檔名'],
};

/** 設備分頁欄位索引 */
const D = {
  id: 0, projectId: 1, qrCode: 2, lng: 3, lat: 4, sdCard: 5, batteryType: 6, batteryPct: 7,
  mode: 8, burst: 9, sensitivity: 10, interval: 11, configNote: 12, createdBy: 13, createdAt: 14,
  lastPatrolAt: 15, lastInspector: 16, running: 17, lastNote: 18, status: 19,
};

/* ════════ 進入點 ════════ */

function doGet(e) {
  try {
    if (e.parameter.token !== TOKEN) return json_({ ok: false, error: 'token 不正確' });
    if (e.parameter.action === 'bootstrap') return json_(bootstrap_());
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
    if (body.token !== TOKEN) return json_({ ok: false, error: 'token 不正確' });

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

function bootstrap_() {
  const ss = getSS_();
  return {
    ok: true,
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
      lng: numOrNull_(r[D.lng]),
      lat: numOrNull_(r[D.lat]),
      sdCard: r[D.sdCard],
      batteryType: r[D.batteryType],
      batteryPct: numOrNull_(r[D.batteryPct]),
      config: {
        mode: r[D.mode],
        burst: numOrNull_(r[D.burst]),
        sensitivity: r[D.sensitivity],
        interval: numOrNull_(r[D.interval]),
        note: r[D.configNote],
      },
      createdBy: r[D.createdBy],
      createdAt: cell_(r[D.createdAt]),
      lastPatrolAt: cell_(r[D.lastPatrolAt]),
      lastInspector: r[D.lastInspector],
      running: r[D.running] !== false && String(r[D.running]).toUpperCase() !== 'FALSE',
      lastNote: r[D.lastNote],
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
  row[D.lng] = d.lng;
  row[D.lat] = d.lat;
  row[D.sdCard] = d.sdCard;
  row[D.batteryType] = d.batteryType;
  row[D.batteryPct] = d.batteryPct;
  row[D.mode] = cfg.mode;
  row[D.burst] = cfg.burst;
  row[D.sensitivity] = cfg.sensitivity;
  row[D.interval] = cfg.interval;
  row[D.configNote] = cfg.note || '';
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
  if (cell_(row[D.lastPatrolAt]) > rec.patrolAt) return;

  row[D.lastPatrolAt] = rec.patrolAt;
  row[D.lastInspector] = rec.inspector;
  row[D.running] = !!rec.running;
  row[D.batteryPct] = rec.batteryPct;
  row[D.lastNote] = rec.note || '';
  if (rec.sdChanged) row[D.sdCard] = rec.sdNew;
  if (rec.batteryChanged) row[D.batteryType] = rec.batteryTypeNew;
  if (rec.configChanged && rec.config) {
    row[D.mode] = rec.config.mode;
    row[D.burst] = rec.config.burst;
    row[D.sensitivity] = rec.config.sensitivity;
    row[D.interval] = rec.config.interval;
    row[D.configNote] = rec.config.note || '';
  }
  if (rec.locationChanged) {
    row[D.lng] = rec.lng;
    row[D.lat] = rec.lat;
  }
  row[D.status] = calcStatus_(!!rec.running, rec.batteryPct, rec.patrolAt);
  sheet.getRange(idx, 1, 1, width).setValues([row]);
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
  if (batteryPct !== '' && batteryPct != null && Number(batteryPct) <= 40) return '電量低';
  return '正常';
}

function daysSince_(stamp) {
  if (!stamp) return Number.MAX_VALUE;
  const t = new Date(String(stamp).replace(' ', 'T')).getTime();
  return isNaN(t) ? Number.MAX_VALUE : (Date.now() - t) / 86400000;
}

function configSummary_(cfg) {
  if (!cfg) return '';
  return cfg.mode + ' · 連拍' + cfg.burst + ' · 感度' + cfg.sensitivity + ' · 間隔' + cfg.interval + 's';
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
 * ⚠️ 清空所有資料列與所有照片（保留標題列與資料夾本身）。測試完畢想從乾淨狀態開始時，
 * 於編輯器手動執行。無法從網路呼叫，只有你本人在編輯器能執行。
 */
function clearAllData() {
  const ss = getSS_();
  Object.keys(HEADERS).forEach(name => {
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

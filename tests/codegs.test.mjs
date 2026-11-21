// code.gs 測試：用記憶體模擬 SpreadsheetApp / DriveApp 等服務，實際跑 doGet / doPost / 編輯器函式。
// 執行：node tests/codegs.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 和真的試算表一樣：新分頁只有 26 欄（A–Z），讀寫超出的欄會丟例外；appendRow 會自動加欄
function makeSheet(name) {
  const data = [];
  let maxCols = 26;
  const sheet = {
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map(r => r.length)),
    getMaxColumns: () => maxCols,
    insertColumnsAfter(after, n) { maxCols += n; },
    setFrozenRows() {},
    appendRow(arr) {
      maxCols = Math.max(maxCols, arr.length);
      data.push(Array.from(arr, v => (v === undefined || v === null ? '' : v)));
    },
    deleteRow(i) { data.splice(i - 1, 1); },
    deleteRows(i, n) { data.splice(i - 1, n); },
    getRange(row, col, nr = 1, nc = 1) {
      if (col + nc - 1 > maxCols) throw new Error(`The coordinates of the range are outside the dimensions of the sheet (${name})`);
      const range = {
        getValues: () => Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => {
          const v = data[row - 1 + r]?.[col - 1 + c];
          return v === undefined ? '' : v;
        })),
        setValues(vals) {
          vals.forEach((rv, r) => {
            data[row - 1 + r] ||= [];
            rv.forEach((v, c) => { data[row - 1 + r][col - 1 + c] = v === undefined || v === null ? '' : v; });
          });
          return range;
        },
        setFontWeight: () => range,
        createTextFinder(text) {
          let entire = false;
          return {
            matchEntireCell(b) { entire = b; return this; },
            findNext() {
              for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
                const v = String(data[row - 1 + r]?.[col - 1 + c] ?? '');
                if (entire ? v === text : v.includes(text)) return { getRow: () => row + r };
              }
              return null;
            },
          };
        },
      };
      return range;
    },
    _data: data,
  };
  return sheet;
}

let ss = null;
function makeSS() {
  const sheets = [makeSheet('工作表1')];
  return {
    getId: () => 'SS1', getUrl: () => 'https://sheets/SS1',
    getSheetByName: n => sheets.find(s => s.getName() === n) || null,
    insertSheet: n => { const s = makeSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets,
    deleteSheet: s => sheets.splice(sheets.indexOf(s), 1),
  };
}

const trashed = [];
const files = {}; // Drive 檔案 id → 內容
let fileSeq = 0;
const iter = list => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
function makeFolder(path, leaf = path) {
  const kids = [];
  const folder = {
    path, leaf,
    getId: () => 'F-' + path, getUrl: () => 'https://drive/' + path,
    getName: () => folder.leaf,
    setName(n) { folder.leaf = n; folder.path = path.replace(/[^/]*$/, n); },
    getFoldersByName: n => iter(kids.filter(k => k.leaf === n && !k.trashed)),
    createFolder: n => { const f = makeFolder(folder.path + '/' + n, n); kids.push(f); return f; },
    createFile: blob => {
      const id = 'FILE' + (++fileSeq);
      files[id] = blob;
      return { getUrl: () => `https://drive.google.com/file/d/${id}/view?usp=drivesdk` };
    },
    getFolders: () => iter(kids.filter(k => !k.trashed)), getFiles: () => ({ hasNext: () => false }),
    setTrashed(b) { folder.trashed = b; trashed.push(folder.path); },
  };
  return folder;
}
const copies = []; // 改編號前的試算表備份
const root = makeFolder('CATPatrol_照片');
const props = { API_TOKEN: 'T0K' }; // v0.4 起 token 放在指令碼屬性
const logs = [];
const ctx = {
  console,
  SpreadsheetApp: { openById: () => { if (!ss) throw new Error('gone'); return ss; }, create: () => (ss = makeSS()) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ setMimeType: () => ({ body: JSON.parse(s) }) }), MimeType: { JSON: 'json' } },
  Utilities: {
    formatDate: d => d.toISOString().slice(0, 16).replace('T', ' '),
    base64Decode: s => Buffer.from(s, 'base64'),
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    newBlob: (bytes, type, name) => ({ name, bytes, type }),
  },
  Session: { getScriptTimeZone: () => 'Asia/Taipei' },
  DriveApp: {
    getFolderById: () => root,
    getFoldersByName: () => ({ hasNext: () => true, next: () => root }),
    createFolder: () => root,
    getFileById: id => ({
      getBlob: () => ({ getBytes: () => files[id].bytes, getContentType: () => files[id].type }),
      makeCopy: name => { copies.push({ id, name, rows: ss.getSheetByName('設備')._data.map(r => r.slice()) }); return { getName: () => name }; },
    }),
  },
  Logger: { log: m => logs.push(m) },
};
vm.createContext(ctx);
const src = fs.readFileSync(path.join(here, '../apps-script/code.gs'), 'utf8');
vm.runInContext(src + '\nglobalThis.__api = { doGet, doPost, setup, clearAllData, deleteDevices, fixIds, D, HEADERS, configSummary_, camId_, sdId_ };', ctx);
const { doGet, doPost, setup, clearAllData, deleteDevices, fixIds, D, HEADERS, configSummary_, camId_, sdId_ } = ctx.__api;

const post = (body, { token = 'T0K', user = 'field@x.org' } = {}) =>
  doPost({ parameter: { ...(token ? { token } : {}), user }, postData: { contents: JSON.stringify(body) } }).body;
const boot = (user = 'field@x.org') => doGet({ parameter: { token: 'T0K', action: 'bootstrap', user } }).body;
const sheet = name => ss.getSheetByName(name)._data;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + extra}`);
};

// ── 舊版（v0.2）試算表：設備 26 欄、巡檢紀錄 27 欄、沒有白名單分頁，也沒在編輯器重跑 setup。
//    換新版程式後第一次被呼叫就要自動補欄位與分頁，bootstrap 不能壞
ss = makeSS(); props.SS_ID = 'SS1';
['專案', '設備', '巡檢紀錄', '自訂欄位定義', '照片索引'].forEach(n => ss.insertSheet(n));
ss.getSheetByName('設備').appendRow(HEADERS['設備'].slice(0, 26));
ss.getSheetByName('設備').appendRow(['OLD-1', 'P0', 'OLD-1', 121, 23.5, '野1', '鋰電', 75, '影片', '', '中', 0, '', '王', '2026-10-01 10:00',
  '2026-10-01 10:00', '王', true, '', '正常', 'Meidase P70', '', '1080p', 30, '全天', 'S-OLD']);
ss.getSheetByName('巡檢紀錄').appendRow(HEADERS['巡檢紀錄'].slice(0, 27));
let b = boot();
check('v0.2 sheet: bootstrap ok, name blank', b.ok && b.me.email === 'field@x.org' && b.me.name === '', JSON.stringify(b));
check('v0.2 sheet auto-upgraded: 設備 31 cols, 巡檢紀錄 30 cols, 白名單 added',
  sheet('設備')[0].length === 31 && sheet('巡檢紀錄')[0][29] === '停止原因' && !!ss.getSheetByName('白名單')
  && ss.getSheetByName('設備').getMaxColumns() >= 31, JSON.stringify(sheet('設備')[0]));
const oldDev = b.devices[0];
check('old device: new config fields empty, night secs null, mount blank',
  oldDev.config.videoSecNight === null && oldDev.config.ironCase === null && oldDev.config.mount === ''
  && oldDev.batteryChangedAt === '', JSON.stringify(oldDev));
check('existing sheets are not deleted by the upgrade', ss.getSheets().some(s => s.getName() === '工作表1'));
check('upgrade also fixes old SD/camera codes once, after backing up the spreadsheet',
  oldDev.sdCard === 'SD001' && oldDev.id === 'OLD-1' && copies.length === 1 && copies[0].rows[1][5] === '野1'
  && /^CATPatrol_資料庫_備份_改編號前_/.test(copies[0].name), JSON.stringify(copies));
check('upgrade runs once per version', props.SHEETS_VERSION && boot().ok && copies.length === 1);

// ── setup 建分頁與表頭
ss = null; delete props.SS_ID; delete props.SHEETS_VERSION;
setup();
check('new spreadsheet: default 工作表1 removed', !ss.getSheetByName('工作表1'));
check('設備 header 31 cols ending 夜間影片秒數/鐵殼/上鎖/遮雨板/固定方式',
  sheet('設備')[0].length === 31 && sheet('設備')[0][25] === '樣點編號'
  && sheet('設備')[0].slice(26).join('|') === '夜間影片秒數|鐵殼|上鎖|遮雨板|固定方式');
check('new spreadsheet: nothing to fix, no backup made', copies.length === 1 && props.IDS_FIX_VERSION === '2');
check('巡檢紀錄 header 30 cols ending 中間有停/停止時間/停止原因',
  sheet('巡檢紀錄')[0].length === 30 && sheet('巡檢紀錄')[0][26] === '樣點編號' && sheet('巡檢紀錄')[0].slice(27).join('|') === '中間有停|停止時間|停止原因');
check('白名單 sheet created', sheet('白名單')[0].join('|') === 'email|姓名|加入日期|備註');
check('D indices match header names',
  HEADERS['設備'][D.stationId] === '樣點編號' && HEADERS['設備'][D.cameraModel] === '相機型號' && HEADERS['設備'][D.status] === '狀態'
  && HEADERS['設備'][D.videoSecNight] === '夜間影片秒數' && HEADERS['設備'][D.ironCase] === '鐵殼'
  && HEADERS['設備'][D.locked] === '上鎖' && HEADERS['設備'][D.rainCover] === '遮雨板' && HEADERS['設備'][D.mount] === '固定方式');

// ── 白名單姓名（email 不分大小寫）
ss.getSheetByName('白名單').appendRow(['Field@X.org', '王小明', '2026-10-31', '']);
check('me.name from 白名單, case-insensitive', boot('field@x.org').me.name === '王小明');
check('bootstrap reports backend version', /^v\d+\.\d+$/.test(boot().version), boot().version);
check('unknown email: name blank', boot('nobody@x.org').me.name === '');

check('wrong token rejected', post({ action: 'addProject', payload: { id: 'P1', name: 'x' } }, { token: 'bad' }).error === 'token 不正確');
check('code has no token literal (pasting a new version needs no edit)', !/const TOKEN\b/.test(src) && !src.includes('CHANGE_ME'));
delete props.API_TOKEN;
const noTok = boot();
check('token property missing: clear message on GET and POST, nothing written',
  noTok.ok === false && noTok.error.includes('指令碼屬性') && noTok.error.includes('API_TOKEN')
  && post({ action: 'addProject', payload: { id: 'PX', name: 'x' } }).error.includes('API_TOKEN')
  && !sheet('專案').some(r => r[0] === 'PX'), JSON.stringify(noTok));
check('token property missing: empty token does not pass', post({ action: 'addProject', payload: { id: 'PX', name: 'x' } }, { token: '' }).ok === false);
props.API_TOKEN = 'T0K';
check('addProject ok', post({ action: 'addProject', payload: { id: 'P1', name: '玉山', createdAt: '2026-10-25 10:00' } }).ok);

const cfg = { mode: '照片', photoQuality: '32MP', burst: 3, videoQuality: '', videoSec: null, sensitivity: '中', interval: 0, workHours: '全天', note: '' };
const addDev = (id, stationId) => post({ action: 'addDevice', photos: [], payload: {
  id, projectId: 'P1', stationId, qrCode: id, cameraModel: 'Meidase P70', lng: 121.1, lat: 23.5, sdCard: '野12',
  batteryType: '鋰電', batteryPct: 100, config: cfg, createdBy: '王小明', createdAt: '2026-10-25 10:00',
  lastPatrolAt: '2026-10-25 10:00', lastInspector: '王小明', running: true } });
check('addDevice ok', addDev('CAM-1', 'S-01').ok);
const devRow = sheet('設備')[1];
check('device row: 樣點編號 col 26, old-style SD 野12 stored as SD012', devRow[25] === 'S-01' && devRow[5] === 'SD012', JSON.stringify(devRow));
check('bootstrap returns stationId', boot().devices[0].stationId === 'S-01');

// ── 日夜不同的影片秒數、現場防護（鐵殼／上鎖／遮雨板）
const vcfg = { ...cfg, mode: '照片+影片', videoQuality: '1080p', videoSec: 30, videoSecNight: 15, ironCase: true, locked: false, rainCover: true };
post({ action: 'addDevice', photos: [], payload: {
  id: 'VID-1', projectId: 'P1', stationId: 'S-V', qrCode: 'VID-1', cameraModel: 'Meidase P70', lng: 121.2, lat: 23.6, sdCard: 'Wv3',
  batteryType: '鋰電', batteryPct: 100, config: vcfg, createdBy: '王小明', createdAt: '2026-10-26 10:00',
  lastPatrolAt: '2026-10-26 10:00', lastInspector: '王小明', running: true } });
const vRow = sheet('設備').find(r => r[0] === 'VID-1');
check('device row: night secs + guards in cols 27–30', vRow[23] === 30 && vRow[26] === 15 && vRow[27] === true && vRow[28] === false && vRow[29] === true,
  JSON.stringify(vRow.slice(20)));
const vDev = boot().devices.find(d => d.id === 'VID-1');
check('bootstrap returns night secs + guards', vDev.config.videoSecNight === 15 && vDev.config.ironCase === true
  && vDev.config.locked === false && vDev.config.rainCover === true, JSON.stringify(vDev.config));
check('never changed battery: batteryChangedAt blank (App falls back to createdAt)', vDev.batteryChangedAt === '');

// ── 固定方式（第 31 欄）、巡檢時補填樣點編號／相機型號
post({ action: 'addDevice', photos: [], payload: {
  id: '7', projectId: 'P1', stationId: 'S-07', qrCode: '7', cameraModel: 'Meidase P70', lng: 121.3, lat: 23.7, sdCard: '野3',
  batteryType: '鋰電', batteryPct: 100, config: { ...cfg, mount: '角鋼' }, createdBy: '王小明', createdAt: '2026-10-26 10:00',
  lastPatrolAt: '2026-10-26 10:00', lastInspector: '王小明', running: true } });
const r7 = sheet('設備').find(r => r[0] === 'CA007');
check('old-style ids from a stale phone are stored in the new format (7 → CA007, 野3 → SD003)', r7 && r7[5] === 'SD003', JSON.stringify(r7));
check('mount in col 31 and returned by bootstrap', r7[30] === '角鋼' && boot().devices.find(d => d.id === 'CA007').config.mount === '角鋼');
post({ action: 'addRecord', photos: [], payload: { recordId: 'REC-F', patrolAt: '2026-11-21 08:00', projectId: 'P1', deviceId: '7',
  stationId: 'S-NEW', inspector: '王小明', running: true, sdChanged: true, sdNew: '21', sdRetrieved: '野3', batteryPct: 75,
  configChanged: true, config: { ...cfg, mount: '綁帶', ironCase: false }, fill: { stationId: 'S-NEW', cameraModel: 'Meidase P60' },
  locationChanged: false, note: '', customFields: {} } });
const r7b = sheet('設備').find(r => r[0] === 'CA007');
const f7 = sheet('巡檢紀錄').find(r => r[0] === 'REC-F');
check('record with old-style device id lands on the right camera; SD 21 → SD021, retrieved 野3 → SD003',
  f7[3] === 'CA007' && f7[7] === 'SD021' && f7[8] === 'SD003' && r7b[15] === '2026-11-21 08:00' && r7b[5] === 'SD021', JSON.stringify(f7));
check('fill: blank-asked station/model written to the device; config answers saved',
  r7b[25] === 'S-NEW' && r7b[20] === 'Meidase P60' && r7b[30] === '綁帶' && r7b[27] === false && f7[26] === 'S-NEW', JSON.stringify(r7b));

// ── 更換相機（原因＋樣點編號寫進紀錄；新相機沿用樣點）
const rec = { recordId: 'REC-1', patrolAt: '2026-11-20 08:00', projectId: 'P1', deviceId: 'CAM-1', stationId: 'S-01',
  inspector: '王小明', running: false, cameraSwapped: true, newDeviceId: 'CAM-9', newCameraModel: 'Browning Spec Ops Elite HP5 Ultra',
  swapReason: '進水故障', sdChanged: true, sdNew: 'Wv7', sdRetrieved: '野12', batteryChanged: false, batteryPct: 100,
  configChanged: true, config: { ...cfg, photoQuality: '46MP' }, locationChanged: false, lng: null, lat: null, note: '舊機故障', customFields: {} };
check('swap record ok', post({ action: 'addRecord', payload: rec, photos: [] }).ok);
const recRow = sheet('巡檢紀錄').find(r => r[0] === 'REC-1');
check('record row: swap cols + 更換原因 + 樣點編號',
  recRow[22] === true && recRow[23] === 'CAM-9' && recRow[25] === '進水故障' && recRow[26] === 'S-01', JSON.stringify(recRow.slice(20)));
const oldRow = sheet('設備').find(r => r[0] === 'CAM-1');
const newRow = sheet('設備').find(r => r[0] === 'CAM-9');
check('old camera 已撤下', oldRow[19] === '已撤下');
check('new camera keeps 樣點編號 + new SD', newRow && newRow[25] === 'S-01' && newRow[5] === 'SD007' && newRow[21] === '46MP', JSON.stringify(newRow));
check('bootstrap: new device carries stationId', boot().devices.find(d => d.id === 'CAM-9').stationId === 'S-01');
check('prevSdCard: swap with SD change → new camera\'s previous card is the retrieved one',
  boot().devices.find(d => d.id === 'CAM-9').prevSdCard === 'SD012' && boot().devices.find(d => d.id === 'CAM-1').prevSdCard === 'SD012');

// ── 上次照片：bootstrap 給最新一張的檔案 id，photo 只給照片索引裡有的檔案
post({ action: 'addRecord', photos: [{ name: 'a.jpg', dataBase64: Buffer.from('first').toString('base64') }],
  payload: { ...rec, recordId: 'REC-P1', deviceId: 'CAM-9', cameraSwapped: false, newDeviceId: '', newCameraModel: '',
    swapReason: '', configChanged: false, config: null, patrolAt: '2026-11-25 08:00' } });
post({ action: 'addRecord', photos: [{ name: 'b.jpg', dataBase64: Buffer.from('second').toString('base64') }],
  payload: { ...rec, recordId: 'REC-P2', deviceId: 'CAM-9', cameraSwapped: false, newDeviceId: '', newCameraModel: '',
    swapReason: '', configChanged: false, config: null, patrolAt: '2026-11-26 08:00', note: '第二次' } });
const cam9 = boot().devices.find(d => d.id === 'CAM-9');
check('bootstrap lastPhotoId = newest photo', cam9.lastPhotoId === `FILE${fileSeq}`, cam9.lastPhotoId);
let ph = doGet({ parameter: { token: 'T0K', action: 'photo', id: cam9.lastPhotoId } }).body;
check('photo returns base64 of the file', ph.ok && Buffer.from(ph.data, 'base64').toString() === 'second' && ph.mime === 'image/jpeg', JSON.stringify(ph));
files.SECRET = { bytes: Buffer.from('not a photo'), type: 'text/plain' };
ph = doGet({ parameter: { token: 'T0K', action: 'photo', id: 'SECRET' } }).body;
check('photo refuses files not in 照片索引', ph.ok === false);
check('photo needs token', doGet({ parameter: { token: 'bad', action: 'photo', id: cam9.lastPhotoId } }).body.ok === false);

// ── 修改已上傳的紀錄：覆蓋紀錄列、照片張數累加；是最新一筆才覆蓋設備現況
const recCount = sheet('巡檢紀錄').length;
const upd = { ...rec, recordId: 'REC-P2', deviceId: 'CAM-9', cameraSwapped: false, newDeviceId: '', newCameraModel: '', swapReason: '',
  configChanged: false, config: null, patrolAt: '2026-11-26 08:00', note: '改過了', batteryPct: 25,
  deviceState: { sdCard: 'Wv7', batteryType: '鋰電', batteryPct: 25, config: { ...cfg, photoQuality: '46MP' }, lng: 121.1, lat: 23.5,
    lastInspector: '王小明', running: true, lastNote: '改過了', lastPatrolAt: '2026-11-26 08:00' } };
check('updateRecord ok', post({ action: 'updateRecord', payload: upd, photos: [{ name: 'c.jpg', dataBase64: 'AA==' }] }).updated === true);
const updRow = sheet('巡檢紀錄').find(r => r[0] === 'REC-P2');
check('record overwritten in place (no new row), photo count accumulated',
  sheet('巡檢紀錄').length === recCount && updRow[19] === '改過了' && updRow[11] === 25 && updRow[17] === 2, JSON.stringify(updRow));
const cam9Row = sheet('設備').find(r => r[0] === 'CAM-9');
check('device state overwritten (latest record)', cam9Row[18] === '改過了' && cam9Row[7] === 25 && cam9Row[19] === '電量低', JSON.stringify(cam9Row));
post({ action: 'updateRecord', photos: [], payload: { ...upd, recordId: 'REC-P1', patrolAt: '2026-11-25 08:00', note: '改舊的',
  deviceState: { ...upd.deviceState, lastNote: '不該寫進設備' } } });
check('older record update leaves device alone', sheet('設備').find(r => r[0] === 'CAM-9')[18] === '改過了'
  && sheet('巡檢紀錄').find(r => r[0] === 'REC-P1')[19] === '改舊的');
post({ action: 'updateRecord', photos: [], payload: { ...upd, recordId: 'REC-GONE', note: '雲端沒有' } });
check('update of missing record falls back to add', sheet('巡檢紀錄').some(r => r[0] === 'REC-GONE'));

// ── 上次換電池：最近一次勾「更換電池」的巡檢；換機的新相機沿用舊相機的；晚上傳的舊紀錄不蓋掉新的
const cam9Battery = () => boot().devices.find(d => d.id === 'CAM-9').batteryChangedAt;
check('swapped-in camera inherits old camera\'s battery time (install time)', cam9Battery() === '2026-10-25 10:00', cam9Battery());
const batRec = (recordId, patrolAt) => post({ action: 'addRecord', photos: [], payload: { ...rec, recordId, deviceId: 'CAM-9',
  cameraSwapped: false, newDeviceId: '', newCameraModel: '', swapReason: '', sdChanged: false, configChanged: false, config: null,
  batteryChanged: true, batteryTypeNew: '鋰電', patrolAt } });
batRec('REC-B1', '2026-11-28 08:00');
batRec('REC-B0', '2026-11-27 08:00'); // 離線較久、較晚才上傳
check('battery time = newest battery change by patrol time', cam9Battery() === '2026-11-28 08:00', cam9Battery());

// ── 中間有停：寫進巡檢紀錄最後三欄
post({ action: 'addRecord', photos: [], payload: { ...rec, recordId: 'REC-S', deviceId: 'CAM-9', cameraSwapped: false, newDeviceId: '',
  newCameraModel: '', swapReason: '', configChanged: false, config: null, patrolAt: '2026-11-29 08:00',
  stoppedMidway: true, stoppedAt: '2026-11-20 14:30', stopReason: '沒電' } });
const sRow = sheet('巡檢紀錄').find(r => r[0] === 'REC-S');
check('record row: 中間有停/停止時間/停止原因', sRow[27] === true && sRow[28] === '2026-11-20 14:30' && sRow[29] === '沒電', JSON.stringify(sRow.slice(26)));
check('records without stop: 中間有停 FALSE, blanks', sheet('巡檢紀錄').find(r => r[0] === 'REC-B1').slice(27).join('|') === 'false||');

// ── bootstrap 帶全部巡檢紀錄（履歷與統計用），依巡檢時間排序
const bRecs = boot().records;
const times = bRecs.map(r => r.patrolAt);
check('bootstrap records: all rows, sorted by patrol time',
  bRecs.length === sheet('巡檢紀錄').length - 1 && times.every((t, i) => i === 0 || times[i - 1] <= t), JSON.stringify(times));
const bSwap = bRecs.find(r => r.recordId === 'REC-1');
check('bootstrap record: swap fields, down camera, SD in/out, booleans',
  bSwap.cameraSwapped === true && bSwap.newDeviceId === 'CAM-9' && bSwap.swapReason === '進水故障' && bSwap.running === false
  && bSwap.sdChanged === true && bSwap.sdNew === 'SD007' && bSwap.sdRetrieved === 'SD012' && bSwap.batteryChanged === false
  && bSwap.configChanged === true && bSwap.locationChanged === false && bSwap.stationId === 'S-01' && bSwap.inspector === '王小明'
  && bSwap.projectId === 'P1' && bSwap.note === '舊機故障', JSON.stringify(bSwap));
const bStop = bRecs.find(r => r.recordId === 'REC-S');
check('bootstrap record: 中間有停 + battery pct number',
  bStop.stoppedMidway === true && bStop.stoppedAt === '2026-11-20 14:30' && bStop.stopReason === '沒電' && bStop.batteryPct === 100
  && bRecs.find(r => r.recordId === 'REC-B1').stoppedMidway === false && bRecs.find(r => r.recordId === 'REC-B1').batteryTypeNew === '鋰電',
  JSON.stringify(bStop));
// 試算表把日期字串轉成日期格時，讀回來要是同一個格式（停止時間只填日期也一樣）
// Date 要在 vm 裡建立，code.gs 的 instanceof Date 才認得
ss.getSheetByName('巡檢紀錄')._data.find(r => r[0] === 'REC-S')[28] = vm.runInContext("new Date('2026-11-20T00:00:00Z')", ctx);
check('bootstrap record: date cells formatted like strings', boot().records.find(r => r.recordId === 'REC-S').stoppedAt === '2026-11-20 00:00');
ss.getSheetByName('巡檢紀錄')._data.find(r => r[0] === 'REC-S')[28] = '2026-11-20 14:30';

// ── deleteDevices：刪設備列、巡檢紀錄、照片索引、照片資料夾；白名單不受影響
addDev('132', 'S-02');
addDev('CA-78', 'S-03');
post({ action: 'addRecord', photos: [{ name: 'p.jpg', dataBase64: 'AA==' }], payload: { ...rec, recordId: 'REC-2', deviceId: '132', stationId: 'S-02',
  cameraSwapped: false, newDeviceId: '', newCameraModel: '', swapReason: '', configChanged: false, config: null, patrolAt: '2026-11-21 08:00' } });
const has = (name, col, id) => sheet(name).some(r => r[col] === id);
check('test data present (stored as CA132 / CA078)',
  has('設備', 0, 'CA132') && has('設備', 0, 'CA078') && has('巡檢紀錄', 3, 'CA132') && has('照片索引', 2, 'CA132'));
const before = { devices: sheet('設備').length, records: sheet('巡檢紀錄').length, photos: sheet('照片索引').length };
logs.length = 0;
deleteDevices(); // IDS 寫的是舊寫法 132、Ca-78
check('deleteDevices accepts old-style ids: CA132/CA078 deleted',
  !has('設備', 0, 'CA132') && !has('設備', 0, 'CA078') && sheet('設備').length === before.devices - 2);
check('巡檢紀錄 for CA132 deleted, others kept',
  !has('巡檢紀錄', 3, 'CA132') && sheet('巡檢紀錄').length === before.records - 1 && has('巡檢紀錄', 0, 'REC-1'));
check('照片索引 for CA132 deleted, others kept', !has('照片索引', 2, 'CA132') && sheet('照片索引').length === before.photos - 1);
check('photo folder of CA132 trashed', trashed.some(n => n.endsWith('/CA132')), JSON.stringify(trashed));
check('log reports nothing missing', !logs.some(l => String(l).includes('找不到')), JSON.stringify(logs));

clearAllData();
check('clearAllData keeps 白名單', sheet('白名單').length === 2 && sheet('設備').length === 1);

// ── 改編號（v0.5 換版後自動跑一次）：用一份 v0.4 的試算表
const oldRow31 = (id, sd, station) => {
  const r = Array(31).fill('');
  Object.assign(r, { 0: id, 1: 'P1', 2: id, 3: 121, 4: 23.5, 5: sd, 6: '鋰電', 7: 75, 14: '2026-10-01 10:00', 15: '2026-10-01 10:00',
    17: true, 19: '正常', 20: 'Meidase P70', 25: station });
  return r;
};
// 使用者實際的狀況：v0.5 已用舊規則跑過一次（IDS_FIXED 有值），換 v0.6 要依新規則再整理
ss = makeSS(); props.SS_ID = 'SS1'; props.SHEETS_VERSION = 'v0.5'; props.IDS_FIXED = '2026-11-21 11:30'; delete props.IDS_FIX_VERSION;
Object.keys(HEADERS).forEach(n => ss.insertSheet(n).appendRow(HEADERS[n]));
[[132, '野8', 'S-01'], ['Ca-78', 'Wv12', 'S-02'], ['12', 'sd 3', 'S-03'], ['CA012', '野08', 'S-04'], ['ABC', 'X-9', 'S-05'],
  [96, 'SD020', 'S-06'], ['10N', 'SD021', 'S-07'], ['CA24N', 'SD022', 'S-08'], ['CA24', 'SD023', 'S-09']]
  .forEach(([id, sd, st]) => ss.getSheetByName('設備').appendRow(oldRow31(id, sd, st)));
const oldRec = Array(30).fill('');
Object.assign(oldRec, { 0: 'REC-O', 1: '2026-10-05 10:00', 2: 'P1', 3: 132, 4: '王小明', 5: false, 6: true, 7: '野8', 8: 'Wv12',
  22: true, 23: 'Ca-78' });
ss.getSheetByName('巡檢紀錄').appendRow(oldRec);
// 同一台在巡檢紀錄寫成 CA96（設備分頁是 96）
ss.getSheetByName('巡檢紀錄').appendRow(Object.assign(Array(30).fill(''), { 0: 'REC-96', 1: '2026-10-06 10:00', 2: 'P1', 3: 'CA96', 4: '王小明', 5: true }));
ss.getSheetByName('照片索引').appendRow(['PH1', 'REC-O', 132, '2026-10-05 10:00', 'https://drive.google.com/file/d/X/view', 'a.jpg']);
const proj = root.createFolder('玉山舊');
proj.createFolder('132');
proj.createFolder('12');
const copiesBefore = copies.length;
const fixed = boot();
const dev = id => sheet('設備').find(r => r[0] === id);
check('fixIds: camera ids → CA + 3 digits (number cell 132 too), QR follows',
  !!dev('CA132') && !!dev('CA078') && dev('CA132')[2] === 'CA132' && dev('CA078')[2] === 'CA078', JSON.stringify(sheet('設備').map(r => r[0])));
check('fixIds: SD 野8 / Wv12 / sd 3 / 野08 → SD008 / SD012 / SD003 / SD008',
  dev('CA132')[5] === 'SD008' && dev('CA078')[5] === 'SD012' && dev('12')[5] === 'SD003' && dev('CA012')[5] === 'SD008', JSON.stringify(sheet('設備').map(r => r[5])));
check('fixIds: 12 and CA012 are two rows in 設備 → both left alone; unreadable ABC / X-9 left alone',
  !!dev('12') && !!dev('CA012') && !!dev('ABC') && dev('ABC')[5] === 'X-9');
check('fixIds: same camera written 96 in 設備 and CA96 in records → merged into CA096',
  !!dev('CA096') && !dev(96) && sheet('巡檢紀錄').find(r => r[0] === 'REC-96')[3] === 'CA096', JSON.stringify(sheet('設備').map(r => r[0])));
check('fixIds: N batch kept and padded (10N → CA010N, CA24N → CA024N), CA24 is a different camera (CA024)',
  !!dev('CA010N') && !!dev('CA024N') && !!dev('CA024') && dev('CA024N')[5] === 'SD022' && dev('CA024')[5] === 'SD023',
  JSON.stringify(sheet('設備').map(r => r[0])));
check('fixIds: v0.5 already ran (old flag) → v0.6 reruns once with the new rules', props.IDS_FIX_VERSION === '2');
const fr = sheet('巡檢紀錄').find(r => r[0] === 'REC-O');
check('fixIds: records (device, new device, new/retrieved card) and photo index follow',
  fr[3] === 'CA132' && fr[23] === 'CA078' && fr[7] === 'SD008' && fr[8] === 'SD012' && sheet('照片索引')[1][2] === 'CA132', JSON.stringify(fr));
check('fixIds: photo folder renamed, colliding one left alone',
  proj.getFoldersByName('CA132').hasNext() && !proj.getFoldersByName('132').hasNext() && proj.getFoldersByName('12').hasNext());
check('fixIds: backup taken before changing, report lists only the real clash (12 / CA012), not 96',
  copies.length === copiesBefore + 1 && copies.at(-1).rows.some(r => r[0] === 132) && props.IDS_FIX_REPORT.includes('撞號')
  && props.IDS_FIX_REPORT.includes('12 / CA012') && !props.IDS_FIX_REPORT.includes('96'), props.IDS_FIX_REPORT);
check('bootstrap after the fix returns the new ids', fixed.devices.some(d => d.id === 'CA132' && d.sdCard === 'SD008')
  && fixed.records[0].deviceId === 'CA132', JSON.stringify(fixed.devices.map(d => d.id)));
boot();
check('runs only once', copies.length === copiesBefore + 1);
const again = fixIds();
check('manual fixIds() rerun changes nothing new', /設備 序號 0 格/.test(again) && /記憶卡 0 格/.test(again), again);

// 網頁 form.js 的 camId / sdId 要和 code.gs 一樣
const formJs = await import(new URL('../public/js/form.js', import.meta.url));
for (const v of ['1', '12', '132', 'ca-78', 'CA1', ' CA 007 ', '0', '1000', 'CAM-1', '', 132, '10N', 'CA24N', 'ca 118 n', 'CA118N', '24NN', 'N']) {
  check(`camId same front/back: ${JSON.stringify(v)} → ${camId_(v)}`, formJs.camId(v) === camId_(v), formJs.camId(v));
}
for (const v of ['野12', 'Wv7', 'sd 3', 'SD012', '08', 'X-9', '', '野0']) {
  check(`sdId same front/back: ${JSON.stringify(v)} → ${sdId_(v)}`, formJs.sdId(v) === sdId_(v), formJs.sdId(v));
}

check('summary unchanged format', configSummary_(cfg) === '照片 · 照片32MP · 連拍3 · 感度中 · 間隔0s · 工作時間全天', configSummary_(cfg));
check('summary: day/night secs + guards',
  configSummary_(vcfg) === '照片+影片 · 照片32MP · 連拍3 · 影片1080p 日30秒/夜15秒 · 感度中 · 間隔0s · 工作時間全天 · 鐵殼✓ 上鎖✗ 遮雨板✓', configSummary_(vcfg));
const sameSec = { ...vcfg, videoSecNight: 30, ironCase: undefined, locked: undefined, rainCover: undefined };
check('summary: same day/night secs → one number, no guards when never set',
  configSummary_(sameSec) === '照片+影片 · 照片32MP · 連拍3 · 影片1080p 30秒 · 感度中 · 間隔0s · 工作時間全天', configSummary_(sameSec));

// 網頁的 configSummary 與 code.gs 的 configSummary_ 要一模一樣（比對卡和試算表「新設定摘要」對得起來）
const front = await import(new URL('../public/js/cam-config.js', import.meta.url));
check('summary: mount at the end', configSummary_({ ...cfg, mount: '角鋼' }) === '照片 · 照片32MP · 連拍3 · 感度中 · 間隔0s · 工作時間全天 · 固定角鋼');
for (const c of [cfg, vcfg, sameSec, { ...vcfg, mode: '影片', videoSecNight: null, ironCase: false }, { ...vcfg, mount: '綁帶' }]) {
  check(`front/back summary identical: ${configSummary_(c)}`, front.configSummary(c) === configSummary_(c), front.configSummary(c));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

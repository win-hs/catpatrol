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
function makeFolder(name) {
  const kids = [];
  const folder = {
    name,
    getId: () => 'F-' + name, getUrl: () => 'https://drive/' + name,
    getFoldersByName: n => {
      const f = kids.filter(k => k.name === n && !k.folder.trashed);
      let i = 0;
      return { hasNext: () => i < f.length, next: () => f[i++].folder };
    },
    createFolder: n => { const f = makeFolder(name + '/' + n); kids.push({ name: n, folder: f }); return f; },
    createFile: blob => {
      const id = 'FILE' + (++fileSeq);
      files[id] = blob;
      return { getUrl: () => `https://drive.google.com/file/d/${id}/view?usp=drivesdk` };
    },
    getFolders: () => ({ hasNext: () => false }), getFiles: () => ({ hasNext: () => false }),
    setTrashed(b) { folder.trashed = b; trashed.push(name); },
  };
  return folder;
}
const root = makeFolder('CATPatrol_照片');
const props = {};
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
    getFileById: id => ({ getBlob: () => ({ getBytes: () => files[id].bytes, getContentType: () => files[id].type }) }),
  },
  Logger: { log: m => logs.push(m) },
};
vm.createContext(ctx);
const src = fs.readFileSync(path.join(here, '../apps-script/code.gs'), 'utf8')
  .replace("const TOKEN = 'CHANGE_ME';", "const TOKEN = 'T0K';");
vm.runInContext(src + '\nglobalThis.__api = { doGet, doPost, setup, clearAllData, deleteDevices, D, HEADERS, configSummary_ };', ctx);
const { doGet, doPost, setup, clearAllData, deleteDevices, D, HEADERS, configSummary_ } = ctx.__api;

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
check('v0.2 sheet auto-upgraded: 設備 30 cols, 巡檢紀錄 30 cols, 白名單 added',
  sheet('設備')[0].length === 30 && sheet('巡檢紀錄')[0][29] === '停止原因' && !!ss.getSheetByName('白名單')
  && ss.getSheetByName('設備').getMaxColumns() >= 30, JSON.stringify(sheet('設備')[0]));
const oldDev = b.devices[0];
check('old device: new config fields empty, night secs null',
  oldDev.config.videoSecNight === null && oldDev.config.ironCase === null && oldDev.batteryChangedAt === '', JSON.stringify(oldDev));
check('existing sheets are not deleted by the upgrade', ss.getSheets().some(s => s.getName() === '工作表1'));
check('upgrade runs once per version', props.SHEETS_VERSION && boot().ok);

// ── setup 建分頁與表頭
ss = null; delete props.SS_ID; delete props.SHEETS_VERSION;
setup();
check('new spreadsheet: default 工作表1 removed', !ss.getSheetByName('工作表1'));
check('設備 header 30 cols ending 夜間影片秒數/鐵殼/上鎖/遮雨板',
  sheet('設備')[0].length === 30 && sheet('設備')[0][25] === '樣點編號' && sheet('設備')[0].slice(26).join('|') === '夜間影片秒數|鐵殼|上鎖|遮雨板');
check('巡檢紀錄 header 30 cols ending 中間有停/停止時間/停止原因',
  sheet('巡檢紀錄')[0].length === 30 && sheet('巡檢紀錄')[0][26] === '樣點編號' && sheet('巡檢紀錄')[0].slice(27).join('|') === '中間有停|停止時間|停止原因');
check('白名單 sheet created', sheet('白名單')[0].join('|') === 'email|姓名|加入日期|備註');
check('D indices match header names',
  HEADERS['設備'][D.stationId] === '樣點編號' && HEADERS['設備'][D.cameraModel] === '相機型號' && HEADERS['設備'][D.status] === '狀態'
  && HEADERS['設備'][D.videoSecNight] === '夜間影片秒數' && HEADERS['設備'][D.ironCase] === '鐵殼'
  && HEADERS['設備'][D.locked] === '上鎖' && HEADERS['設備'][D.rainCover] === '遮雨板');

// ── 白名單姓名（email 不分大小寫）
ss.getSheetByName('白名單').appendRow(['Field@X.org', '王小明', '2026-10-31', '']);
check('me.name from 白名單, case-insensitive', boot('field@x.org').me.name === '王小明');
check('bootstrap reports backend version', /^v\d+\.\d+$/.test(boot().version), boot().version);
check('unknown email: name blank', boot('nobody@x.org').me.name === '');

check('wrong token rejected', post({ action: 'addProject', payload: { id: 'P1', name: 'x' } }, { token: 'bad' }).error === 'token 不正確');
check('addProject ok', post({ action: 'addProject', payload: { id: 'P1', name: '玉山', createdAt: '2026-10-25 10:00' } }).ok);

const cfg = { mode: '照片', photoQuality: '32MP', burst: 3, videoQuality: '', videoSec: null, sensitivity: '中', interval: 0, workHours: '全天', note: '' };
const addDev = (id, stationId) => post({ action: 'addDevice', photos: [], payload: {
  id, projectId: 'P1', stationId, qrCode: id, cameraModel: 'Meidase P70', lng: 121.1, lat: 23.5, sdCard: '野12',
  batteryType: '鋰電', batteryPct: 100, config: cfg, createdBy: '王小明', createdAt: '2026-10-25 10:00',
  lastPatrolAt: '2026-10-25 10:00', lastInspector: '王小明', running: true } });
check('addDevice ok', addDev('CAM-1', 'S-01').ok);
const devRow = sheet('設備')[1];
check('device row: 樣點編號 col 26, SD with prefix', devRow[25] === 'S-01' && devRow[5] === '野12', JSON.stringify(devRow));
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

// ── 更換相機（原因＋樣點編號寫進紀錄；新相機沿用樣點）
const rec = { recordId: 'REC-1', patrolAt: '2026-11-20 08:00', projectId: 'P1', deviceId: 'CAM-1', stationId: 'S-01',
  inspector: '王小明', running: false, cameraSwapped: true, newDeviceId: 'CAM-9', newCameraModel: 'Browning Spec Ops Elite HP5 Ultra',
  swapReason: '進水故障', sdChanged: true, sdNew: 'Wv7', sdRetrieved: '野12', batteryChanged: false, batteryPct: 100,
  configChanged: true, config: { ...cfg, photoQuality: '46MP' }, locationChanged: false, lng: null, lat: null, note: '舊機故障', customFields: {} };
check('swap record ok', post({ action: 'addRecord', payload: rec, photos: [] }).ok);
const recRow = sheet('巡檢紀錄')[1];
check('record row: swap cols + 更換原因 + 樣點編號',
  recRow[22] === true && recRow[23] === 'CAM-9' && recRow[25] === '進水故障' && recRow[26] === 'S-01', JSON.stringify(recRow.slice(20)));
const oldRow = sheet('設備').find(r => r[0] === 'CAM-1');
const newRow = sheet('設備').find(r => r[0] === 'CAM-9');
check('old camera 已撤下', oldRow[19] === '已撤下');
check('new camera keeps 樣點編號 + new SD', newRow && newRow[25] === 'S-01' && newRow[5] === 'Wv7' && newRow[21] === '46MP', JSON.stringify(newRow));
check('bootstrap: new device carries stationId', boot().devices.find(d => d.id === 'CAM-9').stationId === 'S-01');
check('prevSdCard: swap with SD change → new camera\'s previous card is the retrieved one',
  boot().devices.find(d => d.id === 'CAM-9').prevSdCard === '野12' && boot().devices.find(d => d.id === 'CAM-1').prevSdCard === '野12');

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

// ── deleteDevices：刪設備列、巡檢紀錄、照片索引、照片資料夾；白名單不受影響
addDev('132', 'S-02');
addDev('CA-78', 'S-03');
post({ action: 'addRecord', photos: [{ name: 'p.jpg', dataBase64: 'AA==' }], payload: { ...rec, recordId: 'REC-2', deviceId: '132', stationId: 'S-02',
  cameraSwapped: false, newDeviceId: '', newCameraModel: '', swapReason: '', configChanged: false, config: null, patrolAt: '2026-11-21 08:00' } });
const has = (name, col, id) => sheet(name).some(r => r[col] === id);
check('test data present', has('設備', 0, '132') && has('設備', 0, 'CA-78') && has('巡檢紀錄', 3, '132') && has('照片索引', 2, '132'));
const before = { devices: sheet('設備').length, records: sheet('巡檢紀錄').length, photos: sheet('照片索引').length };
logs.length = 0;
deleteDevices();
check('設備 rows 132/CA-78 deleted (case-insensitive Ca-78)',
  !has('設備', 0, '132') && !has('設備', 0, 'CA-78') && sheet('設備').length === before.devices - 2);
check('巡檢紀錄 for 132 deleted, others kept',
  !has('巡檢紀錄', 3, '132') && sheet('巡檢紀錄').length === before.records - 1 && has('巡檢紀錄', 0, 'REC-1'));
check('照片索引 for 132 deleted, others kept', !has('照片索引', 2, '132') && sheet('照片索引').length === before.photos - 1);
check('photo folder of 132 trashed', trashed.some(n => n.endsWith('/132')), JSON.stringify(trashed));
check('log reports nothing missing', !logs.some(l => String(l).includes('找不到')), JSON.stringify(logs));

clearAllData();
check('clearAllData keeps 白名單', sheet('白名單').length === 2 && sheet('設備').length === 1);

check('summary unchanged format', configSummary_(cfg) === '照片 · 照片32MP · 連拍3 · 感度中 · 間隔0s · 工作時間全天', configSummary_(cfg));
check('summary: day/night secs + guards',
  configSummary_(vcfg) === '照片+影片 · 照片32MP · 連拍3 · 影片1080p 日30秒/夜15秒 · 感度中 · 間隔0s · 工作時間全天 · 鐵殼✓ 上鎖✗ 遮雨板✓', configSummary_(vcfg));
const sameSec = { ...vcfg, videoSecNight: 30, ironCase: undefined, locked: undefined, rainCover: undefined };
check('summary: same day/night secs → one number, no guards when never set',
  configSummary_(sameSec) === '照片+影片 · 照片32MP · 連拍3 · 影片1080p 30秒 · 感度中 · 間隔0s · 工作時間全天', configSummary_(sameSec));

// 網頁的 configSummary 與 code.gs 的 configSummary_ 要一模一樣（比對卡和試算表「新設定摘要」對得起來）
const front = await import(new URL('../public/js/cam-config.js', import.meta.url));
for (const c of [cfg, vcfg, sameSec, { ...vcfg, mode: '影片', videoSecNight: null, ironCase: false }]) {
  check(`front/back summary identical: ${configSummary_(c)}`, front.configSummary(c) === configSummary_(c), front.configSummary(c));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

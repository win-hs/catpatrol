// code.gs 測試：用記憶體模擬 SpreadsheetApp / DriveApp 等服務，實際跑 doGet / doPost / 編輯器函式。
// 執行：node tests/codegs.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeSheet(name) {
  const data = [];
  const sheet = {
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map(r => r.length)),
    setFrozenRows() {},
    appendRow(arr) { data.push(arr.map(v => (v === undefined || v === null ? '' : v))); },
    deleteRow(i) { data.splice(i - 1, 1); },
    deleteRows(i, n) { data.splice(i - 1, n); },
    getRange(row, col, nr = 1, nc = 1) {
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
    createFile: blob => ({ getUrl: () => 'https://drive/' + name + '/' + blob.name }),
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
    newBlob: (bytes, type, name) => ({ name }),
  },
  Session: { getScriptTimeZone: () => 'Asia/Taipei' },
  DriveApp: { getFolderById: () => root, getFoldersByName: () => ({ hasNext: () => true, next: () => root }), createFolder: () => root },
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

// ── 舊試算表還沒重跑 setup 時（沒有白名單分頁）bootstrap 不能壞
ss = makeSS(); props.SS_ID = 'SS1';
['專案', '設備', '巡檢紀錄', '自訂欄位定義', '照片索引'].forEach(n => ss.insertSheet(n));
let b = boot();
check('no 白名單 sheet yet: bootstrap ok, name blank', b.ok && b.me.email === 'field@x.org' && b.me.name === '', JSON.stringify(b));

// ── setup 建分頁與表頭
ss = null; delete props.SS_ID;
setup();
check('設備 header 26 cols ending 樣點編號', sheet('設備')[0].length === 26 && sheet('設備')[0][25] === '樣點編號');
check('巡檢紀錄 header 27 cols ending 更換原因/樣點編號',
  sheet('巡檢紀錄')[0].length === 27 && sheet('巡檢紀錄')[0][25] === '更換原因' && sheet('巡檢紀錄')[0][26] === '樣點編號');
check('白名單 sheet created', sheet('白名單')[0].join('|') === 'email|姓名|加入日期|備註');
check('D indices match header names',
  HEADERS['設備'][D.stationId] === '樣點編號' && HEADERS['設備'][D.cameraModel] === '相機型號' && HEADERS['設備'][D.status] === '狀態');

// ── 白名單姓名（email 不分大小寫）
ss.getSheetByName('白名單').appendRow(['Field@X.org', '王小明', '2026-10-31', '']);
check('me.name from 白名單, case-insensitive', boot('field@x.org').me.name === '王小明');
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

// ── deleteDevices：刪設備列、巡檢紀錄、照片索引、照片資料夾；白名單不受影響
addDev('132', 'S-02');
addDev('CA-78', 'S-03');
post({ action: 'addRecord', photos: [{ name: 'p.jpg', dataBase64: 'AA==' }], payload: { ...rec, recordId: 'REC-2', deviceId: '132', stationId: 'S-02',
  cameraSwapped: false, newDeviceId: '', newCameraModel: '', swapReason: '', configChanged: false, config: null, patrolAt: '2026-11-21 08:00' } });
check('test data present', sheet('設備').length === 5 && sheet('巡檢紀錄').length === 3 && sheet('照片索引').length === 2);
logs.length = 0;
deleteDevices();
check('設備 rows 132/CA-78 deleted (case-insensitive Ca-78)', !sheet('設備').some(r => ['132', 'CA-78'].includes(r[0])) && sheet('設備').length === 3);
check('巡檢紀錄 for 132 deleted, others kept', sheet('巡檢紀錄').length === 2 && sheet('巡檢紀錄')[1][3] === 'CAM-1');
check('照片索引 for 132 deleted', sheet('照片索引').length === 1);
check('photo folder of 132 trashed', trashed.some(n => n.endsWith('/132')), JSON.stringify(trashed));
check('log reports nothing missing', !logs.some(l => String(l).includes('找不到')), JSON.stringify(logs));

clearAllData();
check('clearAllData keeps 白名單', sheet('白名單').length === 2 && sheet('設備').length === 1);

check('summary unchanged format', configSummary_(cfg) === '照片 · 照片32MP · 連拍3 · 感度中 · 間隔0s · 工作時間全天', configSummary_(cfg));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import { markError } from './form.js';

/**
 * 相機型號與各自的設定選項（2026-10 查證）：
 * - Meidase P70：官方說明書
 * - Meidase P60：零售頁只查到最高 32MP、影片 1296p/1080p（其他照片檔位與影片秒數範圍查不到，用「其他」自填）
 * - Meidase P60 Pro：零售頁（影片秒數範圍查不到）
 * - Browning Spec Ops Elite HP5 Ultra：官網與評測（照片只查到最高 46MP、最低 4MP，中間檔位用「其他」自填）
 * - Browning Spec Ops Elite HP5（BTC-8E-HP5）：官方說明書 p.7–9、p.23（2026-11-21 讀）——照片 4/8/12/24MP；
 *   影片都是 1920×1080，HIGH 30fps、ULTRA 60fps；長度 5、10、20、30 秒、1、2 分；夜間影片最長 20 秒；
 *   連拍 1–8 張；只有拍照、影片、縮時三種模式（沒有照片＋影片）
 * - Ereagle E1S（ERE-E1S）：官方說明書 ED-E1S-TM-01 V112 p.12、p.19–20、p.31——照片 12M（插補）/8M/5M/3M/2M/1M；
 *   影片 1080P 30fps、720P 60fps、720P 30fps、480P；長度 1–120 秒；連拍 1–5 張；有 Camera+Video（先拍照再錄影）
 *
 * videoSecNight：夜間影片秒數另有上限時才寫；modes：只有部分拍攝模式時才寫（沒寫＝三種都有）
 */
export const CAMERA_MODELS = {
  'Meidase P70': {
    photo: ['64MP', '32MP', '24MP', '16MP', '8MP', '4MP'],
    video: ['1296p', '1080p', '720p'],
    videoSec: [3, 300],
  },
  'Meidase P60': {
    photo: ['32MP'],
    video: ['1296p', '1080p'],
    videoSec: null,
  },
  'Meidase P60 Pro': {
    photo: ['48MP', '24MP', '16MP', '8MP', '4MP'],
    video: ['1440p', '1080p'],
    videoSec: null,
  },
  'Browning Spec Ops Elite HP5': {
    photo: ['24MP', '12MP', '8MP', '4MP'],
    video: ['1080p 60fps', '1080p 30fps'],
    videoSec: [5, 120],
    videoSecNight: [5, 20],
    modes: ['照片', '影片'],
  },
  'Browning Spec Ops Elite HP5 Ultra': {
    photo: ['46MP', '4MP'],
    video: ['1440p', '1080p'],
    videoSec: [5, 120],
  },
  'Ereagle E1S': {
    photo: ['12MP', '8MP', '5MP', '3MP', '2MP', '1MP'],
    video: ['1080p', '720p 60fps', '720p 30fps', '480p'],
    videoSec: [1, 120],
  },
};

export const MODEL_OPTIONS = '<option value="">請選擇…</option>'
  + Object.keys(CAMERA_MODELS).map(m => `<option>${m}</option>`).join('');

const OTHER = '__other';
const NO_SPEC = { photo: [], video: [], videoSec: null };

/** 現場防護：設定裡的欄位名稱與顯示文字 */
export const GUARDS = [['ironCase', 'iron', '鐵殼'], ['locked', 'lock', '上鎖'], ['rainCover', 'rain', '遮雨板']];
/** 固定方式（單選；沒選＝沒填過） */
export const MOUNTS = ['角鋼', '綁帶'];

const isVideo = mode => mode === '影片' || mode === '照片+影片';

/**
 * 之後才加的欄位，舊設備沒填過的：巡檢時要補問（之後新增欄位也加在這裡，就會自動被問）。
 * 回傳這台還沒填的欄位名稱，順序就是畫面上問的順序
 */
export function missingFields(d) {
  const cfg = d.config || {};
  const out = [];
  if (!String(d.stationId ?? '').trim()) out.push('stationId');
  if (!d.cameraModel) out.push('cameraModel');
  if (isVideo(cfg.mode) && cfg.videoSecNight == null) out.push('videoSecNight');
  GUARDS.forEach(([key]) => { if (cfg[key] == null) out.push(key); });
  if (!cfg.mount) out.push('mount');
  return out;
}

/** 設定摘要：上次巡檢比對卡用（後端 configSummary_ 寫進試算表的格式相同） */
export function configSummary(cfg = {}) {
  const parts = [cfg.mode || '—'];
  if (cfg.mode !== '影片') parts.push(`照片${cfg.photoQuality || '—'}`, `連拍${cfg.burst ?? '—'}`);
  if (cfg.mode === '影片' || cfg.mode === '照片+影片') {
    // 日夜秒數一樣（或舊資料沒有夜間）只寫一個
    const sec = cfg.videoSecNight != null && cfg.videoSecNight !== cfg.videoSec
      ? `日${cfg.videoSec ?? '—'}秒/夜${cfg.videoSecNight}秒`
      : `${cfg.videoSec ?? '—'}秒`;
    parts.push(`影片${cfg.videoQuality || '—'} ${sec}`);
  }
  parts.push(`靈敏度${cfg.sensitivity || '—'}`, `間隔${cfg.interval ?? '—'}秒`, `工作時間${cfg.workHours || '全天'}`);
  // 舊資料三項都沒填過就不顯示
  if (GUARDS.some(([key]) => cfg[key] != null)) {
    parts.push(GUARDS.map(([key, , label]) => `${label}${cfg[key] ? '✓' : cfg[key] === false ? '✗' : '—'}`).join(' '));
  }
  if (cfg.mount) parts.push(`${cfg.mount}固定`);
  return parts.join(' · ');
}

/**
 * 綁定一組設備設定欄位（新增設備 add-、巡檢 pt-），畫質選項隨相機型號切換，
 * 照片/影片欄位隨拍攝模式顯示。
 */
export function configForm(prefix) {
  const el = name => document.getElementById(`${prefix}-${name}`);
  let model = null; // null＝選單還沒填過，第一次 setModel('') 也要填

  const mode = () => el('mode').querySelector('button.on')?.dataset.value ?? '照片';
  const spec = () => CAMERA_MODELS[model] || NO_SPEC;

  function showMode(m) {
    el('photo-grp').hidden = m === '影片';
    el('video-grp').hidden = m === '照片';
  }

  function fillSelect(name, options, value) {
    const sel = el(name);
    const known = options.includes(value);
    sel.innerHTML = '<option value="">請選擇…</option>'
      + options.map(o => `<option>${o}</option>`).join('')
      + `<option value="${OTHER}">其他（手動輸入）</option>`;
    sel.value = !value ? '' : known ? value : OTHER;
    el(`${name}-other`).value = value && !known ? value : '';
    el(`${name}-other`).hidden = sel.value !== OTHER;
  }

  const selValue = name => (el(name).value === OTHER ? el(`${name}-other`).value.trim() : el(name).value);
  const selTarget = name => (el(name).value === OTHER ? el(`${name}-other`) : el(name));

  /** 秒數範圍：夜間另有上限的型號（例如 HP5 夜間最長 20 秒）用自己的 */
  const secRange = name => (name === 'video-sec-night' && spec().videoSecNight) || spec().videoSec;

  function applySecRange() {
    ['video-sec', 'video-sec-night'].forEach(name => {
      const range = secRange(name);
      el(name).placeholder = range ? `${range[0]}–${range[1]}` : '秒';
    });
  }

  /** 型號沒有的拍攝模式不顯示；正在用的模式被藏起來時改回「照片」 */
  function applyModes() {
    const allowed = spec().modes;
    const buttons = [...el('mode').querySelectorAll('button')];
    buttons.forEach(b => { b.hidden = !!allowed && !allowed.includes(b.dataset.value); });
    if (buttons.some(b => b.hidden && b.classList.contains('on'))) {
      buttons.forEach(b => b.classList.toggle('on', b.dataset.value === '照片'));
      showMode('照片');
    }
  }

  // 拍攝模式按鈕的 on 狀態由 app.js 的共用點擊處理切換；這裡直接看被點的那顆
  el('mode').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) showMode(btn.dataset.value);
  });
  ['photo-q', 'video-q'].forEach(name => el(name).addEventListener('change', () => {
    el(`${name}-other`).hidden = el(name).value !== OTHER;
  }));
  // 固定方式：單選，再點一次取消
  el('mount').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const on = !btn.classList.contains('on');
    el('mount').querySelectorAll('button').forEach(b => b.classList.toggle('on', on && b === btn));
  });
  const mountValue = () => el('mount').querySelector('button.on')?.dataset.value || '';

  /** 換型號：新型號沒有的畫質就清掉讓使用者重選 */
  function setModel(m) {
    if (m === model) return;
    model = m;
    const keep = (name, options) => (options.includes(selValue(name)) ? selValue(name) : '');
    fillSelect('photo-q', spec().photo, keep('photo-q', spec().photo));
    fillSelect('video-q', spec().video, keep('video-q', spec().video));
    applySecRange();
    applyModes();
  }

  /** 帶入既有設定（巡檢時預填上次值） */
  function fill(cfg = {}, m = '') {
    model = m;
    const current = cfg.mode || '照片';
    el('mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === current));
    showMode(current);
    fillSelect('photo-q', spec().photo, cfg.photoQuality || '');
    fillSelect('video-q', spec().video, cfg.videoQuality || '');
    applySecRange();
    applyModes();
    el('burst').value = cfg.burst ?? '';
    el('video-sec').value = cfg.videoSec ?? '';
    el('video-sec-night').value = cfg.videoSecNight ?? cfg.videoSec ?? ''; // 舊資料沒有夜間：先帶日間的
    GUARDS.forEach(([key, id]) => el(id).classList.toggle('on', !!cfg[key]));
    el('mount').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === cfg.mount));
    el('sens').value = cfg.sensitivity || '中';
    el('interval').value = cfg.interval ?? '';
    const hours = cfg.workHours && cfg.workHours !== '全天' ? cfg.workHours.split('-') : null;
    el('hours-on').classList.toggle('on', !!hours);
    el('hours').hidden = !hours;
    el('hours-start').value = hours?.[0] || '';
    el('hours-end').value = hours?.[1] || '';
    el('config-note').value = cfg.note || '';
  }

  function read() {
    const m = mode();
    const photo = m !== '影片';
    const video = m !== '照片';
    return {
      mode: m,
      photoQuality: photo ? selValue('photo-q') : '',
      burst: photo ? Number(el('burst').value) : null,
      videoQuality: video ? selValue('video-q') : '',
      videoSec: video ? Number(el('video-sec').value) : null,
      videoSecNight: video ? Number(el('video-sec-night').value) : null,
      sensitivity: el('sens').value,
      interval: Number(el('interval').value),
      workHours: el('hours-on').classList.contains('on')
        ? `${el('hours-start').value}-${el('hours-end').value}`
        : '全天',
      ...Object.fromEntries(GUARDS.map(([key, id]) => [key, el(id).classList.contains('on')])),
      mount: mountValue(),
      note: el('config-note').value.trim(),
    };
  }

  function validate() {
    let ok = true;
    const need = (cond, target, msg) => { if (!cond) { markError(target, msg); ok = false; } };
    const m = mode();
    if (m !== '影片') need(selValue('photo-q'), selTarget('photo-q'), '請選擇照片畫質');
    if (m !== '照片') {
      need(selValue('video-q'), selTarget('video-q'), '請選擇影片畫質');
      ['video-sec', 'video-sec-night'].forEach(name => {
        const range = secRange(name);
        const sec = Number(el(name).value);
        need(sec > 0 && (!range || (sec >= range[0] && sec <= range[1])), el(name),
          range ? `請填 ${range[0]}–${range[1]} 秒` : '請填寫影片秒數');
      });
    }
    if (el('hours-on').classList.contains('on')) {
      need(el('hours-start').value, el('hours-start'), '請填開始時間');
      need(el('hours-end').value, el('hours-end'), '請填結束時間');
    }
    // 新設備一定要選；巡檢改設定時，舊設備沒填過的由「這台還沒填過」那一格問
    if (prefix === 'add') need(mountValue(), el('mount'), '請選擇固定方式');
    return ok;
  }

  return { setModel, fill, read, validate };
}

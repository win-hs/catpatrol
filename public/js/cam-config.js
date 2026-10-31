import { markError } from './form.js';

/**
 * 相機型號與各自的設定選項（2026-10 查證）：
 * - Meidase P70：官方說明書
 * - Meidase P60：零售頁只查到最高 32MP、影片 1296p/1080p（其他照片檔位與影片秒數範圍查不到，用「其他」自填）
 * - Meidase P60 Pro：零售頁（影片秒數範圍查不到）
 * - Browning Spec Ops Elite HP5 Ultra：官網與評測（照片只查到最高 46MP、最低 4MP，中間檔位用「其他」自填）
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
  'Browning Spec Ops Elite HP5 Ultra': {
    photo: ['46MP', '4MP'],
    video: ['1440p', '1080p'],
    videoSec: [5, 120],
  },
};

export const MODEL_OPTIONS = '<option value="">請選擇…</option>'
  + Object.keys(CAMERA_MODELS).map(m => `<option>${m}</option>`).join('');

const OTHER = '__other';
const NO_SPEC = { photo: [], video: [], videoSec: null };

/** 設定摘要：上次巡檢比對卡用（後端 configSummary_ 寫進試算表的格式相同） */
export function configSummary(cfg = {}) {
  const parts = [cfg.mode || '—'];
  if (cfg.mode !== '影片') parts.push(`照片${cfg.photoQuality || '—'}`, `連拍${cfg.burst ?? '—'}`);
  if (cfg.mode === '影片' || cfg.mode === '照片+影片') parts.push(`影片${cfg.videoQuality || '—'} ${cfg.videoSec ?? '—'}秒`);
  parts.push(`感度${cfg.sensitivity || '—'}`, `間隔${cfg.interval ?? '—'}s`, `工作時間${cfg.workHours || '全天'}`);
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

  function applySecRange() {
    const range = spec().videoSec;
    el('video-sec').placeholder = range ? `${range[0]}–${range[1]}` : '秒';
  }

  // 拍攝模式按鈕的 on 狀態由 app.js 的共用點擊處理切換；這裡直接看被點的那顆
  el('mode').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) showMode(btn.dataset.value);
  });
  ['photo-q', 'video-q'].forEach(name => el(name).addEventListener('change', () => {
    el(`${name}-other`).hidden = el(name).value !== OTHER;
  }));

  /** 換型號：新型號沒有的畫質就清掉讓使用者重選 */
  function setModel(m) {
    if (m === model) return;
    model = m;
    const keep = (name, options) => (options.includes(selValue(name)) ? selValue(name) : '');
    fillSelect('photo-q', spec().photo, keep('photo-q', spec().photo));
    fillSelect('video-q', spec().video, keep('video-q', spec().video));
    applySecRange();
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
    el('burst').value = cfg.burst ?? '';
    el('video-sec').value = cfg.videoSec ?? '';
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
      sensitivity: el('sens').value,
      interval: Number(el('interval').value),
      workHours: el('hours-on').classList.contains('on')
        ? `${el('hours-start').value}-${el('hours-end').value}`
        : '全天',
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
      const sec = Number(el('video-sec').value);
      const range = spec().videoSec;
      need(sec > 0 && (!range || (sec >= range[0] && sec <= range[1])), el('video-sec'),
        range ? `請填 ${range[0]}–${range[1]} 秒` : '請填寫影片秒數');
    }
    if (el('hours-on').classList.contains('on')) {
      need(el('hours-start').value, el('hours-start'), '請填開始時間');
      need(el('hours-end').value, el('hours-end'), '請填結束時間');
    }
    return ok;
  }

  return { setModel, fill, read, validate };
}

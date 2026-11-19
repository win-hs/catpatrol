import { esc } from './form.js';

// 顏色看「多久沒巡」；電量低不另外上色（清單徽章與點位說明裡看得到）
const STATUS_COLOR = {
  '正常': '#2d6a4f',
  '電量低': '#2d6a4f',
  '逾2個月未巡': '#e9b200',
  '逾3個月未巡': '#e07a00',
  '逾4個月未巡': '#c0392b',
  '相機故障': '#7b2cbf',
};

const NORMAL_STYLE = { radius: 9, color: '#fff', weight: 2 };
const SELECTED_STYLE = { radius: 12, color: '#1d6fa5', weight: 4 };

let map;
let markerLayer;
let meMarker;
let meAccuracy;
let markers = new Map(); // device id → 點位
let callbacks = { onSelect() {}, onPatrol() {} };

const LocateControl = () => {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'locate-btn');
      btn.innerHTML = '📍';
      btn.title = '顯示我的位置';
      btn.type = 'button';
      L.DomEvent.on(btn, 'click', e => {
        L.DomEvent.stop(e);
        locateMe();
      });
      return btn;
    },
  });
  return new Ctl();
};

const FitAllControl = () => {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'locate-btn');
      btn.innerHTML = '⛶';
      btn.title = '顯示全部相機';
      btn.type = 'button';
      L.DomEvent.on(btn, 'click', e => {
        L.DomEvent.stop(e);
        fitAll();
      });
      return btn;
    },
  });
  return new Ctl();
};

function showMe(lat, lng, accuracy) {
  if (meMarker) {
    map.removeLayer(meMarker);
    map.removeLayer(meAccuracy);
  }
  meAccuracy = L.circle([lat, lng], {
    radius: accuracy, color: '#1d6fa5', weight: 1, fillOpacity: 0.12,
  }).addTo(map);
  meMarker = L.circleMarker([lat, lng], {
    radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fa5', fillOpacity: 1,
  }).addTo(map).bindPopup('📍 我的位置').openPopup();
  map.setView([lat, lng], 15);
}

function locateMe() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    p => showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    () => showMe(24.2845, 121.0165, 40),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

export function renderDevices(devices) {
  markerLayer.clearLayers();
  markers = new Map();
  // 座標壞掉（空白或 NaN）的設備不上圖：Leaflet 遇到 NaN 會丟例外，整個首頁跟著打不開
  devices
    .filter(d => Number.isFinite(d.lat) && Number.isFinite(d.lng))
    .forEach(d => {
      const m = L.circleMarker([d.lat, d.lng], {
        ...NORMAL_STYLE, fillColor: STATUS_COLOR[d.status] || '#6b7a70', fillOpacity: 1,
      })
        // 樣點編號常駐顯示在點位旁；有備註時加 📝，點開看內容
        .bindTooltip(esc(d.label) + (d.memo ? ' 📝' : ''), { permanent: true, direction: 'right', offset: [8, 0], className: 'dev-label' })
        .bindPopup(`<div class="dev-popup"><b>${esc(d.label)}</b><br><small>序號 ${esc(d.id)}`
          + `${d.model ? ` · ${esc(d.model)}` : ''}<br>${d.status} · ${esc(d.note)}</small>`
          + (d.memo ? `<div class="dev-memo">📝 ${esc(d.memo)}</div>` : '')
          + `<button type="button" class="popup-patrol" data-patrol="${esc(d.id)}">✅ 巡檢這台</button></div>`)
        .on('click', () => callbacks.onSelect(d.id));
      markers.set(d.id, m);
      markerLayer.addLayer(m);
    });
  fitAll();
}

/** 框到全部相機 */
export function fitAll() {
  if (!markers.size) return;
  // 在別的分頁時視窗大小變過（例如手機鍵盤彈出），Leaflet 記下的地圖尺寸會變 0、框出來的範圍就錯了：先重量再框
  map.invalidateSize({ pan: false });
  map.fitBounds(L.featureGroup([...markers.values()]).getBounds().pad(0.25), { maxZoom: 16 });
}

/**
 * 標出選取的相機（藍框）；pan＝移過去（從清單點的），點位本身被點時不必再移。
 * 從清單選不打開說明框：手機上地圖小，說明框會蓋住相機周圍，內容卡片上也都有
 */
export function selectDevice(id, pan = true) {
  markers.forEach((m, mid) => m.setStyle(mid === id ? SELECTED_STYLE : NORMAL_STYLE));
  const m = markers.get(id);
  if (pan) map.closePopup();
  if (!m) return;
  m.bringToFront();
  if (!pan) return;
  map.invalidateSize({ pan: false });
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
}

export function resizeMap() {
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

/** onSelect(id)：點了地圖上的相機；onPatrol(id)：按了說明框裡的「巡檢這台」 */
export function initMap(cb) {
  callbacks = { ...callbacks, ...cb };
  map = L.map('devmap').setView([23.7, 121.0], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
    // 以 CORS 取得圖磚，Service Worker 才能拿到可快取的回應（預設的 opaque 回應無法快取）
    crossOrigin: 'anonymous',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.addControl(LocateControl());
  map.addControl(FitAllControl());
  // 說明框是字串產生的，按鈕要在打開時才綁得到
  map.on('popupopen', e => {
    const btn = e.popup.getElement().querySelector('[data-patrol]');
    if (btn) btn.onclick = () => callbacks.onPatrol(btn.dataset.patrol);
  });
}

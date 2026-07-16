const STATUS_COLOR = {
  '正常': '#2d6a4f',
  '電量低': '#e07a00',
  '待巡檢': '#e07a00',
  '異常': '#c0392b',
};

let map;
let markerLayer;
let meMarker;
let meAccuracy;

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
  const markers = devices
    .filter(d => d.lat != null && d.lng != null)
    .map(d => L.circleMarker([d.lat, d.lng], {
      radius: 9, color: '#fff', weight: 2,
      fillColor: STATUS_COLOR[d.status] || '#6b7a70', fillOpacity: 1,
    }).bindPopup(`<div class="dev-popup"><b>${d.id}</b><br><small>${d.note} · ${d.status}</small></div>`));

  markers.forEach(m => markerLayer.addLayer(m));
  if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.25));
}

export function resizeMap() {
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

export function initMap() {
  map = L.map('devmap').setView([23.7, 121.0], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.addControl(LocateControl());
}

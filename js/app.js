import { initMap, resizeMap } from './map.js';

const screens = document.querySelector('#screens');

export function go(screenId) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.toggle('active', s.id === screenId);
  });
  document.querySelectorAll('.nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === screenId);
  });
  screens.scrollTop = 0;
  if (screenId === 'scr-home') resizeMap();
}

document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => go(btn.dataset.screen));
});

document.addEventListener('click', e => {
  const goTarget = e.target.closest('[data-go]');
  if (goTarget) {
    go(goTarget.dataset.go);
    return;
  }

  const tgl = e.target.closest('[data-tgl]');
  if (tgl) {
    const on = tgl.classList.toggle('on');
    if (tgl.dataset.reveal) {
      document.querySelector(tgl.dataset.reveal).hidden = !on;
    }
    return;
  }

  const segBtn = e.target.closest('.seg[data-seg] button');
  if (segBtn) {
    segBtn.parentElement.querySelectorAll('button')
      .forEach(b => b.classList.toggle('on', b === segBtn));
    return;
  }

  const scanBtn = e.target.closest('[data-toggle-scan]');
  if (scanBtn) {
    const box = document.querySelector(scanBtn.dataset.toggleScan);
    box.hidden = !box.hidden;
    const { labelOn, labelOff } = scanBtn.dataset;
    if (labelOn && labelOff) scanBtn.textContent = box.hidden ? labelOff : labelOn;
  }
});

initMap();

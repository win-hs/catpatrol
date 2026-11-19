// stats.js 測試：相機履歷、漏拍、續航、工作量、出發準備的計算。
// 執行：node tests/stats.test.mjs
import * as S from '../public/js/stats.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + extra}`);
};
const DAY = 86400000;
const near = (a, b) => Math.abs(a - b) < 1e-6;
const J = x => JSON.stringify(x);

// 巡檢紀錄的預設值（和 App 存的、bootstrap 傳來的欄位一樣）
const rec = (o) => ({
  recordId: o.recordId || `R-${o.deviceId}-${o.patrolAt}`, projectId: 'P1', inspector: '王小明', running: true,
  sdChanged: false, sdNew: '', sdRetrieved: '', batteryChanged: false, batteryTypeNew: '', batteryPct: 75,
  configChanged: false, locationChanged: false, note: '', cameraSwapped: false, newDeviceId: '', newCameraModel: '',
  swapReason: '', stationId: '', stoppedMidway: false, stoppedAt: '', stopReason: '', ...o,
});
const dev = (o) => ({ projectId: 'P1', cameraModel: 'Meidase P70', batteryType: '鋰電', batteryPct: 100, running: true,
  config: { mode: '照片', photoQuality: '16MP', burst: 3 }, retired: false, ...o });

// ── 時間
check('toMs: date only = local midnight', S.toMs('2026-10-05') === new Date(2026, 9, 5).getTime());
check('toMs: date + time local', S.toMs('2026-10-05 14:30') === new Date(2026, 9, 5, 14, 30).getTime());
check('toMs: blank → NaN', Number.isNaN(S.toMs('')));

// ── 履歷：換機前的舊相機算同一個樣點
const hist = [
  rec({ deviceId: 'OLD', patrolAt: '2026-03-01 10:00' }),
  rec({ deviceId: 'OLD', patrolAt: '2026-05-30 10:00', cameraSwapped: true, newDeviceId: 'NEW', running: false }),
  rec({ deviceId: 'NEW', patrolAt: '2026-08-05 10:00' }),
  rec({ deviceId: 'OTHER', patrolAt: '2026-08-06 10:00' }),
];
check('chainIds follows swaps back to the oldest camera', J(S.chainIds('NEW', hist)) === J(['OLD', 'NEW']));
check('chainIds of a camera never swapped', J(S.chainIds('OTHER', hist)) === J(['OTHER']));
check('chainIds survives a swap loop', S.chainIds('A', [rec({ deviceId: 'A', patrolAt: '1', cameraSwapped: true, newDeviceId: 'B' }),
  rec({ deviceId: 'B', patrolAt: '2', cameraSwapped: true, newDeviceId: 'A' })]).length === 2);
const h = S.stationHistory('NEW', hist);
check('stationHistory: old camera included, newest first, other stations excluded',
  J(h.map(r => r.patrolAt)) === J(['2026-08-05 10:00', '2026-05-30 10:00', '2026-03-01 10:00']));
check('chainIds: numeric ids from the sheet match string ids', J(S.chainIds('9', [rec({ deviceId: 8, patrolAt: '1', cameraSwapped: true, newDeviceId: 9 })])) === J([8, '9']));

// ── 漏拍區段
const now = new Date(2026, 10, 19, 12, 0).getTime(); // 2026-11-19 12:00
const dt = S.downtimes([
  rec({ deviceId: 'A', patrolAt: '2026-10-20 10:00', stoppedMidway: true, stoppedAt: '2026-10-02', stopReason: '沒電' }),
  rec({ deviceId: 'B', patrolAt: '2026-10-10 10:00', running: false }),
  rec({ deviceId: 'B', patrolAt: '2026-10-25 10:00' }),
  rec({ deviceId: 'C', patrolAt: '2026-11-10 09:00', running: false }),
  rec({ deviceId: 'D', patrolAt: '2026-10-15 09:00', running: false, cameraSwapped: true, newDeviceId: 'E' }),
  rec({ deviceId: 'F', patrolAt: '2026-10-15 09:00', stoppedMidway: true, stoppedAt: '2026-10-16', stopReason: '沒電' }),
], now);
const of = id => dt.filter(x => x.deviceId === id);
check('stop: 停止時間 → 這次巡檢, reason kept', of('A').length === 1 && of('A')[0].start === S.toMs('2026-10-02')
  && of('A')[0].end === S.toMs('2026-10-20 10:00') && of('A')[0].reason === '沒電');
check('down at patrol: until next patrol of the same camera', of('B').length === 1 && of('B')[0].end === S.toMs('2026-10-25 10:00')
  && of('B')[0].reason === '故障' && !of('B')[0].ongoing);
check('down and not patrolled since: ongoing until now', of('C').length === 1 && of('C')[0].end === now && of('C')[0].ongoing === true);
check('down but swapped on the spot: no downtime after', of('D').length === 0);
check('stop date after patrol (bad data) ignored', of('F').length === 0);

const merged = S.lostByDevice([
  { deviceId: 'X', start: 0, end: 10 * DAY, reason: '沒電' },
  { deviceId: 'X', start: 5 * DAY, end: 12 * DAY, reason: '故障' },
  { deviceId: 'X', start: 20 * DAY, end: 22 * DAY, reason: '沒電' },
], 0, 21 * DAY).get('X');
check('lostByDevice: overlaps counted once, clipped to window, reasons unique',
  near(merged.ms, 13 * DAY) && J(merged.reasons) === J(['沒電', '故障']), J(merged));

// ── 漏拍統計：10 月，含月中架設、月中換機、跨月的停機
const devs = [
  dev({ id: 'A', stationId: 'S-01', createdAt: '2026-01-01 10:00' }),
  dev({ id: 'B', stationId: 'S-02', createdAt: '2026-10-11 00:00' }),                           // 10/11 才架：21 天
  dev({ id: 'OLD', stationId: 'S-03', createdAt: '2026-01-01 10:00', retired: true, lastPatrolAt: '2026-10-16 00:00' }),
  dev({ id: 'NEW', stationId: 'S-03', createdAt: '2026-10-16 00:00' }),
];
const recs = [
  rec({ deviceId: 'A', patrolAt: '2026-11-05 10:00', stoppedMidway: true, stoppedAt: '2026-10-22', stopReason: '沒電' }), // 10 月漏 10 天
  rec({ deviceId: 'OLD', patrolAt: '2026-10-11 00:00', running: false }),                                                 // 故障 10/11 → 換機 10/16
  rec({ deviceId: 'OLD', patrolAt: '2026-10-16 00:00', running: false, cameraSwapped: true, newDeviceId: 'NEW' }),
  rec({ deviceId: 'ZZZ', patrolAt: '2026-10-20 00:00', running: false }),                                                 // 別專案的設備：不算
];
const oct = S.downtimeReport(devs, recs, new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime(), now);
check('expected: A 31 + B 21 + OLD 15 + NEW 16 = 83 camera-days, 4 cameras', near(oct.expected, 83) && oct.cams === 4, J(oct));
check('lost: A 10 days (stop crosses month end) + S-03 5 days down before swap', near(oct.lost, 15), J(oct));
check('rows by station, most first; S-03 points to the current camera',
  J(oct.rows.map(r => [r.label, Math.round(r.days), r.reasons, r.deviceId])) === J([['S-01', 10, ['沒電'], 'A'], ['S-03', 5, ['故障'], 'NEW']]), J(oct.rows));
check('working rate', near(S.workingRate(oct), 1 - 15 / 83));
const nov = S.downtimeReport(devs, recs, new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime(), now);
check('current month counted only up to now; next month of a stop gets its share',
  near(nov.expected, 3 * (18 + 0.5)) && near(nov.lost, 4 + 10 / 24), J(nov));
check('future period: nothing', S.downtimeReport(devs, recs, new Date(2027, 0, 1).getTime(), new Date(2027, 1, 1).getTime(), now).cams === 0);
check('no cameras: working rate null', S.workingRate({ expected: 0, lost: 0 }) === null);
const ongoing = S.downtimeReport([dev({ id: 'C', stationId: 'S-09', createdAt: '2026-01-01' })],
  [rec({ deviceId: 'C', patrolAt: '2026-11-10 12:00', running: false })], new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime(), now);
check('still broken: ongoing flagged, counted up to now', ongoing.rows[0].ongoing === true && near(ongoing.lost, 9), J(ongoing));

// ── 續航
const lifeDevs = [
  dev({ id: 'L1', createdAt: '2026-01-01 00:00', batteryType: '鋰電' }),
  dev({ id: 'K1', createdAt: '2026-01-01 00:00', batteryType: '鹼性' }),
  dev({ id: 'K2', createdAt: '2026-01-01 00:00', batteryType: '鹼性' }),
  dev({ id: 'P1', createdAt: '2026-01-01 00:00', batteryType: '外接電源' }),
  dev({ id: 'OLDL', createdAt: '2026-01-01 00:00', batteryType: '鋰電', retired: true }),
  dev({ id: 'NEWL', createdAt: '2026-03-01 00:00', batteryType: '鋰電' }),
  dev({ id: 'V1', createdAt: '2026-01-01 00:00', config: { mode: '影片', videoQuality: '1080p', videoSec: 20, videoSecNight: 10 } }),
];
const lifeRecs = [
  rec({ deviceId: 'L1', patrolAt: '2026-06-10 10:00', stoppedMidway: true, stoppedAt: '2026-05-31', stopReason: '沒電', batteryChanged: true, batteryTypeNew: '鋰電' }), // 150
  rec({ deviceId: 'L1', patrolAt: '2026-11-01 10:00', stoppedMidway: true, stoppedAt: '2026-10-28 10:00', stopReason: '沒電' }),  // 6/10 起 140
  rec({ deviceId: 'K1', patrolAt: '2026-01-11 00:00', batteryChanged: true, batteryTypeNew: '鹼性' }),
  rec({ deviceId: 'K1', patrolAt: '2026-02-20 00:00', stoppedMidway: true, stoppedAt: '2026-02-11', stopReason: '沒電' }),         // 1/11 起 31
  rec({ deviceId: 'K2', patrolAt: '2026-02-20 00:00', stoppedMidway: true, stoppedAt: '2026-02-10', stopReason: '沒電' }),         // 架設起 40
  rec({ deviceId: 'P1', patrolAt: '2026-02-20 00:00', stoppedMidway: true, stoppedAt: '2026-02-10', stopReason: '沒電' }),         // 外接電源：不算
  rec({ deviceId: 'K2', patrolAt: '2026-03-01 00:00', stoppedMidway: true, stoppedAt: '2026-02-25', stopReason: '記憶卡滿' }),     // 不是沒電
  rec({ deviceId: 'OLDL', patrolAt: '2026-03-01 00:00', batteryChanged: true, batteryTypeNew: '鋰電', cameraSwapped: true, newDeviceId: 'NEWL' }),
  rec({ deviceId: 'NEWL', patrolAt: '2026-08-01 00:00', stoppedMidway: true, stoppedAt: '2026-07-29', stopReason: '沒電' }),       // 換機時換的電池起 150
  rec({ deviceId: 'V1', patrolAt: '2026-02-20 00:00', sdChanged: true }),
  rec({ deviceId: 'V1', patrolAt: '2026-04-01 00:00', stoppedMidway: true, stoppedAt: '2026-03-26', stopReason: '記憶卡滿' }),    // 2/20 起 34
];
const bat = S.lifeStats(lifeDevs, lifeRecs, 'battery');
const g = sub => bat.find(x => x.sub === sub);
check('battery life grouped by model + battery type, external power excluded',
  bat.length === 2 && g('鹼性') && g('鋰電') && !g('外接電源'), J(bat));
check('alkaline: min 31 (from battery change), median of 31/40 = 35.5',
  g('鹼性').n === 2 && near(g('鹼性').min, 31) && near(g('鹼性').median, 35.5), J(g('鹼性')));
check('lithium: install→stop 150, change 6/10 10:00→stop 10/28 10:00 = 140, swapped-in camera counts from the swap battery',
  g('鋰電').n === 3 && near(g('鋰電').min, 140) && near(g('鋰電').median, 150), J(g('鋰電')));
const sd = S.lifeStats(lifeDevs, lifeRecs, 'sd');
check('card full: grouped by shooting settings, from last card change',
  sd.length === 2 && sd.some(x => x.sub === '影片 1080p · 日20秒/夜10秒' && near(x.min, 34)) && sd.some(x => x.sub === '照片 16MP ×3 連拍' && near(x.min, 55)), J(sd));
check('swap inherits the old camera\'s start when the battery was not changed',
  near(S.lifeStats([dev({ id: 'O', createdAt: '2026-01-01 00:00', retired: true }), dev({ id: 'N', createdAt: '2026-02-01 00:00' })],
    [rec({ deviceId: 'O', patrolAt: '2026-02-01 00:00', cameraSwapped: true, newDeviceId: 'N' }),
      rec({ deviceId: 'N', patrolAt: '2026-03-01 00:00', stoppedMidway: true, stoppedAt: '2026-02-20', stopReason: '沒電' })], 'battery')[0].min, 50));
check('shootLabel: photo+video, same day/night secs', S.shootLabel({ mode: '照片+影片', photoQuality: '32MP', burst: 1, videoQuality: '2K', videoSec: 10, videoSecNight: 10 })
  === '照片 32MP ＋ 影片 2K · 10秒');

// ── 工作量
const work = S.workload([
  rec({ deviceId: 'A', patrolAt: '2026-10-03 09:00', inspector: '林小華', batteryChanged: true, batteryTypeNew: '鋰電', sdChanged: true }),
  rec({ deviceId: 'B', patrolAt: '2026-10-03 10:00', inspector: '林小華', sdChanged: true }),
  rec({ deviceId: 'C', patrolAt: '2026-10-03 11:00', inspector: '王小明', batteryChanged: true, batteryTypeNew: '鹼性', cameraSwapped: true, newDeviceId: 'C2' }),
  rec({ deviceId: 'A', patrolAt: '2026-10-14 09:00', inspector: '林小華', batteryChanged: true, batteryTypeNew: '鋰電' }),
  rec({ deviceId: 'A', patrolAt: '2026-11-01 09:00', inspector: '林小華' }),                       // 11 月：不算
  rec({ deviceId: 'A', patrolAt: '2026-10-20 09:00', inspector: '' }),
], new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime());
const lin = work.people.find(p => p.name === '林小華');
check('per person: days, count, battery, sd', lin.days === 2 && lin.count === 3 && lin.battery === 2 && lin.sd === 2 && lin.swap === 0, J(lin));
check('people sorted by count; blank inspector shown as （未填）', work.people[0].name === '林小華' && work.people.some(p => p.name === '（未填）'));
check('total days = days anyone went out (same day counted once)', work.total.days === 3 && work.total.count === 5 && work.total.swap === 1, J(work.total));
check('battery use by new battery type', J(work.battery) === J([{ type: '鋰電', n: 2 }, { type: '鹼性', n: 1 }]), J(work.battery));
check('detail by date then person', J(work.detail.map(x => [x.day, x.name, x.n])) === J([['2026-10-03', '林小華', 2], ['2026-10-03', '王小明', 1],
  ['2026-10-14', '林小華', 1], ['2026-10-20', '（未填）', 1]]), J(work.detail));

// ── 出發準備
const days = n => { const d = new Date(Date.now() - n * DAY); const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
check('isDue: >60 days or broken', S.isDue({ lastPatrolAt: days(61) }) && !S.isDue({ lastPatrolAt: days(59) }) && S.isDue({ running: false, lastPatrolAt: days(1) }));
const need = S.packNeeds;
check('battery when ≤50%, not at 75%', need(dev({ batteryPct: 50 })).battery === '鋰電' && need(dev({ batteryPct: 75 })).battery === null);
check('broken camera: spare + battery', need(dev({ running: false, batteryPct: 100 })).spare && need(dev({ running: false, batteryPct: 100 })).battery === '鋰電');
check('external power never needs batteries', need(dev({ batteryType: '外接電源', batteryPct: 0, running: false })).battery === null);
check('guards: only explicit "no" (false), not unknown (null)',
  need(dev({ config: { locked: false, rainCover: null, ironCase: true } })).lock && !need(dev({ config: { locked: false, rainCover: null } })).rain
  && !need(dev({ config: { ironCase: true } })).iron);
const pack = S.packSummary([
  dev({ id: '1', stationId: 'S-03', batteryPct: 25 }),
  dev({ id: '2', stationId: 'S-05', batteryType: '鹼性', batteryPct: 50, config: { locked: false } }),
  dev({ id: '3', stationId: 'S-07', running: false, cameraModel: 'Browning HP5 Ultra' }),
  dev({ id: '4', stationId: 'S-11', batteryPct: 75, config: { rainCover: false, ironCase: false } }),
]);
check('pack summary: batteries by type with stations, a card each, spare, guards',
  J(pack.battery) === J([{ type: '鋰電', labels: ['S-03', 'S-07'] }, { type: '鹼性', labels: ['S-05'] }]) && pack.sd === 4
  && J(pack.spare) === J([{ label: 'S-07', model: 'Browning HP5 Ultra' }]) && J(pack.lock) === J(['S-05'])
  && J(pack.rain) === J(['S-11']) && J(pack.iron) === J(['S-11']), J(pack));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

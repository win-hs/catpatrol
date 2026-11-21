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
  && of('B')[0].reason === '未運作' && !of('B')[0].ongoing);
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
  J(oct.rows.map(r => [r.label, Math.round(r.days), r.reasons, r.deviceId])) === J([['S-01', 10, ['沒電'], 'A'], ['S-03', 5, ['未運作'], 'NEW']]), J(oct.rows));
check('working rate', near(S.workingRate(oct), 1 - 15 / 83));
const nov = S.downtimeReport(devs, recs, new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime(), now);
check('current month counted only up to now; next month of a stop gets its share',
  near(nov.expected, 3 * (18 + 0.5)) && near(nov.lost, 4 + 10 / 24), J(nov));
check('future period: nothing', S.downtimeReport(devs, recs, new Date(2027, 0, 1).getTime(), new Date(2027, 1, 1).getTime(), now).cams === 0);
check('no cameras: working rate null', S.workingRate({ expected: 0, lost: 0 }) === null);
const ongoing = S.downtimeReport([dev({ id: 'C', stationId: 'S-09', createdAt: '2026-01-01' })],
  [rec({ deviceId: 'C', patrolAt: '2026-11-10 12:00', running: false })], new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime(), now);
check('still broken: ongoing flagged, counted up to now', ongoing.rows[0].ongoing === true && near(ongoing.lost, 9), J(ongoing));

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

// ── 出發準備（v0.7：上面三排決定怎麼帶）
const LOW = { battery: 'low', sd: 'each', guard: 'full' };
const ALL = { battery: 'all', sd: 'each', guard: 'full' };
const full3 = { ironCase: true, locked: true, rainCover: true };
const need = S.packNeeds;
check('battery "all": every camera except external power',
  need(dev({ batteryPct: 100 }), ALL).battery === '鋰電' && need(dev({ batteryType: '外接電源' }), ALL).battery === null);
check('battery "low": ≤50% or not running only',
  need(dev({ batteryPct: 50 }), LOW).battery === '鋰電' && need(dev({ batteryPct: 75 }), LOW).battery === null
  && need(dev({ running: false, batteryPct: 100 }), LOW).battery === '鋰電');
check('not running: spare camera', need(dev({ running: false }), ALL).spare === true && need(dev({}), ALL).spare === false);
check('missing guards: anything not recorded as "has" (false or never filled)',
  J(need(dev({ config: { ironCase: true, locked: false } }), ALL).guards) === J(['locked', 'rainCover'])
  && need(dev({ config: full3 }), ALL).guards.length === 0 && need(dev({ config: undefined }), ALL).guards.length === 3);
check('sd count: each / half / third, rounded up',
  S.sdCount(7, 'each') === 7 && S.sdCount(7, 'half') === 4 && S.sdCount(7, 'third') === 3 && S.sdCount(6, 'half') === 3 && S.sdCount(0, 'third') === 0);

const packDevs = [
  dev({ id: '1', stationId: 'S-03', batteryPct: 25, config: full3 }),
  dev({ id: '2', stationId: 'S-05', batteryType: '鹼性', batteryPct: 50, config: { ...full3, locked: false } }),
  dev({ id: '3', stationId: 'S-07', running: false, cameraModel: 'Browning HP5 Ultra', config: full3 }),
  dev({ id: '4', stationId: 'S-11', batteryPct: 75, config: { locked: true, rainCover: false, ironCase: false } }),
  dev({ id: '5', stationId: 'S-12', batteryType: '外接電源', batteryPct: 100, config: {} }), // 防護沒填過
];
const pf = S.packSummary(packDevs, { battery: 'low', sd: 'half', guard: 'full' });
check('"50% 以下才換" + 備一半 + 全部上防護: batteries by type with a total, cards, spare, kits with per-item counts',
  J(pf.battery) === J([{ type: '鋰電', labels: ['S-03', 'S-07'] }, { type: '鹼性', labels: ['S-05'] }]) && pf.batteryTotal === 3
  && pf.sd === 3 && J(pf.spare) === J([{ label: 'S-07', model: 'Browning HP5 Ultra' }])
  && pf.guard.mode === 'full' && J(pf.guard.kits) === J(['S-05', 'S-11', 'S-12']) && pf.guard.total === 3
  && pf.guard.items.ironCase.length === 3 && pf.guard.items.locked.length === 3 && pf.guard.items.rainCover.length === 3, J(pf));
const pg = S.packSummary(packDevs, { battery: 'all', sd: 'third', guard: 'gaps' });
check('"全部換" + 備 1/3 + 補缺漏: every camera gets batteries (not external power), only the missing pieces',
  pg.batteryTotal === 4 && pg.sd === 2 && pg.guard.mode === 'gaps'
  && J(pg.guard.items.ironCase) === J(['S-11', 'S-12']) && J(pg.guard.items.locked) === J(['S-05', 'S-12'])
  && J(pg.guard.items.rainCover) === J(['S-11', 'S-12']) && pg.guard.total === 6, J(pg));
check('no cameras: nothing to bring', S.packSummary([], ALL).sd === 0 && S.packSummary([], ALL).guard.total === 0);

// ── 資料檢查：樣點／記憶卡重複、編號格式
const issues = S.dataIssues([
  dev({ id: 'CA001', stationId: 'S-03', sdCard: 'SD012' }),
  dev({ id: 'CA002', stationId: 's-03 ', sdCard: '野12' }),            // 樣點不分大小寫空白；野12 = SD012
  dev({ id: 'CA003', stationId: 'S-04', sdCard: 'SD013' }),
  dev({ id: 'CA004', stationId: 'S-04', sdCard: 'SD014', retired: true }), // 已撤下的不算
  dev({ id: 'ABC', stationId: 'S-05', sdCard: 'X-9' }),
  dev({ id: 'CA006', stationId: '', sdCard: '' }),                       // 空白不算重複
  dev({ id: 'CA007', stationId: '', sdCard: '' }),
  dev({ id: 'CA024N', stationId: 'S-24', sdCard: 'SD024' }),             // N＝另一批，格式正確
]);
check('duplicate stations (case/space-insensitive), retired ignored, blanks ignored',
  issues.stations.length === 1 && J(issues.stations[0].devices.map(d => d.id)) === J(['CA001', 'CA002']), J(issues.stations));
check('duplicate cards: old 野12 and SD012 are the same card', issues.cards.length === 1 && issues.cards[0].key === 'SD012'
  && issues.cards[0].devices.length === 2, J(issues.cards));
check('bad formats listed (camera ABC, card X-9; 野12 too until fixed)',
  J(issues.badIds.map(d => d.id)) === J(['ABC']) && J(issues.badCards.map(d => d.sdCard)) === J(['野12', 'X-9']), J(issues));

// ── 舊設備沒填過、巡檢時要補問的欄位
const { missingFields } = await import('../public/js/cam-config.js');
check('missing: station, model, night secs (video only), guards, mount',
  J(missingFields({ stationId: '', cameraModel: '', config: { mode: '照片+影片', videoSec: 20 } }))
  === J(['stationId', 'cameraModel', 'videoSecNight', 'ironCase', 'locked', 'rainCover', 'mount']));
check('missing: photo-only camera is not asked night secs; filled ones not asked',
  J(missingFields({ stationId: 'S-1', cameraModel: 'Meidase P70', config: { mode: '照片', ironCase: false, locked: true, rainCover: null, mount: '角鋼' } }))
  === J(['rainCover']));
check('missing: nothing when all filled (false counts as filled)',
  missingFields({ stationId: 'S-1', cameraModel: 'X', config: { mode: '影片', videoSecNight: 10, ironCase: false, locked: false, rainCover: false, mount: '綁帶' } }).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

const assert = require('node:assert/strict');
const test = require('node:test');
const {tourismReportGroups} = require('../pages/staff/tourism-report');

const bounds = {
  period: {start: '2026-04-01T00:00:00.000+08:00', endExclusive: '2026-05-01T00:00:00.000+08:00'},
  occurrenceCutoffExclusive: '2026-05-01T00:00:00.000+08:00',
  asOf: '2026-05-05T12:00:00.001+08:00'
};
const scope = (count, status = 'complete') => ({status, count});
const values = group => Object.fromEntries(group.rows.map(({label, value}) => [label, value]));

test('tourism text preserves the two evidence groups, individual metrics, scope and units', () => {
  const [demo, operational] = tourismReportGroups({
    ...bounds,
    demo: {
      route_exposed: scope(2), route_adopted: scope(1), route_completed_self_reported: scope(1),
      guide_played: {...scope(1, 'partial'), durationSeconds: 12},
      booking_demo_submitted: scope(1), parking_advice_adopted: scope(1), parking_navigation_clicked: scope(1),
      parking_arrival_verified: scope(8)
    },
    operational: {
      route_exposed: {status: 'unavailable'}, route_adopted: scope(0, 'partial'), guide_played: {...scope(0), durationSeconds: 0},
      booking_requested: scope(2), booking_confirmed: scope(1), booking_cancelled: scope(1),
      bookingStatus: {status: 'partial', requested: 0, confirmed: 1, cancelled: 1},
      parking_arrival_verified: scope(0), booking_demo_submitted: scope(9)
    }
  });
  assert.equal(demo.title, '导览行为 · 演示');
  assert.equal(operational.title, '导览行为 · 运营');
  assert.deepEqual(values(demo), {
    '路线推荐曝光': '2 次（完整覆盖）', '路线采纳': '1 次（完整覆盖）', '路线完成（游客自报）': '1 次（完整覆盖）',
    '语音实播次数': '1 次（部分覆盖）', '语音实播累计时长': '12 秒（部分覆盖）',
    '预约演示提交': '1 次（完整覆盖）', '停车建议采纳': '1 次（完整覆盖）', '停车导航点击': '1 次（完整覆盖）'
  });
  const live = values(operational);
  assert.equal(live['路线推荐曝光'], '暂无覆盖');
  assert.equal(live['路线采纳'], '0 次（部分覆盖）');
  assert.equal(live['语音实播累计时长'], '0 秒（完整覆盖）');
  assert.equal(live['停车核验到达'], '0 次（完整覆盖）');
  assert.equal(live['停车导航点击'], '暂无覆盖');
  assert.equal(live['预约发起'], '2 次（完整覆盖）');
  assert.equal(live['预约确认'], '1 次（完整覆盖）');
  assert.equal(live['预约取消'], '1 次（完整覆盖）');
  assert.equal(live['预约状态 · 待确认'], '0 笔（部分覆盖）');
  assert.equal(live['预约状态 · 已确认'], '1 笔（部分覆盖）');
  assert.equal(live['预约状态 · 已取消'], '1 笔（部分覆盖）');
  assert.equal(live['预约演示提交'], undefined);
  assert.match(demo.note, /北京时间.*2026-04-01 00:00:00 至 2026-05-01 00:00:00，录入截点 2026-05-05 12:00:00\.001/);
});

test('missing and legacy unavailable reports show no manufactured zeros or extra fields', () => {
  const empty = tourismReportGroups(undefined);
  assert.deepEqual(tourismReportGroups({
    status: 'unavailable', reason: 'UNTRUSTED',
    demo: {unknown_metric: {...scope(1), label: 'PRIVATE'}, route_adopted: {status: 'unavailable', count: 0}},
    operational: {sourceId: 'PRIVATE', flowId: 'PRIVATE'},
    events: ['PRIVATE']
  }), empty);
  for (const group of empty) assert.ok(group.rows.every(item => item.value === '暂无覆盖'));
  assert.match(empty[0].note, /暂无导览来源覆盖/);
});

test('formatting validates defined numbers and timestamps and preserves large durations exactly', () => {
  const duration = '18014398509481982';
  const demo = {guide_played: {...scope(2), durationSeconds: duration, id: 'PRIVATE'}};
  const wholeSeconds = type => bounds[type].replace('.000', '').replace('.001', '');
  const report = tourismReportGroups({...bounds, occurrenceCutoffExclusive: wholeSeconds('occurrenceCutoffExclusive'),
    asOf: wholeSeconds('asOf'), demo});
  assert.equal(values(report[0])['语音实播累计时长'], `${duration} 秒（完整覆盖）`);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.throws(() => tourismReportGroups({...bounds, demo: {route_exposed: scope('0')}}), /Invalid tourism measure/);
  assert.throws(() => tourismReportGroups({...bounds, demo: {guide_played: scope(1)}}), /Invalid tourism measure/);
  assert.throws(() => tourismReportGroups({...bounds, demo: {guide_played: {...scope(1), durationSeconds: '<text>'}}}), /Invalid tourism measure/);
  assert.throws(() => tourismReportGroups({...bounds, asOf: '2026-04-31T00:00:00.000+08:00', demo}), /Invalid tourism report timestamp/);
  assert.throws(() => tourismReportGroups({...bounds, asOf: bounds.period.start, demo}), /Invalid tourism report interval/);
});

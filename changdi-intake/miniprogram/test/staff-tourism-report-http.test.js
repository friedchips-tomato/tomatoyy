const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const config = require('../config');

const beijingOffset = 8 * 3600000;
const beijingMonth = ms => new Date(ms + beijingOffset).toISOString().slice(0, 7);
const id = n => n.toString(16).padStart(24, '0');

const catalogs = {
  route_exposed: ['R1', 'R2', 'R3'],
  route_adopted: ['R1', 'R2', 'R3'],
  route_completed_self_reported: ['R1', 'R2', 'R3'],
  guide_played: ['CD-A01'],
  booking_demo_submitted: ['G1'],
  parking_advice_adopted: ['P1'],
  parking_navigation_clicked: ['P1']
};

async function fixture(t) {
  const { createIntakeServer } = await import('../../server/src/server.js');
  const { randomBytes } = require('node:crypto');
  const directory = mkdtempSync(join(tmpdir(), 'staff-tourism-http-'));
  const dutyToken = randomBytes(24).toString('base64url');
  const metricsToken = randomBytes(24).toString('base64url');
  const intakeToken = randomBytes(24).toString('base64url');
  const server = createIntakeServer({
    dbPath: join(directory, 'intake.sqlite'),
    receiptKey: randomBytes(32),
    integrations: [{source: 'guide-form', token: intakeToken}],
    staff: [{id: 'desk', role: 'duty', token: dutyToken}],
    merchants: [],
    tourism: {
      sources: [{id: 'guide-demo', kind: 'guide_h5', evidence: 'demo', token: metricsToken, subjects: catalogs}],
      coverage: Object.keys(catalogs).map(type => ({
        evidence: 'demo', type, from: '2026-01-01T00:00:00Z', status: 'complete'
      }))
    }
  });
  t.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    rmSync(directory, {recursive: true, force: true});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    dutyToken, metricsToken
  };
}

function postEvent(origin, token, body) {
  return fetch(origin + '/api/v1/metrics/tourism/events', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify(body)
  });
}

function pageFixture(t, origin, token) {
  const path = require.resolve('../pages/staff/index');
  const initialOrigin = config.apiBaseUrl;
  let page;
  global.Page = definition => { page = definition; };
  global.wx = {
    request(options) {
      const init = {method: options.method || 'GET', headers: options.header};
      if (options.data !== undefined && options.method && options.method !== 'GET') {
        init.body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data);
      }
      fetch(options.url, init).then(async response => {
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        options.success({statusCode: response.status, data});
      }).catch(() => options.fail({errMsg: 'network'}));
    },
    setStorage: () => assert.fail('unexpected persisted data'),
    setStorageSync: () => assert.fail('unexpected persisted data')
  };
  delete require.cache[path];
  require(path);
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad();
  t.after(() => {
    page.onUnload();
    config.apiBaseUrl = initialOrigin;
    delete global.Page;
    delete global.wx;
    delete require.cache[path];
  });
  return page;
}

test('管理月报的真实响应渲染导览分组与口径说明', async t => {
  const server = await fixture(t);
  const now = new Date();
  const occurredAt = now.toISOString();
  const events = [
    {eventId: id(1), type: 'route_exposed', subjectId: 'R1', flowId: id(101), occurredAt},
    {eventId: id(2), type: 'route_exposed', subjectId: 'R2', flowId: id(101), occurredAt},
    {eventId: id(3), type: 'route_adopted', subjectId: 'R1', flowId: id(101), occurredAt},
    {eventId: id(4), type: 'route_completed_self_reported', subjectId: 'R1', flowId: id(101), occurredAt},
    {eventId: id(5), type: 'guide_played', subjectId: 'CD-A01', flowId: id(102), occurredAt, durationSeconds: 12},
    {eventId: id(6), type: 'booking_demo_submitted', subjectId: 'G1', flowId: id(103), occurredAt},
    {eventId: id(7), type: 'parking_advice_adopted', subjectId: 'P1', flowId: id(104), occurredAt}
  ];
  for (const event of events) {
    const response = await postEvent(server.origin, server.metricsToken, event);
    assert.equal(response.status, 201);
  }

  config.apiBaseUrl = server.origin;
  const page = pageFixture(t, server.origin, server.dutyToken);
  await page.onLoginSubmit({detail: {value: {token: server.dutyToken}}});
  await page.onOpenMonthlyReport();
  const report = page.data.report;
  assert.ok(report, 'the management report must be rendered');
  assert.equal(report.tourismMissing, false);

  const demo = report.groups.find(group => group.title === '导览行为 · 演示');
  assert.ok(demo, 'the demo tourism group must be part of the report groups');
  const values = Object.fromEntries(demo.rows.map(row => [row.label, row.value]));
  assert.equal(values['路线推荐曝光'], '2 次（完整覆盖）');
  assert.equal(values['路线采纳'], '1 次（完整覆盖）');
  assert.equal(values['路线完成（游客自报）'], '1 次（完整覆盖）');
  assert.equal(values['语音实播次数'], '1 次（完整覆盖）');
  assert.equal(values['语音实播累计时长'], '12 秒（完整覆盖）');
  assert.equal(values['预约演示提交'], '1 次（完整覆盖）');
  assert.equal(values['停车建议采纳'], '1 次（完整覆盖）');
  // The prototype has no parking navigation entry, so the covered metric is a real zero.
  assert.equal(values['停车导航点击'], '0 次（完整覆盖）');

  const operational = report.groups.find(group => group.title === '导览行为 · 运营');
  assert.ok(operational, 'the operational tourism group must be part of the report groups');
  const live = Object.fromEntries(operational.rows.map(row => [row.label, row.value]));
  assert.equal(live['路线推荐曝光'], '暂无覆盖');
  assert.equal(live['预约状态 · 已确认'], '暂无覆盖');
  assert.equal(live['停车核验到达'], '暂无覆盖');

  // The cutoff of the tourism column keeps milliseconds, the complaint column does not.
  assert.match(demo.note, /导览截点保留毫秒，投诉指标按整秒取数/);
  assert.match(demo.note, /录入截点 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
  assert.equal(report.asOf.length, 19);
  assert.equal(page.data.reportMonth, beijingMonth(Date.now()));
});

test('管理月报的模板渲染导览分组、说明与缺覆盖提示', () => {
  const wxml = readFileSync(require.resolve('../pages/staff/index.wxml'), 'utf8');
  assert.match(wxml, /wx:for="\{\{report\.groups\}\}"/);
  assert.match(wxml, /\{\{group\.title\}\}/);
  assert.match(wxml, /\{\{group\.note\}\}/);
  assert.match(wxml, /\{\{item\.label\}\}/);
  assert.match(wxml, /\{\{item\.value\}\}/);
  assert.match(wxml, /report\.tourismMissing/);
  assert.match(wxml, /所选期间暂无导览来源覆盖。/);
});

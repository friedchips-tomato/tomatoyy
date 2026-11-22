const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const config = require('../config');
const { beijingMonth, validReportMonth, reportView } = require('../pages/staff/monthly-report');
const { queues } = require('../pages/staff/workbench');

const duty = { id: 'synthetic-duty', role: 'duty', token: 'd'.repeat(43) };
const supervisor = { id: 'synthetic-supervisor', role: 'supervisor', department: 'a', token: 's'.repeat(43) };
const priorMonth = '2020-06';
const absent = { status: 'unavailable', reason: 'synthetic-private-reason' };
const response = (request, data, statusCode = 200) => request.success({ statusCode, data });
const signIn = (page, profile) => page.onLoginSubmit({ detail: { value: { token: profile.token } } });
const selectMonth = (page, month) => page.onReportMonthChange({ detail: { value: month } });

function sample(month, { final = true, median = 0, rate = 0 } = {}) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  return {
    month, timeZone: 'Asia/Shanghai',
    asOf: '2026-12-05T00:00:00+08:00',
    period: { start: month + '-01T00:00:00+08:00', endExclusive: '2026-12-01T00:00:00+08:00' },
    firstResponse: { submitted: 3, responded: 1, pending: 2, medianMinutes: median,
      distribution: { atMostOneHour: 1, upTo24Hours: 0, over24Hours: 0 } },
    completion: { accepted: 3, completed: 0, rate },
    monthEnd: { state: final ? 'final' : 'provisional', cutoff: '2026-12-01T00:00:00+08:00',
      deadlineData: 'insufficient', unfinished: 2, overdue: 0, withoutDeadline: 1, missingDeadlineEvidence: 1 },
    reopen: { applications: 1, approved: 0, rejected: 1, newRounds: 0 },
    evaluation: { publishedRounds: 0, validEvaluations: 0, unevaluatedRounds: 0, coverage: null, dimensions: {
      speed: { mean: null, distribution }, effectiveness: { mean: null, distribution }, attitude: { mean: null, distribution }
    } },
    duplicateComplaints: absent, tourism: absent
  };
}

function fixture(t) {
  const path = require.resolve('../pages/staff/index');
  const initialOrigin = config.apiBaseUrl;
  delete require.cache[path];
  let page;
  const calls = [];
  global.Page = definition => { page = definition; };
  global.wx = {
    request(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/v1/staff/monthly-report') calls.push(request);
      else if (pathname === '/api/v1/staff/me') {
        const user = [duty, supervisor].find(item => request.header.Authorization === 'Bearer ' + item.token);
        const { token, ...identity } = user;
        response(request, identity);
      } else if (pathname === '/api/v1/staff/workbench') {
        response(request, { counts: Object.fromEntries(queues.map(queue => [queue.id, 0])), dueSoonSeconds: 86400 });
      } else response(request, { items: [] });
    },
    setStorage: () => assert.fail('unexpected persisted data'),
    setStorageSync: () => assert.fail('unexpected persisted data')
  };
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
  return { page, calls };
}

test('北京时间月边界、汇总投影和 0／空值显示', () => {
  assert.equal(beijingMonth(Date.parse('2026-11-30T15:59:59Z')), '2026-11');
  assert.equal(beijingMonth(Date.parse('2026-11-30T16:00:00Z')), '2026-12');
  for (const month of ['2026-1', '2026-13', '2026-12\n', '2027-01', '2026-12-01']) {
    assert.equal(validReportMonth(month, '2026-12'), false);
  }
  const input = { ...sample('2026-11'), caseNumber: 'CD-PRIVATE', contact: 'synthetic contact' };
  const view = reportView(input, '2026-11');
  assert.equal(view.snapshotLabel, '月末快照');
  assert.equal(view.asOf, '2026-12-05 00:00:00');
  assert.equal(view.groups[0].rows[3].value, '0 分钟');
  assert.equal(view.groups[1].rows[2].value, '0%');
  assert.equal(view.groups[4].rows[3].value, '无适用样本');
  assert.equal(view.ratings[0].bins[4].count, '0');
  assert.equal(view.ratings[0].mean, '无适用样本');
  assert.match(view.deadlineWarning, /缺少历史期限/);
  assert.equal(view.duplicateMissing, true);
  assert.equal(view.tourismMissing, true);
  assert.doesNotMatch(JSON.stringify(view), /CD-PRIVATE|synthetic contact|synthetic-private-reason/);
  assert.equal(reportView(sample('2026-11', { final: false, rate: null }), '2026-11').snapshotLabel, '截至当前');
});

test('重复投诉区分已覆盖零、部分覆盖与缺少来源', () => {
  const view = fields => reportView({ ...sample('2026-11'), duplicateComplaints: fields }, '2026-11');
  const aggregate = { submitted: 3, covered: 3, unclassified: 0, confirmed: 0, notConfirmed: 3 };
  const group = rendered => rendered.groups.find(item => item.title === '重复投诉');
  assert.equal(group(view({ status: 'available', ...aggregate })).rows.find(row => row.label === '已确认重复').value, '0');
  const partial = group(view({ status: 'partial', ...aggregate, covered: 2, unclassified: 1, confirmed: 1, notConfirmed: 1 }));
  assert.match(partial.note, /仅部分/);
  assert.equal(partial.rows.find(row => row.label === '已确认重复').value, '1');
  const unavailable = group(view({ status: 'unavailable', submitted: 3, covered: 0, unclassified: 3 }));
  assert.match(unavailable.note, /无法统计/);
  assert.equal(unavailable.rows.some(row => row.label === '已确认重复'), false);
  assert.equal(view(absent).duplicateMissing, true);
  assert.equal(group(view(absent)), undefined);
});

test('仅值班进入，月切换作废旧响应，失败后重读当前月', async t => {
  const { page, calls } = fixture(t);
  await signIn(page, supervisor);
  await page.onOpenMonthlyReport();
  assert.equal(page.data.view, 'workbench');
  assert.equal(calls.length, 0);
  page.onLogout();
  await signIn(page, duty);
  const starting = page.onOpenMonthlyReport();
  assert.equal(page.data.reportMonth, beijingMonth());
  assert.equal(new URL(calls[0].url).searchParams.get('month'), beijingMonth());
  assert.equal(calls[0].header.Authorization, 'Bearer ' + duty.token);
  assert.ok(!calls[0].url.includes(duty.token));
  const changing = selectMonth(page, priorMonth);
  assert.equal(page.data.report, null);
  calls[1].fail();
  await changing;
  assert.match(page.data.reportError, /读取失败/);
  response(calls[0], sample(beijingMonth()));
  await starting;
  assert.equal(page.data.report, null);
  const retry = page.onRetryMonthlyReport();
  assert.equal(new URL(calls[2].url).searchParams.get('month'), priorMonth);
  response(calls[2], sample(priorMonth, { median: 12 }));
  await retry;
  assert.equal(page.data.report.groups[0].rows[3].value, '12 分钟');
  await selectMonth(page, '2026-99');
  assert.equal(calls.length, 3);
  assert.match(page.data.reportError, /合法统计月/);
});

test('关闭、隐藏、退出和失权都清空月报并作废请求', async t => {
  const { page, calls } = fixture(t);
  for (const leave of [() => page.onCloseMonthlyReport(), () => page.onHide(), () => page.onLogout()]) {
    if (page.data.view === 'login') await signIn(page, duty);
    const pending = page.onOpenMonthlyReport();
    leave();
    response(calls.at(-1), sample(beijingMonth()));
    await pending;
    assert.equal(page.data.report, null);
    assert.equal(page.data.reportBusy, false);
  }
  await signIn(page, duty);
  const denied = page.onOpenMonthlyReport();
  response(calls.at(-1), {}, 403);
  await denied;
  assert.equal(page._token, '');
  assert.equal(page.data.view, 'login');
  assert.equal(page.data.report, null);
});

test('实际回环月报契约提供可用汇总和空样本且拒绝主管', async t => {
  const { page } = fixture(t);
  const { createIntakeServer } = await import('../../server/src/server.js');
  const integration = 'i'.repeat(43);
  const month = beijingMonth();
  let now = Date.parse(month + '-15T09:00:00+08:00');
  const server = createIntakeServer({
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 76), now: () => new Date(now),
    integrations: [{ source: 'synthetic-monthly-report-ui', token: integration }], staff: [duty, supervisor]
  });
  t.after(async () => {
    const stopped = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await stopped;
    assert.equal(server.listening, false);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  config.apiBaseUrl = origin;
  global.wx.request = async request => {
    assert.equal(new URL(request.url).origin, origin);
    try {
      const result = await fetch(request.url, { headers: request.header, signal: AbortSignal.timeout(4000) });
      response(request, await result.json(), result.status);
    } catch {
      request.fail();
    }
  };
  const form = new FormData();
  form.append('payload', JSON.stringify({ externalCaseId: 'synthetic-ui-month', occurredAt: new Date(now).toISOString(),
    location: '只用于合成验收的位置', category: '合成类别', description: '只用于合成验收的正文' }));
  const submitted = await fetch(origin + '/api/v1/integrations/intake/cases', {
    method: 'POST', headers: { Authorization: 'Bearer ' + integration }, body: form, signal: AbortSignal.timeout(4000)
  });
  assert.equal(submitted.status, 201);
  const { caseNumber } = await submitted.json();
  now += 120000;
  const accepted = await fetch(origin + '/api/v1/staff/cases/' + caseNumber + '/actions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + duty.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'accept', expectedVersion: 1 }), signal: AbortSignal.timeout(4000)
  });
  assert.equal(accepted.status, 200);
  await accepted.json();
  now += 1000;
  await signIn(page, duty);
  await page.onOpenMonthlyReport();
  assert.equal(page.data.report.groups[0].rows[3].value, '2 分钟');
  assert.equal(page.data.report.groups[1].rows[2].value, '0%');
  assert.equal(page.data.report.snapshotLabel, '截至当前');
  assert.ok(!JSON.stringify(page.data.report).includes(caseNumber));
  await selectMonth(page, priorMonth);
  assert.equal(page.data.report.snapshotLabel, '月末快照');
  assert.equal(page.data.report.groups[1].rows[2].value, '无适用样本');
  const denied = await fetch(origin + '/api/v1/staff/monthly-report?month=' + month, {
    headers: { Authorization: 'Bearer ' + supervisor.token }, signal: AbortSignal.timeout(4000)
  });
  assert.equal(denied.status, 403);
  await denied.json();
});

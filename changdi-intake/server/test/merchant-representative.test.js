import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';
import { SCHEMA_VERSION } from '../src/store.js';
import { representativeReportConfig } from '../src/representative-report.js';

const member = (id, merchantId, character, permissions = ['readCases', 'submitCases']) =>
  ({ id, merchantId, token: character.repeat(43), permissions });
const writerA = member('writer-a', 'tenant-a', 'a');
const writerB = member('writer-b', 'tenant-b', 'b');
const otherA = member('other-a', 'tenant-a', 'o');
const outsider = member('outside', 'outside', 'u');
const repA = member('rep-a', 'viewer-a', 'v', ['representativeReport', 'readCases', 'submitCases', 'collaborate']);
const repA2 = member('rep-a2', 'viewer-a', 'n', ['representativeReport']);
const repB = member('rep-b', 'viewer-b', 'q', ['representativeReport']);
const noScope = member('no-scope', 'not-configured', 'z', ['representativeReport']);
const allMerchants = [writerA, writerB, otherA, outsider, repA, repA2, repB, noScope];
const desk = { id: 'desk', role: 'duty', token: 'd'.repeat(43), supervision: true, readContact: true };
const lead = { id: 'lead', role: 'supervisor', department: 'street', token: 'l'.repeat(43) };
const handler = { id: 'handler', role: 'handler', department: 'street', token: 'h'.repeat(43) };
const settings = {
  minimumGroupSize: 5, months: ['2026-11', '2026-12'],
  ranges: [
    { id: 'east', merchantIds: ['tenant-a', 'viewer-a'] },
    { id: 'west', merchantIds: ['tenant-b', 'viewer-b'] },
  ],
};
const supervision = { windowHours: 72, points: [{ code: 'p', label: '合成点位' }], categories: [{ code: 'c', label: '合成类别' }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const at = time => new Date('2026-' + time + '+08:00').toISOString();
const cases = '/api/v1/merchant/cases';
const report = '/api/v1/merchant/representative-report?month=';
const receiptPath = number => cases + '/' + number + '/receipt';
const claim = number => cases + '/' + number + '/claimant';
const payload = {
  clientRequestId: 'old-own-case', occurredAt: at('11-01T00:01:00'), location: '合成地点', category: '合成类别',
  description: '合成描述', contact: 'synthetic-contact-private',
};

function form(value, includePhoto = false) {
  const body = new FormData();
  body.set('payload', JSON.stringify(value));
  if (includePhoto) body.append('photos', new Blob([png], { type: 'image/png' }), 'example.png');
  return body;
}

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'changdi-merchant-release-'));
  const dbPath = join(directory, 'merchant.sqlite');
  let clock = new Date(at('11-01T00:10:00'));
  const options = {
    dbPath, receiptKey: Buffer.alloc(32, 28), now: () => clock,
    integrations: [{ source: 'synthetic', token: 'i'.repeat(43) }], staff: [desk, lead, handler],
    merchants: allMerchants, supervision, representativeReports: settings, ...extra,
  };
  let server;
  let origin;
  async function stop() {
    if (!server) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
    server = null;
  }
  async function start(overrides = {}) {
    server = createIntakeServer({ ...options, ...overrides });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return {
    start, stop, clock: value => { clock = new Date(at(value)); },
    inspect(action) {
      const db = new DatabaseSync(dbPath);
      try { return action(db); } finally { db.close(); }
    },
    async call(path, principal, input, binary = false) {
      const headers = principal ? { Authorization: 'Bearer ' + (principal.token ?? principal) } : {};
      let body = input;
      if (input !== undefined && !(input instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(input);
      }
      const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', body, headers,
        signal: AbortSignal.timeout(8000) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: binary ? Buffer.from(await response.arrayBuffer()) : await response.json() };
    },
  };
}

function expect(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}

test('旧库升级保留原单，制码失败原单降级，回执、反馈图片、评价和补办绑定原提交人', async t => {
  const f = await fixture(t, { representativeReports: null });
  expect(await f.call(report + '2026-11', repA), 403);
  assert.deepEqual(expect(await f.call('/api/v1/merchant/me', repA2)).permissions, []);
  const old = expect(await f.call(cases, writerA, form(payload)), 201);
  const number = old.caseNumber;
  expect(await f.call('/api/v1/staff/cases/' + number + '/contact', desk));
  await f.stop();
  const before = f.inspect(db => {
    db.exec('DROP TABLE representative_report_releases; DROP TABLE tourism_event_ids; DROP TABLE tourism_events; PRAGMA user_version = 12;');
    return db.prepare('SELECT * FROM case_contact_access_audit').all();
  });
  let outage = true;
  const scenes = [];
  await f.start({ wechatCode: {
    appId: 'wx1234567890abcdef', appSecret: 'SYNTHETIC_TEST_SECRET', envVersion: 'trial',
    async fetchImpl(url, options) {
      const upstream = new URL(url);
      if (upstream.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'synthetic', expires_in: 7200 });
      const codeRequest = JSON.parse(options.body);
      assert.deepEqual(Object.keys(codeRequest).sort(), ['check_path', 'env_version', 'page', 'scene']);
      assert.equal(codeRequest.page, 'pages/public/index');
      assert.match(codeRequest.scene, /^[A-Za-z0-9_-]{24}$/);
      scenes.push(codeRequest.scene);
      return outage ? Response.json({ errcode: 40013 }) : new Response(png, { headers: { 'Content-Type': 'image/png' } });
    },
  } });
  f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(db.prepare('SELECT * FROM case_contact_access_audit').all(), before);
  });
  assert.deepEqual(expect(await f.call(receiptPath(number), writerA)), { ...old, wechatCode: null });
  const input = { ...payload, clientRequestId: 'new-with-department', suggestedDepartment: '合成建议部门' };
  const created = expect(await f.call(cases, writerA, form(input, true)), 201);
  assert.equal(created.wechatCode, null);
  assert.deepEqual(expect(await f.call(cases, writerA, form(input, true))), created);
  expect(await f.call(cases, writerA, form({ ...input, suggestedDepartment: '更换内容' }, true)), 409);
  f.inspect(db => {
    const item = db.prepare('SELECT id, suggested_department FROM cases WHERE case_number = ?').get(created.caseNumber);
    assert.equal(item.suggested_department, input.suggestedDepartment);
    assert.equal(db.prepare('SELECT count(*) AS count FROM cases').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM attachments WHERE case_id = ?').get(item.id).count, 1);
  });
  outage = false;
  assert.deepEqual(expect(await f.call(receiptPath(number), writerA)), {
    ...old, wechatCode: { envVersion: 'trial', mediaType: 'image/png', base64: png.toString('base64') },
  });
  assert.deepEqual(scenes, [old.publicLookupCode, created.publicLookupCode, created.publicLookupCode, old.publicLookupCode]);
  assert.deepEqual(Object.keys(expect(await f.call('/api/v1/public/cases/' + old.publicLookupCode))).sort(),
    ['caseNumber', 'milestones', 'status']);
  const oldList = expect(await f.call(cases, otherA));
  assert.equal(oldList.items.length, 2);
  const existingDetail = expect(await f.call(cases + '/' + number, otherA));
  assert.doesNotMatch(JSON.stringify({ oldList, existingDetail }), /privateLookupToken|publicLookupCode|wechatCode|synthetic-contact-private/);
  for (const principal of [otherA, writerB]) {
    expect(await f.call(receiptPath(number), principal), 404);
    expect(await f.call(claim(number), principal), 404);
    expect(await f.call(claim(number) + '/actions', principal, { action: 'confirm_resolved', expectedVersion: 1 }), 404);
  }
  expect(await f.call(receiptPath(number), null), 401);
  expect(await f.call(receiptPath(number), 'x'.repeat(43)), 401);

  const action = '/api/v1/staff/cases/' + number + '/actions';
  expect(await f.call(action, desk, { action: 'accept', expectedVersion: 1 }));
  expect(await f.call(action, desk, { action: 'assign', expectedVersion: 2, assignee: handler.id, dueAt: at('11-10T00:00:00') }));
  expect(await f.call(action, handler, { action: 'start', expectedVersion: 3 }));
  expect(await f.call(action, handler, { action: 'submit_result', expectedVersion: 4, summary: '合成办理', photoOmissionReason: '合成理由' }));
  expect(await f.call(action, lead, form({ action: 'publish', expectedVersion: 5, summary: '合成反馈', derivativesReviewed: true }, true)));
  const customer = expect(await f.call(claim(number), writerA));
  assert.equal(customer.rounds[0].feedback.summary, '合成反馈');
  assert.doesNotMatch(JSON.stringify(customer), /ownerSessionToken|privateLookupToken|publicLookupCode|synthetic-contact-private|writer-a/);
  const thumbnail = claim(number) + '/feedback-photos/6/0';
  assert.equal(expect(await f.call(thumbnail, writerA, undefined, true)).length > 32, true);
  expect(await f.call(thumbnail, otherA), 404);
  expect(await f.call(claim(number) + '/actions', writerA, {
    action: 'evaluate', expectedVersion: 6, speed: 5, effectiveness: 4, attitude: 3,
  }));
  assert.equal(expect(await f.call(claim(number) + '/actions', writerA, {
    action: 'confirm_resolved', expectedVersion: 7,
  })).status, 'closed');
  expect(await f.call(claim(number) + '/actions', writerA, { action: 'request_reopen', expectedVersion: 8, reason: '合成补办' }));
  await f.stop();
  const changedTenant = { ...writerA, token: 'r'.repeat(43), merchantId: 'tenant-b' };
  await f.start({ merchants: [changedTenant, ...allMerchants.slice(1)] });
  expect(await f.call(receiptPath(number), writerA), 401);
  expect(await f.call(receiptPath(number), changedTenant), 404);
  expect(await f.call(claim(number), changedTenant), 404);
});

function addReportEvents(db, number, group, duplicateOf, responseAt = '11-03T08:00:00') {
  const id = db.prepare('SELECT id FROM cases WHERE case_number = ?').get(number).id;
  const add = (version, action, status, round, when = '11-03T08:00:00') => db.prepare(`
    INSERT INTO case_events (case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public, round)
    VALUES (?, ?, ?, ?, 'staff', 'desk', ?, '{}', 1, ?)
  `).run(id, version, action, status, at(when), round);
  if (group === 'reject') {
    db.prepare(`INSERT INTO case_events VALUES (?, 2, 'reject', 'rejected', 'staff', 'desk', ?, '{"reason":"test"}', 1, 1)`)
      .run(id, at('11-03T08:00:00'));
  }
  if (['high', 'low'].includes(group)) {
    add(2, 'accept', 'accepted', 1, responseAt);
    add(3, 'publish', 'awaiting_evaluation', 1);
    const score = group === 'high' ? 4 : 2;
    db.prepare('INSERT INTO case_evaluations VALUES (?, 1, ?, ?, ?, NULL, ?)').run(id, score, score, score, at('11-04T08:00:00'));
    if (group === 'low') add(4, 'approve_reopen', 'assigned', 2, '11-05T08:00:00');
  }
  db.prepare('INSERT INTO case_supervision_events VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, duplicateOf ? 'confirm' : 'classify', 'p', 'c', duplicateOf ?? null, '合成判重', 'desk', at('11-06T08:00:00'));
  return id;
}

test('固定互斥范围、冻结截点、代表已见工单剔除及联合小样本抑制经回环验证', async t => {
  const f = await fixture(t);
  const seed = async (merchant, group, index, duplicateOf) => {
    const submitted = expect(await f.call(cases, merchant, form({
      ...payload, clientRequestId: merchant.id + '-' + group + '-' + index,
    })), 201);
    return f.inspect(db => addReportEvents(db, submitted.caseNumber, group, duplicateOf));
  };
  expect(await f.call(report + '2026-11', repA), 404);
  expect(await f.call(report + '2026-11', writerA), 403);
  expect(await f.call(report + '2026-11', noScope), 403);
  expect(await f.call(report + '2026-11', null), 401);
  assert.deepEqual(expect(await f.call('/api/v1/merchant/me', noScope)).permissions, []);
  assert.deepEqual(expect(await f.call('/api/v1/merchant/me', repA2)).permissions, ['representativeReport']);
  f.clock('10-31T23:59:59');
  await seed(writerA, 'reject', 'previous-month');
  f.clock('11-01T00:00:00');
  const anchor = await seed(writerA, 'pending', 0);
  for (let index = 0; index < 5; index++) {
    await seed(writerA, 'high', index, anchor);
    await seed(writerA, 'low', index);
    if (index > 0) await seed(writerA, 'pending', index);
    await seed(writerB, 'high', index);
    await seed(writerB, 'low', index);
    await seed(writerB, 'pending', index);
  }
  // Each marginal in west has enough cases, but the single rejection is revealed by response/completion overlap.
  await seed(writerB, 'reject', 0);
  // If either already-visible case entered east, the same single-cell guard would suppress its release.
  await seed(repA, 'reject', 1);
  const viewed = await seed(writerA, 'reject', 2);
  f.inspect(db => db.prepare(`INSERT INTO collaboration_tasks
    (task_id, case_id, round, merchant_id, instructions, due_at, status, version)
    VALUES ('CT-' || '11111111111111111111111111111111', ?, 1, ?, '合成协办', ?, 'awaiting_submission', 1)`)
    .run(viewed, repA.merchantId, at('11-12T08:00:00')));
  await seed(outsider, 'reject', 0);
  f.clock('12-01T00:00:00');
  expect(await f.call(report + '2026-11&department=street', repA), 400);
  expect(await f.call(report + '2026-11&month=2026-10', repA), 400);
  expect(await f.call(report + '2026-11&asOf=2026-12-01', repA), 400);
  expect(await f.call(report + '2026-12', repA), 404);
  expect(await f.call(report + '2026-10', repA), 404);
  const east = expect(await f.call(report + '2026-11', repA));
  // All ten eastern responses occur Nov 3 at 08:00 after the Nov 1 at 00:00 submission.
  assert.equal((Date.parse(at('11-03T08:00:00')) - Date.parse(at('11-01T00:00:00'))) / 60000, 3360);
  assert.deepEqual(east, { month: '2026-11', metrics: {
    firstResponse: { status: 'available', band: 2 }, firstResponseDuration: { status: 'available', band: 2 },
    completion: { status: 'available', band: 2 },
    duplicateComplaints: { status: 'available', band: 1 }, satisfaction: { status: 'available', band: 2 },
  } });
  assert.deepEqual(expect(await f.call(report + '2026-11', repA2)), east);
  const west = expect(await f.call(report + '2026-11', repB));
  assert.deepEqual(Object.keys(west.metrics).sort(), Object.keys(east.metrics).sort());
  assert.deepEqual(Object.values(west.metrics), Array.from({ length: 5 }, () => ({ status: 'withheld' })));
  assert.doesNotMatch(JSON.stringify({ east, west }), /tenant|viewer|case|cutoff|timestamp|medianMinutes|"count"|"ratio"|合成|contact/i);

  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM representative_report_releases').get().n, 1);
    db.exec('UPDATE case_evaluations SET speed = 5, effectiveness = 5, attitude = 5');
    // An operator backfill would change both private report math and disclosure without an immutable release.
    db.prepare("DELETE FROM case_supervision_events WHERE action = 'confirm'").run();
  });
  f.clock('12-05T10:00:00');
  assert.deepEqual(expect(await f.call(report + '2026-11', repA)), east);
  assert.deepEqual(expect(await f.call(report + '2026-11', repB)), west);
  await f.stop();
  await f.start();
  assert.deepEqual(expect(await f.call(report + '2026-11', repA)), east);
  await f.stop();
  await f.start({ representativeReports: { ...settings, ranges: [{ id: 'east', merchantIds: ['tenant-a', 'viewer-a', 'tenant-b', 'viewer-b'] }] } });
  expect(await f.call(report + '2026-11', repA), 404);
  expect(await f.call(report + '2026-11', repB), 404);
  f.inspect(db => assert.equal(db.prepare('SELECT count(*) AS n FROM representative_report_releases').get().n, 1));
});

async function seedResponseDurations(f, merchant, values) {
  for (const [index, minutes] of values.entries()) {
    const item = expect(await f.call(cases, merchant, form({ ...payload, clientRequestId: merchant.id + '-response-' + index })), 201);
    if (minutes === null) continue;
    f.inspect(db => {
      const { id } = db.prepare('SELECT id FROM cases WHERE case_number = ?').get(item.caseNumber);
      const submittedAt = db.prepare('SELECT occurred_at FROM case_events WHERE case_id = ? AND version = 1').get(id).occurred_at;
      const respondedAt = new Date(Date.parse(submittedAt) + minutes * 60_000).toISOString();
      db.prepare(`INSERT INTO case_events VALUES (?, 2, 'accept', 'accepted', 'staff', 'desk', ?, '{}', 1, 1)`)
        .run(id, respondedAt);
    });
  }
}

test('中位首响区间在 60 与 1440 分钟边界使用管理月报的含端点口径', async t => {
  const f = await fixture(t);
  await seedResponseDurations(f, writerA, [60, 60, 60, 60, 60, null, null, null, null, null]);
  await seedResponseDurations(f, writerB, [1440, 1440, 1440, 1440, 1440, null, null, null, null, null]);
  f.clock('12-01T00:00:00');
  const east = expect(await f.call(report + '2026-11', repA));
  const west = expect(await f.call(report + '2026-11', repB));
  assert.deepEqual(east.metrics.firstResponseDuration, { status: 'available', band: 0 });
  assert.deepEqual(west.metrics.firstResponseDuration, { status: 'available', band: 1 });
  assert.deepEqual(east.metrics.firstResponse, { status: 'available', band: 2 });
  assert.deepEqual(west.metrics.firstResponse, { status: 'available', band: 2 });
});

test('时长小样本或跨档中位数仅抑制时长，覆盖仍可安全披露', async t => {
  const f = await fixture(t);
  const noResponse = [null, null, null, null, null];
  await seedResponseDurations(f, writerA, [0, 0, 0, 0, 0, 61, ...noResponse]);
  await seedResponseDurations(f, writerB, [1, 1, 1, 1, 1, 1441, 1441, 1441, 1441, 1441, ...noResponse]);
  f.clock('12-01T00:00:00');
  for (const principal of [repA, repB]) {
    const { metrics } = expect(await f.call(report + '2026-11', principal));
    assert.deepEqual(metrics.firstResponse, { status: 'available', band: 2 });
    assert.deepEqual(metrics.firstResponseDuration, { status: 'withheld' });
  }
});

test('时长单项分档人数已达阈值，但与完成和评价交叉的小组仍受到抑制', async t => {
  const f = await fixture(t);
  // Marginal duration groups: 7 short, 5 medium, 5 unanswered.
  // Crossing with completion splits the medium group into cells of 1 and 4.
  for (const [group, short, medium, total] of [['high', 5, 1, 6], ['low', 2, 4, 6], ['pending', 0, 0, 5]]) {
    assert.equal(group === 'pending' ? total : short + medium, total);
    for (let index = 0; index < total; index++) {
      const item = expect(await f.call(cases, writerA, form({
        ...payload, clientRequestId: 'joint-duration-' + group + '-' + index,
      })), 201);
      f.inspect(db => addReportEvents(db, item.caseNumber, group, null,
        index < short ? '11-01T00:10:00' : '11-01T01:11:00'));
    }
  }
  f.clock('12-01T00:00:00');
  const { metrics } = expect(await f.call(report + '2026-11', repA));
  for (const name of ['firstResponse', 'completion', 'satisfaction']) assert.equal(metrics[name].status, 'available');
  assert.deepEqual(metrics.firstResponseDuration, { status: 'withheld' });
});

test('旧冻结快照原样读取，返工后不得对同一已发布月份补算时长', async t => {
  const f = await fixture(t);
  const merchants = new Set(allMerchants.filter(item => item.permissions.includes('representativeReport')).map(item => item.merchantId));
  const { policyHash } = representativeReportConfig(settings, merchants);
  const metrics = { firstResponse: { status: 'available', band: 2 }, completion: { status: 'withheld' },
    satisfaction: { status: 'withheld' }, duplicateComplaints: { status: 'withheld' } };
  f.inspect(db => db.prepare('INSERT INTO representative_report_releases VALUES (?, ?, ?, ?)')
    .run('2026-11', policyHash, JSON.stringify({ east: metrics }), at('12-01T00:00:00')));
  await seedResponseDurations(f, writerA, [60, 60, 60, 60, 60, null, null, null, null, null]);
  f.clock('12-01T00:01:00');
  assert.deepEqual(expect(await f.call(report + '2026-11', repA)), { month: '2026-11', metrics });
});

test('配置拒绝重叠范围和过低样本阈值', () => {
  const options = { dbPath: ':memory:', receiptKey: Buffer.alloc(32), integrations: [{ source: 'synthetic', token: 'i'.repeat(43) }] };
  assert.throws(() => createIntakeServer({ ...options, representativeReports: { ...settings, minimumGroupSize: 4 } }),
    /Invalid representative report policy/);
  assert.throws(() => createIntakeServer({ ...options, representativeReports: { ...settings,
    ranges: [...settings.ranges, { id: 'overlap', merchantIds: ['tenant-a'] }],
  } }), /ranges must not overlap/);
});

test('制码在途时微信会话过期，已入库的原回执不会下发', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const old = expect(await f.call(cases, writerA, form(payload)), 201);
  await f.stop();
  let markStarted;
  let finishQr;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { finishQr = resolve; });
  await f.start({
    wechatLogin: {
      appId: 'wx1234567890abcdef', appSecret: 'SYNTHETIC_TEST_SECRET',
      bindings: [{ type: 'merchant', id: writerA.id, openid: 'synthetic-openid-writer-a' }],
      async fetchImpl() { return Response.json({ openid: 'synthetic-openid-writer-a', session_key: 'synthetic' }); },
    },
    wechatCode: {
      appId: 'wx1234567890abcdef', appSecret: 'SYNTHETIC_TEST_SECRET', envVersion: 'trial',
      async fetchImpl(url) {
        if (new URL(url).pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'synthetic', expires_in: 7200 });
        markStarted();
        await gate;
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      },
    },
  });
  const session = expect(await f.call('/api/v1/auth/wechat/session', null, { code: 'synthetic-login' })).sessionToken;
  expect(await f.call(receiptPath(old.caseNumber), writerA), 401);
  expect(await f.call(claim(old.caseNumber), session));
  const pending = f.call(receiptPath(old.caseNumber), session);
  try {
    await Promise.race([started, pending.then(result => assert.fail('QR was not requested: ' + result.status))]);
    f.clock('11-01T00:26:00');
  } finally {
    finishQr();
  }
  expect(await pending, 401);
  expect(await f.call(claim(old.caseNumber), session), 401);
  f.inspect(db => assert.equal(db.prepare('SELECT count(*) AS n FROM merchant_cases').get().n, 1));
});

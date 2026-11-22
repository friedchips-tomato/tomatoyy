// 一次性本地契约核对：启动后端实例，用合成数据建单，再用小程序查询模块
// 走一遍真实 HTTP。不使用真实凭据，不写生产数据，跑完即清理。
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const { queryPublicCase, extractPublicCode, verifyOwner, fetchOwnerCase, submitOwnerAction } =
  require(path.join(miniprogramRoot, 'pages/public/query.js'));

test('与真实后端实例的契约核对', async t => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { pathToFileURL } = require('node:url');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-contract-'));
  const receiptKey = randomBytes(32);
  const token = randomBytes(32).toString('base64url');
  const server = createIntakeServer({
    dbPath: path.join(directory, 'intake.sqlite'),
    receiptKey,
    integrations: [{ source: 'contract-check', token }],
    staff: [],
    merchants: []
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });

  // 用合成数据建单，取到真实公开码。
  const form = new FormData();
  form.append('payload', JSON.stringify({
    externalCaseId: 'contract-check-001',
    occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成契约核对地点',
    category: '街面维护',
    description: '合成契约核对正文'
  }));
  const created = await fetch(baseUrl + '/api/v1/integrations/intake/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();
  assert.match(receipt.publicLookupCode, /^[A-Za-z0-9_-]{24}$/);

  // 小程序侧请求封装：把 fetch 适配成 wx.request 的形状。
  const request = options => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
    fetch(options.url, { signal: controller.signal })
      .then(async response => {
        clearTimeout(timer);
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        options.success({ statusCode: response.status, data });
      })
      .catch(error => {
        clearTimeout(timer);
        options.fail({ errMsg: error.name === 'AbortError' ? 'request:fail timeout' : 'request:fail' });
      });
  };

  const found = await queryPublicCase({ request, baseUrl, code: receipt.publicLookupCode, timeout: 5000 });
  assert.equal(found.kind, 'success', JSON.stringify(found));
  assert.equal(found.caseNumber, receipt.caseNumber);
  assert.equal(found.statusText, '已提交');
  assert.ok(found.milestones.length >= 1);

  const missing = await queryPublicCase({ request, baseUrl, code: 'A'.repeat(24), timeout: 5000 });
  assert.equal(missing.kind, 'notfound');

  const invalid = await queryPublicCase({ request, baseUrl, code: 'short', timeout: 5000 });
  assert.equal(invalid.kind, 'invalid');

  // 从回执链接形态还原公开码，仍只得到码。
  const linked = extractPublicCode('https://example.test/scan?scene=c%3D' + receipt.publicLookupCode);
  assert.equal(linked, receipt.publicLookupCode);

  // 小程序路径形态同样只还原出码。
  const fromPath = extractPublicCode('/pages/public/index?scene=c%3D' + receipt.publicLookupCode);
  assert.equal(fromPath, receipt.publicLookupCode);
});

test('与真实后端实例的本人核验契约核对', async t => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { pathToFileURL } = require('node:url');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-owner-'));
  const receiptKey = randomBytes(32);
  const token = randomBytes(32).toString('base64url');
  const server = createIntakeServer({
    dbPath: path.join(directory, 'intake.sqlite'),
    receiptKey,
    integrations: [{ source: 'owner-check', token }],
    staff: [],
    merchants: []
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });

  const form = new FormData();
  form.append('payload', JSON.stringify({
    externalCaseId: 'owner-check-001',
    occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成核验地点',
    category: '街面维护',
    description: '合成核验正文'
  }));
  const created = await fetch(baseUrl + '/api/v1/integrations/intake/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();

  const request = options => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
    const init = { method: options.method || 'GET', signal: controller.signal };
    if (options.data !== undefined) {
      init.body = JSON.stringify(options.data);
      init.headers = { 'content-type': 'application/json' };
    }
    if (options.header) init.headers = { ...(init.headers || {}), ...options.header };
    fetch(options.url, init)
      .then(async response => {
        clearTimeout(timer);
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        options.success({ statusCode: response.status, data });
      })
      .catch(error => {
        clearTimeout(timer);
        options.fail({ errMsg: error.name === 'AbortError' ? 'request:fail timeout' : 'request:fail' });
      });
  };

  // 错误凭证被拒。
  const wrong = await verifyOwner({
    request,
    baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: 'x'.repeat(43),
    timeout: 5000
  });
  assert.equal(wrong.kind, 'unauthorized');

  // 正确凭证换取授权并取到详情。
  const ok = await verifyOwner({
    request,
    baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: receipt.privateLookupToken,
    timeout: 5000
  });
  assert.equal(ok.kind, 'success', JSON.stringify(ok));
  assert.equal(ok.caseNumber, receipt.caseNumber);
  assert.ok(ok.ownerSessionToken.startsWith('owner.'));

  const detail = await fetchOwnerCase({
    request,
    baseUrl,
    caseNumber: ok.caseNumber,
    ownerSessionToken: ok.ownerSessionToken,
    timeout: 5000
  });
  assert.equal(detail.kind, 'success', JSON.stringify(detail));
  assert.equal(detail.caseNumber, receipt.caseNumber);
  assert.equal(detail.round, 1);
  assert.equal(detail.statusText, '已提交');

  // 无授权取详情被拒。
  const noAuth = await fetchOwnerCase({
    request,
    baseUrl,
    caseNumber: ok.caseNumber,
    ownerSessionToken: '',
    timeout: 5000
  });
  assert.equal(noAuth.kind, 'unauthorized');
});


test('与真实后端实例的本人动作契约核对', async t => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { pathToFileURL } = require('node:url');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-action-'));
  const receiptKey = randomBytes(32);
  const integrationToken = randomBytes(32).toString('base64url');
  const dutyToken = randomBytes(32).toString('base64url');
  const handlerToken = randomBytes(32).toString('base64url');
  const leadToken = randomBytes(32).toString('base64url');
  const server = createIntakeServer({
    dbPath: path.join(directory, 'intake.sqlite'),
    receiptKey,
    integrations: [{ source: 'action-check', token: integrationToken }],
    staff: [
      { id: 'desk', role: 'duty', token: dutyToken },
      { id: 'handler-a', role: 'handler', department: 'street', token: handlerToken },
      { id: 'lead-a', role: 'supervisor', department: 'street', token: leadToken }
    ],
    merchants: []
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });

  const request = options => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
    const init = { method: options.method || 'GET', signal: controller.signal };
    if (options.data !== undefined) {
      init.body = JSON.stringify(options.data);
      init.headers = { 'content-type': 'application/json' };
    }
    if (options.header) init.headers = { ...(init.headers || {}), ...options.header };
    fetch(options.url, init)
      .then(async response => {
        clearTimeout(timer);
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        options.success({ statusCode: response.status, data });
      })
      .catch(error => {
        clearTimeout(timer);
        options.fail({ errMsg: error.name === 'AbortError' ? 'request:fail timeout' : 'request:fail' });
      });
  };

  const staffAct = async (token, action, expectedVersion, extra) => {
    const response = await fetch(baseUrl + '/api/v1/staff/cases/' + receipt.caseNumber + '/actions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action, expectedVersion, ...(extra || {}) })
    });
    return response;
  };

  const form = new FormData();
  form.append('payload', JSON.stringify({
    externalCaseId: 'action-check-001',
    occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成动作地点',
    category: '街面维护',
    description: '合成动作正文'
  }));
  const created = await fetch(baseUrl + '/api/v1/integrations/intake/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + integrationToken },
    body: form
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();

  const verified = await verifyOwner({
    request,
    baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: receipt.privateLookupToken,
    timeout: 5000
  });
  assert.equal(verified.kind, 'success');
  const sessionToken = verified.ownerSessionToken;

  // 已提交时本人没有可用动作。
  const early = await fetchOwnerCase({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken, timeout: 5000
  });
  assert.equal(early.kind, 'success');
  assert.equal(early.version, 1);
  assert.deepEqual(early.availableActions, [], '已提交时没有本人动作');

  // 推进到待评价：值班受理分派、承办接单送审、主管发布。
  assert.equal((await staffAct(dutyToken, 'accept', 1)).status, 200);
  assert.equal((await staffAct(dutyToken, 'assign', 2, {
    assignee: 'handler-a', dueAt: '2027-01-20T10:00:00+08:00'
  })).status, 200);
  assert.equal((await staffAct(handlerToken, 'start', 3)).status, 200);
  assert.equal((await staffAct(handlerToken, 'submit_result', 4, {
    summary: '合成承办说明', photoOmissionReason: '合成缺照原因'
  })).status, 200);
  assert.equal((await staffAct(leadToken, 'publish', 5, {
    summary: '已复核的处理说明'
  })).status, 200);

  // 待评价时本人动作齐全，已发布反馈可见。
  const ready = await fetchOwnerCase({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken, timeout: 5000
  });
  assert.equal(ready.kind, 'success');
  assert.deepEqual(ready.availableActions, ['evaluate', 'confirm_resolved', 'request_reopen']);
  assert.equal(ready.rounds[0].summary, '已复核的处理说明');
  assert.equal(ready.rounds[0].evaluated, false);

  // 错误版本应得 409，并被归类为冲突。
  const stale = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken,
    action: 'evaluate', expectedVersion: 99,
    payload: { speed: 5, effectiveness: 5, attitude: 5 }, timeout: 5000
  });
  assert.equal(stale.kind, 'conflict', JSON.stringify(stale));

  // 评分越界应被服务端拒绝。
  const badRating = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken,
    action: 'evaluate', expectedVersion: ready.version,
    payload: { speed: 9, effectiveness: 5, attitude: 5 }, timeout: 5000
  });
  assert.equal(badRating.kind, 'invalid', JSON.stringify(badRating));

  // 正常评价成功，返回更新后的本人详情。
  const evaluated = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken,
    action: 'evaluate', expectedVersion: ready.version,
    payload: { speed: 5, effectiveness: 4, attitude: 5, comment: '合成评价意见' }, timeout: 5000
  });
  assert.equal(evaluated.kind, 'success', JSON.stringify(evaluated));
  assert.equal(evaluated.data.rounds[0].evaluation.speed, 5);
  assert.equal(evaluated.data.rounds[0].evaluation.effectiveness, 4);
  assert.equal(evaluated.data.rounds[0].evaluation.attitude, 5);
  assert.equal(evaluated.data.rounds[0].evaluation.comment, '合成评价意见');

  // 评价后本人动作只剩确认解决与补办。
  const afterEvaluate = await fetchOwnerCase({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken, timeout: 5000
  });
  assert.deepEqual(afterEvaluate.availableActions, ['confirm_resolved', 'request_reopen']);

  // 确认解决后工单办结。
  const closed = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken,
    action: 'confirm_resolved', expectedVersion: afterEvaluate.version,
    payload: {}, timeout: 5000
  });
  assert.equal(closed.kind, 'success', JSON.stringify(closed));
  assert.equal(closed.data.status, 'closed');

  // 办结后仍可申请补办。
  const afterClosed = await fetchOwnerCase({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken, timeout: 5000
  });
  assert.ok(afterClosed.availableActions.includes('request_reopen'));
  const reopened = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken,
    action: 'request_reopen', expectedVersion: afterClosed.version,
    payload: { reason: '合成未解决说明' }, timeout: 5000
  });
  assert.equal(reopened.kind, 'success', JSON.stringify(reopened));
  assert.equal(reopened.data.status, 'reopen_pending');
  assert.equal(reopened.data.reopenRequests[0].reason, '合成未解决说明');
  assert.equal(reopened.data.reopenRequests[0].decision, null, '待审核时决定为空');
  // 页面用的是归一化后的详情，待审核显示为空串。
  const pendingDetail = await fetchOwnerCase({
    request, baseUrl, caseNumber: receipt.caseNumber,
    ownerSessionToken: sessionToken, timeout: 5000
  });
  assert.equal(pendingDetail.kind, 'success');
  assert.equal(pendingDetail.statusText, '补办待审核');
  assert.equal(pendingDetail.reopenRequests.length, 1);
  assert.equal(pendingDetail.reopenRequests[0].decision, '');
  assert.equal(pendingDetail.reopenRequests[0].reason, '合成未解决说明');
});

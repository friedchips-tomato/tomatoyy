// 本人文字补件（T05）与真实后端实例的契约核对：值班先提出补件要求，
// 再由小程序模块用本人授权提交补件，确认原单回到待受理。
// 不使用真实凭据，不写生产数据，跑完即清理。
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const miniprogramRoot = path.resolve(__dirname, '..');
const { verifyOwner, fetchOwnerCase, submitOwnerAction } =
  require(path.join(miniprogramRoot, 'pages/public/query.js'));

// 把 fetch 适配成 wx.request 的形状。
function makeRequest(timeout) {
  return options => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || timeout);
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
}

test('与真实后端实例的补件契约核对', async t => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-supplement-'));
  const dutyToken = randomBytes(32).toString('base64url');
  const integrationToken = randomBytes(32).toString('base64url');
  const server = createIntakeServer({
    dbPath: path.join(directory, 'intake.sqlite'),
    receiptKey: randomBytes(32),
    integrations: [{ source: 'supplement-check', token: integrationToken }],
    staff: [{ id: 'desk', role: 'duty', token: dutyToken }],
    merchants: []
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });

  // 用合成数据建单。
  const form = new FormData();
  form.append('payload', JSON.stringify({
    externalCaseId: 'supplement-check-001',
    occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成补件地点',
    category: '街面维护',
    description: '合成补件正文'
  }));
  const created = await fetch(baseUrl + '/api/v1/integrations/intake/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + integrationToken },
    body: form
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();

  // 值班提出补件要求。
  const requested = await fetch(baseUrl + '/api/v1/staff/cases/' + receipt.caseNumber + '/actions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + dutyToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'request_supplement', expectedVersion: 1, reason: '请补充问题发生的具体时段'
    })
  });
  assert.equal(requested.status, 200, await requested.text());

  const request = makeRequest(5000);
  const verified = await verifyOwner({
    request, baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: receipt.privateLookupToken,
    timeout: 5000
  });
  assert.equal(verified.kind, 'success', JSON.stringify(verified));

  // 本人详情显示待补充材料与补件要求。
  const detail = await fetchOwnerCase({
    request, baseUrl,
    caseNumber: verified.caseNumber,
    ownerSessionToken: verified.ownerSessionToken,
    timeout: 5000
  });
  assert.equal(detail.kind, 'success', JSON.stringify(detail));
  assert.equal(detail.status, 'awaiting_supplement');
  assert.equal(detail.statusText, '待补充材料');
  assert.ok(detail.availableActions.includes('submit_supplement'), '提供补件动作');
  assert.equal(detail.supplementRequirement.reason, '请补充问题发生的具体时段');
  assert.ok(detail.supplementRequirement.requestedAt, '给出提出时间');
  assert.equal(detail.version, 2);

  // 补件说明必填：空说明被服务端拒绝。
  const blank = await submitOwnerAction({
    request, baseUrl,
    caseNumber: verified.caseNumber,
    ownerSessionToken: verified.ownerSessionToken,
    action: 'submit_supplement',
    expectedVersion: 2,
    payload: { summary: '   ' },
    timeout: 5000
  });
  assert.notEqual(blank.kind, 'success');

  // 版本过期时返回冲突。
  const stale = await submitOwnerAction({
    request, baseUrl,
    caseNumber: verified.caseNumber,
    ownerSessionToken: verified.ownerSessionToken,
    action: 'submit_supplement',
    expectedVersion: 1,
    payload: { summary: '问题出现在上午十点左右' },
    timeout: 5000
  });
  assert.equal(stale.kind, 'conflict', JSON.stringify(stale));

  // 正常补件：原单回到待受理。
  const supplement = await submitOwnerAction({
    request, baseUrl,
    caseNumber: verified.caseNumber,
    ownerSessionToken: verified.ownerSessionToken,
    action: 'submit_supplement',
    expectedVersion: 2,
    payload: { summary: '问题出现在上午十点左右' },
    timeout: 5000
  });
  assert.equal(supplement.kind, 'success', JSON.stringify(supplement));
  assert.equal(supplement.data.status, 'submitted', '原单回到待受理');
  assert.equal(supplement.data.supplementRequirement, null, '补件要求已清除');
  assert.ok(!supplement.data.availableActions.includes('submit_supplement'));
  assert.equal(supplement.data.caseNumber, receipt.caseNumber, '编号不变');
  assert.equal(supplement.data.round, 1, '轮次不变');

  // 再次读取详情确认状态。
  const after = await fetchOwnerCase({
    request, baseUrl,
    caseNumber: verified.caseNumber,
    ownerSessionToken: verified.ownerSessionToken,
    timeout: 5000
  });
  assert.equal(after.statusText, '已提交');
  assert.equal(after.supplementRequirement, null);
});

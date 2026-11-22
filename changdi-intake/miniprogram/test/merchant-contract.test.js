// 商户窗口与真实后端实例的契约核对：启动后端，用合成商户账号建单并派协办，
// 再用小程序商户模块走一遍真实 HTTP。不使用真实凭据，不写生产数据，跑完即清理。
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const miniprogramRoot = path.resolve(__dirname, '..');
const {
  buildMerchantSubmission,
  fetchIdentity,
  fetchMerchantCases,
  fetchMerchantCase,
  fetchCollaborations,
  fetchCollaboration,
  submitCollaboration
} = require(path.join(miniprogramRoot, 'pages/merchant/merchant.js'));

const token = () => randomBytes(32).toString('base64url');

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

test('与真实后端实例的商户契约核对', async t => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-merchant-'));
  const merchantToken = token();
  const readerToken = token();
  const writerToken = token();
  const otherToken = token();
  const dutyToken = token();
  const supervisorToken = token();
  const server = createIntakeServer({
    dbPath: path.join(directory, 'intake.sqlite'),
    receiptKey: randomBytes(32),
    integrations: [{ source: 'merchant-contract', token: token() }],
    staff: [
      { id: 'desk', role: 'duty', token: dutyToken },
      { id: 'handler-a', role: 'handler', department: 'street', token: token() },
      { id: 'lead-a', role: 'supervisor', department: 'street', token: supervisorToken }
    ],
    merchants: [
      { id: 'shop-a-member', merchantId: 'shop-a', token: merchantToken, permissions: ['readCases', 'submitCases', 'collaborate'] },
      { id: 'shop-a-reader', merchantId: 'shop-a', token: readerToken, permissions: ['readCases'] },
      { id: 'shop-a-writer', merchantId: 'shop-a', token: writerToken, permissions: ['submitCases'] },
      { id: 'shop-b-member', merchantId: 'shop-b', token: otherToken, permissions: ['readCases', 'submitCases', 'collaborate'] }
    ]
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });

  const request = makeRequest(5000);
  const base = { request, baseUrl, timeout: 5000 };

  // 身份与授权由服务端给出。
  const identity = await fetchIdentity({ ...base, token: merchantToken });
  assert.equal(identity.kind, 'success', JSON.stringify(identity));
  assert.equal(identity.merchantId, 'shop-a');
  assert.deepEqual(identity.permissions.sort(), ['collaborate', 'readCases', 'submitCases']);

  // 其他角色的凭据不能当商户使用。
  const wrongRole = await fetchIdentity({ ...base, token: dutyToken });
  assert.equal(wrongRole.kind, 'forbidden');
  const noToken = await fetchIdentity({ ...base, token: '' });
  assert.equal(noToken.kind, 'unauthorized');

  // 商户提交一条工单：走小程序自己的 multipart 组装，与服务端解析口径一致。
  const submission = buildMerchantSubmission({
    clientRequestId: 'merchant-contract-001',
    occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成商户地点',
    category: '街面维护',
    description: '合成商户诉求正文'
  });
  assert.equal(submission.error, undefined);
  const created = await fetch(baseUrl + '/api/v1/merchant/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + merchantToken, 'content-type': submission.contentType },
    body: submission.body
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();
  assert.match(receipt.caseNumber, /^CD-[0-9A-F]{32}$/);
  assert.equal(receipt.status, 'submitted');

  // 同一请求号与同一内容重发：服务端按请求号去重，不另建工单。
  const repeated = await fetch(baseUrl + '/api/v1/merchant/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + merchantToken, 'content-type': submission.contentType },
    body: submission.body
  });
  assert.equal(repeated.status, 200, '同号同内容返回原工单');
  assert.deepEqual(await repeated.json(), receipt);

  // 同一请求号换内容：服务端拒绝，不覆盖已建工单。
  const changed = buildMerchantSubmission({
    clientRequestId: 'merchant-contract-001',
    occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成商户地点',
    category: '街面维护',
    description: '改了内容的诉求正文'
  });
  const conflicted = await fetch(baseUrl + '/api/v1/merchant/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + merchantToken, 'content-type': changed.contentType },
    body: changed.body
  });
  assert.equal(conflicted.status, 409);
  assert.equal((await conflicted.json()).error, 'submission_conflict');

  // 本商户工单列表可见，其他商户不可见。
  const list = await fetchMerchantCases({ ...base, token: merchantToken });
  assert.equal(list.kind, 'success', JSON.stringify(list));
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].caseNumber, receipt.caseNumber);
  assert.equal(list.items[0].statusLabel, '已提交');
  const otherList = await fetchMerchantCases({ ...base, token: otherToken });
  assert.deepEqual(otherList.items, [], '其他商户看不到本单');
  const readerList = await fetchMerchantCases({ ...base, token: readerToken });
  assert.equal(readerList.items.length, 1, '同商户其他成员可见');

  // 详情只返回本商户可见字段。
  const detail = await fetchMerchantCase({ ...base, token: merchantToken, caseNumber: receipt.caseNumber });
  assert.equal(detail.kind, 'success', JSON.stringify(detail));
  assert.equal(detail.detail.description, '合成商户诉求正文');
  assert.equal(detail.detail.statusLabel, '已提交');
  const foreign = await fetchMerchantCase({ ...base, token: otherToken, caseNumber: receipt.caseNumber });
  assert.equal(foreign.kind, 'notfound', '其他商户读详情被拒');

  // 受理后按状态筛选可用。
  await fetch(baseUrl + '/api/v1/staff/cases/' + receipt.caseNumber + '/actions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + dutyToken, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'accept', expectedVersion: 1 })
  });
  const accepted = await fetchMerchantCases({ ...base, token: merchantToken, status: 'accepted' });
  assert.equal(accepted.items.length, 1);
  const submitted = await fetchMerchantCases({ ...base, token: merchantToken, status: 'submitted' });
  assert.equal(submitted.items.length, 0);

  // 分派承办后追加协办任务给本商户。
  await fetch(baseUrl + '/api/v1/staff/cases/' + receipt.caseNumber + '/actions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + dutyToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'assign', expectedVersion: 2, assignee: 'handler-a', dueAt: '2027-01-20T10:00:00+08:00'
    })
  });
  const assigned = await fetch(baseUrl + '/api/v1/staff/cases/' + receipt.caseNumber + '/collaborations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + dutyToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: 3,
      merchantId: 'shop-a',
      instructions: '核查指定区域',
      location: '合成协办地点',
      dueAt: '2027-01-20T10:00:00+08:00'
    })
  });
  assert.equal(assigned.status, 201);
  const taskId = (await assigned.json()).taskId;

  // 协办待办只列获派商户。
  const tasks = await fetchCollaborations({ ...base, token: merchantToken });
  assert.equal(tasks.kind, 'success', JSON.stringify(tasks));
  assert.equal(tasks.items.length, 1);
  assert.equal(tasks.items[0].taskId, taskId);
  assert.equal(tasks.items[0].statusLabel, '待提交');
  assert.equal(tasks.items[0].version, 1);
  const otherTasks = await fetchCollaborations({ ...base, token: otherToken });
  assert.deepEqual(otherTasks.items, [], '其他商户看不到该任务');
  const readerTasks = await fetchCollaborations({ ...base, token: readerToken });
  assert.equal(readerTasks.kind, 'forbidden', '无协办权限被拒');

  // 协办详情含单独授权的信息，不含原单申报正文。
  const task = await fetchCollaboration({ ...base, token: merchantToken, taskId });
  assert.equal(task.kind, 'success', JSON.stringify(task));
  assert.equal(task.detail.location, '合成协办地点');
  assert.equal(task.detail.version, 1);
  assert.ok(!JSON.stringify(task.detail).includes('合成商户诉求正文'), '任务详情不含原单正文');

  // 文字送审按任务版本写入。
  const submittedTask = await submitCollaboration({
    ...base, token: merchantToken, taskId, expectedVersion: 1, summary: '合成现场说明'
  });
  assert.equal(submittedTask.kind, 'success', JSON.stringify(submittedTask));
  assert.equal(submittedTask.detail.status, 'awaiting_review');
  assert.equal(submittedTask.detail.version, 2);

  // 版本过期时返回冲突。
  const stale = await submitCollaboration({
    ...base, token: merchantToken, taskId, expectedVersion: 1, summary: '重复送审'
  });
  assert.equal(stale.kind, 'conflict', JSON.stringify(stale));

  // 空说明在客户端被拦下，不发请求。
  const blank = await submitCollaboration({
    ...base, token: merchantToken, taskId, expectedVersion: 2, summary: '   '
  });
  assert.equal(blank.kind, 'invalid');

  // 只可提交不能读取的商户：能拿到回执，但读不到工单内容。
  const writerSubmission = buildMerchantSubmission({
    clientRequestId: 'merchant-contract-writer-001',
    occurredAt: '2026-11-19T10:00:00+08:00',
    location: '合成只提交商户地点',
    category: '街面维护',
    description: '合成只提交商户诉求正文'
  });
  const writerCreated = await fetch(baseUrl + '/api/v1/merchant/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + writerToken, 'content-type': writerSubmission.contentType },
    body: writerSubmission.body
  });
  assert.equal(writerCreated.status, 201);
  const writerReceipt = await writerCreated.json();
  assert.match(writerReceipt.caseNumber, /^CD-[0-9A-F]{32}$/);
  assert.equal(writerReceipt.status, 'submitted');

  const writerList = await fetch(baseUrl + '/api/v1/merchant/cases', {
    headers: { Authorization: 'Bearer ' + writerToken }
  });
  assert.equal(writerList.status, 403, '无读取权限读不到工单列表');
  const writerDetail = await fetch(baseUrl + '/api/v1/merchant/cases/' + writerReceipt.caseNumber, {
    headers: { Authorization: 'Bearer ' + writerToken }
  });
  assert.equal(writerDetail.status, 403, '无读取权限读不到工单详情');
  const writerOther = await fetch(baseUrl + '/api/v1/merchant/cases/' + receipt.caseNumber, {
    headers: { Authorization: 'Bearer ' + writerToken }
  });
  assert.equal(writerOther.status, 403, '不越权读其他工单');
});

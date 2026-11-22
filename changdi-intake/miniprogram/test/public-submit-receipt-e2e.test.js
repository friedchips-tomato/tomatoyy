// 游客申报的「建议处理部门」与「微信小程序查询码」：真实 HTTP 端到端核对。
// 请求全部打到本机 loopback 上真实运行的后端实例，不 mock 业务结果。
// 微信侧上游用注入的 fetchImpl 造出合成图片，不访问真实微信接口，也不在本机伪造小程序码：
// 小程序码只由服务端按公开查询码向微信侧申请，本用例核对回执、校验与展示这一整条链路。
// 临时 SQLite 建在系统临时目录，用例结束即关服删库，不写仓库内文件。
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const miniprogramRoot = path.resolve(__dirname, '..');
const { submitCase } = require(path.join(miniprogramRoot, 'pages/submit/submit.js'));
const { queryPublicCase } = require(path.join(miniprogramRoot, 'pages/public/query.js'));
const receiptCode = require(path.join(miniprogramRoot, 'pages/submit/receipt-code.js'));

const TIMEOUT = 8000;
const APP_ID = 'wx1234567890abcdef';
const APP_SECRET = 'FAKE_SYNTHETIC_APP_SECRET_EXAMPLE';
const ACCESS_TOKEN = 'synthetic-access-token-01';

// 一张真实结构的 PNG：服务端按文件头尾签名识别图片，伪造的字节会被判不合格。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64'
);

// wx.request 的形状适配器：用 node fetch 实现，multipart 二进制直接当请求体。
function createRequestAdapter() {
  return options => {
    const controller = new AbortController();
    const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = {};
    for (const [key, value] of Object.entries(options.header || {})) headers[key] = value;
    const init = { method: options.method || 'GET', signal: controller.signal, headers };
    const data = options.data;
    if (data instanceof ArrayBuffer) init.body = data;
    else if (typeof data === 'string') init.body = data;
    else if (data !== undefined && data !== null) {
      init.body = JSON.stringify(data);
      if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
    fetch(options.url, init)
      .then(async response => {
        clearTimeout(timer);
        const text = await response.text();
        let parsed = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch { parsed = null; }
        }
        options.success({ statusCode: response.status, data: parsed });
      })
      .catch(error => {
        clearTimeout(timer);
        options.fail({
          errMsg: error.name === 'AbortError' ? 'request:fail timeout' : 'request:fail'
        });
      });
  };
}

// 合成一条上游访问记录，并断言场景值只有公开查询码。
function upstream({ envVersion = 'release' } = {}) {
  const calls = [];
  return {
    calls,
    config: {
      appId: APP_ID,
      appSecret: APP_SECRET,
      envVersion,
      timeoutMs: 2000,
      async fetchImpl(rawUrl, request) {
        const url = new URL(rawUrl);
        const body = JSON.parse(request.body);
        calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
        assert.equal(url.origin, 'https://api.weixin.qq.com');
        if (url.pathname === '/cgi-bin/stable_token') {
          return Response.json({ access_token: ACCESS_TOKEN, expires_in: 7200 });
        }
        assert.equal(url.pathname, '/wxa/getwxacodeunlimit');
        // 场景值只能是公开查询码：私密凭证不进二维码。
        assert.match(body.scene, /^[A-Za-z0-9_-]{24}$/);
        assert.equal(body.page, 'pages/public/index');
        assert.deepEqual(body, { scene: body.scene, page: 'pages/public/index',
          check_path: envVersion === 'release', env_version: envVersion });
        return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
      }
    }
  };
}

// 真实后端实例：临时目录 SQLite、随机 receiptKey、随机端口。
async function startServer(t, wechatCode) {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-public-receipt-'));
  const dbPath = path.join(directory, 'receipt.sqlite');
  const integrationToken = randomBytes(32).toString('base64url');
  const server = createIntakeServer({
    dbPath,
    receiptKey: randomBytes(32),
    integrations: [{ source: 'public-receipt', token: integrationToken }],
    staff: [],
    merchants: [],
    ...(wechatCode ? { wechatCode } : {})
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  return { baseUrl, dbPath, integrationToken };
}

// 数一数库里到底建了几单。用于核对制码失败降级时不会重复建单。
function countCases(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT COUNT(*) AS total FROM cases').get().total;
  } finally {
    db.close();
  }
}

// 合成一条游客诉求内容。
function payloadOf(clientRequestId, overrides = {}) {
  return {
    clientRequestId,
    occurredAt: '2026-11-21T09:30:00+08:00',
    location: '长堤风貌街合成地点',
    category: '街面维护',
    description: '合成建议部门诉求正文',
    ...overrides
  };
}

test('建议处理部门被服务端接受，并参与同一请求号的内容比对（真实 HTTP）', async t => {
  const { baseUrl } = await startServer(t);
  const request = createRequestAdapter();

  // 1. 带建议处理部门建单：201。
  const payload = payloadOf('pg-dept-0001', { suggestedDepartment: '市政管理单位' });
  const created = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.equal(created.created, true, '首次提交是新建');
  const receipt = created.receipt;
  assert.match(receipt.caseNumber, /^CD-[0-9A-F]{32}$/);
  assert.match(receipt.publicLookupCode, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(receipt.wechatCode, undefined, '未启用小程序码时回执里没有查询码');

  // 2. 同一请求号、同一内容重放：200，回执完全一致。
  const replay = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(replay.kind, 'success', JSON.stringify(replay));
  assert.equal(replay.created, false, '重放不是新建');
  assert.deepEqual(replay.receipt, receipt, '重放回执与首次完全一致');

  // 3. 同一请求号换了建议处理部门：409。这正是「改了内容再重试」会踩到的冲突，
  //    所以结果未知后的重试必须原样复用请求号、正文与照片。
  const conflict = await submitCase({
    request, baseUrl,
    payload: payloadOf('pg-dept-0001', { suggestedDepartment: '环境卫生管理所' }),
    files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(conflict.kind, 'conflict', JSON.stringify(conflict));

  // 4. 公开查询仍指向首个工单。
  const response = await fetch(baseUrl + '/api/v1/public/cases/' + receipt.publicLookupCode);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.caseNumber, receipt.caseNumber);
  assert.deepEqual(Object.keys(body).sort(), ['caseNumber', 'milestones', 'status'],
    '公开视图不含建议部门等申报内容');
});

test('启用微信小程序码时回执附带查询码，小程序端校验后展示（真实 HTTP）', async t => {
  const wx = upstream({ envVersion: 'trial' });
  const { baseUrl } = await startServer(t, wx.config);
  const request = createRequestAdapter();

  const created = await submitCase({
    request, baseUrl,
    payload: payloadOf('pg-wechat-0001', { suggestedDepartment: '市政管理单位' }),
    files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const receipt = created.receipt;
  assert.ok(receipt.wechatCode, '回执里带查询码');
  assert.deepEqual(Object.keys(receipt.wechatCode).sort(), ['base64', 'envVersion', 'mediaType']);
  assert.equal(receipt.wechatCode.envVersion, 'trial');
  assert.equal(receipt.wechatCode.mediaType, 'image/png');

  // 上游收到的场景值就是公开查询码，私密凭证不进二维码。
  const codeCall = wx.calls.find(call => call.path === '/wxa/getwxacodeunlimit');
  assert.ok(codeCall, '向微信侧申请过小程序码');
  assert.equal(codeCall.body.scene, receipt.publicLookupCode, '场景值只有公开查询码');
  assert.ok(!JSON.stringify(wx.calls).includes(receipt.privateLookupToken), '上游请求里没有私密凭证');

  // 小程序端按 OpenAPI 口径校验这份查询码。
  const normalized = receiptCode.normalizeWechatCode(receipt.wechatCode);
  assert.ok(normalized, '查询码通过校验');
  assert.equal(normalized.envVersion, 'trial');
  assert.equal(normalized.mediaType, 'image/png');
  assert.deepEqual(Buffer.from(normalized.bytes), PNG, '解出的就是上游给的图片字节');
  assert.ok(!Buffer.from(normalized.bytes).toString('utf8').includes(receipt.privateLookupToken),
    '图片字节里没有私密凭证');

  // 落盘文件名只用公开查询码。
  const name = receiptCode.receiptCodeFileName(receipt.publicLookupCode, 'image/png');
  assert.equal(name, 'receipt-code-' + receipt.publicLookupCode + '.png');
  assert.ok(!name.includes(receipt.privateLookupToken), '文件名里没有私密凭证');
});

test('未启用微信小程序码时回执仍可续取，小程序端降级为只显示公开码（真实 HTTP）', async t => {
  const { baseUrl } = await startServer(t);
  const request = createRequestAdapter();
  const payload = payloadOf('pg-wechat-off-0001');

  const created = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.equal(created.receipt.wechatCode, undefined, '没有查询码');
  // 回执三字段缺一不可，私密凭证照常下发。
  assert.deepEqual(
    Object.keys(created.receipt).sort(),
    ['caseNumber', 'privateLookupToken', 'publicLookupCode']
  );

  // 查询码缺失时降级：公开码与私密凭证仍在。
  const normalized = receiptCode.normalizeWechatCode(created.receipt.wechatCode);
  assert.equal(normalized, null, '缺失的查询码不展示');
  assert.ok(created.receipt.publicLookupCode, '公开码照常下发');
  assert.ok(created.receipt.privateLookupToken, '私密凭证照常下发');
});

// 微信侧上游：可以在「整段不可用」与「恢复正常」之间切换。
// 服务端在启动时固定了这个函数，因此切换靠闭包里的 healthy 标志，不靠替换函数。
function switchableUpstream() {
  const calls = [];
  const state = { healthy: false };
  return {
    calls,
    state,
    config: {
      appId: APP_ID,
      appSecret: APP_SECRET,
      envVersion: 'release',
      timeoutMs: 2000,
      async fetchImpl(rawUrl, request) {
        const url = new URL(rawUrl);
        calls.push({ path: url.pathname, body: JSON.parse(request.body) });
        if (!state.healthy) {
          // 微信侧直接回业务错误：制码不可用。
          return Response.json({ errcode: 45009, errmsg: 'api unauthorized' });
        }
        if (url.pathname === '/cgi-bin/stable_token') {
          return Response.json({ access_token: ACCESS_TOKEN, expires_in: 7200 });
        }
        return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
      }
    }
  };
}

test('制码失败时公开申报降级交付三字段，上游恢复后同号重试取回含码回执（真实 HTTP）', async t => {
  const wx = switchableUpstream();
  const { baseUrl, dbPath } = await startServer(t, wx.config);
  const request = createRequestAdapter();
  const payload = payloadOf('pg-degrade-0001', { suggestedDepartment: '市政管理单位' });

  // 1. 制码失败：仍然建单成功，回执给出三个标识字段，只是不带微信码。
  const created = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.equal(created.created, true, '工单已建成');
  assert.deepEqual(
    Object.keys(created.receipt).sort(),
    ['caseNumber', 'privateLookupToken', 'publicLookupCode'],
    '降级时只交付三个标识字段'
  );
  assert.equal(created.receipt.wechatCode, undefined, '降级时没有微信码');
  assert.match(created.receipt.publicLookupCode, /^[A-Za-z0-9_-]{24}$/, '公开码照常下发');
  assert.ok(created.receipt.privateLookupToken, '私密凭证照常下发');
  assert.equal(countCases(dbPath), 1, '只建了一单');

  // 2. 页面手动输码查询：用公开码能查到这张工单。
  const found = await queryPublicCase({
    request, baseUrl, code: created.receipt.publicLookupCode, timeout: TIMEOUT
  });
  assert.equal(found.kind, 'success', JSON.stringify(found));
  assert.equal(found.caseNumber, created.receipt.caseNumber, '手动输码能查到工单');
  assert.equal(found.statusText, '已提交');

  // 3. 同一请求号、同一内容重试：仍是同一张回执，不会再建一单。
  const replay = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(replay.kind, 'success', JSON.stringify(replay));
  assert.equal(replay.created, false, '重试不新建');
  assert.deepEqual(replay.receipt, created.receipt, '重试回执与首次完全一致');
  assert.equal(countCases(dbPath), 1, '重试后仍然只有一单');

  // 4. 上游恢复后，同号重试取到含微信码的回执。
  wx.state.healthy = true;
  const recovered = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(recovered.kind, 'success', JSON.stringify(recovered));
  assert.equal(recovered.created, false, '上游恢复后重试不新建');
  assert.deepEqual(
    Object.keys(recovered.receipt).sort(),
    ['caseNumber', 'privateLookupToken', 'publicLookupCode', 'wechatCode'],
    '上游恢复后回执带微信码'
  );
  assert.equal(recovered.receipt.wechatCode.mediaType, 'image/png');
  assert.equal(recovered.receipt.wechatCode.envVersion, 'release');
  assert.deepEqual(recovered.receipt.caseNumber, created.receipt.caseNumber, '仍是同一张工单');
  assert.equal(countCases(dbPath), 1, '全程只建了一单');

  // 5. 小程序端按 OpenAPI 口径校验这份恢复后的查询码。
  const normalized = receiptCode.normalizeWechatCode(recovered.receipt.wechatCode);
  assert.ok(normalized, '恢复后的查询码通过校验');
  assert.deepEqual(Buffer.from(normalized.bytes), PNG, '解出的就是上游给的图片字节');
});

test('合作方接单接口的 503 契约保持不变（真实 HTTP）', async t => {
  const wx = switchableUpstream();
  const { baseUrl, dbPath, integrationToken } = await startServer(t, wx.config);

  const form = new FormData();
  form.append('payload', JSON.stringify({
    externalCaseId: 'partner-degrade-0001',
    occurredAt: '2026-11-21T09:30:00+08:00',
    location: '长堤风貌街合成地点',
    category: '街面维护',
    description: '合成合作方申报正文'
  }));
  const response = await fetch(baseUrl + '/api/v1/integrations/intake/cases', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + integrationToken },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT)
  });
  assert.equal(response.status, 503, '合作方接口仍返回 503');
  assert.equal(response.headers.get('retry-after'), '1', '仍带 Retry-After');
  const body = await response.json();
  assert.deepEqual(body, { error: 'wechat_code_unavailable' }, '错误码不变');
  assert.equal(countCases(dbPath), 1, '合作方这一单已保存');
});

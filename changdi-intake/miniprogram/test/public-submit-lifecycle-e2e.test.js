// 游客公开申报「受理 → 分派 → 办理 → 反馈 → 评价 → 办结」全流程的真实 HTTP 端到端验收。
// 请求全部打到本机 loopback 上真实运行的后端实例，不 mock 任何业务结果。
// 临时 SQLite 建在系统临时目录，用例结束即关服删库，不写仓库内文件。
//
// 与 public-submit-e2e.test.js 的分工：那一支只覆盖「提交 → 回执 → 公开查询 → 本人核验」，
// 本用例从公开申报出发，把管理方受理、分派、承办、复核发布与本人评价、办结串成一条完整链路，
// 并在每个节点核对公众视图的可见范围。
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

const miniprogramRoot = path.resolve(__dirname, '..');
const { submitCase } = require(path.join(miniprogramRoot, 'pages/submit/submit.js'));
const { queryPublicCase, verifyOwner, fetchOwnerCase, submitOwnerAction } =
  require(path.join(miniprogramRoot, 'pages/public/query.js'));

const TIMEOUT = 8000;

// 后端时钟的起点与推进点。期限与评价期断言都钉在这两个时刻上，
// 推进时钟后期限状态与公示时间戳都会随之变化。
const CLOCK_START = '2026-11-19T02:00:00.000Z';
const CLOCK_LATER = '2026-11-20T04:00:00.000Z';
// 办理期限：相对 CLOCK_START 往后 48 小时，推进到 CLOCK_LATER 后落在临期区间。
const DUE_AT = '2026-11-21T02:00:00.000Z';
// 评价期与补办申请期，与后端默认口径一致，这里显式写出以便断言。
const EVALUATION_SECONDS = 7 * 86400;
const REOPEN_SECONDS = 30 * 86400;

// —— 造真实图片字节 ——
// 小程序端与服务端都按文件头尾签名识别图片类型，伪造签名的假图会被判 415。
// 这里用 zlib 现场编出结构完整的真 PNG（IHDR/IDAT/IEND 与 CRC 齐全）。
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function realPng(width, height, seed) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // 位深 8 位
  header[9] = 2;  // 真彩色
  header[10] = 0; // 压缩方式
  header[11] = 0; // 滤波方式
  header[12] = 0; // 非隔行
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // 每行前置滤波字节
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = (seed + x * 7) & 0xff;
      raw[at + 1] = (seed + y * 11) & 0xff;
      raw[at + 2] = (seed * 3) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// —— wx 兼容的 request 适配器 ——
// 用 node fetch 实现 wx.request 的形状：成功回调带 {statusCode, data}，失败回调带 errMsg。
// options.data 是 ArrayBuffer 时直接当请求体（multipart 二进制），否则按 JSON 序列化。
function createRequestAdapter() {
  return options => {
    const controller = new AbortController();
    const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = {};
    for (const [key, value] of Object.entries(options.header || {})) headers[key] = value;
    const init = { method: options.method || 'GET', signal: controller.signal, headers };
    const data = options.data;
    if (data instanceof ArrayBuffer) {
      init.body = data;
    } else if (typeof data === 'string') {
      init.body = data;
    } else if (data !== undefined && data !== null) {
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
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
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

// —— wx.getFileSystemManager().readFile 桩 ——
// 只按路径返回事先准备好的真实图片字节，其余一概读失败。
function installWxFiles(t, files) {
  global.wx = {
    getFileSystemManager: () => ({
      readFile: options => {
        const bytes = files.get(options.filePath);
        if (!bytes) {
          options.fail({ errMsg: 'readFile:fail no such file' });
          return;
        }
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        options.success({ data: arrayBuffer });
      }
    })
  };
  t.after(() => {
    delete global.wx;
  });
}

// 把图片字节转成小程序 photos 模块认识的 {path, length} 列表。
function photoFiles(files, paths) {
  return paths.map(itemPath => ({ path: itemPath, length: files.get(itemPath).length }));
}

// —— 真实后端实例 ——
// 临时目录 SQLite、随机 receiptKey、监听 127.0.0.1:0 随机端口，
// now 是一个可推进的闭包，期限与评价期断言都基于它。
async function startServer(t) {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-public-lifecycle-'));
  let clock = new Date(CLOCK_START);
  const now = () => clock;
  const tokens = {
    duty: randomBytes(32).toString('base64url'),
    handler: randomBytes(32).toString('base64url'),
    supervisor: randomBytes(32).toString('base64url')
  };
  const server = createIntakeServer({
    dbPath: path.join(directory, 'lifecycle.sqlite'),
    receiptKey: randomBytes(32),
    now,
    evaluationSeconds: EVALUATION_SECONDS,
    reopenSeconds: REOPEN_SECONDS,
    // 后端 createAuth 要求 integrations 非空（空数组直接抛 Invalid identity configuration），
    // 这里给一个不参与本用例的合成集成身份；被测的公开接口是匿名的，不受影响。
    integrations: [{ source: 'public-lifecycle', token: randomBytes(32).toString('base64url') }],
    staff: [
      { id: 'desk', role: 'duty', token: tokens.duty },
      { id: 'handler', role: 'handler', department: 'street', token: tokens.handler },
      { id: 'supervisor', role: 'supervisor', department: 'street', token: tokens.supervisor }
    ],
    merchants: []
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  return { baseUrl, tokens, setClock: value => { clock = new Date(value); }, now };
}

// —— 直连后端的裸请求 ——
// 管理方与本人链路不走小程序封装，直接按后端契约发请求，返回状态码与已解析的 JSON。
async function call(baseUrl, pathname, { method = 'GET', auth, body } = {}) {
  const headers = {};
  if (auth) headers.Authorization = 'Bearer ' + auth;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(baseUrl + pathname, {
    method, headers, body, signal: AbortSignal.timeout(TIMEOUT)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

// 管理方动作：普通动作走 JSON，附照片的动作走 multipart（payload + photos 两个 part）。
function staffActionForm(payload, bytes) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  form.append('photos', new Blob([bytes], { type: 'image/png' }), 'synthetic.png');
  return form;
}

// 造一份合法的游客诉求内容。
function payloadOf(clientRequestId, overrides = {}) {
  return {
    clientRequestId,
    occurredAt: '2026-11-19T09:30:00+08:00',
    location: '长堤风貌街合成地点',
    category: '街面维护',
    description: '合成全流程诉求正文',
    ...overrides
  };
}

test('主链路：游客申报 → 受理 → 分派 → 办理 → 复核发布 → 评价 → 办结（真实 HTTP）', async t => {
  const { baseUrl, tokens, setClock } = await startServer(t);
  const request = createRequestAdapter();
  // 三张互不相同的真实 PNG：游客上传件、承办处理留痕件、复核发布件。
  // 发布件必须与既有照片字节不同，否则后端按 feedback_original_not_allowed 拒绝。
  const visitorPhoto = realPng(9, 7, 21);
  const handlerPhoto = realPng(11, 6, 53);
  const feedbackPhoto = realPng(13, 9, 97);
  const photos = new Map([['wxfile://lifecycle/visitor-1.png', visitorPhoto]]);
  installWxFiles(t, photos);

  const payload = payloadOf('pg-lifecycle-main-0001', { contact: '13800001111' });

  // 1. 游客提交：走小程序提交页逻辑，带 1 张真实 PNG，拿到回执。
  const created = await submitCase({
    request, baseUrl, payload,
    files: photoFiles(photos, ['wxfile://lifecycle/visitor-1.png']),
    timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.equal(created.created, true, '首次提交是新建');
  const receipt = created.receipt;
  assert.match(receipt.caseNumber, /^CD-[0-9A-F]{32}$/, '工单号格式正确');
  assert.match(receipt.publicLookupCode, /^[A-Za-z0-9_-]{24}$/, '公开码 24 位');
  assert.match(receipt.privateLookupToken, /^[A-Za-z0-9_-]{43}$/, '私密凭证 43 位');

  const staffPath = '/api/v1/staff/cases/' + receipt.caseNumber;
  const publicPath = '/api/v1/public/cases/' + receipt.publicLookupCode;

  // 公开视图核对：状态推进到指定节点，且任何时候都不外泄正文、联系方式、地点与照片地址。
  async function publicView(expectedStatus) {
    const response = await call(baseUrl, publicPath);
    assert.equal(response.status, 200);
    assert.equal(response.json.status, expectedStatus, '公开状态符合预期');
    assert.deepEqual(Object.keys(response.json).sort(), ['caseNumber', 'milestones', 'status'],
      '公开视图只有编号、状态与节点');
    assert.ok(!response.text.includes(payload.description), '公开视图不含问题描述');
    assert.ok(!response.text.includes(payload.contact), '公开视图不含联系方式');
    assert.ok(!response.text.includes(payload.location), '公开视图不含发生地点');
    assert.ok(!Object.keys(response.json).some(key => /photo|image|attachment/i.test(key)),
      '公开视图不含照片字段');
    assert.ok(!/https?:\/\//.test(response.text), '公开视图不含任何照片地址');
    return response.json;
  }

  // 2. 管理方待办里能看到这张单，来源映射为 public。
  const pending = await call(baseUrl, '/api/v1/staff/cases?queue=pending_intake', { auth: tokens.duty });
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.json.items.map(item => item.caseNumber), [receipt.caseNumber]);
  assert.equal(pending.json.items[0].sourceType, 'public', '工单列表里来源显示为 public');
  const workbench = await call(baseUrl, '/api/v1/staff/workbench', { auth: tokens.duty });
  assert.equal(workbench.status, 200);
  assert.equal(workbench.json.counts.pending_intake, 1, '工作台待受理计数为 1');

  // 3. 公众视角：已提交。
  const submitted = await publicView('submitted');
  assert.equal(submitted.milestones.length, 1);
  assert.equal(submitted.milestones[0].occurredAt, CLOCK_START);

  // 4. 值班受理。
  const accepted = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.duty, body: { action: 'accept', expectedVersion: 1 }
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.status, 'accepted');
  assert.equal(accepted.json.sourceType, 'public', '工单详情里来源仍是 public');
  assert.equal(accepted.json.version, 2);
  await publicView('accepted');

  // 5. 分派给承办人并设期限。
  const assigned = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.duty,
    body: { action: 'assign', expectedVersion: accepted.json.version, assignee: 'handler', dueAt: DUE_AT }
  });
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal(assigned.json.status, 'assigned');
  assert.equal(assigned.json.assignee, 'handler');
  assert.equal(assigned.json.department, 'street');
  assert.equal(assigned.json.dueAt, DUE_AT);
  await publicView('assigned');

  // 6. 推进后端时钟：期限从从容变成临期，公示时间戳随之变化。
  setClock(CLOCK_LATER);
  const dueList = await call(baseUrl, '/api/v1/staff/cases?status=assigned', { auth: tokens.duty });
  assert.equal(dueList.status, 200);
  const listed = dueList.json.items.find(item => item.caseNumber === receipt.caseNumber);
  assert.ok(listed, '已分派队列里能找到这张单');
  assert.equal(listed.sourceType, 'public', '工单列表里来源显示为 public');
  assert.equal(listed.assignee, 'handler');
  assert.equal(listed.dueAt, DUE_AT);
  assert.equal(listed.deadlineState, 'due_soon', '推进时钟后期限状态变为临期');

  // 7. 承办人接单。
  const processing = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.handler,
    body: { action: 'start', expectedVersion: assigned.json.version }
  });
  assert.equal(processing.status, 200, processing.text);
  assert.equal(processing.json.status, 'processing');
  await publicView('processing');

  // 8. 承办人提交处理结果（说明 + 照片）。承办动作必须带照片，走 multipart。
  const draft = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.handler,
    body: staffActionForm({
      action: 'submit_result', expectedVersion: processing.json.version, summary: '合成承办处理说明'
    }, handlerPhoto)
  });
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.json.status, 'awaiting_review');
  // 承办结果不进公开节点，公开视图仍停在处理中。
  const afterDraft = await publicView('processing');
  assert.ok(!afterDraft.milestones.some(item => item.status === 'awaiting_review'),
    '待复核节点不向公众公示');

  // 9. 主管侧能看到处理说明与照片。
  const review = await call(baseUrl, staffPath, { auth: tokens.supervisor });
  assert.equal(review.status, 200, review.text);
  assert.equal(review.json.description, payload.description, '管理方可见诉求正文');
  const submittedEvent = review.json.history.find(item => item.action === 'submit_result');
  assert.ok(submittedEvent, '工单历史里有承办提交记录');
  assert.equal(submittedEvent.detail.summary, '合成承办处理说明', '处理说明可见');
  assert.ok(Array.isArray(review.json.submissionPhotos), '管理方详情带处理照片清单');
  assert.equal(review.json.submissionPhotos.length, 1);
  assert.equal(review.json.submissionPhotos[0].submitVersion, draft.json.version);

  const submissionPhoto = await fetch(
    baseUrl + staffPath + '/submission-photos/' + draft.json.version + '/0',
    { headers: { Authorization: 'Bearer ' + tokens.supervisor }, signal: AbortSignal.timeout(TIMEOUT) }
  );
  assert.equal(submissionPhoto.status, 200);
  assert.equal(submissionPhoto.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await submissionPhoto.arrayBuffer()), handlerPhoto,
    '处理照片字节与上传一致');
  // 值班没有查看处理照片的权限。
  const dutyPhoto = await fetch(
    baseUrl + staffPath + '/submission-photos/' + draft.json.version + '/0',
    { headers: { Authorization: 'Bearer ' + tokens.duty }, signal: AbortSignal.timeout(TIMEOUT) }
  );
  assert.equal(dutyPhoto.status, 403);

  // 10. 主管复核发布（说明 + 复核件）。发布件必须与既有照片字节不同。
  const published = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.supervisor,
    body: staffActionForm({
      action: 'publish', expectedVersion: draft.json.version,
      summary: '合成复核反馈说明', derivativesReviewed: true
    }, feedbackPhoto)
  });
  assert.equal(published.status, 200, published.text);
  assert.equal(published.json.status, 'awaiting_evaluation');
  assert.equal(published.json.evaluationEndsAt,
    new Date(Date.parse(CLOCK_LATER) + EVALUATION_SECONDS * 1000).toISOString(), '评价期按发布时刻起算');
  assert.equal(published.json.reopenEndsAt,
    new Date(Date.parse(CLOCK_LATER) + REOPEN_SECONDS * 1000).toISOString(), '补办申请期按发布时刻起算');
  const afterPublish = await publicView('awaiting_evaluation');
  assert.deepEqual(afterPublish.milestones.map(item => item.status),
    ['submitted', 'accepted', 'assigned', 'processing', 'awaiting_evaluation']);

  // 11. 本人核验：私密凭证换取授权。
  const verified = await verifyOwner({
    request, baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: receipt.privateLookupToken,
    timeout: TIMEOUT
  });
  assert.equal(verified.kind, 'success', JSON.stringify(verified));
  assert.equal(verified.caseNumber, receipt.caseNumber);
  assert.ok(verified.ownerSessionToken.startsWith('owner.'), '拿到本人会话凭证');
  const ownerToken = verified.ownerSessionToken;

  // 12. 本人详情：看得到已发布反馈与反馈照片。
  const detail = await fetchOwnerCase({
    request, baseUrl, caseNumber: receipt.caseNumber, ownerSessionToken: ownerToken, timeout: TIMEOUT
  });
  assert.equal(detail.kind, 'success', JSON.stringify(detail));
  assert.equal(detail.status, 'awaiting_evaluation');
  assert.equal(detail.statusText, '待评价');
  assert.ok(detail.availableActions.includes('evaluate'), '本人可评价');
  assert.ok(detail.availableActions.includes('confirm_resolved'), '本人可确认解决');
  assert.equal(detail.rounds.length, 1);
  assert.equal(detail.rounds[0].summary, '合成复核反馈说明', '本人看得到已发布反馈');
  assert.equal(detail.rounds[0].evaluated, false);
  assert.equal(detail.feedbackPhotos.length, 1, '本人看得到反馈照片');
  assert.equal(detail.feedbackPhotos[0].mediaType, 'image/png');

  const ownerRaw = await call(baseUrl, '/api/v1/owner/cases/' + receipt.caseNumber, { auth: ownerToken });
  assert.equal(ownerRaw.status, 200);
  assert.ok(!Object.keys(ownerRaw.json).some(key => /contact|phone|mobile/i.test(key)),
    '本人详情不下发联系方式字段');

  const feedbackImage = await fetch(
    baseUrl + '/api/v1/owner/cases/' + receipt.caseNumber + '/feedback-photos/' + detail.feedbackPhotos[0].key,
    { headers: { Authorization: 'Bearer ' + ownerToken }, signal: AbortSignal.timeout(TIMEOUT) }
  );
  assert.equal(feedbackImage.status, 200);
  assert.equal(feedbackImage.headers.get('content-type'), 'image/png');
  const feedbackBytes = Buffer.from(await feedbackImage.arrayBuffer());
  assert.deepEqual(feedbackBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    '反馈照片是合法 PNG');
  assert.ok(feedbackBytes.length >= 45);

  // 13. 三维评价，1–5 分。
  const scores = { speed: 5, effectiveness: 4, attitude: 5, comment: '合成评价留言' };
  const evaluated = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber, ownerSessionToken: ownerToken,
    action: 'evaluate', expectedVersion: detail.version, payload: scores, timeout: TIMEOUT
  });
  assert.equal(evaluated.kind, 'success', JSON.stringify(evaluated));
  assert.equal(evaluated.data.version, detail.version + 1);
  assert.equal(evaluated.data.status, 'awaiting_evaluation', '评价后仍在待评价');
  // 评价动作不向公众公示节点。
  const afterEvaluate = await publicView('awaiting_evaluation');
  assert.equal(afterEvaluate.milestones.length, afterPublish.milestones.length, '评价不新增公开节点');

  // 14. 确认解决，工单办结。
  const closed = await submitOwnerAction({
    request, baseUrl, caseNumber: receipt.caseNumber, ownerSessionToken: ownerToken,
    action: 'confirm_resolved', expectedVersion: evaluated.data.version, timeout: TIMEOUT
  });
  assert.equal(closed.kind, 'success', JSON.stringify(closed));
  assert.equal(closed.data.status, 'closed');

  // 15. 公众视角最终显示已办结。
  const finalView = await publicView('closed');
  assert.deepEqual(finalView.milestones.map(item => item.status),
    ['submitted', 'accepted', 'assigned', 'processing', 'awaiting_evaluation', 'closed'],
    '公开节点按受理到办结逐个推进');
  assert.equal(finalView.milestones[0].occurredAt, CLOCK_START);
  assert.equal(finalView.milestones[3].occurredAt, CLOCK_LATER, '推进时钟后的节点用新时刻');
  assert.equal(finalView.milestones.at(-1).occurredAt, CLOCK_LATER);

  // 小程序公开查询页读到的状态文案与原始接口一致。
  const queried = await queryPublicCase({
    request, baseUrl, code: receipt.publicLookupCode, timeout: TIMEOUT
  });
  assert.equal(queried.kind, 'success', JSON.stringify(queried));
  assert.equal(queried.caseNumber, receipt.caseNumber);
  assert.equal(queried.statusText, '已办结');
});

test('负向：无令牌与错误令牌访问管理方工单被拒，跨工单私密凭证核验失败（真实 HTTP）', async t => {
  const { baseUrl, tokens } = await startServer(t);
  const request = createRequestAdapter();
  const photos = new Map([
    ['wxfile://lifecycle/negative-1.png', realPng(8, 8, 13)],
    ['wxfile://lifecycle/negative-2.png', realPng(10, 6, 29)]
  ]);
  installWxFiles(t, photos);

  async function submit(name, photoPath) {
    const result = await submitCase({
      request, baseUrl,
      payload: payloadOf('pg-lifecycle-' + name, { description: '合成负向场景诉求正文 ' + name }),
      files: photoFiles(photos, [photoPath]),
      timeout: TIMEOUT, isCurrent: () => true
    });
    assert.equal(result.kind, 'success', JSON.stringify(result));
    assert.equal(result.created, true);
    return result.receipt;
  }

  const first = await submit('negative-a', 'wxfile://lifecycle/negative-1.png');
  const second = await submit('negative-b', 'wxfile://lifecycle/negative-2.png');
  const staffPath = '/api/v1/staff/cases/' + first.caseNumber;

  // 1. 不带令牌访问管理方工单：401。
  const anonymous = await call(baseUrl, staffPath);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, 'unauthorized');

  // 2. 带一个不存在的令牌：401。
  const wrongToken = await call(baseUrl, staffPath, { auth: randomBytes(32).toString('base64url') });
  assert.equal(wrongToken.status, 401);
  assert.equal(wrongToken.json.error, 'unauthorized');

  // 3. 令牌有效但角色不对：403。先把工单派给承办人，让承办人看得到这张单。
  const accepted = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.duty, body: { action: 'accept', expectedVersion: 1 }
  });
  assert.equal(accepted.status, 200, accepted.text);
  const assigned = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.duty,
    body: { action: 'assign', expectedVersion: accepted.json.version, assignee: 'handler', dueAt: DUE_AT }
  });
  assert.equal(assigned.status, 200, assigned.text);

  const handlerAccept = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.handler,
    body: { action: 'accept', expectedVersion: assigned.json.version }
  });
  assert.equal(handlerAccept.status, 403, '承办人不能受理');
  assert.equal(handlerAccept.json.error, 'forbidden');

  const dutyPublish = await call(baseUrl, staffPath + '/actions', {
    method: 'POST', auth: tokens.duty,
    body: { action: 'publish', expectedVersion: assigned.json.version, summary: '越权发布' }
  });
  assert.equal(dutyPublish.status, 403, '值班不能复核发布');
  assert.equal(dutyPublish.json.error, 'forbidden');

  // 4. 用另一张工单的私密凭证核验本单：核验失败。
  const crossed = await verifyOwner({
    request, baseUrl,
    publicLookupCode: first.publicLookupCode,
    privateLookupToken: second.privateLookupToken,
    timeout: TIMEOUT
  });
  assert.equal(crossed.kind, 'unauthorized', JSON.stringify(crossed));

  // 5. 核验失败不影响本人正常核验与查询。
  const verified = await verifyOwner({
    request, baseUrl,
    publicLookupCode: first.publicLookupCode,
    privateLookupToken: first.privateLookupToken,
    timeout: TIMEOUT
  });
  assert.equal(verified.kind, 'success', JSON.stringify(verified));
  const detail = await fetchOwnerCase({
    request, baseUrl, caseNumber: first.caseNumber, ownerSessionToken: verified.ownerSessionToken, timeout: TIMEOUT
  });
  assert.equal(detail.kind, 'success', JSON.stringify(detail));
  assert.equal(detail.status, 'assigned');

  // 6. 本人详情不带授权：401。
  const ownerAnonymous = await call(baseUrl, '/api/v1/owner/cases/' + first.caseNumber);
  assert.equal(ownerAnonymous.status, 401);
});

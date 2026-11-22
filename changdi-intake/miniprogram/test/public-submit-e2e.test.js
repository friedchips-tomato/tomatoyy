// 游客诉求「提交 → 回执 → 公开查询 → 本人核验」的真实 HTTP 端到端用例。
// 请求全部打到本机 loopback 上真实运行的后端实例，不 mock 业务结果。
// 临时 SQLite 建在系统临时目录，用例结束即关服删库，不写仓库内文件。
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
const { queryPublicCase, verifyOwner, fetchOwnerCase } =
  require(path.join(miniprogramRoot, 'pages/public/query.js'));

const TIMEOUT = 8000;
// 后端 publicRateLimit 的默认新建上限（windowSeconds 默认 600）。
const RATE_LIMIT = 10;

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
// 临时目录 SQLite、随机 receiptKey、监听 127.0.0.1:0 随机端口。
async function startServer(t) {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-public-e2e-'));
  const server = createIntakeServer({
    dbPath: path.join(directory, 'intake.sqlite'),
    receiptKey: randomBytes(32),
    // 后端 createAuth 要求 integrations 非空（空数组直接抛 Invalid identity configuration），
    // 这里给一个不参与本用例的合成集成身份；被测的公开接口是匿名的，不受影响。
    integrations: [{ source: 'public-e2e', token: randomBytes(32).toString('base64url') }],
    staff: [],
    merchants: []
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  return { baseUrl };
}

// 造一份合法的游客诉求内容。
function payloadOf(clientRequestId, overrides = {}) {
  return {
    clientRequestId,
    occurredAt: '2026-11-21T09:30:00+08:00',
    location: '长堤风貌街合成地点',
    category: '街面维护',
    description: '合成端到端诉求正文',
    ...overrides
  };
}

test('主链路：带两张照片提交 → 回执 → 公开查询 → 本人核验（真实 HTTP）', async t => {
  const { baseUrl } = await startServer(t);
  const request = createRequestAdapter();
  const photos = new Map([
    ['wxfile://e2e/photo-1.png', realPng(8, 8, 11)],
    ['wxfile://e2e/photo-2.png', realPng(12, 9, 77)]
  ]);
  installWxFiles(t, photos);
  const files = photoFiles(photos, ['wxfile://e2e/photo-1.png', 'wxfile://e2e/photo-2.png']);
  const payload = payloadOf('pg-e2e-main-0001', { contact: '13800000000' });

  // 1. 新建：回执三字段齐全且格式正确。
  const created = await submitCase({
    request, baseUrl, payload, files, timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.equal(created.created, true, '首次提交是新建');
  const receipt = created.receipt;
  assert.match(receipt.caseNumber, /^CD-[0-9A-F]{32}$/, '工单号格式正确');
  assert.match(receipt.publicLookupCode, /^[A-Za-z0-9_-]{24}$/, '公开码 24 位');
  assert.match(receipt.privateLookupToken, /^[A-Za-z0-9_-]{43}$/, '私密凭证 43 位');

  // 2. 同一请求号、同一内容重放：仍是成功，但不是新建，回执完全一致。
  const replay = await submitCase({
    request, baseUrl, payload, files, timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(replay.kind, 'success', JSON.stringify(replay));
  assert.equal(replay.created, false, '重放不是新建');
  assert.deepEqual(replay.receipt, receipt, '重放回执与首次完全一致');

  // 3. 公开查询：编号一致、状态已提交、至少一个节点。
  const found = await queryPublicCase({
    request, baseUrl, code: receipt.publicLookupCode, timeout: TIMEOUT
  });
  assert.equal(found.kind, 'success', JSON.stringify(found));
  assert.equal(found.caseNumber, receipt.caseNumber);
  assert.equal(found.statusText, '已提交');
  assert.ok(found.milestones.length >= 1, '至少一个公开节点');

  // 4. 直接看公开查询的原始 JSON：只有三个公开字段，正文与照片都不外泄。
  const rawResponse = await fetch(baseUrl + '/api/v1/public/cases/' + receipt.publicLookupCode);
  assert.equal(rawResponse.status, 200);
  const rawText = await rawResponse.text();
  const raw = JSON.parse(rawText);
  assert.deepEqual(Object.keys(raw).sort(), ['caseNumber', 'milestones', 'status'],
    '公开视图只有编号、状态与节点');
  assert.ok(!rawText.includes(payload.description), '公开视图不含问题描述');
  assert.ok(!rawText.includes(payload.contact), '公开视图不含联系方式');
  assert.ok(!rawText.includes(payload.location), '公开视图不含发生地点');
  assert.ok(!Object.keys(raw).some(key => /photo|image|attachment/i.test(key)), '公开视图不含照片字段');
  assert.ok(!/https?:\/\//.test(rawText), '公开视图不含任何照片地址');

  // 5. 本人核验：私密凭证换取授权，再凭授权取本人详情。
  const verified = await verifyOwner({
    request, baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: receipt.privateLookupToken,
    timeout: TIMEOUT
  });
  assert.equal(verified.kind, 'success', JSON.stringify(verified));
  assert.equal(verified.caseNumber, receipt.caseNumber);
  assert.ok(verified.ownerSessionToken.startsWith('owner.'), '拿到本人会话凭证');

  const detail = await fetchOwnerCase({
    request, baseUrl,
    caseNumber: verified.caseNumber,
    ownerSessionToken: verified.ownerSessionToken,
    timeout: TIMEOUT
  });
  assert.equal(detail.kind, 'success', JSON.stringify(detail));
  assert.equal(detail.caseNumber, receipt.caseNumber, '本人详情工单号一致');
  assert.equal(detail.statusText, '已提交');

  // 本人详情若返回联系方式，必须与提交时一致；当前后端未在本人详情里下发联系方式。
  const ownerRaw = await fetch(baseUrl + '/api/v1/owner/cases/' + receipt.caseNumber, {
    headers: { Authorization: 'Bearer ' + verified.ownerSessionToken }
  });
  assert.equal(ownerRaw.status, 200);
  const ownerJson = await ownerRaw.json();
  if (Object.hasOwn(ownerJson, 'contact')) {
    assert.equal(ownerJson.contact, payload.contact, '本人详情可见联系方式');
  } else {
    assert.ok(!Object.keys(ownerJson).some(key => /contact|phone|mobile/i.test(key)),
      '本人详情未下发联系方式时不出现其他联系方式字段');
  }

  // 6. 错误私密凭证：401 归一化为 unauthorized。
  const wrong = await verifyOwner({
    request, baseUrl,
    publicLookupCode: receipt.publicLookupCode,
    privateLookupToken: 'x'.repeat(43),
    timeout: TIMEOUT
  });
  assert.equal(wrong.kind, 'unauthorized', JSON.stringify(wrong));
});

test('冲突与无照片：同号改内容报冲突，新号零照片仍可建单并查询', async t => {
  const { baseUrl } = await startServer(t);
  const request = createRequestAdapter();
  const photos = new Map();
  installWxFiles(t, photos);

  // 首次建单（无照片）。
  const payload = payloadOf('pg-e2e-conflict-0001', { contact: '13900000001' });
  const first = await submitCase({
    request, baseUrl, payload, files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(first.kind, 'success', JSON.stringify(first));
  assert.equal(first.created, true);
  assert.match(first.receipt.publicLookupCode, /^[A-Za-z0-9_-]{24}$/);
  assert.match(first.receipt.privateLookupToken, /^[A-Za-z0-9_-]{43}$/);

  // 同一请求号换描述：服务端拒绝，归一化为 conflict。
  const conflict = await submitCase({
    request, baseUrl,
    payload: payloadOf('pg-e2e-conflict-0001', {
      contact: '13900000001',
      description: '换了内容的诉求正文'
    }),
    files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(conflict.kind, 'conflict', JSON.stringify(conflict));

  // 另一个全新请求号、0 张照片：仍能建单，回执可用。
  const second = await submitCase({
    request, baseUrl,
    payload: payloadOf('pg-e2e-nophoto-0002', { description: '无照片的诉求正文' }),
    files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(second.kind, 'success', JSON.stringify(second));
  assert.equal(second.created, true);
  assert.match(second.receipt.caseNumber, /^CD-[0-9A-F]{32}$/);

  const found = await queryPublicCase({
    request, baseUrl, code: second.receipt.publicLookupCode, timeout: TIMEOUT
  });
  assert.equal(found.kind, 'success', JSON.stringify(found));
  assert.equal(found.caseNumber, second.receipt.caseNumber, '回执可用：公开码能查到工单');
  assert.equal(found.statusText, '已提交');
});

// 限流场景：先在窗口内建满上限，再用已成功的请求号重放。
async function runRateLimitScenario(request, baseUrl) {
  const receipts = [];
  for (let index = 0; index < RATE_LIMIT; index += 1) {
    const result = await submitCase({
      request, baseUrl,
      payload: payloadOf('pg-e2e-rate-' + index, { description: '限流场景诉求正文 ' + index }),
      files: [], timeout: TIMEOUT, isCurrent: () => true
    });
    assert.equal(result.kind, 'success', JSON.stringify(result));
    receipts.push(result.receipt);
  }
  return receipts;
}

test('限流与幂等互不干扰：窗口内建满上限后重放已成功的请求号仍返回原回执（真实 HTTP）', async t => {
  const { baseUrl } = await startServer(t);
  const request = createRequestAdapter();
  installWxFiles(t, new Map());

  // 窗口内建满默认上限（10 次新建）。
  const receipts = await runRateLimitScenario(request, baseUrl);
  assert.equal(receipts.length, RATE_LIMIT);

  // 上限已满：换个全新的请求号仍然会被限流拒绝，说明限流确实在生效。
  const overLimit = await submitCase({
    request, baseUrl,
    payload: payloadOf('pg-e2e-rate-over-limit'),
    files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(overLimit.kind, 'limited', JSON.stringify(overLimit));

  // 但重放一个已经成功的请求号仍然拿到原回执，不被限流拦下，也不新建工单。
  const replay = await submitCase({
    request, baseUrl,
    payload: payloadOf('pg-e2e-rate-0', { description: '限流场景诉求正文 0' }),
    files: [], timeout: TIMEOUT, isCurrent: () => true
  });
  assert.equal(replay.kind, 'success', JSON.stringify(replay));
  assert.equal(replay.created, false, '重放不是新建');
  assert.deepEqual(replay.receipt, receipts[0], '重放返回原回执');

  // 限流拒绝与重放都没有破坏已有工单：公开查询仍指向首个工单。
  const found = await queryPublicCase({
    request, baseUrl, code: receipts[0].publicLookupCode, timeout: TIMEOUT
  });
  assert.equal(found.kind, 'success', JSON.stringify(found));
  assert.equal(found.caseNumber, receipts[0].caseNumber);
});

// 商户新诉求可选照片的本地检查：选图、随文一次提交、冻结重试与落库核对。
// 只用合成图片，不访问真实图片、真实凭据或外部网络；回环验证只连本机服务。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const miniprogramRoot = path.resolve(__dirname, '..');
const merchantModule = require(path.join(miniprogramRoot, 'pages/merchant/merchant.js'));
const photosModule = require(path.join(miniprogramRoot, 'pages/merchant/photos.js'));

const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const TOKEN = 'merchant_photo_token_0123456789abcdefghijklmnopqrstuvwxyz';

// 合成图片：1×1 PNG 与一张最小 JPEG，字节来自本地固定串，不含真实照片内容。
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64');
const jpegBytes = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z',
  'base64');

const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

// 模拟 wx.chooseMedia 与 wx.getFileSystemManager，只读写内存里的合成文件。
function createEnvironment(options = {}) {
  const calls = [];
  const picks = [];
  const reads = [];
  const files = new Map();
  let page = null;
  const modulePath = path.join(miniprogramRoot, 'pages/merchant/index.js');
  delete require.cache[require.resolve(modulePath)];
  global.Page = definition => { page = definition; };
  global.wx = {
    request: request => {
      calls.push(request);
      const url = request.url;
      if (url.endsWith('/api/v1/merchant/me')) {
        request.success({
          statusCode: 200,
          data: { merchantId: 'shop-a', permissions: ['readCases', 'submitCases'] }
        });
        return;
      }
      if (request.method === 'POST' && url.endsWith('/api/v1/merchant/cases')) {
        (options.submit || (value => value.success({
          statusCode: 201,
          data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
        })))(request);
        return;
      }
      request.success({ statusCode: 200, data: { items: [], nextBefore: null } });
    },
    chooseMedia: request => picks.push(request),
    getFileSystemManager: () => ({
      readFile: request => {
        reads.push(request);
        const data = files.get(request.filePath);
        if (!data) {
          request.fail({ errMsg: 'readFile:fail' });
          return;
        }
        request.success({ data: arrayBuffer(data) });
      }
    }),
    navigateBack: () => {}
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  return { page, calls, picks, reads, files };
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// 选图：先记录 picker 调用，再回填选中的临时文件。
async function pick(page, picks, files) {
  const pending = page.onChoosePhotos();
  const picker = picks.at(-1);
  assert.ok(picker, '调用了 wx.chooseMedia');
  assert.equal(picker.count, 3, '最多选 3 张');
  assert.deepEqual(picker.mediaType, ['image']);
  picker.success({ tempFiles: [...files].map(([path, size]) => ({ tempFilePath: path, size })) });
  await pending;
}

// 填入一份合成诉求内容。
function fillForm(page, overrides = {}) {
  page.setData({
    formDate: '2026-11-19',
    formTime: '09:00',
    formLocation: '合成商户地点',
    formCategory: '街面维护',
    formDescription: '合成商户诉求正文',
    formContact: '',
    ...overrides
  });
}

async function login(page) {
  page.onLoad({});
  page.onLoginSubmit({ detail: { value: { token: TOKEN } } });
  await tick();
  await tick();
}

// 按请求头声明的边界真实解析 multipart 请求体。
async function readMultipart(call) {
  const contentType = call.header['content-type'] || call.header['Content-Type'];
  assert.match(contentType, /^multipart\/form-data; boundary=/, '请求头声明 multipart 边界');
  assert.ok(call.data instanceof ArrayBuffer, '请求体是二进制');
  const form = await new Response(call.data, { headers: { 'Content-Type': contentType } }).formData();
  return { form, contentType };
}

async function readPayload(call) {
  const { form } = await readMultipart(call);
  const parts = form.getAll('payload');
  assert.equal(parts.length, 1, '请求体含且仅含一个 payload part');
  return JSON.parse(parts[0]);
}

async function readPhotos(call) {
  const { form } = await readMultipart(call);
  const files = form.getAll('photos');
  return Promise.all(files.map(async file => ({
    name: file.name,
    type: file.type,
    size: file.size,
    bytes: Buffer.from(await file.arrayBuffer())
  })));
}

test('选择照片后与正文一次提交：multipart 带照片字节，图片逐字节比对', async () => {
  const env = createEnvironment();
  const { page, calls, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    files.set('/synthetic.jpg', jpegBytes);
    await login(page);
    await pick(page, picks, [['/synthetic.png', pngBytes.length], ['/synthetic.jpg', jpegBytes.length]]);
    assert.equal(page.data.photoCount, 2, '显示已选张数');

    fillForm(page);
    await page.onSubmitNewCase();
    await tick();

    const call = calls.find(entry => entry.method === 'POST');
    assert.ok(call, '发出一次提交请求');
    assert.equal(calls.filter(entry => entry.method === 'POST').length, 1, '照片与正文一次提交，不另发请求');
    assert.match(call.header['content-type'], /^multipart\/form-data; boundary=/);

    // 正文文本 part。
    const payload = await readPayload(call);
    assert.match(payload.clientRequestId, /^mp-/);
    assert.equal(payload.description, '合成商户诉求正文');
    assert.equal(payload.location, '合成商户地点');

    // 照片 part 与原始字节逐字节比对。
    const photos = await readPhotos(call);
    assert.equal(photos.length, 2);
    assert.deepEqual(photos.map(photo => photo.type), ['image/png', 'image/jpeg']);
    assert.deepEqual(photos[0].bytes, pngBytes, 'PNG 字节与原文件一致');
    assert.deepEqual(photos[1].bytes, jpegBytes, 'JPEG 字节与原文件一致');
    assert.equal(photos[0].size, pngBytes.length);
    assert.equal(photos[1].size, jpegBytes.length);
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
    assert.equal(page.data.photoCount, 0, '提交成功后清空已选照片');
  } finally {
    restoreGlobals();
  }
});

test('不选照片时仍可提交：请求体只有 payload 文本 part', async () => {
  const env = createEnvironment();
  const { page, calls } = env;
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const call = calls.find(entry => entry.method === 'POST');
    assert.ok(call);
    const payload = await readPayload(call);
    assert.equal(payload.description, '合成商户诉求正文');
    assert.deepEqual(await readPhotos(call), [], '没有照片 part');
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('非图片类型的文件被本地拦下，请求不发出', async () => {
  const env = createEnvironment();
  const { page, calls, picks, files } = env;
  try {
    const text = Buffer.from('这不是图片');
    files.set('/not-an-image.txt', text);
    await login(page);
    await pick(page, picks, [['/not-an-image.txt', text.length]]);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, '请求未发出');
    assert.equal(page.data.submitPending, false, '不进入未知结果状态');
    assert.match(page.data.submitMessage, /JPEG|PNG|WebP/);
  } finally {
    restoreGlobals();
  }
});

test('本地读取失败时请求不发出，用户可以修正后重提', async () => {
  const env = createEnvironment();
  const { page, calls, picks, files } = env;
  try {
    await login(page);
    await pick(page, picks, [['/missing.png', pngBytes.length]]);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, '请求未发出');
    assert.equal(page.data.submitPending, false, '本地读取失败不算结果未知');
    assert.match(page.data.submitMessage, /无法读取/);

    // 换成可读文件后可以重提。
    files.set('/missing.png', pngBytes);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 1, '修正后发出请求');
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('未知结果后冻结请求号、字段与首次发出的照片字节', async () => {
  const attempts = [];
  const env = createEnvironment({
    submit: request => {
      attempts.push(request);
      if (attempts.length === 1) {
        request.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      request.success({
        statusCode: 200,
        data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
      });
    }
  });
  const { page, calls, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    await login(page);
    await pick(page, picks, [['/synthetic.png', pngBytes.length]]);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.match(page.data.submitMessage, /结果未知/);
    assert.equal(page.data.submitPending, true, '进入待确认状态');
    const first = calls.find(call => call.method === 'POST');
    const requestId = page.data.submitRequestId;

    // 未确认前不得换图、清图或改字段。
    await pick(page, picks, [['/synthetic.jpg', jpegBytes.length]]);
    assert.equal(page.data.photoCount, 1, '未确认前不能换图');
    assert.match(page.data.submitMessage, /不能更换照片/);
    page.onClearPhotos();
    assert.equal(page.data.photoCount, 1, '未确认前不能清图');
    page.onFormDescriptionInput({ detail: { value: '改过的正文' } });
    assert.equal(page.data.formDescription, '合成商户诉求正文', '未确认前不能改字段');

    // 重试重发同一份字节：请求号、字段、照片字节都不变。
    await page.onSubmitNewCase();
    await tick();
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2, '重试发出一次请求');
    const second = await readPayload(posts[1]);
    assert.equal(second.clientRequestId, requestId, '重试沿用同一请求号');
    assert.equal(second.description, '合成商户诉求正文');
    const firstPhotos = await readPhotos(posts[0]);
    const secondPhotos = await readPhotos(posts[1]);
    assert.equal(secondPhotos.length, 1);
    assert.deepEqual(secondPhotos[0].bytes, firstPhotos[0].bytes, '重试重发同一张照片字节');
    assert.deepEqual(secondPhotos[0].bytes, pngBytes);
    assert.equal(page.data.submitPending, false, '确认成功后解除锁定');
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('关闭会话清空临时数据，并保留结果未确认提示', async () => {
  const env = createEnvironment({
    submit: request => request.fail({ errMsg: 'request:fail' })
  });
  const { page, calls, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    await login(page);
    await pick(page, picks, [['/synthetic.png', pngBytes.length]]);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitPending, true);

    page.onHide();
    assert.equal(page._token, '', '令牌已清除');
    assert.equal(page._draft, null, '草稿已清除');
    assert.equal(page._frozen, null, '冻结的照片字节已清除');
    assert.deepEqual(page._pickedFiles, [], '已选照片已清除');
    assert.match(page.data.loginError, /未确认/);
    assert.match(page.data.loginError, /工单列表/);
  } finally {
    restoreGlobals();
  }
});

test('超过 3 张或超大文件在客户端被挡下', async () => {
  const env = createEnvironment();
  const { page, calls, picks } = env;
  try {
    await login(page);
    const pending = page.onChoosePhotos();
    const picker = picks.at(-1);
    picker.success({
      tempFiles: [
        { tempFilePath: '/a.png', size: 10 },
        { tempFilePath: '/b.png', size: 10 },
        { tempFilePath: '/c.png', size: 10 },
        { tempFilePath: '/d.png', size: 10 }
      ]
    });
    await pending;
    assert.equal(page.data.photoCount, 0, '超过 3 张不采纳');
    assert.match(page.data.submitMessage, /3/);

    const oversized = page.onChoosePhotos();
    picks.at(-1).success({ tempFiles: [{ tempFilePath: '/big.png', size: 5 * 1024 * 1024 + 1 }] });
    await oversized;
    assert.equal(page.data.photoCount, 0, '超大文件不采纳');
  } finally {
    restoreGlobals();
  }
});

test('服务端明确拒绝时解除锁定，照片可重新选择', async () => {
  const env = createEnvironment({
    submit: request => request.success({ statusCode: 400, data: { error: 'invalid_field' } })
  });
  const { page, calls, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    files.set('/synthetic.jpg', jpegBytes);
    await login(page);
    await pick(page, picks, [['/synthetic.png', pngBytes.length]]);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitPending, false, '明确拒绝不锁定');
    assert.equal(page._frozen, null, '明确拒绝不冻结字节');

    // 换一张照片后可以重新提交，并按新的照片内容换请求号。
    await pick(page, picks, [['/synthetic.jpg', jpegBytes.length]]);
    assert.equal(page.data.photoCount, 1);
    const second = page.onSubmitNewCase();
    await tick();
    await second;
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2);
    const firstPayload = await readPayload(posts[0]);
    const secondPayload = await readPayload(posts[1]);
    assert.notEqual(secondPayload.clientRequestId, firstPayload.clientRequestId, '照片变了换请求号');
    const photos = await readPhotos(posts[1]);
    assert.equal(photos.length, 1);
    assert.deepEqual(photos[0].bytes, jpegBytes, '重发的是新选的照片');
  } finally {
    restoreGlobals();
  }
});

test('回环真实服务：带照片的新诉求确实落库，重试不重复建单', async () => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { randomBytes } = await import('node:crypto');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-merchant-photos-'));
  const dbPath = path.join(directory, 'intake.sqlite');
  const merchantToken = randomBytes(32).toString('base64url');
  const server = createIntakeServer({
    dbPath,
    receiptKey: randomBytes(32),
    integrations: [{ source: 'merchant-photos-contract', token: randomBytes(32).toString('base64url') }],
    staff: [{ id: 'desk', role: 'duty', token: randomBytes(32).toString('base64url') }],
    merchants: [
      { id: 'shop-a-member', merchantId: 'shop-a', token: merchantToken, permissions: ['readCases', 'submitCases'] }
    ]
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    // 用小程序自己的组装模块生成 multipart，再真的发给本机服务。
    const submission = merchantModule.buildMerchantSubmission({
      clientRequestId: 'merchant-photos-contract-001',
      occurredAt: '2026-11-19T09:00:00+08:00',
      location: '合成商户地点',
      category: '街面维护',
      description: '带照片的合成诉求正文',
      photos: [
        { mediaType: 'image/png', bytes: new Uint8Array(pngBytes) },
        { mediaType: 'image/jpeg', bytes: new Uint8Array(jpegBytes) }
      ]
    });
    assert.equal(submission.error, undefined);

    const created = await fetch(origin + '/api/v1/merchant/cases', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + merchantToken, 'content-type': submission.contentType },
      body: submission.body
    });
    assert.equal(created.status, 201, '带照片建单成功');
    const receipt = await created.json();
    assert.match(receipt.caseNumber, /^CD-[0-9A-F]{32}$/);
    assert.equal(receipt.status, 'submitted');

    // 同一请求号、同一内容与同一照片字节重发：不重复建单，返回原回执。
    const repeated = await fetch(origin + '/api/v1/merchant/cases', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + merchantToken, 'content-type': submission.contentType },
      body: submission.body
    });
    assert.equal(repeated.status, 200, '同号同内容同照片返回原工单');
    assert.deepEqual(await repeated.json(), receipt);

    // 同一请求号换一张照片：服务端判定内容冲突，不覆盖已建工单。
    const changed = merchantModule.buildMerchantSubmission({
      clientRequestId: 'merchant-photos-contract-001',
      occurredAt: '2026-11-19T09:00:00+08:00',
      location: '合成商户地点',
      category: '街面维护',
      description: '带照片的合成诉求正文',
      photos: [{ mediaType: 'image/png', bytes: new Uint8Array(pngBytes) }]
    });
    const conflicted = await fetch(origin + '/api/v1/merchant/cases', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + merchantToken, 'content-type': changed.contentType },
      body: changed.body
    });
    assert.equal(conflicted.status, 409);
    assert.equal((await conflicted.json()).error, 'submission_conflict');

    // 落库核对：照片字节真的写进了附件表。
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT media_type AS mediaType, size, bytes FROM attachments ORDER BY position').all();
    db.close();
    assert.equal(rows.length, 2, '两张照片都落库');
    assert.deepEqual(rows.map(row => row.mediaType), ['image/png', 'image/jpeg']);
    assert.deepEqual(Buffer.from(rows[0].bytes), pngBytes, '落库的 PNG 字节与发送的一致');
    assert.deepEqual(Buffer.from(rows[1].bytes), jpegBytes, '落库的 JPEG 字节与发送的一致');
    assert.equal(rows[0].size, pngBytes.length);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('photos 模块的口径与文档一致', () => {
  assert.equal(photosModule.maxPhotos, 3, '最多 3 张');
  assert.equal(photosModule.maxPhotoBytes, 5 * 1024 * 1024, '每张 5 MiB');
  assert.equal(photosModule.maxBodyBytes, 3 * 5 * 1024 * 1024 + 64 * 1024, '整包 15 MiB + 64 KiB');
  assert.equal(photosModule.mediaType(new Uint8Array(pngBytes)), 'image/png');
  assert.equal(photosModule.mediaType(new Uint8Array(jpegBytes)), 'image/jpeg');
  assert.equal(photosModule.mediaType(new Uint8Array(Buffer.from('不是图片'))), '', '非图片不认');
});

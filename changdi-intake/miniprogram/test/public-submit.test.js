// 游客诉求提交页的本地模拟检查：字段校验、multipart 载荷、回执与私密凭证保护、
// 重试去重、错误提示与防双击。用 Node 模拟 wx，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const submitModule = require(path.join(miniprogramRoot, 'pages/submit/submit.js'));
const { apiEnvironment } = require(path.join(miniprogramRoot, 'api-environment.js'));
const config = require(path.join(miniprogramRoot, 'config.js'));

const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const PUBLIC_CODE = 'AbCdEfGhIjKlMnOpQrStUvWx';
const PRIVATE_TOKEN = 'aB3dEf7hIjKlMn0pQrStUvWxYz12-_CD45ghiJkLmN7';

const tick = () => new Promise(resolve => setImmediate(resolve));

function receipt() {
  return { caseNumber: CASE_NUMBER, publicLookupCode: PUBLIC_CODE, privateLookupToken: PRIVATE_TOKEN };
}

// 造一张签名合法的 PNG，供照片上传路径使用。
function fakePng(size = 64) {
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]).copy(bytes, size - 12);
  return bytes;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

// 载入页面并模拟 wx。handlers.request 决定每次请求的响应。
function createHarness(handlers = {}) {
  const modulePath = path.join(miniprogramRoot, 'pages/submit/index.js');
  delete require.cache[require.resolve(modulePath)];
  const state = {
    calls: [],
    navigations: [],
    storageWrites: [],
    chooseResult: null
  };
  let page = null;
  global.Page = definition => { page = definition; };
  global.wx = {
    request: options => {
      state.calls.push(options);
      (handlers.request || (value => value.success({ statusCode: 201, data: receipt() })))(options);
    },
    navigateTo: options => state.navigations.push(options.url),
    setStorageSync: (key, value) => state.storageWrites.push([key, value]),
    setStorage: options => state.storageWrites.push([options.key, options.data]),
    removeStorageSync: key => state.storageWrites.push(['remove', key]),
    chooseMedia: options => {
      const files = state.chooseResult;
      if (!files) {
        options.fail({ errMsg: 'chooseMedia:fail cancel' });
        return;
      }
      options.success({ tempFiles: files.map(file => ({ tempFilePath: file.path, size: file.bytes.length })) });
    },
    getFileSystemManager: () => ({
      readFile: options => {
        const file = (state.chooseResult || []).find(item => item.path === options.filePath);
        options.success({ data: toArrayBuffer(file ? file.bytes : fakePng()) });
      }
    })
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  page.onLoad({});
  return { page, state };
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

// 填入一份合成诉求内容。
function fillForm(page, overrides = {}) {
  page.setData({
    formDate: '2026-11-19',
    formTime: '09:00',
    formLocation: '合成游客地点',
    categoryIndex: 0,
    categoryText: '街面维护',
    formDescription: '合成游客诉求正文',
    formDescriptionLength: 8,
    formContact: '',
    ...overrides
  });
}

// 请求体是二进制 multipart，用标准 FormData 解码，与服务端读单口径一致。
async function readMultipart(call) {
  const contentType = call.header['content-type'] || call.header['Content-Type'];
  assert.match(contentType, /^multipart\/form-data; boundary=/, '请求头声明 multipart 边界');
  assert.ok(call.data instanceof ArrayBuffer, '请求体是二进制');
  return new Response(call.data, { headers: { 'Content-Type': contentType } }).formData();
}

async function readPayload(call) {
  const form = await readMultipart(call);
  const parts = form.getAll('payload');
  assert.equal(parts.length, 1, '请求体含且仅含一个 payload part');
  assert.equal(typeof parts[0], 'string', 'payload 是文本 part');
  return JSON.parse(parts[0]);
}

async function readPhotos(call) {
  const form = await readMultipart(call);
  return Promise.all(form.getAll('photos').map(async file => ({
    name: file.name,
    type: file.type,
    size: file.size,
    bytes: Buffer.from(await file.arrayBuffer())
  })));
}

function bodyText(call) {
  return Buffer.from(new Uint8Array(call.data)).toString('utf8');
}

function posts(state) {
  return state.calls.filter(call => call.method === 'POST');
}

test('必填字段逐项就地提示，输入保留且不发请求', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page, { formLocation: '' });
    await page.onSubmit();
    await tick();
    assert.ok(page.data.errors.location, '缺地点时就地提示');
    assert.match(page.data.errors.location, /地点/);
    assert.equal(posts(state).length, 0, '缺地点不发请求');

    fillForm(page, { formDescription: '' });
    await page.onSubmit();
    await tick();
    assert.ok(page.data.errors.description, '缺描述时就地提示');
    assert.equal(posts(state).length, 0, '缺描述不发请求');

    fillForm(page, { categoryIndex: -1, categoryText: '请选择问题类别' });
    await page.onSubmit();
    await tick();
    assert.ok(page.data.errors.category, '缺类别时就地提示');
    assert.match(page.data.errors.category, /类别/);
    assert.equal(posts(state).length, 0, '缺类别不发请求');

    fillForm(page, { formDate: '' });
    await page.onSubmit();
    await tick();
    assert.ok(page.data.errors.occurredAt, '缺时间时就地提示');
    assert.equal(posts(state).length, 0, '缺时间不发请求');

    // 其余输入保持不变，用户补齐后即可继续。
    assert.equal(page.data.formDescription, '合成游客诉求正文');
  } finally {
    restoreGlobals();
  }
});

test('提交成功：multipart 载荷字段齐全，无照片时只发 payload part', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();

    const call = posts(state)[0];
    assert.ok(call, '发出提交请求');
    assert.equal(call.url, apiEnvironment().origin + '/api/v1/public/cases');
    const payload = await readPayload(call);
    assert.match(payload.clientRequestId, /^pg-/, '带请求号');
    assert.ok(payload.clientRequestId.length >= 32, '请求号至少 32 位');
    assert.equal(payload.occurredAt, '2026-11-19T09:00:00+08:00');
    assert.equal(payload.location, '合成游客地点');
    assert.equal(payload.category, '街面维护');
    assert.equal(payload.description, '合成游客诉求正文');
    assert.equal(payload.contact, undefined, '未填的联系方式不发送');
    assert.deepEqual(await readPhotos(call), [], '不选照片时不发照片 part');

    assert.equal(page.data.receipt.caseNumber, CASE_NUMBER);
    assert.equal(page.data.receipt.publicLookupCode, PUBLIC_CODE);
    assert.equal(page.data.view, 'receipt');
  } finally {
    restoreGlobals();
  }
});

test('照片 1 张与 3 张时 multipart 带对应文件 part', async () => {
  const { page, state } = createHarness();
  try {
    state.chooseResult = [{ path: 'wxfile://one.png', bytes: fakePng() }];
    await page.onChoosePhotos();
    await tick();
    assert.equal(page.data.photoCount, 1, '已选 1 张');

    fillForm(page);
    await page.onSubmit();
    await tick();
    let photos = await readPhotos(posts(state)[0]);
    assert.equal(photos.length, 1, '带 1 个照片 part');
    assert.equal(photos[0].name, 'photo-1.png');
    assert.equal(photos[0].type, 'image/png');
    assert.equal(photos[0].bytes.length, 64);

    // 换成 3 张再提交一次。
    state.chooseResult = [
      { path: 'wxfile://one.png', bytes: fakePng() },
      { path: 'wxfile://two.png', bytes: fakePng(80) },
      { path: 'wxfile://three.png', bytes: fakePng(96) }
    ];
    await page.onChoosePhotos();
    await tick();
    assert.equal(page.data.photoCount, 3, '已选 3 张');

    fillForm(page, { formDescription: '第二条诉求正文' });
    await page.onSubmit();
    await tick();
    photos = await readPhotos(posts(state)[1]);
    assert.equal(photos.length, 3, '带 3 个照片 part');
    assert.deepEqual(photos.map(item => item.name), ['photo-1.png', 'photo-2.png', 'photo-3.png']);
    const payload = await readPayload(posts(state)[1]);
    assert.equal(payload.description, '第二条诉求正文');
  } finally {
    restoreGlobals();
  }
});

test('私密凭证只留在页面内存：不进网址、不写存储、不进请求体', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();

    const call = posts(state)[0];
    assert.equal(page.data.receipt.privateLookupToken, PRIVATE_TOKEN, '回执上显示私密凭证');
    assert.ok(!call.url.includes(PRIVATE_TOKEN), '网址不含私密凭证');
    assert.ok(!bodyText(call).includes(PRIVATE_TOKEN), '请求体不含私密凭证');
    assert.equal(state.storageWrites.length, 0, '不写任何存储');
    for (const [key, value] of state.storageWrites) {
      assert.ok(!String(key).includes(PRIVATE_TOKEN) && !String(value).includes(PRIVATE_TOKEN), '存储不含私密凭证');
    }

    page.onViewProgress();
    assert.equal(state.navigations.length, 1, '跳转到公开进度页');
    assert.equal(state.navigations[0], '/pages/public/index?code=' + PUBLIC_CODE, '网址只带公开查询码');
    assert.ok(!state.navigations[0].includes(PRIVATE_TOKEN), '跳转网址不含私密凭证');
  } finally {
    restoreGlobals();
  }
});

test('回执页会展示提示文案，公开码异常时给出说明且不跳转', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    assert.equal(page.data.view, 'receipt');

    // 公开码格式异常时：写入提示、不跳转、页面仍停在回执页。
    page.setData({ receipt: { ...page.data.receipt, publicLookupCode: 'not-a-valid-code' } });
    page.onViewProgress();
    assert.ok(page.data.submitMessage, '异常分支写入提示文案');
    assert.match(page.data.submitMessage, /公开查询码/);
    assert.equal(state.navigations.length, 0, '公开码异常时不跳转');
    assert.equal(page.data.view, 'receipt', '仍停在回执页');
  } finally {
    restoreGlobals();
  }
});

test('页面模板：回执页输出提示文案，表单页不展示内部请求号', () => {
  const template = fs.readFileSync(path.join(miniprogramRoot, 'pages/submit/index.wxml'), 'utf8');
  const receiptBranch = template.slice(template.indexOf('<block wx:else>'));
  assert.ok(receiptBranch.includes('{{submitMessage}}'), '回执页输出提示文案');
  assert.ok(receiptBranch.includes('warning-text'), '回执页复用 warning-text 样式');
  assert.ok(receiptBranch.includes('aria-role="alert"'), '回执页提示可读屏播报');
  assert.ok(!template.includes('请求号 {{requestId}}'), '不向游客展示内部请求号');
});

test('网络失败保留表单与请求号，重试复用同一请求号；成功后新表单换新请求号', async () => {
  let attempt = 0;
  const { page, state } = createHarness({
    request: options => {
      attempt += 1;
      if (attempt === 1) {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      options.success({ statusCode: 201, data: receipt() });
    }
  });
  try {
    fillForm(page);
    const requestId = page.data.requestId;
    await page.onSubmit();
    await tick();
    assert.match(page.data.submitMessage, /结果未知/, '结果未知时如实说明');
    assert.match(page.data.submitMessage, /重试/);
    assert.equal(page.data.formDescription, '合成游客诉求正文', '失败后保留表单');
    assert.equal(page.data.formLocation, '合成游客地点', '失败后保留地点');
    assert.equal(page.data.requestId, requestId, '失败后保留请求号');

    // 重试：内容未变，请求号必须不变。
    await page.onSubmit();
    await tick();
    const sent = posts(state);
    assert.equal(sent.length, 2, '重试确实发出一次请求');
    const first = await readPayload(sent[0]);
    const second = await readPayload(sent[1]);
    assert.equal(second.clientRequestId, first.clientRequestId, '重试沿用同一请求号');
    assert.deepEqual(second, first, '重试内容保持不变');
    assert.equal(page.data.receipt.caseNumber, CASE_NUMBER, '重试后拿到回执');

    // 成功后的新表单用新的请求号。
    page.onNewSubmission();
    await tick();
    assert.equal(page.data.receipt, null, '新表单清空回执');
    assert.equal(page.data.formDescription, '');
    assert.notEqual(page.data.requestId, requestId, '新表单换新请求号');
    fillForm(page, { formDescription: '新的诉求正文' });
    await page.onSubmit();
    await tick();
    const last = await readPayload(posts(state)[posts(state).length - 1]);
    assert.notEqual(last.clientRequestId, first.clientRequestId, '新表单用新的请求号');
  } finally {
    restoreGlobals();
  }
});

test('409 提示内容冲突并建议先查询回执', async () => {
  const { page } = createHarness({
    request: options => options.success({ statusCode: 409, data: { error: 'submission_conflict' } })
  });
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    assert.match(page.data.submitMessage, /冲突|不一致/);
    assert.match(page.data.submitMessage, /回执/, '建议先查询回执');
    assert.equal(page.data.receipt, null, '没有拿到回执');
    assert.equal(page.data.formDescription, '合成游客诉求正文', '保留表单');
  } finally {
    restoreGlobals();
  }
});

test('429 提示稍后再试', async () => {
  const { page } = createHarness({
    request: options => options.success({ statusCode: 429, data: { error: 'too_many_requests' } })
  });
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    assert.match(page.data.submitMessage, /频繁|稍后/);
    assert.equal(page.data.receipt, null, '没有拿到回执');
    assert.equal(page.data.formDescription, '合成游客诉求正文', '保留表单');
  } finally {
    restoreGlobals();
  }
});

test('提交期间锁定，双击只发出一次请求', async () => {
  const pending = [];
  const { page, state } = createHarness({ request: options => pending.push(options) });
  try {
    fillForm(page);
    const first = page.onSubmit();
    const second = page.onSubmit();
    await tick();
    assert.equal(posts(state).length, 1, '第二次点击被拒绝');
    assert.equal(page.data.submitBusy, true, '提交期间锁定');

    pending[0].success({ statusCode: 201, data: receipt() });
    await first;
    await second;
    await tick();
    assert.equal(page.data.submitBusy, false, '提交结束后解除锁定');
    assert.equal(page.data.receipt.caseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('请求网址必须在配置的 origin 下，未配置时不发请求', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    const origin = apiEnvironment().origin;
    assert.ok(origin, '本地配置有可用 origin');
    for (const call of state.calls) {
      assert.ok(call.url.startsWith(origin + '/api/v1/'), '网址在配置的 origin 下：' + call.url);
    }

    const original = config.apiBaseUrl;
    config.apiBaseUrl = 'https://example.test';
    try {
      const second = createHarness();
      try {
        fillForm(second.page);
        await second.page.onSubmit();
        await tick();
        assert.equal(posts(second.state).length, 0, '未配置 origin 时不发请求');
        assert.match(second.page.data.submitMessage, /服务地址/);
      } finally {
        restoreGlobals();
      }
    } finally {
      config.apiBaseUrl = original;
    }
  } finally {
    restoreGlobals();
  }
});

test('校验与请求号生成是纯逻辑，可在 Node 里直接检查', () => {
  const first = submitModule.newClientRequestId(0);
  const second = submitModule.newClientRequestId(1);
  assert.ok(first.length >= 32, '请求号至少 32 位');
  assert.notEqual(first, second, '每次生成都不同');

  const missing = submitModule.validateSubmission({ clientRequestId: 'pg-1' });
  assert.ok(missing.errors.location, '缺地点时报字段级错误');
  assert.ok(missing.errors.category, '缺类别时报字段级错误');
  assert.ok(missing.errors.description, '缺描述时报字段级错误');
  assert.ok(missing.errors.occurredAt, '缺时间时报字段级错误');
  assert.equal(missing.payload, undefined, '有错误时不给出载荷');

  const good = submitModule.validateSubmission({
    clientRequestId: 'pg-1', occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成地点', category: '街面维护', description: '合成正文', contact: '13800000000'
  });
  assert.deepEqual(good.errors, {});
  assert.equal(good.payload.contact, '13800000000');
  assert.equal(good.payload.clientRequestId, 'pg-1');

  assert.equal(submitModule.progressUrl(PUBLIC_CODE), '/pages/public/index?code=' + PUBLIC_CODE);
  assert.equal(submitModule.progressUrl(PRIVATE_TOKEN), '', '私密凭证不能作为跳转参数');
});

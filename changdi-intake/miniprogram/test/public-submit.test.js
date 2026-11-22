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

// 造一张签名合法的 JPEG，供图片格式校验使用。
function fakeJpeg(size = 64) {
  const bytes = Buffer.alloc(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
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
    storage: new Map(),
    chooseResult: null,
    // 本机文件：键是文件路径，值是文件内容。
    files: new Map(),
    // 本机照片读取次数与是否失效：用来验证重试是否复用已发出的字节。
    readCalls: 0,
    readFails: false,
    clipboard: [],
    modals: []
  };
  let page = null;
  global.Page = definition => { page = definition; };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://user' },
    request: options => {
      state.calls.push(options);
      (handlers.request || (value => value.success({ statusCode: 201, data: receipt() })))(options);
    },
    navigateTo: options => state.navigations.push(options.url),
    getStorageSync: key => (state.storage.has(key) ? state.storage.get(key) : ''),
    setStorageSync: (key, value) => {
      state.storageWrites.push([key, value]);
      state.storage.set(key, value);
    },
    setStorage: options => state.storageWrites.push([options.key, options.data]),
    removeStorageSync: key => {
      state.storageWrites.push(['remove', key]);
      state.storage.delete(key);
    },
    setClipboardData: options => {
      state.clipboard.push(options.data);
      (handlers.clipboard || (value => value.success({})))(options);
    },
    showModal: options => {
      state.modals.push(options);
      (handlers.modal || (() => {}))(options);
    },
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
        state.readCalls += 1;
        if (state.readFails) {
          options.fail({ errMsg: 'readFile:fail no such file' });
          return;
        }
        const file = (state.chooseResult || []).find(item => item.path === options.filePath);
        options.success({ data: toArrayBuffer(file ? file.bytes : fakePng()) });
      },
      writeFileSync: (path, buffer) => {
        state.files.set(path, Buffer.from(buffer));
      },
      readdirSync: () => [...state.files.keys()].map(item => item.split('/').pop()),
      unlinkSync: path => {
        if (!state.files.has(path)) {
          const error = new Error('no such file');
          error.errMsg = 'unlinkSync:fail no such file';
          throw error;
        }
        state.files.delete(path);
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

test('私密凭证只留在页面内存：本机只写允许字段，成功后写一次', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page, { formContact: '13800000000' });
    await page.onSubmit();
    await tick();

    const call = posts(state)[0];
    assert.equal(page.data.receipt.privateLookupToken, PRIVATE_TOKEN, '回执上显示私密凭证');
    assert.ok(!call.url.includes(PRIVATE_TOKEN), '网址不含私密凭证');
    assert.ok(!bodyText(call).includes(PRIVATE_TOKEN), '请求体不含私密凭证');

    // 本机只写回执夹，且只写工单编号、公开查询码与提交时间三项。
    assert.equal(state.storageWrites.length, 1, '成功后只写一次存储');
    const [key, value] = state.storageWrites[0];
    assert.equal(key, 'changdi:my-cases:v1', '只写回执夹这一处存储');
    const stored = JSON.parse(value);
    assert.equal(stored.length, 1, '回执夹里有一条记录');
    assert.deepEqual(
      Object.keys(stored[0]).sort(),
      ['caseNumber', 'publicLookupCode', 'submittedAt'],
      '存储只含允许的三个字段'
    );
    assert.equal(stored[0].caseNumber, CASE_NUMBER, '存了工单编号');
    assert.equal(stored[0].publicLookupCode, PUBLIC_CODE, '存了公开查询码');
    assert.ok(!value.includes(PRIVATE_TOKEN), '存储不含私密凭证');
    assert.ok(!value.includes('合成游客地点'), '存储不含发生地点');
    assert.ok(!value.includes('合成游客诉求正文'), '存储不含问题描述');
    assert.ok(!value.includes('13800000000'), '存储不含联系方式');
    assert.ok(bodyText(call).includes('13800000000'), '联系方式只随提交发出');
    assert.equal(page.data.submitMessage, '', '保存成功时不打扰用户');

    page.onViewProgress();
    assert.equal(state.navigations.length, 1, '跳转到公开进度页');
    assert.equal(state.navigations[0], '/pages/public/index?code=' + PUBLIC_CODE, '网址只带公开查询码');
    assert.ok(!state.navigations[0].includes(PRIVATE_TOKEN), '跳转网址不含私密凭证');
  } finally {
    restoreGlobals();
  }
});

test('提交失败不写本机回执夹；本机保存失败时回执照常展示', async () => {
  const failed = createHarness({
    request: options => options.fail({ errMsg: 'request:fail timeout' })
  });
  try {
    fillForm(failed.page);
    await failed.page.onSubmit();
    await tick();
    assert.equal(failed.state.storageWrites.length, 0, '提交失败不写存储');
    assert.equal(failed.page.data.receipt, null, '没有拿到回执');
  } finally {
    restoreGlobals();
  }

  // 存储不可用时给出轻提示，回执仍然正常展示。
  const broken = createHarness();
  try {
    broken.state.storageWrites.length = 0;
    global.wx.getStorageSync = () => { throw new Error('storage unavailable'); };
    fillForm(broken.page);
    await broken.page.onSubmit();
    await tick();
    assert.equal(broken.state.storageWrites.length, 0, '存储异常时不写存储');
    assert.equal(broken.page.data.view, 'receipt', '回执照常展示');
    assert.equal(broken.page.data.receipt.caseNumber, CASE_NUMBER);
    assert.match(broken.page.data.submitMessage, /本机记录保存失败/);
    assert.equal(broken.page.data.receipt.privateLookupToken, PRIVATE_TOKEN, '私密凭证仍只在页面内存');
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

test('建议处理部门：填了随提交送出，未填不带字段，超长就地提示不发请求', async () => {
  const filled = createHarness();
  try {
    fillForm(filled.page, { formSuggestedDepartment: '市政管理单位' });
    await filled.page.onSubmit();
    await tick();
    const payload = await readPayload(posts(filled.state)[0]);
    assert.equal(payload.suggestedDepartment, '市政管理单位', '填了就随提交送出');
  } finally {
    restoreGlobals();
  }

  const empty = createHarness();
  try {
    fillForm(empty.page);
    await empty.page.onSubmit();
    await tick();
    const payload = await readPayload(posts(empty.state)[0]);
    assert.ok(!('suggestedDepartment' in payload), '没填就不带这个字段');
  } finally {
    restoreGlobals();
  }

  const tooLong = createHarness();
  try {
    fillForm(tooLong.page, { formSuggestedDepartment: '部'.repeat(101) });
    await tooLong.page.onSubmit();
    await tick();
    assert.ok(tooLong.page.data.errors.suggestedDepartment, '超长就地提示');
    assert.match(tooLong.page.data.errors.suggestedDepartment, /100/);
    assert.equal(posts(tooLong.state).length, 0, '超长不发请求');
    assert.equal(tooLong.page.data.formSuggestedDepartment, '部'.repeat(101), '输入保留');
  } finally {
    restoreGlobals();
  }
});

test('结果未知后重试沿用原快照：改动表单与照片都不影响重试内容，快照不落盘', async () => {
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
    state.chooseResult = [{ path: 'wxfile://one.png', bytes: fakePng() }];
    await page.onChoosePhotos();
    await tick();
    fillForm(page, { formSuggestedDepartment: '市政管理单位' });
    const requestId = page.data.requestId;

    await page.onSubmit();
    await tick();
    assert.match(page.data.submitMessage, /结果未知/, '结果未知时如实说明');
    assert.equal(page.data.formLocked, true, '结果未知时锁定表单');
    assert.match(page.data.lockNotice, /沿用原请求号/, '提示重试沿用原请求号与原内容');
    assert.equal(state.storageWrites.length, 0, '快照不写本机存储');

    // 锁定后不接受改动：换照片与改输入都不生效。
    state.chooseResult = [{ path: 'wxfile://two.png', bytes: fakeJpeg(80) }];
    await page.onChoosePhotos();
    await tick();
    assert.equal(page.data.photoCount, 1, '锁定后不能再换照片');
    assert.equal(page.data.formDescription, '合成游客诉求正文', '锁定后输入不变');

    // 即便表单被绕过锁定改动，重试仍按快照原样发出。
    page.setData({ formDescription: '被改动后的正文', formLocation: '被改动后的地点' });
    page._pickedFiles = [];
    await page.onSubmit();
    await tick();

    const sent = posts(state);
    assert.equal(sent.length, 2, '重试确实发出一次请求');
    const first = await readPayload(sent[0]);
    const second = await readPayload(sent[1]);
    assert.equal(second.clientRequestId, requestId, '重试沿用同一请求号');
    assert.equal(second.clientRequestId, first.clientRequestId, '两次请求号一致');
    assert.deepEqual(second, first, '重试内容与首次完全一致');
    assert.equal(second.description, '合成游客诉求正文', '改动没有进入重试');
    assert.equal(second.suggestedDepartment, '市政管理单位', '建议部门原样重发');
    const photos = await readPhotos(sent[1]);
    assert.deepEqual(photos.map(item => item.name), ['photo-1.png'], '重试带上原照片');
    assert.equal(page.data.receipt.caseNumber, CASE_NUMBER, '重试后拿到回执');
  } finally {
    restoreGlobals();
  }
});

test('结果未知时可放弃本次提交：换新请求号重填，原内容保留', async () => {
  const { page, state } = createHarness({
    request: options => options.fail({ errMsg: 'request:fail timeout' }),
    modal: options => options.success({ confirm: true, cancel: false })
  });
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    assert.equal(page.data.formLocked, true);
    const before = page.data.requestId;

    page.onAbandonSubmission();
    assert.equal(state.modals.length, 1, '放弃前先二次确认');
    assert.notEqual(page.data.requestId, before, '放弃后换新请求号');
    assert.equal(page.data.formLocked, false, '放弃后解锁表单');
    assert.equal(page.data.formDescription, '合成游客诉求正文', '放弃后保留已填内容');
    assert.equal(page.data.receipt, null, '放弃后没有回执');
  } finally {
    restoreGlobals();
  }
});

test('回执查询码：合法 wechatCode 落盘展示，退出页面时释放临时文件', async () => {
  const png = fakePng();
  const { page, state } = createHarness({
    request: options => options.success({
      statusCode: 201,
      data: { ...receipt(), wechatCode: { envVersion: 'release', mediaType: 'image/png', base64: png.toString('base64') } }
    })
  });
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();

    assert.equal(page.data.receiptCodeState, 'ready', '查询码可用');
    const path = page.data.receiptCodePath;
    assert.ok(path, '给出可展示的临时文件路径');
    assert.ok(path.startsWith('wxfile://user/'), '写在用户目录下');
    assert.ok(path.includes(PUBLIC_CODE), '文件名只用公开查询码');
    assert.ok(!path.includes(PRIVATE_TOKEN), '文件名不含私密凭证');
    assert.deepEqual(state.files.get(path), png, '写出的就是服务端下发的图片字节');
    assert.ok(!state.files.get(path).toString('utf8').includes(PRIVATE_TOKEN), '图片里没有私密凭证');

    page.onUnload();
    assert.equal(state.files.size, 0, '退出页面时释放临时文件');
  } finally {
    restoreGlobals();
  }
});

test('回执查询码降级：未配置、编码非法、图像格式不符时仍能看到公开码与私密凭证', async () => {
  const cases = [
    ['未下发查询码', undefined],
    ['编码不是 Base64', { envVersion: 'release', mediaType: 'image/png', base64: '这不是 base64!!' }],
    ['编码长度不对', { envVersion: 'release', mediaType: 'image/png', base64: 'AAA' }],
    ['类型不被接受', { envVersion: 'release', mediaType: 'image/gif', base64: fakePng().toString('base64') }],
    ['版本不被接受', { envVersion: 'staging', mediaType: 'image/png', base64: fakePng().toString('base64') }],
    ['图像与声明的类型不符', { envVersion: 'release', mediaType: 'image/png', base64: fakeJpeg().toString('base64') }],
    ['不是对象', 'png']
  ];
  for (const [label, wechatCode] of cases) {
    const { page, state } = createHarness({
      request: options => options.success({ statusCode: 201, data: { ...receipt(), wechatCode } })
    });
    try {
      fillForm(page);
      await page.onSubmit();
      await tick();
      assert.equal(page.data.receiptCodeState, 'unavailable', label + '：不展示查询码');
      assert.equal(page.data.receiptCodePath, '', label + '：没有图片路径');
      assert.match(page.data.receiptCodeMessage, /公开查询码/, label + '：提示仍可手动查询');
      assert.equal(state.files.size, 0, label + '：不落盘无效图片');
      assert.equal(page.data.receipt.publicLookupCode, PUBLIC_CODE, label + '：公开码照常展示');
      assert.equal(page.data.receipt.privateLookupToken, PRIVATE_TOKEN, label + '：私密凭证照常展示');
    } finally {
      restoreGlobals();
    }
  }
});

test('查询码图片加载失败时释放文件并降级，公开码与私密凭证仍可见', async () => {
  const { page, state } = createHarness({
    request: options => options.success({
      statusCode: 201,
      data: { ...receipt(), wechatCode: { envVersion: 'trial', mediaType: 'image/png', base64: fakePng().toString('base64') } }
    })
  });
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    assert.equal(page.data.receiptCodeState, 'ready');
    assert.equal(state.files.size, 1, '图片已写入本机');

    page.onReceiptCodeError();
    await tick();
    assert.equal(page.data.receiptCodeState, 'unavailable', '加载失败后降级');
    assert.equal(page.data.receiptCodePath, '', '不再展示坏掉的图片');
    assert.equal(state.files.size, 0, '坏掉的临时文件被释放');
    assert.match(page.data.receiptCodeMessage, /公开查询码/);
    assert.equal(page.data.receipt.publicLookupCode, PUBLIC_CODE, '公开码仍可见');
    assert.equal(page.data.receipt.privateLookupToken, PRIVATE_TOKEN, '私密凭证仍可见');
  } finally {
    restoreGlobals();
  }
});

test('公开查询码可复制：只复制公开码，不复制私密凭证', async () => {
  const { page, state } = createHarness();
  try {
    fillForm(page);
    await page.onSubmit();
    await tick();
    page.onCopyPublicCode();
    assert.deepEqual(state.clipboard, [PUBLIC_CODE], '只复制公开查询码');
    assert.match(page.data.copyMessage, /已复制/);
    assert.ok(!state.clipboard.join('').includes(PRIVATE_TOKEN), '不复制私密凭证');
  } finally {
    restoreGlobals();
  }
});

test('选照片进行中不提交；照片选定后提交带上所选照片', async () => {
  const { page, state } = createHarness();
  try {
    state.chooseResult = [{ path: 'wxfile://one.png', bytes: fakePng() }];
    let pending = null;
    global.wx.chooseMedia = options => { pending = options; };
    const choosing = page.onChoosePhotos();
    await tick();
    assert.equal(page.data.photoChoosing, true, '选照片进行中');
    assert.ok(pending, '选照片回调已挂起');

    // 选照片进行中点提交：不发请求，避免发出的照片与页面上看到的不一致。
    await page.onSubmit();
    await tick();
    assert.equal(posts(state).length, 0, '选照片进行中不发请求');
    assert.match(page.data.submitMessage, /照片选择中/);

    // 照片选定后再提交：重复点击只发一次请求。
    pending.success({ tempFiles: [{ tempFilePath: 'wxfile://one.png', size: 64 }] });
    await choosing;
    await tick();
    assert.equal(page.data.photoCount, 1, '照片已选定');
    assert.equal(page.data.photoChoosing, false, '选照片结束');

    fillForm(page);
    const first = page.onSubmit();
    const second = page.onSubmit();
    await tick();
    assert.equal(posts(state).length, 1, '重复点击只发一次请求');

    await first;
    await second;
    await tick();
    const photos = await readPhotos(posts(state)[0]);
    assert.equal(photos.length, 1, '提交带上所选照片');
  } finally {
    restoreGlobals();
  }
});

test('服务端提示微信查询码暂不可用时，按同一请求重试取回回执', async () => {
  let attempt = 0;
  const { page, state } = createHarness({
    request: options => {
      attempt += 1;
      if (attempt === 1) {
        options.success({ statusCode: 503, data: { error: 'wechat_code_unavailable' } });
        return;
      }
      options.success({ statusCode: 200, data: receipt() });
    }
  });
  try {
    fillForm(page);
    const requestId = page.data.requestId;
    await page.onSubmit();
    await tick();
    assert.match(page.data.submitMessage, /查询码暂不可用/, '如实说明查询码不可用');
    assert.equal(page.data.formLocked, true, '结果未知时锁定表单');

    await page.onSubmit();
    await tick();
    const sent = posts(state);
    assert.equal(sent.length, 2);
    const first = await readPayload(sent[0]);
    const second = await readPayload(sent[1]);
    assert.equal(second.clientRequestId, requestId, '重试沿用同一请求号');
    assert.deepEqual(second, first, '重试内容保持不变');
    assert.equal(page.data.receipt.caseNumber, CASE_NUMBER, '重试取回回执');
    assert.equal(page.data.receiptCodeState, 'unavailable', '回执里没有查询码时降级');
    assert.equal(page.data.receipt.publicLookupCode, PUBLIC_CODE, '公开码照常展示');
  } finally {
    restoreGlobals();
  }
});

test('回执页模板：展示查询码与复制入口，表单页不展示内部请求号', () => {
  const template = fs.readFileSync(path.join(miniprogramRoot, 'pages/submit/index.wxml'), 'utf8');
  assert.ok(template.includes('bindtap="onCopyPublicCode"'), '有复制公开码入口');
  assert.ok(template.includes('receiptCodePath'), '有查询码图片展示位');
  assert.ok(template.includes('binderror="onReceiptCodeError"'), '查询码加载失败有兜底');
  assert.ok(template.includes('建议处理部门'), '表单里有建议处理部门');
  assert.ok(template.includes('最终由管理方分派'), '说明最终由管理方分派');
  assert.ok(template.includes('{{receipt.privateLookupToken}}'), '回执上展示私密凭证');
  assert.ok(!template.includes('请求号 {{requestId}}'), '不向游客展示内部请求号');
});

test('先已发送超时、再让本机读图失败，仍能按原字节重试并拿到同一回执', async () => {
  let attempt = 0;
  const { page, state } = createHarness({
    request: options => {
      attempt += 1;
      if (attempt === 1) {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      options.success({ statusCode: 200, data: receipt() });
    }
  });
  try {
    state.chooseResult = [{ path: 'wxfile://one.png', bytes: fakePng() }];
    await page.onChoosePhotos();
    await tick();
    fillForm(page);
    const requestId = page.data.requestId;

    await page.onSubmit();
    await tick();
    assert.equal(page.data.formLocked, true, '结果未知时锁定表单');
    assert.equal(state.readCalls, 1, '首次提交读了一次本机照片');
    const firstBody = Buffer.from(new Uint8Array(posts(state)[0].data));

    // 本机照片临时文件失效：重试必须按已发出的字节原样重发。
    state.readFails = true;
    await page.onSubmit();
    await tick();

    const sent = posts(state);
    assert.equal(sent.length, 2, '重试确实发出一次请求');
    assert.equal(state.readCalls, 1, '重试没有再读本机照片');
    const secondBody = Buffer.from(new Uint8Array(sent[1].data));
    assert.deepEqual(secondBody, firstBody, '重试按原字节原样发出');
    const secondPayload = await readPayload(sent[1]);
    assert.equal(secondPayload.clientRequestId, requestId, '重试沿用同一请求号');
    const photos = await readPhotos(sent[1]);
    assert.equal(photos.length, 1, '重试仍带上原照片');
    assert.equal(page.data.receipt.caseNumber, CASE_NUMBER, '同一次提交拿到回执');
    assert.equal(page.data.formLocked, false, '成功后解锁');

    // 照片与凭证都不落盘：回执夹里只有工单编号、公开查询码与提交时间。
    assert.equal(state.storageWrites.length, 1, '只写回执夹一次');
    const stored = JSON.parse(state.storageWrites[0][1]);
    assert.deepEqual(
      Object.keys(stored[0]).sort(),
      ['caseNumber', 'publicLookupCode', 'submittedAt'],
      '存储只含允许的三个字段'
    );
    assert.ok(!state.storageWrites[0][1].includes(PRIVATE_TOKEN), '存储不含私密凭证');
    assert.ok(!state.storageWrites[0][1].includes('合成游客诉求正文'), '存储不含问题描述');
  } finally {
    restoreGlobals();
  }
});

test('曾有结果未知后，本地制包失败不当成明确拒绝：不解锁、快照与请求号仍保留', async () => {
  const { page, state } = createHarness({
    request: options => options.fail({ errMsg: 'request:fail timeout' })
  });
  try {
    state.chooseResult = [{ path: 'wxfile://one.png', bytes: fakePng() }];
    await page.onChoosePhotos();
    await tick();
    fillForm(page);
    const requestId = page.data.requestId;

    await page.onSubmit();
    await tick();
    assert.equal(page.data.formLocked, true, '结果未知时锁定表单');
    assert.ok(page._snapshot, '结果未知时保留快照');

    // 丢掉已发出的字节并让本机读图失败：这次重试在本地就失败。
    page._snapshot.body = null;
    state.readFails = true;
    await page.onSubmit();
    await tick();

    assert.equal(page.data.formLocked, true, '本地失败不当成明确拒绝解锁');
    assert.ok(page._snapshot, '快照仍保留');
    assert.equal(page._snapshot.payload.clientRequestId, requestId, '请求号不变');
    assert.match(page.data.submitMessage, /图片/, '如实说明本地没能发出请求');
    assert.equal(page.data.receipt, null, '还没有回执');

    // 本地失败后仍能再试一次：这次照片恢复可读，按原请求号重发。
    state.readFails = false;
    await page.onSubmit();
    await tick();
    const sent = posts(state);
    assert.equal(sent.length, 2, '第三次确实发出请求（第二次本地失败没有发出去）');
    const last = await readPayload(sent[1]);
    assert.equal(last.clientRequestId, requestId, '仍用同一请求号');
  } finally {
    restoreGlobals();
  }
});

test('已发出的请求字节在成功、放弃或离开页面后释放', async () => {
  const done = createHarness();
  try {
    fillForm(done.page);
    await done.page.onSubmit();
    await tick();
    assert.equal(done.page._snapshot, null, '成功后释放快照与字节');
  } finally {
    restoreGlobals();
  }

  const abandoned = createHarness({
    request: options => options.fail({ errMsg: 'request:fail timeout' }),
    modal: options => options.success({ confirm: true, cancel: false })
  });
  try {
    fillForm(abandoned.page);
    await abandoned.page.onSubmit();
    await tick();
    assert.ok(abandoned.page._snapshot, '结果未知时保留快照');
    abandoned.page.onAbandonSubmission();
    assert.equal(abandoned.page._snapshot, null, '放弃后释放快照与字节');
  } finally {
    restoreGlobals();
  }

  const left = createHarness({ request: options => options.fail({ errMsg: 'request:fail timeout' }) });
  try {
    fillForm(left.page);
    await left.page.onSubmit();
    await tick();
    assert.ok(left.page._snapshot, '结果未知时保留快照');
    left.page.onUnload();
    assert.equal(left.page._snapshot, null, '离开页面后释放快照与字节');
  } finally {
    restoreGlobals();
  }
});

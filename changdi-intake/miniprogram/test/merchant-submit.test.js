// 商户新诉求文字表单的本地模拟检查：权限、格式校验、超时重试与防双击。
// 用 Node 模拟 wx.request 与 Page，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const merchantModule = require(path.join(miniprogramRoot, 'pages/merchant/merchant.js'));

const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const TOKEN = 'merchant_test_token_0123456789abcdefghijklmnopqrstuvwxyz';

function loadMerchantPage() {
  const modulePath = path.join(miniprogramRoot, 'pages/merchant/index.js');
  delete require.cache[require.resolve(modulePath)];
  let page = null;
  global.Page = definition => { page = definition; };
  global.wx = {
    request: options => page.__request(options),
    navigateBack: () => {}
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  return page;
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// 请求体是二进制 multipart。用真实 multipart 解码读取，与服务端读单口径一致：
// 按请求头声明的 boundary 解析，得到 payload 文本 part 与 photos 文件 part。
async function readMultipart(call) {
  const contentType = call.header['content-type'] || call.header['Content-Type'];
  assert.match(contentType, /^multipart\/form-data; boundary=/, '请求头声明 multipart 边界');
  assert.ok(call.data instanceof ArrayBuffer, '请求体是二进制');
  const form = await new Response(call.data, { headers: { 'Content-Type': contentType } }).formData();
  return { form, contentType };
}

// 取出 multipart 里的 payload 文本 part 并解析成对象。
async function readPayload(call) {
  const { form } = await readMultipart(call);
  const parts = form.getAll('payload');
  assert.equal(parts.length, 1, '请求体含且仅含一个 payload part');
  assert.equal(typeof parts[0], 'string', 'payload 是文本 part');
  return JSON.parse(parts[0]);
}

// 取出 multipart 里的照片文件 part，还原原始字节。
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

// 整个请求体按 UTF-8 转为文本，用于检查正文里没有夹带凭据。
function bodyText(call) {
  return Buffer.from(new Uint8Array(call.data)).toString('utf8');
}

// 商户页面：提交动作与列表读取分别可控。
function merchantPage(identity = { merchantId: 'shop-a', permissions: ['readCases', 'submitCases', 'collaborate'] }, handlers = {}) {
  const calls = [];
  const page = loadMerchantPage();
  page.__request = options => {
    calls.push(options);
    const url = options.url;
    if (url.endsWith('/api/v1/merchant/me')) {
      options.success({ statusCode: 200, data: identity });
      return;
    }
    if (options.method === 'POST' && url.endsWith('/api/v1/merchant/cases')) {
      (handlers.submit || (value => value.success({
        statusCode: 201,
        data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
      })))(options);
      return;
    }
    if (url.includes('/api/v1/merchant/cases')) {
      (handlers.cases || (value => value.success({ statusCode: 200, data: { items: [], nextBefore: null } })))(options);
      return;
    }
    (handlers.collaborations || (value => value.success({ statusCode: 200, data: { items: [], nextBefore: null } })))(options);
  };
  return { page, calls };
}

async function login(page) {
  page.onLoad({});
  page.onLoginSubmit({ detail: { value: { token: TOKEN } } });
  await tick();
  await tick();
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

test('没有提交权限时不开放新诉求表单，也不发请求', async () => {
  const { page, calls } = merchantPage({ merchantId: 'shop-a', permissions: ['readCases'] });
  try {
    await login(page);
    assert.equal(page.data.canSubmitCases, false);
    page.onOpenForm();
    assert.equal(page.data.showForm, false, '不显示表单');
    assert.match(page.data.submitMessage, /权限/);

    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, '无权限不发提交请求');
  } finally {
    restoreGlobals();
  }
});

test('提交成功：multipart 载荷带请求号与必填字段，回执显示编号', async () => {
  const { page, calls } = merchantPage();
  try {
    await login(page);
    page.onOpenForm();
    assert.equal(page.data.showForm, true);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();

    const call = calls.find(entry => entry.method === 'POST');
    assert.ok(call, '发出提交请求');
    assert.ok(call.url.endsWith('/api/v1/merchant/cases'));
    assert.match(call.header['content-type'], /^multipart\/form-data; boundary=/);
    const payload = await readPayload(call);
    assert.match(payload.clientRequestId, /^mp-/, '带请求号');
    assert.notEqual(payload.clientRequestId, 'probe');
    assert.equal(payload.occurredAt, '2026-11-19T09:00:00+08:00');
    assert.equal(payload.location, '合成商户地点');
    assert.equal(payload.category, '街面维护');
    assert.equal(payload.description, '合成商户诉求正文');
    assert.equal(payload.contact, undefined, '未填的联系方式不发送');
    assert.ok(!('photos' in payload), '照片不进 payload 文本 part');
    assert.deepEqual(await readPhotos(call), [], '不选照片时不发照片 part');

    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
    assert.equal(page.data.submitReceipt.statusLabel, '已提交');
    assert.match(page.data.submitMessage, /已提交/);
    assert.equal(page.data.formDescription, '', '提交后清空表单');
  } finally {
    restoreGlobals();
  }
});

test('令牌只出现在授权头，不进入请求体', async () => {
  const { page, calls } = merchantPage();
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const call = calls.find(entry => entry.method === 'POST');
    assert.equal(call.header.Authorization, 'Bearer ' + TOKEN);
    assert.ok(!bodyText(call).includes(TOKEN), '请求体不含令牌');
    assert.ok(!call.url.includes(TOKEN), '网址不含令牌');
  } finally {
    restoreGlobals();
  }
});

test('凭据失效时清除令牌与商户数据', async () => {
  const { page } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => options.success({ statusCode: 401, data: { error: 'unauthorized' } }) }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page._token, '', '令牌已清除');
    assert.equal(page.data.merchant, '');
    assert.equal(page.data.view, 'login');
  } finally {
    restoreGlobals();
  }
});

test('格式有缺时客户端拦下，不发请求', async () => {
  const { page, calls } = merchantPage();
  try {
    await login(page);
    fillForm(page, { formLocation: '  ' });
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, '缺地点不发请求');
    assert.match(page.data.submitMessage, /地点/);

    fillForm(page, { formDescription: '' });
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, '缺说明不发请求');
    assert.match(page.data.submitMessage, /诉求说明/);
  } finally {
    restoreGlobals();
  }
});

test('提交进行中不接受第二次点击', async () => {
  const pending = [];
  const { page, calls } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => pending.push(options) }
  );
  try {
    await login(page);
    fillForm(page);
    const first = page.onSubmitNewCase();
    const second = page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 1, '第二次点击被拒绝');

    pending[0].success({
      statusCode: 201,
      data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
    });
    await first;
    await second;
    await tick();
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('超时后重试沿用同一请求号与内容，不重复建单', async () => {
  const attempts = [];
  const { page, calls } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    {
      submit: options => {
        attempts.push(options);
        if (attempts.length === 1) {
          options.fail({ errMsg: 'request:fail timeout' });
          return;
        }
        // 服务端按请求号去重，返回原工单。
        options.success({
          statusCode: 200,
          data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
        });
      }
    }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.match(page.data.submitMessage, /结果未知/);
    assert.ok(page.data.submitRequestId, '显示本次请求号');

    // 重试：内容未变，请求号必须不变。
    await page.onSubmitNewCase();
    await tick();
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2, '重试确实发出一次请求');
    const first = await readPayload(posts[0]);
    const second = await readPayload(posts[1]);
    assert.equal(second.clientRequestId, first.clientRequestId, '重试沿用同一请求号');
    assert.deepEqual(second, first, '重试内容保持不变');
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
    assert.match(page.data.submitMessage, /此前已提交/);
  } finally {
    restoreGlobals();
  }
});

test('只可提交不能读取的商户拿到回执，且不请求工单列表', async () => {
  const { page, calls } = merchantPage({ merchantId: 'shop-a', permissions: ['submitCases'] });
  try {
    await login(page);
    assert.equal(page.data.canReadCases, false);
    assert.equal(page.data.canSubmitCases, true);
    const listCalls = calls.filter(call => call.method === 'GET' && call.url.includes('/api/v1/merchant/cases'));
    assert.equal(listCalls.length, 0, '无读取权限不读工单列表');

    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER, '拿到回执');
    assert.equal(page.data.submitReceipt.description, undefined, '回执不含工单内容');
    const after = calls.filter(call => call.method === 'GET' && call.url.includes('/api/v1/merchant/cases'));
    assert.equal(after.length, 0, '提交后仍不越权读取工单');
  } finally {
    restoreGlobals();
  }
});

test('清空重填会换新的请求号', async () => {
  const { page, calls } = merchantPage();
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const first = await readPayload(calls.find(call => call.method === 'POST'));

    fillForm(page);
    page.onResetForm();
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const posts = calls.filter(call => call.method === 'POST');
    const second = await readPayload(posts[posts.length - 1]);
    assert.notEqual(second.clientRequestId, first.clientRequestId, '重新开始用新请求号');
  } finally {
    restoreGlobals();
  }
});

test('请求号与内容绑定：内容变化才换请求号', () => {
  const first = merchantModule.normalizeSubmission({
    clientRequestId: 'mp-1', occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成地点', category: '街面维护', description: '合成正文'
  });
  assert.equal(first.error, undefined);
  const second = merchantModule.normalizeSubmission({
    clientRequestId: 'mp-2', occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成地点', category: '街面维护', description: '另一份正文'
  });
  assert.notEqual(first.content.description, second.content.description);
  assert.equal(merchantModule.normalizeSubmission({
    clientRequestId: 'mp-3', occurredAt: '不是时间',
    location: '合成地点', category: '街面维护', description: '合成正文'
  }).error.includes('发生时间'), true);
});

// 断网后进入待确认状态：改内容、清空都要被拒绝。
test('断网后锁定本次申报：不能改内容', async () => {
  const { page } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => options.fail({ errMsg: 'request:fail' }) }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitPending, true, '进入待确认状态');

    page.onFormDescriptionInput({ detail: { value: '改过的诉求正文' } });
    page.onFormLocationInput({ detail: { value: '改过的地点' } });
    page.onFormCategoryInput({ detail: { value: '改过的分类' } });
    page.onFormDateChange({ detail: { value: '2026-12-01' } });
    page.onFormTimeChange({ detail: { value: '08:00' } });
    page.onFormContactInput({ detail: { value: '改过的联系方式' } });

    assert.equal(page.data.formDescription, '合成商户诉求正文', '说明未改');
    assert.equal(page.data.formLocation, '合成商户地点', '地点未改');
    assert.equal(page.data.formCategory, '街面维护', '分类未改');
    assert.equal(page.data.formDate, '2026-11-19', '日期未改');
    assert.equal(page.data.formTime, '09:00', '时刻未改');
    assert.equal(page.data.formContact, '', '联系方式未改');
  } finally {
    restoreGlobals();
  }
});

test('断网后不能清空重来，草稿被保留', async () => {
  const { page, calls } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => options.fail({ errMsg: 'request:fail' }) }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const requestId = page.data.submitRequestId;

    page.onResetForm();
    assert.equal(page.data.formDescription, '合成商户诉求正文', '内容未被清空');
    assert.equal(page.data.submitRequestId, requestId, '请求号未被丢弃');
    assert.match(page.data.submitMessage, /不能清空重来/);

    // 也没有新的提交被发出。
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  } finally {
    restoreGlobals();
  }
});

test('断网后重试直接复用冻结的请求号与原字段', async () => {
  const attempts = [];
  const { page, calls } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    {
      submit: options => {
        attempts.push(options);
        if (attempts.length === 1) {
          options.fail({ errMsg: 'request:fail' });
          return;
        }
        options.success({
          statusCode: 200,
          data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
        });
      }
    }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const first = await readPayload(calls.find(call => call.method === 'POST'));

    // 即使页面数据被绕过界面改动，重试仍以冻结的原字段为准。
    page.setData({ formDescription: '被绕过的改动', formLocation: '被绕过的地点' });
    await page.onSubmitNewCase();
    await tick();

    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2, '重试发出一次请求');
    const second = await readPayload(posts[1]);
    assert.equal(second.clientRequestId, first.clientRequestId, '复用冻结的请求号');
    assert.equal(second.description, '合成商户诉求正文', '复用原字段');
    assert.equal(second.location, '合成商户地点');
    assert.equal(page.data.submitPending, false, '确认成功后解除锁定');
    assert.equal(page.data.submitReceipt.caseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('确认成功后才可开始新的申报', async () => {
  const attempts = [];
  const { page, calls } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    {
      submit: options => {
        attempts.push(options);
        if (attempts.length === 1) {
          options.fail({ errMsg: 'request:fail' });
          return;
        }
        options.success({
          statusCode: 200,
          data: { caseNumber: CASE_NUMBER, status: 'submitted', submittedAt: '2026-11-19T02:00:00.000Z' }
        });
      }
    }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitPending, false);

    // 成功后可以再改内容并重新提交，且是新的请求号。
    fillForm(page, { formDescription: '新的诉求正文' });
    assert.equal(page.data.formDescription, '新的诉求正文', '可以再编辑');
    await page.onSubmitNewCase();
    await tick();
    const posts = calls.filter(call => call.method === 'POST');
    const first = await readPayload(posts[0]);
    const last = await readPayload(posts[posts.length - 1]);
    assert.notEqual(last.clientRequestId, first.clientRequestId, '新申报用新请求号');
    assert.equal(last.description, '新的诉求正文');
  } finally {
    restoreGlobals();
  }
});

test('服务端明确拒绝时恢复可编辑', async () => {
  const { page } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => options.success({ statusCode: 400, data: { error: 'invalid_field' } }) }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitPending, false, '明确拒绝不锁定');
    page.onFormDescriptionInput({ detail: { value: '改正后的正文' } });
    assert.equal(page.data.formDescription, '改正后的正文', '可以修正');
    page.onResetForm();
    assert.equal(page.data.formDescription, '', '可以清空');
  } finally {
    restoreGlobals();
  }
});

test('409 不引导清空换号重交同一事项', async () => {
  const { page, calls } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => options.success({ statusCode: 409, data: { error: 'submission_conflict' } }) }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    const requestId = page.data.submitRequestId;

    assert.equal(page.data.submitPending, true, '409 后锁定');
    assert.ok(!/清空|换.*请求号|重新提交/.test(page.data.submitMessage), page.data.submitMessage);
    assert.match(page.data.submitMessage, /工单列表/);

    // 不能靠清空换号重交同一事项。
    page.onResetForm();
    assert.equal(page.data.submitRequestId, requestId, '请求号未被丢弃');
    assert.equal(page.data.formDescription, '合成商户诉求正文');

    // 重试仍是同一个请求号与原内容。
    await page.onSubmitNewCase();
    await tick();
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2);
    const first = await readPayload(posts[0]);
    const second = await readPayload(posts[1]);
    assert.equal(second.clientRequestId, first.clientRequestId);
    assert.deepEqual(second, first);
  } finally {
    restoreGlobals();
  }
});

test('退出或隐藏时如实说明结果未确认且无法续接', async () => {  const { page } = merchantPage(
    { merchantId: 'shop-a', permissions: ['submitCases'] },
    { submit: options => options.fail({ errMsg: 'request:fail' }) }
  );
  try {
    await login(page);
    fillForm(page);
    await page.onSubmitNewCase();
    await tick();
    assert.equal(page.data.submitPending, true);

    page.onHide();
    assert.equal(page._token, '', '令牌已清除');
    assert.equal(page._draft, null, '草稿已清除');
    assert.match(page.data.loginError, /未确认/);
    assert.match(page.data.loginError, /工单列表/);
    assert.equal(page.data.submitPending, false, '退出后不再显示待确认状态');
  } finally {
    restoreGlobals();
  }
});

test('服务地址不是本地回环时不带令牌发出提交', async () => {
  const config = require(path.join(miniprogramRoot, 'config.js'));
  const original = config.apiBaseUrl;
  const { page, calls } = merchantPage();
  try {
    await login(page);
    fillForm(page);
    config.apiBaseUrl = 'https://example.test';
    await page.onSubmitNewCase();
    await tick();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, '未发出请求');
    assert.match(page.data.submitMessage, /回环/);
    assert.equal(page.data.submitPending, false, '明确未发出，不锁定');
  } finally {
    config.apiBaseUrl = original;
    restoreGlobals();
  }
});

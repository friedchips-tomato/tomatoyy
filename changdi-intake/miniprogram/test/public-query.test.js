// 本地模拟检查：用 Node 模拟 wx.request 与 Page，验证公开查询的分支行为。
// 不启动微信开发者工具，不发起真实网络请求，不使用任何真实凭据。
// 运行：node miniprogram/test/public-query.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const { extractPublicCode, isValidCode, queryPublicCase, formatBeijingTime } =
  require(path.join(miniprogramRoot, 'pages/public/query.js'));
const config = require(path.join(miniprogramRoot, 'config.js'));

const VALID_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWX';
const BASE_URL = 'http://127.0.0.1:3400';

function fakeRequest(responder) {
  const calls = [];
  const request = options => {
    calls.push(options);
    responder(options, response => {
      if (response.ok) options.success(response.payload);
      else options.fail(response.error);
    });
  };
  request.calls = calls;
  return request;
}

function respondWith(statusCode, data) {
  return fakeRequest((options, done) => {
    options.__status = statusCode;
    done({ ok: true, payload: { statusCode, data } });
  });
}

function failWith(errMsg) {
  return fakeRequest((options, done) => {
    done({ ok: false, error: { errMsg } });
  });
}

test('公开码格式：仅接受 24 位字母数字下划线连字符', () => {
  assert.equal(isValidCode(VALID_CODE), true);
  assert.equal(isValidCode('ab_ABCDEFGHIJKLMNOPQRSTU'), true, '含下划线的 24 位');
  assert.equal(isValidCode('ab-CD_ABCDEFGHIJKLMNOPQR'), true, '含连字符的 24 位');
  assert.equal(isValidCode('ABCDEFGHIJKLMNOPQRSTUVW'), false, '少于 24 位');
  assert.equal(isValidCode('ABCDEFGHIJKLMNOPQRSTUVWXY'), false, '多于 24 位');
  assert.equal(isValidCode('ABCDEFGHIJKLMNOPQRSTUV!'), false, '含非法字符');
  assert.equal(isValidCode('ABCDEFGHIJKLMNOPQRSTUV X'), false, '含空格');
  assert.equal(isValidCode('中文中文中文中文中文中文中文'), false, '含中文');
  assert.equal(isValidCode(''), false);
});

test('入口参数与扫码内容只接受明确格式，不再从任意文本检索', () => {
  assert.equal(extractPublicCode(VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode(`  ${VALID_CODE}  `), VALID_CODE);
  assert.equal(extractPublicCode('c=' + VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode(`https://example.test/q?code=${VALID_CODE}`), VALID_CODE);
  assert.equal(extractPublicCode(`https://example.test/q?scene=c%3D${VALID_CODE}`), VALID_CODE);
  assert.equal(extractPublicCode(`https://example.test/q?scene=${VALID_CODE}`), VALID_CODE);
  assert.equal(extractPublicCode(`https://example.test/q?publicLookupCode=${VALID_CODE}`), VALID_CODE);
  assert.equal(extractPublicCode('https://example.test/q?code=short'), '', '无效码不返回');
  assert.equal(extractPublicCode('https://evil.example.test/steal'), '', '无参数不返回地址');
  assert.equal(extractPublicCode('这里有一个码 ' + VALID_CODE + ' 请查'), '', '任意文本不再检索');
  assert.equal(extractPublicCode('前缀' + VALID_CODE), '', '连在词尾的码不再接受');
  assert.equal(extractPublicCode('/other/pages/index'), '', '无参数路径不返回');
});

test('识别小程序路径中的 scene 与 code', () => {
  assert.equal(extractPublicCode('/pages/public/index?code=' + VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode('/pages/public/index?scene=' + VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode('/pages/public/index?scene=c%3D' + VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode('/pages/public/index?publicLookupCode=' + VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode('/pages/public/index?scene=c%3D' + VALID_CODE + '&from=scan'), VALID_CODE);
  assert.equal(extractPublicCode('/pages/public/index'), '', '无参数路径不返回');
});

test('构建请求始终使用自有基址，不使用扫码内容中的地址', async () => {
  const request = respondWith(200, {
    caseNumber: 'CD-0123456789ABCDEF0123456789ABCDEF',
    status: 'submitted',
    milestones: []
  });
  await queryPublicCase({ request, baseUrl: BASE_URL, code: VALID_CODE, timeout: 1000 });
  const url = request.calls[0].url;
  assert.ok(url.startsWith(BASE_URL + '/api/v1/public/cases/'), url);
  assert.ok(url.endsWith(VALID_CODE));
});

test('成功：只呈现编号、中文状态与可公开时间节点', async () => {
  const request = respondWith(200, {
    caseNumber: 'CD-0123456789ABCDEF0123456789ABCDEF',
    status: 'submitted',
    milestones: [{ status: 'submitted', occurredAt: '2026-11-19T01:00:00.000Z' }]
  });
  const result = await queryPublicCase({ request, baseUrl: BASE_URL, code: VALID_CODE, timeout: 1000 });
  assert.equal(result.kind, 'success');
  assert.equal(result.caseNumber, 'CD-0123456789ABCDEF0123456789ABCDEF');
  assert.equal(result.statusText, '已提交');
  assert.equal(result.milestones.length, 1);
  assert.equal(result.milestones[0].label, '已提交');
  assert.equal(result.milestones[0].timeText, '2026-11-19 09:00');
  assert.equal(result.description, undefined, '不返回申报正文');
  assert.equal(result.photos, undefined, '不返回照片');
});

test('待复核对公众显示为处理中', async () => {
  const request = respondWith(200, {
    caseNumber: 'CD-0123456789ABCDEF0123456789ABCDEF',
    status: 'processing',
    milestones: [{ status: 'awaiting_review', occurredAt: '2026-11-19T01:00:00.000Z' }]
  });
  const result = await queryPublicCase({ request, baseUrl: BASE_URL, code: VALID_CODE, timeout: 1000 });
  assert.equal(result.statusText, '处理中');
});

test('404 提示无法查询', async () => {
  const request = respondWith(404, { error: 'case_not_found' });
  const result = await queryPublicCase({ request, baseUrl: BASE_URL, code: VALID_CODE, timeout: 1000 });
  assert.equal(result.kind, 'notfound');
  assert.match(result.message, /重新扫描回执/);
});

test('网络失败与超时分开处理', async () => {
  const failed = await queryPublicCase({
    request: failWith('request:fail'),
    baseUrl: BASE_URL,
    code: VALID_CODE,
    timeout: 1000
  });
  assert.equal(failed.kind, 'network');

  const timedOut = await queryPublicCase({
    request: failWith('request:fail timeout'),
    baseUrl: BASE_URL,
    code: VALID_CODE,
    timeout: 1000
  });
  assert.equal(timedOut.kind, 'timeout');
  assert.match(timedOut.message, /超时/);
});

test('非法公开码不发起请求', async () => {
  const request = respondWith(200, {});
  const result = await queryPublicCase({ request, baseUrl: BASE_URL, code: 'short', timeout: 1000 });
  assert.equal(result.kind, 'invalid');
  assert.equal(request.calls.length, 0, '非法码不触网');
});

test('服务端错误码不被当作成功', async () => {
  const request = respondWith(500, { error: 'internal_error' });
  const result = await queryPublicCase({ request, baseUrl: BASE_URL, code: VALID_CODE, timeout: 1000 });
  assert.equal(result.kind, 'error');
});

test('响应体缺少必要字段时不渲染', async () => {
  const request = respondWith(200, { caseNumber: 'CD-X' });
  const result = await queryPublicCase({ request, baseUrl: BASE_URL, code: VALID_CODE, timeout: 1000 });
  assert.equal(result.kind, 'error');
});

test('时间按北京时间显示', () => {
  assert.equal(formatBeijingTime('2026-11-19T01:00:00.000Z'), '2026-11-19 09:00');
  assert.equal(formatBeijingTime('2026-11-19T01:00:00+08:00'), '2026-11-19 01:00');
  assert.equal(formatBeijingTime('not-a-time'), '');
});

test('配置指向本地开发基址', () => {
  assert.equal(config.apiBaseUrl, 'http://127.0.0.1:3400');
  assert.ok(!/^https?:/.test(config.apiBaseUrl) === false);
  assert.ok(!config.apiBaseUrl.includes('example.com'));
});

// 页面层：模拟 Page 与 wx，验证加载、重复提交与旧请求晚到覆盖的处理。
// 页面在 lookup 时才调用 wx.request，因此全局 wx 要保持到用例结束。
function loadPublicPage() {
  const modulePath = path.join(miniprogramRoot, 'pages/public/index.js');
  delete require.cache[require.resolve(modulePath)];
  let page = null;
  const scanCalls = [];
  global.Page = definition => { page = definition; };
  global.wx = {
    request: options => page.__request(options),
    scanCode: options => { scanCalls.push(options); },
    navigateBack: () => {}
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  page.__scanCalls = scanCalls;
  return page;
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

test('页面：重复提交时后发请求覆盖前一次', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => { resolvers.push(options); };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    page.lookup(VALID_CODE);
    assert.equal(resolvers.length, 2);

    // 先发的请求后到，其结果不得覆盖后发请求的结果。
    resolvers[0].success({
      statusCode: 200,
      data: { caseNumber: 'CD-OLD', status: 'submitted', milestones: [] }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.state, 'loading', '旧响应被丢弃，仍为加载中');

    resolvers[1].success({
      statusCode: 200,
      data: { caseNumber: 'CD-NEW', status: 'processing', milestones: [] }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.state, 'success');
    assert.equal(page.data.caseNumber, 'CD-NEW');
  } finally {
    restoreGlobals();
  }
});

test('页面：非法输入只提示不请求', () => {
  let called = 0;
  const page = loadPublicPage();
  page.__request = () => { called += 1; };
  try {
    page.onLoad({});
    page.setData({ code: 'bad' });
    page.onSubmit();
    assert.equal(called, 0);
    assert.equal(page.data.state, 'invalid');
  } finally {
    restoreGlobals();
  }
});

test('页面：入口 scene 参数自动查询', async () => {
  const page = loadPublicPage();
  page.__request = options => options.success({
    statusCode: 200,
    data: { caseNumber: 'CD-S', status: 'submitted', milestones: [] }
  });
  try {
    page.onLoad({ scene: `c=${VALID_CODE}` });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.state, 'success');
    assert.equal(page.data.caseNumber, 'CD-S');
  } finally {
    restoreGlobals();
  }
});

test('页面：扫码取消时留在本页且保留已输入内容', () => {
  const page = loadPublicPage();
  page.__request = () => {};
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.onScanTap();
    assert.equal(page.__scanCalls.length, 1);
    page.__scanCalls[0].fail({ errMsg: 'scanCode:fail cancel' });
    assert.equal(page.data.code, VALID_CODE, '取消后保留输入');
    assert.equal(page.data.state, 'idle', '取消后不改变状态');
  } finally {
    restoreGlobals();
  }
});

test('页面：扫码直达且无上一页时，“返回首页”打开首页', () => {
  const page = loadPublicPage();
  const destinations = [];
  global.wx.navigateBack = options => options.fail({ errMsg: '没有上一页' });
  global.wx.reLaunch = options => destinations.push(options.url);
  try {
    page.onLoad({});
    page.onBackTap();
    assert.deepEqual(destinations, ['/pages/home/index']);
  } finally {
    restoreGlobals();
  }
});

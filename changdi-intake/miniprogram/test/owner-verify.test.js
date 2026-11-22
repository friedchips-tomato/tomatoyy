// 公开查询的作废处理与本人核验流程的本地模拟检查。
// 用 Node 模拟 wx.request 与 Page，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const { statusText } = require(path.join(miniprogramRoot, 'pages/public/query.js'));

const VALID_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWX';
const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const TOKEN = 'owner.1000.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZab';

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

const tick = () => new Promise(resolve => setImmediate(resolve));

function okPublic(caseNumber = 'CD-STALE') {
  return {
    statusCode: 200,
    data: { caseNumber, status: 'submitted', milestones: [] }
  };
}

test('reopen_pending 状态有中文显示', () => {
  assert.equal(statusText('reopen_pending'), '补办待审核');
  assert.equal(statusText('awaiting_evaluation'), '待评价');
  assert.equal(statusText('unknown_status'), '状态更新中');
});

test('页面：输入变化作废在途请求', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => { resolvers.push(options); };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    assert.equal(resolvers.length, 1);

    page.onInput({ detail: { value: 'ABCD' } });
    resolvers[0].success(okPublic());
    await tick();
    assert.equal(page.data.state, 'idle', '旧响应被丢弃');
    assert.equal(page.data.caseNumber, '', '不显示旧结果');
  } finally {
    restoreGlobals();
  }
});

test('页面：无效提交作废在途请求', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => { resolvers.push(options); };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);

    page.setData({ code: 'bad' });
    page.onSubmit();
    assert.equal(page.data.state, 'invalid');

    resolvers[0].success(okPublic());
    await tick();
    assert.equal(page.data.state, 'invalid', '旧响应不覆盖无效提示');
    assert.equal(page.data.caseNumber, '');
  } finally {
    restoreGlobals();
  }
});

test('页面：无效扫码结果作废在途请求', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => { resolvers.push(options); };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);

    page.onScanTap();
    page.__scanCalls[0].success({ result: '这里有一个码 ' + VALID_CODE });
    assert.equal(page.data.state, 'invalid');

    resolvers[0].success(okPublic());
    await tick();
    assert.equal(page.data.state, 'invalid');
    assert.equal(page.data.caseNumber, '');
  } finally {
    restoreGlobals();
  }
});

test('页面：退出页面作废在途请求', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => { resolvers.push(options); };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);

    page.onUnload();
    resolvers[0].success(okPublic());
    await tick();
    assert.equal(page.data.state, 'loading', '退出后旧响应不写回页面');
    assert.equal(page.data.caseNumber, '');
  } finally {
    restoreGlobals();
  }
});

test('本人核验：成功后取到详情，凭证清空且只留在内存', async () => {
  const calls = [];
  const page = loadPublicPage();
  page.__request = options => {
    calls.push(options);
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({
        statusCode: 200,
        data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' }
      });
      return;
    }
    options.success({
      statusCode: 200,
      data: {
        caseNumber: CASE_NUMBER,
        status: 'awaiting_evaluation',
        round: 1,
        rounds: [
          {
            round: 1,
            feedback: { publishedAt: '2026-11-19T01:00:00.000Z', summary: '已修复盲道砖块。', photos: [] },
            evaluation: null
          }
        ],
        history: [],
        availableActions: []
      }
    });
  };
  try {
    page.onLoad({});
    // 核验入口绑定最后一次成功公开查询，先做公开查询。
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();
    page.setData({ privateToken: 'a'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    await tick();

    assert.equal(page.data.verifyState, 'success');
    assert.equal(page.data.ownerCaseNumber, CASE_NUMBER);
    assert.equal(page.data.ownerRound, '1');
    assert.equal(page.data.ownerStatusText, '待评价');
    assert.equal(page.data.ownerRounds.length, 1);
    assert.equal(page.data.ownerRounds[0].summary, '已修复盲道砖块。');
    assert.equal(page.data.privateToken, '', '凭证输入已清空');

    const serialized = JSON.stringify(page.data);
    assert.ok(!serialized.includes('a'.repeat(43)), '凭证不在页面数据中');
    assert.ok(!serialized.includes('owner.1000.'), '会话令牌不在页面数据中');

    const verifyCall = calls.find(call => call.url.endsWith('/api/v1/owner/verify'));
    assert.equal(verifyCall.header && verifyCall.header.Authorization, undefined, '核验请求不带授权头');
    assert.equal(verifyCall.data.privateLookupToken, 'a'.repeat(43));
    assert.ok(!verifyCall.url.includes('a'.repeat(43)), '凭证不进 URL');

    const detailCall = calls.find(call => call.url.includes('/api/v1/owner/cases/'));
    assert.equal(detailCall.url, configBase() + '/api/v1/owner/cases/' + CASE_NUMBER);
    assert.ok(detailCall.header.Authorization.startsWith('Bearer owner.'));
  } finally {
    restoreGlobals();
  }
});

function configBase() {
  return require(path.join(miniprogramRoot, 'config.js')).apiBaseUrl;
}

test('本人核验：凭证错误时不保留私密数据', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'submitted', milestones: [] } });
      return;
    }
    options.success({ statusCode: 401, data: { error: 'invalid_private_lookup_token' } });
  };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();
    page.setData({ privateToken: 'b'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    assert.equal(page.data.verifyState, 'unauthorized');
    assert.equal(page.data.privateToken, '', '失败后输入清空');
    assert.equal(page.ownerSessionToken, '', '失败后无会话令牌');
    assert.ok(!JSON.stringify(page).includes('b'.repeat(43)), '凭证不在页面对象中');
  } finally {
    restoreGlobals();
  }
});

test('本人核验：授权过期时清除私密数据', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'submitted', milestones: [] } });
      return;
    }
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({
        statusCode: 200,
        data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' }
      });
      return;
    }
    options.success({ statusCode: 401, data: { error: 'owner_authorization_required' } });
  };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();
    page.setData({ privateToken: 'c'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    await tick();

    assert.equal(page.data.verifyState, 'unauthorized');
    assert.equal(page.ownerSessionToken, '', '授权过期后清除令牌');
    assert.equal(page.ownerCaseNumber, '');
    assert.equal(page.data.ownerCaseNumber, '');
    assert.equal(page.data.ownerRounds.length, 0);
  } finally {
    restoreGlobals();
  }
});

test('本人核验：旧响应不得覆盖较新的一次核验', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'submitted', milestones: [] } });
      return;
    }
    resolvers.push(options);
  };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();
    page.setData({ privateToken: 'd'.repeat(43) });
    page.onVerifySubmit();
    // 提交后输入已清空，第二次核验需重新输入凭证。
    page.setData({ privateToken: 'd'.repeat(43) });
    page.onVerifySubmit();
    assert.equal(resolvers.length, 2);

    // 旧核验后到，编号与当前绑定一致但序号过期，应被丢弃。
    resolvers[0].success({
      statusCode: 200,
      data: { caseNumber: CASE_NUMBER, ownerSessionToken: 'owner.1.a.' + 'x'.repeat(43), expiresAt: '2026-11-19T02:00:00.000Z' }
    });
    await tick();
    assert.equal(page.data.verifyState, 'loading', '旧核验响应被丢弃');

    resolvers[1].success({
      statusCode: 200,
      data: { caseNumber: CASE_NUMBER, ownerSessionToken: 'owner.1.b.' + 'y'.repeat(43), expiresAt: '2026-11-19T02:00:00.000Z' }
    });
    await tick();
    // 核验通过后会再取一次详情，该请求同样受序号保护。
    assert.equal(resolvers.length, 3);
    resolvers[2].success({
      statusCode: 200,
      data: { caseNumber: CASE_NUMBER, status: 'processing', round: 1, rounds: [] }
    });
    await tick();
    assert.equal(page.data.verifyState, 'success');
    assert.equal(page.data.ownerCaseNumber, CASE_NUMBER);
  } finally {
    restoreGlobals();
  }
});

test('本人核验：退出页面清除凭证与授权', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({
        statusCode: 200,
        data: { caseNumber: 'CD-X', ownerSessionToken: 'owner.1.c.' + 'z'.repeat(43), expiresAt: '2026-11-19T02:00:00.000Z' }
      });
      return;
    }
    options.success({ statusCode: 200, data: { caseNumber: 'CD-X', status: 'processing', round: 1, rounds: [] } });
  };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();
    page.setData({ privateToken: 'e'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    await tick();
    assert.equal(page.data.verifyState, 'success');

    page.onUnload();
    assert.equal(page.ownerSessionToken, '', '退出后无令牌');
    assert.equal(page.ownerCaseNumber, '');
    assert.equal(page.data.privateToken, '');
    assert.equal(page.data.ownerCaseNumber, '');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.ok(!JSON.stringify(page).includes('e'.repeat(43)), '凭证不在页面对象中');
  } finally {
    restoreGlobals();
  }
});

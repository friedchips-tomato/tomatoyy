// 本人动作、状态隔离与扫码回退的本地模拟检查。
// 用 Node 模拟 wx.request 与 Page，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const { extractPublicCode } = require(path.join(miniprogramRoot, 'pages/public/query.js'));

const VALID_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWX';
const OTHER_CODE = 'ZYXWVUTSRQPONMLKJIHGFEDC';
const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const OTHER_CASE = 'CD-FEDCBA9876543210FEDCBA9876543210';
const TOKEN = 'owner.1000.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZab';

for (const [name, value] of [['VALID_CODE', VALID_CODE], ['OTHER_CODE', OTHER_CODE]]) {
  if (!/^[A-Za-z0-9_-]{24}$/.test(value)) {
    throw new Error(name + ' 必须是 24 位公开码，当前为 ' + value.length + ' 位');
  }
}

function loadPublicPage() {
  const modulePath = path.join(miniprogramRoot, 'pages/public/index.js');
  delete require.cache[require.resolve(modulePath)];
  let page = null;
  const scanCalls = [];
  const modalCalls = [];
  global.Page = definition => { page = definition; };
  global.wx = {
    request: options => page.__request(options),
    scanCode: options => { scanCalls.push(options); },
    navigateBack: () => {},
    showModal: options => { modalCalls.push(options); }
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  page.__scanCalls = scanCalls;
  page.__modalCalls = modalCalls;
  return page;
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// 建立一个已核验并加载本人详情的页面。
function verifiedPage(overrides = {}) {
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
    if (options.url.includes('/actions')) {
      options.success({ statusCode: 200, data: ownerDetail({ version: 2 }) });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      // 切换到另一个公开码时返回另一个工单编号。
      const caseNumber = options.url.endsWith(OTHER_CODE) ? OTHER_CASE : CASE_NUMBER;
      options.success({ statusCode: 200, data: { caseNumber, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    options.success({ statusCode: 200, data: ownerDetail({ version: 1, ...overrides }) });
  };
  return { page, calls };
}

function ownerDetail({ version = 1, availableActions = ['evaluate', 'confirm_resolved', 'request_reopen'] } = {}) {
  return {
    caseNumber: CASE_NUMBER,
    status: 'awaiting_evaluation',
    version,
    round: 1,
    evaluationEndsAt: '2026-11-26T02:00:00.000Z',
    reopenEndsAt: '2026-11-29T02:00:00.000Z',
    availableActions,
    history: [],
    rounds: [
      {
        round: 1,
        feedback: { publishedAt: '2026-11-19T01:00:00.000Z', summary: '已修复盲道砖块。', photos: [] },
        evaluation: null
      }
    ],
    reopenRequests: []
  };
}

async function verifyAndLoad(page) {
  page.onLoad({});
  // 核验入口绑定最后一次成功公开查询，先做公开查询。
  page.setData({ code: VALID_CODE });
  page.lookup(VALID_CODE);
  await tick();
  page.setData({ privateToken: 'a'.repeat(43) });
  page.onVerifySubmit();
  await tick();
  await tick();
}

test('扫码回退：result 无有效内容时用 path 解析', () => {
  const page = loadPublicPage();
  let requested = null;
  page.__request = options => {
    requested = options;
    options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'submitted', milestones: [] } });
  };
  try {
    page.onLoad({});
    page.onScanTap();
    // result.result 不含码，path 含 scene 时应回退到 path。
    page.__scanCalls[0].success({ result: '', path: '/pages/public/index?scene=c%3D' + VALID_CODE });
    assert.ok(requested.url.endsWith(VALID_CODE), requested.url);
    assert.equal(page.data.code, VALID_CODE);
  } finally {
    restoreGlobals();
  }
});

test('扫码回退：result 有效时优先使用 result', () => {
  const page = loadPublicPage();
  let requested = null;
  page.__request = options => {
    requested = options;
    options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'submitted', milestones: [] } });
  };
  try {
    page.onLoad({});
    page.onScanTap();
    page.__scanCalls[0].success({
      result: 'https://example.test/q?code=' + VALID_CODE,
      path: '/pages/public/index?scene=c%3D' + OTHER_CODE
    });
    assert.ok(requested.url.endsWith(VALID_CODE), requested.url);
  } finally {
    restoreGlobals();
  }
});

test('切换工单时清空本人详情、授权与界面', async () => {
  const { page } = verifiedPage();
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.verifyState, 'success');
    assert.equal(page.data.ownerCaseNumber, CASE_NUMBER);
    assert.equal(page.data.ownerRounds.length, 1);

    // 切换到另一公开码。
    page.setData({ code: OTHER_CODE });
    page.onSubmit();
    await tick();

    assert.equal(page.data.showVerify, false, '核验界面关闭');
    assert.equal(page.data.ownerCaseNumber, '', '本人详情清空');
    assert.equal(page.data.ownerRounds.length, 0, '旧反馈不再显示');
    assert.equal(page.data.availableActions.length, 0, '旧动作权限清空');
    assert.equal(page.data.privateToken, '', '凭证输入清空');
    assert.equal(page.ownerSessionToken, '', '授权清空');
    assert.equal(page.ownerCaseNumber, '');
    // 核验入口改为绑定新查到的工单，而不是旧工单。
    assert.equal(page.lastPublicCaseNumber, OTHER_CASE, '核验入口绑定新编号');
    assert.equal(page.data.ownerCaseNumber, '', '不显示旧工单详情');
  } finally {
    restoreGlobals();
  }
});

test('输入变化清空本人数据与授权', async () => {
  const { page } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.onInput({ detail: { value: 'ABCD' } });
    assert.equal(page.data.showVerify, false);
    assert.equal(page.data.ownerCaseNumber, '');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.equal(page.ownerSessionToken, '');
  } finally {
    restoreGlobals();
  }
});

test('无效扫码结果清空本人数据', async () => {
  const { page } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.onScanTap();
    page.__scanCalls[0].success({ result: '无法识别的内容' });
    assert.equal(page.data.showVerify, false);
    assert.equal(page.data.ownerCaseNumber, '');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.equal(page.ownerSessionToken, '');
  } finally {
    restoreGlobals();
  }
});

test('页面隐藏清空本人数据并作废本人在途请求', async () => {
  const { page } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.onHide();
    assert.equal(page.data.showVerify, false);
    assert.equal(page.data.ownerCaseNumber, '');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.equal(page.ownerSessionToken, '');
  } finally {
    restoreGlobals();
  }
});

test('核验入口绑定最后成功的公开码与编号', async () => {
  const page = loadPublicPage();
  const seen = [];
  page.__request = options => {
    seen.push(options);
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
    assert.equal(page.lastPublicCode, VALID_CODE);
    assert.equal(page.lastPublicCaseNumber, CASE_NUMBER);

    page.onVerifyOpen();
    assert.equal(page.data.showVerify, true);

    page.setData({ privateToken: 'z'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    const verifyCall = seen.find(call => call.url.endsWith('/api/v1/owner/verify'));
    assert.equal(verifyCall.data.publicLookupCode, VALID_CODE, '核验用最后成功的公开码');
  } finally {
    restoreGlobals();
  }
});

test('核验回复的工单与公开查询不一致时拒绝', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'submitted', milestones: [] } });
      return;
    }
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({
        statusCode: 200,
        data: { caseNumber: OTHER_CASE, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' }
      });
      return;
    }
    options.success({ statusCode: 200, data: ownerDetail() });
  };
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();

    page.setData({ privateToken: 'z'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    assert.equal(page.data.verifyState, 'invalid');
    assert.equal(page.data.ownerCaseNumber, '', '不显示不一致工单的详情');
    assert.equal(page.ownerSessionToken, '');
  } finally {
    restoreGlobals();
  }
});

test('提交凭证后立即清空输入，核验成功后隐藏凭证框', async () => {
  const { page } = verifiedPage();
  try {
    page.onLoad({});
    page.setData({ code: VALID_CODE });
    page.lookup(VALID_CODE);
    await tick();

    page.setData({ privateToken: 'a'.repeat(43) });
    page.onVerifySubmit();
    // 提交即清空，不等结果回来。
    assert.equal(page.data.privateToken, '', '提交后输入立即清空');

    await tick();
    await tick();
    assert.equal(page.data.verifyState, 'success');
    // 成功后凭证框与验证按钮不再显示（WXML 以 verifyState !== success 控制）。
    assert.equal(page.data.privateToken, '');
  } finally {
    restoreGlobals();
  }
});

test('动作按 availableActions 显示', async () => {
  const { page } = verifiedPage({ availableActions: ['evaluate'] });
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.showEvaluate, true);
    assert.equal(page.data.showConfirm, false, '未授权的动作不显示');
    assert.equal(page.data.showReopen, false);
  } finally {
    restoreGlobals();
  }
});

test('evaluate 带三项分数与意见，expectedVersion 取自详情', async () => {
  const { page, calls } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 4, attitude: 5 }, comment: '处理很快' });
    page.onEvaluateSubmit();
    await tick();

    const actionCall = calls.find(call => call.url.includes('/actions'));
    assert.ok(actionCall, '发出动作请求');
    assert.equal(actionCall.method, 'POST');
    assert.equal(actionCall.data.action, 'evaluate');
    assert.equal(actionCall.data.expectedVersion, 1, '版本取自详情');
    assert.equal(actionCall.data.speed, 5);
    assert.equal(actionCall.data.effectiveness, 4);
    assert.equal(actionCall.data.attitude, 5);
    assert.equal(actionCall.data.comment, '处理很快');
  } finally {
    restoreGlobals();
  }
});

test('评分缺失时不合规，不发请求', async () => {
  const { page, calls } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 0, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 0);
    assert.equal(page.data.actionState, 'invalid');
  } finally {
    restoreGlobals();
  }
});

test('单次写入锁：进行中不接受第二个动作', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' } });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    if (options.url.includes('/actions')) {
      resolvers.push(options);
      return;
    }
    options.success({ statusCode: 200, data: ownerDetail() });
  };
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    page.onEvaluateSubmit();
    assert.equal(resolvers.length, 1, '第二个动作被拒绝');
    assert.equal(page.data.actionState, 'busy');

    resolvers[0].success({ statusCode: 200, data: ownerDetail({ version: 2 }) });
    await tick();
    assert.equal(page.data.actionState, 'idle');
  } finally {
    restoreGlobals();
  }
});

test('409 后刷新详情确认结果，再允许重试', async () => {
  const resolvers = [];
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' } });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    if (options.url.includes('/actions')) {
      resolvers.push(options);
      return;
    }
    options.success({ statusCode: 200, data: ownerDetail({ version: 3 }) });
  };
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    assert.equal(resolvers.length, 1);

    resolvers[0].success({ statusCode: 409, data: { error: 'stale_version' } });
    await tick();
    assert.equal(page.data.actionState, 'conflict');
    // 409 后自动刷新详情以确认结果。
    assert.ok(resolvers.length >= 1);
    await tick();
    assert.equal(page.ownerVersion, 3, '刷新后取到新版本');
  } finally {
    restoreGlobals();
  }
});

test('401 后清除授权与本人详情', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' } });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    if (options.url.includes('/actions')) {
      options.success({ statusCode: 401, data: { error: 'owner_authorization_required' } });
      return;
    }
    options.success({ statusCode: 200, data: ownerDetail() });
  };
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();

    assert.equal(page.ownerSessionToken, '', '授权已清除');
    assert.equal(page.data.ownerCaseNumber, '', '详情已清除');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.equal(page.data.showEvaluate, false, '停止显示本人内容');
  } finally {
    restoreGlobals();
  }
});

test('confirm_resolved 需要确认步骤', async () => {
  const { page, calls } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.onConfirmResolved();
    assert.equal(page.__modalCalls.length, 1, '先弹确认');
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 0, '未确认不发请求');

    page.__modalCalls[0].success({ confirm: true });
    await tick();
    const actionCall = calls.find(call => call.url.includes('/actions'));
    assert.ok(actionCall);
    assert.equal(actionCall.data.action, 'confirm_resolved');
    assert.equal(actionCall.data.expectedVersion, 1);
  } finally {
    restoreGlobals();
  }
});

test('确认取消时不发请求', async () => {
  const { page, calls } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.onConfirmResolved();
    page.__modalCalls[0].success({ confirm: false });
    await tick();
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 0);
  } finally {
    restoreGlobals();
  }
});

test('request_reopen 原因必填', async () => {
  const { page, calls } = verifiedPage();
  try {
    await verifyAndLoad(page);
    page.onReopenSubmit();
    await tick();
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 0, '缺原因不发请求');
    assert.equal(page.data.actionState, 'invalid');

    page.setData({ reopenReason: '盲道仍未修复' });
    page.onReopenSubmit();
    await tick();
    const actionCall = calls.find(call => call.url.includes('/actions'));
    assert.ok(actionCall);
    assert.equal(actionCall.data.action, 'request_reopen');
    assert.equal(actionCall.data.reason, '盲道仍未修复');
    assert.equal(actionCall.data.expectedVersion, 1);
  } finally {
    restoreGlobals();
  }
});

test('每轮已发布反馈与评价在详情中保留', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' } });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    options.success({
      statusCode: 200,
      data: {
        caseNumber: CASE_NUMBER,
        status: 'awaiting_evaluation',
        version: 4,
        round: 2,
        availableActions: ['confirm_resolved'],
        history: [],
        rounds: [
          { round: 1, feedback: { publishedAt: '2026-11-19T01:00:00.000Z', summary: '第一轮反馈。', photos: [] }, evaluation: { speed: 4, effectiveness: 4, attitude: 5, comment: '还不错', submittedAt: '2026-11-19T02:00:00.000Z' } },
          { round: 2, feedback: { publishedAt: '2026-11-20T01:00:00.000Z', summary: '第二轮反馈。', photos: [] }, evaluation: null }
        ],
        reopenRequests: [
          { round: 1, previousStatus: 'closed', reason: '仍未修复', requestedAt: '2026-11-19T03:00:00.000Z', decision: null, decisionReason: null, decidedAt: null }
        ]
      }
    });
  };
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.ownerRounds.length, 2, '两轮反馈都在');    assert.equal(page.data.ownerRounds[0].summary, '第一轮反馈。');
    assert.equal(page.data.ownerRounds[0].evaluated, true);
    assert.equal(page.data.ownerRounds[0].speed, 4);
    assert.equal(page.data.ownerRounds[1].summary, '第二轮反馈。');
    assert.equal(page.data.ownerRounds[1].evaluated, false);
    assert.equal(page.data.reopenRequests.length, 1);
    assert.equal(page.data.reopenRequests[0].decision, '', '待审核时决定为空');
  } finally {
    restoreGlobals();
  }
});

test('授权过期后停止显示本人详情', async () => {
  const page = loadPublicPage();
  page.__request = options => {
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN, expiresAt: '2026-11-19T02:00:00.000Z' } });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    options.success({ statusCode: 401, data: { error: 'owner_authorization_required' } });
  };
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.verifyState, 'unauthorized');
    assert.equal(page.data.ownerCaseNumber, '');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.equal(page.ownerSessionToken, '');
  } finally {
    restoreGlobals();
  }
});

test('提取公开码：路径形态可用', () => {
  assert.equal(extractPublicCode('/pages/public/index?scene=c%3D' + VALID_CODE), VALID_CODE);
  assert.equal(extractPublicCode('/pages/public/index?code=' + VALID_CODE), VALID_CODE);
});

// 本人文字补件（T05）与待补充材料状态的本地模拟检查。
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
  global.Page = definition => { page = definition; };
  global.wx = {
    request: options => page.__request(options),
    scanCode: () => {},
    navigateBack: () => {},
    showModal: options => options.success({ confirm: true })
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

// 待补充材料的本人详情。
function supplementDetail({ version = 2, requirement = { reason: '请补充问题发生的具体时段', requestedAt: '2026-11-19T03:00:00.000Z' } } = {}) {
  return {
    caseNumber: CASE_NUMBER,
    status: 'awaiting_supplement',
    version,
    round: 1,
    evaluationEndsAt: '2026-11-26T02:00:00.000Z',
    reopenEndsAt: '2026-11-29T02:00:00.000Z',
    availableActions: ['submit_supplement'],
    supplementRequirement: requirement,
    history: [],
    rounds: [],
    reopenRequests: []
  };
}

// 补交成功后的详情：原单回到待受理。
function pendingIntakeDetail({ version = 3 } = {}) {
  return {
    caseNumber: CASE_NUMBER,
    status: 'submitted',
    version,
    round: 1,
    availableActions: [],
    supplementRequirement: null,
    history: [],
    rounds: [],
    reopenRequests: []
  };
}

// 页面：核验后返回待补充材料详情，提交动作可控制。
function supplementPage({ onAction, detail } = {}) {
  const calls = [];
  const page = loadPublicPage();
  let loads = 0;
  page.__request = options => {
    calls.push(options);
    if (options.url.endsWith('/api/v1/owner/verify')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, ownerSessionToken: TOKEN } });
      return;
    }
    if (options.url.includes('/api/v1/public/cases/')) {
      options.success({ statusCode: 200, data: { caseNumber: CASE_NUMBER, status: 'awaiting_supplement', milestones: [] } });
      return;
    }
    if (options.url.includes('/actions')) {
      if (onAction) return onAction(options);
      options.success({ statusCode: 200, data: pendingIntakeDetail() });
      return;
    }
    loads += 1;
    options.success({ statusCode: 200, data: detail ? detail(loads) : supplementDetail() });
  };
  return { page, calls };
}

async function verifyAndLoad(page) {
  page.onLoad({});
  page.setData({ code: VALID_CODE });
  page.lookup(VALID_CODE);
  await tick();
  page.setData({ privateToken: 'a'.repeat(43) });
  page.onVerifySubmit();
  await tick();
  await tick();
}

test('待补充材料有中文状态', () => {
  assert.equal(statusText('awaiting_supplement'), '待补充材料');
});

test('待补充材料时显示补件入口与要求说明', async () => {
  const { page } = supplementPage();
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.verifyState, 'success');
    assert.equal(page.data.ownerStatusText, '待补充材料');
    assert.equal(page.data.showSupplement, true, '显示补件入口');
    assert.equal(page.data.supplementReason, '请补充问题发生的具体时段');
    assert.match(page.data.supplementRequestedText, /2026-11-19 11:00/);
  } finally {
    restoreGlobals();
  }
});

test('补件说明为必填，缺失时不发请求', async () => {
  const { page, calls } = supplementPage();
  try {
    await verifyAndLoad(page);
    page.setData({ supplementSummary: '   ' });
    page.onSupplementSubmit();
    await tick();
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 0, '缺说明不发请求');
    assert.equal(page.data.actionState, 'invalid');
    assert.match(page.data.actionMessage, /补件说明/);
  } finally {
    restoreGlobals();
  }
});

test('补件带工单版本与说明，成功后原单回到待受理', async () => {
  const { page, calls } = supplementPage();
  try {
    await verifyAndLoad(page);
    page.setData({ supplementSummary: '问题出现在上午十点左右' });
    page.onSupplementSubmit();
    await tick();

    const actionCall = calls.find(call => call.url.includes('/actions'));
    assert.ok(actionCall, '发出补件请求');
    assert.equal(actionCall.method, 'POST');
    assert.equal(actionCall.data.action, 'submit_supplement');
    assert.equal(actionCall.data.expectedVersion, 2, '版本取自详情');
    assert.equal(actionCall.data.summary, '问题出现在上午十点左右');

    assert.equal(page.data.showSupplement, false, '补件入口收起');
    assert.equal(page.data.ownerStatusText, '已提交', '原单回到待受理状态');
    assert.match(page.data.supplementNotice, /待受理/);
    assert.equal(page.data.supplementSummary, '', '补件说明已清空');
  } finally {
    restoreGlobals();
  }
});

test('补件沿用写入锁：提交进行中不接受第二次补件', async () => {
  const pending = [];
  const { page, calls } = supplementPage({
    onAction: options => pending.push(options)
  });
  try {
    await verifyAndLoad(page);
    page.setData({ supplementSummary: '问题出现在上午十点左右' });
    page.onSupplementSubmit();
    page.onSupplementSubmit();
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 1, '第二次补件被拒绝');
    assert.equal(page.data.actionState, 'busy');

    pending[0].success({ statusCode: 200, data: pendingIntakeDetail() });
    await tick();
    assert.equal(page.data.actionState, 'idle');
  } finally {
    restoreGlobals();
  }
});

test('补件版本冲突时刷新详情确认结果，期间不再发写请求', async () => {
  const pending = [];
  let actionCount = 0;
  const { page, calls } = supplementPage({
    onAction: options => {
      actionCount += 1;
      if (actionCount === 1) {
        pending.push(options);
        return;
      }
      options.success({ statusCode: 200, data: pendingIntakeDetail({ version: 4 }) });
    },
    detail: loads => (loads === 1 ? supplementDetail() : pendingIntakeDetail({ version: 4 }))
  });
  try {
    await verifyAndLoad(page);
    page.setData({ supplementSummary: '问题出现在上午十点左右' });
    page.onSupplementSubmit();
    assert.equal(pending.length, 1);

    pending[0].success({ statusCode: 409, data: { error: 'stale_version' } });
    await tick();
    // 刷新后取到新版本，写入锁释放。
    assert.equal(page.ownerVersion, 4);
    assert.equal(page.data.ownerStatusText, '已提交');
    assert.equal(calls.filter(call => call.url.includes('/actions')).length, 1, '刷新期间没有重复写入');
  } finally {
    restoreGlobals();
  }
});

test('补件时授权失效则清除授权与本人详情', async () => {
  const { page } = supplementPage({
    onAction: options => options.success({ statusCode: 401, data: { error: 'owner_authorization_required' } })
  });
  try {
    await verifyAndLoad(page);
    page.setData({ supplementSummary: '问题出现在上午十点左右' });
    page.onSupplementSubmit();
    await tick();
    assert.equal(page.ownerSessionToken, '', '授权已清除');
    assert.equal(page.data.ownerCaseNumber, '', '详情已清除');
    assert.equal(page.data.showSupplement, false);
  } finally {
    restoreGlobals();
  }
});

test('切单后不再显示旧的补件要求', async () => {
  const { page } = supplementPage();
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.showSupplement, true);
    page.setData({ code: 'ZYXWVUTSRQPONMLKJIHGFEDC' });
    page.onInput({ detail: { value: 'ZYXWVUTSRQPONMLKJIHGFEDC' } });
    assert.equal(page.data.showSupplement, false, '旧补件要求清空');
    assert.equal(page.data.supplementReason, '');
    assert.equal(page.data.supplementSummary, '');
  } finally {
    restoreGlobals();
  }
});

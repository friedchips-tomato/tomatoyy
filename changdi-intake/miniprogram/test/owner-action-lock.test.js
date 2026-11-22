// 写入锁覆盖刷新、过期弹窗回调与网络断开后结果未知的本地模拟检查。
// 用 Node 模拟 wx.request 与 Page，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');

const VALID_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWX';
const OTHER_CODE = 'ZYXWVUTSRQPONMLKJIHGFEDC';
const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const OTHER_CASE = 'CD-FEDCBA9876543210FEDCBA9876543210';
const TOKEN = 'owner.1000.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZab';

function loadPublicPage() {
  const modulePath = path.join(miniprogramRoot, 'pages/public/index.js');
  delete require.cache[require.resolve(modulePath)];
  let page = null;
  const modalCalls = [];
  global.Page = definition => { page = definition; };
  global.wx = {
    request: options => page.__request(options),
    scanCode: options => {},
    navigateBack: () => {},
    showModal: options => { modalCalls.push(options); }
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  page.__modalCalls = modalCalls;
  return page;
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function ownerDetail({ version = 1, caseNumber = CASE_NUMBER, availableActions = ['evaluate', 'confirm_resolved', 'request_reopen'] } = {}) {
  return {
    caseNumber,
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

// 建一个页面：公开查询、核验与首次详情立即成功，后续读回请求由测试自己控制。
function controlledPage() {
  const calls = [];
  const pending = { actions: [], details: [] };
  let detailCount = 0;
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
    if (options.url.includes('/api/v1/public/cases/')) {
      // 切换到另一个公开码时返回另一个工单编号。
      const caseNumber = options.url.endsWith(OTHER_CODE) ? OTHER_CASE : CASE_NUMBER;
      options.success({ statusCode: 200, data: { caseNumber, status: 'awaiting_evaluation', milestones: [] } });
      return;
    }
    if (options.url.includes('/actions')) {
      pending.actions.push(options);
      return;
    }
    // 首次详情立即返回，其后的读回交给测试控制。
    if (detailCount++ === 0) {
      options.success({ statusCode: 200, data: ownerDetail({ version: 1 }) });
      return;
    }
    pending.details.push(options);
  };
  return { page, calls, pending };
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

const actionCalls = calls => calls.filter(call => call.url.includes('/actions'));
// 读回请求：从首次详情之后才算，因此按 pending.details 计数最可靠。
const readBackCount = pending => pending.details.length;

test('延迟刷新期间写入锁保持占用，不发第二次写请求', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1, '只发一次写请求');

    // 服务端返回 409，页面进入读回确认。
    pending.actions[0].success({ statusCode: 409, data: { error: 'stale_version' } });
    await tick();
    assert.equal(readBackCount(pending), 1, '冲突后发起一次读回');
    assert.equal(page.data.actionState, 'conflict');

    // 读回尚未返回时再次提交，必须被锁挡住。
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1, '读回期间不再发写请求');
    assert.equal(page.data.actionState, 'busy', '提示正在确认');
    assert.match(page.data.actionMessage, /确认上一次提交的结果/, '说明当前在确认结果');

    // 另一个动作同样被锁挡住。
    page.setData({ reopenReason: '仍未修复' });
    page.onReopenSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1, '读回期间其他动作同样被挡住');
    assert.equal(page.data.actionState, 'busy');

    // 读回返回新版本后才可再次操作。
    pending.details[0].success({ statusCode: 200, data: ownerDetail({ version: 5 }) });
    await tick();
    assert.equal(page.ownerVersion, 5, '读回后取到新版本');
    assert.equal(page.data.actionState, 'conflict', '读回后保留冲突状态');
    assert.match(page.data.actionMessage, /未写入/, '用户明确知道本次未写入');

    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 2, '收到新版本后才可再次提交');
  } finally {
    restoreGlobals();
  }
});

test('读回期间旧版本号不被复用，新版本才用于下一次提交', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls)[0].data.expectedVersion, 1, '首次使用详情版本');

    pending.actions[0].success({ statusCode: 409, data: { error: 'stale_version' } });
    await tick();
    pending.details[0].success({ statusCode: 200, data: ownerDetail({ version: 7 }) });
    await tick();

    page.setData({ scores: { speed: 4, effectiveness: 4, attitude: 4 } });
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls)[1].data.expectedVersion, 7, '重试使用读回后的新版本');
  } finally {
    restoreGlobals();
  }
});

test('网络断开导致结果未知时也走读回确认并纳入刷新', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();

    // 写请求网络失败，结果未知。
    pending.actions[0].fail({ errMsg: 'request:fail' });
    await tick();
    assert.equal(readBackCount(pending), 1, '结果未知同样发起读回');
    assert.equal(page.data.actionState, 'network');

    // 读回未返回时仍不接受新写入。
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1, '结果未知期间不再发写请求');

    pending.details[0].success({ statusCode: 200, data: ownerDetail({ version: 3 }) });
    await tick();
    assert.equal(page.ownerVersion, 3);
    assert.equal(page.data.actionState, 'network', '读回后保留结果未知状态');
    assert.match(page.data.actionMessage, /结果未知/, '文案说明结果未知且已同步');
    assert.equal(page.data.actionPending, false, '读回完成后不再处于待确认');
  } finally {
    restoreGlobals();
  }
});

test('提交超时的结果未知同样由读回确认后才可再操作', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();

    pending.actions[0].fail({ errMsg: 'request:fail timeout' });
    await tick();
    assert.equal(page.data.actionState, 'timeout');
    assert.equal(readBackCount(pending), 1, '超时也发起读回');

    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1, '超时后读回期间不发新写入');

    pending.details[0].success({ statusCode: 200, data: ownerDetail({ version: 4 }) });
    await tick();
    assert.equal(page.data.actionState, 'timeout', '读回后保留超时状态');
    assert.equal(page.data.actionPending, false);
  } finally {
    restoreGlobals();
  }
});

test('本人操作收到网关错误或错误工单回执，必须读回原单才能解除写入锁', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    pending.actions[0].success({ statusCode: 502, data: null });
    await tick();
    assert.equal(page.data.actionPending, true);
    assert.equal(readBackCount(pending), 1);
    pending.details[0].success({
      statusCode: 200,
      data: ownerDetail({ caseNumber: OTHER_CASE, version: 3 })
    });
    await tick();
    assert.equal(page.data.actionState, 'refresh_failed');
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1);
    page.onRetryRefresh();
    await tick();
    pending.details[1].success({ statusCode: 200, data: ownerDetail({ version: 3 }) });
    await tick();
    assert.equal(page.ownerVersion, 3);
    assert.equal(page.data.actionPending, false);
  } finally {
    restoreGlobals();
  }
});

test('读回本身失败时保持锁，结果仍未知并可重试读回', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    pending.actions[0].success({ statusCode: 409, data: { error: 'stale_version' } });
    await tick();

    // 读回失败。
    pending.details[0].fail({ errMsg: 'request:fail' });
    await tick();
    assert.equal(page.data.actionState, 'refresh_failed');
    assert.equal(page.data.actionPending, true, '结果未知，保持待确认');
    assert.match(page.data.actionMessage, /结果仍未知/);

    // 锁仍在，读回失败期间不接受新写入。
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 1, '读回失败期间不发写请求');

    // 重试读回。
    page.onRetryRefresh();
    await tick();
    assert.equal(readBackCount(pending), 2, '重试发起第二次读回');
    pending.details[1].success({ statusCode: 200, data: ownerDetail({ version: 6 }) });
    await tick();
    assert.equal(page.ownerVersion, 6);
    assert.equal(page.data.actionPending, false, '读回成功后解除待确认');
    assert.equal(page.data.actionState, 'conflict', '仍保留冲突结论');

    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    assert.equal(actionCalls(calls).length, 2, '确认后才可再提交');
  } finally {
    restoreGlobals();
  }
});

test('弹窗打开后切换工单，确认回调不提交到别单', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    assert.equal(page.data.showConfirm, true);

    // 打开确认弹窗。
    page.onConfirmResolved();
    assert.equal(page.__modalCalls.length, 1, '先弹确认');
    assert.equal(actionCalls(calls).length, 0, '未确认不发请求');

    // 弹窗期间切换到另一个工单。
    page.setData({ code: OTHER_CODE });
    page.onSubmit();
    await tick();
    assert.equal(page.lastPublicCaseNumber, OTHER_CASE, '已切到另一单');

    // 用户此时点了确认。
    page.__modalCalls[0].success({ confirm: true });
    await tick();
    assert.equal(actionCalls(calls).length, 0, '过期弹窗不提交到别单');
    assert.equal(page.data.actionState, 'invalid');
    assert.match(page.data.actionMessage, /未提交/);
  } finally {
    restoreGlobals();
  }
});

test('弹窗打开后授权失效，确认回调不写入', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.onConfirmResolved();
    assert.equal(page.__modalCalls.length, 1);

    // 弹窗期间授权失效，页面清空本人数据。
    page.onHide();
    assert.equal(page.ownerSessionToken, '');

    page.__modalCalls[0].success({ confirm: true });
    await tick();
    assert.equal(actionCalls(calls).length, 0, '失权后不写入');
    assert.equal(page.data.actionState, 'invalid');
  } finally {
    restoreGlobals();
  }
});

test('弹窗打开后重新核验另一单，旧弹窗回调失效', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.onConfirmResolved();
    assert.equal(page.__modalCalls.length, 1);

    // 弹窗期间重新核验，核验代次变化。
    page.setData({ privateToken: 'b'.repeat(43) });
    page.onVerifySubmit();
    await tick();
    await tick();
    assert.notEqual(page.ownerEpoch, 0, '核验代次已推进');

    page.__modalCalls[0].success({ confirm: true });
    await tick();
    assert.equal(actionCalls(calls).length, 0, '核验代次变化后旧弹窗失效');
    assert.equal(page.data.actionState, 'invalid');
  } finally {
    restoreGlobals();
  }
});

test('弹窗打开时绑定的是当时的工单与版本', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.onConfirmResolved();
    page.__modalCalls[0].success({ confirm: true });
    await tick();
    const call = actionCalls(calls)[0];
    assert.equal(call.url.includes(CASE_NUMBER), true, '提交到弹窗打开时的工单');
    assert.equal(call.data.expectedVersion, 1, '提交使用弹窗打开时的版本');
  } finally {
    restoreGlobals();
  }
});

test('核验成功后重新打开弹窗仍绑定当前工单', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.onConfirmResolved();
    page.__modalCalls[0].success({ confirm: true });
    await tick();
    pending.actions[0].success({ statusCode: 200, data: ownerDetail({ version: 2 }) });
    await tick();

    // 再次确认时使用刷新后的版本。
    page.onConfirmResolved();
    page.__modalCalls[1].success({ confirm: true });
    await tick();
    assert.equal(actionCalls(calls)[1].data.expectedVersion, 2, '第二次使用最新版本');
  } finally {
    restoreGlobals();
  }
});

test('授权失效时清除本人数据并释放写入锁', async () => {
  const { page, calls, pending } = controlledPage();
  try {
    await verifyAndLoad(page);
    page.setData({ scores: { speed: 5, effectiveness: 5, attitude: 5 } });
    page.onEvaluateSubmit();
    await tick();
    pending.actions[0].success({ statusCode: 401, data: { error: 'owner_authorization_required' } });
    await tick();

    assert.equal(page.ownerSessionToken, '', '授权已清除');
    assert.equal(page.data.ownerCaseNumber, '', '详情已清除');
    assert.equal(page.data.ownerRounds.length, 0);
    assert.equal(page.data.actionPending, false, '锁已释放');
    assert.equal(page.data.showVerify, true);
  } finally {
    restoreGlobals();
  }
});

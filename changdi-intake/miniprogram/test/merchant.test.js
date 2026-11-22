// 商户窗口的权限显示、分页、任务版本与令牌处理的本地模拟检查。
// 用 Node 模拟 wx.request 与 Page，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const merchantModule = require(path.join(miniprogramRoot, 'pages/merchant/merchant.js'));

const CASE_NUMBER = 'CD-0123456789ABCDEF0123456789ABCDEF';
const OTHER_CASE = 'CD-FEDCBA9876543210FEDCBA9876543210';
const TASK_ID = 'CT-0123456789ABCDEF0123456789ABCDEF';
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

function caseItem(caseNumber = CASE_NUMBER, status = 'submitted') {
  return { caseNumber, status, submittedAt: '2026-11-19T02:00:00.000Z' };
}

function taskItem(overrides = {}) {
  return {
    taskId: TASK_ID,
    instructions: '核查指定区域',
    dueAt: '2026-11-20T10:00:00.000Z',
    status: 'awaiting_submission',
    version: 1,
    ...overrides
  };
}

// 建一个商户页面：身份读取可控，其余由测试分别应答。
function merchantPage(identity = { merchantId: 'shop-a', permissions: ['readCases', 'submitCases', 'collaborate'] }) {
  const calls = [];
  const handlers = { cases: null, case: null, collaborations: null, collaboration: null, submission: null };
  const page = loadMerchantPage();
  page.__request = options => {
    calls.push(options);
    const url = options.url;
    if (url.endsWith('/api/v1/merchant/me')) {
      options.success({ statusCode: 200, data: identity });
      return;
    }
    if (url.includes('/api/v1/merchant/cases/')) {
      (handlers.case || (value => options.success({ statusCode: 200, data: value })))(options);
      return;
    }
    if (url.includes('/api/v1/merchant/cases')) {
      (handlers.cases || (value => options.success({ statusCode: 200, data: value })))(options);
      return;
    }
    if (url.includes('/submissions')) {
      (handlers.submission || (value => options.success({ statusCode: 200, data: value })))(options);
      return;
    }
    if (url.includes('/api/v1/merchant/collaborations/')) {
      (handlers.collaboration || (value => options.success({ statusCode: 200, data: value })))(options);
      return;
    }
    (handlers.collaborations || (value => options.success({ statusCode: 200, data: value })))(options);
  };
  return { page, calls, handlers };
}

async function login(page) {
  page.onLoad({});
  page.onLoginSubmit({ detail: { value: { token: TOKEN } } });
  await tick();
  await tick();
}

test('令牌只放在内存，提交后立即清空输入', async () => {
  const { page } = merchantPage();
  try {
    page.onLoad({});
    page.onLoginSubmit({ detail: { value: { token: TOKEN } } });
    // 输入框在提交后即被换掉，不保留令牌文本。
    assert.ok(page.data.loginKeys[0] > 0, '输入框已重置');
    assert.ok(!JSON.stringify(page.data).includes(TOKEN), '令牌不在页面数据中');
    await tick();
    await tick();
    assert.equal(page.data.merchant, 'shop-a');
    assert.ok(!JSON.stringify(page.data).includes(TOKEN), '登录后令牌不在页面数据中');
  } finally {
    restoreGlobals();
  }
});

test('令牌只出现在授权头，不进入网址', async () => {
  const { page, calls } = merchantPage();
  try {
    await login(page);
    const call = calls.find(entry => entry.url.endsWith('/api/v1/merchant/me'));
    assert.equal(call.header.Authorization, 'Bearer ' + TOKEN);
    assert.ok(!call.url.includes(TOKEN), '令牌不进网址');
    for (const entry of calls) {
      assert.ok(!entry.url.includes(TOKEN), '任何请求的网址都不带令牌');
    }
  } finally {
    restoreGlobals();
  }
});

test('退出或页面隐藏时清除令牌与商户数据', async () => {
  const { page } = merchantPage();
  try {
    await login(page);
    assert.equal(page.data.merchant, 'shop-a');
    page.onHide();
    assert.equal(page._token, '', '令牌已清除');
    assert.equal(page.data.merchant, '', '商户身份已清除');
    assert.equal(page.data.cases.length, 0);
    assert.equal(page.data.tasks.length, 0);
    assert.ok(!JSON.stringify(page.data).includes(TOKEN));
  } finally {
    restoreGlobals();
  }
});

test('按权限显示：只读权限不请求协办待办', async () => {
  const { page, calls } = merchantPage({ merchantId: 'shop-a', permissions: ['readCases'] });
  try {
    await login(page);
    assert.equal(page.data.canReadCases, true);
    assert.equal(page.data.canCollaborate, false);
    assert.equal(page.data.canSubmitCases, false);
    assert.equal(calls.filter(call => call.url.includes('/collaborations')).length, 0, '无协办权限不请求待办');
    assert.ok(calls.some(call => call.url.includes('/api/v1/merchant/cases')));
  } finally {
    restoreGlobals();
  }
});

test('按权限显示：无读取权限不请求工单', async () => {
  const { page, calls } = merchantPage({ merchantId: 'shop-a', permissions: ['collaborate'] });
  try {
    await login(page);
    assert.equal(page.data.canReadCases, false);
    assert.equal(calls.filter(call => call.url.includes('/api/v1/merchant/cases')).length, 0, '无读取权限不请求工单');
    assert.ok(calls.some(call => call.url.includes('/collaborations')));
  } finally {
    restoreGlobals();
  }
});

test('工单列表按状态筛选并用 nextBefore 翻页', async () => {
  const { page, calls, handlers } = merchantPage();
  try {
    handlers.cases = options => {
      if (options.url.includes('status=processing')) {
        options.success({ statusCode: 200, data: { items: [caseItem(CASE_NUMBER, 'processing')], nextBefore: null } });
        return;
      }
      options.success({ statusCode: 200, data: { items: [caseItem(CASE_NUMBER)], nextBefore: OTHER_CASE } });
    };
    await login(page);
    assert.equal(page.data.cases.length, 1);
    assert.equal(page.data.cases[0].statusLabel, '已提交');
    assert.equal(page.data.casesNextBefore, OTHER_CASE);

    // 翻页带上 nextBefore。
    await page.loadCases(true);
    const paged = calls.filter(call => call.url.includes('/api/v1/merchant/cases?')).pop();
    assert.ok(paged.url.includes('before=' + OTHER_CASE), paged.url);

    // 切换状态筛选。
    await page.onStatusChange({ detail: { value: 5 } });
    const filtered = calls.filter(call => call.url.includes('/api/v1/merchant/cases?')).pop();
    assert.ok(filtered.url.includes('status=processing'), filtered.url);
  } finally {
    restoreGlobals();
  }
});

test('分页游标失效时重新读取第一页', async () => {
  const { page, calls, handlers } = merchantPage();
  try {
    let count = 0;
    handlers.cases = options => {
      count += 1;
      if (count === 1) {
        options.success({ statusCode: 200, data: { items: [caseItem(CASE_NUMBER)], nextBefore: OTHER_CASE } });
        return;
      }
      if (options.url.includes('before=')) {
        options.success({ statusCode: 400, data: { error: 'invalid_cursor' } });
        return;
      }
      options.success({ statusCode: 200, data: { items: [caseItem(CASE_NUMBER)], nextBefore: null } });
    };
    await login(page);
    assert.equal(page.data.casesNextBefore, OTHER_CASE);
    await page.loadCases(true);
    assert.ok(page.data.notice.includes('列表范围已变化'), page.data.notice);
    const first = calls.filter(call => call.url.includes('/api/v1/merchant/cases')).pop();
    assert.ok(!first.url.includes('before='), '已回到第一页');
  } finally {
    restoreGlobals();
  }
});

test('工单详情只展示本商户可见字段', async () => {
  const { page, handlers } = merchantPage();
  try {
    handlers.case = options => {
      options.success({
        statusCode: 200,
        data: {
          caseNumber: CASE_NUMBER,
          status: 'processing',
          submittedAt: '2026-11-19T02:00:00.000Z',
          round: 1,
          occurredAt: '2026-11-19T01:00:00.000Z',
          location: '合成商户地点',
          category: '街面维护',
          description: '合成商户描述',
          history: [{ status: 'submitted', round: 1, occurredAt: '2026-11-19T02:00:00.000Z' }],
          feedback: [{ round: 1, publishedAt: '2026-11-19T03:00:00.000Z', summary: '已修复' }]
        }
      });
    };
    await login(page);
    await page.onOpenCase({ currentTarget: { dataset: { case: CASE_NUMBER } } });
    assert.equal(page.data.view, 'case');
    assert.equal(page.data.caseDetail.statusLabel, '处理中');
    assert.equal(page.data.caseDetail.feedback[0].summary, '已修复');
    assert.equal(page.data.caseDetail.history.length, 1);
  } finally {
    restoreGlobals();
  }
});

test('工单详情不可见时撤下详情并回到列表', async () => {
  const { page, handlers } = merchantPage();
  try {
    handlers.case = options => {
      options.success({ statusCode: 404, data: { error: 'case_not_found' } });
    };
    await login(page);
    await page.onOpenCase({ currentTarget: { dataset: { case: CASE_NUMBER } } });
    assert.equal(page.data.view, 'workbench');
    assert.equal(page.data.caseDetail, null);
    assert.ok(page.data.notice.includes('不在本商户范围'), page.data.notice);
  } finally {
    restoreGlobals();
  }
});

test('协办待办分页与任务版本', async () => {
  const { page, calls, handlers } = merchantPage();
  try {
    handlers.collaborations = options => {
      if (options.url.includes('before=')) {
        options.success({ statusCode: 200, data: { items: [taskItem({ taskId: 'CT-' + 'B'.repeat(32), version: 2 })], nextBefore: null } });
        return;
      }
      options.success({ statusCode: 200, data: { items: [taskItem()], nextBefore: 'CT-' + 'B'.repeat(32) } });
    };
    await login(page);
    assert.equal(page.data.tasks.length, 1);
    assert.equal(page.data.tasks[0].statusLabel, '待提交');
    assert.equal(page.data.tasks[0].version, 1);
    assert.equal(page.data.tasksNextBefore, 'CT-' + 'B'.repeat(32));

    await page.loadTasks(true);
    const paged = calls.filter(call => call.url.includes('/collaborations?')).pop();
    assert.ok(paged.url.includes('before=CT-'), paged.url);
  } finally {
    restoreGlobals();
  }
});

test('协办详情展示必要地点与退回理由', async () => {
  const { page, handlers } = merchantPage();
  try {
    handlers.collaboration = options => {
      options.success({
        statusCode: 200,
        data: {
          taskId: TASK_ID,
          status: 'returned',
          version: 2,
          instructions: '核查指定区域',
          location: '合成协办地点',
          dueAt: '2026-11-20T10:00:00.000Z',
          latestSubmission: '首次送审说明',
          returnReason: '请明确复查范围'
        }
      });
    };
    await login(page);
    await page.onOpenTask({ currentTarget: { dataset: { task: TASK_ID } } });
    assert.equal(page.data.view, 'task');
    assert.equal(page.data.taskDetail.location, '合成协办地点');
    assert.equal(page.data.taskDetail.returnReason, '请明确复查范围');
    assert.equal(page.data.taskDetail.version, 2);
    assert.equal(page.data.taskDetail.latestSubmission, '首次送审说明');
  } finally {
    restoreGlobals();
  }
});

test('协办送审带任务版本与文字说明', async () => {
  const { page, calls, handlers } = merchantPage();
  try {
    handlers.collaboration = options => {
      options.success({
        statusCode: 200,
        data: {
          taskId: TASK_ID,
          status: 'awaiting_submission',
          version: 1,
          instructions: '核查指定区域',
          location: '',
          dueAt: '2026-11-20T10:00:00.000Z',
          latestSubmission: '',
          returnReason: ''
        }
      });
    };
    handlers.submission = options => {
      options.success({
        statusCode: 200,
        data: {
          taskId: TASK_ID,
          status: 'awaiting_review',
          version: 2,
          instructions: '核查指定区域',
          location: '',
          dueAt: '2026-11-20T10:00:00.000Z',
          latestSubmission: '合成现场说明',
          returnReason: ''
        }
      });
    };
    await login(page);
    await page.onOpenTask({ currentTarget: { dataset: { task: TASK_ID } } });
    page.setData({ taskSummary: '合成现场说明' });
    await page.onSubmitTask();
    await tick();

    const call = calls.find(entry => entry.url.includes('/submissions'));
    assert.ok(call, '发出送审请求');
    assert.equal(call.method, 'POST');
    assert.equal(call.data.expectedVersion, 1, '带任务版本');
    assert.equal(call.data.summary, '合成现场说明');
    assert.ok(!JSON.stringify(call.data).includes('photo'), '未选照片时只提交文字');
    assert.equal(page.data.taskDetail.statusLabel, '待管理方复核');
    assert.ok(page.data.taskSubmitMessage.includes('已送审'));
  } finally {
    restoreGlobals();
  }
});

test('送审说明为空时就地提示且不发请求', async () => {
  const { page, calls, handlers } = merchantPage();
  try {
    handlers.collaboration = options => {
      options.success({
        statusCode: 200,
        data: {
          taskId: TASK_ID, status: 'awaiting_submission', version: 1, instructions: '核查指定区域',
          location: '', dueAt: '2026-11-20T10:00:00.000Z', latestSubmission: '', returnReason: ''
        }
      });
    };
    await login(page);
    await page.onOpenTask({ currentTarget: { dataset: { task: TASK_ID } } });
    page.setData({ taskSummary: '   ' });
    await page.onSubmitTask();
    assert.equal(calls.filter(entry => entry.url.includes('/submissions')).length, 0, '缺说明不发请求');
    assert.match(page.data.taskSubmitMessage, /协办说明/);
  } finally {
    restoreGlobals();
  }
});

test('任务版本冲突时刷新任务再决定', async () => {
  const { page, calls, handlers } = merchantPage();
  try {
    let submissionCount = 0;
    handlers.collaboration = options => {
      options.success({
        statusCode: 200,
        data: {
          taskId: TASK_ID, status: 'awaiting_submission', version: submissionCount ? 3 : 1,
          instructions: '核查指定区域', location: '', dueAt: '2026-11-20T10:00:00.000Z',
          latestSubmission: '', returnReason: ''
        }
      });
    };
    handlers.submission = options => {
      submissionCount += 1;
      options.success({ statusCode: 409, data: { error: 'stale_version' } });
    };
    await login(page);
    await page.onOpenTask({ currentTarget: { dataset: { task: TASK_ID } } });
    page.setData({ taskSummary: '合成现场说明' });
    await page.onSubmitTask();
    await tick();
    assert.match(page.data.taskSubmitMessage, /已被更新/);
    assert.equal(page.data.taskDetail.version, 3, '已刷新到新版本');
  } finally {
    restoreGlobals();
  }
});

test('凭据失效时清除令牌与商户数据', async () => {
  const { page, handlers } = merchantPage();
  try {
    handlers.cases = options => {
      options.success({ statusCode: 401, data: { error: 'unauthorized' } });
    };
    await login(page);
    assert.equal(page._token, '');
    assert.equal(page.data.merchant, '');
    assert.equal(page.data.view, 'login');
  } finally {
    restoreGlobals();
  }
});

test('权限被回收时回到核验页', async () => {
  const { page, handlers } = merchantPage();
  try {
    handlers.cases = options => {
      options.success({ statusCode: 403, data: { error: 'forbidden' } });
    };
    await login(page);
    assert.equal(page._token, '');
    assert.equal(page.data.view, 'login');
    assert.match(page.data.loginError, /权限/);
  } finally {
    restoreGlobals();
  }
});

test('本地回环地址判定与非回环拒绝', () => {
  assert.equal(merchantModule.localOrigin('http://127.0.0.1:3400'), 'http://127.0.0.1:3400');
  assert.equal(merchantModule.localOrigin('http://[::1]:3400'), 'http://[::1]:3400');
  assert.equal(merchantModule.localOrigin('http://192.168.1.10:3400'), '');
  assert.equal(merchantModule.localOrigin('https://127.0.0.1:3400'), '');
  assert.equal(merchantModule.localOrigin('http://127.0.0.1:3400/'), '');
});

test('令牌格式校验', () => {
  assert.equal(merchantModule.isValidToken(TOKEN), true);
  assert.equal(merchantModule.isValidToken('short'), false);
  assert.equal(merchantModule.isValidToken(''), false);
  assert.equal(merchantModule.isValidToken(null), false);
});

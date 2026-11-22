// T01「我的诉求」的本地模拟检查：本机回执夹的写入规则与容错、页面列表渲染、
// 单条失败重试、扫码与清除交互。用 Node 模拟 wx，不启动微信工具，不发起真实网络请求。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const miniprogramRoot = path.resolve(__dirname, '..');
const receipts = require(path.join(miniprogramRoot, 'pages/mine/receipts.js'));

const CASE_A = 'CD-0123456789ABCDEF0123456789ABCDEF';
const CASE_B = 'CD-FEDCBA9876543210FEDCBA9876543210';
const CODE_A = 'AbCdEfGhIjKlMnOpQrStUvWx';
const CODE_B = 'ZyXwVuTsRqPoNmLkJiHgFeDc';
const PRIVATE_TOKEN = 'aB3dEf7hIjKlMn0pQrStUvWxYz12-_CD45ghiJkLmN7';
const AT = '2026-11-19T01:00:00.000Z';

// 可控的本机存储替身。writes 记录每次写入，便于核对写入次数与内容。
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    writes: [],
    removals: [],
    data,
    get(key) {
      return data.has(key) ? data.get(key) : '';
    },
    set(key, value) {
      storage.writes.push([key, value]);
      data.set(key, value);
    },
    remove(key) {
      storage.removals.push(key);
      data.delete(key);
    }
  };
  return storage;
}

function entry(caseNumber, code, submittedAt = AT) {
  return { caseNumber, publicLookupCode: code, submittedAt };
}

test('合法回执写入本机，存储内容只有允许的三个字段', () => {
  const storage = fakeStorage();
  const result = receipts.addReceipt(CASE_A, CODE_A, AT, { storage });
  assert.equal(result.ok, true, '写入成功');
  assert.equal(storage.writes.length, 1, '只写一次');
  const [key, value] = storage.writes[0];
  assert.equal(key, receipts.STORAGE_KEY, '写在回执夹这一处');
  const stored = JSON.parse(value);
  assert.equal(stored.length, 1, '存了一条');
  assert.deepEqual(
    Object.keys(stored[0]).sort(),
    ['caseNumber', 'publicLookupCode', 'submittedAt'],
    '只含允许字段'
  );
  assert.equal(stored[0].caseNumber, CASE_A);
  assert.equal(stored[0].publicLookupCode, CODE_A);
  assert.equal(stored[0].submittedAt, AT, '提交时间按 ISO UTC 存放');
});

test('写入前的校验不通过时直接丢弃，不读也不写存储', () => {
  const storage = fakeStorage();
  const bad = [
    ['编号格式不对', 'CD-123', CODE_A, AT],
    ['编号不是大写十六进制', 'cd-0123456789abcdef0123456789abcdef', CODE_A, AT],
    ['公开码位数不对', CASE_A, 'short-code', AT],
    ['公开码含非法字符', CASE_A, 'AbCdEfGhIjKlMnOpQrStUv!', AT],
    ['时间无法解析', CASE_A, CODE_A, '昨天下午'],
    ['时间缺失', CASE_A, CODE_A, '']
  ];
  for (const [label, caseNumber, code, at] of bad) {
    const result = receipts.addReceipt(caseNumber, code, at, { storage });
    assert.equal(result.ok, false, label + '：不写入');
    assert.deepEqual(result.entries, [], label + '：不返回条目');
  }
  assert.equal(storage.writes.length, 0, '不合格的记录一次都不写');
});

test('同编号重复提交时更新并移到最前', () => {
  const storage = fakeStorage();
  receipts.addReceipt(CASE_A, CODE_A, AT, { storage });
  receipts.addReceipt(CASE_B, CODE_B, '2026-11-20T01:00:00.000Z', { storage });
  const result = receipts.addReceipt(CASE_A, CODE_A, '2026-11-21T01:00:00.000Z', { storage });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 2, '不产生重复条目');
  assert.equal(result.entries[0].caseNumber, CASE_A, '重复的编号移到最前');
  assert.equal(result.entries[0].submittedAt, '2026-11-21T01:00:00.000Z', '时间被更新');
  assert.equal(result.entries[1].caseNumber, CASE_B, '其余条目顺序不变');
});

test('超过上限时按最旧淘汰，只留 20 条', () => {
  const storage = fakeStorage();
  for (let index = 0; index < 23; index += 1) {
    const caseNumber = 'CD-' + String(index).padStart(32, '0');
    const result = receipts.addReceipt(caseNumber, CODE_A, AT, { storage });
    assert.equal(result.ok, true);
  }
  const stored = JSON.parse(storage.data.get(receipts.STORAGE_KEY));
  assert.equal(stored.length, 20, '只留 20 条');
  assert.equal(stored[0].caseNumber, 'CD-' + String(22).padStart(32, '0'), '最新的一条在最前');
  assert.equal(stored[19].caseNumber, 'CD-' + String(3).padStart(32, '0'), '最旧的三条已淘汰');
});

test('读取脏数据时容错：解析失败、非数组与非法条目都不抛异常', () => {
  const broken = fakeStorage({ [receipts.STORAGE_KEY]: '{不是 JSON' });
  const failed = receipts.readReceipts({ storage: broken });
  assert.equal(failed.ok, true, '读取本身不失败');
  assert.deepEqual(failed.entries, [], '解析失败按空列表处理');

  const notArray = fakeStorage({ [receipts.STORAGE_KEY]: JSON.stringify({ caseNumber: CASE_A }) });
  assert.deepEqual(receipts.readReceipts({ storage: notArray }).entries, [], '非数组按空列表处理');

  const mixed = fakeStorage({
    [receipts.STORAGE_KEY]: JSON.stringify([
      entry(CASE_A, CODE_A),
      { caseNumber: 'CD-坏的', publicLookupCode: CODE_A, submittedAt: AT },
      entry(CASE_A, 'short'),
      null,
      '不是对象',
      entry(CASE_B, CODE_B)
    ])
  });
  const filtered = receipts.readReceipts({ storage: mixed });
  assert.equal(filtered.entries.length, 2, '非法条目被过滤');
  assert.deepEqual(
    filtered.entries.map(item => item.caseNumber),
    [CASE_A, CASE_B],
    '保留的条目内容正确'
  );
});

test('clearAll 清除回执夹这一处存储', () => {
  const storage = fakeStorage();
  receipts.addReceipt(CASE_A, CODE_A, AT, { storage });
  const result = receipts.clearAll({ storage });
  assert.equal(result.ok, true);
  assert.deepEqual(storage.removals, [receipts.STORAGE_KEY], '只清除回执夹');
  assert.deepEqual(receipts.readReceipts({ storage }).entries, [], '清除后读不到记录');
});

test('存储读写异常都不外抛，返回 ok 为 false', () => {
  const broken = {
    get() { throw new Error('read failed'); },
    set() { throw new Error('write failed'); },
    remove() { throw new Error('remove failed'); }
  };
  assert.deepEqual(receipts.readReceipts({ storage: broken }), { ok: false, entries: [] });
  assert.deepEqual(receipts.addReceipt(CASE_A, CODE_A, AT, { storage: broken }), { ok: false, entries: [] });
  assert.deepEqual(receipts.clearAll({ storage: broken }), { ok: false });

  // 读得到、写失败时也不抛出，原有记录保持不变。
  const readOnly = {
    get() { return JSON.stringify([entry(CASE_B, CODE_B)]); },
    set() { throw new Error('write failed'); },
    remove() { throw new Error('remove failed'); }
  };
  const result = receipts.addReceipt(CASE_A, CODE_A, AT, { storage: readOnly });
  assert.equal(result.ok, false, '写失败返回 ok 为 false');
  assert.equal(result.entries.length, 1, '返回原有记录');
});

// 页面用的模拟环境。
const tick = () => new Promise(resolve => setImmediate(resolve));

function createHarness(options = {}) {
  const modulePath = path.join(miniprogramRoot, 'pages/mine/index.js');
  delete require.cache[require.resolve(modulePath)];
  const state = {
    requests: [],
    navigations: [],
    scans: [],
    modals: [],
    storage: new Map(),
    storageWrites: []
  };
  let page = null;
  global.Page = definition => { page = definition; };
  global.wx = {
    request: opts => {
      state.requests.push(opts);
      (options.request || (value => value.success({ statusCode: 200, data: publicCase(value) })))(opts);
    },
    navigateTo: opts => state.navigations.push(opts.url),
    scanCode: opts => {
      state.scans.push(opts);
      (options.scan || (() => {}))(opts);
    },
    showModal: opts => {
      state.modals.push(opts);
      (options.modal || (() => {}))(opts);
    },
    stopPullDownRefresh: () => {},
    getStorageSync: key => (state.storage.has(key) ? state.storage.get(key) : ''),
    setStorageSync: (key, value) => {
      state.storageWrites.push([key, value]);
      state.storage.set(key, value);
    },
    removeStorageSync: key => {
      state.storageWrites.push(['remove', key]);
      state.storage.delete(key);
    }
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  return { page, state };
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

// 默认的公开查询应答：按网址里的公开码给出对应工单。
function publicCase(options) {
  const code = options.url.split('/').pop();
  const known = {
    [CODE_A]: { caseNumber: CASE_A, status: 'processing', milestones: [
      { status: 'submitted', occurredAt: '2026-11-19T01:00:00.000Z' },
      { status: 'processing', occurredAt: '2026-11-20T03:30:00.000Z' }
    ] },
    [CODE_B]: { caseNumber: CASE_B, status: 'closed', milestones: [
      { status: 'closed', occurredAt: '2026-11-21T06:00:00.000Z' }
    ] }
  };
  return known[code] || { caseNumber: CASE_A, status: 'submitted', milestones: [] };
}

function seed(state, entries) {
  state.storage.set(receipts.STORAGE_KEY, JSON.stringify(entries));
}

test('页面列出本机回执并显示编号、状态与最近节点时间', async () => {
  const { page, state } = createHarness();
  try {
    seed(state, [entry(CASE_A, CODE_A), entry(CASE_B, CODE_B)]);
    await page.onLoad({});
    await tick();

    assert.equal(page.data.loading, false, '加载结束');
    assert.equal(page.data.empty, false, '不是空列表');
    assert.equal(page.data.entries.length, 2, '两条记录都在');
    assert.equal(page.data.entries[0].caseNumber, CASE_A);
    assert.equal(page.data.entries[0].statusText, '处理中', '显示中文状态');
    assert.equal(page.data.entries[0].latestText, '2026-11-20 11:30', '显示最近节点时间');
    assert.equal(page.data.entries[0].submittedText, '2026-11-19 09:00', '显示提交时间');
    assert.equal(page.data.entries[1].statusText, '已办结');
    assert.equal(page.data.entries[1].latestText, '2026-11-21 14:00');
    for (const item of page.data.entries) {
      assert.equal(item.state, 'success', '每条都查到状态');
      assert.ok(!JSON.stringify(item).includes(PRIVATE_TOKEN), '页面数据不含私密凭证');
    }
    assert.equal(state.requests.length, 2, '逐条查询公开状态');
    for (const call of state.requests) {
      assert.ok(call.url.includes('/api/v1/public/cases/'), '只请求公开查询接口');
      assert.ok(!call.url.includes(PRIVATE_TOKEN), '网址不含私密凭证');
    }
  } finally {
    restoreGlobals();
  }
});

test('本机没有记录时显示空列表', async () => {
  const { page, state } = createHarness();
  try {
    await page.onLoad({});
    await tick();
    assert.equal(page.data.empty, true, '显示空列表');
    assert.equal(page.data.entries.length, 0);
    assert.equal(state.requests.length, 0, '没有记录时不发请求');
  } finally {
    restoreGlobals();
  }
});

test('单条查询失败保留该条并提示可重试，重试成功后更新状态', async () => {
  let failing = true;
  const { page, state } = createHarness({
    request: options => {
      const code = options.url.split('/').pop();
      if (code === CODE_A && failing) {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      options.success({ statusCode: 200, data: publicCase(options) });
    }
  });
  try {
    seed(state, [entry(CASE_A, CODE_A), entry(CASE_B, CODE_B)]);
    await page.onLoad({});
    await tick();

    assert.equal(page.data.entries.length, 2, '失败的条目仍然保留');
    const failed = page.data.entries.find(item => item.publicLookupCode === CODE_A);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.message, '查询失败，可重试');
    assert.equal(failed.caseNumber, CASE_A, '编号照常显示');
    const ok = page.data.entries.find(item => item.publicLookupCode === CODE_B);
    assert.equal(ok.state, 'success');

    // 重试这一条。
    failing = false;
    await page.onRetryTap({ currentTarget: { dataset: { code: CODE_A } } });
    await tick();
    const retried = page.data.entries.find(item => item.publicLookupCode === CODE_A);
    assert.equal(retried.state, 'success', '重试后显示状态');
    assert.equal(retried.statusText, '处理中');
    assert.equal(retried.latestText, '2026-11-20 11:30');
    assert.equal(page.data.entries.length, 2, '条目数量不变');
  } finally {
    restoreGlobals();
  }
});

test('扫码成功跳到公开进度页，取消留在本页，无法识别提示重新扫', async () => {
  const scanned = createHarness({
    scan: opts => opts.success({ result: '/pages/public/index?code=' + CODE_A })
  });
  try {
    await scanned.page.onLoad({});
    scanned.page.onScanTap();
    assert.equal(scanned.state.navigations.length, 1, '扫码成功跳转一次');
    assert.equal(scanned.state.navigations[0], '/pages/public/index?code=' + CODE_A, '网址只带公开码');
    assert.ok(!scanned.state.navigations[0].includes(PRIVATE_TOKEN), '网址不含私密凭证');
  } finally {
    restoreGlobals();
  }

  const cancelled = createHarness({ scan: opts => opts.fail({ errMsg: 'scanCode:fail cancel' }) });
  try {
    await cancelled.page.onLoad({});
    cancelled.page.onScanTap();
    assert.equal(cancelled.state.navigations.length, 0, '取消扫描不跳转');
    assert.equal(cancelled.page.data.message, '', '取消不提示');
  } finally {
    restoreGlobals();
  }

  const unknown = createHarness({ scan: opts => opts.success({ result: '这里没有公开码' }) });
  try {
    await unknown.page.onLoad({});
    unknown.page.onScanTap();
    assert.equal(unknown.state.navigations.length, 0, '无法识别不跳转');
    assert.match(unknown.page.data.message, /重新扫描/);
  } finally {
    restoreGlobals();
  }
});

test('单条「查看」只带公开码跳转公开进度页', async () => {
  const { page, state } = createHarness();
  try {
    seed(state, [entry(CASE_A, CODE_A)]);
    await page.onLoad({});
    await tick();
    page.onViewTap({ currentTarget: { dataset: { code: CODE_A } } });
    assert.equal(state.navigations.length, 1);
    assert.equal(state.navigations[0], '/pages/public/index?code=' + CODE_A);
    assert.ok(!state.navigations[0].includes(PRIVATE_TOKEN), '网址不含私密凭证');
  } finally {
    restoreGlobals();
  }
});

test('清除本机记录需二次确认，确认后清空列表，取消不动', async () => {
  const confirmed = createHarness({
    modal: opts => opts.success({ confirm: true, cancel: false })
  });
  try {
    seed(confirmed.state, [entry(CASE_A, CODE_A), entry(CASE_B, CODE_B)]);
    await confirmed.page.onLoad({});
    await tick();
    assert.equal(confirmed.page.data.entries.length, 2);
    confirmed.page.onClearTap();
    assert.equal(confirmed.state.modals.length, 1, '清除前先确认');
    assert.equal(confirmed.page.data.entries.length, 0, '确认后清空列表');
    assert.equal(confirmed.page.data.empty, true);
    assert.deepEqual(confirmed.state.storageWrites, [['remove', receipts.STORAGE_KEY]], '清除回执夹这一处存储');
    assert.equal(JSON.parse(confirmed.state.storage.get(receipts.STORAGE_KEY) || 'null'), null, '存储里已无记录');
  } finally {
    restoreGlobals();
  }

  const cancelled = createHarness({ modal: opts => opts.success({ confirm: false, cancel: true }) });
  try {
    seed(cancelled.state, [entry(CASE_A, CODE_A)]);
    await cancelled.page.onLoad({});
    await tick();
    cancelled.page.onClearTap();
    assert.equal(cancelled.page.data.entries.length, 1, '取消后记录保留');
    assert.equal(cancelled.state.storageWrites.length, 0, '取消不写存储');
  } finally {
    restoreGlobals();
  }
});

test('页面文案说明本机只存编号与公开码，私密凭证不入本机', () => {
  const template = fs.readFileSync(path.join(miniprogramRoot, 'pages/mine/index.wxml'), 'utf8');
  const script = fs.readFileSync(path.join(miniprogramRoot, 'pages/mine/index.js'), 'utf8');
  assert.ok(template.includes('本机只保存工单编号与公开查询码'), '空态说明本机存什么');
  assert.ok(template.includes('不保存问题描述、发生地点、联系方式和私密查询凭证'), '空态提醒私密凭证不入本机');
  assert.ok(template.includes('记录仅保存在本机，换手机或清除缓存后不再显示'), '说明记录只在本机');
  assert.ok(template.includes('{{item.message}}'), '单条失败显示提示文案');
  assert.ok(script.includes('查询失败，可重试'), '单条失败提示可重试');
  assert.ok(template.includes('bindtap="onScanTap"'), '有扫码入口');
  assert.ok(template.includes('bindtap="onClearTap"'), '有清除入口');
});

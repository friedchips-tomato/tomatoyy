const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const config = require('../config');
const { localOrigin, queues } = require('../pages/staff/workbench');

const first = 'CD-' + 'A'.repeat(32);
const second = 'CD-' + 'B'.repeat(32);
const third = 'CD-' + 'C'.repeat(32);
const taskOne = 'CT-' + 'A'.repeat(32);
const taskTwo = 'CT-' + 'B'.repeat(32);
const paths = '/api/v1/staff';
const credentials = { duty: 'd'.repeat(43), handler: 'h'.repeat(43), supervisor: 's'.repeat(43) };
const profiles = {
  duty: { id: 'desk', role: 'duty', department: null },
  handler: { id: 'worker-a', role: 'handler', department: 'street' },
  supervisor: { id: 'lead-a', role: 'supervisor', department: 'street' }
};
const counts = { asOf: '2026-11-19T02:00:00Z', dueSoonSeconds: 86400,
  counts: Object.fromEntries(queues.map(queue => [queue.id, 1])) };
const list = (items = [], nextBefore = null) => ({ items, nextBefore });
const event = data => ({ currentTarget: { dataset: data } });
const input = (field, value) => ({ ...event({ field }), detail: { value } });
const login = (page, role) => page.onLoginSubmit({ detail: { value: { token: credentials[role] } } });
const status = (page, index) => page.onStatusChange({ detail: { value: String(index) } });
const click = (page, action) => page.onActionTap(event({ action }));
const open = (page, caseNumber) => page.onOpenCase(event({ case: caseNumber }));
const actionIds = page => page.data.availableActions.map(action => action.id);
const ok = (request, data) => request.success({ statusCode: 200, data });
const reject = (request, statusCode) => request.success({ statusCode, data: { error: 'synthetic error' } });
const requestPath = request => new URL(request.url).pathname;

function record(caseNumber, state = 'submitted', version = 1, extra = {}) {
  return {
    caseNumber, status: state, version, round: 1, category: '合成街面维护', sourceType: 'integration',
    department: state === 'submitted' || state === 'accepted' ? null : 'street',
    assignee: state === 'submitted' || state === 'accepted' ? null : 'worker-a',
    location: '合成地点', description: '合成工单正文', history: [], ...extra
  };
}

function fixture(t, { holdCollaborations = false } = {}) {
  const modulePath = require.resolve('../pages/staff/index');
  const original = config.apiBaseUrl;
  delete require.cache[modulePath];
  let page;
  const calls = [];
  const exits = [];
  global.Page = value => { page = value; };
  global.wx = {
    request(request) {
      if (!holdCollaborations && request.method === 'GET' && requestPath(request).endsWith('/collaborations')) {
        ok(request, { items: [] });
      } else {
        calls.push(request);
      }
    },
    navigateBack(value) { exits.push(value); },
    setStorage() { assert.fail('unexpected storage write'); },
    setStorageSync() { assert.fail('unexpected storage write'); }
  };
  t.after(() => {
    if (page._alive) page.onUnload();
    config.apiBaseUrl = original;
    delete global.Page;
    delete global.wx;
    delete require.cache[modulePath];
  });
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = update => { Object.assign(page.data, update); };
  page.onLoad();
  const take = (path, method = 'GET') => {
    const index = calls.findIndex(request => requestPath(request) === paths + path && request.method === method);
    assert.notEqual(index, -1, 'missing request ' + method + ' ' + path);
    return calls.splice(index, 1)[0];
  };
  return { page, calls, exits, take };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function finishOverview(f, records = [], nextBefore = null) {
  await tick();
  ok(f.take('/workbench'), counts);
  ok(f.take('/cases'), list(records, nextBefore));
}

async function signIn(f, role, records = [], nextBefore = null) {
  const pending = login(f.page, role);
  ok(f.take('/me'), profiles[role]);
  await finishOverview(f, records, nextBefore);
  await pending;
}

test('本地登录允许回环基址并清空密码输入，退出和失权清理页面数据', async t => {
  const f = fixture(t);
  const { page } = f;
  const template = readFileSync(require.resolve('../pages/staff/index.wxml'), 'utf8');
  assert.match(template, /name="token"\s+password/);
  assert.match(template, /wx:for="{{loginKeys}}"\s+wx:key="\*this"/);
  for (const address of [
    'https://example.invalid', 'http://127.0.0.1.example.invalid:3400',
    'http://127.0.0.1:3400@evil.invalid', 'http://127.0.0.1:65536',
    'http://127.0.0.1:3400/other', 'http://127.0.0.1:3400\n'
  ]) assert.equal(localOrigin(address), '');
  assert.equal(localOrigin('http://[::1]:3400'), 'http://[::1]:3400');
  await page.onLoginSubmit({ detail: { value: { token: 'bad' } } });
  assert.deepEqual(page.data.loginKeys, [1]);
  assert.equal(f.calls.length, 0);
  const blockedBase = config.apiBaseUrl;
  config.apiBaseUrl = 'http://127.0.0.1@other.invalid';
  await login(page, 'duty');
  assert.equal(page.data.localEnabled, false);
  assert.equal(page._token, '');
  assert.equal(f.calls.length, 0);
  config.apiBaseUrl = blockedBase;
  page.onLogout();
  const pending = login(page, 'duty');
  const request = f.take('/me');
  assert.equal(request.header.Authorization, 'Bearer ' + credentials.duty);
  assert.equal(request.url, config.apiBaseUrl + paths + '/me');
  assert.ok(!JSON.stringify(page.data).includes(credentials.duty));
  assert.ok(!JSON.stringify(request.data || {}).includes(credentials.duty));
  ok(request, profiles.duty);
  await finishOverview(f, [record(first)]);
  await pending;
  assert.equal(page.data.view, 'workbench');
  assert.equal(page.data.staff.roleLabel, '值班人员');

  const candidate = open(page, first);
  const stale = f.take('/cases/' + first);
  const latest = open(page, second);
  reject(f.take('/cases/' + second), 403);
  await latest;
  assert.equal(page.data.view, 'login');
  assert.equal(page._token, '');
  assert.equal(page.data.detail, null);
  assert.deepEqual(page.data.items, []);
  assert.equal(page.data.counts, null);
  ok(stale, record(first));
  await candidate;
  assert.equal(page.data.detail, null);
  page.onExit();
  assert.deepEqual(f.exits, [{ delta: 1 }]);
});

test('值班、承办和主管以当前版本完成受理、分派、接单、送审、退回与发布', async t => {
  const f = fixture(t);
  const { page } = f;
  let current = record(first);
  async function show(role) {
    page.onLogout();
    await signIn(f, role, [current]);
    const pending = open(page, first);
    ok(f.take('/cases/' + first), current);
    await pending;
  }
  async function submit(action, fields, to) {
    const attemptedVersion = current.version;
    const pending = page.onActionSubmit();
    await page.onActionSubmit();
    const request = f.take('/cases/' + first + '/actions', 'POST');
    assert.equal(f.calls.length, 0, '同一写入在途时互斥');
    assert.deepEqual(request.data, { action, expectedVersion: attemptedVersion, ...fields });
    current = record(first, to, attemptedVersion + 1, {
      history: current.history.concat({
        action, status: to, actorId: page.data.staff.id, occurredAt: '2026-11-19T02:00:00Z', detail: fields
      })
    });
    ok(request, current);
    await finishOverview(f, [current]);
    await pending;
    assert.equal(page.data.detail.version, attemptedVersion + 1);
    assert.equal(page.data.editor, null);
  }

  await show('duty');
  assert.deepEqual(actionIds(page), ['accept', 'request_supplement', 'reject']);
  await click(page, 'start');
  assert.equal(page.data.editor, null);
  await click(page, 'accept');
  await submit('accept', {}, 'accepted');
  assert.deepEqual(actionIds(page), ['assign']);
  const directory = click(page, 'assign');
  ok(f.take('/assignees'), { items: [{ id: 'worker-a', department: 'street' }] });
  await directory;
  assert.deepEqual(page.data.editor.peopleLabels, ['请选择承办人', 'worker-a · street']);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  page.onEditorChange(input('personIndex', '1'));
  page.onEditorChange(input('date', future));
  page.onEditorChange(input('time', '09:30'));
  await submit('assign', { assignee: 'worker-a', dueAt: future + 'T09:30:00+08:00' }, 'assigned');

  await show('handler');
  assert.deepEqual(actionIds(page), ['start']);
  await click(page, 'start');
  await submit('start', {}, 'processing');
  assert.deepEqual(actionIds(page), ['submit_result']);
  await click(page, 'submit_result');
  page.onEditorChange(input('summary', '已完成合成处置'));
  await page.onActionSubmit();
  assert.match(page.data.editor.error, /照片/);
  assert.equal(f.calls.length, 0);
  page.onEditorChange(input('photoReason', '本地测试仅提交文字'));
  await submit('submit_result', { summary: '已完成合成处置', photoOmissionReason: '本地测试仅提交文字' }, 'awaiting_review');
  assert.deepEqual(actionIds(page), []);
  await show('supervisor');
  assert.deepEqual(actionIds(page), ['reassign', 'return_result', 'publish']);
  await click(page, 'return_result');
  page.onEditorChange(input('reason', '请补充处置时间'));
  await submit('return_result', { reason: '请补充处置时间' }, 'processing');
  await show('handler');
  await click(page, 'submit_result');
  page.onEditorChange(input('summary', '已经补全时间'));
  page.onEditorChange(input('photoReason', '合成测试无照片'));
  await submit('submit_result', { summary: '已经补全时间', photoOmissionReason: '合成测试无照片' }, 'awaiting_review');
  await show('supervisor');
  await click(page, 'publish');
  page.onEditorChange(input('summary', '已复核，可以反馈'));
  await submit('publish', { summary: '已复核，可以反馈' }, 'awaiting_evaluation');
  assert.equal(page.data.detail.history.at(-1).notes, '已复核，可以反馈');
  assert.deepEqual(actionIds(page), []);
});

test('切队列、分页和切单后迟到的响应不会覆盖当前结果', async t => {
  const f = fixture(t);
  const { page } = f;
  await signIn(f, 'duty', [record(first)], first);
  const oldPage = page.onLoadMore();
  const append = f.take('/cases');
  assert.equal(new URL(append.url).searchParams.get('before'), first);
  const queue = page.onQueueTap(event({ queue: 'pending_assignment' }));
  const newQueue = f.take('/cases');
  assert.equal(new URL(newQueue.url).searchParams.get('queue'), 'pending_assignment');
  const filtered = status(page, page.data.statusOptions.findIndex(option => option.id === 'accepted'));
  const latest = f.take('/cases');
  assert.equal(new URL(latest.url).searchParams.get('status'), 'accepted');
  ok(latest, list([record(second, 'accepted')], second));
  await filtered;
  ok(newQueue, list([record(third, 'accepted')]));
  ok(append, list([record(first)]));
  await Promise.all([oldPage, queue]);
  assert.deepEqual(page.data.items.map(item => item.caseNumber), [second]);
  const extra = page.onLoadMore();
  const extraCall = f.take('/cases');
  assert.equal(new URL(extraCall.url).searchParams.get('before'), second);
  ok(extraCall, list([record(second, 'accepted'), record(third, 'accepted')]));
  await extra;
  assert.deepEqual(page.data.items.map(item => item.caseNumber), [second, third]);
  const slower = open(page, second);
  const detail = open(page, third);
  ok(f.take('/cases/' + third), record(third, 'accepted', 2));
  await detail;
  const directory = click(page, 'assign');
  const newCase = open(page, first);
  ok(f.take('/cases/' + first), record(first));
  ok(f.take('/assignees'), { items: [{ id: 'old', department: 'street' }] });
  ok(f.take('/cases/' + second), record(second, 'accepted', 2));
  await Promise.all([newCase, directory, slower]);
  assert.equal(page.data.detail.caseNumber, first);
  assert.equal(page.data.editor, null);
  assert.deepEqual(actionIds(page), ['accept', 'request_supplement', 'reject']);
});

test('版本过期和请求超时只读回详情，失去工单范围会清除旧数据', async t => {
  const f = fixture(t);
  const { page } = f;
  await signIn(f, 'duty', [record(first)]);
  const detail = open(page, first);
  ok(f.take('/cases/' + first), record(first));
  await detail;
  for (const fail of [request => reject(request, 409), request => request.fail({ errMsg: 'timeout' })]) {
    await click(page, 'accept');
    const pending = page.onActionSubmit();
    const write = f.take('/cases/' + first + '/actions', 'POST');
    fail(write);
    await tick();
    assert.equal(page.data.detail, null);
    assert.equal(page.data.editor, null);
    assert.deepEqual(actionIds(page), []);
    assert.match(page.data.notice, /未重发/);
    await page.onActionSubmit();
    assert.equal(f.calls.filter(request => request.method === 'POST').length, 0);
    ok(f.take('/cases/' + first), record(first, 'submitted', write.data.expectedVersion + 1));
    await finishOverview(f, [record(first)]);
    await pending;
    assert.equal(page.data.detail.version, write.data.expectedVersion + 1);
  }
  const refresh = page.onRetryDetail();
  reject(f.take('/cases/' + first), 404);
  await finishOverview(f);
  await refresh;
  assert.equal(page.data.view, 'workbench');
  assert.equal(page.data.detail, null);
  assert.deepEqual(page.data.items, []);
  assert.match(page.data.notice, /权限范围/);
});

test('主管补办审核按在地目录提交，离开页面后清除会话并丢弃响应', async t => {
  const f = fixture(t);
  const { page } = f;
  const pendingRow = record(first, 'reopen_pending', 10, {
    reopenRequests: [{ reason: '合成未解决事项', decision: null, previousStatus: 'closed' }],
    rounds: [{ round: 1, feedback: { summary: '上一轮公开反馈' }, evaluation: { speed: 5, effectiveness: 4, attitude: 3 } }]
  });
  await signIn(f, 'supervisor', [pendingRow]);
  const load = open(page, first);
  ok(f.take('/cases/' + first), pendingRow);
  await load;
  assert.deepEqual(actionIds(page), ['approve_reopen', 'reject_reopen']);
  assert.equal(page.data.detail.reopenRequests[0].reason, '合成未解决事项');
  assert.equal(page.data.detail.rounds[0].evaluation, '5 / 4 / 3');
  const editing = click(page, 'approve_reopen');
  ok(f.take('/assignees'), { items: [{ id: 'worker-a', department: 'street' }, { id: 'worker-b', department: 'other' }] });
  await editing;
  assert.deepEqual(page.data.editor.people.map(person => person.id), ['worker-a']);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  page.onEditorChange(input('personIndex', '1'));
  page.onEditorChange(input('date', future));
  page.onEditorChange(input('time', '12:00'));
  page.onEditorChange(input('continueProcessing', true));
  const pending = page.onActionSubmit();
  const write = f.take('/cases/' + first + '/actions', 'POST');
  assert.deepEqual(write.data, {
    action: 'approve_reopen', expectedVersion: 10, assignee: 'worker-a',
    dueAt: future + 'T12:00:00+08:00', nextStatus: 'processing'
  });
  page.onUnload();
  ok(write, record(first, 'processing', 11));
  await pending;
  assert.equal(page._token, '');
  assert.equal(page.data.detail, null);
  assert.equal(page.data.staff, null);
  assert.equal(f.calls.length, 0);
});

test('主管转派需要原因，评价期届满才提供结案操作', async t => {
  const f = fixture(t);
  const { page } = f;
  await signIn(f, 'supervisor');
  const opening = open(page, first);
  ok(f.take('/cases/' + first), record(first, 'processing', 7));
  await opening;
  const editing = click(page, 'reassign');
  ok(f.take('/assignees'), { items: [{ id: 'worker-a2', department: 'street' }] });
  await editing;
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  page.onEditorChange(input('personIndex', '1'));
  page.onEditorChange(input('date', future));
  page.onEditorChange(input('time', '08:00'));
  await page.onActionSubmit();
  assert.match(page.data.editor.error, /原因/);
  page.onEditorChange(input('reason', '合成转派原因'));
  const reassign = page.onActionSubmit();
  const write = f.take('/cases/' + first + '/actions', 'POST');
  assert.deepEqual(write.data, {
    action: 'reassign', expectedVersion: 7, assignee: 'worker-a2',
    dueAt: future + 'T08:00:00+08:00', reason: '合成转派原因'
  });
  ok(write, record(first, 'assigned', 8, { assignee: 'worker-a2' }));
  await finishOverview(f);
  await reassign;

  for (const [offset, expected] of [[86400000, []], [-86400000, ['close']]]) {
    const refreshed = page.onRetryDetail();
    ok(f.take('/cases/' + first), record(first, 'awaiting_evaluation', 12, {
      evaluationEndsAt: new Date(Date.now() + offset).toISOString()
    }));
    await refreshed;
    assert.deepEqual(actionIds(page), expected);
  }
});

const collabPath = caseNumber => '/cases/' + caseNumber + '/collaborations';
const taskActionPath = (caseNumber, taskId) => collabPath(caseNumber) + '/' + taskId + '/actions';
const chooseReview = (page, taskId, action) => page.onReviewCollaboration(event({ task: taskId, action }));
const futureDay = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

function task(taskId, state = 'awaiting_review', version = 2, extra = {}) {
  return {
    taskId, status: state, version, round: 1, merchantId: 'shop-a',
    instructions: '合成协办范围', location: '合成协办地点', dueAt: futureDay() + 'T10:30:00+08:00',
    latestSubmission: '合成补充说明',
    history: [{ action: 'submit', version, actorId: 'test-merchant', detail: { summary: '合成补充说明' } }],
    ...extra
  };
}

async function loadCollaborationDetail(f, value, items) {
  const pending = open(f.page, value.caseNumber);
  ok(f.take('/cases/' + value.caseNumber), value);
  await tick();
  ok(f.take(collabPath(value.caseNumber)), { items });
  await pending;
}

test('派发协办接受 201 并更新主单版本，协办与主单共用写锁', async t => {
  const f = fixture(t, { holdCollaborations: true });
  const { page } = f;
  const active = record(first, 'assigned', 7);
  await signIn(f, 'duty', [active]);
  await loadCollaborationDetail(f, active, []);
  assert.equal(page.data.canAssignCollaboration, true);
  page.onAssignCollaboration();
  await page.onSubmitCollaboration();
  assert.match(page.data.collaborationEditor.error, /商户编号/);
  const date = futureDay();
  for (const [field, value] of [
    ['merchantId', 'shop-a'], ['instructions', '合成协办范围'], ['location', '合成协办地点'],
    ['date', date], ['time', '10:30']
  ]) page.onCollaborationInput(input(field, value));
  const assigning = page.onSubmitCollaboration();
  const write = f.take(collabPath(first), 'POST');
  assert.deepEqual(write.data, {
    expectedVersion: 7, merchantId: 'shop-a', instructions: '合成协办范围',
    location: '合成协办地点', dueAt: date + 'T10:30:00+08:00'
  });
  await click(page, 'reassign');
  await page.onActionSubmit();
  await page.onSubmitCollaboration();
  assert.equal(f.calls.length, 0);
  write.success({ statusCode: 201, data: { ...task(taskOne, 'awaiting_submission', 1), caseVersion: 8 } });
  await assigning;
  assert.equal(page.data.detail.version, 8);
  assert.equal(page.data.detail.status, 'assigned');
  assert.equal(page.data.collaborations[0].taskId, taskOne);
  assert.equal(page.data.collaborationEditor, null);
  const editor = click(page, 'reassign');
  ok(f.take('/assignees'), { items: [{ id: 'worker-b', department: 'other' }] });
  await editor;
  for (const [field, value] of [['personIndex', '1'], ['date', date], ['time', '11:00'], ['reason', '合成转派']]) {
    page.onEditorChange(input(field, value));
  }
  const reassign = page.onActionSubmit();
  const mainWrite = f.take('/cases/' + first + '/actions', 'POST');
  assert.equal(mainWrite.data.expectedVersion, 8);
  page.onAssignCollaboration();
  await page.onSubmitCollaboration();
  assert.equal(f.calls.length, 0);
  ok(mainWrite, record(first, 'assigned', 9, { department: 'other', assignee: 'worker-b' }));
  await finishOverview(f);
  ok(f.take(collabPath(first)), { items: [task(taskOne, 'awaiting_submission', 1)] });
  await reassign;
  assert.equal(page.data.detail.version, 9);
});

test('协办任务按主责角色、当前轮次和任务状态显示真实可用动作', async t => {
  const f = fixture(t, { holdCollaborations: true });
  const { page } = f;
  const active = record(first, 'awaiting_review', 8, { round: 2 });
  const pending = task(taskOne, 'awaiting_review', 2, { round: 2 });
  const previous = task(taskTwo, 'awaiting_review', 2);
  await signIn(f, 'handler');
  await loadCollaborationDetail(f, active, [pending, previous]);
  assert.equal(page.data.canAssignCollaboration, false);
  assert.deepEqual(page.data.collaborations.map(item => item.actions), [[], []]);
  chooseReview(page, taskOne, 'approve');
  assert.equal(page.data.collaborationEditor, null);

  page.onLogout();
  await signIn(f, 'supervisor');
  await loadCollaborationDetail(f, active, [pending, previous]);
  assert.equal(page.data.canAssignCollaboration, false, '主单待复核时不能新增协办');
  assert.deepEqual(page.data.collaborations[0].actions.map(action => action.id), ['approve', 'return', 'withdraw']);
  assert.deepEqual(page.data.collaborations[1].actions, []);
  assert.equal(page.data.collaborations[0].history[0].note, '合成补充说明');
  chooseReview(page, taskTwo, 'approve');
  assert.equal(page.data.collaborationEditor, null);

  chooseReview(page, taskOne, 'return');
  await page.onSubmitCollaboration();
  assert.match(page.data.collaborationEditor.error, /原因/);
  page.onCollaborationInput(input('reason', '合成退回原因'));
  const returning = page.onSubmitCollaboration();
  const returnRequest = f.take(taskActionPath(first, taskOne), 'POST');
  assert.deepEqual(returnRequest.data, { action: 'return', expectedVersion: 2, reason: '合成退回原因' });
  ok(returnRequest, task(taskOne, 'returned', 3, { round: 2, returnReason: '合成退回原因' }));
  await returning;
  assert.equal(page.data.detail.version, 8);
  assert.deepEqual(page.data.collaborations[0].actions.map(action => action.id), ['withdraw']);
  chooseReview(page, taskOne, 'withdraw');
  page.onCollaborationInput(input('reason', '合成撤回原因'));
  const withdrawing = page.onSubmitCollaboration();
  const withdrawRequest = f.take(taskActionPath(first, taskOne), 'POST');
  assert.deepEqual(withdrawRequest.data, { action: 'withdraw', expectedVersion: 3, reason: '合成撤回原因' });
  ok(withdrawRequest, task(taskOne, 'withdrawn', 4, { round: 2 }));
  await withdrawing;
  assert.deepEqual(page.data.collaborations[0].actions, []);

  const refresh = page.onRetryDetail();
  ok(f.take('/cases/' + first), active);
  await tick();
  ok(f.take(collabPath(first)), { items: [pending] });
  await refresh;
  chooseReview(page, taskOne, 'approve');
  const approving = page.onSubmitCollaboration();
  const approveRequest = f.take(taskActionPath(first, taskOne), 'POST');
  assert.deepEqual(approveRequest.data, { action: 'approve', expectedVersion: 2 });
  ok(approveRequest, task(taskOne, 'approved', 3, { round: 2 }));
  await approving;
  assert.deepEqual(page.data.collaborations[0].actions, []);
});

test('协办冲突或连接中断后必须成功读回主单与协办，且不会自动重发', async t => {
  const f = fixture(t, { holdCollaborations: true });
  const { page } = f;
  const active = record(first, 'processing', 8);
  await signIn(f, 'supervisor');
  await loadCollaborationDetail(f, active, [task(taskOne)]);
  for (const [index, fail] of [
    [0, request => reject(request, 409)],
    [1, request => request.fail({ errMsg: 'synthetic connection reset' })]
  ]) {
    chooseReview(page, taskOne, 'approve');
    const pending = page.onSubmitCollaboration();
    const write = f.take(taskActionPath(first, taskOne), 'POST');
    assert.equal(write.data.expectedVersion, 2 + index);
    fail(write);
    await tick();
    assert.equal(page.data.recovering, true);
    assert.equal(page.data.collaborationEditor, null);
    ok(f.take('/cases/' + first), { ...active, version: 9 + index });
    await tick();
    await click(page, 'reassign');
    page.onAssignCollaboration();
    await page.onActionSubmit();
    await page.onSubmitCollaboration();
    assert.equal(page.data.editor, null);
    assert.equal(page.data.collaborationEditor, null);
    assert.equal(f.calls.filter(request => request.method === 'POST').length, 0);
    f.take(collabPath(first)).fail({ errMsg: 'synthetic timeout' });
    await finishOverview(f);
    await pending;
    assert.equal(page.data.recovering, true);
    const retry = page.onRetryDetail();
    ok(f.take('/cases/' + first), { ...active, version: 9 + index });
    await tick();
    ok(f.take(collabPath(first)), { items: [task(taskOne, 'awaiting_review', 3 + index)] });
    await retry;
    assert.equal(page.data.recovering, false);
    assert.equal(page.data.collaborations[0].version, 3 + index);
    assert.match(page.data.notice, /系统未重发/);
    assert.equal(f.calls.length, 0);
  }
});

test('切单、页面隐藏和协办失权会丢弃旧记录或迟到响应', async t => {
  const f = fixture(t, { holdCollaborations: true });
  const { page } = f;
  await signIn(f, 'duty');
  const oldLoad = open(page, first);
  ok(f.take('/cases/' + first), record(first, 'processing', 8));
  await tick();
  const oldTasks = f.take(collabPath(first));
  await loadCollaborationDetail(f, record(second, 'processing', 3), [task(taskTwo)]);
  ok(oldTasks, { items: [task(taskOne)] });
  await oldLoad;
  assert.deepEqual(page.data.collaborations.map(item => item.taskId), [taskTwo]);
  const latest = page.onRetryDetail();
  ok(f.take('/cases/' + second), record(second, 'processing', 3));
  await tick();
  const late = f.take(collabPath(second));
  page.onHide();
  ok(late, { items: [task(taskTwo)] });
  await latest;
  assert.equal(page._token, '');
  assert.equal(page.data.detail, null);
  assert.deepEqual(page.data.collaborations, []);
  assert.equal(page.data.collaborationEditor, null);
  await signIn(f, 'duty');
  const forbidden = open(page, first);
  ok(f.take('/cases/' + first), record(first, 'processing', 8));
  await tick();
  reject(f.take(collabPath(first)), 403);
  await forbidden;
  assert.equal(page.data.view, 'login');
  assert.equal(page._token, '');
  assert.equal(page.data.detail, null);
  assert.deepEqual(page.data.collaborations, []);
});

test('A05 仅值班外部待受理单可发起补件，并刷新待受理队列', async t => {
  const f = fixture(t);
  const { page } = f;
  await signIn(f, 'duty', [record(first)]);
  for (const [value, options] of [
    [record(first, 'submitted', 1, { sourceType: 'merchant' }), ['accept', 'reject']],
    [record(first, 'submitted', 1, { sourceType: undefined }), ['accept', 'reject']],
    [record(first, 'accepted', 2), ['assign']],
    [record(first, 'submitted', 3), ['accept', 'request_supplement', 'reject']]
  ]) {
    const opened = open(page, first);
    ok(f.take('/cases/' + first), value);
    await opened;
    assert.deepEqual(actionIds(page), options);
  }
  page.onReturnToList();
  const selecting = page.onQueueTap(event({ queue: 'pending_intake' }));
  ok(f.take('/cases'), list([record(first)]));
  await selecting;
  const opened = open(page, first);
  ok(f.take('/cases/' + first), record(first, 'submitted', 3));
  await opened;
  await click(page, 'request_supplement');
  await page.onActionSubmit();
  assert.match(page.data.editor.error, /原因/);
  assert.equal(f.calls.length, 0);
  const reason = '请补充发生时段';
  page.onEditorChange(input('reason', reason));
  const pending = page.onActionSubmit();
  const request = f.take('/cases/' + first + '/actions', 'POST');
  assert.deepEqual(request.data, { action: 'request_supplement', expectedVersion: 3, reason });
  ok(request, record(first, 'awaiting_supplement', 4, { history: [
    { action: 'request_supplement', status: 'awaiting_supplement', detail: { reason } }
  ] }));
  await tick();
  ok(f.take('/workbench'), { ...counts, counts: { ...counts.counts, pending_intake: 0 } });
  const queued = f.take('/cases');
  assert.equal(new URL(queued.url).searchParams.get('queue'), 'pending_intake');
  ok(queued, list());
  await pending;
  assert.equal(page.data.detail.statusLabel, '待补充材料');
  assert.deepEqual(actionIds(page), []);
  assert.equal(page.data.detail.history[0].notes, reason);
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.counts.pending_intake, 0);
});

test('本地管理端到端：派发、商户送审、主管通过，主工单状态保持', async t => {
  const { page } = fixture(t);
  const { createIntakeServer } = await import('../../server/src/server.js');
  const integration = 'i'.repeat(43);
  const merchant = 'm'.repeat(43);
  const server = createIntakeServer({
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 123),
    integrations: [{ source: 'synthetic-staff-e2e', token: integration }],
    staff: Object.entries(profiles).map(([role, profile]) => ({ ...profile, token: credentials[role] })),
    merchants: [{ id: 'shop-a-member', merchantId: 'shop-a', token: merchant, permissions: ['collaborate'] }]
  });
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  config.apiBaseUrl = origin;
  global.wx.request = async options => {
    assert.equal(new URL(options.url).origin, origin);
    try {
      const response = await fetch(options.url, {
        method: options.method, headers: options.header,
        body: options.data ? JSON.stringify(options.data) : undefined,
        signal: AbortSignal.timeout(4000)
      });
      options.success({ statusCode: response.status, data: await response.json() });
    } catch {
      options.fail({ errMsg: 'local request failed' });
    }
  };

  async function call(path, token, data, form) {
    const headers = { Authorization: 'Bearer ' + token };
    if (data) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + path, {
      method: data || form ? 'POST' : 'GET', headers,
      body: data ? JSON.stringify(data) : form,
      signal: AbortSignal.timeout(4000)
    });
    return { status: response.status, body: await response.json() };
  }
  const form = new FormData();
  form.append('payload', JSON.stringify({
    externalCaseId: 'synthetic-staff-collaboration-e2e',
    occurredAt: '2026-11-19T09:00:00+08:00', location: '合成申报地点',
    category: '合成街面维护', description: '合成申报说明'
  }));
  const intake = await call('/api/v1/integrations/intake/cases', integration, undefined, form);
  assert.equal(intake.status, 201);
  const { caseNumber } = intake.body;
  const date = futureDay();
  const dueAt = date + 'T10:30:00+08:00';
  await login(page, 'duty');
  await open(page, caseNumber);
  await click(page, 'accept');
  await page.onActionSubmit();
  assert.equal(page.data.detail.status, 'accepted');
  await click(page, 'assign');
  page.onEditorChange(input('personIndex', '1'));
  page.onEditorChange(input('date', date));
  page.onEditorChange(input('time', '10:30'));
  await page.onActionSubmit();
  assert.equal(page.data.detail.status, 'assigned');
  assert.equal(page.data.detail.version, 3);
  page.onAssignCollaboration();
  for (const [field, value] of [['merchantId', 'shop-a'], ['instructions', '合成协办范围'], ['date', date], ['time', '10:30']]) {
    page.onCollaborationInput(input(field, value));
  }
  await page.onSubmitCollaboration();
  assert.equal(page.data.detail.version, 4);
  assert.equal(page.data.collaborations[0].status, 'awaiting_submission');
  const { taskId } = page.data.collaborations[0];
  const merchantReview = await call('/api/v1/merchant/collaborations/' + taskId + '/submissions', merchant,
    { expectedVersion: 1, summary: '合成商户现场说明' });
  assert.equal(merchantReview.status, 200);
  page.onLogout();
  await login(page, 'supervisor');
  await open(page, caseNumber);
  assert.equal(page.data.collaborations[0].latestSubmission, '合成商户现场说明');
  chooseReview(page, taskId, 'approve');
  await page.onSubmitCollaboration();
  assert.equal(page.data.collaborations[0].status, 'approved');
  assert.equal(page.data.detail.status, 'assigned');
  assert.equal(page.data.detail.version, 4);
  const main = await call(paths + '/cases/' + caseNumber, credentials.supervisor);
  assert.equal(main.body.dueAt, new Date(dueAt).toISOString());
  assert.equal(main.body.status, 'assigned');
  assert.equal(main.body.version, 4);
});

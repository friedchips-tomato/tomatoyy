const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../config');
const { apiEnvironment, httpsOrigin, requestConfigured } = require('../api-environment');
const { queues } = require('../pages/staff/workbench');

const https = 'https://intake.synthetic.test';
const local = 'http://127.0.0.1:3400';
const staffToken = 'wxsession.' + 's'.repeat(43);
const merchantToken = 'wxsession.' + 'm'.repeat(43);
const ownerToken = 'owner.synthetic.session-token';
const testToken = 'l'.repeat(43);
const code = 'A'.repeat(24);
const number = 'CD-' + 'A'.repeat(32);
const taskId = 'CT-' + 'B'.repeat(32);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const bytes = () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length);
const photo = { round: 1, submitVersion: 3, position: 0, mediaType: 'image/png', size: png.length };
const staffIdentity = { id: 'lead-a', role: 'supervisor', department: 'street-a' };
const permissions = ['readCases', 'submitCases', 'collaborate'];
const merchantIdentity = { merchantId: 'shop-a', permissions };
const tap = dataset => ({ currentTarget: { dataset } });
const input = value => ({ detail: { value } });
const ok = (request, data, header, statusCode = 200) => request.success({ statusCode, data, header });
const image = request => ok(request, bytes(), { 'Content-Type': 'image/png' });
const tick = () => new Promise(setImmediate);
const authHeader = call => call.header?.Authorization;
const grant = (type, overrides = {}) => ({
  identity: type === 'staff' ? { type, ...staffIdentity } : { type, ...merchantIdentity },
  sessionToken: type === 'staff' ? staffToken : merchantToken,
  expiresAt: new Date(Date.now() + 20000).toISOString(),
  ...overrides
});

function fixture(t, route = () => {}) {
  const saved = { ...config };
  config.apiMode = 'production';
  config.apiBaseUrl = local;
  config.productionApiBaseUrl = https;
  const calls = [];
  const logins = [];
  const selections = [];
  const files = new Map();
  const pages = [];
  const fs = {
    readdirSync: () => [],
    readFile: request => request.success({ data: bytes() }),
    writeFileSync: (path, data) => files.set(path, Buffer.from(data)),
    unlinkSync: path => files.delete(path)
  };
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic-private' },
    getFileSystemManager: () => fs,
    login: options => logins.push(options),
    navigateBack: () => {},
    chooseMedia: options => selections.push(options),
    chooseMessageFile: options => selections.push(options),
    setStorage: () => assert.fail('unexpected persistent storage'),
    setStorageSync: () => assert.fail('unexpected persistent storage'),
    request(options) {
      calls.push(options);
      route(options, new URL(options.url).pathname);
    }
  };
  function load(window) {
    const entry = require.resolve('../pages/' + window + '/index');
    delete require.cache[entry];
    let page;
    global.Page = definition => { page = definition; };
    require(entry);
    page.setData = patch => Object.assign(page.data, patch);
    page.onLoad({});
    pages.push({ page, entry });
    return page;
  }
  t.after(() => {
    for (const { page, entry } of pages) {
      page.onUnload();
      delete require.cache[entry];
    }
    assert.equal(files.size, 0);
    Object.assign(config, saved);
    delete global.Page;
    delete global.wx;
  });
  return { load, calls, logins, files, selections };
}

async function finishWechat(f, page, name, data) {
  const pending = page.onWechatLogin();
  f.logins.at(-1).success({ code: name });
  await tick();
  const exchange = f.calls.at(-1);
  assert.equal(exchange.url, https + '/api/v1/auth/wechat/session');
  assert.equal(exchange.method, 'POST');
  assert.equal(authHeader(exchange), undefined);
  assert.deepEqual(exchange.data, { code: name });
  ok(exchange, data);
  await pending;
}

function staffOverview(request, path) {
  if (path === '/api/v1/staff/me') {
    ok(request, staffIdentity);
  } else if (path === '/api/v1/staff/workbench') {
    ok(request, { counts: Object.fromEntries(queues.map(queue => [queue.id, 0])), dueSoonSeconds: 86400 });
  } else if (path === '/api/v1/staff/cases') {
    ok(request, { items: [] });
  }
}

test('selects only an explicit HTTPS origin or a development loopback, with no fallback', async t => {
  const f = fixture(t);
  assert.equal(httpsOrigin(https), https);
  assert.equal(httpsOrigin(https + ':8443'), https + ':8443');
  for (const address of [
    'http://intake.synthetic.test', 'https://127.0.0.1', 'https://[::1]', 'https://x.localhost',
    'https://0x7f.0.0.0x01', https + ':65536', https + '/', https + '?a=1', https + '#x',
    'https://user:pwd@intake.synthetic.test', https + '\\other.test', https + '\n', ' ' + https,
    'https://x..test', 'https://%69ntake.synthetic.test', 'https://-intake.test'
  ]) assert.equal(httpsOrigin(address), '', address);
  assert.deepEqual(apiEnvironment(), { origin: https, localEnabled: false, wechatEnabled: true });
  const staff = f.load('staff');
  const merchant = f.load('merchant');
  assert.equal(staff.data.localEnabled, false);
  assert.equal(merchant.data.wechatEnabled, true);
  await staff.onLoginSubmit(input({ token: testToken }));
  await merchant.onLoginSubmit(input({ token: testToken }));
  assert.equal(f.calls.length, 0);
  config.productionApiBaseUrl = https + '/unexpected';
  assert.deepEqual(apiEnvironment(), { origin: '', localEnabled: false, wechatEnabled: false });
  await staff.onWechatLogin();
  assert.equal(f.logins.length, 0);
  const owner = f.load('public');
  owner.onInput(input(code));
  await owner.lookup(code);
  assert.equal(f.calls.length, 0);
  config.apiMode = 'development';
  assert.deepEqual(apiEnvironment(), { origin: local, localEnabled: true, wechatEnabled: false });
  let rejected = false;
  requestConfigured({ url: https + '/api/v1/owner/verify', fail: () => { rejected = true; } });
  assert.equal(rejected, true);
  assert.equal(f.calls.length, 0);
});

test('development credentials stay on loopback and cannot be carried into formal mode', async t => {
  const f = fixture(t, (request, path) => staffOverview(request, path));
  config.apiMode = 'development';
  const page = f.load('staff');
  await page.onWechatLogin();
  assert.equal(f.logins.length, 0);
  await page.onLoginSubmit(input({ token: testToken }));
  assert.equal(page.data.view, 'workbench');
  assert.ok(f.calls.every(call => call.url.startsWith(local + '/') && authHeader(call) === 'Bearer ' + testToken));
  const count = f.calls.length;
  config.apiMode = 'production';
  await page.refreshOverview();
  assert.equal(page._token, '');
  assert.equal(page.data.view, 'login');
  assert.equal(f.calls.length, count);
});

test('wrong-window and already expired credentials never request either workspace', async t => {
  const f = fixture(t);
  const staff = f.load('staff');
  const merchant = f.load('merchant');
  await finishWechat(f, staff, 'code-wrong-staff', grant('merchant'));
  await finishWechat(f, merchant, 'code-wrong-merchant', grant('staff'));
  await finishWechat(f, staff, 'code-expired-staff', grant('staff', {
    expiresAt: new Date(Date.now() - 1000).toISOString()
  }));
  assert.deepEqual(f.calls.map(call => call.data.code), ['code-wrong-staff', 'code-wrong-merchant', 'code-expired-staff']);
  assert.equal(staff._token, '');
  assert.equal(merchant._token, '');
  assert.match(staff.data.loginError, /已失效/);
  assert.match(merchant.data.loginError, /无法进入/);
});

test('hide, timeout and retry discard late login results and use a new wx.login code', async t => {
  const f = fixture(t, (request, path) => staffOverview(request, path));
  const page = f.load('staff');
  const hiddenBeforeCode = page.onWechatLogin();
  page.onHide();
  f.logins[0].success({ code: 'late-before-exchange' });
  await hiddenBeforeCode;
  assert.equal(f.calls.length, 0);
  const hiddenBeforeExchange = page.onWechatLogin();
  f.logins[1].success({ code: 'late-after-exchange' });
  await tick();
  page.onHide();
  const lateReply = f.calls[0];
  const failure = page.onWechatLogin();
  f.logins[2].success({ code: 'network-failure' });
  await tick();
  f.calls[1].fail({ errMsg: 'timeout with synthetic-private-details' });
  await failure;
  assert.match(page.data.loginError, /登录失败/);
  assert.doesNotMatch(page.data.loginError, /private-details/);
  await finishWechat(f, page, 'fresh-code', grant('staff'));
  ok(lateReply, grant('staff', { sessionToken: 'wxsession.' + 'Z'.repeat(43) }));
  await hiddenBeforeExchange;
  assert.equal(page._token, staffToken);
  assert.equal(page.data.view, 'workbench');
  assert.doesNotMatch(JSON.stringify(page.data), /wxsession|fresh-code/);
  page.onLogout();
  assert.equal(page._token, '');
  assert.equal(page.data.staff, null);
});

test('an expired session clears both windows and drops delayed workbench data', async t => {
  const requests = [];
  const f = fixture(t, (request, path) => {
    if (path === '/api/v1/staff/me') ok(request, staffIdentity);
    else if (path === '/api/v1/merchant/me') ok(request, merchantIdentity);
    else if (path !== '/api/v1/auth/wechat/session') requests.push(request);
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const type of ['staff', 'merchant']) {
    const page = f.load(type);
    const pending = page.onWechatLogin();
    f.logins.at(-1).success({ code: 'expiry-' + type });
    await tick();
    ok(f.calls.at(-1), grant(type));
    await tick();
    assert.equal(page.data.view, 'workbench');
    now += 21000;
    for (const request of requests.splice(0)) ok(request, { items: [{ caseNumber: number, status: 'submitted' }] });
    await pending;
    assert.equal(page.data.view, 'login');
    assert.equal(page._token, '');
    assert.deepEqual(type === 'staff' ? page.data.items : page.data.cases, []);
  }
});

test('the owner expiry timer clears a verified case with no photos or pending actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const expiry = Date.now() + 1000;
  const f = fixture(t, (request, path) => {
    if (path.startsWith('/api/v1/public/')) return ok(request, { caseNumber: number, status: 'submitted', milestones: [] });
    if (path === '/api/v1/owner/verify') return ok(request, { caseNumber: number, ownerSessionToken: ownerToken,
      expiresAt: new Date(expiry).toISOString() });
    ok(request, { caseNumber: number, version: 1, round: 1, status: 'submitted', rounds: [] });
  });
  const page = f.load('public');
  page.onInput(input(code));
  await page.lookup(code);
  page.onVerifyOpen();
  page.onPrivateTokenInput(input('P'.repeat(43)));
  await page.onVerifySubmit();
  assert.equal(page.ownerSessionToken, ownerToken);
  assert.equal(page.data.verifyState, 'success');
  t.mock.timers.tick(1000);
  assert.equal(page.ownerSessionToken, '');
  assert.equal(page.data.ownerCaseNumber, '');
  assert.equal(page.data.caseNumber, number);
  assert.equal(page.data.verifyState, 'unauthorized');
});

test('HTTPS management publish and owner feedback/supplement photos share the configured origin', async t => {
  const staffCase = '/api/v1/staff/cases/' + number;
  const ownerCase = '/api/v1/owner/cases/' + number;
  const staffDetails = { caseNumber: number, status: 'awaiting_review', round: 1, version: 5,
    department: 'street-a', assignee: 'handler-a', history: [], submissionPhotos: [photo], supplementPhotos: [photo] };
  const ownerDetails = {
    caseNumber: number, status: 'awaiting_supplement', version: 9, round: 2,
    availableActions: ['submit_supplement'], supplementRequirement: { reason: '请补件' },
    rounds: [{ round: 1, feedback: { photos: [{ ...photo, publishVersion: 6 }] } }],
    supplementPhotos: [photo]
  };
  const f = fixture(t, (request, path) => {
    if (path === '/api/v1/auth/wechat/session') return;
    if (path === staffCase) return ok(request, staffDetails);
    if (path === staffCase + '/collaborations') return ok(request, { items: [] });
    if (path === staffCase + '/actions') return ok(request, { ...staffDetails, status: 'awaiting_evaluation', version: 6 });
    if (path === ownerCase) return ok(request, ownerDetails);
    if (path === ownerCase + '/actions') return ok(request, { ...ownerDetails, status: 'submitted', version: 10, availableActions: [] });
    if (path.startsWith('/api/v1/public/cases/')) return ok(request, { caseNumber: number, status: 'processing', milestones: [] });
    if (path === '/api/v1/owner/verify') return ok(request, { caseNumber: number, ownerSessionToken: ownerToken,
      expiresAt: new Date(Date.now() + 20000).toISOString() });
    if (request.responseType === 'arraybuffer') return image(request);
    staffOverview(request, path);
  });
  const staff = f.load('staff');
  await finishWechat(f, staff, 'code-publisher', grant('staff'));
  await staff.onOpenCase(tap({ case: number }));
  await staff.onPreviewOriginal(tap({ photo: '3/0' }));
  assert.equal(f.calls.at(-1).url, https + staffCase + '/submission-photos/3/0');
  await staff.onPreviewSupplementPhoto(tap({ photo: '3/0' }));
  assert.equal(f.calls.at(-1).url, https + staffCase + '/supplement-photos/3/0');
  assert.deepEqual(f.files.get(staff.data.previewPath), png);
  await staff.onOpenFeedbackPublisher();
  staff.onEditorChange({ ...input('合成公开反馈'), ...tap({ field: 'summary' }) });
  const choosing = staff.onChoosePhotos();
  f.selections.at(-1).success({ tempFiles: [{ path: '/synthetic-derivative.png', size: png.length }] });
  await choosing;
  staff.onEditorChange({ ...input(true), ...tap({ field: 'derivativesReviewed' }) });
  await staff.onActionSubmit();
  const publish = f.calls.find(call => call.url === https + staffCase + '/actions');
  const attachment = await new Response(publish.data, { headers: publish.header }).formData();
  assert.equal(JSON.parse(attachment.get('payload')).action, 'publish');
  assert.deepEqual(Buffer.from(await attachment.get('photos').arrayBuffer()), png);
  assert.equal(authHeader(publish), 'Bearer ' + staffToken);
  const owner = f.load('public');
  owner.onInput(input(code));
  await owner.lookup(code);
  assert.equal(owner.data.ownerFeedbackPhotos.length, 0);
  assert.equal(authHeader(f.calls.at(-1)), undefined);
  owner.onVerifyOpen();
  owner.onPrivateTokenInput(input('P'.repeat(43)));
  await owner.onVerifySubmit();
  await owner.onOpenFeedbackPhoto(tap({ photo: '6/0' }));
  assert.equal(f.calls.at(-1).url, https + ownerCase + '/feedback-photos/6/0');
  assert.deepEqual(f.files.get(owner.data.feedbackPhotoPath), png);
  await owner.onOpenSupplementPhoto(tap({ photo: '3/0' }));
  assert.equal(f.calls.at(-1).url, https + ownerCase + '/supplement-photos/3/0');
  assert.equal(authHeader(f.calls.at(-1)), 'Bearer ' + ownerToken);
  const supplement = owner.onChooseSupplementPhotos();
  f.selections.at(-1).success({ tempFiles: [{ tempFilePath: '/synthetic-supplement.png', size: png.length }] });
  await supplement;
  owner.onSupplementSummaryInput(input('合成补件说明'));
  await owner.onSupplementSubmit();
  const uploaded = f.calls.find(call => call.url === https + ownerCase + '/actions');
  const received = await new Response(uploaded.data, { headers: uploaded.header }).formData();
  assert.equal(JSON.parse(received.get('payload')).action, 'submit_supplement');
  assert.deepEqual(Buffer.from(await received.get('photos').arrayBuffer()), png);
  assert.equal(authHeader(uploaded), 'Bearer ' + ownerToken);
  assert.ok(f.calls.every(call => call.url.startsWith(https + '/api/v1/')));
  assert.ok(f.calls.every(call => !call.url.includes(staffToken) && !call.url.includes(ownerToken)));
});

test('HTTPS merchant reads and submits its own attachments, then clears on exit', async t => {
  const path = '/api/v1/merchant/collaborations/' + taskId;
  const task = { taskId, status: 'returned', round: 1, version: 3, instructions: '合成协办', submissionPhotos: [photo] };
  const f = fixture(t, (request, route) => {
    if (route === '/api/v1/auth/wechat/session') return;
    if (route === '/api/v1/merchant/me') return ok(request, merchantIdentity);
    if (route === path) return ok(request, task);
    if (route === path + '/submissions') return ok(request, { ...task, status: 'awaiting_review', version: 4 });
    if (route === path + '/submission-photos/3/0') return image(request);
    if (route === '/api/v1/merchant/collaborations') return ok(request, { items: [task] });
    ok(request, { items: [] });
  });
  const page = f.load('merchant');
  await finishWechat(f, page, 'code-merchant', grant('merchant'));
  await page.onOpenTask(tap({ task: taskId }));
  await page.onPreviewTaskPhoto(tap({ task: taskId, photo: '3/0' }));
  assert.equal(f.calls.at(-1).url, https + path + '/submission-photos/3/0');
  assert.deepEqual(f.files.get(page.data.taskPreviewPath), png);
  const selecting = page.onChooseTaskPhotos();
  f.selections.at(-1).success({ tempFiles: [{ tempFilePath: '/synthetic-merchant.png', size: png.length }] });
  await selecting;
  page.onTaskSummaryInput(input('合成协办说明'));
  await page.onSubmitTask();
  const submission = f.calls.find(call => call.url === https + path + '/submissions');
  const multipart = await new Response(submission.data, { headers: submission.header }).formData();
  assert.deepEqual(Buffer.from(await multipart.get('photos').arrayBuffer()), png);
  assert.ok(f.calls.slice(1).every(call => call.url.startsWith(https + '/') &&
    authHeader(call) === 'Bearer ' + merchantToken));
  page.onExit();
  assert.equal(page._token, '');
  assert.equal(page.data.taskDetail, null);
  assert.equal(f.files.size, 0);
});

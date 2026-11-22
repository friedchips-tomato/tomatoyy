const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const config = require('../config');

const version = 2;
const first = 'CD-' + 'A'.repeat(32);
const second = 'CD-' + 'B'.repeat(32);
const ownerToken = 'owner.synthetic-supplement-token';
const dutyToken = 'd'.repeat(43);
const root = '/synthetic-private';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const bytes = () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length);
const metadata = { round: 1, submitVersion: 3, position: 0, mediaType: 'image/png', size: png.length };
const ownerDetail = (caseNumber, supplemented = false) => ({
  caseNumber, round: 1, version: supplemented ? 3 : version, rounds: [],
  status: supplemented ? 'submitted' : 'awaiting_supplement',
  availableActions: supplemented ? [] : ['submit_supplement'],
  ...(supplemented ? { supplementPhotos: [metadata] } : { supplementRequirement: { reason: '请附现场情况' } })
});
const input = value => ({ detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });
const imageTap = tap({ photo: '3/0' });
const ownerPath = caseNumber => '/api/v1/owner/cases/' + caseNumber;
const staffPath = caseNumber => '/api/v1/staff/cases/' + caseNumber;
const respond = (request, code, data, header) => request.success({ statusCode: code, data, header });
const respondPhoto = request => respond(request, 200, bytes(), { 'content-type': 'image/png' });

function fixture(t) {
  const previousOrigin = config.apiBaseUrl;
  const calls = [];
  const choices = [];
  const reads = [];
  const files = new Map([
    [root + '/owner-supplement-preview-abc-9.webp', png],
    [root + '/unrelated.png', png]
  ]);
  const controls = { partialWrite: false, failSyncDelete: false };
  const pages = [];
  const fs = {
    readdirSync: () => [...files.keys()].map(path => path.slice(root.length + 1)),
    readFile: request => reads.push(request),
    writeFileSync(path, value) {
      files.set(path, Buffer.from(value));
      if (controls.partialWrite) throw new Error('synthetic failed write');
    },
    unlinkSync(path) {
      if (controls.failSyncDelete) throw new Error('synthetic failed unlink');
      files.delete(path);
    },
    unlink({ filePath, success, complete }) {
      files.delete(filePath);
      success();
      complete();
    }
  };
  global.wx = {
    env: { USER_DATA_PATH: root },
    getFileSystemManager: () => fs,
    chooseMedia: request => choices.push(request),
    request: request => calls.push(request),
    setStorage: () => assert.fail('unexpected persistent write'),
    setStorageSync: () => assert.fail('unexpected persistent write')
  };
  function load(name) {
    const entry = require.resolve('../pages/' + name + '/index');
    delete require.cache[entry];
    let page;
    global.Page = definition => { page = definition; };
    require(entry);
    page.setData = patch => Object.assign(page.data, patch);
    page.onLoad();
    pages.push({ page, entry });
    return page;
  }
  t.after(() => {
    for (const { page, entry } of pages) {
      page.onUnload();
      delete require.cache[entry];
    }
    assert.deepEqual([...files.keys()], [root + '/unrelated.png']);
    config.apiBaseUrl = previousOrigin;
    delete global.Page;
    delete global.wx;
  });
  return { load, calls, choices, reads, files, controls };
}

function bindOwner(page, caseNumber = first, token = ownerToken, expiry = Date.now() + 30000) {
  page.ownerCaseNumber = caseNumber;
  page.lastPublicCaseNumber = caseNumber;
  page.ownerSessionToken = token;
  page.ownerExpiresAt = expiry;
  page.ownerEpoch++;
  page.setData({ verifyState: 'success', showVerify: true });
}

async function select(page, choices) {
  const choosing = page.onChooseSupplementPhotos();
  const request = choices.at(-1);
  assert.equal(request.count, 3);
  request.success({ tempFiles: [{ tempFilePath: '/wx/synthetic-original', size: png.length }] });
  await choosing;
  assert.equal(page.data.supplementPhotoCount, 1);
}

test('本人照片沿用动作锁、版本和 multipart，清除照片后保持 JSON 补件', async t => {
  const { load, choices, reads, calls } = fixture(t);
  const page = load('public');
  bindOwner(page);
  page.applyOwnerDetail(ownerDetail(first));
  await select(page, choices);
  page.onSupplementSummaryInput(input('补充说明'));
  const writing = page.onSupplementSubmit();
  page.onSupplementSubmit();
  assert.equal(reads.length, 1);
  assert.equal(calls.length, 0);
  reads[0].success({ data: bytes() });
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.apiBaseUrl + ownerPath(first) + '/actions');
  const form = await new Response(calls[0].data, { headers: calls[0].header }).formData();
  assert.equal(calls[0].header.Authorization, 'Bearer ' + ownerToken);
  assert.deepEqual(JSON.parse(form.get('payload')), { action: 'submit_supplement', expectedVersion: 2, summary: '补充说明' });
  assert.deepEqual(Buffer.from(await form.get('photos').arrayBuffer()), png);
  respond(calls[0], 200, ownerDetail(first, true));
  await writing;
  assert.equal(page.data.supplementPhotoCount, 0);
  assert.equal(page.data.showSupplement, false);
  assert.deepEqual(page.data.ownerSupplementPhotos.map(item => item.key), ['3/0']);
  assert.equal(page.data.ownerFeedbackPhotos.length, 0);
  page.applyOwnerDetail(ownerDetail(first));
  await select(page, choices);
  page.onClearSupplementPhotos();
  page.onSupplementSummaryInput(input('仅文字'));
  const text = page.onSupplementSubmit();
  assert.deepEqual(calls[1].data, { action: 'submit_supplement', expectedVersion: 2, summary: '仅文字' });
  assert.equal(calls[1].header['content-type'], 'application/json');
  respond(calls[1], 200, ownerDetail(first, true));
  await text;
});

test('切单、隐藏或到期后放弃在途图片选择和构包', async t => {
  const { load, choices, calls, reads } = fixture(t);
  const page = load('public');
  bindOwner(page);
  page.applyOwnerDetail(ownerDetail(first));
  const choosing = page.onChooseSupplementPhotos();
  page.onInput(input('NEW_PUBLIC_CODE'));
  choices[0].success({ tempFiles: [{ tempFilePath: '/wx/late', size: png.length }] });
  await choosing;
  assert.equal(page.data.supplementPhotoCount, 0);
  for (const interrupt of [() => page.onInput(input('SWITCHED')), () => page.onHide(),
    () => { page.ownerExpiresAt = Date.now() - 1; }]) {
    bindOwner(page);
    page.applyOwnerDetail(ownerDetail(first));
    await select(page, choices);
    page.onSupplementSummaryInput(input('合成说明'));
    const writing = page.onSupplementSubmit();
    interrupt();
    reads.at(-1).success({ data: bytes() });
    await writing;
    assert.equal(calls.length, 0);
    assert.equal(page.supplementFiles.length, 0);
    assert.equal(page.ownerSessionToken, '');
    assert.equal(page.data.actionPending, false);
  }
});

test('上传文件签名无效时不发请求，可以清除文件并重新提交', async t => {
  const { load, choices, reads, calls } = fixture(t);
  const page = load('public');
  bindOwner(page);
  page.applyOwnerDetail(ownerDetail(first));
  await select(page, choices);
  page.onSupplementSummaryInput(input('合成说明'));
  const attempt = page.onSupplementSubmit();
  reads[0].success({ data: new ArrayBuffer(png.length) });
  await attempt;
  assert.equal(calls.length, 0);
  assert.equal(page.actionLocked, false);
  assert.match(page.data.actionMessage, /JPEG、PNG 或 WebP/);
  page.onClearSupplementPhotos();
  const fallback = page.onSupplementSubmit();
  assert.equal(calls[0].header['content-type'], 'application/json');
  respond(calls[0], 200, ownerDetail(first, true));
  await fallback;
});

test('图片写入冲突或超时只读回，失败时仍锁住写入并可重新读回', async t => {
  const { load, choices, calls, reads } = fixture(t);
  const page = load('public');
  for (const fail of [request => respond(request, 409, { error: 'stale_version' }),
    request => request.fail({ errMsg: 'request:fail timeout' })]) {
    const start = calls.length;
    bindOwner(page);
    page.applyOwnerDetail(ownerDetail(first));
    await select(page, choices);
    page.onSupplementSummaryInput(input('合成说明'));
    const writing = page.onSupplementSubmit();
    reads.at(-1).success({ data: bytes() });
    await new Promise(setImmediate);
    fail(calls[start]);
    await writing;
    assert.equal(calls[start + 1].method, 'GET');
    page.onSupplementSubmit();
    assert.equal(calls.length, start + 2);
    calls[start + 1].fail({ errMsg: 'request:fail timeout' });
    await new Promise(setImmediate);
    assert.equal(page.data.actionState, 'refresh_failed');
    assert.equal(page.actionLocked, true);
    page.onRetryRefresh();
    assert.equal(calls[start + 2].method, 'GET');
    respond(calls[start + 2], 200, ownerDetail(first, true));
    await new Promise(setImmediate);
    assert.equal(page.actionLocked, false);
    assert.equal(page.data.supplementPhotoCount, 0);
    assert.equal(page.data.ownerSupplementPhotos.length, 1);
    assert.deepEqual(calls.slice(start).map(request => request.method), ['POST', 'GET', 'GET']);
  }
});

test('本人只读取绑定工单的补件原图，切单、异常写盘、渲染失败和失权均清理', async t => {
  const { load, calls, controls, files } = fixture(t);
  const page = load('public');
  await page.onOpenSupplementPhoto(imageTap);
  assert.equal(calls.length, 0);
  assert.equal(files.has(root + '/owner-supplement-preview-abc-9.webp'), false);
  bindOwner(page);
  page.applyOwnerDetail(ownerDetail(first, true));
  const stale = page.onOpenSupplementPhoto(imageTap);
  page.onInput(input('SWITCHED'));
  bindOwner(page, second);
  page.applyOwnerDetail(ownerDetail(second, true));
  respondPhoto(calls[0]);
  await stale;
  assert.equal(page.data.feedbackPhotoPath, '');
  assert.equal(files.size, 1);
  controls.partialWrite = true;
  controls.failSyncDelete = true;
  const broken = page.onOpenSupplementPhoto(imageTap);
  assert.equal(calls[1].url, config.apiBaseUrl + ownerPath(second) + '/supplement-photos/3/0');
  respondPhoto(calls[1]);
  await broken;
  assert.match(page.data.feedbackPhotoError, /读取失败/);
  assert.equal(files.size, 1);
  controls.partialWrite = false;
  const reading = page.onOpenSupplementPhoto(imageTap);
  respondPhoto(calls[2]);
  await reading;
  assert.equal(page.data.previewKind, 'supplement');
  const path = page.data.feedbackPhotoPath;
  assert.deepEqual(files.get(path), png);
  page.onFeedbackImageError(tap({ path }));
  assert.ok(!files.has(path));
  const denied = page.onOpenSupplementPhoto(imageTap);
  respond(calls[3], 401, {});
  await denied;
  assert.equal(page.ownerSessionToken, '');
  assert.equal(page.data.ownerSupplementPhotos.length, 0);
  assert.equal(files.size, 1);
});

test('管理补件原图仅走本单管理路径，读取被拒和隐藏均撤下旧预览', async t => {
  const { load, calls, files } = fixture(t);
  load('public'); // Owner-private orphan cleanup must leave other paths alone.
  const page = load('staff');
  const staff = { id: 'desk', role: 'duty' };
  page._token = dutyToken;
  page.setData({ activeCase: first, staff, view: 'detail' });
  page.showDetail(ownerDetail(first, true));
  assert.equal(page.data.submissionPhotos.length, 0);
  assert.equal(page.data.supplementPhotos.length, 1);
  const opening = page.onPreviewSupplementPhoto(imageTap);
  assert.equal(calls[0].url, config.apiBaseUrl + staffPath(first) + '/supplement-photos/3/0');
  assert.equal(calls[0].header.Authorization, 'Bearer ' + dutyToken);
  respondPhoto(calls[0]);
  await opening;
  assert.equal(page.data.previewLabel, '补件原图');
  assert.deepEqual(files.get(page.data.previewPath), png);
  const denied = page.onPreviewSupplementPhoto(imageTap);
  respond(calls[1], 403, {});
  await denied;
  assert.equal(page.data.view, 'login');
  assert.equal(page.data.supplementPhotos.length, 0);
  assert.equal(files.size, 1);
  page._token = dutyToken;
  page.setData({ activeCase: second, staff, view: 'detail' });
  page.showDetail(ownerDetail(second, true));
  const late = page.onPreviewSupplementPhoto(imageTap);
  page.onHide();
  respondPhoto(calls[2]);
  await late;
  assert.equal(page.data.previewPath, '');
  assert.equal(files.size, 1);
});

test('真实回环服务接收小程序 multipart 并分权读回已提交的原图', async t => {
  const { load, choices, reads, files } = fixture(t);
  const page = load('public');
  const { createIntakeServer } = await import('../../server/src/server.js');
  const integration = 'i'.repeat(43);
  const server = createIntakeServer({
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 83),
    integrations: [{ source: 'synthetic-supplement-ui', token: integration }],
    staff: [{ id: 'desk', role: 'duty', token: dutyToken }]
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  config.apiBaseUrl = origin;
  const call = (path, { auth, body } = {}) => fetch(origin + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(4000),
    headers: {
      ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
    },
    body: body instanceof FormData ? body : body && JSON.stringify(body)
  });
  global.wx.request = async options => {
    assert.equal(new URL(options.url).origin, origin);
    try {
      const response = await fetch(options.url, {
        method: options.method, headers: options.header, signal: AbortSignal.timeout(4000),
        body: options.method === 'POST'
          ? options.data instanceof ArrayBuffer ? options.data : JSON.stringify(options.data)
          : undefined
      });
      const data = options.responseType === 'arraybuffer' && response.ok
        ? await response.arrayBuffer() : await response.json();
      respond(options, response.status, data, Object.fromEntries(response.headers));
    } catch {
      options.fail({});
    }
  };
  const intake = async id => {
    const body = new FormData();
    body.append('payload', JSON.stringify({ externalCaseId: id, occurredAt: new Date().toISOString(),
      location: '合成地点', category: '合成类别', description: '合成描述' }));
    const response = await call('/api/v1/integrations/intake/cases', { auth: integration, body });
    assert.equal(response.status, 201);
    return response.json();
  };
  const verify = async receipt => {
    const response = await call('/api/v1/owner/verify', { body: {
      publicLookupCode: receipt.publicLookupCode, privateLookupToken: receipt.privateLookupToken
    } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const receipt = await intake('synthetic-a');
  const unrelated = await verify(await intake('synthetic-b'));
  const { caseNumber } = receipt;
  const request = await call(staffPath(caseNumber) + '/actions', { auth: dutyToken,
    body: { action: 'request_supplement', expectedVersion: 1, reason: '请补充' } });
  assert.equal(request.status, 200);
  await request.json();
  const authorized = await verify(receipt);
  bindOwner(page, caseNumber, authorized.ownerSessionToken, Date.parse(authorized.expiresAt));
  await page.loadOwnerCase(++page.ownerSeq);
  await select(page, choices);
  page.onSupplementSummaryInput(input('回环合成说明'));
  const writing = page.onSupplementSubmit();
  reads[0].success({ data: bytes() });
  await writing;
  assert.equal(page.ownerVersion, 3);
  assert.equal(page.data.ownerCaseNumber, caseNumber);
  assert.equal(page.data.showSupplement, false);
  await page.onOpenSupplementPhoto(imageTap);
  assert.deepEqual(files.get(page.data.feedbackPhotoPath), png);
  const staffPage = load('staff');
  await staffPage.onLoginSubmit(input({ token: dutyToken }));
  await staffPage.onOpenCase(tap({ case: caseNumber }));
  await staffPage.onPreviewSupplementPhoto(imageTap);
  assert.deepEqual(files.get(staffPage.data.previewPath), png);
  const imagePath = ownerPath(caseNumber) + '/supplement-photos/3/0';
  for (const auth of [undefined, unrelated.ownerSessionToken, integration]) {
    const response = await call(imagePath, { auth });
    assert.equal(response.status, 401);
    await response.json();
  }
  const safe = await call('/api/v1/public/cases/' + receipt.publicLookupCode);
  assert.doesNotMatch(await safe.text(), /supplementPhotos|回环合成说明/);
  page.onCloseFeedbackPhoto();
  staffPage.onClosePhotoPreview();
  assert.equal(files.size, 1);
});

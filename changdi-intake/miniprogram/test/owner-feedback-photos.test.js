const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const config = require('../config');
const { publishedPhotos } = require('../pages/public/feedback-photos');

const first = 'CD-' + 'A'.repeat(32);
const other = 'CD-' + 'B'.repeat(32);
const token = 'owner.synthetic-test-session';
const root = '/synthetic-private';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
const metadata = { publishVersion: 6, position: 0, mediaType: 'image/png', size: png.length };
const rounds = [{ round: 1, feedback: { photos: [metadata] } }];
const tap = dataset => ({ currentTarget: { dataset } });
const photoTap = tap({ photo: '6/0' });

function fixture(t) {
  const modulePath = require.resolve('../pages/public/index');
  const origin = config.apiBaseUrl;
  delete require.cache[modulePath];
  let page;
  const calls = [];
  const deleted = [];
  const files = new Map([
    [root + '/owner-feedback-preview-past-3.png', png],
    [root + '/staff-preview-past-2.png', png],
    [root + '/unrelated.png', png]
  ]);
  const controls = { failWrite: false, failSyncDelete: false };
  const fs = {
    readdirSync: dir => [...files.keys()].filter(path => path.startsWith(dir + '/')).map(path => path.slice(dir.length + 1)),
    writeFileSync(path, data) {
      files.set(path, Buffer.from(data));
      if (controls.failWrite) throw new Error('synthetic partial write');
    },
    unlinkSync(path) {
      if (controls.failSyncDelete) throw new Error('synthetic unlink failure');
      deleted.push(path);
      files.delete(path);
    },
    unlink({ filePath, success, complete }) {
      deleted.push(filePath);
      files.delete(filePath);
      success();
      complete();
    }
  };
  global.Page = value => { page = value; };
  global.wx = {
    env: { USER_DATA_PATH: root },
    getFileSystemManager: () => fs,
    request: options => calls.push(options),
    setStorage: () => assert.fail('unexpected storage write'),
    setStorageSync: () => assert.fail('unexpected storage write')
  };
  require(modulePath);
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad({});
  t.after(() => {
    page.onUnload();
    assert.equal([...files.keys()].filter(path => path.includes('/owner-feedback-preview-')).length, 0);
    config.apiBaseUrl = origin;
    delete global.Page;
    delete global.wx;
    delete require.cache[modulePath];
  });
  return { page, files, calls, controls, deleted };
}

function authorize(page, expiresAt = Date.now() + 30000) {
  page.ownerEpoch++;
  page.ownerCaseNumber = first;
  page.lastPublicCaseNumber = first;
  page.ownerSessionToken = token;
  page.ownerVersion = 6;
  page.ownerExpiresAt = expiresAt;
  page.setData({ verifyState: 'success' });
  page.setFeedbackPhotos(publishedPhotos(rounds, 6));
}

function imageResponse(call, data = png, type = 'image/png') {
  call.success({ statusCode: 200, data: arrayBuffer(data), header: { 'Content-Type': type } });
}

test('从本人历轮筛选有效图片，公开页和无效元数据不发请求', async t => {
  const { page, calls, files } = fixture(t);
  assert.ok(!files.has(root + '/owner-feedback-preview-past-3.png'));
  assert.ok(files.has(root + '/staff-preview-past-2.png'));
  assert.ok(files.has(root + '/unrelated.png'));
  await page.onOpenFeedbackPhoto(photoTap);
  assert.equal(calls.length, 0);
  assert.deepEqual(publishedPhotos([{ round: 1, feedback: { photos: [
    metadata, metadata, { ...metadata, publishVersion: 7 }, { ...metadata, position: 3 },
    { ...metadata, size: 10 }, { ...metadata, mediaType: 'image/jpeg' }
  ] } }], 6).map(photo => photo.key), ['6/0']);
  authorize(page);
  await page.onOpenFeedbackPhoto(tap({ photo: '../6/0' }));
  assert.equal(calls.length, 0);
  const opening = page.onOpenFeedbackPhoto(photoTap);
  assert.equal(calls[0].url, config.apiBaseUrl + '/api/v1/owner/cases/' + first + '/feedback-photos/6/0');
  assert.deepEqual(calls[0].header, { Authorization: 'Bearer ' + token });
  imageResponse(calls[0]);
  await opening;
  assert.deepEqual(files.get(page.data.feedbackPhotoPath), png);
  page.onCloseFeedbackPhoto();
  assert.equal(page.data.feedbackPhotoPath, '');
  assert.equal(files.size, 2);
});

test('MIME、大小、格式、部分落盘及渲染失败都不会保留预览', async t => {
  const { page, calls, controls, files } = fixture(t);
  authorize(page);
  const broken = Buffer.from(png);
  broken[25] = 6;
  for (const [data, type] of [[png, 'text/plain'], [png.subarray(1), 'image/png'], [broken, 'image/png']]) {
    const pending = page.onOpenFeedbackPhoto(photoTap);
    imageResponse(calls.at(-1), data, type);
    await pending;
    assert.equal(page.data.feedbackPhotoPath, '');
    assert.match(page.data.feedbackPhotoError, /读取失败/);
  }
  controls.failWrite = true;
  controls.failSyncDelete = true;
  const failed = page.onOpenFeedbackPhoto(photoTap);
  imageResponse(calls.at(-1));
  await failed;
  assert.equal(files.size, 2, 'fallback deletes a partially written file');
  controls.failWrite = false;
  const valid = page.onOpenFeedbackPhoto(photoTap);
  imageResponse(calls.at(-1));
  await valid;
  page.onFeedbackImageError(tap({ path: page.data.feedbackPhotoPath }));
  assert.equal(files.size, 2);
  assert.match(page.data.feedbackPhotoError, /预览失败/);
});

test('关闭、切单、隐藏、到期和失权后丢弃迟到结果并删除预览', async t => {
  const { page, calls, files } = fixture(t);
  for (const change of [
    () => page.onCloseFeedbackPhoto(),
    () => { page.clearOwnerOnly(); page.lastPublicCaseNumber = other; },
    () => page.onHide(),
    () => { page.ownerExpiresAt = Date.now() - 1; }
  ]) {
    authorize(page);
    const pending = page.onOpenFeedbackPhoto(photoTap);
    change();
    imageResponse(calls.at(-1));
    await pending;
    assert.equal(page.data.feedbackPhotoPath, '');
    assert.equal(files.size, 2);
  }
  authorize(page);
  const denied = page.onOpenFeedbackPhoto(photoTap);
  calls.at(-1).success({ statusCode: 401, data: {} });
  await denied;
  assert.equal(page.ownerSessionToken, '');
  assert.deepEqual(page.data.ownerFeedbackPhotos, []);
  authorize(page, Date.now() + 60);
  const open = page.onOpenFeedbackPhoto(photoTap);
  imageResponse(calls.at(-1));
  await open;
  assert.ok(page.data.feedbackPhotoPath);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(page.data.feedbackPhotoPath, '');
  assert.equal(page.ownerSessionToken, '');
  assert.equal(files.size, 2);
});

test('实际回环后端仅允许本单有效授权读取已发布图片', async t => {
  const { page, files } = fixture(t);
  const { createIntakeServer } = await import('../../server/src/server.js');
  const credentials = ['i', 'd', 'h', 's'].map(letter => letter.repeat(43));
  const [integration, duty, handler, supervisor] = credentials;
  let now = Date.now();
  const server = createIntakeServer({
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 89), now: () => new Date(now),
    integrations: [{ source: 'synthetic-feedback-frontend', token: integration }],
    staff: [
      { id: 'desk', role: 'duty', token: duty },
      { id: 'worker', role: 'handler', department: 'a', token: handler },
      { id: 'lead', role: 'supervisor', department: 'a', token: supervisor }
    ]
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
        method: options.method, headers: options.header, signal: AbortSignal.timeout(4000)
      });
      const data = options.responseType === 'arraybuffer' && response.ok
        ? await response.arrayBuffer() : await response.json();
      options.success({ statusCode: response.status, data, header: Object.fromEntries(response.headers) });
    } catch {
      options.fail({});
    }
  };
  const call = (path, { auth, data } = {}) => fetch(origin + path, {
    method: data ? 'POST' : 'GET', signal: AbortSignal.timeout(4000),
    headers: {
      ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
      ...(data && !(data instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
    },
    body: data instanceof FormData ? data : data ? JSON.stringify(data) : undefined
  });
  async function intake(id) {
    const form = new FormData();
    form.append('payload', JSON.stringify({ externalCaseId: id, occurredAt: new Date(now).toISOString(),
      location: '合成地点', category: '合成类别', description: '合成描述' }));
    const result = await call('/api/v1/integrations/intake/cases', { auth: integration, data: form });
    assert.equal(result.status, 201);
    return result.json();
  }
  async function verify(receipt) {
    const result = await call('/api/v1/owner/verify', { data: {
      publicLookupCode: receipt.publicLookupCode, privateLookupToken: receipt.privateLookupToken
    } });
    assert.equal(result.status, 200);
    return result.json();
  }
  const receipt = await intake('synthetic-feedback-a');
  const another = await intake('synthetic-feedback-b');
  const path = '/api/v1/staff/cases/' + receipt.caseNumber + '/actions';
  for (const [auth, data] of [
    [duty, { action: 'accept', expectedVersion: 1 }],
    [duty, { action: 'assign', expectedVersion: 2, assignee: 'worker', dueAt: new Date(now + 86400000).toISOString() }],
    [handler, { action: 'start', expectedVersion: 3 }],
    [handler, { action: 'submit_result', expectedVersion: 4, summary: '合成处置', photoOmissionReason: '文字送审' }]
  ]) {
    const result = await call(path, { auth, data });
    assert.equal(result.status, 200);
    await result.json();
  }
  const form = new FormData();
  form.append('payload', JSON.stringify({ action: 'publish', expectedVersion: 5, summary: '合成发布',
    derivativesReviewed: true }));
  form.append('photos', new Blob([png], { type: 'image/png' }), 'synthetic.png');
  const publication = await call(path, { auth: supervisor, data: form });
  assert.equal(publication.status, 200);
  await publication.json();
  const owner = await verify(receipt);
  const otherOwner = await verify(another);
  const imagePath = '/api/v1/owner/cases/' + receipt.caseNumber + '/feedback-photos/6/0';
  for (const response of [await call(imagePath, { auth: otherOwner.ownerSessionToken }), await call(imagePath)]) {
    assert.equal(response.status, 401);
    await response.json();
  }
  page.ownerCaseNumber = receipt.caseNumber;
  page.lastPublicCaseNumber = receipt.caseNumber;
  page.ownerSessionToken = owner.ownerSessionToken;
  page.ownerExpiresAt = Date.parse(owner.expiresAt);
  const ready = new Promise(resolve => {
    const originalSetData = page.setData;
    page.setData = patch => {
      originalSetData(patch);
      if (patch.ownerFeedbackPhotos && patch.ownerFeedbackPhotos.length) resolve();
    };
  });
  page.loadOwnerCase(++page.ownerSeq);
  await Promise.race([ready, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('owner detail timed out')), 4500);
    timer.unref();
  })]);
  await page.onOpenFeedbackPhoto(photoTap);
  assert.deepEqual(files.get(page.data.feedbackPhotoPath), png);
  now += 1800000;
  await page.onOpenFeedbackPhoto(photoTap);
  assert.equal(page.ownerSessionToken, '');
  assert.equal(page.data.feedbackPhotoPath, '');
  assert.equal(files.size, 2);
});

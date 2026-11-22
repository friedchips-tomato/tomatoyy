const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { crc32, deflateSync } = require('node:zlib');
const config = require('../config');
const { queues } = require('../pages/staff/workbench');

const first = 'CD-' + 'A'.repeat(32);
const second = 'CD-' + 'B'.repeat(32);
const endpoint = '/api/v1/staff/cases/';
const profiles = {
  handler: { id: 'handler-a', role: 'handler', department: 'street', token: 'h'.repeat(43) },
  supervisor: { id: 'lead-a', role: 'supervisor', department: 'street', token: 's'.repeat(43) },
  duty: { id: 'desk-a', role: 'duty', token: 'd'.repeat(43) }
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z',
  'base64');
const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
const tap = dataset => ({ currentTarget: { dataset } });
const input = (field, value) => ({ ...tap({ field }), detail: { value } });
const ok = (options, data, header = {}) => options.success({ statusCode: 200, data, header });
const login = (page, role) => page.onLoginSubmit({ detail: { value: { token: profiles[role].token } } });
const open = (page, caseNumber = first) => page.onOpenCase(tap({ case: caseNumber }));
const action = (page, name) => page.onActionTap(tap({ action: name }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const originalMetadata = { round: 1, submitVersion: 5, position: 0, mediaType: 'image/png', size: png.length };

function detail(caseNumber, status, extra = {}) {
  return {
    caseNumber, status, version: status === 'processing' ? 4 : 5, round: 1, category: '合成事项',
    sourceType: 'integration', department: 'street', assignee: 'handler-a', history: [], ...extra
  };
}

function fixture(t) {
  const modulePath = require.resolve('../pages/staff/index');
  const origin = config.apiBaseUrl;
  delete require.cache[modulePath];
  let page;
  global.Page = definition => { page = definition; };
  const events = { requests: [], picks: [], reads: [], deletes: [], writes: [] };
  const files = new Map();
  const inputs = new Map();
  const control = {
    details: new Map(), holdReads: false, holdPreview: false, failWrite: false, failSyncDelete: false,
    nextPost: null
  };
  const fs = {
    readFile(options) {
      events.reads.push(options);
      if (control.holdReads) return;
      const data = inputs.get(options.filePath);
      if (data) options.success({ data: arrayBuffer(data) });
      else options.fail();
    },
    writeFileSync(path, data) {
      files.set(path, Buffer.from(data));
      events.writes.push(path);
      if (control.failWrite) throw new Error('synthetic partial write');
    },
    unlinkSync(path) {
      if (control.failSyncDelete) throw new Error('synthetic sync failure');
      events.deletes.push(path);
      files.delete(path);
    },
    unlink(options) {
      events.deletes.push(options.filePath);
      files.delete(options.filePath);
      options.success();
      options.complete();
    }
  };
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic-user-data' },
    getFileSystemManager: () => fs,
    chooseMedia: options => events.picks.push({ method: 'media', options }),
    chooseMessageFile: options => events.picks.push({ method: 'message', options }),
    request(options) {
      events.requests.push(options);
      const path = new URL(options.url).pathname;
      if (options.method === 'POST') {
        if (control.nextPost) control.nextPost(options);
        return;
      }
      if (path === '/api/v1/staff/me') {
        const profile = Object.values(profiles).find(item => 'Bearer ' + item.token === options.header.Authorization);
        const { token, ...identity } = profile;
        ok(options, identity);
      } else if (path === '/api/v1/staff/workbench') {
        ok(options, { counts: Object.fromEntries(queues.map(queue => [queue.id, 0])), dueSoonSeconds: 86400 });
      } else if (path.endsWith('/submission-photos/5/0')) {
        if (!control.holdPreview) ok(options, arrayBuffer(png), { 'content-type': 'image/png' });
      } else if (path.endsWith('/collaborations') || path === '/api/v1/staff/cases') {
        ok(options, { items: [] });
      } else {
        ok(options, control.details.get(path.slice(endpoint.length)));
      }
    }
  };
  require(modulePath);
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad();
  t.after(() => {
    if (page._alive) page.onUnload();
    assert.equal(files.size, 0, 'all preview files released');
    config.apiBaseUrl = origin;
    delete global.Page;
    delete global.wx;
    delete require.cache[modulePath];
  });
  return { page, events, inputs, control, files };
}

async function picked(f, method, files) {
  const pending = f.page.onChoosePhotos();
  const call = f.events.picks.at(-1);
  assert.equal(call.method, method);
  assert.equal(call.options.count, 3);
  call.options.success({ tempFiles: files.map(([path, size]) => ({
    [method === 'media' ? 'tempFilePath' : 'path']: path, size
  })) });
  await pending;
}

async function inspectMultipart(request) {
  assert.ok(request.data instanceof ArrayBuffer);
  return new Response(request.data, { headers: { 'Content-Type': request.header['Content-Type'] } }).formData();
}

test('承办选择两张图时按真实 multipart 结构编码并锁住读文件阶段', async t => {
  const f = fixture(t);
  f.control.details.set(first, detail(first, 'processing'));
  await login(f.page, 'handler');
  await open(f.page);
  await action(f.page, 'submit_result');
  await picked(f, 'media', [['/oversize.png', 5 * 1024 * 1024 + 1]]);
  assert.equal(f.page.data.editor.photoCount, 0);
  assert.match(f.page.data.editor.error, /5 MiB/);
  f.inputs.set('/synthetic.png', png);
  f.inputs.set('/synthetic.jpg', jpeg);
  await picked(f, 'media', [['/synthetic.png', png.length], ['/synthetic.jpg', jpeg.length]]);
  assert.equal(f.page.data.editor.photoCount, 2);
  assert.doesNotMatch(JSON.stringify(f.page.data), /synthetic\.png/);
  f.page.onEditorChange(input('summary', '合成送审说明📷'));
  f.control.holdReads = true;
  const saving = f.page.onActionSubmit();
  await f.page.onActionSubmit();
  assert.equal(f.page.data.saving, true);
  assert.equal(f.events.reads.length, 1);
  assert.equal(f.events.requests.filter(request => request.method === 'POST').length, 0);
  f.events.reads[0].success({ data: arrayBuffer(png) });
  await tick();
  f.events.reads[1].success({ data: arrayBuffer(jpeg) });
  await tick();
  const sent = f.events.requests.at(-1);
  const form = await inspectMultipart(sent);
  assert.equal(sent.url, config.apiBaseUrl + endpoint + first + '/actions');
  assert.deepEqual(JSON.parse(form.get('payload')), { expectedVersion: 4, action: 'submit_result', summary: '合成送审说明📷' });
  const images = form.getAll('photos');
  assert.deepEqual(images.map(image => image.type), ['image/png', 'image/jpeg']);
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), jpeg);
  ok(sent, detail(first, 'awaiting_review', { submissionPhotos: [originalMetadata] }));
  await saving;
  assert.equal(f.page.data.detail.status, 'awaiting_review');
  assert.equal(f.page.data.submissionPhotos.length, 1);
  assert.deepEqual(f.page._pickedFiles, []);
});

test('主管图片发布独立于文字和原图查看，重新选图会重置确认', async t => {
  const f = fixture(t);
  f.control.details.set(first, detail(first, 'awaiting_review', { submissionPhotos: [originalMetadata] }));
  f.inputs.set('/approved.png', png);
  f.inputs.set('/incorrect.png', jpeg);
  await login(f.page, 'supervisor');
  await open(f.page);
  assert.equal(f.page.data.canPublishFeedbackPhotos, true);
  await f.page.onOpenFeedbackPublisher();
  f.page.onEditorChange(input('summary', '仅向本人发布的说明'));
  await picked(f, 'message', [['/incorrect.png', jpeg.length]]);
  f.page.onEditorChange(input('derivativesReviewed', true));
  await f.page.onActionSubmit();
  assert.match(f.page.data.editor.error, /RGB/);
  assert.equal(f.events.requests.filter(request => request.method === 'POST').length, 0);
  await picked(f, 'message', [['/approved.png', png.length]]);
  assert.equal(f.page.data.editor.derivativesReviewed, false);
  await f.page.onActionSubmit();
  assert.match(f.page.data.editor.error, /确认/);
  f.page.onEditorChange(input('derivativesReviewed', true));
  const publishing = f.page.onActionSubmit();
  await tick();
  const sent = f.events.requests.at(-1);
  const form = await inspectMultipart(sent);
  assert.deepEqual(JSON.parse(form.get('payload')), {
    action: 'publish', expectedVersion: 5, summary: '仅向本人发布的说明', derivativesReviewed: true
  });
  assert.equal(form.getAll('photos').length, 1);
  ok(sent, detail(first, 'awaiting_evaluation', { version: 6 }));
  await publishing;
  assert.equal(f.page.data.canPublishFeedbackPhotos, false);
});

test('切单及失去会话后丢弃选择器和读文件的迟到结果', async t => {
  const f = fixture(t);
  for (const number of [first, second]) f.control.details.set(number, detail(number, 'processing'));
  await login(f.page, 'handler');
  await open(f.page);
  await action(f.page, 'submit_result');
  const latePick = f.page.onChoosePhotos();
  const picker = f.events.picks.at(-1).options;
  await open(f.page, second);
  picker.success({ tempFiles: [{ tempFilePath: '/stale.png', size: png.length }] });
  await latePick;
  assert.equal(f.page.data.detail.caseNumber, second);
  assert.equal(f.page.data.editor, null);
  assert.deepEqual(f.page._pickedFiles, []);

  await action(f.page, 'submit_result');
  await picked(f, 'media', [['/late.png', png.length]]);
  f.page.onEditorChange(input('summary', '合成说明'));
  f.control.holdReads = true;
  const lateWrite = f.page.onActionSubmit();
  f.page.onHide();
  f.events.reads.at(-1).success({ data: arrayBuffer(png) });
  await lateWrite;
  assert.equal(f.page.data.view, 'login');
  assert.equal(f.page._token, '');
  assert.equal(f.events.requests.filter(request => request.method === 'POST').length, 0);
});

test('原图按需授权读取，切单、失权、预览失败和延迟响应都不留文件', async t => {
  const f = fixture(t);
  for (const number of [first, second]) {
    f.control.details.set(number, detail(number, 'awaiting_review', { submissionPhotos: [originalMetadata] }));
  }
  await login(f.page, 'supervisor');
  await open(f.page);
  assert.equal(f.events.writes.length, 0);
  const preview = () => f.page.onPreviewOriginal(tap({ photo: '5/0' }));
  await preview();
  const request = f.events.requests.at(-1);
  assert.equal(request.url, config.apiBaseUrl + endpoint + first + '/submission-photos/5/0');
  assert.equal(request.header.Authorization, 'Bearer ' + profiles.supervisor.token);
  assert.equal(request.responseType, 'arraybuffer');
  assert.deepEqual(f.files.get(f.page.data.previewPath), png);
  const oldPath = f.page.data.previewPath;
  f.control.failSyncDelete = true;
  await open(f.page, second);
  assert.ok(f.events.deletes.includes(oldPath));
  assert.equal(f.files.size, 0);
  f.control.failWrite = true;
  await preview();
  assert.equal(f.files.size, 0);
  assert.match(f.page.data.previewError, /读取失败/);
  f.control.failWrite = false;
  await preview();
  f.page.onPhotoPreviewError(tap({ path: f.page.data.previewPath }));
  assert.equal(f.files.size, 0);

  f.control.holdPreview = true;
  const late = preview();
  const response = f.events.requests.at(-1);
  f.page.onHide();
  ok(response, arrayBuffer(png), { 'Content-Type': 'image/png' });
  await late;
  assert.equal(f.files.size, 0);
  assert.equal(f.page.data.previewPath, '');
  await login(f.page, 'supervisor');
  await open(f.page);
  const unauthorized = preview();
  f.events.requests.at(-1).success({ statusCode: 403, data: {} });
  await unauthorized;
  assert.equal(f.page._token, '');
  assert.equal(f.page.data.submissionPhotos.length, 0);
  await login(f.page, 'duty');
  await open(f.page);
  assert.equal(f.page.data.submissionPhotos.length, 0, 'malformed metadata from duty response stays hidden');
});

test('图片送审冲突后读回当时的版本，保留手动重试', async t => {
  const f = fixture(t);
  f.control.details.set(first, detail(first, 'processing'));
  f.inputs.set('/synthetic.png', png);
  await login(f.page, 'handler');
  await open(f.page);
  await action(f.page, 'submit_result');
  f.page.onEditorChange(input('summary', '合成补充说明'));
  await picked(f, 'media', [['/synthetic.png', png.length]]);
  f.control.nextPost = options => {
    f.control.details.set(first, detail(first, 'processing', { version: 8 }));
    options.success({ statusCode: 409, data: { error: 'stale_version' } });
  };
  await f.page.onActionSubmit();
  assert.equal(f.page.data.detail.version, 8);
  assert.equal(f.page.data.editor, null);
  assert.deepEqual(f.page._pickedFiles, []);
  assert.match(f.page.data.notice, /系统未重发/);
  assert.equal(f.events.requests.filter(request => request.method === 'POST').length, 1);
});

function derivativePng() {
  function chunk(kind, bytes) {
    const value = Buffer.alloc(bytes.length + 12);
    value.writeUInt32BE(bytes.length, 0);
    value.write(kind, 4);
    bytes.copy(value, 8);
    value.writeUInt32BE(crc32(value.subarray(4, -4)), value.length - 4);
    return value;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 4, 5, 6]))), chunk('IEND', Buffer.alloc(0))]);
}

test('实际回环后端核对承办 multipart、授权读取与独立 PNG 发布', async t => {
  const f = fixture(t);
  const { createIntakeServer } = await import('../../server/src/server.js');
  const integration = 'i'.repeat(43);
  const server = createIntakeServer({
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 67),
    integrations: [{ source: 'synthetic-staff-photos-e2e', token: integration }],
    staff: Object.values(profiles)
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
      const body = options.data instanceof ArrayBuffer ? options.data : options.data && JSON.stringify(options.data);
      const response = await fetch(options.url, {
        method: options.method, body, headers: options.header, signal: AbortSignal.timeout(4000)
      });
      const data = response.status === 200 && options.responseType === 'arraybuffer'
        ? await response.arrayBuffer() : await response.json();
      options.success({ statusCode: response.status, data, header: Object.fromEntries(response.headers) });
    } catch {
      options.fail({ errMsg: 'local request failed' });
    }
  };
  const external = new FormData();
  external.append('payload', JSON.stringify({
    externalCaseId: 'synthetic-staff-photos-e2e', occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成地点', category: '合成事项', description: '合成申报'
  }));
  const intake = await fetch(origin + '/api/v1/integrations/intake/cases', {
    method: 'POST', body: external, headers: { Authorization: 'Bearer ' + integration },
    signal: AbortSignal.timeout(4000)
  });
  assert.equal(intake.status, 201);
  const receipt = await intake.json();
  const casePath = endpoint + receipt.caseNumber;
  const dueAt = new Date(Date.now() + 86400000).toISOString();
  const run = async (role, data) => {
    const response = await fetch(origin + casePath + '/actions', {
      method: 'POST', body: JSON.stringify(data),
      headers: { Authorization: 'Bearer ' + profiles[role].token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(4000)
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  await run('duty', { action: 'accept', expectedVersion: 1 });
  await run('duty', { action: 'assign', expectedVersion: 2, assignee: 'handler-a', dueAt });
  await run('handler', { action: 'start', expectedVersion: 3 });

  f.inputs.set('/original.png', png);
  f.inputs.set('/original.jpg', jpeg);
  await login(f.page, 'handler');
  await open(f.page, receipt.caseNumber);
  await action(f.page, 'submit_result');
  f.page.onEditorChange(input('summary', '两张合成图送审'));
  await picked(f, 'media', [['/original.png', png.length], ['/original.jpg', jpeg.length]]);
  await f.page.onActionSubmit();
  assert.equal(f.page.data.detail.status, 'awaiting_review');
  assert.deepEqual(f.page.data.submissionPhotos.map(photo => photo.mediaType), ['image/png', 'image/jpeg']);
  await f.page.onPreviewOriginal(tap({ photo: '5/1' }));
  assert.deepEqual(f.files.get(f.page.data.previewPath), jpeg);
  f.page.onLogout();
  assert.equal(f.files.size, 0);

  await login(f.page, 'supervisor');
  await open(f.page, receipt.caseNumber);
  await f.page.onOpenFeedbackPublisher();
  const derivative = derivativePng();
  f.inputs.set('/derivative.png', derivative);
  await picked(f, 'message', [['/derivative.png', derivative.length]]);
  f.page.onEditorChange(input('summary', '发布独立处理的合成图'));
  f.page.onEditorChange(input('derivativesReviewed', true));
  await f.page.onActionSubmit();
  assert.equal(f.page.data.detail.status, 'awaiting_evaluation');
  assert.equal(f.page.data.detail.version, 6);
  const verify = await fetch(origin + '/api/v1/owner/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      publicLookupCode: receipt.publicLookupCode, privateLookupToken: receipt.privateLookupToken
    }), signal: AbortSignal.timeout(4000)
  });
  assert.equal(verify.status, 200);
  const { ownerSessionToken } = await verify.json();
  const photo = await fetch(origin + '/api/v1/owner/cases/' + receipt.caseNumber + '/feedback-photos/6/0', {
    headers: { Authorization: 'Bearer ' + ownerSessionToken }, signal: AbortSignal.timeout(4000)
  });
  assert.equal(photo.status, 200);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), derivative);
});

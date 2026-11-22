const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const config = require('../config');
const { queues } = require('../pages/staff/workbench');
const { taskView } = require('../pages/staff/collaborations');

const first = 'CD-' + 'A'.repeat(32);
const another = 'CD-' + 'B'.repeat(32);
const taskA = 'CT-' + 'A'.repeat(32);
const taskB = 'CT-' + 'B'.repeat(32);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const profiles = {
  duty: { id: 'desk', role: 'duty', token: 'd'.repeat(43) },
  handler: { id: 'worker', role: 'handler', department: 'a', token: 'h'.repeat(43) },
  supervisor: { id: 'lead', role: 'supervisor', department: 'a', token: 's'.repeat(43) }
};
const metadata = { submitVersion: 2, position: 0, mediaType: 'image/png', size: png.length };
const task = (taskId, extra) => ({ taskId, status: 'awaiting_review', round: 1, version: 2,
  merchantId: 'shop-a', history: [], submissionPhotos: [metadata], ...extra });
const staffCase = caseNumber => ({ caseNumber, status: 'assigned', version: 4, round: 1,
  department: 'a', assignee: 'worker', category: '合成类别', history: [] });
const tap = dataset => ({ currentTarget: { dataset } });
const open = (page, caseNumber = first) => page.onOpenCase(tap({ case: caseNumber }));
const preview = (page, taskId, photo = '2/0') => page.onPreviewCollaborationPhoto(tap({ task: taskId, photo }));
const login = (page, role) => page.onLoginSubmit({ detail: { value: { token: profiles[role].token } } });
const pathFor = (caseNumber, taskId) => '/api/v1/staff/cases/' + caseNumber + '/collaborations/' + taskId + '/submission-photos/2/0';
const ok = (request, data, header = {}) => request.success({ statusCode: 200, data, header });
const pngArray = () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length);
const image = request => ok(request, pngArray(), { 'Content-Type': 'image/png' });

function fixture(t) {
  const modulePath = require.resolve('../pages/staff/index');
  const previousOrigin = config.apiBaseUrl;
  const files = new Map();
  const photos = [];
  const control = { tasks: [task(taskA), task(taskB)], syncDeleteFails: false, partialWrite: false };
  delete require.cache[modulePath];
  let page;
  global.Page = definition => { page = definition; };
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic' },
    getFileSystemManager: () => ({
      writeFileSync(path, buffer) {
        files.set(path, Buffer.from(buffer));
        if (control.partialWrite) throw new Error('synthetic partial write');
      },
      unlinkSync(path) {
        if (control.syncDeleteFails) throw new Error('synthetic sync delete failure');
        files.delete(path);
      },
      unlink({ filePath, success, complete }) {
        files.delete(filePath);
        success();
        complete();
      }
    }),
    setStorage() { assert.fail('unexpected cache write'); },
    setStorageSync() { assert.fail('unexpected cache write'); },
    request(request) {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/submission-photos/2/0')) photos.push(request);
      else if (pathname.endsWith('/collaborations')) ok(request, { items: control.tasks });
      else if (pathname.endsWith('/me')) {
        const { token, ...identity } = Object.values(profiles).find(user => request.header.Authorization === 'Bearer ' + user.token);
        ok(request, identity);
      } else if (pathname.endsWith('/workbench')) {
        ok(request, { counts: Object.fromEntries(queues.map(queue => [queue.id, 0])), dueSoonSeconds: 86400 });
      } else if (pathname.endsWith('/cases')) ok(request, { items: [] });
      else ok(request, staffCase(pathname.split('/').at(-1)));
    }
  };
  require(modulePath);
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad();
  t.after(() => {
    page.onUnload();
    assert.equal(files.size, 0);
    config.apiBaseUrl = previousOrigin;
    delete global.Page;
    delete global.wx;
    delete require.cache[modulePath];
  });
  return { page, photos, control, files };
}

test('协办图片元数据限于有权角色、有效轮次和有效送审版本', () => {
  const item = staffCase(first);
  const invalid = [task(taskA, { round: 2 }), task(taskA, { status: 'withdrawn' }),
    task(taskA, { submissionPhotos: [{ ...metadata, submitVersion: 1 }, { ...metadata, submitVersion: 3 }] })];
  for (const value of invalid) assert.deepEqual(taskView(value, profiles.supervisor, item).submissionPhotos, []);
  assert.deepEqual(taskView(task(taskA), profiles.duty, item).submissionPhotos, []);
  assert.deepEqual(taskView(task(taskA), profiles.handler, { ...item, assignee: 'another' }).submissionPhotos, []);
  assert.deepEqual(taskView(task(taskA), profiles.supervisor, { ...item, status: 'closed' }).submissionPhotos, []);
  assert.equal(taskView(task(taskA), profiles.handler, item).submissionPhotos[0].key, '2/0');
});

test('协办原图请求绑定任务和工单，切任务、刷新、切单及隐藏丢弃旧响应', async t => {
  const { page, photos, control, files } = fixture(t);
  await login(page, 'duty');
  await open(page);
  await preview(page, taskA);
  assert.equal(photos.length, 0);
  page.onLogout();
  await login(page, 'handler');
  await open(page);
  await preview(page, taskA, '9/0');
  assert.equal(photos.length, 0);
  const old = preview(page, taskA);
  const fresh = preview(page, taskB);
  assert.equal(photos[0].url, config.apiBaseUrl + pathFor(first, taskA));
  assert.equal(photos[1].url, config.apiBaseUrl + pathFor(first, taskB));
  assert.equal(photos[1].header.Authorization, 'Bearer ' + profiles.handler.token);
  assert.equal(photos[1].responseType, 'arraybuffer');
  image(photos[1]);
  await fresh;
  const visible = page.data.previewPath;
  image(photos[0]);
  await old;
  assert.equal(page.data.previewTaskId, taskB);
  assert.equal(page.data.previewPath, visible);
  assert.deepEqual(files.get(visible), png);
  await page.loadCollaborations(first);
  assert.equal(files.size, 0);
  for (const change of [
    () => page.loadCollaborations(first), () => open(page, another), () => page.onHide()
  ]) {
    const late = preview(page, taskA);
    const firstRequest = photos.at(-1);
    await change();
    image(firstRequest);
    await late;
    assert.equal(page.data.previewPath, '');
    assert.equal(files.size, 0);
  }
  assert.equal(page._token, '');
  assert.equal(control.tasks.length, 2);
});

test('服务器撤回后拒绝读取，部分写入和渲染错误清理准确文件', async t => {
  const { page, photos, control, files } = fixture(t);
  await login(page, 'supervisor');
  await open(page);
  control.partialWrite = true;
  control.syncDeleteFails = true;
  const broken = preview(page, taskA);
  image(photos.at(-1));
  await broken;
  assert.equal(files.size, 0);
  assert.match(page.data.previewError, /读取失败/);
  control.partialWrite = false;
  const visible = preview(page, taskA);
  image(photos.at(-1));
  await visible;
  page.onPhotoPreviewError(tap({ path: page.data.previewPath }));
  assert.equal(files.size, 0);
  assert.equal(page.data.previewTaskId, taskA);
  const revoked = preview(page, taskA);
  control.tasks = [task(taskA, { status: 'withdrawn', version: 3 })];
  photos.at(-1).success({ statusCode: 404, data: { error: 'collaboration_not_found' } });
  await revoked;
  assert.equal(page.data.previewPath, '');
  assert.deepEqual(page.data.collaborations[0].submissionPhotos, []);
  const count = photos.length;
  await preview(page, taskA);
  assert.equal(photos.length, count);
});

test('实际回环后端读取协办原图并在撤回后拒绝旧版本', async t => {
  const { page, files } = fixture(t);
  const { createIntakeServer } = await import('../../server/src/server.js');
  const platform = 'i'.repeat(43);
  const merchant = 'm'.repeat(43);
  const server = createIntakeServer({
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 82),
    integrations: [{ source: 'synthetic-task-photo', token: platform }],
    staff: Object.values(profiles),
    merchants: [{ id: 'member', merchantId: 'shop-a', token: merchant, permissions: ['collaborate'] }]
  });
  t.after(async () => {
    const stopped = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await stopped;
    assert.equal(server.listening, false);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  config.apiBaseUrl = origin;
  global.wx.request = async request => {
    assert.equal(new URL(request.url).origin, origin);
    try {
      const result = await fetch(request.url, { headers: request.header, signal: AbortSignal.timeout(4000) });
      const data = request.responseType === 'arraybuffer' && result.ok ? await result.arrayBuffer() : await result.json();
      request.success({ statusCode: result.status, data, header: Object.fromEntries(result.headers) });
    } catch {
      request.fail();
    }
  };
  const post = async (path, token, payload, status) => {
    const form = payload instanceof FormData;
    const result = await fetch(origin + path, {
      method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { Authorization: 'Bearer ' + token, ...(form ? {} : { 'Content-Type': 'application/json' }) },
      body: form ? payload : JSON.stringify(payload)
    });
    assert.equal(result.status, status);
    return result.json();
  };
  const intake = new FormData();
  intake.append('payload', JSON.stringify({ externalCaseId: 'synthetic-media-task', occurredAt: new Date().toISOString(),
    location: '合成地点', category: '合成类别', description: '合成内容' }));
  const { caseNumber } = await post('/api/v1/integrations/intake/cases', platform, intake, 201);
  const path = '/api/v1/staff/cases/' + caseNumber;
  const dueAt = new Date(Date.now() + 86400000).toISOString();
  await post(path + '/actions', profiles.duty.token, { action: 'accept', expectedVersion: 1 }, 200);
  await post(path + '/actions', profiles.duty.token, { action: 'assign', expectedVersion: 2, assignee: 'worker', dueAt }, 200);
  const assigned = await post(path + '/collaborations', profiles.supervisor.token,
    { expectedVersion: 3, merchantId: 'shop-a', instructions: '合成说明', dueAt }, 201);
  const submitted = new FormData();
  submitted.append('payload', JSON.stringify({ expectedVersion: 1, summary: '合成送审' }));
  submitted.append('photos', new Blob([png], { type: 'image/png' }), 'synthetic.png');
  await post('/api/v1/merchant/collaborations/' + assigned.taskId + '/submissions', merchant, submitted, 200);
  await login(page, 'handler');
  await open(page, caseNumber);
  await preview(page, assigned.taskId);
  assert.deepEqual(files.get(page.data.previewPath), png);
  await post(path + '/collaborations/' + assigned.taskId + '/actions', profiles.supervisor.token,
    { action: 'withdraw', expectedVersion: 2, reason: '合成撤回' }, 200);
  await preview(page, assigned.taskId);
  assert.equal(files.size, 0);
  assert.equal(page.data.collaborations[0].status, 'withdrawn');
  assert.deepEqual(page.data.collaborations[0].submissionPhotos, []);
});

// 商户协办送审的可选照片与授权原图查看：本地模拟检查与真实回环核对。
// 只用合成图片与本机回环服务，不访问真实图片、真实凭据或外部网络。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const miniprogramRoot = path.resolve(__dirname, '..');
const merchantModule = require(path.join(miniprogramRoot, 'pages/merchant/merchant.js'));

const TASK_ID = 'CT-0123456789ABCDEF0123456789ABCDEF';
const OTHER_TASK_ID = 'CT-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const TOKEN = 'merchant_collab_token_0123456789abcdefghijklmnopqrstuvwxyz';

// 合成图片：1×1 PNG 与最小 JPEG，字节来自本地固定串，不含真实照片内容。
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64');
const jpegBytes = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z',
  'base64');

const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
const tick = () => new Promise(resolve => setImmediate(resolve));
const tap = dataset => ({ currentTarget: { dataset } });

function taskDetail(extra = {}) {
  return {
    taskId: TASK_ID,
    status: 'awaiting_submission',
    version: 1,
    instructions: '核查指定区域',
    location: '合成协办地点',
    dueAt: '2026-11-20T10:00:00.000Z',
    latestSubmission: '',
    returnReason: '',
    ...extra
  };
}

// 商户页面模拟环境：可控的选图、读文件、写文件与请求。
function createEnvironment(options = {}) {
  const calls = [];
  const picks = [];
  const reads = [];
  const files = new Map();
  const written = new Map();
  const deleted = [];
  let page = null;
  const modulePath = path.join(miniprogramRoot, 'pages/merchant/index.js');
  delete require.cache[require.resolve(modulePath)];
  global.Page = definition => { page = definition; };
  const fs = {
    readFile(request) {
      reads.push(request);
      if (options.readFile) return options.readFile(request);
      const data = files.get(request.filePath);
      if (!data) {
        request.fail({ errMsg: 'readFile:fail' });
        return;
      }
      request.success({ data: arrayBuffer(data) });
    },
    writeFileSync(target, data) {
      written.set(target, Buffer.from(data));
    },
    unlinkSync(target) {
      deleted.push(target);
      written.delete(target);
    }
  };
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic-user-data' },
    getFileSystemManager: () => fs,
    chooseMedia: request => picks.push(request),
    request: request => {
      calls.push(request);
      const url = request.url;
      if (url.endsWith('/api/v1/merchant/me')) {
        request.success({
          statusCode: 200,
          data: { merchantId: 'shop-a', permissions: ['readCases', 'submitCases', 'collaborate'] }
        });
        return;
      }
      if (request.method === 'POST' && url.includes('/submissions')) {
        (options.submit || (value => value.success({
          statusCode: 200,
          data: taskDetail({ status: 'awaiting_review', version: 2 })
        })))(request);
        return;
      }
      if (request.method === 'GET' && url.includes('/submission-photos/')) {
        (options.photo || (value => value.success({
          statusCode: 200,
          data: arrayBuffer(pngBytes),
          header: { 'content-type': 'image/png' }
        })))(request);
        return;
      }
      if (url.includes('/api/v1/merchant/collaborations/')) {
        (options.collaboration || (value => value.success({ statusCode: 200, data: taskDetail() })))(request);
        return;
      }
      request.success({ statusCode: 200, data: { items: [], nextBefore: null } });
    },
    navigateBack: () => {}
  };
  require(modulePath);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => { page.data = { ...page.data, ...patch }; };
  return { page, calls, picks, reads, files, written, deleted };
}

function restoreGlobals() {
  delete global.Page;
  delete global.wx;
}

async function login(page) {
  page.onLoad({});
  page.onLoginSubmit({ detail: { value: { token: TOKEN } } });
  await tick();
  await tick();
}

// 选图：先记录 picker 调用，再回填选中的临时文件。
async function pick(page, picks, files) {
  const pending = page.onChooseTaskPhotos();
  const picker = picks.at(-1);
  assert.ok(picker, '调用了 wx.chooseMedia');
  assert.equal(picker.count, 3, '最多选 3 张');
  picker.success({ tempFiles: [...files].map(([filePath, size]) => ({ tempFilePath: filePath, size })) });
  await pending;
}

// 按请求头声明的边界真实解析 multipart 请求体。
async function readMultipart(call) {
  const contentType = call.header['content-type'] || call.header['Content-Type'];
  assert.match(contentType, /^multipart\/form-data; boundary=/, '请求头声明 multipart 边界');
  assert.ok(call.data instanceof ArrayBuffer, '请求体是二进制');
  const form = await new Response(call.data, { headers: { 'Content-Type': contentType } }).formData();
  return { form, contentType };
}

async function readPayload(call) {
  const { form } = await readMultipart(call);
  const parts = form.getAll('payload');
  assert.equal(parts.length, 1, '请求体含且仅含一个 payload part');
  assert.equal(typeof parts[0], 'string', 'payload 是文本 part');
  return JSON.parse(parts[0]);
}

async function readPhotos(call) {
  const { form } = await readMultipart(call);
  const files = form.getAll('photos');
  return Promise.all(files.map(async file => ({
    name: file.name,
    type: file.type,
    size: file.size,
    bytes: Buffer.from(await file.arrayBuffer())
  })));
}

const submissions = calls => calls.filter(entry => entry.method === 'POST' && entry.url.includes('/submissions'));

test('协办送审附照片：multipart 带任务版本、说明与照片字节', async () => {
  const env = createEnvironment();
  const { page, calls, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    files.set('/synthetic.jpg', jpegBytes);
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    assert.equal(page.data.taskDetail.taskId, TASK_ID);
    await pick(page, picks, [['/synthetic.png', pngBytes.length], ['/synthetic.jpg', jpegBytes.length]]);
    assert.equal(page.data.taskPhotoCount, 2, '显示已选张数');

    page.setData({ taskSummary: '合成现场说明' });
    await page.onSubmitTask();
    await tick();

    assert.equal(submissions(calls).length, 1, '照片与说明一次提交，不另发请求');
    const call = submissions(calls)[0];
    assert.match(call.header['content-type'], /^multipart\/form-data; boundary=/);
    assert.equal(call.header.Authorization, 'Bearer ' + TOKEN, '凭据只放授权头');
    assert.ok(!call.url.includes(TOKEN), '网址不含令牌');

    const payload = await readPayload(call);
    assert.equal(payload.expectedVersion, 1, '带任务版本');
    assert.equal(payload.summary, '合成现场说明');
    assert.ok(!('photos' in payload), '照片不进 payload 文本 part');

    const photos = await readPhotos(call);
    assert.equal(photos.length, 2);
    assert.deepEqual(photos.map(photo => photo.type), ['image/png', 'image/jpeg']);
    assert.deepEqual(photos[0].bytes, pngBytes, 'PNG 字节与原文件一致');
    assert.deepEqual(photos[1].bytes, jpegBytes, 'JPEG 字节与原文件一致');
    assert.equal(page.data.taskPhotoCount, 0, '送审成功后清空已选照片');
    assert.match(page.data.taskSubmitMessage, /已送审/);
  } finally {
    restoreGlobals();
  }
});

test('不选照片时仍用原来的 JSON 送审，字段保持兼容', async () => {
  const env = createEnvironment();
  const { page, calls } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    page.setData({ taskSummary: '合成现场说明' });
    await page.onSubmitTask();
    await tick();

    assert.equal(submissions(calls).length, 1);
    const call = submissions(calls)[0];
    assert.equal(call.header['content-type'], 'application/json');
    assert.equal(call.data.expectedVersion, 1);
    assert.equal(call.data.summary, '合成现场说明');
    assert.ok(!('photos' in call.data), '不带照片字段');
  } finally {
    restoreGlobals();
  }
});

test('本地读取失败时不发请求，用户可修正后重提', async () => {
  const env = createEnvironment();
  const { page, calls, picks, files } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await pick(page, picks, [['/missing.png', pngBytes.length]]);
    page.setData({ taskSummary: '合成现场说明' });
    await page.onSubmitTask();
    await tick();
    assert.equal(submissions(calls).length, 0, '请求未发出');
    assert.match(page.data.taskSubmitMessage, /无法读取/);

    files.set('/missing.png', pngBytes);
    await page.onSubmitTask();
    await tick();
    assert.equal(submissions(calls).length, 1, '修正后发出请求');
  } finally {
    restoreGlobals();
  }
});

test('切换任务不把上一个任务选的照片带过去', async () => {
  const env = createEnvironment();
  const { page, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await pick(page, picks, [['/synthetic.png', pngBytes.length]]);
    assert.equal(page.data.taskPhotoCount, 1);

    page.setData({ taskDetail: taskDetail() });
    await page.onOpenTask(tap({ task: OTHER_TASK_ID }));
    assert.equal(page.data.taskPhotoCount, 0, '切任务后已选照片清空');
    assert.deepEqual(page._taskPickedFiles, []);
  } finally {
    restoreGlobals();
  }
});

test('送审结果未知时不自动补发，先刷新任务核对', async () => {
  let attempts = 0;
  const env = createEnvironment({
    submit: request => {
      attempts += 1;
      request.fail({ errMsg: 'request:fail timeout' });
    }
  });
  const { page, calls } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    page.setData({ taskSummary: '合成现场说明' });
    await page.onSubmitTask();
    await tick();
    assert.equal(attempts, 1, '只发出一次，没有自动补发');
    assert.equal(submissions(calls).length, 1);
    assert.match(page.data.taskSubmitMessage, /结果未知/);
    assert.match(page.data.taskSubmitMessage, /不会自动补发/);
    const refreshed = calls.filter(entry => entry.method === 'GET' &&
      entry.url.includes('/api/v1/merchant/collaborations/' + TASK_ID));
    assert.ok(refreshed.length >= 1, '先刷新任务核对');
  } finally {
    restoreGlobals();
  }
});

test('协办送审在照片读取完成前锁住操作，不能重复读取或提交', async () => {
  let pendingRead;
  const { page, picks, reads, calls } = createEnvironment({
    readFile: request => { pendingRead = request; },
  });
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await pick(page, picks, [['/synthetic.png', pngBytes.length]]);
    page.setData({ taskSummary: '现场已核对' });
    const submit = page.onSubmitTask();
    assert.equal(page.data.taskSubmitting, true);
    await page.onSubmitTask();
    await page.onOpenTask(tap({ task: OTHER_TASK_ID }));
    assert.equal(page.data.activeTask, TASK_ID);
    assert.equal(reads.length, 1);
    assert.equal(submissions(calls).length, 0);
    pendingRead.success({ data: arrayBuffer(pngBytes) });
    await submit;
    assert.equal(submissions(calls).length, 1);
    assert.equal(page.data.taskSubmitting, false);
  } finally {
    restoreGlobals();
  }
});

test('协办断网后直到详情读回都锁住提交，退出后读回不会覆盖页面', async () => {
  let readBack;
  const { page, calls } = createEnvironment({
    submit: request => request.fail({ errMsg: 'request:fail timeout' }),
    collaboration: request => {
      if (!readBack && calls.some(call => call.method === 'POST' && call.url.includes('/submissions'))) {
        readBack = request;
      } else {
        request.success({ statusCode: 200, data: taskDetail() });
      }
    },
  });
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    page.setData({ taskSummary: '现场已核对' });
    const submit = page.onSubmitTask();
    await tick();
    assert.ok(readBack);
    assert.equal(page.data.taskSubmitting, true);
    await page.onRetryTask();
    await page.onSubmitTask();
    assert.equal(submissions(calls).length, 1);
    page.onHide();
    readBack.success({ statusCode: 200, data: taskDetail({ version: 2 }) });
    await submit;
    assert.equal(page.data.view, 'login');
    assert.equal(page.data.taskSubmitMessage, '');
  } finally {
    restoreGlobals();
  }
});

test('协办回执无法确认时读回任务，避免把不完整回执显示为送审成功', async () => {
  const { page, calls } = createEnvironment({
    submit: request => request.success({ statusCode: 200, data: taskDetail() }),
  });
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    page.setData({ taskSummary: '现场已核对' });
    await page.onSubmitTask();
    assert.equal(submissions(calls).length, 1);
    assert.equal(calls.filter(call => call.method === 'GET' &&
      call.url.endsWith('/collaborations/' + TASK_ID)).length, 2);
    assert.match(page.data.taskSubmitMessage, /无法确认送审回执/);
  } finally {
    restoreGlobals();
  }
});

test('查看协办原图：按固定回环地址与授权头读取，校验类型、大小与签名', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    })
  });
  const { page, calls, written } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    assert.equal(page.data.taskDetail.submissionPhotos.length, 1, '任务详情带出原图元数据');

    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();

    const call = calls.find(entry => entry.method === 'GET' && entry.url.includes('/submission-photos/'));
    assert.ok(call, '发出原图读取请求');
    assert.match(call.url, new RegExp('/api/v1/merchant/collaborations/' + TASK_ID +
      '/submission-photos/2/0$'), '按任务与送审版本定位，不借用原单路线');
    assert.equal(call.header.Authorization, 'Bearer ' + TOKEN, '凭据只放授权头');
    assert.ok(!call.url.includes(TOKEN), '网址不含令牌');

    assert.equal(page.data.taskPreviewBusy, false);
    assert.ok(page.data.taskPreviewPath, '显示预览路径');
    const preview = [...written.entries()].find(([, value]) => value.equals(pngBytes));
    assert.ok(preview, '写入的预览文件内容与原图一致');
    assert.equal(page.data.taskPreviewPath, preview[0]);
  } finally {
    restoreGlobals();
  }
});

test('只读取被选中的那一项原图', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [
          { submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length },
          { submitVersion: 2, position: 1, mediaType: 'image/jpeg', size: jpegBytes.length }
        ]
      })
    }),
    photo: request => {
      const position = Number(request.url.split('/').pop());
      request.success({
        statusCode: 200,
        data: arrayBuffer(position === 0 ? pngBytes : jpegBytes),
        header: { 'content-type': position === 0 ? 'image/png' : 'image/jpeg' }
      });
    }
  });
  const { page, calls, written } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/1' }));
    await tick();

    const call = calls.find(entry => entry.method === 'GET' && entry.url.includes('/submission-photos/'));
    assert.match(call.url, /\/submission-photos\/2\/1$/, '只请求被点中的那一项');
    assert.equal(written.size, 1, '只写一个预览文件');
    const preview = [...written.entries()][0];
    assert.ok(preview[1].equals(jpegBytes), '预览的是被点中的那张');
    assert.equal(page.data.taskPreviewKey, '2/1');
  } finally {
    restoreGlobals();
  }
});

test('不在任务原图清单里的项不读取', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    })
  });
  const { page, calls, written } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '9/9' }));
    await tick();
    assert.equal(calls.filter(entry => entry.method === 'GET' && entry.url.includes('/submission-photos/')).length, 0,
      '没有发出原图请求');
    assert.equal(page.data.taskPreviewPath, '');
    assert.equal(written.size, 0);
  } finally {
    restoreGlobals();
  }
});

test('原图类型或大小与记录不符时拒绝显示', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    }),
    photo: request => request.success({
      statusCode: 200,
      data: arrayBuffer(jpegBytes),
      header: { 'content-type': 'image/jpeg' }
    })
  });
  const { page, written } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();
    assert.equal(page.data.taskPreviewPath, '', '类型不符不显示');
    assert.match(page.data.taskPreviewError, /类型/);
    assert.equal(written.size, 0, '不写临时文件');
  } finally {
    restoreGlobals();
  }
});

test('关闭原图时清掉预览文件，不留下旧图', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    })
  });
  const { page, written, deleted } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();
    assert.ok(page.data.taskPreviewPath);
    assert.equal(written.size, 1);

    page.onCloseTaskPreview();
    assert.equal(page.data.taskPreviewPath, '', '关闭后不显示旧图');
    assert.equal(written.size, 0, '临时文件已删除');
    assert.equal(deleted.length, 1, '逐个清理');
  } finally {
    restoreGlobals();
  }
});

test('页面隐藏时清掉预览文件与已选照片', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    })
  });
  const { page, written, picks, files } = env;
  try {
    files.set('/synthetic.png', pngBytes);
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await pick(page, picks, [['/synthetic.png', pngBytes.length]]);
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();
    assert.equal(written.size, 1);

    page.onHide();
    assert.equal(page.data.taskPreviewPath, '', '隐藏后不显示旧图');
    assert.equal(written.size, 0, '临时文件已删除');
    assert.deepEqual(page._taskPickedFiles, [], '已选照片也清空');
    assert.equal(page._token, '', '令牌清空');
  } finally {
    restoreGlobals();
  }
});

test('任务撤回后不显示旧图，详情、预览与临时文件一并清空', async () => {
  // 第一次读到任务，第二次刷新时任务已被撤回（服务端返回不存在）。
  let reads = 0;
  const env = createEnvironment({
    collaboration: request => {
      reads += 1;
      if (reads === 1) {
        request.success({
          statusCode: 200,
          data: taskDetail({
            status: 'awaiting_review',
            version: 2,
            submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
          })
        });
        return;
      }
      request.success({ statusCode: 404, data: { error: 'collaboration_not_found' } });
    }
  });
  const { page, written, deleted } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();
    assert.equal(written.size, 1, '预览文件已写入');

    // 刷新任务时已被撤回。
    await page.onRetryTask();
    await tick();
    assert.equal(page.data.view, 'workbench', '撤回后撤下详情');
    assert.equal(page.data.taskDetail, null, '撤回后清空任务详情');
    assert.equal(page.data.taskPreviewPath, '', '撤回后不显示旧图');
    assert.equal(page.data.taskPhotoCount, 0, '撤回后清空已选照片');
    assert.deepEqual(page._taskPickedFiles, [], '撤回后清空已选照片列表');
    assert.equal(written.size, 0, '撤回后临时文件已删除');
    assert.ok(deleted.length >= 1, '临时文件逐个清理');
  } finally {
    restoreGlobals();
  }
});

test('原图读取失败时不显示旧图', async () => {
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    }),
    photo: request => request.success({ statusCode: 404, data: { error: 'collaboration_photo_not_found' } })
  });
  const { page, written } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    await page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();
    assert.equal(page.data.taskPreviewPath, '', '读不到不显示');
    assert.match(page.data.taskPreviewError, /不可读/);
    assert.equal(written.size, 0);
  } finally {
    restoreGlobals();
  }
});

test('迟到的原图回调不显示旧图，也不留下临时文件', async () => {
  let pending = null;
  const env = createEnvironment({
    collaboration: request => request.success({
      statusCode: 200,
      data: taskDetail({
        status: 'awaiting_review',
        version: 2,
        submissionPhotos: [{ submitVersion: 2, position: 0, mediaType: 'image/png', size: pngBytes.length }]
      })
    }),
    photo: request => { pending = request; }
  });
  const { page, written } = env;
  try {
    await login(page);
    await page.onOpenTask(tap({ task: TASK_ID }));
    const previewing = page.onPreviewTaskPhoto(tap({ task: TASK_ID, photo: '2/0' }));
    await tick();
    assert.ok(pending, '原图请求已发出');

    // 用户在读取期间切走任务。
    await page.onOpenTask(tap({ task: OTHER_TASK_ID }));
    assert.equal(page.data.taskPreviewPath, '', '切走后不显示旧图');

    // 迟到的回调到达：不应显示，也不应留下文件。
    pending.success({
      statusCode: 200,
      data: arrayBuffer(pngBytes),
      header: { 'content-type': 'image/png' }
    });
    await previewing;
    await tick();
    assert.equal(page.data.taskPreviewPath, '', '迟到回调不显示旧图');
    assert.equal(written.size, 0, '不留临时文件');
  } finally {
    restoreGlobals();
  }
});

test('回环真实服务：协办送审照片落库，原图按授权可读，其他商户不可读', async () => {
  const serverRoot = path.resolve(miniprogramRoot, '../server');
  const { createIntakeServer } = await import(
    pathToFileURL(path.join(serverRoot, 'src/server.js')).href
  );
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { randomBytes } = await import('node:crypto');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'changdi-merchant-collab-photos-'));
  const dbPath = path.join(directory, 'intake.sqlite');
  const token = () => randomBytes(32).toString('base64url');
  const merchantToken = token();
  const otherToken = token();
  const dutyToken = token();
  const integrationToken = token();
  // 同一个临时库只用一把合成回执密钥，并且只开一个服务实例：
  // 服务端会把回执密钥写入库并校验，换钥匙或换实例打开同一个库会被拒绝。
  const receiptKey = randomBytes(32);
  const server = createIntakeServer({
    dbPath,
    receiptKey,
    integrations: [{ source: 'merchant-collab-photos', token: integrationToken }],
    staff: [
      { id: 'desk', role: 'duty', token: dutyToken },
      { id: 'handler-a', role: 'handler', department: 'street', token: token() }
    ],
    merchants: [
      { id: 'shop-a-member', merchantId: 'shop-a', token: merchantToken, permissions: ['readCases', 'submitCases', 'collaborate'] },
      { id: 'shop-b-member', merchantId: 'shop-b', token: otherToken, permissions: ['readCases', 'submitCases', 'collaborate'] }
    ]
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = async (route, options = {}) => {
    const response = await fetch(origin + route, {
      method: options.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + (options.auth || dutyToken),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    // 先由外部单建一张工单并派单，才能产生协办任务。
    const intakeForm = new FormData();
    intakeForm.append('payload', JSON.stringify({
      externalCaseId: 'merchant-collab-photos-e2e',
      occurredAt: '2026-11-19T09:00:00+08:00',
      location: '合成地点',
      category: '合成事项',
      description: '合成申报'
    }));
    const intake = await fetch(origin + '/api/v1/integrations/intake/cases', {
      method: 'POST', body: intakeForm,
      headers: { Authorization: 'Bearer ' + integrationToken },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(intake.status, 201);
    const receipt = await intake.json();

    assert.equal((await call('/api/v1/staff/cases/' + receipt.caseNumber + '/actions', {
      method: 'POST', body: { action: 'accept', expectedVersion: 1 }
    })).status, 200);
    assert.equal((await call('/api/v1/staff/cases/' + receipt.caseNumber + '/actions', {
      method: 'POST',
      body: { action: 'assign', expectedVersion: 2, assignee: 'handler-a', dueAt: '2027-01-20T10:00:00+08:00' }
    })).status, 200);
    const assigned = await call('/api/v1/staff/cases/' + receipt.caseNumber + '/collaborations', {
      method: 'POST',
      body: {
        expectedVersion: 3, merchantId: 'shop-a', instructions: '核查指定区域',
        location: '合成协办地点', dueAt: '2027-01-20T10:00:00+08:00'
      }
    });
    assert.equal(assigned.status, 201);
    const taskId = assigned.body.taskId;
    assert.match(taskId, /^CT-[0-9A-F]{32}$/);

    // 用小程序自己的模块组装带照片的送审体，发给本机服务。
    const submission = await merchantModule.submitCollaboration({
      request: options => {
        fetch(options.url, {
          method: options.method, body: options.data, headers: options.header,
          signal: AbortSignal.timeout(5000)
        }).then(async response => {
          options.success({ statusCode: response.status, data: await response.json() });
        }).catch(() => options.fail({ errMsg: 'request:fail' }));
      },
      baseUrl: origin,
      token: merchantToken,
      taskId,
      expectedVersion: 1,
      summary: '带照片的合成协办说明',
      photos: [
        { mediaType: 'image/png', bytes: new Uint8Array(pngBytes) },
        { mediaType: 'image/jpeg', bytes: new Uint8Array(jpegBytes) }
      ],
      timeout: 8000
    });
    assert.equal(submission.kind, 'success', JSON.stringify(submission));
    assert.equal(submission.detail.status, 'awaiting_review');
    assert.equal(submission.detail.version, 2, '送审后任务版本推进');
    assert.equal(submission.detail.submissionPhotos.length, 2, '送审后带回原图元数据');
    assert.deepEqual(submission.detail.submissionPhotos.map(photo => photo.submitVersion), [2, 2]);
    assert.deepEqual(submission.detail.submissionPhotos.map(photo => photo.position), [0, 1]);
    assert.deepEqual(submission.detail.submissionPhotos.map(photo => photo.mediaType), ['image/png', 'image/jpeg']);

    // 落库核对：原图字节真的写进了协办原图表。
    const db = new DatabaseSync(dbPath);
    const stored = db.prepare(
      'SELECT media_type AS mediaType, size, bytes FROM collaboration_submission_photos ORDER BY position'
    ).all();
    db.close();
    assert.equal(stored.length, 2, '两张原图都落库');
    assert.deepEqual(stored.map(row => row.mediaType), ['image/png', 'image/jpeg']);
    assert.deepEqual(Buffer.from(stored[0].bytes), pngBytes, '落库的 PNG 字节与发送的一致');
    assert.deepEqual(Buffer.from(stored[1].bytes), jpegBytes, '落库的 JPEG 字节与发送的一致');

    // 获派商户按任务与送审版本读取原图。
    const photoRoute = '/api/v1/merchant/collaborations/' + taskId + '/submission-photos/2/0';
    const photo = await fetch(origin + photoRoute, {
      headers: { Authorization: 'Bearer ' + merchantToken }, signal: AbortSignal.timeout(5000)
    });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.equal(photo.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), pngBytes, '读回的 PNG 与落库一致');

    // 其他商户读不到该任务的原图。
    const foreign = await fetch(origin + photoRoute, {
      headers: { Authorization: 'Bearer ' + otherToken }, signal: AbortSignal.timeout(5000)
    });
    assert.equal(foreign.status, 404, '其他商户读不到本任务的原图');

    // 无凭据读不到。
    const anonymous = await fetch(origin + photoRoute, { signal: AbortSignal.timeout(5000) });
    assert.equal(anonymous.status, 401, '无凭据读原图被拒');
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    // 临时库与合成密钥一并清掉，不留残件。
    await rm(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false, '临时库目录已清理');
  }
});

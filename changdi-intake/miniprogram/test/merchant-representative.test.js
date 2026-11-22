const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { crc32, deflateSync, inflateSync } = require('node:zlib');
const { previousMonth } = require('../pages/merchant/claimant');
const { createReceiptArtwork } = require('../pages/merchant/receipt-artwork');

const number = 'CD-' + 'C'.repeat(32);
const code = 'q'.repeat(24);
const privateToken = 'synthetic-private-token-do-not-propagate';
const base = '/api/v1/merchant';
const token = 'x'.repeat(43);
const input = (value, dataset = {}) => ({ detail: { value }, currentTarget: { dataset } });
const tap = dataset => ({ currentTarget: { dataset } });
const ok = (request, data, statusCode = 200) => request.success({ statusCode, data });

function fixture(t, permissions) {
  let page;
  const requests = [];
  const navigation = [];
  const files = new Map();
  const visitorFile = '/synthetic-user-data/receipt-code-' + code + '.png';
  files.set(visitorFile, Buffer.alloc(1));
  global.Page = definition => { page = definition; };
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic-user-data' },
    getFileSystemManager() {
      return {
        readdirSync: () => [...files.keys()].map(path => path.split('/').at(-1)),
        writeFileSync: (path, bytes) => { files.set(path, Buffer.from(bytes)); },
        unlinkSync: path => { if (!files.delete(path)) throw new Error('ENOENT'); }
      };
    },
    request(request) {
      if (new URL(request.url).pathname === base + '/me') return ok(request, { merchantId: 'viewer', permissions });
      requests.push(request);
    },
    navigateTo(options) { navigation.push(options); },
    setStorage() { assert.fail('Unexpected storage write'); },
    setStorageSync() { assert.fail('Unexpected storage write'); }
  };
  const script = require.resolve('../pages/merchant/index');
  delete require.cache[script];
  require(script);
  page.setData = change => {
    assert.doesNotMatch(JSON.stringify(change), /"base64"|data:image\/|synthetic-private-token-do-not-propagate/);
    Object.assign(page.data, change);
  };
  page.onLoad();
  t.after(() => {
    page.onUnload();
    delete global.Page;
    delete global.wx;
    delete require.cache[script];
  });
  return {
    page, requests, navigation, files, visitorFile,
    login: () => page.onLoginSubmit(input({ token })),
    take(path, method = 'GET') {
      const index = requests.findIndex(request => request.method === method && new URL(request.url).pathname === base + path);
      assert.notEqual(index, -1, 'Missing request ' + path);
      return requests.splice(index, 1)[0];
    }
  };
}

const receipt = { caseNumber: number, publicLookupCode: code, privateLookupToken: privateToken, status: 'submitted',
  submittedAt: '2026-11-19T02:00:00Z', wechatCode: null };
const detail = { caseNumber: number, version: 6, round: 1, evaluationEndsAt: '2026-11-22T02:00:00Z',
  availableActions: ['evaluate', 'request_reopen'],
  rounds: [{ round: 1, feedback: { summary: '合成反馈' }, evaluation: null }] };

test('商户提交字段、公开码降级、本人办理及退出后的数据隔离', async t => {
  const { page, take, navigation, requests, login } = fixture(t, ['submitCases']);
  const template = readFileSync(require.resolve('../pages/merchant/index.wxml'), 'utf8');
  assert.match(template, /建议处理部门/);
  assert.match(template, /bindtap="onFindReceipt"/);
  assert.match(template, /bindtap="onOpenClaimant"/);
  await login();
  await page.onOpenRepresentativeReport();
  assert.equal(requests.length, 0);
  page.onOpenForm();
  page.onFormLocationInput(input('合成地点'));
  page.onFormCategoryInput(input('合成类别'));
  page.onFormDescriptionInput(input('合成说明'));
  page.onFormSuggestedDepartmentInput(input('合成建议部门'));
  page.onFormContactInput(input('合成联系信息'));
  const submitting = page.onSubmitNewCase();
  const post = take('/cases', 'POST');
  assert.match(new TextDecoder().decode(post.data), /"suggestedDepartment":"合成建议部门"/);
  ok(post, receipt, 201);
  await submitting;
  assert.equal(page.data.submitReceipt.publicLookupCode, code);
  assert.equal(page.data.submitReceipt.qrSource, '');
  assert.doesNotMatch(JSON.stringify(page.data), new RegExp(privateToken));
  page.onOpenPublicReceipt(tap({ code }));
  assert.deepEqual(navigation, [{ url: '/pages/public/index?code=' + code }]);
  const opening = page.onOpenClaimant(tap({ case: number }));
  const own = take('/cases/' + number + '/claimant');
  assert.equal(own.header.Authorization, 'Bearer ' + token);
  assert.equal(own.data, undefined);
  ok(own, detail);
  await opening;
  assert.equal(page.data.claimant.rounds[0].summary, '合成反馈');
  page.onChooseClaimAction(tap({ action: 'evaluate' }));
  page.onSaveClaimAction();
  assert.match(page.data.extraError, /三个维度/);
  for (const [field, score] of [['speed', '4'], ['effectiveness', '3'], ['attitude', '2']]) {
    page.onClaimInput(input(score, { field }));
  }
  const saving = page.onSaveClaimAction();
  const request = take('/cases/' + number + '/claimant/actions', 'POST');
  assert.deepEqual(request.data, { action: 'evaluate', expectedVersion: 6, speed: 5, effectiveness: 4, attitude: 3 });
  ok(request, { ...detail, version: 7, availableActions: ['request_reopen'] });
  await saving;
  page.onCloseClaimant();
  assert.equal(page.data.claimant, null);
  page.onReceiptLookupInput(input(number));
  const pending = page.onFindReceipt();
  const lookup = take('/cases/' + number + '/receipt');
  page.onHide();
  ok(lookup, receipt);
  await pending;
  assert.equal(page.data.view, 'login');
  assert.equal(page.data.submitReceipt, null);
  assert.equal(page.data.caseReceipt, null);
  assert.doesNotMatch(JSON.stringify(page.data), /合成联系信息|合成反馈|synthetic-private-token/);
});

test('同店他人从回执入口收到拒绝且不展示内容', async t => {
  const { page, take, login } = fixture(t, ['submitCases']);
  await login();
  page.onReceiptLookupInput(input(number));
  const pending = page.onFindReceipt();
  ok(take('/cases/' + number + '/receipt'), { error: 'case_not_found' }, 404);
  await pending;
  assert.equal(page.data.view, 'workbench');
  assert.equal(page.data.submitReceipt, null);
  assert.match(page.data.receiptError, /无法读取/);
});

test('代表入口按权限开放且仅展示冻结区间、抑制和缺失', async t => {
  assert.equal(previousMonth(Date.parse('2026-12-01T15:59:00Z')), '2026-11');
  const { page, take, login } = fixture(t, ['representativeReport']);
  await login();
  assert.equal(page.data.canViewRepresentativeReport, true);
  const pending = page.onOpenRepresentativeReport();
  const request = take('/representative-report');
  const month = new URL(request.url).searchParams.get('month');
  assert.equal(month, previousMonth());
  assert.deepEqual([...new URL(request.url).searchParams.keys()], ['month']);
  ok(request, { month, caseNumber: number, contact: privateToken, metrics: {
    firstResponse: { status: 'available', band: 2, count: 11 },
    firstResponseDuration: { status: 'available', band: 1, medianMinutes: 1440 },
    completion: { status: 'withheld' },
    duplicateComplaints: { status: 'unavailable' },
    satisfaction: { status: 'available', band: 2 }
  } });
  await pending;
  assert.deepEqual(page.data.reportRows.map(row => row.value),
    ['50%–不足 75%', '超过 1 小时且不超过 24 小时', '未达到公开条件', '缺少已启用的数据来源', '3–不足 4 分']);
  assert.doesNotMatch(JSON.stringify(page.data.reportRows), new RegExp(number + '|' + privateToken + '|11|1440'));
  const historical = page.onRepresentativeMonthChange(input('2026-01-01'));
  ok(take('/representative-report'), { month: '2026-01', metrics: {} });
  await historical;
  assert.equal(page.data.reportRows.find(row => row.label === '中位首响时长').value, '原冻结快照未发布时长');
  const expired = page.onRepresentativeMonthChange(input('2026-01-01'));
  ok(take('/representative-report'), { error: 'forbidden' }, 403);
  await expired;
  assert.equal(page.data.reportRows, null);
  assert.equal(page.data.view, 'login');
});

function pngChunk(type, data) {
  const tag = Buffer.from(type);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  tag.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([header, data, checksum]);
}

function largePng(size = 430) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(size * (1 + size * 3));
  const compressed = deflateSync(pixels, { level: 0 });
  assert.deepEqual(inflateSync(compressed), pixels);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))
  ]);
}

test('大规格真实 PNG 用本地路径展示，重取坏图和迟到响应只保留公开码', async t => {
  const { page, take, login, files, visitorFile } = fixture(t, ['readCases', 'submitCases']);
  const png = largePng();
  const wechatCode = { envVersion: 'trial', mediaType: 'image/png', base64: png.toString('base64') };
  assert.ok(png.length > 550000 && png.length <= 1024 * 1024);
  assert.ok(wechatCode.base64.length > 700000);
  const signingIn = login();
  await new Promise(resolve => setImmediate(resolve));
  ok(take('/cases'), { items: [], nextBefore: null });
  await signingIn;

  page.onOpenForm();
  page.onFormLocationInput(input('合成地点'));
  page.onFormCategoryInput(input('合成类别'));
  page.onFormDescriptionInput(input('合成说明'));
  const posting = page.onSubmitNewCase();
  ok(take('/cases', 'POST'), { ...receipt, wechatCode }, 201);
  await new Promise(resolve => setImmediate(resolve));
  ok(take('/cases'), { items: [], nextBefore: null });
  await posting;
  const submitPath = page.data.submitReceipt.qrSource;
  assert.match(submitPath, /receipt-code-merchant-submitReceipt-[A-Za-z0-9_-]{24}\.png$/);
  assert.deepEqual(files.get(submitPath), png);

  const entering = page.onOpenCase(tap({ case: number }));
  assert.equal(files.has(submitPath), false);
  ok(take('/cases/' + number), { caseNumber: number, status: 'submitted' });
  await entering;
  const retrieving = page.onReadCaseReceipt();
  ok(take('/cases/' + number + '/receipt'), { ...receipt, wechatCode });
  await retrieving;
  const { qrSource, qrRevision } = page.data.caseReceipt;
  assert.match(qrSource, /receipt-code-merchant-caseReceipt-[A-Za-z0-9_-]{24}\.png$/);
  assert.deepEqual(files.get(qrSource), png);

  for (const corrupted of [
    { ...wechatCode, mediaType: 'image/webp' }, { ...wechatCode, envVersion: 'invalid' },
    { ...wechatCode, base64: Buffer.alloc(150).toString('base64') },
    { ...wechatCode, base64: largePng(600).toString('base64') }
  ]) {
    const refreshing = page.onReadCaseReceipt();
    assert.equal(files.has(qrSource), false);
    assert.equal(page.data.caseReceipt.publicLookupCode, code);
    ok(take('/cases/' + number + '/receipt'), { ...receipt, wechatCode: corrupted });
    await refreshing;
    assert.equal(page.data.caseReceipt.qrSource, '');
  }
  const retry = page.onReadCaseReceipt();
  ok(take('/cases/' + number + '/receipt'), { ...receipt, wechatCode });
  await retry;
  page.onReceiptImageError(tap({ receipt: 'caseReceipt', revision: qrRevision }));
  assert.equal(files.has(qrSource), true, '过期图片错误不能清除本次图片');
  page.onClearReceiptImage(tap({ receipt: 'caseReceipt', revision: page.data.caseReceipt.qrRevision }));
  assert.equal(files.has(qrSource), false);
  assert.equal(page.data.caseReceipt.publicLookupCode, code);

  const late = page.onReadCaseReceipt();
  const previous = take('/cases/' + number + '/receipt');
  page.onHide();
  ok(previous, { ...receipt, wechatCode });
  await late;
  assert.equal(page.data.view, 'login');
  assert.deepEqual([...files.keys()], [visitorFile]);
});

test('同一公开码在两个回执位的本地图片分别释放', t => {
  const { files, visitorFile } = fixture(t, []);
  const artwork = createReceiptArtwork();
  const wechat = { envVersion: 'develop', mediaType: 'image/png', base64: largePng().toString('base64') };
  const publicReceipt = { caseNumber: number, publicLookupCode: code };
  const first = artwork.present('submitReceipt', publicReceipt, wechat);
  const second = artwork.present('caseReceipt', publicReceipt, wechat);
  assert.notEqual(first.qrSource, second.qrSource);
  artwork.clear('caseReceipt');
  assert.equal(files.has(first.qrSource), true);
  assert.equal(files.has(second.qrSource), false);
  artwork.clearAll();
  assert.deepEqual([...files.keys()], [visitorFile]);
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z';
  const jpegReceipt = artwork.present('submitReceipt', publicReceipt, { envVersion: 'release', mediaType: 'image/jpeg', base64: jpeg });
  assert.match(jpegReceipt.qrSource, /\.jpg$/);
  assert.deepEqual(files.get(jpegReceipt.qrSource), Buffer.from(jpeg, 'base64'));
  artwork.clearAll();
  assert.deepEqual([...files.keys()], [visitorFile]);
});

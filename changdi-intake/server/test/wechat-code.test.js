import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';

const intakePath = '/api/v1/integrations/intake/cases';
const integration = 'i'.repeat(43);
const alternate = 'a'.repeat(43);
const appId = 'wx1234567890abcdef';
const appSecret = 'FAKE_SYNTHETIC_APP_SECRET_EXAMPLE';
const accessToken = 'synthetic-access-token-01';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const baseImage = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
const stablePath = '/cgi-bin/stable_token';
const codePath = '/wxa/getwxacodeunlimit';
const errorBody = { error: 'wechat_code_unavailable' };

async function fixture(t, options = {}) {
  const logs = [];
  const servers = new Set();
  const directory = options.disk && await mkdtemp(join(tmpdir(), 'changdi-wechat-test-'));
  const dbPath = directory ? join(directory, 'fake.sqlite') : ':memory:';
  async function stop(server) {
    if (!servers.delete(server)) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
  }
  t.after(async () => {
    await Promise.all([...servers].map(stop));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function start(wechatCode) {
    const server = createIntakeServer({
      dbPath, receiptKey: Buffer.alloc(32, 0x6a), integrations: [
        { source: 'synthetic-platform', token: integration },
        { source: 'other-synthetic-platform', token: alternate },
      ],
      ...(options.now ? { now: options.now } : {}),
      wechatCode, onInternalError: (...args) => logs.push(args),
    });
    servers.add(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    return {
      get: async path => {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
        return { status: response.status, body: await response.json() };
      },
      async submit(id, { auth = integration, description = '合成申报正文', signal = AbortSignal.timeout(4000) } = {}) {
        const body = new FormData();
        body.append('payload', JSON.stringify({
          externalCaseId: id, occurredAt: '2026-11-19T01:00:00Z', location: '合成私密地点',
          category: '合成类别', description, contact: '合成联系信息',
        }));
        body.append('photos', new Blob([png], { type: 'image/png' }), 'synthetic.png');
        const response = await fetch(base + intakePath, {
          method: 'POST', headers: { Authorization: 'Bearer ' + auth }, body, signal,
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
      },
      stop: () => stop(server),
    };
  }
  function inspect(operation) {
    assert.ok(directory);
    const db = new DatabaseSync(dbPath);
    try { return operation(db); } finally { db.close(); }
  }
  return { start, logs, inspect };
}

function upstream({ envVersion = 'release', app = appId, timeoutMs = 1000, token, image } = {}) {
  const calls = [];
  return {
    calls, config: { appId: app, appSecret, envVersion, timeoutMs, async fetchImpl(rawUrl, request) {
      const url = new URL(rawUrl);
      const body = JSON.parse(request.body);
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      assert.equal(url.origin, 'https://api.weixin.qq.com');
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      assert.deepEqual(request.headers, { 'Content-Type': 'application/json' });
      if (url.pathname === stablePath) {
        assert.equal(url.search, '');
        assert.deepEqual(body, { grant_type: 'client_credential', appid: app,
          secret: appSecret, force_refresh: body.force_refresh });
        assert.equal(typeof body.force_refresh, 'boolean');
        return token ? token(body, request) : Response.json({ access_token: accessToken, expires_in: 7200 });
      }
      assert.equal(url.pathname, codePath);
      assert.deepEqual([...url.searchParams.keys()], ['access_token']);
      assert.match(body.scene, /^[A-Za-z0-9_-]{24}$/);
      assert.deepEqual(body, { scene: body.scene, page: 'pages/public/index',
        check_path: envVersion === 'release', env_version: envVersion });
      return image ? image(url.searchParams.get('access_token'), request) : baseImage();
    } },
  };
}

function assertCode(receipt, envVersion = 'release') {
  assert.deepEqual(Object.keys(receipt).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode', 'wechatCode']);
  assert.deepEqual(receipt.wechatCode, { envVersion, mediaType: 'image/png', base64: png.toString('base64') });
}

test('default intake still returns exactly the three original fields', async t => {
  const { start } = await fixture(t);
  const intake = await start();
  const first = await intake.submit('synthetic-default');
  const replay = await intake.submit('synthetic-default');
  assert.deepEqual([first.status, replay.status], [201, 200]);
  assert.deepEqual(first.body, replay.body);
  assert.deepEqual(Object.keys(first.body).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode']);
  assert.equal(first.headers.get('cache-control'), 'no-store');
});

test('enabled intake forwards only the correct scene and stores a stable scoped receipt across restart', async t => {
  const { start, logs, inspect } = await fixture(t, { disk: true });
  const wx = upstream({ image: () => new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } }) });
  const local = await start(wx.config);
  const one = await local.submit('synthetic-one');
  const two = await local.submit('synthetic-two');
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assertCode(one.body);
  assertCode(two.body);
  assert.equal(one.headers.get('cache-control'), 'no-store');
  assert.deepEqual(wx.calls.map(({ path }) => path), [stablePath, codePath, codePath]);
  for (const [index, receipt] of [one.body, two.body].entries()) {
    assert.equal(wx.calls[index + 1].body.scene, receipt.publicLookupCode);
    assert.deepEqual(wx.calls[index + 1].query, { access_token: accessToken });
    assert.doesNotMatch(JSON.stringify(wx.calls), new RegExp(receipt.privateLookupToken + '|合成|synthetic-one|synthetic-two'));
  }
  assert.deepEqual((await local.submit('synthetic-one', { description: '改动正文' })).body, { error: 'submission_conflict' });
  assert.equal(wx.calls.length, 3);
  assert.equal((await local.submit('synthetic-one', { auth: 'u'.repeat(43) })).status, 401);
  assert.equal(wx.calls.length, 3);
  const separate = await local.submit('synthetic-one', { auth: alternate });
  assert.equal(separate.status, 201);
  assert.notEqual(separate.body.caseNumber, one.body.caseNumber);
  assert.equal(wx.calls.at(-1).body.scene, separate.body.publicLookupCode);
  const publicResult = await local.get('/api/v1/public/cases/' + one.body.publicLookupCode);
  assert.equal(publicResult.status, 200);
  assert.doesNotMatch(JSON.stringify(publicResult.body), /wechatCode|privateLookupToken/);
  assert.doesNotMatch(JSON.stringify(one.body), new RegExp(appId + '|' + appSecret + '|' + accessToken + '|weixin.qq.com'));
  await local.stop();
  const reboot = upstream({ image: () => assert.fail('a saved receipt must not make an upstream request') });
  const replay = await (await start(reboot.config)).submit('synthetic-one');
  assert.deepEqual([replay.status, replay.body], [200, one.body]);
  assert.equal(reboot.calls.length, 0);
  assert.deepEqual(logs, []);
  inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM cases').get().count, 3);
    assert.equal(db.prepare('SELECT count(*) AS count FROM wechat_receipt_codes').get().count, 3);
    assert.equal(db.prepare('SELECT length(app_scope) AS length FROM wechat_receipt_codes LIMIT 1').get().length, 64);
  });
});

test('slow streaming response aborts, opaque 503 keeps the case and a retry completes once', async t => {
  const { start, logs, inspect } = await fixture(t, { disk: true });
  let signal;
  let cancelled = false;
  let attempt = 0;
  const wx = upstream({ timeoutMs: 100, image: (_, request) => {
    if (++attempt > 1) return baseImage();
    signal = request.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/png' } });
  } });
  const local = await start(wx.config);
  const first = await local.submit('synthetic-timeout');
  assert.deepEqual([first.status, first.body, first.headers.get('retry-after')], [503, errorBody, '1']);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  const original = inspect(db => ({
    cases: db.prepare('SELECT case_number, public_lookup_code FROM cases').all(),
    photos: db.prepare('SELECT count(*) AS count FROM attachments').get().count,
    codes: db.prepare('SELECT count(*) AS count FROM wechat_receipt_codes').get().count,
  }));
  assert.deepEqual([original.cases.length, original.photos, original.codes], [1, 1, 0]);
  const replay = await local.submit('synthetic-timeout');
  assert.equal(replay.status, 200);
  assertCode(replay.body);
  assert.deepEqual([replay.body.caseNumber, replay.body.publicLookupCode],
    [original.cases[0].case_number, original.cases[0].public_lookup_code]);
  assert.deepEqual(wx.calls.map(({ path }) => path), [stablePath, codePath, codePath]);
  assert.deepEqual(logs, []);
});

test('a disconnected caller can recover the same saved image and original case', async t => {
  const { start, inspect } = await fixture(t, { disk: true });
  let announce;
  let finish;
  const reachedWechat = new Promise(resolve => { announce = resolve; });
  const image = new Promise(resolve => { finish = resolve; });
  const wx = upstream({ image: () => { announce(); return image; } });
  const local = await start(wx.config);
  const controller = new AbortController();
  const original = local.submit('synthetic-lost-response', { signal: controller.signal });
  await Promise.race([reachedWechat, original]);
  controller.abort();
  await assert.rejects(original, { name: 'AbortError' });
  finish(baseImage());
  const retry = await local.submit('synthetic-lost-response');
  assert.equal(retry.status, 200);
  assertCode(retry.body);
  assert.deepEqual(wx.calls.map(call => call.path), [stablePath, codePath]);
  inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM cases').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM wechat_receipt_codes').get().count, 1);
  });
});

test('WeChat JSON credentials errors trigger one shared refresh and token expires with the injected clock', async t => {
  let time = Date.parse('2026-11-19T01:00:00Z');
  const { start } = await fixture(t, { now: () => new Date(time) });
  let sequence = 0;
  const waiting = [];
  const wx = upstream({
    token: () => Response.json({ access_token: 'test-token-' + ++sequence, expires_in: 10 }),
    image: token => token === 'test-token-1' ? new Promise(resolve => {
      waiting.push(resolve);
      if (waiting.length === 2) {
        for (const reply of waiting) reply(new Response(JSON.stringify({
          errcode: 40001, errmsg: 'PRIVATE upstream URL with synthetic token',
        }), { headers: { 'Content-Type': 'text/plain' } }));
      }
    }) : baseImage(),
  });
  const local = await start(wx.config);
  const saved = await Promise.all(['synthetic-refresh-a', 'synthetic-refresh-b', 'synthetic-refresh-a'].map(id => local.submit(id)));
  assert.deepEqual(saved.map(result => result.status).sort(), [200, 201, 201]);
  assert.deepEqual(saved[0].body, saved[2].body);
  for (const result of saved) assertCode(result.body);
  assert.deepEqual(wx.calls.filter(call => call.path === stablePath).map(call => call.body.force_refresh), [false, true]);
  assert.equal(wx.calls.filter(call => call.path === codePath).length, 4);
  time += 10_000;
  assert.equal((await local.submit('synthetic-after-expiry')).status, 201);
  assert.deepEqual(wx.calls.filter(call => call.path === stablePath).map(call => call.body.force_refresh), [false, true, false]);
});

test('rejects JSON errors, invalid images and oversized chunks without exposing upstream content', async t => {
  const { start, logs } = await fixture(t);
  const sensitive = 'synthetic-upstream-private-details ' + appSecret;
  const invalidImages = [
    () => Response.json({ errcode: 41030, errmsg: sensitive }),
    () => new Response(sensitive, { headers: { 'Content-Type': 'image/png' } }),
    () => new Response(png, { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1048577));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'image/png' } }),
    () => { throw new Error(sensitive); },
  ];
  let attempt = 0;
  const wx = upstream({ image: () => attempt < invalidImages.length ? invalidImages[attempt++]() : baseImage() });
  const local = await start(wx.config);
  for (const invalid of invalidImages) {
    const failed = await local.submit('synthetic-invalid');
    assert.deepEqual([failed.status, failed.body], [503, errorBody]);
  }
  assert.deepEqual(logs, []);
  const successful = await local.submit('synthetic-invalid');
  assert.equal(successful.status, 200);
  assertCode(successful.body);
  assert.equal(wx.calls.filter(call => call.path === stablePath).length, 1);
});

test('token API errors stay opaque and a v8 upgrade preserves the receipt across configuration changes', async t => {
  const { start, inspect, logs } = await fixture(t, { disk: true });
  const prior = await start();
  const original = await prior.submit('synthetic-v8');
  await prior.stop();
  inspect(db => db.exec('DROP TABLE wechat_receipt_codes; PRAGMA user_version = 8;'));
  const fallback = upstream({ envVersion: 'trial', token: () => Response.json({ errcode: 40013, errmsg: appSecret }) });
  const failedTrial = await start(fallback.config);
  const failure = await failedTrial.submit('synthetic-v8');
  assert.deepEqual([failure.status, failure.body], [503, errorBody]);
  assert.deepEqual(fallback.calls.map(call => call.path), [stablePath]);
  assert.deepEqual(logs, []);
  await failedTrial.stop();
  for (const [envVersion, app] of [['release', appId], ['trial', appId], ['trial', 'wxfedcba9876543210']]) {
    const wx = upstream({ envVersion, app });
    const local = await start(wx.config);
    const retry = await local.submit('synthetic-v8');
    assert.equal(retry.status, 200);
    assertCode(retry.body, envVersion);
    const { wechatCode, ...originalFields } = retry.body;
    assert.deepEqual(originalFields, original.body);
    assert.deepEqual(wx.calls.map(call => call.path), [stablePath, codePath]);
    await local.stop();
  }
  assert.deepEqual((await (await start()).submit('synthetic-v8')).body, original.body);
  inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM cases').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM wechat_receipt_codes').get().count, 3);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('invalid or incomplete enabled configuration is rejected before any request', () => {
  const base = { dbPath: ':memory:', integrations: [{ source: 'synthetic', token: integration }],
    receiptKey: Buffer.alloc(32), wechatCode: upstream().config };
  for (const bad of [{ appSecret: '' }, { appId: 'wrong' }, { envVersion: undefined }, { envVersion: 'staging' }]) {
    assert.throws(() => createIntakeServer({ ...base, wechatCode: { ...base.wechatCode, ...bad } }),
      /Invalid WeChat mini-program code configuration/);
  }
});

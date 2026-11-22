import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';

const loginPath = '/api/v1/auth/wechat/session';
const intakePath = '/api/v1/integrations/intake/cases';
const staffMe = '/api/v1/staff/me';
const merchantMe = '/api/v1/merchant/me';
const integration = 'i'.repeat(43);
const appId = 'wx1234567890abcdef';
const appSecret = 'FAKE_SYNTHETIC_APP_SECRET_EXAMPLE';
const staff = [
  { id: 'desk', role: 'duty', token: 'd'.repeat(43) },
  { id: 'handler-a', role: 'handler', department: 'street-a', token: 'a'.repeat(43) },
  { id: 'lead-b', role: 'supervisor', department: 'street-b', token: 'b'.repeat(43) },
];
const merchants = [
  { id: 'shop-a-member', merchantId: 'shop-a', permissions: ['readCases'], token: 'm'.repeat(43) },
  { id: 'shop-b-member', merchantId: 'shop-b', permissions: ['readCases', 'submitCases'], token: 'n'.repeat(43) },
];
const bindings = [
  ...staff.map(({ id }) => ({ openid: 'synthetic-openid-' + id, type: 'staff', id })),
  ...merchants.map(({ id }) => ({ openid: 'synthetic-openid-' + id, type: 'merchant', id })),
];
const denial = { error: 'wechat_login_denied' };
const outage = { error: 'wechat_login_unavailable' };

const form = (identity, id = 'synthetic-001') => {
  const formData = new FormData();
  formData.append('payload', JSON.stringify({
    [identity === 'merchant' ? 'clientRequestId' : 'externalCaseId']: id,
    occurredAt: '2026-11-19T01:00:00Z', location: '合成地点', category: '合成类别', description: '合成申报',
  }));
  return formData;
};

function fixture(t) {
  const listeners = new Set();
  const logs = [];
  let time = Date.parse('2026-11-19T01:00:00Z');
  const config = {
    dbPath: ':memory:', receiptKey: Buffer.alloc(32, 91), integrations: [{ source: 'synthetic', token: integration }],
    staff, merchants, now: () => new Date(time), onInternalError: (...data) => logs.push(data),
  };
  const stop = async server => {
    if (!listeners.delete(server)) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
  };
  t.after(() => Promise.all([...listeners].map(stop)));
  return {
    logs, config, advance: milliseconds => { time += milliseconds; },
    async start(wechatLogin, directory = {}) {
      const server = createIntakeServer({ ...config, ...directory, wechatLogin });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      listeners.add(server);
      const base = 'http://127.0.0.1:' + server.address().port;
      const call = async (path, { auth, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
        const response = await fetch(base + path, {
          method, signal: AbortSignal.timeout(4000),
          headers: {
            ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
            ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body instanceof FormData || body === undefined ? body : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
      };
      return {
        base, server, call, login: code => call(loginPath, { body: { code } }), stop: () => stop(server),
      };
    },
  };
}

const wechatReply = id => Response.json({
  openid: 'synthetic-openid-' + id, session_key: 'synthetic-session-key', unionid: 'synthetic-unionid', errcode: 0,
});
function mockWechat(response = code => wechatReply(code.replace(/^login-/, '')), fields = {}) {
  const calls = [];
  return {
    calls, config: {
      appId, appSecret, bindings, timeoutMs: 1000,
      ...fields,
      async fetchImpl(raw, options) {
        const url = new URL(raw);
        assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
        const query = Object.fromEntries(url.searchParams);
        assert.deepEqual(query, { appid: appId, secret: appSecret,
          js_code: query.js_code, grant_type: 'authorization_code' });
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        assert.equal(options.redirect, 'error');
        calls.push(query.js_code);
        return response(query.js_code, options);
      },
    },
  };
}

test('WeChat login is disabled by default and the existing loopback credentials still work', async t => {
  const { start } = fixture(t);
  const local = await start();
  assert.deepEqual((await local.login('login-desk')).body, { error: 'route_not_found' });
  assert.equal((await local.call(staffMe, { auth: staff[0].token })).status, 200);
  assert.equal((await local.call(merchantMe, { auth: merchants[0].token })).status, 200);
  const receipt = await local.call(intakePath, { auth: integration, body: form('integration') });
  assert.equal(receipt.status, 201);
  assert.deepEqual(Object.keys(receipt.body).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode']);
});

test('WeChat contact access uses the server-side staff grant and current session', async t => {
  const { start, advance } = fixture(t);
  const local = await start(mockWechat().config, {
    staff: [{ ...staff[0], readContact: true }, ...staff.slice(1)],
  });
  const synthetic = 'synthetic-WeChat-session-contact';
  const body = form('integration', 'wechat-contact');
  body.set('payload', JSON.stringify({ ...JSON.parse(body.get('payload')), contact: synthetic }));
  const receipt = await local.call(intakePath, { auth: integration, body });
  assert.equal(receipt.status, 201);
  const path = '/api/v1/staff/cases/' + receipt.body.caseNumber + '/contact';
  const deskSession = (await local.login('login-desk')).body.sessionToken;
  const handlerSession = (await local.login('login-handler-a')).body.sessionToken;
  const merchantSession = (await local.login('login-shop-a-member')).body.sessionToken;
  assert.equal((await local.call(staffMe, { auth: deskSession })).body.readContact, true);
  assert.equal((await local.call(path, { auth: staff[0].token })).status, 401);
  assert.equal((await local.call(path, { auth: handlerSession })).status, 403);
  assert.equal((await local.call(path, { auth: merchantSession })).status, 403);
  const authorized = await local.call(path, { auth: deskSession });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body, { contact: synthetic });
  assert.equal(authorized.headers.get('cache-control'), 'no-store');
  advance(15 * 60 * 1000);
  assert.equal((await local.call(path, { auth: deskSession })).status, 401);
});

test('formal login grants only the bound staff or merchant identity and no WeChat material', async t => {
  const { start, logs } = fixture(t);
  const wx = mockWechat();
  const local = await start(wx.config);
  const staffSession = await local.login('login-desk');
  const merchantSession = await local.login('login-shop-a-member');
  for (const result of [staffSession, merchantSession]) {
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'identity', 'sessionToken']);
    assert.match(result.body.sessionToken, /^wxsession\.[A-Za-z0-9_-]{43}$/);
    assert.equal(result.body.expiresAt, '2026-11-19T01:15:00.000Z');
    assert.doesNotMatch(JSON.stringify(result.body), /synthetic-openid|synthetic-session-key|synthetic-unionid|login-|FAKE_|api\.weixin/);
  }
  assert.deepEqual(staffSession.body.identity, { type: 'staff', id: 'desk', role: 'duty', department: null });
  assert.deepEqual(merchantSession.body.identity, { type: 'merchant', merchantId: 'shop-a', permissions: ['readCases'] });
  const staffToken = staffSession.body.sessionToken;
  const merchantToken = merchantSession.body.sessionToken;
  assert.equal((await local.call(staffMe, { auth: staffToken })).status, 200);
  assert.equal((await local.call(merchantMe, { auth: merchantToken })).status, 200);
  assert.equal((await local.call(staffMe, { auth: merchantToken })).status, 403);
  assert.equal((await local.call(merchantMe, { auth: staffToken })).status, 403);
  for (const token of [staffToken, merchantToken]) {
    assert.equal((await local.call(intakePath, { auth: token, body: form('integration') })).status, 403);
  }
  assert.equal((await local.call(staffMe, { auth: staff[0].token })).status, 401);
  assert.equal((await local.call(merchantMe, { auth: merchants[0].token })).status, 401);
  assert.equal((await local.call(staffMe, { auth: integration })).status, 403);
  assert.equal((await local.call(merchantMe, { auth: integration })).status, 403);
  const receipt = await local.call(intakePath, { auth: integration, body: form('integration') });
  assert.equal(receipt.status, 201);
  const privatePath = '/api/v1/owner/cases/' + receipt.body.caseNumber;
  assert.equal((await local.call(privatePath, { auth: staffToken })).status, 401);
  assert.equal((await local.call(privatePath, { auth: merchantToken })).status, 401);
  const owner = await local.call('/api/v1/owner/verify', { body: {
    publicLookupCode: receipt.body.publicLookupCode, privateLookupToken: receipt.body.privateLookupToken,
  } });
  assert.equal(owner.status, 200);
  assert.equal((await local.call(privatePath, { auth: owner.body.ownerSessionToken })).status, 200);
  assert.equal((await local.call(staffMe, { auth: owner.body.ownerSessionToken })).status, 401);
  assert.equal((await local.call(merchantMe, { auth: owner.body.ownerSessionToken })).status, 401);
  assert.deepEqual(wx.calls, ['login-desk', 'login-shop-a-member']);
  assert.deepEqual(logs, []);
});

test('logged-in staff and merchants retain case, department and grant scope', async t => {
  const { start } = fixture(t);
  const local = await start(mockWechat().config);
  const signIn = async id => (await local.login('login-' + id)).body.sessionToken;
  const duty = await signIn('desk');
  const handler = await signIn('handler-a');
  const supervisor = await signIn('lead-b');
  const viewer = await signIn('shop-a-member');
  const submitter = await signIn('shop-b-member');
  const newCase = await local.call(intakePath, { auth: integration, body: form('integration') });
  const path = '/api/v1/staff/cases/' + newCase.body.caseNumber;
  assert.equal((await local.call(path + '/actions', { auth: duty, body: { action: 'accept', expectedVersion: 1 } })).status, 200);
  assert.equal((await local.call(path + '/actions', { auth: duty, body: {
    action: 'assign', expectedVersion: 2, assignee: 'handler-a', dueAt: '2026-11-19T03:00:00Z',
  } })).status, 200);
  assert.equal((await local.call(path, { auth: handler })).status, 200);
  assert.equal((await local.call(path, { auth: supervisor })).status, 404);
  assert.equal((await local.call('/api/v1/merchant/cases', { auth: viewer, body: form('merchant') })).status, 403);
  const merchantCase = await local.call('/api/v1/merchant/cases', { auth: submitter, body: form('merchant') });
  assert.equal(merchantCase.status, 201);
  assert.equal((await local.call('/api/v1/merchant/cases/' + merchantCase.body.caseNumber, { auth: viewer })).status, 404);
  assert.equal((await local.call('/api/v1/merchant/cases/' + merchantCase.body.caseNumber, { auth: submitter })).status, 200);
  assert.equal((await local.call('/api/v1/merchant/collaborations', { auth: submitter })).status, 403);
});

test('cannot forge role or OpenID and concurrent duplicate codes have only one upstream exchange', async t => {
  const { start } = fixture(t);
  let arrive;
  let finish;
  const arrived = new Promise(resolve => { arrive = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const wx = mockWechat(code => {
    if (code === 'login-desk') {
      arrive();
      return pending;
    }
    if (code === 'invalid-code') return Response.json({ errcode: 40029, errmsg: 'synthetic-sensitive-error' });
    return wechatReply('not-approved');
  });
  const local = await start(wx.config);
  assert.equal((await local.call(loginPath, { body: {
    code: 'login-desk', role: 'duty', merchantId: 'shop-a', department: 'street-a', openid: bindings[0].openid,
  } })).status, 400);
  assert.equal((await local.call(loginPath, { body: { code: 'login-desk' }, auth: integration })).status, 403);
  assert.equal((await local.call(loginPath)).status, 405);
  assert.equal((await local.login('bad code')).status, 400);
  assert.deepEqual(wx.calls, []);
  const unbound = await local.login('unbound-code');
  const invalid = await local.login('invalid-code');
  assert.deepEqual([unbound.status, unbound.body], [401, denial]);
  assert.deepEqual([invalid.status, invalid.body], [401, denial]);
  const first = local.login('login-desk');
  await Promise.race([arrived, first]);
  assert.deepEqual((await local.login('login-desk')).body, denial);
  finish(wechatReply('desk'));
  assert.equal((await first).status, 200);
  assert.deepEqual((await local.login('login-desk')).body, denial);
  assert.deepEqual(wx.calls, ['unbound-code', 'invalid-code', 'login-desk']);
});

test('limits concurrent exchanges, then releases capacity for a fresh code', async t => {
  const { start } = fixture(t);
  let announce;
  let release;
  const allStarted = new Promise(resolve => { announce = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let active = 0;
  const wx = mockWechat(async () => {
    if (++active === 8) announce();
    await hold;
    return wechatReply('desk');
  });
  const local = await start(wx.config);
  const exchanges = Array.from({ length: 8 }, (_, index) => local.login('concurrent-' + index));
  await Promise.race([allStarted, ...exchanges]);
  const saturated = await local.login('concurrent-over-limit');
  assert.deepEqual([saturated.status, saturated.body], [503, outage]);
  assert.equal(wx.calls.length, 8);
  release();
  const sessions = await Promise.all(exchanges);
  assert.ok(sessions.every(session => session.status === 200));
  assert.equal(new Set(sessions.map(session => session.body.sessionToken)).size, 8);
  assert.equal((await local.login('concurrent-fresh')).status, 200);
});

test('timeouts and malformed WeChat responses are bounded, opaque and require a fresh wx.login code', async t => {
  const { start, logs } = fixture(t);
  let cancelled = false;
  let signal;
  const wx = mockWechat((code, options) => {
    if (code === 'timeout-code') {
      signal = options.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }
    if (code === 'oversized-code') return new Response('a'.repeat(16 * 1024 + 1));
    if (code === 'limited-code') return Response.json({ errcode: 45011, errmsg: appSecret });
    if (code === 'network-code') throw new Error(appSecret + ' ' + code + ' https://api.weixin.qq.com');
    return wechatReply('desk');
  }, { timeoutMs: 100 });
  const local = await start(wx.config);
  for (const code of ['timeout-code', 'oversized-code', 'limited-code', 'network-code']) {
    const result = await local.login(code);
    assert.deepEqual([result.status, result.body, result.headers.get('retry-after')], [503, outage, '1']);
    assert.deepEqual((await local.login(code)).body, denial);
  }
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal((await local.login('fresh-code')).status, 200);
  assert.deepEqual(wx.calls, ['timeout-code', 'oversized-code', 'limited-code', 'network-code', 'fresh-code']);
  assert.deepEqual(logs, []);
});

test('expiration holds on reads and on a staff write whose body finishes after time runs out', async t => {
  const { start, advance } = fixture(t);
  const local = await start(mockWechat(() => wechatReply('desk'), { sessionSeconds: 2 }).config);
  const receipt = await local.call(intakePath, { auth: integration, body: form('integration') });
  const path = '/api/v1/staff/cases/' + receipt.body.caseNumber;
  const token = (await local.login('login-desk')).body.sessionToken;
  assert.equal((await local.call(staffMe, { auth: token })).status, 200);
  const requestSeen = new Promise(resolve => local.server.once('request', resolve));
  const body = JSON.stringify({ action: 'accept', expectedVersion: 1 });
  const request = httpRequest(local.base + path + '/actions', {
    method: 'POST', timeout: 4000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': body.length },
  });
  request.on('timeout', () => request.destroy(new Error('slow loopback request timed out')));
  const pending = once(request, 'response');
  request.flushHeaders();
  await requestSeen;
  advance(2000);
  request.end(body);
  const [response] = await pending;
  assert.equal(response.statusCode, 401);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { error: 'unauthorized' });
  assert.equal((await local.call(staffMe, { auth: token })).status, 401);
  const renewed = await local.login('fresh-desk');
  assert.equal(renewed.status, 200);
  const unchanged = await local.call(path, { auth: renewed.body.sessionToken });
  assert.equal(unchanged.status, 200);
  assert.deepEqual([unchanged.body.status, unchanged.body.version], ['submitted', 1]);
});

test('restart applies unbinding and changed grants and rejects all prior project sessions', async t => {
  const { start } = fixture(t);
  const wx = mockWechat();
  const prior = await start(wx.config);
  const oldStaff = (await prior.login('login-desk')).body.sessionToken;
  const oldMerchant = (await prior.login('login-shop-a-member')).body.sessionToken;
  await prior.stop();
  const revised = await start({ ...wx.config, bindings: bindings.filter(binding => binding.id !== 'desk') }, {
    staff: staff.map(({ id, role, department }) => ({ id, role, department })),
    merchants: merchants.map(({ id, merchantId, permissions }) => ({
      id, merchantId, permissions: id === 'shop-a-member' ? [] : permissions,
    })),
  });
  assert.equal((await revised.call(staffMe, { auth: oldStaff })).status, 401);
  assert.equal((await revised.call(merchantMe, { auth: oldMerchant })).status, 401);
  assert.deepEqual((await revised.login('login-desk')).body, denial);
  const customer = await revised.login('login-shop-a-member');
  assert.deepEqual(customer.body.identity, { type: 'merchant', merchantId: 'shop-a', permissions: [] });
  assert.equal((await revised.call('/api/v1/merchant/cases', { auth: customer.body.sessionToken })).status, 403);
});

test('bad or duplicate identity bindings fail closed at startup', t => {
  const { config } = fixture(t);
  const wx = mockWechat();
  for (const invalid of [
    [bindings[0], { ...bindings[3], openid: bindings[0].openid }],
    [{ ...bindings[0], id: 'missing' }],
    [{ ...bindings[0], type: 'owner' }],
    [{ ...bindings[0], type: 'integration', id: 'synthetic' }],
    [{ ...bindings[0], role: 'duty' }],
  ]) {
    assert.throws(() => createIntakeServer({ ...config, wechatLogin: { ...wx.config, bindings: invalid } }),
      /WeChat identity binding/);
  }
  assert.deepEqual(wx.calls, []);
});

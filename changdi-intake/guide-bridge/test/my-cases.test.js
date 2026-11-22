import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server.js';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

const CODE = 'abcdefghijklmnopqrstuvwx';

test('公开查询代理原样透传状态码与响应体，且不外发凭据', async t => {
  let seen;
  const body = JSON.stringify({
    caseNumber: 'CD-' + 'A'.repeat(32),
    status: 'submitted',
    milestones: [{ status: 'submitted', occurredAt: '2026-11-19T01:30:00.000Z' }]
  });
  const upstream = await listen(t, createServer((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  }));
  const bridge = await listen(t, createBridge({ upstream, token: 'private' }));
  const res = await fetch(bridge + '/bridge/my-cases/' + CODE, { headers: { Authorization: 'Bearer client' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), body);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(seen, { url: '/api/v1/public/cases/' + CODE, auth: undefined });
});

test('上游查不到工单时透传 404 与原响应体', async t => {
  let seen;
  const upstream = await listen(t, createServer((req, res) => {
    seen = req.url;
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"case_not_found"}');
  }));
  const bridge = await listen(t, createBridge({ upstream, token: 'private' }));
  const res = await fetch(bridge + '/bridge/my-cases/' + CODE);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '{"error":"case_not_found"}');
  assert.equal(seen, '/api/v1/public/cases/' + CODE);
});

test('非法公开查询码形态返回 404，且不触达上游', async t => {
  let hits = 0;
  const upstream = await listen(t, createServer((req, res) => {
    hits++;
    res.writeHead(200).end('{}');
  }));
  const bridge = await listen(t, createBridge({ upstream, token: 'private' }));
  const illegal = [
    'abcdefghijklmnopqrstuvw',            // 23 位
    'abcdefghijklmnopqrstuvwxy',          // 25 位
    'abcdefghijklmnopqrstu$',             // 非法字符
    'abcdefghijklmnopqrstu%2F',           // 编码后的分隔符
    'abcdefghijklmnopqrstuvw/extra',      // 多余路径段
    ''                                    // 空查询码
  ];
  for (const code of illegal) {
    const res = await fetch(bridge + '/bridge/my-cases/' + code);
    assert.equal(res.status, 404, `应当拒绝 ${code}`);
  }
  assert.equal((await fetch(bridge + '/bridge/my-cases')).status, 404);
  assert.equal(hits, 0, '非法查询码不得触达上游');
});

test('跨域来源被拒绝，写入方法不被允许', async t => {
  const upstream = await listen(t, createServer((req, res) => res.writeHead(200).end('{}')));
  const bridge = await listen(t, createBridge({ upstream, token: 'private' }));
  const cross = await fetch(bridge + '/bridge/my-cases/' + CODE, { headers: { origin: 'https://example.org' } });
  assert.equal(cross.status, 403);
  const same = await fetch(bridge + '/bridge/my-cases/' + CODE, { headers: { origin: bridge } });
  assert.equal(same.status, 200);
  assert.equal((await fetch(bridge + '/bridge/my-cases/' + CODE, { method: 'POST' })).status, 405);
});

test('上游超时降级为 502，且不泄露上游异常原文', async t => {
  const upstream = await listen(t, createServer(() => { /* 永不回应，触发 5 秒超时 */ }));
  const bridge = await listen(t, createBridge({ upstream, token: 'private' }));
  const res = await fetch(bridge + '/bridge/my-cases/' + CODE);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'unavailable' });
  assert.doesNotMatch(text, /timeout|abort|ECONN|127\.0\.0\.1/i);
});

test('与真实接诉即办服务端联通：提交后可查到公开进度', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guide-my-cases-'));
  const token = randomBytes(32).toString('base64url');
  const { createIntakeServer } = await import('../../server/src/server.js');
  const intake = createIntakeServer({ dbPath: join(dir, 'db.sqlite'), receiptKey: randomBytes(32), integrations: [{ source: 'guide-test', token }], staff: [] });
  let bridge;
  t.after(async () => {
    for (const server of [bridge, intake]) if (server?.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
    await rm(dir, { recursive: true, force: true });
  });
  intake.listen(0, '127.0.0.1'); await once(intake, 'listening');
  const upstream = `http://127.0.0.1:${intake.address().port}`;
  bridge = createBridge({ upstream, token }); bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const origin = `http://127.0.0.1:${bridge.address().port}`;

  const form = new FormData();
  form.append('payload', JSON.stringify({ externalCaseId: 'synthetic-id', occurredAt: '2026-11-19T09:30:00+08:00', location: 'synthetic location', category: 'road', description: 'synthetic detail' }));
  const submit = await fetch(origin + '/bridge/submit', { method: 'POST', headers: { Origin: origin }, body: form });
  assert.equal(submit.status, 201);
  const receipt = await submit.json();

  const queried = await fetch(origin + '/bridge/my-cases/' + receipt.publicLookupCode);
  assert.equal(queried.status, 200);
  const payload = await queried.json();
  assert.equal(payload.caseNumber, receipt.caseNumber);
  assert.equal(payload.status, 'submitted');
  assert.ok(Array.isArray(payload.milestones));
  assert.doesNotMatch(JSON.stringify(payload), /synthetic detail|privateLookupToken/);

  const missing = await fetch(origin + '/bridge/my-cases/' + CODE);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'case_not_found' });
});

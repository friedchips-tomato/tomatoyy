import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBridge} from './server.js';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('代理保留响应字节、状态、限流头与查询，不外发凭据', async t => {
  let seen;
  const body = '{ "error": "too_many_requests" }\n';
  const upstream = await listen(t, createServer((req, res) => {
    seen = {url: req.url, auth: req.headers.authorization};
    res.writeHead(429, {'Retry-After': '45'}).end(body);
  }));
  const bridge = await listen(t, createBridge({upstream, token: 'private'}));
  for (const suffix of ['lots', 'lots/P1/forecast?horizons=15,45', 'recommendations?destination_id=CD']) {
    const res = await fetch(bridge + '/bridge/parking/' + suffix, {headers: {Authorization: 'Bearer client'}});
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '45');
    assert.equal(await res.text(), body);
    assert.deepEqual(seen, {url: '/api/v1/public/parking/' + suffix, auth: undefined});
  }
});

test('上游断开返回 502', async t => {
  const upstream = await listen(t, createServer(req => req.socket.destroy()));
  const bridge = await listen(t, createBridge({upstream, token: 'private'}));
  const res = await fetch(bridge + '/bridge/parking/lots');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {error: 'unavailable'});
});

test('参数拼写、重复与原始编码由服务端校验', async t => {
  let seen;
  const upstream = await listen(t, createServer((req, res) => {
    seen = req.url;
    res.writeHead(400).end('{"error":"invalid_filter"}');
  }));
  const bridge = await listen(t, createBridge({upstream, token: 'private'}));
  const suffix = 'recommendations?prefernce=x%2By&prefernce=a+b';
  const res = await fetch(bridge + '/bridge/parking/' + suffix);
  assert.equal(seen, '/api/v1/public/parking/' + suffix);
  assert.equal(res.status, 400);
  assert.equal(await res.text(), '{"error":"invalid_filter"}');
});

test('拒绝未知路径、跨域来源和写入', async t => {
  const bridge = await listen(t, createBridge({upstream: 'http://127.0.0.1:3400', token: 'private'}));
  const root = bridge + '/bridge/parking/';
  assert.equal((await fetch(root + 'nope')).status, 404);
  assert.equal((await fetch(root + 'lots', {headers: {origin: 'https://example.org'}})).status, 403);
  assert.equal((await fetch(root + 'lots', {method: 'POST'})).status, 405);
});

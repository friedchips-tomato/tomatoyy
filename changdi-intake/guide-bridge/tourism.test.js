import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createBridge } from './server.js';

async function listen(t, server) {
  t.after(async () => {
    if (!server.listening) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('tourism bridge validates, separates credentials, retries the same event and supports disabled mode', async t => {
  const received = [];
  let reply = (req, res) => res.writeHead(201).end('upstream response stays behind the bridge');
  const upstream = await listen(t, createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString()});
    reply(req, res);
  }));
  const token = randomBytes(32).toString('base64url');
  const metricsToken = randomBytes(32).toString('base64url');
  const origin = await listen(t, createBridge({upstream, token, metricsToken}));
  const disabled = await listen(t, createBridge({upstream, token}));
  assert.throws(() => createBridge({upstream, token, metricsToken: token}), /separate tokens/);
  const path = '/bridge/tourism-events';
  const event = {
    eventId: '11ab340a616c6477106fed82', type: 'route_exposed', subjectId: 'R1',
    flowId: 'fa3e183c012a3916230002a8', occurredAt: '2026-11-22T09:30:00+08:00'
  };
  const post = (value, {base = origin, headers = {Origin: base}, contentType = 'application/json'} = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: {'Content-Type': contentType, ...headers},
      body: typeof value === 'string' ? value : JSON.stringify(value)
    });

  assert.match(await (await fetch(origin)).text(), /\/bridge\/tourism-client\.js/);
  const script = await (await fetch(origin + '/bridge/tourism-client.js')).text();
  assert.ok(!script.includes(metricsToken) && !script.includes(token));
  assert.doesNotMatch(await (await fetch(disabled)).text(), /tourism-client/);
  assert.equal((await fetch(disabled + '/bridge/tourism-client.js')).status, 404);
  assert.equal((await post(event, {base: disabled})).status, 404);
  assert.equal((await fetch(origin + path)).status, 405);
  assert.equal((await post(event, {headers: {Origin: 'http://example.test'}})).status, 403);
  assert.equal((await post(event, {headers: {}})).status, 403);
  assert.equal((await post(event, {contentType: 'text/plain'})).status, 415);
  assert.equal((await post(' '.repeat(513))).status, 413);
  const chunked = new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(300));
    controller.enqueue(new Uint8Array(300));
    controller.close();
  }});
  assert.equal((await fetch(origin + path, {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: chunked, duplex: 'half'
  })).status, 413);
  for (const invalid of [
    '{', [event], {...event, contact: 'synthetic-personal-text'}, {...event, source: 'demo'},
    {...event, type: 'route_completed'}, {...event, subjectId: 'G1'}, {...event, subjectId: 'user-text'},
    {...event, occurredAt: '2026-11-22T09:30:00'}, {...event, occurredAt: '2026-02-30T09:30:00Z'},
    {...event, eventId: [event.eventId]}, {...event, flowId: undefined}, {...event, durationSeconds: 1},
    ...[undefined, 0, -1, 1.2, '1', null].map(durationSeconds => ({
      ...event, type: 'guide_played', subjectId: 'CD-A01', durationSeconds
    }))
  ]) assert.equal((await post(invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(received.length, 0);

  const window = {};
  runInNewContext(await readFile(new URL('../../prototype-paper/data/points.js', import.meta.url), 'utf8'), {window});
  const {routes, guides, parking, points} = window.CD_DATA;
  const catalogs = {
    route_exposed: routes, route_adopted: routes, route_completed_self_reported: routes,
    booking_demo_submitted: guides, parking_advice_adopted: parking, parking_navigation_clicked: parking,
    guide_played: points.filter(point => point.guide)
  };
  const valid = Object.entries(catalogs).flatMap(([type, subjects]) => subjects.map(({id}) => ({
    ...event, eventId: randomBytes(12).toString('hex'), type, subjectId: id,
    ...(type === 'guide_played' ? {durationSeconds: 9} : {})
  })));
  for (const body of valid) {
    const result = await post(body, {headers: {Origin: origin, Authorization: 'Bearer browser-supplied'}});
    assert.equal(result.status, 204, JSON.stringify(body));
    assert.equal(await result.text(), '');
  }
  assert.deepEqual(received.map(item => JSON.parse(item.body)), valid);
  for (const item of received) {
    assert.equal(item.method, 'POST');
    assert.equal(item.path, '/api/v1/metrics/tourism/events');
    assert.equal(item.headers.authorization, `Bearer ${metricsToken}`);
    assert.equal(item.headers['content-type'], 'application/json');
    assert.equal(item.headers.origin, undefined);
    assert.equal(item.headers.cookie, undefined);
  }

  const form = new FormData();
  form.set('payload', '{}');
  assert.equal((await fetch(origin + '/bridge/submit', {method: 'POST', headers: {Origin: origin}, body: form})).status, 201);
  assert.equal(received.at(-1).path, '/api/v1/integrations/intake/cases');
  assert.equal(received.at(-1).headers.authorization, `Bearer ${token}`);

  let attempts = 0;
  reply = (req, res) => {
    if (++attempts === 1) return; // Receiver processed the body but the response timed out.
    res.writeHead(201).end();
  };
  assert.equal((await post(event)).status, 204);
  assert.equal(attempts, 2);
  assert.equal(received.at(-1).body, received.at(-2).body);
  assert.deepEqual(JSON.parse(received.at(-1).body), event);

  attempts = 0;
  reply = (req, res) => { attempts++; res.writeHead(503).end(); };
  assert.equal((await post(event)).status, 503);
  assert.equal(attempts, 2);
  attempts = 0;
  reply = (req, res) => { attempts++; res.writeHead(401).end(); };
  assert.equal((await post(event)).status, 502);
  assert.equal(attempts, 1);
});

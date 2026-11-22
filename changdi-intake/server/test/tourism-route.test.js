import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBridge } from '../../guide-bridge/server.js';
import { HttpError, sendJson } from '../src/http.js';
import { handleTourismRoute } from '../src/routes/tourism.js';
import { createTourismCore } from '../src/tourism/index.js';

const url = '/api/v1/metrics/tourism/events';
const schema = readFileSync(new URL('../migrations/014-tourism-events.sql', import.meta.url), 'utf8');
const initialEvent = {
  eventId: '11ab340a616c6477106fed82', type: 'route_exposed', subjectId: 'R1',
  flowId: 'fa3e183c012a3916230002a8', occurredAt: '2026-04-12T09:30:00.000+08:00'
};

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

test('tourism route enforces the wire contract through actual loopback HTTP and guide bridge', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  const tourism = createTourismCore(db, {
    sources: [{id: 'guide-demo', kind: 'guide_h5', evidence: 'demo', subjects: {route_exposed: ['R1', 'R2']}}],
    now: () => new Date('2026-05-01T05:00:00Z')
  });
  const intakeToken = randomBytes(24).toString('base64url');
  const metricsToken = randomBytes(24).toString('base64url');
  const authorize = token => `Bearer ${token}`;
  async function authenticateTourismSource(request) {
    const header = request.headers.authorization;
    if (header === authorize(metricsToken)) return {id: 'guide-demo'};
    if (header === authorize(intakeToken)) throw new HttpError(403, 'forbidden');
    throw new HttpError(401, 'unauthorized');
  }
  const statuses = [];
  const server = createServer(async (req, res) => {
    try {
      if (!await handleTourismRoute(req, res, {authenticateTourismSource, tourism})) {
        throw new HttpError(404, 'route_not_found');
      }
      statuses.push(res.statusCode);
    } catch (error) {
      if (!req.readableEnded) res.setHeader('Connection', 'close');
      if (error instanceof HttpError) {
        if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(res, error.status, {error: error.message});
      } else {
        t.diagnostic('Unexpected route exception');
        res.writeHead(500).end();
      }
    }
  });
  const origin = await listen(t, server);
  const text = JSON.stringify(initialEvent);
  const send = (body, {path = url, method = 'POST', token = metricsToken, contentType = 'application/json', duplex} = {}) =>
    fetch(origin + path, {
      method,
      headers: {'Content-Type': contentType, ...(token && {Authorization: authorize(token)})},
      body, duplex
    });
  async function rejected(response, status, code) {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {error: code});
  }

  const wrongMethod = await send(undefined, {method: 'GET', token: null});
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  await rejected(wrongMethod, 405, 'method_not_allowed');
  await rejected(await send(text, {path: url + '?source=guide-demo'}), 404, 'route_not_found');
  const noAuth = await send(text, {token: null});
  assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer');
  await rejected(noAuth, 401, 'unauthorized');
  await rejected(await send(text, {token: intakeToken}), 403, 'forbidden');
  await rejected(await send(text, {contentType: 'text/plain'}), 415, 'expected_json');
  await rejected(await send(text, {contentType: 'application/json; charset=latin1'}), 415, 'expected_json');
  await rejected(await send(Buffer.from([0xff])), 400, 'invalid_utf8');
  await rejected(await send('{'), 400, 'invalid_json');
  await rejected(await send(text.replace('{', '{"ev\\u0065ntId":"ignored",')), 400, 'duplicate_field');
  await rejected(await send(JSON.stringify({...initialEvent, sourceId: 'browser-chosen'})), 400, 'invalid_tourism_fields');
  await rejected(await send(text.padEnd(513)), 413, 'body_too_large');
  const chunked = new ReadableStream({start(controller) {
    controller.enqueue(Buffer.from(text.padEnd(300)));
    controller.enqueue(Buffer.alloc(213, 32));
    controller.close();
  }});
  await rejected(await send(chunked, {duplex: 'half'}), 413, 'body_too_large');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tourism_events').get().count, 0);

  const first = await send(text.padEnd(512), {contentType: 'application/json; charset=UTF-8'});
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(await first.text(), '');
  const replay = await send(text);
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), '');
  const dedup = await send(JSON.stringify({...initialEvent, eventId: '22ab340a616c6477106fed82'}));
  assert.equal(dedup.status, 200);
  assert.equal(await dedup.text(), '');
  await rejected(await send(JSON.stringify({...initialEvent, subjectId: 'R2'})), 409, 'tourism_event_conflict');

  const bridgeOrigin = await listen(t, createBridge({upstream: origin, token: intakeToken, metricsToken}));
  const browserEvent = JSON.stringify({...initialEvent, eventId: '33ab340a616c6477106fed82', subjectId: 'R2'});
  const fromBridge = () => fetch(bridgeOrigin + '/bridge/tourism-events', {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: bridgeOrigin}, body: browserEvent
  });
  assert.equal((await fromBridge()).status, 204);
  assert.equal((await fromBridge()).status, 204);
  assert.deepEqual(statuses, [201, 200, 200, 201, 200]);
  assert.deepEqual(db.prepare('SELECT DISTINCT source_id, evidence FROM tourism_events').all().map(row => ({...row})),
    [{source_id: 'guide-demo', evidence: 'demo'}]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tourism_events').get().count, 2);
});

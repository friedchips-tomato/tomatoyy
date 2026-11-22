import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';

const eventPath = '/api/v1/metrics/tourism/events';
const reportPath = '/api/v1/staff/monthly-report';
const receiptKey = randomBytes(32);
const bookingToken = randomBytes(24).toString('base64url');
const arrivalToken = randomBytes(24).toString('base64url');
const intakeToken = randomBytes(24).toString('base64url');
const dutyToken = randomBytes(24).toString('base64url');

const id = n => n.toString(16).padStart(24, '0');
const event = (n, type, subjectId, flowNumber, occurredAt) =>
  ({eventId: id(n), type, subjectId, flowId: id(flowNumber), occurredAt});

// Two synthetic sources with independent Bearer credentials. They stand in for the
// booking service and the parking verifier, which have no real counterpart in the prototype.
const sources = [
  {id: 'synthetic-booking', kind: 'booking_service', evidence: 'operational', token: bookingToken,
    subjects: {booking_requested: ['G1'], booking_confirmed: ['G1'], booking_cancelled: ['G1']}},
  {id: 'synthetic-arrival', kind: 'parking_verifier', evidence: 'operational', token: arrivalToken,
    subjects: {parking_arrival_verified: ['P1']}}
];
const coverage = [
  {evidence: 'operational', type: 'booking_requested', from: '2026-01-01T00:00:00Z', status: 'complete'},
  {evidence: 'operational', type: 'booking_confirmed', from: '2026-01-01T00:00:00Z', status: 'complete'},
  {evidence: 'operational', type: 'booking_cancelled', from: '2026-01-01T00:00:00Z', status: 'complete'},
  {evidence: 'operational', type: 'parking_arrival_verified', from: '2026-01-01T00:00:00Z', status: 'complete'}
];

async function listen(t, server) {
  t.after(async () => {
    if (!server.listening) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tourism-coverage-'));
  const dbPath = join(directory, 'intake.sqlite');
  let clock = '2026-05-01T00:00:00.000Z';
  const server = createIntakeServer({
    dbPath, receiptKey,
    integrations: [{source: 'guide-form', token: intakeToken}],
    staff: [{id: 'desk', role: 'duty', token: dutyToken}],
    merchants: [],
    now: () => new Date(clock),
    tourism: {sources, coverage},
    ...options
  });
  t.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    rmSync(directory, {recursive: true, force: true});
  });
  return {
    server, dbPath,
    at(value) { clock = value; },
    async origin() { return listen(t, server); }
  };
}

function post(origin, body, token) {
  return fetch(origin + eventPath, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify(body)
  });
}

async function monthly(origin, month) {
  const response = await fetch(`${origin}${reportPath}?month=${month}`, {headers: {Authorization: `Bearer ${dutyToken}`}});
  assert.equal(response.status, 200);
  return (await response.json()).tourism;
}

test('合成来源在完整覆盖下报零，重复上报只记一次', async t => {
  const fixtureServer = fixture(t);
  const origin = await fixtureServer.origin();
  fixtureServer.at('2026-04-20T00:00:00.000Z');

  const requested = event(1, 'booking_requested', 'G1', 50, '2026-04-10T02:00:00.000Z');
  assert.equal((await post(origin, requested, bookingToken)).status, 201);
  assert.equal((await post(origin, requested, bookingToken)).status, 200);
  assert.equal((await post(origin, requested, bookingToken)).status, 200);
  fixtureServer.at('2026-05-02T00:00:00.000Z');

  const april = await monthly(origin, '2026-04');
  assert.equal(april.operational.booking_requested.status, 'complete');
  assert.equal(april.operational.booking_requested.count, 1);
  // Complete coverage without an observed event reports zero, not a missing metric.
  assert.equal(april.operational.booking_confirmed.status, 'complete');
  assert.equal(april.operational.booking_confirmed.count, 0);
  assert.equal(april.operational.booking_cancelled.count, 0);
  assert.equal(april.operational.bookingStatus.status, 'complete');
  assert.equal(april.operational.bookingStatus.requested, 1);
  assert.equal(april.operational.bookingStatus.confirmed, 0);
  assert.equal(april.operational.parking_arrival_verified.status, 'complete');
  assert.equal(april.operational.parking_arrival_verified.count, 0);

  const db = new DatabaseSync(fixtureServer.dbPath);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tourism_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tourism_event_ids').get().n, 1);
  } finally {
    db.close();
  }
});

test('合成来源互相隔离，核验到达只能来自车场来源', async t => {
  const fixtureServer = fixture(t);
  const origin = await fixtureServer.origin();
  fixtureServer.at('2026-04-20T00:00:00.000Z');
  const arrival = event(2, 'parking_arrival_verified', 'P1', 60, '2026-04-11T02:00:00.000Z');
  assert.equal((await post(origin, arrival, bookingToken)).status, 403);
  assert.equal((await post(origin, arrival, arrivalToken)).status, 201);
  // A booking source cannot confirm a booking either.
  assert.equal((await post(origin, event(3, 'booking_confirmed', 'G1', 61, '2026-04-11T02:00:00.000Z'), arrivalToken)).status, 403);
  fixtureServer.at('2026-05-02T00:00:00.000Z');
  const april = await monthly(origin, '2026-04');
  assert.equal(april.operational.parking_arrival_verified.count, 1);
  assert.equal(april.operational.booking_confirmed.count, 0);
});

test('同 ID 冲突与同流程去重按既定语义判定', async t => {
  const fixtureServer = fixture(t);
  const origin = await fixtureServer.origin();
  fixtureServer.at('2026-04-20T00:00:00.000Z');
  const original = event(4, 'booking_requested', 'G1', 70, '2026-04-12T02:00:00.000Z');
  assert.equal((await post(origin, original, bookingToken)).status, 201);
  const conflict = await post(origin, {...original, subjectId: 'G2'}, bookingToken);
  assert.equal(conflict.status, 400);
  assert.deepEqual(await conflict.json(), {error: 'invalid_tourism_subject'});
  // A different event id with the same source, type, subject and flow reuses the first record.
  const alias = {...original, eventId: id(5), occurredAt: '2026-04-12T03:00:00.000Z'};
  assert.equal((await post(origin, alias, bookingToken)).status, 200);
  // The alias remembers its own fingerprint, so a later change is reported as a conflict.
  const changed = await post(origin, {...alias, occurredAt: '2026-04-12T04:00:00.000Z'}, bookingToken);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), {error: 'tourism_event_conflict'});
  fixtureServer.at('2026-05-02T00:00:00.000Z');
  assert.equal((await monthly(origin, '2026-04')).operational.booking_requested.count, 1);
});

test('月界按北京时间归月，跨月的同一流程分别计入', async t => {
  const fixtureServer = fixture(t);
  const origin = await fixtureServer.origin();
  fixtureServer.at('2026-05-01T00:00:00.000Z');
  // 2026-04-30T15:59:59.999Z is still April in Beijing, one millisecond later it is May.
  assert.equal((await post(origin, event(6, 'booking_requested', 'G1', 80, '2026-04-30T15:59:59.999Z'), bookingToken)).status, 201);
  assert.equal((await post(origin, event(7, 'booking_requested', 'G1', 81, '2026-04-30T16:00:00.000Z'), bookingToken)).status, 201);
  fixtureServer.at('2026-05-20T00:00:00.000Z');
  assert.equal((await monthly(origin, '2026-04')).operational.booking_requested.count, 1);
  assert.equal((await monthly(origin, '2026-05')).operational.booking_requested.count, 1);
});

test('缺覆盖时报告给出不可用状态，不伪造零', async t => {
  const fixtureServer = fixture(t, {tourism: {sources, coverage: []}});
  const origin = await fixtureServer.origin();
  fixtureServer.at('2026-04-20T00:00:00.000Z');
  assert.equal((await post(origin, event(8, 'booking_requested', 'G1', 90, '2026-04-12T02:00:00.000Z'), bookingToken)).status, 201);
  fixtureServer.at('2026-05-02T00:00:00.000Z');
  const april = await monthly(origin, '2026-04');
  assert.equal(april.status, 'unavailable');
  assert.deepEqual(april.operational.booking_requested, {status: 'unavailable'});
  assert.deepEqual(april.operational.parking_arrival_verified, {status: 'unavailable'});
  assert.deepEqual(april.operational.bookingStatus, {status: 'unavailable'});
});

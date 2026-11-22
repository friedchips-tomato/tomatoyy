import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createTourismCore, TOURISM_BODY_LIMIT } from '../src/tourism/index.js';

const schema = readFileSync(new URL('../migrations/014-tourism-events.sql', import.meta.url), 'utf8');
const routeIds = ['R1', 'R2', 'R3'];
const parkingIds = ['P1', 'P2'];
const h5Catalog = {
  route_exposed: routeIds, route_adopted: routeIds, route_completed_self_reported: routeIds,
  guide_played: ['CD-R01', 'CD-R02', 'CD-V01', 'CD-A01', 'CD-A02', 'CD-A03', 'CD-S01', 'CD-S02', 'CD-S03'],
  parking_advice_adopted: parkingIds, parking_navigation_clicked: parkingIds
};
const guide = {id: 'guide-demo', kind: 'guide_h5', evidence: 'demo',
  subjects: {...h5Catalog, booking_demo_submitted: ['G1', 'G2', 'G3']}};
const liveGuide = {id: 'guide-live', kind: 'guide_h5', evidence: 'operational', subjects: h5Catalog};
const booking = {id: 'booking-mock', kind: 'booking_service', evidence: 'operational',
  subjects: {booking_requested: ['G1'], booking_confirmed: ['G1'], booking_cancelled: ['G1']}};
const verifier = {id: 'verifier-mock', kind: 'parking_verifier', evidence: 'operational',
  subjects: {parking_arrival_verified: ['P1']}};
const sources = [guide, liveGuide, booking, verifier];
const april = '2026-04-01T00:00:00+08:00';
const may = '2026-05-01T00:00:00+08:00';
const june = '2026-06-01T00:00:00+08:00';
const at = n => `2026-04-${String(n).padStart(2, '0')}T10:00:00+08:00`;
const id = n => n.toString(16).padStart(24, '0');
const covered = (evidence, type, from = april, to = june, status = 'complete') => ({evidence, type, from, to, status});
const testCoverage = [
  ...Object.keys(guide.subjects).map(type => covered('demo', type)),
  covered('operational', 'route_exposed'),
  ...Object.keys(booking.subjects).map(type => covered('operational', type)),
  covered('operational', 'parking_arrival_verified')
];

function fixture(t, coverage = testCoverage, db = new DatabaseSync(':memory:')) {
  t.after(() => db.close());
  db.exec(schema);
  let now = may;
  const core = createTourismCore(db, {sources, coverage, now: () => new Date(now)});
  const clock = value => { now = value; };
  const write = (source, event) => core.recordEvent(source.id, JSON.stringify(event));
  return {db, core, clock, write};
}

function event(eventNumber, type, subjectId, flowNumber, occurredAt, durationSeconds) {
  return {eventId: id(eventNumber), type, subjectId, flowId: id(flowNumber), occurredAt,
    ...(durationSeconds !== undefined ? {durationSeconds} : {})};
}
const valid = event(1, 'route_exposed', 'R1', 100, at(15));
const count = (value, status = 'complete') => ({status, count: value});

test('sample totals distinguish demo and operational facts and replay an independent time-window oracle', t => {
  const {core, clock, write} = fixture(t);
  clock('2026-05-04T11:00:00+08:00');
  const accepted = [
    [guide, event(1, 'route_exposed', 'R1', 100, at(15))],
    [guide, event(2, 'route_exposed', 'R2', 100, at(15))],
    [guide, event(3, 'route_adopted', 'R1', 100, at(26))],
    [guide, event(4, 'route_completed_self_reported', 'R1', 100, '2026-04-30T23:59:59.999+08:00')],
    [guide, event(5, 'guide_played', 'CD-A01', 101, at(15), 12)],
    [guide, event(6, 'booking_demo_submitted', 'G1', 102, at(15))],
    [guide, event(7, 'parking_advice_adopted', 'P1', 103, at(15))],
    [guide, event(8, 'parking_navigation_clicked', 'P1', 103, at(15))],
    [liveGuide, event(1, 'route_exposed', 'R1', 100, at(15))],
    [booking, event(9, 'booking_requested', 'G1', 104, at(19))],
    [booking, event(10, 'booking_confirmed', 'G1', 104, at(20))],
    [booking, event(11, 'booking_cancelled', 'G1', 104, at(21))]
  ];
  for (const [source, item] of accepted.toReversed()) assert.deepEqual(write(source, item), {status: 'recorded'});
  clock('2026-05-04T12:00:00+08:00');
  const aprilBeforeArrival = core.summarizeMonth('2026-04', {asOf: '2026-05-04T12:00:00+08:00'});
  assert.deepEqual(aprilBeforeArrival.demo, {
    route_exposed: count(2), route_adopted: count(1), route_completed_self_reported: count(1),
    guide_played: {...count(1), durationSeconds: 12}, booking_demo_submitted: count(1),
    parking_advice_adopted: count(1), parking_navigation_clicked: count(1)
  });
  assert.deepEqual(aprilBeforeArrival.operational.route_exposed, count(1));
  assert.deepEqual(aprilBeforeArrival.operational.parking_arrival_verified, count(0));
  assert.deepEqual(aprilBeforeArrival.operational.bookingStatus, {status: 'complete', requested: 0, confirmed: 0, cancelled: 1});
  for (const state of ['requested', 'confirmed', 'cancelled']) {
    assert.deepEqual(aprilBeforeArrival.operational[`booking_${state}`], count(1));
  }
  assert.deepEqual(aprilBeforeArrival.operational.route_adopted, {status: 'unavailable'});
  assert.deepEqual(aprilBeforeArrival.period, {start: '2026-04-01T00:00:00.000+08:00', endExclusive: '2026-05-01T00:00:00.000+08:00'});
  assert.equal(aprilBeforeArrival.status, 'partial');
  const maySnapshot = core.summarizeMonth('2026-05', {asOf: '2026-05-04T12:00:00+08:00'});
  assert.equal(maySnapshot.demo.route_completed_self_reported.count, 0);
  assert.equal(maySnapshot.demo.route_adopted.count, 0);
  assert.equal(maySnapshot.occurrenceCutoffExclusive, '2026-05-04T12:00:00.000+08:00');

  clock('2026-05-05T12:00:00+08:00');
  const arrival = event(12, 'parking_arrival_verified', 'P1', 199, at(15));
  assert.deepEqual(write(verifier, arrival), {status: 'recorded'});
  assert.deepEqual(core.summarizeMonth('2026-04', {asOf: '2026-05-04T12:00:00+08:00'}), aprilBeforeArrival);
  assert.deepEqual(core.summarizeMonth('2026-04').operational.parking_arrival_verified, count(0));
  clock('2026-05-05T12:00:00.001+08:00');
  const revised = core.summarizeMonth('2026-04');
  assert.deepEqual(revised.operational.parking_arrival_verified, count(1));
  assert.deepEqual(revised.demo, aprilBeforeArrival.demo);

  // Recompute independently from the fixture as-sold, using calendar dates in Beijing and no SQL.
  const sourceRows = [...accepted, [verifier, arrival]];
  const computed = {demo: {}, operational: {}};
  for (const [source, item] of sourceRows) {
    if (new Date(Date.parse(item.occurredAt) + 28_800_000).toISOString().slice(0, 7) !== '2026-04') continue;
    computed[source.evidence][item.type] = (computed[source.evidence][item.type] ?? 0) + 1;
  }
  for (const [evidence, metrics] of Object.entries(computed)) {
    for (const [type, total] of Object.entries(metrics)) assert.equal(revised[evidence][type].count, total);
  }
  assert.doesNotMatch(JSON.stringify(revised), /eventId|flowId|subjectId|guide-demo|booking-mock|verifier-mock/);
});

test('idempotency holds across event order, ID aliases, source isolation and SQLite connections', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tourism-core-'));
  const dbPath = join(directory, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  const peer = new DatabaseSync(dbPath);
  t.after(() => {
    peer.close();
    db.close();
    rmSync(directory, {recursive: true, force: true});
  });
  db.exec(schema);
  let time = '2026-05-03T00:00:00Z';
  const options = {sources, coverage: testCoverage, now: () => new Date(time)};
  const first = createTourismCore(db, options);
  const second = createTourismCore(peer, options);
  const send = (core, source, value) => core.recordEvent(source.id, JSON.stringify(value));
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => send(second, guide, valid), /database is locked/);
  db.exec('COMMIT');
  assert.deepEqual(send(first, guide, valid), {status: 'recorded'});
  const {eventId, ...rest} = valid;
  const normalizedReplay = JSON.stringify({...rest, occurredAt: '2026-04-15T02:00:00.000Z', eventId});
  assert.deepEqual(second.recordEvent(guide.id, normalizedReplay), {status: 'replayed'});
  assert.throws(() => send(second, guide, {...valid, subjectId: 'R2'}), {status: 409, message: 'tourism_event_conflict'});
  const alias = {...valid, eventId: id(2), occurredAt: may};
  assert.deepEqual(send(second, guide, alias), {status: 'deduplicated'});
  assert.deepEqual(send(first, guide, alias), {status: 'replayed'});
  assert.throws(() => send(first, guide, {...alias, occurredAt: at(16)}), {status: 409});
  assert.deepEqual(send(second, liveGuide, valid), {status: 'recorded'});
  const done = event(3, 'route_completed_self_reported', 'R1', 100, may);
  const adopted = event(4, 'route_adopted', 'R1', 100, '2026-04-30T23:59:59.999+08:00');
  assert.deepEqual(send(second, guide, done), {status: 'recorded'});
  assert.deepEqual(send(first, guide, adopted), {status: 'recorded'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tourism_events').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tourism_event_ids').get().n, 5);
  time = '2026-05-03T00:00:00.001Z';
  assert.equal(first.summarizeMonth('2026-04').demo.route_exposed.count, 1);
  assert.equal(first.summarizeMonth('2026-05').demo.route_exposed.count, 0);
  assert.equal(first.summarizeMonth('2026-05').demo.route_completed_self_reported.count, 1);
  assert.equal(peer.isTransaction, false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('additive SQL applies inside the migration transaction on a disposable v10 database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tourism-migration-'));
  const dbPath = join(directory, 'test.sqlite');
  let db;
  t.after(() => {
    db?.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const now = () => new Date(may);
  db = new DatabaseSync(dbPath);
  // Freeze the historical baseline. The current store can advance beyond v10.
  const migrations = [
    '001-initial', '002-owner-workflow', '003-merchants', '004-case-supplement',
    '005-staff-submission-photos', '006-published-feedback-photos', '007-collaboration-photos',
    '008-owner-supplement-photos', '009-wechat-receipt-codes', '010-public-submissions'
  ];
  const migrate = name => db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
  const receiptKeyCheck = createHmac('sha256', Buffer.alloc(32, 1))
    .update('changdi-intake:verify-receipt-key:v1').digest('base64url');
  // Historic migrations rebuild FK targets with enforcement off, then check the final graph.
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
  migrate(migrations[0]);
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('receipt_key_check', receiptKeyCheck);
  db.exec(`
    INSERT INTO cases (id, source, external_case_id, submission_hash, case_number, public_lookup_code,
      occurred_at, location, category, description, status, version)
      VALUES (7, 'synthetic-source', 'legacy-case', 'synthetic-hash', 'LEGACY-7', 'LEGACY-CODE',
        '2026-04-12T12:00:00.000Z', 'Synthetic location', 'Synthetic category', 'Legacy fixture', 'closed', 2);
    INSERT INTO case_events VALUES
      (7, 1, 'submit', 'submitted', 'integration', 'synthetic-source', '2026-04-12T12:00:00.000Z', '{}', 1),
      (7, 2, 'publish', 'closed', 'staff', 'synthetic-staff', '2026-04-12T13:00:00.000Z', '{}', 1);
    INSERT INTO case_contacts VALUES (7, 'synthetic legacy contact');
  `);
  migrate(migrations[1]);
  db.prepare(`
    UPDATE cases SET reopen_ends_at = (
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+' || ? || ' seconds')
      FROM case_events WHERE case_id = cases.id AND action = 'publish' ORDER BY version DESC LIMIT 1
    )
  `).run(600);
  for (const name of migrations.slice(2)) migrate(name);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.exec('PRAGMA user_version = 10; COMMIT; PRAGMA foreign_keys = ON;');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const readCases = db.prepare('SELECT * FROM cases ORDER BY id');
  const readEvents = db.prepare('SELECT * FROM case_events ORDER BY case_id, version');
  const readContacts = db.prepare('SELECT * FROM case_contacts ORDER BY case_id');
  const readSettings = db.prepare('SELECT * FROM settings ORDER BY key');
  const oldRows = [readCases, readEvents, readContacts, readSettings].map(query => query.all());
  assert.equal(oldRows[0][0].reopen_ends_at, '2026-04-12T13:10:00.000Z');
  assert.equal(oldRows[1].length, 2);
  assert.equal(oldRows[2][0].case_id, 7);
  assert.equal(readSettings.get().value, receiptKeyCheck);
  db.exec('BEGIN IMMEDIATE');
  db.exec(schema);
  db.exec('COMMIT');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.deepEqual([readCases, readEvents, readContacts, readSettings].map(query => query.all()), oldRows);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => db.prepare('DELETE FROM cases WHERE id = ?').run(7), /FOREIGN KEY constraint failed/);
  assert.equal(createTourismCore(db, {now}).summarizeMonth('2026-04').status, 'unavailable');
});

test('coverage and the two clocks exclude out-of-scope, late and future events from historical runs', t => {
  const coverage = [
    covered('demo', 'route_exposed', april, at(10)),
    covered('demo', 'route_exposed', at(10), may),
    covered('demo', 'route_adopted', at(5), may),
    covered('demo', 'guide_played', april, may, 'partial'),
    covered('demo', 'parking_navigation_clicked', april, at(6)),
    covered('demo', 'parking_navigation_clicked', at(7), may)
  ];
  const {core, clock, write} = fixture(t, coverage);
  clock(at(10));
  write(guide, event(1, 'route_adopted', 'R1', 10, at(2)));
  write(guide, event(2, 'route_adopted', 'R1', 11, at(5)));
  write(guide, event(3, 'route_exposed', 'R1', 12, '2026-04-10T10:03:00+08:00'));
  write(guide, event(4, 'parking_navigation_clicked', 'P1', 13, '2026-04-06T18:00:00+08:00'));
  clock(at(20));
  write(guide, event(5, 'route_exposed', 'R1', 14, at(8)));
  write(guide, event(6, 'route_completed_self_reported', 'R1', 14, at(9)));
  const early = core.summarizeMonth('2026-04', {asOf: '2026-04-10T10:02:00+08:00'});
  assert.deepEqual(early.demo.route_exposed, count(0));
  assert.deepEqual(early.demo.route_adopted, count(1, 'partial'));
  assert.deepEqual(early.demo.guide_played, {...count(0, 'partial'), durationSeconds: 0});
  assert.deepEqual(early.demo.parking_navigation_clicked, count(0, 'partial'));
  assert.deepEqual(early.demo.route_completed_self_reported, {status: 'unavailable'});
  assert.deepEqual(early.operational.bookingStatus, {status: 'unavailable'});
  assert.equal(core.summarizeMonth('2026-04').demo.route_exposed.count, 1);
  clock(june);
  assert.deepEqual(core.summarizeMonth('2026-04').demo.route_exposed, count(2));
  assert.deepEqual(core.summarizeMonth('2026-05').demo.route_exposed, {status: 'unavailable'});
  assert.throws(() => core.summarizeMonth('2026-07'), {status: 400, message: 'future_report_month'});
  assert.throws(() => core.summarizeMonth('2026-04', {asOf: '2026-06-02T00:00:00+08:00'}), {status: 400, message: 'future_report_cutoff'});
});

test('strict input validation, source permissions, privacy and SQLite checks', t => {
  const {db, core, write} = fixture(t);
  assert.equal(TOURISM_BODY_LIMIT, 512);
  assert.equal(core.validateEvent(guide.id, Buffer.from(JSON.stringify(valid))).occurredAt, '2026-04-15T02:00:00.000Z');
  assert.throws(() => core.recordEvent('unconfigured', JSON.stringify(valid)), {status: 403});
  for (const [source, invalid] of [
    [guide, event(1, 'booking_confirmed', 'G1', 1, at(10))],
    [liveGuide, event(1, 'booking_demo_submitted', 'G1', 1, at(10))],
    [guide, event(1, 'parking_arrival_verified', 'P1', 1, at(10))],
    [booking, event(1, 'parking_arrival_verified', 'P1', 1, at(10))],
    [verifier, valid]
  ]) assert.throws(() => write(source, invalid), {status: 403});
  for (const invalid of [
    {...valid, type: 'route_completed'}, {...valid, subjectId: 'G1'}, {...valid, subjectId: ['R1']},
    {...valid, eventId: 'test-id'}, {...valid, flowId: null}, {...valid, durationSeconds: 1},
    {...valid, occurredAt: '2026-02-30T12:00:00Z'}, {...valid, occurredAt: '2026-04-15T12:00:00'},
    {...valid, occurredAt: '2026-05-01T00:05:00.001+08:00'},
    ...['source', 'sourceId', 'evidence', 'phone', 'contact', 'userId', 'location', 'caseNumber', 'receiptCode', 'description', '__proto__']
      .map(field => ({...valid, [field]: 'synthetic extra value'})),
    ...[undefined, null, 0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]
      .map(seconds => event(1, 'guide_played', 'CD-A01', 1, at(10), seconds))
  ]) assert.throws(() => write(guide, invalid), {status: 400}, JSON.stringify(invalid));
  assert.throws(() => core.recordEvent(guide.id, Buffer.from([0xff])), {status: 400, message: 'invalid_utf8'});
  assert.throws(() => core.recordEvent(guide.id, ' '.repeat(513)), {status: 413});
  for (const name of ['eventId', 'ev\\u0065ntId', 'phone']) {
    const body = name === 'phone'
      ? JSON.stringify(valid).replace('{', '{"phone":"s1","phone":"s2",')
      : JSON.stringify(valid).replace('{', `{"${name}":"0",`);
    assert.throws(() => core.recordEvent(guide.id, body), {status: 400, message: 'duplicate_field'});
  }
  assert.throws(() => write(verifier, event(1, 'parking_arrival_verified', 'P2', 1, at(12))), {status: 400});
  assert.throws(() => createTourismCore(db, {sources: [guide], coverage: [covered('operational', 'parking_arrival_verified')]}), TypeError);
  assert.throws(() => createTourismCore(db, {sources: [{...guide, evidence: 'invalid'}]}), TypeError);
  assert.throws(() => createTourismCore(db, {sources: [{...guide, subjects: {parking_arrival_verified: ['P1']}}]}), TypeError);
  assert.throws(() => createTourismCore(db, {sources: [{...guide, subjects: {route_exposed: ['R 1']}}]}), TypeError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tourism_events').get().n, 0);
  assert.deepEqual(db.prepare('PRAGMA table_info(tourism_events)').all().map(column => column.name),
    ['id', 'source_id', 'evidence', 'type', 'subject_id', 'flow_id', 'occurred_at', 'recorded_at', 'duration_seconds']);
  assert.deepEqual(db.prepare('PRAGMA table_info(tourism_event_ids)').all().map(column => column.name),
    ['source_id', 'event_id', 'fingerprint', 'canonical_id']);
  const insert = db.prepare(`
    INSERT INTO tourism_events (source_id, evidence, type, subject_id, flow_id, occurred_at, recorded_at, duration_seconds)
    VALUES ('guide-demo', 'demo', ?, 'P1', ?, ?, '2026-04-12T13:00:00.000Z', ?)
  `);
  assert.throws(() => insert.run('parking_arrival_verified', id(1), '2026-04-12T12:00:00.000Z', null), /CHECK constraint failed/);
  assert.throws(() => insert.run('guide_played', id(1), '2026-04-12T12:00:00.000Z', null), /CHECK constraint failed/);
  assert.throws(() => insert.run('route_exposed', id(1), '2026-02-30T12:00:00.000Z', null), /CHECK constraint failed/);
});

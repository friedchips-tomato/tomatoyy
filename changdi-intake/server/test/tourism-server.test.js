import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';
import { SCHEMA_VERSION } from '../src/store.js';
import { applyLegacySchema } from './legacy-schema.js';

const eventPath = '/api/v1/metrics/tourism/events';
const reportPath = '/api/v1/staff/monthly-report';
const receiptKey = randomBytes(32);
const demoToken = randomBytes(24).toString('base64url');
const liveToken = randomBytes(24).toString('base64url');
const bookingToken = randomBytes(24).toString('base64url');
const parkingToken = randomBytes(24).toString('base64url');
const intakeToken = randomBytes(24).toString('base64url');
const dutyToken = randomBytes(24).toString('base64url');
const supervisorToken = randomBytes(24).toString('base64url');
const handlerToken = randomBytes(24).toString('base64url');
const merchantToken = randomBytes(24).toString('base64url');

const guideSubjects = {
  route_exposed: ['R1', 'R2', 'R3'],
  route_adopted: ['R1', 'R2', 'R3'],
  route_completed_self_reported: ['R1', 'R2', 'R3'],
  guide_played: ['CD-A01', 'CD-S01'],
  parking_advice_adopted: ['P1', 'P2'],
  parking_navigation_clicked: ['P1', 'P2']
};
const demoSubjects = {...guideSubjects, booking_demo_submitted: ['G1', 'G2', 'G3']};
const bookingSubjects = {booking_requested: ['G1'], booking_confirmed: ['G1'], booking_cancelled: ['G1']};
const parkingSubjects = {parking_arrival_verified: ['P1']};

// Every configured source holds its own credential and its own restricted catalog.
const tourism = {
  sources: [
    {id: 'guide-demo', kind: 'guide_h5', evidence: 'demo', token: demoToken, subjects: demoSubjects},
    {id: 'guide-live', kind: 'guide_h5', evidence: 'operational', token: liveToken, subjects: guideSubjects},
    {id: 'booking-live', kind: 'booking_service', evidence: 'operational', token: bookingToken, subjects: bookingSubjects},
    {id: 'parking-live', kind: 'parking_verifier', evidence: 'operational', token: parkingToken, subjects: parkingSubjects}
  ],
  coverage: [
    ...Object.keys(demoSubjects).map(type => ({evidence: 'demo', type, from: '2026-01-01T00:00:00Z', status: 'complete'})),
    ...Object.keys(guideSubjects).map(type => ({evidence: 'operational', type, from: '2026-01-01T00:00:00Z', status: 'complete'})),
    ...Object.keys(bookingSubjects).map(type => ({evidence: 'operational', type, from: '2026-01-01T00:00:00Z', status: 'complete'})),
    ...Object.keys(parkingSubjects).map(type => ({evidence: 'operational', type, from: '2026-01-01T00:00:00Z', status: 'complete'}))
  ]
};

const id = n => n.toString(16).padStart(24, '0');
const event = (n, type, subjectId, flowNumber, occurredAt, extra = {}) =>
  ({eventId: id(n), type, subjectId, flowId: id(flowNumber), occurredAt, ...extra});
const april = '2026-04-15T02:00:00.000Z';
const recordedAt = '2026-05-01T00:00:00.000Z';
const reportedAt = '2026-05-20T04:00:00.000Z';

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

// The store keeps the database open until the server closes, so the temporary directory
// is removed only after every server of the test has been closed.
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tourism-server-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      if (!server.listening) continue;
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    rmSync(directory, {recursive: true, force: true});
  });
  return {directory, servers};
}

function startServer(t, options = {}) {
  const {directory, servers} = workspace(t);
  let clock = reportedAt;
  const dbPath = join(directory, 'intake.sqlite');
  const server = createIntakeServer({
    dbPath,
    receiptKey,
    integrations: [{source: 'guide-form', token: intakeToken}],
    staff: [
      {id: 'desk', role: 'duty', token: dutyToken},
      {id: 'chief', role: 'supervisor', department: 'streets', token: supervisorToken},
      {id: 'runner', role: 'handler', department: 'streets', token: handlerToken}
    ],
    merchants: [{id: 'shop', merchantId: 'shop-1', token: merchantToken, permissions: ['representativeReport']}],
    now: () => new Date(clock),
    ...options
  });
  servers.push(server);
  return {
    server, dbPath,
    at(value) { clock = value; },
    async origin() { return listen(t, server); }
  };
}

function post(origin, body, token) {
  return fetch(origin + eventPath, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    body: JSON.stringify(body)
  });
}

function report(origin, month, token) {
  return fetch(`${origin}${reportPath}?month=${month}`, {headers: {Authorization: `Bearer ${token}`}});
}

test('导览来源各自持凭据，跨来源、跨身份复用凭据一律启动失败', t => {
  const {directory, servers} = workspace(t);
  const base = {
    receiptKey,
    integrations: [{source: 'guide-form', token: intakeToken}],
    staff: [{id: 'desk', role: 'duty', token: dutyToken}],
    merchants: [{id: 'shop', merchantId: 'shop-1', token: merchantToken, permissions: []}]
  };
  let counter = 0;
  const withSources = sources => ({
    ...base, dbPath: join(directory, `db-${counter += 1}.sqlite`),
    tourism: {sources, coverage: []}
  });
  const source = (id, token) => ({id, kind: 'guide_h5', evidence: 'demo', token, subjects: {route_exposed: ['R1']}});
  assert.throws(() => createIntakeServer(withSources([source('guide-a', demoToken), source('guide-b', demoToken)])),
    /Duplicate credential/);
  assert.throws(() => createIntakeServer(withSources([source('guide-a', intakeToken)])), /Duplicate credential/);
  assert.throws(() => createIntakeServer(withSources([source('guide-a', dutyToken)])), /Duplicate credential/);
  assert.throws(() => createIntakeServer(withSources([source('guide-a', merchantToken)])), /Duplicate credential/);
  // A source may only catalog the event types its kind and evidence allow.
  assert.throws(() => createIntakeServer(withSources([{...source('guide-a', demoToken), subjects: {booking_confirmed: ['G1']}}])),
    /Invalid tourism source catalog/);
  assert.throws(() => createIntakeServer(withSources([{...source('guide-a', 'short-token')}])),
    /Invalid credential format/);
  assert.throws(() => createIntakeServer({...withSources([source('guide-a', demoToken)]), tourism: {sources: [], coverage: [], extra: 1}}),
    /Invalid tourism configuration/);
  assert.equal(servers.length, 0);
});

test('缺省不启用任何导览来源，既有身份不能写入导览事件', async t => {
  const fixture = startServer(t, {tourism: {}});
  const origin = await fixture.origin();
  const body = event(1, 'route_exposed', 'R1', 10, april);
  for (const token of [dutyToken, intakeToken, merchantToken, supervisorToken]) {
    const response = await post(origin, body, token);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {error: 'forbidden'});
  }
  const anonymous = await post(origin, body, null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
});

test('导览事件按来源边界受理，路径、状态与幂等语义同既有模块一致', async t => {
  const fixture = startServer(t, {tourism});
  const origin = await fixture.origin();
  fixture.at(recordedAt);
  const body = event(1, 'route_exposed', 'R1', 10, april);

  const wrongMethod = await fetch(origin + eventPath, {method: 'GET'});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  const wrongPath = await fetch(origin + eventPath + '?source=guide-demo', {
    method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${demoToken}`}, body: JSON.stringify(body)
  });
  assert.equal(wrongPath.status, 404);
  assert.deepEqual(await wrongPath.json(), {error: 'route_not_found'});

  const first = await post(origin, body, demoToken);
  assert.equal(first.status, 201);
  assert.equal(await first.text(), '');
  const replay = await post(origin, body, demoToken);
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), '');
  const conflict = await post(origin, {...body, subjectId: 'R2'}, demoToken);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {error: 'tourism_event_conflict'});

  // A source cannot write another source's evidence class or catalog.
  const demoOnly = await post(origin, event(2, 'booking_confirmed', 'G1', 11, april), demoToken);
  assert.equal(demoOnly.status, 403);
  assert.deepEqual(await demoOnly.json(), {error: 'tourism_type_forbidden'});
  const operationalOnly = await post(origin, event(3, 'booking_demo_submitted', 'G1', 12, april), liveToken);
  assert.equal(operationalOnly.status, 403);
  const outsideCatalog = await post(origin, event(4, 'route_exposed', 'R9', 13, april), demoToken);
  assert.equal(outsideCatalog.status, 400);
  assert.deepEqual(await outsideCatalog.json(), {error: 'invalid_tourism_subject'});
  const otherSource = await post(origin, event(5, 'route_exposed', 'R1', 14, april), liveToken);
  assert.equal(otherSource.status, 201);

  // Identities of other modules never reach the tourism writer.
  for (const token of [intakeToken, dutyToken, merchantToken]) {
    const response = await post(origin, event(6, 'route_exposed', 'R1', 15, april), token);
    assert.equal(response.status, 403);
  }

  // Credentials never reach SQLite, the browser or any response body.
  const bytes = readFileSync(fixture.dbPath);
  for (const token of [demoToken, liveToken, bookingToken, parkingToken]) {
    assert.ok(!bytes.includes(token), 'source credential must not be stored');
  }
  fixture.at(reportedAt);
  const rows = await (await report(origin, '2026-04', dutyToken)).text();
  for (const token of [demoToken, liveToken, bookingToken, parkingToken]) assert.ok(!rows.includes(token));
});

test('管理月报聚合导览数据，缺覆盖时给出明确提示', async t => {
  const fixture = startServer(t, {tourism});
  const origin = await fixture.origin();
  fixture.at(recordedAt);
  await post(origin, event(1, 'route_exposed', 'R1', 10, april), demoToken);
  await post(origin, event(2, 'route_exposed', 'R2', 10, april), demoToken);
  await post(origin, event(3, 'route_adopted', 'R1', 10, april), demoToken);
  await post(origin, event(4, 'route_completed_self_reported', 'R1', 10, april), demoToken);
  await post(origin, event(5, 'guide_played', 'CD-A01', 11, april, {durationSeconds: 12}), demoToken);
  await post(origin, event(6, 'booking_demo_submitted', 'G1', 12, april), demoToken);
  await post(origin, event(7, 'parking_advice_adopted', 'P1', 13, april), demoToken);
  await post(origin, event(8, 'parking_navigation_clicked', 'P1', 13, april), demoToken);
  await post(origin, event(9, 'route_exposed', 'R1', 14, april), liveToken);
  await post(origin, event(10, 'booking_requested', 'G1', 15, april), bookingToken);
  await post(origin, event(11, 'booking_confirmed', 'G1', 15, april), bookingToken);
  fixture.at(reportedAt);

  const response = await report(origin, '2026-04', dutyToken);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.month, '2026-04');
  assert.equal(body.tourism.demo.route_exposed.count, 2);
  assert.equal(body.tourism.demo.route_adopted.count, 1);
  assert.equal(body.tourism.demo.route_completed_self_reported.count, 1);
  assert.equal(body.tourism.demo.guide_played.count, 1);
  assert.equal(body.tourism.demo.guide_played.durationSeconds, 12);
  assert.equal(body.tourism.demo.booking_demo_submitted.count, 1);
  assert.equal(body.tourism.demo.parking_advice_adopted.count, 1);
  assert.equal(body.tourism.demo.parking_navigation_clicked.count, 1);
  assert.equal(body.tourism.operational.route_exposed.count, 1);
  assert.equal(body.tourism.operational.bookingStatus.status, 'complete');
  assert.equal(body.tourism.operational.bookingStatus.confirmed, 1);
  // The arrival verifier produced nothing, and complete coverage must show zero rather than missing data.
  assert.equal(body.tourism.operational.parking_arrival_verified.status, 'complete');
  assert.equal(body.tourism.operational.parking_arrival_verified.count, 0);
  assert.equal(body.tourism.operational.booking_cancelled.count, 0);

  // The report clock is the server clock. A client supplied cutoff is never honoured.
  assert.equal(body.asOf, '2026-05-20T12:00:00+08:00');
  assert.equal(body.tourism.asOf, '2026-05-20T12:00:00.000+08:00');
  const spoofed = await fetch(`${origin}${reportPath}?month=2026-04&asOf=2020-01-01T00:00:00.000Z`, {
    headers: {Authorization: `Bearer ${dutyToken}`}
  });
  assert.equal(spoofed.status, 400);
  assert.deepEqual(await spoofed.json(), {error: 'invalid_filter'});
  const repeated = await report(origin, '2026-04', dutyToken);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).asOf, body.asOf);

  // Only the all-street duty desk may read the management report.
  for (const token of [supervisorToken, handlerToken, merchantToken, intakeToken]) {
    const denied = await report(origin, '2026-04', token);
    assert.equal(denied.status, 403, `token must not read the management report: ${token}`);
  }
  assert.equal((await report(origin, '2026-04', null)).status, 401);
});

// The merchant representative report and the public case view must never carry tourism data.
// The check is structural: the key sets of the parsed response are compared, so a 404 error
// body can no longer pass as a successful check.
const tourismTypeNames = [
  'route_exposed', 'route_adopted', 'route_completed_self_reported', 'guide_played',
  'booking_demo_submitted', 'parking_advice_adopted', 'parking_navigation_clicked',
  'booking_requested', 'booking_confirmed', 'booking_cancelled', 'parking_arrival_verified'
];
const tourismFieldNames = [
  'tourism', 'demo', 'operational', 'eventId', 'flowId', 'subjectId',
  'durationSeconds', 'occurrenceCutoffExclusive', 'sourceId', 'evidence'
];

function collectKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      collectKeys(item, found);
    }
  }
  return found;
}

function collectStrings(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, found);
    return found;
  }
  if (typeof value === 'string') found.push(value);
  return found;
}

function assertNoTourism(value, label) {
  for (const key of collectKeys(value)) {
    assert.ok(!tourismFieldNames.includes(key), `${label} must not carry the tourism key ${key}`);
    assert.ok(!tourismTypeNames.includes(key), `${label} must not carry the tourism type ${key}`);
  }
  for (const text of collectStrings(value)) {
    for (const source of ['guide-demo', 'guide-live', 'booking-live', 'parking-live']) {
      assert.ok(!text.includes(source), `${label} must not carry the tourism source ${source}`);
    }
    for (const type of tourismTypeNames) {
      assert.ok(!text.includes(type), `${label} must not carry the tourism type ${type}`);
    }
  }
}

function multipart(payload) {
  const form = new FormData();
  form.set('payload', JSON.stringify(payload));
  return form;
}

test('商户代表报告与公开接口都不含导览数据', async t => {
  const shopTwoToken = randomBytes(24).toString('base64url');
  const fixture = startServer(t, {
    tourism,
    supervision: {
      windowHours: 72,
      points: [{code: 'P1', label: '合成点位'}],
      categories: [{code: 'C1', label: '合成类别'}]
    },
    merchants: [
      {id: 'shop', merchantId: 'shop-1', token: merchantToken, permissions: ['representativeReport']},
      {id: 'shop-two', merchantId: 'shop-2', token: shopTwoToken, permissions: ['readCases', 'submitCases']}
    ],
    representativeReports: {
      minimumGroupSize: 5, months: ['2026-04'],
      ranges: [{id: 'range-1', merchantIds: ['shop-1', 'shop-2']}]
    }
  });
  const origin = await fixture.origin();

  // A real report needs a released month and a real sample. Both come from the same store.
  fixture.at('2026-04-02T00:10:00.000Z');
  const submitted = [];
  for (let index = 0; index < 15; index++) {
    const response = await fetch(origin + '/api/v1/merchant/cases', {
      method: 'POST',
      headers: {Authorization: `Bearer ${shopTwoToken}`},
      body: multipart({
        clientRequestId: `synthetic-${index}`,
        occurredAt: '2026-04-02T00:01:00.000Z',
        location: '合成地点', category: '合成类别', description: '合成描述', contact: 'synthetic-contact'
      })
    });
    assert.equal(response.status, 201);
    submitted.push((await response.json()).caseNumber);
  }
  // The disclosure needs both sides of every metric. Five cases are answered, published and
  // rated well, five are answered but reopened after publication, and five are still pending.
  const db = new DatabaseSync(fixture.dbPath);
  try {
    const caseId = number => db.prepare('SELECT id FROM cases WHERE case_number = ?').get(number).id;
    const anchor = caseId(submitted[0]);
    for (const [index, caseNumber] of submitted.entries()) {
      const id = caseId(caseNumber);
      const add = (version, action, status, when, round = 1) => db.prepare(`
        INSERT INTO case_events (case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public, round)
        VALUES (?, ?, ?, ?, 'staff', 'desk', ?, '{}', 1, ?)
      `).run(id, version, action, status, when, round);
      const classify = (duplicateOf) => db.prepare(`
        INSERT INTO case_supervision_events (case_id, revision, action, point_code, category_code, duplicate_of, reason, staff_id, changed_at)
        VALUES (?, 1, ?, 'P1', 'C1', ?, '合成判重', 'desk', '2026-04-10T00:00:00.000Z')
      `).run(id, duplicateOf === null ? 'classify' : 'confirm', duplicateOf);
      if (index >= 5 && index < 10) {
        add(2, 'accept', 'accepted', '2026-04-03T00:00:00.000Z');
        add(3, 'publish', 'awaiting_evaluation', '2026-04-04T00:00:00.000Z');
        db.prepare('INSERT INTO case_evaluations VALUES (?, 1, ?, ?, ?, NULL, ?)')
          .run(id, 5, 5, 5, '2026-04-05T00:00:00.000Z');
        classify(anchor);
      } else if (index >= 10) {
        add(2, 'accept', 'accepted', '2026-04-03T00:00:00.000Z');
        add(3, 'publish', 'awaiting_evaluation', '2026-04-04T00:00:00.000Z');
        add(4, 'approve_reopen', 'assigned', '2026-04-06T00:00:00.000Z', 2);
        db.prepare('INSERT INTO case_evaluations VALUES (?, 1, ?, ?, ?, NULL, ?)')
          .run(id, 2, 2, 2, '2026-04-05T00:00:00.000Z');
        classify(null);
      } else {
        classify(null);
      }
    }
  } finally {
    db.close();
  }
  fixture.at(reportedAt);
  await post(origin, event(1, 'route_exposed', 'R1', 10, april), demoToken);

  // The old path of the regression did not exist and answered with a 404 error body.
  const wrongPath = await fetch(origin + '/api/v1/merchant/reports/2026-04', {
    headers: {Authorization: `Bearer ${merchantToken}`}
  });
  assert.equal(wrongPath.status, 404);
  assert.deepEqual(await wrongPath.json(), {error: 'route_not_found'});
  // A month that is not released is a documented answer of its own.
  const unreleased = await fetch(origin + '/api/v1/merchant/representative-report?month=2026-03', {
    headers: {Authorization: `Bearer ${merchantToken}`}
  });
  assert.equal(unreleased.status, 404);
  assert.deepEqual(await unreleased.json(), {error: 'report_not_released'});

  const representative = await fetch(origin + '/api/v1/merchant/representative-report?month=2026-04', {
    headers: {Authorization: `Bearer ${merchantToken}`}
  });
  assert.equal(representative.status, 200);
  const body = await representative.json();
  assert.deepEqual(Object.keys(body).sort(), ['metrics', 'month']);
  assert.equal(body.month, '2026-04');
  assert.deepEqual(Object.keys(body.metrics).sort(),
    ['completion', 'duplicateComplaints', 'firstResponse', 'firstResponseDuration', 'satisfaction']);
  for (const [name, value] of Object.entries(body.metrics)) {
    assert.ok(['available', 'withheld', 'unavailable'].includes(value.status), `${name} status`);
    assert.deepEqual(Object.keys(value).filter(key => key !== 'band'), ['status']);
    if (value.status === 'available') assert.ok(Number.isInteger(value.band) && value.band >= 0 && value.band <= 3);
  }
  // The published report carries real metric values and no tourism key, type or source.
  assert.equal(body.metrics.firstResponse.status, 'available');
  assert.equal(body.metrics.completion.status, 'available');
  assert.equal(body.metrics.satisfaction.status, 'available');
  assertNoTourism(body, '商户代表报告');

  // The public case view is the first party view. It carries the documented fields only.
  const publicSubmission = await fetch(origin + '/api/v1/public/cases', {
    method: 'POST',
    body: multipart({
      clientRequestId: 'synthetic-public-case',
      occurredAt: '2026-04-02T00:01:00.000Z',
      location: '合成地点', category: '合成类别', description: '合成描述', contact: 'synthetic-contact'
    })
  });
  assert.equal(publicSubmission.status, 201);
  const receipt = await publicSubmission.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode']);
  const publicView = await fetch(`${origin}/api/v1/public/cases/${receipt.publicLookupCode}`);
  assert.equal(publicView.status, 200);
  const view = await publicView.json();
  assert.deepEqual(Object.keys(view).sort(), ['caseNumber', 'milestones', 'status']);
  assert.equal(view.caseNumber, receipt.caseNumber);
  assert.ok(Array.isArray(view.milestones) && view.milestones.length >= 1);
  for (const milestone of view.milestones) {
    assert.deepEqual(Object.keys(milestone).sort(), ['occurredAt', 'status']);
  }
  assertNoTourism(view, '公开工单视图');
});

test('013 临时库升级到 014 后旧数据、授权与外键保持', async t => {
  const {directory, servers} = workspace(t);
  const dbPath = join(directory, 'intake.sqlite');
  const db = new DatabaseSync(dbPath);
  const keyCheck = createHmac('sha256', receiptKey).update('changdi-intake:verify-receipt-key:v1').digest('base64url');
  try {
    // An explicit v13 fixture: old case, contact audit, supervision record and a published merchant report.
    applyLegacySchema(db, 13);
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('receipt_key_check', keyCheck);
    db.prepare(`
      INSERT INTO cases (id, source, external_case_id, submission_hash, case_number, public_lookup_code,
        occurred_at, location, category, description, status, version)
      VALUES (7, 'synthetic-source', 'legacy-case', 'synthetic-hash', 'CD-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'LEGACY-CODE',
        '2026-04-12T12:00:00.000Z', 'Synthetic location', 'Synthetic category', 'Legacy fixture', 'closed', 2)
    `).run();
    db.prepare('INSERT INTO case_contacts VALUES (7, ?)').run('synthetic legacy contact');
    db.prepare('INSERT INTO case_contact_access_audit VALUES (7, ?, ?)').run('legacy-auditor', '2026-04-12T13:00:00.000Z');
    db.prepare(`
      INSERT INTO case_events (case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public, round)
      VALUES (7, 1, 'submit', 'submitted', 'integration', 'synthetic-source', '2026-04-12T12:00:00.000Z', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO case_supervision_events (case_id, revision, action, point_code, category_code, duplicate_of, reason, staff_id, changed_at)
      VALUES (7, 1, 'classify', 'P1', 'street', NULL, 'legacy classification', 'legacy-supervisor', '2026-04-12T14:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO remediation_entries (id, topic, minutes, responsible_unit, due_at, staff_id, created_at)
      VALUES (1, 'legacy topic', 'legacy minutes', 'legacy unit', '2026-05-01T00:00:00.000Z', 'legacy-supervisor', '2026-04-12T14:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO representative_report_releases (month, policy_hash, reports, frozen_at)
      VALUES ('2026-04', 'synthetic-policy', '{"range-1":{"completion":{"status":"withheld"}}}', '2026-05-01T00:00:00.000Z')
    `).run();
    db.exec('PRAGMA user_version = 13');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally {
    db.close();
  }

  const config = {
    dbPath, receiptKey,
    integrations: [{source: 'guide-form', token: intakeToken}],
    staff: [{id: 'legacy-duty', role: 'duty', token: dutyToken, readContact: true}],
    merchants: [{id: 'shop', merchantId: 'shop-1', token: merchantToken, permissions: ['representativeReport']}],
    now: () => new Date(reportedAt),
    tourism
  };
  const server = createIntakeServer(config);
  servers.push(server);
  const origin = await listen(t, server);
  const upgraded = new DatabaseSync(dbPath);
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 1);
    assert.equal(upgraded.prepare('SELECT contact FROM case_contacts').get().contact, 'synthetic legacy contact');
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM case_contact_access_audit').get().n, 1);
    assert.equal(upgraded.prepare('SELECT point_code FROM current_case_supervision').get().point_code, 'P1');
    assert.equal(upgraded.prepare('SELECT topic FROM remediation_entries').get().topic, 'legacy topic');
    assert.equal(upgraded.prepare('SELECT month FROM representative_report_releases').get().month, '2026-04');
    // The new tables exist and the old business tables need no backfill.
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM tourism_events').get().n, 0);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM tourism_event_ids').get().n, 0);
  } finally {
    upgraded.close();
  }

  // Reopening the migrated library keeps the old rows and the old authorisations.
  const reopened = createIntakeServer(config);
  servers.push(reopened);
  const reopenedOrigin = await listen(t, reopened);
  const contact = await fetch(reopenedOrigin + '/api/v1/staff/cases/CD-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/contact', {
    headers: {Authorization: `Bearer ${dutyToken}`}
  });
  assert.equal(contact.status, 200);
  assert.deepEqual(await contact.json(), {contact: 'synthetic legacy contact'});
  const audit = new DatabaseSync(dbPath);
  try {
    assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM case_contact_access_audit').get().n, 2);
    assert.equal(audit.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  } finally {
    audit.close();
  }
});

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { backup, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { crc32, deflateSync } from 'node:zlib';
import { createIntakeServer } from '../src/server.js';
import { SCHEMA_VERSION } from '../src/store.js';

const intakePath = '/api/v1/integrations/intake/cases';
const verifyPath = '/api/v1/owner/verify';
const ownerPath = caseNumber => '/api/v1/owner/cases/' + caseNumber;
const staffPath = caseNumber => '/api/v1/staff/cases/' + caseNumber;
const staffCases = '/api/v1/staff/cases';
const workbench = '/api/v1/staff/workbench';
const publicPath = code => '/api/v1/public/cases/' + code;
const merchantCases = '/api/v1/merchant/cases';
const merchantTasks = '/api/v1/merchant/collaborations';
const payload = {
  externalCaseId: 'synthetic-001',
  occurredAt: '2026-11-19T09:00:00+08:00',
  location: '合成测试地点：精确地址',
  category: '街面维护',
  description: '合成测试正文',
  suggestedDepartment: '合成建议部门',
  contact: 'synthetic@example.invalid',
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z',
  'base64',
);
const token = () => randomBytes(32).toString('base64url');

function form(value = payload, photos = []) {
  const data = new FormData();
  data.append('payload', JSON.stringify(value));
  for (const { bytes, type, name } of photos) data.append('photos', new Blob([bytes], { type }), name);
  return data;
}

const photo = { bytes: png, type: 'image/png', name: 'example.png' };
const photo2 = { bytes: jpeg, type: 'image/jpeg', name: 'example.jpg' };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function stop(server) {
  const stopped = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await stopped;
  assert.equal(server.listening, false);
}

async function fixture(t) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-', import.meta.url)));
  const cleanup = [];
  t.after(async () => {
    const outcomes = await Promise.allSettled(cleanup.map(close => close()));
    await rm(directory, { recursive: true, force: true });
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  });
  const integration = token();
  const rotated = token();
  const other = token();
  const duty = token();
  const handler = token();
  const secondHandler = token();
  const unrelatedHandler = token();
  const supervisor = token();
  const unrelatedSupervisor = token();
  const shopA = token();
  const shopAReader = token();
  const shopB = token();
  const submitOnly = token();
  const staff = [
    { id: 'dispatcher', role: 'duty', token: duty },
    { id: 'handler-a', department: 'a', role: 'handler', token: handler },
    { id: 'handler-a2', department: 'a', role: 'handler', token: secondHandler },
    { id: 'handler-b', department: 'b', role: 'handler', token: unrelatedHandler },
    { id: 'supervisor-a', department: 'a', role: 'supervisor', token: supervisor },
    { id: 'supervisor-b', department: 'b', role: 'supervisor', token: unrelatedSupervisor },
  ];
  const config = {
    dbPath: directory + '/test.sqlite',
    receiptKey: randomBytes(32),
    integrations: [
      { source: 'platform-a', token: integration },
      { source: 'platform-a', token: rotated },
      { source: 'platform-b', token: other },
    ],
    staff,
    merchants: [
      { id: 'merchant-a', merchantId: 'shop-a', token: shopA, permissions: ['readCases', 'submitCases', 'collaborate'] },
      { id: 'merchant-a-reader', merchantId: 'shop-a', token: shopAReader, permissions: ['readCases'] },
      { id: 'merchant-b', merchantId: 'shop-b', token: shopB, permissions: ['readCases', 'submitCases', 'collaborate'] },
      { id: 'merchant-c', merchantId: 'shop-c', token: submitOnly, permissions: ['submitCases'] },
    ],
    evaluationSeconds: 10,
    reopenSeconds: 40,
  };
  let current = new Date('2026-11-19T02:00:00Z');
  const server = createIntakeServer({ ...config, now: () => current });
  cleanup.push(() => stop(server));
  const base = await listen(server);
  const client = origin => async (path, { auth, body, method = 'GET', headers = {} } = {}) => {
    if (auth) headers.Authorization = 'Bearer ' + auth;
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + path, { method, headers, body });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const get = client(base);
  return {
    config, integration, rotated, other, duty, handler, secondHandler, unrelatedHandler,
    supervisor, unrelatedSupervisor, shopA, shopAReader, shopB, submitOnly, get, client, cleanup, base,
    now: () => current,
    advanceClock: seconds => { current = new Date(current.valueOf() + seconds * 1000); },
    submit: (body = form(), auth = integration) => get(intakePath, { method: 'POST', body, auth }),
  };
}

function verify(f, receipt, options = {}) {
  const { publicLookupCode, privateLookupToken } = receipt;
  return f.get(verifyPath, { method: 'POST', body: JSON.stringify({ publicLookupCode, privateLookupToken }), ...options });
}

function act(f, path, auth, action, expectedVersion, fields = {}) {
  return f.get(path + '/actions', {
    auth, method: 'POST', body: JSON.stringify({ action, expectedVersion, ...fields }),
  });
}

async function prepareFeedback(f, caseNumber) {
  const path = staffPath(caseNumber);
  assert.equal((await act(f, path, f.duty, 'accept', 1)).status, 200);
  assert.equal((await act(f, path, f.duty, 'assign', 2, {
    assignee: 'handler-a', dueAt: '2026-11-20T10:00:00+08:00',
  })).status, 200);
  assert.equal((await act(f, path, f.handler, 'start', 3)).status, 200);
  assert.equal((await act(f, path, f.handler, 'submit_result', 4, {
    summary: '未发布的承办草稿', photoOmissionReason: '合成缺照原因',
  })).status, 200);
}

async function secondListener(f) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { ...f.config, fixedNow: f.now().toISOString() },
  });
  const workerExited = once(worker, 'exit');
  f.cleanup.push(async () => {
    if (worker.threadId !== -1) worker.postMessage('stop');
    assert.deepEqual(await workerExited, [0]);
  });
  const [base] = await once(worker, 'message');
  return f.client(base);
}

function inspect(config, run) {
  const db = new DatabaseSync(config.dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

if (isMainThread) test('intake receipt is stable across source credential rotation and service reopen', async t => {
  const f = await fixture(t);
  const first = await f.submit(form(payload, [photo, photo2]));
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(first.body).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode']);
  assert.match(first.body.caseNumber, /^CD-[0-9A-F]{32}$/);
  assert.match(first.body.publicLookupCode, /^[A-Za-z0-9_-]{24}$/);
  assert.match(first.body.privateLookupToken, /^[A-Za-z0-9_-]{43}$/);
  const samePayload = Object.fromEntries(Object.entries(payload).reverse());
  samePayload.occurredAt = '2026-11-19T01:00:00.000Z';
  samePayload.location += ' ';
  const replay = () => form(samePayload, [photo2, { ...photo, name: 'renamed.png' }]);
  const repeat = await f.submit(replay(), f.rotated);
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, first.body);
  assert.deepEqual((await f.submit(form({ ...payload, description: 'changed' }, [photo, photo2]))).body,
    { error: 'submission_conflict' });
  assert.equal((await f.submit(form(payload, [photo]))).status, 409);
  assert.equal((await f.submit(form(payload, [photo2, photo2]))).status, 409);
  const other = await f.submit(form(payload, [photo]), f.other);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.caseNumber, first.body.caseNumber);
  assert.throws(() => createIntakeServer({ ...f.config, receiptKey: randomBytes(32) }), /Receipt key/);
  const reopened = createIntakeServer(f.config);
  f.cleanup.push(() => stop(reopened));
  const post = f.client(await listen(reopened));
  const reopenedRepeat = await post(intakePath, { method: 'POST', body: replay(), auth: f.rotated });
  assert.equal(reopenedRepeat.status, 200);
  assert.deepEqual(reopenedRepeat.body, first.body);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_contacts').get().n, 2);
    const stored = db.prepare('SELECT bytes, size FROM attachments WHERE position = 0 ORDER BY case_id').all();
    assert.deepEqual(Buffer.from(stored[0].bytes), png);
    assert.equal(stored[0].size, png.length);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 3);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (isMainThread) test('invalid multipart, fields, authentication and photos create no database rows', async t => {
  const f = await fixture(t);
  const duplicate = form();
  duplicate.append('payload', JSON.stringify(payload));
  const textPhoto = form();
  textPhoto.append('photos', 'text');
  const unexpected = form();
  unexpected.append('source', 'forged-source');
  const filePayload = new FormData();
  filePayload.append('payload', new Blob([JSON.stringify(payload)]), 'payload.json');
  const rows = [
    [form(), '', 401],
    [form(), token(), 401],
    [form(), f.duty, 403],
    ['{}', f.integration, 415],
    [duplicate, f.integration, 400],
    [unexpected, f.integration, 400],
    [filePayload, f.integration, 400],
    [form({ ...payload, description: '' }), f.integration, 400],
    [form({ ...payload, occurredAt: '2026-02-30T08:00:00Z' }), f.integration, 400],
    [form({ ...payload, contact: null }), f.integration, 400],
    [textPhoto, f.integration, 415],
    [form(payload, [{ ...photo, type: 'text/html' }]), f.integration, 415],
    [form(payload, [{ ...photo, bytes: Buffer.from('not an image') }]), f.integration, 415],
    [form(payload, [{ ...photo, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }]), f.integration, 413],
    [form(payload, Array(4).fill(photo)), f.integration, 413],
  ];
  for (const [body, auth, status] of rows) assert.equal((await f.submit(body, auth)).status, status);
  assert.equal((await f.get(intakePath, { auth: f.integration })).status, 405);
  inspect(f.config, db => assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 0));
});

if (isMainThread) test('attachment write failure rolls back case, contact, photos and event before retry', async t => {
  const f = await fixture(t);
  inspect(f.config, db => db.exec(`
    CREATE TRIGGER test_attachment_failure BEFORE INSERT ON attachments WHEN NEW.position = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END
  `));
  const rejected = await f.submit(form(payload, [photo, photo2]));
  assert.deepEqual([rejected.status, rejected.body], [500, { error: 'internal_error' }]);
  inspect(f.config, db => {
    const counts = db.prepare(`
      SELECT (SELECT count(*) FROM cases) AS cases, (SELECT count(*) FROM attachments) AS photos,
        (SELECT count(*) FROM case_contacts) AS contacts, (SELECT count(*) FROM case_events) AS events
    `).get();
    assert.deepEqual({ ...counts }, { cases: 0, photos: 0, contacts: 0, events: 0 });
    db.exec('DROP TRIGGER test_attachment_failure');
  });
  assert.equal((await f.submit(form(payload, [photo, photo2]))).status, 201);
});

if (isMainThread) test('a local SQLite backup restores the matched case, attachment and original receipt', async t => {
  const f = await fixture(t);
  const original = await f.submit(form(payload, [photo]));
  const restoredPath = f.config.dbPath + '.restore.sqlite';
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, restoredPath);
  } finally {
    source.close();
  }
  const restoredConfig = { ...f.config, dbPath: restoredPath };
  const restored = createIntakeServer(restoredConfig);
  f.cleanup.push(() => stop(restored));
  const request = f.client(await listen(restored));
  const replay = await request(intakePath, { method: 'POST', auth: f.integration, body: form(payload, [photo]) });
  assert.deepEqual([replay.status, replay.body], [200, original.body]);
  inspect(restoredConfig, db => {
    const row = db.prepare('SELECT case_number, bytes FROM attachments JOIN cases ON case_id = cases.id').get();
    assert.equal(row.case_number, original.body.caseNumber);
    assert.deepEqual(Buffer.from(row.bytes), png);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (isMainThread) test('anonymous lookup exposes exact public shape and uploaded bytes have no route', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit(form(payload, [photo]));
  const query = '/api/v1/public/cases/';
  const response = await f.get(query + receipt.publicLookupCode);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    caseNumber: receipt.caseNumber,
    status: 'submitted',
    milestones: [{ status: 'submitted', occurredAt: '2026-11-19T02:00:00.000Z' }],
  });
  for (const path of [query + token().slice(0, 24), query + receipt.privateLookupToken,
    query + receipt.publicLookupCode + '/attachments/0', '/.local/intake.sqlite']) {
    assert.equal((await f.get(path)).status, 404);
  }
  const { contact, suggestedDepartment, ...anonymous } = payload;
  const result = await f.submit(form({ ...anonymous, externalCaseId: 'synthetic-anonymous' }));
  assert.equal(result.status, 201);
});

if (isMainThread) test('role, owner and department gates protect the core workflow and history', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit();
  const path = '/api/v1/staff/cases/' + receipt.caseNumber;
  const action = (auth, name, expectedVersion, fields = {}) => f.get(path + '/actions', {
    auth, method: 'POST', body: JSON.stringify({ action: name, expectedVersion, ...fields }),
  });
  assert.equal((await f.get(path)).status, 401);
  assert.equal((await f.get(path, { auth: f.integration })).status, 403);
  assert.equal((await f.get(path, { auth: f.handler })).status, 404);
  assert.equal((await action(f.duty, 'start', 1)).status, 403);
  const assign = { assignee: 'handler-a', dueAt: '2026-11-20T10:00:00+08:00' };
  assert.equal((await action(f.duty, 'assign', 1, assign)).status, 409);
  assert.equal((await action(f.duty, 'accept', 1)).body.status, 'accepted');
  assert.equal((await action(f.duty, 'assign', 2, assign)).body.status, 'assigned');
  assert.equal((await action(f.unrelatedHandler, 'start', 3)).status, 404);
  assert.equal((await action(f.secondHandler, 'start', 3)).status, 404);
  assert.equal((await f.get(path, { auth: f.unrelatedSupervisor })).status, 404);
  assert.equal((await action(f.supervisor, 'reassign', 3, {
    ...assign, assignee: 'handler-b', reason: '合成转派',
  })).status, 403);
  assert.equal((await action(f.handler, 'start', 3)).body.status, 'processing');
  assert.equal((await action(f.duty, 'reassign', 4, {
    ...assign, assignee: 'handler-a2', reason: '合成转派',
  })).body.status, 'assigned');
  assert.equal((await f.get(path, { auth: f.handler })).status, 404);
  assert.equal((await action(f.secondHandler, 'start', 5)).body.status, 'processing');
  assert.equal((await action(f.secondHandler, 'submit_result', 6, { summary: '缺少照片说明' })).status, 400);
  const result = { summary: '合成处理说明', photoOmissionReason: '合成缺图原因' };
  assert.equal((await action(f.secondHandler, 'submit_result', 6, result)).body.status, 'awaiting_review');
  const publicPath = '/api/v1/public/cases/' + receipt.publicLookupCode;
  const publicBefore = await f.get(publicPath);
  assert.equal(publicBefore.body.status, 'processing');
  assert.equal(publicBefore.body.milestones.length, 6);
  assert.equal((await action(f.secondHandler, 'publish', 7, { summary: '合成发布说明' })).status, 403);
  assert.equal((await action(f.supervisor, 'return_result', 7, { reason: '合成退回' })).body.status, 'processing');
  assert.equal((await action(f.secondHandler, 'submit_result', 8, result)).status, 200);
  assert.equal((await action(f.supervisor, 'publish', 8, { summary: '过期操作' })).status, 409);
  assert.equal((await action(f.supervisor, 'publish', 9, { summary: '合成发布说明' })).body.status, 'awaiting_evaluation');
  assert.equal((await action(f.supervisor, 'close', 10, { reason: '合成结案' })).status, 409);
  f.advanceClock(10);
  const closed = await action(f.supervisor, 'close', 10, { reason: '合成结案' });
  assert.equal(closed.body.status, 'closed');
  assert.equal(closed.body.version, 11);
  assert.equal(closed.body.history.length, 11);
  assert.equal(Object.hasOwn(closed.body, 'contact'), false);
  assert.deepEqual(closed.body.history[4].detail, {
    reason: '合成转派', assignee: 'handler-a2', department: 'a', dueAt: '2026-11-20T02:00:00.000Z',
  });
  assert.deepEqual((await f.get(publicPath)).body, {
    caseNumber: receipt.caseNumber,
    status: 'closed',
    milestones: [
      'submitted', 'accepted', 'assigned', 'processing', 'assigned', 'processing', 'awaiting_evaluation', 'closed',
    ].map(status => ({ status, occurredAt: status === 'closed' ? '2026-11-19T02:00:10.000Z' : '2026-11-19T02:00:00.000Z' })),
  });
});

if (isMainThread) test('parallel listeners on separate SQLite connections share idempotency and version checks', async t => {
  const f = await fixture(t);
  const second = await secondListener(f);
  const submitters = Array.from({ length: 4 }, (_, index) => index % 2
    ? second(intakePath, { auth: f.integration, method: 'POST', body: form(payload, [photo]) })
    : f.submit(form(payload, [photo])));
  const results = await Promise.all(submitters);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 200, 201]);
  for (const result of results) assert.deepEqual(result.body, results[0].body);
  const path = '/api/v1/staff/cases/' + results[0].body.caseNumber + '/actions';
  const accept = { auth: f.duty, method: 'POST', body: JSON.stringify({ action: 'accept', expectedVersion: 1 }) };
  const race = await Promise.all([second(path, accept), f.get(path, accept)]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  const sourceId = { ...payload, externalCaseId: 'synthetic-concurrent-conflict' };
  const conflicting = await Promise.all([
    f.submit(form(sourceId)),
    second(intakePath, { auth: f.integration, method: 'POST', body: form({ ...sourceId, description: '不同正文' }) }),
  ]);
  assert.deepEqual(conflicting.map(result => result.status).sort(), [201, 409]);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_events').get().n, 3);
  });
});

if (isMainThread) test('owner verification grants only short-lived access to its case and published feedback', async t => {
  const f = await fixture(t);
  const { body: first } = await f.submit();
  const { body: second } = await f.submit(form({ ...payload, externalCaseId: 'synthetic-owner-other' }));
  const privatePath = ownerPath(first.caseNumber);
  const wrong = { error: 'invalid_private_lookup_token' };
  for (const credentials of [
    { ...first, privateLookupToken: token() },
    { ...first, privateLookupToken: first.privateLookupToken + '\n' },
    { ...first, privateLookupToken: second.privateLookupToken },
    { ...first, publicLookupCode: token().slice(0, 24) },
  ]) {
    const denied = await verify(f, credentials);
    assert.deepEqual([denied.status, denied.body], [401, wrong]);
  }
  assert.equal((await verify(f, first, { auth: f.integration })).status, 403);
  for (const auth of [undefined, first.publicLookupCode, first.privateLookupToken, f.integration, f.duty]) {
    assert.equal((await f.get(privatePath, { auth })).status, 401);
  }
  const verified = await verify(f, first);
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get('cache-control'), 'no-store');
  const { ownerSessionToken: auth, expiresAt } = verified.body;
  assert.equal(expiresAt, '2026-11-19T02:30:00.000Z');
  assert.equal((await f.get(ownerPath(second.caseNumber), { auth })).status, 401);
  assert.equal((await act(f, ownerPath(second.caseNumber), auth, 'confirm_resolved', 1)).status, 401);
  assert.equal((await f.get(staffPath(first.caseNumber), { auth })).status, 401);
  assert.equal((await f.get(privatePath + '?token=synthetic-placeholder')).status, 404);
  await prepareFeedback(f, first.caseNumber);
  const draft = await f.get(privatePath, { auth });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.rounds[0].feedback, null);
  assert.doesNotMatch(JSON.stringify(draft.body), /未发布|合成缺照|synthetic@example/);
  const published = await act(f, staffPath(first.caseNumber), f.supervisor, 'publish', 5, { summary: '已复核的处理说明' });
  assert.equal(published.status, 200);
  const detail = (await f.get(privatePath, { auth })).body;
  assert.equal(detail.rounds[0].feedback.summary, '已复核的处理说明');
  assert.deepEqual(detail.availableActions, ['evaluate', 'confirm_resolved', 'request_reopen']);
  assert.doesNotMatch(JSON.stringify((await f.get(publicPath(first.publicLookupCode), { auth })).body), /已复核|feedback|rounds/);
  f.advanceClock(1800);
  assert.equal((await f.get(privatePath, { auth })).status, 401);
  assert.equal((await verify(f, first)).status, 200);
});

if (isMainThread) test('failed verification budget is shared by listeners and cannot lock a case from another origin', async t => {
  const f = await fixture(t);
  const alternateListener = { get: await secondListener(f) };
  const { body: receipt } = await f.submit();
  const invalid = { ...receipt, privateLookupToken: token() };
  for (let index = 0; index < 10; index++) {
    const source = index % 2 ? alternateListener : f;
    assert.equal((await verify(source, invalid)).status, 401);
  }
  const blocked = await verify(f, receipt, { headers: { 'X-Forwarded-For': '127.0.0.2' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  const otherOriginStatus = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ publicLookupCode: receipt.publicLookupCode, privateLookupToken: receipt.privateLookupToken });
    const request = httpRequest(new URL(verifyPath, f.base), {
      method: 'POST',
      localAddress: '127.0.0.2',
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error('Loopback verification timed out')));
    request.once('error', reject);
    request.end(body);
  });
  assert.equal(otherOriginStatus, 200);
  assert.equal((await f.get(publicPath(receipt.publicLookupCode))).status, 200);
  f.advanceClock(900);
  assert.equal((await verify(f, receipt)).status, 200);
  inspect(f.config, db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_verify_attempts').get().n, 0));
});

if (isMainThread) test('concurrent evaluation stores one result per round, independently of confirming resolution', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit();
  const { body: { ownerSessionToken: auth } } = await verify(f, receipt);
  const internal = staffPath(receipt.caseNumber);
  const owner = ownerPath(receipt.caseNumber);
  await prepareFeedback(f, receipt.caseNumber);
  assert.equal((await act(f, internal, f.supervisor, 'publish', 5, { summary: '评价前已发布' })).status, 200);
  const scores = { speed: 4, effectiveness: 5, attitude: 3, comment: '合成意见' };
  assert.deepEqual((await act(f, owner, auth, 'evaluate', 6, { ...scores, attitude: 0 })).body, { error: 'invalid_rating' });
  const otherProcess = { get: await secondListener(f) };
  const race = await Promise.all([
    act(f, owner, auth, 'evaluate', 6, scores),
    act(otherProcess, owner, auth, 'evaluate', 6, scores),
  ]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  assert.equal((await act(f, owner, auth, 'evaluate', 7, scores)).body.error, 'evaluation_exists');
  const saved = race.find(result => result.status === 200).body;
  assert.equal(saved.status, 'awaiting_evaluation');
  assert.equal(saved.rounds[0].evaluation.effectiveness, 5);
  assert.equal(saved.rounds[0].evaluation.comment, '合成意见');
  const confirm = await act(f, owner, auth, 'confirm_resolved', 7);
  assert.equal(confirm.body.status, 'closed');
  assert.deepEqual(confirm.body.rounds, saved.rounds);
  assert.doesNotMatch(JSON.stringify((await f.get(publicPath(receipt.publicLookupCode))).body), /合成意见|"evaluation"|evaluate/);
  inspect(f.config, db => assert.equal(db.prepare('SELECT count(*) AS n FROM case_evaluations').get().n, 1));
  assert.equal((await act(f, owner, auth, 'request_reopen', 8, { reason: '合成补办' })).status, 200);
  const approval = await act(f, internal, f.supervisor, 'approve_reopen', 9, {
    assignee: 'handler-a', dueAt: '2026-11-20T10:00:00+08:00', nextStatus: 'assigned',
  });
  assert.equal(approval.body.status, 'assigned');
  assert.equal(approval.body.rounds[0].evaluation.speed, 4);
  assert.equal((await act(f, internal, f.handler, 'start', 10)).status, 200);
  assert.equal((await act(f, internal, f.handler, 'submit_result', 11, {
    summary: '新轮处置', photoOmissionReason: '合成缺照',
  })).status, 200);
  assert.equal((await act(f, internal, f.supervisor, 'publish', 12, { summary: '新轮反馈' })).status, 200);
  const nextRating = await act(f, owner, auth, 'evaluate', 13, { speed: 5, effectiveness: 5, attitude: 5 });
  assert.equal(nextRating.status, 200);
  assert.deepEqual(nextRating.body.rounds.map(round => round.evaluation.speed), [4, 5]);
});

if (isMainThread) test('reopen review can restore either prior state or start a new round under the same number', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit();
  const { body: { ownerSessionToken: auth } } = await verify(f, receipt);
  const owner = ownerPath(receipt.caseNumber);
  const internal = staffPath(receipt.caseNumber);
  await prepareFeedback(f, receipt.caseNumber);
  await act(f, internal, f.supervisor, 'publish', 5, { summary: '第一轮反馈' });
  const requested = await act(f, owner, auth, 'request_reopen', 6, { reason: '尚有合成问题' });
  assert.equal(requested.body.status, 'reopen_pending');
  assert.equal(requested.body.reopenRequests[0].previousStatus, 'awaiting_evaluation');
  assert.equal((await act(f, owner, auth, 'request_reopen', 7, { reason: '重复' })).status, 409);
  assert.equal((await act(f, internal, f.handler, 'reject_reopen', 7, { reason: '越权' })).status, 403);
  assert.equal((await act(f, internal, f.unrelatedSupervisor, 'reject_reopen', 7, { reason: '越权' })).status, 404);
  assert.equal((await act(f, internal, f.supervisor, 'reject_reopen', 7, { reason: '合成驳回' })).body.status, 'awaiting_evaluation');
  assert.equal((await f.get(owner, { auth })).body.reopenRequests[0].decisionReason, '合成驳回');
  const confirmed = await act(f, owner, auth, 'confirm_resolved', 8);
  assert.equal(confirmed.body.status, 'closed');
  assert.equal(confirmed.body.rounds[0].evaluation, null);
  const again = await act(f, owner, auth, 'request_reopen', 9, { reason: '办结后申请' });
  assert.equal(again.body.reopenRequests[1].previousStatus, 'closed');
  assert.equal((await act(f, internal, f.supervisor, 'reject_reopen', 10, { reason: '合成驳回二' })).body.status, 'closed');
  await act(f, owner, auth, 'request_reopen', 11, { reason: '合成新证据' });
  const transfer = { assignee: 'handler-a2', dueAt: '2026-11-20T11:00:00+08:00', nextStatus: 'processing' };
  assert.equal((await act(f, internal, f.supervisor, 'approve_reopen', 12, { ...transfer, assignee: 'handler-b' })).status, 403);
  const approval = await act(f, internal, f.supervisor, 'approve_reopen', 12, transfer);
  assert.equal(approval.body.status, 'processing');
  assert.equal(approval.body.round, 2);
  assert.equal(approval.body.caseNumber, receipt.caseNumber);
  assert.equal(approval.body.evaluationEndsAt, null);
  assert.equal(approval.body.reopenEndsAt, null);
  assert.equal(approval.body.reopenRequests[2].decision, 'approved');
  assert.equal((await act(f, internal, f.supervisor, 'approve_reopen', 12, transfer)).status, 409);
  assert.equal((await f.get(internal, { auth: f.handler })).status, 404);
  const roundTwo = (await f.get(owner, { auth })).body;
  assert.equal(roundTwo.rounds[0].feedback.summary, '第一轮反馈');
  assert.deepEqual(roundTwo.rounds[1], { round: 2, feedback: null, evaluation: null });
  assert.equal((await act(f, internal, f.secondHandler, 'submit_result', 13, {
    summary: '第二轮草稿', photoOmissionReason: '合成缺照',
  })).status, 200);
  assert.equal((await act(f, internal, f.supervisor, 'publish', 14, { summary: '第二轮反馈' })).status, 200);
  f.advanceClock(10);
  assert.equal((await act(f, owner, auth, 'evaluate', 15, {
    speed: 5, effectiveness: 5, attitude: 5,
  })).body.error, 'evaluation_window_expired');
  f.advanceClock(30);
  assert.equal((await act(f, owner, auth, 'request_reopen', 15, { reason: '逾期申请' })).body.error, 'reopen_window_expired');
  const publicDetail = (await f.get(publicPath(receipt.publicLookupCode))).body;
  assert.deepEqual(Object.keys(publicDetail), ['caseNumber', 'status', 'milestones']);
  assert.doesNotMatch(JSON.stringify(publicDetail), /合成驳回|第一轮反馈|合成新证据/);
});

if (isMainThread) test('v1 database upgrades with attachment, old receipt and published feedback intact', async t => {
  const f = await fixture(t);
  const migration = await readFile(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.legacy.sqlite' };
  const code = randomBytes(18).toString('base64url');
  const caseNumber = 'CD-' + 'A'.repeat(32);
  const sign = input => createHmac('sha256', legacy.receiptKey).update(input).digest('base64url');
  const oldReceipt = {
    caseNumber, publicLookupCode: code, privateLookupToken: sign('changdi-intake:private-lookup:v1:' + code),
  };
  const normalized = { ...payload, occurredAt: '2026-11-19T01:00:00.000Z' };
  const sha = createHash('sha256').update(png).digest('hex');
  const hash = createHash('sha256').update(JSON.stringify([normalized, ['image/png:' + sha]])).digest('hex');
  const publishedAt = '2026-11-19T01:59:55.000Z';
  inspect(legacy, db => {
    db.exec(migration);
    db.exec('PRAGMA user_version = 1');
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('receipt_key_check', sign('changdi-intake:verify-receipt-key:v1'));
    db.prepare(`
      INSERT INTO cases VALUES (1, 'platform-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_evaluation',
        6, 'a', 'handler-a', '2026-11-20T02:00:00.000Z', '2026-11-19T02:00:05.000Z')
    `).run(payload.externalCaseId, hash, caseNumber, code, normalized.occurredAt, payload.location,
      payload.category, payload.description, payload.suggestedDepartment);
    db.prepare('INSERT INTO case_contacts VALUES (1, ?)').run(payload.contact);
    db.prepare("INSERT INTO attachments VALUES (1, 0, 'image/png', ?, ?, ?)").run(png.length, sha, png);
    const insert = db.prepare('INSERT INTO case_events VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [version, action, status, actor, actorId, detail, visible] of [
      [1, 'submit', 'submitted', 'integration', 'platform-a', {}, 1],
      [2, 'accept', 'accepted', 'staff', 'dispatcher', {}, 1],
      [3, 'assign', 'assigned', 'staff', 'dispatcher', {}, 1],
      [4, 'start', 'processing', 'staff', 'handler-a', {}, 1],
      [5, 'submit_result', 'awaiting_review', 'staff', 'handler-a', { summary: '旧版未发布草稿' }, 0],
      [6, 'publish', 'awaiting_evaluation', 'staff', 'supervisor-a', { summary: '旧版已发布反馈' }, 1],
    ]) insert.run(version, action, status, actor, actorId, publishedAt, JSON.stringify(detail), visible);
  });
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const get = f.client(await listen(migrated));
  const replay = await get(intakePath, { method: 'POST', body: form(payload, [photo]), auth: f.integration });
  assert.deepEqual([replay.status, replay.body], [200, oldReceipt]);
  const verified = await verify({ get }, oldReceipt);
  assert.equal(verified.status, 200);
  const auth = verified.body.ownerSessionToken;
  const privatePath = ownerPath(caseNumber);
  const oldCase = (await get(privatePath, { auth })).body;
  assert.equal(oldCase.round, 1);
  assert.equal(oldCase.evaluationEndsAt, '2026-11-19T02:00:05.000Z');
  assert.equal(oldCase.reopenEndsAt, '2026-11-19T02:00:35.000Z');
  assert.deepEqual(oldCase.rounds[0].feedback, { publishedAt, summary: '旧版已发布反馈', photos: [] });
  assert.doesNotMatch(JSON.stringify(oldCase), /旧版未发布草稿/);
  assert.equal((await act({ get }, privatePath, auth, 'request_reopen', 6, { reason: '旧单可补办' })).status, 200);
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM attachments').get().bytes), png);
    assert.equal(db.prepare('SELECT contact FROM case_contacts').get().contact, payload.contact);
  });
});

if (isMainThread) test('merchant submission and read permissions are bound to its merchant and segregated from other roles', async t => {
  const f = await fixture(t);
  const { externalCaseId, suggestedDepartment, ...fields } = payload;
  const content = { ...fields, clientRequestId: externalCaseId };
  const submit = (auth, data = content) => f.get(merchantCases, { method: 'POST', auth, body: form(data, [photo]) });
  const identity = await f.get('/api/v1/merchant/me', { auth: f.shopA });
  assert.deepEqual(identity.body, { merchantId: 'shop-a', permissions: ['readCases', 'submitCases', 'collaborate'] });
  for (const unrelated of [f.integration, f.duty]) {
    assert.equal((await submit(unrelated)).status, 403);
    assert.equal((await f.get(merchantCases, { auth: unrelated })).status, 403);
  }
  assert.equal((await submit(f.shopAReader)).status, 403);
  assert.equal((await f.get(merchantCases, { auth: f.submitOnly })).status, 403);
  assert.equal((await submit(f.shopA, { ...content, merchantId: 'shop-b' })).status, 400);
  const partner = await f.submit();
  assert.equal(partner.status, 201);
  assert.equal((await f.submit(form(), f.shopA)).status, 403);
  const first = await submit(f.shopA);
  const second = await submit(f.shopB);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const { caseNumber } = first.body;
  assert.notEqual(caseNumber, second.body.caseNumber);
  assert.notEqual(caseNumber, partner.body.caseNumber);
  assert.deepEqual(Object.keys(first.body), ['caseNumber', 'status', 'submittedAt', 'publicLookupCode']);
  const retry = await submit(f.shopA);
  assert.deepEqual([retry.status, retry.body], [200, first.body]);
  assert.equal((await submit(f.shopA, { ...content, description: '不同正文' })).status, 409);
  const list = await f.get(merchantCases, { auth: f.shopAReader });
  assert.deepEqual(list.body, {
    items: [{ caseNumber, status: first.body.status, submittedAt: first.body.submittedAt }], nextBefore: null,
  });
  assert.deepEqual((await f.get(merchantCases + '?status=accepted', { auth: f.shopA })).body.items, []);
  assert.equal((await f.get(merchantCases + '?before=' + second.body.caseNumber, { auth: f.shopA })).status, 400);
  for (const number of [second.body.caseNumber, partner.body.caseNumber]) {
    assert.equal((await f.get(merchantCases + '/' + number, { auth: f.shopA })).status, 404);
  }
  assert.equal((await f.get(merchantCases + '/' + caseNumber, { auth: f.submitOnly })).status, 403);
  assert.equal((await f.get(ownerPath(caseNumber), { auth: f.shopA })).status, 401);
  const detail = await f.get(merchantCases + '/' + caseNumber, { auth: f.shopAReader });
  assert.equal(detail.body.description, payload.description);
  assert.doesNotMatch(JSON.stringify(detail.body), /synthetic@example|privateLookup|publicLookup|assignee|actorId/);
  assert.equal((await act(f, staffPath(caseNumber), f.shopA, 'accept', 1)).status, 403);
  const staff = await act(f, staffPath(caseNumber), f.duty, 'accept', 1);
  assert.equal(staff.body.sourceType, 'merchant');
  assert.equal((await f.get(merchantCases + '?status=accepted', { auth: f.shopA })).body.items[0].status, 'accepted');
  assert.deepEqual((await submit(f.shopA)).body, first.body);
  inspect(f.config, db => {
    const row = db.prepare(`
      SELECT m.merchant_id, m.submitted_by, a.bytes, p.contact FROM merchant_cases m
      JOIN attachments a ON a.case_id = m.case_id JOIN case_contacts p ON p.case_id = m.case_id
      JOIN cases c ON c.id = m.case_id WHERE c.case_number = ?
    `).get(caseNumber);
    assert.equal(row.merchant_id, 'shop-a');
    assert.equal(row.submitted_by, 'merchant-a');
    assert.equal(row.contact, payload.contact);
    assert.deepEqual(Buffer.from(row.bytes), png);
  });
});

if (isMainThread) test('collaboration scope, concurrency and review leave the main workflow under staff control', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit(form(payload, [photo]));
  const main = staffPath(receipt.caseNumber);
  const staffTasks = main + '/collaborations';
  const post = (path, auth, body, client = f) => client.get(path, { method: 'POST', auth, body: JSON.stringify(body) });
  const instructions = { merchantId: 'shop-a', instructions: '核查指定区域', location: '合成协办地点', dueAt: '2026-11-20T10:00:00+08:00' };
  const assign = (auth, expectedVersion, fields = {}) => post(staffTasks, auth, { ...instructions, ...fields, expectedVersion });
  assert.equal((await assign(f.duty, 1)).status, 409);
  assert.equal((await act(f, main, f.duty, 'accept', 1)).status, 200);
  assert.equal((await act(f, main, f.duty, 'assign', 2, {
    assignee: 'handler-a', dueAt: instructions.dueAt,
  })).status, 200);
  assert.equal((await assign(f.unrelatedSupervisor, 3)).status, 404);
  assert.equal((await assign(f.handler, 3)).status, 403);
  assert.equal((await assign(f.shopA, 3)).status, 403);
  assert.equal((await assign(f.duty, 3, { merchantId: 'shop-c' })).status, 400);
  const assigned = await assign(f.supervisor, 3);
  assert.equal(assigned.status, 201);
  const { taskId, caseVersion } = assigned.body;
  assert.equal(caseVersion, 4);
  assert.equal((await assign(f.supervisor, 3)).status, 409);
  const merchantTask = merchantTasks + '/' + taskId;
  const review = staffTasks + '/' + taskId + '/actions';
  const { body: otherCase } = await f.submit(form({ ...payload, externalCaseId: 'synthetic-other-assignment' }));
  assert.equal((await post(staffPath(otherCase.caseNumber) + '/collaborations/' + taskId + '/actions',
    f.duty, { action: 'approve', expectedVersion: 1 })).status, 403);
  await act(f, staffPath(otherCase.caseNumber), f.duty, 'accept', 1);
  await act(f, staffPath(otherCase.caseNumber), f.duty, 'assign', 2, {
    assignee: 'handler-a', dueAt: instructions.dueAt,
  });
  assert.equal((await post(staffPath(otherCase.caseNumber) + '/collaborations/' + taskId + '/actions',
    f.supervisor, { action: 'approve', expectedVersion: 1 })).status, 404);
  assert.equal((await f.get(merchantTasks, { auth: f.shopA })).body.items[0].taskId, taskId);
  assert.deepEqual((await f.get(merchantTasks, { auth: f.shopB })).body.items, []);
  assert.equal((await f.get(merchantTask, { auth: f.shopAReader })).status, 403);
  assert.equal((await f.get(merchantTask, { auth: f.shopB })).status, 404);
  assert.equal((await f.get(merchantTasks, { auth: f.integration })).status, 403);
  assert.equal((await f.get(merchantCases + '/' + receipt.caseNumber, { auth: f.shopA })).status, 404);
  const task = await f.get(merchantTask, { auth: f.shopA });
  assert.equal(task.body.location, instructions.location);
  assert.doesNotMatch(JSON.stringify(task.body), /synthetic@example|精确地址|合成测试正文|caseNumber|privateLookup|actorId/);
  assert.equal((await post(merchantTask + '/submissions', f.shopB, { expectedVersion: 1, summary: '越权' })).status, 404);
  assert.equal((await post(merchantTask + '/submissions', f.supervisor, { expectedVersion: 1, summary: '越权' })).status, 403);
  const second = { get: await secondListener(f) };
  const race = await Promise.all([f, second].map(client => post(
    merchantTask + '/submissions', f.shopA, { expectedVersion: 1, summary: '合成现场说明' }, client,
  )));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  assert.equal((await post(review, f.handler, { action: 'approve', expectedVersion: 2 })).status, 403);
  assert.equal((await post(review, f.shopA, { action: 'approve', expectedVersion: 2 })).status, 403);
  const returned = await post(review, f.supervisor, { action: 'return', expectedVersion: 2, reason: '请明确复查范围' });
  assert.equal(returned.body.status, 'returned');
  assert.equal((await f.get(merchantTask, { auth: f.shopA })).body.returnReason, '请明确复查范围');
  const resubmitted = await post(merchantTask + '/submissions', f.shopA, { expectedVersion: 3, summary: '补充说明' });
  assert.equal(resubmitted.body.status, 'awaiting_review');
  assert.equal((await post(review, f.supervisor, { action: 'approve', expectedVersion: 3 })).status, 409);
  const approved = await post(review, f.supervisor, { action: 'approve', expectedVersion: 4 });
  assert.equal(approved.body.status, 'approved');
  assert.deepEqual(approved.body.history.map(event => event.action), ['assign', 'submit', 'return', 'submit', 'approve']);
  assert.deepEqual((await f.get(merchantTasks, { auth: f.shopA })).body.items, []);
  const unchanged = await f.get(main, { auth: f.supervisor });
  assert.deepEqual([unchanged.body.status, unchanged.body.version], ['assigned', 4]);
  const another = await assign(f.duty, 4);
  assert.equal(another.status, 201);
  const withdrawn = await post(staffTasks + '/' + another.body.taskId + '/actions', f.supervisor,
    { action: 'withdraw', expectedVersion: 1, reason: '任务合并' });
  assert.equal(withdrawn.body.status, 'withdrawn');
  assert.equal((await f.get(merchantTasks + '/' + another.body.taskId, { auth: f.shopA })).status, 404);
  const pending = await assign(f.duty, 5);
  assert.equal(pending.status, 201);
  assert.equal((await act(f, main, f.duty, 'reassign', 6, {
    assignee: 'handler-b', dueAt: instructions.dueAt, reason: '合成跨部门转派',
  })).status, 200);
  assert.equal((await f.get(staffTasks, { auth: f.supervisor })).status, 404);
  assert.equal((await f.get(staffTasks, { auth: f.unrelatedSupervisor })).body.items.length, 3);
  assert.equal((await act(f, main, f.unrelatedHandler, 'start', 7)).status, 200);
  assert.equal((await act(f, main, f.unrelatedHandler, 'submit_result', 8, {
    summary: '合成处置情况', photoOmissionReason: '合成缺照原因',
  })).status, 200);
  assert.equal((await act(f, main, f.unrelatedSupervisor, 'publish', 9, { summary: '合成发布反馈' })).status, 200);
  assert.equal((await f.get(merchantTasks + '/' + pending.body.taskId, { auth: f.shopA })).status, 404);
  assert.deepEqual((await f.get(merchantTasks, { auth: f.shopA })).body.items, []);
  const anonymous = await f.get(publicPath(receipt.publicLookupCode));
  assert.equal(anonymous.body.status, 'awaiting_evaluation');
  assert.doesNotMatch(JSON.stringify(anonymous.body), /核查指定区域|合作|补充说明|CT-/);
});

if (isMainThread) test('upgrade from v2 preserves existing cases, ratings, receipts and attachments', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit(form(payload, [photo]));
  const { body: { ownerSessionToken: auth } } = await verify(f, receipt);
  await prepareFeedback(f, receipt.caseNumber);
  await act(f, staffPath(receipt.caseNumber), f.supervisor, 'publish', 5, { summary: '升级前反馈' });
  const before = await act(f, ownerPath(receipt.caseNumber), auth, 'evaluate', 6,
    { speed: 4, effectiveness: 5, attitude: 5, comment: '升级前评价' });
  assert.equal(before.status, 200);
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v2.sqlite' };
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, legacy.dbPath);
  } finally {
    source.close();
  }
  // Remove tables introduced later so the disposable backup exercises the v2 upgrade branch.
  inspect(legacy, db => db.exec(`
    DROP TABLE wechat_receipt_codes;
    DROP TABLE owner_supplement_photos;
    DROP TABLE collaboration_submission_photos;
    DROP TABLE published_feedback_photos;
    DROP TABLE staff_submission_photos;
    DROP TABLE collaboration_events;
    DROP TABLE collaboration_tasks;
    DROP TABLE merchant_cases;
    DROP TABLE representative_report_releases;
    DROP TABLE tourism_event_ids;
    DROP TABLE tourism_events;
    DROP VIEW current_case_supervision;
    DROP TABLE case_supervision_events;
    DROP TABLE remediation_reviews;
    DROP TABLE remediation_entries;
    DROP TABLE case_contact_access_audit;
    PRAGMA user_version = 2;
  `));
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const get = f.client(await listen(migrated));
  assert.deepEqual((await get(ownerPath(receipt.caseNumber), { auth })).body, before.body);
  const replay = await get(intakePath, { method: 'POST', auth: f.integration, body: form(payload, [photo]) });
  assert.deepEqual([replay.status, replay.body], [200, receipt]);
  assert.deepEqual((await get(merchantCases, { auth: f.shopA })).body, { items: [], nextBefore: null });
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM attachments').get().bytes), png);
  });
});

async function workbenchCase(f, key, options = {}) {
  const { assignee, handler, dueMs = 120_000, status = 'assigned' } = options;
  const result = await f.submit(form({ ...payload, externalCaseId: 'synthetic-workbench-' + key }, options.photos));
  assert.equal(result.status, 201);
  const receipt = result.body;
  const path = staffPath(receipt.caseNumber);
  if (status === 'submitted') return receipt;
  assert.equal((await act(f, path, f.duty, 'accept', 1)).status, 200);
  if (status === 'accepted') return receipt;
  assert.equal((await act(f, path, f.duty, 'assign', 2, {
    assignee, dueAt: new Date(f.now().valueOf() + dueMs).toISOString(),
  })).status, 200);
  if (status === 'assigned') return receipt;
  assert.equal((await act(f, path, handler, 'start', 3)).status, 200);
  if (status === 'processing') return receipt;
  assert.equal((await act(f, path, handler, 'submit_result', 4, {
    summary: '合成承办细节', photoOmissionReason: '合成缺照',
  })).status, 200);
  if (status === 'awaiting_review') return receipt;
  assert.equal((await act(f, path, f.supervisor, 'publish', 5, { summary: '合成已发布反馈' })).status, 200);
  if (status === 'awaiting_evaluation') return receipt;
  const { body: { ownerSessionToken: owner } } = await verify(f, receipt);
  if (status === 'closed') {
    assert.equal((await act(f, ownerPath(receipt.caseNumber), owner, 'confirm_resolved', 6)).status, 200);
  } else {
    assert.equal((await act(f, ownerPath(receipt.caseNumber), owner, 'request_reopen', 6, {
      reason: '合成补办理由',
    })).status, 200);
  }
  return receipt;
}

if (isMainThread) test('staff entry and assignee directory are safe and scoped to the caller role', async t => {
  const f = await fixture(t);
  const me = '/api/v1/staff/me';
  const directory = '/api/v1/staff/assignees';
  for (const path of [me, directory, workbench, staffCases]) {
    assert.equal((await f.get(path)).status, 401);
    for (const auth of [f.integration, f.shopA]) assert.equal((await f.get(path, { auth })).status, 403);
  }
  for (const [auth, expected] of [
    [f.duty, { id: 'dispatcher', role: 'duty', department: null }],
    [f.supervisor, { id: 'supervisor-a', role: 'supervisor', department: 'a' }],
    [f.handler, { id: 'handler-a', role: 'handler', department: 'a' }],
  ]) {
    const identity = await f.get(me, { auth });
    assert.deepEqual(identity.body, expected);
    assert.equal(identity.headers.get('cache-control'), 'no-store');
  }
  const a = [{ id: 'handler-a', department: 'a' }, { id: 'handler-a2', department: 'a' }];
  const b = [{ id: 'handler-b', department: 'b' }];
  for (const [auth, items] of [[f.duty, [...a, ...b]], [f.supervisor, a], [f.unrelatedSupervisor, b]]) {
    const response = await f.get(directory, { auth });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { items });
  }
  assert.equal((await f.get(directory, { auth: f.handler })).status, 403);
});

if (isMainThread) test('staff queues share visibility, counts and inclusive deadline boundaries', async t => {
  const f = await fixture(t);
  await workbenchCase(f, 'submitted', { status: 'submitted' });
  await workbenchCase(f, 'accepted', { status: 'accepted' });
  const a = { assignee: 'handler-a', handler: f.handler };
  const a2 = { assignee: 'handler-a2', handler: f.secondHandler };
  const b = { assignee: 'handler-b', handler: f.unrelatedHandler };
  const past = await workbenchCase(f, 'past', { ...a, dueMs: 30_000 });
  const exact = await workbenchCase(f, 'exact', { ...a2, dueMs: 60_000, status: 'processing' });
  const justAfter = await workbenchCase(f, 'after', { ...a, dueMs: 60_001, status: 'awaiting_review' });
  const horizon = await workbenchCase(f, 'horizon', { ...b, dueMs: 86_460_000 });
  const outside = await workbenchCase(f, 'outside', { ...b, dueMs: 86_460_001, status: 'processing' });
  const reopen = await workbenchCase(f, 'reopen', { ...a, dueMs: 1000, status: 'reopen_pending' });
  const closed = await workbenchCase(f, 'closed', { ...a, dueMs: 1000, status: 'closed' });
  const evaluation = await workbenchCase(f, 'evaluation', { ...a, dueMs: 1000, status: 'awaiting_evaluation' });
  f.advanceClock(60);
  const asOf = '2026-11-19T02:01:00.000Z';
  const queueNames = ['pending_intake', 'pending_assignment', 'processing', 'pending_review', 'pending_reopen', 'due_soon', 'overdue'];
  const rows = async (auth, queue) => {
    const result = await f.get(staffCases + '?queue=' + queue, { auth });
    assert.equal(result.status, 200);
    assert.equal(result.body.asOf, asOf);
    return result.body.items;
  };
  for (const [auth, expected] of [
    [f.duty, [1, 1, 4, 1, 1, 2, 2]],
    [f.supervisor, [0, 0, 2, 1, 1, 1, 2]],
    [f.handler, [0, 0, 1, 1, 1, 1, 1]],
    [f.secondHandler, [0, 0, 1, 0, 0, 0, 1]],
    [f.unrelatedSupervisor, [0, 0, 2, 0, 0, 1, 0]],
  ]) {
    const result = await f.get(workbench, { auth });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      asOf, dueSoonSeconds: 86400, counts: Object.fromEntries(queueNames.map((name, index) => [name, expected[index]])),
    });
    for (const [index, queue] of queueNames.entries()) {
      assert.equal((await rows(auth, queue)).length, expected[index]);
    }
  }
  assert.deepEqual((await rows(f.duty, 'overdue')).map(item => item.caseNumber), [exact.caseNumber, past.caseNumber]);
  assert.deepEqual((await rows(f.duty, 'due_soon')).map(item => item.caseNumber), [horizon.caseNumber, justAfter.caseNumber]);
  const all = (await f.get(staffCases, { auth: f.duty })).body.items;
  for (const receipt of [closed, evaluation, reopen]) {
    const item = all.find(candidate => candidate.caseNumber === receipt.caseNumber);
    assert.deepEqual([item.dueAt, item.deadlineState], [null, null]);
  }
  assert.equal(all.find(item => item.caseNumber === outside.caseNumber).deadlineState, 'on_track');
  assert.deepEqual(Object.keys(all[0]), ['caseNumber', 'status', 'category', 'sourceType', 'department', 'assignee', 'dueAt', 'deadlineState']);
  assert.doesNotMatch(JSON.stringify(all), /合成测试正文|精确地址|synthetic@example|privateLookup|合成已发布反馈/);
  f.advanceClock(0.001);
  const nowOverdue = await f.get(staffCases + '?queue=overdue', { auth: f.duty });
  assert.equal(nowOverdue.body.asOf, '2026-11-19T02:01:00.001Z');
  assert.equal(nowOverdue.body.items[0].caseNumber, justAfter.caseNumber);
  assert.equal((await f.get(staffCases + '?queue=due_soon', { auth: f.duty })).body.items[0].caseNumber, outside.caseNumber);
});

if (isMainThread) test('staff list filters and live keyset cursors cannot widen detail scope', async t => {
  const f = await fixture(t);
  const a = { assignee: 'handler-a' };
  const first = await workbenchCase(f, 'page-1', a);
  const hidden = await workbenchCase(f, 'page-hidden', { assignee: 'handler-b' });
  const second = await workbenchCase(f, 'page-2', a);
  const third = await workbenchCase(f, 'page-3', { assignee: 'handler-a2' });
  const page = async (auth, query) => f.get(staffCases + '?' + query, { auth });
  const query = 'status=assigned&department=a&limit=2';
  const firstPage = await page(f.supervisor, query);
  assert.equal(firstPage.status, 200);
  assert.deepEqual(firstPage.body.items.map(item => item.caseNumber), [third.caseNumber, second.caseNumber]);
  assert.equal(firstPage.body.nextBefore, second.caseNumber);
  const newest = await workbenchCase(f, 'page-new', a);
  assert.equal((await act(f, staffPath(second.caseNumber), f.handler, 'start', 3)).status, 200);
  const next = await page(f.supervisor, query + '&before=' + firstPage.body.nextBefore);
  assert.deepEqual(next.body.items.map(item => item.caseNumber), [first.caseNumber]);
  assert.equal(next.body.nextBefore, null);
  assert.equal((await page(f.supervisor, query)).body.items[0].caseNumber, newest.caseNumber);
  assert.deepEqual((await page(f.supervisor, 'department=b')).body.items, []);
  assert.deepEqual((await page(f.handler, 'assignee=handler-a2')).body.items, []);
  assert.deepEqual((await page(f.handler, 'assignee=handler-a')).body.items.map(item => item.caseNumber),
    [newest.caseNumber, second.caseNumber, first.caseNumber]);
  for (const restricted of [hidden.caseNumber, third.caseNumber, 'CD-' + '0'.repeat(32)]) {
    assert.deepEqual((await page(f.handler, 'before=' + restricted)).body, { error: 'invalid_cursor' });
    assert.equal((await f.get(staffPath(restricted), { auth: f.handler })).status, 404);
  }
  assert.equal((await f.get(staffPath(third.caseNumber), { auth: f.supervisor })).status, 200);
  for (const invalid of ['status=bad', 'queue=__proto__', 'limit=0', 'limit=51', 'limit=1.5',
    'department=a&department=b', 'role=duty']) {
    assert.equal((await page(f.handler, invalid)).status, 400);
  }
  assert.equal((await act(f, staffPath(second.caseNumber), f.duty, 'reassign', 4, {
    assignee: 'handler-b', dueAt: '2026-11-20T10:00:00+08:00', reason: '合成转派',
  })).status, 200);
  const stale = await page(f.supervisor, 'before=' + second.caseNumber);
  assert.deepEqual([stale.status, stale.body], [400, { error: 'invalid_cursor' }]);
  assert.equal((await f.get(staffPath(second.caseNumber), { auth: f.supervisor })).status, 404);
  assert.equal((await f.get(staffPath(second.caseNumber), { auth: f.unrelatedSupervisor })).status, 200);
});

if (isMainThread) test('supplement requirements and submissions stay scoped and return the original case to intake', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit(form(payload, [photo]));
  const { body: other } = await f.submit(form({ ...payload, externalCaseId: 'synthetic-other-supplement' }));
  const { body: { ownerSessionToken: originalOwner } } = await verify(f, receipt);
  const { body: { ownerSessionToken: otherOwner } } = await verify(f, other);
  const staff = staffPath(receipt.caseNumber);
  const owner = ownerPath(receipt.caseNumber);
  const reason = '合成补件要求，请说明具体时段';
  const summary = '合成补充说明，相关时段为上午';
  const intakeCount = async () => (await f.get(workbench, { auth: f.duty })).body.counts.pending_intake;
  const queuedNumbers = async () => (await f.get(staffCases + '?queue=pending_intake', { auth: f.duty }))
    .body.items.map(item => item.caseNumber);
  assert.equal(await intakeCount(), 2);
  assert.equal((await act(f, staff, f.integration, 'request_supplement', 1, { reason })).status, 403);
  for (const auth of [f.handler, f.supervisor]) {
    assert.equal((await act(f, staff, auth, 'request_supplement', 1, { reason })).status, 404);
  }
  assert.deepEqual((await act(f, staff, f.duty, 'request_supplement', 1, { reason: ' ' })).body, { error: 'invalid_field' });
  assert.deepEqual((await act(f, owner, originalOwner, 'submit_supplement', 1, { summary })).body,
    { error: 'invalid_transition' });

  const requested = await act(f, staff, f.duty, 'request_supplement', 1, { reason });
  assert.equal(requested.status, 200);
  assert.deepEqual([requested.body.caseNumber, requested.body.status, requested.body.version],
    [receipt.caseNumber, 'awaiting_supplement', 2]);
  assert.deepEqual(requested.body.history.at(-1).detail, { reason });
  assert.equal(await intakeCount(), 1);
  assert.deepEqual(await queuedNumbers(), [other.caseNumber]);
  const filtered = await f.get(staffCases + '?status=awaiting_supplement', { auth: f.duty });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.items.map(item => item.caseNumber), [receipt.caseNumber]);
  assert.doesNotMatch(JSON.stringify(filtered.body), /补件要求|synthetic@example/);
  assert.deepEqual((await act(f, staff, f.duty, 'accept', 2)).body, { error: 'invalid_transition' });
  assert.deepEqual((await act(f, staff, f.duty, 'request_supplement', 1, { reason })).body, { error: 'stale_version' });
  const detail = await f.get(owner, { auth: originalOwner });
  assert.deepEqual(detail.body.availableActions, ['submit_supplement']);
  assert.deepEqual(detail.body.supplementRequirement, { reason, requestedAt: f.now().toISOString() });
  assert.equal(detail.body.history.at(-1).reason, reason);
  assert.doesNotMatch(JSON.stringify(detail.body), /synthetic@example/);
  assert.deepEqual((await f.get(publicPath(receipt.publicLookupCode))).body, {
    caseNumber: receipt.caseNumber, status: 'awaiting_supplement',
    milestones: ['submitted', 'awaiting_supplement'].map(status => ({ status, occurredAt: f.now().toISOString() })),
  });

  for (const auth of [undefined, f.integration, f.duty, otherOwner, receipt.privateLookupToken]) {
    assert.equal((await act(f, owner, auth, 'submit_supplement', 2, { summary })).status, 401);
  }
  f.advanceClock(1800);
  assert.equal((await act(f, owner, originalOwner, 'submit_supplement', 2, { summary })).status, 401);
  const { body: { ownerSessionToken: renewed } } = await verify(f, receipt);
  assert.deepEqual((await act(f, owner, renewed, 'submit_supplement', 2, { summary: ' ' })).body, { error: 'invalid_field' });
  assert.deepEqual((await act(f, owner, renewed, 'submit_supplement', 2, { summary, photos: ['synthetic'] })).body,
    { error: 'unknown_field' });
  const second = { get: await secondListener(f) };
  const race = await Promise.all([f, second].map(client => act(client, owner, renewed, 'submit_supplement', 2, { summary })));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  const winner = race.find(result => result.status === 200).body;
  assert.deepEqual([winner.caseNumber, winner.status, winner.version, winner.round, winner.supplementRequirement],
    [receipt.caseNumber, 'submitted', 3, 1, null]);
  assert.equal(winner.history.at(-1).summary, summary);
  assert.deepEqual(winner.availableActions, []);
  assert.deepEqual((await act(f, owner, renewed, 'submit_supplement', 2, { summary })).body, { error: 'stale_version' });
  assert.deepEqual((await act(f, owner, renewed, 'submit_supplement', 3, { summary })).body, { error: 'invalid_transition' });
  assert.equal(await intakeCount(), 2);
  assert.deepEqual(await queuedNumbers(), [other.caseNumber, receipt.caseNumber]);
  const staffView = await f.get(staff, { auth: f.duty });
  assert.deepEqual(staffView.body.history.slice(-2).map(event => event.detail), [{ reason }, { summary }]);
  const publicView = (await f.get(publicPath(receipt.publicLookupCode))).body;
  assert.deepEqual(Object.keys(publicView), ['caseNumber', 'status', 'milestones']);
  assert.deepEqual(publicView.milestones.map(node => node.status), ['submitted', 'awaiting_supplement', 'submitted']);
  assert.doesNotMatch(JSON.stringify(publicView), /补件要求|补充说明|synthetic@example/);

  assert.equal((await act(f, staff, f.duty, 'request_supplement', 3, { reason: '合成第二次补件要求' })).status, 200);
  const next = await act(f, owner, renewed, 'submit_supplement', 4, { summary: '合成第二次补充说明' });
  assert.equal(next.status, 200);
  assert.deepEqual(next.body.history.filter(event => event.action === 'submit_supplement').map(event => event.summary),
    [summary, '合成第二次补充说明']);
  assert.equal((await act(f, staff, f.duty, 'accept', 5)).body.status, 'accepted');
  const retry = await f.submit(form(payload, [photo]));
  assert.deepEqual([retry.status, retry.body], [200, receipt]);
});

if (isMainThread) test('merchant cases cannot be stranded by a supplement request without claimant authorization', async t => {
  const f = await fixture(t);
  const { externalCaseId, suggestedDepartment, ...fields } = payload;
  const created = await f.get(merchantCases, {
    auth: f.shopA, method: 'POST', body: form({ ...fields, clientRequestId: externalCaseId }),
  });
  assert.equal(created.status, 201);
  const path = staffPath(created.body.caseNumber);
  const request = await act(f, path, f.duty, 'request_supplement', 1, { reason: '合成商户补件要求' });
  assert.deepEqual([request.status, request.body], [409, { error: 'supplement_owner_unavailable' }]);
  assert.equal((await act(f, ownerPath(created.body.caseNumber), f.shopA, 'submit_supplement', 1, {
    summary: '合成商户说明',
  })).status, 401);
  assert.equal((await act(f, path, f.duty, 'accept', 1)).body.status, 'accepted');
});

if (isMainThread) test('v3 schema upgrades with merchant bindings, attachments and collaboration and reopen audits intact', async t => {
  const f = await fixture(t);
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v3.sqlite' };
  const schemas = await Promise.all(['001-initial.sql', '002-owner-workflow.sql', '003-merchants.sql']
    .map(file => readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')));
  const code = randomBytes(18).toString('base64url');
  const caseNumber = 'CD-' + '1'.repeat(32);
  const merchantNumber = 'CD-' + '2'.repeat(32);
  const taskId = 'CT-' + '3'.repeat(32);
  const at = f.now().toISOString();
  const due = '2026-11-20T02:00:00.000Z';
  const sign = text => createHmac('sha256', legacy.receiptKey).update(text).digest('base64url');
  const receipt = { caseNumber, publicLookupCode: code, privateLookupToken: sign('changdi-intake:private-lookup:v1:' + code) };
  const normalized = { ...payload, occurredAt: '2026-11-19T01:00:00.000Z' };
  const sha = createHash('sha256').update(png).digest('hex');
  const hash = createHash('sha256').update(JSON.stringify([normalized, ['image/png:' + sha]])).digest('hex');
  inspect(legacy, db => {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const schema of schemas) db.exec(schema);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA user_version = 3;');
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('receipt_key_check', sign('changdi-intake:verify-receipt-key:v1'));
    db.prepare(`
      INSERT INTO cases (id, source, external_case_id, submission_hash, case_number, public_lookup_code,
        occurred_at, location, category, description, suggested_department, status, version, department, assignee, due_at, round)
      VALUES (1, 'platform-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', 11, 'a', 'handler-a', ?, 2)
    `).run(payload.externalCaseId, hash, caseNumber, code, normalized.occurredAt, payload.location, payload.category,
      payload.description, payload.suggestedDepartment, due);
    db.prepare(`
      INSERT INTO cases (id, source, external_case_id, submission_hash, case_number, public_lookup_code,
        occurred_at, location, category, description, status)
      SELECT 2, 'merchant:shop-a:merchant-a', 'synthetic-old-shop', 'synthetic', ?, ?,
        occurred_at, location, category, description, 'submitted' FROM cases WHERE id = 1
    `).run(merchantNumber, randomBytes(18).toString('base64url'));
    db.exec("INSERT INTO merchant_cases VALUES (2, 'shop-a', 'merchant-a')");
    db.prepare('INSERT INTO case_contacts VALUES (1, ?)').run(payload.contact);
    db.prepare("INSERT INTO attachments VALUES (1, 0, 'image/png', ?, ?, ?)").run(png.length, sha, png);
    const event = db.prepare('INSERT INTO case_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [version, action, status, actor, id, detail, visible, round] of [
      [1, 'submit', 'submitted', 'integration', 'platform-a', {}, 1, 1],
      [2, 'accept', 'accepted', 'staff', 'dispatcher', {}, 1, 1],
      [3, 'assign', 'assigned', 'staff', 'dispatcher', {}, 1, 1],
      [4, 'start', 'processing', 'staff', 'handler-a', {}, 1, 1],
      [5, 'submit_result', 'awaiting_review', 'staff', 'handler-a', {}, 0, 1],
      [6, 'publish', 'awaiting_evaluation', 'staff', 'supervisor-a', { summary: '旧轮已发布' }, 1, 1],
      [7, 'evaluate', 'awaiting_evaluation', 'owner', 'claimant', {}, 0, 1],
      [8, 'confirm_resolved', 'closed', 'owner', 'claimant', {}, 1, 1],
      [9, 'request_reopen', 'reopen_pending', 'owner', 'claimant', {}, 1, 1],
      [10, 'approve_reopen', 'assigned', 'staff', 'supervisor-a', {}, 1, 2],
      [11, 'assign_collaboration', 'assigned', 'staff', 'dispatcher', {}, 0, 2],
    ]) event.run(1, version, action, status, actor, id, at, JSON.stringify(detail), visible, round);
    event.run(2, 1, 'submit', 'submitted', 'owner', 'merchant-a', at, '{}', 1, 1);
    db.prepare('INSERT INTO case_evaluations VALUES (1, 1, 5, 4, 3, ?, ?)').run('旧轮评价', at);
    db.prepare(`
      INSERT INTO reopen_requests (case_id, requested_version, round, previous_status, reason, requested_at,
        decision, decided_at, decided_by)
      VALUES (1, 9, 1, 'closed', ?, ?, 'approved', ?, 'supervisor-a')
    `).run('旧轮补办', at, at);
    db.prepare(`
      INSERT INTO collaboration_tasks (id, task_id, case_id, round, merchant_id, instructions, due_at,
        status, version, latest_submission)
      VALUES (1, ?, 1, 2, 'shop-a', ?, ?, 'awaiting_review', 2, ?)
    `).run(taskId, '旧协办任务', due, '旧协办说明');
    const taskEvent = db.prepare('INSERT INTO collaboration_events VALUES (1, ?, ?, ?, ?, ?, ?)');
    taskEvent.run(1, 'assign', 'staff', 'dispatcher', at, '{}');
    taskEvent.run(2, 'submit', 'merchant', 'merchant-a', at, JSON.stringify({ summary: '旧协办说明' }));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const get = f.client(await listen(migrated));
  const retry = await get(intakePath, { method: 'POST', auth: f.integration, body: form(payload, [photo]) });
  assert.deepEqual([retry.status, retry.body], [200, receipt]);
  const { body: owner } = await verify({ get }, receipt);
  const details = await get(ownerPath(caseNumber), { auth: owner.ownerSessionToken });
  assert.equal(details.body.version, 11);
  assert.equal(details.body.round, 2);
  assert.equal(details.body.rounds[0].feedback.summary, '旧轮已发布');
  assert.equal(details.body.rounds[0].evaluation.comment, '旧轮评价');
  assert.equal(details.body.reopenRequests[0].decision, 'approved');
  assert.equal(details.body.reopenRequests[0].reason, '旧轮补办');
  const ownCases = await get(merchantCases, { auth: f.shopA });
  assert.deepEqual(ownCases.body.items.map(item => item.caseNumber), [merchantNumber]);
  const collaborations = staffPath(caseNumber) + '/collaborations';
  const tasks = await get(collaborations, { auth: f.supervisor });
  assert.equal(tasks.body.items[0].history[1].detail.summary, '旧协办说明');
  const reviewed = await get(collaborations + '/' + taskId + '/actions', {
    auth: f.supervisor, method: 'POST', body: JSON.stringify({ action: 'approve', expectedVersion: 2 }),
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.history.at(-1).action, 'approve');
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM attachments').get().bytes), png);
    assert.equal(db.prepare('SELECT contact FROM case_contacts').get().contact, payload.contact);
  });
});

const resultPhotoPath = (caseNumber, version, position = 0) => staffPath(caseNumber) + '/submission-photos/' + version + '/' + position;

function uploadResult(client, caseNumber, auth, expectedVersion, photos = [photo], extra = {}) {
  return client.get(staffPath(caseNumber) + '/actions', {
    auth, method: 'POST',
    body: form({ action: 'submit_result', expectedVersion, summary: '合成现场处置说明', ...extra }, photos),
  });
}

async function getPhoto(base, path, auth) {
  const response = await fetch(base + path, { headers: auth ? { Authorization: 'Bearer ' + auth } : {} });
  const body = response.status === 200 ? Buffer.from(await response.arrayBuffer()) : await response.json();
  return { status: response.status, body, headers: response.headers };
}

if (isMainThread) test('staff photo submission is readable only by current handler and supervising department after transfer', async t => {
  const f = await fixture(t);
  const receipt = await workbenchCase(f, 'staff-photos', {
    assignee: 'handler-a', handler: f.handler, status: 'processing',
  });
  const { caseNumber } = receipt;
  const path = staffPath(caseNumber);
  const url = resultPhotoPath(caseNumber, 5);
  const { body: { ownerSessionToken } } = await verify(f, receipt);

  for (const [auth, expected] of [[f.integration, 403], [f.shopA, 403], [f.duty, 403],
    [f.supervisor, 403], [f.secondHandler, 404], [f.unrelatedHandler, 404], [ownerSessionToken, 401]]) {
    assert.equal((await uploadResult(f, caseNumber, auth, 4)).status, expected);
  }
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, [])).body.error, 'photos_required');
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, [photo], { action: 'start' })).body.error, 'invalid_action');
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, [photo], { photoOmissionReason: '合成' })).body.error, 'unknown_field');
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, [
    { ...photo, bytes: Buffer.from('synthetic unsupported bytes') },
  ])).status, 415);
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, Array(4).fill(photo))).status, 413);
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, [
    { ...photo, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) },
  ])).status, 413);
  assert.equal((await act(f, path, f.handler, 'submit_result', 4, { summary: '缺少照片原因' })).status, 400);

  const submitted = await uploadResult(f, caseNumber, f.handler, 4, [photo, photo2]);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'awaiting_review');
  assert.equal(submitted.body.version, 5);
  assert.deepEqual(submitted.body.submissionPhotos, [
    { round: 1, submitVersion: 5, position: 0, mediaType: 'image/png', size: png.length },
    { round: 1, submitVersion: 5, position: 1, mediaType: 'image/jpeg', size: jpeg.length },
  ]);
  assert.deepEqual(submitted.body.history.at(-1).detail, { summary: '合成现场处置说明' });
  for (const auth of [f.handler, f.supervisor]) {
    const read = await getPhoto(f.base, url, auth);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, png);
    assert.equal(read.headers.get('content-type'), 'image/png');
    assert.equal(read.headers.get('content-disposition'), 'attachment');
    assert.equal(read.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual((await getPhoto(f.base, resultPhotoPath(caseNumber, 5, 1), f.supervisor)).body, jpeg);
  for (const [auth, expected] of [[undefined, 401], [f.integration, 403], [f.shopA, 403], [f.duty, 403],
    [f.secondHandler, 404], [f.unrelatedSupervisor, 404], [ownerSessionToken, 401]]) {
    assert.equal((await getPhoto(f.base, url, auth)).status, expected);
  }
  assert.equal((await getPhoto(f.base, resultPhotoPath(caseNumber, 4), f.supervisor)).status, 404);
  const duty = await f.get(path, { auth: f.duty });
  assert.equal(Object.hasOwn(duty.body, 'submissionPhotos'), false);
  assert.equal((await f.get('/api/v1/owner/cases/' + caseNumber + '/submission-photos/5/0', {
    auth: ownerSessionToken,
  })).status, 404);
  const publicProgress = await f.get(publicPath(receipt.publicLookupCode));
  assert.equal(publicProgress.body.status, 'processing');
  assert.doesNotMatch(JSON.stringify(publicProgress.body), /处置说明|submissionPhotos|photos/);

  assert.equal((await act(f, path, f.duty, 'reassign', 5, {
    assignee: 'handler-b', dueAt: '2026-11-20T02:00:00Z', reason: '合成转派',
  })).status, 200);
  assert.equal((await getPhoto(f.base, url, f.handler)).status, 404);
  assert.equal((await getPhoto(f.base, url, f.supervisor)).status, 404);
  assert.equal((await uploadResult(f, caseNumber, f.handler, 6)).status, 404);
  assert.deepEqual((await getPhoto(f.base, url, f.unrelatedHandler)).body, png);
  assert.deepEqual((await getPhoto(f.base, url, f.unrelatedSupervisor)).body, png);
  assert.equal((await act(f, path, f.unrelatedHandler, 'start', 6)).status, 200);
  assert.equal((await act(f, path, f.unrelatedHandler, 'submit_result', 7, {
    summary: '合成文字结果', photoOmissionReason: '本次仅有文字材料',
  })).status, 200);
  assert.equal((await act(f, path, f.unrelatedSupervisor, 'publish', 8, { summary: '合成公开反馈内容' })).status, 200);
  const owner = await f.get(ownerPath(caseNumber), { auth: ownerSessionToken });
  assert.deepEqual(owner.body.rounds[0].feedback.photos, []);
  assert.equal(Object.hasOwn(owner.body, 'submissionPhotos'), false);
  assert.equal((await act(f, ownerPath(caseNumber), ownerSessionToken, 'request_reopen', 9, {
    reason: '合成补办证据',
  })).status, 200);
  assert.equal((await act(f, path, f.unrelatedSupervisor, 'approve_reopen', 10, {
    assignee: 'handler-b', dueAt: '2026-11-20T02:00:00Z', nextStatus: 'processing',
  })).status, 200);
  const nextRound = await uploadResult(f, caseNumber, f.unrelatedHandler, 11, [photo2]);
  assert.equal(nextRound.status, 200);
  assert.deepEqual(nextRound.body.submissionPhotos.map(({ round, submitVersion }) => [round, submitVersion]),
    [[1, 5], [1, 5], [2, 12]]);
  assert.deepEqual((await getPhoto(f.base, resultPhotoPath(caseNumber, 12), f.unrelatedSupervisor)).body, jpeg);
  assert.equal((await getPhoto(f.base, url, f.supervisor)).status, 404);
});

if (isMainThread) test('photo write failure and stale versions leave no partial result across SQLite connections', async t => {
  const f = await fixture(t);
  const { caseNumber } = await workbenchCase(f, 'photo-rollback', {
    assignee: 'handler-a', handler: f.handler, status: 'processing',
  });
  inspect(f.config, db => db.exec(`
    CREATE TRIGGER test_staff_photo_failure BEFORE INSERT ON staff_submission_photos WHEN NEW.position = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic staff photo write failure'); END
  `));
  const failure = await uploadResult(f, caseNumber, f.handler, 4, [photo, photo2]);
  assert.deepEqual([failure.status, failure.body], [500, { error: 'internal_error' }]);
  const unchanged = await f.get(staffPath(caseNumber), { auth: f.handler });
  assert.deepEqual([unchanged.body.status, unchanged.body.version, unchanged.body.history.length, unchanged.body.submissionPhotos],
    ['processing', 4, 4, []]);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM staff_submission_photos').get().n, 0);
    db.exec('DROP TRIGGER test_staff_photo_failure');
  });
  const stale = await uploadResult(f, caseNumber, f.handler, 3);
  assert.deepEqual([stale.status, stale.body], [409, { error: 'stale_version' }]);
  const second = { get: await secondListener(f) };
  const race = await Promise.all([uploadResult(f, caseNumber, f.handler, 4), uploadResult(second, caseNumber, f.handler, 4)]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM staff_submission_photos').get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM case_events WHERE action = 'submit_result'").get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (isMainThread) test('v4 upgrade preserves legacy text result and original receipt before a new photo submission', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit(form(payload, [photo]));
  const { caseNumber } = receipt;
  await prepareFeedback(f, caseNumber);
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v4.sqlite' };
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, legacy.dbPath);
  } finally {
    source.close();
  }
  inspect(legacy, db => db.exec(`
    DROP TABLE wechat_receipt_codes;
    DROP TABLE owner_supplement_photos;
    DROP TABLE collaboration_submission_photos;
    DROP TABLE published_feedback_photos;
    DROP TABLE staff_submission_photos;
    DROP TABLE representative_report_releases;
    DROP TABLE tourism_event_ids;
    DROP TABLE tourism_events;
    DROP VIEW current_case_supervision;
    DROP TABLE case_supervision_events;
    DROP TABLE remediation_reviews;
    DROP TABLE remediation_entries;
    DROP TABLE case_contact_access_audit;
    PRAGMA user_version = 4;
  `));
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const base = await listen(migrated);
  const get = f.client(base);
  const replay = await get(intakePath, { method: 'POST', auth: f.integration, body: form(payload, [photo]) });
  assert.deepEqual([replay.status, replay.body], [200, receipt]);
  const verified = await verify({ get }, receipt);
  assert.equal(verified.status, 200);
  const original = await get(staffPath(caseNumber), { auth: f.supervisor });
  assert.equal(original.body.status, 'awaiting_review');
  assert.equal(original.body.version, 5);
  assert.equal(original.body.history.at(-1).detail.photoOmissionReason, '合成缺照原因');
  assert.deepEqual(original.body.submissionPhotos, []);
  assert.equal((await act({ get }, staffPath(caseNumber), f.supervisor, 'return_result', 5, { reason: '合成补照片' })).status, 200);
  const refreshed = await uploadResult({ get }, caseNumber, f.handler, 6);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.submissionPhotos[0].submitVersion, 7);
  assert.deepEqual((await getPhoto(base, resultPhotoPath(caseNumber, 7), f.supervisor)).body, png);
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM attachments').get().bytes), png);
  });
});

const ownerPhotoPath = (caseNumber, version, position = 0) =>
  ownerPath(caseNumber) + '/feedback-photos/' + version + '/' + position;

function syntheticDerivative(rgb, metadata) {
  function chunk(type, bytes) {
    const chunk = Buffer.alloc(bytes.length + 12);
    chunk.writeUInt32BE(bytes.length);
    chunk.write(type, 4);
    bytes.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
  }
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header)];
  if (metadata) parts.push(chunk('tEXt', Buffer.from('Comment\0' + metadata)));
  parts.push(chunk('IDAT', deflateSync(Buffer.from([0, ...rgb]))), chunk('IEND', Buffer.alloc(0)));
  return { bytes: Buffer.concat(parts), type: 'image/png', name: 'synthetic-derivative.png' };
}

function publishPhotos(client, caseNumber, auth, expectedVersion, photos, extra = {}) {
  return client.get(staffPath(caseNumber) + '/actions', {
    auth, method: 'POST',
    body: form({ action: 'publish', expectedVersion, summary: '合成已发布文字反馈', derivativesReviewed: true, ...extra }, photos),
  });
}

if (isMainThread) test('reviewed derivatives are separate from raw attachments and readable only by the correct owner across rounds', async t => {
  const f = await fixture(t);
  const receipt = await workbenchCase(f, 'published-feedback', {
    assignee: 'handler-a', handler: f.handler, status: 'processing', photos: [photo],
  });
  const { caseNumber } = receipt;
  const { body: { ownerSessionToken: owner } } = await verify(f, receipt);
  const { body: other } = await f.submit();
  const { body: { ownerSessionToken: otherOwner } } = await verify(f, other);
  const raw = syntheticDerivative([250, 10, 10]);
  const surrogate = syntheticDerivative([20, 30, 40], 'synthetic-private-metadata');
  const clean = syntheticDerivative([20, 30, 40]);
  const path = ownerPhotoPath(caseNumber, 6);
  assert.equal((await getPhoto(f.base, path, owner)).status, 404);
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 4, [surrogate])).body.error, 'invalid_transition');
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4, [raw])).status, 200);
  assert.equal((await getPhoto(f.base, path, owner)).status, 404);
  assert.equal((await getPhoto(f.base, ownerPhotoPath(caseNumber, 5), owner)).status, 404);
  for (const [auth, expected] of [[f.integration, 403], [f.shopA, 403], [f.duty, 403],
    [f.handler, 403], [f.unrelatedSupervisor, 404], [owner, 401]]) {
    assert.equal((await publishPhotos(f, caseNumber, auth, 5, [surrogate])).status, expected);
  }
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 5, [])).body.error, 'photos_required');
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 5, [surrogate], {
    derivativesReviewed: false,
  })).body.error, 'feedback_review_required');
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 5, [surrogate], {
    submissionPhoto: 0,
  })).body.error, 'unknown_field');
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 5, [photo2])).body.error, 'invalid_feedback_png');
  const broken = { ...surrogate, bytes: Buffer.from(surrogate.bytes) };
  broken.bytes[29] ^= 1;
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 5, [broken])).body.error, 'invalid_feedback_png');
  for (const original of [photo, raw, syntheticDerivative([250, 10, 10], 'synthetic-added-metadata')]) {
    const rejected = await publishPhotos(f, caseNumber, f.supervisor, 5, [original]);
    assert.deepEqual([rejected.status, rejected.body], [409, { error: 'feedback_original_not_allowed' }]);
  }
  const published = await publishPhotos(f, caseNumber, f.supervisor, 5, [surrogate]);
  assert.equal(published.status, 200);
  assert.deepEqual([published.body.status, published.body.version], ['awaiting_evaluation', 6]);
  assert.equal(published.body.history.at(-1).detail.derivativesReviewed, true);
  assert.deepEqual(published.body.rounds[0].feedback.photos, []);
  const ownerDetail = await f.get(ownerPath(caseNumber), { auth: owner });
  assert.deepEqual(ownerDetail.body.rounds[0].feedback.photos,
    [{ publishVersion: 6, position: 0, mediaType: 'image/png', size: clean.bytes.length }]);
  const image = await getPhoto(f.base, path, owner);
  assert.equal(image.status, 200);
  assert.deepEqual(image.body, clean.bytes);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('content-type'), 'image/png');
  for (const auth of [undefined, f.integration, f.shopA, f.supervisor, otherOwner, receipt.privateLookupToken]) {
    assert.equal((await getPhoto(f.base, path, auth)).status, 401);
  }
  assert.equal((await getPhoto(f.base, ownerPhotoPath(other.caseNumber, 6), owner)).status, 401);
  assert.equal((await getPhoto(f.base, resultPhotoPath(caseNumber, 5), owner)).status, 401);
  assert.equal((await getPhoto(f.base, publicPath(receipt.publicLookupCode) + '/feedback-photos/6/0')).status, 404);
  assert.doesNotMatch(JSON.stringify((await f.get(publicPath(receipt.publicLookupCode))).body), /反馈内容|photos|publishVersion/);

  assert.equal((await act(f, ownerPath(caseNumber), owner, 'request_reopen', 6, { reason: '合成补办' })).status, 200);
  assert.equal((await act(f, staffPath(caseNumber), f.supervisor, 'approve_reopen', 7, {
    assignee: 'handler-a', dueAt: '2026-11-20T02:00:00Z', nextStatus: 'processing',
  })).status, 200);
  assert.equal((await uploadResult(f, caseNumber, f.handler, 8, [syntheticDerivative([1, 2, 3])])).status, 200);
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 9, [raw])).body.error, 'feedback_original_not_allowed');
  const roundTwoImage = syntheticDerivative([60, 70, 80]);
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 9, [roundTwoImage])).status, 200);
  const latest = await f.get(ownerPath(caseNumber), { auth: owner });
  assert.deepEqual(latest.body.rounds.map(entry => [entry.round, entry.feedback.photos[0].publishVersion]), [[1, 6], [2, 10]]);
  assert.deepEqual((await getPhoto(f.base, path, owner)).body, clean.bytes);
  assert.deepEqual((await getPhoto(f.base, ownerPhotoPath(caseNumber, 10), owner)).body, roundTwoImage.bytes);
  f.advanceClock(1800);
  assert.equal((await getPhoto(f.base, path, owner)).status, 401);
  const { body: { ownerSessionToken: renewed } } = await verify(f, receipt);
  assert.deepEqual((await getPhoto(f.base, path, renewed)).body, clean.bytes);
});

if (isMainThread) test('feedback image write failure and stale versions do not publish any bytes or text', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit();
  const { caseNumber } = receipt;
  await prepareFeedback(f, caseNumber);
  const { body: { ownerSessionToken: owner } } = await verify(f, receipt);
  const images = [syntheticDerivative([40, 40, 40]), syntheticDerivative([80, 80, 80])];
  inspect(f.config, db => db.exec(`
    CREATE TRIGGER test_feedback_failure BEFORE INSERT ON published_feedback_photos WHEN NEW.position = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic feedback photo write failure'); END
  `));
  const rejected = await publishPhotos(f, caseNumber, f.supervisor, 5, images);
  assert.deepEqual([rejected.status, rejected.body], [500, { error: 'internal_error' }]);
  const detail = await f.get(staffPath(caseNumber), { auth: f.supervisor });
  assert.deepEqual([detail.body.status, detail.body.version, detail.body.history.length], ['awaiting_review', 5, 5]);
  assert.equal((await f.get(ownerPath(caseNumber), { auth: owner })).body.rounds[0].feedback, null);
  assert.equal((await getPhoto(f.base, ownerPhotoPath(caseNumber, 6), owner)).status, 404);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM published_feedback_photos').get().n, 0);
    db.exec('DROP TRIGGER test_feedback_failure');
  });
  assert.equal((await publishPhotos(f, caseNumber, f.supervisor, 4, images)).body.error, 'stale_version');
  const second = { get: await secondListener(f) };
  const race = await Promise.all([f, second].map(client => publishPhotos(client, caseNumber, f.supervisor, 5, images)));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM published_feedback_photos').get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM case_events WHERE action = 'publish'").get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (isMainThread) test('v5 upgrade preserves text feedback, original receipt and private submission photos', async t => {
  const f = await fixture(t);
  const receipt = await workbenchCase(f, 'old-feedback-v5', {
    assignee: 'handler-a', handler: f.handler, status: 'processing', photos: [photo],
  });
  const { caseNumber } = receipt;
  assert.equal((await uploadResult(f, caseNumber, f.handler, 4)).status, 200);
  assert.equal((await act(f, staffPath(caseNumber), f.supervisor, 'publish', 5, { summary: '旧库文字反馈' })).status, 200);
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v5.sqlite' };
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, legacy.dbPath);
  } finally {
    source.close();
  }
  inspect(legacy, db => db.exec(`
    DROP TABLE wechat_receipt_codes;
    DROP TABLE owner_supplement_photos;
    DROP TABLE collaboration_submission_photos;
    DROP TABLE published_feedback_photos;
    DROP TABLE representative_report_releases;
    DROP TABLE tourism_event_ids;
    DROP TABLE tourism_events;
    DROP VIEW current_case_supervision;
    DROP TABLE case_supervision_events;
    DROP TABLE remediation_reviews;
    DROP TABLE remediation_entries;
    DROP TABLE case_contact_access_audit;
    PRAGMA user_version = 5;
  `));
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const base = await listen(migrated);
  const get = f.client(base);
  const replay = await get(intakePath, {
    method: 'POST', auth: f.integration,
    body: form({ ...payload, externalCaseId: 'synthetic-workbench-old-feedback-v5' }, [photo]),
  });
  assert.deepEqual([replay.status, replay.body], [200, receipt]);
  const { body: { ownerSessionToken: owner } } = await verify({ get }, receipt);
  const ownerDetail = await get(ownerPath(caseNumber), { auth: owner });
  assert.equal(ownerDetail.body.rounds[0].feedback.summary, '旧库文字反馈');
  assert.deepEqual(ownerDetail.body.rounds[0].feedback.photos, []);
  assert.deepEqual((await getPhoto(base, resultPhotoPath(caseNumber, 5), f.supervisor)).body, png);
  assert.equal((await getPhoto(base, ownerPhotoPath(caseNumber, 5), owner)).status, 404);
  assert.equal((await getPhoto(base, ownerPhotoPath(caseNumber, 6), owner)).status, 404);
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM published_feedback_photos').get().n, 0);
  });
});

async function prepareCollabPhotos(f, key) {
  const receipt = await workbenchCase(f, key, { assignee: 'handler-a' });
  const staffTasks = staffPath(receipt.caseNumber) + '/collaborations';
  const assigned = await f.get(staffTasks, { auth: f.supervisor, method: 'POST', body: JSON.stringify({
    expectedVersion: 3, merchantId: 'shop-a', instructions: '合成任务', dueAt: '2026-11-20T02:00:00Z',
  }) });
  assert.equal(assigned.status, 201);
  const taskId = assigned.body.taskId;
  return { receipt, staffTasks, task: merchantTasks + '/' + taskId, manage: staffTasks + '/' + taskId };
}

const uploadCollab = (client, task, auth, expectedVersion, photos = [photo]) =>
  client.get(task + '/submissions', { method: 'POST', auth, body: form({ expectedVersion, summary: '合成协办说明' }, photos) });

if (isMainThread) test('collaboration originals follow task, role, current department and active round without changing the case', async t => {
  const f = await fixture(t);
  const { receipt, staffTasks, task, manage } = await prepareCollabPhotos(f, 'collaboration-photo-scope');
  const { caseNumber, publicLookupCode } = receipt;
  const { body: { ownerSessionToken } } = await verify(f, receipt);
  const path = staffPath(caseNumber);
  const merchantPhoto = task + '/submission-photos/2/0';
  const staffPhoto = manage + '/submission-photos/2/0';
  for (const [auth, expected] of [[f.shopB, 404], [f.shopAReader, 403], [f.integration, 403], [f.handler, 403]]) {
    assert.equal((await uploadCollab(f, task, auth, 1)).status, expected);
  }
  assert.equal((await uploadCollab(f, task, f.shopA, 1, [])).body.error, 'photos_required');
  assert.equal((await uploadCollab(f, task, f.shopA, 1, [{ ...photo, bytes: Buffer.from('not an image') }])).status, 415);
  assert.equal((await uploadCollab(f, task, f.shopA, 1, Array(4).fill(photo))).status, 413);
  const submitted = await uploadCollab(f, task, f.shopA, 1, [photo, photo2]);
  const metadata = [
    { submitVersion: 2, position: 0, mediaType: 'image/png', size: png.length },
    { submitVersion: 2, position: 1, mediaType: 'image/jpeg', size: jpeg.length },
  ];
  assert.deepEqual([submitted.status, submitted.body.version, submitted.body.submissionPhotos], [200, 2, metadata]);
  const main = (await f.get(path, { auth: f.duty })).body;
  assert.deepEqual([main.status, main.version], ['assigned', 4]);
  assert.deepEqual((await f.get(task, { auth: f.shopA })).body.submissionPhotos, metadata);
  assert.deepEqual((await f.get(staffTasks, { auth: f.handler })).body.items[0].submissionPhotos, metadata);
  assert.equal(Object.hasOwn((await f.get(staffTasks, { auth: f.duty })).body.items[0], 'submissionPhotos'), false);
  for (const [url, auth] of [[merchantPhoto, f.shopA], [staffPhoto, f.handler], [staffPhoto, f.supervisor]]) {
    const result = await getPhoto(f.base, url, auth);
    assert.deepEqual([result.status, result.body], [200, png]);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  for (const [url, auth, expected] of [
    [merchantPhoto, f.shopB, 404], [merchantPhoto, f.shopAReader, 403], [staffPhoto, f.duty, 403],
    [staffPhoto, f.secondHandler, 404], [staffPhoto, f.unrelatedSupervisor, 404],
    [staffPhoto, ownerSessionToken, 401], [staffPhoto, f.integration, 403], [staffPhoto, f.shopA, 403],
    [staffPhoto, undefined, 401], [manage + '/submission-photos/1/0', f.supervisor, 404],
  ]) assert.equal((await getPhoto(f.base, url, auth)).status, expected);
  assert.equal((await getPhoto(f.base, publicPath(publicLookupCode) + '/submission-photos/2/0')).status, 404);
  assert.equal((await getPhoto(f.base, ownerPhotoPath(caseNumber, 2), ownerSessionToken)).status, 404);
  assert.doesNotMatch(JSON.stringify((await f.get(ownerPath(caseNumber), { auth: ownerSessionToken })).body), /submitVersion|协办说明/);
  assert.equal((await act(f, path, f.duty, 'reassign', 4, {
    assignee: 'handler-b', dueAt: '2026-11-20T02:00:00Z', reason: '合成转派',
  })).status, 200);
  for (const auth of [f.handler, f.supervisor]) assert.equal((await getPhoto(f.base, staffPhoto, auth)).status, 404);
  for (const [url, auth] of [[merchantPhoto, f.shopA], [staffPhoto, f.unrelatedHandler], [staffPhoto, f.unrelatedSupervisor]]) {
    assert.equal((await getPhoto(f.base, url, auth)).status, 200);
  }
  assert.equal((await act(f, path, f.unrelatedHandler, 'start', 5)).status, 200);
  assert.equal((await act(f, path, f.unrelatedHandler, 'submit_result', 6, {
    summary: '处置说明', photoOmissionReason: '文字送审',
  })).status, 200);
  assert.equal((await publishPhotos(f, caseNumber, f.unrelatedSupervisor, 7, [photo])).body.error, 'feedback_original_not_allowed');
  assert.equal((await act(f, path, f.unrelatedSupervisor, 'publish', 7, { summary: '合成反馈' })).status, 200);
  assert.equal((await getPhoto(f.base, merchantPhoto, f.shopA)).status, 404);
  assert.equal((await getPhoto(f.base, staffPhoto, f.unrelatedSupervisor)).status, 404);
  assert.equal((await act(f, ownerPath(caseNumber), ownerSessionToken, 'request_reopen', 8, { reason: '合成补办' })).status, 200);
  assert.equal((await act(f, path, f.unrelatedSupervisor, 'approve_reopen', 9, {
    assignee: 'handler-b', dueAt: '2026-11-20T02:00:00Z', nextStatus: 'processing',
  })).status, 200);
  assert.equal((await getPhoto(f.base, staffPhoto, f.unrelatedSupervisor)).status, 404);
  assert.equal((await getPhoto(f.base, merchantPhoto, f.shopA)).status, 404);
  assert.equal(Object.hasOwn((await f.get(staffTasks, { auth: f.unrelatedSupervisor })).body.items[0], 'submissionPhotos'), false);
});

if (isMainThread) test('collaboration photo and event writes roll back together, and duplicate submits cannot add images', async t => {
  const f = await fixture(t);
  const { receipt, task, manage } = await prepareCollabPhotos(f, 'collaboration-photo-rollback');
  inspect(f.config, db => db.exec(`
    CREATE TRIGGER test_collaboration_photo_failure BEFORE INSERT ON collaboration_submission_photos WHEN NEW.position = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic collaboration photo write failure'); END
  `));
  assert.equal((await uploadCollab(f, task, f.shopA, 1, [photo, photo2])).status, 500);
  const still = (await f.get(task, { auth: f.shopA })).body;
  assert.deepEqual([still.version, still.status, still.submissionPhotos], [1, 'awaiting_submission', []]);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM collaboration_submission_photos').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_events WHERE action = 'submit'").get().n, 0);
    db.exec('DROP TRIGGER test_collaboration_photo_failure');
  });
  const second = { get: await secondListener(f) };
  const race = await Promise.all([f, second].map(client => uploadCollab(client, task, f.shopA, 1, [photo, photo2])));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  assert.equal((await uploadCollab(f, task, f.shopA, 1)).body.error, 'stale_version');
  assert.equal((await uploadCollab(f, task, f.shopA, 2)).body.error, 'invalid_transition');
  const withdrawn = await f.get(manage + '/actions', { auth: f.supervisor, method: 'POST', body: JSON.stringify({
    action: 'withdraw', expectedVersion: 2, reason: '合成撤回',
  }) });
  assert.equal(withdrawn.status, 200);
  assert.equal(Object.hasOwn(withdrawn.body, 'submissionPhotos'), false);
  assert.equal((await getPhoto(f.base, task + '/submission-photos/2/0', f.shopA)).status, 404);
  assert.equal((await getPhoto(f.base, manage + '/submission-photos/2/0', f.supervisor)).status, 404);
  assert.equal((await f.get(staffPath(receipt.caseNumber), { auth: f.duty })).body.version, 4);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM collaboration_submission_photos').get().n, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (isMainThread) test('v6 upgrade keeps an existing text-only collaboration and supports photo resubmission', async t => {
  const f = await fixture(t);
  const { task, manage } = await prepareCollabPhotos(f, 'collaboration-photo-v6');
  const submitted = await f.get(task + '/submissions', { auth: f.shopA, method: 'POST', body: JSON.stringify({
    expectedVersion: 1, summary: '迁移前文字',
  }) });
  assert.equal(submitted.status, 200);
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v6.sqlite' };
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, legacy.dbPath);
  } finally {
    source.close();
  }
  inspect(legacy, db => db.exec(`
    DROP TABLE wechat_receipt_codes;
    DROP TABLE owner_supplement_photos;
    DROP TABLE collaboration_submission_photos;
    DROP TABLE representative_report_releases;
    DROP TABLE tourism_event_ids;
    DROP TABLE tourism_events;
    DROP VIEW current_case_supervision;
    DROP TABLE case_supervision_events;
    DROP TABLE remediation_reviews;
    DROP TABLE remediation_entries;
    DROP TABLE case_contact_access_audit;
    PRAGMA user_version = 6;
  `));
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const base = await listen(migrated);
  const get = f.client(base);
  const previous = await get(task, { auth: f.shopA });
  assert.deepEqual(previous.body, submitted.body);
  assert.equal((await get(manage + '/actions', { auth: f.supervisor, method: 'POST', body: JSON.stringify({
    action: 'return', expectedVersion: 2, reason: '合成退回',
  }) })).status, 200);
  const next = await uploadCollab({ get }, task, f.shopA, 3);
  assert.equal(next.status, 200);
  assert.equal(next.body.submissionPhotos[0].submitVersion, 4);
  assert.deepEqual((await getPhoto(base, manage + '/submission-photos/4/0', f.supervisor)).body, png);
  assert.equal((await getPhoto(base, manage + '/submission-photos/2/0', f.supervisor)).status, 404);
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

const novemberReport = '/api/v1/staff/monthly-report?month=2026-11';
const beijing = value => new Date('2026-' + value + '+08:00').toISOString();

function reportEvent(time, action, status, detail = {}, round = 1) {
  const actor = action === 'submit' ? 'integration' : ['request_reopen', 'evaluate'].includes(action) ? 'owner' : 'staff';
  return { at: beijing(time), action, status, actor, detail, round };
}

function seedReportCase(f, key, events, evaluation, reopen) {
  inspect(f.config, db => {
    const latest = events.at(-1);
    const created = db.prepare(`
      INSERT INTO cases (source, external_case_id, submission_hash, case_number, public_lookup_code,
        occurred_at, location, category, description, status, version, round)
      VALUES ('local-report', ?, 'synthetic-report', ?, ?, ?, '合成地址', '合成类别', '合成正文', ?, ?, ?)
    `).run(key, 'CD-' + key, token().slice(0, 24), events[0].at, latest.status, events.length, latest.round);
    const id = created.lastInsertRowid;
    const insert = db.prepare('INSERT INTO case_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    events.forEach((event, index) => insert.run(id, index + 1, event.action, event.status, event.actor,
      'synthetic-internal-actor', event.at, JSON.stringify(event.detail), 0, event.round));
    if (evaluation) db.prepare('INSERT INTO case_evaluations VALUES (?, ?, ?, ?, ?, NULL, ?)').run(id, ...evaluation);
    if (reopen) {
      const index = events.findIndex(event => event.action === 'request_reopen');
      const rejected = events.some(event => event.action === 'reject_reopen');
      db.prepare(`
        INSERT INTO reopen_requests (case_id, requested_version, round, previous_status, reason, requested_at,
          decision, decision_reason, decided_at, decided_by)
        VALUES (?, ?, 1, 'awaiting_evaluation', '合成补办说明', ?, ?, ?, ?, 'synthetic-approver')
      `).run(id, index + 1, events[index].at, rejected ? 'rejected' : 'approved',
        rejected ? '合成驳回原因' : null, reopen);
    }
  });
}

function reportClock(f, dateTime) {
  f.advanceClock((Date.parse(beijing(dateTime)) - f.now().valueOf()) / 1000);
}

if (isMainThread) test('Beijing monthly report reproduces the six-case fixture and separates month-end from extraction', async t => {
  const f = await fixture(t);
  const e = reportEvent;
  reportClock(f, '12-05T00:00:00');
  seedReportCase(f, 'A', [
    e('11-01T00:00:00', 'submit', 'submitted'),
    e('11-01T00:30:00', 'accept', 'accepted'),
    e('11-01T01:00:00', 'assign', 'assigned', { dueAt: beijing('11-03T00:00:00') }),
    e('11-01T02:00:00', 'start', 'processing'),
    e('11-02T00:00:00', 'submit_result', 'awaiting_review'),
    e('11-02T01:00:00', 'publish', 'awaiting_evaluation'),
    e('11-02T01:01:00', 'evaluate', 'awaiting_evaluation'),
    e('11-29T00:00:00', 'request_reopen', 'reopen_pending'),
    e('11-30T00:00:00', 'approve_reopen', 'assigned', { dueAt: beijing('12-03T00:00:00') }, 2),
  ], [1, 4, 5, 3, beijing('11-02T01:01:00')], beijing('11-30T00:00:00'));
  seedReportCase(f, 'B', [
    e('11-05T09:00:00', 'submit', 'submitted'),
    e('11-05T10:00:00', 'accept', 'accepted'),
    e('11-05T11:00:00', 'assign', 'assigned', { dueAt: beijing('12-03T00:00:00') }),
    e('11-05T12:00:00', 'reassign', 'assigned', { dueAt: beijing('11-29T00:00:00') }),
    e('11-06T11:00:00', 'start', 'processing'),
    e('12-02T00:00:00', 'submit_result', 'awaiting_review'),
    e('12-02T01:00:00', 'publish', 'awaiting_evaluation'),
  ]);
  seedReportCase(f, 'C', [
    e('10-31T23:50:00', 'submit', 'submitted'),
    e('11-01T00:10:00', 'accept', 'accepted'),
    e('11-01T01:00:00', 'assign', 'assigned', { dueAt: beijing('11-15T00:00:00') }),
    e('11-01T02:00:00', 'start', 'processing'),
    e('11-10T00:00:00', 'submit_result', 'awaiting_review'),
    e('11-10T01:00:00', 'publish', 'awaiting_evaluation'),
  ]);
  seedReportCase(f, 'D', [
    e('11-06T09:00:00', 'submit', 'submitted'),
    e('11-06T11:00:00', 'request_supplement', 'awaiting_supplement', { reason: '合成补件' }),
  ]);
  seedReportCase(f, 'E', [e('11-30T23:50:00', 'submit', 'submitted')]);
  seedReportCase(f, 'F', [e('12-01T00:00:00', 'submit', 'submitted')]);
  const response = await f.get(novemberReport, { auth: f.duty });
  assert.equal(response.status, 200);
  const data = response.body;
  assert.deepEqual(data.period, { start: '2026-11-01T00:00:00+08:00', endExclusive: '2026-12-01T00:00:00+08:00' });
  assert.equal(data.asOf, '2026-12-05T00:00:00+08:00');
  assert.deepEqual(data.firstResponse, { submitted: 4, responded: 3, pending: 1, medianMinutes: 60,
    distribution: { atMostOneHour: 2, upTo24Hours: 1, over24Hours: 0 } });
  assert.deepEqual(data.completion, { accepted: 3, completed: 2, rate: 2 / 3 });
  assert.deepEqual(data.monthEnd, { cutoff: '2026-12-01T00:00:00+08:00', state: 'final',
    unfinished: 2, overdue: 1, withoutDeadline: 0, missingDeadlineEvidence: 0, deadlineData: 'available' });
  assert.deepEqual(data.reopen, { applications: 1, approved: 1, rejected: 0, newRounds: 1 });
  assert.deepEqual(data.evaluation, { publishedRounds: 2, validEvaluations: 1, coverage: 0.5, unevaluatedRounds: 1,
    dimensions: {
      speed: { distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 }, mean: 4 },
      effectiveness: { distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, mean: 5 },
      attitude: { distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 }, mean: 3 },
    } });
  assert.equal(data.duplicateComplaints.status, 'unavailable');
  assert.equal(data.tourism.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(data), /CD-|合成地址|合成正文|internal-actor|department/);
});

if (isMainThread) test('monthly report uses exclusive current cutoff, deadline evidence and zero-sample nulls', async t => {
  const f = await fixture(t);
  const e = reportEvent;
  reportClock(f, '11-19T10:00:00.999');
  seedReportCase(f, 'tied', [
    e('11-01T00:00:00', 'submit', 'submitted'),
    e('11-01T00:00:00', 'accept', 'accepted'),
    e('11-02T00:00:00', 'assign', 'assigned', { dueAt: beijing('11-19T10:00:00') }),
    e('11-19T10:00:00', 'publish', 'awaiting_evaluation'),
  ], [1, 5, 5, 5, beijing('11-19T10:00:00')]);
  seedReportCase(f, 'middle', [
    e('11-05T00:00:00', 'submit', 'submitted'),
    e('11-06T00:00:00', 'reject', 'rejected', { reason: '合成理由' }),
  ]);
  seedReportCase(f, 'late', [
    e('11-05T00:00:00', 'submit', 'submitted'),
    e('11-07T00:00:00', 'request_supplement', 'awaiting_supplement', { reason: '合成要求' }),
  ]);
  seedReportCase(f, 'no-due', [
    e('10-31T00:00:00', 'submit', 'submitted'),
    e('11-08T00:00:00', 'accept', 'accepted'),
    e('11-09T00:00:00', 'assign', 'assigned', { dueAt: beijing('11-10T00:00:00') }),
    e('11-10T01:00:00', 'reassign', 'assigned', {}),
  ]);
  seedReportCase(f, 'no-assignment', [
    e('10-31T10:00:00', 'submit', 'submitted'),
    e('11-10T01:00:00', 'accept', 'accepted'),
  ]);
  seedReportCase(f, 'even', [
    e('11-05T00:00:00', 'submit', 'submitted'),
    e('11-05T01:00:00', 'request_supplement', 'awaiting_supplement', { reason: '合成要求' }),
  ]);
  seedReportCase(f, 'pending', [
    e('11-05T00:00:00', 'submit', 'submitted'),
    e('11-05T01:00:00', 'reject', 'rejected', { reason: '　' }),
  ]);
  seedReportCase(f, 'prior-month-reopen', [
    e('10-01T00:00:00', 'submit', 'submitted'),
    e('10-02T00:00:00', 'accept', 'accepted'),
    e('10-03T00:00:00', 'publish', 'awaiting_evaluation'),
    e('10-31T23:00:00', 'request_reopen', 'reopen_pending'),
    e('11-01T00:00:00', 'reject_reopen', 'awaiting_evaluation'),
  ], null, beijing('11-01T00:00:00'));
  const { body: data } = await f.get(novemberReport, { auth: f.duty });
  assert.equal(data.asOf, '2026-11-19T10:00:00+08:00');
  assert.deepEqual(data.monthEnd, { cutoff: data.asOf, state: 'provisional', unfinished: 3, overdue: 0,
    withoutDeadline: 2, missingDeadlineEvidence: 1, deadlineData: 'insufficient' });
  assert.deepEqual(data.firstResponse, { submitted: 5, responded: 4, pending: 1, medianMinutes: 750,
    distribution: { atMostOneHour: 2, upTo24Hours: 1, over24Hours: 1 } });
  assert.equal(data.completion.completed, 0);
  assert.deepEqual(data.reopen, { applications: 0, approved: 0, rejected: 1, newRounds: 0 });
  assert.equal(data.evaluation.coverage, null);
  assert.equal(data.evaluation.dimensions.speed.mean, null);
  f.advanceClock(1);
  const next = (await f.get(novemberReport, { auth: f.duty })).body;
  assert.equal(next.completion.completed, 1);
  assert.equal(next.evaluation.validEvaluations, 1);
  const empty = (await f.get('/api/v1/staff/monthly-report?month=2026-09', { auth: f.duty })).body;
  assert.equal(empty.firstResponse.medianMinutes, null);
  assert.equal(empty.completion.rate, null);
  assert.equal(empty.evaluation.coverage, null);
  assert.equal(empty.monthEnd.unfinished, 0);
});

if (isMainThread) test('monthly report is restricted to local all-street duty and validates month input', async t => {
  const f = await fixture(t);
  const { body: receipt } = await f.submit();
  const { body: { ownerSessionToken } } = await verify(f, receipt);
  for (const auth of [undefined, ownerSessionToken]) assert.equal((await f.get(novemberReport, { auth })).status, 401);
  for (const auth of [f.integration, f.shopA, f.supervisor, f.unrelatedSupervisor, f.handler]) {
    assert.equal((await f.get(novemberReport, { auth })).status, 403);
  }
  for (const query of ['', '?month=2026-13', '?month=2026-11&department=a', '?month=2026-11&month=2026-10']) {
    assert.equal((await f.get('/api/v1/staff/monthly-report' + query, { auth: f.duty })).status, 400);
  }
  const future = await f.get('/api/v1/staff/monthly-report?month=2026-12', { auth: f.duty });
  assert.deepEqual([future.status, future.body], [400, { error: 'future_report_month' }]);
});

async function requestPhotoSupplement(f) {
  const { body: receipt } = await f.submit();
  const { body: { ownerSessionToken: owner } } = await verify(f, receipt);
  const staff = staffPath(receipt.caseNumber);
  assert.equal((await act(f, staff, f.duty, 'request_supplement', 1, { reason: '请补充合成情况' })).status, 200);
  return { receipt, owner, staff, privatePath: ownerPath(receipt.caseNumber) };
}

function uploadSupplement(client, path, auth, version, photos = [photo], extra = {}) {
  return client.get(path + '/actions', { auth, method: 'POST', body: form({
    action: 'submit_supplement', expectedVersion: version, summary: '合成补件说明', ...extra,
  }, photos) });
}

if (isMainThread) test('supplement originals stay in the case scope and are not publishable as feedback', async t => {
  const f = await fixture(t);
  const { receipt, owner, staff, privatePath } = await requestPhotoSupplement(f);
  const photoUrl = privatePath + '/supplement-photos/3/0';
  const staffPhoto = staff + '/supplement-photos/3/0';
  const { body: another } = await f.submit(form({ ...payload, externalCaseId: 'synthetic-other-supplement-photo' }));
  const { body: { ownerSessionToken: otherOwner } } = await verify(f, another);
  for (const auth of [undefined, otherOwner, f.integration, f.shopA, f.handler, receipt.privateLookupToken]) {
    assert.equal((await uploadSupplement(f, privatePath, auth, 2)).status, 401);
  }
  assert.equal((await uploadSupplement(f, privatePath, owner, 2, [])).body.error, 'photos_required');
  assert.equal((await uploadSupplement(f, privatePath, owner, 2, [photo], { action: 'confirm_resolved' })).body.error, 'invalid_action');
  assert.equal((await uploadSupplement(f, privatePath, owner, 2, Array(4).fill(photo))).status, 413);
  assert.equal((await uploadSupplement(f, privatePath, owner, 2, [{ ...photo, bytes: Buffer.from('bad file') }])).status, 415);
  assert.equal((await getPhoto(f.base, photoUrl, owner)).status, 404);
  const submitted = await uploadSupplement(f, privatePath, owner, 2, [photo, photo2]);
  assert.equal(submitted.status, 200);
  const metadata = [
    { round: 1, submitVersion: 3, position: 0, mediaType: 'image/png', size: png.length },
    { round: 1, submitVersion: 3, position: 1, mediaType: 'image/jpeg', size: jpeg.length },
  ];
  assert.deepEqual([submitted.body.caseNumber, submitted.body.status, submitted.body.version, submitted.body.supplementPhotos],
    [receipt.caseNumber, 'submitted', 3, metadata]);
  assert.deepEqual((await f.get(staff, { auth: f.duty })).body.supplementPhotos, metadata);
  assert.deepEqual((await f.get(privatePath, { auth: owner })).body.supplementPhotos, metadata);
  assert.match((await f.get(staff, { auth: f.duty })).body.history.at(-1).detail.summary, /补件说明/);
  for (const [url, auth] of [[photoUrl, owner], [staffPhoto, f.duty]]) {
    const got = await getPhoto(f.base, url, auth);
    assert.deepEqual([got.status, got.body], [200, png]);
    assert.equal(got.headers.get('cache-control'), 'no-store');
  }
  for (const auth of [undefined, otherOwner, f.integration, f.shopA]) assert.equal((await getPhoto(f.base, photoUrl, auth)).status, 401);
  for (const auth of [f.integration, f.shopA]) assert.equal((await getPhoto(f.base, staffPhoto, auth)).status, 403);
  assert.equal((await getPhoto(f.base, staffPhoto, f.supervisor)).status, 404);
  assert.equal((await getPhoto(f.base, publicPath(receipt.publicLookupCode) + '/supplement-photos/3/0')).status, 404);
  assert.equal((await getPhoto(f.base, ownerPhotoPath(receipt.caseNumber, 3), owner)).status, 404);
  assert.doesNotMatch(JSON.stringify((await f.get(publicPath(receipt.publicLookupCode))).body), /supplementPhotos|补件说明/);
  assert.equal((await act(f, staff, f.duty, 'accept', 3)).status, 200);
  const dueAt = '2026-11-20T02:00:00Z';
  assert.equal((await act(f, staff, f.duty, 'assign', 4, { assignee: 'handler-a', dueAt })).status, 200);
  for (const auth of [f.handler, f.supervisor]) assert.equal((await getPhoto(f.base, staffPhoto, auth)).status, 200);
  assert.equal((await getPhoto(f.base, staffPhoto, f.secondHandler)).status, 404);
  assert.equal((await act(f, staff, f.duty, 'reassign', 5, { assignee: 'handler-b', dueAt, reason: '合成转派' })).status, 200);
  for (const auth of [f.handler, f.supervisor]) assert.equal((await getPhoto(f.base, staffPhoto, auth)).status, 404);
  for (const auth of [f.unrelatedHandler, f.unrelatedSupervisor]) assert.equal((await getPhoto(f.base, staffPhoto, auth)).status, 200);
  assert.equal((await act(f, staff, f.unrelatedHandler, 'start', 6)).status, 200);
  assert.equal((await act(f, staff, f.unrelatedHandler, 'submit_result', 7, {
    summary: '合成处理结果', photoOmissionReason: '合成文字送审',
  })).status, 200);
  assert.equal((await publishPhotos(f, receipt.caseNumber, f.unrelatedSupervisor, 8, [photo])).body.error,
    'feedback_original_not_allowed');
  assert.equal((await act(f, staff, f.unrelatedSupervisor, 'publish', 8, { summary: '合成文字反馈' })).status, 200);
  assert.deepEqual((await f.get(privatePath, { auth: owner })).body.rounds[0].feedback.photos, []);
  f.advanceClock(1800);
  assert.equal((await getPhoto(f.base, photoUrl, owner)).status, 401);
  assert.equal((await uploadSupplement(f, privatePath, owner, 2)).status, 401);
  const { body: { ownerSessionToken: renewed } } = await verify(f, receipt);
  assert.deepEqual((await getPhoto(f.base, photoUrl, renewed)).body, png);
});

if (isMainThread) test('supplement attachment failure rolls back all writes and concurrent retries produce one event', async t => {
  const f = await fixture(t);
  const { owner, privatePath, staff } = await requestPhotoSupplement(f);
  inspect(f.config, db => db.exec(`
    CREATE TRIGGER test_supplement_photo_failure BEFORE INSERT ON owner_supplement_photos WHEN NEW.position = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic supplement photo write failure'); END
  `));
  assert.equal((await uploadSupplement(f, privatePath, owner, 2, [photo, photo2])).status, 500);
  const detail = (await f.get(staff, { auth: f.duty })).body;
  assert.deepEqual([detail.status, detail.version, detail.history.length], ['awaiting_supplement', 2, 2]);
  assert.equal(Object.hasOwn(detail, 'supplementPhotos'), false);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM owner_supplement_photos').get().n, 0);
    db.exec('DROP TRIGGER test_supplement_photo_failure');
  });
  const second = { get: await secondListener(f) };
  const race = await Promise.all([f, second].map(client => uploadSupplement(client, privatePath, owner, 2, [photo, photo2])));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  assert.equal((await uploadSupplement(f, privatePath, owner, 2)).body.error, 'stale_version');
  assert.equal((await uploadSupplement(f, privatePath, owner, 3)).body.error, 'invalid_transition');
  assert.equal((await f.get(workbench, { auth: f.duty })).body.counts.pending_intake, 1);
  inspect(f.config, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM owner_supplement_photos').get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM case_events WHERE action = 'submit_supplement'").get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (isMainThread) test('v7 upgrade preserves old receipt and text supplement before photo supplement', async t => {
  const f = await fixture(t);
  const { receipt, owner, privatePath, staff } = await requestPhotoSupplement(f);
  const previous = await act(f, privatePath, owner, 'submit_supplement', 2, { summary: '旧版文字补件' });
  assert.equal(previous.status, 200);
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v7.sqlite' };
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, legacy.dbPath);
  } finally {
    source.close();
  }
  inspect(legacy, db => db.exec('DROP TABLE representative_report_releases; DROP TABLE tourism_event_ids; DROP TABLE tourism_events; DROP VIEW current_case_supervision; DROP TABLE case_supervision_events; DROP TABLE remediation_reviews; DROP TABLE remediation_entries; DROP TABLE case_contact_access_audit; DROP TABLE wechat_receipt_codes; DROP TABLE owner_supplement_photos; PRAGMA user_version = 7;'));
  const migrated = createIntakeServer({ ...legacy, now: f.now });
  f.cleanup.push(() => stop(migrated));
  const base = await listen(migrated);
  const get = f.client(base);
  const replay = await get(intakePath, { method: 'POST', auth: f.integration, body: form() });
  assert.deepEqual([replay.status, replay.body], [200, receipt]);
  const { body: { ownerSessionToken } } = await verify({ get }, receipt);
  assert.deepEqual((await get(privatePath, { auth: ownerSessionToken })).body, previous.body);
  assert.equal((await act({ get }, staff, f.duty, 'request_supplement', 3, { reason: '合成再补件' })).status, 200);
  const next = await uploadSupplement({ get }, privatePath, ownerSessionToken, 4);
  assert.equal(next.status, 200);
  assert.equal(next.body.supplementPhotos[0].submitVersion, 5);
  assert.deepEqual((await getPhoto(base, privatePath + '/supplement-photos/5/0', ownerSessionToken)).body, png);
  inspect(legacy, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

if (!isMainThread) {
  // Structured cloning turns a Buffer into a Uint8Array.
  const server = createIntakeServer({
    ...workerData,
    receiptKey: Buffer.from(workerData.receiptKey),
    now: () => new Date(workerData.fixedNow),
  });
  parentPort.once('message', async () => {
    await stop(server);
    parentPort.close();
  });
  parentPort.postMessage(await listen(server));
}

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';
import { SCHEMA_VERSION } from '../src/store.js';

const staffPath = '/api/v1/staff/cases/';
const publicPath = '/api/v1/public/cases';
const merchantPath = '/api/v1/merchant/cases';
const at = '2026-11-19T02:00:00.000Z';
const accessedAt = '2026-11-19T03:00:00.000Z';
const contact = 'synthetic-private-contact-example';
const missing = 'CD-' + '0'.repeat(32);
const desk = { id: 'desk', role: 'duty', token: 'd'.repeat(43), readContact: true };
const worker = { id: 'worker', role: 'handler', department: 'street', token: 'w'.repeat(43), readContact: true };
const lead = { id: 'lead', role: 'supervisor', department: 'street', token: 'l'.repeat(43), readContact: true };
const ordinary = { id: 'ordinary', role: 'duty', token: 'o'.repeat(43) };
const inherited = Object.assign(Object.create({ readContact: true }), {
  id: 'inherited', role: 'duty', token: 'h'.repeat(43),
});
const denied = { id: 'denied', role: 'duty', token: 'n'.repeat(43), readContact: false };
const shop = { id: 'member', merchantId: 'shop', token: 'm'.repeat(43), permissions: ['submitCases', 'readCases'] };
const options = {
  receiptKey: Buffer.alloc(32, 9), now: () => new Date(at),
  integrations: [{ source: 'synthetic', token: 'i'.repeat(43) }],
  staff: [desk, worker, lead, ordinary, denied, inherited], merchants: [shop],
};

function form(id, value) {
  const body = new FormData();
  body.append('payload', JSON.stringify({
    clientRequestId: id, occurredAt: at, location: '测试地点', category: '测试事项', description: '合成测试',
    ...(value ? { contact: value } : {}),
  }));
  return body;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'changdi-staff-contact-'));
  const dbPath = join(directory, 'test.sqlite');
  let server;
  let origin;
  async function stop() {
    if (!server) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
    server = null;
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    async start(extra = {}) {
      server = createIntakeServer({ ...options, dbPath, ...extra });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      origin = 'http://127.0.0.1:' + server.address().port;
    },
    stop,
    inspect(run) {
      const db = new DatabaseSync(dbPath);
      try {
        return run(db);
      } finally {
        db.close();
      }
    },
    async request(path, token, body, method = body === undefined ? 'GET' : 'POST') {
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      if (body !== undefined && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const response = await fetch(origin + path, { headers, method, body, signal: AbortSignal.timeout(6000) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      return { status: response.status, body: await response.json() };
    },
  };
}

const auditRows = db => db.prepare(`
  SELECT cases.case_number, audit.staff_id, audit.accessed_at
  FROM case_contact_access_audit AS audit JOIN cases ON cases.id = audit.case_id ORDER BY audit.rowid
`).all().map(row => ({ ...row }));

test('v10 升级保留旧单和联系方式，查阅范围与审计经回环 HTTP 核对', async t => {
  const f = await fixture(t);
  await f.start();
  const created = await f.request(publicPath, null, form('public-contact', contact));
  const empty = await f.request(publicPath, null, form('public-empty'));
  const merchant = await f.request(merchantPath, shop.token, form('shop-contact', contact));
  for (const response of [created, empty]) {
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode']);
  }
  assert.equal(merchant.status, 201);
  assert.deepEqual(Object.keys(merchant.body).sort(), ['caseNumber', 'publicLookupCode', 'status', 'submittedAt']);
  const { caseNumber, publicLookupCode, privateLookupToken } = created.body;
  const detail = staffPath + caseNumber;
  const action = detail + '/actions';
  assert.equal((await f.request(action, desk.token, { action: 'accept', expectedVersion: 1 })).status, 200);
  assert.equal((await f.request(action, desk.token, {
    action: 'assign', expectedVersion: 2, assignee: worker.id, dueAt: '2026-11-21T02:00:00Z',
  })).status, 200);
  const existing = db => ['cases', 'case_contacts', 'case_events', 'merchant_cases']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  await f.stop();
  const before = f.inspect(db => {
    db.exec('DROP TABLE representative_report_releases; DROP TABLE tourism_event_ids; DROP TABLE tourism_events; DROP VIEW current_case_supervision; DROP TABLE case_supervision_events; DROP TABLE remediation_reviews; DROP TABLE remediation_entries; DROP TABLE case_contact_access_audit; PRAGMA user_version = 10;');
    return existing(db);
  });
  await f.start({ now: () => new Date(accessedAt) });
  f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(existing(db), before);
    assert.throws(() => db.prepare('INSERT INTO case_contact_access_audit VALUES (?, ?, ?)').run(-1, 'desk', at),
      /FOREIGN KEY constraint failed/);
    assert.deepEqual(auditRows(db), []);
  });
  assert.equal((await f.request('/api/v1/staff/me', desk.token)).body.readContact, true);
  assert.equal((await f.request('/api/v1/staff/me', ordinary.token)).body.readContact, undefined);
  const owner = await f.request('/api/v1/owner/verify', null, { publicLookupCode, privateLookupToken });
  assert.equal(owner.status, 200);
  const { ownerSessionToken } = owner.body;

  for (const [token, status, error] of [
    [undefined, 401, 'unauthorized'], ['x'.repeat(43), 401, 'unauthorized'],
    [privateLookupToken, 401, 'unauthorized'], [ownerSessionToken, 401, 'unauthorized'],
    [ordinary.token, 403, 'forbidden'],
    [denied.token, 403, 'forbidden'], [inherited.token, 403, 'forbidden'], [shop.token, 403, 'forbidden'],
    [options.integrations[0].token, 403, 'forbidden'],
  ]) {
    for (const id of [caseNumber, empty.body.caseNumber, missing]) {
      assert.deepEqual(await f.request(staffPath + id + '/contact', token), { status, body: { error } });
    }
  }
  for (const principal of [worker, lead]) {
    for (const id of [empty.body.caseNumber, missing]) {
      assert.deepEqual(await f.request(staffPath + id + '/contact', principal.token),
        { status: 404, body: { error: 'case_not_found' } });
    }
    assert.deepEqual(await f.request(detail + '/contact', principal.token), { status: 200, body: { contact } });
  }
  assert.equal((await f.request(detail + '/contact', desk.token, undefined, 'POST')).status, 405);
  assert.deepEqual(await f.request(staffPath + empty.body.caseNumber + '/contact', desk.token),
    { status: 200, body: { contact: null } });
  const publicResult = await f.request(publicPath + '/' + publicLookupCode);
  assert.equal(publicResult.status, 200);
  assert.deepEqual(Object.keys(publicResult.body).sort(), ['caseNumber', 'milestones', 'status']);
  for (const result of [
    publicResult, await f.request(detail, desk.token), await f.request(detail, ordinary.token),
    await f.request('/api/v1/staff/cases', desk.token),
    await f.request('/api/v1/owner/cases/' + caseNumber, ownerSessionToken),
    await f.request(merchantPath + '/' + merchant.body.caseNumber, shop.token),
  ]) {
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body, 'contact'), false);
    assert.equal(JSON.stringify(result.body).includes(contact), false);
  }
  f.inspect(db => {
    assert.deepEqual(db.prepare('PRAGMA table_info(case_contact_access_audit)').all().map(row => row.name),
      ['case_id', 'staff_id', 'accessed_at']);
    assert.deepEqual(auditRows(db), [
      { case_number: caseNumber, staff_id: worker.id, accessed_at: accessedAt },
      { case_number: caseNumber, staff_id: lead.id, accessed_at: accessedAt },
      { case_number: empty.body.caseNumber, staff_id: desk.id, accessed_at: accessedAt },
    ]);
    assert.deepEqual(existing(db), before);
  });
});

test('联系方式表读取或审计写入失败时，HTTP 不下发联系方式', async t => {
  const f = await fixture(t);
  const logs = [];
  await f.start({ onInternalError: (...args) => logs.push(args) });
  const { body: { caseNumber } } = await f.request(publicPath, null, form('fail-closed', contact));
  const path = staffPath + caseNumber + '/contact';
  f.inspect(db => db.exec('ALTER TABLE case_contacts RENAME TO test_unavailable_contacts'));
  assert.deepEqual(await f.request(path, desk.token), { status: 500, body: { error: 'internal_error' } });
  f.inspect(db => {
    db.exec('ALTER TABLE test_unavailable_contacts RENAME TO case_contacts');
    db.exec(`CREATE TRIGGER test_ignore_audit BEFORE INSERT ON case_contact_access_audit
      BEGIN SELECT RAISE(IGNORE); END`);
  });
  assert.deepEqual(await f.request(path, desk.token), { status: 500, body: { error: 'internal_error' } });
  f.inspect(db => {
    assert.deepEqual(auditRows(db), []);
    db.exec('DROP TRIGGER test_ignore_audit');
  });
  assert.deepEqual(await f.request(path, desk.token), { status: 200, body: { contact } });
  assert.deepEqual(logs, [[], []]);
});

test('工作人员查阅配置只接受显式布尔值', () => {
  for (const readContact of ['true', 1, null]) {
    assert.throws(() => createIntakeServer({ ...options, dbPath: ':memory:', staff: [{ ...desk, readContact }] }),
      /Invalid staff directory entry/);
  }
});

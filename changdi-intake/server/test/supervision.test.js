import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';
import { openStore, SCHEMA_VERSION } from '../src/store.js';

const duty = { id: 'desk', role: 'duty', token: 'd'.repeat(43), supervision: true, readContact: true };
const plain = { id: 'plain', role: 'duty', token: 'p'.repeat(43) };
const lead = { id: 'lead', role: 'supervisor', department: 'a', token: 'l'.repeat(43), supervision: true };
const worker = { id: 'worker', role: 'handler', department: 'a', token: 'w'.repeat(43), supervision: true };
const otherWorker = { id: 'other', role: 'handler', department: 'b', token: 'b'.repeat(43), supervision: true };
const merchant = { id: 'shop-member', merchantId: 'shop', token: 'm'.repeat(43), permissions: ['readCases'] };
const supervision = {
  windowHours: 72,
  points: [{ code: 'east', label: '合成东点' }, { code: 'west', label: '合成西点' }],
  categories: [{ code: 'surface', label: '合成路面' }, { code: 'lighting', label: '合成照明' }],
};
const caseBase = '/api/v1/staff/cases/';
const ledger = '/api/v1/staff/remediation';
const report = month => '/api/v1/staff/monthly-report?month=2026-' + month;
const panel = receipt => caseBase + receipt.caseNumber + '/supervision';
const staffAction = receipt => caseBase + receipt.caseNumber + '/actions';
const at = time => '2026-' + time + '+08:00';
const contact = 'synthetic-secret-contact';
const sameMark = { pointCode: 'east', categoryCode: 'surface', reason: '合成标注说明' };

async function fixture(t, settings = supervision) {
  const directory = await mkdtemp(join(tmpdir(), 'changdi-supervision-'));
  const dbPath = join(directory, 'supervision.sqlite');
  let clock = new Date(at('10-27T10:00:00'));
  const options = {
    dbPath, receiptKey: Buffer.alloc(32, 45), now: () => clock, supervision: settings, publicRateLimit: { limit: 50 },
    integrations: [{ source: 'synthetic', token: 'i'.repeat(43) }],
    staff: [duty, plain, lead, worker, otherWorker], merchants: [merchant],
  };
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
  async function start(extra = {}) {
    server = createIntakeServer({ ...options, ...extra });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  await start();
  async function call(path, principal, data) {
    const headers = principal ? { Authorization: 'Bearer ' + (principal.token ?? principal) } : {};
    let body = data;
    if (data !== undefined && !(data instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(data);
    }
    const response = await fetch(origin + path, { headers, body, method: data === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(6000) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  }
  return {
    start, stop, call, clock: time => { clock = new Date(at(time)); },
    scopedReport(month, ids) {
      const store = openStore(dbPath, options.receiptKey, options.now, { supervision: settings });
      try {
        return store.monthlyReport(month, { includeDuplicates: true, includeCase: id => ids.has(id) });
      } finally {
        store.close();
      }
    },
    inspect(run) {
      const db = new DatabaseSync(dbPath);
      try { return run(db); } finally { db.close(); }
    },
    async submit(clientRequestId, occurredAt = clock.toISOString()) {
      const form = new FormData();
      form.set('payload', JSON.stringify({
        clientRequestId, occurredAt, contact, category: '合成自由文本分类',
        location: '合成自由文本点位', description: '合成正文',
      }));
      const result = await call('/api/v1/public/cases', null, form);
      assert.equal(result.status, 201);
      return result.body;
    },
  };
}

const check = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
};
const mark = (f, r, fields = {}, principal = duty, expectedRevision = 0) =>
  f.call(panel(r), principal, { action: 'classify', expectedRevision, ...sameMark, ...fields });
const confirm = (f, r, earlier, expectedRevision = 1, principal = duty) =>
  f.call(panel(r), principal, { action: 'confirm', expectedRevision, targetCaseNumber: earlier.caseNumber, reason: '合成人工核实' });
const revoke = (f, r, expectedRevision = 2, principal = duty) =>
  f.call(panel(r), principal, { action: 'revoke', expectedRevision, reason: '合成撤销说明' });

async function assign(f, receipt, handler) {
  check(await f.call(staffAction(receipt), duty, { action: 'accept', expectedVersion: 1 }));
  check(await f.call(staffAction(receipt), duty, {
    action: 'assign', expectedVersion: 2, assignee: handler.id, dueAt: at('12-10T08:00:00'),
  }));
}

test('结构化候选、并发人工判重和北京时间月末回放', async t => {
  const f = await fixture(t);
  const stale = await f.submit('too-early', at('10-29T00:19:59'));
  const edge = await f.submit('window-start-inclusive', at('10-29T00:20:00'));
  check(await mark(f, stale));
  check(await mark(f, edge));
  f.clock('10-31T22:20:00');
  const original = await f.submit('cross-month', at('10-31T22:00:00'));
  const tie = await f.submit('tie-cross-department', at('10-31T22:00:00'));
  const otherCategory = await f.submit('different-category', at('10-31T22:00:00'));
  const otherPoint = await f.submit('different-point', at('10-31T22:00:00'));
  check(await mark(f, original));
  check(await mark(f, tie));
  check(await mark(f, otherCategory, { categoryCode: 'lighting' }));
  check(await mark(f, otherPoint, { pointCode: 'west' }));
  await assign(f, original, worker);
  await assign(f, tie, otherWorker);

  f.clock('11-01T00:21:00');
  const later = await f.submit('after-month-boundary', at('11-01T00:20:00'));
  const unknown = await f.submit('unknown-matching-free-text', at('11-01T00:20:00'));
  const action = panel(later);
  check(await f.call(action), 401);
  check(await f.call(action, merchant), 403);
  check(await f.call(action, plain), 403);
  check(await f.call(action, worker), 404);
  const unmarked = check(await f.call(action, duty));
  assert.equal(unmarked.revision, 0);
  assert.equal(unmarked.classification, null);
  assert.deepEqual(unmarked.candidates, []);
  check(await mark(f, later, { pointCode: 'invented' }), 400);
  await assign(f, later, worker);
  assert.deepEqual(check(await mark(f, later, {}, lead)).candidates.map(item => item.caseNumber), [original.caseNumber]);
  assert.deepEqual(check(await f.call(action, duty)).candidates.map(item => item.caseNumber),
    [tie.caseNumber, original.caseNumber, edge.caseNumber], '相同发生时间稳定排序，含窗口起点');
  for (const entry of [later, unknown, stale, otherCategory, otherPoint]) check(await confirm(f, later, entry), 404);
  check(await confirm(f, later, tie, 1, worker), 404);
  f.clock('11-01T01:00:00');
  const pending = check(await f.call(report('11'), duty)).duplicateComplaints;
  assert.deepEqual(pending, {
    status: 'partial', submitted: 2, covered: 1, unclassified: 1, windowHours: 72, confirmed: 0, notConfirmed: 1,
  });
  const concurrently = await Promise.all([confirm(f, later, original, 1, lead), confirm(f, later, original, 1, lead)]);
  assert.deepEqual(concurrently.map(result => result.status).sort(), [200, 409]);
  assert.equal(check(concurrently.find(result => result.status === 200)).targetCaseNumber, original.caseNumber);
  check(await mark(f, original, { pointCode: 'west' }, duty, 1), 409);
  check(await mark(f, later, { pointCode: 'west' }, duty, 2), 409);
  check(await confirm(f, original, stale), 409);

  f.clock('11-02T00:30:00');
  const withdrawn = await f.submit('revoke-before-cutoff');
  check(await mark(f, withdrawn));
  check(await confirm(f, withdrawn, later), 404);
  check(await confirm(f, withdrawn, original));
  const revoked = await Promise.all([revoke(f, withdrawn), revoke(f, withdrawn)]);
  assert.deepEqual(revoked.map(result => result.status).sort(), [200, 409]);

  f.clock('11-03T09:00:00');
  check(await f.call(staffAction(later), worker, { action: 'start', expectedVersion: 3 }));
  check(await f.call(staffAction(later), worker, {
    action: 'submit_result', expectedVersion: 4, summary: '合成办理', photoOmissionReason: '测试无需照片',
  }));
  check(await f.call(staffAction(later), lead, { action: 'publish', expectedVersion: 5, summary: '合成完成' }));
  const { publicLookupCode, privateLookupToken } = later;
  const owner = check(await f.call('/api/v1/owner/verify', null, { publicLookupCode, privateLookupToken }));
  check(await f.call('/api/v1/owner/cases/' + later.caseNumber + '/actions', owner.ownerSessionToken, {
    action: 'request_reopen', expectedVersion: 6, reason: '合成补办',
  }));
  check(await f.call(staffAction(later), lead, {
    action: 'approve_reopen', expectedVersion: 7, assignee: worker.id, dueAt: at('12-10T08:00:00'), nextStatus: 'assigned',
  }));
  check(await f.call(staffAction(original), duty, {
    action: 'reassign', expectedVersion: 3, assignee: otherWorker.id, dueAt: at('12-10T08:00:00'), reason: '合成转派',
  }));
  const masked = check(await f.call(action, worker));
  assert.equal(masked.linked, true);
  assert.equal(masked.targetCaseNumber, null);
  assert.equal(masked.lastChange, null);
  assert.doesNotMatch(JSON.stringify(masked), new RegExp(original.caseNumber));
  check(await revoke(f, later, 2, worker), 404);

  f.clock('12-01T00:00:00');
  const final = check(await f.call(report('11'), duty));
  assert.equal(final.firstResponse.submitted, 3);
  assert.deepEqual(final.duplicateComplaints, {
    status: 'partial', submitted: 3, covered: 2, unclassified: 1, windowHours: 72, confirmed: 1, notConfirmed: 1,
  });
  assert.deepEqual(final.reopen, { applications: 1, approved: 1, rejected: 0, newRounds: 1 });
  const onlyLater = f.inspect(db => db.prepare('SELECT id FROM cases WHERE case_number = ?').get(later.caseNumber).id);
  const scoped = f.scopedReport('2026-11', new Set([onlyLater]));
  assert.equal(scoped.firstResponse.submitted, 1);
  assert.equal(scoped.completion.accepted, 1);
  assert.equal(scoped.reopen.applications, 1);
  assert.equal(scoped.evaluation.publishedRounds, 1);
  assert.equal(scoped.duplicateComplaints.confirmed, 0, '原单不在月报范围，不计入重复');
  const emptyScope = f.scopedReport('2026-11', new Set());
  assert.equal(emptyScope.reopen.applications, 0);
  assert.equal(emptyScope.evaluation.publishedRounds, 0);
  check(await revoke(f, later));
  check(await mark(f, original, { pointCode: 'west' }, duty, 1));
  f.clock('12-01T00:01:00');
  assert.equal(check(await f.call(action, duty)).linked, false);
  assert.deepEqual(check(await f.call(report('11'), duty)).duplicateComplaints, final.duplicateComplaints);
  assert.equal(check(await f.call(report('11'), plain)).duplicateComplaints.status, 'unavailable');
  check(await f.call(report('11'), lead), 403);
  assert.doesNotMatch(JSON.stringify(final), /CD-[0-9A-F]{32}|synthetic-secret-contact|合成人工核实|合成自由文本|photo/);
  f.inspect(db => {
    const history = db.prepare(`
      SELECT s.action, s.reason, s.staff_id, s.changed_at FROM case_supervision_events s
      JOIN cases c ON c.id = s.case_id WHERE c.case_number = ? ORDER BY s.revision
    `).all(later.caseNumber).map(row => [row.action, row.reason, row.staff_id, row.changed_at]);
    assert.deepEqual(history, [
      ['classify', sameMark.reason, lead.id, new Date(at('11-01T00:21:00')).toISOString()],
      ['confirm', '合成人工核实', lead.id, new Date(at('11-01T01:00:00')).toISOString()],
      ['revoke', '合成撤销说明', duty.id, new Date(at('12-01T00:00:00')).toISOString()],
    ]);
  });
});

test('候选返回数量固定上限，排序不受自由文本影响', async t => {
  const f = await fixture(t);
  const candidates = [];
  for (let index = 0; index < 22; index++) {
    const earlier = await f.submit('bounded-candidate-' + index);
    candidates.push(earlier.caseNumber);
    check(await mark(f, earlier));
  }
  f.clock('10-27T10:01:00');
  const after = await f.submit('bounded-target');
  const result = check(await mark(f, after));
  assert.equal(result.candidateLimit, 20);
  assert.deepEqual(result.candidates.map(item => item.caseNumber), candidates.toReversed().slice(0, 20));
});

test('未配置时维持缺失指标，v11 升级保留联系方式审计，台账只向全街授权值班开放', async t => {
  const f = await fixture(t, null);
  const receipt = await f.submit('prior-case');
  check(await f.call(caseBase + receipt.caseNumber + '/contact', duty));
  const before = check(await f.call(report('10'), duty));
  assert.equal(check(await f.call('/api/v1/staff/me', duty)).supervision, undefined);
  assert.deepEqual(before.duplicateComplaints, { status: 'unavailable', reason: 'structured_location_and_confirmation_missing' });
  check(await f.call(panel(receipt), duty), 403);
  check(await f.call(ledger, duty), 403);
  await f.stop();
  const rows = db => ['cases', 'case_contacts', 'case_events', 'case_contact_access_audit']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  const original = f.inspect(db => {
    db.exec(`
      DROP TABLE representative_report_releases;
    DROP TABLE tourism_event_ids;
    DROP TABLE tourism_events;
    DROP VIEW current_case_supervision;
      DROP TABLE case_supervision_events;
      DROP TABLE remediation_reviews;
      DROP TABLE remediation_entries;
      PRAGMA user_version = 11;
    `);
    return rows(db);
  });
  await f.start({ supervision });
  f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(rows(db), original);
  });
  assert.equal(check(await f.call('/api/v1/staff/me', duty)).supervision, true);
  assert.equal(check(await f.call('/api/v1/staff/me', plain)).supervision, undefined);
  f.clock('10-27T10:01:00');
  assert.deepEqual(check(await f.call(report('10'), duty)).duplicateComplaints, {
    status: 'unavailable', reason: 'structured_coverage_missing', submitted: 1, covered: 0, unclassified: 1, windowHours: 72,
  });
  check(await mark(f, receipt));
  f.clock('10-27T10:02:00');
  assert.deepEqual(check(await f.call(report('10'), duty)).duplicateComplaints, {
    status: 'available', submitted: 1, covered: 1, unclassified: 0, windowHours: 72, confirmed: 0, notConfirmed: 1,
  });

  const data = { topic: '合成协商主题', minutes: '合成内部纪要', responsibleUnit: '合成责任单位', dueAt: at('10-30T18:00:00') };
  for (const principal of [plain, merchant, lead, worker]) {
    check(await f.call(ledger, principal), 403);
    check(await f.call(ledger, principal, data), 403);
  }
  check(await f.call(ledger), 401);
  check(await f.call(ledger, duty, { ...data, dueAt: at('10-26T18:00:00') }), 400);
  check(await f.call(ledger, duty, { ...data, score: 5 }), 400);
  const created = check(await f.call(ledger, duty, data), 201);
  assert.equal(created.revision, 1);
  assert.equal(created.staffId, duty.id);
  assert.equal(created.status, 'open');
  const path = ledger + '/' + created.id;
  check(await f.call(path, worker), 403);
  check(await f.call(path + '/reviews', lead, { expectedRevision: 1, notes: '不允许', conclusion: 'resolved' }), 403);
  const listing = check(await f.call(ledger, duty));
  assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].topic, data.topic);
  assert.doesNotMatch(JSON.stringify(listing), /合成内部纪要/);
  const review = { expectedRevision: 1, notes: '合成复查纪要', conclusion: 'follow_up' };
  const concurrent = await Promise.all([f.call(path + '/reviews', duty, review), f.call(path + '/reviews', duty, review)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  f.clock('10-28T10:00:00');
  check(await f.call(path + '/reviews', duty, { expectedRevision: 2, notes: '合成复查通过', conclusion: 'resolved' }));
  check(await f.call(path + '/reviews', duty, { ...review, expectedRevision: 3 }), 409);
  const detail = check(await f.call(path, duty));
  assert.equal(detail.status, 'resolved');
  assert.deepEqual(detail.reviews.map(row => [row.revision, row.notes, row.conclusion, row.staffId, row.reviewedAt]), [
    [2, review.notes, 'follow_up', duty.id, new Date(at('10-27T10:02:00')).toISOString()],
    [3, '合成复查通过', 'resolved', duty.id, new Date(at('10-28T10:00:00')).toISOString()],
  ]);
  const aggregate = check(await f.call(report('10'), duty));
  assert.doesNotMatch(JSON.stringify(aggregate), /合成协商主题|合成内部纪要|合成复查|synthetic-secret-contact/);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM remediation_entries').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM remediation_reviews').get().n, 2);
  });
});

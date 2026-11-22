import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';

const intakePath = '/api/v1/integrations/intake/cases';
const staffCases = '/api/v1/staff/cases';
const merchantTasks = '/api/v1/merchant/collaborations';
const token = () => randomBytes(32).toString('base64url');
const dueAt = '2026-11-20T02:00:00.000Z';
const syntheticPhoto = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
    'base64');
const feedbackPhoto = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNIrJ4DAAK5AXlwqBQ7AAAAAElFTkSuQmCC',
    'base64');

function formWithPhoto(payload, bytes) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  form.append('photos', new Blob([bytes], {type: 'image/png'}), 'synthetic.png');
  return form;
}

function intakeForm() {
  return formWithPhoto({
    externalCaseId: 'three-window-road-001',
    occurredAt: '2026-11-19T09:30:00+08:00',
    location: '合成测试精确地址',
    category: '街面维护',
    description: '合成路面砖块松动',
    contact: 'synthetic-private-contact',
  }, syntheticPhoto);
}

test('一张外部工单走完公众、管理方和商户协办，并沿原编号开启补办轮次', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'changdi-three-window-'));
  let server;
  t.after(async () => {
    try {
      if (server) {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
        assert.equal(server.listening, false);
        assert.equal(server.address(), null);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory), { code: 'ENOENT' });
    }
  });

  const partner = token();
  const duty = token();
  const handler = token();
  const supervisor = token();
  const shopA = token();
  const shopB = token();
  server = createIntakeServer({
    dbPath: join(directory, 'acceptance.sqlite'),
    receiptKey: randomBytes(32),
    now: () => new Date('2026-11-19T02:00:00.000Z'),
    integrations: [{ source: 'synthetic-platform', token: partner }],
    staff: [
      { id: 'desk', role: 'duty', token: duty },
      { id: 'handler', role: 'handler', department: 'street', token: handler },
      { id: 'supervisor', role: 'supervisor', department: 'street', token: supervisor },
    ],
    merchants: [
      { id: 'shop-a-member', merchantId: 'shop-a', token: shopA, permissions: ['readCases', 'collaborate'] },
      { id: 'shop-b-member', merchantId: 'shop-b', token: shopB, permissions: ['readCases', 'collaborate'] },
    ],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  async function request(path, {auth, body, status = 200, binary = false} = {}) {
    const headers = {};
    if (auth) headers.Authorization = 'Bearer ' + auth;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(origin + path, {
      method, headers, body, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, status, method + ' ' + path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    if (binary) {
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('content-disposition'), 'attachment');
      return Buffer.from(await response.arrayBuffer());
    }
    return response.json();
  }

  function change(path, auth, item, action, fields = {}, status = 200) {
    return request(path + '/actions', {
      auth, body: { action, expectedVersion: item.version, ...fields }, status,
    });
  }

  const receipt = await request(intakePath, { auth: partner, body: intakeForm(), status: 201 });
  const { caseNumber, publicLookupCode, privateLookupToken } = receipt;
  assert.deepEqual(await request(intakePath, { auth: partner, body: intakeForm() }), receipt);

  const publicPath = '/api/v1/public/cases/' + publicLookupCode;
  const staffPath = staffCases + '/' + caseNumber;
  const ownerPath = '/api/v1/owner/cases/' + caseNumber;
  const staffTasks = staffPath + '/collaborations';
  const publicStart = await request(publicPath);
  assert.deepEqual(Object.keys(publicStart).sort(), ['caseNumber', 'milestones', 'status']);
  assert.equal(publicStart.caseNumber, caseNumber);
  assert.equal(publicStart.status, 'submitted');

  const pending = await request(staffCases + '?queue=pending_intake', { auth: duty });
  assert.deepEqual(pending.items.map(item => item.caseNumber), [caseNumber]);
  const received = await request(staffPath, { auth: duty });
  assert.doesNotMatch(JSON.stringify(received), /synthetic-private-contact/);
  const requirement = await change(
      staffPath, duty, received, 'request_supplement',
      {reason: '请补充发现问题的时段'});
  const awaitingSupplement = await request(publicPath);
  assert.equal(awaitingSupplement.status, 'awaiting_supplement');
  assert.doesNotMatch(JSON.stringify(awaitingSupplement), /请补充|reason/);
  await request(ownerPath, {status: 401});
  const session = await request('/api/v1/owner/verify', {
    body: {publicLookupCode, privateLookupToken},
  });
  assert.equal(session.caseNumber, caseNumber);
  const owner = session.ownerSessionToken;
  const ownerRequirement = await request(ownerPath, {auth: owner});
  assert.equal(ownerRequirement.supplementRequirement.reason, '请补充发现问题的时段');
  const supplemented = await request(ownerPath + '/actions', {
    auth: owner,
    body: formWithPhoto({
      action: 'submit_supplement',
      expectedVersion: requirement.version,
      summary: '发现时间约为上午十点',
    }, syntheticPhoto),
  });
  assert.equal(supplemented.caseNumber, caseNumber);
  assert.equal(supplemented.status, 'submitted');
  const supplementPath = '/supplement-photos/' + supplemented.version + '/0';
  await request(ownerPath + supplementPath, {status: 401});
  await request(staffPath + supplementPath, {auth: shopA, status: 403});
  assert.deepEqual(await request(staffPath + supplementPath, {
    auth: duty, binary: true,
  }), syntheticPhoto);
  const accepted = await change(staffPath, duty, supplemented, 'accept');
  const assigned = await change(staffPath, duty, accepted, 'assign', { assignee: 'handler', dueAt });
  assert.equal(assigned.status, 'assigned');

  const assignedTask = await request(staffTasks, {
    auth: duty,
    body: {
      expectedVersion: assigned.version, merchantId: 'shop-a',
      instructions: '核查松动砖块附近的商户通道', location: '合成协办通道', dueAt,
    },
    status: 201,
  });
  assert.equal(assignedTask.caseVersion, assigned.version + 1);
  assert.equal(assignedTask.version, 1);

  const shopTaskPath = merchantTasks + '/' + assignedTask.taskId;
  const reviewPath = staffTasks + '/' + assignedTask.taskId;
  const shopQueue = await request(merchantTasks, { auth: shopA });
  assert.deepEqual(shopQueue.items.map(item => item.taskId), [assignedTask.taskId]);
  assert.deepEqual((await request(merchantTasks, { auth: shopB })).items, []);
  await request(shopTaskPath, { auth: shopB, status: 404 });
  await request(staffPath, { auth: shopA, status: 403 });

  const shopTask = await request(shopTaskPath, { auth: shopA });
  assert.equal(shopTask.location, '合成协办通道');
  assert.doesNotMatch(JSON.stringify(shopTask), /合成测试精确地址|合成路面砖块松动|caseNumber|privateLookup|contact/);
  const submittedTask = await request(shopTaskPath + '/submissions', {
    auth: shopA,
    body: formWithPhoto({
      expectedVersion: shopTask.version, summary: '已初步核查通道',
    }, syntheticPhoto),
  });
  const shopPhoto = shopTaskPath + '/submission-photos/' + submittedTask.version + '/0';
  await request(shopPhoto, {auth: shopB, status: 404});
  assert.deepEqual(await request(shopPhoto, {
    auth: shopA, binary: true,
  }), syntheticPhoto);
  const returnedTask = await change(reviewPath, supervisor, submittedTask, 'return', { reason: '请补充范围' });
  const shopRetry = await request(shopTaskPath, { auth: shopA });
  assert.deepEqual([shopRetry.status, shopRetry.version, shopRetry.returnReason],
    ['returned', returnedTask.version, '请补充范围']);
  const resubmittedTask = await request(shopTaskPath + '/submissions', {
    auth: shopA, body: { expectedVersion: shopRetry.version, summary: '松动区域已明确，商户通道可通行' },
  });
  const approvedTask = await change(reviewPath, supervisor, resubmittedTask, 'approve');
  assert.deepEqual([approvedTask.status, approvedTask.version], ['approved', assignedTask.version + 4]);

  const main = await request(staffPath, { auth: handler });
  assert.deepEqual([main.caseNumber, main.status, main.version], [caseNumber, 'assigned', assignedTask.caseVersion]);
  const processing = await change(staffPath, handler, main, 'start');
  const draft = await request(staffPath + '/actions', {
    auth: handler,
    body: formWithPhoto({
      action: 'submit_result', expectedVersion: processing.version,
      summary: '内部草稿，砖块已固定并复查通道',
    }, syntheticPhoto),
  });
  const rawPhoto = staffPath + '/submission-photos/' + draft.version + '/0';
  await request(rawPhoto, {auth: partner, status: 403});
  assert.deepEqual(await request(rawPhoto, {
    auth: supervisor, binary: true,
  }), syntheticPhoto);
  await change(staffPath, handler, draft, 'publish', { summary: '越权发布' }, 403);
  const feedback = '已固定松动砖块，商户通道复查可通行';
  const published = await request(staffPath + '/actions', {
    auth: supervisor,
    body: formWithPhoto({
      action: 'publish', expectedVersion: draft.version, summary: feedback,
      derivativesReviewed: true,
    }, feedbackPhoto),
  });
  const publishedPhoto = ownerPath + '/feedback-photos/' + published.version + '/0';
  await request(publishedPhoto, {status: 401});
  await request(publishedPhoto, {auth: shopA, status: 401});
  assert.deepEqual(await request(publishedPhoto, {
    auth: owner, binary: true,
  }), feedbackPhoto);
  const publicPublished = await request(publicPath);
  assert.deepEqual(publicPublished, {
    caseNumber, status: 'awaiting_evaluation',
    milestones: ['submitted', 'awaiting_supplement', 'submitted', 'accepted',
      'assigned', 'processing', 'awaiting_evaluation']
      .map(status => ({ status, occurredAt: '2026-11-19T02:00:00.000Z' })),
  });

  const detail = await request(ownerPath, { auth: owner });
  assert.equal(detail.version, published.version);
  assert.equal(detail.rounds[0].feedback.summary, feedback);

  const scores = { speed: 4, effectiveness: 5, attitude: 3 };
  const evaluated = await change(ownerPath, owner, detail, 'evaluate', scores);
  const closed = await change(ownerPath, owner, evaluated, 'confirm_resolved');
  assert.equal(closed.status, 'closed');
  const reopened = await change(ownerPath, owner, closed, 'request_reopen', { reason: '合成复查发现一块边砖仍松动' });
  assert.equal(reopened.status, 'reopen_pending');
  await change(staffPath, supervisor, reopened, 'approve_reopen', {
    assignee: 'handler', dueAt, nextStatus: 'assigned',
  });

  const nextRound = await request(ownerPath, { auth: owner });
  assert.deepEqual([nextRound.caseNumber, nextRound.status, nextRound.round], [caseNumber, 'assigned', 2]);
  const firstRound = nextRound.rounds[0];
  const { speed, effectiveness, attitude } = firstRound.evaluation;
  assert.equal(firstRound.feedback.summary, feedback);
  assert.deepEqual({ speed, effectiveness, attitude }, scores);
  assert.deepEqual(nextRound.rounds[1], { round: 2, feedback: null, evaluation: null });
  assert.equal(nextRound.reopenRequests[0].decision, 'approved');
});

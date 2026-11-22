import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeServer } from '../src/server.js';

const publicCasesPath = '/api/v1/public/cases';
const token = () => randomBytes(32).toString('base64url');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z',
  'base64',
);
const payload = {
  clientRequestId: 'mp-20261119-0001',
  occurredAt: '2026-11-19T09:00:00+08:00',
  location: '合成测试地点：长堤风貌街 A 段',
  category: '街面维护',
  description: '合成测试正文：路面砖块松动',
  suggestedDepartment: '合成建议部门',
  contact: 'synthetic-contact-0001',
};
const photo = { bytes: png, type: 'image/png', name: 'example.png' };
const photo2 = { bytes: jpeg, type: 'image/jpeg', name: 'example.jpg' };

function form(value = payload, photos = []) {
  const data = new FormData();
  data.append('payload', JSON.stringify(value));
  for (const { bytes, type, name } of photos) data.append('photos', new Blob([bytes], { type }), name);
  return data;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function stop(server) {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
  assert.equal(server.listening, false);
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'changdi-public-'));
  const cleanup = [];
  t.after(async () => {
    await Promise.allSettled(cleanup.map(close => close()));
    await rm(directory, { recursive: true, force: true });
  });
  const staffToken = token();
  const integrationToken = token();
  const config = {
    dbPath: join(directory, 'public.sqlite'),
    receiptKey: randomBytes(32),
    integrations: [{ source: 'synthetic-platform', token: integrationToken }],
    staff: [{ id: 'desk', role: 'duty', token: staffToken }],
    merchants: [],
    ...options,
  };
  let current = new Date('2026-11-19T02:00:00.000Z');
  const server = createIntakeServer({ ...config, now: () => current });
  cleanup.push(() => stop(server));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  async function post(body = form(), headers = {}) {
    const response = await fetch(origin + publicCasesPath, {
      method: 'POST', body, headers, signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  async function get(path, headers = {}) {
    const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  return {
    config, origin, post, get, staffToken, integrationToken,
    advanceClock: seconds => { current = new Date(current.valueOf() + seconds * 1000); },
    inspect(run) {
      const db = new DatabaseSync(config.dbPath);
      try {
        return run(db);
      } finally {
        db.close();
      }
    },
  };
}

test('游客匿名申报返回三件回执并以 public 身份记录建单事件', async t => {
  const f = await fixture(t);
  const created = await f.post(form(payload, [photo]));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(Object.keys(created.body).sort(), ['caseNumber', 'privateLookupToken', 'publicLookupCode']);
  assert.match(created.body.caseNumber, /^CD-[0-9A-F]{32}$/);
  assert.match(created.body.publicLookupCode, /^[A-Za-z0-9_-]{24}$/);
  assert.match(created.body.privateLookupToken, /^[A-Za-z0-9_-]{43}$/);
  f.inspect(db => {
    const item = db.prepare('SELECT source, external_case_id, status FROM cases').get();
    assert.deepEqual([item.source, item.external_case_id, item.status],
      ['miniprogram', payload.clientRequestId, 'submitted']);
    const event = db.prepare('SELECT action, actor_type, actor_id FROM case_events').get();
    assert.deepEqual([event.action, event.actor_type, event.actor_id], ['submit', 'public', 'miniprogram']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_contacts').get().n, 1);
  });
  const staff = await f.get('/api/v1/staff/cases/' + created.body.caseNumber, {
    Authorization: 'Bearer ' + f.staffToken,
  });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.sourceType, 'public');
});

test('同一 clientRequestId 同内容重放返回原回执且不重复落库', async t => {
  const f = await fixture(t);
  const created = await f.post(form(payload, [photo]));
  assert.equal(created.status, 201);
  // 字段顺序、照片顺序和文件名不影响内容比较。
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const replay = await f.post(form(reordered, [{ ...photo, name: 'renamed.png' }]));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, created.body);
  const again = await f.post(form(payload, [photo]));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, created.body);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_events').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_contacts').get().n, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('同一 clientRequestId 不同内容返回 409 且原单和附件保持不变', async t => {
  const f = await fixture(t);
  const created = await f.post(form(payload, [photo]));
  assert.equal(created.status, 201);
  const changed = await f.post(form({ ...payload, description: '合成测试正文：内容已被改动' }, [photo]));
  assert.equal(changed.status, 409);
  assert.deepEqual(changed.body, { error: 'submission_conflict' });
  const withoutPhoto = await f.post(form(payload, []));
  assert.equal(withoutPhoto.status, 409);
  assert.deepEqual(withoutPhoto.body, { error: 'submission_conflict' });
  const otherPhoto = await f.post(form(payload, [photo2]));
  assert.equal(otherPhoto.status, 409);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 1);
    assert.equal(db.prepare('SELECT description FROM cases').get().description, payload.description);
  });
});

test('缺字段、非法发生时间和未知字段返回 400 且不落库', async t => {
  const f = await fixture(t);
  const missingId = await f.post(form({ ...payload, clientRequestId: undefined }));
  assert.equal(missingId.status, 400);
  assert.deepEqual(missingId.body, { error: 'invalid_field' });
  const missingDescription = await f.post(form({ ...payload, description: undefined }));
  assert.equal(missingDescription.status, 400);
  assert.deepEqual(missingDescription.body, { error: 'invalid_field' });
  const missingLocation = await f.post(form({ ...payload, location: undefined }));
  assert.equal(missingLocation.status, 400);
  const withoutTimezone = await f.post(form({ ...payload, occurredAt: '2026-11-19T09:00:00' }));
  assert.equal(withoutTimezone.status, 400);
  assert.deepEqual(withoutTimezone.body, { error: 'invalid_timestamp' });
  const impossibleDate = await f.post(form({ ...payload, occurredAt: '2026-02-30T09:00:00+08:00' }));
  assert.equal(impossibleDate.status, 400);
  assert.deepEqual(impossibleDate.body, { error: 'invalid_timestamp' });
  const unknown = await f.post(form({ ...payload, source: 'forged-source' }));
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body, { error: 'unknown_field' });
  const notMultipart = await f.post(JSON.stringify(payload), { 'Content-Type': 'application/json' });
  assert.equal(notMultipart.status, 415);
  assert.deepEqual(notMultipart.body, { error: 'expected_multipart' });
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_events').get().n, 0);
  });
});

test('四张照片返回 413，伪造图片签名和不支持的类型返回 415', async t => {
  const f = await fixture(t);
  const tooMany = await f.post(form(payload, [photo, photo, photo, photo]));
  assert.equal(tooMany.status, 413);
  assert.deepEqual(tooMany.body, { error: 'too_many_photos' });
  const forged = await f.post(form(payload, [{
    bytes: Buffer.from('forged-image-content'), type: 'image/png', name: 'forged.png',
  }]));
  assert.equal(forged.status, 415);
  assert.deepEqual(forged.body, { error: 'invalid_photo_type' });
  const mismatched = await f.post(form(payload, [{ bytes: png, type: 'image/jpeg', name: 'mismatch.jpg' }]));
  assert.equal(mismatched.status, 415);
  const unsupported = await f.post(form(payload, [{
    bytes: png, type: 'application/pdf', name: 'document.pdf',
  }]));
  assert.equal(unsupported.status, 415);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 0);
  });
});

test('超过窗口上限返回 429 并带 Retry-After，窗口过后恢复', async t => {
  const f = await fixture(t, { publicRateLimit: { windowSeconds: 600, limit: 2 } });
  const first = await f.post(form({ ...payload, clientRequestId: 'mp-limit-1' }));
  assert.equal(first.status, 201);
  // 重放同一 clientRequestId 不消耗额度。
  const replay = await f.post(form({ ...payload, clientRequestId: 'mp-limit-1' }));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  const second = await f.post(form({ ...payload, clientRequestId: 'mp-limit-2' }));
  assert.equal(second.status, 201);
  const limited = await f.post(form({ ...payload, clientRequestId: 'mp-limit-3' }));
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: 'too_many_requests' });
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 600, 'retry-after');
  // 被限流的申报不落库。
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_events').get().n, 2);
  });
  f.advanceClock(601);
  const afterWindow = await f.post(form({ ...payload, clientRequestId: 'mp-limit-3' }));
  assert.equal(afterWindow.status, 201);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 3);
  });
});

test('额度用尽后重放已成功单号仍返回原回执，只有新建受限', async t => {
  const f = await fixture(t, { publicRateLimit: { windowSeconds: 600, limit: 1 } });
  const first = await f.post(form(payload, [photo]));
  assert.equal(first.status, 201);
  // 额度已满，重放同一 clientRequestId 仍取回原回执，不受上限影响。
  const replay = await f.post(form(payload, [photo]));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  // 内容不一致的重放是冲突，同样不受上限影响，也不消耗额度。
  const conflict = await f.post(form({ ...payload, description: '合成测试正文：内容已被改动' }, [photo]));
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { error: 'submission_conflict' });
  // 另起一个 clientRequestId 属于新建，超限返回 429 且不落库。
  const limited = await f.post(form({ ...payload, clientRequestId: 'mp-limit-2' }, [photo]));
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: 'too_many_requests' });
  assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'retry-after');
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_events').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 1);
  });
  // 窗口推进后可以继续新建。
  f.advanceClock(601);
  const afterWindow = await f.post(form({ ...payload, clientRequestId: 'mp-limit-2' }, [photo]));
  assert.equal(afterWindow.status, 201);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM case_events').get().n, 2);
  });
});

test('公开查询只返回编号、状态和公开节点', async t => {
  const f = await fixture(t);
  const created = await f.post(form(payload, [photo]));
  const viewed = await f.get('/api/v1/public/cases/' + created.body.publicLookupCode);
  assert.equal(viewed.status, 200);
  assert.deepEqual(Object.keys(viewed.body).sort(), ['caseNumber', 'milestones', 'status']);
  assert.equal(viewed.body.caseNumber, created.body.caseNumber);
  assert.equal(viewed.body.status, 'submitted');
  assert.deepEqual(viewed.body.milestones, [{ status: 'submitted', occurredAt: '2026-11-19T02:00:00.000Z' }]);
  assert.doesNotMatch(JSON.stringify(viewed.body), /合成测试正文|合成测试地点|合成建议部门/);
});

test('带联系方式的建单不在公开查询中泄漏联系方式', async t => {
  const f = await fixture(t);
  const created = await f.post(form({ ...payload, contact: 'synthetic-contact-0001' }, [photo]));
  assert.equal(created.status, 201);
  const viewed = await f.get('/api/v1/public/cases/' + created.body.publicLookupCode);
  assert.equal(viewed.status, 200);
  assert.doesNotMatch(JSON.stringify(viewed.body), /synthetic-contact-0001|contact/);
  assert.equal('contact' in viewed.body, false);
  f.inspect(db => {
    assert.equal(db.prepare('SELECT contact FROM case_contacts').get().contact, 'synthetic-contact-0001');
  });
});

test('启用微信小程序码时公开回执附 wechatCode', async t => {
  const wechatCode = {
    appId: 'wx1234567890abcdef',
    appSecret: 'FAKE_SYNTHETIC_APP_SECRET_EXAMPLE',
    envVersion: 'release',
    timeoutMs: 1000,
    async fetchImpl(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname === '/cgi-bin/stable_token') {
        return Response.json({ access_token: 'synthetic-access-token-01', expires_in: 7200 });
      }
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    },
  };
  const f = await fixture(t, { wechatCode });
  const created = await f.post(form(payload, [photo]));
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(),
    ['caseNumber', 'privateLookupToken', 'publicLookupCode', 'wechatCode']);
  assert.deepEqual(created.body.wechatCode, {
    envVersion: 'release', mediaType: 'image/png', base64: png.toString('base64'),
  });
  const replay = await f.post(form(payload, [photo]));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.wechatCode, created.body.wechatCode);
});

test('v9 库升级后保留原工单并接受 public 事件身份', async t => {
  const f = await fixture(t);
  // 升级前的库只有合作方来源，先用接入凭据建一单带照片的工单。
  const intake = new FormData();
  intake.append('payload', JSON.stringify({
    externalCaseId: 'legacy-001', occurredAt: '2026-11-19T09:00:00+08:00',
    location: '合成测试地点', category: '街面维护', description: '合成测试正文',
  }));
  intake.append('photos', new Blob([png], { type: 'image/png' }), 'legacy.png');
  const seeded = await fetch(f.origin + '/api/v1/integrations/intake/cases', {
    method: 'POST', headers: { Authorization: 'Bearer ' + f.integrationToken }, body: intake,
  });
  assert.equal(seeded.status, 201);
  const receipt = await seeded.json();
  const legacy = { ...f.config, dbPath: f.config.dbPath + '.v9.sqlite' };
  const source = new DatabaseSync(f.config.dbPath);
  try {
    await backup(source, legacy.dbPath);
  } finally {
    source.close();
  }
  // 把事件表退回 v9 的取值范围，模拟升级前的库。
  const downgrade = new DatabaseSync(legacy.dbPath);
  try {
    downgrade.exec('PRAGMA foreign_keys=OFF');
    downgrade.exec('PRAGMA legacy_alter_table=ON');
    downgrade.exec(`
      CREATE TABLE case_events_v9 (
          case_id INTEGER NOT NULL REFERENCES cases(id),
          version INTEGER NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('integration', 'staff', 'owner')),
          actor_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          detail TEXT NOT NULL CHECK (json_valid(detail)),
          public INTEGER NOT NULL CHECK (public IN (0, 1)),
          round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
          PRIMARY KEY (case_id, version)
      ) STRICT;
      INSERT INTO case_events_v9 SELECT * FROM case_events;
      DROP TABLE case_events;
      ALTER TABLE case_events_v9 RENAME TO case_events;
    `);
    downgrade.exec('PRAGMA legacy_alter_table=OFF');
    downgrade.exec('PRAGMA user_version = 9');
  } finally {
    downgrade.close();
  }
  const migrated = createIntakeServer({ ...legacy, now: () => new Date('2026-11-19T02:00:00.000Z') });
  const origin = await listen(migrated);
  try {
    const replay = await fetch(origin + '/api/v1/integrations/intake/cases', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.integrationToken }, body: intake,
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    const fresh = await fetch(origin + publicCasesPath, {
      method: 'POST',
      body: form({ ...payload, clientRequestId: 'mp-after-upgrade' }, [photo]),
    });
    assert.equal(fresh.status, 201);
    const db = new DatabaseSync(legacy.dbPath);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 2);
      assert.equal(db.prepare("SELECT count(*) AS n FROM case_events WHERE actor_type = 'public'").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM case_events WHERE actor_type = 'integration'").get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM attachments').get().n, 2);
    } finally {
      db.close();
    }
  } finally {
    await stop(migrated);
  }
});

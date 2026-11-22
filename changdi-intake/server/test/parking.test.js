import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntakeServer} from '../src/server.js';

const path = '/api/v1/public/parking/';
const query = 'recommendations?destination_id=CD-0001&arrive_at=2026-04-10T00:30:00Z';
const loaded = '2026-11-22T12:00:00.000Z';
const now = () => new Date(loaded);
const config = {dbPath: ':memory:', receiptKey: Buffer.alloc(32),
  integrations: [{source: 'demo', token: 'x'.repeat(32)}]};
async function start(t, options = {}) {
  const server = createIntakeServer({...config, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return suffix => fetch('http://127.0.0.1:' + server.address().port + path + suffix);
}

test('匿名推荐包含合成数据与可用车位', async t => {
  const get = await start(t);
  const res = await get(query);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const row = await res.json();
  assert.equal(row.source, 'synthetic');
  assert.equal(row.available, true);
  assert.ok(row.items.length && row.items[0].arrive_free !== null);
  assert.match(row.items[0].updated_at, /Z$/);
});

for (const [label, suffix, status, error] of [
  ['非法时间', query.replace('2026-04-10T00:30:00Z', 'yesterday'), 400, 'invalid_timestamp'],
  ['缺失时间', 'recommendations?destination_id=CD', 400, 'invalid_timestamp'],
  ['非法偏好', query + '&preference=fast', 400, 'invalid_field'],
  ['未知参数', query + '&debug=1', 400, 'invalid_filter'],
  ['重复参数', query + '&destination_id=x', 400, 'invalid_filter'],
  ['未知车场', 'lots/nope/forecast', 404, 'lot_not_found'],
  ['非法预测时距', 'lots/P1/forecast?horizons=15,90', 400, 'invalid_field'],
  ['时距值重复', 'lots/P1/forecast?horizons=15,15', 400, 'invalid_field'],
  ['时距键重复', 'lots/P1/forecast?horizons=15&horizons=30', 400, 'invalid_filter'],
  ['时距为空', 'lots/P1/forecast?horizons=', 400, 'invalid_field'],
  ['时距含空元素', 'lots/P1/forecast?horizons=15,', 400, 'invalid_field'],
  ['非法车高', query + '&vehicle_height_m=-1', 400, 'invalid_field'],
]) {
  test(label, async t => {
    const get = await start(t);
    const res = await get(suffix);
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), {error});
  });
}

test('重复推荐逐字节相同，停车时长只作用于本次费用', async t => {
  const get = await start(t);
  const first = await (await get(query)).text();
  const changed = await (await get(query + '&stay_hours=4')).json();
  const hourly = [...changed.items, ...changed.alternates].find(item => item.lot_id === 'P1');
  assert.equal(hourly.fee_amount, 20);
  assert.equal(await (await get(query)).text(), first);
});

test('预测支持指定时距和等价的东八区时间', async t => {
  const get = await start(t);
  const suffix = 'lots/P1/forecast?horizons=15,45&issued_at=';
  const a = await (await get(suffix + '2026-04-10T00:00:00Z')).json();
  assert.deepEqual(a.forecasts.map(f => f.horizon_minutes), [15, 45]);
  assert.equal(a.forecasts[0].target_ts, '2026-04-10T00:15:00.000Z');
  assert.deepEqual(await (await get(suffix + '2026-04-10T08:00:00%2B08:00')).json(), a);
});

test('空目录仍可读静态车场，三个接口均说明不可用', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'parking-api-'));
  t.after(() => rm(dir, {recursive: true}));
  const get = await start(t, {parkingDir: dir});
  for (const suffix of ['lots', query, 'lots/P1/forecast']) {
    const res = await get(suffix);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.ok(body.note);
    if (suffix === 'lots') assert.ok(body.items.some(item => item.lot_id === 'P1'));
    if (suffix.endsWith('/forecast')) {
      assert.equal(body.forecasts.length, 4);
      assert.ok(body.forecasts.every(row => row.method === 'unavailable' && row.point_free === null));
    }
  }
});

test('三个接口共享独立读取配额', async t => {
  const get = await start(t, {parkingRateLimit: {windowSeconds: 600, limit: 1}});
  assert.equal((await get('lots')).status, 200);
  const res = await get(query);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.deepEqual(await res.json(), {error: 'too_many_requests'});
});

for (const [label, parkingRateLimit] of [
  ['缺少窗口', {limit: 1}], ['窗口为零', {windowSeconds: 0, limit: 1}],
  ['窗口含小数', {windowSeconds: 1.5, limit: 1}], ['窗口毫秒溢出', {windowSeconds: Number.MAX_SAFE_INTEGER, limit: 1}],
  ['阈值为零', {windowSeconds: 1, limit: 0}], ['阈值为字符串', {windowSeconds: 1, limit: '1'}],
  ['未知配置键', {windowSeconds: 1, limit: 1, other: 1}], ['配置为空', null],
]) {
  test('非法限流配置阻止启动：' + label, () => {
    assert.throws(() => createIntakeServer({...config, parkingRateLimit}), /CHANGDI_PARKING_RATE_LIMIT/);
  });
}

test('合成窗口前的预测不可用，但运行时可用', async t => {
  const get = await start(t);
  const data = await (await get('lots/P1/forecast?issued_at=2025-01-01T00:00:00Z')).json();
  assert.equal(data.available, true);
  assert.equal(data.degraded, true);
  for (const f of data.forecasts) {
    assert.equal(f.method, 'unavailable');
    for (const key of ['point_free', 'p10', 'p90', 'free_rate', 'model_version', 'data_asof']) {
      assert.equal(f[key], null);
    }
    assert.ok(f.degrade_reason);
  }
});

test('内置车场采用产物清单的 UTC 生成时刻', async t => {
  const get = await start(t, {now});
  assert.equal((await (await get('lots')).json()).generated_at, '2026-04-14T16:00:00.000Z');
});

for (const [label, manifest, expected] of [
  ['缺失', undefined, loaded], ['损坏', '{', loaded],
  ['无时区', '{"generated_at":"2020-01-01T00:00:00"}', loaded],
  ['有效自定义清单', '{"generated_at":"2020-01-01T00:00:00-04:00"}', '2020-01-01T04:00:00.000Z'],
]) {
  test('装载清单：' + label, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'parking-manifest-'));
    t.after(() => rm(dir, {recursive: true}));
    await mkdir(join(dir, 'artifacts'));
    if (manifest !== undefined) await writeFile(join(dir, 'artifacts/manifest.json'), manifest);
    const get = await start(t, {parkingDir: dir, now});
    assert.equal((await (await get('lots')).json()).generated_at, expected);
  });
}

for (const [label, modelSource, lotSource, expected] of [
  ['模型优先', 'camera', 'manual', 'camera'], ['车场来源回退', undefined, 'manual', 'manual'],
  ['来源全部缺失', undefined, undefined, 'synthetic'],
]) {
  test('三个读取接口返回一致的来源：' + label, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'parking-source-'));
    t.after(() => rm(dir, {recursive: true}));
    await cp(new URL('../src/parking/vendor/', import.meta.url), dir, {recursive: true});
    const modelPath = join(dir, 'artifacts/model.json');
    const model = JSON.parse(await readFile(modelPath, 'utf8'));
    await writeFile(modelPath, JSON.stringify({...model, source: modelSource}));
    const lotPath = join(dir, 'data/synthetic/lots.jsonl');
    const lines = (await readFile(lotPath, 'utf8')).trim().split('\n');
    await writeFile(lotPath, lines.map(line => JSON.stringify({...JSON.parse(line), source: lotSource})).join('\n'));
    const get = await start(t, {parkingDir: dir});
    for (const suffix of ['lots', query, 'lots/P1/forecast']) {
      const body = await (await get(suffix)).json();
      assert.equal(body.available, true);
      assert.equal(body.source, expected);
    }
  });
}

for (const [arrive, expected] of [
  ['2026-04-10T00:30:00Z', '2026-04-10T00:00:00.000Z'],
  ['2026-11-23T00:30:00Z', loaded],
]) {
  test('推荐签发截点：' + arrive, async t => {
    const get = await start(t, {now});
    const row = await (await get('recommendations?destination_id=CD&arrive_at=' + arrive)).json();
    assert.equal(row.generated_at, expected);
  });
}

for (const scenario of ['版本不兼容', '预测期间异常']) {
  test(scenario, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'parking-runtime-'));
    t.after(() => rm(dir, {recursive: true}));
    await mkdir(join(dir, 'runtime'));
    const vendor = new URL('../src/parking/vendor/runtime/index.mjs', import.meta.url).href;
    const dataset = new URL('../src/parking/vendor/data/synthetic/', import.meta.url);
    const artifact = new URL('../src/parking/vendor/artifacts/model.json', import.meta.url);
    await writeFile(join(dir, 'runtime/index.mjs'), [
      'export * from ' + JSON.stringify(vendor),
      'import * as original from ' + JSON.stringify(vendor),
      "import {fileURLToPath} from 'node:url'",
      'export const loadDataset = () => original.loadDataset(fileURLToPath(' + JSON.stringify(dataset.href) + '))',
      scenario === '版本不兼容' ? "export const loadModel = () => ({schema_version: '9'})" :
        'export const loadModel = () => original.loadModel(fileURLToPath(' + JSON.stringify(artifact.href) + '))',
      "export function recommend() { throw new Error('fixture') }",
    ].join('\n'));
    const get = await start(t, {parkingDir: dir});
    const res = await get(query);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.equal(body.degraded, true);
    assert.equal(body.note, scenario === '版本不兼容' ? 'unsupported schema_version: 9' : 'parking prediction unavailable');
  });
}

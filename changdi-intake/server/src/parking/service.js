import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {timestamp} from '../http.js';

const vendor = fileURLToPath(new URL('./vendor/', import.meta.url));
const lotFields = ['lot_id', 'name', 'total_spaces', 'fee', 'access', 'walk_to_street', 'district', 'notes', 'source'];
const pickLot = lot => Object.fromEntries(lotFields.map(key => [key, lot[key]]));
const utc = value => value == null ? null : new Date(value).toISOString();
// 上游以东八区墙钟进行时段匹配，输入必须先转为当地时间。
const local = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';

async function loadState(dir) {
  const state = {lots: [], note: null};
  try {
    const manifest = JSON.parse(await readFile(resolve(dir, 'artifacts/manifest.json'), 'utf8'));
    state.generatedAt = timestamp(manifest.generated_at);
  } catch { /* 清单缺失或时间无效时，目录接口使用装载时刻。 */ }
  for (const root of new Set([dir, vendor])) {
    try {
      const data = await readFile(resolve(root, 'data/synthetic/lots.jsonl'), 'utf8');
      state.lots = data.split('\n').filter(line => line.trim()).map(line => pickLot(JSON.parse(line)));
      if (state.lots.length) break;
    } catch { /* 继续尝试内置静态车场。 */ }
  }
  let reason = 'parking runtime unavailable';
  try {
    state.runtime = await import(pathToFileURL(resolve(dir, 'runtime/index.mjs')).href);
    reason = 'invalid artifact';
    state.model = state.runtime.loadModel(resolve(dir, 'artifacts/model.json'));
    const result = state.runtime.validateArtifact(state.model);
    if (!result.ok) return {...state, note: result.error};
    reason = 'parking dataset unavailable';
    state.dataset = state.runtime.loadDataset(resolve(dir, 'data/synthetic'));
    if (!state.dataset.lots.length) return {...state, note: reason};
    state.lots = state.dataset.lots.map(pickLot);
  } catch {
    state.note = reason;
  }
  return state;
}

export async function loadParking(dir = vendor) {
  const state = await loadState(dir);
  let observations = state.dataset?.observations;
  if (!observations) {
    // 模型或运行时装载失败时，独立读取配置目录里的观测，避免混入内置示范值。
    try {
      const data = await readFile(resolve(dir, 'data/synthetic/observations.jsonl'), 'utf8');
      observations = data.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    } catch {
      observations = [];
    }
  }
  const latest = new Map();
  for (const row of observations) {
    const time = Date.parse(row?.ts);
    if (Number.isFinite(time) && time >= (latest.get(row.lot_id)?.time ?? -Infinity)) {
      latest.set(row.lot_id, {row, time});
    }
  }
  state.lots = state.lots.map(lot => {
    const observation = latest.get(lot.lot_id);
    return {...lot, current_free: observation?.row.free_spaces ?? null,
      current_observed_at: utc(observation?.time), current_quality: observation?.row.quality ?? null,
      current_stale: (observation?.row.age_seconds ?? 0) > 900};
  });
  // 无显式年龄时只保存过期截点，读取时比较时钟即可，无需重扫观测。
  state.staleAfter = new Map();
  for (const [id, {row, time}] of latest) {
    if (row.age_seconds == null) state.staleAfter.set(id, time + 900_000);
  }
  return state;
}

export function currentLots(state, now) {
  const time = now.getTime();
  return state.lots.map(lot => state.staleAfter.has(lot.lot_id)
    ? {...lot, current_stale: time > state.staleAfter.get(lot.lot_id)}
    : lot);
}

// 本接口不承诺预测精度；上游主口径为 MAE_ratio（绝对车位 MAE 见上游 metrics.json），当前数据为合成数据，不构成达标结论。
// 观测缺失（quality=missing/stale）时 free_spaces 为 NULL，0 表示真实零余位。本层保留观测与预测中的空值。
export function getForecast(state, id, issued, horizons) {
  const time = local(issued);
  const {forecasts} = state.runtime.forecastLot(state.dataset, state.model, id, time, time, horizons);
  return forecasts.map(row => ({...row, issued_at: issued,
    target_ts: utc(Date.parse(issued) + row.horizon_minutes * 60000), data_asof: utc(row.data_asof)}));
}

export function getRecommendations(state, query, height, stay) {
  const {destination_id, arrive_at, generated_at, preference} = query;
  const model = stay === undefined ? state.model : {...state.model,
    ranking_caps: {...state.model.ranking_caps, stay_hours: stay}};
  const options = {preference, vehicle: {height_m: height}, generatedAt: local(generated_at)};
  const result = state.runtime.recommend(state.dataset, model, destination_id, local(arrive_at), options);
  const normalize = row => ({...row, updated_at: utc(row.updated_at)});
  return {...result, ...query, items: result.items.map(normalize), alternates: result.alternates.map(normalize)};
}

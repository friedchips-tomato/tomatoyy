import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const vendor = fileURLToPath(new URL('./vendor/', import.meta.url));
const lotFields = ['lot_id', 'name', 'total_spaces', 'fee', 'access', 'walk_to_street', 'district', 'notes', 'source'];
const pickLot = lot => Object.fromEntries(lotFields.map(key => [key, lot[key]]));
const utc = value => value == null ? null : new Date(value).toISOString();
// 上游以东八区墙钟进行时段匹配，输入必须先转为当地时间。
const local = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';

export async function loadParking(dir = vendor) {
  const state = {lots: [], note: null};
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

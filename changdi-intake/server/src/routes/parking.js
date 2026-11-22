import {HttpError, readFilters, readText, requireMethod, sendJson, timestamp} from '../http.js';
import {getForecast, getRecommendations} from '../parking/service.js';

const prefix = '/api/v1/public/parking/';
const allowedHorizons = ['15', '30', '45', '60'];
const recommendationFields = ['destination_id', 'arrive_at', 'preference', 'vehicle_height_m', 'stay_hours'];

function instant(value) {
  try {
    return timestamp(value);
  } catch {
    throw new HttpError(400, 'invalid_timestamp');
  }
}

function positive(value) {
  if (value === null) return undefined;
  const number = Number(value);
  if (!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(number) || number <= 0) {
    throw new HttpError(400, 'invalid_field');
  }
  return number;
}

function evaluate(base, state, run) {
  const payload = {...base, source: 'synthetic', available: !state.note, degraded: Boolean(state.note), note: state.note};
  if (state.note) return payload;
  try {
    return {...payload, ...run()};
  } catch {
    return {...payload, available: false, degraded: true, note: 'parking prediction unavailable'};
  }
}

export async function handleParkingRoute(request, response, {parking, parkingLimit, now, snapshotAt}) {
  if (!request.url.startsWith(prefix)) return false;
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname.slice(prefix.length);
  const forecast = /^lots\/([A-Za-z0-9_-]{1,32})\/forecast$/.exec(path);
  if (!forecast && path !== 'recommendations' && path !== 'lots') return false;
  requireMethod(request, response, 'GET');
  parkingLimit(request.socket.remoteAddress);
  const state = await parking;
  let body;
  if (path === 'lots') {
    readFilters(url.search, []);
    body = evaluate({generated_at: snapshotAt, items: state.lots}, state, () => ({}));
  } else if (forecast) {
    const params = readFilters(url.search, ['issued_at', 'horizons']);
    const id = forecast[1];
    if (!state.lots.some(lot => lot.lot_id === id)) throw new HttpError(404, 'lot_not_found');
    const issued = params.has('issued_at') ? instant(params.get('issued_at')) : now().toISOString();
    const values = params.has('horizons') ? params.get('horizons').split(',') : allowedHorizons;
    if (values.some(h => !allowedHorizons.includes(h)) || new Set(values).size !== values.length) {
      throw new HttpError(400, 'invalid_filter');
    }
    body = evaluate({lot_id: id, issued_at: issued, forecasts: []}, state, () => {
      const forecasts = getForecast(state, id, issued, values.map(Number));
      const fallback = forecasts.find(f => f.degraded);
      return {forecasts, degraded: Boolean(fallback), note: fallback?.degrade_reason ?? null};
    });
    if (!body.available) {
      body.forecasts = values.map(value => ({
        lot_id: id, issued_at: issued, target_ts: new Date(Date.parse(issued) + Number(value) * 60000).toISOString(),
        horizon_minutes: Number(value), point_free: null, p10: null, p90: null, free_rate: null,
        method: 'unavailable', degraded: true, degrade_reason: body.note,
        model_version: null, data_asof: null, source: 'synthetic',
      }));
    }
  } else {
    const params = readFilters(url.search, recommendationFields);
    const id = params.get('destination_id');
    readText(id, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'invalid_field');
    const preference = params.get('preference') ?? 'save_time';
    if (!['save_time', 'less_walking'].includes(preference)) throw new HttpError(400, 'invalid_field');
    const arrive = instant(params.get('arrive_at'));
    const height = positive(params.get('vehicle_height_m'));
    const stay = positive(params.get('stay_hours'));
    // 合成数据固定，历史回放使用上游默认的提前半小时截点；未来查询最多使用装载时的数据。
    const generated = new Date(Math.min(Date.parse(snapshotAt), Date.parse(arrive) - 30 * 60000)).toISOString();
    const query = {destination_id: id, arrive_at: arrive, generated_at: generated, preference};
    body = evaluate({...query, items: [], alternates: [], excluded: [], offsets: []}, state, () => {
      const result = getRecommendations(state, query, height, stay);
      const fallback = [...result.items, ...result.alternates].find(row => row.degraded);
      return {degraded: Boolean(fallback), note: fallback ? '停车预测已降级（' + fallback.forecast_method + '）' : null,
        ...result};
    });
  }
  sendJson(response, 200, body);
  return true;
}

// 特征构造（与 Python src/pf/features.py 逐位一致）。防泄漏：只用 ts <= min(cutoff, issued_at)。

import {
  MINUTES_PER_SLOT, WEATHER_CODES, RAIN_WEATHER, PEAK_CODES,
  parseParts, epochSec, dateKey, dayNum, weekdayOfParts, slotOfParts, median,
} from "./format.mjs";

export const SAME_SLOT_WINDOW_DAYS = 28;
export const SAME_SLOT_HALF_SLOTS = 1;
export const SAME_WEEKDAY_HALF_SLOTS = 2;
export const SAME_SLOT_MIN_SAMPLES = 3;
export const SAME_WEEKDAY_MIN_SAMPLES = 2;
export const EVENT_LOOKBACK_MINUTES = 6 * 60;
export const EVENT_HORIZON_MINUTES = 2 * 60;

export const FEATURE_NAMES = [
  "free_lag_1", "free_lag_2", "free_lag_4",
  "free_known", "known_age_min", "free_rate_known",
  "drain_15", "drain_60",
  "same_slot_mean", "same_slot_median", "same_weekday_mean", "same_day_hist",
  "is_workday", "is_holiday", "is_weekend", "is_peak", "peak_type",
  "days_since_holiday", "days_to_holiday",
  "time_of_day_sin", "time_of_day_cos", "dow_sin", "dow_cos",
  "weather_code", "is_rain", "temperature_c",
  "event_strength", "event_in_2h", "event_size",
  "total_spaces", "base_rate", "day_of_history",
  "peak_x_workday", "rain_x_weekend",
  "lag_missing", "calendar_missing", "weather_missing", "event_missing", "periodic_missing",
];

const OK_STALE = new Set(["ok", "stale"]);

function byTs(a, b) {
  const x = a.ts.slice(0, 19), y = b.ts.slice(0, 19);
  return x < y ? -1 : (x > y ? 1 : 0);
}

export function prepare(dataset) {
  const lots = {};
  for (const l of dataset.lots) lots[l.lot_id] = l;

  const obsByLot = {};
  for (const lotId of Object.keys(lots)) {
    const rows = dataset.observations
      .filter((o) => o.lot_id === lotId)
      .sort(byTs)
      .map((o) => {
        const p = parseParts(o.ts);
        return {
          ts: o.ts, epoch: epochSec(o.ts), date: dateKey(o.ts),
          weekday: weekdayOfParts(p), slot: slotOfParts(p),
          free: o.free_spaces, quality: o.quality,
        };
      });
    obsByLot[lotId] = rows;
  }

  const calendar = dataset.signals.filter((s) => s.kind === "calendar").sort(byTs)
    .map((s) => ({ ...s, epoch: epochSec(s.ts) }));
  const weather = dataset.signals.filter((s) => s.kind === "weather").sort(byTs)
    .map((s) => ({ ...s, epoch: epochSec(s.ts) }));
  const events = dataset.signals.filter((s) => s.kind === "event").sort(byTs)
    .map((s) => ({ ...s, epoch: epochSec(s.ts) }));

  const holidays = [...new Set(calendar.filter((s) => s.is_holiday).map((s) => dateKey(s.ts)))].sort();

  return { lots, obsByLot, calendar, weather, events, holidays, hasEventData: events.length > 0 };
}

function latestAtOrBefore(rows, cutoffEpoch) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].epoch <= cutoffEpoch) return rows[i];
  }
  return null;
}

function freeAtOrBefore(obs, cutoffEpoch, qualities) {
  for (let i = obs.length - 1; i >= 0; i--) {
    const o = obs[i];
    if (o.epoch <= cutoffEpoch && qualities.has(o.quality) && o.free !== null) {
      return { ts: o.ts, epoch: o.epoch, free: o.free };
    }
  }
  return null;
}

function lagFeatures(index, lotId, issuedAt, effective, stats, values, meta) {
  const total = index.lots[lotId].total_spaces;
  const obs = index.obsByLot[lotId];

  const known = freeAtOrBefore(obs, effective, OK_STALE);
  const freeKnown = known ? known.free : null;
  const knownEpoch = known ? known.epoch : null;

  const lags = {};
  for (const k of [1, 2, 4]) {
    const cut = Math.min(issuedAt - MINUTES_PER_SLOT * 60 * k, effective);
    const hit = freeAtOrBefore(obs, cut, OK_STALE);
    lags["free_lag_" + k] = hit ? hit.free : null;
  }

  const lagMissing = freeKnown === null;
  if (freeKnown === null) {
    values.free_known = stats.lag_fill;
    values.known_age_min = stats.lag_fill;
    values.free_rate_known = stats.lag_fill;
  } else {
    values.free_known = freeKnown;
    values.known_age_min = (issuedAt - knownEpoch) / 60.0;
    values.free_rate_known = freeKnown / total;
  }
  for (const k of [1, 2, 4]) {
    const key = "free_lag_" + k;
    values[key] = lags[key] !== null ? lags[key] : stats.lag_fill;
  }
  if (freeKnown !== null && lags.free_lag_1 !== null) {
    values.drain_15 = (lags.free_lag_1 - freeKnown) / MINUTES_PER_SLOT;
  } else {
    values.drain_15 = stats.lag_fill;
  }
  if (freeKnown !== null && lags.free_lag_4 !== null) {
    values.drain_60 = (lags.free_lag_4 - freeKnown) / (MINUTES_PER_SLOT * 4);
  } else {
    values.drain_60 = stats.lag_fill;
  }
  values.lag_missing = lagMissing ? 1 : 0;
  meta.free_known = freeKnown;
  meta.free_known_ts = known ? known.ts : null;
  meta.age_seconds = knownEpoch !== null ? Math.round(issuedAt - knownEpoch) : null;
}

function periodicFeatures(index, lotId, issuedAt, effective, issuedParts, issuedDate, stats, values, meta) {
  const obs = index.obsByLot[lotId];
  const issuedSlot = slotOfParts(issuedParts);
  const issuedDow = weekdayOfParts(issuedParts);
  const windowStart = issuedAt - SAME_SLOT_WINDOW_DAYS * 86400;

  const slotVals = [];
  const weekdayVals = [];
  const todayVals = [];

  for (const o of obs) {
    if (o.epoch > effective) break;
    if (o.epoch < windowStart) continue;
    if (o.quality !== "ok" && o.quality !== "stale") continue;
    if (o.free === null) continue;
    if (o.date === issuedDate) {
      if (o.epoch < issuedAt) todayVals.push(o.free);
      continue;
    }
    if (o.weekday !== issuedDow) continue;
    if (Math.abs(o.slot - issuedSlot) <= SAME_SLOT_HALF_SLOTS) slotVals.push(o.free);
    if (Math.abs(o.slot - issuedSlot) <= SAME_WEEKDAY_HALF_SLOTS) weekdayVals.push(o.free);
  }

  let periodicMissing = false;
  const slotOk = slotVals.length >= SAME_SLOT_MIN_SAMPLES;
  if (slotOk) {
    values.same_slot_mean = slotVals.reduce((a, b) => a + b, 0) / slotVals.length;
    values.same_slot_median = median(slotVals);
  } else {
    values.same_slot_mean = stats.periodic_fill;
    values.same_slot_median = stats.periodic_fill;
    periodicMissing = true;
  }
  const weekdayOk = weekdayVals.length >= SAME_WEEKDAY_MIN_SAMPLES;
  if (weekdayOk) {
    values.same_weekday_mean = weekdayVals.reduce((a, b) => a + b, 0) / weekdayVals.length;
  } else {
    values.same_weekday_mean = stats.periodic_fill;
    periodicMissing = true;
  }
  if (todayVals.length) {
    values.same_day_hist = median(todayVals);
  } else {
    values.same_day_hist = stats.periodic_fill;
    periodicMissing = true;
  }
  values.periodic_missing = periodicMissing ? 1 : 0;
  meta.same_slot_median = slotOk ? median(slotVals) : null;
  meta.same_weekday_mean = weekdayOk ? (weekdayVals.reduce((a, b) => a + b, 0) / weekdayVals.length) : null;
}

function calendarFeatures(index, issuedParts, issuedDate, effective, model, values, meta) {
  const sig = latestAtOrBefore(index.calendar, effective);
  const issuedDow = weekdayOfParts(issuedParts);
  const slot = slotOfParts(issuedParts);
  const cal = model.payload.calendar;

  let isWorkday, isHoliday, isWeekend, peak, calendarMissing, daysSince, daysTo;
  if (sig === null) {
    isWeekend = issuedDow >= 5;
    isWorkday = !isWeekend;
    isHoliday = false;
    peak = "none";
    calendarMissing = true;
    daysSince = -7;
    daysTo = 7;
  } else {
    isWorkday = !!sig.is_workday;
    isHoliday = !!sig.is_holiday;
    isWeekend = issuedDow >= 5;
    peak = sig.peak || "none";
    calendarMissing = false;
    const todayNum = dayNum(issuedDate);
    daysSince = null;
    daysTo = null;
    for (const h of index.holidays) {
      const hn = dayNum(h);
      if (hn <= todayNum) daysSince = todayNum - hn;
      if (hn >= todayNum && daysTo === null) daysTo = hn - todayNum;
    }
    daysSince = daysSince === null ? -7 : Math.max(-7, Math.min(7, daysSince));
    daysTo = daysTo === null ? 7 : Math.max(-7, Math.min(7, daysTo));
  }

  const isPeak = peak === "am_peak" || peak === "pm_peak";
  values.is_workday = isWorkday ? 1 : 0;
  values.is_holiday = isHoliday ? 1 : 0;
  values.is_weekend = isWeekend ? 1 : 0;
  values.is_peak = isPeak ? 1 : 0;
  values.peak_type = PEAK_CODES[peak] ?? 0;
  values.days_since_holiday = daysSince;
  values.days_to_holiday = daysTo;
  values.time_of_day_sin = cal.time_sin[slot];
  values.time_of_day_cos = cal.time_cos[slot];
  values.dow_sin = cal.dow_sin[issuedDow];
  values.dow_cos = cal.dow_cos[issuedDow];
  values.calendar_missing = calendarMissing ? 1 : 0;
  meta.calendar_missing = calendarMissing;
  meta.is_workday = isWorkday;
  meta.is_weekend = isWeekend;
  meta.peak = peak;
}

function weatherFeatures(index, effective, stats, values, meta) {
  const sig = latestAtOrBefore(index.weather, effective);
  if (sig === null) {
    values.weather_code = stats.weather_code_mode;
    values.is_rain = 0;
    values.temperature_c = stats.temperature_median;
    values.weather_missing = 1;
    meta.weather = null;
  } else {
    const wname = sig.weather;
    const code = WEATHER_CODES[wname] ?? 0;
    values.weather_code = code;
    values.is_rain = RAIN_WEATHER.has(wname) ? 1 : 0;
    values.temperature_c = sig.temperature_c != null ? sig.temperature_c : stats.temperature_median;
    values.weather_missing = 0;
    meta.weather = wname;
  }
}

function eventFeatures(index, issuedAt, effective, stats, values, meta) {
  if (!index.hasEventData) {
    values.event_strength = stats.event_strength_median;
    values.event_in_2h = 0;
    values.event_size = 0;
    values.event_missing = 1;
    meta.has_event = false;
    return;
  }
  const lo = issuedAt - EVENT_LOOKBACK_MINUTES * 60;
  const in2hLo = issuedAt - EVENT_HORIZON_MINUTES * 60;
  const strengths = [];
  const ids = new Set();
  let in2h = false;
  for (const s of index.events) {
    if (s.epoch > effective) break;
    if (s.epoch < lo) continue;
    strengths.push(s.event_strength ?? 0);
    if (s.epoch >= in2hLo) in2h = true;
    if (s.event_id) ids.add(s.event_id);
  }
  values.event_strength = strengths.length ? Math.max(...strengths) : 0;
  values.event_in_2h = in2h ? 1 : 0;
  values.event_size = ids.size;
  values.event_missing = 0;
  meta.has_event = strengths.length > 0;
}

function lotFeatures(index, lotId, effective, stats, values) {
  const total = index.lots[lotId].total_spaces;
  values.total_spaces = total;
  values.base_rate = stats.base_rate[lotId] ?? 0;
  const days = new Set();
  for (const o of index.obsByLot[lotId]) {
    if (o.epoch > effective) break;
    if ((o.quality === "ok" || o.quality === "stale") && o.free !== null) days.add(o.date);
  }
  values.day_of_history = days.size;
}

export function buildLotFeatures(dataset, model, lotId, issuedAtStr, cutoffStr) {
  const index = prepare(dataset);
  const stats = model.payload.feature_fills;
  const issuedAt = epochSec(issuedAtStr);
  const cutoff = epochSec(cutoffStr);
  const effective = Math.min(cutoff, issuedAt);
  const issuedParts = parseParts(issuedAtStr);
  const issuedDate = dateKey(issuedAtStr);

  const values = {};
  const meta = { lot_id: lotId };

  lagFeatures(index, lotId, issuedAt, effective, stats, values, meta);
  periodicFeatures(index, lotId, issuedAt, effective, issuedParts, issuedDate, stats, values, meta);
  calendarFeatures(index, issuedParts, issuedDate, effective, model, values, meta);
  weatherFeatures(index, effective, stats, values, meta);
  eventFeatures(index, issuedAt, effective, stats, values, meta);
  lotFeatures(index, lotId, effective, stats, values);

  values.peak_x_workday = values.is_peak * values.is_workday;
  values.rain_x_weekend = values.is_rain * values.is_weekend;

  for (const name of FEATURE_NAMES) {
    if (values[name] === undefined) values[name] = 0;
  }
  return { values, meta };
}

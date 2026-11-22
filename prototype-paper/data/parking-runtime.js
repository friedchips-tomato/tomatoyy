// 停车运行时（浏览器经典脚本，自动打包生成，勿手改）。
// 复用 parking-forecast/runtime/{format,features,forecast,reasons,recommend}.mjs（阶段 2 产物，算法逐字不变），
// 仅去除 ES 模块 import/export 并包成 IIFE，另加浏览器安全适配层（对应 runtime/index.mjs 的校验与降级包装）。
// 原因：演示用 python3 -m http.server 把 .mjs 当 text/plain 提供，浏览器拒绝模块脚本，故打包为经典脚本。
// 重新生成：对 runtime/*.mjs 去 import/export 后按依赖序拼接。
(function (global) {
"use strict";

// ===== format.mjs (parking-forecast/runtime) =====
// 共享工具（与 Python 侧 src/pf/features.py 逐位一致）。
// 约定：合成数据时间戳均为零填充 ISO 8601 + "+08:00"；内部以「墙钟 epoch 秒」表示时间，
// 与 Python 的 naive datetime + total_seconds() 完全一致。

const HORIZONS = [15, 30, 45, 60];
const MINUTES_PER_SLOT = 15;
const SLOTS_PER_DAY = 96;
const WEEK_DAYS = 7;

const WEATHER_CODES = { sunny: 0, cloudy: 1, rain: 2, heavy_rain: 3, storm: 4 };
const RAIN_WEATHER = new Set(["rain", "heavy_rain", "storm"]);
const PEAK_CODES = { none: 0, am_peak: 1, pm_peak: 2, evening: 3 };

function parseParts(s) {
  return {
    y: Number(s.slice(0, 4)),
    mo: Number(s.slice(5, 7)),
    d: Number(s.slice(8, 10)),
    h: Number(s.slice(11, 13)),
    mi: Number(s.slice(14, 16)),
    s: Number(s.slice(17, 19)),
  };
}

function epochSec(s) {
  const p = parseParts(s);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
}

function dateKey(s) {
  return s.slice(0, 10);
}

function dayNumOfParts(p) {
  return Date.UTC(p.y, p.mo - 1, p.d) / 86400000;
}

function dayNum(s) {
  return dayNumOfParts(parseParts(s));
}

function weekdayOfParts(p) {
  // 周一=0（与 Python datetime.weekday() 一致；1970-01-01 周四 => (0+3)%7=3）
  return (dayNumOfParts(p) + 3) % 7;
}

function slotOfParts(p) {
  return p.h * 4 + Math.floor(p.mi / MINUTES_PER_SLOT);
}

function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2.0;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

// 从「墙钟 epoch 秒」反推日历字段（Date.UTC 与 Python naive datetime 同用公历，逐位一致）。
function partsFromEpoch(sec) {
  const d = new Date(sec * 1000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

function dateKeyFromParts(p) {
  return `${pad(p.y, 4)}-${pad(p.mo, 2)}-${pad(p.d, 2)}`;
}

function fmtEpoch(sec) {
  const p = partsFromEpoch(sec);
  return `${pad(p.y, 4)}-${pad(p.mo, 2)}-${pad(p.d, 2)}T${pad(p.h, 2)}:${pad(p.mi, 2)}:${pad(p.s, 2)}+08:00`;
}

function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

function clamp01(x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

// 时间戳字典序比较（零填充 ISO 8601 下与按时间排序等价）
function lteTs(a, b) {
  return a.slice(0, 19) <= b.slice(0, 19);
}


// ===== features.mjs (parking-forecast/runtime) =====
// 特征构造（与 Python src/pf/features.py 逐位一致）。防泄漏：只用 ts <= min(cutoff, issued_at)。

const SAME_SLOT_WINDOW_DAYS = 28;
const SAME_SLOT_HALF_SLOTS = 1;
const SAME_WEEKDAY_HALF_SLOTS = 2;
const SAME_SLOT_MIN_SAMPLES = 3;
const SAME_WEEKDAY_MIN_SAMPLES = 2;
const EVENT_LOOKBACK_MINUTES = 6 * 60;
const EVENT_HORIZON_MINUTES = 2 * 60;

const FEATURE_NAMES = [
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

function prepare(dataset) {
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

function buildLotFeatures(dataset, model, lotId, issuedAtStr, cutoffStr) {
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


// ===== forecast.mjs (parking-forecast/runtime) =====
// 预测（线性模型点积 + 降级链 D0–D4），与 Python src/pf/train.py 逐位一致。
// 累加顺序与 Python predict_point 完全一致，保证点预测逐位相等。

function predictPoint(model, h, values) {
  const hz = model.payload.horizons[String(h)];
  const mean = model.payload.scaler.mean;
  const std = model.payload.scaler.std;
  let acc = values["free_known"] + hz.intercept;
  for (const name of model.features) {
    acc = acc + hz.coef[name] * (values[name] - mean[name]) / std[name];
  }
  return acc;
}

function roundClamp(x, total) {
  return Math.max(0, Math.min(total, roundHalfUp(x)));
}

function periodicStat(index, lotId, targetEpoch, cutoffEpoch, halfSlots, minSamples, stat) {
  const obs = index.obsByLot[lotId];
  const tp = partsFromEpoch(targetEpoch);
  const targetSlot = slotOfParts(tp);
  const targetDow = weekdayOfParts(tp);
  const cutoffDate = dateKeyFromParts(partsFromEpoch(cutoffEpoch));
  const windowStart = targetEpoch - SAME_SLOT_WINDOW_DAYS * 86400;

  const vals = [];
  for (const o of obs) {
    if (o.epoch > cutoffEpoch) break;
    if (o.epoch < windowStart) continue;
    if (o.quality !== "ok" && o.quality !== "stale") continue;
    if (o.free === null) continue;
    if (o.date >= cutoffDate) continue;
    if (o.weekday !== targetDow) continue;
    if (Math.abs(o.slot - targetSlot) <= halfSlots) vals.push(o.free);
  }
  if (vals.length < minSamples) return null;
  if (stat === "median") return median(vals);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sameSlotMedianAt(index, lotId, targetEpoch, cutoffEpoch) {
  return periodicStat(index, lotId, targetEpoch, cutoffEpoch,
    SAME_SLOT_HALF_SLOTS, SAME_SLOT_MIN_SAMPLES, "median");
}

function sameWeekdayMeanAt(index, lotId, targetEpoch, cutoffEpoch) {
  return periodicStat(index, lotId, targetEpoch, cutoffEpoch,
    SAME_WEEKDAY_HALF_SLOTS, SAME_WEEKDAY_MIN_SAMPLES, "mean");
}

const METHOD_BY_LEVEL = {
  D0: "model",
  D1: "same_slot_baseline",
  D2: "same_weekday_baseline",
  D3: "last_known",
  D4: "unavailable",
};

function degradeLevel(f) {
  const m = f.meta;
  if (m.free_known === null) return "D4";
  const hasSlot = m.same_slot_median !== null;
  const hasWeekday = m.same_weekday_mean !== null;
  if (!hasSlot && !hasWeekday) return "D3";
  if (hasSlot) {
    const complete = !["lag_missing", "calendar_missing", "weather_missing",
      "event_missing", "periodic_missing"].some((n) => f.values[n]);
    return complete ? "D0" : "D1";
  }
  return "D2";
}

function degradeReason(level, f) {
  if (level === "D0") return null;
  if (level === "D1") {
    if (f.values.lag_missing) return "missing_observation";
    if (f.values.calendar_missing) return "missing_calendar";
    if (f.values.weather_missing) return "missing_weather";
    if (f.values.event_missing) return "missing_event";
    return "missing_periodic";
  }
  if (level === "D2") return "insufficient_same_slot";
  if (level === "D3") return "no_history";
  return "missing_observation";
}

function forecastLot(dataset, model, lotId, issuedAtStr, cutoffStr, horizons) {
  const hs = horizons || HORIZONS;
  const cut = cutoffStr || issuedAtStr;
  const index = prepare(dataset);
  const stats = model.payload.feature_fills;
  const total = index.lots[lotId].total_spaces;
  const issuedAt = epochSec(issuedAtStr);
  const cutoff = epochSec(cut);
  const f = buildLotFeatures(dataset, model, lotId, issuedAtStr, cut);

  const level = degradeLevel(f);
  const method = METHOD_BY_LEVEL[level];
  const reason = degradeReason(level, f);
  const freeKnown = f.meta.free_known;
  const freeKnownTs = f.meta.free_known_ts;

  const forecasts = [];
  for (const h of hs) {
    const targetEpoch = issuedAt + h * 60;
    let point = null;
    let p10 = null;
    let p90 = null;

    if (level === "D0") {
      const z = predictPoint(model, h, f.values);
      point = roundClamp(z, total);
      p10 = roundClamp(z + model.payload.residual_quantiles[String(h)].q10, total);
      p90 = roundClamp(z + model.payload.residual_quantiles[String(h)].q90, total);
    } else if (level === "D1") {
      let v = sameSlotMedianAt(index, lotId, targetEpoch, cutoff);
      if (v === null) v = sameWeekdayMeanAt(index, lotId, targetEpoch, cutoff);
      if (v === null) v = freeKnown;
      point = v !== null ? roundClamp(v, total) : null;
    } else if (level === "D2") {
      let v = sameWeekdayMeanAt(index, lotId, targetEpoch, cutoff);
      if (v === null) v = freeKnown;
      point = v !== null ? roundClamp(v, total) : null;
    } else if (level === "D3") {
      point = freeKnown !== null ? Math.trunc(freeKnown) : null;
    } else {
      point = null;
    }

    const freeRate = point !== null ? point / total : null;
    forecasts.push({
      lot_id: lotId,
      issued_at: fmtEpoch(issuedAt),
      target_ts: fmtEpoch(targetEpoch),
      horizon_minutes: h,
      point_free: point,
      p10,
      p90,
      free_rate: freeRate,
      method,
      degraded: level !== "D0",
      degrade_reason: reason,
      model_version: method === "model" ? model.version : null,
      data_asof: freeKnownTs,
      source: "synthetic",
    });
  }

  return { forecasts, features: f };
}


// ===== reasons.mjs (parking-forecast/runtime) =====
// 人话理由（确定性字符串模板），与 Python src/pf/recommend.py 的 make_reasons 逐字一致。
// 每个数字来自 score_breakdown 的 raw（2.22）。

function ageSeconds(forecast) {
  if (!forecast.data_asof) return null;
  return epochSec(forecast.issued_at) - epochSec(forecast.data_asof);
}

function fmtNum(x) {
  if (x === null || x === undefined) return "未知";
  const r = roundHalfUp(x);
  if (Math.abs(x - r) < 1e-9) return String(r);
  return x.toFixed(1);
}

function bdict(breakdown) {
  const d = {};
  for (const b of breakdown) d[b.factor] = b;
  return d;
}

function makeReasons(lot, forecast, breakdown, caps) {
  const b = bdict(breakdown);
  const reasons = [];

  const af = b.arrive_free.raw;
  const fr = b.arrive_free_rate.raw;
  if (af !== null && af !== undefined) {
    const pct = roundHalfUp((fr !== null && fr !== undefined ? fr : 0.0) * 100.0);
    reasons.push(`到达时预计余位 ${Math.trunc(af)} 个（约 ${pct}% 空置率），有位可停。`);
  } else {
    reasons.push("该车场暂无可用余位预测，仅按步行距离与费用排序。");
  }

  const walkMin = Math.trunc(b.walk_cost.raw);
  const walkMeters = Math.trunc(lot.walk_to_street.meters);
  reasons.push(`停车后步行约 ${walkMin} 分钟（${walkMeters} 米）到街区入口。`);

  const totalTime = b.total_time.raw;
  const drive = Math.trunc(caps.drive_minutes_estimate);
  const park = Math.trunc(caps.park_minutes);
  reasons.push(`预计总时间约 ${Math.trunc(totalTime)} 分钟（驾车估算 ${drive} 分钟 + 步行 ${walkMin} 分钟 + 停车 ${park} 分钟）。`);

  const feeAmount = b.fee_cost.raw;
  if (feeAmount !== null && feeAmount !== undefined) {
    const feeMode = lot.fee.mode;
    if (feeMode === "hourly") {
      reasons.push(`费用 ${fmtNum(lot.fee.amount)} 元/小时，按 ${Math.trunc(caps.stay_hours)} 小时停留估算 ${roundHalfUp(feeAmount)} 元。`);
    } else {
      reasons.push(`停车费约 ${roundHalfUp(feeAmount)} 元。`);
    }
  } else {
    reasons.push("费用未知，建议以现场公示为准。");
  }

  const age = ageSeconds(forecast);
  const conf = b.confidence.raw;
  const level = conf >= 0.8 ? "较高" : (conf >= 0.5 ? "中等" : "较低");
  if (age !== null && age > 900) {
    reasons.push(`余位数据已过期（${Math.floor(age / 60)} 分钟前），以现场为准。`);
  } else if (age !== null) {
    reasons.push(`余位数据更新于 ${Math.floor(age / 60)} 分钟前，预测可信度${level}。`);
  } else {
    reasons.push(`余位数据更新时间未知，预测可信度${level}。`);
  }

  if (lot.notes) reasons.push(`注意：${lot.notes}`);
  const access = lot.access || {};
  if (access.one_way) {
    if (access.note) reasons.push(`注意：${access.note}`);
  }

  return reasons;
}


// ===== recommend.mjs (parking-forecast/runtime) =====
// 停车推荐、排序与打分（04 §3），与 Python src/pf/recommend.py 逐位一致。
// 打分方向分高靠前；硬过滤在打分前；错峰 +30/+60；transfer 一律 feasible=false。

const FACTOR_ORDER = ["arrive_free", "arrive_free_rate", "walk_cost", "total_time",
  "fee_cost", "confidence", "restriction_penalty"];

function computeFee(fee, stayHours) {
  const mode = fee.mode;
  const amount = fee.amount;
  if (mode === "unknown" || amount === null || amount === undefined) return null;
  if (mode === "flat") return amount;
  return amount * stayHours;
}

function confidenceFromForecast(forecast) {
  const method = forecast.method;
  if (method === "unavailable") return 0.0;
  const base = {
    model: 0.9,
    same_slot_baseline: 0.6,
    same_weekday_baseline: 0.5,
    last_known: 0.3,
  }[method] ?? 0.5;
  const age = ageSeconds(forecast);
  let mult;
  if (age === null) mult = 0.5;
  else if (age <= 180) mult = 1.0;
  else if (age <= 900) mult = 0.8;
  else mult = 0.5;
  return base * mult;
}

function inHours(cur, frm, to) {
  const lo = hhmm(frm);
  const hi = hhmm(to);
  if (lo <= hi) return lo <= cur && cur < hi;
  return cur >= lo || cur < hi;
}

function hhmm(s) {
  const [h, m] = s.trim().split(":");
  return Number(h) * 60 + Number(m);
}

function accessCheck(lot, arriveParts) {
  const reasons = [];
  const access = lot.access || {};
  const oh = access.open_hours;
  if (oh) {
    const [lo, hi] = oh.split("-");
    if (!inHours(arriveParts.h * 60 + arriveParts.mi, lo, hi)) {
      reasons.push(`不在开放时间（${oh}）`);
    }
  }
  for (const r of (access.restricted_hours || [])) {
    if (inHours(arriveParts.h * 60 + arriveParts.mi, r.from, r.to)) {
      reasons.push(`限行时段：${r.note || `${r.from}-${r.to}`}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function heightCheck(lot, vehicle) {
  const limit = (lot.access || {}).height_limit_m;
  if (limit === null || limit === undefined || !vehicle) return { ok: true, reason: null };
  const vh = vehicle.height_m;
  if (vh === null || vh === undefined) return { ok: true, reason: null };
  if (vh > limit) {
    return { ok: false, reason: `车辆高度 ${vh.toFixed(1)} 米超过限高 ${limit.toFixed(1)} 米` };
  }
  return { ok: true, reason: null };
}

function scoreLot(lot, forecast, preference, caps, weights) {
  const w = weights[preference] || weights.default;
  const total = Math.trunc(lot.total_spaces);

  const arriveFree = forecast.point_free;
  let freeRate = forecast.free_rate;
  if (freeRate === null && arriveFree !== null) freeRate = arriveFree / total;
  const walkMin = Math.trunc(lot.walk_to_street.minutes);
  const feeAmount = computeFee(lot.fee, caps.stay_hours);
  const drive = caps.drive_minutes_estimate;
  const park = caps.park_minutes;
  const totalTime = drive + park + walkMin;
  const confidence = confidenceFromForecast(forecast);
  const restrictionPenalty = (lot.access || {}).one_way ? caps.restriction_one_way_penalty : 0.0;

  const raws = {
    arrive_free: arriveFree !== null ? arriveFree : null,
    arrive_free_rate: freeRate,
    walk_cost: walkMin,
    total_time: totalTime,
    fee_cost: feeAmount,
    confidence,
    restriction_penalty: restrictionPenalty,
  };
  const norms = {
    arrive_free: clamp01((arriveFree !== null ? arriveFree : 0.0) / caps.need),
    arrive_free_rate: clamp01(freeRate !== null ? freeRate : 0.0),
    walk_cost: 1.0 - clamp01(walkMin / caps.walk_cap_min),
    total_time: 1.0 - clamp01(totalTime / caps.total_cap_min),
    fee_cost: feeAmount !== null ? (1.0 - clamp01(feeAmount / caps.fee_cap_cny)) : 0.5,
    confidence: clamp01(confidence),
    restriction_penalty: restrictionPenalty,
  };

  const breakdown = [];
  let score = 0.0;
  for (const k of FACTOR_ORDER) {
    const wgt = w[k];
    const norm = norms[k];
    const contribution = wgt * norm * 100.0;
    score += contribution;
    breakdown.push({ factor: k, weight: wgt, raw: raws[k], normalized: norm, contribution });
  }
  return { score, breakdown };
}

function clampHorizon(minutes) {
  const horizon = Math.round(minutes / 15.0) * 15;
  return Math.max(15, Math.min(60, horizon));
}

function restrictionNotes(lot) {
  const access = lot.access || {};
  const notes = [];
  if (access.one_way) notes.push("单行");
  if (access.note) notes.push(access.note);
  return notes;
}

function buildItem(lot, forecast, breakdown, reasons, score, caps) {
  const feeAmount = computeFee(lot.fee, caps.stay_hours);
  const age = ageSeconds(forecast);
  return {
    lot_id: lot.lot_id,
    name: lot.name,
    arrive_free: forecast.point_free,
    arrive_free_rate: forecast.free_rate,
    arrive_free_p10: forecast.p10,
    arrive_free_p90: forecast.p90,
    walk_meters: lot.walk_to_street.meters,
    walk_minutes: lot.walk_to_street.minutes,
    fee_amount: feeAmount,
    fee_unit: feeAmount !== null ? lot.fee.unit : null,
    updated_at: forecast.data_asof,
    stale: age !== null && age > 900,
    score,
    score_breakdown: breakdown,
    reasons,
    total_time_minutes: caps.drive_minutes_estimate + caps.park_minutes + lot.walk_to_street.minutes,
    transfer: { mode: null, feasible: false, minutes: null, note: "暂无可用接驳点数据" },
    restrictions: restrictionNotes(lot),
    forecast_method: forecast.method,
    degraded: forecast.degraded,
  };
}

function buildOffsets(dataset, model, lotId, lot, arriveAtEpoch, issuedAtEpoch, issuedAtStr, offsets) {
  let ok = false;
  for (const extra of [30, 60]) {
    const targetEpoch = arriveAtEpoch + extra * 60;
    const h = clampHorizon(Math.floor((targetEpoch - issuedAtEpoch) / 60));
    const fcs = forecastLot(dataset, model, lotId, issuedAtStr, issuedAtStr, [h]).forecasts;
    const f = fcs[0];
    if (f.point_free !== null && f.point_free > 0) {
      offsets.push({
        lot_id: lotId,
        name: lot.name,
        arrive_at: `+${extra}min`,
        arrive_free: f.point_free,
        extra_minutes: extra,
        note: `建议错峰 ${extra} 分钟后到达，预计有余位`,
      });
      ok = true;
    }
  }
  return ok;
}

function recommend(dataset, model, destinationId, arriveAtStr, opts = {}) {
  const preference = opts.preference || "save_time";
  const vehicle = opts.vehicle || null;
  const travelMode = opts.travelMode || "drive";
  const generatedAt = opts.generatedAt || null;

  const arriveAtEpoch = epochSec(arriveAtStr);

  if (travelMode !== "drive") {
    return {
      destination_id: destinationId,
      arrive_at: fmtEpoch(arriveAtEpoch),
      preference,
      generated_at: fmtEpoch(generatedAt ? epochSec(generatedAt) : arriveAtEpoch),
      items: [], alternates: [], excluded: [], offsets: [],
      source: "synthetic", note: "步行抵达，无需停车",
    };
  }

  const caps = model.ranking_caps;
  const weights = model.ranking_weights;
  const issuedAtEpoch = generatedAt ? epochSec(generatedAt) : arriveAtEpoch - 30 * 60;
  const issuedAtStr = fmtEpoch(issuedAtEpoch);
  const horizon = clampHorizon(Math.floor((arriveAtEpoch - issuedAtEpoch) / 60));

  const lots = {};
  for (const l of dataset.lots) lots[l.lot_id] = l;

  const items = [];
  const excluded = [];
  const offsets = [];

  for (const lotId of Object.keys(lots)) {
    const lot = lots[lotId];
    const forecast = forecastLot(dataset, model, lotId, issuedAtStr, issuedAtStr, [horizon]).forecasts[0];

    const acc = accessCheck(lot, parseParts(arriveAtStr));
    if (!acc.ok) {
      excluded.push({ lot_id: lotId, name: lot.name, reason: acc.reasons.join("；") });
      continue;
    }
    const hgt = heightCheck(lot, vehicle);
    if (!hgt.ok) {
      excluded.push({ lot_id: lotId, name: lot.name, reason: hgt.reason });
      continue;
    }
    if (forecast.point_free === 0) {
      const offsetOk = buildOffsets(dataset, model, lotId, lot, arriveAtEpoch, issuedAtEpoch, issuedAtStr, offsets);
      if (!offsetOk) {
        excluded.push({ lot_id: lotId, name: lot.name, reason: "到达时刻预计无余位，且无可行错峰方案" });
      }
      continue;
    }

    const { score, breakdown } = scoreLot(lot, forecast, preference, caps, weights);
    const reasons = makeReasons(lot, forecast, breakdown, caps);
    items.push(buildItem(lot, forecast, breakdown, reasons, score, caps));
  }

  items.sort((a, b) => b.score - a.score);
  const alternates = items.slice(1);
  const top = items.slice(0, 1);
  return {
    destination_id: destinationId,
    arrive_at: fmtEpoch(arriveAtEpoch),
    preference,
    generated_at: fmtEpoch(issuedAtEpoch),
    items: top,
    alternates,
    excluded,
    offsets,
    source: "synthetic",
  };
}



// ===== 浏览器安全适配层（对应 runtime/index.mjs 的 validateArtifact + 降级包装，去 node:fs/node:path）=====
const SCHEMA_VERSION = "2.0.0";

function validateArtifact(a) {
  if (!a || typeof a !== "object") return { ok: false, error: "missing artifact" };
  if (a.schema_version !== SCHEMA_VERSION) return { ok: false, error: "unsupported schema_version: " + a.schema_version };
  if (a.kind !== "linear") return { ok: false, error: "unsupported kind: " + a.kind };
  const p = a.payload;
  if (!Array.isArray(a.features) || a.features.length === 0) return { ok: false, error: "missing features" };
  if (!p || !p.horizons || !p.scaler || !p.scaler.mean || !p.scaler.std || !p.feature_fills) return { ok: false, error: "missing model payload" };
  for (const h of HORIZONS) { if (!p.horizons[String(h)]) return { ok: false, error: "missing horizon " + h }; }
  if (!a.ranking_caps || !a.ranking_weights) return { ok: false, error: "missing ranking config" };
  if (!Array.isArray(a.lots) || a.lots.length === 0) return { ok: false, error: "missing lots" };
  return { ok: true };
}

function unavailableForecasts(lotId, issuedAtStr, horizons, reason) {
  const hs = horizons || HORIZONS;
  const issuedAt = epochSec(issuedAtStr);
  return hs.map(function (h) {
    return {
      lot_id: lotId, issued_at: fmtEpoch(issuedAt), target_ts: fmtEpoch(issuedAt + h * 60),
      horizon_minutes: h, point_free: null, p10: null, p90: null, free_rate: null,
      method: "unavailable", degraded: true, degrade_reason: reason, model_version: null,
      data_asof: null, source: "synthetic"
    };
  });
}

function forecastLotChecked(dataset, model, lotId, issuedAtStr, cutoffStr, horizons) {
  const v = validateArtifact(model);
  if (!v.ok) return { forecasts: unavailableForecasts(lotId, issuedAtStr, horizons, v.error), features: null };
  return forecastLot(dataset, model, lotId, issuedAtStr, cutoffStr, horizons);
}

function recommendChecked(dataset, model, destinationId, arriveAtStr, opts) {
  opts = opts || {};
  const v = validateArtifact(model);
  if (!v.ok) {
    return {
      destination_id: destinationId, arrive_at: fmtEpoch(epochSec(arriveAtStr)),
      preference: opts.preference || "save_time", generated_at: fmtEpoch(epochSec(arriveAtStr)),
      items: [], alternates: [], excluded: [], offsets: [], source: "synthetic", note: v.error
    };
  }
  return recommend(dataset, model, destinationId, arriveAtStr, opts);
}

const DEMO_NOW = "2026-04-10T14:00:00+08:00";
function demoNow() {
  const override = global.CD_PARKING_DEMO_NOW;
  return (typeof override === "string" && /^d{4}-d{2}-d{2}Td{2}:d{2}:d{2}/.test(override)) ? override : DEMO_NOW;
}

function validDataset(dataset) {
  return Boolean(dataset && Array.isArray(dataset.lots) && dataset.lots.length && Array.isArray(dataset.observations) && Array.isArray(dataset.signals));
}

const artifact = global.CD_PARKING_ARTIFACT;
const model = (artifact && typeof artifact === "object") ? artifact.model : null;
const validated = validateArtifact(model);
const datasetOk = validDataset(artifact && artifact.dataset);
const ready = Boolean(artifact && artifact.injected) && validated.ok && datasetOk;

global.CD_PARKING = {
  artifactPresent: Boolean(artifact && artifact.injected),
  ready: ready,
  artifactOk: validated.ok,
  artifactError: validated.ok ? null : validated.error,
  source: (validated.ok && model) ? model.source : null,
  demoNow: demoNow(),
  model: validated.ok ? model : null,
  dataset: datasetOk ? artifact.dataset : null,
  forecastLot: forecastLotChecked,
  recommend: recommendChecked,
  makeReasons: makeReasons,
  ageSeconds: ageSeconds,
  fmtNum: fmtNum,
  computeFee: computeFee,
  confidenceFromForecast: confidenceFromForecast,
  FACTOR_ORDER: FACTOR_ORDER,
  validateArtifact: validateArtifact,
  unavailableForecasts: unavailableForecasts
};

})(typeof window !== "undefined" ? window : globalThis);

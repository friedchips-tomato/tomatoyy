// 预测（线性模型点积 + 降级链 D0–D4），与 Python src/pf/train.py 逐位一致。
// 累加顺序与 Python predict_point 完全一致，保证点预测逐位相等。

import {
  HORIZONS, MINUTES_PER_SLOT, roundHalfUp, median,
  partsFromEpoch, slotOfParts, weekdayOfParts, dateKeyFromParts, fmtEpoch, epochSec,
} from "./format.mjs";
import {
  prepare, buildLotFeatures,
  SAME_SLOT_HALF_SLOTS, SAME_WEEKDAY_HALF_SLOTS,
  SAME_SLOT_MIN_SAMPLES, SAME_WEEKDAY_MIN_SAMPLES, SAME_SLOT_WINDOW_DAYS,
} from "./features.mjs";

export function predictPoint(model, h, values) {
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

export function forecastLot(dataset, model, lotId, issuedAtStr, cutoffStr, horizons) {
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

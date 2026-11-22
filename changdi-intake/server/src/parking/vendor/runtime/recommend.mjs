// 停车推荐、排序与打分（04 §3），与 Python src/pf/recommend.py 逐位一致。
// 打分方向分高靠前；硬过滤在打分前；错峰 +30/+60；transfer 一律 feasible=false。

import { clamp01, epochSec, fmtEpoch, parseParts } from "./format.mjs";
import { forecastLot } from "./forecast.mjs";
import { makeReasons, ageSeconds } from "./reasons.mjs";

export const FACTOR_ORDER = ["arrive_free", "arrive_free_rate", "walk_cost", "total_time",
  "fee_cost", "confidence", "restriction_penalty"];

export function computeFee(fee, stayHours) {
  const mode = fee.mode;
  const amount = fee.amount;
  if (mode === "unknown" || amount === null || amount === undefined) return null;
  if (mode === "flat") return amount;
  return amount * stayHours;
}

export function confidenceFromForecast(forecast) {
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

export function accessCheck(lot, arriveParts) {
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

export function heightCheck(lot, vehicle) {
  const limit = (lot.access || {}).height_limit_m;
  if (limit === null || limit === undefined || !vehicle) return { ok: true, reason: null };
  const vh = vehicle.height_m;
  if (vh === null || vh === undefined) return { ok: true, reason: null };
  if (vh > limit) {
    return { ok: false, reason: `车辆高度 ${vh.toFixed(1)} 米超过限高 ${limit.toFixed(1)} 米` };
  }
  return { ok: true, reason: null };
}

export function scoreLot(lot, forecast, preference, caps, weights) {
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

export function recommend(dataset, model, destinationId, arriveAtStr, opts = {}) {
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

// 零依赖 Node ESM 运行时入口。加载 model.json 后即可本地解释执行：
// 特征 → 预测（降级链 D0–D4）→ 推荐/打分/理由。与 Python 侧逐位一致。
//
// 安全边界（2.18/2.19）：产物缺失 / schema 不合法 / 版本不兼容 → 返回 unavailable，
// 不抛异常。校验与降级在 index.mjs 这一层完成；features/forecast/recommend 假定拿到的是
// 已经通过 validateArtifact 的合法产物。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as format from "./format.mjs";
import { HORIZONS, epochSec, fmtEpoch } from "./format.mjs";
import { prepare, buildLotFeatures, FEATURE_NAMES } from "./features.mjs";
import { predictPoint, forecastLot as rawForecastLot } from "./forecast.mjs";
import {
  recommend as rawRecommend, scoreLot, computeFee, confidenceFromForecast,
  accessCheck, heightCheck, FACTOR_ORDER,
} from "./recommend.mjs";
import { makeReasons, ageSeconds, fmtNum } from "./reasons.mjs";

export const SCHEMA_VERSION = "2.0.0";

export {
  format, FEATURE_NAMES, prepare, buildLotFeatures, predictPoint,
  scoreLot, computeFee, confidenceFromForecast, accessCheck, heightCheck, FACTOR_ORDER,
  makeReasons, ageSeconds, fmtNum,
};

export function validateArtifact(a) {
  if (!a || typeof a !== "object") return { ok: false, error: "missing artifact" };
  if (a.schema_version !== SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schema_version: ${a.schema_version}` };
  }
  if (a.kind !== "linear") return { ok: false, error: `unsupported kind: ${a.kind}` };
  const p = a.payload;
  if (!Array.isArray(a.features) || a.features.length === 0) {
    return { ok: false, error: "missing features" };
  }
  if (!p || !p.horizons || !p.scaler || !p.scaler.mean || !p.scaler.std || !p.feature_fills) {
    return { ok: false, error: "missing model payload" };
  }
  for (const h of HORIZONS) {
    if (!p.horizons[String(h)]) return { ok: false, error: `missing horizon ${h}` };
  }
  if (!a.ranking_caps || !a.ranking_weights) return { ok: false, error: "missing ranking config" };
  if (!Array.isArray(a.lots) || a.lots.length === 0) return { ok: false, error: "missing lots" };
  return { ok: true };
}

export function loadModel(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function loadJsonl(path) {
  const text = readFileSync(path, "utf-8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function loadDataset(dataDir) {
  return {
    lots: loadJsonl(join(dataDir, "lots.jsonl")),
    observations: loadJsonl(join(dataDir, "observations.jsonl")),
    signals: loadJsonl(join(dataDir, "signals.jsonl")),
  };
}

export function unavailableForecasts(dataset, lotId, issuedAtStr, horizons, reason) {
  const hs = horizons || HORIZONS;
  const issuedAt = epochSec(issuedAtStr);
  return hs.map((h) => ({
    lot_id: lotId,
    issued_at: fmtEpoch(issuedAt),
    target_ts: fmtEpoch(issuedAt + h * 60),
    horizon_minutes: h,
    point_free: null,
    p10: null,
    p90: null,
    free_rate: null,
    method: "unavailable",
    degraded: true,
    degrade_reason: reason,
    model_version: null,
    data_asof: null,
    source: "synthetic",
  }));
}

export function forecastLot(dataset, model, lotId, issuedAtStr, cutoffStr, horizons) {
  const v = validateArtifact(model);
  if (!v.ok) {
    return { forecasts: unavailableForecasts(dataset, lotId, issuedAtStr, horizons, v.error), features: null };
  }
  return rawForecastLot(dataset, model, lotId, issuedAtStr, cutoffStr, horizons);
}

export function recommend(dataset, model, destinationId, arriveAtStr, opts = {}) {
  const v = validateArtifact(model);
  if (!v.ok) {
    return {
      destination_id: destinationId,
      arrive_at: fmtEpoch(epochSec(arriveAtStr)),
      preference: opts.preference || "save_time",
      generated_at: fmtEpoch(epochSec(arriveAtStr)),
      items: [], alternates: [], excluded: [], offsets: [],
      source: "synthetic",
      note: v.error,
    };
  }
  return rawRecommend(dataset, model, destinationId, arriveAtStr, opts);
}

// 一次给所有车场出预测（供 batch 场景与一致性测试）。产物非法时返回 unavailable。
export function forecastAll(dataset, model, issuedAtStr, cutoffStr, horizons) {
  const v = validateArtifact(model);
  const hs = horizons || HORIZONS;
  const out = {};
  for (const lot of dataset.lots) {
    out[lot.lot_id] = v.ok
      ? forecastLot(dataset, model, lot.lot_id, issuedAtStr, cutoffStr, horizons).forecasts
      : unavailableForecasts(dataset, lot.lot_id, issuedAtStr, hs, v.error);
  }
  return out;
}

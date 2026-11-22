// @template-header
// 浏览器安全适配层（打包模板）。本文件由 parking-forecast/scripts/export_browser.mjs
// 原样内联到 prototype-paper/data/parking-runtime.js 的 IIFE 末尾。
//
// 它是 parking-forecast/runtime/index.mjs 的浏览器等价物：index.mjs 是 ESM 且依赖
// node:fs/node:path 读盘；本文件是同语义的经典脚本版（无 import/export、无 fs），供
// prototype-paper/index.html 用 <script src="data/parking-runtime.js"> 直接引入。
//
// 逐条对应关系（改这里必须同步改 index.mjs，反之亦然）：
//   validateArtifact       <- index.mjs 的 validateArtifact（校验规则一致；错误串措辞由模板串改为字符串拼接）
//   unavailableForecasts   <- index.mjs 的 unavailableForecasts（去掉未使用的 dataset 形参）
//   forecastLotChecked     <- index.mjs 的 forecastLot（先校验；不合法返回 unavailable，不抛异常）
//   recommendChecked       <- index.mjs 的 recommend（同上）
//   demoNow / validDataset <- 浏览器侧新增（演示时间覆盖 + 数据集完整性）
//   global.CD_PARKING      <- 浏览器侧新增（导出给 prototype-paper/app.js 消费）
//
// @template-body
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
  return (typeof override === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(override)) ? override : DEMO_NOW;
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

// 2.19：产物缺失 / 版本不兼容时返回 unavailable，不抛异常。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadModel, loadDataset, forecastLot, forecastAll, recommend } from "../index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const dataset = loadDataset(join(ROOT, "data", "synthetic"));
const model = loadModel(join(ROOT, "artifacts", "model.json"));
const lotId = dataset.lots[0].lot_id;
const issued = "2026-04-10T08:00:00+08:00";

test("loadModel 读缺失文件返回 null，不抛异常", () => {
  const m = loadModel(join(__dirname, "no-such-model.json"));
  assert.equal(m, null);
});

test("forecastLot 产物缺失 → unavailable，不抛异常", () => {
  const { forecasts } = forecastLot(dataset, null, lotId, issued, issued);
  assert.ok(forecasts.length > 0);
  for (const f of forecasts) {
    assert.equal(f.method, "unavailable");
    assert.equal(f.point_free, null);
    assert.equal(f.degraded, true);
  }
});

test("forecastLot 版本不兼容 → unavailable，不抛异常", () => {
  const bad = JSON.parse(JSON.stringify(model));
  bad.schema_version = "9.9.9";
  const { forecasts } = forecastLot(dataset, bad, lotId, issued, issued);
  assert.equal(forecasts[0].method, "unavailable");
  assert.equal(forecasts[0].point_free, null);
});

test("forecastAll 坏产物 → 所有车场 unavailable", () => {
  const out = forecastAll(dataset, { bogus: true }, issued, issued);
  for (const lot of dataset.lots) {
    assert.equal(out[lot.lot_id][0].method, "unavailable");
  }
});

test("recommend 坏产物 → 空列表 + note，不抛异常", () => {
  const r = recommend(dataset, null, "DEST-DEMO-001", issued, {});
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.alternates, []);
  assert.equal(r.source, "synthetic");
  assert.ok(r.note);
});

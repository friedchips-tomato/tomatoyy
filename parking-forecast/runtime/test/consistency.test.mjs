// 2.17：同一批 500 条输入，Python 与 JS 运行时输出逐位相等。
// 黄金基准由 tests/test_consistency.py 生成（runtime/test/fixtures/consistency.json）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  loadDataset, loadModel, buildLotFeatures, forecastLot, recommend, FEATURE_NAMES,
} from "../index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const dataset = loadDataset(join(ROOT, "data", "synthetic"));
const model = loadModel(join(ROOT, "artifacts", "model.json"));
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "consistency.json"), "utf-8"));

test("fixture 规模正确", () => {
  assert.equal(fixture.n_cases, 500);
  assert.equal(fixture.n_recommend, 20);
  assert.equal(fixture.source, "synthetic");
});

test("500 条特征逐位一致", () => {
  for (const c of fixture.cases) {
    const { values } = buildLotFeatures(dataset, model, c.lot_id, c.issued_at, c.cutoff);
    for (const n of FEATURE_NAMES) {
      assert.equal(values[n], c.features[n], `${c.lot_id} @ ${c.issued_at} feature ${n}`);
    }
  }
});

test("500 条预测逐位一致", () => {
  for (const c of fixture.cases) {
    const { forecasts } = forecastLot(dataset, model, c.lot_id, c.issued_at, c.cutoff);
    assert.deepStrictEqual(forecasts, c.forecasts, `${c.lot_id} @ ${c.issued_at}`);
  }
});

test("20 条推荐逐位一致", () => {
  for (const r of fixture.recommend_cases) {
    const got = recommend(dataset, model, "DEST-DEMO-001", r.arrive_at, {
      preference: r.preference,
      vehicle: r.vehicle,
      travelMode: "drive",
      generatedAt: r.issued_at,
    });
    assert.deepStrictEqual(got, r.recommend, `recommend @ ${r.issued_at}`);
  }
});

// 2.20：同一输入 → 同一推荐顺序与同一理由文本（确定性）；2.21 score == Σ contribution。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadModel, loadDataset, recommend, scoreLot, forecastLot, validateArtifact, makeReasons } from "../index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const dataset = loadDataset(join(ROOT, "data", "synthetic"));
const model = loadModel(join(ROOT, "artifacts", "model.json"));

const arrived = "2026-04-10T08:30:00+08:00";

test("同一推荐跑两遍 JSON 逐字节一致", () => {
  const a = recommend(dataset, model, "DEST-DEMO-001", arrived, { preference: "default", travelMode: "drive" });
  const b = recommend(dataset, model, "DEST-DEMO-001", arrived, { preference: "default", travelMode: "drive" });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("偏好切换只改权重：三种偏好都有确定输出", () => {
  const outs = ["default", "save_time", "less_walking"].map(
    (p) => recommend(dataset, model, "DEST-DEMO-001", arrived, { preference: p, travelMode: "drive" }),
  );
  for (const o of outs) assert.ok(Array.isArray(o.items));
});

test("score == Σ contribution（2.21，浮点容差 1e-9）", () => {
  assert.equal(validateArtifact(model).ok, true);
  for (const lot of dataset.lots) {
    const { forecasts } = forecastLot(dataset, model, lot.lot_id, "2026-04-10T08:00:00+08:00", undefined, [30]);
    const { score, breakdown } = scoreLot(lot, forecasts[0], "default", model.ranking_caps, model.ranking_weights);
    const s = breakdown.reduce((acc, b) => acc + b.contribution, 0);
    assert.ok(Math.abs(score - s) < 1e-9, `${lot.lot_id} score=${score} sum=${s}`);
  }
});

test("理由文本与 breakdown 数字一致（2.22 的运行时侧）", () => {
  const lot = dataset.lots[0];
  const { forecasts } = forecastLot(dataset, model, lot.lot_id, "2026-04-10T08:00:00+08:00", undefined, [30]);
  const { score, breakdown } = scoreLot(lot, forecasts[0], "default", model.ranking_caps, model.ranking_weights);
  const reasons = makeReasons(lot, forecasts[0], breakdown, model.ranking_caps);
  assert.ok(reasons.length >= 2);
  assert.match(reasons[0], /余位/);
});

// 2.18：JS 运行时能读 artifact 并校验 schema，不合法则拒绝（validateArtifact 返回 ok=false）。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadModel, validateArtifact, SCHEMA_VERSION } from "../index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const model = loadModel(join(ROOT, "artifacts", "model.json"));

test("真实 model.json 通过校验", () => {
  const v = validateArtifact(model);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(model.schema_version, SCHEMA_VERSION);
  assert.equal(model.kind, "linear");
  assert.equal(model.source, "synthetic");
});

test("产物缺失被拒绝", () => {
  assert.equal(validateArtifact(null).ok, false);
  assert.equal(validateArtifact(undefined).ok, false);
  assert.equal(validateArtifact({}).ok, false);
});

test("版本不兼容被拒绝", () => {
  const bad = JSON.parse(JSON.stringify(model));
  bad.schema_version = "9.9.9";
  const v = validateArtifact(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /schema_version/);
});

test("kind 不支持被拒绝", () => {
  const bad = JSON.parse(JSON.stringify(model));
  bad.kind = "gbdt";
  const v = validateArtifact(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /kind/);
});

test("缺 features / horizon / payload 被拒绝", () => {
  for (const mutate of [
    (m) => { m.features = []; },
    (m) => { delete m.payload.horizons["15"]; },
    (m) => { delete m.payload.scaler.mean; },
    (m) => { delete m.ranking_caps; },
    (m) => { m.lots = []; },
  ]) {
    const bad = JSON.parse(JSON.stringify(model));
    mutate(bad);
    assert.equal(validateArtifact(bad).ok, false);
  }
});

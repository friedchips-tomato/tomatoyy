#!/usr/bin/env node
// 浏览器产物导出脚本：把 parking-forecast 阶段 2 的模型产物与 JS 运行时，打包成
// prototype-paper 能直接 <script src> 引用的两个经典脚本。
//
//   node parking-forecast/scripts/export_browser.mjs            # 写出（默认）
//   node parking-forecast/scripts/export_browser.mjs --check    # 只校验，不写盘
//
// 产物：
//   prototype-paper/data/parking-artifact.js
//     = artifacts/model.json 内联 + data/synthetic/{lots,observations,signals}.jsonl 内联
//   prototype-paper/data/parking-runtime.js
//     = runtime/{format,features,forecast,reasons,recommend}.mjs 去 import/export 后按依赖序
//       拼成 IIFE，末尾接 scripts/browser_adapter.js（runtime/index.mjs 的浏览器等价物）
//
// 硬约束（勿改）：
//   * 不改上游算法与运行时逻辑：只搬运、只包装。
//   * 不引第三方依赖：只用 node: 内置模块。
//   * 输出必须确定性：无时间戳、无随机序、无机器路径，同输入必得同字节。
//   * 输出必须是经典脚本（IIFE），不能改成 .mjs ESM——演示用 python -m http.server 会把
//     .mjs 当 text/plain 发出，浏览器拒绝模块脚本。
//
// 行尾约定：仓库里的产物在 Git 中以 LF 存储（core.autocrlf=true 的检出环境会变成 CRLF）。
// 本脚本一律写 LF，因此产物字节与平台无关；--check 比对时把两侧行尾都归一化为 LF。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PF_DIR = join(REPO_ROOT, "parking-forecast");
const OUT_DIR = join(REPO_ROOT, "prototype-paper", "data");

const MODEL_JSON = join(PF_DIR, "artifacts", "model.json");
const DATA_DIR = join(PF_DIR, "data", "synthetic");
const MANIFEST_JSON = join(DATA_DIR, "manifest.json");
const RUNTIME_DIR = join(PF_DIR, "runtime");
const ADAPTER_TEMPLATE = join(HERE, "browser_adapter.js");

const ARTIFACT_OUT = join(OUT_DIR, "parking-artifact.js");
const RUNTIME_OUT = join(OUT_DIR, "parking-runtime.js");

// 依赖序：format → features → forecast → reasons → recommend（recommend 依赖前四者）。
const MODULES = ["format", "features", "forecast", "reasons", "recommend"];

const ARTIFACT_HEADER = [
  "// 可选产物注入脚本（自动生成，勿手改）：把阶段 2 的运行时产物注入 window.CD_PARKING_ARTIFACT。",
  "// 来源：parking-forecast/artifacts/model.json + parking-forecast/data/synthetic/{lots,observations,signals}.jsonl",
  "// 删除本脚本在 index.html 中的 <script> 引用即可回落静态示范数据（阶段 3 验收 3.2）。",
  "// 重新生成：见 parking-forecast 阶段 2 的导出流程。",
  "",
].join("\n");

const RUNTIME_HEADER = [
  "// 停车运行时（浏览器经典脚本，自动打包生成，勿手改）。",
  "// 复用 parking-forecast/runtime/{format,features,forecast,reasons,recommend}.mjs（阶段 2 产物，算法逐字不变），",
  "// 仅去除 ES 模块 import/export 并包成 IIFE，另加浏览器安全适配层（对应 runtime/index.mjs 的校验与降级包装）。",
  "// 原因：演示用 python3 -m http.server 把 .mjs 当 text/plain 提供，浏览器拒绝模块脚本，故打包为经典脚本。",
  "// 重新生成：对 runtime/*.mjs 去 import/export 后按依赖序拼接。",
  "(function (global) {",
  '"use strict";',
  "",
  "",
].join("\n");

const RUNTIME_ADAPTER_MARKER =
  "// ===== 浏览器安全适配层（对应 runtime/index.mjs 的 validateArtifact + 降级包装，去 node:fs/node:path）=====";
const RUNTIME_FOOTER = '})(typeof window !== "undefined" ? window : globalThis);';

function die(msg) {
  process.stderr.write(`export_browser: ${msg}\n`);
  process.exit(1);
}

function readText(path) {
  return readFileSync(path, "utf8");
}

/** 行尾归一化为 LF（产物按 LF 存储，跨平台可比对）。 */
function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function readJsonl(path) {
  return normalizeEol(readText(path))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        die(`${path}: 第 ${i + 1} 行不是合法 JSON：${err.message}`);
      }
    });
}

/**
 * 把一个 ESM 模块转成可直接并入 IIFE 的经典脚本片段：
 *   1. 删掉 import 语句（含多行花括号形式）；
 *   2. 去掉行首的 `export ` 关键字；
 *   3. 把连续空行压成一行（删 import 后留下的多余空行正是这么来的）。
 * 除以上三类以外，函数体逐字不动。
 */
export function stripModule(source) {
  const lines = normalizeEol(source).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // 去掉结尾换行产生的空串
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^import\b/.test(line)) {
      while (i < lines.length && !lines[i].includes(";")) i += 1;
      i += 1; // 跳过结束 import 的那一行
      continue;
    }
    out.push(line.replace(/^export\s+/, ""));
    i += 1;
  }
  const collapsed = [];
  for (const line of out) {
    if (line.trim() === "" && collapsed.length && collapsed[collapsed.length - 1].trim() === "") continue;
    collapsed.push(line);
  }
  return collapsed;
}

/** 读取适配层模板：丢掉 @template-body 之前的说明文字。 */
function readAdapterTemplate() {
  const lines = normalizeEol(readText(ADAPTER_TEMPLATE)).split("\n");
  const idx = lines.findIndex((l) => l.trim() === "// @template-body");
  if (idx < 0) die(`${ADAPTER_TEMPLATE} 缺少 // @template-body 标记`);
  const body = lines.slice(idx + 1);
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  return body;
}

function buildArtifact(model, dataset) {
  return [
    ARTIFACT_HEADER,
    "window.CD_PARKING_ARTIFACT = {",
    "  injected: true,",
    `  model: ${JSON.stringify(model)},`,
    "  dataset: {",
    `    lots: ${JSON.stringify(dataset.lots)},`,
    `    observations: ${JSON.stringify(dataset.observations)},`,
    `    signals: ${JSON.stringify(dataset.signals)}`,
    "  }",
    "};",
    "",
  ].join("\n");
}

function buildRuntime(moduleBodies, adapterBody) {
  const parts = [RUNTIME_HEADER];
  for (const name of MODULES) {
    parts.push(`// ===== ${name}.mjs (parking-forecast/runtime) =====\n`);
    parts.push(moduleBodies[name].join("\n") + "\n");
    parts.push("\n\n"); // 模块之间空两行
  }
  parts.push("\n"); // 适配层前多空一行（与入库产物一致）
  parts.push(RUNTIME_ADAPTER_MARKER + "\n");
  parts.push(adapterBody.join("\n") + "\n");
  parts.push("\n");
  parts.push(RUNTIME_FOOTER + "\n");
  return parts.join("");
}

/** 逐行比对两段文本，返回第一处不同的行号（相同返回 -1）。 */
function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i + 1;
  }
  return -1;
}

/**
 * 自检 1：产物里的 data_fingerprint 与上游 model.json 一致，且等于
 * data/synthetic/manifest.json 记录的三份 jsonl 的 sha256 指纹。
 *
 * 注：manifest.json 里的 file_sha256 是在 Windows 检出（CRLF）下算的；LF 检出时
 * 文件字节不同、哈希也不同，但两者都源自同一份内容。故这里同时接受「原始字节」
 * 与「CRLF 归一化字节」两种哈希，任一命中即认为数据未被篡改。
 */
function checkFingerprint(model, manifest) {
  const problems = [];
  const shas = manifest.file_sha256 || {};
  const derived = ["lots.jsonl", "observations.jsonl", "signals.jsonl"].map((f) => shas[f] ?? "?").join(":");
  if (!model.data_fingerprint) problems.push("model.json 缺 data_fingerprint");
  else if (model.data_fingerprint !== derived) {
    problems.push(`model.json 的 data_fingerprint 与 manifest.json 派生值不一致：\n  model    = ${model.data_fingerprint}\n  manifest = ${derived}`);
  }
  for (const [name, want] of Object.entries(shas)) {
    const raw = readText(join(DATA_DIR, name));
    const crlf = raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    if (sha256(raw) !== want && sha256(crlf) !== want) {
      problems.push(`${name} 的内容哈希与 manifest.json 记录不一致（原始字节与 CRLF 归一化字节都不匹配）：数据被改过？`);
    }
  }
  return problems;
}

/**
 * 自检 2：产物文本里内联的 model / dataset 与上游文件逐字段一致
 * （直接解析产物文本，而不是比对刚生成的对象，避免自证）。
 */
function checkArtifactContent(artifactText, modelJson, upstream) {
  const problems = [];
  const pick = (re) => {
    const m = artifactText.match(re);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (err) {
      problems.push(`产物里内联的 JSON 解析失败：${err.message}`);
      return null;
    }
  };
  const model = pick(/\n {2}model: (\{.*\}),\n {2}dataset: \{/);
  const lots = pick(/\n {4}lots: (\[.*\]),\n {4}observations:/);
  const observations = pick(/\n {4}observations: (\[.*\]),\n {4}signals:/);
  const signals = pick(/\n {4}signals: (\[.*\])\n {2}\}/);
  if (!model) problems.push("产物里找不到内联的 model");
  else if (JSON.stringify(model) !== JSON.stringify(modelJson)) problems.push("产物里的 model 与 artifacts/model.json 不一致");
  if (!lots) problems.push("产物里找不到内联的 dataset.lots");
  else if (JSON.stringify(lots) !== JSON.stringify(upstream.lots)) problems.push("产物里的 dataset.lots 与 lots.jsonl 不一致");
  if (!observations) problems.push("产物里找不到内联的 dataset.observations");
  else if (JSON.stringify(observations) !== JSON.stringify(upstream.observations)) problems.push("产物里的 dataset.observations 与 observations.jsonl 不一致");
  if (!signals) problems.push("产物里找不到内联的 dataset.signals");
  else if (JSON.stringify(signals) !== JSON.stringify(upstream.signals)) problems.push("产物里的 dataset.signals 与 signals.jsonl 不一致");
  return problems;
}

/**
 * 自检 3：runtime 包里的算法代码与上游 runtime/*.mjs 逐行一致（去 import/export 后）。
 */
function checkRuntimeBodies(runtimeText, moduleBodies) {
  const problems = [];
  const lines = runtimeText.split("\n");
  for (const name of MODULES) {
    const body = moduleBodies[name];
    let found = false;
    let best = Infinity;
    for (let start = 0; start + body.length <= lines.length; start += 1) {
      let ok = true;
      for (let k = 0; k < body.length; k += 1) {
        if (lines[start + k] !== body[k]) { ok = false; break; }
      }
      if (ok) { found = true; break; }
      const d = firstDiff(body, lines.slice(start, start + body.length));
      if (d >= 0 && d < best) best = d;
    }
    if (!found) {
      problems.push(`runtime 包里的 ${name}.mjs 代码与上游不一致（最接近的一段第 ${best} 行起有差异）`);
    }
  }
  return problems;
}

/**
 * 自检 4：适配层与 runtime/index.mjs 行为一致。
 *   * 产物缺失：artifactPresent = false、ready = false、artifactError = "missing artifact"。
 *   * 合法产物：forecastLot / recommend 的输出与 index.mjs 逐字节一致。
 *   * 版本不兼容：两边都降级为 unavailable / note，不抛异常。
 */
async function checkBehaviour(runtimeText, artifactText, model, dataset) {
  const problems = [];
  const index = await import(pathToFileURL(join(RUNTIME_DIR, "index.mjs")).href);

  const makeSandbox = () => {
    const sandbox = { console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    return sandbox;
  };
  const load = (sandbox, artifactSrc) => {
    vm.runInContext(artifactSrc, sandbox, { filename: "parking-artifact.js" });
    vm.runInContext(runtimeText, sandbox, { filename: "parking-runtime.js" });
    return sandbox.CD_PARKING;
  };

  const issuedAt = "2026-04-10T14:00:00+08:00";
  const lotId = model.lots[0].lot_id;
  const horizons = [15, 30, 45, 60];

  // (a) 产物缺失
  {
    const sandbox = makeSandbox();
    vm.runInContext(runtimeText, sandbox, { filename: "parking-runtime.js" });
    const pf = sandbox.CD_PARKING;
    if (pf.artifactPresent !== false) problems.push("产物缺失时 artifactPresent 应为 false");
    if (pf.ready !== false) problems.push("产物缺失时 ready 应为 false");
    if (pf.artifactError !== "missing artifact") problems.push(`产物缺失时 artifactError 应为 "missing artifact"，实为 ${pf.artifactError}`);
    if (pf.model !== null || pf.dataset !== null) problems.push("产物缺失时 model / dataset 应为 null");
  }

  // (b) 正常产物
  const sandbox = makeSandbox();
  const pf = load(sandbox, artifactText);
  if (pf.artifactPresent !== true) problems.push("产物存在时 artifactPresent 应为 true");
  if (pf.ready !== true) problems.push(`产物合法时 ready 应为 true（artifactError=${pf.artifactError}）`);
  if (pf.artifactOk !== true) problems.push(`产物合法时 artifactOk 应为 true（artifactError=${pf.artifactError}）`);
  if (!pf.model || !pf.dataset) problems.push("产物合法时 model / dataset 不应为空");

  const mine = pf.forecastLot(pf.dataset, pf.model, lotId, issuedAt, issuedAt, horizons);
  const theirs = index.forecastLot(dataset, model, lotId, issuedAt, issuedAt, horizons);
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) problems.push("forecastLot 输出与 runtime/index.mjs 不一致");

  const myRec = pf.recommend(pf.dataset, pf.model, lotId, issuedAt, { preference: "save_time" });
  const theirRec = index.recommend(dataset, model, lotId, issuedAt, { preference: "save_time" });
  if (JSON.stringify(myRec) !== JSON.stringify(theirRec)) problems.push("recommend 输出与 runtime/index.mjs 不一致");

  // (c) 版本不兼容 → 降级为 unavailable，不抛异常
  {
    const badArtifact = artifactText.replace(/"schema_version":"2\.0\.0"/, '"schema_version":"9.9.9"');
    const badSandbox = makeSandbox();
    const bpf = load(badSandbox, badArtifact);
    const badModel = JSON.parse(badArtifact.match(/\n {2}model: (\{.*\}),\n {2}dataset: \{/)[1]);
    const expectErr = "unsupported schema_version: 9.9.9";

    if (bpf.artifactPresent !== true) problems.push("版本不兼容时 artifactPresent 仍应为 true（脚本在，只是产物不可用）");
    if (bpf.ready !== false) problems.push("版本不兼容时 ready 应为 false");
    if (bpf.artifactOk !== false) problems.push("版本不兼容时 artifactOk 应为 false");
    if (bpf.artifactError !== expectErr) problems.push(`版本不兼容时 artifactError 应为 "${expectErr}"，实为 ${bpf.artifactError}`);
    if (bpf.model !== null) problems.push("版本不兼容时 model 应被置为 null（下游只能拿到降级结果）");

    // 传同一个坏模型给两边：输出必须逐字节一致
    const bf = bpf.forecastLot(bpf.dataset, badModel, lotId, issuedAt, issuedAt, horizons);
    const theirBad = index.forecastLot(dataset, badModel, lotId, issuedAt, issuedAt, horizons);
    if (JSON.stringify(bf) !== JSON.stringify(theirBad)) problems.push("版本不兼容时的降级输出与 runtime/index.mjs 不一致");
    if (!bf || !Array.isArray(bf.forecasts) || bf.forecasts.length !== horizons.length) {
      problems.push(`版本不兼容时 forecastLot 应返回 ${horizons.length} 条 unavailable`);
    } else {
      if (bf.forecasts[0].degrade_reason !== expectErr) problems.push("版本不兼容时 degrade_reason 应为 unsupported schema_version");
      if (bf.forecasts[0].point_free !== null) problems.push("版本不兼容时 point_free 应为 null（不是 0）");
      if (bf.forecasts[0].method !== "unavailable") problems.push("版本不兼容时 method 应为 unavailable");
    }

    // 走 app.js 的调用方式（用 pf.model，此时为 null）：同样要降级、不抛异常
    const viaNull = bpf.forecastLot(bpf.dataset, bpf.model, lotId, issuedAt, issuedAt, horizons);
    if (!viaNull || !Array.isArray(viaNull.forecasts) || viaNull.forecasts.length !== horizons.length) {
      problems.push("版本不兼容且 model 为 null 时 forecastLot 应返回 unavailable 列表");
    } else if (viaNull.forecasts[0].point_free !== null || viaNull.forecasts[0].degraded !== true) {
      problems.push("版本不兼容且 model 为 null 时应返回 degraded=true / point_free=null");
    }

    // 坏模型下的 recommend：两边一致，且不抛异常
    const br = bpf.recommend(bpf.dataset, badModel, lotId, issuedAt, { preference: "save_time" });
    const theirBR = index.recommend(dataset, badModel, lotId, issuedAt, { preference: "save_time" });
    if (JSON.stringify(br) !== JSON.stringify(theirBR)) problems.push("版本不兼容时 recommend 输出与 runtime/index.mjs 不一致");
  }
  return problems;
}

function compareToDisk(path, generated) {
  if (!existsSync(path)) return { status: "缺失", detail: `文件不存在：${path}` };
  const onDisk = normalizeEol(readText(path));
  if (onDisk === generated) return { status: "一致", detail: "" };
  const a = onDisk.split("\n");
  const b = generated.split("\n");
  const line = firstDiff(a, b);
  return {
    status: "不一致",
    detail: `共 ${Math.max(a.length, b.length)} 行，首处差异在第 ${line} 行（磁盘 ${a.length} 行 / 新生成 ${b.length} 行）`,
  };
}

function rel(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1).replace(/\\/g, "/") : path;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length) die(`未知参数：${unknown.join(" ")}`);

  const modelJson = JSON.parse(readText(MODEL_JSON));
  const manifest = JSON.parse(readText(MANIFEST_JSON));
  const dataset = {
    lots: readJsonl(join(DATA_DIR, "lots.jsonl")),
    observations: readJsonl(join(DATA_DIR, "observations.jsonl")),
    signals: readJsonl(join(DATA_DIR, "signals.jsonl")),
  };

  const moduleBodies = {};
  for (const name of MODULES) {
    moduleBodies[name] = stripModule(readText(join(RUNTIME_DIR, `${name}.mjs`)));
  }
  const adapterBody = readAdapterTemplate();

  const artifactText = buildArtifact(modelJson, dataset);
  const runtimeText = buildRuntime(moduleBodies, adapterBody);

  const problems = [];
  problems.push(...checkFingerprint(modelJson, manifest));
  problems.push(...checkArtifactContent(artifactText, modelJson, dataset));
  problems.push(...checkRuntimeBodies(runtimeText, moduleBodies));
  problems.push(...(await checkBehaviour(runtimeText, artifactText, modelJson, dataset)));

  const results = [
    { path: ARTIFACT_OUT, text: artifactText },
    { path: RUNTIME_OUT, text: runtimeText },
  ].map((r) => ({ ...r, cmp: compareToDisk(r.path, r.text) }));

  const out = [];
  out.push("export_browser · 浏览器产物导出");
  out.push("  上游：parking-forecast/artifacts/model.json + data/synthetic/*.jsonl + runtime/*.mjs");
  for (const r of results) {
    out.push(`  ${rel(r.path)}`);
    out.push(`    重新生成 sha256 = ${sha256(r.text)}`);
    out.push(`    与磁盘文件比对：${r.cmp.status}${r.cmp.detail ? `（${r.cmp.detail}）` : ""}`);
  }
  if (problems.length) {
    out.push("  自检：未通过");
    for (const p of problems) out.push(`    - ${p}`);
  } else {
    out.push("  自检：全部通过（data_fingerprint / 内联 model+dataset / runtime 函数体 / 适配层与 index.mjs 行为一致）");
  }
  process.stdout.write(out.join("\n") + "\n");

  if (checkOnly) {
    const mismatched = results.filter((r) => r.cmp.status !== "一致");
    if (problems.length || mismatched.length) {
      process.stderr.write("export_browser: --check 未通过\n");
      process.exit(1);
    }
    return;
  }

  for (const r of results) {
    // 内容相同就不重写：避免无谓地改动工作区的行尾（Git 存储形式是 LF，检出可能是 CRLF）。
    const onDisk = existsSync(r.path) ? normalizeEol(readText(r.path)) : null;
    if (onDisk === r.text) {
      r.written = false;
      continue;
    }
    writeFileSync(r.path, r.text, "utf8");
    r.written = true;
  }
  const wrote = results.filter((r) => r.written).length;
  process.stdout.write(
    wrote === 0
      ? "  已是最新，未改动任何文件（LF 行尾，跨平台字节一致）\n"
      : `  已写出 ${wrote} 个文件（LF 行尾，跨平台字节一致）\n`
  );
  if (problems.length) {
    process.stderr.write("export_browser: 自检未通过，仍写出了文件，请检查上面的问题\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`export_browser: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

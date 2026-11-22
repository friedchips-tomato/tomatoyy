# parking-forecast · 停车预测与推荐（阶段 1 + 阶段 2）

本目录是任务二「停车预测 + 停车推荐」的离线管道。本阶段（阶段 1）只做三件事：

1. **定死数据长什么样**：六份 JSON Schema（draft 2020-12 子集）。
2. **定死缺数据怎么办**：完全可复现的合成数据生成器（含缺失/过期注入）。
3. **统一读取入口**：`load_observations` 骨架（合成分支可用，真实分支留接口桩）。

> **重要声明**：本目录所有数据均为 `source: "synthetic"` 的**合成/示范数据，仅用于验证管道**，
> 不代表真实车场余位，不构成正式精度达标。任何「看起来像真实数据」的数字都必须同屏可见其来源标记。

## 目录结构

```
parking-forecast/
  README.md
  schemas/              六份 JSON Schema
    lot.schema.json            车场静态信息（02 §2.1）
    observation.schema.json    余位观测时序（02 §2.2，核心表）
    signals.schema.json        外部信号 calendar/weather/event（02 §2.3）
    forecast.schema.json       预测输出（02 §2.4）
    recommendation.schema.json 推荐输出（02 §2.5）
    artifact.schema.json       运行时产物契约（01 §5 / 03 §3.4）
  src/pf/
    __init__.py
    schema.py     最小 JSON Schema 校验器（不引 jsonschema）
    synth.py      合成生成器（可复现，numpy）
    dataset.py    统一读取层（合成/真实同入口，真实分支为接口桩）
  tests/
    test_schema.py  验收 1.1
    test_synth.py   验收 1.2–1.9 + dataset
  data/synthetic/   生成产物（lots/observations/signals.jsonl + manifest.json）
```

## 复算命令

```sh
cd parking-forecast

# 运行测试（pytest）
python -m pytest tests -q

# 重新生成合成数据（写 data/synthetic/）
PYTHONPATH=src python -m pf.synth

# 重新生成并换种子
PYTHONPATH=src python -m pf.synth --seed 123
```

依赖：Python 3.11 + numpy（`numpy.random.default_rng`）。校验器与读取层为纯标准库，不引第三方依赖。

## 数据约定

- 文件均为 **JSON Lines**（`.jsonl`），字段名 **snake_case**。
- 时间统一 **UTC 带时区偏移**，合成数据固定 `+08:00`（与 changdi-intake 北京口径一致）。
  内部以 naive datetime 表示墙钟时间，输出时附加 `+08:00`，例：`2026-04-15T18:30:00+08:00`。
- 所有 **record 对象一律 `additionalProperties: false`**：真实接入时悄悄塞进未定义字段会变成显式失败。
- `parking_observation.free_spaces` 允许 `integer` 或 `null`；`quality == "missing"` 时 `free_spaces` 必为 `null`
  （0 是有业务含义的真实值，不得顶替）。`quality == "stale"` 时 `age_seconds` 必填。
  这两条条件约束由生成器与读取层强制；JSON Schema 子集无法表达 `if/then`，故写入 schema 的 `description`。
- `parking_signal.kind` ∈ `calendar` / `weather` / `event`；`lot_id == "ALL"` 表示全局信号。
- 所有产物带 `source: "synthetic"`。

## JSON Schema 子集

schema 只使用 `type` / `required` / `properties` / `enum` / `minimum` / `maximum` / `additionalProperties`
（外加 `$schema` / `title` / `description` 元信息）。**数组只校验 `type == array`**，数组元素深度校验
（fee 结构、forecast 长度与粒度等）由阶段 3 的 `prototype-paper/check.mjs` 负责——这是设计文档的明确划分。

`schema.py` 为自写最小校验器（约 120 行），`validate(instance, schema) -> list[error]`，
错误为 `{"path": "...", "reason": "..."}`，空列表 = 通过。`type` 支持单个类型名或类型名列表
（union，如 `["integer", "null"]`）。

## 合成生成器（synth.py）

- **可复现**：单一 `seed` 决定全部随机性，`numpy.random.default_rng(seed)`，不混用全局 `np.random`。
- **余位模型**（02 §3.3）：

  ```
  occupancy_rate(t) = clip( base_occupancy[L]
                            + workday_shift[L]·is_workday(t)
                            + holiday_shift[L]·is_holiday(t)
                            − weekend_shift[L]·is_weekend(t)
                            + peak_shape[L](t)·peak_intensity[L]
                            + weather_coeff[weather(t)]·weather_intensity
                            + Σ event_strength[e]·event_shape[e](t)
                            + noise(t), 0.02, 0.98 )
  free_spaces(t) = round( total_spaces[L] · (1 − occupancy_rate(t)) )
  ```

  - `peak_shape[L](t)`：`profile` 给出的控制点线性插值（早高峰 07:30–09:30、晚高峰 17:00–19:30），不硬编码街区规律。
  - `noise(t)`：AR(1) 过程 `noise[i] = ρ·noise[i-1] + N(0,σ)`，默认 `ρ=0.7`、`σ=0.015`。
  - `event_shape[e](t)`：事件窗口内半小时渐入/渐出的梯形权重。

- **缺失/过期注入顺序**（02 §3.4，顺序固定保证可复现）：
  1. 算「真值」序列；2. `outage_windows` 整段 missing；3. `missing_rate` 随机 missing；
  4. `stale_rate` 冻结（沿用上一条有效值 + `quality=stale` + `age_seconds` 随冻结时长递增）；
  5. `suspect_rate`（默认 0）置 suspect。

- **参数即契约**：`SynthConfig` 与 02 §3.2 表一致（另加 §3.4 的 `suspect_rate`），全部写入 `manifest.json`。
  `generated_at` 由参数给定（生成器不读系统时钟），缺省为 `null`，以保证两次运行逐字节相同。

## 读取层（dataset.py）

`load_observations(config) -> Dataset`：合成读 `data/synthetic/*.jsonl`，按 `lot_id`/`ts` 排序，
同 `lot` 同 `ts` 去重（保留 `quality` 最高的一条，排序 `ok > stale > suspect > missing`）。
真实分支为接口桩（`NotImplementedError`），契约要求见 02 §4（缺失不插值、不前向填充等）。

## 验收标准对照

| 标准 | 测试 |
| --- | --- |
| 1.1 schema 齐备 + additionalProperties:false + 缺/多字段/枚举越界报错 | `test_schema.py` |
| 1.2 同 seed 同参数两次运行逐字节相同（sha256） | `test_reproducible_same_seed` |
| 1.3 不同 seed 产出不同数据 | `test_different_seed_differs` |
| 1.4 missing 的 free_spaces 是 null | `test_missing_free_spaces_is_null` |
| 1.5 stale 带 age_seconds 且单调不减 | `test_stale_age_seconds_monotonic` |
| 1.6 outage 区间全部 missing | `test_outage_window_all_missing` |
| 1.7 manifest 记录 seed/参数/sha256/计数且一致 | `test_manifest_records_seed_params_sha_counts` |
| 1.8 余位 ∈ [0,total]、空置率 ∈ [0,1] | `test_physical_range` |
| 1.9 AR(1) lag-1 自相关 > 0.5 | `test_ar1_noise_autocorrelation` |

---

## 阶段 2 · 复杂算法（特征 + 基线 + 训练 + 回测 + JS 运行时）

本阶段把「能不能预测」变成「可复算的数字」，并把模型搬进**零依赖 Node ESM 运行时**。

### 目录结构（阶段 2 新增）

```
parking-forecast/
  src/pf/
    features.py   特征构造（39 维，防泄漏 hard rule，与 runtime/features.mjs 逐位一致）
    baselines.py  B1 last_known / B2 same_slot_median / B3 same_weekday_mean（+ 前一日诊断）
    train.py      M0 规则 / M1 岭回归（导出 kind=linear）/ M3 分位数回归 + 降级链 D0–D4
    backtest.py   时间切分 + walk-forward 回测 + degrade_coverage + 指标 + 六维分层
    recommend.py  打分（分高靠前）+ 硬过滤 + 错峰 + 人话理由（04 §3）
    export.py     model.json 产物（{version, kind, features, payload, ranking_caps, ...}）
  scripts/
    report.py            重新生成 artifacts/{model.json, metrics.json, manifest.json, report.md}
    export_browser.mjs   重新生成 prototype-paper/data/{parking-artifact.js, parking-runtime.js}
    browser_adapter.js   浏览器安全适配层模板（runtime/index.mjs 的经典脚本等价物）
  tests/
    test_features.py     特征 / 基线 / 降级 D3–D4（2.1–2.2, 2.6, 2.7, 2.9, 2.10）
    test_backtest.py     切分 / walk-forward / 降级覆盖 / 指标（2.3–2.5, 2.13–2.14）
    test_leakage.py      删除未来观测特征预测逐位不变（2.1–2.2）
    test_consistency.py  生成 500 条 Python 黄金基准供 node 逐位比对（2.17, 2.25）
    test_export_browser.py  浏览器产物导出脚本的可复现性回归（连跑两次字节相同 + 与入库产物一致）
  runtime/               零依赖 Node ESM 运行时（与 Python 逐位一致）
    index.mjs     入口 + artifact schema 校验 + 产物缺失/版本不兼容降级 unavailable
    features.mjs  特征构造（同 features.py）
    forecast.mjs  线性点积 + 降级链 D0–D4（同 train.py）
    recommend.mjs 打分/排序/错峰（同 recommend.py）
    reasons.mjs   人话理由模板（同 make_reasons）
    format.mjs    时间/舍入/中位数等共享工具
    test/*.test.mjs  node:test（一致性 / schema / 版本兼容 / 确定性）
  artifacts/  model.json / metrics.json / manifest.json / report.md（全部 source=synthetic）
```

### 复算命令（阶段 2）

```sh
cd parking-forecast

# 1) 重新生成 artifacts（model.json / metrics.json / manifest.json / report.md）
PYTHONPATH=src python scripts/report.py

# 2) Python 测试（含 500 条一致性黄金基准生成，写入 runtime/test/fixtures/consistency.json）
python -m pytest tests -q

# 3) JS 运行时测试（读取 model.json + 黄金基准，逐位比对；18 条断言）
node --test "runtime/test/*.test.mjs"

# 4) 重新生成浏览器产物（prototype-paper 的两个注入脚本，见下节）
node scripts/export_browser.mjs          # 写出
node scripts/export_browser.mjs --check  # 只校验：与入库产物比对 + 脚本内置自检
```

依赖：阶段 2 在阶段 1 之上新增 `numpy` + `scikit-learn`（`Ridge`、`HistGradientBoostingRegressor`）。
运行时 `runtime/*.mjs` 为**零依赖 Node ESM**（Node ≥ 18，本机验证 Node 22）。

> **行尾策略（生成物一律 LF）**：`pf.export.write_json` / `write_text` 与 `pf.synth._write_jsonl` /
> `_write_json` 都显式 `newline="\n"`，生成物不随平台默认换行转换而变。于是
> 「磁盘字节 = Git blob 字节 = `manifest.json` 里记录的 SHA-256 字节」三者在任何平台都相等：
> `data/synthetic/manifest.json` 的 `file_sha256` 与 `artifacts/manifest.json` 的 `files` 才是可用的
> 完整性凭据（改动这几个写出函数时**不得**去掉 `newline="\n"`）。
> 注意检出环境仍可能把 LF 检出成 CRLF（`core.autocrlf=true`），此时用 LF 归一化后的字节比对即可
> （`scripts/export_browser.mjs` 的 `checkFingerprint` 就是这么做的）。

> 说明：`node --test runtime/test/`（目录形式）在本机 Windows + Node 22.17 下会退化为「按模块路径加载」而失败，
> 故用 glob 形式 `node --test "runtime/test/*.test.mjs"`（或 `node --test` 无参扫描），二者语义等价。

### 浏览器产物导出（prototype-paper 注入脚本）

`prototype-paper/data/` 下有两个**自动生成**的产物，入库它们是为了让演示页不必重跑训练管线：

| 产物 | 来源 | 说明 |
| --- | --- | --- |
| `parking-artifact.js` | `artifacts/model.json` + `data/synthetic/{lots,observations,signals}.jsonl` | 把模型与合成数据内联成 `window.CD_PARKING_ARTIFACT` |
| `parking-runtime.js` | `runtime/{format,features,forecast,reasons,recommend}.mjs` + `scripts/browser_adapter.js` | 去 ESM 的 import/export 后拼成 IIFE，末尾接浏览器安全适配层 |

```sh
cd parking-forecast

node scripts/export_browser.mjs           # 重新写出两个产物
node scripts/export_browser.mjs --check   # 只校验不写盘：与入库产物逐字节比对 + 内置自检
```

脚本特性（`scripts/export_browser.mjs`，零第三方依赖，只用 Node 内置模块）：

- **确定性**：无时间戳、无随机序、无机器路径；同输入必得同字节。产物按 **LF** 写出
  （Git 存储形式即 LF；检出环境可能是 CRLF，`--check` 比对时两侧都归一化为 LF）。
- **不改上游语义**：只搬运与包装。`runtime/*.mjs` 的函数体逐行不变（去掉 import/export 之外不动一字），
  适配层是 `runtime/index.mjs` 的经典脚本等价物（见 `scripts/browser_adapter.js` 头部的逐条对应关系）。
- **输出必须是经典脚本（IIFE）**，不能改成 `.mjs` ESM——演示用 `python -m http.server` 会把 `.mjs`
  当 `text/plain` 发出，浏览器拒绝模块脚本。
- **内置自检**（`--check` 也会跑）：
  1. 产物的 `data_fingerprint` == `model.json` == `data/synthetic/manifest.json` 派生的三份 jsonl 哈希；
  2. 产物内联的 model / dataset 与上游文件逐字段一致（解析产物文本再比，不是自证）；
  3. runtime 包里每个 `runtime/*.mjs` 的代码与上游逐行一致；
  4. 适配层与 `runtime/index.mjs` **行为一致**：合法产物下 `forecastLot` / `recommend` 输出逐字节相同；
     版本不兼容（`schema_version` 不匹配）时两边都降级为 `unavailable` 且不抛异常；
     产物缺失时 `artifactPresent=false` / `ready=false` / `artifactError="missing artifact"`。


### 模型产物（artifacts/model.json）

```jsonc
{
  "schema_version": "2.0.0",
  "version": "2.0.0", "kind": "linear",
  "features": [/* 39 个有序特征名，点积顺序 */],
  "payload": {
    "horizons": {"15": {"intercept": ..., "coef": {...}}, "30": ..., "45": ..., "60": ...},
    "scaler": {"mean": {...}, "std": {...}},
    "residual_quantiles": {"15": {"q10": ..., "q90": ...}, ...},
    "feature_fills": { /* 缺失填值统计 */ },
    "calendar": {"time_sin": [...], "time_cos": [...], "dow_sin": [...], "dow_cos": [...]}
  },
  "ranking_caps": { /* need / walk_cap_min / total_cap_min / fee_cap_cny / ... */ },
  "ranking_weights": { "default": {...}, "save_time": {...}, "less_walking": {...} },
  "lots": [...], "trained_at": "...", "data_fingerprint": "...", "source": "synthetic"
}
```

### 主口径与降级链

- 主百分比口径 **WAPE（口径 D）**，同时给出绝对车位 MAE；四个候选口径 A/B/C/D 一并列出，
  需求方书面确认前**不自称达标**（详见 `artifacts/report.md` 首页口径声明）。
- 降级链：`D0 model → D1 same_slot → D2 same_weekday → D3 last_known → D4 unavailable`；
  D4 时 `point_free=null`（不是 0），D3 只复制最后已知值、不外推趋势。

### 验收标准对照（阶段 2）

| 标准 | 测试 / 产物 |
| --- | --- |
| 2.1 删除未来观测特征预测逐位不变 | `test_leakage.py::test_delete_future_observations_identical` |
| 2.2 周期基线窗口右端点 ≤ issued_at | `test_leakage.py::test_baseline_window_right_endpoint` |
| 2.3 切分不交叠 + ≥24h embargo | `test_backtest.py::test_split_no_overlap_and_embargo` |
| 2.4 walk-forward 只用该步之前数据 | `test_backtest.py::test_walk_forward_causal_window` |
| 2.5 D0–D4 每级都被触发 | `test_backtest.py::test_degrade_coverage_all_levels` |
| 2.6 D3 只复制最后已知值、不外推 | `test_features.py::test_degrade_d3_last_known_d4_unavailable` |
| 2.7 D4 point_free is None（不是 0） | 同上 |
| 2.9 降级原因写入 degrade_reason | 同上 |
| 2.10 三基线全部实现并上报 | `test_backtest.py::test_baselines_reported_three_rows` + report 三行 |
| 2.11 绝对 MAE + 按书面口径百分比 | `artifacts/metrics.json`（`mae` / `wape` 等） |
| 2.12 报告首页写明口径选择与原因 | `artifacts/report.md` 首页 |
| 2.13 六维分层 | `test_backtest.py::test_stratify_six_dimensions_shape` + `metrics.json` |
| 2.14 MAPE 排除 actual==0 且报排除比例 | `test_backtest.py::test_metrics_mape_excludes_zero` |
| 2.15 报告声明合成数据 | `report.md` 首页 |
| 2.16 主口径优于最强基线且无某层更差 | `report.py`（`model_beats_strongest_every_horizon`） |
| 2.17 500 条 Python/JS 逐位相等 | `test_consistency.py` + `runtime/test/consistency.test.mjs` |
| 2.18 JS 校验 schema、不合法拒绝 | `runtime/test/schema.test.mjs` |
| 2.19 产物缺失/版本不兼容返回 unavailable 不抛异常 | `runtime/test/version_compat.test.mjs` |
| 2.20 同一输入同一推荐顺序与理由（确定性） | `runtime/test/determinism.test.mjs` |
| 2.21 score == Σ contribution | `runtime/test/determinism.test.mjs` |
| 2.22 理由数字与 breakdown.raw 一致 | 同上 |
| 2.23 偏好切换只改权重、排序不同 | 同上 |
| 2.24 硬过滤车场进 excluded 带原因 | `recommend.py`（`access_check` / `height_check`） |
| 2.25 ranking_caps / ranking_weights 写进 model.json | `test_consistency.py::test_artifact_has_ranking_caps_and_weights` |

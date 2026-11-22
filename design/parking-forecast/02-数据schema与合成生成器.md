# 02 · 数据 schema 与合成数据生成器

设计目标：**同一套 schema 同时承载「合成验收数据」与「未来真实历史数据」**，使得管线（特征 → 训练 → 回测 → 产物）在两种数据上跑的是同一段代码，只是换输入文件。真实数据到位时不需要改模型代码。

---

## 1. 数据层次

```
                        ┌─ calendar.signal（工作日/节假日/高峰）─┐
输入层  observation ────┤                                      ├──► features ──► model ──► forecast
        （余位时序）     ├─ weather.signal（天气）───────────────┤
                        └─ event.signal（活动/事件强度）─────────┘

输出层  forecast（余位预测 + 区间 + 降级标记）──► recommend（排序 + 可复算理由）
```

三类信号都是**可选**的：真实数据接入时可能只有日历，没有天气和事件。管线必须能在信号缺失时按 §3 的降级规则继续工作，而不是崩溃。

---

## 2. Schema

所有文件为 JSON Lines（`.jsonl`），字段名用 snake_case，时间统一 **UTC 带时区偏移**（`2026-04-15T18:30:00+08:00`），与 `changdi-intake` 现有时间口径一致（该项目用北京时间报表 + 毫秒截点）。

### 2.1 `parking_lot` — 车场静态信息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `lot_id` | string | 是 | 目录代码，**大写字母开头**，仅大写字母/数字/短横线，≤32 字符。与导览事件 `subjectId` 规则一致（`tourism/contract.js` 的 `subjectIdPattern`），便于直接复用目录 |
| `name` | string | 是 | 展示名 |
| `total_spaces` | integer | 是 | 总车位数（正整数） |
| `fee` | object | 是 | `{mode: "hourly"\|"flat"\|"unknown", amount: number\|null, unit: "CNY"\|null, note: string}` — 现行 `fee` 是写死字符串，必须拆成可计算结构 |
| `access` | object | 是 | 进出限制：`{open_hours: "00:00-24:00"\|null, one_way: bool, restricted_hours: [{from,to}]｜null, height_limit_m: number｜null, note: string}` |
| `geometry` | object | 否 | `{lat, lon}` 真实坐标占位；现阶段填 `null`，不得编造经纬度 |
| `walk_to_street` | object | 是 | `{meters: integer, minutes: integer}` — 到街区主入口的步行距离/时间。现行 `walk: 150` 只有米数，**时间需另行给定并标注为估算** |
| `district` | string | 否 | 归属街区/片区，真实数据接入后用于分模型 |
| `source` | string | 是 | `synthetic` / `manual` / `api` / `camera` — 数据来源，决定页面上标注什么 |
| `notes` | string\|null | 否 | 备注 |

### 2.2 `parking_observation` — 余位观测时序（核心表）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `lot_id` | string | 是 | 外键 → `parking_lot.lot_id` |
| `ts` | string | 是 | 观测时刻（带时区） |
| `free_spaces` | integer\|**null** | 是 | 当前余位。**允许 null 表示缺失**，不得用 0 顶替（0 是有业务含义的真实值） |
| `total_spaces` | integer\|null | 否 | 当时的总位数（改扩建时会变），null 时回落到车场静态表 |
| `source` | string | 是 | `synthetic` / `sensor` / `manual` / `api` |
| `quality` | string | 是 | `ok` / `stale` / `suspect` / `missing` — 由生成器或接入器判定；`missing` 时 `free_spaces` 必为 null |
| `age_seconds` | integer\|null | 否 | 数据年龄；`stale` 时必填。**这是过期判定的唯一依据**，不靠 `updated` 文案 |
| `ingested_at` | string | 否 | 入库时刻，真实数据接入后用于重算 |

**为什么必须有 `quality` 和 `age_seconds`**：现行 `updated: "2 分钟前"` 是文案，既不可计算也不可信。改造后「数据更新时间」一律由 `age_seconds` 推导。

### 2.3 `parking_signal` — 外部信号（可空）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `lot_id` | string | 车场；`"ALL"` 表示全局信号（天气、街区级活动） |
| `ts` | string | 信号生效时刻 |
| `kind` | enum | `calendar` / `weather` / `event` |
| `is_workday` | bool | `kind=calendar` |
| `is_holiday` | bool | `kind=calendar` |
| `holiday_name` | string\|null | `kind=calendar`，如 "国庆节" |
| `peak` | enum | `kind=calendar`：`none` / `am_peak` / `pm_peak` / `evening` |
| `weather` | enum | `kind=weather`：`sunny` / `cloudy` / `rain` / `heavy_rain` / `storm` |
| `temperature_c` | number\|null | `kind=weather` |
| `event_id` | string\|null | `kind=event`，与 `event_strength` 配对 |
| `event_name` | string\|null | `kind=event` |
| `event_strength` | number\|null | 0..1，事件对停车需求的拉动强度。**由配置给定，不自行推断**；无事件数据时该字段不存在（不是 0） |
| `source` | string | `synthetic` / `calendar_api` / `weather_api` / `manual` |

### 2.4 `parking_forecast` — 预测输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `lot_id` | string | |
| `issued_at` | string | 预测生成时刻 |
| `target_ts` | string | 被预测的目标时刻 |
| `horizon_minutes` | integer | 距生成时刻的分钟数 |
| `point_free` | integer\|**null** | 点预测余位；不可用时为 null |
| `p10` / `p90` | integer\|null | 区间下/上界（余位） |
| `free_rate` | number\|null | 点预测空置率 = `point_free / total_spaces` |
| `method` | enum | `last_known` / `same_slot_baseline` / `same_weekday_baseline` / `model` / `unavailable` — **降级链条可见** |
| `degraded` | bool | 是否走了降级路径 |
| `degrade_reason` | string\|null | 如 `missing_observation`、`stale_observation`、`no_history` |
| `model_version` | string\|null | 产出该预测的模型版本（`unavailable` 时为 null） |
| `data_asof` | string\|null | 预测实际使用的最新观测时刻 |
| `source` | string | `synthetic` / `real` — 页面据此决定标注「模拟」还是「实测」 |

### 2.5 `parking_recommendation` — 推荐输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `destination_id` | string | 目的地锚点 id（点位 id 或车场 id） |
| `arrive_at` | string | 计划到达时刻（带时区） |
| `preference` | enum | `save_time`（省总时间）/ `less_walking`（少走路） |
| `generated_at` | string | |
| `items` | array | 每项见下 |
| `alternates` | array | 备选车场（同一目的地次优项） |
| `source` | string | `synthetic` / `real` |

单个 item：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `lot_id` / `name` | string | |
| `arrive_free` | integer\|null | 到达时刻的预计余位（来自 forecast） |
| `arrive_free_rate` | number\|null | 到达时刻空置率 |
| `arrive_free_p10`/`p90` | integer\|null | 到达时刻区间 |
| `walk_meters` / `walk_minutes` | integer | 停车后到目的地的步行量 |
| `fee_amount` / `fee_unit` | number\|string\|null | 费用；`unknown` 时为 null 并在理由中说明 |
| `updated_at` | string\|null | 该车场数据的更新时间 |
| `stale` | bool | 数据是否过期 |
| `score` | number | 综合分（越大越靠前，或按实现定义越小越优——**必须在文档中固定一个方向**） |
| `score_breakdown` | array | `[{factor, weight, raw, normalized, contribution}]` — **可复算的关键** |
| `reasons` | array of string | 人话理由，逐条可回溯到 `score_breakdown` 某项 |
| `total_time_minutes` | number\|null | 总时间估计 = 驾车 + 步行（驾车时间需道路数据，现阶段为估算并标注） |
| `transfer` | object\|null | 接驳方案：`{mode: "bike"\|null, feasible: bool, minutes, note}` |
| `restrictions` | array of string | 该车场在到达时刻的进出限制提示 |
| `forecast_method` | enum | 该项余位预测用的方法（与 forecast.method 对齐） |
| `degraded` | bool | 是否降级结果 |

---

## 3. 合成数据生成器（`src/pf/synth.py`）

### 3.1 设计约束

- **可复现**：单一 `seed` 决定全部随机性；同 seed + 同参数 → 逐字节同输出。用 `numpy.random.default_rng(seed)`，不混用全局 `np.random`。
- **不伪造真实事实**：所有产物带 `source: "synthetic"`，`notes` 写明「合成数据，仅用于管线验证」。
- **可注入缺陷**：缺失与过期是**显式参数**，不是偶然副产品——这样回测能覆盖降级路径。
- **参数即契约**：生成参数写入 `manifest.json`，任何一份合成数据都能追溯到它的生成参数。

### 3.2 生成器参数（`SynthConfig`）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `seed` | int | 必填 | 随机种子 |
| `start_date` / `end_date` | date | 必填 | 日期范围（含） |
| `granularity_minutes` | int | 15 | 时间粒度（观测与预测点） |
| `lots` | list | 2（P1/P2） | 车场配置：`lot_id`, `total_spaces`, `base_occupancy`, `profile` |
| `profile` | object | 见下 | 每个车场的日内/周内形态 |
| `day_type` | object | 见下 | 工作日/节假日/周末的基础差异 |
| `peak` | object | 见下 | 高峰时段与强度 |
| `weather` | object | 见下 | 天气取值分布与对需求的系数 |
| `events` | list | `[]` | 事件清单：`event_id`, `name`, `dates`, `hours`, `strength` |
| `noise` | object | 见下 | 噪声模型参数 |
| `missing_rate` | float | 0.03 | 观测随机缺失比例（`free_spaces=null` + `quality=missing`） |
| `stale_rate` | float | 0.02 | 观测「冻结」比例（沿用上一条值 + `quality=stale` + `age_seconds`） |
| `outage_windows` | list | `[]` | 整段断连：`[{lot_id, from, to}]`，该区间全部 `missing` |

### 3.3 余位生成模型

对车场 `L`、时刻 `t`：

```
occupancy_rate(t) = clip( base_occupancy[L]
                          + weekday_shift[L] * is_workday(t)
                          + holiday_shift[L] * is_holiday(t)
                          - weekend_shift[L] * is_weekend(t)
                          + peak_shape[L](t) * peak_intensity[L]
                          + weather_coeff[L][weather(t)] * weather_intensity
                          + sum(event_strength[e] * event_shape[e](t) for e in events(t))
                          + noise(t), 0.02, 0.98 )

free_spaces(t) = round( total_spaces[L] * (1 - occupancy_rate(t)) )
```

- `peak_shape[L](t)`：归一化的日内曲线（早高峰 07:30–09:30、晚高峰 17:00–19:30），形状由 `profile` 给出的若干控制点线性插值而来，**不硬编码**具体街区规律。
- `noise(t)`：AR(1) 过程 `noise(t) = ρ·noise(t-Δ) + ε(t)`，`ρ` 与 `ε` 尺度由 `noise` 参数给出（默认 ρ=0.7、σ=0.015）。用 AR(1) 而不是白噪声，是为了让序列具备真实的短程自相关——否则「最后已知值」基线会失真，从而低估模型收益。
- `event_shape[e](t)`：事件影响窗口内的钟形/梯形权重，`strength` 为幅度上限。

### 3.4 缺失与过期的注入顺序

按顺序执行，保证可复现：

1. 算出「真值」序列；
2. 按 `outage_windows` 整段置为 `missing`；
3. 按 `missing_rate` 随机置为 `missing`；
4. 按 `stale_rate` 冻结：保留上一条有效值，`quality=stale`，`age_seconds` 随冻结时长递增；
5. 按 `suspect_rate`（默认 0）置为 `suspect`（值存在但可能错，例如余位为负或超总量的 ±1 抖动）——真实接入时用于表达传感器异常。

**关键**：`missing` 的 `free_spaces` 必须是 `null`，不是 0；`stale` 必须带 `age_seconds`。这两点直接决定降级逻辑是否可测。

### 3.5 产物

```
data/synthetic/
  lots.jsonl
  observations-<lot_id>.jsonl      # 或合并为 observations.jsonl
  signals.jsonl
  manifest.json                    # {seed, config, generated_at, generator_version, file_sha256[], sample_counts}
```

`manifest.json` 记录每个文件的 sha256，回测报告引用 manifest 指纹 → 任何一次回测结果都能追到具体数据。

---

## 4. 真实历史数据接口（后续接入，本任务不实现）

预留一个**读取层**接口，合成与真实走同一入口：

```python
# src/pf/dataset.py（后续阶段）
def load_observations(config) -> Dataset:
    """读取 observations + signals + lots，返回统一 Dataset。
    - 合成：读 data/synthetic/*.jsonl
    - 真实：读 CHANGDI_PARKING_OBSERVATIONS 指向的目录或数据库
    统一：按 lot_id/ts 排序、去重（同 lot 同 ts 保留 quality 最高的一条）、标注 staleness。
    """
```

真实数据接入的**契约要求**（写在这里，方便日后对接方照做）：

- 每条观测至少给 `lot_id` / `ts` / `free_spaces` / `source`；
- 缺失时刻**直接不产出行**，或产出行且 `free_spaces=null` + `quality=missing`——两者等价，但**不要插值、不要前向填充**，插值会污染回测结论；
- 历史覆盖建议 ≥ 8 周、粒度 ≤ 15 分钟，且**包含至少一次节假日或大活动**，否则「工作日/节假日/活动」三类特征无法验证，只能作为占位特征。

---

## 5. Schema 校验

- `schemas/*.schema.json` 用 JSON Schema draft 2020-12 的子集（`type` / `required` / `properties` / `enum` / `minimum` / `maximum` / `additionalProperties: false`），Python 侧写一个 ~150 行的最小校验器（不引 `jsonschema` 依赖），Node 侧同样实现一份（供运行时读产物时校验）。
- **所有 schema 对 record 对象一律 `additionalProperties: false`**：防止真实接入时悄悄塞进未定义字段，让「字段含义变化」变成显式失败。
- 校验失败的处理：合成生成器自己产出必然合法的数据（自检断言）；真实接入时校验失败 → **该批次不进入训练**，并把失败原因写入报告，而不是跳过坏行继续跑。

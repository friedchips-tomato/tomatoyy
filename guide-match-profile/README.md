# 讲解员智能匹配 + 游客兴趣画像（guide-match-profile）

乐游蓬江 AI 智慧导览小程序 · 模块 4「人工讲解员智能匹配与在线预约」与模块 1「游客兴趣画像」的算法层实现。
负责：讲解员**多条件匹配与排序**、**服务能力画像**（评价聚合 + 时段供给）、**游客兴趣画像**（行为增量更新），
以及配套的**代理评估与指标计算函数**。

> 全部字段遵守 `algo-specs/CONTRACT.md`（ID 前缀、时间口径 UTC+8、WGS84 坐标）。
> 所有数据均为**合成示例**（`data_source=synthetic`、`verified=false`），不冒充真实人物与真实评价。

---

## 1. 目录结构

```
guide-match-profile/
  README.md                # 本文件
  main.py                  # 演示入口：匹配 → 画像 → 供给 → 冲突/改约 → 代理指标
  config.py                # 权重表、阈值、行为映射规则（可从配置改）
  common.py                # 包内公共工具（haversine、时间/时段解析）
  matching.py              # 讲解员多条件匹配与排序
  profile.py               # 讲解员服务能力画像
  visitor_profile.py       # 游客兴趣画像增量更新 + 脱敏
  evaluation.py            # 代理评估与指标计算函数
  data/
    make_data.py           # 合成数据生成脚本（固定随机种子 20261122）
    guides.json            # 24 位示例讲解员
    points.json            # 12 个示例点位（LD 前缀）
    reviews.csv            # 1446 条示例评价
    visitor_events.csv     # 621 条示例游客行为（含 book_confirmed 扩展事件）
  tests/test_*.py          # pytest（23 项，全绿）
  metrics.json             # 跑出来的量化指标（含基线对比与画像更新示例）
```

## 2. 运行与验收

```bash
# 跑通一次完整示例（打印匹配结果/画像/供给/代理指标，并写 metrics.json）
python guide-match-profile/main.py

# 全量测试
python -m pytest guide-match-profile/tests -q
```

依赖：Python 3.11，仅标准库 + `numpy / pandas / scikit-learn / scipy / pytest`（本机已装，无需联网安装）。
本包实际只用到了 `pandas`（读写与聚合表格数据），其余库为环境约定。

---

## 3. 数据契约与字段

字段名与 CONTRACT 对齐；为满足距离打分与预约冲突检测，`guides.json` 追加了少量**包内扩展字段**
（不改契约字段名，集成时由数据层补填或回退默认值）：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `person_id / name / languages / rating / rating_count / service_point_ids / service_radius_m / service_hours / price / bio / available_slots / verified` | CONTRACT 4.4 | 按契约原样使用 |
| `location {longitude, latitude, coord_system}` | **扩展** | 讲解员当前位置，用于距离打分（契约未给讲解员坐标） |
| `capacity_per_slot` | **扩展** | 同一时段可接单数，默认 1（同一讲解员同一时间只能接一单） |
| `level / topics` | **扩展** | 评级档位与擅长话题，仅用于展示与理由 |
| `visitor_events.csv` 追加列 `guide_id` | **扩展** | `book_guide / book_confirmed` 事件关联讲解员，用于复约率与确认时长 |
| `visitor_events.csv` 事件类型 `book_confirmed` | **扩展** | 预约确认时刻，用于「平均确认时长」口径（CONTRACT 事件集未含确认） |

`points.json` 使用 `LD` 前缀（契约 4.1），与原型 `prototype-paper/data/points.js` 的 `CD-*` 点位是两套 ID，
集成时按名称/坐标建立映射即可（见 §9）。

---

## 4. 算法 A —— 讲解员多条件匹配（matching.py）

### 4.1 硬过滤（任一不满足即剔除，并给拒绝理由）

| 过滤 | 规则 |
| --- | --- |
| 语种 | 游客 `device_lang` 与 `requested_languages` 中每个语种都必须 ∈ 讲解员 `languages` |
| 服务范围 | 目标点位 ∈ `service_point_ids`，或讲解员到点位球面距离 ≤ `service_radius_m` |
| 当日在班 | 按日期星期分组（mon_fri/sat_sun）查 `service_hours`，该时段落在某班 [start,end) 内 |
| 预约时段 | `available_slots[date]` 含该时段，且该讲解员该时段未被占满（`capacity_per_slot`，默认 1） |

### 4.2 加权打分（权重写进 `config.py`，函数可传 `weights=` 覆盖）

| 子分 | 权重 | 公式（归一化到 0–1） |
| --- | --- | --- |
| 语种匹配 `language_match` | 0.22 | 设备语言 ∈ 请求语种 → 1.0（母语级）；否则 0.85（可服务） |
| 评级 `rating` | 0.20 | `rating / 5` |
| 距离 `distance` | 0.12 | 官方服务点位 → 1.0；否则 `1 − 距离/服务半径` |
| 时段契合 `slot_fit` | 0.10 | `0.7×命中 + 0.3×当日空闲时段占比` |
| 价格偏离 `price_deviation` | 0.08 | `1 − |price − 均价| / 均价`（奖励贴近均价） |
| 评价量与趋势 `review_trend` | 0.18 | `0.6×log 评价量 + 0.4×近30天趋势归一`，再 × 置信度 |
| 时段负载 `load_balance` | 0.10 | `1 − 当日已约时段 / 当日可约时段`（避免全推同一人） |

总分 `score = Σ 权重 × 子分`（0–1）。排序先按总分降序，同分按评级降序。

> 说明：同一时段冲突是**硬过滤**（同一讲解员同一时间只能接一单）；「负载」子分再对**当日整体负载**
> 做软惩罚，把预约分散到不同讲解员。趋势归一：`(趋势 + 1)/2`，趋势 = 近 30 天均分 − 历史均分，钳制 [−1,1]；
> 评价量按 `log1p(count)/log1p(100)` 饱和。

### 4.3 推荐理由

每条推荐给 1–3 条中文理由，例：
- `语种匹配：普通话、粤语`
- `评级 4.8，评价 126 条`
- `距目标点位 320 米（服务半径 800 米）` / `官方服务点位：堤东路骑楼（示例）`
- `该时段可预约（10:30）`、`价格 200 元，接近均价 210 元`、`近 30 天趋势上升 +0.13`

### 4.4 可用时段查询与冲突检测

`query_available_slots(date, time, …)` 返回该日期+时段可预约的讲解员与剩余名额
（`remaining = capacity − 已约单数`），`conflict=true` 表示该时段已满。
`build_bookings(events)` 从 `book_guide` 事件统计 `(讲解员, 日期, 时段)` 的已约单数。

### 4.5 改约候选

`reschedule_candidates(guide_id, date, time, …)` 在前后 `window_days`（默认 3 天）内枚举该讲解员
空闲可约时段，按「离原时段分钟差」升序返回前 5 个候选；**不实现完整改约/取消业务流程**（取消为建议项，非考核项）。

---

## 5. 算法 B —— 讲解员服务能力画像（profile.py）

### 5.1 评价聚合（`aggregate_reviews`）

从 `reviews.csv` 按 `person_id` 聚合：平均分、四维分（讲解准确度/表达/服务态度/准时）、
近 30 天均分 vs 历史均分（趋势）、评价量置信度。
评价数 `< 30`（`CONFIDENCE_MIN_COUNT`）时 `confidence = 评价数/30` 并标注 `sample_sufficient=false`（「样本不足」）。

### 5.2 时段供给画像（`slot_supply_profile`）

按 `(星期分组 × 时段)` 统计每位讲解员的可约供给量；全局统计每个时段可服务的讲解员数，
可服务人数 ≤ `SUPPLY_TIGHT_THRESHOLD`（默认 3）的时段进入「**供给紧张时段**」清单，供旺季/淡季调度参考。

### 5.3 服务能力综合分（`capability_score`，0–1）

```
raw = 0.35·(平均星级/5) + 0.25·(四维均分/5) + 0.20·(准时分/5) + 0.20·复约率
score = clamp(raw) × confidence
```

- 复约率 = 同一游客重复预约该讲解员的单数 / 该讲解员预约总单数（由 `book_guide` 事件统计）。
- 评价样本不足时整体按 `confidence` 降权，避免小样本误判。

---

## 6. 算法 C —— 游客兴趣画像（visitor_profile.py）

### 6.1 行为 → 兴趣 映射表（显式规则，权重可配置）

| 事件 | 兴趣来源 | 权重 |
| --- | --- | --- |
| `arrive_point` 到达点位 | 目标点位 `interest_tags` | 0.40 |
| `listen_guide` 听讲解 | 目标点位 `interest_tags` | 0.30 |
| `ask_question` 提问 | 目标点位 `interest_tags` | 0.20 |
| `adopt_route` 采纳路线 | 事件自带 `interest_tags` | 0.50 |
| `finish_route` 走完路线 | 事件自带 `interest_tags` | 0.40 |
| `view_route` 浏览路线 | 事件自带 `interest_tags` | 0.10 |
| `book_guide` 预约讲解 | 事件自带 `interest_tags` | 0.20 |
| `feedback` 反馈 | 事件自带 `interest_tags` | 0.10 |
| `view_parking` / `adopt_parking` | 无兴趣信号 | 0.00 |

规则示例：到访「历史建筑」点位 → `历史` +0.4×衰减、`建筑` +0.4×衰减；听了某类讲解 → 对应标签 +0.3×衰减。

### 6.2 增量更新

`update_profile(profile, event, …)` 每次并入一个事件：兴趣权重按**时间衰减** `0.5^(age_days/30)`（半衰期 30 天），
活跃时段按 2 小时分桶累加，常用语言按 `device_lang` 累加，`book_guide` 事件按讲解员价格更新消费偏好与价位档，
到达点位去重计数。

### 6.3 画像输出字段（`visitor_profile.json`，字段自定、写入 README）

```json
{
  "visitor_id": "V0001",
  "updated_at": "2026-11-22T10:00:00+08:00",
  "interest_tags": {"历史": 2.3, "摄影": 2.3, "非遗": 1.7},
  "active_hours": {"09-11": 3, "14-16": 2},
  "languages": {"普通话": 12},
  "price_preference": {"band": "250-400", "avg_booked_price": 320.0, "bookings": 1},
  "visited_points": 6,
  "total_events": 30
}
```

### 6.4 脱敏

输出不含姓名、手机号、身份证等可识别信息；`visitor_id` 保持匿名 `V\d{4,}` 格式。
`deidentify_ok(profile)` 提供自检（正则检测手机号/身份证 + PII 字段名 + visitor_id 格式），测试覆盖。

---

## 7. 算法 D —— 代理评估与指标计算（evaluation.py）

### 7.1 匹配效果代理评估

- **真值口径**：以合成行为中游客**实际预约的讲解员**为「显示偏好真值」，构造查询集（n=22，来自 22 条 `book_guide`）。
- **推荐口径**：预测时刻排除该游客自己的这条预约（还原下单前的可约状态），其余不变。
- **基线**：仅按评级降序 + 只做语种硬过滤（不做服务范围/在班/时段/负载约束）。

| 指标 | 结果 | 基线（仅评级） |
| --- | --- | --- |
| Top1 命中率 | **0.545** | 0.045 |
| Top3 覆盖率 | **0.864** | 0.182 |
| 语种硬过滤正确率 | **1.000** | — |
| 候选非空率 | 0.955 | — |

样本量 n=22，真值与样本均为合成数据，**不代表真实效果**。

### 7.2 预约使用率 / 平均确认时长（指标计算函数，不伪造达成）

- `booking_usage_rate(events)`：预约使用率 = 至少一次 `book_guide` 的去重游客数 / 去重游客总数。
  合成数据示例：22/60 = 0.3667。
- `avg_confirmation_minutes(events)`：平均确认时长 = `book_guide`（提交）到 `book_confirmed`（确认）的分钟差均值，
  同一 (visitor, guide) 按时间 FIFO 配对。合成数据示例：24.77 分钟（n=22）。

> **「在线预约使用率 ≥ 30%」「平均预约确认时长 ≤ 30 分钟」需线上真实埋点数据才能验收。**
> 上述合成结果为「示例计算」，不代表真实达成；接入真实 `visitor_events.csv` 后直接调用这两个函数即可复算。

---

## 8. 示例数据说明（真实性红线）

- 全部数据 `data_source=synthetic`、`verified=false`，由 `data/make_data.py` 生成，**固定随机种子 `20261122`**，可复现。
- 讲解员姓名用「讲解员A…X」中性写法；评价文本取自中性短句池，不含真实人物、真实评价或任何可识别信息。
- 点位坐标（江门长堤一带 WGS84 示意，约 113.08–113.09E / 22.57–22.58N）与评级、价格、时段均为示意，未经现场核实。
- 生成规则要点：24 位讲解员语种含 4 位无普通话者（用于语种硬过滤测试）；11 位评价数 <30（用于「样本不足」）；
  22 位游客 `book_guide` 且语种/时段/服务范围与讲解员一致（保证真值可复现）；确认时长为 5–45 分钟随机。

---

## 9. 局限、待核实清单、换成真实数据要改什么

**局限**
- 无真实讲解员/评价/行为数据，所有指标是合成数据的代理结果，不能作为上线验收依据。
- 距离按球面直线（haversine）估算，未接入实际路网；服务半径是示意值。
- 负载与复约率依赖 `visitor_events.csv` 埋点完整性；埋点缺失会低估负载。
- 改约只给候选时段，取消/改约的完整状态机不在本包范围。

**待核实清单**
- 点位坐标、名称、类别的现场核实；讲解员资料、评级、价格、可约时段的真实数据替换。
- 契约 `LD` 点位与原型 `CD-*` 点位的 ID 映射。

**换成真实数据要改什么**
- 直接替换 `data/` 四个文件（保持字段名与列名不变），重新运行 `main.py` 即产出真实指标。
- `config.py` 里的权重与阈值（半衰期、置信阈值、紧张阈值）按真实业务调优。
- 后端接入时把 `book_confirmed` 事件换成真实确认时间戳；`guide_id` 列由订单系统回填。

---

## 10. 与后端接口对接所需字段

**匹配请求（输入）**
```json
{"visitor_id": "V0001", "device_lang": "普通话", "requested_languages": ["普通话"],
 "target_point_id": "LD006", "date": "2026-11-22", "time": "10:30", "price_max": null}
```

**推荐输出（对齐契约 4.7 `guide_match_result.json`）**
```json
{"person_id": "PV008", "score": 0.8886, "reasons": ["语种匹配：普通话", "评级 4.8，评价 126 条", "距目标点位 461 米"],
 "language_match": true, "distance_m": 461, "slot": "2026-11-22T10:30:00+08:00"}
```

**依赖数据表**：`guides.json`、`points.json`、`reviews.csv`、`visitor_events.csv`（字段见 §3）。

**画像输出**：讲解员能力画像（§5）、游客画像 `visitor_profile.json`（§6.3）。

---

## 11. 验收结果汇总

| 验收项 | 结果 |
| --- | --- |
| `python guide-match-profile/main.py` 跑通 | ✅ 打印匹配（含理由）、能力画像、供给、冲突/改约、画像前后对比、代理指标 |
| `python -m pytest guide-match-profile/tests -q` 全绿 | ✅ 23 passed（覆盖语种硬过滤、时段冲突、评分排序、增量单调性、脱敏、代理指标） |
| `metrics.json` 含 Top1/Top3、基线对比、画像更新示例、指标函数说明 | ✅ |
| README 含权重表、规则、公式、局限、对接字段 | ✅ 本文件 |
| 只新增 `guide-match-profile/`，未改其它目录 | ✅ |

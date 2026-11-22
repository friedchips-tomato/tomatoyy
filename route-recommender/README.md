# route-recommender · 个性化路线推荐算法包

乐游蓬江 AI 智慧导览小程序（江门长堤风貌街）的路线推荐算法。结合**兴趣偏好 + 游览时间预算 +
步行距离 + 景点状态（开放时段/拥挤度）**生成**三条可比较的候选路线**，并在自驾场景下把停车场
作为起点、兼顾停车与返程。

- 数据契约：`C:/Users/17109/.orca/bots/bot-6/algo-specs/CONTRACT.md`（字段名、ID 规则、时间/坐标口径）
- 运行环境：Python 3.11，仅标准库（无需 numpy/pandas/scipy；算法为纯 Python，刻意保持零重依赖）

---

## 1. 接手时状态与本次改动

上一执行者在 Codex 配额耗尽前已完成大部分核心代码。接手时（2026-11-22）工作区状态：

| 文件 | 接手时 | 本次动作 |
| --- | --- | --- |
| `recommender.py` | 已有（路线搜索、候选构造、3 条路线选择、replan） | 修两处：`route_id` 由 39 位随机数改为顺序 `R0001…`；`distance` 路线由「1 个点」的退化结果改为「≥2 个点中步行最短」 |
| `scoring.py` / `schedule.py` / `parking.py` / `io_utils.py` | 已有且跑通 | 未改 |
| `data/points.json`（104 点）、`parking_lots.json`、`kg_relations.json`、`visitor_events.csv`、`visitor_profile.json` | 已有 | 未改 |
| `main.py` / `metrics.py` / `tests/` / `README.md` / `metrics.json` | **缺失** | 本次补齐 |

接手时先用 `python -m pytest route-recommender/tests -q` 与 `python route-recommender/main.py` 摸底：
前者无测试文件、后者无入口文件；核心模块 `recommender.py` 可独立 import 并跑出 3 条路线
（当时 `distance` 路线只有 1 个点、`route_id` 为 39 位随机数）。本次在其上续做，未重写可用部分。

---

## 2. 目录结构与快速开始

```
route-recommender/
  main.py            # 入口：完整示例（步行 + 自驾），打印 3 条路线并刷新 metrics.json
  recommender.py     # 核心算法：时间窗 orienteering 启发式、3 条路线选择、replan
  scoring.py         # 兴趣/拥挤/文化关联/多样性 打分与权重
  schedule.py        # 开放时段时间窗、Haversine、步行时长
  parking.py         # 停车场排序、费用、错峰建议
  io_utils.py        # JSON/CSV 读写、ID/字段校验
  metrics.py         # 离线评测：耗时 p50/p95、采纳率代理、长度分布、错峰建议代理
  data/              # 点位/停车场/画像/知识图谱关系/游客事件（均合成或待核实）
  tests/             # pytest（31 用例，全绿）
  metrics.json       # 跑出来的量化指标
```

```bash
# 完整示例 + 重算指标（约 15 秒）
python route-recommender/main.py

# 全量测试
python -m pytest route-recommender/tests -q

# 仅重算 metrics.json
python route-recommender/metrics.py
```

---

## 3. 输入 / 输出

输入为契约 §4.6 的 `route_request.json` 结构，示例：

```json
{
  "visitor_id": "V0001",
  "origin": {"longitude": 113.0890, "latitude": 22.5840},
  "start_time": "2026-11-22T09:00:00+08:00",
  "duration_minutes": 60,
  "interest_tags": ["历史", "美食"],
  "pace": "normal",
  "transport": "walk",
  "parking_id": null,
  "must_include_point_ids": [],
  "excluded_point_ids": [],
  "max_walk_minutes": null
}
```

- `duration_minutes ∈ {30, 60, 120}`，`pace ∈ {relaxed, normal, deep}`，`transport ∈ {walk, car}`。
- `transport=car` 时 `parking_id` 可为 `null`（算法自动选停车场）或指定某个 `PKxxx`。

输出为契约 §4.6 的 `route_result.json`：`algo_version / generated_ms / routes[]`，每条路线含
`route_id / side_focus / point_ids / order / straight_distance_meters / distance_meters /
walk_minutes / visit_minutes / total_minutes / parking_id / reasons[] / score`，并附加
`stops[]`（逐站到达/离开时刻）、`endpoint`（返程停车场或公交接驳点）。`side_focus` 恒为
`culture / distance / depth` 三条。

---

## 4. 算法要求逐条落实

### 4.1 兴趣匹配
`scoring.py` 计算每个点位的兴趣得分 `base[key]`：

```
base = w_interest · match + w_popularity · popularity − w_crowd · crowd_cost
match  = Σ preference(tag) / Σ preference       # 请求兴趣标签 + 画像学习的权重
popularity = mean(tag_heat(tag))                # 由 visitor_events 聚合的对数热度，归一化到 [0,1]
crowd_cost = {low:0, medium:0.20, high:0.75, unknown:0.20}
```

- **标签命中加权**：`interest_weights()` 把请求声明的标签（权重 1.0）与画像学习权重（`interest_weights`，×0.4 折合）叠加。
- **标签热度**：`tag_heat()` 按 `visitor_events` 的事件类型加权（`listen_guide`=2，`arrive_point/ask_question/finish_route`=1），再做 `log1p` 归一化。
- **类别多样性惩罚**：`Scoring.value()` 对路线加 `category_bonus·(类别数)`，再减 `repeated_category·(重复点位)`；`overlap_cost()` 用于让三条路线在点位集合与类别分布上都拉开差异，避免三条全是同一类点位。

### 4.2 时间预算约束
路线总时长 = 步行时间 + 各点位游览时长，**必须 ≤ `duration_minutes`**，超预算直接裁剪（不硬塞）：

```
单点停留 dwell = visit_minutes × PACE_FACTOR[pace]     # relaxed 1.15 / normal 1.0 / deep 1.45
步行时间 = 直线距离 × detour_factor / walking_m_per_min（75 m/min）
```

每条候选路线在构造与局部改进的每一步都通过 `RouteSearch.evaluate()` 校验「预算 + 开放时间窗 +
最大步行上限」，不满足即丢弃（`None`），保证输出永不违反预算。

### 4.3 步行距离计算
- 两点间用 **Haversine** 大圆距离（`schedule.haversine`，地球半径 6371008.8 m）得到**直线距离**；
- **估算步行距离** = 直线距离 × 绕行系数 `detour_factor`（默认 **1.3**，可调）；
- 输出同时给出 `straight_distance_meters`（直线）与 `distance_meters`（估算步行）两个值；
- `transport=car` 时以 `parking_id` 的坐标为起点计算首段步行，末段再走回停车场（`endpoint` 为 `return_to_parking`）。

### 4.4 路线构造算法（难点）
采用**带时间窗约束的有向 orienteering / TSP 启发式**：**cheapest-insertion + Or-opt 局部改进**，
并以**贪心最近邻**作为基线对比策略。每条点位带开放时间窗与停留时长，插入/改序每一步都做时间窗
可行性校验。

伪代码：

```
function plan(request):
    build feasibility:  for each point -> opening_windows, dwell = visit_minutes × pace
                        exclude closed points / parking category / transit-only nodes
    seeds = required_seeds(must_include)   # 束搜索把必去点排进可行前缀
    pool  = {}
    for each seed, focus in {culture, depth}:
        shortlist = rank feasible points by (value per unit time + leg)  # 候选池限制 candidate_limit
        tour = cheapest_insertion(seed, shortlist, focus)               # 见下
        tour = or_opt(tour, focus)                                      # 局部改进
        pool[tour] = tour
    candidates = pool.values() ∪ nearest_neighbor(seeds)   # 基线策略
    return select_three(candidates)                          # culture / distance / depth

function cheapest_insertion(seed, shortlist, focus):
    tour = seed
    loop:
        best = argmax over (point, position) of
                 [ value(tour + point) − value(tour) + (3 if focus==depth else 0) ] / Δtime
        if best gain <= 0 and focus == culture: break
        tour = best;  if no feasible insertion: break
    return tour

function or_opt(tour, focus):
    repeat local_passes times:
        best = tour
        for each single stop moved to any other position:
            candidate = evaluate(new order)      # full time-window + budget check
            if value(candidate, focus) > value(best, focus): best = candidate
        if best == tour: break
    return best
```

**复杂度**：预计算成对 Haversine 距离 O(N²)（N≈106，约 11k 次）；单条路线 cheapest-insertion
O(m·L²)（m=候选池、L=路线长度），Or-opt O(passes·L²)；三条侧重点 × 3 个起始方案，均受
`candidate_limit=24`、`starts_per_focus=3`、`local_passes=2` 上界约束。100+ 点位规模下单次生成
实测 p50 ≈ 28 ms（见 §7），远低于 3 秒目标。

### 4.5 三条候选路线
`select()` 从候选池挑出**互不相同**的三条：

| side_focus | 目标 | 实现 |
| --- | --- | --- |
| `culture` | 文化关联优先 | 文化类目（历史建筑/文化场馆/非遗业态）加权，`kg_relations` 有向边对相邻点位做文化关联加分（`cultural_link`） |
| `distance` | 步行最短 | ≥2 个点中总步行最短（避免退化成 1 个点） |
| `depth` | 打卡最多、内容最丰富 | 点位数量最多，且与已选路线在点位集合/类别上做 `overlap_cost` 惩罚拉开差异 |

### 4.6 推荐理由
每条路线生成 2–4 条中文理由，例：
- 「优先串联文化点位和主题」「匹配兴趣：历史、美食」
- 「预计 59.16 分钟，游览预算 60 分钟」「步行较少，估算约 24 米」
- 自驾加「已预留步行返回停车场取车的时间」，公交加「末站接驳公交点，接驳步行已计入预算」。

### 4.7 景点状态约束
- `opening_hours`：`opening_windows()` 把工作日/周末开放时段 + `closed_days`（星期或具体日期）
  展开成相对出发时刻的分钟时间窗（含跨天与隔夜营业），闭馆日/闭馆时段排除。
- `crowd_level`：`high` 减 0.75、`medium`/`unknown` 减 0.20、`low` 不减——拥挤点位降权而非硬排除。

### 4.8 断点续游 / 动态调整
- `save_progress(request, route, completed_point_ids, elapsed_minutes, walk_minutes_used, saved_at)`
  返回 `progress` 快照：剩余点位、已完成点位、已用时间/步行、停车场、保存时刻。
- `replan(current_point_id, current_location, progress, now, next_point_id=None)` 从当前位置重算
  剩余路线：剩余预算 = `duration − elapsed`，剩余步行上限 = `max_walk − walk_used`，已完成点位转为
  排除、剩余点位作为偏好（`preferred`）优先保留；自驾沿用原停车场，预算不足时返回 `return_unavailable`。

### 4.9 性能
`time.perf_counter` 实测，50 次重复，结果写入 `metrics.json`（p50/p95/max，见 §7）。

### 4.10 采纳率代理指标
无真实线上数据，采用**构造仿真评测集**（`metrics.build_eval_requests`，固定随机种子 42，N=160，
walk 出行）：为每位合成游客生成 3 条候选路线与 3 条基线（纯距离最近邻）路线，用同一效用函数判定
「采纳」。**口径**：任意一条候选路线含 **≥2 个命中游客兴趣标签的点位**即视为采纳。本算法与基线
使用**同一评测集、同一口径**，结果见 §7。非挑样本凑指标：样本量、种子、口径全部固定并写入 JSON。

### 4.11 停车场联动
- 排序：`parking.rank()` 按「可用车位（有预测用 `predicted_free_spaces`，无预测用 `total_spaces`
  静态值并标注 `availability_source=static_capacity`）× 距离 × 费用」打分排序，只保留营业且有余位的。
- 起点/返程：`transport=car` 时把停车场作为起点计算首段步行，末段回停车场取车计入预算。
- 错峰建议：`parking.advice()` 结合时刻高峰规律（周末 10–12/14–17、工作日 11–13/17–19），有预测时
  按「预测余位增益 ≥ 15%」、无预测时按「当前高峰 → 稍晚非高峰」给 `suggested_start_time`。
- 错峰建议采纳率**代理口径**（真实采纳需埋点）：以 `adopt_parking` 事件 `ts` 与 `suggested_start_time`
  偏差 ≤ 30 分钟计为采纳，分母为「收到错峰建议的自驾请求数」。本包无埋点，仅报**建议覆盖率**代理
  （见 §7），真实口径与要改的数据见 §9。

---

## 5. 参数表

`RouteSettings`（`recommender.py`，构造 `RouteRecommender(..., settings=...)` 可覆盖）：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `detour_factor` | 1.3 | 直线→步行绕行系数 |
| `walking_m_per_min` | 75 | 步行速度 m/min |
| `candidate_limit` | 24 | 每侧重点的候选池上限 |
| `starts_per_focus` | 3 | 每个侧重点的起始方案数 |
| `local_passes` | 2 | Or-opt 局部改进轮数 |
| `required_beam_width` | 16 | 必去点束搜索束宽 |
| `transit_max_walk_m` | 350 | 公交接驳点最大接驳步行 |

`scoring.Weights`：`interest=1.85, popularity=0.30, crowd=1.0, category_bonus=0.30,
repeated_category=0.16, route_overlap=0.55, category_overlap=0.30, culture_category=1.25,
culture_link=1.35`。

`pace` 停留系数：`relaxed=1.15 / normal=1.0 / deep=1.45`。

`parking.ParkingSettings`：`distance_scale_m=400, fee_scale_yuan=10,
forecast_tolerance_minutes=30, forecast_gain_ratio=0.15, advice_horizon_minutes=180`。

---

## 6. 数据与真实性

- `data/points.json`：**104 个点位**。其中 10 个来自 `prototype-paper/data/points.js`
  （蓬江大桥/启明里/海关旧址/博物馆分馆/水埠头/堤东路骑楼/新市路/墟顶老街/沿江停车场/江门铁桥），
  1 个来自 `docs/像素地图方案清单.md §2.1`（钓台路公交站）。**占位数据 93 条**，用于 100 点位规模
  压测，命名「压测占位 · <类别> NN」，需真实数据替换。
- 所有点位 `verified: false`：坐标（WGS84 近似）、开放时段、历史描述均**未现场核实**，不编造史实；
  有出处者已在 `sources` / `data_source` 标注。
- `data/parking_lots.json`：2 个停车场（PK001/PK002），`data_source=synthetic`。
- `data/visitor_events.csv`：64 条合成事件（`arrive_point/listen_guide/ask_question`，32 位匿名游客），
  仅用于标签热度聚合；**不含 `view_route/adopt_route`**，故采纳率采用仿真评测集（§4.10）。
- `data/kg_relations.json`：4 条有向关系，来自 points.js 的 ST01 演示故事线，`verified: false`。

---

## 7. 验收结果（`metrics.json`，可复现）

| 指标 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 路线生成时间（50 次） | ≤ 3000 ms | p50 27.9 ms / p95 32.9 ms / max 38.5 ms | ✅ |
| 采纳率代理（N=160） | ≥ 40% | 本算法 93.8%，基线最近邻 64.4% | ✅ 优于基线 |
| 路线长度分布 | — | 480 条路线，打卡点均值 4.6（中位 3），步行均值 831 m | ✅ |

- 采纳率口径：任意候选路线含 ≥2 个命中兴趣点位即采纳；本算法最优命中 4.55 个 / 基线 2.45 个。
- 错峰建议代理：高峰时段自驾请求 24 例，建议覆盖率 100%（无预测余位，按时刻高峰规律给出；
  真实采纳率需埋点，见 §4.11）。
- `metrics.json` 中所有口径、样本量、随机种子均写死，`python route-recommender/main.py` 可重算复现。

---

## 8. 局限

- **无真实路网**：步行距离是 Haversine × 1.3 的估算，非真实街道路径；绕行系数为经验值。
- **无真实人流/天气/活动**：`crowd_level` 为静态标定值，不随时间变化。
- **开放时段为合成标定**：真实闭馆日/时段到位前，时间窗约束只在合成数据上验证。
- **采纳率为代理指标**：无线上埋点，采用仿真评测集的离线代理，不代表真实点击/采纳。
- **兴趣画像仅单条示例**：多游客画像的行为学习权重仅示例级，未做真实行为建模。
- 算法为启发式（cheapest-insertion + Or-opt），非全局最优 orienteering；不保证最优解。

---

## 9. 接入真实数据要改什么

1. **点位表**：用真实点位替换 `data/points.json`，保持字段名与契约 §4.1 一致（`point_id/longitude/
   latitude/coord_system/opening_hours/visit_minutes/interest_tags/style_tags/crowd_level/...`），
   把 `verified` 改为 `true` 并填 `sources`。算法零改动即可消费。
2. **停车场**：替换 `data/parking_lots.json`（真实容量/费用/坐标）；接入 `parking_forecasts`
   （契约 §4.8 的 `forecast[]`）后 `RouteRecommender(..., parking_forecasts=...)` 自动改用预测余位，
   错峰建议从「时刻规律」升级为「预测余位增益」。
3. **游客画像**：后端按游客历史行为回填 `interest_weights`，替换 `visitor_profile.json`。
4. **采纳率**：埋点接入 `view_route/adopt_route/adopt_parking` 事件后，用真实口径
   `adopt_route 数 / view_route 数`（或 `adopt_parking` 按建议时间到达占比）替换 §4.10/§4.11 的代理口径。
5. **知识图谱**：真实图谱以 §4.9 的 `algo_kg_entities / algo_kg_relations` 视图导出，替换
   `data/kg_relations.json` 的示例边（字段映射在 `recommender.RouteRecommender` 的 kg 边校验处，
   只换数据、不改算法）。

---

## 10. 测试覆盖

`tests/`（31 用例，全绿）覆盖：时间预算不被违反、闭馆点被排除、三条路线差异、必去点被包含、
排除点不出现、冲突请求、ID 唯一性与前缀、距离字段自洽、理由数量、car 停车场起点/返程/排序、
显式停车场、walk 拒绝停车场、save_progress/replan 及校验、性能 ≤3000 ms、p50/p95、仿真集确定性、
采纳率优于基线、长度分布、run_all 关键字段。

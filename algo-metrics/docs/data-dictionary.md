# 数据字典（字段级 · 视图层口径）

> **文件**：`algo-metrics/docs/data-dictionary.md`
> **版本**：v1.0（2026-11-27） · **归属**：任务 M4 · **契约**：`CONTRACT v1`（含 §4.9 数据库视图契约与 §7 决策记录）
> **配套**：`algo-metrics/docs/metrics-definition.md`（指标口径书）、`algo-metrics/registry.py`（机器可读口径）

## 0. 本文件的边界（先读这段）

1. 本文件**只登记「视图层」的字段口径**，按**视图名**组织，供指标口径书与各算法包对齐取数。
2. 本文件**不定义表结构**：基表怎么建、索引怎么建、约束怎么写，是数据底座包（数据库设计指挥）的职责。
   本文件只写「指标要从哪个视图的哪个字段取数、该字段什么含义、什么口径下算」。
3. **凡是本文件没能从仓库里找到权威定义的视图或字段，一律标
   `TODO: 与 DDL 对齐（负责人：数据库设计指挥）`，不猜、不臆造、不自行定表结构。**
4. 本文件**不改动任何指标口径**：公式、分子分母、剔除规则、目标值一律以
   `metrics-definition.md` 为准；本文件只回答「这些字段从哪来」。
5. **数据状态**：本阶段所有指标数值都来自**合成/示意数据**（`data_source=synthetic`、`verified=false`），
   **不代表真实达成**；需求方书面确认放在上线阶段。

## 1. 视图清单与状态

| 视图名 | 归属 | 本阶段状态 | 权威定义出处 | 用到它的指标 |
| --- | --- | --- | --- | --- |
| `algo_parking_history` | 停车时序 | **已定义**（分支未合主线） | `friedchips-tomato/parking-db`：`changdi-intake/server/migrations/015-guide-parking.sql` | `parking_mae_ratio_1h` / `parking_mae_spaces_1h` / `parking_mae_pp_1h` |
| `algo_parking_lots` | 车场静态 | **已定义**（分支未合主线） | 同上 | `parking_mae_*`（`total_spaces` 回落来源） |
| `ml_parking_lots` | 车场静态（ML 兼容） | **已定义**（分支未合主线） | 同上 + `parking-forecast/schemas/lot.schema.json` | parking-forecast 包 |
| `ml_parking_observations` | 余位观测（ML 兼容） | **已定义**（分支未合主线） | 同上 + `parking-forecast/schemas/observation.schema.json` | parking-forecast 包 |
| `algo_points` | 点位总表 | **已定义**（分支未合主线） | `friedchips-tomato/guide-db-content`：`changdi-intake/docs/db-design-guide-content.md` §6.2 | 点位/讲解相关指标（暂无直接取数字的指标） |
| `algo_kg_entities` | 知识图谱实体 | **已定义**（分支未合主线） | `algo/kg-recommend`：`kg-recommend/schemas/kg.schema.json` | `kg_recommendation_ctr`（待包交付） |
| `algo_kg_relations` | 知识图谱关系 | **已定义**（分支未合主线） | 同上 | `kg_recommendation_ctr`（待包交付） |
| `algo_visitor_events` | 游客事件流 | **待定义** | 仓库内暂无 DDL | `route_adoption_rate` / `parking_offpeak_adoption_rate` / `booking_usage_rate` |
| `algo_guides` | 讲解内容 | **待定义** | 仓库内暂无 DDL | `voice_naturalness_mos` / `guide_point_match_accuracy` |

> **「已定义（分支未合主线）」** 的含义：视图的 SQL 定义已存在于对应分支，
> 但该分支**尚未合并进 `feature/intake-public-submission`**；
> 合并前这些视图在主线库里不存在，指标只能跑合成评测集。

---

## 2. `algo_parking_history`（停车余位历史 · 口径书 §2.8）

**用途**：停车 MAE 的唯一取数来源（口径书 §2.8.5）。

| 字段 | 类型 | 口径 | 说明 |
| --- | --- | --- | --- |
| `parking_id` | TEXT | 车场标识 | `PK` + 3 位数字；基表主键，视图原样输出 |
| `ts` | TEXT | 观测时刻（`+08:00`） | 库内存 UTC（带毫秒），**视图层转北京时间到秒** |
| `occupied_spaces` | INTEGER\|NULL | 占用车位数 | `total_spaces − free_spaces`；任一输入缺失则为 NULL（**不补零**） |
| `free_spaces` | INTEGER\|NULL | 当前余位 | NULL = 缺失，**不是 0** |
| `total_spaces` | INTEGER | 总车位数 | 分母优先取观测快照，缺失时回落到车场静态表 |
| `weekday` | INTEGER | 星期（0=周日） | 按北京时间计算 |
| `is_holiday` | 0/1 | 节假日标记 | 来自 `parking_signals` 的 `calendar` 类信号 |
| `weather` | TEXT | 天气 | 来自 `parking_signals` 的 `weather` 类信号；无信号为 NULL |
| `event_flag` | 0/1\|NULL | 活动标记 | 已知活动只在半开窗口 `[signal_at, signal_at+2h)` 内计 1；未知为 NULL |
| `data_source` | TEXT | 来源渠道 | `synthetic` / `sensor` / `manual` / `api` |

### 2.1 与口径书 §2.8.5/§2.8.6 的差异（**必须闭环**）

口径书 §2.8.5 要求本视图带 `quality`（`ok/stale/suspect/missing`）、`age_seconds`、
`source`、`evidence`；§2.8.6 的剔除规则（「**MAE 只在 `quality='ok'` 的桶上计算**」）
直接依赖 `quality`。但当前 DDL 里 `algo_parking_history` **没有输出 `quality` / `age_seconds`**
（这两列在基表 `parking_observations` 上，视图未透出），`source` 视图里叫 `data_source`，
`evidence` 未输出。

**结论**：口径书的**剔除规则不变**（仍以 `quality='ok'` 为准），缺的是视图层透出该字段。
→ **TODO: 与 DDL 对齐（负责人：数据库设计指挥）**
（在 `algo_parking_history` 视图补 `quality`、`age_seconds`、`evidence`；
`data_source` 与 `source` 的命名统一以契约为准。）

> 在对齐落地前，合成评测集用**文件里的 `quality` 列**跑同一套剔除规则（见 §4），
> 真实数据接入时只换数据文件、不改口径。

## 3. `algo_parking_lots`（车场静态）

| 字段 | 类型 | 口径 |
| --- | --- | --- |
| `parking_id` | TEXT | 车场标识（`PK` + 3 位数字） |
| `name` | TEXT | 展示名 |
| `longitude` / `latitude` | REAL\|NULL | 真实坐标占位；**未核坐标留空**，`verified=0` |
| `coord_system` | TEXT | 坐标系（视图转大写）：`CGCS2000` / `WGS84` / `GCJ-02` / `BD-09` |
| `total_spaces` | INTEGER\|NULL | 总车位数（正整数；未知留空，**不用 0 顶替**） |
| `fee_rule` | JSON | 费用规则文本对象（`text` / `first_hour` / `after_hour` / `daily_cap`） |
| `open_hours` | TEXT\|NULL | 开放时间；未知为 NULL |
| `point_id` | TEXT\|NULL | 最近点位（软引用，无外键） |
| `data_source` | TEXT | 来源渠道 |
| `verified` | JSON 布尔 | 是否已人工核验（`0/1` → `true`/`false`） |

## 4. `ml_parking_lots` / `ml_parking_observations`（ML 兼容视图）

`ml_*` 是**算法侧兼容视图**：字段与 `parking-forecast` 包的
`schemas/lot.schema.json`、`schemas/observation.schema.json` **一一对应**，
接入真实停车数据时由这两个视图导出 JSONL 供运行时读取。

| `ml_parking_lots` 字段 | 口径 | | `ml_parking_observations` 字段 | 口径 |
| --- | --- | --- | --- | --- |
| `lot_id` | 目录代码（= 基表 `parking_id`） | | `lot_id` | 外键 → `ml_parking_lots.lot_id` |
| `name` | 展示名 | | `ts` | 观测时刻（`+08:00`，秒级） |
| `total_spaces` | 总车位数（正整数） | | `free_spaces` | 当前余位；**NULL = 缺失，不是 0** |
| `fee` | 费用结构对象 | | `total_spaces` | 当时总位快照；NULL 时回落到静态表 |
| `access` | 进出限制对象 | | `source` | `synthetic` / `sensor` / `manual` / `api` |
| `geometry` | `{lat, lon}`；现阶段为 null，**不得编造经纬度** | | `quality` | `ok` / `stale` / `suspect` / `missing` |
| `walk_to_street` | `{meters, minutes}`（估算需标注） | | `age_seconds` | 数据年龄；`stale` 时必填（过期判定的唯一依据） |
| `district` | 归属街区/片区 | | `ingested_at` | 入库时刻（UTC），真实数据接入后用于重算 |
| `source` | `synthetic` / `manual` / `api` / `camera` | | | |
| `notes` | 备注 | | | |

> `ml_parking_current`（每车场最新余位）与 `ml_parking_forecast`、`algo_parking_coverage`
> 等其余视图不在指标取数范围内，本文件不登记。

## 5. `algo_points`（点位总表）

| 字段 | 口径 |
| --- | --- |
| `point_id` | 点位标识（`LD` + 3 位数字） |
| `name` | 中文名 |
| `category` | 类别（8 类直出，扩展类映射到 8 类） |
| `longitude` / `latitude` | 坐标（基表 `lng`/`lat` 改名） |
| `coord_system` | 坐标系标签：`WGS84` / `CGCS2000` / `GCJ-02` / `BD-09` / `PIXEL_LOCAL` |
| `opening_hours` | 开放时间（JSON 对象，NULL → `null`） |
| `visit_minutes` | 建议参观时长 |
| `interest_tags` / `style_tags` | 兴趣标签 / 风格标签（JSON 数组） |
| `crowd_level` | 拥挤度 |
| `description` | 描述 |
| `data_source` | 数据来源 |
| `verified` | 是否已核验（`0/1` → JSON 布尔） |
| `history_id` | **视图层派生**：该点位的史料 id 列表 |
| `kg_id` | **视图层派生**：代表实体（`role='anchor'`） |
| `guide_content_id` | **视图层派生**：已审讲解内容 id |
| `image_refs` | **视图层派生**：素材 uri 数组 |

## 6. `algo_kg_entities` / `algo_kg_relations`（知识图谱）

**`algo_kg_entities`**（每条实体）：`entity_id`（`KG` + ≥3 位数字）、`entity_type`
（`building`/`person`/`event`/`artifact`/`craft`/`merchant`/`place`/`institution`/`period`）、
`name`、`point_id`（可空）、`tags`、`summary`（可空）、`attributes`、`sources`（史料 id 数组）、
`verified`（0/1）。

**`algo_kg_relations`**（每条关系）：`relation_id`、`src_id`、`dst_id`（有向边 src→dst）、
`relation_type`（`built_by`/`located_in`/`participated_in`/`heritage_of`/`owned_by`/
`named_after`/`related_to`/`succeeded`）、`weight`（0..1）、`sources`（史料 id 数组）、`verified`（0/1）。

## 7. `algo_visitor_events`（游客事件流）—— **待定义**

口径书与注册表引用了这个视图（`route_adoption_rate`、`parking_offpeak_adoption_rate`、
`booking_usage_rate` 都从它取数），但**仓库里目前没有它的 DDL**。指标侧已经固定的字段口径：

| 字段 | 口径 | 来源 |
| --- | --- | --- |
| `visitor_id` | 匿名访客标识（比例型指标按它去重） | 口径书 §0.3 |
| `ts` | 事件时刻（`+08:00`） | 口径书 §0.3 |
| `event_type` | 事件类型（枚举见下） | 口径书 §2.2/§2.6/§2.9 |
| `point_id` | 点位（缺失留空，**不填 0**） | 评测集与口径书 |
| `route_id` | 路线（缺失留空） | 口径书 §2.2 |
| `dwell_seconds` | 停留时长（缺失留空） | 口径书 §0.3 |
| `interest_tags` | 兴趣标签 | 评测集 |
| `device_lang` | 设备语言 | 评测集 |
| `data_source` | `synthetic` / `real` | 口径书 §0.3 |

**当前 `event_type` 枚举**（评测集与口径书一致）：
`view_route`、`adopt_route`、`finish_route`、`arrive_point`、`listen_guide`、`ask_question`、
`view_parking`、`adopt_parking`、`book_guide`、`feedback`。

**待补的枚举（指标已依赖，契约尚未收录）**：

| 事件类型 | 谁要用 | 状态 |
| --- | --- | --- |
| `impress_kg` / `click_kg` | `kg_recommendation_ctr` 的分子/分母 | **TODO: 契约增补**（口径书 §2.3） |
| `view_booking` | `booking_usage_rate` 的分母 | **TODO: 契约增补**（口径书 §2.6） |
| 「含错峰建议」的曝光标记 | `parking_offpeak_adoption_rate` 的分母筛选 | **TODO: 契约增补**（口径书 §2.9） |

→ 视图整体字段清单：**TODO: 与 DDL 对齐（负责人：数据库设计指挥）**

## 8. `algo_guides`（讲解内容）—— **待定义**

口径书 §2.4/§2.5 的数据源写的是「MOS 问卷与评分表」「讲解抽检标注集」，
指标侧需要能定位到「播放点位 / 讲解内容 / 抽检标签 / 评分」四类信息。
仓库里目前没有 `algo_guides` 的 DDL。

→ **TODO: 与 DDL 对齐（负责人：数据库设计指挥）**
（需要澄清：`algo_guides` 是否同时承载「讲解内容」与「讲解员排班」，
以及 `guide_point_match_accuracy` 的抽检标注是落在视图里还是独立的标注表。）

## 9. 评测集与视图的对应（`algo-metrics/datasets/`）

评测集是**按视图口径导出的文件**，字段 = 视图字段 + **评测扩展列**。
扩展列只存在于评测文件，**不在视图契约里**：

| 评测集文件 | 对应视图 | 视图字段 | 评测扩展列（不在契约内） |
| --- | --- | --- | --- |
| `parking_observations_sample.csv` | `algo_parking_history` + `algo_parking_lots` | `parking_id`、`ts`、`occupied_spaces`、`free_spaces`、`total_spaces`、`weekday`、`is_holiday`、`weather`、`event_flag`、`data_source` | `quality`、`age_seconds`、`predicted_free_spaces`、`horizon_min`、`split` |
| `visitor_events_sample.csv` | `algo_visitor_events` | `visitor_id`、`ts`、`event_type`、`point_id`、`route_id`、`dwell_seconds`、`interest_tags`、`device_lang`、`data_source` | —（无扩展列；`data_source` 是口径书 §0.3 要求的数据来源标注位） |
| `route_impressions_sample.csv` | 曝光明细（**线上需新增**，口径书 §2.2 离线代理口径） | `impression_id`、`visitor_id`、`ts`、`algo_version`、`side_focus`、`shown_point_ids`、`adopted`、`dwell_seconds`、`data_source` | 曝光明细表本身尚未进入视图契约 → **TODO: 契约增补** |

- `quality` / `age_seconds` 与基表 `parking_observations` 同名同义（见 §2.1 的 TODO）；
- `predicted_free_spaces` 来自 parking-forecast 包的回测输出（对应 CONTRACT §4.8
  `parking_forecast.json` 的 `forecast[].predicted_free_spaces`），**不是数据库字段**；
- `split`（`warmup` / `eval`）是评测集的分段标记，只服务于口径书 §2.8.6 的评估窗口；
- 三个文件的 seed、行数与 sha256 记录在 `datasets/manifest.json`，
  **全部为合成/示意数据，不代表真实达成**。

## 10. 更新频率与责任人

| 视图 | 更新频率 | 责任人 |
| --- | --- | --- |
| `algo_parking_history` | 观测写入即更新（30 分钟粒度为评测集口径；线上按采集频率） | 数据库设计指挥（DDL）/ 停车数据责任人（供给） |
| `algo_parking_lots` / `ml_parking_lots` | 变更时更新（含 `updated_at`） | 数据库设计指挥 |
| `ml_parking_observations` | 观测写入即更新 | 数据库设计指挥 |
| `algo_points` | 变更时更新（含审核发布流程） | 数据库设计指挥 / 内容审核责任人 |
| `algo_kg_entities` / `algo_kg_relations` | 变更时更新（带 `sources` 溯源） | 数据库设计指挥 / 图谱内容责任人 |
| `algo_visitor_events` | **待定** | **TODO: 与 DDL 对齐（负责人：数据库设计指挥）** |
| `algo_guides` | **待定** | **TODO: 与 DDL 对齐（负责人：数据库设计指挥）** |

> 「更新频率」在视图未落地前无法从 DDL 确认的，一律标 TODO，**不臆造 SLA**。

# kg-recommend · 知识图谱语义关联推荐 + 历史故事线生成 + 史实一致性校验

> 任务 K2 交付物。乐游蓬江 AI 智慧导览小程序（江门长堤风貌街文旅导览）——知识图谱算法层：
> 消费约定格式的图谱三元组（entities + relations），产出**语义关联推荐**、**历史故事线**与**史实一致性校验报告**。
> 图谱内容与表结构由数据库设计侧负责，本包只做算法，**换数据文件即切换真实图谱**。

## 0. 接手状态（2026-11-22 重启说明）

本包由上一任执行者开工后因模型配额中断，接手时工作区状态：

- 已有可用（经修复后保留）：`graph.py`、`similarity.py`、`recommend.py`、`storyline.py`、
  `consistency.py`、`chronology.py`、`evaluation.py`、`main.py`、`data/kg_sample.json`（24 实体 / 49 关系，英文枚举码，符合 CONTRACT §4.9）。
- 半成品/缺失：`tests/` 与 `schemas/` 为**空目录**；无 README；`main.py` 因 `chronology.py` 的正则缺陷（`SINGLE_DATE` 切片越界，`Match.__getitem__` 越组）一启动就崩溃。
- 本次续做修复：① `chronology.parse_period` 越界 bug + 补回「纯年份→整年区间」逻辑、支持「2001年5月」；
  ② `_check_time` 只用故事节点建年代表导致文案引用的年代矛盾漏检 → 改为全图有年代实体；
  ③ `HttpLLMChecker` 网络异常捕获缺 `OSError`，内建 `ConnectionError` 会击穿降级；
  ④ `recommend` 对不存在的实体抛 `KeyError` 而非带中文信息的 `ValueError`；
  ⑤ 实体 `sources` 未登记进 `history_ids`（引用完整性校验会误报）；
  ⑥ `verified` 契约为 0/1，加载器现在同时接受 false/true 并归一化；
  ⑦ 故事线 beam 排序把「分数略高的 4 点」排在「完整 5 点」之前 → 改为长度优先。
- 补齐：`tests/`（73 项，全绿）、`schemas/kg.schema.json`、本 README、`output/` 产出文件与 `metrics.json`。

## 1. 运行

```bash
python kg-recommend/main.py                      # 完整流水线：推荐→故事线→校验→代理指标
python -m pytest kg-recommend/tests -q           # 73 passed
python kg-recommend/main.py --llm               # 规则层之后追加 LLM 校验（可选）
python kg-recommend/main.py --building KG002 --length 5 --theme 贸易
```

`main.py` 打印关联推荐（含中文理由与关系路径）、一条 5 点故事线（含 `connector_text` 叙事）、
一致性校验报告（示例数据下命中 ≥ 1 条 warn，证明校验器在工作）、点击率代理指标对比，
并把结果写入 `output/`：`kg_recommend_result.json`、`storyline.json`、`consistency_report.json`、
`metrics.json`、`visitor_events_semantic.csv`、`visitor_events_tag_popularity.csv`。

依赖：Python 3.11 标准库 + `requests`（仅 `HttpLLMChecker` 用到）。numpy/pandas 等未使用。

## 2. 图谱输入契约（消费方定义）

`data/kg_sample.json` 为自带最小可跑示例（**≥ 20 实体 / ≥ 40 关系**，实际 24/49；
`source: "sample"`、`verified: 0`、内容全部为示意条目，**非史实**）。真实图谱到位后只替换该文件，不改算法。

- 消费 CONTRACT §4.9 冻结的数据库视图 `algo_kg_entities` / `algo_kg_relations`（英文枚举码）：
  - `entity_type` ∈ `building / person / event / artifact / craft / merchant / place / institution / period`
  - `relation_type` ∈ `built_by / located_in / participated_in / heritage_of / owned_by / named_after / related_to / succeeded`
- ID 规则：实体 `KG###`，关系 `R###`，史料 `HIS###`，点位 `LD###`；`sources` 必须是 HIS 数组（关系至少 1 条来源）。
- `weight` ∈ [0,1] 为关系置信度；`verified` 用 0/1（加载器兼容 false/true）。
- 顶层可加 `history_ids`（在册史料全集）；缺省时从各 records 的 `sources` 汇集。
- 日期字段识别集（`attributes` 内按序探测，见 `chronology.TIME_FIELDS`）：
  `时间 / 发生时间 / 年代 / 年份 / 建成年代 / 建成时间 / 建造时间 / 修复时间 / year / date / time / event_date / built_year`。
  支持 `2001`、`"2001年"`、`"2001年5月"`、`"2001-05-06"`、`"1990年代"`、`"1990-2000"`、`{"start":…,"end":…}`、
  带 `+08:00` 时区的 ISO 时间戳；解析不了就当作无年代（`None`），**不猜**。

结构定义见 `schemas/kg.schema.json`（含输入图谱与三类输出的 JSON Schema）。

## 3. 算法说明

### 3.1 语义关联推荐（`recommend.py` + `similarity.py`）

给定建筑或人物实体，枚举其 1 跳与 2 跳简单路径（双向遍历，`Step.reversed` 记录是否反向），
按目标类型分组（building / person / event / cultural_resource，其中 artifact 与 craft 归入文化资源），
每组取前 `per_type` 个，再全局按分排序。

**打分公式**（`similarity.relatedness`）：

```
score = 0.35 × Jaccard(标签集) + 0.25 × s/(1+s) + 0.40 × path_strength
```

- `Jaccard(A,B) = |tags_A ∩ tags_B| / |tags_A ∪ tags_B|`（共同主题标签）；
- `s` = 2 跳共享邻居数（不同中间实体个数），`s/(1+s)` 做饱和压缩；
- `path_strength` = 最强路径强度：`edge_strength = weight × relation_weight`
  （`weight` 是数据自带置信度，`relation_weight` 是关系类型先验，`built_by` 1.0 … `related_to` 0.5，见 `graph.RELATION_TYPES`），
  路径强度 = `0.75^(跳数-1) × 各边强度的几何平均`（多跳衰减 0.75）；
- **类型多样性惩罚**：同组内第 k 个入选项分数乘 `1/(1 + 0.35×k)`，避免同类刷屏。

**可解释性**：每条推荐给出三类中文理由（共享标签、共享邻居实体、关系路径），`path` 字段
（如 `["built_by", "participated_in"]`）与 `path_edges`（含方向 `reversed`）可供前端直接画关系链。

### 3.2 故事线生成（`storyline.py`）

输入：建筑实体 + 目标长度（3/5/8 点）+ 主题标签。**先骨架后文案**：

1. **骨架**：束搜索（beam width 64）沿图谱关系扩展节点链，单步加分
   `0.55 × edge_strength + 0.30 × [主题命中] + 0.15 × [新类型节点]`；
   时序约束：不走向代早于链首起点的实体（无年代实体不受限）。
   候选排序**长度优先、分数次之**——完整长度的链绝不输给提前断掉的高分链；无路可走时返回可达最长链。
2. **文案**：`connector_text` 用中文模板把真实三元组渲染成可读叙事
   （例：「接着可以看到，『示例营造者甲』参与了『示例营造活动』。」；反向遍历用「沿着这条关系看过去」起头）。
3. **可追溯**：每个节点、每条转场都对应图谱中存在的实体与关系；`source_citations` = 节点 KG 编号 ∪ 沿链引用的 HIS 编号。
   **不凭空生成实体**；示例数据下标题自动加「【示例】」前缀。

输出节点带 `role`（anchor / related）、`one_line`、`reason`（中文理由，前端可直接展示）。

### 3.3 史实一致性校验（`consistency.py`）

**规则层**（默认，离线可跑）：

| rule_id | 级别 | 含义 |
| --- | --- | --- |
| `KG_ENTITY` | error | 实体无中生有：节点或文案中引用的 KG 编号不在图谱中 |
| `KG_RELATION` | error | 故事声称的关系在 relations 中不存在（含编号/方向不匹配） |
| `KG_TIME` | error | 时间矛盾：叙事节点顺序与年代区间矛盾（区间按 `chronology` 解析，互斥区间才报错）；或文案中「A早于/晚于/发生在B之前之后」与图谱年代矛盾 |
| `KG_TYPE` | error | 关系类型与实体类型不兼容（如 event —built_by→ building；兼容矩阵见 `graph.RELATION_TYPES`） |
| `KG_CITATION` | error | 引用完整性：`source_citations` 指向的 KG/HIS 编号必须存在；空引用报错 |
| `KG_WORDING` | warn | 夸大/传闻词检测（最高、唯一、首次、据说、绝无仅有、史无前例）→ 风险标记 |
| `KG_CHAIN` | error | 结构完整性：转场与相邻节点必须构成连续链 |
| `KG_LLM` | error/warn | LLM 层追加的问题（仅配置了 LLM 时出现） |

**LLM 层**（可插拔，`LLMChecker` 协议：`check(storyline, kg) -> list[issue]`）：

- `RuleOnlyChecker`：默认实现，纯规则。
- `HttpLLMChecker`：读环境变量 `ALGO_LLM_BASE_URL` / `ALGO_LLM_API_KEY` / `ALGO_LLM_MODEL`，
  调 OpenAI 兼容 `/chat/completions`（prompt 注入防护：系统消息声明输入是待审数据）。
  **缺任一配置、网络失败、响应非法时一律优雅降级为规则层并打印提示到 stderr，不抛错。**

报告 `consistency_report.json`：`passed`（无 error 即过）、`issues[]`（level/rule_id/target/evidence/suggestion 全中文）、`rule_hits`（各规则命中数）。

### 3.4 点击率代理指标（`evaluation.py`）

正式指标「语义关联推荐点击率 ≥ 25%」无真实埋点，做**离线代理评估**（诚实口径，不挑样本）：

- **合成事件**：种子 20261122，320 名合成游客 × 4 个推荐位 × 2 个排序臂 = 每臂 1280 次展示。
  事件行为契约风格 `visitor_events.csv`（`event_type=view_recommendation / click_recommendation`），写入 `output/visitor_events_*.csv`。
- **配对设计**：同一游客、同一次访问对两个排序臂各生成一套展示位，点击概率由同一组随机数
  `draws = 0.04 + 0.32×兴趣标签重合率 + 0.12×偏好类型命中) × 位置系数(1.0/0.8/0.65/0.5)` 驱动——
  两个臂的差距只来自排序本身的兴趣匹配度，控制位置偏差。
- **对比基线**：标签热度排序（按候选实体标签的全图文档频率之和降序）。
- **当前结果**（示例图谱）：语义排序 225/1280 = **17.58%**，标签热度基线 202/1280 = 15.78%，差 +1.80pp。
  **未达 25% 目标**——这是合成口径下的诚实数字；真实上线需以实际埋点重算，见 §5 局限。

## 4. 验收结果（2026-11-22）

- `python kg-recommend/main.py` 跑通：打印推荐（含理由与路径）、5 点故事线、校验报告
  （命中 1 条 `KG_WORDING` warn：示例简介含「据说」——校验器确实在工作）、CTR 代理对比。
- `python -m pytest kg-recommend/tests -q` → **73 passed**，覆盖任务书全部要求项：
  无中生有实体报错（节点级 + 文案级）、关系不存在报错（类型/编号/方向三类）、时间矛盾报错（节点序 + 文案比较句）、
  类型不兼容报错、引用缺失报错、缺 key 时 LLM 优雅降级（完全没配置 / 只配一半 / 网络炸了三种场景）、
  路径可追溯（推荐 path、故事线转场、citations 三层）、schema 结构、CTR 代理可复现性。
- `metrics.json` 含：CTR 代理（两臂 + 差值 + 样本量 + 公式）、故事线长度分布
  （3 点档 15/15 达标；5 点档 12/15、8 点档 12/15——其余为 KG005 起点在时序约束下的真实死路，已穷举验证无 5 点链存在）、
  校验器各规则命中数。

## 5. 局限（如实声明）

1. **无真实图谱**：`data/kg_sample.json` 全部为示意条目（`source: sample`、`verified: 0`），不含任何史实；
   需求的「覆盖点位 ≥ 100」需等真实图谱导出后替换 `data/` 即可，算法无需改动。
2. **无 LLM 时只有规则校验**：语义级的事实矛盾（规则与年代表覆盖不到的表述）检不出来；
   LLM 层未配置时自动降级且打印提示。
3. **点击率是合成代理**：17.58% 由合成事件模型得出，反映「语义排序 vs 标签热度」的相对优势，不能当作真实 CTR；
   25% 目标需真实埋点验收。
4. **年代解析保守**：区间有重叠即视为不矛盾（年代常有不确定性），只对互斥区间报错；无年代实体跳过时间校验。
5. **故事线为链式**：不做分叉叙事；图太稀疏时可能不足目标长度（返回可达最长链并在 metrics 中如实记录）。

## 6. 与后端/前端的接口字段

| 端点/文件 | 关键字段 |
| --- | --- |
| `kg_recommend_result.json` | `source_entity_id`；`items[].entity_id / entity_type / recommendation_group / display_name / score / reasons[] / path[] / path_edges[]{from,to,relation_id,relation_type,reversed}`；`algo_version` |
| `storyline.json` | `title / theme`；`nodes[]{entity_id, entity_type, role, display_name, one_line, reason}`；`transitions[]{from, to, relation_id, relation_type, reversed, connector_text}`；`source_citations[]`（KG+HIS）；`algo_version` |
| `consistency_report.json` | `passed`；`issues[]{level, rule_id, target, evidence, suggestion}`；`rule_hits{rule_id: count}` |
| `metrics.json` | `graph_size`；`recommendation_ctr_proxy{semantic, tag_popularity, absolute_ctr_delta, 口径字段}`；`storyline_lengths`；`consistency.rule_hits` |

后端接入：`KnowledgeGraph.load(path)` 载入视图导出的 JSON → `recommend()` / `generate_storyline()` /
`consistency_report()`；LLM 校验用 `HttpLLMChecker`（三个环境变量见 §3.3）。前端：`path`/`path_edges` 画推荐关系链，
`transitions.connector_text` 直接做故事线旁白，`reasons`/`reason` 直接做解释气泡。

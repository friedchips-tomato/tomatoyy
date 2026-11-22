# 停车预测与推荐接口接入说明

本文面向 H5 游客端、运营台和微信小程序，说明长堤风貌街停车预测与推荐接口的请求、响应和判读规则。字段名、错误码和路径保持英文原样。接口的权威定义以 [OpenAPI](openapi.yaml) 为准，本文与契约冲突时以契约为准。

本接口的数据由上游停车预测运行时提供：上游为仓库根目录 `parking-forecast/`（`model_version = 2.0.0`、`schema_version = 2.0.0`）。服务端内置一份只读副本（`server/src/parking/vendor/`，附来源与 SHA-256 记录，见同目录 `PROVENANCE.md`），可用环境变量 `CHANGDI_PARKING_DIR` 切换到别处；切换后数据可能不是合成数据，届时 `source` 会随之变化。

当前数据为合成示范数据：响应顶层的 `source` 取自运行时产物，当前为 `synthetic`；车场静态条目的 `source` 枚举允许 `synthetic`、`manual`、`api`、`camera`。这不是真实车场余位，所有展示位置必须标注「模拟」，不得把静态信息或合成预测说成实时余位。

## 通用约定

- 公共前缀为 `/api/v1/public/parking`，三个接口均匿名、只读，不要求 `Authorization`，携带凭据也不校验。
- 按对端地址限流，默认每 600 秒 60 次，超限返回 429 `too_many_requests` 并带 `Retry-After`（秒）。
- 响应统一带 `Cache-Control: no-store`，客户端不得缓存或把结果当作长期有效数据。
- 请求和响应均为 JSON，字段名使用 snake_case。
- 时间一律为带时区的 ISO8601，服务端返回 UTC（以 `Z` 结尾）。请求中的 `arrive_at`、`issued_at` 必须带时区。
- `destination_id` 使用导览点位代码（例如 `CD-0001`），`lot_id` 使用车场目录代码（例如 `P1`、`P2`）。
- 错误响应统一为 `{ "error": "<code>" }`。

| 错误码 | HTTP | 说明 |
| --- | --- | --- |
| `invalid_field` | 400 | 已知参数的取值非法，例如 `preference=fast`、`horizons=15,90`、`horizons=15,15`、`vehicle_height_m=-1`、`stay_hours=0` |
| `invalid_timestamp` | 400 | 时间不是带时区的 ISO8601 |
| `invalid_filter` | 400 | 出现未列出的查询参数，或同名参数重复；三个接口都适用（`lots` 也不接受任何查询参数） |
| `lot_not_found` | 404 | `lot_id` 未登记 |
| `too_many_requests` | 429 | 超出限流窗口，按 `Retry-After` 重试 |
| `unavailable` | 502 | 仅 guide-bridge 代理：上游不可达 |

`invalid_filter` 只判断参数名是否合法、是否重复；已列出的参数名对应的取值不合法一律用 `invalid_field`，时间格式错误用 `invalid_timestamp`。

## 1. 车场目录

`GET /api/v1/public/parking/lots`，不接受任何查询参数；传入未列出的参数或同名重复参数返回 400 `invalid_filter`。

| 响应字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `source` | string | 否 | 数据来源，取自运行时产物；当前为 `synthetic`（合成示范数据，不是真实余位） |
| `available` | boolean | 否 | 运行时产物是否可用；`false` 时 `items` 仍为静态车场信息，接口仍返回 200 |
| `degraded` | boolean | 否 | 本次响应是否含降级结果（任一时距或任一车场走了降级链，或运行时整体不可用） |
| `note` | string | 是 | 人类可读的降级或不可用原因（降级链名或运行时不可用的原因），正常时为 `null` |
| `generated_at` | string | 否 | 运行时数据的生成时刻（取自运行时产物 manifest），表示这份数据何时产生，不是请求时刻 |
| `items` | array | 否 | 车场列表 |

`items` 每项（`ParkingLot`）：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码，例如 `P1` |
| `name` | string | 否 | 车场名称 |
| `total_spaces` | integer | 否 | 车位总数，不小于 1 |
| `current_free` | integer | 是 | 最近一次观测的当前余位；`null` 表示当前余位未知 |
| `current_observed_at` | string | 是 | 该观测的时刻（UTC，带 Z）；没有观测时为 `null` |
| `current_quality` | string | 是 | 观测质量：`ok`、`stale`、`missing` 或 `suspect`；没有任何观测时为 `null` |
| `current_stale` | boolean | 否 | 该观测是否过期（`age_seconds > 900`，与运行时阈值一致）；没有观测时为 `false` |
| `fee` | object | 否 | 计费信息，见下表 |
| `access` | object | 否 | 通行限制，见下表 |
| `walk_to_street` | object | 否 | 到街区步行距离，见下表 |
| `district` | string | 是 | 所属街区或片区，未知时为 `null` |
| `notes` | string | 是 | 补充说明，合成数据会注明用途；无说明时为 `null` |
| `source` | string | 否 | 车场静态数据来源，取自运行时产物：`synthetic`、`manual`、`api` 或 `camera`；当前为 `synthetic` |

以上 `current_*` 四个字段来自观测数据，**不依赖模型或运行时可用性**：即使 `available=false`（模型或运行时不可用），它们仍照常给出，前端此时至少可显示「当前余位（观测值）」，不必退回纯静态示意。`current_free=null` 表示**当前余位未知**，页面显示「当前余位暂不可用」，**不得显示为 0 或「已满」**；`current_stale=true` 时还应标注该观测已过期并显示 `current_observed_at`。

`fee` 对象本身一定存在，其中部分字段的值可能为 `null`：

| `fee` 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `mode` | string | 否 | 计费方式：`hourly`、`flat` 或 `unknown` |
| `amount` | number | 是 | 计费金额，未知时为 `null` |
| `unit` | string | 是 | 币种，目前为 `CNY`，未知时为 `null` |
| `note` | string | 否 | 面向游客的计费说明 |

`access` 对象本身一定存在，其中部分字段的值可能为 `null`：

| `access` 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `open_hours` | string | 是 | 开放时段，未知时为 `null` |
| `one_way` | boolean | 否 | 是否单行进出 |
| `restricted_hours` | object[] | 是 | 受限时段，无相关数据时为 `null`；每项为 `{ from, to, note }`，三个键均为字符串 |
| `height_limit_m` | number | 是 | 限高（米），无限制或未知时为 `null` |
| `note` | string | 否 | 通行限制说明 |

| `walk_to_street` 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `meters` | integer | 否 | 步行距离（米），不小于 0 |
| `minutes` | integer | 否 | 步行时间（分钟），不小于 0 |

## 2. 停车推荐

`GET /api/v1/public/parking/recommendations`

| 查询参数 | 必填 | 类型 | 含义 |
| --- | --- | --- | --- |
| `destination_id` | 是 | string | 导览点位代码，匹配 `^[A-Za-z0-9_-]{1,64}$` |
| `arrive_at` | 是 | string | 到达时间，带时区的 ISO8601 |
| `preference` | 否 | string | `save_time`（默认，省时）或 `less_walking`（少走路） |
| `vehicle_height_m` | 否 | number | 车辆高度（米），须为正数 |
| `stay_hours` | 否 | number | 预计停留时长（小时），须为正数 |

未列出的参数或同名重复参数返回 400 `invalid_filter`。已列出参数的取值非法返回 400 `invalid_field`（例如 `preference=fast`、`vehicle_height_m=-1`、`stay_hours=0`），`arrive_at` 缺失或格式不符返回 400 `invalid_timestamp`。

| 响应字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `destination_id` | string | 否 | 回显请求中的点位代码 |
| `arrive_at` | string | 否 | 回显到达时间（UTC） |
| `preference` | string | 否 | 实际采用的偏好 |
| `generated_at` | string | 否 | 该次推荐所依据预测的签发截点，即 min(数据装载时刻, `arrive_at` − 30 分钟)；语义等于上游 forecast 的 `issued_at`，不是响应发送时刻 |
| `source` | string | 否 | 数据来源，取自运行时产物；当前为 `synthetic`（合成示范数据，不是真实余位） |
| `available` | boolean | 否 | 运行时产物是否可用；`false` 时静态车场信息仍照常给出，接口仍返回 200 |
| `degraded` | boolean | 否 | 本次响应是否含降级结果（任一时距或任一车场走了降级链，或运行时整体不可用） |
| `note` | string | 是 | 人类可读的降级或不可用原因（降级链名或运行时不可用的原因），正常时为 `null` |
| `items` | array | 否 | 首选推荐 |
| `alternates` | array | 否 | 备选推荐 |
| `excluded` | array | 否 | 被排除的车场及原因 |
| `offsets` | array | 否 | 偏移或时间调整建议；原样透传，元素结构以上游运行时为准 |

`items`、`alternates`、`offsets` 的元素字段一致（snake_case）：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `name` | string | 否 | 车场名称 |
| `arrive_free` | number | 是 | 到达时预计空闲车位；`null` 表示不可用，不是 0 |
| `arrive_free_rate` | number | 是 | 空闲车位占比（0–1），不可用时为 `null` |
| `arrive_free_p10` | number | 是 | 空闲车位预测下限（P10），不可用时为 `null` |
| `arrive_free_p90` | number | 是 | 空闲车位预测上限（P90），不可用时为 `null` |
| `walk_meters` | integer | 否 | 到目的地步行距离（米） |
| `walk_minutes` | number | 否 | 步行时间（分钟） |
| `fee_amount` | number | 是 | 预计停车费用金额，费用未知时为 `null` |
| `fee_unit` | string | 是 | 费用单位，例如 `CNY`；`fee_amount` 为 `null` 时也为 `null` |
| `updated_at` | string | 是 | 该条数据或预测的更新时间（UTC），无更新时间时为 `null` |
| `stale` | boolean | 否 | 数据是否已过时 |
| `score` | number | 否 | 综合评分，越高越优先 |
| `score_breakdown` | object[] | 否 | 评分构成，固定七项，见下表 |
| `reasons` | string[] | 否 | 推荐理由列表 |
| `total_time_minutes` | number | 否 | 含停车与步行的总耗时（分钟） |
| `transfer` | object | 否 | 换乘或接驳信息，见下表 |
| `restrictions` | string[] | 否 | 限制条件说明，无限制时为空数组 |
| `forecast_method` | string | 否 | 该条预测来源，见「判读规则」 |
| `degraded` | boolean | 否 | 该条结果是否来自降级路径 |

`score_breakdown` 为数组，固定七项且顺序固定：`arrive_free`、`arrive_free_rate`、`walk_cost`、`total_time`、`fee_cost`、`confidence`、`restriction_penalty`。每项：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `factor` | string | 否 | 评分因子，取上列七项之一 |
| `weight` | number | 否 | 该因子的权重 |
| `raw` | number | 是 | 原始值；`arrive_free`/`arrive_free_rate` 预测不可用时为 `null`，`fee_cost` 费用未知时也为 `null` |
| `normalized` | number | 否 | 归一化后的取值 |
| `contribution` | number | 否 | 对总分的贡献 |

`transfer` 对象本身始终存在：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `mode` | string | 是 | 接驳方式，无数据时为 `null` |
| `feasible` | boolean | 否 | 当前是否可换乘接驳；当前实现恒为 `false` |
| `minutes` | number | 是 | 接驳耗时（分钟），无数据时为 `null` |
| `note` | string | 否 | 接驳说明，当前为「暂无可用接驳点数据」 |

`excluded` 每项：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `name` | string | 否 | 车场名称 |
| `reason` | string | 否 | 排除原因，例如限高不符或已满 |

## 3. 单场余位预测

`GET /api/v1/public/parking/lots/{lot_id}/forecast`

| 参数 | 位置 | 必填 | 类型 | 含义 |
| --- | --- | --- | --- | --- |
| `lot_id` | path | 是 | string | 车场目录代码，匹配 `^[A-Za-z0-9_-]{1,32}$`，未登记返回 404 `lot_not_found` |
| `issued_at` | query | 否 | string | 本次请求的签发时刻，带时区的 ISO8601，默认服务器当前时间（不是数据生成时刻） |
| `horizons` | query | 否 | string | 逗号分隔的分钟数，取值限于 `15,30,45,60`，默认全部 |

未列出的参数或同名重复参数返回 400 `invalid_filter`；`horizons` 取值非法（例如 `15,90`、`15,15` 或为空）返回 400 `invalid_field`，`issued_at` 格式不符返回 400 `invalid_timestamp`。

| 响应字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `issued_at` | string | 否 | 本次请求的签发时刻，回显为 UTC，不是数据生成时刻 |
| `source` | string | 否 | 数据来源，取自运行时产物；当前为 `synthetic`（合成示范数据，不是真实余位） |
| `available` | boolean | 否 | 运行时产物是否可用；`false` 时仍返回 200，`forecasts` 中 `method` 为 `unavailable` |
| `degraded` | boolean | 否 | 本次响应是否含降级结果（任一时距或任一车场走了降级链，或运行时整体不可用） |
| `note` | string | 是 | 人类可读的降级或不可用原因（降级链名或运行时不可用的原因），正常时为 `null` |
| `forecasts` | array | 否 | 按 `horizons` 顺序返回的预测列表 |

`forecasts` 每项：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `issued_at` | string | 否 | 本次请求的签发时刻（UTC），与响应顶层 `issued_at` 一致，不是数据生成时刻 |
| `target_ts` | string | 否 | 预测目标时刻（UTC） |
| `horizon_minutes` | integer | 否 | 预测时长，`15`、`30`、`45` 或 `60` |
| `point_free` | integer | 是 | 目标时刻预计空闲车位数；`method=unavailable` 时为 `null` |
| `p10` | integer | 是 | 空闲车位预测下限（P10）；`method=unavailable` 时为 `null` |
| `p90` | integer | 是 | 空闲车位预测上限（P90）；`method=unavailable` 时为 `null` |
| `free_rate` | number | 是 | 预计空闲车位占比（0–1）；`method=unavailable` 时为 `null` |
| `method` | string | 否 | 预测来源方法，见「判读规则」 |
| `degraded` | boolean | 否 | 该条预测是否来自降级路径 |
| `degrade_reason` | string | 是 | 降级原因，未降级时为 `null`；不可预测时给出 `missing_observation`、`stale_observation` 或 `no_history` 等原因 |
| `model_version` | string | 是 | 生成预测的模型版本；`method=unavailable` 时为 `null` |
| `data_asof` | string | 是 | 所依据数据的最新时刻（UTC）；`method=unavailable` 时为 `null` |
| `source` | string | 否 | 数据来源，取自运行时产物；当前为 `synthetic`（合成示范数据，不是真实余位） |

## 判读规则

- `available`：运行时产物是否可用。`available: false` 时三个接口仍返回 200（不返回 5xx），静态车场信息可用，但预测类字段不可信，页面必须按「实时余位暂不可用」展示。
- `degraded`：本次响应**含**降级结果——任一时距或任一车场走了降级链，或运行时整体不可用。数值可以展示，但须标注降级方式。
- `note`：人类可读原因（降级链名，或运行时不可用的原因）；正常时为 `null`。
- `stale: true`：该条数据或预测已过时，展示时须给出「数据已过时」提示。
- `arrive_free: null`：预测不可用，**不是 0**。不得把它渲染成「无空位」或 0 个车位。
- `current_free: null`：当前余位未知，页面显示「当前余位暂不可用」，**不得显示为 0 或「已满」**；`current_stale=true` 时还应标注该观测已过期并显示 `current_observed_at`。这批观测字段不依赖模型可用性，`available=false` 时仍照常给出。
- `forecast_method`、`method` 取值：
  - `model`：模型输出，正常使用；
  - `last_known`：沿用最近一次观测；
  - `same_slot_baseline`：同一时段历史基线；
  - `same_weekday_baseline`：同一星期历史基线；
  - `unavailable`：该时段不可预测，按不可用处理；此时 `point_free`、`p10`、`p90`、`free_rate`、`model_version`、`data_asof` 全部为 `null`，原因见 `degrade_reason`。
  - 取值以外的内容以 OpenAPI 为准。
- `score_breakdown[].raw` 可能为 `null`：`arrive_free`/`arrive_free_rate` 预测不可用时为 `null`，`fee_cost` 费用未知时也为 `null`。不得把 `raw=null` 当作 0 参与展示或再计算。
- `transfer.feasible` 当前恒为 `false`，表示暂无接驳点数据。前端不得据此显示「可换乘接驳」，只能展示 `transfer.note` 的提示。
- `excluded` 中的车场不参与推荐，展示原因即可，不要把它们当作 0 空位。
- `score` 只在同一次响应内比较，不跨请求、跨偏好比较。

## 预测精度口径

本接口只返回预测值，不承诺预测精度，响应中不提供任何 accuracy 字段。上游主口径为 `MAE_ratio = mean|pred_free − actual_free| / total_spaces`（绝对车位 MAE 与其他口径见上游 `metrics.json`），需求书原文的单位与口径仍待项目方书面确认；当前数据为合成示范数据，不构成任何达标结论。前端不得据此宣称「预测准确」或展示达标百分比。

## 回落规则

以下三条判据分别处理，不得混用：

1. `available=false`（模型/运行时不可用）→ 使用静态车场信息（名称、总位数、步行距离、费用、开放时段）和 `current_*` 观测值；预测余位一律不显示，标注「实时余位暂不可用」。观测字段不依赖模型可用性，`current_free` 有值时至少展示「当前余位（观测值）」，为 `null` 时显示「当前余位暂不可用」。
2. `available=true` 但 `degraded=true` → 可以显示预测值，但必须标注降级方式（如 `forecast_method=last_known` 表示「沿用最近一次观测」），并显示 `updated_at`。
3. `arrive_free=null`（该时刻不可用）→ 该车场按「暂无余位」处理，**不得显示为 0**。

补充：`score_breakdown[].raw` 可能为 `null`；`transfer.feasible` 当前恒为 `false`（暂无接驳点数据），前端不得据此显示「可换乘接驳」。

- 静默失败不可取：网络错误或非 2xx 时也必须展示可感知的提示文案，不得把静态值说成实时余位。
- 收到 429 时按 `Retry-After` 退避，可先回落静态数据，不要连续重试。
- `lot_id` 返回 404 时按不可推荐处理，不要猜测该车场。
- 运营台同样适用以上规则，并在数据区标注「模拟」。

## 浏览器与小程序接入

浏览器 H5 必须走 guide-bridge 的同源代理，不直连后端。原因是通过同源请求避免跨域限制，也不在浏览器中暴露后端地址：

- `GET /bridge/parking/lots`
- `GET /bridge/parking/recommendations?<查询参数>`
- `GET /bridge/parking/lots/{lot_id}/forecast?<查询参数>`

guide-bridge 是同源代理：只做路径映射、状态码与 JSON 原文透传，上游不可达或超时返回 502 `{"error":"unavailable"}`，未知路径返回 404，代理不注入 token。**查询参数原样透传，不做过滤或改写**；参数合法性由服务端统一校验，服务端对未知参数或同名重复参数返回 400 `invalid_filter`。

不在代理层过滤参数的原因：若代理静默丢掉写错的参数名（例如 `prefernce`），请求会悄悄退回默认的 `save_time`，推荐结果错了却没有任何报错。宁可让前端拿到明确的 400。

微信小程序按部署基址直接调用上述 `/api/v1/public/parking/*` 路径，接口同样匿名（以 OpenAPI 为准）。

埋点沿用导览既有行为通道（`parking_advice_adopted`、`parking_navigation_clicked`），命名与上报时机见 [guide-bridge/README.md](../guide-bridge/README.md)。

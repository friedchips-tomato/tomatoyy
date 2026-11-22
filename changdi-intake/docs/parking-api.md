# 停车预测与推荐接口接入说明

本文面向 H5 游客端、运营台和微信小程序，说明长堤风貌街停车预测与推荐接口的请求、响应和判读规则。字段名、错误码和路径保持英文原样。接口的权威定义以 [OpenAPI](openapi.yaml) 为准，本文与契约冲突时以契约为准。

数据为合成示范数据，响应中的 `source` 固定为 `synthetic`，不是真实车场余位。所有展示位置必须标注「模拟」，不得把静态信息或合成预测说成实时余位。

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
| `invalid_field` | 400 | 字段缺失、格式或取值不合法 |
| `invalid_timestamp` | 400 | 时间不是带时区的 ISO8601 |
| `invalid_filter` | 400 | 出现未列出的查询参数或同名重复参数（仅推荐接口） |
| `lot_not_found` | 404 | `lot_id` 未登记 |
| `too_many_requests` | 429 | 超出限流窗口，按 `Retry-After` 重试 |
| `unavailable` | 502 | 仅 guide-bridge 代理：上游不可达 |

## 1. 车场目录

`GET /api/v1/public/parking/lots`，无查询参数。

| 响应字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `source` | string | 否 | 数据来源，固定 `synthetic` |
| `available` | boolean | 否 | 运行时数据是否可用；`false` 时 `items` 仍为静态车场信息 |
| `degraded` | boolean | 否 | 是否处于降级状态 |
| `note` | string | 是 | 降级或不可用原因，正常时为 `null` |
| `generated_at` | string | 否 | 响应生成时间（UTC） |
| `items` | array | 否 | 车场列表 |

`items` 每项（`ParkingLot`）：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码，例如 `P1` |
| `name` | string | 否 | 车场名称 |
| `total_spaces` | integer | 否 | 车位总数 |
| `fee` | object | 否 | 计费信息，见下表 |
| `access` | object | 否 | 通行限制，见下表 |
| `walk_to_street` | object | 否 | 到街区步行距离，见下表 |
| `district` | string | 否 | 所属街区或片区 |
| `notes` | string | 否 | 补充说明，合成数据会注明用途 |
| `source` | string | 否 | 数据来源，固定 `synthetic` |

| `fee` 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `mode` | string | 否 | 计费方式，例如 `hourly` |
| `amount` | number | 否 | 计费金额 |
| `unit` | string | 否 | 币种或单位，例如 `CNY` |
| `note` | string | 否 | 面向游客的计费说明 |

| `access` 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `open_hours` | string | 否 | 开放时段 |
| `one_way` | boolean | 否 | 是否单行进出 |
| `restricted_hours` | string[] | 否 | 受限时段，无限制时为空数组 |
| `height_limit_m` | number | 是 | 限高（米），无限制时为 `null` |
| `note` | string | 否 | 通行限制说明 |

| `walk_to_street` 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `meters` | integer | 否 | 步行距离（米） |
| `minutes` | number | 否 | 步行时间（分钟） |

## 2. 停车推荐

`GET /api/v1/public/parking/recommendations`

| 查询参数 | 必填 | 类型 | 含义 |
| --- | --- | --- | --- |
| `destination_id` | 是 | string | 导览点位代码，匹配 `^[A-Za-z0-9_-]{1,64}$` |
| `arrive_at` | 是 | string | 到达时间，带时区的 ISO8601 |
| `preference` | 否 | string | `save_time`（默认，省时）或 `less_walking`（少走路） |
| `vehicle_height_m` | 否 | number | 车辆高度（米），须为正数 |
| `stay_hours` | 否 | number | 预计停留时长（小时），须为正数 |

未列出的参数或同名重复参数返回 400 `invalid_filter`。`destination_id` 不合法返回 400 `invalid_field`，`arrive_at` 缺失或格式不符返回 400 `invalid_timestamp`。

| 响应字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `destination_id` | string | 否 | 回显请求中的点位代码 |
| `arrive_at` | string | 否 | 回显到达时间（UTC） |
| `preference` | string | 否 | 实际采用的偏好 |
| `generated_at` | string | 否 | 响应生成时间（UTC） |
| `source` | string | 否 | 数据来源，固定 `synthetic` |
| `available` | boolean | 否 | 运行时数据是否可用 |
| `degraded` | boolean | 否 | 是否处于降级状态 |
| `note` | string | 是 | 降级或不可用原因，正常时为 `null` |
| `items` | array | 否 | 首选推荐 |
| `alternates` | array | 否 | 备选推荐 |
| `excluded` | array | 否 | 被排除的车场及原因 |
| `offsets` | array | 否 | 偏移或时间调整建议 |

`items`、`alternates`、`offsets` 的元素字段一致（snake_case）：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `name` | string | 否 | 车场名称 |
| `arrive_free` | integer | 是 | 到达时预计空闲车位；`null` 表示不可用，不是 0 |
| `arrive_free_rate` | number | 是 | 空闲车位占比（0–1），不可用时为 `null` |
| `arrive_free_p10` | integer | 是 | 空闲车位预测下限（P10），不可用时为 `null` |
| `arrive_free_p90` | integer | 是 | 空闲车位预测上限（P90），不可用时为 `null` |
| `walk_meters` | integer | 否 | 到目的地步行距离（米） |
| `walk_minutes` | number | 否 | 步行时间（分钟） |
| `fee_amount` | number | 否 | 预计停车费用金额 |
| `fee_unit` | string | 否 | 费用单位，例如 `CNY` |
| `updated_at` | string | 否 | 该条数据或预测的更新时间（UTC） |
| `stale` | boolean | 否 | 数据是否已过时 |
| `score` | number | 否 | 综合评分，越高越优先 |
| `score_breakdown` | object | 否 | 评分构成明细，键值由实现定义 |
| `reasons` | string[] | 否 | 推荐理由列表 |
| `total_time_minutes` | number | 否 | 含停车与步行的总耗时（分钟） |
| `transfer` | object | 是 | 换乘或接驳信息，无换乘或不可用时为 `null`，结构由实现定义 |
| `restrictions` | string[] | 否 | 限制条件说明，无限制时为空数组 |
| `forecast_method` | string | 否 | 该条预测来源，见「判读规则」 |
| `degraded` | boolean | 否 | 该条结果是否来自降级路径 |

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
| `issued_at` | query | 否 | string | 签发时间，带时区的 ISO8601，默认服务器当前时间 |
| `horizons` | query | 否 | string | 逗号分隔的分钟数，取值限于 `15,30,45,60`，默认全部 |

| 响应字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `issued_at` | string | 否 | 回显签发时间（UTC） |
| `source` | string | 否 | 数据来源，固定 `synthetic` |
| `available` | boolean | 否 | 预测数据是否可用 |
| `degraded` | boolean | 否 | 是否处于降级状态 |
| `note` | string | 是 | 降级或不可用原因，正常时为 `null` |
| `forecasts` | array | 否 | 按 `horizons` 顺序返回的预测列表 |

`forecasts` 每项：

| 字段 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `lot_id` | string | 否 | 车场目录代码 |
| `issued_at` | string | 否 | 签发时间（UTC） |
| `target_ts` | string | 否 | 预测目标时刻（UTC） |
| `horizon_minutes` | integer | 否 | 预测时长，`15`、`30`、`45` 或 `60` |
| `point_free` | integer | 否 | 目标时刻预计空闲车位数 |
| `p10` | integer | 否 | 空闲车位预测下限（P10） |
| `p90` | integer | 否 | 空闲车位预测上限（P90） |
| `free_rate` | number | 否 | 预计空闲车位占比（0–1） |
| `method` | string | 否 | 预测来源方法，见「判读规则」 |
| `degraded` | boolean | 否 | 该条预测是否来自降级路径 |
| `degrade_reason` | string | 是 | 降级原因，未降级时为 `null` |
| `model_version` | string | 否 | 生成预测的模型版本 |
| `data_asof` | string | 否 | 所依据数据的最新时刻（UTC） |
| `source` | string | 否 | 数据来源，固定 `synthetic` |

## 判读规则

- `available: false`：运行时数据不可用，响应中的静态车场信息仍可用，但预测类字段不可信。页面必须按「预测不可用」展示。
- `degraded: true`：结果来自降级路径（例如沿用最近观测或基线），数值可以展示，但须标注降级状态。
- `stale: true`：该条数据或预测已过时，展示时须给出「数据已过时」提示。
- `arrive_free: null`：预测不可用，**不是 0**。不得把它渲染成「无空位」或 0 个车位。
- `forecast_method`、`method` 取值：
  - `model`：模型输出，正常使用；
  - `last_known`：沿用最近一次观测；
  - `same_slot_baseline`：同一时段历史基线；
  - `same_weekday_baseline`：同一星期历史基线；
  - `unavailable`：该时段不可预测，按不可用处理。
  - 取值以外的内容以 OpenAPI 为准。
- `excluded` 中的车场不参与推荐，展示原因即可，不要把它们当作 0 空位。
- `score` 只在同一次响应内比较，不跨请求、跨偏好比较。

## 回落规则

接口不可用（网络错误、非 2xx、`available: false`）时，前端回落静态示范数据，并明确显示「数据已过时 / 预测不可用」，不得把静态值说成实时余位。

- 静默失败不可取：回落时必须展示可感知的提示文案。
- `arrive_free` 等预测字段为 `null` 时展示「预测不可用」，不要填 0。
- 收到 429 时按 `Retry-After` 退避，可先回落静态数据，不要连续重试。
- `lot_id` 返回 404 时按不可推荐处理，不要猜测该车场。
- 运营台同样适用以上规则，并在数据区标注「模拟」。

## 浏览器与小程序接入

浏览器 H5 必须走 guide-bridge 的同源代理，不直连后端。原因是通过同源请求避免跨域限制，也不在浏览器中暴露后端地址：

- `GET /bridge/parking/lots`
- `GET /bridge/parking/recommendations?<白名单参数>`
- `GET /bridge/parking/lots/{lot_id}/forecast?<白名单参数>`

代理只透传白名单参数 `destination_id`、`arrive_at`、`preference`、`vehicle_height_m`、`stay_hours`、`issued_at`、`horizons`，并原样透传上游状态码与 JSON。上游不可达返回 502 `{"error":"unavailable"}`，未知路径返回 404。代理不注入 token。

微信小程序按部署基址直接调用上述 `/api/v1/public/parking/*` 路径，接口同样匿名（以 OpenAPI 为准）。

埋点沿用导览既有行为通道（`parking_advice_adopted`、`parking_navigation_clicked`），命名与上报时机见 [guide-bridge/README.md](../guide-bridge/README.md)。

# 长堤风貌街接诉即办后端

本地纵切使用 Node.js 22.17 和内置 SQLite，无第三方运行依赖。用合成数据运行 `npm.cmd test`，测试以临时数据库和随机端口启动服务并清理现场。

## 本地运行

在本目录用 PowerShell 为当前进程生成测试凭据。再次使用同一数据库时需继续使用原 `CHANGDI_RECEIPT_KEY`。接入方 Bearer 可以轮换，轮换前后配置中的 `source` 应保持一致。

```powershell
function New-LocalToken { node -p "require('node:crypto').randomBytes(32).toString('base64url')" }
$env:CHANGDI_RECEIPT_KEY = New-LocalToken
$env:CHANGDI_INTAKE_DEMO_TOKEN = New-LocalToken
$env:CHANGDI_INTEGRATIONS_JSON = ConvertTo-Json -Compress -InputObject @(
    @{ source = 'local-demo'; token = $env:CHANGDI_INTAKE_DEMO_TOKEN }
)
$env:CHANGDI_STAFF_JSON = ConvertTo-Json -Compress -InputObject @(
    @{ id = 'desk'; role = 'duty'; token = (New-LocalToken) },
    @{ id = 'handler-a'; role = 'handler'; department = 'street'; token = (New-LocalToken) },
    @{ id = 'lead-a'; role = 'supervisor'; department = 'street'; token = (New-LocalToken) }
)
$env:CHANGDI_MERCHANT_DEMO_A = New-LocalToken
$env:CHANGDI_MERCHANT_DEMO_B = New-LocalToken
$env:CHANGDI_MERCHANTS_JSON = ConvertTo-Json -Compress -Depth 4 -InputObject @(
    @{ id = 'shop-a-member'; merchantId = 'shop-a'; token = $env:CHANGDI_MERCHANT_DEMO_A
       permissions = @('readCases', 'submitCases', 'collaborate') },
    @{ id = 'shop-b-member'; merchantId = 'shop-b'; token = $env:CHANGDI_MERCHANT_DEMO_B
       permissions = @('readCases', 'submitCases', 'collaborate') }
)
npm.cmd start
```

服务监听 `127.0.0.1:3400`，用 Ctrl+C 退出。可用 `CHANGDI_PORT` 改端口。评价和补办窗口均从该轮发布反馈时起算。评价窗口默认七天，`CHANGDI_EVALUATION_SECONDS` 范围为 1 秒至 90 天。补办窗口默认 30 天，`CHANGDI_REOPEN_SECONDS` 范围为 1 秒至 365 天。工单保存在 Git 忽略的 `.local/intake.sqlite`。同一数据库使用新的回执密钥会导致启动失败。回执密钥与数据库需要分开保管。

## 合作方联调

[OpenAPI](../docs/openapi.yaml) 是唯一的合作方契约，接口为 `POST /api/v1/integrations/intake/cases`。接入方服务端使用独立的 Bearer 凭据。接入来源由后端从凭据解析。

| payload 字段 | 要求 | 格式和上限 |
| --- | --- | --- |
| `externalCaseId` | 必填 | 字符串，128 字符，同一来源下保持唯一，重试保持原值 |
| `occurredAt` | 必填 | 带时区的日期时间，例如 `2026-11-19T09:00:00+08:00`，最多三位小数；存储为 UTC |
| `location` | 必填 | 发生地点，300 字符 |
| `category` | 必填 | 问题类别，80 字符，本地接收文本 |
| `description` | 必填 | 申报描述，4,000 字符 |
| `suggestedDepartment` | 可选 | 建议部门，100 字符，由值班人员最终分派 |
| `contact` | 可选 | 联系方式文本，300 字符，单独存储 |

`payload` 是唯一一个 JSON 文本 part。传入的字符串会去除首尾空白，必填项和传入的选填项均须非空，选填项没有值时省略。最多 3 张照片，每张 5 MiB，文件 MIME 与 JPEG、PNG、WebP 文件签名必须匹配。整包上限 15 MiB + 64 KiB，payload 解码后最多 32 KiB，读取请求体限时 15 秒。当前执行文件签名校验，图片完整解码、内容复核及公开衍生图留在后续批次。

在能读取已配置接入凭据的 PowerShell 客户端中提交合成请求。需要照片时重复调用 `body.append("photos", blob, filename)`，使用对应图片 MIME。

```powershell
@'
const body = new FormData()
body.append("payload", JSON.stringify({
  externalCaseId: "example-001",
  occurredAt: "2026-11-19T09:00:00+08:00",
  location: "合成测试点位",
  category: "街面维护",
  description: "合成申报示例"
}))
const response = await fetch("http://127.0.0.1:3400/api/v1/integrations/intake/cases", {
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.CHANGDI_INTAKE_DEMO_TOKEN },
  body
})
const receipt = await response.json()
console.log(response.status, receipt.caseNumber, receipt.publicLookupCode)
'@ | node --input-type=module -
```

回执示例使用合成占位值。

```json
{
  "caseNumber": "CD-0123456789ABCDEF0123456789ABCDEF",
  "publicLookupCode": "ABCDEFGHIJKLMNOPQRSTUVWX",
  "privateLookupToken": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

首次成功返回 201。同来源同外部单号重发相同的规范化字段与照片字节，返回 200 和原回执。JSON 键顺序、照片顺序和文件名不参与内容比较，照片增删、替换或重复数量变化会得到 409 `submission_conflict`。400 表示字段、JSON 或 multipart 结构错误，401 表示凭据无效，403 表示凭据属于其他角色，413 表示超限，415 表示媒体类型错误。遇到超时、500 或 503 时保留原单号及原内容重试，收到 `Retry-After` 时按其间隔重试。接入方仅在 201 或 200 后展示成功。

提交方在非公开回执中单独交付 `privateLookupToken`。二维码及公开查询只使用 `publicLookupCode`。接入方日志、页面分析脚本和公开链接均须避开本人凭证和申报信息。

### 可选微信小程序码

默认关闭，接单成功回执保留上述三个字段。账号联调经授权后，由服务端运行环境提供以下配置，用同一接单路径返回可选的 `wechatCode: { envVersion, mediaType, base64 }`。合作方无需持有微信侧凭据。

| 服务端环境变量 | 值 |
| --- | --- |
| `CHANGDI_WECHAT_CODE_ENABLED` | 未设置或 `0` 为关闭，`1` 为启用 |
| `CHANGDI_WECHAT_APP_ID` | 启用时必填，小程序 AppID |
| `CHANGDI_WECHAT_APP_SECRET` | 启用时必填，小程序 AppSecret，供服务端从受控环境读取 |
| `CHANGDI_WECHAT_ENV_VERSION` | 启用时必填，`release` 正式版、`trial` 体验版或 `develop` 开发版 |

- 微信请求固定到官方 HTTPS 接口。[获取稳定版接口调用凭据](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getstableaccesstoken.html)用 POST JSON，令牌仅在进程内缓存。微信返回凭据无效或过期时最多刷新并重试一次，同一进程两次强刷至少间隔 30 秒。[获取不限制的小程序码](https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/qr-code/api_getunlimitedqrcode.html)固定页面为 `pages/public/index`，`scene` 仅含 24 位公开码。正式版开启页面校验，体验版和开发版允许未发布页面。
- 每次微信请求最多等待 3 秒，包含读取响应体。拒绝重定向，令牌和非图片响应最多读取 16 KiB，图片响应最多读取 1 MiB，错误 JSON 解析上限为 16 KiB。码图片须通过 JPEG 或 PNG 签名校验。响应提供正确图片 MIME 及标准 Base64，无 data URL 前缀。微信 URL、消息、访问令牌和 AppSecret 不进合作方响应或应用日志。
- 先提交工单及原附件，再生成码。上游超时、微信报错、图片验证失败或待生成队列满时返回 503 `wechat_code_unavailable` 和 `Retry-After: 1`。工单已保存。使用同一外部单号和相同内容重试，随后成功返回 200，原三个标识和附件保持一致。相同工单、AppID 和版本环境复用数据库中的生成结果，包括成功回执丢失或服务重启。切换账号或版本环境后按新范围生成，不覆盖原工单。多进程同时补生成时可发出重复的上游调用，数据库只保留最先保存的码。
- 本地自动测试通过构造参数 `wechatCode.fetchImpl` 注入模拟上游，内存和临时 SQLite 仅使用合成数据。真实账号授权、返回图片类型和扫码进入设定版本的页面留待账号联调。

## 游客公开申报

`POST /api/v1/public/cases` 是小程序「游客诉求」页使用的第一方入口，不需要接入凭据，也不校验
Authorization：请求携带凭据时同样按匿名申报处理。请求体与接单接口一致，为 `multipart/form-data`，
含且仅含一个 `payload` 文本 part（JSON），可带 0 至 3 个 `photos` 文件 part。

| payload 字段 | 要求 | 格式和上限 |
| --- | --- | --- |
| `clientRequestId` | 必填 | 字符串，128 字符，由小程序生成，不同申报取值不同，重试复用原值 |
| `occurredAt` | 必填 | 带时区的日期时间，例如 `2026-11-19T09:00:00+08:00`，最多三位小数；存储为 UTC |
| `location` | 必填 | 发生地点，300 字符 |
| `category` | 必填 | 问题类别，80 字符，本地接收文本 |
| `description` | 必填 | 申报描述，4,000 字符 |
| `suggestedDepartment` | 可选 | 建议部门，100 字符，由值班人员最终分派 |
| `contact` | 可选 | 联系方式文本，300 字符，单独存储且不进入公开查询 |

选填项没有值时省略，不要传空字符串。照片类型、签名和大小校验与接单接口相同，最多 3 张、每张 5 MiB，
整包上限 15 MiB + 64 KiB。

- 去重键固定为 `clientRequestId`。比较口径与接单接口相同：文本去首尾空白，`occurredAt` 归一化为 UTC，
  照片按声明类型和内容摘要比较，照片顺序和文件名不参与比较。首次保存返回 201，同一键和相同内容重放
  返回 200 和原回执，库内仍只有一单一份附件；同一键提交不同内容返回 409 `submission_conflict`，原单不变。
- 工单来源固定为 `miniprogram`，建单事件记为 `actor_type='public'`、`actor_id='miniprogram'`。
- 回执为 `caseNumber`、`publicLookupCode`、`privateLookupToken` 三个字段，启用微信小程序码时同接单接口
  一样附 `wechatCode`。`privateLookupToken` 只在提交成功的会话中展示，不得写入 URL、二维码、日志或埋点。
- 按对端地址做窗口限流，默认每 600 秒只统计 10 次新建建单。只有新建建单受上限约束：
  已成功单号的重放（内容一致返回 200，内容不同返回 409）不消耗额度，也不受当前窗口上限影响，
  用户始终能拿回自己的回执。超限的新建请求返回 429 `too_many_requests` 和 `Retry-After`（秒）；
  限流判断在建单事务内执行，被限流的请求整笔回滚、不落库。计数保存在服务进程内，多实例部署时按实例各算一份。
  限流窗口长度和上限通过 `createIntakeServer` 的 `publicRateLimit: { windowSeconds, limit }` 注入，
  计时复用注入的 `now`。
- 400 表示字段、JSON 或 multipart 结构错误，409 表示同一键内容冲突，413 表示照片或整包超限，
  415 表示媒体类型或文件签名不符，429 表示超出限流窗口，503 表示上传并发已满或数据库繁忙。
  收到 503 或超时时保留原 `clientRequestId` 及原内容重试。

## 停车预测与推荐（本地）

停车相关接口使用合成示范数据，`source` 固定为 `synthetic`，不是真实车场余位。页面和运营台必须标注「模拟」，不得把静态信息或合成预测说成实时余位。接口契约以 [OpenAPI](../docs/openapi.yaml) 为准，三个公开接口均匿名、只读，不要求 Bearer；按对端地址做窗口限流，默认每 600 秒 60 次，超限返回 429 `too_many_requests` 和 `Retry-After`（秒），响应统一带 `Cache-Control: no-store`。

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/public/parking/lots` | 车场目录及计费、通行、步行距离等静态信息 |
| `GET /api/v1/public/parking/recommendations` | 按 `destination_id`、`arrive_at` 等参数推荐车场，含首选、备选、排除原因 |
| `GET /api/v1/public/parking/lots/{lot_id}/forecast` | 单个车场未来 15、30、45、60 分钟的余位预测 |

运行时数据装载失败时进程照常启动，接口仍返回 200，`available` 为 `false`、`degraded` 为 `true`，并在 `note` 写明原因，静态车场信息照常给出。`arrive_free` 为 `null` 表示预测不可用，不是 0。

| 服务端环境变量 | 值 |
| --- | --- |
| `CHANGDI_PARKING_DIR` | 运行时数据目录，覆盖服务内置副本 |
| `CHANGDI_PARKING_RATE_LIMIT` | 限流窗口 JSON，例如 `{"windowSeconds":600,"limit":60}` |

```powershell
$env:CHANGDI_PARKING_DIR = 'C:\path\to\parking-runtime'
$env:CHANGDI_PARKING_RATE_LIMIT = '{"windowSeconds":600,"limit":60}'
npm.cmd start
```

浏览器端不直连后端，统一走 [guide-bridge](../guide-bridge/README.md) 的 `/bridge/parking/*` 同源代理：`/bridge/parking/lots`、`/bridge/parking/recommendations`、`/bridge/parking/lots/{lot_id}/forecast`。代理只透传白名单参数与上游状态码和 JSON，不注入 token；上游不可达返回 502 `{"error":"unavailable"}`。

用合成数据复核接口与预测管线，测试以临时目录和随机端口启动服务：

```powershell
npm.cmd test
```

将 `CHANGDI_PARKING_DIR` 指向另一份运行时目录即可切换到对应数据，无需改动代码。数据字段、错误码和示例详见 [OpenAPI](../docs/openapi.yaml) 与 [停车接口接入说明](../docs/parking-api.md)。

## 代码目录

- `src/server.js` 负责监听、路由分派、上传并发总量及统一错误响应。
- `src/routes/` 按接单与微信会话、游客公开申报与公开查询、本人、商户、管理方分组。路由处理请求与授权，办理规则留在对应业务模块。
- `src/http.js` 提供请求格式校验和响应头。JSON、回执及私有图片响应统一禁止缓存，并禁止浏览器发送来源地址。
- `src/public-rate-limit.js` 按对端地址统计游客公开申报的限流窗口，只计新建建单。
- `src/store.js` 负责工单写入事务。角色、办理、附件和月报模块负责各自的数据访问与规则。
- `migrations/` 保存顺序迁移。`test/` 包含按业务和权限的检查、游客公开申报检查以及三窗口同单验收。

## 小程序内部调用

- `POST /api/v1/public/cases` 供小程序游客诉求页匿名申报，不要求凭据，契约见「游客公开申报」。
- `GET /api/v1/public/cases/{publicLookupCode}` 匿名可用。响应字段为 `caseNumber`、`status`、`milestones`，每个节点只有状态与 UTC 时间。待复核期间对公众显示处理中。
- `GET /api/v1/staff/cases/{caseNumber}` 使用工作人员 Bearer，返回受权限约束的工单明细、当前 `version` 和流转历史。
- `POST /api/v1/staff/cases/{caseNumber}/actions` 使用工作人员 Bearer，提交 `application/json`。每次请求附当前 `expectedVersion`。状态已改变时返回 409，重新读取工单后再决定是否操作。

### 管理方和商户微信登录

服务端入口默认关闭，回环开发继续使用原有工作人员和商户测试口令。项目方启用 `CHANGDI_WECHAT_LOGIN_ENABLED=1` 后，工作人员和商户只接受项目签发的微信登录会话，目录中的 `token` 字段会被忽略并可省略。合作方接入凭据和原提交人核验继续走各自的授权路径。微信登录开关和小程序码开关相互独立。

后续小程序通过 `wx.login` 获取一次性登录码，再调用内部 `POST /api/v1/auth/wechat/session`。请求使用 `Content-Type: application/json`，不带 Authorization，JSON 仅含字符串字段 `code`，角色、部门、商户和 OpenID 均由服务端确定。服务端以固定 HTTPS 地址调用 `code2Session`，仅使用返回的 OpenID 匹配项目方预先批准的绑定。上游请求包含响应体在内限时 3 秒，最多读取 16 KiB，拒绝重定向。微信登录码、OpenID、session_key、AppSecret 和上游错误详情均不写入应用日志或返回给小程序。[wx.login 官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html) · [code2Session 官方文档](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html)

- 成功返回 200、`Cache-Control: no-store` 和 `{ sessionToken, expiresAt, identity }`。令牌为项目签发的短期 Bearer，有效期 15 分钟。工作人员的 `identity` 为 `{ type: "staff", id, role, department }`，值班人员的 `department` 为 `null`。商户成员的 `identity` 为 `{ type: "merchant", merchantId, permissions }`。按身份调用现有内部接口，`sessionToken` 只放 Authorization 头。
- 无绑定、微信拒绝登录码或同一进程重放均返回 401 `wechat_login_denied`。请求字段错误返回 400，上游暂不可用或本地容量已满返回 503 `wechat_login_unavailable` 与 `Retry-After: 1`。关闭时该路径返回 404。登录失败或连接中断后先重新调用 `wx.login` 获取新码，再尝试登录。尝试过的码只保留摘要，在后续登录时清理五分钟前的记录。每进程最多同时八个上游交换、8,192 条防重放记录及 4,096 个有效会话。
- 每次请求重新读取会话对应的项目身份，再执行原有工单、部门、商户及权限校验。读完异步写入请求体后再次检查授权。会话摘要只存放在服务进程内，绑定和授权目录以启动配置为准。运营调整或取消绑定后须更新配置并重启全部实例，旧会话随重启失效。当前没有热更新、逐枚撤销接口或共享会话库。

实际联调前需项目方交付同一小程序 AppID 下的已审批 OpenID 对照表和目录权限，通过受控配置注入，勿写入仓库或联调日志。

| 服务端环境变量 | 所需资料 |
| --- | --- |
| `CHANGDI_WECHAT_LOGIN_ENABLED` | 默认 `0`，授权联调时配置 `1` |
| `CHANGDI_WECHAT_APP_ID`、`CHANGDI_WECHAT_APP_SECRET` | 同一小程序的账号与服务端密钥 |
| `CHANGDI_STAFF_JSON` | 已批准工作人员的内部 `id`、`role`，以及主管或承办人的 `department` |
| `CHANGDI_MERCHANTS_JSON` | 已批准成员的内部 `id`、所属 `merchantId` 及 `permissions` |
| `CHANGDI_WECHAT_IDENTITY_BINDINGS_JSON` | 数组，每项仅含 `{ openid, type, id }`。`type` 为 `staff` 或 `merchant`，`id` 引用对应目录。同一 AppID 下一个 OpenID 只能绑定一个身份 |

本轮仅用 `wechatLogin.fetchImpl` 注入模拟微信响应并运行本地回环测试。真实账号换码、小程序前端接线及正式环境的网关限流、日志脱敏和多进程会话管理待联调或部署阶段验收。

### 管理入口、工作台和派单目录

下列接口使用本地工作人员 Bearer。A01 通过 `GET /api/v1/staff/me` 读取 `{ id, role, department }`。角色为 `duty`（值班）、`supervisor`（主管）或 `handler`（承办），值班账号的 `department` 为 `null`。值班人员可见全部工单，主管可见本部门工单，承办人只看本部门且分派给本人的工单。详情、列表、计数和分页游标均以当前归属为准。

- A02 调用 `GET /api/v1/staff/workbench`。响应含 `asOf`（服务端 UTC 时间）、`dueSoonSeconds`（86400）与 `counts`。下面每个队列都有独立计数，空队列为 0。
- A03 调用 `GET /api/v1/staff/cases`，例如 `?queue=due_soon&limit=20`。可选参数为下表中的 `queue`、精确的 `status`、`department`、`assignee`、`before` 和 `limit`。筛选条件取交集，省略队列时包含权限范围内各状态。默认每页 20 条，允许 1–50 条。
- 列表返回 `{ asOf, items, nextBefore }`。每项含 `caseNumber`、`status`、`category`、`sourceType`（`merchant` 或 `integration`）、`department`、`assignee`、`dueAt`、`deadlineState`。地点和申报详情从 A04 读取。列表按建单顺序从新到旧，继续分页时保留筛选并传回 `nextBefore`；`null` 表示当前没有下一页。各页反映请求时的状态与权限；刷新首屏可获取最新入列的工单。游标不存在或已失去该单权限时统一返回 400 `invalid_cursor`，此时重新加载首屏。
- A06／A09 调用 `GET /api/v1/staff/assignees`。值班人员可见所有部门的承办人，主管仅见本部门承办人，承办人调用返回 403。响应为 `{ items: [{ id, department }] }`。派单时使用 `id` 作为 `assignee`，写操作继续执行原权限检查。

| 队列参数及计数字段 | 范围 |
| --- | --- |
| `pending_intake` | 待受理 `submitted` |
| `pending_assignment` | 待分派 `accepted` |
| `processing` | 已分派 `assigned` 或处理中 `processing` |
| `pending_review` | 待复核 `awaiting_review` |
| `pending_reopen` | 补办待审核 `reopen_pending` |
| `due_soon` | 当前办理期限大于 `asOf`，且在未来 24 小时内（含窗口上界） |
| `overdue` | 当前办理期限小于或等于 `asOf` |

期限仅适用于有 `dueAt` 的已分派、处理中及待复核工单。更远的有效期限显示 `on_track`。其余状态的列表 `dueAt`、`deadlineState` 为 `null`，包括已过评价期仍待评价、已办结和等待补办审核的工单。期限队列会与状态队列重叠。此处采用固定 24 小时预警窗口，分阶段时限规则、提醒与自动升级、试点身份验证和统计月报留待后续。

### 本人核验、详情和操作

1. T02 用公开码查进度。进入 T03 后调用 `POST /api/v1/owner/verify`，将 `{"publicLookupCode":"…","privateLookupToken":"…"}` 放在 JSON 请求体。核验请求不带 `Authorization`。成功响应给出 `caseNumber`、`ownerSessionToken` 和 UTC 格式的 `expiresAt`。错误凭证或与工单不匹配统一返回 401 `invalid_private_lookup_token`。
2. T04 调用 `GET /api/v1/owner/cases/{caseNumber}`，带 `Authorization: Bearer <ownerSessionToken>`。这个授权只对返回的工单编号有效，30 分钟后失效。失效或越权返回 401 `owner_authorization_required`，客户端清除本人数据并回到 T02。私密凭证仅在 T03 输入和发送，核验完成即清空。本人授权只放在当前会话内存，私密凭证与授权均不得写进 URL、分享、日志或持久缓存。
3. 详情响应含 `caseNumber`、`status`、`version`、`round`、`evaluationEndsAt`、`reopenEndsAt`、`availableActions`、`history`、`rounds` 和 `reopenRequests`。每轮含 `round`、`feedback` 和 `evaluation`。未发布时 `feedback` 为 `null`，发布后含 `summary`、`publishedAt` 和 `photos`，文字发布的 `photos` 为空。未评价时 `evaluation` 为 `null`，已评价时包含三项分数、`comment` 及 `submittedAt`。补办记录包含 `round`、`previousStatus`、`reason`、`requestedAt`、`decision`、`decisionReason` 和 `decidedAt`，待审核时决定相关字段为 `null`。内部送审和退回草稿不出现在本人时间线。
4. T04／T06／T07 调用 `POST /api/v1/owner/cases/{caseNumber}/actions`，使用同一本人授权。请求体包含 `action`、详情返回的 `expectedVersion` 和该动作需要的字段。成功返回更新的本人详情。客户端依据 `availableActions` 显示按钮，服务端每次复核状态、时限和版本。

| 本人动作 | 请求附加字段 | 成功结果 |
| --- | --- | --- |
| `evaluate` | `speed`、`effectiveness`、`attitude` 各为 1–5 的整数，可选 `comment`（1,000 字符） | 待评价且期限内，每轮存一份，工单仍处于待评价 |
| `confirm_resolved` | 无 | 待评价 → 已办结，可独立确认，未评分仍记为未评价 |
| `request_reopen` | `reason`（必填，1,000 字符） | 待评价或已办结且补办期内 → `reopen_pending`（补办待审核） |

收到 `stale_version`、`evaluation_exists` 或写入超时时先刷新详情确认结果。截止后分别返回 409 `evaluation_window_expired` 或 `reopen_window_expired`。状态已改变且当前动作不适用时返回 409 `invalid_transition`。公开接口始终只返回公开进度，合作方凭据也无法调用本人接口。

本人核验的失败限次按直连来源 IP 计数，各监听实例共享 SQLite 计数。同一来源 15 分钟内累计 10 次失败后，核验返回 429 及 `Retry-After` 秒数。知道公开码的人无法锁住该工单在其他来源的核验，同一 NAT 内会共用来源额度。服务不信任任意客户端转发头。生产需在可信入口识别真实来源，配置网关速率限制和异常监控，防护多来源流量与共享出口误伤。

### 管理办理和补办审核

| 动作 | 角色 | 状态与附加字段 |
| --- | --- | --- |
| `accept` | 值班人员 | 已提交 → 已受理 |
| `reject` | 值班人员 | 已提交 → 不予受理，`reason` |
| `request_supplement` | 值班人员 | 外部申报已提交 → 待补充材料，`reason` |
| `assign` | 值班人员 | 已受理 → 已分派，`assignee`、`dueAt` |
| `reassign` | 值班人员或本部门主管 | 已分派、处理中或待复核 → 已分派，`assignee`、`dueAt`、`reason` |
| `start` | 当前承办人 | 已分派 → 处理中 |
| `submit_result` | 当前承办人 | 处理中 → 待复核，`summary`、`photoOmissionReason` |
| `return_result` | 本部门主管 | 待复核 → 处理中，`reason` |
| `publish` | 本部门主管 | 待复核 → 待评价，`summary`，开始评价窗口 |
| `close` | 本部门主管 | 评价窗口届满且状态为待评价 → 已办结，`reason` |
| `approve_reopen` | 当前主责部门主管 | 补办待审核 → 新一轮，提交本部门 `assignee`、`dueAt` 与 `nextStatus`（`assigned` 或 `processing`） |
| `reject_reopen` | 当前主责部门主管 | 补办待审核 → 还原申请前的待评价或已办结，提交 `reason` |

分派示例为 `{"action":"assign","expectedVersion":2,"assignee":"handler-a","dueAt":"2026-11-20T10:00:00+08:00"}`。承办人必须来自服务端目录，主责部门从目录取得。值班人员可跨部门分派，主管转派限本部门。期限须晚于操作时间。说明上限 4,000 字符，原因上限 1,000 字符。动作记录操作者、时间、状态和原因。工作人员接口不提供联系人及申报原图。

A09 从管理明细读取 `reopenRequests` 中 `decision: null` 的申请和 `rounds` 历轮结果。审核沿用管理动作的 `expectedVersion`。批准后工单编号、公开码和本人授权范围保持一致，轮次加一，新一轮重新办理。驳回保留原轮次与截止时间，提交人可在本人详情查看理由。历史反馈、评分及申请保留在原工单。

### A07／A08 承办照片送审

- 继续使用 `POST /api/v1/staff/cases/{caseNumber}/actions`。当前承办人在 `processing` 工单上可发送 JSON 文字结果及必填的 `photoOmissionReason`，也可以用 `multipart/form-data` 送审照片。
- multipart 的 `payload` 为唯一的 JSON 文本字段，例如 `{"action":"submit_result","expectedVersion":4,"summary":"现场已处理"}`。附 1–3 个重复 `photos` 文件字段，此时省略 `photoOmissionReason`。文件复用接单的 JPEG、PNG、WebP 签名和大小校验。照片、流转记录及状态同一事务写入，成功返回 200 和 `awaiting_review` 管理详情，旧版本返回 409。超时后先刷新详情核对送审结果。
- 当前承办人、本部门主管的详情含 `submissionPhotos`，每项含 `round`、`submitVersion`（此次送审成功后的工单版本）、`position`（从 0 开始）、`mediaType` 及 `size`。读取使用 `GET /api/v1/staff/cases/{caseNumber}/submission-photos/{submitVersion}/{position}`，携带工作人员 Bearer。成功返回私有二进制响应，同时标记 `no-store`。归属按读取时重新判断，新承办范围可查同一工单历轮送审图，转派后失去范围的旧人员返回 404。值班人员无送审图权限，公开、本人、商户和合作方接口也不提供送审图。

### A08 发布反馈衍生图片

- 当前主责部门主管在 `awaiting_review` 调用 `POST /api/v1/staff/cases/{caseNumber}/actions`。JSON `publish` 继续发布文字。发布图片使用 multipart，`payload` 为 JSON 文本，例如 `{"action":"publish","expectedVersion":5,"summary":"现场已处理","derivativesReviewed":true}`，并上传 1–3 张已人工脱敏、检查合规的独立衍生图片，每张一个 `photos` 文件字段。后端拒绝原图引用字段及缺少明确确认的上传。主管确认记入发布事件。
- 本地只处理合成图和人工脱敏发布流程。衍生文件输入限 8 位 RGB、非隔行 PNG，每个维度最多 2048 像素，输入和重编码后的文件均不超过 5 MiB。服务端校验 PNG 块和校验和，解压受限的图像数据，再写出只含 `IHDR`、`IDAT`、`IEND` 的 PNG。允许的文字、EXIF 和色彩等附加块会被丢弃，带透明度、动画或未知块的输入会被拒绝。上传和重编码结果的 SHA-256 均与本单原申报附件及历轮本人补件、承办送审和协办原图比对，匹配返回 409 `feedback_original_not_allowed`。
- 重编码处理文件结构和附加元数据。画面中的姓名、号码、人脸、车牌等仍须人工遮盖和检查，摘要无法证明内容已脱敏，也不能覆盖所有重新编码的原图。生产图片审核、存储权限、保留和删除规则留待部署批次。
- 文字、衍生图片、状态和发布事件在同一事务提交。事件的版本和轮次确定图片归属。本人详情各轮 `feedback.photos` 含 `publishVersion`、`position`、`mediaType`、`size`；本单有效本人 Bearer 可通过 `GET /api/v1/owner/cases/{caseNumber}/feedback-photos/{publishVersion}/{position}` 读取对应 PNG，`position` 从 0 开始。响应标记 `Cache-Control: no-store`。凭证只放授权头。未发布及不存在的图片返回 404，授权过期、跨单或使用其他角色凭据返回 401。公开进度、合作方和商户均无图片访问。
- 新轮次可以另行发布，新旧轮图片按原发布版本独立留存。前端衍生图选择和查看留待接入。

### A05／T05 补件

- A05 使用工作人员 Bearer 调用 `POST /api/v1/staff/cases/{caseNumber}/actions`，在 `submitted` 工单提交 `{"action":"request_supplement","expectedVersion":1,"reason":"请补充问题发生的具体时段"}`。面向本人的 `reason` 必填，最多 1,000 字。成功返回 200 和新的管理详情，状态为 `awaiting_supplement`（待补充材料）。
- T04 本人详情在待补充材料时提供 `availableActions` 中的 `submit_supplement` 与 `supplementRequirement: {reason, requestedAt}`。T05 使用当前工单的本人 Bearer 调用 `POST /api/v1/owner/cases/{caseNumber}/actions`，提交 `{"action":"submit_supplement","expectedVersion":2,"summary":"问题出现在上午十点左右"}`。说明必填，最多 4,000 字。成功返回 200 和更新后的本人详情，状态回到 `submitted`，清除当前补件要求，原编号及轮次保持。值班人员可重新受理或继续要求补件。
- 带图时使用同一路径和 `multipart/form-data`，上述 JSON 放入唯一的 `payload` 文本字段，另附 1–3 个重复的 `photos` 文件字段。文件沿用 JPEG、PNG、WebP 签名校验和每张 5 MiB 限制。multipart 仅接受 `submit_supplement`，无图时继续用 JSON。工单状态、补件事件和照片在同一事务提交。补件日期和轮次以该次提交事件为准。
- 管理明细的 `history` 在对应事件 `detail.reason` 和 `detail.summary` 记录原文。本人详情的对应事件使用 `reason` 和 `summary`。公开查询仅列状态和时间节点，原因、说明、联系方式及照片均在公开响应之外。
- 有照片时，本人及授权管理详情提供 `supplementPhotos`，每项仅含 `round`、`submitVersion`（补件成功后的工单版本）、`position`（从 0 开始）、`mediaType`、`size`。本人按需调用 `GET /api/v1/owner/cases/{caseNumber}/supplement-photos/{submitVersion}/{position}`，工作人员使用相同路径结构的 `/api/v1/staff/cases/`。两条路径均需各自的 Bearer 授权头，返回私有二进制并标记 `Cache-Control: no-store`。
- 本人有效授权可查看本单历轮补件图。管理读取限当前有该单业务范围的值班人员、当前承办人和主责部门主管。失去归属的工作人员、本单不存在的版本或照片返回 404；跨单或过期本人凭据、匿名和其他角色凭据不能访问。补件原图单独存储，并纳入发布反馈的原图比对。
- 待补充材料的事项从待受理队列及计数移出，管理列表可用 `status=awaiting_supplement` 查找。本人补件成功后，原单回到 `pending_intake`。
- 本人授权过期或越权返回 401。授权过期时先回到核验入口，再用原回执核验并刷新当前详情。版本过旧返回 409 `stale_version`，当前状态不允许动作返回 409 `invalid_transition`。超时或 409 时先刷新，核对历史是否已有该笔请求或补件，再决定是否操作。补件沿用本人授权时限，当前没有独立的业务补件截止时间。
- 商户原提交人的本人授权尚未接入，商户工单的 `request_supplement` 返回 409 `supplement_owner_unavailable`，原单可继续正常受理。小程序的补件选图和预览留待接线。

### 商户窗口

商户用独立的 `Authorization: Bearer <本地测试令牌>`。B01 调用 `GET /api/v1/merchant/me` 获取 `merchantId` 及 `permissions`。同一商户可配置多个成员，每个账号使用独立令牌，并按需授予 `readCases`、`submitCases`、`collaborate`。绑定及授权由服务端配置确定，调整后重启本地服务。工作人员、商户、接入方凭据不能互用。

| 页面 | 内部接口 | 字段与权限 |
| --- | --- | --- |
| B02 本商户工单 | `GET /api/v1/merchant/cases` | `readCases`。返回 `{ items, nextBefore }`，每项含 `caseNumber`、`status`、`submittedAt`。可传 `status` 筛选，用返回的 `nextBefore` 作下一页 `before`；每页最多 50 条。待复核按 `processing` 展示并筛选。 |
| B03 新诉求 | `POST /api/v1/merchant/cases` | `submitCases`。multipart 的 `payload` 为 JSON 文本，必填 `clientRequestId`、`occurredAt`、`location`、`category`、`description`，可选 `contact`。可重复附 `photos`，沿用接单的文件校验和大小限制。 |
| B04 工单详情 | `GET /api/v1/merchant/cases/{caseNumber}` | `readCases`。在列表字段之外返回 `round`、`occurredAt`、`location`、`category`、`description`、`history` 和已发布的 `feedback`。 |
| B05 协办待办 | `GET /api/v1/merchant/collaborations` | `collaborate`。返回 `{ items, nextBefore }`。每项有 `taskId`、`instructions`、`dueAt`、`status`、`version`，下一页使用 `before`。 |
| B06 协办详情 | `GET /api/v1/merchant/collaborations/{taskId}` | `collaborate`。追加展示单独授权的 `location`、`latestSubmission`、退回时的 `returnReason`。 |
| B06 协办送审 | `POST /api/v1/merchant/collaborations/{taskId}/submissions` | `collaborate`。JSON 或 multipart 送审，待提交或退回 → 待复核，返回更新后的任务详情。 |

商户新单进入与外部申报共用的管理受理流程。B03 返回 `caseNumber`、初始 `status: submitted` 和 `submittedAt`。同一商户成员使用同一个 `clientRequestId` 和相同内容可重试，首次返回 201，重试返回 200，复用编号但改变内容返回 409。B04 读当前状态。协办不会把原单加入参与商户的工单列表。商户接口只按当前绑定查询，其他商户记录返回 404；关联工单原始申报、联系方式、原图、私密回执、承办账号和本人评价不随协办任务返回。

### 小程序商户页面

小程序侧商户页面在 `miniprogram/pages/merchant/`，请求封装与视图归一化在同目录的 `merchant.js`，页面与本地模拟检查共用该模块。

- 本地入口沿用 `miniprogram/config.js` 的 `apiBaseUrl`，只有回环地址（`127.0.0.1` 或 `[::1]`）允许输入测试令牌。令牌用密码框输入，只放在页面内存，作为 `Authorization` 头发送，不进入网址、日志或持久缓存；退出、页面隐藏或失权时清除。
- 登录后调用 B01 读取绑定商户与授权，页面按 `readCases`、`submitCases`、`collaborate` 分别显示工单列表、工单详情与协办待办。无对应权限时不发出该类请求。
- 工单列表与协办待办都用 `nextBefore` 翻页；游标失效返回 400 `invalid_cursor` 时重新读取第一页。
- 工单详情展示编号、状态、轮次、时间线与已发布反馈。协办详情展示协办事项、必要地点、期限、最近送审说明与退回理由，不含原工单申报内容。
- 协办页面当前提交 JSON `{ expectedVersion, summary }`，使用详情返回的任务版本；版本冲突时先刷新任务再决定。照片接口可用于后续接线。

本批未接通：商户新诉求表单（B03）与照片上传、协办照片上传、商户本人核验与评价、统计月报。

### 管理侧协办

- `GET /api/v1/staff/cases/{caseNumber}/collaborations` 返回 `{ items }`，当前有该单权限的工作人员可看任务及其操作记录。
- `POST /api/v1/staff/cases/{caseNumber}/collaborations` 由值班人员或本部门主管调用。仅在工单已分派或处理中可创建，JSON 提供工单的 `expectedVersion`、具协办权限的 `merchantId`、`instructions`（最多 1,000 字符）、未来的 `dueAt` 和可选的必要 `location`（最多 300 字符）。成功返回 201、任务详情及新的 `caseVersion`。主单状态保持，版本递增以防并发重复派发。
- `POST /api/v1/staff/cases/{caseNumber}/collaborations/{taskId}/actions` 由当前主责部门主管调用。JSON 含任务的 `expectedVersion` 和 `action`，`approve` 通过，`return` 退回补充，`withdraw` 撤回非终态任务。退回与撤回附 `reason`（1–1,000 字符）。送审、审核和撤回只更新任务状态与任务版本，主单继续由原管理流程控制。

商户可处理当前工单轮次中还在办理阶段的已派任务。已通过任务移出待办，已撤回和停止办理的任务同时撤下商户详情入口。跨部门转派后，任务审核权限随主责部门更新。截止时间用于显示和跟进，本地未自动阻止逾期提交。版本冲突时刷新相应的工单或任务再决定操作。

### 协办送审原图

- 继续使用 `POST /api/v1/merchant/collaborations/{taskId}/submissions`。获派商户使用 `collaborate` 授权。JSON `{ expectedVersion, summary }` 保持可用。multipart 使用一个 `payload` 文本字段，内容同 JSON，附 1–3 个重复的 `photos` 文件字段。说明必填且最多 4,000 字，文件复用 JPEG、PNG、WebP 签名与 5 MiB 单张限制。超时或 409 时先刷新任务和送审记录再决定重试。
- 成功返回 200。任务版本、送审历史与原图同事务更新，主工单状态和版本保持。任务详情的 `submissionPhotos` 内部元数据仅含 `submitVersion`（送审成功后的任务版本）、`position`（从 0 开始）、`mediaType`、`size`；纯文字项无照片。图片按任务和版本保存，包含该有效任务历次送审。
- 获派商户通过 `GET /api/v1/merchant/collaborations/{taskId}/submission-photos/{submitVersion}/{position}` 读取。当前承办人和当前主责部门主管通过 `GET /api/v1/staff/cases/{caseNumber}/collaborations/{taskId}/submission-photos/{submitVersion}/{position}` 读取，也可从管理侧协办列表取获授权任务的元数据。两条路径携带各自 Bearer，返回 `no-store` 二进制。值班角色、非获派商户、公开、本人、合作方无原图读取权限。
- 当前轮次且主单为已分派、处理中或待复核时可读尚未撤回的任务。已通过任务仍可从直达详情读取，直至办理阶段结束。转派后原主责范围外的人员失权，当前承办人及主责部门主管按新归属读取，获派商户仍按原任务授权。撤回、结束办理或开启新轮次后，旧任务原图与元数据停止对商户和工作人员提供，管理端文字历史仍可查询。协办原图保存在独立表内，禁止直接作为本人发布图。

## 本地存储和下一批

- `cases` 以来源与外部单号做唯一约束；`case_contacts` 对工单是一对一关系；`attachments` 和 `case_events` 是一对多。照片字节和附件索引同表存储。SQLite 事务同时提交工单、联系方式、附件和初始事件，状态变化与事件同样原子提交。数据库没有静态文件或图片访问路由。
- 本地启动按版本自动应用迁移。v1 升 v2 时保留工单主键、回执、附件和事件，旧反馈作为第一轮，补办截止时间根据原反馈发布时间回填。v3 新增商户归属、协办任务和任务事件三张表。v4 扩展工单状态约束。v5 增加关联到送审事件的照片表。v6 新增独立的发布图片表。v7 增加协办原图表。v8 增加关联到本人补件事件的原图表，原回执及文字补件保留。v9 增加可选的小程序码图片表，保存工单关联、AppID 的摘要、版本环境、图片 MIME 与字节。SQLite 在线备份可同时包含工单与附件，测试已用合成数据升级及恢复检查。正式存储、系统访问控制、监测、留存和恢复手册留待部署批次。
- 后续办理批次接入真实的工作人员与商户审核、商户原提交人的本人授权、微信身份绑定和跨会话的「我的诉求」、小程序补件照片、超时提醒。小程序扫码、外部平台联调和生产发布需真实环境验收。

## 内部月报

`GET /api/v1/staff/monthly-report?month=2026-11` 使用工作人员 Bearer。本地仅预置具全街区权限的值班角色可读。主管、承办、商户和合作方凭据返回 403，本人或无效凭据返回 401。仅允许 `month=YYYY-MM`，不接受部门参数或未来月份。响应只提供全街区汇总。

月份按北京时间区间取样，含月首、排除下月月首。响应 `period.start`、`period.endExclusive`、`asOf` 和 `monthEnd.cutoff` 均用 `+08:00`，取数时钟向下取整到秒，事件必须早于截点。月末快照以月份终点或当前取数时间的较早者回放，分别标记 `final` 或 `provisional`。同一工单同一时刻按事件版本排序。仅用历史事件的状态和派单期限，当前状态不会回填历史快照。

| 响应字段 | 口径 |
| --- | --- |
| `firstResponse` | 当月首次提交数、截点前有效人工响应及待响应数。中位数用自然经过分钟，另列 ≤1 小时、>1 至 24 小时、>24 小时三段。未响应不计入耗时。 |
| `completion` | 当月首次受理工单为分母。取数时最新一轮已发布为完成，获批补办之后尚未重新发布退出分子。 |
| `monthEnd` | 同一受理样本在快照时的未完成和超时。已分派、处理中、待复核且当时期限严格早于快照截点才算超时。无历史期限单列 `withoutDeadline`。应有期限却无证据的计入 `missingDeadlineEvidence`，并标记 `deadlineData: insufficient`。 |
| `reopen` | 申请按申请时间归月，通过、驳回及新轮按决定事件时间归月。只有通过补办开启新轮。 |
| `evaluation` | 当月已发布的去重工单轮次为分母。匹配取数前的评价，分别输出速度、效果、态度的 1–5 分分布、均分、有效评价数、覆盖率和未评价轮次。 |
| `duplicateComplaints`、`tourism` | 分别在缺结构化点位及确认记录、缺导览来源时返回 `unavailable` 及原因。 |

比例为 0–1 数值。分母为零时比例为 `null`，无适用样本的均值和中位数为 `null`，计数仍为 0。已用验收清单的六单合成样例核对首响中位数 60 分钟、受理完成率 2/3、月末未完成 2 单且超时 1 单及评价覆盖率 1/2。正式汇总授权、细分范围、小样本展示规则及外部数据源待试点确认。

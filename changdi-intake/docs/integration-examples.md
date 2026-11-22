# 外部平台联调样例（长堤风貌街 · 接诉即办）

本文档用于"长堤风貌街"接诉即办事项与**唯一合作方**之间的接口联调，是《实施验收清单》I01–I07、Q01–Q02 的配套样例说明。

> 说明：本文所有数据均为**虚构合成样例**，不含任何真实案件、真实人员、真实联系方式或真实凭据。文中出现的地址、编号、令牌、联系方式一律为占位值，仅用于说明报文结构与联调断言。

---

## 1. 联调范围与凭据

| 项 | 值 |
| --- | --- |
| 合作方 | `Partner-A`（外部平台"城市服务"入口，代号占位） |
| 联调接口（**唯一**） | `POST /api/v1/integrations/intake/cases` |
| 方法 | POST（其他方法返回 405） |
| 传输格式 | `multipart/form-data` |
| 认证 | `Authorization: Bearer <ACCESS_TOKEN>` |
| 接入凭据来源 | 由**长堤风貌街项目方**签发并线下交付合作方；合作方以服务端方式保存、可轮换、可单独撤换 |
| 凭据形态 | 32–256 位，字符集 `[A-Za-z0-9_-]`；本文只使用占位符，**不落地真实凭据** |
| 联调基址 | `https://intake-api.example-integration.test`（`.test` 为保留测试域名，非真实服务） |

**合作方在联调范围内只调用上述一个接口。** 案件查询、补材料、评价和补办均在微信小程序内办理，外部平台不另调查询接口；文中出现的 `publicLookupCode` 与 `privateLookupToken` 都是本接口**返回给合作方**的回执字段，合作方只负责展示，不据此发起二次调用。

### 1.1 与服务端现有实现的对应关系

本文样例的字段名、长度上限、照片限制、去重键与响应体，均对照 `changdi-intake/server` 现有源码书写，可直接比对：

| 本文条目 | 实现位置 |
| --- | --- |
| 路由、方法校验、认证顺序、并发保护、响应体 | `server/src/server.js` |
| `payload` 为 JSON 文本 part、字段名白名单、`photos` 重复字段 | `server/src/intake.js` |
| 字段长度上限、`occurredAt` 归一化、`contact` 为可选字符串 | `server/src/intake.js` `validatePayload`、`server/src/http.js` `readText` / `timestamp` |
| 照片数量、单张大小、类型与文件头校验 | `server/src/intake.js` `signatures` / `maxPhotos` / `maxPhotoBytes` |
| 去重键 `接入方 + externalCaseId`、内容哈希、稳定回执 | `server/src/store.js` `submit` / `receipt` |
| 接入凭据校验与撤换 | `server/src/auth.js` |

---

## 2. 请求报文

### 2.1 总体结构

请求体为 `multipart/form-data`，其中：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `payload` | JSON 文本（text part） | 是 | 案件主体内容，part 的 body 是 UTF-8 的 JSON 字符串，**不是** `application/json` 的独立 part；必须且只能出现 1 个 |
| `photos` | 文件（binary part） | 否 | 现场照片，**可重复字段**（同一字段名出现多次）；未上传时不携带该字段 |

- 请求体中除 `payload` 与 `photos` 之外的任何字段名一律拒绝；
- `payload` part 的 body 上限 32 KB；
- 整个请求体上限为 3 张照片各 5 MB 再加 64 KB 余量。

### 2.2 `payload` 字段

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `externalCaseId` | string | 是 | ≤ 128 字 | 合作方侧单号；与接入方身份组合构成去重键 |
| `occurredAt` | string | 是 | ≤ 40 字，ISO 8601 且必须带时区（`Z` 或 `±HH:MM`） | 事项发生时间，例 `2026-11-17T09:42:00+08:00`；服务端归一化为 UTC |
| `location` | string | 是 | ≤ 300 字 | 事项发生地点 |
| `category` | string | 是 | ≤ 80 字 | 事项分类。**当前服务端按自由字符串接收，不校验取值**；取值约定待联调时确认（见 §8 待定项） |
| `description` | string | 是 | ≤ 4000 字 | 事项描述 |
| `suggestedDepartment` | string | 否 | ≤ 100 字 | 合作方建议的承办部门，**仅作为输入记录，服务端当前不回传** |
| `contact` | string | 否 | ≤ 300 字 | 联系方式文本，可含姓名与电话；匿名提交时整体省略 |

说明：

- 除 `suggestedDepartment` 与 `contact` 外，其余字段缺失即判为非法；
- 所有字符串去除首尾空白后不得为空、不得包含 `\0`，且必须是合法的 Unicode 文本。**可选字段要么整体省略、要么给出非空字符串**，传空串会被拒绝；
- `payload` 中出现未定义字段（例如把 `category` 写成 `type`）会被拒绝，避免字段映射错位在联调期被掩盖；
- `contact` 是单个字符串，不接受对象结构。

### 2.3 照片（`photos`）规则

| 项 | 规则 |
| --- | --- |
| 数量 | 0–3 张；超过 3 张返回 413 `too_many_photos` |
| 单张大小 | ≤ 5 MB；超过返回 413 `photo_too_large` |
| 类型 | 仅 `image/jpeg`、`image/png`、`image/webp`；其他类型返回 415 `invalid_photo_type` |
| 内容校验 | 服务端按文件头（magic bytes）校验实际内容，与声明类型不符返回 415 `invalid_photo_type` |
| 字段名 | 固定 `photos`，多张时重复出现该字段名 |
| 顺序 | 按 part 顺序记录与展示 |
| 不传 | 省略全部 `photos` part，即 0 张照片，正常建单 |

### 2.4 响应约定

**成功响应体**（201 首次建单 / 200 幂等命中，两者响应体结构完全一致）：

```json
{
  "caseNumber": "CD-…",
  "publicLookupCode": "…",
  "privateLookupToken": "…"
}
```

只有这三个字段。除此之外服务端不返回状态、时间、部门、照片数等任何其他字段——合作方需要的其余信息应来自小程序侧，不得在本文假定。

**失败响应体**统一为：

```json
{
  "error": "machine_readable_code"
}
```

`error` 为小写下划线错误码字符串，没有 message、没有 requestId、没有 details。

| 状态码 | `error` | 场景 |
| --- | --- | --- |
| 400 | `invalid_payload_part` | `payload` part 不是字符串或超过 32 KB |
| 400 | `invalid_multipart` | 请求体不是合法的 multipart |
| 400 | `invalid_multipart_fields` | `payload` part 不是恰好 1 个，或出现 `payload`/`photos` 之外的字段名 |
| 400 | `invalid_json` / `invalid_json_object` | `payload` 不是合法 JSON，或不是 JSON 对象 |
| 400 | `unknown_field` | `payload` 含未定义字段 |
| 400 | `invalid_field` | 必填字段缺失、类型不符、超长、为空或含非法字符 |
| 400 | `invalid_timestamp` | `occurredAt` 不带时区、格式非法或不是真实存在的时刻 |
| 400 | `incomplete_body` | 上传过程中连接中断，请求体未收全 |
| 401 | `unauthorized` | 缺失、格式不符、未知或已撤换的接入凭据 |
| 403 | `forbidden` | 凭据类型不匹配（例如用工作人员凭据调用接入接口） |
| 405 | `method_not_allowed` | 对接入路径使用非 POST 方法 |
| 413 | `too_many_photos` / `photo_too_large` / `body_too_large` | 照片张数、单张大小或请求体超限 |
| 415 | `expected_multipart` | 请求体不是 `multipart/form-data` |
| 415 | `invalid_photo_type` | 照片类型不在允许集合，或内容与声明类型不符 |
| 503 | `intake_busy` | 同时在途的接入请求超过并发上限，响应带 `Retry-After: 1` |
| 503 | `database_busy` | 数据库繁忙，响应带 `Retry-After: 1` |
| 503 | `wechat_code_unavailable` | 工单及附件已保存，小程序码暂不可用。遵循 `Retry-After: 1`，用原单号和原内容重试 |
| 408 | `body_timeout` | 请求体上传超时（服务端等待约 15 秒） |
| 500 | `internal_error` | 服务端异常 |
| 404 | `route_not_found` | 路径不是接入接口 |

401 响应带 `WWW-Authenticate: Bearer`。

**可重试判定**：503 与 500 属服务端侧问题，可按同一 `externalCaseId`、同内容重试；4xx 是请求本身的问题，重试前须修正请求。

---

## 3. 固定样例数据

以下数据在 §4 三个场景中复用，保证可对照差异。

| 字段 | 样例值 |
| --- | --- |
| `externalCaseId` | `EXT-SAMPLE-000137` |
| `occurredAt` | `2026-11-17T09:42:00+08:00` |
| `location` | `长堤风貌街 88 号对街人行道` |
| `category` | `ROAD_SURFACE` |
| `description` | `人行道盲道砖块多处松动翘起，约 3 米长，行人易被绊倒。` |
| `suggestedDepartment` | `市政管理单位` |
| `contact` | `synthetic-contact-0001`（纯合成占位值，非真实可联系信息） |
| 照片 | 2 张，占位文件名 `sample-01.jpg`（JPEG）、`sample-02.jpg`（JPEG） |

服务端返回的三个标识（虚构样例）：

| 字段 | 样例值 | 形态说明 |
| --- | --- | --- |
| `caseNumber` | `CD-3F2A9C7E5B1D8406A9C4E7B2D5F80130` | `CD-` + 32 位大写十六进制 |
| `publicLookupCode` | `ebIZ7JBnxpMZbM6mFK5qRYnr` | 24 位 `[A-Za-z0-9_-]` |
| `privateLookupToken` | `pEkN37yDLjtSyY3I1Gc8u95cNeA6Dk-kvMEne-y_0oE` | 私密查询凭证，由服务端签发 |

---

## 4. 联调场景

### 4.1 场景一：首次提交（期望 201）

**请求**

```bash
curl -i -X POST 'https://intake-api.example-integration.test/api/v1/integrations/intake/cases' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -F 'payload={"externalCaseId":"EXT-SAMPLE-000137","occurredAt":"2026-11-17T09:42:00+08:00","location":"长堤风貌街 88 号对街人行道","category":"ROAD_SURFACE","description":"人行道盲道砖块多处松动翘起，约 3 米长，行人易被绊倒。","suggestedDepartment":"市政管理单位","contact":"synthetic-contact-0001"}' \
  -F 'photos=@./sample-01.jpg' \
  -F 'photos=@./sample-02.jpg'
```

> `photos` 出现两次即为重复字段；携带 0 张照片时省略全部 `photos` part。上例 `photos` 为本地占位文件，实际联调时替换为合作方提供的样例图片。占位符 `<ACCESS_TOKEN>` 需替换为项目方签发的真实凭据（32–256 位 `[A-Za-z0-9_-]`）。

**成功响应（201 Created）**

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

```json
{
  "caseNumber": "CD-3F2A9C7E5B1D8406A9C4E7B2D5F80130",
  "publicLookupCode": "ebIZ7JBnxpMZbM6mFK5qRYnr",
  "privateLookupToken": "pEkN37yDLjtSyY3I1Gc8u95cNeA6Dk-kvMEne-y_0oE"
}
```

**三个标识的用途**

| 字段 | 用途 | 可见范围 |
| --- | --- | --- |
| `caseNumber` | 平台侧工单编号 | 提交人可见、合作方可见 |
| `publicLookupCode` | 公开查询码，用于在小程序侧查看本单的公开进度 | 提交人可见、合作方可见；**不含任何私密信息** |
| `privateLookupToken` | **原提交人的私密查询凭证**，用于核验本人身份后查看完整反馈、补材料、评价与申请补办 | **仅原提交人**；不得进入公开二维码、URL、日志、埋点，也不得作为运营对账凭据（见 §5） |

**断言要点**

- 三个标识均非空且互不相同；
- `caseNumber` 与 `publicLookupCode` 在后续幂等重试中保持不变；
- 照片按 part 顺序全部入库，不丢失、不串号；
- **外部平台收到成功响应后才显示「提交成功」**；未收到成功响应时显示失败页，并保留可重试的原单号。

### 4.2 场景二：原单号 + 相同语义内容重试（期望 200）

**请求**：沿用同一 `externalCaseId`，**语义内容保持相同**即可重试——不需要 multipart 逐字节一致：

- `payload` 中的字段值相同，字段顺序、JSON 空白、`occurredAt` 的时区写法（如 `+08:00` 与 `Z` 表示同一时刻）均可不同；
- 照片内容相同即可，同一张图片的重新编码、或照片上传顺序调换，都不构成内容差异。

**响应（200 OK）**

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

```json
{
  "caseNumber": "CD-3F2A9C7E5B1D8406A9C4E7B2D5F80130",
  "publicLookupCode": "ebIZ7JBnxpMZbM6mFK5qRYnr",
  "privateLookupToken": "pEkN37yDLjtSyY3I1Gc8u95cNeA6Dk-kvMEne-y_0oE"
}
```

响应体与首次提交完全一致，合作方据此续取回执（含私密查询凭证），可在提交成功会话中继续展示。

**断言要点**

- 返回的三个标识与首次提交**完全一致**（回执稳定）；
- 不产生第二个工单，数据库仅有一张工单，附件与办理记录不重复；
- 覆盖三种触发场景：用户重复点击、并发相同请求、服务端已保存但响应超时；
- 5xx / 503 之后沿用原单号原样重试，同样命中幂等，不产生重复工单。

**判定规则（联调需逐条确认）**

服务端以**接入方身份 + `externalCaseId`** 组合作为去重键。命中已有工单后，比对由「归一化后的 `payload` + 照片集合（按类型与内容摘要）」计算出的内容哈希：

- 归一化包括：字符串去首尾空白、`occurredAt` 转为 UTC 时刻、可选字段缺失即不参与；
- 照片集合按内容摘要比对，**与上传顺序无关**；
- 哈希一致 → 幂等命中，返回 200 与原回执；
- 哈希不一致 → 走 §4.3，返回 409。

### 4.3 场景三：原单号 + 修改内容（期望 409）

**请求**：沿用 `externalCaseId = EXT-SAMPLE-000137`，修改 `location` 与 `description`，并将照片从 2 张减为 1 张，其余保持 §3 不变。

```bash
curl -i -X POST 'https://intake-api.example-integration.test/api/v1/integrations/intake/cases' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -F 'payload={"externalCaseId":"EXT-SAMPLE-000137","occurredAt":"2026-11-17T09:42:00+08:00","location":"长堤风貌街 90 号门前人行道","category":"ROAD_SURFACE","description":"人行道盲道砖块松动翘起，范围较首次上报扩大，行人通行存在安全隐患。","suggestedDepartment":"市政管理单位","contact":"synthetic-contact-0001"}' \
  -F 'photos=@./sample-01.jpg'
```

**与原单的差异（用于说明 409 触发点）**

| 字段 | 原单 | 本次提交 | 是否参与差异判定 |
| --- | --- | --- | --- |
| `externalCaseId` | `EXT-SAMPLE-000137` | 同左 | 去重键，不作为差异项 |
| `location` | 长堤风貌街 88 号对街人行道 | 长堤风貌街 90 号门前人行道 | 是 |
| `description` | 约 3 米长 | 范围扩大 | 是 |
| `photos` | 2 张 | 1 张 | 是（按内容摘要比对） |
| `occurredAt` / `category` / `suggestedDepartment` / `contact` | — | 未变 | 否 |

**响应（409 Conflict）**

```http
HTTP/1.1 409 Conflict
Content-Type: application/json; charset=utf-8
```

```json
{
  "error": "submission_conflict"
}
```

**断言要点**

- 状态码为 409，`error` 为 `submission_conflict`；
- 409 时**不创建**新工单、**不覆盖**原单内容，原单的工单编号、公开查询码、私密查询凭证与附件保持不变；
- **去重键包含接入方身份**：另一个已授权接入方使用**相同** `externalCaseId` 可独立建单，不返回 409。

**收到 409 后的正确处理（重要）**

409 表示"**同一外部单号已经建过单**"，不是"这张单建错了"。外部平台此时应：

1. **先核对原单**——用首次响应中的 `caseNumber` / `publicLookupCode` 在小程序侧查看该事项的当前状态与处理进度；
2. 若用户确实需要更正原单内容，**不得**在同一事项上换一个 `externalCaseId` 重新提交，否则会造成同一事项重复建单；
3. 更正路径应走小程序内的**补材料 / 申请补办**流程，由项目方在原单上处理；
4. 若确认属于两个独立事项（例如同一地点的两个不同问题），再使用新的 `externalCaseId` 提交，并在提交前与用户确认。

---

## 5. 外部平台如何展示回执

回执由**合作方平台**渲染，字段来源为 §4.1 的成功响应。面向原提交人的展示与面向合作方运营人员的展示必须分层，**私密查询凭证严禁跨层使用**。

### 5.1 原提交人回执（提交成功会话内私下展示）

```
┌────────────────────────────────────────┐
│              提交成功                    │
│                                        │
│  工单编号   CD-3F2A9C7E5B1D8406A9C4E7B2D5F80130 │
│  查询码     ebIZ7JBnxpMZbM6mFK5qRYnr  │
│  照片       2 张已随单提交                 │
│                                        │
│  ── 下方分隔线以下为仅您可见的内容 ──      │
│                                        │
│  私密查询凭证（请截图保存，勿转发他人）      │
│  pEkN37yDLjtSyY3I1Gc8u95cNeA6Dk-kvMEne-y_0oE      │
│  凭此凭证可在小程序内核验本人身份，          │
│  查看完整反馈、补充材料、评价和申请补办。      │
└────────────────────────────────────────┘
```

展示规则：

1. 展示 `caseNumber` 与 `publicLookupCode`，用于公开查询本单进度；
2. `privateLookupToken` **仅在本人提交成功会话内展示**，并配"请截图保存、勿转发"的提示文案；它是**原提交人的私密查询凭证**；
3. `privateLookupToken` **不得**：进入公开二维码内容、进入任何 URL、写入日志或埋点、作为运营对账凭据记录或展示、存入平台侧长期后台列表；
4. `externalCaseId` 可在提交成功页小字显示，便于用户与平台客服核对，**但不作为查询凭据**；
5. 幂等重试（200）触发的回执与首次一致，展示文案相同，仅在平台侧标记"重试命中"，避免向用户重复提示"已提交"两次；
6. 公开查询码对应的页面**只可见编号、状态和明确允许公开的时间节点**，看不到原始描述、原始照片、精确地址、联系方式；私密查询凭证与公开查询码相互独立，二维码内容中不含私密查询凭证。

### 5.2 合作方运营端回执

运营端**只**保留定位原单所需的最小信息：

| 列 | 取值 |
| --- | --- |
| 合作方单号 | `externalCaseId` |
| 平台工单编号 | `caseNumber` |
| 公开查询码 | `publicLookupCode` |
| 照片数 | 由提交时的 `photos` 数量自行记录 |
| 提交结果 | 201 已建单 / 200 幂等命中 / 4xx、5xx 失败 |

- **不记录、不展示 `privateLookupToken`**——它是原提交人的私密凭证，不是运营对账凭据；
- 失败时展示 `error` 错误码与服务端返回的状态码，用于与服务端按 `externalCaseId` 排障；**失败回执不向用户展示技术细节**。

### 5.3 一致性要求

- 同一 `externalCaseId` 对应的 `caseNumber` 与 `publicLookupCode` 唯一且稳定，重试不变；
- 409 的用户侧文案须明确指向"该单号已受理，请查看原单进度"，**不得引导用户换号重交同一事项**；
- 私密查询凭证只出现在提交成功会话内，任何二次展示场景都要先确认查看者是原提交人。

---

## 6. 微信小程序码

项目方启用小程序码后，同一接单接口在 201 和 200 响应中随三个标识返回 `wechatCode`。默认本地回执沿用 §4.1 的三个字段。合作方无需增加请求字段，项目方负责配置账号和版本。

| 字段 | 值 |
| --- | --- |
| `wechatCode.envVersion` | `release` 正式版、`trial` 体验版或 `develop` 开发版 |
| `wechatCode.mediaType` | `image/jpeg` 或 `image/png` |
| `wechatCode.base64` | 标准 Base64，解码后为最多 1 MiB 的图片字节，无 data URL 前缀 |

收到图片时按 MIME 解码和展示。扫码进入 `pages/public/index`，场景值只有本单的 24 位 `publicLookupCode`。私密查询凭证仍只交原提交人，且与码分开展示。回执缺少小程序码字段时，展示原有公开码。

相同申报重试沿用原编号和公开码。成功回执丢失后，同一小程序账号与版本下可取回已保存的图片。返回 `wechat_code_unavailable` 时，原工单已保存。合作方在同一接口用原单号和原内容重试，收到 200 后再展示成功回执。接入方收到的错误只包含项目定义的错误码。

当前通过模拟微信上游和本地回环验证。待账号联调时由项目方按 [服务端配置](../server/README.md#可选微信小程序码)启用，再核对实际返回的 MIME、版本以及扫码是否打开原工单。

---

## 7. 联调检查清单

| # | 检查项 | 期望 | 状态 |
| --- | --- | --- | --- |
| 1 | 未带 `Authorization` 头提交 | 401，`unauthorized`，带 `WWW-Authenticate: Bearer` | ☐ |
| 2 | Bearer 填格式不符（少于 32 位 / 含非法字符） | 401，`unauthorized` | ☐ |
| 3 | Bearer 为未知凭据 | 401，`unauthorized` | ☐ |
| 4 | 凭据已撤换后再次调用 | 401，`unauthorized` | ☐ |
| 5 | 用工作人员凭据调用接入接口 | 403，`forbidden` | ☐ |
| 6 | 对接入路径使用 GET / PUT | 405，`method_not_allowed` | ☐ |
| 7 | 请求体不是 `multipart/form-data` | 415，`expected_multipart` | ☐ |
| 8 | `payload` 省略 `description` | 400，`invalid_field` | ☐ |
| 9 | `payload` 省略 `externalCaseId` / `location` / `category` | 400，`invalid_field` | ☐ |
| 10 | `payload` 省略 `occurredAt` | 400，`invalid_field` | ☐ |
| 11 | `occurredAt` 不带时区 | 400，`invalid_timestamp` | ☐ |
| 12 | `payload` 含未定义字段（如 `type`） | 400，`unknown_field` | ☐ |
| 13 | `payload` body 不是合法 JSON / 不是 JSON 对象 | 400，`invalid_json` / `invalid_json_object` | ☐ |
| 14 | `payload` 出现 0 个或 2 个 part | 400，`invalid_multipart_fields` | ☐ |
| 15 | 请求体出现 `payload`/`photos` 之外的字段名 | 400，`invalid_multipart_fields` | ☐ |
| 16 | `payload` 省略 `suggestedDepartment` | 201，正常建单 | ☐ |
| 17 | `payload` 省略 `contact`（匿名） | 201，正常建单 | ☐ |
| 18 | `contact` 传空串 | 400，`invalid_field` | ☐ |
| 19 | `photos` 携带 0 个 part | 201，正常建单 | ☐ |
| 20 | `photos` 携带 1 个 part | 201，照片数为 1 | ☐ |
| 21 | `photos` 携带 2 个 part（重复字段） | 201，照片数为 2，顺序与提交一致 | ☐ |
| 22 | `photos` 携带 4 个 part | 413，`too_many_photos` | ☐ |
| 23 | 照片类型不在 jpeg/png/webp 内 | 415，`invalid_photo_type` | ☐ |
| 24 | 照片内容与声明类型不符 | 415，`invalid_photo_type` | ☐ |
| 25 | 单张照片超过 5 MB | 413，`photo_too_large` | ☐ |
| 26 | `payload` body 为 JSON 文本而非独立 JSON part | 服务端正确解析 | ☐ |
| 27 | 首次提交 | 201，默认响应体恰为三个标识字段；启用时另含 `wechatCode` | ☐ |
| 28 | 同单号 + 相同语义内容重试（字段顺序/空白/时区写法不同） | 200，三标识与首次一致，无重复建单 | ☐ |
| 29 | 同单号 + 同图换序重试 | 200，命中幂等 | ☐ |
| 30 | 同单号 + 改内容 | 409，`submission_conflict`，原单内容与附件未被覆盖 | ☐ |
| 31 | 另一授权接入方用相同 `externalCaseId` | 独立建单，不返回 409 | ☐ |
| 32 | 5xx / 503 后原样重试 | 幂等命中，不产生重复工单 | ☐ |
| 33 | 并发在途请求超限 | 503，`intake_busy`，带 `Retry-After: 1` | ☐ |
| 34 | **私密查询凭证在提交成功会话展示** | 原提交人可见并有保存提示 | ☐ |
| 35 | **私密查询凭证不在运营端记录或展示** | 运营端仅见 `externalCaseId`、`caseNumber`、`publicLookupCode` | ☐ |
| 36 | **私密查询凭证不在二维码、URL、日志、埋点中** | 全链路排查无泄漏 | ☐ |
| 37 | 公开查询码页面只可见公开字段 | 无原始描述、原图、精确地址、联系方式 | ☐ |
| 38 | 运营端可按 `externalCaseId` 检索到提交结果与错误码 | 可排障 | ☐ |
| 39 | **微信小程序码** | 启用后验证图片和版本，扫码进入原单，生成失败后原样重试（见 §6） | ☐ |

微信小程序码为待联调项，对应检查项 39，与三个必返标识同属验收范围。

---

## 8. 待定项（联调前需与服务端确认）

| # | 事项 | 现状 |
| --- | --- | --- |
| 1 | `category` 的取值枚举 | 服务端当前按 ≤80 字自由字符串接收，不校验取值。需与合作方约定取值清单后决定是否加校验 |
| 2 | 响应体除三字段外是否扩展 | 默认返回三个标识，启用后加 `wechatCode` |
| 3 | 微信小程序账号和版本 | 合作方联调前由项目方确认，字段和重试规则见 §6 |
| 4 | 限流与并发保护 | 当前为在途并发上限（503 `intake_busy`），未实现按接入方的配额限流 |
| 5 | 401 / 403 / 409 之外的错误码是否随版本调整 | 现以服务端 `error` 字符串为准，双方以同一版本对照 |

---

## 9. 数据与凭据约定

- 联调全程只使用本文的虚构合成样例数据与 `Bearer <ACCESS_TOKEN>` 占位符；
- 不在文档、脚本、截图、日志中写入真实凭据；
- 样例中的 `contact` 使用 `synthetic-contact-0001` 这类纯合成占位值，**不含真实可联系信息**，不使用真实格式的手机号；
- 样例二维码与接口地址使用保留测试域名 `.test`，无法在公网真实访问，仅用于报文结构演示；
- 服务端日志不写入联系方式、申报正文、私密查询凭证和接入凭据；
- 接入凭据由长堤风貌街项目方签发与撤换，合作方不得自行扩散或跨环境复用。

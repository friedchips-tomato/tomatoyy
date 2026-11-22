# 导览事件存储和月报核心

DDL 只在 `migrations/014-tourism-events.sql` 一处定义，由现有迁移框架在 `BEGIN IMMEDIATE` 迁移事务中执行并更新 `user_version`，迁移后开启外键校验。DDL 创建两张独立表及索引，现有业务表无需回填。生产代码和相关测试都从该迁移文件取用 DDL，不再另存一份定义。

测试在空临时库和显式构造的旧版临时库上运行。v10 夹具保留旧工单、联系方式、事件、回执初始化设置与外键。v13 夹具保留旧工单、联系方式审计、监督记录和商户已发布月报，升级到 014 后重开，旧数据、授权与外键保持。历史版本回归用例显式构造旧版夹具，版本号取自 `src/store.js` 的 `SCHEMA_VERSION`，不再各自写死最新版本。

## 服务端配置

导览来源由服务端配置 `CHANGDI_TOURISM_JSON` 启用，缺省 `{}` 不启用任何来源。每条来源形如 `{id, kind, evidence, token, subjects}`，各自持服务端凭据和受限事件目录。同一个令牌出现在两条来源之间，或与接单、工作人员、商户凭据重复时，服务端启动失败。凭据不写入 SQLite、浏览器或日志。请求不能选择来源、证据或目录代码；未配置来源时写入返回 403。

## 模块入口

| 函数 | 输入和输出 |
| --- | --- |
| `createTourismCore(db, {sources, coverage, now})` | 接收迁移后的 `node:sqlite` 连接。可选的 `now()` 返回服务端 `Date`，默认当前时间。无配置时拒绝上报并给出缺覆盖的报告。 |
| `core.validateEvent(sourceId, payload)` | 校验已授权来源与原始 JSON 字符串或 UTF-8 字节，返回规范化事件，供内部使用。 |
| `core.recordEvent(sourceId, payload)` | 自行校验并开启短写入事务，调用方应在外层写事务之外调用。成功返回 `{status: 'recorded' \| 'replayed' \| 'deduplicated'}`，正文同 ID 冲突抛出 `HttpError(409, 'tourism_event_conflict')`。 |
| `core.summarizeMonth(month, {asOf}?)` | `month` 形如 `2026-04`，`asOf` 为带时区的报告截点，缺省取服务端现在。返回北京时间报告区间、截点，以及 `demo` 和 `operational` 的逐项聚合。可在现有报告读事务中调用。 |

`sourceId` 由未来 HTTP 接线层根据认证结果传入。每条 `sources` 配置形如 `{id, kind, evidence, subjects}`。`id` 是以小写字母开头的固定来源代码，最长 48 字符。`subjects` 按事件类型列出目录代码，如 `{route_exposed: ['R1', 'R2', 'R3']}`，代码以大写字母开头，只用大写字母、数字和短横线，最长 32 字符。每个类型单独配置，追加目录代码需要服务端变更。保留来源 ID 对应的证据含义，若含义改变则分配新 ID。

| 来源 `kind` | 证据 `evidence` | 可配置的业务类型 |
| --- | --- | --- |
| `guide_h5` | `demo` | `route_exposed`、`route_adopted`、`route_completed_self_reported`、`guide_played`、`booking_demo_submitted`、`parking_advice_adopted`、`parking_navigation_clicked` |
| `guide_h5` | `operational` | 可核实为已运营 H5 的曝光、采纳、自报完成、实播、停车建议及导航按钮操作。自报完成与导航点击保留各自证据含义。 |
| `booking_service` | `operational` | `booking_requested`、`booking_confirmed`、`booking_cancelled`，`subjectId` 为讲解员目录代码。 |
| `parking_verifier` | `operational` | `parking_arrival_verified`，`subjectId` 为车场目录代码。 |

当前 guide bridge 映射至 `guide_h5/demo`。路线使用 `R1` 至 `R3`，语音使用带讲解的点位代码，预约演示使用 `G1` 至 `G3`，停车使用 `P1`、`P2`。当前原型没有实际预约、停车核验或停车导航来源。测试里的停车导航、预约服务和核验来源均为合成数据。

## 事件验证与重试

每个请求一个 UTF-8 JSON 对象，上限 512 字节。统一字段为 `eventId`、`type`、`subjectId`、`flowId`、`occurredAt`，仅 `guide_played` 加必填的正安全整数 `durationSeconds`。两个 ID 均为临时的 24 位小写十六进制标识。真实预约服务在同一来源和讲解员下为一次预约生命周期复用随机 `flowId`，每个状态各自使用独立 `eventId`。该标识与预约原号、账号、联系方式、坐标、工单号、回执和原始文本无关。服务端拒绝多余字段及重复键，含转义后同名的键。

时间必须带时区且日期有效。比较前统一为带毫秒的 UTC 表示。设备时钟允许最多提前五分钟，报告仍按明确截点过滤。录入时间由服务端在获取 SQLite 写锁后为该笔事务取值。数据库持久化规范化列和幂等指纹，凭据和请求原文不进入表。

同一来源内，同 `eventId` 的规范化内容相同则重放成功，内容不同则返回 `409`。新 ID 若命中相同的 `sourceId/type/subjectId/flowId`，沿用首次成功录入的记录并记住新 ID 的规范化指纹，以便新 ID 的后续重试仍可判冲突。SQLite 事务及唯一约束保护这两种幂等键。不同类型各自接收，预约取消可以先于确认到达，跨午夜的采纳和完成也各自入库。

## 覆盖和报告截点

`coverage` 是服务端配置数组，每项为 `{evidence, type, from, to, status}`。半开区间 `[from, to)` 描述该证据和类型的汇总覆盖范围，`to` 缺省表示持续覆盖，`status` 为 `complete` 或 `partial`。声明覆盖需要至少一条配置来源拥有该类型。完整覆盖表示配置方确认整个统计范围的来源都已接入，认证令牌存在本身不足以证明完整。

报告月份使用北京时间，统计发生区间为 `[月初, min(下月月初, asOf))`，且服务端录入时间须严格早于 `asOf`。迟到事件在较晚的报告截点可计入原发生月份，重用原截点可重算原结果。重放时使用同版本的覆盖配置，保留历史覆盖区间。

- 无相交覆盖返回 `{status: 'unavailable'}`。这也适用于发生区间为空的月初时刻。
- 有相交覆盖但完整区间未填满报告发生区间，返回 `partial` 及已接入区间内的值。完整窗口可以拼接。
- 报告发生区间被完整填满时返回 `complete`，此时 `count: 0` 表示完整覆盖下没有可计事件。

每项事件分别计数，播放另带累计 `durationSeconds`，总值超过 JSON 安全整数时返回十进制字符串。预约状态 `operational.bookingStatus` 对报告发生区间内有覆盖且观察到状态的流程，取每个来源、讲解员和流程的最后一个发生状态。发生时刻相同，取消优先于确认，确认优先于发起。它同时给出各状态的流程数，覆盖等级由三个状态事件的覆盖共同决定。逐类型计数仍保留这三步各自的发生数。

## 回环接线

- `src/routes/tourism.js` 的 `handleTourismRoute(request, response, {authenticateTourismSource, tourism})` 已接入 `src/server.js` 的正常路由链，只消费确切的 `POST /api/v1/metrics/tourism/events`。`authenticateTourismSource(request)` 以独立 Bearer 凭据验证并返回来源身份，失败抛现有 `HttpError`。`tourism` 接收 `createTourismCore` 返回的实例。路由读取限制为 512 字节的原始 JSON，核心校验 UTF-8 与重复键。
- 新事件返回空 `201`，重放及流程去重返回空 `200`，路径和成功／错误状态与既有已验收模块一致。共享 server 沿用现有 `HttpError` 映射。配置桥的 `GUIDE_METRICS_TOKEN` 对应演示来源，将接单令牌、商户会话和管理会话排除在写入鉴权之外。独立路由测试已用真实回环 bridge 验证 201 和 200 均转换为浏览器收到的 204。
- 聚合结果接入已有管理端月报授权：只有全街区值班角色可读，传入同一个服务端报告截点。商户、游客、公开接口、普通处理人、主管和仅上报来源的凭据均无此读权限，商户代表报告不含导览数据。模块只返回聚合结果，应用层不暴露任何事件、来源标识、匿名流程键或凭据。覆盖时间段来自明确配置。
- 小程序用 `tourismReportGroups(result.tourism)` 返回与月报兼容的 `{title, rows, note?}[]`。管理月报的 `groups` 列表加入这两个分组，沿用同一文字模板并移除重复的旧缺失提示。子报告保留非零毫秒截点，播放按秒显示，预约状态按笔显示。

## 可复算样例

在 `changdi-intake/server` 运行 `node --test test/tourism-core.test.js test/tourism-route.test.js test/tourism-server.test.js test/tourism-coverage.test.js`，在 `changdi-intake/miniprogram` 运行 `node --test test/staff-tourism-report.test.js test/staff-tourism-report-http.test.js`。各目录的 `npm.cmd test` 执行全量测试。浏览器走查见 `changdi-intake/guide-bridge/README.md`。样例令各项演示类型与合成核验来源完整覆盖四月。下表的前八条发生于北京时间 2026 年 4 月，在 5 月 4 日 11:00 录入。路线曝光共用一次推荐流程，采纳和自报完成与选中路线的曝光共用该流程。核验事件发生于 4 月 15 日，5 月 5 日 12:00 录入。

| 数据 | 2026 年 4 月报告，截点 5 月 4 日 12:00 | 同月报告，截点 5 月 5 日 12:00:00.001 |
| --- | --- | --- |
| 演示曝光 `R1`、`R2` 各一次 | 2 | 2 |
| 演示采纳 `R1`、末站自报 `R1` 各一次 | 1、1 | 1、1 |
| 演示点位 `CD-A01` 播放一次，共 12 秒 | 1 次，12 秒 | 1 次，12 秒 |
| `G1` 演示预约提交一次 | 1 | 1 |
| 合成停车建议采纳 `P1`、导航点击 `P1` 各一次 | 1、1 | 1、1 |
| 运营列合成车场来源核验一次 `P1` | 完整覆盖，0 | 完整覆盖，1 |

测试另用独立 JavaScript 循环按北京时间月份和证据逐项点算，与模块结果逐项比较。独立用例还覆盖跨月同流程、乱序预约回放、同 ID 内容冲突、SQLite 两连接锁争用及报告部分覆盖。原型“服务 → 停车 → 从这里出发排路线”发出 `parking_advice_adopted`。当前页面没有外部停车导航或车场核验入口，覆盖配置应保持这些类型缺失，直到接入对应来源。

真实路由链、管理端页面和浏览器走查已完成接线：临时接诉后端、接入层、Edge 原型和 SQLite 之间的行为事件通路，以及值班凭据读取管理月报的通路都已核对。真实预约、停车导航和物理到达仍无来源，其覆盖配置应保持缺失，直到接入对应来源。

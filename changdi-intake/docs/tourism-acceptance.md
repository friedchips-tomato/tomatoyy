# 导览事件正式接线与联合验收 · 回报

- 实际模型：claude-opus-5-5（Opus 5.5）
- 工作区：`C:\Users\17109\orca\workspaces\tomatoyy\intake-guide-collection`（隔离 worktree，分支 `friedchips-tomato/intake-guide-collection`）
- 未操作生产库，未提交、未推送、未部署；未改动商户功能与其独立汇总权限。

## 1. 迁移与 DDL 单一来源

- DDL 只保留一份：`server/migrations/014-tourism-events.sql`（`tourism_events`、`tourism_event_ids` 两张独立表及索引）。
  `server/src/tourism/schema.sql` 的第二份定义已不存在，`test/tourism-route.test.js` 改为从 `migrations/014-tourism-events.sql` 取用；
  `test/tourism-core.test.js` 原本就指向该迁移文件。
- `server/src/store.js` 新增导出常量 `SCHEMA_VERSION = 14`，迁移框架的版本上限守卫（`version > SCHEMA_VERSION`）
  和最后一级迁移（`version < SCHEMA_VERSION` → `PRAGMA user_version = 14`）都读它，版本号只有一处来源。
- 历史回归同步：`test/intake.test.js`、`test/public-submission.test.js`、`test/wechat-code.test.js`、
  `test/staff-contact.test.js`、`test/supervision.test.js`、`test/merchant-representative.test.js` 中
  写死 `13` 的版本断言改为 `SCHEMA_VERSION`；旧版夹具显式补齐 `DROP TABLE tourism_event_ids; DROP TABLE tourism_events;`，
  使 v1–v11 夹具成为真正的旧版库（此前直接复制当前库再改 `user_version` 会带上 v14 表，触发 `table tourism_events already exists`）。
- `test/legacy-schema.js` 的迁移清单补入 `014-tourism-events`，可用 `applyLegacySchema(db, 13)` 显式构造旧版夹具。

### 013 → 014 升级验证（`server/test/tourism-server.test.js` 第 6 项）

显式构造 v13 夹具（`applyLegacySchema(db, 13)` + 旧工单、联系方式审计、监督记录、商户已发布月报），再由 `createIntakeServer` 升级：

- `user_version` 升到 `SCHEMA_VERSION`（14），`PRAGMA foreign_key_check` 为空，`integrity_check` 为 `ok`；
- 旧工单、`case_contacts` 联系方式、`case_contact_access_audit` 审计、`current_case_supervision` 标注、
  `remediation_entries` 台账、`representative_report_releases` 商户已发布月报全部保留；
- 新表 `tourism_events`、`tourism_event_ids` 建好且为空，业务表无需回填；
- 重开同一库后旧数据与旧授权保持（值班角色仍能读到旧联系方式，审计追加一行）。

## 2. 来源启用、凭据与路由接线

- 配置入口：`CHANGDI_TOURISM_JSON`（`server/src/main.js` → `createIntakeServer({tourism})`），缺省 `{}` 即不启用任何来源。
  每条来源 `{id, kind, evidence, token, subjects}` 各自持服务端凭据和受限事件目录；
  `kind` 分 `guide_h5` / `booking_service` / `parking_verifier`，`evidence` 分 `demo` / `operational`，
  对应演示 H5、运营 H5、真实预约、车场核验四类来源。
- 复用现有认证与全局 token 冲突检查：`server/src/auth.js` 的 `addCredential` 对导览来源与接单、工作人员、
  商户凭据统一登记，同一令牌出现在两处（两个来源之间，或来源与接单／工作人员／商户之间）启动即报 `Duplicate credential`。
- `handleTourismRoute` 已在 `server/src/server.js` 正常路由链中接线，路径 `POST /api/v1/metrics/tourism/events`，
  成功返回空 201，重放与同流程去重返回空 200，正文上限 512 字节，错误状态与既有模块一致（405/404/401/403/409/413/415）。
- 凭据不落 SQLite、不进浏览器、不进日志：来源 token 只在 `auth.js` 内存登记，事件表只存规范化列与幂等指纹。
- 配置不能由请求选择身份或证据：来源身份来自凭据，证据类别来自服务端配置，`subjects` 目录由服务端裁定。
- Bridge 用独立 `GUIDE_METRICS_TOKEN`，与 `GUIDE_INTAKE_TOKEN` 相同值时启动失败；未设置行为令牌时行为入口和采集脚本返回 404。

## 3. 月报聚合与授权

- `server/src/store.js` 的 `monthlyReport` 用同一个服务端时钟：`asOf = now()`，投诉指标按整秒取数（原语义不变），
  导览列保留毫秒截点；客户端传 `asOf` 等参数直接 400 `invalid_filter`。
- `miniprogram/pages/staff/tourism-report.js` 的 `tourismReportGroups` 与 `pages/staff/monthly-report.js` 的
  `reportView` 已接入，`pages/staff/index.wxml` 用通用 `report.groups` 渲染两组，并显示口径说明
  （导览截点保留毫秒、投诉指标按整秒取数）和缺覆盖提示。
- 展示区分：来源覆盖状态（完整覆盖／部分覆盖／暂无覆盖）、语音实播次数与累计秒数、路线完成（游客自报）、
  预约演示提交与真实预约发起／确认／取消及状态笔数、停车建议采纳、停车导航点击、停车核验到达；无可用覆盖时给简明提示。
- 授权：只有全街区值班角色可读管理月报；主管、承办、商户、公开接口、普通处理人均 403，无效凭据 401；
  商户代表报告不含导览数据（`representative-report.js` 走投诉口径 `summarizeMonth`，未接导览）。

## 4. 真实走查与复算

`guide-bridge/browser-check.cjs` 已改为端到端通路：临时接诉后端（真实 SQLite 文件）+ 接入层 + Edge 原型 + 管理月报。

- 正路径：原型「路线」生成并曝光 R1–R3、采纳 R1、末站自报完成、语音实播（受控 SpeechSynthesis 回调，只计实际播放区段）、
  本地预约演示提交、`parking_advice_adopted`；事件经 `POST /bridge/tourism-events` → 桥 → 真实 `POST /api/v1/metrics/tourism/events`
  → SQLite → 值班凭据 `GET /api/v1/staff/monthly-report`；再按浏览器实际发出的 10 条事件复算各组数字并逐项比对，
  语音秒数按事件累计值核对，响应体不含来源 ID、事件 ID、流程 ID、对象代码和凭据。
- 反路径：桥无行为令牌时页面无 `window.CD_TOURISM`、行为脚本 404、行为入口 404；非同源 Origin 403、错误 Content-Type 415、
  超长正文 413、非法字段 400；被主动中断的停车事件不入库也不计数（`browserPosts = events + failed`）；
  未曝光的路线不计、刷新不重发、语音未起播不记、暂停与准备时间不计；
  真实预约、停车导航、物理到达无来源，`parking_navigation_clicked` 为完整覆盖下的真实 0，运营列整体 `unavailable`。
- 无真实预约／导航／物理到达入口，按证据报告，不把按钮或试验注入算成运营数据（合成预约服务与车场核验只用于核对契约）。

## 5. 命令与确切计数

| 命令 | 计数 |
| --- | --- |
| `cd changdi-intake/server && node --test` | 98 tests / 98 pass / 0 fail（基线 87，修复 14 项历史回归后新增 11 项导览用例） |
| `cd changdi-intake/miniprogram && node --test test/*.test.js` | 253 tests / 253 pass / 0 fail（基线 251，新增 2 项） |
| `cd changdi-intake/guide-bridge && node --test` | 3 tests / 3 pass / 0 fail |
| `cd changdi-intake/guide-bridge && NODE_PATH=<playwright-core> CHROMIUM_PATH=<Edge> node browser-check.cjs` | 三阶段通过，退出码 0 |

浏览器走查使用本机 Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；
`playwright-core` 安装在 Orca 临时目录（`%APPDATA%\orca\chat-scratch\eff295b27a073a3976cccb6bc3c5c747\node_modules`），
未写入仓库。

## 6. 商户代表报告与公开接口的导览隔离（返工修正）

上一轮验收发现 `server/test/tourism-server.test.js` 的「商户代表报告与公开接口都不含导览数据」一项存在**假覆盖**：

- 该用例请求的是 `/api/v1/merchant/reports/2026-04`，这是**不存在的路径**，落到 404 `route_not_found`；
  断言 `!text.includes('tourism')` 恰好在错误响应体上成立，于是「商户报告不含导览数据」实际上从未被验证。
- 标题中的「公开接口」部分**没有任何断言**。

修正后的用例（仅改测试，未动生产代码）：

- 改用真实路由 `GET /api/v1/merchant/representative-report?month=2026-04`，持 `representativeReport` 权限的商户账号请求，
  断言 **200**；另保留两条 404 对照断言（旧路径 → `route_not_found`，未发布月份 → `report_not_released`），
  使「错误响应体永远不算通过」成为结构性事实。
- 样本按最小发布条件构造：同一 `ranges` 组内第二个商户贡献 15 件工单（5 件受理+发布+高分评价、
  5 件受理+发布后被重开+低分评价、5 件仍待处理），使 `firstResponse`、`completion`、`satisfaction`
  三个指标两侧都达到 k=5 匿名阈值，报告真正发布出 `available` 与分段值，而不是靠 `withheld` 蒙混。
- 一律使用**结构化断言**：先 `JSON.parse`，再比较键集合（商户报告顶层恰为 `month`/`metrics`，
  `metrics` 恰为 `firstResponse`/`firstResponseDuration`/`completion`/`duplicateComplaints`/`satisfaction`），
  并递归检查键名与字符串值中不出现导览类型名、来源 ID（`guide-demo` 等）与任何导览字段。
  公开接口同理：`GET /api/v1/public/cases/<code>` 的键集合恰为 `caseNumber`/`status`/`milestones`，
  里程碑恰为 `status`/`occurredAt`。

真实 HTTP 响应截取（键集合）：

```
GET /api/v1/merchant/representative-report?month=2026-04  → 200
{"month":"2026-04","metrics":{"firstResponse":{"status":"available","band":2},
 "firstResponseDuration":{"status":"available","band":1},"completion":{"status":"available","band":2},
 "satisfaction":{"status":"available","band":2},"duplicateComplaints":{"status":"available","band":1}}}

GET /api/v1/public/cases/<publicLookupCode>  → 200
{"caseNumber":"CD-3914DF6D960748328E21AD3D5CFA7639","status":"submitted",
 "milestones":[{"status":"submitted","occurredAt":"2026-05-20T04:00:00.000Z"}]}
```

## 7. 文件清单

新增：

- `changdi-intake/server/test/tourism-server.test.js`（6 项：凭据隔离、缺省无来源、来源边界与幂等、月报聚合与授权、商户报告不含导览、013→014 升级）
- `changdi-intake/server/test/tourism-coverage.test.js`（5 项：完整覆盖报零与只记一次、来源互相隔离、同 ID 冲突与同流程去重、月界、缺覆盖）
- `changdi-intake/miniprogram/test/staff-tourism-report-http.test.js`（2 项：真实管理 HTTP 响应验证 WXML 模型、模板渲染检查）

修改：

- `changdi-intake/server/src/store.js`（导出 `SCHEMA_VERSION`，迁移框架读它）
- `changdi-intake/server/test/legacy-schema.js`（迁移清单补 014）
- `changdi-intake/server/test/tourism-route.test.js`（DDL 改从 014 迁移取）
- `changdi-intake/server/test/{intake,public-submission,wechat-code,staff-contact,supervision,merchant-representative}.test.js`
  （版本断言改 `SCHEMA_VERSION`；旧版夹具显式删除 v14 两张表）
- `changdi-intake/guide-bridge/browser-check.cjs`（端到端：真实后端 + 桥 + Edge + 月报复算；正反路径）
- `changdi-intake/docs/openapi.yaml`（新增 `POST /api/v1/metrics/tourism/events` 路径、`TourismSourceBearer`、`TourismEvent` schema，版本 1.3.0）
- `changdi-intake/server/README.md`（新增「导览来源与行为上报」章、迁移版本说明、月报导览列口径）
- `changdi-intake/server/src/tourism/README.md`（DDL 唯一来源、v10/v13 夹具、服务端配置、接线现状、可复算命令）
- `changdi-intake/guide-bridge/README.md`（浏览器走查命令、真实后端与月报复算说明、无真实来源的边界）
- `changdi-intake/docs/local-acceptance.md`（验收表新增导览通路行、计数与链接更新）

未改动：`prototype-paper/app.js`（基线已含采集逻辑，无需桥连修正）、商户功能与其独立汇总权限、
`miniprogram/pages/staff/index.wxml` 结构（通用 `report.groups` 已能渲染导览分组）。

## 8. 未解决问题与边界

1. 真实预约服务、停车导航、车场物理到达目前没有真实来源。月报中相应项按覆盖状态显示（演示列完整覆盖下为真实 0，运营列 `unavailable`），
   不以按钮或试验注入充数。接入真实来源后需重新确认覆盖区间和样例复算。
2. 浏览器走查的月报月份取自浏览器事件的北京时间月份，跨月首日零点的极短窗口内可能落在不同月份，重跑即可；不影响单元与接口回归。
3. 正式部署仍需独立完成 HTTPS、限流、反向代理、可靠恢复、真实微信身份和公开指标授权；本地复跑不等于生产验收。
4. 导览来源的 `subjects` 目录由服务端配置，新增点位需服务端变更；浏览器侧采集脚本另有一份允许目录，两者需同步维护。

# 导览与接诉即办本地接入层

此目录为本地联调实现。服务读取 `prototype-paper` 文件，并在返回游客首页时加入本目录的脚本。游客在“服务 → 反馈”填写发生时间、地点、类型、描述、联系方式及照片；服务端以合作方身份调用接诉即办的唯一接单接口。成功时展示编号、公开查询码和本人私密凭证；若后端已启用微信小程序码，也会显示小程序码。查询、查看反馈、评价、补件和补办仍在接诉即办小程序中办理。导览原有“我的诉求”和运营台是浏览器内的演示记录。

提交响应丢失时保留本页面，并按原内容重试；接诉后端按相同编号和内容幂等返回回执。页面关闭或刷新后，尚未确认的内容和回执不会保留，可能无法自动恢复；不要在结果未知时重新提交新单，应先联系工作人员核查。私密凭证仅在当前页面内存中展示，需由提交者妥善保存，不放进 URL、二维码或浏览器持久存储。

## 启动和验证

使用 Node.js 22.17 或更高版本。先按 `../server/README.md` 启动接诉后端，并在其 `CHANGDI_INTEGRATIONS_JSON` 中配置一条本地测试接入方。然后在另一个 PowerShell 窗口设置同一测试接入方的令牌：

```powershell
cd changdi-intake/guide-bridge
$env:GUIDE_INTAKE_TOKEN = '<本地测试接入方令牌>'
$env:GUIDE_INTAKE_ORIGIN = 'http://127.0.0.1:3400'
npm.cmd start
```

打开 `http://127.0.0.1:8932/`。`GUIDE_BRIDGE_PORT` 可调整监听端口；服务只监听 `127.0.0.1`，也只接受回环后端，不支持生产部署。按 Ctrl+C 结束。测试使用临时数据库与随机端口，并在结束时关闭服务：

```powershell
npm.cmd test
```

浏览器走查另需本机已有的 `playwright-core` 和 Chromium 或 Edge，通过 `NODE_PATH` 指向其所在 `node_modules`，`CHROMIUM_PATH` 指向浏览器程序后运行 `node browser-check.cjs`。脚本启动临时接诉后端和接入层，模拟回执丢失并重试，再以真实浏览器操作导览界面，把行为事件经接入层送入临时接诉后端并落库，最后用值班凭据读取管理月报并按浏览器实际发出的事件复算各组数字。结束时关闭浏览器和服务并删除测试数据库。

```powershell
cd changdi-intake/guide-bridge
$env:NODE_PATH = '<playwright-core 所在的 node_modules>'
$env:CHROMIUM_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node browser-check.cjs
```

办理效率处标注“暂无经授权公开的数据”。管理方月报不是公开接口；公开范围、脱敏、小样本规则和统计口径未确定前不展示其数值。正式部署需要独立完成 HTTPS、限流、反向代理、可靠恢复、真实微信和公开指标授权等工作；本地测试不等于生产验收。

## 导览行为采集

启动桥前设置 `GUIDE_METRICS_TOKEN`，沿用同一个回环上游地址 `GUIDE_INTAKE_ORIGIN`。接单使用 `GUIDE_INTAKE_TOKEN`，导览行为使用独立的 `GUIDE_METRICS_TOKEN`。两者配置成相同值时启动失败。未设置行为令牌时，行为入口和采集脚本返回 `404`，接单仍可用。直接预览原型时无需桥或凭据。

浏览器向同源的 `POST /bridge/tourism-events` 发送一个 `application/json` 事件，桥以 `Authorization: Bearer <GUIDE_METRICS_TOKEN>` 转发至 `POST /api/v1/metrics/tourism/events`。后端从该凭据判定来源和演示证据。浏览器请求省略 Cookie，凭据留在桥进程中。

```json
{
  "eventId": "11ab340a616c6477106fed82",
  "type": "route_exposed",
  "subjectId": "R1",
  "flowId": "fa3e183c012a3916230002a8",
  "occurredAt": "2026-11-22T01:30:00.000Z"
}
```

| `type` | `subjectId` | 触发条件 |
| --- | --- | --- |
| `route_exposed` | `R1` 至 `R3` | 推荐卡首次进入可见区域。同一批次每条路线发送一次，重绘和来回滚动不重复。 |
| `route_adopted` | `R1` 至 `R3` | 点击“按这条走”。 |
| `route_completed_self_reported` | `R1` 至 `R3` | 游客点击最后一站的到站按钮。 |
| `guide_played` | 含语音讲解的 `CD-*` 点位 | SpeechSynthesis 起播后累计实际播放区段，结束、停止、切换或出错时结算。仅此类型含 `durationSeconds`，向下取整并省略不足一整秒的记录。 |
| `booking_demo_submitted` | `G1` 至 `G3` | 本地预约演示提交成功，正文仅含讲解员目录编号和通用字段。 |
| `parking_advice_adopted` | `P1`、`P2` | 点击“从这里出发排路线”。 |
| `parking_navigation_clicked` | `P1`、`P2` | 契约保留给真实停车导航入口，现有原型无此动作。 |

`eventId` 与 `flowId` 都是临时生成的 24 位小写十六进制随机 ID。`occurredAt` 含时区，浏览器使用 UTC。推荐批次共享一个 `flowId`，采纳和末站自报完成沿用该 ID，可与 `subjectId` 组合关联。同一事件的重试使用完全相同的 JSON 和 `eventId`，接收方应按来源和 `eventId` 幂等处理。预约表单字段、预约号、定位、工单与回执都不进入采集请求。

桥要求浏览器 `Origin` 等于当前 `http://127.0.0.1:<端口>`，正文上限 512 字节，并按类型核对精确字段与目录编号。上游接受后桥返回空 `204`。上游超时、传输错误或返回 `408`、`429`、`5xx` 时最多重试一次，每次等响应头最多 1.5 秒，两次间隔 150 毫秒，耗尽返回 `503`。其他上游拒绝返回 `502`，响应正文留在上游。桥最多同时转发 16 个事件，浏览器每页最多发起 8 个并发请求，每个最多等待 4.5 秒。采集请求和失败记录均不写入持久存储，网络失败不影响页面操作。

在 `changdi-intake/guide-bridge` 运行 `npm.cmd test`，由回环 HTTP 假接收器核对实际转发的字段、凭据、拒绝条件和同 ID 重试，并回归接单。配置前节的浏览器环境后运行 `node browser-check.cjs`，用真实浏览器操作导览 UI，使用受控的 SpeechSynthesis 回调验证起播、暂停、续播和结束计时，把事件送入临时接诉后端落库，再核对管理月报与浏览器实际发出的事件一致。在仓库根目录运行 `node prototype-paper/check.mjs` 检查原型目录。单元测试用假接收器验证交接契约，浏览器走查用真实后端验证入库和月报统计。

当前原型没有真实预约、停车导航和物理到达入口：`booking_demo_submitted` 是本地演示预约，`parking_advice_adopted` 只记录采纳停车建议，`parking_navigation_clicked` 没有触发动作，`booking_requested`、`booking_confirmed`、`booking_cancelled` 和 `parking_arrival_verified` 没有来源。这些项在月报中按覆盖状态显示，不把按钮或试验注入算成运营数据。

# 重复投诉和协商整改试点

## 配置与权限

试点覆盖当前接诉服务管理的一个街区。配置 `CHANGDI_SUPERVISION_JSON` 并在需要操作的工作人员目录条目中设置 `"supervision": true`。两项同时具备时，`GET /api/v1/staff/me` 返回 `supervision: true`。省略配置或设置为 `null` 即关闭试点，省略账号授权或设为 `false` 即拒绝该账号。配置错误会阻止服务启动，调整配置后需重启服务。

以下 PowerShell 示例仅使用合成数据，在专用空工作区执行。该启动入口使用工作区自己的 `server/.local/intake.sqlite`，默认绑定 `127.0.0.1:3400`。如需使用真实数据库，先另行安排备份和升级。本任务的验证由测试脚本自行启动回环服务和临时数据库。

```powershell
$env:CHANGDI_SUPERVISION_JSON = '{"windowHours":72,"points":[{"code":"east","label":"Sample East Gate"}],"categories":[{"code":"lighting","label":"Sample Lighting"}]}'
$env:CHANGDI_STAFF_JSON = '[{"id":"test-desk","role":"duty","token":"' + ('d' * 43) + '","supervision":true}]'
$env:CHANGDI_INTEGRATIONS_JSON = '[{"source":"test-platform","token":"' + ('i' * 43) + '"}]'
$env:CHANGDI_RECEIPT_KEY = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
npm.cmd --prefix .\changdi-intake\server start
```

保留同一专用测试库时须沿用首次启动的回执密钥。程序化启动可直接传入 `createIntakeServer({ supervision, staff, … })`。窗口范围为 1–720 整小时，两个目录各有 1–100 个条目。代码在各自目录内唯一，只用 1–32 位字母、数字、下划线或连字符。已使用的代码保留原含义，显示名称可修改。

原有微信会话与本地令牌边界继续适用。获授权的值班人员、主管、承办人分别使用全街、所属部门、本人承办范围进行工单标注和审核，目标工单也须在操作人范围内。协商整改台账仅开放给明确获授权且有全街范围的值班人员。现有普通值班人员仍可查看基础全街月报，重复指标继续提示待接入。

## 工单核对

- `GET /api/v1/staff/cases/{caseNumber}/supervision` 返回目录、当前标注、修订版本、最近操作及候选。未标注时 `revision: 0`，无候选。候选只返回工单号及发生时间，最多 20 条。
- 向同一路径 `POST` 提交 `expectedRevision` 和非空 `reason`。动作 `classify` 另传 `pointCode` 和 `categoryCode`，`confirm` 另传 `targetCaseNumber`，`revoke` 撤销当前关联。
- 候选的结构化点位和类别均须匹配。发生时间在 `[后单发生时间 − windowHours, 后单发生时间)` 内，按发生时间倒序，再按内部工单 ID 倒序。自由文本和照片不参与判重。
- 每张后单最多关联一张原单。原单可接多张后单。禁止自指、环和链。关联有效时锁定两端标注，先撤销关联再更正。目标后续转出权限范围时，当前视图隐藏其编号和确认理由，由有两端权限的工作人员处理。
- 事务内再次核对版本、两端权限和匹配条件，旧版本或已锁定操作返回 409，目标不符合条件或越权统一返回 404。变更记录保留修订号、标注、操作、理由、人员和 UTC 时间。`cases.version` 仍用于办理流转。

## 协商整改台账

- `GET /api/v1/staff/remediation` 每页返回最多 20 条概要。以后端返回的 `nextBefore` 作为下一页的 `before`。详情由 `GET /api/v1/staff/remediation/{id}` 读取。
- `POST /api/v1/staff/remediation` 接受 `topic`、`minutes`、`responsibleUnit` 和未来的 `dueAt`，返回 201 及版本 1。
- `POST /api/v1/staff/remediation/{id}/reviews` 接受 `expectedRevision`、`notes` 和 `conclusion`。允许 `follow_up`（继续整改）与 `resolved`（复查通过），后者结束复查。版本冲突或已结束返回 409。登记和复查均保留工作人员及时间。
- 保存结果不明时先返回列表核对。台账和月报不触发自动奖惩，由运营方结合实际处理。

## 月报与本地验收

月报继续使用北京时间与既有首响、完成和评价分母。重复统计纳入后单首次提交在当月的工单，以月末或当前截点之前最后一次监督修订为准，每单最多计一次。月末之后的撤销和更正不回写历史月报。补办仍单列。

`duplicateComplaints` 报告 `submitted`、`covered`、`unclassified`。有可统计来源时还返回 `confirmed` 与 `notConfirmed`，后者仅表示已标注且未计入重复。全部有标注时为 `available`，部分标注为 `partial`，未启用或有工单但全部缺标注时为 `unavailable`。启用后空月份显示无首次提交样本。窗口字段反映当前配置，窗口修改仅影响后续候选和确认。

月报只返回聚合结果。模块通过 `includeCase(caseId)` 可对首响、完成、补办、评价和重复使用同一范围。重复关联两端同时在该范围内才计数。此轮仍仅有全街值班月报路由。

```powershell
node --test .\changdi-intake\server\test\supervision.test.js
npm.cmd --prefix .\changdi-intake\server test
npm.cmd --prefix .\changdi-intake\miniprogram test
git diff --check
```

SQLite 迁移 012 新增监督事件及台账结构，保留现有工单与联系方式审计。回环测试覆盖 v11 升级、判重与撤销冲突、跨北京时间月末和权限隔离。小程序测试使用模拟请求验证界面状态。

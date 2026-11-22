# 商户本人回执和代表月报

## 申报和本人办理

商户登录继续使用既有本地回环令牌或微信会话。申报使用 `POST /api/v1/merchant/cases` 的 multipart 请求，`payload` 包含 `clientRequestId`、带时区的 `occurredAt`、`location`、`category` 和 `description`，并可填写 `suggestedDepartment`（最多 100 字）、`contact`（最多 300 字）。照片以重复的 `photos` 文件段提交，至多 3 张。地点、照片及联系方式继续按既有渠道保存。

建单返回 201，原内容重放返回 200，同请求号异内容返回 409。可查询回执含原 `caseNumber`、`status`、`submittedAt` 和 `publicLookupCode`。微信制码开启时使用既有公开进度页及 24 位公开号作场景。制码超时或失败时 `wechatCode` 为 `null`，原工单和公开查询码照常返回。关闭制码时省略该字段。公开接口继续只返回原有状态和时间线字段。

以下路径使用商户 Bearer 凭据。当前账号至少有 `readCases` 或 `submitCases`，且账号 ID、商户 ID 同时匹配原单的提交记录。已有工单沿用当前编号、公开号与归属，无需补录。配置中的账号 ID 与商户 ID 为持久身份，换人或更换主体需分配新 ID。

| 请求 | 用途 |
| --- | --- |
| `GET /api/v1/merchant/cases/{caseNumber}/receipt` | 重取本人回执。越权或工单不存在统一返回 404 |
| `GET /api/v1/merchant/cases/{caseNumber}/claimant` | 读取本人可用操作、截止时间、已发布反馈与评价、补办结果 |
| `GET /api/v1/merchant/cases/{caseNumber}/claimant/feedback-photos/{publishVersion}/{position}` | 读取已发布的脱敏反馈图 |
| `POST /api/v1/merchant/cases/{caseNumber}/claimant/actions` | 提交 `evaluate`（三维 1–5 分）、`confirm_resolved` 或 `request_reopen`，沿用工单 `expectedVersion` 与既有状态、期限校验 |

商户路径全程使用当前登录会话来验证本人，响应没有私密本人令牌。商户列表和普通详情没有回执码或制码图片。原提交人可从工作台按编号重取回执，也可从工单详情按需打开。公开进度链接只带公开号。

商户复用游客回执图片校验与文件工具，接受 `release`、`trial`、`develop` 的 PNG/JPEG，解码后最多 1 MiB。页面数据仅持有本地图片路径。申报和详情的暂存图片分别管理，重取时先释放旧图；坏图或手动隐藏后仍可使用公开码。退出、页面隐藏或会话失效时清除页面数据和暂存图片。

## 代表月报配置

试点默认关闭。在程序化入口传 `createIntakeServer({ representativeReports, merchants, … })`，或在现有本地启动环境设置 `CHANGDI_REPRESENTATIVE_REPORTS_JSON`。下例为合成配置，依旧使用现有 `CHANGDI_RECEIPT_KEY` 和接单凭据。

```powershell
$env:CHANGDI_REPRESENTATIVE_REPORTS_JSON = '{"minimumGroupSize":5,"months":["2026-11"],"ranges":[{"id":"east","merchantIds":["representative-shop","ordinary-shop"]}]}'
$env:CHANGDI_MERCHANTS_JSON = '[{"id":"synthetic-rep","merchantId":"representative-shop","permissions":["representativeReport"],"token":"' + ('r' * 43) + '"}]'
npm.cmd --prefix .\changdi-intake\server start
```

只有配置目录中的商户账号显式获授 `representativeReport`，且其商户 ID 归属一个配置范围时，商户 `/me` 才为其显示汇总入口。每个商户 ID 只能属于一个范围，真实归属来源为服务端 `merchant_cases` 登记关系。请在上线前由运营方核验范围目录、代表账号及其知悉数据、月份名单、样本阈值（至少 5）和满意度口径。确认代表身份与其可访问的其他商户或管理方身份不会形成交叉披露。

## 固定发布规则

`GET /api/v1/merchant/representative-report?month=YYYY-MM` 只接受月份。无授权返回 403，当前月、未批准月或现行策略不匹配统一返回 404。只对批准且已结束的北京时间月份发布，首次有效读取在同一事务中冻结各个固定范围的结果。SQLite 013 保存每月发布内容与策略指纹。迟到记录、撤销、进度更新不会重算已发布月份；范围、排除身份或阈值变化后，旧月无法用新策略重新生成。

每个样本按工单**首次提交**月份和登记商户归入一个范围，排除所有代表账号所在商户的工单，以及曾派给这些商户协办的工单。预先划定样本后复用管理月报的首响、受理完成、截点判重和有效评价规则，截点固定为月末。各指标沿用对应的不同分母，在同一范围和入组月份内计算。

- **首次有效响应覆盖**为已有有效首响的比例。
- **中位首响时长**使用与管理月报相同的有效响应分钟数和中位数，只返回不超过 1 小时、超过 1 小时且不超过 24 小时、超过 24 小时三个区间之一。
- **受理工单完成率**为当月首次受理样本中的完成率。
- **重复投诉占比**只计后单与原单均在可发布范围和同一初提月份，且截点有效的确认。结构化覆盖完整才纳入发布判断。
- **三维满意度均分**取有效评价轮次的速度、效果、态度均分。样本保护按不同工单计算，按每单有效评价均分达到 4 分和未达到分别校验人数。

基础指标检查互补样本是否达到 `k`，并对拟发布指标的联合贡献分组再检查一次。联合分组包括无受理、无评价等对分母有影响的状态。发布中位时长还需至少 `k` 个有效首响，并把无首响和三档时长加入已有联合分组重新检查。任一非空细分组低于 `k`，或偶数样本的两个中间值跨档，只抑制新增时长，已通过检查的基础指标仍可发布。无响应样本始终缺少可公布的时长。

响应只含 `month` 和指标的 `status`，可发布项另含区间索引 `band`。百分比仍按 25 个百分点分档，满意度仍按 1 分分档；`firstResponseDuration.band` 为 0–2。响应不含分子、分母、精确分数或时长、范围标识、分布、时间戳或个案。代表可查的自有与协办工单已经从样本剔除。旧冻结记录继续原样读取，在页面标为“原冻结快照未发布时长”，因此同月不会因增加指标而有两个发布结果。

本地合成样本中，东区有效首响中位数独立复算为 3360 分钟，报告只返回“超过 24 小时”。另有 60 与 1440 分钟的边界样本，以及覆盖率可公布但时长或其交叉小样本受抑制的用例。修改历史评价、删除测试重复标注、随后按不同范围重启，均无法取得旧月的新结果。该证据针对上述授权和数据可见边界，无法覆盖外部来源已披露的个案数据。

```powershell
node --test .\changdi-intake\server\test\merchant-representative.test.js
npm.cmd --prefix .\changdi-intake\server test
npm.cmd --prefix .\changdi-intake\miniprogram test
```

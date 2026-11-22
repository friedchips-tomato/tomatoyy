# 长堤风貌街导览与接诉即办

| 模块 | 入口 | 用途 |
| --- | --- | --- |
| 侨批纸质风导览 | [游客端](../../prototype-paper/index.html) · [运营台](../../prototype-paper/ops.html) | 浏览导览、讲解、路线、预约、停车和示意反馈。运营台读取同一浏览器的演示记录。 |
| 像素风导览 | [游客端](../../prototype/index.html) | 第一版导览原型，加载独立的演示数据。 |
| 接诉即办 | [小程序环境](../miniprogram/README.md) · [后端](../server/README.md) | 统一受理、分派、协办、反馈、评价和补办。 |

导览来源为 `friedchips-tomato/tomatoyy` 的 `feature/changdi-guide`，基线提交为 `e24676e465e330ed78c7569862afac891f1de4d1`。导览文件按此提交原样保留。启动导览和复核两版页面的命令见[导览原版说明](../../README.md)。

## 申报接入

原型里的反馈表单和运营台工单使用浏览器本地记录。真实申报按已定分工由外部平台制作和托管表单，平台服务端通过唯一的 `POST /api/v1/integrations/intake/cases` 接入接诉即办。导览如需提供真实申报入口，由负责发布导览的一方配置已确认的外部表单地址。

| 外部表单内容 | 接诉即办接口 |
| --- | --- |
| 稳定的申报编号 | `externalCaseId`。网络中断或回执丢失时保留原编号、正文和照片重试。 |
| 发生时间、地点 | `occurredAt`（带时区）、`location`。原型示意反馈接入真实流程时需由外部表单补齐。 |
| 类别、说明 | `category`、`description`。 |
| 联系方式、现场照片 | `contact` 选填。照片随同一次 multipart 请求上传，字段为 `photos`。 |

平台收到成功回执后展示工单编号和公开查询入口。微信小程序码启用后随同一回执返回。原提交人的私密凭证仅在本人的成功会话展示，查询、补件和办理继续在接诉即办小程序完成。接入凭据由平台服务端保管。

## 联合验收

- 从仓库根目录运行 `node prototype-paper/check.mjs` 和 `node prototype/check.mjs`，检查两版导览原型。
- 运行 `node --test changdi-intake/server/test/three-window-acceptance.test.js`，用合成申报核对接单重试、公开查询、三窗口办理和原单补办。
- 外部表单上线测试时核对同一张合成工单是否从导览入口进入已确认的外部表单，再通过服务端接单出现在小程序管理窗口。[接单契约](openapi.yaml) · [联调样例](integration-examples.md) · [真机验收顺序](local-acceptance.md#正式联调与真机待验)

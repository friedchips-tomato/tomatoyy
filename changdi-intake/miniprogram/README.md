# 小程序运行环境

三个窗口共享 [config.js](config.js) 中的环境配置。切换环境须重新构建小程序。页面输入和扫码结果只用于业务查询，服务地址由配置确定。

| `apiMode` | 服务地址 | 工作人员和商户入口 |
| --- | --- | --- |
| `development`（默认） | `apiBaseUrl`，仅允许 HTTP 回环 `127.0.0.1` 或 `[::1]` | 本地测试令牌 |
| `production` | `productionApiBaseUrl`，由项目方填入经批准的 HTTPS origin | 微信登录 |

正式 origin 使用小写域名，例如 `https://intake.example.test`（合成占位地址）。可带与微信配置完全一致的端口。省去路径和末尾斜杠，禁止用户信息、查询参数、片段及 IP 地址。配置缺失或不合规时不会回退到其他环境，也不会发出请求。正式入口的业务请求、本人查询与核验、图片上传、下载和发布均使用该 origin。

微信登录调用 `wx.login`，将一次性 code 交给项目后端的 `POST /api/v1/auth/wechat/session`。返回的身份须与当前窗口匹配。失败后再次点击登录会重新获取 code。工作人员和商户令牌仅保存在当前页面内存，到期、失权、退出或隐藏后清除。本人核验沿用自己的授权流程。 [微信登录后端契约](../server/README.md#管理方和商户微信登录) · [微信登录文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)

## 正式联调依赖

当前 [project.config.json](project.config.json) 保留游客 AppID 和本地 `urlCheck: false`。正式联调时，由项目方在微信开发者工具使用获授权 AppID，配置同一 HTTPS 地址为 request 合法域名，并启用域名和证书校验。网关需在该 origin 直接提供 API，涉及凭据的请求避免重定向。后端须启用微信换码并提供获批准的工作人员及商户绑定。 [微信网络请求配置](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)

本地用 `npm.cmd test` 验证。正式 HTTPS 用例模拟 `wx.login`、`wx.request` 和文件操作，实际回环测试仍使用合成数据。真实微信登录、证书、域名白名单及真机选图上传和预览留待账号和设备联调。

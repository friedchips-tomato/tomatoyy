# 微信小程序 6 页界面示意图（静态绘制）

**这些图不是真机截图。** 仓库没有微信开发者工具，无法编译运行 `changdi-intake/miniprogram`，
所以本页 6 张竖图是按仓库真实页面结构手工绘制的界面示意图，供 11-28 初期答辩展示用。

每张图顶部都标注了「界面示意图 · 仓库无微信开发者工具 · 未真机运行」。

| 图 | 真实页面 |
| --- | --- |
| `01-home.png` | `changdi-intake/miniprogram/pages/home/index` |
| `02-submit.png` | `changdi-intake/miniprogram/pages/submit/index` |
| `03-mine.png` | `changdi-intake/miniprogram/pages/mine/index` |
| `04-public.png` | `changdi-intake/miniprogram/pages/public/index` |
| `05-merchant.png` | `changdi-intake/miniprogram/pages/merchant/index` |
| `06-staff.png` | `changdi-intake/miniprogram/pages/staff/index` |

## 画法约定

- 尺寸 750×1334 竖版，比例与小程序 rpx 设计稿一致。
- 配色取自 `prototype-paper/paper.css`（米黄纸面、米白纸卡、细红框、朱红主按钮）。
- 图上所有字段、文案、按钮都来自真实页面（`*.wxml` / `*.js`），没有画页面上不存在的功能。
- 灰褐色小字（如「工单详情视图：」）是示意图的版面说明，不属于应用界面。
- 商户页与工作台页内容较长，底部渐隐表示页面可继续下滑。
- 图里的工单编号、公开查询码、私密查询凭证都是 `render.py` 里**写死的演示值**，
  不对应任何真实工单或凭证，也不来自真实环境；请勿当作可用的查询码或凭证。
- 这些图从未真机运行（仓库没有微信开发者工具），只用于说明页面结构，不代表生产界面。

## 重新生成

```sh
python render.py
```

依赖：Pillow（本机 Windows 用 `C:\Windows\Fonts\simsun.ttc` / `msyh.ttc`）。
脚本只读 `changdi-intake/miniprogram/pages/**`，不改任何业务代码。

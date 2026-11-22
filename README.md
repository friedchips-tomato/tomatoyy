# 长堤风貌街 · 文旅导览原型

江门长堤历史文化街区的竖屏 H5 导览原型，配套一个值班运营台。全部是前端演示：点位、停车、预约、工单都是示意数据，没有接真实后端。

## 两版界面

| 目录 | 说明 |
| --- | --- |
| `prototype/` | 第一版像素风基线，保留原样 |
| `prototype-paper/` | 侨批纸质风版本，当前主版本：游客端全部页面 + 值班运营台 |
| `design/qiaopi-mock/` | 纸质风设计样张与点位卡配图对比 |

两版的本地记录分开保存（旧版 `cd-demo-v1`，纸质版 `cd-paper-v1`），互不影响。

## 快速预览

在仓库根目录启动一个静态服务：

```sh
python3 -m http.server 8931 --bind 127.0.0.1
```

然后打开：

- 游客端（纸质版）：<http://127.0.0.1:8931/prototype-paper/>
- 值班运营台：<http://127.0.0.1:8931/prototype-paper/ops.html>
- 点位卡配图对比：<http://127.0.0.1:8931/prototype-paper/pic-compare.html>
- 游客端（像素版）：<http://127.0.0.1:8931/prototype/>

纸质版支持在网址后加 `?pic=mount`（默认）、`?pic=crop` 或 `?pic=stamp`，切换点位卡的三种配图做法。

页面是原生 HTML / CSS / JavaScript，不需要安装依赖。

## 功能

游客端：

- 街景看楼与收卡、七枚印格进度
- 点位卡、详情页、三种语言的讲解文稿（普通话 / 粤语 / English）
- 游记回听、沿街行程单、路线推荐与途中导航
- 到站讲解、扫码到站（演示）
- 讲解员预约、停车比较、游客反馈、我的 / 卡册 / 记录

值班运营台：

- 总览、诉求工单（分派、处理、办结、评价）、讲解预约、车场状态、点位内容
- 读取同一浏览器里游客端提交的诉求和预约，处理结果同步回游客端「我的」

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `prototype-paper/index.html` `styles.css` `app.js` | 游客端页面、样式与逻辑 |
| `prototype-paper/ops.html` `ops.css` `ops.js` | 值班运营台 |
| `prototype-paper/paper.css` | 两端共用的纸质风组件 |
| `prototype-paper/data/points.js` | 点位、故事、路线、讲解员、停车示范数据 |
| `prototype-paper/assets/` | 示意地图、建筑小卡、撕纸边素材 |
| `prototype-paper/screenshots/` | 逐页验收截图与汇总图 |
| `prototype-paper/tests/` | 游客端与运营台的浏览器走查脚本 |
| `prototype/` | 第一版像素风原型（含自检与浏览器测试） |
| `docs/` | 需求材料、分阶段清单与上线总清单 |

## 验证

静态自检：

```sh
node prototype-paper/check.mjs
node prototype/check.mjs
```

浏览器走查（需要 `playwright-core`，可用 `NODE_PATH` 指定其所在 `node_modules`）：

```sh
python3 -m http.server 8931 --bind 127.0.0.1 &
node prototype-paper/tests/pages.cjs http://127.0.0.1:8931/prototype-paper/
node prototype-paper/tests/ops.cjs http://127.0.0.1:8931/prototype-paper/
```

脚本会把截图写回 `prototype-paper/screenshots/`。

## 已知边界

- 点位位置、建筑外观、停车数据都是示意数据，未经现场核实。
- 没有后端：预约、工单、停车状态只存在当前浏览器的本地存储，注销或换浏览器就没了。
- 讲解使用浏览器自带的语音合成，缺对应语种时退回逐字文稿。
- 扫码和到站通过页面里的点位列表模拟，不是真实的二维码 / NFC。
- 微信小程序原生端还没接（本机缺微信开发者工具），仓库里只有 H5 原型。
- 没有上线授权，也没有接入生产数据。

## 文档

- [长堤导览 · 从像素样板到上线总清单](docs/长堤导览-从样板到上线总清单.md)
- [像素地图方案清单](docs/像素地图方案清单.md)
- [方案清单](docs/方案清单.md)

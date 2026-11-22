# 长堤风貌街 · 侨批纸质版（游客端 H5 + 值班运营台）

以 `design/qiaopi-mock` 的 11:25 样张为准，把纸质风推广到全部页面。旧版像素风原型 `prototype/` 原样保留，本目录不改动它的任何文件。两版的本地记录也分开保存（旧版 `cd-demo-v1`，新版 `cd-paper-v1`）。

## 打开

在仓库根目录启动 HTTP 预览，然后打开对应页面。

```sh
python3 -m http.server 8931 --bind 127.0.0.1
```

| 页面 | 地址 |
| --- | --- |
| 游客端（手机竖屏） | `http://127.0.0.1:8931/prototype-paper/` |
| 值班运营台（桌面与手机） | `http://127.0.0.1:8931/prototype-paper/ops.html` |
| 点位卡配图对比 | `http://127.0.0.1:8931/prototype-paper/pic-compare.html` |

游客端网址加 `?pic=crop`、`?pic=mount`（默认）或 `?pic=stamp`，可以在真页面里切换三种配图做法。

## 风格规则

| 项目 | 规则 |
| --- | --- |
| 纸面 | 顶栏和底栏 `#efe6d2`，信笺弹层 `#f6efe0`，纸面干净，不铺纸纹 |
| 撕纸边 | 只出现在纸与地图交界处：顶部纸下缘、底部纸上缘、半屏弹层上缘。整页（详情、讲解、游记）和运营台不接地图，所以没有撕纸边 |
| 内容卡 | 米白纸卡 `#fbf7ec` 加细红框，弹层和运营台主区带同一套信笺红框与竖格 |
| 字体 | 标题、楼名、数字用宋体（Songti SC），正文和控件用苹方 |
| 颜色 | 墨色 `#2b2723`，朱红 `#b23a2a` 只用于主按钮、印章、选中和警示 |
| 按钮 | 主按钮朱红满底胶囊，次按钮细红框胶囊，文字按钮朱红小字 |
| 动效 | 统一 `--t-fast .16s`、`--t .26s`、`--t-slow .6s` 与同一条缓动曲线。系统开启减少动效时全部关闭 |
| 配图 | B 衬纸相角，全站一致。缩略图裁到楼体，收卡和详情大图显示整张小卡，未点亮时同一张卡去色 |

共用的颜色、字体、纸卡和控件放在 `paper.css`，游客端与运营台都引用它。

## 文件

| 文件 | 用途 |
| --- | --- |
| `index.html` `styles.css` `app.js` | 游客端：地图、点位卡、讲解、收卡、路线、服务、我的、游记 |
| `ops.html` `ops.css` `ops.js` | 值班运营台：总览、诉求工单、讲解预约、车场、点位内容 |
| `paper.css` | 两端共用的纸质风组件 |
| `pic-compare.html` | 点位卡配图三种做法对比 |
| `data/points.js` | 从 `prototype/data/points.js` 原样复制 |
| `assets/` | 地图、小卡 JPG，以及样张的两张撕纸边 PNG |
| `check.mjs` | 静态自检（复制自旧版） |
| `tests/pages.cjs` `tests/ops.cjs` | 逐页走查并截图 |

## 运营台与游客端的联动

运营台读取游客端在本机提交的诉求和预约，并与示范数据合并显示。分派、处理、办结工单，确认或婉拒预约，以及把车场标记为陈旧，都写入 `cd-paper-ops-v1`。游客端「我的」中的诉求进度和预约状态，以及停车卡的“数据已过时”提示，随之更新。这些联动只在同一浏览器内演示，并不对应真实后台。

## 验收

```sh
node prototype-paper/check.mjs
NODE_PATH=<含 playwright-core 的 node_modules> node prototype-paper/tests/pages.cjs http://127.0.0.1:8931/prototype-paper/
NODE_PATH=<含 playwright-core 的 node_modules> node prototype-paper/tests/ops.cjs http://127.0.0.1:8931/prototype-paper/
```

截图写入 `screenshots/h5/`（390×844）和 `screenshots/ops/`（390×844 与 1280×800），汇总图为 `screenshots/board-h5.png`、`screenshots/board-ops.png` 和 `screenshots/pic-compare.png`。

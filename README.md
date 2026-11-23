# 乐游蓬江 AI 智慧导览小程序

江门长堤风貌街「乐游蓬江 AI 智慧导览小程序」的项目仓库。仓库里有三块可以各自独立跑起来的东西：

1. **导览原型** —— 两版可交互 H5 原型（像素风基线 + 侨批纸质风主版本）与配套的值班运营台。
2. **接诉即办平台** —— 微信小程序前端 + Node / 内置 SQLite 后端 + 把导览端接进接诉即办的本地接入层（guide-bridge）。
3. **停车预测** —— Python 离线管线（合成数据 → 特征 → 基线 → 训练 → 回测 → 产物）与零依赖 Node 运行时。

> **先把边界说在前面**：接诉即办与停车预测都是本地纵切，**没有上线授权、没有生产数据**；导览侧的微信小程序原生端还没接，仓库里只有 H5 原型。停车模型的数据全部是合成数据。逐条清单见文末「已知边界」。

## 目录总览

```text
.
├── prototype/              ① 第一版像素风导览原型（基线，原样保留）
├── prototype-paper/        ① 侨批纸质风导览原型：游客端 + 值班运营台（当前主版本）
├── design/qiaopi-mock/    ① 纸质风设计样张与点位卡配图对比
├── changdi-intake/         ② 接诉即办平台
│   ├── server/               Node + 内置 SQLite 后端
│   ├── miniprogram/          微信小程序前端
│   ├── guide-bridge/         导览接入层（把 prototype-paper 接到后端）
│   └── docs/                 OpenAPI 契约与联调说明
├── parking-forecast/      ③ 停车预测离线管线、回测产物与 Node 运行时
└── docs/                  项目级文档（方案清单、上线总清单、导览端诉求说明）
```

---

## 一、导览原型（H5）

### 目录

| 目录 | 说明 |
| --- | --- |
| `prototype-paper/` | 侨批纸质风：游客端全部页面 + 值班运营台，当前主版本 |
| `prototype/` | 第一版像素风基线，保留原样 |
| `design/qiaopi-mock/` | 纸质风设计样张与配图对比 |

两版的本地记录分开保存（旧版 `cd-demo-v1`，纸质版 `cd-paper-v1`），互不影响。

### 跑起来

在**仓库根目录**起一个静态服务（端口 **8931**）：

```sh
python -m http.server 8931 --bind 127.0.0.1
```

> Windows 上命令是 `python`；macOS / Linux 上用 `python3`。

然后打开：

| 页面 | 地址 |
| --- | --- |
| 游客端（纸质版） | <http://127.0.0.1:8931/prototype-paper/> |
| 值班运营台 | <http://127.0.0.1:8931/prototype-paper/ops.html> |
| 点位卡配图对比 | <http://127.0.0.1:8931/prototype-paper/pic-compare.html> |
| 游客端（像素版） | <http://127.0.0.1:8931/prototype/> |

纸质版支持在网址后加 `?pic=mount`（默认）、`?pic=crop` 或 `?pic=stamp`，切换点位卡的三种配图做法。

页面是原生 HTML / CSS / JavaScript，**不需要安装任何依赖**。

### 入口文件

| 入口 | 文件 |
| --- | --- |
| 游客端（纸质版） | `prototype-paper/index.html` + `styles.css` + `app.js`（共用 `paper.css`） |
| 值班运营台 | `prototype-paper/ops.html` + `ops.css` + `ops.js` |
| 游客端（像素版） | `prototype/index.html` + `styles.css` + `app.js` |
| 示意数据 | `prototype-paper/data/points.js`（自 `prototype/data/points.js` 原样复制） |
| 静态自检 | `prototype-paper/check.mjs`、`prototype/check.mjs` |
| 浏览器走查 | `prototype-paper/tests/pages.cjs`、`ops.cjs`、`parking.cjs`、`intake.cjs` |
| 验收截图 | `prototype-paper/screenshots/`（`h5/` 游客端、`ops/` 运营台、`parking/` 停车、`intake/` 接诉即办，以及汇总图 `board-h5.png`、`board-ops.png`）；像素版在 `prototype/screenshots/` |

### 功能

游客端：

- 街景看楼与收卡、七枚印格进度
- 点位卡、详情页、三种语言的讲解文稿（普通话 / 粤语 / English）
- 游记回听、沿街行程单、路线推荐与途中导航
- 到站讲解、扫码到站（演示）
- 讲解员预约、停车比较、游客反馈、我的 / 卡册 / 记录

值班运营台：

- 总览、诉求工单（分派、处理、办结、评价）、讲解预约、车场状态、点位内容
- 读取同一浏览器里游客端提交的诉求和预约，处理结果同步回游客端「我的」

### 验证

静态自检（无需浏览器）：

```sh
node prototype-paper/check.mjs
node prototype/check.mjs
```

浏览器走查需要 `playwright-core` 与本机 Edge，命令见 [DEPENDENCIES.md](DEPENDENCIES.md)：

```sh
npm install                # 装 playwright-core（走查脚本唯一依赖，node_modules 已被 .gitignore 忽略）
python -m http.server 8931 --bind 127.0.0.1 &
node prototype-paper/tests/pages.cjs http://127.0.0.1:8931/prototype-paper/
node prototype-paper/tests/ops.cjs http://127.0.0.1:8931/prototype-paper/
```

> Windows 上命令是 `python`；macOS / Linux 上用 `python3`。Windows 的 `python3` 是 Microsoft Store 存根，退出码 49，直接执行会失败。
>
> 走查脚本自动探测本机 Microsoft Edge（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）；
> 需要换浏览器时设环境变量 `CHROMIUM_PATH` 指向浏览器可执行文件；两者都找不到时脚本打印中文报错并以退出码 2 退出。

脚本会把截图写回 `prototype-paper/screenshots/`。

---

## 二、接诉即办平台

三部分：后端（Node / SQLite）、微信小程序前端、导览接入层。零第三方运行依赖。

### 2.1 后端（Node ≥ 22.17 + 内置 `node:sqlite`）

- **目录**：`changdi-intake/server/`
- **端口**：**3400**（只监听 `127.0.0.1`；可用 `CHANGDI_PORT` 改）
- **入口文件**：`changdi-intake/server/src/main.js`（`npm start` → `node src/main.js`）
- **数据库**：`changdi-intake/server/.local/intake.sqlite`（Git 忽略）
- **建表迁移**：`changdi-intake/server/migrations/001-initial.sql` … `014-tourism-events.sql`
- **接口契约**：`changdi-intake/docs/openapi.yaml`（合作方唯一接单接口 `POST /api/v1/integrations/intake/cases`）

跑起来（下面两条环境变量是**最低要求**，实测可启动）：

```sh
cd changdi-intake/server
export CHANGDI_RECEIPT_KEY="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
export CHANGDI_INTEGRATIONS_JSON='[{"source":"local-demo","token":"'"$(node -p "require('node:crypto').randomBytes(24).toString('base64url')")"'"}]'
npm start
# changdi-intake listening on http://127.0.0.1:3400
```

- `CHANGDI_RECEIPT_KEY` —— 回执加密密钥，43 位 base64url（32 字节）。缺失、或换库不换密钥，都会启动失败。
- `CHANGDI_INTEGRATIONS_JSON` —— 合作方接入方列表，**至少一条** `{source, token}`，否则报 `Invalid identity configuration`。

完整联调还要配工作人员、商户、监督与导览来源等，完整清单见 [`changdi-intake/server/README.md`](changdi-intake/server/README.md)（`CHANGDI_STAFF_JSON`、`CHANGDI_MERCHANTS_JSON`、`CHANGDI_TOURISM_JSON`、`CHANGDI_SUPERVISION_JSON`、`CHANGDI_REPRESENTATIVE_REPORTS_JSON`、`CHANGDI_WECHAT_CODE_ENABLED`、`CHANGDI_WECHAT_LOGIN_ENABLED`）。

测试：

```sh
cd changdi-intake/server && npm test    # node --test，实测 140 条通过
```

### 2.2 微信小程序前端

- **目录**：`changdi-intake/miniprogram/`
- **端口**：不监听端口；小程序通过 `apiBaseUrl` 访问后端
- **入口文件**：`changdi-intake/miniprogram/app.js` + `app.json`（6 个页面：`home` / `submit` / `mine` / `public` / `merchant` / `staff`）

跑起来：用**微信开发者工具**「导入项目」，选 `changdi-intake/miniprogram/` 目录。`project.config.json` 里已带游客 AppID 与 `urlCheck: false`。

环境切换在 `changdi-intake/miniprogram/config.js`：`development` 走 `apiBaseUrl`（只允许 `127.0.0.1` / `[::1]` 回环），`production` 走 `productionApiBaseUrl`（需项目方填入经批准的 HTTPS origin）。切换环境须重新构建小程序。

测试：

```sh
cd changdi-intake/miniprogram && npm test    # node --test test/*.test.js，实测 253 条通过
```

### 2.3 导览接入层（guide-bridge）

- **目录**：`changdi-intake/guide-bridge/`
- **端口**：**8932**（只监听 `127.0.0.1`；可用 `GUIDE_BRIDGE_PORT` 改）
- **入口文件**：`changdi-intake/guide-bridge/server.js`（`npm start` → `node server.js`）

它做什么：把 `prototype-paper/` 整个目录挂在 8932 上（`/` → `prototype-paper/index.html`），并注入 `/bridge/client.js`。游客在导览「服务 → 反馈」提交时，由桥以合作方身份把内容转发到后端唯一接单接口；导览行为事件则经 `/bridge/tourism-events` 上报。

跑起来（**先起后端 3400**，再起桥）：

```sh
cd changdi-intake/guide-bridge
export GUIDE_INTAKE_TOKEN='<与后端 CHANGDI_INTEGRATIONS_JSON 里同一条接入方的 token>'
export GUIDE_INTAKE_ORIGIN='http://127.0.0.1:3400'
npm start
# Guide bridge: http://127.0.0.1:8932/
```

然后打开 <http://127.0.0.1:8932/> —— 这就是接上了接诉即办的游客端。`GUIDE_METRICS_TOKEN` 用于导览行为采集，必须与接单 token 不同，否则启动失败。

测试：

```sh
cd changdi-intake/guide-bridge && npm test   # 实测 21 条通过
```

浏览器端到端走查（需要 `playwright-core` 与本机 Edge，见 [DEPENDENCIES.md](DEPENDENCIES.md)）：

```sh
cd changdi-intake/guide-bridge && node browser-check.cjs
```

### 2.4 三块怎么串起来

一次完整的本地联调顺序：

1. 起后端 **3400**（§2.1）。
2. 起接入层 **8932**（§2.3），它把 `prototype-paper` 挂到 8932。
3. 打开 <http://127.0.0.1:8932/> 提交诉求 —— 回执（工单号 + 公开查询码 + 本人私密凭证）由桥写进后端 SQLite。
4. 小程序端（§2.2）在 `development` 模式下访问 `http://127.0.0.1:3400`（`config.js` 的 `apiBaseUrl` 缺省就是它），办理查询、查看反馈、评价、补件与补办。

---

## 三、停车预测

离线管线，不监听端口。

- **目录**：`parking-forecast/`
- **端口**：无（纯离线管线 + 零依赖 Node 运行时）
- **入口文件**：`parking-forecast/src/pf/`（Python 管线）与 `parking-forecast/runtime/index.mjs`（Node 运行时）

### 跑起来（复算）

```sh
cd parking-forecast

# 重新生成产物 artifacts/{model.json,metrics.json,manifest.json,report.md}
PYTHONPATH=src python scripts/report.py

# Python 测试（实测 67 条通过）
python -m pytest tests -q

# Node 运行时测试：与 Python 逐位比对（实测 18 条通过）
node --test "runtime/test/*.test.mjs"

# 重新生成浏览器产物 prototype-paper/data/{parking-artifact.js,parking-runtime.js}
node scripts/export_browser.mjs
node scripts/export_browser.mjs --check   # 只校验，不写盘
```

### 入口文件

| 环节 | 文件 |
| --- | --- |
| 数据契约 | `parking-forecast/schemas/*.schema.json`（6 份 JSON Schema） |
| 合成数据生成 | `parking-forecast/src/pf/synth.py` |
| 统一读取层 | `parking-forecast/src/pf/dataset.py` |
| 特征 / 基线 / 训练 | `parking-forecast/src/pf/features.py`、`baselines.py`、`train.py` |
| 回测 | `parking-forecast/src/pf/backtest.py` |
| 推荐 | `parking-forecast/src/pf/recommend.py` |
| 产物导出 | `parking-forecast/src/pf/export.py`、`parking-forecast/scripts/report.py` |
| 浏览器产物导出 | `parking-forecast/scripts/export_browser.mjs` → `prototype-paper/data/parking-artifact.js`、`parking-runtime.js` |
| Node 运行时（零依赖 ESM） | `parking-forecast/runtime/index.mjs`、`features.mjs`、`forecast.mjs`、`recommend.mjs`、`reasons.mjs`、`format.mjs` |

产物：`parking-forecast/artifacts/`（`model.json`、`metrics.json`、`manifest.json`、`report.md`）。全部数据 `source: "synthetic"`。详见 [`parking-forecast/README.md`](parking-forecast/README.md)。

---

## 已知边界

- 点位位置、建筑外观、停车与讲解员信息都是示意数据，**未经现场核实**。
- **微信小程序原生导览端还没接**：仓库里只有 H5 原型（`prototype/`、`prototype-paper/`）；小程序那套目前只有接诉即办前端（`changdi-intake/miniprogram/`）。
- **没有上线授权，也没有接入生产数据**。后端与接入层都只跑在 `127.0.0.1` 回环上，且 `NODE_ENV=production` 时直接报错退出 —— 本地纵切不等于生产验收。
- 停车数据全部是合成数据，模型精度口径（WAPE）未经需求方书面确认，**不自称达标**。
- 导览行为采集的「管理方月报」未授权公开，界面上标注「暂无经授权公开的数据」。
- 浏览器走查需要 `playwright-core` 与本机 Edge，两者都不是仓库自带依赖，见 [DEPENDENCIES.md](DEPENDENCIES.md)。
- 原型里值班运营台与游客端的联动只存在同一浏览器的 localStorage 中，不对应真实后台；讲解用浏览器语音合成；扫码与到站是页面内模拟，没有真实二维码 / NFC。
- 接诉即办回执的私密凭证只在当前页面内存里展示，不进 URL、二维码或浏览器持久存储；提交结果未知时不要重新提交新单，应先联系工作人员核查。

## 文档索引

项目级文档：

- [长堤导览 · 从样板到上线总清单](docs/长堤导览-从样板到上线总清单.md)
- [方案清单](docs/方案清单.md)
- [像素地图方案清单](docs/像素地图方案清单.md)
- [接诉即办 · 导览端「我的诉求」](docs/接诉即办-导览端我的诉求.md)
- [停车预测与推荐（parking-forecast）](parking-forecast/README.md)

子项目说明：

- [接诉即办后端](changdi-intake/server/README.md)
- [导览与接诉即办本地接入层](changdi-intake/guide-bridge/README.md)
- [小程序运行环境](changdi-intake/miniprogram/README.md)
- [侨批纸质版原型](prototype-paper/README.md)
- [像素版原型](prototype/README.md)

接诉即办自带的契约与联调说明在 `changdi-intake/docs/`（`openapi.yaml`、`miniprogram-flow.md`、`guide-integration.md`、`parking-api.md`、`local-acceptance.md` 等）。

## 运行环境与依赖

见 [DEPENDENCIES.md](DEPENDENCIES.md)。简要说：Node ≥ 22.17、Python 3.11 + numpy + scikit-learn 是必需的；`playwright-core` 与本机 Edge 只在跑浏览器走查时才需要。

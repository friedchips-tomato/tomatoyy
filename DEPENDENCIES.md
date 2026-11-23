# 运行环境与依赖清单

本文件列出这个仓库跑起来需要的全部东西，以及每一项**是为了什么**才需要它。

**版本号都是本机实测出来的**（2026-11-23，Windows 11 x64）。复现命令见文末「自己核对版本」。

## 一览表

| 组件 | 实测版本 | 必需性 | 装它是为了什么 |
| --- | --- | --- | --- |
| Node.js | **v22.17.0** | 必需 | 跑接诉即办后端、导览接入层、静态自检、浏览器走查脚本与停车 Node 运行时 |
| npm | **10.9.2** | 必需（随 Node 一起装） | 跑三个 `package.json` 的 `start` / `test` 脚本。**但仓库不需要 `npm install`** |
| Python | **3.11.9** | 停车预测必需 | 跑停车预测的合成数据、训练、回测与产物导出 |
| numpy | **1.26.4** | 停车预测必需 | 合成数据生成器与特征构造（`numpy.random.default_rng`） |
| scikit-learn | **1.8.0** | 停车预测必需 | 训练基线：`Ridge`、`HistGradientBoostingRegressor` |
| pytest | **9.0.2** | 停车预测必需 | 跑 `parking-forecast/tests` |
| playwright-core | **1.65.1** | **可选**，浏览器走查才需要 | 驱动本机 Edge 做逐页截图走查与端到端验收 |
| Microsoft Edge | **157.0.4341.60** | **可选**，浏览器走查才需要 | 给 `playwright-core` 提供 Chromium 内核浏览器 |
| 微信开发者工具 | **2.02.2609250** | **可选**，跑小程序端才需要 | 打开 `changdi-intake/miniprogram/` 做预览与前后端联调 |

## 逐项说明

### Node.js ≥ 22.17 —— 必需

- **装它是为了什么**：三处硬需求。
  1. 后端用 Node 内置的 `node:sqlite`（`DatabaseSync`），需要 Node 22.5+；三个 `package.json` 都声明 `"engines": { "node": ">=22.17" }`。
  2. 走查与测试脚本用 `node:test` / `node:assert`。
  3. `parking-forecast/runtime/*.mjs` 是 Node ESM 运行时。
- **装法**：官网安装包 <https://nodejs.org/>，或用 nvm-windows 管理多版本。
- **校验**：`node -v` 应输出 `v22.17.0` 或更高。
- **实测**：这台机器上跑通了后端 143 条、接入层 27 条、小程序 253 条、停车 runtime 18 条测试，以及两版原型的静态自检。

### npm 10.9.2 —— 必需（随 Node 一起装）

- **装它是为了什么**：`changdi-intake/server`、`changdi-intake/guide-bridge`、`changdi-intake/miniprogram` 三个 `package.json` 的 `start` / `test` 都靠 npm 调起。
- **注意：`npm install` 不需要跑。** 这三个 `package.json` 都没有 `dependencies` 字段 —— 后端与接入层是零第三方运行依赖，仓库里也没有 `package-lock.json` 和 `node_modules`。直接把目录 clone 下来就能 `npm start`。
- **校验**：`npm -v` 应输出 `10.9.2` 或更高。

### Python 3.11 + numpy + scikit-learn —— 停车预测必需

- **装它是为了什么**：
  - `parking-forecast/src/pf/synth.py` 用 `numpy.random.default_rng(seed)` 生成可复现的合成数据；
  - `parking-forecast/src/pf/train.py` 用 scikit-learn 的 `Ridge` 与 `HistGradientBoostingRegressor` 训练基线；
  - `parking-forecast/src/pf/schema.py` 是**自写的**最小 JSON Schema 校验器，**不引第三方 `jsonschema`**；
  - `parking-forecast/src/pf/dataset.py` 的读取层是纯标准库。
- **装法**：

  ```sh
  python -m pip install numpy scikit-learn pytest
  ```

  本机实测版本：Python **3.11.9**、numpy **1.26.4**、scikit-learn **1.8.0**、pytest **9.0.2**（pip 26.1.2）。
- **校验**：

  ```sh
  python --version
  python -c "import numpy,sklearn;print(numpy.__version__,sklearn.__version__)"
  # 期望输出：1.26.4 1.8.0
  ```

- **命令名注意**：Windows 上命令是 `python`；macOS / Linux 上是 `python3`。本机 `python3` 是 Windows 的应用商店占位符，直接跑会失败。

### playwright-core —— 可选，只有浏览器走查才需要

- **装它是为了什么**：静态自检（`node prototype-paper/check.mjs`）和 `node:test` 单测都**不需要浏览器**。只有下面这几件事需要真实浏览器：
  - `prototype-paper/tests/pages.cjs`（游客端逐页截图）
  - `prototype-paper/tests/ops.cjs`（值班运营台逐页截图）
  - `prototype-paper/tests/parking.cjs`、`prototype-paper/tests/intake.cjs`
  - `changdi-intake/guide-bridge/browser-check.cjs`（端到端回执、重试、行为事件落库、月报复算）
- **装法**：装在**仓库根目录**（根 `package.json` 已声明 `playwright-core` 为 devDependency；`node_modules/` 已在 `.gitignore` 里，不会进 Git）：

  ```sh
  # 在仓库根目录
  npm install
  # 只想临时装一次、不写 package-lock.json：
  npm install --no-save playwright-core
  ```

  不装到全局、不用 `NODE_PATH`：脚本用 `require('playwright-core')`，从仓库根的 `node_modules` 就能解析到。

- **用法**：浏览器可执行文件由脚本**自动探测**本机 Microsoft Edge，必要时用环境变量 `CHROMIUM_PATH` 覆盖。

  ```sh
  # 仓库根目录（默认自动探测 Edge，无需设任何环境变量）
  node prototype-paper/tests/pages.cjs http://127.0.0.1:8931/prototype-paper/

  # 换浏览器时才需要显式指定
  # PowerShell
  $env:CHROMIUM_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  ```

  本机实测：仓库根 `npm install` 装到 `playwright-core@1.65.1`，自动探测命中
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，4 个走查脚本全部 exit 0。
- **注意**：`playwright-core` **不自带浏览器**。脚本的探测顺序是：① 环境变量 `CHROMIUM_PATH` →
  ② `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` → ③ `C:\Program Files\Microsoft\Edge\Application\msedge.exe`
  → ④ macOS 的 playwright 缓存路径。全部找不到时脚本打印中文报错并以**退出码 2** 退出。

### Microsoft Edge —— 可选，走查用的浏览器

- **装它是为了什么**：给 `playwright-core` 一个可启动的 Chromium 内核浏览器。
- **本机路径与版本**：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，实测 **157.0.4341.60**。
- **装法**：Windows 11 一般预装 Edge；没有就从 <https://www.microsoft.com/edge/download> 装。
- **用法**：走查脚本默认自动探测这个路径，不用手动设 `CHROMIUM_PATH`；要换浏览器才需要指定。

### 微信开发者工具 —— 可选，跑小程序端才需要

- **装它是为了什么**：`changdi-intake/miniprogram/` 是微信小程序工程，没有开发者工具就无法预览、真机调试或做前后端联调。
- **本机路径与版本**：`C:\Program Files (x86)\Tencent\微信web开发者工具\微信开发者工具.exe`，实测 **2.02.2609250**。
- **装法**：微信开发者工具官网下载安装。
- **用法**：打开开发者工具 →「导入项目」→ 选 `changdi-intake/miniprogram/` 目录。`project.config.json` 里已带游客 AppID 与 `urlCheck: false`；`development` 环境下把 `config.js` 的 `apiBaseUrl` 指向 `http://127.0.0.1:3400` 即可连本地后端。
- **重要**：导览侧的**微信小程序原生端还没接**（仓库里只有 H5 原型），所以这个工具当前只用来跑接诉即办小程序。

## 不需要装的东西

- **任何 npm 第三方运行依赖** —— 后端、接入层、小程序前端、停车 Node 运行时全部零依赖，没有 `package-lock.json`，不需要 `npm install`。
- **数据库服务** —— 后端用 Node 内置 `node:sqlite`，数据落在 `changdi-intake/server/.local/intake.sqlite`（Git 忽略），不需要另装 MySQL / PostgreSQL。
- **jsonschema** —— `parking-forecast/src/pf/schema.py` 是自写的最小校验器。
- **反向代理 / HTTPS 证书** —— 本地纵切只跑回环地址；正式部署需要的 HTTPS、限流、反向代理等不在本仓库范围内。

## 自己核对版本

```sh
node -v
npm -v
python --version
python -c "import numpy,sklearn;print(numpy.__version__,sklearn.__version__)"
python -m pytest --version
```

`playwright-core` 与 Edge / 微信开发者工具的版本查本机安装：

```sh
# playwright-core
node -p "require('playwright-core/package.json').version"   # 在仓库根执行（需先 npm install）

# Edge
powershell -NoProfile -Command "(Get-Item 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe').VersionInfo.ProductVersion"

# 微信开发者工具
node -p "JSON.parse(require('fs').readFileSync('C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/package.json','utf8')).version"
```

# 答辩素材截图总览

本目录是 11-28 答辩用的**全部界面截图总索引**。机器可读的索引在
[`index.json`](index.json)（6 组素材 + 1 组联动对照图，共 71 张 PNG），
每个分组的子索引在各自目录下的 `index.json`，所有 `file` 字段一律写成
**仓库根相对路径**，可用脚本逐张核对「索引 == 磁盘」。

> **重要声明：这里的全部截图都来自本地演示环境与原型页面，不是线上真机截图。**
> 停车余位、费用、预测曲线、讲解员与工单计数等数字均为**示范数据**；
> 小程序那 6 张是**静态绘制的界面示意图**（仓库里没有微信开发者工具，从未真机运行），
> 其中的工单编号 / 公开查询码 / 私密凭证是 `render.py` 里写死的**演示值**，不对应任何真实工单。
> 屏幕上的位置与年份等信息本身也标注了「待核实」。答辩时如被问到数据来源，
> 请直接说明是本地演示/原型环境，不要说成线上真实数据。

> **脱敏与证据：** `intake/` 的回执类截图（01 / 02 / 04）公开展示的是**脱敏副本**，
> 工单编号、公开查询码、本人私密凭证的完整值已遮挡或裁掉。含完整值的**原始证据不入库**，
> 仅保存在**仓库之外、由本机用户控制的目录**，本仓库与索引中不含任何原始证据。
> 脱敏副本由 [`tools/redact_intake.py`](tools/redact_intake.py) 从该仓库外目录重新生成。

## 目录结构

```
prototype-paper/screenshots/
├── index.json          总索引（groups：h5 / intake / ops / parking / miniprogram / paper / link）
├── README.md           本文件
├── h5/                 导览 H5 走查截图（29 张）+ h5/index.json
├── intake/             接诉即办接入层（4 张，01/02/04 为脱敏副本）+ intake/index.json
├── ops/                运营台值班台（16 张）+ ops/index.json
├── parking/            停车预测（4 张）+ parking/index.json
├── miniprogram/        微信小程序界面示意图（6 张）+ miniprogram/index.json
├── paper/              纸质原型组子索引（9 张，跨两处目录）+ paper/index.json
├── link/               3 张联动对照图 + link/index.json + render_link.py
└── tools/              索引构建 / 核对 / 脱敏脚本
```

`prototype/screenshots/`（像素导览走查 6 张）与 `prototype-paper/screenshots/`
根目录下的 3 张汇总大图（`board-h5.png` / `board-ops.png` / `pic-compare.png`）
合起来算作 **paper 组**。

## 各组说明

### h5 · 导览 H5 · 游客主流程（29 张）

覆盖游客从进入导览到玩完全程的主线：首页街景看楼 → 点位卡与点位详情 → 手动收听讲解 →
收卡盖印并点亮 → 故事线 → 沿街行程单（填写 / 三条候选路线 / 地图导航 / 行程单）→ 到站讲解 →
路线完成 → 扫码到站，以及服务侧（讲解员 / 讲解预约 / 预约已提交 / 停车 / 反馈 / 反馈已受理）
与个人中心（卡册 / 预约与诉求 / 游记回听 / 粤语讲解 / 空状态），另含 3 张点位卡配图对比素材。
**答辩时用**：讲游客端主流程与「点亮点位—收卡—成行程」的玩法时，按 01→13 顺序取图。
**拍摄时间**：2026-11-23。**拍摄方式**：`prototype-paper/tests/pages.cjs` 驱动本机
Microsoft Edge（自动定位浏览器），viewport 390×844，逐屏截图。

### intake · 接诉即办接入层 · 导览端回执与进度（4 张）

导览 H5 的「服务 → 反馈」表单接入接诉即办之后的 4 个真实界面状态：提交成功后的回执
（工单编号 / 公开查询码 / 本人私密凭证）、刷新后仍能从「我的诉求」面板查到状态与里程碑并
「重新查询」，以及两种降级态——查不到该工单、暂时查不到进度（上游异常）。
**公开展示的是脱敏副本**：01 的三项值、02 与 04 的工单编号都用「〔已脱敏〕」遮挡条覆盖；
完整值只保留在仓库外的本机留证目录，**不进入 Git、不对外展示**。
**答辩时用**：证明「一单受理、进度可查」与「查不到就直说、绝不编造进度」。
**拍摄时间**：2026-11-23。**拍摄方式**：`prototype-paper/tests/intake.cjs`，
本机 Microsoft Edge，viewport 390×844。

### ops · 运营台 · 值班视角（16 张）

值班台在桌面（1280×800）与手机（390×844）两种视口下的走查：值班总览（4 张统计卡：
待分派诉求 / 处理中诉求 / 待确认预约 / 实时车位（示范））、诉求工单列表与筛选计数、
工单详情（分派前 / 处理中）、讲解预约、车场点位、点位内容维护，外加运营台处理后
游客端「我的」与停车页的同步结果。**答辩时用**：讲运营侧怎么接单、怎么把结果回给游客。
**拍摄时间**：2026-11-23。**拍摄方式**：`prototype-paper/tests/ops.cjs`，本机 Microsoft Edge。

### parking · 停车预测 · 正常与降级（4 张）

停车推荐页的 4 种状态：正常预测卡片（余位、费用、步行距离、预测曲线）、偏好切换（少走路）、
预测产物损坏回退（暂不可用）、无产物回退。**答辩时用**：讲「停车推荐 + 降级兜底」，
重点展示坏产物时页面会明确写「预测暂不可用（产物缺失或版本不兼容），以上为静态示范数据」。
**拍摄时间**：2026-11-23。**拍摄方式**：`prototype-paper/tests/parking.cjs`，本机 Microsoft Edge，
viewport 390×844。

### miniprogram · 微信小程序 · 6 页界面示意图（6 张）

长堤风貌街接诉即办小程序 6 个页面的**静态绘制示意图**：首页（提交诉求 / 游客与居民 / 商户 /
管理方 四个入口）、提交诉求（匿名表单与提交回执）、我的诉求（本机回执夹与进度查询）、
公开查询（里程碑时间线、补件上传、三维评价）、商户（身份核验、本商户工单、协办送审）、
管理方工作台（7 个队列计数、工单列表、13 个办理动作、督办与协办）。
**答辩时用**：讲小程序端能力与工作台；**必须说明这是示意图、不是真机截图**。
**拍摄时间**：2026-11-23。**拍摄方式**：`prototype-paper/screenshots/miniprogram/render.py`
用 Pillow 按仓库真实页面静态绘制，750×1334（仓库无微信开发者工具，从未真机运行）。

### paper · 纸质原型 · 像素导览与汇总大图（9 张）

`prototype/screenshots/` 的像素导览走查 6 张（首页 / 点位 / 点亮 / 路线 / 停车 / 卡册），
加上三张汇总大图：导览端汇总大图 `board-h5.png`、运营台汇总大图 `board-ops.png`、
点位卡配图三种做法对比 `pic-compare.png`。**答辩时用**：页面无法现场打开时的兜底大图，
以及讲点位卡配图的三种做法。**拍摄时间**：像素导览 2026-11-22（`prototype/tests/mobile.cjs`，
viewport 390×844），汇总大图 2026-11-20。**拍摄方式**：本机 Microsoft Edge 走查截图 + 汇总大图导出。

### link · 联动对照图 · 3 张流程对照（3 张）

由已有截图裁剪拼版而成，**只做裁剪、缩放与必要的凭证脱敏，不改动其他界面内容**，底部有醒目说明条。
图 1 的回执步骤已裁掉「本人私密凭证」整行，工单编号与公开查询码只显示「〔已脱敏〕」遮挡条。

| 文件 | 讲什么 | 主要来源截图 |
| --- | --- | --- |
| `01-游客诉求闭环.png` | 导览端提交 → 回执（值已脱敏）→ 本机进度（编号已脱敏）→ 公开查询与三维评价 → 降级态 | `h5/01-home`、`h5/20-feedback`、`intake/01-receipt`、`intake/02-panel-after-refresh`、`intake/03-case-not-found`、`intake/04-upstream-down`、`miniprogram/04-public` |
| `02-处置流转闭环.png` | 7 个队列计数 → 工单列表 → 工单详情 → 处理 → 13 个办理动作与 3 个角色 → 复核结案 | `miniprogram/06-staff`、`ops/desk-01-overview`、`ops/desk-02-tickets`、`ops/desk-03-ticket-detail`、`ops/desk-04-ticket-processing` |
| `03-停车接驳联动.png` | 选目的地与到达时刻 → 停车推荐 → 停车场卡片与 1 小时预测 → 步行接驳导航 → 到站讲解（含预测降级态） | `parking/01-parking-normal`、`h5/19-parking-point`、`h5/10-route-nav`、`h5/12-arrival-listen`、`parking/03-parking-bad-artifact` |

图里的字段名、按钮名、队列名、状态名全部来自仓库真实页面
（`prototype-paper/app.js`、`prototype-paper/ops.js`、`changdi-intake/guide-bridge/client.js`、
`changdi-intake/miniprogram/pages/**`、`changdi-intake/server/**`），没有臆造流程或字段。
图 2、图 3 的来源截图已逐张检查：只有示范工单编号（如 `CD-20261120-0001`、`CD-DEMO-0001`）、
示范停车数据与「联系方式：已隐藏」等占位，没有真实联系方式、查询码或私密凭证。
**拍摄时间**：2026-11-23。**拍摄方式**：`prototype-paper/screenshots/link/render_link.py`
（Pillow 拼版，离线，不依赖网络）。

### 原始证据（不入库）

含完整工单编号、公开查询码与本人私密凭证的 01 / 02 / 04 原始截图**不保存在本仓库**，
也不进入 Git 与任何提交历史；它们仅保存在**仓库之外、由本机用户控制的留证目录**，
**禁止公开展示、截图转发或上传到任何公开渠道**。对外展示一律使用 `intake/` 下的同名脱敏副本。

## 重新生成与核对

```bash
# 重建总索引与各组子索引（顺带核对「索引 == 磁盘」）
PYTHONIOENCODING=utf-8 python prototype-paper/screenshots/tools/build_index.py

# 只核对：索引里每个 file 都存在、磁盘上每个 png 都登记、两边数量相等
PYTHONIOENCODING=utf-8 python prototype-paper/screenshots/tools/verify_index.py

# 从仓库外的证据目录重新生成 intake 脱敏展示副本（覆盖 intake/01、02、04）
# --evidence-dir 必须指向仓库之外、由本机用户控制的原始截图目录；脚本会拒绝仓库内路径
PYTHONIOENCODING=utf-8 python prototype-paper/screenshots/tools/redact_intake.py --evidence-dir <仓库外证据目录>

# 重画 3 张联动对照图（使用 intake 脱敏副本）
python prototype-paper/screenshots/link/render_link.py
```

当前核对结果：索引 **71 条 = 磁盘 71 张 PNG**，两边数量相等，核对通过。
其中**公开展示截图 71 张（含 3 张联动对照图）**，**不含 `link/` 的公开展示截图 68 张**。
索引与磁盘均只含脱敏展示图，**不含任何原始证据**（原始证据保存在仓库外本机目录）。

## 已知注意事项

- `h5/index.json`、`ops/index.json`、`parking/index.json` 原先由走查脚本直接写入**绝对路径**，
  且指向的是另一个 worktree（`t1-walkthrough-v3`），在本仓库里已经失效；本次统一改成
  仓库根相对路径。**如果重跑 `prototype-paper/tests/pages.cjs`、`ops.cjs`、`parking.cjs`，
  这三个子索引会被脚本改回绝对路径**，重跑后请再执行一次 `build_index.py` 修正。
- `intake/` 原来没有子索引，本次补齐，`miniprogram/`、`paper/`、`link/` 同样有独立子索引。
- `intake/01-receipt.png`、`02-panel-after-refresh.png`、`04-upstream-down.png` 是脱敏展示副本，
  **不要手工涂改**；需要重做时运行 `tools/redact_intake.py --evidence-dir <仓库外证据目录>`，
  它只接受仓库外输入的原始截图，拒绝仓库内路径，并始终由这些原图重新生成。
  原始证据不进入本仓库；对外分享前务必确认拿的是 `intake/` 下的脱敏副本。
- 停车、讲解员、工单计数等全部为示范数据；小程序 6 张为静态绘制示意图，非真机截图；
  小程序示意图里的工单编号 / 公开查询码 / 私密凭证是 `miniprogram/render.py` 内写死的演示值。

# 长堤整街景统一粗体素（V=0.48）预览交付报告

## 1. 预览入口与隔离范围

- 新独立预览目录与端口（默认 `coarse`，`V=0.48`，与 8942 粗档四铺同源；右上角支持同镜头切换 `原版 / 中粗 / 粗`）：
  `http://127.0.0.1:8943/prototype-paper-3d-full-coarse/`
- 既有基准全部保留未改动且服务保持运行：
  - `8942`（旧四铺粗档基准）：`http://127.0.0.1:8942/prototype-paper-3d-sample-coarse/`
  - `8941` / `8940` 均保留现状。
- 实际改动文件（仅限新目录 `prototype-paper-3d-full-coarse/`）：
  - `prototype-paper-3d-full-coarse/atlas.js`
  - `prototype-paper-3d-full-coarse/scene3d.js`
  - `prototype-paper-3d-full-coarse/index.html`
  - `prototype-paper-3d-full-coarse/styles.css`（R2 名签与控件防遮挡窄修）
  - `prototype-paper-3d-full-coarse/tests/verify-full-coarse.cjs`
  - `prototype-paper-3d-full-coarse/tests/verify-r2-hit-targets.cjs`（R2 名签命中与控件独立点击复现脚本）
  - `prototype-paper-3d-full-coarse/REPORT.md`

## 2. 整街景统一粗体素改造范围（无全屏滤镜、不改相机推近幅度）

在完整保留 8942 粗档四铺基准（`CD-S01` 四间商铺、后排附楼、连廊及特征测量基准）与原有地图比例、通行关系、俯视/45° 连续相机、贴地路线、点位标签、触区、返回保位及减弱动态的基础上，将整图其余全部街段统一落实为 `V=0.48` 实体三维体素几何与明暗块：

1. **普通沿街骑楼与四铺两端接缝**：
   - 海关北侧 3 栋、海关至博物馆段 3 栋沿江骑楼全面改用实体粗体素骑楼建造器（凹进暗腔、阶梯拱券、出挑檐口、凹进窗洞与台阶山花/瓦坡）。
   - **四铺南端接缝（`z=44.6` 起）**：消除旧版 8942 在 ④ 珊瑚粉波浪铺南侧的 2 单位断档与扁平贴图割裂，改由 3 栋同尺度粗体素延续骑楼（米黄/薄荷/珊瑚粉）无缝衔接并顺沿街线平滑过渡至沿江停车场与江门铁桥。
   - **四铺北端接缝**：同步粗化口袋广场 3 棵行道树、后街砖房及北侧博物馆临江立面，消除冷暖与粒度跳变。
2. **全部 10 处地标三维粗体素重构**：
   - `CD-R01` 蓬江大桥：4 孔实体阶梯石拱桥、3 座踏步石墩、水线白沫、石护栏与桥灯。
   - `CD-V01` 启明里：三开间镂空青砖石基牌坊（实体立柱、赭金匾框、双层阶梯瓦顶）+ 周边 3 栋岭南砖房与绿树。
   - `CD-A02` 江门海关旧址：6 开间拱券连廊主体、东侧临江骑楼翼楼、四面实体表盘与指针钟楼、阶梯攒尖顶，及榕树广场石砌树池与多层级粗体素大榕树（含垂挂气根）。
   - `CD-A01` 江门市博物馆长堤分馆：南向双联巴洛克阶梯山花立面、满洲窗明暗块、临江东立面骑楼柱廊、双坡体素瓦顶与露台 2 座粗体素咖啡伞桌。
   - `CD-A03` 水埠头石阶：9 级粗体素石阶、水线白沫、两侧护墙与木系缆桩、实体乌篷木船。
   - `CD-S01` 堤东路骑楼：完整保留 8942 四铺粗档基准，同步粗化周边 5 棵口袋树与西侧集市摊位。
   - `CD-S02` 新市路：4 栋粗体素岭南商住砖房 + 实体拱洞过街天桥（可通透观望巷道）。
   - `CD-S03` 墟顶老街：4 栋粗体素岭南砖房 + 2 座条纹雨棚集市摊位 + 街树。
   - `CD-P01` 沿江停车场（示范）：粗体素地坪与凸起白线车位 + 3 辆实体糖果色小车（车轮/车身/暗色车窗/车灯）。
   - `CD-R02` 江门铁桥：实体石墩 + 钢箱边梁 + 首尾严密咬合的 8 跨阶梯体素沃伦钢桁架与顶部横撑（无旧版镂空斜线闪烁）。
3. **普通岭南砖房、江岸石堤、树木、街面与行人**：
   - 全图 24 栋配景岭南砖房全部改用 `addCoarseLingnanHouse`（石基、砖墙、暗色门窗、檐下阴影带、出挑白檐与阶梯瓦坡/防火墙山墙）。
   - 江岸石堤改用实体块化护岸、石肋、水线深边与白沫带、连续实体石护栏与横梁，并配齐广场/露台石路缘。
   - 全图树木与 14 名街面行人全部改用实体体素方块造型，消除十字插片透明边闪烁。
   - 着色器 `sampleSharpUv` 改为基于连续 `vUv` 求导并关闭跨槽位 mipmap 渗色，消除路面平铺拼缝虚线。

## 3. 同镜头前后对照图（左：8942 基准 / 右：8943 整街景粗档）

- 393px 全景俯视对照：`prototype-paper-3d-full-coarse/screenshots/compare/compare-panorama-393-flat.png`
- 桌面 1280×860 全景俯视对照：`prototype-paper-3d-full-coarse/screenshots/compare/compare-panorama-desktop-flat.png`
- 393px 四铺两端与南接缝对照（`CD-S01` 45°）：`prototype-paper-3d-full-coarse/screenshots/compare/compare-seam-didong-393.png`
- 393px 四处分散地标与街岸交界对照（`CD-A01` 博物馆北接缝、`CD-A03` 水埠头街岸、`CD-A02` 海关旧址、`CD-R02` 江门铁桥南接缝）：
  `prototype-paper-3d-full-coarse/screenshots/compare/compare-landmarks-4dispersed-393.png`

## 4. 手机连续录屏（首帧即渲染完毕，无片头空白）

均实点覆盖：全景俯视 → `CD-S01` 四铺接缝 45° + 150% 推近 + 返回俯视 → `CD-A02` 海关 → `CD-A01` 博物馆 → `CD-A03` 水埠头 → `CD-R02` 铁桥 → 启用 R2 路线 + 聚焦 100%/150% + 关闭浮层回位：

- 393×852 录屏：`prototype-paper-3d-full-coarse/screenshots/qa-full/mobile-393-full-coarse-walkthrough.mp4`（786×1704，25fps，42.44s）
- 375×812 录屏：`prototype-paper-3d-full-coarse/screenshots/qa-full/mobile-375-full-coarse-walkthrough.mp4`（750×1624，25fps，42.16s）

## 5. 实际验证覆盖与余项说明

完整实测数据见 `prototype-paper-3d-full-coarse/screenshots/qa-full/metrics-full-coarse.json`（脚本：`prototype-paper-3d-full-coarse/tests/verify-full-coarse.cjs`）。

- **已实测通过项**：
  - 视口覆盖：移动端 `393×852`、`375×812`、桌面 `1280×860` 及 `prefers-reduced-motion: reduce` 减弱动态模式；全部场景控制台错误、页面异常、网络失败数均为 `0`，无横向溢出。
  - 地标与接缝：全景 + 5 处分散地标（`CD-S01`、`CD-A02`、`CD-A01`、`CD-A03`、`CD-R02`）实点验证，有无路线（R2）、100%/150% 推近及返回俯视保位均正常（`viewMode="flat"`）。
  - 触区与标签冲突：全视口点位最小触区 `55×44 px`；全景、聚焦 100%/150% 及带路线模式下 `maxPairLabelOverlap = 0`（无标签重叠冲突）。
  - 移动端裁切复核：`393`（`shop1Top=-1.5px`）、`375`（`shop1Top=-0.6px`）、`393 reduced-motion` 及全视口 R2 路线下四铺均 100% 落于可视区内；地面平铺拼缝虚线已彻底消除。
- **明确余项与已知边界（如实记录）**：
  1. **100% 首铺外接框 vs 网格顶点**：100% 无路线桌面 `1280×860`（居中 390px 手机画框）下 `CD-S01` 首铺外接框顶边为 `-3.9px`（375 为 `-0.6px`、393 为 `-1.5px`），但实测网格最高顶点仍落在画布内（桌面 `+10.35px`、375 `+11.76px`、393 `+12.84px`），屋脊本身未被裁切；R2 下 100% 外接框均在画布内（`+2.5px`～`+7.4px`）。
  2. **150% 构图裁切（已知边界）**：150% 推近下桌面、375、393 有无 R2 均可见四铺两端裁切（转角铺上端与近端粉铺拱脚越出可见地图）；按独立验收测量，R2 150% 下首、末铺外接框留在可见地图内的面积比例约 `73–77%` 与 `78–83%`。该构图沿用 8942 锁定相机倍率，本次未改动推近幅度。
  3. **江面与街面点线（已知渲染后端边界）**：在 Chromium SwiftShader 软件渲染下，俯视江面 `UV` 周期交界及铁桥 44°、水埠头 45° 斜视可见深色点线横穿江面，街面亦残留类似点线；而在 Orca Chromium（Apple ANGLE Metal）桌面原画布复拍铁桥 44° 未见同样点线。场景几何岸桥连接连续，该现象属软件渲染后端相关的已知边界，本次窄修未扩展改写着色器或纹理采样。
  4. `CD-R01` 蓬江大桥、`CD-V01` 启明里、`CD-S02` 新市路、`CD-S03` 墟顶老街、`CD-P01` 沿江停车场已在全景、邻近镜头及本轮 R2 实点验收中核验，但旧版对比拼图未逐一为这 5 处单独生成 45° 特写前后对照图。

## 6. 2026-11-23 R2 名签防遮挡窄修与专项实测

针对独立验收报告（`8943整街景独立验收.md`）检出的两处 R2 全景控件拦截问题，仅在 `prototype-paper-3d-full-coarse/styles.css` 做最小定位调整（不改体素几何、不改相机镜头与回位逻辑、不改点位卡内 `.sheet .map-controls` 静态排布）：

- **档位控件 `.voxel-tiers`**：在俯视全景下改置左上角（`top: 18px; left: calc(12px + var(--safe-left)); right: auto;`），避开右上角 `CD-R01` 蓬江大桥名签且与下方 `CD-V01` 启明里保持 `≥28.6px` 净空；若 `.map-view-back` 在地图层显示，通过 `.map-view-back:not([hidden]) ~ .voxel-tiers` 自动让至右上角防冲突。
- **缩放控件 `.zoom`**：由 `bottom: 22px` 上移至江面空旷区 `bottom: 112px`，在 375/393/桌面无路线与 R2 下均完全脱离 `CD-R02` 江门铁桥名签右缘及上方 `CD-A03` 水埠头石阶。

### 复现命令与实测结果

```sh
NODE_PATH=/Volumes/1t扩展盘/Codex项目/SD-Chinese-style-furniture/node_modules \
  node prototype-paper-3d-full-coarse/tests/verify-r2-hit-targets.cjs
```

原始数据：`prototype-paper-3d-full-coarse/screenshots/r2-hit-fix/metrics-r2-hit-fix.json`；验证截图目录：`prototype-paper-3d-full-coarse/screenshots/r2-hit-fix/`。

| 视口 / 模式 | 控制台与网络错误 | 无路线 / R2 重叠项 | R2 实际点击命中与开卡（`CD-R01` 左/中/右 + `CD-R02` 左/中/右/极右缘） | 档位（原版/中粗/粗）与缩放（+/−）独立点击 | 点位卡内控件及 150%→回位 | 附加路线回归（R1/R3） |
| --- | ---: | ---: | --- | --- | --- | --- |
| 桌面 `1280×860` | 0 | 0 / 0 | 7/7 命中对应点位、打开卡片、维持 `coarse`、回位漂移 `0` 且焦点回原按钮 | 5/5 通过 | 通过（漂移 `0`） | — |
| 手机 `375×812` | 0 | 0 / 0 | 7/7 通过（含原失败点 `CD-R01` 中心 `(313.6,194.18)` 与 `CD-R02` 右缘 `(319.8,705.68)` / 极右缘 `(324.8,705.68)`） | 5/5 通过 | 通过（漂移 `0`） | R1/R3 均 0 重叠 |
| 手机 `393×852` | 0 | 0 / 0 | 7/7 通过（含 `CD-R01` 中心 `(328.6,202.28)` 及两侧、`CD-R02` 两侧与极右缘） | 5/5 通过 | 通过（漂移 `0`） | — |
| 手机 `393×852`（`reduced-motion`） | 0 | 0 / 0 | 2/2 通过（`CD-R01` 中心、`CD-R02` 右侧直接落位 44° 与无动画精确回位） | — | — | — |

## 九、独立控件条改造与全矩阵名签触区复验（task_f26881fcb2a7）

### 1. 问题复盘与根因修复
- 独立复验报告（`/Volumes/1t扩展盘/Codex聊天/2026-11-23/paper-full-coarse-hit-recheck-task_3bcbc17a465c/8943名签触区复验.md`）确认此前双桥名签已过，但在 `375×812` 下选中 `R1/R2/R3` 并推近至 `150%` 俯视时，`CD-A02` 江门海关旧址名签落入左上角，被浮动定位的 `.voxel-tiers` 挡住。
- **独立控件区根因方案**（不再把控件浮在地图角落）：
  - `prototype-paper-3d-full-coarse/index.html`：将 `#map-controls`（含 `返回俯视`、三档 `原版/中粗/粗` 与缩放 `+/−`）从 `.map-area` 移入 `.paper-bottom` 顶部的独立固定高度控件条 `#map-toolbar`（地图视口外部、撕纸底栏上方，`height: 52px`）。
  - `prototype-paper-3d-full-coarse/styles.css`：将 `.map-controls` 改为静态 Flex 横条（左侧档位、右侧缩放），地图画布上方零浮动控件；点位卡展开时仍由既有 `app.js` 逻辑停靠入 `.sheet` 顶部（与 `返回俯视` 同行排布），关闭卡片时回挂 `#map-toolbar` 且地图视口高度零跳变。
  - 顺带定位并根治一处 `prefers-reduced-motion: reduce` 交互缺陷：`paper.css` 的 `* { transition-duration: .01ms !important; }` 意外给 `.map-pin` 启用了 `transform` 过渡，在 `styles.css` 的减弱动态禁用清单中补入 `.map-pin` 后，减弱动态下退出点位卡时名签立即精准归位。

### 2. 全矩阵实点验收（正常入口）
- 复现脚本：`prototype-paper-3d-full-coarse/tests/verify-r2-hit-targets.cjs`
- 结构化结果：`prototype-paper-3d-full-coarse/screenshots/r2-hit-fix/metrics-r2-hit-fix.json`
- 运行命令：`NODE_PATH=/Volumes/1t扩展盘/Codex项目/SD-Chinese-style-furniture/node_modules node prototype-paper-3d-full-coarse/tests/verify-r2-hit-targets.cjs`（亦支持 `--vp=desktop-1280|mobile-375|mobile-393|mobile-393-reduced` 分视口运行）
- 覆盖范围与实测结论（`0` console/page/network 报错，`horizontalOverflow: false`，`toolbarOutsideMap: true`）：
  - **视口 × 路线 × 倍率**：`desktop-1280`（`1280×860 @2x`）、`mobile-375`（`375×812 @3x` 触屏）、`mobile-393`（`393×852 @3x` 触屏）、`mobile-393-reduced`（减弱动态），全部覆盖 `flat`（无路线）、`R1`、`R2`、`R3` 与 `100%` / `150%`，共 **32 轮全量 10 名签逐像素扫描**，控件遮挡与名签互压均为 **0**。
  - **正常入口真实点击**：累计 **360 次** 实点（三动画视口各 61 次 + 减弱动态全量 10 名签三侧 177 次）：
    - `150%` 俯视下 `375/393/桌面` 无路线及 `R1/R2/R3` 全部路线中，`CD-A02` 江门海关旧址（左/中/右）、`CD-A03` 水埠头石阶（左/中/右及中心）及全部视口内可见名签均精确命中并点开对应点位卡。
    - `100%` 俯视下 `CD-R01` 蓬江大桥（左/中/右）、`CD-R02` 江门铁桥（左/中/右及极右缘）、`CD-A02` 海关旧址、`CD-A03` 水埠头石阶全部精确命中并点开对应卡片。
    - 全景独立控件条与点位卡内控件的 `原版(0.14)/中粗(0.34)/粗(0.48)` 切换、`100%→150%→200%→150%→100%` 缩放及 `返回俯视` / `×` 关闭均独立可用；退出后精准回位（相机漂移 `0`，焦点回原名签按钮，倍率回原倍率），`CD-S01` 四铺在三视口 `R2 100%` 下 `allShopsInVisible: true`，粗体素默认 `coarse (0.48)` 保持不变。
- 新增截图证据（`prototype-paper-3d-full-coarse/screenshots/r2-hit-fix/`）：
  - `mobile-375-{flat,R2}-100.png`、`mobile-375-{flat,R1,R2,R3}-150.png`、`mobile-375-R2-sheet-CD-S01.png`
  - `mobile-393-{flat,R2}-100.png`、`mobile-393-{flat,R1,R2,R3}-150.png`、`mobile-393-R2-sheet-CD-S01.png`
  - `desktop-1280-{flat,R2}-100.png`、`desktop-1280-{flat,R1,R2,R3}-150.png`、`desktop-1280-R2-sheet-CD-S01.png`

### 3. 已知边界（保持透明）
- `150%` 放大在三视口有无路线下会按放大倍率自然将部分外围名签推出视口边缘（如双桥、墟顶/新市路局部及 `375 flat 150%` 沿江停车场底缘 3.4px 被视口下缘裁切，视口内可见部分 100% 可点），属 150% 视口范围本身表现，非控件遮挡。
- SwiftShader 软件渲染后端下的水面 UV 周期点线及 150% 四铺两端构图裁切仍沿用既有已知边界说明。

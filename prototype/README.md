# 长堤风貌街 · 像素导览演示

直接用浏览器打开 `prototype/index.html`，或在仓库根目录执行以下命令，通过 HTTP 预览。

```sh
cd prototype
python -m http.server 8000
```

> Windows 上命令是 `python`；macOS / Linux 上用 `python3`（Windows 的 `python3` 是 Microsoft Store 存根，退出码 49，不能用）。

在本机打开 `http://localhost:8000/`。同一局域网内的手机可打开电脑局域网 IP 对应的 8000 端口。页面使用原生 HTML、CSS 和 JavaScript，打开前无需安装依赖。

点位位置、停车和预约均用于演示。扫码和 NFC 通过选择列表中的点位模拟。反馈图片只在当前页面预览。预约、文字反馈和点亮状态用当前浏览器的 `cd-demo-v1` 保存，可以在「我的」中重置。浏览器若限制 `file://` 的本地存储，页面仍可使用，记录保留至关闭或刷新页面。讲解需要浏览器提供对应语种的语音，语音不可用时可以阅读逐句文字。

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `index.html` | 固定顶栏、地图、底部菜单及共用弹层 |
| `styles.css` | 竖屏框架、安全区、淡彩像素样式和动画 |
| `app.js` | 页面状态、地图坐标、弹层、语音、路线和本地记录 |
| `data/points.js` | 点位、故事、候选路线、讲解员和停车示范数据 |
| `assets/` | 像素地图和卡片。按 JPG 路径加载，缺失时尝试同名 PNG。卡片缺失时取地图局部 |
| `check.mjs` | 自检点位坐标、路线及故事点位引用和本地资源 |

在仓库根目录运行 `node prototype/check.mjs`。图片缺失会给出警告，坐标、引用或其他入口文件有误会以非零状态退出。

路线按出行方式和兴趣匹配排序，再用时长接近度决定同分顺序。从停车服务选起点时会预选自驾，已标注的停车点加入站点序列。缺少地图点位的停车场仍显示为起点。时长、距离和说明沿用示范数据。

## 浏览器验收

启动上面的 HTTP 服务后，在仓库根目录运行以下命令。测试使用 Node.js 的 `playwright-core`，可通过 `NODE_PATH` 指定已安装该包的 `node_modules` 目录。默认使用本机 Playwright 缓存中的 macOS ARM64 Chromium headless shell 1254，也可用 `CHROMIUM_PATH` 指定可执行文件。

```sh
node prototype/tests/mobile.cjs http://127.0.0.1:8000/
```

脚本在独立浏览器上下文中分别通过 HTTP 和本地文件走完整流程，检查点亮、到站、预约和反馈持久化，以及重置后的状态。HTTP 流程会更新 `prototype/screenshots/` 下的六张 390×844 截图。断言失败或页面出现脚本、控制台错误时，脚本以非零状态退出。

## 移植到微信小程序

| H5 部分 | 小程序对应做法 |
| --- | --- |
| 单页与共用底部弹层 | 用一个 `Page` 管理业务状态，WXML + WXSS 实现底部弹层和安全区 |
| 可滚动缩放的地图、热点和彩色区域 | 用 `scroll-view` 包裹 `image` 或 Canvas。沿用百分比热点坐标。在 Canvas 中先绘灰度底图，再对已点亮的区域裁切绘制彩色原图 |
| SVG 路线、故事线与停车图表 | 用 Canvas 画折线、虚线及节点序号，与地图共用热点坐标 |
| Web Speech 讲解和句子高亮 | 准备三种语音的讲解音频，使用 `wx.createInnerAudioContext` 播放和暂停。用播放时间与句子起止时间对应高亮 |
| `localStorage` 中的演示记录 | 用 `wx.getStorageSync`、`wx.setStorageSync` 和 `wx.removeStorageSync` 保留、读取和重置同一份数据 |
| 模拟选点扫码 | 用 `wx.scanCode` 获取点位码，校验点位 ID 后复用定位、闪烁和打卡逻辑 |
| 预约、停车和反馈 | 将演示数据源换成授权接口。接入实际预约确认、车场数据和反馈状态，按权限处理联系方式与用户图片 |

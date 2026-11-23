// 走查脚本共用的浏览器定位。
//
// 优先级：
//   ① 环境变量 CHROMIUM_PATH —— 现场临时指定浏览器（例如换 Chrome / 换 playwright 缓存里的 headless shell）。
//   ② 自动探测本机 Microsoft Edge（Windows 现场机默认装的就是它）。
//   ③ 自动探测 macOS 上 playwright 缓存里的 chrome-headless-shell（保留原作者机器上的老行为）。
//
// 找不到可用浏览器时：打印中文报错并以退出码 2 退出，不让现场看到 playwright 的英文异常堆栈。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 自动探测顺序：先 Windows 上最常见的 Edge（x86 目录），再 64 位目录，最后是 macOS 的 playwright 缓存。
const AUTO_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  path.join(os.homedir(),
    'Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell')
];

function resolveChromiumPath() {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      console.error('环境变量 CHROMIUM_PATH 指向的文件不存在：' + fromEnv);
      console.error('请改成本机 Chromium 内核浏览器（Microsoft Edge / Chrome / playwright 缓存里的 chrome-headless-shell）的真实路径。');
      process.exit(2);
    }
    return fromEnv;
  }

  for (const candidate of AUTO_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }

  console.error('找不到可用的 Chromium 内核浏览器，走查脚本无法启动。');
  console.error('解决办法（二选一）：');
  console.error('  1) 安装 Microsoft Edge（默认会自动探测）；');
  console.error('  2) 设置环境变量 CHROMIUM_PATH 指向浏览器可执行文件，例如：');
  console.error('       set CHROMIUM_PATH=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  console.error('已自动探测但未找到的路径：');
  for (const candidate of AUTO_CANDIDATES) console.error('  - ' + candidate);
  process.exit(2);
}

module.exports = { resolveChromiumPath };

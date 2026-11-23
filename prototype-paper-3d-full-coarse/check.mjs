import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const errors = [];
const warnings = [];
const sandbox = { window: {} };

vm.runInNewContext(readFileSync(new URL("data/points.js", import.meta.url), "utf8"), sandbox, {
  filename: "data/points.js",
  timeout: 1000
});

const { points, routes, stories, parking } = sandbox.window.CD_DATA;
const pointIds = new Set();
const parkingIds = new Set(parking.map(lot => lot.id));

function checkFile(ref, image = false) {
  const url = new URL(ref, import.meta.url);
  if (url.protocol !== "file:") return;
  if (existsSync(fileURLToPath(url))) return;
  if (image || /\.(?:png|jpe?g|webp|gif|avif|svg|ico)$/i.test(url.pathname)) {
    warnings.push(`图片缺失：${ref}`);
  } else {
    errors.push(`文件缺失：${ref}`);
  }
}

for (const point of points) {
  if (!point.id || pointIds.has(point.id)) errors.push(`无效或重复的点位 ID：${point.id}`);
  pointIds.add(point.id);
  if (point.parking && !parkingIds.has(point.parking)) errors.push(`点位 ${point.id} 引用了未知停车场 ${point.parking}`);
}

const sceneSrc = readFileSync(new URL("scene3d.js", import.meta.url), "utf8");
for (const id of pointIds) {
  if (!sceneSrc.includes(`"${id}"`)) errors.push(`scene3d.js 缺少地标三维体块定义：${id}`);
}

for (const route of routes) {
  for (const ref of route.points) {
    if (!pointIds.has(ref)) errors.push(`路线 ${route.id} 引用了未知点位 ${ref}`);
  }
}
for (const story of stories) {
  for (const node of story.nodes) {
    if (!pointIds.has(node.point)) errors.push(`故事线 ${story.id} 引用了未知点位 ${node.point}`);
  }
}

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
if (html.includes("map-layer-top") || html.includes("map-layer-iso")) {
  errors.push("index.html 存在禁止的两图淡换图层");
}
const htmlRefs = [...html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
  .map(match => match[1] ?? match[2] ?? match[3]).filter(value => value && !value.startsWith("#"));
for (const ref of new Set(htmlRefs)) checkFile(ref);
for (const ref of new Set(["assets/map.jpg", "assets/map-top.png", ...points.map(point => point.card).filter(Boolean)])) checkFile(ref, true);

for (const warning of warnings) console.warn(`警告：${warning}`);
for (const error of errors) console.error(`错误：${error}`);
console.log(`原风格像素三维版静态自检${errors.length ? "未通过" : "通过"} · ${points.length} 个点位 · ${routes.length} 条路线 · ${stories.length} 条故事线 · ${errors.length} 个错误 · ${warnings.length} 个警告`);
process.exitCode = errors.length ? 1 : 0;

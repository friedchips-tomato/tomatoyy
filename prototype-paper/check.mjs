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
    const alternative = new URL(url.href.replace(/\.jpg(?=$|[?#])/i, ".png"));
    const fallback = alternative.href !== url.href && existsSync(fileURLToPath(alternative));
    warnings.push(`图片缺失：${ref}${fallback ? "，找到同名 PNG" : ""}`);
  } else {
    errors.push(`文件缺失：${ref}`);
  }
}

for (const point of points) {
  if (!point.id || pointIds.has(point.id)) errors.push(`无效或重复的点位 ID：${point.id}`);
  pointIds.add(point.id);
  const { x, y, w, h } = point.hotspot || {};
  const inRange = [x, y, w, h].every(value => Number.isFinite(value) && value >= 0 && value <= 100);
  if (!inRange || w === 0 || h === 0 || x + w > 100 || y + h > 100) {
    errors.push(`点位 ${point.id} 的 hotspot 越界或尺寸无效`);
  }
  if (point.parking && !parkingIds.has(point.parking)) errors.push(`点位 ${point.id} 引用了未知停车场 ${point.parking}`);
}

function checkRefs(kind, id, refs) {
  for (const ref of refs) {
    if (!pointIds.has(ref)) errors.push(`${kind} ${id} 引用了未知点位 ${ref}`);
  }
}

for (const route of routes) checkRefs("路线", route.id, route.points);
for (const story of stories) checkRefs("故事线", story.id, story.nodes.map(node => node.point));

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
const htmlRefs = [...html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
  .map(match => match[1] ?? match[2] ?? match[3]).filter(value => value && !value.startsWith("#"));
for (const ref of new Set(htmlRefs)) checkFile(ref);
for (const ref of new Set(["assets/map.jpg", ...points.map(point => point.card).filter(Boolean)])) checkFile(ref, true);

for (const warning of warnings) console.warn(`警告：${warning}`);
for (const error of errors) console.error(`错误：${error}`);
console.log(`静态自检${errors.length ? "未通过" : "通过"} · ${points.length} 个点位 · ${routes.length} 条路线 · ${stories.length} 条故事线 · ${errors.length} 个错误 · ${warnings.length} 个警告`);
process.exitCode = errors.length ? 1 : 0;

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

function checkSources(label, sources) {
  if (!Array.isArray(sources) || sources.length === 0
    || sources.some(source => typeof source !== "string" || source.trim().length === 0)) {
    errors.push(`${label} 的 sources 必须是非空来源字符串数组`);
  }
}

for (const point of points) {
  checkSources(`点位 ${point.id}`, point.sources);
  if (point.guide) checkSources(`点位 ${point.id} 的三语讲解稿`, point.guide.sources);
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

for (const route of routes) {
  checkRefs("路线", route.id, route.points);
  checkSources(`路线 ${route.id}`, route.sources);
}
for (const story of stories) {
  checkRefs("故事线", story.id, story.nodes.map(node => node.point));
  for (const [index, node] of story.nodes.entries()) {
    checkSources(`故事线 ${story.id} 节点 ${index + 1}（${node.point}）`, node.sources);
  }
}

// 停车字段校验（阶段 3）：lot_id 合法、fee 结构完整、时间戳可解析、余位 ∈ [0,total]、forecast 长度与粒度一致。
// 新增字段（fee/access/updated_at/source/walk_minutes）为可选：缺省时回落静态示范数据，不作为错误；存在时校验结构。
const LOT_ID_RE = /^[A-Z][A-Z0-9-]{0,31}$/;
const FEE_MODES = new Set(["hourly", "flat", "unknown"]);
for (const lot of parking) {
  if (!lot.id || !LOT_ID_RE.test(lot.id)) errors.push(`停车场 lot_id 非法：${lot.id}`);
  if (!Number.isInteger(lot.total) || lot.total <= 0) errors.push(`停车场 ${lot.id} 的总车位数 total 非法`);
  if (!Number.isInteger(lot.free) || lot.free < 0 || lot.free > lot.total) {
    errors.push(`停车场 ${lot.id} 的余位 free 不在 [0, total] 区间`);
  }
  if (lot.fee !== undefined && lot.fee !== null) {
    if (typeof lot.fee !== "object" || !FEE_MODES.has(lot.fee.mode)
      || !("amount" in lot.fee) || !(lot.fee.amount === null || typeof lot.fee.amount === "number")
      || !(lot.fee.unit === null || lot.fee.unit === undefined || typeof lot.fee.unit === "string")) {
      errors.push(`停车场 ${lot.id} 的 fee 结构不完整（需 {mode, amount, unit, note}）`);
    }
  }
  if (lot.access !== undefined && lot.access !== null && (typeof lot.access !== "object" || Array.isArray(lot.access))) {
    errors.push(`停车场 ${lot.id} 的 access 结构非法`);
  }
  if (lot.updated_at !== undefined && lot.updated_at !== null && Number.isNaN(Date.parse(lot.updated_at))) {
    errors.push(`停车场 ${lot.id} 的 updated_at 时间戳不可解析`);
  }
  for (const field of ["past", "forecast"]) {
    const series = lot[field];
    if (series === undefined || series === null) continue;
    if (!Array.isArray(series) || series.some(value => !Number.isFinite(value) || value < 0 || value > lot.total)) {
      errors.push(`停车场 ${lot.id} 的 ${field} 序列含越界或非数值项`);
    }
  }
  if (Array.isArray(lot.forecast) && lot.forecast.length !== 4) {
    errors.push(`停车场 ${lot.id} 的 forecast 长度与粒度不一致（应为 15 分钟粒度 × 1 小时 = 4 个点，实际 ${lot.forecast.length}）`);
  }
}

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
const htmlRefs = [...html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
  .map(match => match[1] ?? match[2] ?? match[3]).filter(value => value && !value.startsWith("#"));
for (const ref of new Set(htmlRefs)) checkFile(ref);
for (const ref of new Set(["assets/map.jpg", ...points.map(point => point.card).filter(Boolean)])) checkFile(ref, true);

for (const warning of warnings) console.warn(`警告：${warning}`);
for (const error of errors) console.error(`错误：${error}`);
console.log(`静态自检${errors.length ? "未通过" : "通过"} · ${points.length} 个点位 · ${routes.length} 条路线 · ${stories.length} 条故事线 · ${errors.length} 个错误 · ${warnings.length} 个警告`);
process.exitCode = errors.length ? 1 : 0;

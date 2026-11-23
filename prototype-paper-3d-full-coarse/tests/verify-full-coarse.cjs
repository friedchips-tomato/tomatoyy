// NODE_PATH=/Volumes/1t扩展盘/Codex项目/SD-Chinese-style-furniture/node_modules node prototype-paper-3d-full-coarse/tests/verify-full-coarse.cjs
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const fullUrl = process.argv[2] || "http://127.0.0.1:8943/prototype-paper-3d-full-coarse/";
const base8942Url = "http://127.0.0.1:8942/prototype-paper-3d-sample-coarse/";
const qaDir = path.join(__dirname, "../screenshots/qa-full");
const cmpDir = path.join(__dirname, "../screenshots/compare");

fs.mkdirSync(qaDir, { recursive: true });
fs.mkdirSync(cmpDir, { recursive: true });

function attachErrors(page) {
  const errors = [];
  page.on("console", msg => { if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`); });
  page.on("pageerror", err => errors.push(`pageerror: ${err.message}`));
  page.on("requestfailed", req => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText || ""}`));
  page.on("response", res => { if (res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`); });
  return errors;
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    if (!window.__CD3D__ || !window.__CD3D__.isWebGL) return false;
    const st = window.__CD3D__.getState();
    return st.frameCount >= 4 && st.atlasReady;
  }, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(220);
}

async function waitIdle(page, timeout = 7000) {
  await page.waitForFunction(() => window.__CD3D__ && !window.__CD3D__.getState().animating, { timeout });
  await page.waitForTimeout(200);
}

function convertToMp4(webmPath, mp4Path, trimStartSec = 0) {
  const args = ["-y", "-i", webmPath];
  if (trimStartSec > 0) args.push("-ss", trimStartSec.toFixed(2));
  args.push(
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "19",
    mp4Path
  );
  execFileSync("ffmpeg", args, { stdio: "ignore" });
}

async function tapOrClick(locator, isTouch) {
  if (isTouch) await locator.tap();
  else await locator.click();
}

async function activateClassicRoute(page, isTouch) {
  await tapOrClick(page.locator('[data-action="menu"][data-id="route"]'), isTouch);
  await page.waitForSelector('[data-action="generate"]', { state: "visible" });
  await tapOrClick(page.locator('[data-action="generate"]'), isTouch);
  await page.waitForSelector('[data-action="adopt"][data-id="R2"]', { state: "visible" });
  await tapOrClick(page.locator('[data-action="adopt"][data-id="R2"]'), isTouch);
  await page.waitForFunction(() => !document.getElementById("navigation").hidden && document.getElementById("overlay").hidden, { timeout: 8000 });
  await waitIdle(page);
  await page.waitForTimeout(300);
}

async function clickLandmark(page, id, isTouch) {
  const loc = page.locator(`.map-spot[data-id="${id}"]`);
  await loc.waitFor({ state: "visible", timeout: 8000 });
  await tapOrClick(loc, isTouch);
  await waitIdle(page);
  await page.waitForTimeout(240);
}

async function closeSheetAndReturn(page, isTouch) {
  const closeBtn = page.locator('#sheet [data-action="close-overlay"], #sheet [data-action="close"], .sheet-close');
  if (await closeBtn.first().isVisible().catch(() => false)) {
    await tapOrClick(closeBtn.first(), isTouch);
    await waitIdle(page);
  }
  const backBtn = page.locator("#map-view-back");
  if (await backBtn.isVisible().catch(() => false)) {
    await tapOrClick(backBtn, isTouch);
    await waitIdle(page);
  }
  await page.waitForTimeout(200);
}

async function readSceneMetrics(page, focusId = null) {
  return page.evaluate(targetId => {
    const st = window.__CD3D__.getState();
    const mapR = document.getElementById("map-viewport").getBoundingClientRect();
    const sheetEl = document.getElementById("sheet");
    const overlayHidden = document.getElementById("overlay").hidden;
    const sheetTop = overlayHidden ? mapR.bottom : sheetEl.getBoundingClientRect().top;
    const visibleTop = mapR.top;
    const visibleBottom = Math.min(mapR.bottom, sheetTop);
    const visibleH = Math.max(0, visibleBottom - visibleTop);

    const pins = Array.from(document.querySelectorAll(".map-pin"));
    const visibleLabels = [];
    let minTouchW = Infinity;
    let minTouchH = Infinity;
    for (const pin of pins) {
      const spot = pin.querySelector(".map-spot");
      const lbl = pin.querySelector(".map-label");
      if (!spot || !lbl) continue;
      const op = Number(getComputedStyle(pin).opacity);
      const sr = spot.getBoundingClientRect();
      if (sr.width > 0 && sr.height > 0 && op > 0.5) {
        minTouchW = Math.min(minTouchW, sr.width);
        minTouchH = Math.min(minTouchH, sr.height);
      }
      if (op > 0.5 && getComputedStyle(lbl).visibility !== "hidden") {
        const lr = lbl.getBoundingClientRect();
        if (lr.width > 1 && lr.height > 1) {
          visibleLabels.push({
            id: spot.dataset.id,
            left: lr.left, top: lr.top, right: lr.right, bottom: lr.bottom,
            inVisible: lr.left >= mapR.left - 1 && lr.right <= mapR.right + 1 && lr.top >= visibleTop - 1 && lr.bottom <= visibleBottom + 1
          });
        }
      }
    }
    const overlapArea = (a, b) => {
      const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return Number((ox * oy).toFixed(1));
    };
    let maxPairLabelOverlap = 0;
    let overlapPairs = [];
    for (let i = 0; i < visibleLabels.length; i += 1) {
      for (let j = i + 1; j < visibleLabels.length; j += 1) {
        const area = overlapArea(visibleLabels[i], visibleLabels[j]);
        if (area > maxPairLabelOverlap) maxPairLabelOverlap = area;
        if (area > 4) overlapPairs.push([visibleLabels[i].id, visibleLabels[j].id, area]);
      }
    }

    let focusLabel = null;
    if (targetId) {
      const found = visibleLabels.find(l => l.id === targetId);
      focusLabel = found || null;
    }
    const shops = (st.sampleShops || []).map(shop => ({
      ...shop,
      inVisible: shop.left >= -2 && shop.right <= mapR.width + 2 && shop.top >= -2 && shop.bottom <= visibleH + 2
    }));
    const allShopsInVisible = shops.length === 4 && shops.every(s => s.inVisible);
    const horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return {
      viewMode: st.view,
      voxelTier: st.voxelTier,
      voxelUnit: st.voxelUnit,
      focusedPointId: st.focusedPointId,
      zoomLevel: document.getElementById("zoom-level")?.textContent || "",
      camera: { pitchDeg: st.pitchDeg, yawDeg: st.yawDeg, distance: st.distance, target: st.target, ndcOffsetY: st.ndcOffsetY },
      visibleMap: { width: Math.round(mapR.width), height: Math.round(visibleH) },
      visibleLabelCount: visibleLabels.length,
      allLabelsInVisible: visibleLabels.every(l => l.inVisible),
      maxPairLabelOverlap,
      overlapPairs,
      focusLabel,
      allShopsInVisible,
      sampleShops: shops,
      minTouchW: Number.isFinite(minTouchW) ? Number(minTouchW.toFixed(1)) : 0,
      minTouchH: Number.isFinite(minTouchH) ? Number(minTouchH.toFixed(1)) : 0,
      horizontalOverflow,
      measures: typeof window.__CD3D__.measureSampleFeatures === "function" ? window.__CD3D__.measureSampleFeatures() : []
    };
  }, focusId);
}

async function composeCompareBoard(browser, { title, panels, outPath }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
  try {
    const items = panels.map(p => ({
      label: p.label,
      sub: p.sub || "",
      displayW: p.displayW || 393,
      dataUrl: `data:image/png;base64,${fs.readFileSync(p.file).toString("base64")}`
    }));
    await page.setContent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        body { margin: 0; padding: 24px; background: #f3ede0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #2b231d; }
        .wrap { display: inline-block; }
        h1 { margin: 0 0 14px; font-size: 20px; font-weight: 700; }
        .grid { display: flex; gap: 18px; align-items: flex-start; }
        .card { background: #fffdf8; border: 1px solid #d5cab7; border-radius: 12px; padding: 12px; box-shadow: 0 4px 14px rgba(55,40,25,.08); }
        .head { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
        .sub { font-size: 12px; color: #6c6053; margin-bottom: 10px; }
        img { display: block; border-radius: 8px; border: 1px solid #dfd6c7; }
      </style></head><body>
        <div class="wrap" id="board">
          <h1>${title}</h1>
          <div class="grid">
            ${items.map(it => `<div class="card"><div class="head">${it.label}</div><div class="sub">${it.sub}</div><img src="${it.dataUrl}" style="width:${it.displayW}px;height:auto;" /></div>`).join("")}
          </div>
        </div>
      </body></html>`);
    await page.waitForTimeout(160);
    await page.locator("#board").screenshot({ path: outPath });
  } finally {
    await page.close();
  }
}

async function composeGridBoard(browser, { title, rows, outPath }) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 2200 }, deviceScaleFactor: 2 });
  try {
    const encodedRows = rows.map(row => ({
      heading: row.heading,
      panels: row.panels.map(p => ({
        label: p.label,
        displayW: p.displayW || 360,
        dataUrl: `data:image/png;base64,${fs.readFileSync(p.file).toString("base64")}`
      }))
    }));
    await page.setContent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        body { margin: 0; padding: 24px; background: #f3ede0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #2b231d; }
        .wrap { display: inline-block; }
        h1 { margin: 0 0 16px; font-size: 20px; font-weight: 700; }
        h2 { margin: 16px 0 8px; font-size: 15px; font-weight: 700; color: #43372c; }
        .row { display: flex; gap: 16px; align-items: flex-start; }
        .card { background: #fffdf8; border: 1px solid #d5cab7; border-radius: 10px; padding: 10px; }
        .head { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
        img { display: block; border-radius: 6px; border: 1px solid #dfd6c7; }
      </style></head><body>
        <div class="wrap" id="board">
          <h1>${title}</h1>
          ${encodedRows.map(r => `
            <h2>${r.heading}</h2>
            <div class="row">
              ${r.panels.map(p => `<div class="card"><div class="head">${p.label}</div><img src="${p.dataUrl}" style="width:${p.displayW}px;height:auto;" /></div>`).join("")}
            </div>
          `).join("")}
        </div>
      </body></html>`);
    await page.waitForTimeout(180);
    await page.locator("#board").screenshot({ path: outPath });
  } finally {
    await page.close();
  }
}

async function captureScenePack(browser, { label, url, vw, vh, dpr, isTouch, reducedMotion = false, landmarks = ["CD-S01", "CD-A02", "CD-A01", "CD-A03", "CD-R02"], testRoute = true }) {
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: dpr,
    hasTouch: isTouch,
    isMobile: isTouch,
    reducedMotion: reducedMotion ? "reduce" : "no-preference"
  });
  const page = await context.newPage();
  const errors = attachErrors(page);
  const shots = {};
  const metrics = {};

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitReady(page);

    // 1. Panorama flat 100%
    const flatShot = path.join(qaDir, `${label}-flat-100.png`);
    await page.screenshot({ path: flatShot });
    shots.flat100 = flatShot;
    metrics.flat100 = await readSceneMetrics(page, null);

    // 2. Focus dispersed landmarks (no route, 100% + 150% on CD-S01 + return check)
    metrics.landmarks = {};
    shots.landmarks = {};
    for (const id of landmarks) {
      await clickLandmark(page, id, isTouch);
      const s100 = path.join(qaDir, `${label}-${id}-100.png`);
      await page.screenshot({ path: s100 });
      shots.landmarks[id] = { s100 };
      metrics.landmarks[id] = { m100: await readSceneMetrics(page, id) };

      if (id === "CD-S01") {
        // Zoom to 150%
        await tapOrClick(page.locator('[data-action="zoom"][data-id="1"]'), isTouch);
        await waitIdle(page);
        await page.waitForTimeout(180);
        const s150 = path.join(qaDir, `${label}-${id}-150.png`);
        await page.screenshot({ path: s150 });
        shots.landmarks[id].s150 = s150;
        metrics.landmarks[id].m150 = await readSceneMetrics(page, id);
        // Zoom back to 100%
        await tapOrClick(page.locator('[data-action="zoom"][data-id="-1"]'), isTouch);
        await waitIdle(page);
      }

      await closeSheetAndReturn(page, isTouch);
      metrics.landmarks[id].returnState = await page.evaluate(() => {
        const st = window.__CD3D__.getState();
        return { viewMode: st.view, focusedPointId: st.focusedPointId, pitchDeg: st.pitchDeg, yawDeg: st.yawDeg, distance: st.distance };
      });
    }

    // 3. With Route (R2): panorama + focus CD-S01 (100% & 150%) + return
    if (testRoute) {
      await activateClassicRoute(page, isTouch);
      const routeFlatShot = path.join(qaDir, `${label}-route-flat-100.png`);
      await page.screenshot({ path: routeFlatShot });
      shots.routeFlat100 = routeFlatShot;
      metrics.routeFlat100 = await readSceneMetrics(page, null);

      await clickLandmark(page, "CD-S01", isTouch);
      const routeS100 = path.join(qaDir, `${label}-route-CD-S01-100.png`);
      await page.screenshot({ path: routeS100 });
      shots.routeDidong100 = routeS100;
      metrics.routeDidong100 = await readSceneMetrics(page, "CD-S01");

      await tapOrClick(page.locator('[data-action="zoom"][data-id="1"]'), isTouch);
      await waitIdle(page);
      const routeS150 = path.join(qaDir, `${label}-route-CD-S01-150.png`);
      await page.screenshot({ path: routeS150 });
      shots.routeDidong150 = routeS150;
      metrics.routeDidong150 = await readSceneMetrics(page, "CD-S01");

      await tapOrClick(page.locator('[data-action="zoom"][data-id="-1"]'), isTouch);
      await waitIdle(page);
      await closeSheetAndReturn(page, isTouch);
      metrics.routeReturnState = await page.evaluate(() => {
        const st = window.__CD3D__.getState();
        return { viewMode: st.view, focusedPointId: st.focusedPointId, pitchDeg: st.pitchDeg, yawDeg: st.yawDeg, distance: st.distance };
      });
    }

    return { errors, shots, metrics };
  } finally {
    await context.close();
  }
}

async function recordMobileWalkthrough(browser, { vw, vh, outMp4 }) {
  const tmpDir = path.join(qaDir, `video-tmp-${vw}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    recordVideo: { dir: tmpDir, size: { width: vw * 2, height: vh * 2 } }
  });
  const page = await context.newPage();
  const startMs = Date.now();
  let readySec = 0;
  try {
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitReady(page);
    readySec = Math.max(0, (Date.now() - startMs) / 1000 - 0.1);
    await page.waitForTimeout(900);

    // Focus 4-shop Didong seam + 150% zoom + return
    await clickLandmark(page, "CD-S01", true);
    await page.waitForTimeout(900);
    await page.locator('[data-action="zoom"][data-id="1"]').tap();
    await waitIdle(page);
    await page.waitForTimeout(850);
    await page.locator('[data-action="zoom"][data-id="-1"]').tap();
    await waitIdle(page);
    await closeSheetAndReturn(page, true);
    await page.waitForTimeout(600);

    // Focus Customs (CD-A02), Museum (CD-A01), Shuibutou (CD-A03), Iron Bridge (CD-R02)
    for (const id of ["CD-A02", "CD-A01", "CD-A03", "CD-R02"]) {
      await clickLandmark(page, id, true);
      await page.waitForTimeout(950);
      await closeSheetAndReturn(page, true);
      await page.waitForTimeout(450);
    }

    // Activate R2 route + focus CD-S01 + 150% + return
    await activateClassicRoute(page, true);
    await page.waitForTimeout(800);
    await clickLandmark(page, "CD-S01", true);
    await page.waitForTimeout(850);
    await page.locator('[data-action="zoom"][data-id="1"]').tap();
    await waitIdle(page);
    await page.waitForTimeout(800);
    await page.locator('[data-action="zoom"][data-id="-1"]').tap();
    await waitIdle(page);
    await closeSheetAndReturn(page, true);
    await page.waitForTimeout(700);
  } finally {
    const video = page.video();
    await context.close();
    const webmPath = await video.path();
    convertToMp4(webmPath, outMp4, readySec);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return outMp4;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  });
  try {
    const dispersed5 = ["CD-S01", "CD-A02", "CD-A01", "CD-A03", "CD-R02"];

    // Full-coarse (8943) across 393 mobile, 375 mobile, 1280 desktop, and 393 reduced-motion
    const full393 = await captureScenePack(browser, { label: "full-393", url: fullUrl, vw: 393, vh: 852, dpr: 3, isTouch: true, landmarks: dispersed5, testRoute: true });
    const full375 = await captureScenePack(browser, { label: "full-375", url: fullUrl, vw: 375, vh: 812, dpr: 3, isTouch: true, landmarks: dispersed5, testRoute: true });
    const fullDesk = await captureScenePack(browser, { label: "full-desk", url: fullUrl, vw: 1280, vh: 860, dpr: 2, isTouch: false, landmarks: dispersed5, testRoute: true });
    const fullReduced = await captureScenePack(browser, { label: "full-393-reduced", url: fullUrl, vw: 393, vh: 852, dpr: 3, isTouch: true, reducedMotion: true, landmarks: ["CD-S01", "CD-A02"], testRoute: false });

    // Baseline 8942 (old 4-shop-only coarse) at identical cameras for before/after comparisons
    const base393 = await captureScenePack(browser, { label: "base8942-393", url: base8942Url, vw: 393, vh: 852, dpr: 3, isTouch: true, landmarks: dispersed5, testRoute: false });
    const baseDesk = await captureScenePack(browser, { label: "base8942-desk", url: base8942Url, vw: 1280, vh: 860, dpr: 2, isTouch: false, landmarks: ["CD-S01"], testRoute: false });

    // Assert zero runtime/console/network errors
    for (const [name, pack] of [["full393", full393], ["full375", full375], ["fullDesk", fullDesk], ["fullReduced", fullReduced]]) {
      assert.equal(pack.errors.length, 0, `${name} had errors: ${pack.errors.join("; ")}`);
      assert.equal(pack.metrics.flat100.horizontalOverflow, false, `${name} horizontal overflow`);
      assert.equal(pack.metrics.flat100.voxelTier, "coarse", `${name} default tier must be coarse`);
      if (name !== "fullDesk") {
        assert.equal(pack.metrics.landmarks["CD-S01"].m100.allShopsInVisible, true, `${name} 4 shops must stay in visible map at 100%`);
      }
      assert.equal(pack.metrics.landmarks["CD-S01"].returnState.viewMode, "flat", `${name} return-flat failed`);
    }

    // Compose same-camera Before (8942) vs After (8943) comparison boards
    await composeCompareBoard(browser, {
      title: "393px 全景俯视同镜头前后对照（左：8942 旧四铺割裂 / 右：8943 整街景统一粗档 V=0.48）",
      panels: [
        { label: "改造前 · 8942（仅四铺粗档）", sub: "其余建筑/地标/江岸/树仍为旧平面贴图", file: base393.shots.flat100, displayW: 393 },
        { label: "改造后 · 8943（整街景统一粗档）", sub: "整图普通沿街建筑、10地标、街面、树、江岸与双桥统一体素粗档", file: full393.shots.flat100, displayW: 393 }
      ],
      outPath: path.join(cmpDir, "compare-panorama-393-flat.png")
    });

    await composeCompareBoard(browser, {
      title: "桌面 1280×860 全景俯视同镜头前后对照（左：8942 / 右：8943 整街景统一粗档）",
      panels: [
        { label: "改造前 · 8942", sub: "仅四铺为粗体素，周边街区与江岸风格割裂", file: baseDesk.shots.flat100, displayW: 620 },
        { label: "改造后 · 8943", sub: "整街景几何轮廓与明暗块统一", file: fullDesk.shots.flat100, displayW: 620 }
      ],
      outPath: path.join(cmpDir, "compare-panorama-desktop-flat.png")
    });

    await composeCompareBoard(browser, {
      title: "393px 四铺两端及南接缝同镜头前后对照（CD-S01 45° 100%）",
      panels: [
        { label: "改造前 · 8942（四铺与周边割裂）", sub: "四铺南端延续骑楼/树木/周边砖房仍为旧扁平贴图", file: base393.shots.landmarks["CD-S01"].s100, displayW: 393 },
        { label: "改造后 · 8943（整图接缝统一）", sub: "四铺两端延续骑楼、口袋树、街面与后街砖房同尺度衔接", file: full393.shots.landmarks["CD-S01"].s100, displayW: 393 }
      ],
      outPath: path.join(cmpDir, "compare-seam-didong-393.png")
    });

    await composeGridBoard(browser, {
      title: "393px 四处分散地标与街岸交界同镜头前后对照（左：8942 / 右：8943）",
      rows: [
        {
          heading: "① 北端接缝：CD-A01 江门市博物馆长堤分馆（双山花骑楼 + 咖啡伞 + 临江立面）",
          panels: [
            { label: "改造前 · 8942", file: base393.shots.landmarks["CD-A01"].s100, displayW: 360 },
            { label: "改造后 · 8943", file: full393.shots.landmarks["CD-A01"].s100, displayW: 360 }
          ]
        },
        {
          heading: "② 街岸交界：CD-A03 水埠头石阶（9级石阶 + 乌篷船 + 石堤护栏）",
          panels: [
            { label: "改造前 · 8942", file: base393.shots.landmarks["CD-A03"].s100, displayW: 360 },
            { label: "改造后 · 8943", file: full393.shots.landmarks["CD-A03"].s100, displayW: 360 }
          ]
        },
        {
          heading: "③ 北区地标：CD-A02 江门海关旧址（连廊 + 钟楼 + 榕树广场）",
          panels: [
            { label: "改造前 · 8942", file: base393.shots.landmarks["CD-A02"].s100, displayW: 360 },
            { label: "改造后 · 8943", file: full393.shots.landmarks["CD-A02"].s100, displayW: 360 }
          ]
        },
        {
          heading: "④ 南端地标与接缝：CD-R02 江门铁桥（钢桁架桥 + 沿江停车场 + 南延续骑楼）",
          panels: [
            { label: "改造前 · 8942", file: base393.shots.landmarks["CD-R02"].s100, displayW: 360 },
            { label: "改造后 · 8943", file: full393.shots.landmarks["CD-R02"].s100, displayW: 360 }
          ]
        }
      ],
      outPath: path.join(cmpDir, "compare-landmarks-4dispersed-393.png")
    });

    // Continuous mobile recordings (393px & 375px)
    const mp4_393 = await recordMobileWalkthrough(browser, {
      vw: 393, vh: 852,
      outMp4: path.join(qaDir, "mobile-393-full-coarse-walkthrough.mp4")
    });
    const mp4_375 = await recordMobileWalkthrough(browser, {
      vw: 375, vh: 812,
      outMp4: path.join(qaDir, "mobile-375-full-coarse-walkthrough.mp4")
    });

    const summary = {
      generatedAt: new Date().toISOString(),
      previewUrl: fullUrl,
      baselineUrl: base8942Url,
      videos: { mp4_393, mp4_375 },
      results: {
        full393: { errors: full393.errors, metrics: full393.metrics },
        full375: { errors: full375.errors, metrics: full375.metrics },
        fullDesk: { errors: fullDesk.errors, metrics: fullDesk.metrics },
        fullReduced: { errors: fullReduced.errors, metrics: fullReduced.metrics }
      }
    };
    fs.writeFileSync(path.join(qaDir, "metrics-full-coarse.json"), JSON.stringify(summary, null, 2));
    console.log("VERIFICATION_OK", JSON.stringify({
      errors393: full393.errors.length,
      errors375: full375.errors.length,
      errorsDesk: fullDesk.errors.length,
      errorsReduced: fullReduced.errors.length,
      flat393LabelOverlap: full393.metrics.flat100.maxPairLabelOverlap,
      flat375LabelOverlap: full375.metrics.flat100.maxPairLabelOverlap,
      didong393ShopsVisible: full393.metrics.landmarks["CD-S01"].m100.allShopsInVisible,
      didong375ShopsVisible: full375.metrics.landmarks["CD-S01"].m100.allShopsInVisible,
      route375ShopsVisible: full375.metrics.routeDidong100.allShopsInVisible,
      route375Return: full375.metrics.routeReturnState
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

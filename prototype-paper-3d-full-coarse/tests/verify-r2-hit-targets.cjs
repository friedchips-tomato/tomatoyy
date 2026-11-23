// NODE_PATH=/Volumes/1t扩展盘/Codex项目/SD-Chinese-style-furniture/node_modules node prototype-paper-3d-full-coarse/tests/verify-r2-hit-targets.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const URL_8943 = process.argv[2] && process.argv[2].startsWith("http")
  ? process.argv[2]
  : "http://127.0.0.1:8943/prototype-paper-3d-full-coarse/";
const OUT_DIR = path.resolve(__dirname, "../screenshots/r2-hit-fix");
fs.mkdirSync(OUT_DIR, { recursive: true });

const ROUTES = ["flat", "R1", "R2", "R3"];
const TITLE_BY_ID = {
  "CD-R01": "蓬江大桥",
  "CD-V01": "启明里",
  "CD-A02": "江门海关旧址",
  "CD-A01": "江门市博物馆长堤分馆",
  "CD-A03": "水埠头石阶",
  "CD-S01": "堤东路骑楼",
  "CD-S02": "新市路",
  "CD-S03": "墟顶老街",
  "CD-P01": "沿江停车场",
  "CD-R02": "江门铁桥"
};

async function waitReady(page) {
  await page.waitForFunction(() => {
    const s = window.__CD3D__ && window.__CD3D__.getState();
    return Boolean(s && s.atlasReady && s.frameCount >= 4);
  }, { timeout: 25000, polling: 70 });
}

async function waitIdle(page, extraMs = 80) {
  await page.waitForFunction(() => {
    const s = window.__CD3D__ && window.__CD3D__.getState();
    return Boolean(s && !s.animating);
  }, { timeout: 10000, polling: 40 });
  const fc0 = await page.evaluate(() => window.__CD3D__.getState().frameCount);
  await page.waitForFunction(target => {
    const s = window.__CD3D__ && window.__CD3D__.getState();
    return Boolean(s && !s.animating && s.frameCount >= target);
  }, fc0 + 1, { timeout: 10000, polling: 40 });
  if (extraMs > 0) await page.waitForTimeout(extraMs);
}

async function tapOrClickLocator(locator, isTouch) {
  if (isTouch) await locator.tap({ timeout: 6000 });
  else await locator.click({ timeout: 6000 });
}

async function tapOrClickPoint(page, x, y, isTouch) {
  if (isTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function getState(page) {
  return page.evaluate(() => {
    const s = window.__CD3D__.getState();
    const mapR = document.getElementById("map-viewport").getBoundingClientRect();
    const tbR = document.getElementById("map-toolbar").getBoundingClientRect();
    const nav = document.getElementById("navigation");
    const overlay = document.getElementById("overlay");
    const active = document.activeElement;
    const shops = (s.sampleShops || []).map(sh => ({
      ...sh,
      inVisible: sh.left >= -2 && sh.right <= mapR.width + 2 && sh.top >= -2 && sh.bottom <= mapR.height + 2
    }));
    return {
      view: s.view,
      focusedPointId: s.focusedPointId,
      voxelTier: s.voxelTier,
      voxelUnit: s.voxelUnit,
      zoomPercent: s.zoomPercent,
      distance: Number(s.distance.toFixed(3)),
      pitchDeg: Number(s.pitchDeg.toFixed(2)),
      yawDeg: Number(s.yawDeg.toFixed(2)),
      target: s.target.map(n => Number(n.toFixed(3))),
      overlayOpen: !overlay.hidden,
      sheetTitle: document.getElementById("sheet-title")?.textContent || "",
      activeAction: active?.dataset?.action || "",
      activeId: active?.dataset?.id || "",
      navVisible: !nav.hidden,
      mapRect: [mapR.x, mapR.y, mapR.width, mapR.height].map(n => Number(n.toFixed(2))),
      toolbarRect: [tbR.x, tbR.y, tbR.width, tbR.height].map(n => Number(n.toFixed(2))),
      toolbarOutsideMap: tbR.top >= mapR.bottom - 0.5,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      allShopsInVisible: shops.length === 4 && shops.every(x => x.inVisible),
      sampleShops: shops
    };
  });
}

async function pixelScanLabels(page) {
  return page.evaluate(() => {
    const map = document.getElementById("map-viewport").getBoundingClientRect();
    const items = [];
    for (const label of document.querySelectorAll(".map-label")) {
      const button = label.closest("button");
      const id = button.dataset.id;
      const r = label.getBoundingClientRect();
      // Keep 1px inside map bottom/right because Chromium elementFromPoint tests a 1x1 box
      const x0 = Math.ceil(Math.max(map.left, r.left));
      const x1 = Math.floor(Math.min(map.right - 1, r.right));
      const y0 = Math.ceil(Math.max(map.top, r.top));
      const y1 = Math.floor(Math.min(map.bottom - 1, r.bottom));
      const blockers = {};
      let tested = 0;
      let hit = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          tested++;
          const el = document.elementFromPoint(x, y);
          const b = el && el.closest("button");
          if (b === button) {
            hit++;
            continue;
          }
          const k = b
            ? (b.dataset.action + ":" + b.dataset.id)
            : (el ? (el.id || el.className || el.tagName) : "no-hit");
          blockers[k] = (blockers[k] || 0) + 1;
        }
      }
      const visW = Math.max(0, Math.min(map.right, r.right) - Math.max(map.left, r.left));
      const visH = Math.max(0, Math.min(map.bottom, r.bottom) - Math.max(map.top, r.top));
      const clipped = r.left < map.left || r.right > map.right || r.top < map.top || r.bottom > map.bottom;
      const controlBlocked = Object.keys(blockers).filter(k =>
        k.startsWith("voxel-tier:") ||
        k.startsWith("zoom:") ||
        k.startsWith("return-flat:") ||
        k.includes("voxel") ||
        k.includes("zoom") ||
        k.includes("map-controls") ||
        k.includes("map-toolbar")
      );
      const labelBlocked = Object.keys(blockers).filter(k => k.startsWith("point:"));
      items.push({
        id,
        name: label.textContent,
        rect: [r.left, r.top, r.width, r.height].map(n => Number(n.toFixed(1))),
        visW: Number(visW.toFixed(1)),
        visH: Number(visH.toFixed(1)),
        clipped,
        tested,
        hit,
        blockers,
        controlBlocked,
        labelBlocked
      });
    }
    return {
      mapRect: [map.left, map.top, map.width, map.height].map(n => Number(n.toFixed(2))),
      items
    };
  });
}

async function probeLabelSpot(page, id, spot) {
  return page.evaluate(({ id, spot }) => {
    const map = document.getElementById("map-viewport").getBoundingClientRect();
    const label = document.querySelector(`.map-spot[data-id="${id}"] .map-label`);
    if (!label) return null;
    const r = label.getBoundingClientRect();
    const leftVis = Math.max(map.left + 1, r.left);
    const rightVis = Math.min(map.right - 2, r.right);
    const topVis = Math.max(map.top + 1, r.top);
    const botVis = Math.min(map.bottom - 2, r.bottom);
    if (rightVis - leftVis < 6 || botVis - topVis < 6) return null;
    let x;
    if (spot === "left") x = Math.ceil(leftVis) + 1;
    else if (spot === "right") x = Math.floor(rightVis) - 1;
    else if (spot === "rightEdge") x = Math.floor(rightVis);
    else x = Math.round((leftVis + rightVis) / 2);
    const y = Math.round((topVis + botVis) / 2);
    const hitEl = document.elementFromPoint(x, y);
    const btn = hitEl && hitEl.closest("button");
    return {
      x,
      y,
      rect: [r.left, r.top, r.width, r.height].map(n => Number(n.toFixed(1))),
      hitAction: btn?.dataset?.action || "",
      hitId: btn?.dataset?.id || ""
    };
  }, { id, spot });
}

async function switchRoute(page, routeId, hadRoute, isTouch) {
  if (hadRoute) {
    await tapOrClickLocator(page.locator('[data-action="menu"][data-id="route"]'), isTouch);
    await page.waitForSelector('[data-action="end-route"]', { timeout: 6000 });
    await tapOrClickLocator(page.locator('[data-action="end-route"]'), isTouch);
    await waitIdle(page, 120);
  }
  await tapOrClickLocator(page.locator('[data-action="menu"][data-id="route"]'), isTouch);
  await page.waitForSelector('[data-action="generate"]', { timeout: 6000 });
  await tapOrClickLocator(page.locator('[data-action="generate"]'), isTouch);
  await page.waitForSelector(`[data-action="adopt"][data-id="${routeId}"]`, { timeout: 6000 });
  await tapOrClickLocator(page.locator(`[data-action="adopt"][data-id="${routeId}"]`), isTouch);
  await waitIdle(page, 260);
}

async function closeCard(page, method, isTouch) {
  if (method === "close") {
    await tapOrClickLocator(page.locator("#sheet button.close-button"), isTouch);
  } else {
    await tapOrClickLocator(page.locator("#map-view-back"), isTouch);
  }
  await waitIdle(page, 90);
  await page.waitForFunction(() => document.getElementById("overlay").hidden, { timeout: 6000, polling: 40 });
  await page.waitForTimeout(80);
}

function cameraDrift(a, b) {
  const dt = Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]);
  const dd = Math.abs(a.distance - b.distance);
  return Number(Math.max(dt, dd).toFixed(4));
}

async function testPointSpots(page, id, spots, isTouch, expectedZoom, closeToggleStart = 0) {
  const results = [];
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    const before = await getState(page);
    const probe = await probeLabelSpot(page, id, spot);
    assert.ok(probe, `Label ${id} (${spot}) not visible enough to click`);
    assert.equal(probe.hitAction, "point", `elementFromPoint at ${id} ${spot} (${probe.x},${probe.y}) hit ${probe.hitAction}:${probe.hitId}`);
    assert.equal(probe.hitId, id, `elementFromPoint at ${id} ${spot} hit wrong id ${probe.hitId}`);

    await tapOrClickPoint(page, probe.x, probe.y, isTouch);
    await waitIdle(page, 120);
    await page.waitForFunction(() => !document.getElementById("overlay").hidden, { timeout: 6000, polling: 40 }).catch(async e => { const s = await getState(page); throw new Error(`Overlay did not open for ${id} ${spot} at (${probe.x},${probe.y}); state=${JSON.stringify(s)}`); });

    const opened = await getState(page);
    assert.equal(opened.overlayOpen, true, `Overlay failed to open for ${id} ${spot}`);
    assert.equal(opened.focusedPointId, id, `Focused id mismatch for ${id} ${spot}`);
    assert.equal(opened.sheetTitle, TITLE_BY_ID[id], `Sheet title mismatch for ${id} ${spot}`);
    assert.equal(opened.view, "focused", `Expected focused view for ${id} ${spot}`);
    assert.ok(opened.pitchDeg >= 30, `Expected 45-deg pitch for ${id}, got ${opened.pitchDeg}`);
    assert.equal(opened.voxelTier, "coarse", `Voxel tier changed unexpectedly on ${id}`);

    const closeMethod = (i + closeToggleStart) % 2 === 0 ? "close" : "back";
    await closeCard(page, closeMethod, isTouch);
    const after = await getState(page);
    const drift = cameraDrift(before, after);
    assert.equal(after.view, "flat", `Failed to return to flat after ${id} ${spot}`);
    assert.equal(after.zoomPercent, expectedZoom, `Zoom not preserved after ${id} ${spot}`);
    assert.ok(drift <= 0.02, `Camera drift too large after ${id} ${spot}: ${drift}`);
    assert.equal(after.activeAction, "point", `Focus not returned to point button after ${id} ${spot}`);
    assert.equal(after.activeId, id, `Focus returned to wrong point after ${id} ${spot}: ${after.activeId}`);

    results.push({
      id,
      spot,
      x: probe.x,
      y: probe.y,
      openedTitle: opened.sheetTitle,
      pitchDeg: opened.pitchDeg,
      closeMethod,
      returnDrift: drift,
      returnZoom: after.zoomPercent,
      focusRestoredId: after.activeId
    });
  }
  return results;
}

async function testControlsIndependent(page, isTouch) {
  const seq = [];
  for (const [tier, unit] of [["orig", 0.14], ["medium", 0.34], ["coarse", 0.48]]) {
    await tapOrClickLocator(page.locator(`#map-toolbar [data-action="voxel-tier"][data-id="${tier}"]`), isTouch);
    await waitIdle(page, 90);
    const st = await getState(page);
    assert.equal(st.voxelTier, tier);
    assert.equal(st.voxelUnit, unit);
    assert.equal(st.overlayOpen, false);
    seq.push({ tier, unit: st.voxelUnit });
  }
  await tapOrClickLocator(page.locator('#map-toolbar [data-action="zoom"][data-id="1"]'), isTouch);
  await waitIdle(page, 140);
  assert.equal((await getState(page)).zoomPercent, 150);
  await tapOrClickLocator(page.locator('#map-toolbar [data-action="zoom"][data-id="1"]'), isTouch);
  await waitIdle(page, 140);
  assert.equal((await getState(page)).zoomPercent, 200);
  await tapOrClickLocator(page.locator('#map-toolbar [data-action="zoom"][data-id="-1"]'), isTouch);
  await waitIdle(page, 140);
  assert.equal((await getState(page)).zoomPercent, 150);
  await tapOrClickLocator(page.locator('#map-toolbar [data-action="zoom"][data-id="-1"]'), isTouch);
  await waitIdle(page, 140);
  assert.equal((await getState(page)).zoomPercent, 100);
  return { tiers: seq, zoomCycle: [150, 200, 150, 100] };
}

async function testSheetControls(page, isTouch, shotPath) {
  const before = await getState(page);
  const probe = await probeLabelSpot(page, "CD-S01", "center");
  await tapOrClickPoint(page, probe.x, probe.y, isTouch);
  await waitIdle(page, 160);
  await page.waitForFunction(() => !document.getElementById("overlay").hidden, { timeout: 6000, polling: 40 });

  const openSt = await getState(page);
  assert.equal(openSt.focusedPointId, "CD-S01");
  assert.equal(openSt.voxelTier, "coarse");
  assert.equal(openSt.voxelUnit, 0.48);

  const controlsInsideSheet = await page.evaluate(() => {
    const sheet = document.getElementById("sheet");
    const ctrl = document.getElementById("map-controls");
    const back = document.getElementById("map-view-back");
    return sheet.contains(ctrl) && !back.hidden;
  });
  assert.equal(controlsInsideSheet, true, "Controls did not dock into open point sheet");

  if (shotPath) {
    await page.screenshot({ path: shotPath, scale: "css" });
  }

  for (const [tier, unit] of [["orig", 0.14], ["medium", 0.34], ["coarse", 0.48]]) {
    await tapOrClickLocator(page.locator(`#sheet [data-action="voxel-tier"][data-id="${tier}"]`), isTouch);
    await waitIdle(page, 90);
    const st = await getState(page);
    assert.equal(st.voxelTier, tier);
    assert.equal(st.voxelUnit, unit);
  }

  await tapOrClickLocator(page.locator('#sheet [data-action="zoom"][data-id="1"]'), isTouch);
  await waitIdle(page, 140);
  assert.equal((await getState(page)).zoomPercent, 150);

  await closeCard(page, "back", isTouch);
  const after = await getState(page);
  const drift = cameraDrift(before, after);
  assert.equal(after.view, "flat");
  assert.equal(after.zoomPercent, 100, "Returning from zoomed card must restore pre-focus zoom (100%)");
  assert.ok(drift <= 0.02, `Camera drift too large after sheet controls: ${drift}`);
  const returnedToToolbar = await page.evaluate(() => {
    return document.getElementById("map-toolbar").contains(document.getElementById("map-controls"))
      && document.getElementById("map-view-back").hidden;
  });
  assert.equal(returnedToToolbar, true, "Controls did not return to toolbar on card close");

  return {
    allShopsInVisible100: openSt.allShopsInVisible,
    sampleShops100: openSt.sampleShops,
    controlsInsideSheet,
    returnedToToolbar,
    returnDrift: drift
  };
}

async function runViewport({ name, vw, vh, dpr, isTouch, reducedMotion = false }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  });
  const errors = [];
  const result = { viewport: { vw, vh, dpr, isTouch, reducedMotion }, errors, routes: {} };

  try {
    const context = await browser.newContext({
      viewport: { width: vw, height: vh },
      deviceScaleFactor: dpr,
      hasTouch: isTouch,
      isMobile: isTouch,
      reducedMotion: reducedMotion ? "reduce" : "no-preference"
    });
    const page = await context.newPage();
    page.on("console", m => { if (m.type() === "error") errors.push("console:" + m.text()); });
    page.on("pageerror", e => errors.push("pageerror:" + e.message));
    page.on("requestfailed", r => errors.push("req:" + r.url()));

    await page.goto(URL_8943, { waitUntil: "domcontentloaded" });
    await waitReady(page);
    await waitIdle(page, 180);

    let hadRoute = false;
    for (const route of ROUTES) {
      if (route !== "flat") {
        await switchRoute(page, route, hadRoute, isTouch);
        hadRoute = true;
      }

      const st100 = await getState(page);
      assert.equal(st100.voxelTier, "coarse", `Default tier not coarse in ${name} ${route}`);
      assert.equal(st100.voxelUnit, 0.48, `Default voxelUnit not 0.48 in ${name} ${route}`);
      assert.equal(st100.zoomPercent, 100);
      assert.equal(st100.horizontalOverflow, false, `Horizontal overflow in ${name} ${route} 100%`);
      assert.equal(st100.toolbarOutsideMap, true, `Toolbar overlaps map in ${name} ${route} 100%`);

      const scan100 = await pixelScanLabels(page);
      for (const item of scan100.items) {
        assert.equal(item.controlBlocked.length, 0, `100% control blocker on ${name} ${route} ${item.id}: ${JSON.stringify(item.blockers)}`);
        assert.equal(item.labelBlocked.length, 0, `100% label overlap on ${name} ${route} ${item.id}: ${JSON.stringify(item.blockers)}`);
      }

      if (!reducedMotion && (route === "flat" || route === "R2")) {
        await page.screenshot({ path: path.join(OUT_DIR, `${name}-${route}-100.png`), scale: "css" });
      }

      // Real clicks at 100%:
      // - On flat & R2: full L/C/R on both bridges (CD-R01, CD-R02 + rightEdge), customs (CD-A02), stone steps (CD-A03).
      // - On R1 & R3: L/C/R on customs (CD-A02) & stone steps (CD-A03), plus C/R on bridges (CD-R01, CD-R02).
      // - On reducedMotion: all 10 labels L/C/R!
      const clicks100 = [];
      let targets100;
      if (reducedMotion) {
        targets100 = Object.keys(TITLE_BY_ID).map(id => [id, ["left", "center", "right"]]);
      } else if (route === "R2") {
        targets100 = [
          ["CD-R01", ["left", "center", "right"]],
          ["CD-R02", ["left", "center", "right", "rightEdge"]],
          ["CD-A02", ["left", "center", "right"]],
          ["CD-A03", ["left", "center", "right"]]
        ];
      } else if (route === "flat") {
        targets100 = [
          ["CD-R01", ["left", "center", "right"]],
          ["CD-R02", ["left", "center", "right"]],
          ["CD-A02", ["left", "center", "right"]],
          ["CD-A03", ["center"]]
        ];
      } else {
        targets100 = [
          ["CD-R01", ["center"]],
          ["CD-R02", ["right"]],
          ["CD-A02", ["center"]],
          ["CD-A03", ["center"]]
        ];
      }
      for (const [id, spots] of targets100) {
        clicks100.push(...await testPointSpots(page, id, spots, isTouch, 100));
      }

      if (!reducedMotion && route === "R2") {
        result.independentControls = await testControlsIndependent(page, isTouch);
        result.sheetControls = await testSheetControls(page, isTouch, path.join(OUT_DIR, `${name}-R2-sheet-CD-S01.png`));
      }

      // Zoom to 150% via normal toolbar zoom button
      await tapOrClickLocator(page.locator('#map-toolbar [data-action="zoom"][data-id="1"]'), isTouch);
      await waitIdle(page, 200);

      const st150 = await getState(page);
      assert.equal(st150.zoomPercent, 150, `Failed to reach 150% in ${name} ${route}`);
      assert.equal(st150.horizontalOverflow, false, `Horizontal overflow in ${name} ${route} 150%`);
      assert.equal(st150.toolbarOutsideMap, true, `Toolbar overlaps map in ${name} ${route} 150%`);

      const scan150 = await pixelScanLabels(page);
      for (const item of scan150.items) {
        assert.equal(item.controlBlocked.length, 0, `150% control blocker on ${name} ${route} ${item.id}: ${JSON.stringify(item.blockers)}`);
        assert.equal(item.labelBlocked.length, 0, `150% label overlap on ${name} ${route} ${item.id}: ${JSON.stringify(item.blockers)}`);
      }

      if (!reducedMotion) {
        await page.screenshot({ path: path.join(OUT_DIR, `${name}-${route}-150.png`), scale: "css" });
      }

      // Real clicks at 150%:
      // Every visible label in map viewport (>= 16px wide & >= 10px high):
      // - Customs (CD-A02) & Stone Steps (CD-A03): full L/C/R in ALL routes!
      // - Other visible labels (CD-A01, CD-S01, CD-P01, CD-S02): L/C/R on reducedMotion or flat/R2, center on R1/R3.
      const clicks150 = [];
      const clickable150 = scan150.items.filter(it => it.visW >= 16 && it.visH >= 10);
      for (const item of clickable150) {
        let spots;
        if (reducedMotion || item.id === "CD-A02") {
          spots = ["left", "center", "right"];
        } else if (item.id === "CD-A03" && (route === "flat" || route === "R2")) {
          spots = ["left", "center", "right"];
        } else {
          spots = ["center"];
        }
        clicks150.push(...await testPointSpots(page, item.id, spots, isTouch, 150, 1));
      }

      // Return to 100% before next route
      await tapOrClickLocator(page.locator('#map-toolbar [data-action="zoom"][data-id="-1"]'), isTouch);
      await waitIdle(page, 160);
      assert.equal((await getState(page)).zoomPercent, 100);

      result.routes[route] = {
        st100: { mapRect: st100.mapRect, toolbarRect: st100.toolbarRect, voxelTier: st100.voxelTier, voxelUnit: st100.voxelUnit },
        scan100Flagged: scan100.items.filter(x => Object.keys(x.blockers).length > 0).map(x => ({ id: x.id, blockers: x.blockers })),
        clicks100Count: clicks100.length,
        st150: { mapRect: st150.mapRect, toolbarRect: st150.toolbarRect, zoomPercent: st150.zoomPercent },
        scan150Flagged: scan150.items.filter(x => Object.keys(x.blockers).length > 0).map(x => ({ id: x.id, blockers: x.blockers })),
        clicks150Ids: clickable150.map(x => x.id),
        clicks150Count: clicks150.length,
        clicks100,
        clicks150
      };
      console.log(`[${name}] ${route} OK (100% clicks=${clicks100.length}, 150% clicks=${clicks150.length}, 150% ids=${clickable150.map(x => x.id).join(",")})`);
    }

    await context.close();
    assert.equal(errors.length, 0, `Console/network errors in ${name}: ${errors.join("; ")}`);
    return result;
  } finally {
    await browser.close();
  }
}

(async () => {
  const allViewports = [
    { name: "desktop-1280", vw: 1280, vh: 860, dpr: 2, isTouch: false },
    { name: "mobile-375", vw: 375, vh: 812, dpr: 3, isTouch: true },
    { name: "mobile-393", vw: 393, vh: 852, dpr: 3, isTouch: true },
    { name: "mobile-393-reduced", vw: 393, vh: 852, dpr: 3, isTouch: true, reducedMotion: true }
  ];
  const vpArg = process.argv.find(a => a.startsWith("--vp="));
  const selected = vpArg ? allViewports.filter(v => v.name === vpArg.slice(5)) : allViewports;
  assert.ok(selected.length > 0, "No matching viewport for " + vpArg);

  const outFile = path.join(OUT_DIR, "metrics-r2-hit-fix.json");
  let existing = { url: URL_8943, timestamp: new Date().toISOString(), viewports: {} };
  if (vpArg && fs.existsSync(outFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (parsed && parsed.viewports && typeof parsed.viewports === "object") existing = parsed;
    } catch {}
  }

  const t0 = Date.now();
  for (const vp of selected) {
    const tv = Date.now();
    console.log("Running viewport:", vp.name);
    existing.viewports[vp.name] = await runViewport(vp);
    console.log(`Finished ${vp.name} in ${((Date.now() - tv) / 1000).toFixed(1)}s`);
  }
  existing.url = URL_8943;
  existing.timestamp = new Date().toISOString();
  existing.lastRunDurationSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2));
  console.log(`ALL PASSED in ${existing.lastRunDurationSec}s. Saved: ${outFile}`);
})().catch(err => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});

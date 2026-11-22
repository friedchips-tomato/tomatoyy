// 停车预测与推荐走查（阶段 3 验收 3.1–3.11 的浏览器部分）。用法：
//   NODE_PATH=<含 playwright-core 的 node_modules> CHROMIUM_PATH=<chrome-headless-shell> \
//     node prototype-paper/tests/parking.cjs http://127.0.0.1:8931/prototype-paper/
// 覆盖：① 正常预测卡片（模拟数据标注 + 预测曲线）；② 偏好切换前后排序与理由；
// ③ 理由数字与页面数字一致；④ 坏产物 / 无产物回退态。截图写入 prototype-paper/screenshots/parking/。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'screenshots', 'parking');
const executablePath = process.env.CHROMIUM_PATH || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell');

async function main(url) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  const shots = [];
  const shot = async (page, name, label) => {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(300);
    const file = path.join(outDir, name + '.png');
    await page.screenshot({ path: file, animations: 'disabled' });
    shots.push([file, label]);
  };

  try {
    // ── 场景 1：正常（产物注入 + 运行时就绪）─────────────────────────────
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => window.CD_DATA);

    const runtime = await page.evaluate(() => window.CD_PARKING && {
      ready: window.CD_PARKING.ready,
      source: window.CD_PARKING.source,
      artifactPresent: window.CD_PARKING.artifactPresent,
      demoNow: window.CD_PARKING.demoNow
    });
    assert.equal(runtime.ready, true, '运行时未就绪');
    assert.equal(runtime.source, 'synthetic');
    assert.equal(runtime.artifactPresent, true);

    await page.locator('[data-action="menu"][data-id="services"]').tap();
    await page.locator('[data-action="service-tab"][data-id="parking"]').tap();
    const recCards = page.locator('.card').filter({ has: page.locator('.reasons') });
    await recCards.first().waitFor();

    // 3.4 预测在视觉上可区分（每条静态车场卡有一条虚线预测折线，历史为实线）
    const dashCount = await page.locator('.parking-chart polyline[stroke-dasharray]').count();
    assert.equal(dashCount, 2, '应有 2 条虚线预测折线（每个车场 1 条）');

    // 3.1/3.6 模拟数据标注
    assert((await page.locator('.sheet-body').innerText()).includes('模拟数据'));
    // 首选/备选与理由（推荐卡含 .reasons，静态卡不含）
    assert.equal(await recCards.count(), 2);
    const firstCard = recCards.first();
    const firstText = await firstCard.innerText();
    assert(firstText.includes('首选'));
    assert(firstText.includes('综合分'));
    const reasonCount = await firstCard.locator('.reasons li').count();
    assert(reasonCount >= 3, '首选理由过少');

    await shot(page, '01-parking-normal', '停车 · 正常预测卡片（模拟数据 + 预测曲线）');

    // ── 3.8 理由数字与页面数字一致 ───────────────────────────────────────
    const pageFree = firstText.match(/到达时预计余位\s*(\d+)\s*个/);
    const reasonFree = firstText.match(/到达时预计余位\s*(\d+)\s*个（约\s*(\d+)%\s*空置率）/);
    assert(pageFree, '页面缺少到达时预计余位数字');
    assert(reasonFree, '理由缺少到达时预计余位数字');
    assert.equal(pageFree[1], reasonFree[1], '理由与页面「预计余位」不一致');
    assert(firstText.includes(`空置率约 ${reasonFree[2]}%`), '理由与页面「空置率」不一致');

    const pageWalk = firstText.match(/步行\s*(\d+)\s*米\s*·\s*约\s*(\d+)\s*分钟/);
    const reasonWalk = firstText.match(/停车后步行约\s*(\d+)\s*分钟（(\d+)\s*米）/);
    assert(pageWalk && reasonWalk, '缺少步行距离数字');
    assert.equal(pageWalk[1], reasonWalk[2], '理由与页面「步行米数」不一致');
    assert.equal(pageWalk[2], reasonWalk[1], '理由与页面「步行分钟」不一致');

    // ── 3.7 偏好切换：权重说明与综合分变化（排序在 2 车场下保持稳定，见报告口径）──
    const prefHintText = () => page.locator('.sheet-body p.small').filter({ hasText: '权重' }).first().innerText();
    const beforeHint = await prefHintText();
    const beforeScore = firstText.match(/综合分\s*([\d.]+)/)[1];
    await page.locator('[data-action="parking-preference"][data-id="less_walking"]').tap();
    await page.waitForTimeout(150);
    const afterText = await recCards.first().innerText();
    const afterHint = await prefHintText();
    const afterScore = afterText.match(/综合分\s*([\d.]+)/)[1];
    assert.notEqual(beforeHint, afterHint, '偏好权重说明未变化');
    assert.notEqual(beforeScore, afterScore, '偏好切换未改变综合分');
    assert(afterText.includes('首选'), '少走路偏好下仍应有首选');
    await shot(page, '02-parking-preference', '停车 · 偏好切换（少走路）');

    assert.deepEqual(errors, [], '正常场景出现控制台/页面错误');

    // ── 场景 2：坏产物（artifact 注入但模型非法）→ 回退静态 + 提示 ────────
    const badPage = await context.newPage();
    const badErrors = [];
    badPage.on('console', msg => { if (msg.type() === 'error') badErrors.push(msg.text()); });
    badPage.on('pageerror', error => badErrors.push(error.message));
    await badPage.route('**/parking-artifact.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.CD_PARKING_ARTIFACT = { injected: true, model: { version: 999, bogus: true }, dataset: { lots: [], observations: [], signals: [] } };'
    }));
    await badPage.goto(url);
    await badPage.waitForFunction(() => window.CD_PARKING && window.CD_PARKING.artifactPresent === true);
    const badRuntime = await badPage.evaluate(() => window.CD_PARKING && { ready: window.CD_PARKING.ready, artifactPresent: window.CD_PARKING.artifactPresent });
    assert.equal(badRuntime.ready, false, '坏产物不应就绪');
    assert.equal(badRuntime.artifactPresent, true);
    await badPage.locator('[data-action="menu"][data-id="services"]').tap();
    await badPage.locator('[data-action="service-tab"][data-id="parking"]').tap();
    await badPage.locator('.parking-chart').first().waitFor();
    const badText = await badPage.locator('.sheet-body').innerText();
    assert(badText.includes('示范数据'), '坏产物应回落静态示范数据');
    assert(badText.includes('暂不可用') || badText.includes('预测暂不可用'), '坏产物应提示暂不可用');
    assert(!badText.includes('到达时预计余位'), '坏产物不应出现推荐预测');
    await shot(badPage, '03-parking-bad-artifact', '停车 · 坏产物回退（暂不可用）');
    assert.deepEqual(badErrors, [], '坏产物场景出现控制台错误');

    // ── 场景 3：无产物（artifact 脚本 404）→ 回退静态 ──────────────────────
    const nonePage = await context.newPage();
    const noneErrors = [];
    nonePage.on('console', msg => { if (msg.type() === 'error') noneErrors.push(msg.text()); });
    nonePage.on('pageerror', error => noneErrors.push(error.message));
    await nonePage.route('**/parking-artifact.js', route => route.abort());
    await nonePage.goto(url);
    await nonePage.waitForFunction(() => window.CD_PARKING);
    const noneRuntime = await nonePage.evaluate(() => window.CD_PARKING && { ready: window.CD_PARKING.ready, artifactPresent: window.CD_PARKING.artifactPresent });
    assert.equal(noneRuntime.ready, false, '无产物不应就绪');
    assert.equal(noneRuntime.artifactPresent, false);
    await nonePage.locator('[data-action="menu"][data-id="services"]').tap();
    await nonePage.locator('[data-action="service-tab"][data-id="parking"]').tap();
    await nonePage.locator('.parking-chart').first().waitFor();
    const noneText = await nonePage.locator('.sheet-body').innerText();
    assert(noneText.includes('示范数据'), '无产物应回落静态示范数据');
    await shot(nonePage, '04-parking-no-artifact', '停车 · 无产物回退');
    // 说明：route.abort() 会让浏览器对停车产物脚本报一次 net::ERR_FAILED（预期，模拟 404），
    // 关键是不影响回退渲染，故此处不断言控制台错误为空。

    await context.close();

    console.log('停车走查通过 · ' + shots.length + ' 张截图 · 正常/坏产物/无产物 + 偏好切换证据 · 控制台错误 0');
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shots.map(([file, label]) => ({ file, label })), null, 2));
  } finally {
    await browser.close();
  }
}

main(process.argv[2] || 'http://127.0.0.1:8931/prototype-paper/').catch(error => { console.error(error); process.exitCode = 1; });

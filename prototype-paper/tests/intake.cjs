// 接诉即办「我的诉求」走查（任务书 P2 验收要求 E）。
// 用法：
//   npm install --no-save playwright-core
//   node prototype-paper/tests/intake.cjs
// 浏览器：默认自动探测本机 Microsoft Edge，可用环境变量 CHROMIUM_PATH 覆盖。
// 脚本自带真实接诉即办服务端与导览接入层，截图写入 prototype-paper/screenshots/intake/。
// 断言失败或页面出现脚本错误时以非零状态退出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const { resolveChromiumPath } = require('./browser.cjs');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'screenshots', 'intake');
const executablePath = resolveChromiumPath();

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const { createIntakeServer } = await import(pathToFileURL(join(root, '../changdi-intake/server/src/server.js')));
  const { createBridge } = await import(pathToFileURL(join(root, '../changdi-intake/guide-bridge/server.js')));
  const dir = await mkdtemp(join(tmpdir(), 'guide-intake-walk-'));
  const token = randomBytes(32).toString('base64url');
  const intake = createIntakeServer({
    dbPath: join(dir, 'db.sqlite'),
    receiptKey: randomBytes(32),
    integrations: [{ source: 'walkthrough', token }],
    staff: []
  });
  let bridge, browser;
  try {
    intake.listen(0, '127.0.0.1'); await once(intake, 'listening');
    const upstream = `http://127.0.0.1:${intake.address().port}`;
    bridge = createBridge({ upstream, token }); bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
    const origin = `http://127.0.0.1:${bridge.address().port}`;
    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      // 走查里 404/502 是故意制造的探针，浏览器会记一条资源加载失败，不算页面错误。
      if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
    });
    const shots = [];
    const shot = async name => {
      await page.waitForTimeout(250);
      const file = path.join(outDir, name + '.png');
      await page.screenshot({ path: file, animations: 'disabled' });
      shots.push(file);
    };
    const shotPanel = async name => {
      await panel().scrollIntoViewIfNeeded();
      await shot(name);
    };
    const openFeedback = async () => {
      await page.locator('[data-action="menu"][data-id="services"]').click();
      await page.locator('[data-action="service-tab"][data-id="feedback"]').click();
      await page.locator('form[data-form="feedback"][data-bridge]').waitFor();
    };
    const panel = () => page.locator('[data-bridge-cases]');
    const storageDump = () => page.evaluate(() => JSON.stringify(localStorage));

    await page.goto(origin);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // 1. 提交一条诉求，回执页出现工单号与公开查询码。
    await openFeedback();
    const form = page.locator('form[data-form="feedback"][data-bridge]');
    await form.locator('[name=occurredAt]').fill('2026-11-19T09:30');
    await form.locator('[name=location]').fill('合成走查地点');
    await form.locator('[name=category]').fill('街面维护');
    await form.locator('[name=description]').fill('合成走查诉求');
    await form.locator('[name=contact]').fill('synthetic-private-contact');
    await form.locator('button[type=submit]').click();
    await form.getByText('诉求已提交').waitFor();
    const receiptText = await form.innerText();
    const caseNumber = (receiptText.match(/工单编号：\s*(CD-[0-9A-F]{32})/) || [])[1];
    const publicCode = (receiptText.match(/公开查询码：\s*([A-Za-z0-9_-]{24})/) || [])[1];
    const privateToken = (receiptText.match(/本人私密凭证：\s*([A-Za-z0-9_-]{43})/) || [])[1];
    assert.ok(caseNumber, '回执必须显示工单编号');
    assert.ok(publicCode, '回执必须显示公开查询码');
    assert.ok(privateToken, '回执必须显示本人私密凭证');
    await page.locator('#sheet-body').evaluate(node => { node.scrollTop = 0; });
    await shot('01-receipt');

    // 2. 本机存储里不得出现私密凭证字段或私密凭证的值。
    const stored = await storageDump();
    console.log('localStorage 快照：', stored);
    assert.doesNotMatch(stored, /privateLookupToken/);
    assert.doesNotMatch(stored, new RegExp(privateToken));
    assert.doesNotMatch(stored, /synthetic-private-contact/);
    const receipts = JSON.parse(JSON.parse(stored)['cd-bridge-receipts-v1']);
    assert.equal(receipts.length, 1);
    assert.deepEqual(Object.keys(receipts[0]).sort(), ['caseNumber', 'publicLookupCode', 'submittedAt']);
    assert.equal(receipts[0].caseNumber, caseNumber);
    assert.equal(receipts[0].publicLookupCode, publicCode);

    // 3. 刷新后「我的诉求」面板仍列出该工单，说明持久化生效。
    await page.reload();
    await openFeedback();
    await panel().waitFor();
    await panel().getByText(caseNumber).waitFor();
    await page.waitForFunction(text => {
      const node = document.querySelector('[data-bridge-case-list] .bridge-case-status');
      return node && node.textContent.includes(text);
    }, '已提交');
    const panelText = await panel().innerText();
    assert.match(panelText, new RegExp(caseNumber));
    assert.match(panelText, /提交时间/);
    assert.match(panelText, /状态：已提交/);
    await shotPanel('02-panel-after-refresh');

    // 4. 刷新后私密凭证不再显示，说明它没有落盘。
    const bodyText = await page.locator('#sheet-body').innerText();
    assert.doesNotMatch(bodyText, new RegExp(privateToken));
    assert.doesNotMatch(bodyText, /本人私密凭证/);
    assert.doesNotMatch(await storageDump(), new RegExp(privateToken));

    // 5. 点击「重新查询」，状态来自服务端真实响应。
    await panel().getByRole('button', { name: '重新查询' }).first().click();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-bridge-case-list] .bridge-case-status');
      return node && node.textContent.includes('已提交');
    });
    assert.match(await panel().innerText(), /状态：已提交/);
    const upstreamBody = await (await fetch(`${upstream}/api/v1/public/cases/${publicCode}`)).json();
    assert.equal(upstreamBody.status, 'submitted');
    assert.equal(upstreamBody.caseNumber, caseNumber);

    // 6. 查不到的工单显示「查不到该工单」，不编造进度。
    await page.evaluate(code => {
      const list = JSON.parse(localStorage.getItem('cd-bridge-receipts-v1'));
      list.push({ caseNumber: 'CD-' + 'F'.repeat(32), publicLookupCode: code, submittedAt: new Date().toISOString() });
      localStorage.setItem('cd-bridge-receipts-v1', JSON.stringify(list));
    }, 'z'.repeat(24));
    await page.reload();
    await openFeedback();
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('[data-bridge-case-list] .bridge-case-status')];
      return nodes.some(node => node.textContent.includes('查不到该工单'));
    });
    assert.match(await panel().innerText(), /查不到该工单/);
    await shotPanel('03-case-not-found');

    // 7. 服务端断开时显示「暂时查不到进度」，不编造进度。
    const closed = once(intake, 'close');
    intake.close();
    intake.closeAllConnections();
    await closed;
    await panel().getByRole('button', { name: '重新查询' }).first().click();
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('[data-bridge-case-list] .bridge-case-status')];
      return nodes.some(node => node.textContent.includes('暂时查不到进度'));
    });
    const offlineText = await panel().innerText();
    assert.match(offlineText, /暂时查不到进度，请稍后再试/);
    assert.doesNotMatch(offlineText, /状态：已提交/);
    await shotPanel('04-upstream-down');

    assert.deepEqual(errors, []);
    console.log('走查通过：提交回执、私密凭证不落盘、刷新后仍可查看、状态来自真实响应、查不到与断线均不编造进度');
    console.log('截图：', shots.join(', '));
  } finally {
    if (browser) await browser.close();
    for (const server of [bridge, intake]) if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

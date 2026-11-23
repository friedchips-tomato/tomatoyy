// 走查值班运营台，并验证运营台改动回到游客端「我的」。截图写入 prototype-paper/screenshots/ops/。
//   npm install --no-save playwright-core
//   node prototype-paper/tests/ops.cjs http://127.0.0.1:8931/prototype-paper/
// 浏览器：默认自动探测本机 Microsoft Edge，可用环境变量 CHROMIUM_PATH 覆盖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { resolveChromiumPath } = require('./browser.cjs');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'screenshots', 'ops');
const executablePath = resolveChromiumPath();

async function main(base) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  const errors = [];
  const shots = [];
  try {
    for (const [size, viewport, mobile] of [['phone', { width: 390, height: 844 }, true], ['desk', { width: 1280, height: 800 }, false]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN' });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
      page.on('pageerror', error => errors.push(error.message));
      const click = locator => mobile ? locator.tap() : locator.click();
      const shot = async (name, label, full = false) => {
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.waitForTimeout(400);
        const file = path.join(outDir, `${size}-${name}.png`);
        await page.screenshot({ path: file, animations: 'disabled', fullPage: full });
        shots.push({ file, label: `${label}（${viewport.width}×${viewport.height}）` });
      };
      // 模拟游客端已提交一条诉求和一单预约
      await page.goto(base + 'ops.html');
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('cd-paper-v1', JSON.stringify({
          lang: 'zh', lit: ['CD-A02'], journal: [{ id: 'CD-A02', at: new Date().toISOString(), lit: true, langs: ['zh'] }],
          requests: [{ id: 'CD-20261120-0001', type: '环境卫生', description: '水埠头石阶第三级松动，请留意', contact: '演示', at: new Date(Date.now() - 50 * 60000).toISOString() }],
          bookings: [{ id: 'BK-1120-001', guide: 'G1', name: '讲解员 A', slot: '14:00', people: 2, at: new Date(Date.now() - 12 * 60000).toISOString() }]
        }));
      });
      await page.reload();
      await page.locator('.stats').waitFor();
      assert.equal(await page.locator('#view-title').textContent(), '值班总览');
      await shot('01-overview', '值班总览', !mobile);

      await click(page.locator('#ops-nav a[data-view="tickets"]'));
      await page.locator('.filters').waitFor();
      assert((await page.locator('#view').innerText()).includes('CD-20261120-0001'));
      await shot('02-tickets', '诉求工单');

      await page.goto(base + 'ops.html#ticket/CD-20261120-0001');
      await page.locator('[data-form="assign"]').waitFor();
      await shot('03-ticket-detail', '工单详情 · 分派前');
      await page.locator('[name=dept]').selectOption('环卫');
      await click(page.getByRole('button', { name: '分派' }));
      await page.locator('.log li').nth(1).waitFor();
      await click(page.getByRole('button', { name: '开始处理' }));
      assert.equal(await page.locator('.timeline li.done').count(), 3);
      await shot('04-ticket-processing', '工单详情 · 处理中');

      await click(page.locator('#ops-nav a[data-view="bookings"]'));
      await page.locator('[data-action="booking"][data-id="BK-1120-001"][data-to="已确认"]').waitFor();
      await shot('05-bookings', '讲解预约 · 待确认');
      await click(page.locator('[data-action="booking"][data-id="BK-1120-001"][data-to="已确认"]'));
      assert((await page.locator('#view').innerText()).includes('已确认'));

      await click(page.locator('#ops-nav a[data-view="parking"]'));
      await click(page.locator('[data-action="lot"]').first());
      assert.equal(await page.locator('.lot.stale').count(), 1);
      await shot('06-parking', '车场 · 标记陈旧');

      await click(page.locator('#ops-nav a[data-view="content"]'));
      await page.locator('.content-table').waitFor();
      await shot('07-content', '点位内容', true);

      // 回到游客端：预约变「已确认」，诉求进度到「处理中」
      await page.goto(base + 'index.html');
      await page.locator('[data-action="menu"][data-id="mine"]').first().click();
      assert((await page.locator('#my-bookings').innerText()).includes('已确认'));
      assert.equal(await page.locator('#my-requests .timeline li.done').count(), 3);
      await page.locator('.sheet-header .close-button').click();
      await page.locator('[data-action="menu"][data-id="services"]').click();
      await page.locator('[data-action="service-tab"][data-id="parking"]').click();
      assert.equal(await page.locator('.card.stale .notice').count(), 1);
      if (mobile) await shot('09-guest-parking-stale', '游客端停车 · 运营台标记陈旧后');
      await page.locator('.sheet-header .close-button').click();
      await page.locator('[data-action="menu"][data-id="mine"]').click();
      if (mobile) {
        await page.evaluate(() => document.getElementById('my-bookings').scrollIntoView({ block: 'start' }));
        await shot('08-guest-mine-synced', '游客端「我的」· 运营台处理后');
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shots, null, 2));
    console.log('值班运营台走查通过 · ' + shots.length + ' 张截图 · 手机 390×844 与桌面 1280×800 · 控制台和页面错误 0');
  } finally {
    await browser.close();
  }
}

main(process.argv[2] || 'http://127.0.0.1:8931/prototype-paper/').catch(error => { console.error(error); process.exitCode = 1; });

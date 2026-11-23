// Run with a local HTTP preview URL. Requires playwright-core installed (npm install --no-save playwright-core).
// Browser: auto-detects local Microsoft Edge; override with the CHROMIUM_PATH environment variable.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const { resolveChromiumPath } = require('./browser.cjs');
const root = path.resolve(__dirname, '..');
const executablePath = resolveChromiumPath();

async function exercise(browser, url, capture) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', error => errors.push(error.message));
  const action = (name, id) => page.locator('[data-action="' + name + '"]' + (id ? '[data-id="' + id + '"]' : ''));
  const tap = (name, id) => action(name, id).first().tap();
  const close = () => page.locator('.sheet-header button').tap();
  const shot = async name => {
    if (capture) await page.screenshot({ path: path.join(root, 'screenshots', name + '.png'), animations: 'disabled' });
  };
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('cd-demo-v1')));
  try {
    await page.goto(url);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.map-base')).backgroundImage !== 'none');
    const data = await page.evaluate(() => CD_DATA);
    const story = data.stories[0];
    const point = data.points.find(p => p.id === story.nodes[1].point);
    const keys = data.points.filter(p => p.key);
    await shot('01-home');
    await tap('point', point.id);
    await page.locator('.point-summary img').waitFor();
    await shot('02-point');
    await tap('listen', point.id);
    assert((await page.locator('.transcript').innerText()).includes(point.guide.zh));
    await tap('check-in', point.id);
    await page.locator('.reward-card img').waitFor();
    assert.equal(await page.locator('.reward-card strong').textContent(), point.cardName);
    await tap('close-reward');
    await tap('stop-audio');
    assert.equal(await page.locator('.map-color.lit').count(), 1);
    await shot('03-lit');
    await tap('point', point.id);
    assert(await action('check-in').isDisabled());
    await tap('detail', point.id);
    assert((await page.locator('#sheet.full').innerText()).includes(point.intro));
    assert.equal(await page.locator('.sources li').count(), point.sources.length);
    await tap('start-story');
    assert.equal(await page.locator('.map-note').count(), story.nodes.length);
    await tap('story-step', '1');
    assert((await page.locator('#navigation').innerText()).includes(story.nodes[2].text));
    await tap('story-step', '-1');
    await tap('exit-story');
    await tap('menu', 'route');
    await tap('interest', '骑楼建筑');
    await tap('interest', '侨乡历史');
    await tap('duration', '30');
    await tap('transport', 'drive');
    await tap('generate');
    await page.locator('.skeleton').first().waitFor();
    await page.locator('.route-card').first().waitFor();
    assert.equal(await page.locator('.route-card').count(), 3);
    assert.equal(await page.locator('#map-lines polyline').count(), 3);
    await shot('04-route-preview');
    const route = data.routes.find(r => r.drive);
    assert.equal(await action('adopt').first().getAttribute('data-id'), route.id);
    await tap('adopt', route.id);
    assert.equal(await page.locator('#map-lines polyline').count(), 1);
    for (const [index, id] of route.points.entries()) {
      assert((await page.locator('#navigation').innerText()).includes('第 ' + (index + 1) + '/' + route.points.length));
      const fresh = !(await saved()).lit.includes(id);
      await tap('arrived');
      if (fresh) await tap('close-reward');
      assert((await saved()).lit.includes(id));
    }
    assert.equal(await page.locator('#sheet-title').textContent(), '路线完成');
    await close();
    const unlocked = (await saved()).lit;
    const scan = keys.find(p => !unlocked.includes(p.id));
    await tap('menu', 'scan');
    assert.equal(await action('scan-point').count(), keys.length);
    await tap('scan-point', scan.id);
    await tap('close-reward');
    assert((await saved()).lit.includes(scan.id));
    await tap('menu', 'services');
    const guide = data.guides[0];
    await page.locator('[data-guide-filter]').selectOption(guide.langs[0]);
    await tap('book', guide.id);
    await page.locator('[name=slot]').selectOption({ index: 1 });
    await page.locator('[name=people]').fill('2');
    await page.getByText('提交预约', { exact: true }).tap();
    assert((await page.locator('#sheet-body').innerText()).includes('已提交，待讲解员确认'));
    await close();
    await tap('menu', 'services');
    await tap('service-tab', 'parking');
    assert.equal(await page.locator('.parking-chart polyline[stroke-dasharray]').count(), data.parking.length);
    assert.equal(await page.locator('.parking-chart polyline:not([stroke-dasharray])').count(), data.parking.length);
    await shot('05-parking');
    await tap('parking-start');
    assert.equal(await action('transport', 'drive').getAttribute('aria-pressed'), 'true');
    await close();
    await tap('menu', 'services');
    await tap('service-tab', 'feedback');
    await page.locator('[name=type]').selectOption({ index: 1 });
    await page.locator('[name=description]').fill('导览演示测试');
    await page.locator('[name=photo]').setInputFiles(path.join(root, point.card));
    await page.locator('.feedback-preview').waitFor();
    await page.locator('[name=contact]').fill('演示联系人');
    await page.getByText('提交反馈', { exact: true }).tap();
    const ticket = await page.locator('#sheet-body h3').textContent();
    assert.match(ticket, /^CD-\d{8}-\d{4}$/);
    assert.equal(await page.locator('.timeline li').count(), 4);
    await page.reload();
    await tap('menu', 'mine');
    assert.equal(await page.locator('.album-card').count(), keys.length);
    const lit = (await saved()).lit;
    const obtained = keys.filter(p => lit.includes(p.id));
    assert.equal(await page.locator('.album-card .silhouette').count(), keys.length - obtained.length);
    await page.waitForFunction(n => document.querySelectorAll('.album img').length === n, obtained.filter(p => p.card).length);
    assert((await page.locator('#my-bookings').innerText()).includes(guide.name));
    assert((await page.locator('#my-requests').innerText()).includes(ticket));
    await shot('06-album');
    await tap('reset');
    assert.equal(await saved(), null);
    assert.equal(await page.locator('.album-card .silhouette').count(), keys.length);
    assert.equal(await page.locator('#my-bookings article, #my-requests article').count(), 0);
    assert.deepEqual(errors, []);
    console.log(new URL(url).protocol + ' 全流程通过 · 390×844 · 控制台和页面错误 0');
  } finally {
    await context.close();
  }
}

(async () => {
  assert(process.argv[2], '请传入本地 HTTP 预览地址');
  const browser = await chromium.launch({ executablePath });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1000, height: 844 } });
    await desktop.goto(process.argv[2]);
    assert.deepEqual(await desktop.locator('.phone').boundingBox(), { x: 305, y: 0, width: 390, height: 844 });
    await desktop.close();
    console.log('宽屏居中框通过 · 390×844');
    await exercise(browser, process.argv[2], true);
    await exercise(browser, pathToFileURL(path.join(root, 'index.html')).href, false);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// 逐页走查游客端并截图（390×844 手机竖屏）。用法：
//   npm install --no-save playwright-core
//   node prototype-paper/tests/pages.cjs http://127.0.0.1:8931/prototype-paper/
// 浏览器：默认自动探测本机 Microsoft Edge，可用环境变量 CHROMIUM_PATH 覆盖。
// 截图写入 prototype-paper/screenshots/h5/。断言失败或页面出现脚本、控制台错误时以非零状态退出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { resolveChromiumPath } = require('./browser.cjs');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'screenshots', 'h5');
const executablePath = resolveChromiumPath();

async function main(url) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', error => errors.push(error.message));
  const action = (name, id) => page.locator('[data-action="' + name + '"]' + (id ? '[data-id="' + id + '"]' : ''));
  const tap = (name, id) => action(name, id).first().tap();
  const close = () => page.locator('.sheet-header .close-button').tap();
  const shots = [];
  const shot = async (name, label) => {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(350);
    const file = path.join(outDir, name + '.png');
    await page.screenshot({ path: file, animations: 'disabled' });
    shots.push([file, label]);
  };
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('cd-paper-v1')));
  const title = () => page.locator('#sheet-title').textContent();

  try {
    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.map-base')).backgroundImage !== 'none');
    const data = await page.evaluate(() => CD_DATA);
    const keys = data.points.filter(p => p.key);
    const story = data.stories[0];
    const point = data.points.find(p => p.id === story.nodes[1].point);
    const name = p => p.name.replace(/（.*?）/g, '');

    // 地图铺满：纸下没有露底
    const box = await page.locator('.map-stage').boundingBox();
    const area = await page.locator('.map-scroll').boundingBox();
    assert(box.height >= area.height - 1 && box.width >= area.width - 1, '地图未铺满');
    assert.equal(await page.locator('#seals .seal').count(), keys.length);
    await shot('01-home', '首页 · 街景看楼');

    await tap('point', point.id);
    await page.locator('.point-summary img').waitFor();
    assert.equal(await title(), name(point));
    assert(await page.locator('.map-spot.selected').count() === 1);
    await shot('02-point-card', '点位卡');

    await tap('detail', point.id);
    assert((await page.locator('#sheet.full').innerText()).includes(point.intro));
    assert.equal(await page.locator('.sources li').count(), point.sources.length);
    await page.locator('.hero img').waitFor();
    await shot('03-detail', '点位详情');

    await tap('listen', point.id);
    assert.equal(await page.locator('#sheet').getAttribute('data-kind'), 'listen');
    assert((await page.locator('.transcript').innerText()).replace(/\s/g, '').includes(point.guide.zh.replace(/\s/g, '')));
    await page.waitForTimeout(300);
    await shot('04-listen', '讲解（手动收听）');

    await tap('check-in', point.id);
    await page.locator('.reward-card img').waitFor();
    assert.equal(await page.locator('.reward-card strong').textContent(), point.cardName);
    await shot('05-reward', '收卡 · 盖印');
    await tap('close-reward');
    assert.equal(await page.locator('#seals .seal.lit').count(), 1);
    assert.equal(await page.locator('#sheet').getAttribute('data-kind'), 'listen');
    await close();
    await tap('stop-audio');
    assert.equal(await page.locator('.map-color.lit').count(), 1);
    await shot('06-map-lit', '街景 · 点亮一栋后');

    await tap('point', point.id);
    assert(await action('check-in').isDisabled());
    await tap('detail', point.id);
    await tap('start-story');
    assert.equal(await page.locator('.map-note').count(), story.nodes.length);
    await tap('story-step', '1');
    assert((await page.locator('#navigation').innerText()).includes(story.nodes[2].text));
    await shot('07-story', '故事线');
    await tap('exit-story');

    await tap('menu', 'route');
    await tap('interest', '骑楼建筑');
    await tap('interest', '侨乡历史');
    await tap('duration', '60');
    await shot('08-route-form', '沿街行程单 · 填写');
    await tap('generate');
    await page.locator('.skeleton').first().waitFor();
    await page.locator('.route-card').first().waitFor();
    assert.equal(await page.locator('.route-card').count(), 3);
    assert.equal(await page.locator('#map-lines polyline').count(), 3);
    await shot('09-route-results', '三条候选路线');
    const routeId = await action('adopt').first().getAttribute('data-id');
    const route = data.routes.find(r => r.id === routeId);
    await tap('adopt', routeId);
    assert.equal(await page.locator('#map-lines polyline').count(), 1);
    await shot('10-route-nav', '沿街行程 · 地图导航');
    await tap('itinerary');
    assert.equal(await page.locator('.itinerary li').count(), route.points.length);
    await shot('11-itinerary', '行程单');
    await close();

    for (const [index, id] of route.points.entries()) {
      assert((await page.locator('#navigation').innerText()).includes('第 ' + (index + 1) + '/' + route.points.length));
      const fresh = !(await saved()).lit.includes(id);
      await tap('arrived');
      if (fresh) await tap('close-reward');
      assert((await saved()).lit.includes(id));
      if (index + 1 < route.points.length && data.points.find(p => p.id === id).guide) {
        await page.locator('#sheet[data-kind="listen"]').waitFor();
        assert.match(await page.locator('#sheet-kicker').textContent(), /^到站讲解/);
        if (index === 1) await shot('12-arrival-listen', '到站讲解');
        await close();
      }
    }
    assert.equal(await title(), '路线完成');
    await shot('13-route-complete', '路线完成');
    await close();

    const unlocked = (await saved()).lit;
    const scan = keys.find(p => !unlocked.includes(p.id));
    await tap('menu', 'scan');
    assert.equal(await action('scan-point').count(), keys.length);
    await shot('14-scan', '扫码到站（模拟）');
    await tap('scan-point', scan.id);
    await tap('close-reward');
    assert((await saved()).lit.includes(scan.id));
    await close();

    await tap('menu', 'services');
    const guide = data.guides[0];
    await page.locator('[data-guide-filter]').selectOption(guide.langs[0]);
    await shot('15-guides', '服务 · 讲解员');
    await tap('book', guide.id);
    await page.locator('.chip.slot').nth(1).tap();
    await page.locator('[name=people]').fill('2');
    await shot('16-booking', '讲解预约');
    await page.getByText('提交预约', { exact: true }).tap();
    assert((await page.locator('#sheet-body').innerText()).includes('已提交，待讲解员确认'));
    await shot('17-booking-success', '预约已提交');
    await close();

    await tap('menu', 'services');
    await tap('service-tab', 'parking');
    assert.equal(await page.locator('.parking-chart polyline[stroke-dasharray]').count(), data.parking.length);
    await shot('18-parking', '服务 · 停车');
    await tap('parking-start');
    assert.equal(await action('transport', 'drive').getAttribute('aria-pressed'), 'true');
    await close();
    const lotPoint = data.points.find(p => p.parking);
    await page.evaluate(id => document.querySelector(`[data-action="point"][data-id="${id}"]`).click(), lotPoint.id);
    await page.locator('.parking-chart').waitFor();
    await shot('19-parking-point', '停车场点位卡');
    await close();

    await tap('menu', 'services');
    await tap('service-tab', 'feedback');
    await page.locator('[name=type]').selectOption({ index: 1 });
    await page.locator('[name=description]').fill('水埠头石阶第三级松动，请留意');
    await page.locator('[name=photo]').setInputFiles(path.join(root, point.card));
    await page.locator('.feedback-preview').waitFor();
    await shot('20-feedback', '服务 · 反馈');
    await page.getByText('提交反馈', { exact: true }).tap();
    const ticket = await page.locator('.ticket-no').textContent();
    assert.match(ticket, /^CD-\d{8}-\d{4}$/);
    assert.equal(await page.locator('.timeline li').count(), 4);
    await shot('21-feedback-success', '反馈已受理');
    await close();

    await page.reload();
    await tap('menu', 'mine');
    assert.equal(await page.locator('.album-card').count(), keys.length);
    const lit = (await saved()).lit;
    const obtained = keys.filter(p => lit.includes(p.id));
    await page.waitForFunction(n => document.querySelectorAll('.album img').length === n, obtained.length);
    assert((await page.locator('#my-bookings').innerText()).includes(guide.name));
    assert((await page.locator('#my-requests').innerText()).includes(ticket));
    await shot('22-mine', '个人页 · 卡册');
    await page.locator('#my-bookings').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.getElementById('my-bookings').scrollIntoView({ block: 'start' }));
    await shot('23-mine-records', '个人页 · 预约与诉求');

    await tap('journal');
    const entries = (await saved()).journal.length;
    assert(entries > 0);
    assert.equal(await page.locator('.journal-item').count(), entries);
    await page.waitForFunction(() => document.querySelectorAll('.journal-item img').length > 0);
    await shot('24-journal', '游记回听');
    await page.locator('.journal-item [data-action="listen"]').first().tap();
    assert.equal(await page.locator('#sheet').getAttribute('data-kind'), 'listen');
    await close();

    await page.locator('[data-action="language"][data-id="yue"]').tap();
    await tap('point', point.id);
    await tap('listen', point.id);
    assert((await page.locator('.transcript').innerText()).replace(/\s/g, '').includes(point.guide.yue.replace(/\s/g, '')));
    await shot('25-listen-yue', '讲解 · 粤语');
    await close();
    await page.locator('[data-action="language"][data-id="zh"]').tap();

    // 小卡配图三种做法，同一点位卡对比
    for (const pic of ['crop', 'mount', 'stamp']) {
      await page.goto(url + '?pic=' + pic);
      await page.locator('[data-action="language"][data-id="zh"]').tap();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.map-base')).backgroundImage !== 'none');
      await tap('point', point.id);
      await page.locator('.point-summary img').waitFor();
      await shot('pic-' + pic, '配图 · ' + pic);
      await close();
    }

    await tap('menu', 'mine');
    await tap('reset');
    assert.equal(await saved(), null);
    assert.equal(await page.locator('.album-card .silhouette').count(), keys.length);
    await close();
    await tap('menu', 'mine');
    await tap('journal');
    await shot('26-journal-empty', '游记回听 · 空状态');
    await close();

    assert.deepEqual(errors, []);
    console.log('游客端逐页走查通过 · ' + shots.length + ' 张截图 · 390×844 · 控制台和页面错误 0');
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shots.map(([file, label]) => ({ file, label })), null, 2));
  } finally {
    await browser.close();
  }
}

main(process.argv[2] || 'http://127.0.0.1:8931/prototype-paper/').catch(error => { console.error(error); process.exitCode = 1; });

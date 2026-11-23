// Optional browser acceptance. Set NODE_PATH to a playwright-core installation and CHROMIUM_PATH to Edge/Chromium.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { runInNewContext } = require('node:vm');
const { chromium } = require('playwright-core');

// 浏览器定位：复用走查脚本的公共解析（CHROMIUM_PATH 优先，其次自动探测本机 Edge），
// 找不到时给出中文提示而不是 playwright 的英文异常。
const BROWSER_HELPER = join(__dirname, '..', '..', 'prototype-paper', 'tests', 'browser.cjs');
function resolveBrowserPath() {
  if (existsSync(BROWSER_HELPER)) {
    const { resolveChromiumPath } = require(BROWSER_HELPER);
    return resolveChromiumPath();
  }
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  throw new Error('找不到可用的 Chromium 内核浏览器：请设置 CHROMIUM_PATH 指向本机 Edge/Chrome 可执行文件');
}

const beijingOffset = 8 * 3600000;
const beijingMonth = ms => new Date(ms + beijingOffset).toISOString().slice(0, 7);

// The prototype catalog is the only source of truth for the subject codes the guide emits.
async function prototypeCatalogs() {
  const window = {};
  runInNewContext(await readFile(pathToFileURL(join(__dirname, '../../prototype-paper/data/points.js')), 'utf8'), {window});
  const {routes, guides, parking, points} = window.CD_DATA;
  return {
    route_exposed: routes.map(item => item.id),
    route_adopted: routes.map(item => item.id),
    route_completed_self_reported: routes.map(item => item.id),
    booking_demo_submitted: guides.map(item => item.id),
    parking_advice_adopted: parking.map(item => item.id),
    parking_navigation_clicked: parking.map(item => item.id),
    guide_played: points.filter(point => point.guide).map(point => point.id)
  };
}

async function checkTourism(page, origin, events) {
  page.setDefaultTimeout(5000);
  const action = (name, id) => page.locator(`[data-action="${name}"]${id ? `[data-id="${id}"]` : ''}`);
  async function waitForEvent(predicate) {
    for (let i = 0; i < 100; i++) {
      const event = events.find(predicate);
      if (event) return event;
      await delay(30);
    }
    assert.fail(`No matching tourism event. Received: ${JSON.stringify(events)}`);
  }
  const eventOf = type => waitForEvent(event => event.type === type);
  await page.addInitScript(() => {
    // Let the real guide UI control the queue; drive only the speech engine callbacks.
    let utterance;
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; }
    };
    Object.defineProperty(window, 'speechSynthesis', {value: {
      getVoices: () => ['zh-CN', 'en-US'].map(lang => ({lang, localService: true})),
      speak: item => { utterance = item; },
      cancel: () => { utterance = null; }
    }});
    window.qaSpeech = {
      start: () => utterance.onstart(),
      end: () => utterance.onend(),
      error: () => utterance.onerror(),
      finishRemaining() {
        for (let i = 0; i < 30; i++) {
          const previous = utterance;
          utterance.onstart();
          utterance.onend();
          if (previous === utterance) return;
        }
        throw new Error('Guide did not finish');
      }
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const browserPosts = [];
  const browserStatuses = [];
  const failed = [];
  page.on('request', req => {
    if (req.url().endsWith('/bridge/tourism-events')) {
      browserPosts.push({headers: req.headers(), body: req.postDataJSON(), request: req});
    }
  });
  page.on('requestfailed', req => {
    if (req.url().endsWith('/bridge/tourism-events')) failed.push(req);
  });
  page.on('response', response => {
    if (!response.url().endsWith('/bridge/tourism-events')) return;
    browserStatuses.push(response.status());
    // Only a request the bridge answered was accepted by the server and may be counted.
    const attempt = browserPosts.find(entry => entry.request === response.request());
    if (attempt) events.push(attempt.body);
  });
  await page.goto(origin);
  await action('menu','route').click();
  await action('generate').click();
  const cards = page.locator('[data-route-id]');
  await cards.first().waitFor();
  const routeIds = await cards.evaluateAll(items => items.map(card => card.dataset.routeId));
  const first = await waitForEvent(event => event.type === 'route_exposed' && event.subjectId === routeIds[0]);
  assert.ok(!events.some(event => event.subjectId === routeIds.at(-1)), 'offscreen route must not count yet');
  const second = cards.nth(1);
  await second.scrollIntoViewIfNeeded();
  await waitForEvent(event => event.type === 'route_exposed' && event.subjectId === routeIds[1]);
  await cards.last().scrollIntoViewIfNeeded();
  await waitForEvent(event => event.type === 'route_exposed' && event.subjectId === routeIds[2]);

  const beforeRedraw = browserPosts.length;
  await page.evaluate(() => {
    // Exercise the existing refreshSheet handler while the recommendation panel is open.
    const formAction = document.createElement('button');
    formAction.dataset.action = 'service-tab';
    formAction.dataset.id = 'guides';
    document.getElementById('sheet-body').append(formAction);
    formAction.click();
  });
  await cards.first().scrollIntoViewIfNeeded();
  await cards.last().scrollIntoViewIfNeeded();
  await cards.first().scrollIntoViewIfNeeded();
  assert.equal(browserPosts.length, beforeRedraw);
  assert.deepEqual(events.filter(event => event.type === 'route_exposed').map(event => event.subjectId).sort(), [...routeIds].sort());
  assert.ok(events.every(event => event.flowId === first.flowId));

  await action('adopt', first.subjectId).click();
  const adopted = await eventOf('route_adopted');
  const route = await page.evaluate(id => window.CD_DATA.routes.find(item => item.id === id), adopted.subjectId);
  for (const [index] of route.points.entries()) {
    await action('arrived').click();
    const modal = page.locator('[data-action="close-reward"]');
    const overlay = page.locator('#overlay:not([hidden])');
    try {
      await modal.or(overlay).first().waitFor();
    } catch (error) {
      throw new Error(`Route step ${index + 1} did not open a card or sheet: ${errors.join(', ')}`, {cause: error});
    }
    if (await modal.isVisible()) await modal.click();
    if (index + 1 < route.points.length) {
      assert.ok(!events.some(event => event.type === 'route_completed_self_reported'));
      if (await overlay.isVisible()) await page.keyboard.press('Escape');
      await action('arrived').waitFor();
    }
  }
  const completed = await eventOf('route_completed_self_reported');
  assert.equal(completed.subjectId, adopted.subjectId);
  assert.equal(completed.flowId, adopted.flowId);
  await page.locator('#sheet[data-kind="complete"]').waitFor();
  await page.keyboard.press('Escape');
  // The automatic speech requests above never started, so none should be reported.
  assert.ok(!events.some(event => event.type === 'guide_played'));
  if (await action('stop-audio').first().isVisible()) await action('stop-audio').first().click();

  const pointId = 'CD-A01';
  const showGuide = async () => {
    await action('point', pointId).click();
    await action('listen', pointId).click();
  };
  await showGuide();
  await page.evaluate(() => window.qaSpeech.error());
  assert.ok(!events.some(event => event.type === 'guide_played'));
  const play = action('play', pointId);
  await play.click();
  await page.evaluate(() => window.qaSpeech.start());
  await delay(650);
  await play.click();
  await delay(1350);
  await play.click();
  await delay(1200);
  await page.evaluate(() => window.qaSpeech.start());
  await delay(650);
  await page.evaluate(() => {
    window.qaSpeech.end();
    window.qaSpeech.finishRemaining();
  });
  const played = await eventOf('guide_played');
  assert.equal(played.subjectId, pointId);
  assert.equal(played.durationSeconds, 1, 'paused and preparing time must not count');
  await page.keyboard.press('Escape');
  await action('language', 'en').click();
  await showGuide();
  assert.equal(await page.locator('.transcript p[lang]').getAttribute('lang'), 'en-US');
  await page.evaluate(() => window.qaSpeech.error());
  await page.keyboard.press('Escape');

  await action('menu', 'services').click();
  await action('book', 'G1').click();
  const form = page.locator('form[data-form="booking"]');
  await form.locator('.slot').first().click();
  await form.locator('[name="people"]').fill('13');
  await form.getByRole('button', {name:'提交预约'}).click();
  const booked = await eventOf('booking_demo_submitted');
  assert.equal(booked.subjectId, 'G1');
  await page.locator('#sheet[data-kind="booking-success"]').waitFor();
  await page.keyboard.press('Escape');

  await action('menu', 'services').click();
  await action('service-tab', 'parking').click();
  assert.ok(!events.some(event => event.type.startsWith('parking_')));
  await action('parking-start', 'P1').click();
  const parked = await eventOf('parking_advice_adopted');
  assert.equal(parked.subjectId, 'P1');
  assert.equal(await action('parking-navigation').count(), 0);
  assert.equal(events.filter(event => event.type === 'parking_navigation_clicked').length, 0);
  await page.locator('#sheet[data-kind="route"]').waitFor();
  assert.match(await page.locator('#sheet').innerText(), /沿江停车场/);
  await action('generate').click();
  const newBatch = await waitForEvent(event => event.type === 'route_exposed' && event.flowId !== first.flowId);
  await cards.first().waitFor();
  assert.notEqual(newBatch.flowId, first.flowId);
  await page.waitForLoadState('networkidle');
  const postsBeforeReload = browserPosts.length;
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(browserPosts.length, postsBeforeReload);

  const keys = ['eventId', 'flowId', 'occurredAt', 'subjectId', 'type'];
  // One request is aborted on purpose below, so it never reaches the bridge or the server.
  assert.equal(browserPosts.length, events.length + failed.length);
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  assert.deepEqual(browserStatuses, events.map(() => 204));
  for (const {headers, body} of browserPosts) {
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.deepEqual(Object.keys(body).sort(), body.type === 'guide_played' ? ['durationSeconds', ...keys] : keys);
    assert.match(body.occurredAt, /Z$/);
    assert.match(body.eventId, /^[0-9a-f]{24}$/);
  }
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  for (const event of events) {
    assert.ok(!storage.includes(event.eventId));
    assert.ok(!storage.includes(event.flowId));
  }

  let dropped = 0;
  await page.route('**/bridge/tourism-events', request => {
    dropped++;
    return request.abort('failed');
  });
  await action('menu', 'services').click();
  await action('service-tab', 'parking').click();
  await action('parking-start', 'P2').click();
  await page.locator('#sheet[data-kind="route"]').waitFor();
  assert.match(await page.locator('#sheet').innerText(), /内街停车场/);
  assert.equal(dropped, 1);
  assert.equal(events.filter(event => event.type === 'parking_advice_adopted').length, 1);
  assert.deepEqual(errors, []);
}

(async () => {
  const { createIntakeServer } = await import('../server/src/server.js');
  const { createBridge } = await import('./server.js');
  const dir = await mkdtemp(join(tmpdir(),'guide-browser-'));
  const token = randomBytes(32).toString('base64url');
  const duty = randomBytes(32).toString('base64url');
  const metricsToken = randomBytes(32).toString('base64url');
  const catalogs = await prototypeCatalogs();
  const intake = createIntakeServer({
    dbPath:join(dir,'db.sqlite'),
    receiptKey:randomBytes(32),
    integrations:[{source:'browser-test',token}],
    staff:[{id:'desk',role:'duty',token:duty}],
    tourism: {
      sources: [{id:'guide-demo', kind:'guide_h5', evidence:'demo', token:metricsToken, subjects:catalogs}],
      coverage: Object.keys(catalogs).map(type => ({evidence:'demo', type, from:'2026-01-01T00:00:00Z', status:'complete'}))
    }
  });
  let bridge, browser, metricsBridge;
  try {
    intake.listen(0,'127.0.0.1'); await once(intake,'listening');
    const upstream = `http://127.0.0.1:${intake.address().port}`;
    bridge = createBridge({upstream,token}); bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
    browser = await chromium.launch({executablePath:resolveBrowserPath(),headless:true});
    const page = await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'});
    const errors = []; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${bridge.address().port}/`);
    assert.equal(await page.evaluate(() => typeof window.CD_TOURISM), 'undefined');
    await page.locator('[data-action="menu"][data-id="route"]').click();
    await page.locator('[data-action="generate"]').click();
    await page.locator('.route-card').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-action="menu"][data-id="services"]').click();
    await page.locator('[data-action="service-tab"][data-id="feedback"]').click();
    const form = page.locator('form[data-form="feedback"][data-bridge]'); await form.waitFor();
    await form.locator('[name=occurredAt]').fill('2026-11-19T09:30');
    await form.locator('[name=location]').fill('合成地点');
    await form.locator('[name=category]').fill('街面维护');
    await form.locator('[name=description]').fill('合成测试诉求');
    await form.locator('[name=contact]').fill('synthetic-private-contact');
    if (process.env.GUIDE_QA_SCREENSHOT) await page.screenshot({path:process.env.GUIDE_QA_SCREENSHOT});
    let dropped = false;
    await page.route('**/bridge/submit', async route => {
      if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await form.locator('button[type=submit]').click();
    await form.getByText('连接中断或超时', {exact:false}).waitFor();
    assert.equal(await form.locator('[name=description]').isDisabled(),true);
    await form.getByRole('button',{name:'按原内容重试'}).click();
    await form.getByText('诉求已提交').waitFor();
    assert.match(await form.innerText(), /本人私密凭证/);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /synthetic-private-contact|privateLookupToken/);
    const queue = await (await fetch(upstream+'/api/v1/staff/cases?queue=pending_intake',{headers:{Authorization:`Bearer ${duty}`}})).json();
    assert.equal(queue.items.length,1);
    assert.deepEqual(errors,[]);
    console.log('Browser acceptance passed: guide submission, receipt, privacy and management queue');

    // The metrics bridge forwards to the real intake server with its own Bearer credential.
    metricsBridge = createBridge({upstream, token, metricsToken});
    metricsBridge.listen(0,'127.0.0.1');
    await once(metricsBridge,'listening');
    const received = [];
    const tourismPage = await browser.newPage({viewport:{width:390,height:600},locale:'zh-CN',reducedMotion:'reduce'});
    await checkTourism(tourismPage, `http://127.0.0.1:${metricsBridge.address().port}/`, received);
    console.log('Browser tourism acceptance passed: route exposure/adoption/completion, TTS callbacks, booking demo and parking advice');

    // Recompute the aggregates from the events the browser actually sent and compare them
    // with the authorised management report read over real HTTP.
    assert.ok(received.length > 0, 'the guide must produce tourism events');
    const month = beijingMonth(Date.parse(received[0].occurredAt));
    const response = await fetch(`${upstream}/api/v1/staff/monthly-report?month=${month}`, {headers:{Authorization:`Bearer ${duty}`}});
    assert.equal(response.status, 200);
    const report = await response.json();
    const distinct = new Map();
    let playback = 0;
    for (const item of received) {
      distinct.set(`${item.type}|${item.subjectId}|${item.flowId}`, item);
      if (item.type === 'guide_played') playback += item.durationSeconds;
    }
    const expected = {};
    for (const item of distinct.values()) expected[item.type] = (expected[item.type] ?? 0) + 1;
    for (const [type, total] of Object.entries(expected)) {
      assert.equal(report.tourism.demo[type].count, total, `demo ${type}`);
    }
    assert.equal(report.tourism.demo.guide_played.durationSeconds, playback);
    assert.equal(expected.route_adopted, 1);
    assert.equal(expected.route_completed_self_reported, 1);
    assert.equal(expected.booking_demo_submitted, 1);
    assert.equal(expected.parking_advice_adopted, 1);
    // The prototype has no parking navigation entry, so the covered metric is a real zero.
    assert.equal(report.tourism.demo.parking_navigation_clicked.status, 'complete');
    assert.equal(report.tourism.demo.parking_navigation_clicked.count, 0);
    // No operational source is configured, so the operational column stays uncovered.
    assert.equal(report.tourism.operational.route_exposed.status, 'unavailable');
    assert.equal(report.tourism.status, 'partial');
    assert.doesNotMatch(JSON.stringify(report.tourism), /guide-demo|eventId|flowId|subjectId/);
    assert.doesNotMatch(JSON.stringify(report.tourism), new RegExp(metricsToken));
    console.log(`Browser tourism report acceptance passed: ${month} demo totals recomputed from ${received.length} browser events`);
  } finally {
    if (browser) await browser.close();
    for (const server of [metricsBridge,bridge,intake]) if (server?.listening) {
      const closed = once(server,'close');
      server.close();
      server.closeAllConnections();
      await closed;
      assert.equal(server.listening, false);
    }
    await rm(dir,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

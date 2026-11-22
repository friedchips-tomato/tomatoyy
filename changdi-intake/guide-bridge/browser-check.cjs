// Optional browser acceptance. Set NODE_PATH to a playwright-core installation and CHROMIUM_PATH to Edge/Chromium.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright-core');

(async () => {
  const { createIntakeServer } = await import('../server/src/server.js');
  const { createBridge } = await import('./server.js');
  const dir = await mkdtemp(join(tmpdir(),'guide-browser-'));
  const token = randomBytes(32).toString('base64url');
  const duty = randomBytes(32).toString('base64url');
  const intake = createIntakeServer({dbPath:join(dir,'db.sqlite'), receiptKey:randomBytes(32), integrations:[{source:'browser-test',token}], staff:[{id:'desk',role:'duty',token:duty}]});
  let bridge, browser;
  try {
    intake.listen(0,'127.0.0.1'); await once(intake,'listening');
    const upstream = `http://127.0.0.1:${intake.address().port}`;
    bridge = createBridge({upstream,token}); bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
    const page = await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'});
    const errors = []; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${bridge.address().port}/`);
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
  } finally {
    if (browser) await browser.close();
    for (const server of [bridge,intake]) if (server?.listening) { const closed = once(server,'close'); server.close(); server.closeAllConnections(); await closed; }
    await rm(dir,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

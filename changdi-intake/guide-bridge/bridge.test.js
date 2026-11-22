import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntakeServer } from '../server/src/server.js';
import { createBridge } from './server.js';

test('导览提交经过接入层进入管理队列，并可安全重取同一回执', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guide-bridge-'));
  const token = randomBytes(32).toString('base64url');
  const duty = randomBytes(32).toString('base64url');
  const intake = createIntakeServer({ dbPath:join(dir,'db.sqlite'), receiptKey:randomBytes(32), integrations:[{source:'guide-test', token}], staff:[{id:'desk',role:'duty',token:duty}] });
  let bridge;
  t.after(async () => {
    for (const server of [bridge, intake]) if (server?.listening) { const closed = once(server,'close'); server.close(); server.closeAllConnections(); await closed; assert.equal(server.listening,false); }
    await rm(dir,{recursive:true,force:true});
  });
  intake.listen(0,'127.0.0.1'); await once(intake,'listening');
  const upstream = `http://127.0.0.1:${intake.address().port}`;
  bridge = createBridge({upstream,token}); bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
  const origin = `http://127.0.0.1:${bridge.address().port}`;
  const html = await (await fetch(origin)).text(); assert.match(html, /\/bridge\/client.js/);
  const makeForm = (description = 'synthetic detail') => {
    const f = new FormData(); f.append('payload',JSON.stringify({externalCaseId:'synthetic-id',occurredAt:'2026-11-19T09:30:00+08:00',location:'synthetic location',category:'road',description}));
    f.append('photos', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC','base64')], {type:'image/png'}), 'synthetic.png');
    return f;
  };
  const blocked = await fetch(origin+'/bridge/submit',{method:'POST',headers:{Origin:'http://example.test'},body:makeForm()}); assert.equal(blocked.status,403);
  const submit = async form => fetch(origin+'/bridge/submit',{method:'POST',headers:{Origin:origin},body:form});
  const first = await submit(makeForm()); assert.equal(first.status,201); const receipt = await first.json();
  assert.match(receipt.privateLookupToken,/^[A-Za-z0-9_-]{43}$/);
  const repeat = await submit(makeForm()); assert.equal(repeat.status,200); assert.deepEqual(await repeat.json(),receipt);
  assert.equal((await submit(makeForm('different content'))).status,409);
  const queue = await (await fetch(upstream+'/api/v1/staff/cases?queue=pending_intake',{headers:{Authorization:`Bearer ${duty}`}})).json();
  assert.deepEqual(queue.items.map(item=>item.caseNumber),[receipt.caseNumber]);
  const publicCase = await (await fetch(upstream+'/api/v1/public/cases/'+receipt.publicLookupCode)).json(); assert.equal(publicCase.status,'submitted');
  assert.doesNotMatch(JSON.stringify(publicCase),/synthetic detail|privateLookupToken/);
});

test('只允许配置回环后端', () => {
  assert.throws(() => createBridge({upstream:'https://example.test',token:'test'}));
  assert.throws(() => createBridge({upstream:'http://127.0.0.1:3400',token:''}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECEIPT_STORAGE_KEY,
  MAX_RECEIPTS,
  normalizeReceipt,
  parseReceipts,
  readReceipts,
  addReceipt,
  statusText,
  formatCaseTime
} from '../client.js';

const CASE_NUMBER = 'CD-' + 'A'.repeat(32);
const CODE = 'abcdefghijklmnopqrstuvwx';
const CODE2 = '0123456789abcdefghijklmn';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    dump: () => Object.fromEntries(data)
  };
}

test('回执只接受三个合法字段，多余字段一律不保留', () => {
  const entry = normalizeReceipt({ caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z', privateLookupToken: 'secret-token' });
  assert.deepEqual(Object.keys(entry).sort(), ['caseNumber', 'publicLookupCode', 'submittedAt']);
  assert.equal(entry.privateLookupToken, undefined);
  assert.equal(entry.submittedAt, '2026-11-19T09:30:00.000Z');
});

test('形态不合法的回执一律丢弃', () => {
  const bad = [
    null,
    undefined,
    'CD-whatever',
    [],
    { caseNumber: 'CD-123', publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z' },
    { caseNumber: CASE_NUMBER.toLowerCase(), publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z' },
    { caseNumber: CASE_NUMBER, publicLookupCode: 'short-code', submittedAt: '2026-11-19T09:30:00.000Z' },
    { caseNumber: CASE_NUMBER, publicLookupCode: CODE + '!', submittedAt: '2026-11-19T09:30:00.000Z' },
    { caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: 'not-a-date' },
    { caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: '' },
    { caseNumber: CASE_NUMBER, publicLookupCode: CODE }
  ];
  for (const entry of bad) assert.equal(normalizeReceipt(entry), null);
});

test('解析存储内容：损坏 JSON 与非数组都当作空，非法条目被丢弃', () => {
  assert.deepEqual(parseReceipts('{broken'), []);
  assert.deepEqual(parseReceipts('{"caseNumber":"x"}'), []);
  assert.deepEqual(parseReceipts(null), []);
  assert.deepEqual(parseReceipts(undefined), []);
  const parsed = parseReceipts(JSON.stringify([
    { caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z' },
    { caseNumber: 'bad', publicLookupCode: CODE2, submittedAt: '2026-11-19T09:30:00.000Z' },
    { caseNumber: CASE_NUMBER, publicLookupCode: CODE2, submittedAt: '2026-11-19T09:30:00.000Z' }
  ]));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(item => item.publicLookupCode), [CODE, CODE2]);
});

test('写入后按公开查询码去重，超限丢最旧的', () => {
  const storage = fakeStorage();
  const codeOf = index => ('c' + index).padEnd(24, 'x');
  let current = [];
  for (let index = 0; index < MAX_RECEIPTS; index++) {
    const code = codeOf(index);
    current = addReceipt({ caseNumber: 'CD-' + index.toString(16).padStart(32, '0').toUpperCase(), publicLookupCode: code, submittedAt: '2026-11-19T09:30:00.000Z' }, storage, current).entries;
  }
  assert.equal(current.length, MAX_RECEIPTS);
  const oldest = current[current.length - 1];
  assert.equal(oldest.publicLookupCode, codeOf(0));
  const again = addReceipt({ caseNumber: 'CD-' + 'B'.repeat(32), publicLookupCode: oldest.publicLookupCode, submittedAt: '2026-11-20T09:30:00.000Z' }, storage, current);
  assert.equal(again.entries.length, MAX_RECEIPTS);
  assert.equal(again.entries[0].publicLookupCode, oldest.publicLookupCode);
  assert.equal(again.entries.filter(item => item.publicLookupCode === oldest.publicLookupCode).length, 1);
  const fresh = addReceipt({ caseNumber: 'CD-' + 'C'.repeat(32), publicLookupCode: CODE, submittedAt: '2026-11-21T09:30:00.000Z' }, storage, again.entries);
  assert.equal(fresh.entries.length, MAX_RECEIPTS);
  assert.equal(fresh.entries[0].publicLookupCode, CODE);
  assert.ok(!fresh.entries.some(item => item.publicLookupCode === codeOf(1)), '最旧的一条应当被淘汰');
  assert.ok(fresh.entries.some(item => item.publicLookupCode === codeOf(2)));
});

test('私密凭证不进入任何持久化内容', () => {
  const storage = fakeStorage();
  const result = addReceipt({ caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z', privateLookupToken: 'private-secret-value' }, storage, []);
  assert.equal(result.ok, true);
  const raw = storage.dump()[RECEIPT_STORAGE_KEY];
  assert.doesNotMatch(raw, /privateLookupToken|private-secret-value/);
  assert.deepEqual(Object.keys(JSON.parse(raw)[0]).sort(), ['caseNumber', 'publicLookupCode', 'submittedAt']);
});

test('存储异常时静默降级为内存态', () => {
  const broken = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('quota exceeded'); }
  };
  const read = readReceipts(broken);
  assert.equal(read.ok, false);
  assert.deepEqual(read.entries, []);
  assert.deepEqual(readReceipts(null).entries, []);
  const write = addReceipt({ caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z' }, broken, []);
  assert.equal(write.ok, false);
  assert.equal(write.entries.length, 1, '条目仍保留在内存态');
  const invalid = addReceipt({ caseNumber: 'bad', publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z' }, fakeStorage(), []);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.entries, []);
});

test('读取时逐条校验并丢弃非法条目', () => {
  const storage = fakeStorage({
    [RECEIPT_STORAGE_KEY]: JSON.stringify([
      { caseNumber: CASE_NUMBER, publicLookupCode: CODE, submittedAt: '2026-11-19T09:30:00.000Z' },
      { caseNumber: 'CD-NOT-VALID', publicLookupCode: CODE2, submittedAt: '2026-11-19T09:30:00.000Z' },
      { caseNumber: CASE_NUMBER, publicLookupCode: CODE2, submittedAt: 'whenever' }
    ])
  });
  const read = readReceipts(storage);
  assert.equal(read.ok, true);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].publicLookupCode, CODE);
});

test('状态文案只覆盖服务端真实状态，未知状态显示状态更新中', () => {
  assert.equal(statusText('submitted'), '已提交');
  assert.equal(statusText('closed'), '已办结');
  assert.equal(statusText('processing'), '处理中');
  assert.equal(statusText('not_a_real_status'), '状态更新中');
  assert.equal(statusText(undefined), '状态更新中');
  assert.equal(formatCaseTime('2026-11-19T09:30:00.000Z').length, 16);
  assert.equal(formatCaseTime('nonsense'), '');
});

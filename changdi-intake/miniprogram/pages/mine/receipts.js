// 本机回执夹：只保存工单编号、24 位公开查询码与提交时间三项。
// 私密查询凭证、问题描述、发生地点、联系方式与照片一律不写入存储，用户可一键清除本机记录。
// 纯逻辑模块，可在 Node 里直接测试；存储读写异常不外抛，由调用方按 ok 判断并给出提示。

// 存储键。结构变化时递增版本号，避免与旧结构互相覆盖。
const STORAGE_KEY = 'changdi:my-cases:v1';

// 最多保留 20 条，超出按最旧淘汰。
const MAX_ENTRIES = 20;

// 工单编号格式，与服务端回执一致。
const CASE_NUMBER_PATTERN = /^CD-[0-9A-F]{32}$/;
// 公开查询码格式，与 pages/public/query.js 的公开码口径一致。
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

// 取本机存储实现。优先用调用方注入的替身，其次用小程序的同步存储；都没有时返回 null。
function resolveStorage(options) {
  const injected = options && options.storage;
  if (injected && typeof injected.get === 'function') return injected;
  const api = typeof wx === 'undefined' ? null : wx;
  if (!api || typeof api.getStorageSync !== 'function') return null;
  return {
    get: key => api.getStorageSync(key),
    set: (key, value) => api.setStorageSync(key, value),
    remove: key => api.removeStorageSync(key)
  };
}

// 校验一条回执并整理成只含三个允许字段的条目。不合格返回 null，调用方直接丢弃。
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const caseNumber = typeof entry.caseNumber === 'string' ? entry.caseNumber.trim() : '';
  const publicLookupCode = typeof entry.publicLookupCode === 'string' ? entry.publicLookupCode.trim() : '';
  const submittedAt = typeof entry.submittedAt === 'string' ? entry.submittedAt.trim() : '';
  if (!CASE_NUMBER_PATTERN.test(caseNumber)) return null;
  if (!PUBLIC_CODE_PATTERN.test(publicLookupCode)) return null;
  const time = Date.parse(submittedAt);
  if (!submittedAt || Number.isNaN(time)) return null;
  // 只保留三个允许字段，其余字段一律不写入存储。
  return { caseNumber, publicLookupCode, submittedAt: new Date(time).toISOString() };
}

// 解析存储里的原始内容。JSON 解析失败、非数组或非法条目都按容错处理，不抛异常。
function parseStored(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (error) {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const entries = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, MAX_ENTRIES);
}

// 读取本机回执夹。返回 { ok, entries }，存储不可用或读取异常时 ok 为 false。
function readReceipts(options) {
  const storage = resolveStorage(options);
  if (!storage) return { ok: false, entries: [] };
  let raw;
  try {
    raw = storage.get(STORAGE_KEY);
  } catch (error) {
    return { ok: false, entries: [] };
  }
  return { ok: true, entries: parseStored(raw) };
}

// 追加一条回执。参数只接受工单编号、公开查询码与提交时间，签名里没有私密凭证的位置。
// 同一编号重复提交时更新并移到最前；超过上限时淘汰最旧的一条。
function addReceipt(caseNumber, publicLookupCode, submittedAt, options) {
  const entry = normalizeEntry({ caseNumber, publicLookupCode, submittedAt });
  // 不合格的记录直接丢弃，既不读也不写存储。
  if (!entry) return { ok: false, entries: [] };
  const storage = resolveStorage(options);
  if (!storage) return { ok: false, entries: [] };
  let existing = [];
  try {
    existing = parseStored(storage.get(STORAGE_KEY));
  } catch (error) {
    return { ok: false, entries: [] };
  }
  const next = [entry, ...existing.filter(item => item.caseNumber !== entry.caseNumber)].slice(0, MAX_ENTRIES);
  try {
    storage.set(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    return { ok: false, entries: existing };
  }
  return { ok: true, entries: next };
}

// 清除本机回执夹。返回 { ok }。
function clearAll(options) {
  const storage = resolveStorage(options);
  if (!storage) return { ok: false };
  try {
    storage.remove(STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    return { ok: false };
  }
}

module.exports = {
  STORAGE_KEY,
  MAX_ENTRIES,
  CASE_NUMBER_PATTERN,
  PUBLIC_CODE_PATTERN,
  resolveStorage,
  normalizeEntry,
  parseStored,
  readReceipts,
  addReceipt,
  clearAll
};

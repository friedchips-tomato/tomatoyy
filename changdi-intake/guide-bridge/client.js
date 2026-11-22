// 导览接诉即办接入层前端：提交回执、本机回执夹与「我的诉求」面板。
// 硬约束：本机只保存工单编号、公开查询码与提交时间；私密凭证 privateLookupToken
// 只停留在内存与当前页面 DOM 中用于展示，刷新即失，禁止写入任何持久化存储。
// 与小程序 changdi-intake/miniprogram/pages/mine/index.js 第 2 行的注释同口径。
export const RECEIPT_STORAGE_KEY = 'cd-bridge-receipts-v1';
export const MAX_RECEIPTS = 20;
export const CASE_NUMBER_PATTERN = /^CD-[0-9A-F]{32}$/;
export const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

// 公开查询返回的办理状态文案，与小程序 pages/public/query.js 的 STATUS_TEXT 同口径
// （只读复制，未改动小程序目录）。未知状态一律显示「状态更新中」，不得臆造进度。
export const STATUS_TEXT = {
  submitted: '已提交',
  accepted: '已受理',
  awaiting_supplement: '待补充材料',
  rejected: '不予受理',
  assigned: '已分派',
  processing: '处理中',
  awaiting_review: '待复核',
  awaiting_evaluation: '待评价',
  closed: '已办结',
  reopen_pending: '补办待审核'
};

export function statusText(status) {
  return typeof status === 'string' && Object.hasOwn(STATUS_TEXT, status) ? STATUS_TEXT[status] : '状态更新中';
}

// 校验一条本机回执，只保留工单编号、公开查询码与提交时间三个字段；形态不合格返回 null。
export function normalizeReceipt(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const caseNumber = typeof entry.caseNumber === 'string' ? entry.caseNumber.trim() : '';
  const publicLookupCode = typeof entry.publicLookupCode === 'string' ? entry.publicLookupCode.trim() : '';
  const submittedAt = typeof entry.submittedAt === 'string' ? entry.submittedAt.trim() : '';
  if (!CASE_NUMBER_PATTERN.test(caseNumber)) return null;
  if (!PUBLIC_CODE_PATTERN.test(publicLookupCode)) return null;
  const moment = Date.parse(submittedAt);
  if (!submittedAt || Number.isNaN(moment)) return null;
  return { caseNumber, publicLookupCode, submittedAt: new Date(moment).toISOString() };
}

// 解析存储内容：JSON 损坏或不是数组一律当作空；形态不合法的条目直接丢弃（防存储注入）。
export function parseReceipts(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const entries = [];
  for (const item of list) {
    const entry = normalizeReceipt(item);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, MAX_RECEIPTS);
}

// 读取本机回执：存储不可用（被禁用、抛异常）时返回 ok:false，由调用方降级为内存态。
export function readReceipts(storage) {
  if (!storage || typeof storage.getItem !== 'function') return { ok: false, entries: [] };
  let raw;
  try { raw = storage.getItem(RECEIPT_STORAGE_KEY); } catch { return { ok: false, entries: [] }; }
  return { ok: true, entries: parseReceipts(raw) };
}

// 写入一条回执：同公开查询码去重，新的在前，最多 MAX_RECEIPTS 条，超限丢最旧的。
// 写入失败（配额满、被禁用）时返回 ok:false，条目仍保留在返回的内存态里。
export function addReceipt(entry, storage, current) {
  const normalized = normalizeReceipt(entry);
  const existing = parseReceipts(current);
  if (!normalized) return { ok: false, entries: existing };
  const next = [normalized, ...existing.filter(item => item.publicLookupCode !== normalized.publicLookupCode)].slice(0, MAX_RECEIPTS);
  if (!storage || typeof storage.setItem !== 'function') return { ok: false, entries: next };
  try { storage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(next)); } catch { return { ok: false, entries: next }; }
  return { ok: true, entries: next };
}

export function formatCaseTime(value) {
  if (typeof value !== 'string' || !value) return '';
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

if (typeof document !== 'undefined') {
  (() => {
    let pending = null;
    let busy = false;
    let receipt = null;
    let memoryReceipts = [];
    let casesPanel = null;
    const formHtml = `<p class="small">诉求将提交至接诉即办。联系方式仅供授权处理人员使用。</p>
    <label class="field">发生时间<input name="occurredAt" type="datetime-local" required></label>
    <label class="field">地点<input name="location" maxlength="300" required></label>
    <label class="field">类型<input name="category" maxlength="80" required></label>
    <label class="field">问题描述<textarea name="description" maxlength="4000" required></textarea></label>
    <label class="field">建议处理部门（选填）<input name="suggestedDepartment" maxlength="100"></label>
    <label class="field">联系方式（选填）<input name="contact" maxlength="300"></label>
    <label class="field">现场照片（选填，最多 3 张，每张不超过 5 MiB）<input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>
    <p class="small">提交期间请勿关闭页面；如果结果未知，请保持页面并使用原内容重试。</p>
    <p class="small" data-bridge-status role="status"></p><button class="button primary wide" type="submit">提交诉求</button>
    <p class="small">办理效率：暂无经授权公开的数据。</p>`;

    // 本机存储可能整体不可用（禁用、无痕、配额异常），任何异常都必须静默降级为内存态。
    function safeStorage() {
      try { return window.localStorage; } catch { return null; }
    }
    function loadReceipts() {
      const result = readReceipts(safeStorage());
      if (result.ok) { memoryReceipts = result.entries; return result.entries; }
      return memoryReceipts.slice();
    }
    function saveReceipt(entry) {
      const result = addReceipt(entry, safeStorage(), loadReceipts());
      memoryReceipts = result.entries;
      return result;
    }

    function showReceipt(form) {
      form.replaceChildren();
      const heading = document.createElement('h3'); heading.textContent = '诉求已提交'; form.append(heading);
      for (const [label, value] of [['工单编号', receipt.caseNumber], ['公开查询码', receipt.publicLookupCode], ['本人私密凭证', receipt.privateLookupToken]]) {
        const p = document.createElement('p'); p.textContent = `${label}：${value}`; form.append(p);
      }
      const tip = document.createElement('p'); tip.className = 'small'; tip.textContent = '请分别妥善保存查询码和私密凭证，私密凭证不要分享。工单编号与公开查询码已保存在本机，可在下方「我的诉求」中查看办理进度；私密凭证不会保存在本机，关闭或刷新页面后不再显示。'; form.append(tip);
      if (receipt.wechatCode && ['image/png','image/jpeg'].includes(receipt.wechatCode.mediaType) && /^[A-Za-z0-9+/=]+$/.test(receipt.wechatCode.base64)) {
        const img = document.createElement('img'); img.alt = '接诉即办小程序查询码'; img.width = 180; img.src = `data:${receipt.wechatCode.mediaType};base64,${receipt.wechatCode.base64}`; form.append(img);
      }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button wide'; button.textContent = '提交另一条诉求'; button.addEventListener('click', () => { receipt = null; setup(form); }); form.append(button);
    }
    function setup(form) {
      form.dataset.bridge = 'ready';
      if (receipt) { showReceipt(form); return; }
      form.innerHTML = formHtml;
      if (pending) lock(form, '上次提交结果未知。请使用原内容重试，避免重复提交。');
    }
    function lock(form, message) {
      for (const element of form.elements) if (element.type !== 'submit') element.disabled = true;
      form.querySelector('[data-bridge-status]').textContent = message;
      form.querySelector('button[type=submit]').textContent = '按原内容重试';
    }

    // 「我的诉求」面板：只列出本机保存的工单号、提交时间，以及实时查到的真实状态与进度节点。
    // 面板永远不展示私密凭证，也不展示任何未经服务端确认的进度。
    function caseItem(entry) {
      const item = document.createElement('li');
      item.className = 'bridge-case';
      const title = document.createElement('p');
      title.className = 'bridge-case-title';
      title.textContent = `工单编号 ${entry.caseNumber}`;
      const time = document.createElement('p');
      time.className = 'small';
      time.textContent = `提交时间 ${formatCaseTime(entry.submittedAt) || '未知'}`;
      const status = document.createElement('p');
      status.className = 'small bridge-case-status';
      status.textContent = '状态：查询中…';
      const milestones = document.createElement('ol');
      milestones.className = 'bridge-case-milestones';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'button wide slim';
      refresh.textContent = '重新查询';
      refresh.addEventListener('click', () => queryCase(entry, status, milestones));
      item.append(title, time, status, milestones, refresh);
      queryCase(entry, status, milestones);
      return item;
    }

    async function queryCase(entry, status, milestones) {
      const seq = Number(status.dataset.seq || '0') + 1;
      status.dataset.seq = String(seq);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        status.textContent = '状态：离线，状态未更新';
        milestones.replaceChildren();
        return;
      }
      let result;
      try {
        const response = await fetch(`/bridge/my-cases/${encodeURIComponent(entry.publicLookupCode)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (response.status === 404) result = { kind: 'notfound' };
        else if (!response.ok) result = { kind: 'error' };
        else {
          const data = await response.json();
          result = data && typeof data.status === 'string' ? { kind: 'ok', data } : { kind: 'error' };
        }
      } catch { result = { kind: 'error' }; }
      if (status.dataset.seq !== String(seq)) return;
      milestones.replaceChildren();
      if (result.kind === 'ok') {
        status.textContent = `状态：${statusText(result.data.status)}`;
        const nodes = Array.isArray(result.data.milestones) ? result.data.milestones : [];
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const li = document.createElement('li');
          const label = statusText(node.status);
          const at = formatCaseTime(node.occurredAt);
          li.textContent = at ? `${label} · ${at}` : label;
          milestones.append(li);
        }
        if (!milestones.children.length) {
          const li = document.createElement('li');
          li.className = 'small';
          li.textContent = '暂无公开进度节点';
          milestones.append(li);
        }
      } else if (result.kind === 'notfound') {
        status.textContent = '状态：查不到该工单';
      } else {
        status.textContent = '状态：暂时查不到进度，请稍后再试';
      }
    }

    function renderCases() {
      if (!casesPanel || !casesPanel.isConnected) return;
      const list = casesPanel.querySelector('[data-bridge-case-list]');
      if (!list) return;
      const entries = loadReceipts();
      list.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('li');
        empty.className = 'small';
        empty.textContent = '本机还没有保存的诉求记录。';
        list.append(empty);
        return;
      }
      for (const entry of entries) list.append(caseItem(entry));
    }

    // 面板挂在反馈表单的同级位置（不进入表单），因此不会触发提交，也不会被原型页的
    // sheetBody 提交监听捕获；原型页重绘时由 MutationObserver 重新挂载。
    function ensureCasesPanel(form) {
      if (casesPanel && casesPanel.isConnected) return;
      const host = form.parentElement;
      if (!host) return;
      const panel = document.createElement('section');
      panel.className = 'bridge-cases';
      panel.dataset.bridgeCases = '';
      const heading = document.createElement('h3');
      heading.textContent = '我的诉求';
      const hint = document.createElement('p');
      hint.className = 'small';
      hint.textContent = '本机只保存工单编号、公开查询码与提交时间。私密凭证不保存在本机，刷新后不再显示。';
      const list = document.createElement('ul');
      list.className = 'bridge-case-list';
      list.dataset.bridgeCaseList = '';
      panel.append(heading, hint, list);
      host.append(panel);
      casesPanel = panel;
      renderCases();
    }

    function install() {
      const f = document.querySelector('form[data-form="feedback"]');
      if (!f) return;
      if (!f.dataset.bridge) setup(f);
      ensureCasesPanel(f);
    }
    new MutationObserver(install).observe(document.body, { childList:true, subtree:true });
    install();
    for (const eventName of ['input', 'change']) document.addEventListener(eventName, e => {
      if (e.target.closest('form[data-form="feedback"][data-bridge]')) e.stopPropagation();
    }, true);
    window.addEventListener('beforeunload', e => { if (pending || receipt) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('submit', async e => {
      const form = e.target;
      if (!form.matches('form[data-form="feedback"][data-bridge]')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (busy) return;
      const status = form.querySelector('[data-bridge-status]');
      if (!pending) {
        const data = new FormData(form);
        const files = data.getAll('photos').filter(x => x.size);
        if (files.length > 3 || files.some(x => x.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(x.type))) { status.textContent = '请选择最多 3 张 JPEG、PNG 或 WebP 图片，每张不超过 5 MiB。'; return; }
        const time = new Date(data.get('occurredAt'));
        if (!Number.isFinite(time.valueOf())) { status.textContent = '请填写有效的发生时间。'; return; }
        const payload = { externalCaseId: crypto.randomUUID(), occurredAt: time.toISOString() };
        for (const key of ['location','category','description','suggestedDepartment','contact']) { const value = String(data.get(key) || '').trim(); if (value) payload[key] = value; }
        if (!payload.location || !payload.category || !payload.description) { status.textContent = '请填写地点、类型和问题描述。'; return; }
        pending = { payload, files };
      }
      busy = true; lock(form, '正在提交，请稍候。'); form.querySelector('button[type=submit]').disabled = true;
      const body = new FormData(); body.append('payload', JSON.stringify(pending.payload)); for (const file of pending.files) body.append('photos', file, file.name);
      try {
        const response = await fetch('/bridge/submit', {method:'POST', body, signal:AbortSignal.timeout(25000)});
        const result = await response.json();
        if (response.ok && /^CD-[0-9A-F]{32}$/.test(result.caseNumber) && /^[A-Za-z0-9_-]{24}$/.test(result.publicLookupCode) && /^[A-Za-z0-9_-]{43}$/.test(result.privateLookupToken)) {
          receipt = result; pending = null;
          // 本机只留工单号、公开查询码与提交时间；私密凭证只留在内存里。
          saveReceipt({ caseNumber: result.caseNumber, publicLookupCode: result.publicLookupCode, submittedAt: new Date().toISOString() });
          showReceipt(form);
          renderCases();
        }
        else if ([400,413,415].includes(response.status)) { pending = null; setup(form); form.querySelector('[data-bridge-status]').textContent = '提交未被受理，请检查填写内容和照片后重新填写。'; }
        else lock(form, '提交结果尚未确认，请按原内容重试；如持续失败，请联系工作人员，勿重复新建。');
      } catch { lock(form, '连接中断或超时，提交结果未知。请按原内容重试，勿重复新建。'); }
      finally {
        busy = false;
        const current = document.querySelector('form[data-form="feedback"][data-bridge]');
        if (current && current !== form) {
          if (receipt) showReceipt(current);
          else if (pending) lock(current, '上次提交结果未知，请按原内容重试。');
          else { setup(current); current.querySelector('[data-bridge-status]').textContent = '提交未被受理，请检查填写内容和照片后重新填写。'; }
        }
        const button = (current || form).querySelector('button[type=submit]'); if (button) button.disabled = false;
      }
    }, true);
  })();
}

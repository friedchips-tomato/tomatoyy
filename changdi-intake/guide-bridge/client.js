(() => {
  let pending = null;
  let busy = false;
  let receipt = null;
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

  function showReceipt(form) {
    form.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = '诉求已提交'; form.append(heading);
    for (const [label, value] of [['工单编号', receipt.caseNumber], ['公开查询码', receipt.publicLookupCode], ['本人私密凭证', receipt.privateLookupToken]]) {
      const p = document.createElement('p'); p.textContent = `${label}：${value}`; form.append(p);
    }
    const tip = document.createElement('p'); tip.className = 'small'; tip.textContent = '请分别妥善保存查询码和私密凭证，私密凭证不要分享。进入接诉即办小程序查询；本人核验后可查看反馈、评价或申请补充处理。关闭或刷新页面后此凭证不会保留。'; form.append(tip);
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
  function install() { const f = document.querySelector('form[data-form="feedback"]'); if (f && !f.dataset.bridge) setup(f); }
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
      if (response.ok && /^CD-[0-9A-F]{32}$/.test(result.caseNumber) && /^[A-Za-z0-9_-]{24}$/.test(result.publicLookupCode) && /^[A-Za-z0-9_-]{43}$/.test(result.privateLookupToken)) { receipt = result; pending = null; showReceipt(form); }
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

const { CASE_NUMBER_PATTERN, receiptView, requestExtra, fetchClaimPhoto, timeLabel } = require('./merchant');

const actions = {
  evaluate: '提交三维评价',
  confirm_resolved: '确认已解决',
  request_reopen: '申请补办'
};
const ratingFields = ['speed', 'effectiveness', 'attitude'];
const metricNames = {
  firstResponse: '首次有效响应覆盖',
  firstResponseDuration: '中位首响时长',
  completion: '受理工单完成率',
  duplicateComplaints: '重复投诉占比',
  satisfaction: '三维满意度均分'
};
const percentageBands = ['0%–不足 25%', '25%–不足 50%', '50%–不足 75%', '75%–100%'];
const ratingBands = ['1–不足 2 分', '2–不足 3 分', '3–不足 4 分', '4–5 分'];
const durationBands = ['不超过 1 小时', '超过 1 小时且不超过 24 小时', '超过 24 小时'];
const list = value => Array.isArray(value) ? value : [];

const emptyExtra = () => ({
  caseReceipt: null, receiptBusy: false, receiptError: '',
  receiptLookup: '',
  claimant: null, claimForm: null, extraCase: '', extraBusy: false, extraError: '', claimRefresh: false,
  claimPhotoPath: '', claimPhotoBusy: false, claimPhotoError: '',
  reportMonth: '', reportMaxMonth: '', reportRows: null, ratings: [1, 2, 3, 4, 5]
});

function previousMonth(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function reportView(value, month) {
  if (value?.month !== month || !value.metrics) return null;
  return Object.entries(metricNames).map(([key, label]) => {
    const metric = value.metrics[key];
    const bands = key === 'firstResponseDuration' ? durationBands : key === 'satisfaction' ? ratingBands : percentageBands;
    if (key === 'firstResponseDuration' && metric === undefined) return { label, value: '原冻结快照未发布时长' };
    const text = metric?.status === 'available' && Number.isInteger(metric.band) ? bands[metric.band]
      : metric?.status === 'unavailable' ? '缺少已启用的数据来源' : '未达到公开条件';
    return { label, value: text || '未达到公开条件' };
  });
}

function claimantView(value, number) {
  if (!value || value.caseNumber !== number || !Number.isSafeInteger(value.version) || value.version < 1) return null;
  return {
    caseNumber: number, version: value.version, round: value.round,
    evaluationDeadline: timeLabel(value.evaluationEndsAt), reopenDeadline: timeLabel(value.reopenEndsAt),
    actions: list(value.availableActions).filter(action => Object.hasOwn(actions, action))
      .map(id => ({ id, label: actions[id] })),
    rounds: list(value.rounds).filter(item => item?.feedback || item?.evaluation).map(item => ({
      round: item.round,
      summary: item.feedback?.summary || '',
      photos: list(item.feedback?.photos).filter(photo => photo?.mediaType === 'image/png' &&
        Number.isSafeInteger(photo.publishVersion) && photo.publishVersion >= 1 &&
        Number.isInteger(photo.position) && photo.position >= 0 && photo.position <= 2 &&
        Number.isInteger(photo.size) && photo.size > 0 && photo.size <= 5 * 1024 * 1024)
        .map(({ publishVersion, position, size, mediaType }) => ({
          key: publishVersion + '/' + position, publishVersion, position, size, mediaType
        })),
      evaluation: item.evaluation ? ratingFields.map(field => item.evaluation[field]).join(' / ') : ''
    })),
    reopen: list(value.reopenRequests).filter(Boolean).map((item, index) => ({
      id: index, reason: item.reason, status: item.decision === 'approved' ? '已通过'
        : item.decision === 'rejected' ? '已驳回' : '待审核',
      decisionReason: item.decisionReason || ''
    }))
  };
}

const methods = {
  resetExtra() {
    this._extraRequest++;
    this._receiptArtwork.clear('caseReceipt');
    this.setData(emptyExtra());
  },

  clearReceiptImage(slot) {
    this._receiptArtwork.clear(slot);
    const receipt = this.data[slot];
    if (receipt?.qrSource) this.setData({ [slot]: { ...receipt, qrSource: '', qrRevision: null } });
  },

  async extraRequest(path, input, apply, failure) {
    const session = this._session;
    const sequence = ++this._extraRequest;
    const result = await requestExtra(this.apiOptions(), path, input);
    if (!this.active(session) || sequence !== this._extraRequest) return;
    if (result.kind === 'unauthorized' || result.kind === 'forbidden') return this.clearSession(result.message);
    if (result.kind === 'success') return apply(result.value);
    return failure(result.kind);
  },

  onReadCaseReceipt() {
    const { activeCase, caseDetail, receiptBusy } = this.data;
    if (this.data.view !== 'case' || !this.can('readCases') || !caseDetail || receiptBusy ||
        !CASE_NUMBER_PATTERN.test(activeCase)) return;
    this.clearReceiptImage('caseReceipt');
    this.setData({ receiptBusy: true, receiptError: '' });
    return this.extraRequest('cases/' + activeCase + '/receipt', undefined, value => {
      const receipt = receiptView(value);
      const match = receipt?.caseNumber === activeCase;
      if (match) this.setData({ caseReceipt: this._receiptArtwork.present('caseReceipt', receipt, value.wechatCode) });
      this.setData({ receiptBusy: false, receiptError: match ? '' : '回执读取失败。' });
    }, kind => this.setData({
      ...(kind === 'notfound' ? { caseReceipt: null } : {}),
      receiptBusy: false, receiptError: kind === 'notfound' ? '当前账号无法读取这张工单的本人回执。' : '回执读取失败，请重试。'
    }));
  },

  onReceiptLookupInput(event) {
    if (this.data.view === 'workbench' && !this.data.receiptBusy) this.setData({ receiptLookup: event.detail.value });
  },

  onFindReceipt() {
    if (this.data.view !== 'workbench' || this.data.receiptBusy || this.data.submitBusy ||
        !(this.can('readCases') || this.can('submitCases'))) return;
    const number = this.data.receiptLookup.trim();
    if (!CASE_NUMBER_PATTERN.test(number)) return this.setData({ receiptError: '请输入完整的工单号。' });
    this.clearReceiptImage('submitReceipt');
    if (this.data.submitReceipt?.caseNumber !== number) this.setData({ submitReceipt: null });
    this.setData({ receiptBusy: true, receiptError: '' });
    return this.extraRequest('cases/' + number + '/receipt', undefined, value => {
      const receipt = receiptView(value);
      const match = receipt?.caseNumber === number;
      if (match) this.setData({ submitReceipt: this._receiptArtwork.present('submitReceipt', receipt, value.wechatCode) });
      this.setData({ receiptLookup: '', receiptBusy: false,
        receiptError: match ? '' : '回执读取失败。' });
    }, kind => this.setData({ receiptBusy: false, ...(kind === 'notfound' ? { submitReceipt: null } : {}),
      receiptError: kind === 'notfound' ? '当前账号无法读取这张工单的本人回执。' : '回执读取失败，请重试。' }));
  },

  onOpenPublicReceipt(event) {
    const receipt = this.data.view === 'case' ? this.data.caseReceipt :
      this.data.view === 'workbench' ? this.data.submitReceipt : null;
    const code = event.currentTarget.dataset.code;
    if (!this.data.receiptBusy && receipt?.publicLookupCode === code && typeof code === 'string' && /^[A-Za-z0-9_-]{24}$/.test(code)) {
      this.clearReceiptImage(this.data.view === 'case' ? 'caseReceipt' : 'submitReceipt');
      wx.navigateTo({ url: '/pages/public/index?code=' + encodeURIComponent(code) });
    }
  },

  onReceiptImageError(event) {
    this.onClearReceiptImage(event);
  },

  onClearReceiptImage(event) {
    const { receipt: slot, revision } = event.currentTarget.dataset;
    if (!['caseReceipt', 'submitReceipt'].includes(slot) || !this.data[slot]?.qrSource ||
        this.data[slot].qrRevision !== revision) return;
    this.clearReceiptImage(slot);
  },

  onOpenClaimant(event) {
    const source = this.data.view === 'case' ? this.data.caseReceipt :
      this.data.view === 'workbench' ? this.data.submitReceipt : null;
    const number = event.currentTarget.dataset.case;
    if (this.data.receiptBusy || this.data.submitBusy || source?.caseNumber !== number || !CASE_NUMBER_PATTERN.test(number)) return;
    this.clearReceiptImage(this.data.view === 'case' ? 'caseReceipt' : 'submitReceipt');
    this._claimFrom = this.data.view;
    this.setData({ view: 'claimant', extraCase: number });
    return this.onReadClaimant();
  },

  onCloseClaimant() {
    if (this.data.view !== 'claimant' || this.data.extraBusy) return;
    this._extraRequest++;
    this.onCloseClaimPhoto();
    this.setData({ view: this._claimFrom, claimant: null, claimForm: null, extraCase: '', extraError: '', claimRefresh: false });
    this._claimFrom = '';
  },

  onReadClaimant() {
    if (this.data.view !== 'claimant' || this.data.extraBusy || !CASE_NUMBER_PATTERN.test(this.data.extraCase)) return;
    return this.readClaimant();
  },

  readClaimant(input) {
    const number = this.data.extraCase;
    this.onCloseClaimPhoto();
    this.setData({ extraBusy: true, extraError: '' });
    return this.extraRequest('cases/' + number + '/claimant' + (input ? '/actions' : ''), input, value => {
      const detail = claimantView(value, number);
      this.setData({ claimant: detail, claimForm: null, extraBusy: false, claimRefresh: !detail,
        extraError: detail ? '' : '本人办理状态无法识别，请重新读取。' });
    }, kind => {
      const inaccessible = kind === 'notfound';
      if (inaccessible) this._receiptArtwork.clearAll();
      this.setData({
        extraBusy: false, claimRefresh: true,
        ...(inaccessible ? { claimant: null, claimForm: null, submitReceipt: null, caseReceipt: null } : {}),
        extraError: inaccessible ? '当前账号无法操作这张工单。' : '请重新读取工单并核对结果。'
      });
    });
  },

  onCloseClaimPhoto() {
    this._previewRequest++;
    this._previewFiles.clear();
    this.setData({ claimPhotoPath: '', claimPhotoBusy: false, claimPhotoError: '' });
  },

  async onPreviewClaimPhoto(event) {
    const { extraCase, claimant, extraBusy } = this.data;
    if (this.data.view !== 'claimant' || !claimant || extraBusy) return;
    const key = event.currentTarget.dataset.photo;
    const photo = claimant.rounds.flatMap(round => round.photos).find(item => item.key === key);
    if (!photo) return;
    this.onCloseClaimPhoto();
    const session = this._session;
    const sequence = this._previewRequest;
    this.setData({ claimPhotoBusy: true });
    const result = await fetchClaimPhoto(this.apiOptions(), extraCase, photo);
    if (!this.active(session) || sequence !== this._previewRequest || this.data.extraCase !== extraCase) return;
    if (result.kind === 'unauthorized' || result.kind === 'forbidden') return this.clearSession(result.message);
    try {
      if (result.kind !== 'success') throw new Error('Image unavailable');
      this.setData({ claimPhotoPath: this._previewFiles.write(result.bytes, photo, result.header), claimPhotoBusy: false });
    } catch {
      this.setData({ claimPhotoBusy: false, claimPhotoError: '反馈图片读取失败。' });
    }
  },

  onChooseClaimAction(event) {
    const action = event.currentTarget.dataset.action;
    const { claimant, extraBusy, claimRefresh } = this.data;
    if (this.data.view !== 'claimant' || extraBusy || claimRefresh || !claimant?.actions.some(item => item.id === action)) return;
    this.setData({ claimForm: { action, label: actions[action], reason: '' }, extraError: '' });
  },

  onClaimInput(event) {
    const { field } = event.currentTarget.dataset;
    const { claimForm, extraBusy, claimRefresh } = this.data;
    if (!claimForm || extraBusy || claimRefresh || ![...ratingFields, 'reason'].includes(field)) return;
    const value = field === 'reason' ? event.detail.value : Number(event.detail.value) + 1;
    this.setData({ claimForm: { ...claimForm, [field]: value } });
  },

  onSaveClaimAction() {
    const { claimant, claimForm, extraBusy, claimRefresh } = this.data;
    if (this.data.view !== 'claimant' || !claimForm || extraBusy || claimRefresh ||
        !claimant?.actions.some(item => item.id === claimForm.action)) return;
    const { action, reason } = claimForm;
    const input = { action, expectedVersion: claimant.version };
    if (action === 'evaluate') {
      if (!ratingFields.every(field => Number.isInteger(claimForm[field]) && claimForm[field] >= 1 && claimForm[field] <= 5)) {
        return this.setData({ extraError: '请选择三个维度的评分。' });
      }
      for (const field of ratingFields) input[field] = claimForm[field];
    }
    if (action === 'request_reopen') {
      if (!reason.trim() || Array.from(reason).length > 1000) return this.setData({ extraError: '请填写补办理由。' });
      input.reason = reason.trim();
    }
    return this.readClaimant(input);
  },

  onOpenRepresentativeReport() {
    if (this.data.view !== 'workbench' || !this.can('representativeReport') || this.data.submitBusy || this.data.receiptBusy) return;
    const month = previousMonth();
    this._receiptArtwork.clear('submitReceipt');
    this.setData({ view: 'representativeReport', reportMaxMonth: month, submitReceipt: null });
    return this.loadRepresentativeMonth(month);
  },

  onCloseRepresentativeReport() {
    if (this.data.view !== 'representativeReport') return;
    this.resetExtra();
    this.setData({ view: 'workbench' });
  },

  onRepresentativeMonthChange(event) {
    return this.loadRepresentativeMonth(event.detail.value);
  },

  loadRepresentativeMonth(value) {
    if (this.data.view !== 'representativeReport' || !this.can('representativeReport')) return;
    const month = /^\d{4}-(0[1-9]|1[0-2])(-01)?$/.test(value) ? value.slice(0, 7) : '';
    if (!month || month > this.data.reportMaxMonth) return;
    this.setData({ reportMonth: month, reportRows: null, extraBusy: true, extraError: '' });
    return this.extraRequest('representative-report?month=' + month, undefined, data => {
      const rows = reportView(data, month);
      this.setData({ reportRows: rows, extraBusy: false, extraError: rows ? '' : '月报数据无法识别。' });
    }, kind => this.setData({ extraBusy: false,
      extraError: kind === 'notfound' ? '该月暂未发布代表月报。' : '读取失败，请重新选择月份。' }));
  }
};

module.exports = { emptyExtra, methods, reportView, previousMonth };

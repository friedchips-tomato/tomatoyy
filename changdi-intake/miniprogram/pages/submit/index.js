const config = require('../../config.js');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const { choosePhotos, photoMessage } = require('../staff/photos');
const { addReceipt } = require('../mine/receipts');
const {
  normalizeWechatCode,
  writeReceiptCodeFile,
  removeReceiptCodeFile,
  cleanupReceiptCodeFiles
} = require('./receipt-code.js');
const {
  CATEGORY_OPTIONS,
  MAX_PHOTOS,
  newClientRequestId,
  occurredAtText,
  validateSubmission,
  submitCase,
  progressUrl
} = require('./submit.js');

const categoryPlaceholder = '请选择问题类别';

// 当前北京时间的日期与时刻，作为发生时间的默认值。
function nowBeijing() {
  const shifted = new Date(Date.now() + 8 * 3600000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function initialData() {
  const now = nowBeijing();
  return {
    view: 'form',
    categoryOptions: CATEGORY_OPTIONS,
    categoryIndex: -1,
    categoryText: categoryPlaceholder,
    formDate: now.date,
    formTime: now.time,
    formLocation: '',
    formDescription: '',
    formDescriptionLength: 0,
    formContact: '',
    formSuggestedDepartment: '',
    formSuggestedDepartmentLength: 0,
    photoCount: 0,
    photoChoosing: false,
    submitBusy: false,
    submitMessage: '',
    // 结果未知时锁定表单：重试必须沿用原请求号与原内容，避免与服务端去重键冲突。
    formLocked: false,
    lockNotice: '',
    requestId: '',
    errors: {},
    receipt: null,
    // 微信小程序查询码：ready 可展示，unavailable 只展示公开码与提示。
    receiptCodeState: 'none',
    receiptCodePath: '',
    receiptCodeMessage: '',
    copyMessage: ''
  };
}

Page({
  data: initialData(),

  onLoad() {
    this._alive = true;
    this._seq = 0;
    this._photoSeq = 0;
    this._requestSeq = 0;
    // 本次表单的请求号。同一表单的所有重试沿用它，成功建单后为新表单重新生成。
    this._clientRequestId = newClientRequestId(this._requestSeq);
    // 已选但尚未发送的照片，只有本机临时文件路径。
    this._pickedFiles = [];
    // 提交快照：一次提交的原请求号、正文与照片。结果未知时按它原样重试。
    // 快照只在页面内存里，不写存储、不落盘。
    this._snapshot = null;
    // 私密查询凭证只放在页面内存里，不写存储、不进网址、不进日志。
    this._receiptToken = '';
    // 本机查询码图片路径，退出本页时释放。
    this._receiptCodePath = '';
    // 清理上一次会话遗留的查询码图片。
    cleanupReceiptCodeFiles();
    this.setData({ ...initialData(), requestId: this._clientRequestId });
  },

  onUnload() {
    this._alive = false;
    this._seq += 1;
    this._photoSeq += 1;
    this._pickedFiles = [];
    this._receiptToken = '';
    this._snapshot = null;
    this.releaseReceiptCode();
  },

  // 去掉某个字段的提示，其余提示保持不变。
  clearError(field) {
    const errors = { ...this.data.errors };
    if (!Object.prototype.hasOwnProperty.call(errors, field)) return;
    delete errors[field];
    this.setData({ errors });
  },

  // 表单锁定时不接受改动：结果未知期间内容必须保持原样。
  editable() {
    return !this.data.submitBusy && !this.data.formLocked;
  },

  onDateChange(event) {
    if (!this.editable()) return;
    this.setData({ formDate: event.detail.value });
    this.clearError('occurredAt');
  },

  onTimeChange(event) {
    if (!this.editable()) return;
    this.setData({ formTime: event.detail.value });
    this.clearError('occurredAt');
  },

  onLocationInput(event) {
    if (!this.editable()) return;
    this.setData({ formLocation: event.detail.value });
    this.clearError('location');
  },

  onCategoryChange(event) {
    if (!this.editable()) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || !CATEGORY_OPTIONS[index]) return;
    this.setData({ categoryIndex: index, categoryText: CATEGORY_OPTIONS[index].label });
    this.clearError('category');
  },

  onDescriptionInput(event) {
    if (!this.editable()) return;
    const value = typeof event.detail.value === 'string' ? event.detail.value : '';
    this.setData({ formDescription: value, formDescriptionLength: Array.from(value).length });
    this.clearError('description');
  },

  onContactInput(event) {
    if (!this.editable()) return;
    this.setData({ formContact: event.detail.value });
    this.clearError('contact');
  },

  // 建议处理部门：选填，只作为管理方分派的参考。
  onSuggestedDepartmentInput(event) {
    if (!this.editable()) return;
    const value = typeof event.detail.value === 'string' ? event.detail.value : '';
    this.setData({ formSuggestedDepartment: value, formSuggestedDepartmentLength: Array.from(value).length });
    this.clearError('suggestedDepartment');
  },

  // 选择可选照片。只读取本机临时文件，不访问任何网址。
  async onChoosePhotos() {
    if (!this.editable() || this.data.photoChoosing) return;
    const seq = ++this._photoSeq;
    this.setData({ photoChoosing: true, submitMessage: '' });
    try {
      const files = await choosePhotos(false);
      if (!this._alive || seq !== this._photoSeq) return;
      this.setData({ photoChoosing: false });
      if (!files) return;
      this._pickedFiles = files.slice(0, MAX_PHOTOS);
      this.setData({ photoCount: this._pickedFiles.length });
    } catch (error) {
      if (!this._alive || seq !== this._photoSeq) return;
      this.setData({ photoChoosing: false, submitMessage: photoMessage(error) });
    }
  },

  onClearPhotos() {
    if (!this.editable() || this.data.photoChoosing) return;
    this._pickedFiles = [];
    this.setData({ photoCount: 0, submitMessage: '' });
  },

  // 提交一条游客诉求。照片可选，与正文一次提交。
  async onSubmit() {
    // 提交期间锁定，避免双击发出两次请求。
    if (this.data.submitBusy) return;
    // 选照片进行中先不提交，避免发出的照片与页面上看到的不一致。
    if (this.data.photoChoosing) {
      this.setData({ submitMessage: '照片选择中，请等照片选好后再提交。' });
      return;
    }
    const { origin } = apiEnvironment();
    if (!origin) {
      this.setData({ submitMessage: '服务地址无效，无法提交诉求，请稍后再试。' });
      return;
    }
    let payload = null;
    let files = null;
    let prepared = null;
    if (this._snapshot) {
      // 结果未知后的重试：原样沿用快照里的请求号、正文与照片。
      // 即便期间表单被改动，也不改内容换号重发，避免与服务端冲突（409）。
      // 已经发出过的请求体直接复用，本机照片临时路径失效也不影响这次重试。
      payload = this._snapshot.payload;
      files = this._snapshot.files;
      prepared = this._snapshot.body || null;
    } else {
      const category = this.data.categoryIndex >= 0 && CATEGORY_OPTIONS[this.data.categoryIndex]
        ? CATEGORY_OPTIONS[this.data.categoryIndex].value
        : '';
      const checked = validateSubmission({
        clientRequestId: this._clientRequestId,
        occurredAt: occurredAtText(this.data.formDate, this.data.formTime),
        location: this.data.formLocation,
        category,
        description: this.data.formDescription,
        suggestedDepartment: this.data.formSuggestedDepartment,
        contact: this.data.formContact
      });
      if (Object.keys(checked.errors).length) {
        // 字段级问题就地提示，输入内容全部保留。
        this.setData({ errors: checked.errors, submitMessage: '请补全必填项后再提交。' });
        return;
      }
      payload = checked.payload;
      files = this._pickedFiles.slice();
      // 记下这次提交的原样快照，供结果未知后的重试使用。只在内存里，不落盘。
      // body 存的是已经发出的 multipart 字节，大小受既有的三张照片限额约束。
      this._snapshot = { payload, files, body: null, unknown: false };
    }
    this.setData({ submitBusy: true, submitMessage: '', errors: {} });
    const seq = ++this._seq;
    const result = await submitCase({
      request: options => requestConfigured(options),
      baseUrl: origin,
      payload,
      files,
      prepared,
      timeout: config.requestTimeout,
      isCurrent: () => this._alive && seq === this._seq
    });
    if (!this._alive || seq !== this._seq) return;
    this.applyResult(result);
  },

  // 处理一次提交结果。任何失败都保留表单内容与请求号，重试沿用同一请求。
  applyResult(result) {
    // 结果未知：服务端可能已经建单。记下已发出的请求体，下次按原字节重试。
    if (result.unknown && this._snapshot) {
      this._snapshot.unknown = true;
      if (result.body) this._snapshot.body = result.body;
    }
    if (result.kind === 'success') {
      this._pickedFiles = [];
      // 建单成功：释放快照与已发出的字节。
      this._snapshot = null;
      // 成功建单后为新表单重新生成请求号。
      this._requestSeq += 1;
      this._clientRequestId = newClientRequestId(this._requestSeq);
      this._receiptToken = result.receipt.privateLookupToken;
      this.setData({
        view: 'receipt',
        submitBusy: false,
        submitMessage: '',
        errors: {},
        photoCount: 0,
        formLocked: false,
        lockNotice: '',
        requestId: this._clientRequestId,
        copyMessage: '',
        receipt: {
          caseNumber: result.receipt.caseNumber,
          publicLookupCode: result.receipt.publicLookupCode,
          privateLookupToken: this._receiptToken
        }
      });
      // 回执里带了微信小程序查询码就展示，没带或不合规就降级为只显示公开码。
      this.showReceiptCode(result.receipt.wechatCode, result.receipt.publicLookupCode);
      // 建单成功后把工单编号与公开查询码存进本机回执夹。
      // 私密查询凭证不写入存储，保存失败不影响回执展示，只给一条轻提示。
      const saved = addReceipt(
        result.receipt.caseNumber,
        result.receipt.publicLookupCode,
        new Date().toISOString()
      );
      if (!saved.ok) {
        this.setData({ submitMessage: '本机记录保存失败，请自行保存回执。' });
      }
      return;
    }
    if (result.kind === 'cancelled') {
      this.setData({ submitBusy: false });
      return;
    }
    // 本地校验或制包失败：请求没有发出。若此前有过结果未知的提交，不能当作明确拒绝解锁，
    // 否则用户改了内容又用旧请求号重发，服务端会因内容不一致返回冲突。
    if (result.kind === 'invalid' && result.local && this._snapshot && this._snapshot.unknown) {
      this.setData({
        submitBusy: false,
        submitMessage: result.message || '本次重试没能发出请求，请稍后重试。',
        formLocked: true,
        lockNotice: '本次重试没能发出请求：' + (result.message || '本机照片可能已失效。') +
          '请再提交一次；若照片已失效，请放弃本次提交后重新选择照片再提交。'
      });
      return;
    }
    // 明确被拒且服务端没有建单：解锁表单，用户改正后可以重新提交。
    if (result.kind === 'invalid' || result.kind === 'limited') {
      this._snapshot = null;
      this.setData({
        submitBusy: false,
        submitMessage: result.message || '提交未完成，请稍后重试。',
        formLocked: false,
        lockNotice: '',
        ...(result.errors ? { errors: result.errors } : {})
      });
      return;
    }
    // 结果未知（超时、断网、服务端异常）或与服务端已有记录冲突：
    // 锁定表单并保留快照，重试原样重发，避免因改动内容造成 409。
    this.setData({
      submitBusy: false,
      submitMessage: result.message || '提交未完成，请稍后重试。',
      formLocked: true,
      lockNotice: result.kind === 'conflict'
        ? '本次内容与服务端已有记录不一致，未写入。请先用回执查询确认是否已提交；如需重新提交，请放弃本次提交后重填。'
        : '结果未知：请直接再次提交，重试沿用原请求号与原内容（照片按已发出的字节原样重发）。' +
          '本机照片临时文件离开本页后不可恢复，如需修改内容请放弃本次提交后重填。',
      ...(result.errors ? { errors: result.errors } : {})
    });
  },

  // 放弃本次提交：作废当前请求号与快照，重新填写会按新内容建单。
  onAbandonSubmission() {
    if (this.data.submitBusy) return;
    wx.showModal({
      title: '放弃本次提交',
      content: '放弃后当前请求号作废，重新提交会按当前内容建单，可能与服务端已存在的诉求重复。确认放弃？',
      confirmText: '放弃',
      cancelText: '继续重试',
      success: result => {
        if (!result || !result.confirm) return;
        // 保留已填内容，用户改一改就能重新提交。
        this.resetForm(true);
      }
    });
  },

  // 清空表单并换一个新的请求号，开始一次全新的申报。
  // keepContent 为真时保留已填内容与照片，只作废请求号与快照。
  resetForm(keepContent = false) {
    if (!keepContent) {
      this._pickedFiles = [];
    }
    this._snapshot = null;
    this._receiptToken = '';
    this._requestSeq += 1;
    this._clientRequestId = newClientRequestId(this._requestSeq);
    this.releaseReceiptCode();
    const patch = {
      view: 'form',
      receipt: null,
      submitBusy: false,
      submitMessage: '',
      errors: {},
      photoCount: this._pickedFiles.length,
      formLocked: false,
      lockNotice: '',
      receiptCodeState: 'none',
      receiptCodePath: '',
      receiptCodeMessage: '',
      copyMessage: '',
      requestId: this._clientRequestId
    };
    if (!keepContent) {
      Object.assign(patch, {
        formLocation: '',
        formDescription: '',
        formDescriptionLength: 0,
        formContact: '',
        formSuggestedDepartment: '',
        formSuggestedDepartmentLength: 0,
        categoryIndex: -1,
        categoryText: categoryPlaceholder
      });
    }
    this.setData(patch);
  },

  // 展示回执里的微信小程序查询码。缺失或不合规时降级为只显示公开码与提示。
  showReceiptCode(wechatCode, publicLookupCode) {
    const normalized = normalizeWechatCode(wechatCode);
    if (!normalized) {
      this.setData({
        receiptCodeState: 'unavailable',
        receiptCodePath: '',
        receiptCodeMessage: '本次回执未附带可用的微信小程序查询码，可复制公开查询码后手动查询。'
      });
      return;
    }
    try {
      const path = writeReceiptCodeFile({
        publicLookupCode,
        mediaType: normalized.mediaType,
        bytes: normalized.bytes
      });
      this._receiptCodePath = path;
      this.setData({ receiptCodeState: 'ready', receiptCodePath: path, receiptCodeMessage: '' });
    } catch (error) {
      this.setData({
        receiptCodeState: 'unavailable',
        receiptCodePath: '',
        receiptCodeMessage: '查询码图片写入失败，可复制公开查询码后手动查询。'
      });
    }
  },

  // 释放本机的查询码图片。只删本模块写出的那一张。
  releaseReceiptCode() {
    const path = this._receiptCodePath;
    this._receiptCodePath = '';
    if (!path) return;
    removeReceiptCodeFile(path);
    if (this._alive && this.data.receiptCodePath === path) {
      this.setData({ receiptCodePath: '', receiptCodeState: 'none' });
    }
  },

  // 查询码图片加载失败：释放临时文件并降级为只显示公开码。
  onReceiptCodeError() {
    this.releaseReceiptCode();
    this.setData({
      receiptCodeState: 'unavailable',
      receiptCodePath: '',
      receiptCodeMessage: '查询码图片无法显示，可复制公开查询码后手动查询。'
    });
  },

  // 复制公开查询码。只复制公开码，私密凭证不复制、不外传。
  onCopyPublicCode() {
    const receipt = this.data.receipt;
    if (!receipt || !receipt.publicLookupCode) return;
    const api = typeof wx === 'undefined' ? null : wx;
    if (!api || typeof api.setClipboardData !== 'function') {
      this.setData({ copyMessage: '当前环境不支持复制，请手动记下公开查询码。' });
      return;
    }
    api.setClipboardData({
      data: receipt.publicLookupCode,
      success: () => this.setData({ copyMessage: '公开查询码已复制，可粘贴保存。' }),
      fail: () => this.setData({ copyMessage: '复制失败，请手动记下公开查询码。' })
    });
  },

  // 查看进度。网址只带公开查询码，不带私密凭证。
  onViewProgress() {
    const receipt = this.data.receipt;
    if (!receipt) return;
    const url = progressUrl(receipt.publicLookupCode);
    if (!url) {
      this.setData({ submitMessage: '回执中的公开查询码格式异常，请保存工单编号后联系管理方查询。' });
      return;
    }
    wx.navigateTo({ url });
  },

  // 再提交一条：重置表单并开始一次新的申报，沿用成功建单后生成的新请求号。
  onNewSubmission() {
    if (this.data.submitBusy) return;
    this.resetForm();
  }
});

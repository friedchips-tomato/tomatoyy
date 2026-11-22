const config = require('../../config.js');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const { choosePhotos, photoMessage } = require('../staff/photos');
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
    photoCount: 0,
    photoChoosing: false,
    submitBusy: false,
    submitMessage: '',
    requestId: '',
    errors: {},
    receipt: null
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
    // 私密查询凭证只放在页面内存里，不写存储、不进网址、不进日志。
    this._receiptToken = '';
    this.setData({ ...initialData(), requestId: this._clientRequestId });
  },

  onUnload() {
    this._alive = false;
    this._seq += 1;
    this._photoSeq += 1;
    this._pickedFiles = [];
    this._receiptToken = '';
  },

  // 去掉某个字段的提示，其余提示保持不变。
  clearError(field) {
    const errors = { ...this.data.errors };
    if (!Object.prototype.hasOwnProperty.call(errors, field)) return;
    delete errors[field];
    this.setData({ errors });
  },

  onDateChange(event) {
    if (this.data.submitBusy) return;
    this.setData({ formDate: event.detail.value });
    this.clearError('occurredAt');
  },

  onTimeChange(event) {
    if (this.data.submitBusy) return;
    this.setData({ formTime: event.detail.value });
    this.clearError('occurredAt');
  },

  onLocationInput(event) {
    if (this.data.submitBusy) return;
    this.setData({ formLocation: event.detail.value });
    this.clearError('location');
  },

  onCategoryChange(event) {
    if (this.data.submitBusy) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || !CATEGORY_OPTIONS[index]) return;
    this.setData({ categoryIndex: index, categoryText: CATEGORY_OPTIONS[index].label });
    this.clearError('category');
  },

  onDescriptionInput(event) {
    if (this.data.submitBusy) return;
    const value = typeof event.detail.value === 'string' ? event.detail.value : '';
    this.setData({ formDescription: value, formDescriptionLength: Array.from(value).length });
    this.clearError('description');
  },

  onContactInput(event) {
    if (this.data.submitBusy) return;
    this.setData({ formContact: event.detail.value });
    this.clearError('contact');
  },

  // 选择可选照片。只读取本机临时文件，不访问任何网址。
  async onChoosePhotos() {
    if (this.data.submitBusy || this.data.photoChoosing) return;
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
    if (this.data.submitBusy || this.data.photoChoosing) return;
    this._pickedFiles = [];
    this.setData({ photoCount: 0, submitMessage: '' });
  },

  // 提交一条游客诉求。照片可选，与正文一次提交。
  async onSubmit() {
    // 提交期间锁定，避免双击发出两次请求。
    if (this.data.submitBusy) return;
    const { origin } = apiEnvironment();
    if (!origin) {
      this.setData({ submitMessage: '服务地址无效，无法提交诉求，请稍后再试。' });
      return;
    }
    const category = this.data.categoryIndex >= 0 && CATEGORY_OPTIONS[this.data.categoryIndex]
      ? CATEGORY_OPTIONS[this.data.categoryIndex].value
      : '';
    const checked = validateSubmission({
      clientRequestId: this._clientRequestId,
      occurredAt: occurredAtText(this.data.formDate, this.data.formTime),
      location: this.data.formLocation,
      category,
      description: this.data.formDescription,
      contact: this.data.formContact
    });
    if (Object.keys(checked.errors).length) {
      // 字段级问题就地提示，输入内容全部保留。
      this.setData({ errors: checked.errors, submitMessage: '请补全必填项后再提交。' });
      return;
    }
    this.setData({ submitBusy: true, submitMessage: '', errors: {} });
    const seq = ++this._seq;
    const result = await submitCase({
      request: options => requestConfigured(options),
      baseUrl: origin,
      payload: checked.payload,
      files: this._pickedFiles,
      timeout: config.requestTimeout,
      isCurrent: () => this._alive && seq === this._seq
    });
    if (!this._alive || seq !== this._seq) return;
    this.applyResult(result);
  },

  // 处理一次提交结果。任何失败都保留表单内容与请求号，重试沿用同一请求。
  applyResult(result) {
    if (result.kind === 'success') {
      this._pickedFiles = [];
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
        requestId: this._clientRequestId,
        receipt: {
          caseNumber: result.receipt.caseNumber,
          publicLookupCode: result.receipt.publicLookupCode,
          privateLookupToken: this._receiptToken
        }
      });
      return;
    }
    if (result.kind === 'cancelled') {
      this.setData({ submitBusy: false });
      return;
    }
    this.setData({
      submitBusy: false,
      submitMessage: result.message || '提交未完成，请稍后重试。',
      ...(result.errors ? { errors: result.errors } : {})
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
    this._pickedFiles = [];
    this._receiptToken = '';
    this.setData({
      view: 'form',
      receipt: null,
      submitBusy: false,
      submitMessage: '',
      errors: {},
      photoCount: 0,
      formLocation: '',
      formDescription: '',
      formDescriptionLength: 0,
      formContact: '',
      categoryIndex: -1,
      categoryText: categoryPlaceholder,
      requestId: this._clientRequestId
    });
  }
});

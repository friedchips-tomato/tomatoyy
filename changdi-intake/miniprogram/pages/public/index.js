const config = require('../../config.js');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const {
  choosePhotos, photoMessage, supplementPhotos, createPreviewFiles, cleanupOwnerPreviewOrphans
} = require('../staff/photos');
const { publishedPhotos, fetchFeedbackPhoto, fetchSupplementPhoto } = require('./feedback-photos');
const {
  trimCode,
  isValidCode,
  extractPublicCode,
  queryPublicCase,
  verifyOwner,
  fetchOwnerCase,
  submitOwnerAction,
  statusText,
  formatBeijingTime
} = require('./query.js');

Page({
  data: {
    code: '',
    state: 'idle',
    message: '',
    caseNumber: '',
    statusText: '',
    milestones: [],
    showVerify: false,
    privateToken: '',
    verifyState: 'idle',
    verifyMessage: '',
    ownerCaseNumber: '',
    ownerRound: '',
    ownerStatusText: '',
    ownerRounds: [],
    ownerFeedbackPhotos: [],
    ownerSupplementPhotos: [],
    previewKind: '',
    feedbackPhotoPath: '',
    feedbackPhotoBusy: false,
    feedbackPhotoError: '',
    reopenRequests: [],
    availableActions: [],
    showEvaluate: false,
    showConfirm: false,
    showReopen: false,
    showSupplement: false,
    supplementReason: '',
    supplementRequestedText: '',
    supplementSummary: '',
    supplementNotice: '',
    supplementPhotoCount: 0,
    supplementPhotoChoosing: false,
    supplementPhotoError: '',
    scores: { speed: 0, effectiveness: 0, attitude: 0 },
    comment: '',
    reopenReason: '',
    actionState: 'idle',
    actionMessage: '',
    actionPending: false
  },

  onLoad(query) {
    this.publicSeq = 0;
    this.ownerSeq = 0;
    this.actionSeq = 0;
    this.actionLocked = false;
    this.refreshSeq = 0;
    // 写入阶段：submit 表示提交中，refresh 表示结果待刷新确认。
    this.actionPhase = 'idle';
    // 核验代次：切换工单或重新核验都会自增，用于判断弹窗回调是否仍属当前工单。
    this.ownerEpoch = 0;
    // 最后一次成功公开查询的码与编号，核验入口与之绑定。
    this.lastPublicCode = '';
    this.lastPublicCaseNumber = '';
    // 会话令牌只放在页面内存，用于取本人详情。
    this.ownerSessionToken = '';
    this.ownerCaseNumber = '';
    this.ownerVersion = null;
    this.ownerExpiresAt = NaN;
    this.ownerOrigin = '';
    this.feedbackPhotoSeq = 0;
    this.feedbackPreviews = createPreviewFiles('owner-feedback');
    this.supplementPreviews = createPreviewFiles('owner-supplement');
    this.supplementPickSeq = 0;
    this.supplementFiles = [];
    cleanupOwnerPreviewOrphans();

    const fromEntry = extractPublicCodeFromEntry(query);
    if (fromEntry) {
      this.setData({ code: fromEntry });
      this.lookup(fromEntry);
      return;
    }
    this.setData({ state: 'idle', message: '请输入回执中的公开查询码，或扫描回执二维码。' });
  },

  onShow() {},

  // 页面隐藏或卸载时作废所有在途请求并清除本人私密数据。
  onUnload() {
    this.resetOwner();
  },

  onHide() {
    this.resetOwner();
  },

  // 清空本人界面、表单与短期授权，并作废本人在途请求。
  resetOwner() {
    this.clearFeedbackPhotos();
    this.clearSupplementSelection();
    this.publicSeq += 1;
    this.ownerSeq += 1;
    this.actionSeq += 1;
    this.ownerEpoch = (this.ownerEpoch || 0) + 1;
    this.actionLocked = false;
    this.actionPhase = 'idle';
    this.ownerSessionToken = '';
    this.ownerCaseNumber = '';
    this.ownerVersion = null;
    this.lastPublicCode = '';
    this.lastPublicCaseNumber = '';
    this.setData({
      showVerify: false,
      privateToken: '',
      verifyState: 'idle',
      verifyMessage: '',
      ownerCaseNumber: '',
      ownerRound: '',
      ownerStatusText: '',
      ownerRounds: [],
      reopenRequests: [],
      availableActions: [],
      showEvaluate: false,
      showConfirm: false,
      showReopen: false,
      showSupplement: false,
      supplementReason: '',
      supplementRequestedText: '',
      supplementSummary: '',
      supplementNotice: '',
      scores: { speed: 0, effectiveness: 0, attitude: 0 },
      comment: '',
      reopenReason: '',
      actionState: 'idle',
      actionMessage: '',
      actionPending: false,
      caseNumber: '',
      statusText: '',
      milestones: []
    });
  },

  // 切换工单或输入变化时，只作废在途请求并清空本人数据，不清空已输入的公开码。
  invalidatePublic() {
    this.publicSeq += 1;
  },

  clearOwnerOnly() {
    this.clearFeedbackPhotos();
    this.clearSupplementSelection();
    this.ownerSeq += 1;
    this.actionSeq += 1;
    this.ownerEpoch = (this.ownerEpoch || 0) + 1;
    this.actionLocked = false;
    this.actionPhase = 'idle';
    this.ownerSessionToken = '';
    this.ownerCaseNumber = '';
    this.ownerVersion = null;
    this.setData({
      showVerify: false,
      privateToken: '',
      verifyState: 'idle',
      verifyMessage: '',
      ownerCaseNumber: '',
      ownerRound: '',
      ownerStatusText: '',
      ownerRounds: [],
      reopenRequests: [],
      availableActions: [],
      showEvaluate: false,
      showConfirm: false,
      showReopen: false,
      showSupplement: false,
      supplementReason: '',
      supplementRequestedText: '',
      supplementSummary: '',
      supplementNotice: '',
      scores: { speed: 0, effectiveness: 0, attitude: 0 },
      comment: '',
      reopenReason: '',
      actionState: 'idle',
      actionMessage: '',
      actionPending: false
    });
  },

  onInput(event) {
    // 输入变化即作废在途请求并清空本人数据，避免旧结果或旧详情残留。
    this.invalidatePublic();
    this.clearOwnerOnly();
    this.setData({ code: trimCode(event.detail.value), state: 'idle', message: '' });
  },

  onSubmit() {
    const code = trimCode(this.data.code);
    if (!code) {
      this.invalidatePublic();
      this.clearOwnerOnly();
      this.setData({ state: 'invalid', message: '请先输入公开查询码。' });
      return;
    }
    if (!isValidCode(code)) {
      this.invalidatePublic();
      this.clearOwnerOnly();
      this.setData({ state: 'invalid', message: '公开码格式不正确，应为 24 位字母、数字、下划线或连字符。' });
      return;
    }
    this.lookup(code);
  },

  onScanTap() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: result => {
        // 微信小程序码的 path 字段是回退来源，result.result 只作第一顺位。
        const code = extractPublicCode(result && result.result) || extractPublicCode(result && result.path);
        if (!code) {
          // 无效扫码结果同样作废在途请求并清空本人数据。
          this.invalidatePublic();
          this.clearOwnerOnly();
          this.setData({ state: 'invalid', message: '未识别到公开查询码，请扫描回执中的二维码。' });
          return;
        }
        this.setData({ code });
        this.lookup(code);
      },
      // 取消扫描时留在本页，不清空已输入的内容。
      fail: () => {}
    });
  },

  onRetryTap() {
    const code = trimCode(this.data.code);
    if (!isValidCode(code)) {
      this.invalidatePublic();
      this.clearOwnerOnly();
      this.setData({ state: 'invalid', message: '公开码格式不正确，请重新输入。' });
      return;
    }
    this.lookup(code);
  },

  onBackTap() {
    this.resetOwner();
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/home/index' })
    });
  },

  onVerifyOpen() {
    // 核验入口只绑定到最后一次成功公开查询的码。
    if (!this.lastPublicCode || !this.lastPublicCaseNumber) {
      this.setData({ showVerify: false, verifyState: 'invalid', verifyMessage: '请先完成公开查询再核验本人。' });
      return;
    }
    this.setData({ showVerify: true, verifyState: 'idle', verifyMessage: '' });
  },

  onVerifyClose() {
    this.clearOwnerOnly();
  },

  onPrivateTokenInput(event) {
    this.setData({ privateToken: event.detail.value });
  },

  onVerifySubmit() {
    const privateToken = trimCode(this.data.privateToken);
    // 提交即清空输入，凭证不留在输入框。
    this.setData({ privateToken: '' });
    if (!privateToken) {
      this.setData({ verifyState: 'invalid', verifyMessage: '请输入回执中的私密查询凭证。' });
      return;
    }
    const code = this.lastPublicCode;
    if (!code) {
      this.setData({ verifyState: 'invalid', verifyMessage: '请先完成公开查询再核验本人。' });
      return;
    }

    this.clearOwnerOnly();
    const seq = this.ownerSeq;
    const { origin, wechatEnabled } = apiEnvironment();
    this.setData({ showVerify: true, verifyState: 'loading', verifyMessage: '' });
    return verifyOwner({
      request: requestConfigured,
      baseUrl: origin,
      publicLookupCode: code,
      privateLookupToken: privateToken,
      timeout: config.requestTimeout
    }).then(result => {
      if (seq !== this.ownerSeq) return;
      if (origin !== apiEnvironment().origin) return this.expireFeedbackAuthorization();
      if (result.kind !== 'success') {
        this.setData({ verifyState: result.kind, verifyMessage: result.message });
        return;
      }
      // 校验核验回复的工单编号必须与公开查询一致。
      if (result.caseNumber !== this.lastPublicCaseNumber) {
        this.clearOwnerOnly();
        this.setData({ showVerify: true, verifyState: 'invalid', verifyMessage: '核验结果与当前工单不一致，请重新查询。' });
        return;
      }
      this.ownerSessionToken = result.ownerSessionToken;
      this.ownerCaseNumber = result.caseNumber;
      this.ownerExpiresAt = Date.parse(result.expiresAt);
      this.ownerOrigin = wechatEnabled ? origin : '';
      // 新一轮核验开启新的核验代次，此前打开的弹窗回调一律失效。
      this.ownerEpoch += 1;
      if (!this.ownerSessionCurrent()) return;
      if (this.ownerOrigin) this.scheduleOwnerExpiry();
      this.setData({ verifyState: 'loading', verifyMessage: '' });
      return this.loadOwnerCase(seq);
    });
  },

  loadOwnerCase(seq) {
    if (!this.ownerSessionCurrent()) return;
    return fetchOwnerCase({
      request: requestConfigured,
      baseUrl: this.ownerOrigin || apiEnvironment().origin,
      caseNumber: this.ownerCaseNumber,
      ownerSessionToken: this.ownerSessionToken,
      timeout: config.requestTimeout
    }).then(result => {
      if (seq !== this.ownerSeq || !this.ownerSessionCurrent()) return;
      if (result.kind !== 'success') {
        // 授权失效时清除授权与详情，停止显示本人内容。
        this.clearOwnerOnly();
        this.setData({ showVerify: true, verifyState: result.kind, verifyMessage: result.message });
        return;
      }
      this.ownerVersion = result.version;
      this.setData({
        verifyState: 'success',
        verifyMessage: '',
        ownerCaseNumber: result.caseNumber,
        ownerRound: result.round === null ? '' : String(result.round),
        ownerStatusText: result.statusText,
        ownerRounds: result.rounds,
        reopenRequests: result.reopenRequests,
        availableActions: result.availableActions,
        showEvaluate: result.availableActions.includes('evaluate'),
        showConfirm: result.availableActions.includes('confirm_resolved'),
        showReopen: result.availableActions.includes('request_reopen'),
        showSupplement: result.availableActions.includes('submit_supplement'),
        supplementReason: result.supplementRequirement ? result.supplementRequirement.reason : '',
        supplementRequestedText: result.supplementRequirement ? result.supplementRequirement.requestedText : '',
        supplementSummary: ''
      });
      const sameCase = result.caseNumber === this.ownerCaseNumber;
      this.setFeedbackPhotos(sameCase ? result.feedbackPhotos : [], sameCase ? result.supplementPhotos : []);
    });
  },

  clearFeedbackPhotos() {
    clearTimeout(this.feedbackExpiryTimer);
    this.ownerExpiresAt = NaN;
    this.ownerOrigin = '';
    this.onCloseFeedbackPhoto();
    this.setData({ ownerFeedbackPhotos: [], ownerSupplementPhotos: [] });
  },

  setFeedbackPhotos(photos, supplements = []) {
    clearTimeout(this.feedbackExpiryTimer);
    this.onCloseFeedbackPhoto();
    const remaining = this.ownerExpiresAt - Date.now();
    const items = remaining > 0 && Array.isArray(photos) ? photos : [];
    const originalItems = remaining > 0 && Array.isArray(supplements) ? supplements : [];
    this.setData({ ownerFeedbackPhotos: items, ownerSupplementPhotos: originalItems });
    if (remaining > 0 && (this.ownerOrigin || items.length || originalItems.length || this.data.showSupplement)) {
      this.scheduleOwnerExpiry();
    }
  },

  scheduleOwnerExpiry() {
    const epoch = this.ownerEpoch;
    this.feedbackExpiryTimer = setTimeout(() => {
      if (epoch === this.ownerEpoch) this.expireFeedbackAuthorization();
    }, Math.min(this.ownerExpiresAt - Date.now(), 30 * 60 * 1000));
  },

  ownerSessionCurrent() {
    const { origin, wechatEnabled } = apiEnvironment();
    if ((this.ownerOrigin && (this.ownerOrigin !== origin || !(this.ownerExpiresAt > Date.now()))) ||
        (this.ownerSessionToken && wechatEnabled && !this.ownerOrigin)) {
      this.expireFeedbackAuthorization();
      return false;
    }
    return true;
  },

  expireFeedbackAuthorization() {
    this.clearOwnerOnly();
    this.setData({ showVerify: true, verifyState: 'unauthorized', verifyMessage: '本人授权已失效，请重新核验。' });
  },

  onCloseFeedbackPhoto() {
    this.feedbackPhotoSeq++;
    if (this.feedbackPreviews) this.feedbackPreviews.clear();
    if (this.supplementPreviews) this.supplementPreviews.clear();
    this.setData({ previewKind: '', feedbackPhotoPath: '', feedbackPhotoBusy: false, feedbackPhotoError: '' });
  },

  onFeedbackImageError(event) {
    if (!this.data.feedbackPhotoPath || event.currentTarget.dataset.path !== this.data.feedbackPhotoPath) return;
    const { previewKind } = this.data;
    this.onCloseFeedbackPhoto();
    this.setData({ previewKind, feedbackPhotoError: '图片预览失败，请重新读取。' });
  },

  onOpenFeedbackPhoto(event) {
    return this.openOwnerPhoto('feedback', event.currentTarget.dataset.photo);
  },

  onOpenSupplementPhoto(event) {
    return this.openOwnerPhoto('supplement', event.currentTarget.dataset.photo);
  },

  async openOwnerPhoto(kind, key) {
    const supplement = kind === 'supplement';
    const list = supplement ? 'ownerSupplementPhotos' : 'ownerFeedbackPhotos';
    const photo = this.data[list].find(item => item.key === key);
    const { ownerCaseNumber: caseNumber, ownerSessionToken: token, ownerEpoch: epoch } = this;
    const version = this.ownerVersion;
    if (this.data.verifyState !== 'success' || !token || !photo || this.lastPublicCaseNumber !== caseNumber) return;
    if (!this.ownerSessionCurrent()) return;
    if (!(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
    this.onCloseFeedbackPhoto();
    const seq = this.feedbackPhotoSeq;
    const current = () => seq === this.feedbackPhotoSeq && epoch === this.ownerEpoch &&
      caseNumber === this.ownerCaseNumber && version === this.ownerVersion && token === this.ownerSessionToken &&
      this.data[list].some(item => item.key === key) && this.ownerSessionCurrent();
    this.setData({ previewKind: kind, feedbackPhotoBusy: true });
    try {
      const fetchPhoto = supplement ? fetchSupplementPhoto : fetchFeedbackPhoto;
      const response = await fetchPhoto({ baseUrl: this.ownerOrigin || apiEnvironment().origin, caseNumber, photo, token,
        timeout: config.requestTimeout });
      if (!current()) return;
      if (!(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
      const previews = supplement ? this.supplementPreviews : this.feedbackPreviews;
      const path = previews.write(response.data, photo, response.header);
      this.setData({ feedbackPhotoPath: path, feedbackPhotoBusy: false });
    } catch (error) {
      if (!current()) return;
      if (error.status === 401 || error.status === 403 || !(this.ownerExpiresAt > Date.now())) {
        return this.expireFeedbackAuthorization();
      }
      this.onCloseFeedbackPhoto();
      this.setData({ previewKind: kind, feedbackPhotoError: '图片读取失败，请重新读取。' });
    }
  },

  onScoreTap(event) {
    const dimension = event.currentTarget.dataset.dimension;
    const value = Number(event.currentTarget.dataset.value);
    if (!dimension || !Number.isSafeInteger(value)) return;
    this.setData({ scores: { ...this.data.scores, [dimension]: value } });
  },

  onCommentInput(event) {
    this.setData({ comment: event.detail.value });
  },

  onReopenReasonInput(event) {
    this.setData({ reopenReason: event.detail.value });
  },

  onSupplementSummaryInput(event) {
    this.setData({ supplementSummary: event.detail.value });
  },

  clearSupplementSelection() {
    this.supplementPickSeq++;
    this.supplementFiles = [];
    this.setData({ supplementPhotoCount: 0, supplementPhotoChoosing: false, supplementPhotoError: '' });
  },

  onClearSupplementPhotos() {
    if (!this.actionLocked) this.clearSupplementSelection();
  },

  async onChooseSupplementPhotos() {
    const bound = this.ownerBinding();
    if (!bound || !this.data.showSupplement || this.actionLocked || this.data.supplementPhotoChoosing) return;
    if (!this.ownerSessionCurrent()) return;
    if (!(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
    const seq = ++this.supplementPickSeq;
    this.setData({ supplementPhotoChoosing: true, supplementPhotoError: '' });
    try {
      const files = await choosePhotos(false);
      if (seq !== this.supplementPickSeq || !this.bindingValid(bound) || bound.version !== this.ownerVersion ||
          !this.ownerSessionCurrent()) return;
      if (!(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
      if (files) this.supplementFiles = files;
      this.setData({ supplementPhotoChoosing: false, supplementPhotoCount: this.supplementFiles.length });
    } catch (error) {
      if (seq !== this.supplementPickSeq || !this.bindingValid(bound) || bound.version !== this.ownerVersion ||
          !this.ownerSessionCurrent()) return;
      if (!(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
      this.setData({ supplementPhotoChoosing: false, supplementPhotoError: photoMessage(error) });
    }
  },

  onSupplementSubmit() {
    if (!this.data.showSupplement || this.data.supplementPhotoChoosing) return;
    const summary = trimCode(this.data.supplementSummary);
    if (!summary) {
      this.setData({ actionState: 'invalid', actionMessage: '请填写补件说明。' });
      return;
    }
    if (Array.from(summary).length > 4000) {
      this.setData({ actionState: 'invalid', actionMessage: '补件说明不能超过 4000 字。' });
      return;
    }
    return this.runOwnerAction('submit_supplement', { summary }, this.ownerBinding(), this.supplementFiles);
  },

  onEvaluateSubmit() {
    const { speed, effectiveness, attitude } = this.data.scores;
    if (![speed, effectiveness, attitude].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 5)) {
      this.setData({ actionState: 'invalid', actionMessage: '请为处理速度、处理效果和服务态度各选 1 至 5 分。' });
      return;
    }
    this.runOwnerAction('evaluate', {
      speed,
      effectiveness,
      attitude,
      comment: trimCode(this.data.comment) || undefined
    }, this.ownerBinding());
  },

  onConfirmResolved() {
    // 弹窗在打开时绑定当时的工单与核验代次，回调只对这一次绑定有效。
    const bound = this.ownerBinding();
    if (!bound || !this.data.showConfirm) {
      this.setData({ actionState: 'invalid', actionMessage: '本工单当前不可确认解决。' });
      return;
    }
    // 确认解决需要用户明确确认一次。
    wx.showModal({
      title: '确认解决',
      content: '确认本事项已解决？确认后工单将办结，未评分记为未评价。',
      confirmText: '确认',
      cancelText: '再想想',
      success: result => {
        if (!result || !result.confirm) return;
        // 弹窗期间可能已切单、重新核验或失权，此时不得再写入。
        if (!this.bindingValid(bound)) {
          this.setData({ actionState: 'invalid', actionMessage: '工单或授权已变化，本次操作未提交，请重新确认。' });
          return;
        }
        this.runOwnerAction('confirm_resolved', {}, bound);
      }
    });
  },

  onReopenSubmit() {
    const reason = trimCode(this.data.reopenReason);
    if (!reason) {
      this.setData({ actionState: 'invalid', actionMessage: '请填写未解决事项说明。' });
      return;
    }
    this.runOwnerAction('request_reopen', { reason }, this.ownerBinding());
  },

  // 取得当前本人绑定的快照：工单编号、核验代次与动作版本。
  ownerBinding() {
    if (!this.ownerSessionToken || !this.ownerCaseNumber || !Number.isSafeInteger(this.ownerVersion)) return null;
    return {
      caseNumber: this.ownerCaseNumber,
      epoch: this.ownerEpoch,
      version: this.ownerVersion
    };
  },

  // 判断快照是否仍指向当前工单与当前核验代次。
  bindingValid(bound) {
    if (!bound) return false;
    if (!this.ownerSessionToken || !this.ownerCaseNumber) return false;
    return bound.caseNumber === this.ownerCaseNumber && bound.epoch === this.ownerEpoch;
  },

  // 单次写入锁：提交与随后的结果刷新期间都不接受新的写入。
  runOwnerAction(action, payload, bound, files = []) {
    if (!this.ownerSessionCurrent()) return;
    if (this.actionLocked) {
      // 刷新阶段说明结果待确认，提交阶段说明正在提交。
      const refreshing = this.actionPhase === 'refresh';
      this.setData({
        actionState: 'busy',
        actionMessage: refreshing
          ? '正在确认上一次提交的结果，请稍候，暂不重复提交。'
          : '正在提交，请稍候。'
      });
      return;
    }
    const current = bound || this.ownerBinding();
    if (!current) {
      this.setData({ actionState: 'invalid', actionMessage: '本人授权已失效，请重新核验。' });
      return;
    }
    if (!this.bindingValid(current)) {
      this.setData({ actionState: 'invalid', actionMessage: '工单或授权已变化，本次操作未提交，请重新操作。' });
      return;
    }
    if (files.length && !(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
    this.actionLocked = true;
    this.actionPhase = 'submit';
    const seq = ++this.actionSeq;
    this.setData({ actionState: 'loading', actionMessage: '', actionPending: true });
    return submitOwnerAction({
      request: requestConfigured,
      baseUrl: this.ownerOrigin || apiEnvironment().origin,
      caseNumber: current.caseNumber,
      ownerSessionToken: this.ownerSessionToken,
      action,
      expectedVersion: current.version,
      payload,
      files,
      isCurrent: () => seq === this.actionSeq && this.bindingValid(current) &&
        current.version === this.ownerVersion && this.ownerExpiresAt > Date.now() && this.ownerSessionCurrent(),
      timeout: config.requestTimeout
    }).then(result => {
      if (seq !== this.actionSeq || !this.ownerSessionCurrent()) return;
      if (files.length && !(this.ownerExpiresAt > Date.now())) return this.expireFeedbackAuthorization();
      if (result.kind === 'cancelled') {
        this.actionLocked = false;
        this.actionPhase = 'idle';
        this.setData({ actionState: 'invalid', actionMessage: '工单已变化，请核对后重新操作。', actionPending: false });
        return;
      }
      if (result.kind === 'unauthorized') {
        // 授权失效即清除授权，同时释放写入锁。
        this.clearOwnerOnly();
        this.setData({ showVerify: true, verifyState: result.kind, verifyMessage: result.message, actionMessage: result.message });
        return;
      }
      if (result.kind === 'success') {
        this.actionLocked = false;
        this.actionPhase = 'idle';
        if (action === 'submit_supplement') this.clearSupplementSelection();
        this.applyOwnerDetail(result.data);
        this.setData({
          actionState: 'idle',
          actionMessage: '',
          actionPending: false,
          comment: '',
          reopenReason: '',
          supplementSummary: '',
          ...(action === 'submit_supplement'
            ? { supplementNotice: '补件已提交，原单已回到待受理队列，等待值班人员受理。' }
            : {}),
          scores: { speed: 0, effectiveness: 0, attitude: 0 }
        });
        return;
      }
      if (['conflict', 'timeout', 'network', 'expired', 'uncertain'].includes(result.kind)) {
        // 结果未知或状态已变：写入锁继续持有，先刷新详情确认，再允许重试。
        this.actionPhase = 'refresh';
        this.actionKind = result.kind;
        this.setData({ actionState: result.kind, actionMessage: result.message, actionPending: true });
        this.refreshOwnerDetail(seq);
        return;
      }
      // 明确被拒的写入，释放锁并保留提示，允许用户修正后重试。
      this.actionLocked = false;
      this.actionPhase = 'idle';
      this.setData({ actionState: result.kind, actionMessage: result.message, actionPending: false });
    });
  },

  // 刷新本人详情以确认写入结果。刷新返回前写入锁保持占用。
  refreshOwnerDetail(seq) {
    if (!this.ownerSessionToken || !this.ownerCaseNumber || !this.ownerSessionCurrent()) return;
    const refresh = ++this.refreshSeq;
    fetchOwnerCase({
      request: requestConfigured,
      baseUrl: this.ownerOrigin || apiEnvironment().origin,
      caseNumber: this.ownerCaseNumber,
      ownerSessionToken: this.ownerSessionToken,
      timeout: config.requestTimeout
    }).then(result => {
      if (seq !== this.actionSeq || refresh !== this.refreshSeq || !this.ownerSessionCurrent()) return;
      if (result.kind === 'unauthorized') {
        this.clearOwnerOnly();
        this.setData({ showVerify: true, verifyState: result.kind, verifyMessage: result.message, actionMessage: result.message });
        return;
      }
      if (result.kind !== 'success' || !Number.isSafeInteger(result.version) || result.version < this.ownerVersion) {
        // 刷新未成功，结果仍未知：保持写入锁，等待用户重试刷新确认。
        this.setData({
          actionState: 'refresh_failed',
          actionMessage: '刷新未成功，结果仍未知，请重试刷新确认后再提交。',
          actionPending: true
        });
        return;
      }
      // 已收到新版本，释放写入锁并允许重试。
      this.actionLocked = false;
      this.actionPhase = 'idle';
      this.applyOwnerDetail(result, result.feedbackPhotos);
      // 刷新后仍保留原来的失败状态与文案，用户能明确知道本次写入是否已落库。
      this.setData({
        actionState: this.actionKind,
        actionMessage: this.refreshNotice(this.actionKind),
        actionPending: false
      });
    });
  },

  // 读回后的可见文案：区分“明确未写入”与“结果未知已同步”。
  refreshNotice(kind) {
    if (kind === 'conflict') {
      return '本次提交未写入，工单状态已更新，请核对最新状态后再提交。';
    }
    if (kind === 'expired') {
      return '本次提交未写入，相应期限已结束，请刷新查看当前状态。';
    }
    return '本次提交结果未知，已刷新最新状态，请核对后再决定是否重新提交。';
  },

  // 结果未知时由用户主动重试刷新。
  onRetryRefresh() {
    if (!this.actionLocked || this.actionPhase !== 'refresh') return;
    if (!this.ownerSessionToken || !this.ownerCaseNumber) {
      this.setData({ actionState: 'invalid', actionMessage: '本人授权已失效，请重新核验。' });
      return;
    }
    this.setData({ actionState: 'busy', actionPending: true, actionMessage: '正在刷新确认…' });
    this.refreshOwnerDetail(this.actionSeq);
  },

  applyOwnerDetail(detail, photos = publishedPhotos(detail.rounds, detail.version)) {
    const rounds = Array.isArray(detail.rounds) ? detail.rounds : [];
    const reopenRequests = Array.isArray(detail.reopenRequests) ? detail.reopenRequests : [];
    const availableActions = Array.isArray(detail.availableActions) ? detail.availableActions : [];
    const requirement = detail.supplementRequirement && typeof detail.supplementRequirement === 'object'
      ? detail.supplementRequirement
      : null;
    const showSupplement = availableActions.includes('submit_supplement');
    if (!showSupplement || this.ownerVersion !== detail.version) this.clearSupplementSelection();
    this.ownerVersion = Number.isSafeInteger(detail.version) ? detail.version : this.ownerVersion;
    this.setData({
      ownerCaseNumber: typeof detail.caseNumber === 'string' ? detail.caseNumber : this.ownerCaseNumber,
      ownerRound: Number.isSafeInteger(detail.round) ? String(detail.round) : '',
      ownerStatusText: statusText(detail.status),
      ownerRounds: rounds.filter(item => item && typeof item === 'object'),
      reopenRequests,
      availableActions,
      showEvaluate: availableActions.includes('evaluate'),
      showConfirm: availableActions.includes('confirm_resolved'),
      showReopen: availableActions.includes('request_reopen'),
      showSupplement,
      supplementReason: requirement && typeof requirement.reason === 'string' ? requirement.reason : '',
      supplementRequestedText: requirement ? formatBeijingTime(requirement.requestedAt) : '',
      // 仍有补件要求时，旧的补交结论不再适用。
      supplementNotice: showSupplement ? '' : this.data.supplementNotice
    });
    const sameCase = detail.caseNumber === this.ownerCaseNumber;
    this.setFeedbackPhotos(sameCase ? photos : [], sameCase ? supplementPhotos(detail) : []);
  },

  lookup(code) {
    const seq = ++this.publicSeq;
    // 切换工单先清空本人数据与核验绑定，避免上一单的详情和凭证残留。
    this.clearOwnerOnly();
    this.lastPublicCode = '';
    this.lastPublicCaseNumber = '';
    this.setData({ state: 'loading', message: '', caseNumber: '', statusText: '', milestones: [] });
    const { origin } = apiEnvironment();
    return queryPublicCase({
      request: requestConfigured,
      baseUrl: origin,
      code,
      timeout: config.requestTimeout
    }).then(result => {
      // 旧请求晚到时丢弃，不覆盖较新请求的结果。
      if (seq !== this.publicSeq || origin !== apiEnvironment().origin) return;
      this.applyResult(result);
    });
  },

  applyResult(result) {
    if (result.kind === 'success') {
      // 记录最后成功公开查询的码与编号，供核验入口绑定。
      this.lastPublicCode = trimCode(this.data.code);
      this.lastPublicCaseNumber = result.caseNumber;
      this.setData({
        state: 'success',
        message: '',
        caseNumber: result.caseNumber,
        statusText: result.statusText,
        milestones: result.milestones
      });
      return;
    }
    this.lastPublicCode = '';
    this.lastPublicCaseNumber = '';
    this.setData({
      state: result.kind,
      message: result.message,
      caseNumber: '',
      statusText: '',
      milestones: []
    });
  }
});

// 入口参数支持 scene 与 code。scene 形如 “c=公开码” 或直接是公开码。
function extractPublicCodeFromEntry(query) {
  if (!query || typeof query !== 'object') return '';
  const candidates = [query.code, query.scene];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const code = extractPublicCode(candidate);
    if (code) return code;
  }
  return '';
}

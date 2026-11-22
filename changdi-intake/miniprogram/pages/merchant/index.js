const config = require('../../config.js');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const { invalidEnvironment, clearWechatSession, activeSession, loginWithWechat } = require('../../wechat-session');
const { emptyExtra, methods: claimantMethods } = require('./claimant');
const { createReceiptArtwork } = require('./receipt-artwork');
const {
  isValidToken,
  statusOptions,
  permissionLabels,
  timeLabel,
  canSubmitTask,
  newClientRequestId,
  normalizeSubmission,
  fetchIdentity,
  fetchMerchantCases,
  fetchMerchantCase,
  fetchCollaborations,
  fetchCollaboration,
  fetchCollaborationPhoto,
  submitCollaboration,
  submitMerchantCase
} = require('./merchant.js');
const {
  choosePhotos,
  readPhotos,
  photoFingerprint,
  photoMessage,
  createPreviewFiles
} = require('./photos.js');

const readError = '读取失败，请重试。';

// 当前北京时间的日期与时刻，作为新诉求表单的默认值。
function nowBeijing() {
  const shifted = new Date(Date.now() + 8 * 3600000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function initialData() {
  const now = nowBeijing();
  const { localEnabled, wechatEnabled } = apiEnvironment();
  return {
    view: 'login',
    localEnabled,
    wechatEnabled,
    loginKeys: [0],
    loginBusy: false,
    loginError: '',
    merchant: '',
    permissions: [],
    permissionText: '',
    canReadCases: false,
    canCollaborate: false,
    canSubmitCases: false,
    canViewRepresentativeReport: false,
    ...emptyExtra(),
    notice: '',
    // 工单列表
    statusOptions,
    statusIndex: 0,
    cases: [],
    casesNextBefore: '',
    casesBusy: false,
    casesError: '',
    casesReady: false,
    // 工单详情
    activeCase: '',
    caseDetail: null,
    caseBusy: false,
    caseError: '',
    // 协办待办
    tasks: [],
    tasksNextBefore: '',
    tasksBusy: false,
    tasksError: '',
    tasksReady: false,
    // 协办详情
    activeTask: '',
    taskDetail: null,
    taskBusy: false,
    taskError: '',
    taskSummary: '',
    taskSubmitting: false,
    taskSubmitMessage: '',
    // 协办送审可选照片：与文字说明一次提交，可留空。
    taskPhotoCount: 0,
    taskPhotoChoosing: false,
    // 协办送审原图预览：只在选中的那一项上显示。
    taskPreviewPath: '',
    taskPreviewBusy: false,
    taskPreviewError: '',
    taskPreviewKey: '',
    // 新诉求表单
    showForm: false,
    formDate: now.date,
    formTime: now.time,
    formLocation: '',
    formCategory: '',
    formDescription: '',
    formSuggestedDepartment: '',
    formContact: '',
    submitBusy: false,
    submitMessage: '',
    submitReceipt: null,
    submitRequestId: '',
    submitButtonText: '提交诉求',
    // 结果未知时锁定本次申报：不可改字段、不可清空、不可换图，只能原样重试。
    submitPending: false,
    // 可选照片：与正文一次提交，照片可留空。
    photoCount: 0,
    photoChoosing: false
  };
}

const dataset = event => event.currentTarget.dataset;

Page({
  data: initialData(),
  ...claimantMethods,

  onLoad() {
    this._alive = true;
    this._session = 0;
    this._caseRequest = 0;
    this._taskRequest = 0;
    this._detailRequest = 0;
    this._submitRequest = 0;
    this._submitCaseRequest = 0;
    this._photoRequest = 0;
    this._taskPhotoRequest = 0;
    this._previewRequest = 0;
    this._requestSeq = 0;
    this._extraRequest = 0;
    // 当前申报的草稿：请求号与内容绑定，网络中断重试时保持不变。
    this._draft = null;
    // 已选但尚未发送的照片（只有本机临时文件路径）。
    this._pickedFiles = [];
    // 结果未知时冻结的内容：首次实际发出的字节，重试时原样重发。
    this._frozen = null;
    // 协办送审已选但尚未发送的照片，与新诉求的照片分开，互不串用。
    this._taskPickedFiles = [];
    // 协办原图预览文件：逐个登记，逐个清理。
    this._previewFiles = createPreviewFiles();
    this._receiptArtwork = createReceiptArtwork();
    this._receiptArtwork.cleanupPrevious();
    // 商户令牌只放在页面内存，不写本页数据、不进网址、不写持久缓存。
    this._token = '';
    this.setData(initialData());
  },

  onUnload() {
    this._alive = false;
    this.clearSession(this.pendingNotice());
  },

  onHide() {
    // 页面隐藏即清除令牌与本人商户数据。结果未确认时如实说明无法续接。
    this.clearSession(this.pendingNotice());
  },

  onLogout() {
    this.clearSession(this.pendingNotice());
  },

  // 结果未确认时给出说明：本次申报已随会话清除，无法继续确认。
  pendingNotice() {
    return this._draft && this._draft.pending
      ? '本次提交结果未确认，退出后无法继续确认，请先在工单列表核对后再提交新的诉求。'
      : '';
  },

  onExit() {
    this.clearSession(this.pendingNotice());
    wx.navigateBack({ delta: 1 });
  },

  // 清除商户身份、令牌与全部商户数据，并作废在途请求。
  clearSession(message) {
    this._session += 1;
    this._caseRequest += 1;
    this._taskRequest += 1;
    this._detailRequest += 1;
    this._submitRequest += 1;
    this._submitCaseRequest += 1;
    this._photoRequest += 1;
    this._taskPhotoRequest += 1;
    this._previewRequest += 1;
    this._extraRequest += 1;
    this._claimFrom = '';
    this._token = '';
    clearWechatSession(this);
    this._draft = null;
    // 关闭会话时清空临时数据：已选照片与冻结的字节都不再保留。
    this._pickedFiles = [];
    this._frozen = null;
    this._taskPickedFiles = [];
    // 预览文件逐个清理，不留在本机。
    this._previewFiles.clear();
    this._receiptArtwork.clearAll();
    this.setData({
      ...initialData(),
      loginKeys: [this.data.loginKeys[0] + 1],
      loginError: message || ''
    });
  },

  active(session) {
    return activeSession(this, session);
  },

  apiOptions() {
    const sequence = this._session;
    return {
      baseUrl: apiEnvironment().origin, token: this._token, timeout: config.requestTimeout,
      request: options => {
        if (!this.active(sequence)) return options.fail({ errMsg: 'inactive_session' });
        return requestConfigured(options);
      }
    };
  },

  sessionError(error) {
    if (error.status === 401 || error.status === 403) {
      this.clearSession('当前商户凭据无效或权限已变更，请重新核验。');
      return true;
    }
    return false;
  },

  async onLoginSubmit(event) {
    if (!this._alive || this.data.loginBusy || this.data.view !== 'login') return;
    const value = event.detail.value.token;
    const token = typeof value === 'string' ? value.trim() : '';
    // 提交后立即清空输入框，凭据不留在页面上。
    this.setData({ loginKeys: [this.data.loginKeys[0] + 1], loginError: '' });
    if (!apiEnvironment().localEnabled) {
      this.clearSession(invalidEnvironment);
      return;
    }
    if (!isValidToken(token)) {
      this.setData({ loginError: '请输入有效格式的本地商户测试令牌。' });
      return;
    }
    const session = ++this._session;
    this._token = token;
    this.setData({ loginBusy: true });
    return this.finishLogin(session);
  },

  onWechatLogin() {
    return loginWithWechat(this, 'merchant');
  },

  async finishLogin(session) {
    try {
      const result = await fetchIdentity(this.apiOptions());
      if (!this.active(session)) return;
      if (result.kind !== 'success') {
        this.clearSession(result.message || '未能确认商户身份。');
        return;
      }
      this.setData({
        loginBusy: false,
        view: 'workbench',
        merchant: result.merchantId,
        permissions: result.permissions,
        permissionText: result.permissions.map(item => permissionLabels[item]).join(' · '),
        canReadCases: result.permissions.includes('readCases'),
        canSubmitCases: result.permissions.includes('submitCases'),
        canViewRepresentativeReport: result.permissions.includes('representativeReport'),
        canCollaborate: result.permissions.includes('collaborate')
      });
      return this.refreshAll();
    } catch (error) {
      if (!this.active(session) || this.sessionError(error)) return;
      this.clearSession('无法完成核验，请检查服务后重试。');
    }
  },

  // 按权限决定可读的部分：无读取权限时不请求工单，无协办权限时不请求待办。
  can(permission) {
    return this.data.permissions.includes(permission);
  },

  refreshAll() {
    const work = [];
    if (this.can('readCases')) work.push(this.loadCases());
    if (this.can('collaborate')) work.push(this.loadTasks());
    return Promise.all(work);
  },

  onRefresh() {
    if (!this._token || this.data.view !== 'workbench') return;
    this.setData({ notice: '' });
    return this.refreshAll();
  },

  async loadCases(append = false) {
    if (!this.can('readCases')) return;
    const { statusIndex, casesNextBefore } = this.data;
    const session = this._session;
    const request = ++this._caseRequest;
    const status = statusOptions[statusIndex].id;
    const params = [];
    if (status) params.push('status=' + encodeURIComponent(status));
    if (append) params.push('before=' + encodeURIComponent(casesNextBefore));
    const query = params.length ? '?' + params.join('&') : '';
    this.setData({
      casesBusy: true,
      casesError: '',
      ...(append ? {} : { cases: [], casesNextBefore: '', casesReady: false })
    });
    try {
      const result = await fetchMerchantCases({
        ...this.apiOptions(),
        status,
        before: append ? casesNextBefore : ''
      });
      if (!this.active(session) || request !== this._caseRequest) return;
      if (result.kind !== 'success') {
        if (result.kind === 'unauthorized' || result.kind === 'forbidden') {
          this.clearSession(result.message);
          return;
        }
        if (result.kind === 'invalid_cursor') {
          this.setData({ notice: result.message });
          return this.loadCases();
        }
        this.setData({ casesBusy: false, casesError: result.message || readError });
        return;
      }
      const items = append ? this.data.cases.slice() : [];
      const known = new Set(items.map(item => item.caseNumber));
      for (const item of result.items) {
        if (!known.has(item.caseNumber)) {
          items.push(item);
          known.add(item.caseNumber);
        }
      }
      this.setData({
        cases: items,
        casesNextBefore: result.nextBefore,
        casesBusy: false,
        casesReady: true
      });
    } catch (error) {
      if (!this.active(session) || request !== this._caseRequest || this.sessionError(error)) return;
      this.setData({ casesBusy: false, casesError: readError });
    }
  },

  onStatusChange(event) {
    const statusIndex = Number(event.detail.value);
    if (this.data.view !== 'workbench' || !Number.isInteger(statusIndex) || !statusOptions[statusIndex]) return;
    this.setData({ statusIndex, notice: '' });
    return this.loadCases();
  },

  onLoadMoreCases() {
    if (this.data.view === 'workbench' && this.data.casesNextBefore) return this.loadCases(true);
  },

  async loadTasks(append = false) {
    if (!this.can('collaborate')) return;
    const { tasksNextBefore } = this.data;
    const session = this._session;
    const request = ++this._taskRequest;
    this.setData({
      tasksBusy: true,
      tasksError: '',
      ...(append ? {} : { tasks: [], tasksNextBefore: '', tasksReady: false })
    });
    try {
      const result = await fetchCollaborations({
        ...this.apiOptions(),
        before: append ? tasksNextBefore : ''
      });
      if (!this.active(session) || request !== this._taskRequest) return;
      if (result.kind !== 'success') {
        if (result.kind === 'unauthorized' || result.kind === 'forbidden') {
          this.clearSession(result.message);
          return;
        }
        if (result.kind === 'invalid_cursor') {
          this.setData({ notice: result.message });
          return this.loadTasks();
        }
        this.setData({ tasksBusy: false, tasksError: result.message || readError });
        return;
      }
      const items = append ? this.data.tasks.slice() : [];
      const known = new Set(items.map(item => item.taskId));
      for (const item of result.items) {
        if (!known.has(item.taskId)) {
          items.push(item);
          known.add(item.taskId);
        }
      }
      this.setData({
        tasks: items,
        tasksNextBefore: result.nextBefore,
        tasksBusy: false,
        tasksReady: true
      });
    } catch (error) {
      if (!this.active(session) || request !== this._taskRequest || this.sessionError(error)) return;
      this.setData({ tasksBusy: false, tasksError: readError });
    }
  },

  onLoadMoreTasks() {
    if (this.data.view === 'workbench' && this.data.tasksNextBefore) return this.loadTasks(true);
  },

  onOpenCase(event) {
    const caseNumber = dataset(event).case;
    if (!this.can('readCases') || this.data.submitBusy || this.data.caseBusy || typeof caseNumber !== 'string') return;
    this._receiptArtwork.clear('submitReceipt');
    this.setData({ view: 'case', activeCase: caseNumber, notice: '', submitReceipt: null });
    return this.loadCase(caseNumber);
  },

  async loadCase(caseNumber) {
    if (!this.can('readCases')) return;
    const session = this._session;
    const request = ++this._detailRequest;
    this.resetExtra();
    this.setData({ caseDetail: null, caseBusy: true, caseError: '' });
    try {
      const result = await fetchMerchantCase({
        ...this.apiOptions(), caseNumber
      });
      if (!this.active(session) || request !== this._detailRequest) return;
      if (result.kind !== 'success') {
        if (result.kind === 'unauthorized' || result.kind === 'forbidden') {
          this.clearSession(result.message);
          return;
        }
        if (result.kind === 'notfound') {
          this.setData({ view: 'workbench', activeCase: '', caseDetail: null, caseBusy: false, notice: '该工单已不在本商户范围内。' });
          return this.loadCases();
        }
        this.setData({ caseBusy: false, caseError: result.message || readError });
        return;
      }
      this.setData({ caseDetail: result.detail, caseBusy: false, caseError: '' });
    } catch (error) {
      if (!this.active(session) || request !== this._detailRequest || this.sessionError(error)) return;
      this.setData({ caseBusy: false, caseError: readError });
    }
  },

  onRetryCase() {
    if (this.data.caseBusy) return;
    return this.loadCase(this.data.activeCase);
  },

  onReturnToWorkbench() {
    if (this.data.taskSubmitting) return;
    this._detailRequest += 1;
    this._submitRequest += 1;
    this.resetExtra();
    // 离开任务详情：清掉预览文件与已选照片。
    this.closeTaskPreview();
    this._taskPickedFiles = [];
    this.setData({
      view: 'workbench',
      activeCase: '',
      caseDetail: null,
      caseBusy: false,
      caseError: '',
      activeTask: '',
      taskDetail: null,
      taskBusy: false,
      taskError: '',
      taskSummary: '',
      taskSubmitMessage: '',
      taskPhotoCount: 0
    });
  },

  onOpenTask(event) {
    const taskId = dataset(event).task;
    if (!this.can('collaborate') || this.data.submitBusy || this.data.taskBusy || this.data.taskSubmitting ||
        typeof taskId !== 'string') return;
    // 切换任务：清掉上一个任务的已选照片与预览，不把旧图带到新任务。
    this._taskPickedFiles = [];
    this.closeTaskPreview();
    this._receiptArtwork.clear('submitReceipt');
    this.resetExtra();
    this.setData({
      view: 'task',
      submitReceipt: null,
      activeTask: taskId,
      notice: '',
      taskPhotoCount: 0,
      taskSummary: '',
      taskSubmitMessage: ''
    });
    return this.loadTask(taskId);
  },

  async loadTask(taskId) {
    if (!this.can('collaborate')) return;
    const session = this._session;
    const request = ++this._detailRequest;
    this.closeTaskPreview();
    this.setData({ taskDetail: null, taskBusy: true, taskError: '', taskSummary: '', taskSubmitMessage: '' });
    try {
      const result = await fetchCollaboration({
        ...this.apiOptions(), taskId
      });
      if (!this.active(session) || request !== this._detailRequest) return;
      if (result.kind !== 'success') {
        if (result.kind === 'unauthorized' || result.kind === 'forbidden') {
          this.clearSession(result.message);
          return;
        }
        if (result.kind === 'notfound') {
          // 任务已撤回或已移出商户范围，撤下详情并回待办列表。
          this.closeTaskPreview();
          this._taskPickedFiles = [];
          this.setData({
            view: 'workbench',
            activeTask: '',
            taskDetail: null,
            taskBusy: false,
            taskPhotoCount: 0,
            notice: '该协办任务已不在待办中。'
          });
          return this.loadTasks();
        }
        this.setData({ taskBusy: false, taskError: result.message || readError });
        return;
      }
      this.setData({ taskDetail: result.detail, taskBusy: false, taskError: '' });
    } catch (error) {
      if (!this.active(session) || request !== this._detailRequest || this.sessionError(error)) return;
      this.setData({ taskBusy: false, taskError: readError });
    }
  },

  onRetryTask() {
    if (this.data.taskBusy || this.data.taskSubmitting) return;
    return this.loadTask(this.data.activeTask);
  },

  onTaskSummaryInput(event) {
    if (this.data.taskSubmitting) return;
    this.setData({ taskSummary: event.detail.value });
  },

  // 协办送审可选照片：只选本机临时文件，与新诉求的照片分开。
  async onChooseTaskPhotos() {
    if (this.data.taskSubmitting || this.data.taskPhotoChoosing) return;
    if (!this.can('collaborate') || !this.data.taskDetail) return;
    const session = this._session;
    const request = ++this._taskPhotoRequest;
    this.setData({ taskPhotoChoosing: true, taskSubmitMessage: '' });
    try {
      const files = await choosePhotos();
      if (!this.active(session) || request !== this._taskPhotoRequest) return;
      if (files) this._taskPickedFiles = files;
      this.setData({ taskPhotoChoosing: false, taskPhotoCount: this._taskPickedFiles.length });
    } catch (error) {
      if (!this.active(session) || request !== this._taskPhotoRequest) return;
      this.setData({ taskPhotoChoosing: false, taskSubmitMessage: photoMessage(error) });
    }
  },

  onClearTaskPhotos() {
    if (this.data.taskSubmitting || this.data.taskPhotoChoosing) return;
    this._taskPickedFiles = [];
    this.setData({ taskPhotoCount: 0, taskSubmitMessage: '' });
  },

  // 关闭原图预览：清掉预览文件，不留下旧图。
  closeTaskPreview() {
    this._previewRequest += 1;
    this._previewFiles.clear();
    this.setData({ taskPreviewPath: '', taskPreviewBusy: false, taskPreviewError: '', taskPreviewKey: '' });
  },

  onCloseTaskPreview() {
    this.closeTaskPreview();
  },

  // 查看选中的那一项协办原图。只取本任务 submissionPhotos 里的元数据，
  // 按当前配置的服务基址和 Authorization 头读取，并校验类型、大小与签名。
  async onPreviewTaskPhoto(event) {
    const { task: taskId, photo: key } = dataset(event);
    const { taskDetail } = this.data;
    if (!this.can('collaborate') || !taskDetail || taskDetail.taskId !== taskId) return;
    const item = (taskDetail.submissionPhotos || []).find(entry => entry.key === key);
    if (!item) return;
    if (!apiEnvironment().origin) {
      this.setData({ taskPreviewError: invalidEnvironment });
      return;
    }
    this.closeTaskPreview();
    const session = this._session;
    const request = this._previewRequest;
    const current = () => this.active(session) && request === this._previewRequest &&
      this.data.taskDetail && this.data.taskDetail.taskId === taskId;
    this.setData({ taskPreviewBusy: true, taskPreviewKey: item.key, taskPreviewError: '' });
    let result;
    try {
      result = await fetchCollaborationPhoto({
        ...this.apiOptions(),
        taskId,
        submitVersion: item.submitVersion,
        position: item.position
      });
    } catch (error) {
      if (!current()) return;
      this.setData({ taskPreviewBusy: false, taskPreviewError: '原图读取失败，请重试。' });
      return;
    }
    if (!current()) return;
    if (result.kind !== 'success') {
      this.setData({ taskPreviewBusy: false, taskPreviewError: result.message || '原图读取失败，请重试。' });
      if (result.kind === 'unauthorized' || result.kind === 'forbidden') this.clearSession(result.message);
      return;
    }
    let path = '';
    try {
      path = this._previewFiles.write(result.bytes, item, result.header);
    } catch (error) {
      this.setData({ taskPreviewBusy: false, taskPreviewError: photoMessage(error) });
      return;
    }
    // 读取期间任务已切换或会话已结束：立刻清掉刚写的文件，不显示旧图。
    if (!current()) {
      this._previewFiles.remove(path);
      return;
    }
    this.setData({ taskPreviewBusy: false, taskPreviewPath: path, taskPreviewKey: item.key });
  },

  // 协办送审：提交任务版本、文字说明与可选照片。
  async onSubmitTask() {
    const { taskDetail, taskSummary, taskSubmitting } = this.data;
    if (taskSubmitting || this.data.taskPhotoChoosing || !taskDetail ||
        this.data.activeTask !== taskDetail.taskId) return;
    if (!canSubmitTask(taskDetail)) {
      this.setData({ taskSubmitMessage: '该任务当前状态不可送审，请刷新查看。' });
      return;
    }
    const session = this._session;
    const request = ++this._submitRequest;
    const taskId = taskDetail.taskId;
    const current = () => this.active(session) && request === this._submitRequest;
    this.setData({ taskSubmitting: true, taskSubmitMessage: '' });
    // 先读照片。读取或校验失败时请求尚未发出，用户可以就地修正。
    let photos = [];
    if (this._taskPickedFiles.length) {
      try {
        photos = await readPhotos(this._taskPickedFiles);
      } catch (error) {
        if (!current()) return;
        this.setData({ taskSubmitting: false, taskSubmitMessage: photoMessage(error) });
        return;
      }
      if (!current()) return;
    }
    const result = await submitCollaboration({
      ...this.apiOptions(),
      taskId,
      expectedVersion: taskDetail.version,
      summary: taskSummary,
      photos
    });
    if (!current()) return;
    if (result.kind === 'success') {
      this._taskPickedFiles = [];
      this.setData({
        taskSubmitting: false,
        taskDetail: result.detail,
        taskSummary: '',
        taskPhotoCount: 0,
        taskSubmitMessage: '协办说明已送审，等待管理方复核。'
      });
      return this.loadTasks();
    }
    if (result.kind === 'unauthorized' || result.kind === 'forbidden') {
      this.clearSession(result.message);
      return;
    }
    if (['timeout', 'network', 'uncertain', 'conflict', 'notfound'].includes(result.kind)) {
      await this.loadTask(taskId);
      if (!current()) return;
      this.setData({ taskSubmitting: false });
      if (this.data.activeTask === taskId && this.data.taskDetail) {
        this.setData({
          taskSubmitMessage: result.message + '请核对最新任务和送审记录，系统不会自动补发。'
        });
      }
      return;
    }
    this.setData({ taskSubmitting: false, taskSubmitMessage: result.message || '提交未完成，请重试。' });
  },

  // 提交按钮文案：结果未知时只能重试确认。
  submitLabel(pending, requestId) {
    if (pending) return '重试确认';
    if (requestId) return '重试提交';
    return '提交诉求';
  },

  // 新诉求表单：只有具备提交权限的商户可打开。
  onOpenForm() {
    if (!this.can('submitCases')) {
      this.setData({ submitMessage: '当前账号没有提交诉求的权限。' });
      return;
    }
    // 结果未确认时不重置提示，避免掩盖待确认状态。
    if (this.data.submitPending) {
      this.setData({ showForm: true });
      return;
    }
    this.clearReceiptImage('submitReceipt');
    this.setData({
      showForm: true,
      submitMessage: '',
      submitButtonText: this.submitLabel(false, this.data.submitRequestId)
    });
  },

  onCloseForm() {
    if (this.data.submitBusy) return;
    this.clearReceiptImage('submitReceipt');
    this.setData({ showForm: false });
  },

  onFormDateChange(event) {
    if (this.data.submitPending) return;
    this.setData({ formDate: event.detail.value });
  },

  onFormTimeChange(event) {
    if (this.data.submitPending) return;
    this.setData({ formTime: event.detail.value });
  },

  onFormLocationInput(event) {
    if (this.data.submitPending) return;
    this.setData({ formLocation: event.detail.value });
  },

  onFormCategoryInput(event) {
    if (this.data.submitPending) return;
    this.setData({ formCategory: event.detail.value });
  },

  onFormDescriptionInput(event) {
    if (this.data.submitPending) return;
    this.setData({ formDescription: event.detail.value });
  },

  onFormSuggestedDepartmentInput(event) {
    if (this.data.submitPending) return;
    this.setData({ formSuggestedDepartment: event.detail.value });
  },

  onFormContactInput(event) {
    if (this.data.submitPending) return;
    this.setData({ formContact: event.detail.value });
  },

  // 清空重填：放弃当前请求号，重新开始一次申报。
  // 结果未确认时不允许清空，否则可能把已入库的同一事项重复建单。
  onResetForm() {
    if (this.data.submitBusy) return;
    if (this.data.submitPending) {
      this.setData({ submitMessage: '本次提交结果未确认，不能清空重来；请先重试确认原请求。' });
      return;
    }
    this._draft = null;
    // 一并清掉已选照片，重新开始时不带旧的图片。
    this._pickedFiles = [];
    this.clearReceiptImage('submitReceipt');
    this.setData({
      formLocation: '',
      formCategory: '',
      formDescription: '',
      formSuggestedDepartment: '',
      formContact: '',
      submitMessage: '',
      submitRequestId: '',
      submitButtonText: '提交诉求',
      photoCount: 0
    });
  },

  // 同一份内容沿用同一个请求号，内容或照片变化才换新请求号。
  draftFor(content, photoKey) {
    const current = this._draft;
    // 结果未确认时锁定原草稿：请求号与字段都不再变化。
    if (current && current.pending) return { draft: current };
    const probe = normalizeSubmission({ ...content, clientRequestId: 'probe' });
    if (probe.error) return { error: probe.error };
    const same = Boolean(current) &&
      current.occurredAt === probe.content.occurredAt &&
      current.location === probe.content.location &&
      current.category === probe.content.category &&
      current.description === probe.content.description &&
      (current.suggestedDepartment || '') === (probe.content.suggestedDepartment || '') &&
      (current.contact || '') === (probe.content.contact || '') &&
      (current.photoKey || '') === (photoKey || '');
    if (same) return { draft: current };
    // 校验用的占位请求号不进入实际内容。
    const { clientRequestId: _placeholder, ...fields } = probe.content;
    this._requestSeq += 1;
    const draft = { clientRequestId: newClientRequestId(this._requestSeq), photoKey: photoKey || '', ...fields };
    this._draft = draft;
    return { draft };
  },

  // 选择可选照片。只读取本机临时文件，不访问任何网址。
  async onChoosePhotos() {
    if (this.data.submitBusy || this.data.photoChoosing) return;
    // 结果未确认时不得换图，否则重试的内容与首次发出的不一致。
    if (this.data.submitPending) {
      this.setData({ submitMessage: '本次提交结果未确认，不能更换照片；请先重试确认原请求。' });
      return;
    }
    if (!this.can('submitCases')) {
      this.setData({ submitMessage: '当前账号没有提交诉求的权限。' });
      return;
    }
    const session = this._session;
    const request = ++this._photoRequest;
    this.setData({ photoChoosing: true, submitMessage: '' });
    try {
      const files = await choosePhotos();
      if (!this.active(session) || request !== this._photoRequest) return;
      if (files) this._pickedFiles = files;
      this.setData({
        photoChoosing: false,
        photoCount: this._pickedFiles.length,
        submitMessage: ''
      });
    } catch (error) {
      if (!this.active(session) || request !== this._photoRequest) return;
      this.setData({ photoChoosing: false, submitMessage: photoMessage(error) });
    }
  },

  // 清除已选照片。结果未确认时不允许清除。
  onClearPhotos() {
    if (this.data.submitBusy || this.data.photoChoosing) return;
    if (this.data.submitPending) {
      this.setData({ submitMessage: '本次提交结果未确认，不能清除照片；请先重试确认原请求。' });
      return;
    }
    this._pickedFiles = [];
    this.setData({ photoCount: 0, submitMessage: '' });
  },

  // 提交一条新的商户诉求。照片为可选，与正文一次提交。
  async onSubmitNewCase() {
    if (this.data.view !== 'workbench' || this.data.submitBusy || this.data.receiptBusy) return;
    if (!this.can('submitCases')) {
      this.setData({ submitMessage: '当前账号没有提交诉求的权限。' });
      return;
    }
    if (!apiEnvironment().origin) {
      this.setData({ submitMessage: invalidEnvironment });
      return;
    }
    const session = this._session;
    // 新诉求与协办送审各自计数，互不作废对方的在途请求。
    const request = ++this._submitCaseRequest;
    this._receiptArtwork.clear('submitReceipt');
    this.setData({ submitBusy: true, submitMessage: '', submitReceipt: null });

    // 结果未确认后的重试：原样重发首次实际发出的字节，不重读文件、不换请求号。
    const frozen = this._frozen;
    if (frozen) {
      this.setData({ submitRequestId: frozen.requestId });
      const retry = await submitMerchantCase({
        ...this.apiOptions(),
        prepared: { body: frozen.body, contentType: frozen.contentType, requestId: frozen.requestId }
      });
      if (!this.active(session) || request !== this._submitCaseRequest) return;
      return this.applySubmitResult(retry, frozen);
    }
    // 锁定状态但没有可重发的字节：只能先核对工单，不能改内容另发。
    if (this.data.submitPending) {
      this.setData({
        submitBusy: false,
        submitMessage: '本次提交结果未确认，且原请求内容已不可重发；请先在本商户工单列表核对是否已有同一事项。'
      });
      return;
    }

    // 首次提交：先读照片。读取或校验失败时请求尚未发出，用户可以就地修正。
    let photos = [];
    if (this._pickedFiles.length) {
      try {
        photos = await readPhotos(this._pickedFiles);
      } catch (error) {
        if (!this.active(session) || request !== this._submitCaseRequest) return;
        this.setData({ submitBusy: false, submitMessage: photoMessage(error) });
        return;
      }
      if (!this.active(session) || request !== this._submitCaseRequest) return;
    }

    const prepared = this.draftFor({
      occurredAt: `${this.data.formDate}T${this.data.formTime}:00+08:00`,
      location: this.data.formLocation,
      category: this.data.formCategory,
      description: this.data.formDescription,
      suggestedDepartment: this.data.formSuggestedDepartment,
      contact: this.data.formContact
    }, photoFingerprint(photos));
    if (prepared.error) {
      this.setData({ submitBusy: false, submitMessage: prepared.error });
      return;
    }
    const draft = prepared.draft;
    this.setData({ submitRequestId: draft.clientRequestId });
    const result = await submitMerchantCase({
      ...this.apiOptions(), submission: { ...draft, photos }
    });
    if (!this.active(session) || request !== this._submitCaseRequest) return;
    return this.applySubmitResult(result, null);
  },

  // 处理一次提交结果。frozen 非空表示这是冻结后的重试。
  async applySubmitResult(result, frozen) {
    if (result.kind === 'success') {
      // 提交成功后清空表单与草稿，才能开始下一次申报。
      this._draft = null;
      this._frozen = null;
      this._pickedFiles = [];
      this.setData({
        submitBusy: false,
        submitPending: false,
        submitMessage: result.created ? '诉求已提交。' : '该请求号此前已提交，已返回原工单。',
        submitReceipt: this._receiptArtwork.present('submitReceipt', result.receipt, result.wechatCode),
        submitRequestId: '',
        submitButtonText: '提交诉求',
        photoCount: 0,
        formLocation: '',
        formCategory: '',
        formDescription: '',
        formSuggestedDepartment: '',
        formContact: ''
      });
      if (this.can('readCases')) return this.loadCases();
      return;
    }
    if (result.kind === 'unauthorized') {
      this.setData({ submitBusy: false, submitPending: false });
      this.clearSession(result.message);
      return;
    }
    if (result.kind === 'forbidden' || result.kind === 'invalid') {
      // 服务端明确拒绝，没有建单：解除锁定，冻结的字节不再有效，修正后可重新提交。
      if (this._draft) this._draft.pending = false;
      this._frozen = null;
      this.setData({
        submitBusy: false,
        submitPending: false,
        submitMessage: result.message,
        submitButtonText: this.submitLabel(false, this._draft ? this._draft.clientRequestId : '')
      });
      return;
    }
    // 结果未知（超时、断网、409）：锁定本次申报，保留原请求号、原字段与
    // 首次实际发出的照片字节，只能原样重试；确认成功后才可开始新的申报。
    if (this._draft) this._draft.pending = true;
    if (!frozen && result.sent && result.sent.body) {
      // 记下本次实际发出的字节，重试时原样重发。
      this._frozen = {
        body: result.sent.body,
        contentType: result.sent.contentType,
        requestId: result.sent.requestId
      };
    }
    this.setData({
      submitBusy: false,
      submitPending: true,
      submitMessage: result.message,
      submitRequestId: this._frozen ? this._frozen.requestId : this.data.submitRequestId,
      submitButtonText: this.submitLabel(true, this.data.submitRequestId)
    });
  }
});

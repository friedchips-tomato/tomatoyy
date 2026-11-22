const config = require('../../config');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const { invalidEnvironment, clearWechatSession, activeSession, loginWithWechat } = require('../../wechat-session');
const {
  identity, canView, allowedActions, caseRow, detailView, actionPayload,
  actionRule, canEditAction, queues, statusOptions, casePattern, safeId, timeLabel
} = require('./workbench');
const { canAssignCollaboration, reviewActions, taskView, collaborationPayload, canViewTaskPhotos } = require('./collaborations');
const { beijingMonth, validReportMonth, reportView } = require('./monthly-report');
const { emptySupervision, emptyLedger, supervisionMethods, ledgerMethods, conclusionLabels } = require('./supervision');
const {
  choosePhotos, multipartPhotos, photoMessage, submissionPhotos, supplementPhotos, createPreviewFiles, retryPreviewCleanup
} = require('./photos');

const caseEndpoint = '/api/v1/staff/cases';
const allQueues = [{ id: '', label: '全部工单' }].concat(queues);
const readError = '读取失败，请重试。';
const contactWindowMs = 30_000;
const emptyContact = () => ({ contact: null, contactReady: false, contactBusy: false, contactError: '' });
const taskPath = caseNumber => caseEndpoint + '/' + caseNumber + '/collaborations';
const emptyPreview = () => ({ previewPath: '', previewBusy: false, previewError: '', previewTaskId: '', previewLabel: '' });
const emptyReport = () => ({ reportMonth: '', reportMaxMonth: '', reportBusy: false, reportError: '', report: null });

function emptyCollaborations() {
  return {
    collaborations: [], collaborationBusy: false, collaborationReady: false, collaborationError: '',
    canAssignCollaboration: false, collaborationEditor: null
  };
}

function initialData() {
  const { localEnabled, wechatEnabled } = apiEnvironment();
  return {
    view: 'login', localEnabled, wechatEnabled,
    loginKeys: [0], loginBusy: false, loginError: '', staff: null,
    queues: allQueues, statusOptions, queue: '', statusIndex: 0,
    counts: null, countError: '', countBusy: false, dueSoonHours: null, asOfLabel: '',
    items: [], nextBefore: '', listBusy: false, listError: '', listReady: false,
    activeCase: '', detail: null, detailBusy: false, detailError: '', availableActions: [],
    ...emptyContact(),
    ...emptySupervision(), ...emptyLedger(), conclusionLabels,
    submissionPhotos: [], supplementPhotos: [], canPublishFeedbackPhotos: false, ...emptyPreview(),
    ...emptyReport(),
    editor: null, saving: false, recovering: false, recoveryBusy: false, notice: '',
    ...emptyCollaborations()
  };
}

const dataset = event => event.currentTarget.dataset;

Page({
  data: initialData(),
  ...supervisionMethods,
  ...ledgerMethods,

  onLoad() {
    this._alive = true;
    this._session = 0;
    this._listRequest = 0;
    this._detailRequest = 0;
    this._countRequest = 0;
    this._editorRequest = 0;
    this._collaborationRequest = 0;
    this._previewRequest = 0;
    this._contactRequest = 0;
    this._supervisionRequest = 0;
    this._ledgerRequest = 0;
    this._pickedFiles = [];
    this._previewFiles = createPreviewFiles();
    retryPreviewCleanup();
    this._token = '';
    this._reportRequest = 0;
    this.setData(initialData());
  },

  clearSession(message) {
    this._session++;
    this._token = '';
    clearWechatSession(this);
    this.clearContact();
    this.resetSupervision();
    this.resetLedger();
    this.clearMedia();
    this.setData({
      ...initialData(), loginKeys: [this.data.loginKeys[0] + 1], loginError: message || ''
    });
  },

  onUnload() {
    this._alive = false;
    this.clearSession('');
  },

  onHide() {
    if (this._alive) this.clearSession('');
  },

  onLogout() {
    this.clearSession('');
  },

  onExit() {
    this.clearSession('');
    wx.navigateBack({ delta: 1 });
  },

  active(session) {
    return activeSession(this, session);
  },

  request(path, method = 'GET', data, successStatus = 200, options = {}) {
    if (!this.active(this._session) || !this._token) return Promise.reject({ kind: 'inactive_session' });
    const { origin } = apiEnvironment();
    if (!origin) return Promise.reject({ kind: 'local_disabled' });
    return new Promise((resolve, reject) => {
      requestConfigured({
        url: origin + path,
        method,
        data,
        timeout: config.requestTimeout,
        header: { Authorization: 'Bearer ' + this._token, 'Content-Type': options.contentType || 'application/json' },
        ...(options.binary ? { responseType: 'arraybuffer', dataType: 'text' } : {}),
        success: response => {
          if (response.statusCode === successStatus && response.data && typeof response.data === 'object') {
            resolve(options.binary ? response : response.data);
          } else {
            reject({ status: response.statusCode });
          }
        },
        fail: () => reject({ kind: 'network' })
      });
    });
  },

  sessionError(error) {
    if (error.kind === 'local_disabled') {
      this.clearSession(invalidEnvironment);
      return true;
    }
    if (error.status === 401 || error.status === 403) {
      this.clearSession('当前工作人员凭据无效或权限已变更，请重新核验。');
      return true;
    }
    return false;
  },

  async onLoginSubmit(event) {
    if (!this._alive || this.data.loginBusy || this.data.view !== 'login') return;
    const value = event.detail.value.token;
    const token = typeof value === 'string' ? value.trim() : '';
    this.setData({ loginKeys: [this.data.loginKeys[0] + 1], loginError: '' });
    if (!apiEnvironment().localEnabled) {
      this.clearSession(invalidEnvironment);
      return;
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      this.setData({ loginError: '请输入有效格式的本地工作人员令牌。' });
      return;
    }
    const session = ++this._session;
    this._token = token;
    this.setData({ loginBusy: true });
    return this.finishLogin(session);
  },

  onWechatLogin() {
    return loginWithWechat(this, 'staff');
  },

  async finishLogin(session) {
    try {
      const staff = identity(await this.request('/api/v1/staff/me'));
      if (!this.active(session)) return;
      if (!staff) {
        this.clearSession('未能确认工作人员身份。');
        return;
      }
      this.setData({ staff, loginBusy: false, view: 'workbench' });
      return this.refreshOverview();
    } catch (error) {
      if (!this.active(session) || this.sessionError(error)) return;
      this.clearSession('无法完成核验，请检查服务后重试。');
    }
  },

  refreshOverview() {
    if (!this.active(this._session) || !this._token) return;
    return Promise.all([this.loadCounts(), this.loadList()]);
  },

  onOpenMonthlyReport() {
    if (this.data.view !== 'workbench' || this.data.staff?.role !== 'duty' || !this._token) return;
    const month = beijingMonth();
    this.setData({ view: 'report', notice: '', reportMaxMonth: month });
    return this.loadMonthlyReport(month);
  },

  onCloseMonthlyReport() {
    if (this.data.view !== 'report') return;
    this._reportRequest++;
    this.setData({ ...emptyReport(), view: 'workbench' });
  },

  onReportMonthChange(event) {
    return this.loadMonthlyReport(event.detail.value);
  },

  onRetryMonthlyReport() {
    if (!this.data.reportBusy) return this.loadMonthlyReport(this.data.reportMonth);
  },

  async loadMonthlyReport(month) {
    if (this.data.view !== 'report' || this.data.staff?.role !== 'duty' || !this._token) return;
    const request = ++this._reportRequest;
    const session = this._session;
    if (!validReportMonth(month, beijingMonth())) {
      this.setData({ reportBusy: false, report: null, reportError: '请选择当前或过去的合法统计月。' });
      return;
    }
    const current = () => this.active(session) && request === this._reportRequest && this.data.view === 'report';
    this.setData({ reportMonth: month, reportBusy: true, reportError: '', report: null });
    try {
      const result = await this.request('/api/v1/staff/monthly-report?month=' + encodeURIComponent(month));
      if (!current()) return;
      this.setData({ reportBusy: false, report: reportView(result, month) });
    } catch (error) {
      if (!current() || this.sessionError(error)) return;
      this.setData({ reportBusy: false, reportError: '月报读取失败，请重试。' });
    }
  },

  onRefreshOverview() {
    if (!this._token || this.data.view !== 'workbench') return;
    this.setData({ notice: '' });
    return this.refreshOverview();
  },

  async loadCounts() {
    const session = this._session;
    const request = ++this._countRequest;
    this.setData({ countBusy: true, countError: '' });
    try {
      const result = await this.request('/api/v1/staff/workbench');
      if (!this.active(session) || request !== this._countRequest) return;
      if (!result.counts || queues.some(queue => !Number.isInteger(result.counts[queue.id]) || result.counts[queue.id] < 0)) {
        throw new Error('Invalid workbench counts');
      }
      const counts = {};
      for (const queue of queues) counts[queue.id] = result.counts[queue.id];
      this.setData({ counts, dueSoonHours: result.dueSoonSeconds / 3600, asOfLabel: timeLabel(result.asOf), countBusy: false });
    } catch (error) {
      if (!this.active(session) || request !== this._countRequest || this.sessionError(error)) return;
      this.setData({ counts: null, asOfLabel: '', countBusy: false, countError: readError });
    }
  },

  async loadList(append = false) {
    const { queue, statusIndex, nextBefore, staff } = this.data;
    if (append && (!nextBefore || this.data.listBusy)) return;
    const session = this._session;
    const request = ++this._listRequest;
    const status = statusOptions[statusIndex].id;
    const params = ['limit=20'];
    if (queue) params.push('queue=' + encodeURIComponent(queue));
    if (status) params.push('status=' + encodeURIComponent(status));
    if (append) params.push('before=' + encodeURIComponent(nextBefore));
    this.setData({
      listBusy: true, listError: '',
      ...(append ? {} : { items: [], nextBefore: '', listReady: false })
    });
    try {
      const result = await this.request(caseEndpoint + '?' + params.join('&'));
      if (!this.active(session) || request !== this._listRequest) return;
      if (!Array.isArray(result.items)) throw new Error('Invalid case list');
      const items = append ? this.data.items.slice() : [];
      const known = new Set(items.map(item => item.caseNumber));
      for (const item of result.items) {
        if (item && typeof item.caseNumber === 'string' && casePattern.test(item.caseNumber) &&
            canView(staff, item) && !known.has(item.caseNumber)) {
          items.push(caseRow(item));
          known.add(item.caseNumber);
        }
      }
      const next = typeof result.nextBefore === 'string' && casePattern.test(result.nextBefore) &&
        known.has(result.nextBefore) && (!append || result.nextBefore !== nextBefore) ? result.nextBefore : '';
      this.setData({ items, nextBefore: next, listBusy: false, listReady: true });
    } catch (error) {
      if (!this.active(session) || request !== this._listRequest || this.sessionError(error)) return;
      if (append && error.status === 400) {
        this.setData({ notice: '列表范围已变化，已重新读取第一页。' });
        return this.loadList();
      }
      this.setData({ listBusy: false, listError: readError });
    }
  },

  onQueueTap(event) {
    const queue = dataset(event).queue;
    if (this.data.view !== 'workbench' || !allQueues.some(entry => entry.id === queue)) return;
    this.setData({ queue, statusIndex: 0, notice: '' });
    return this.loadList();
  },

  onStatusChange(event) {
    const statusIndex = Number(event.detail.value);
    if (this.data.view !== 'workbench' || !Number.isInteger(statusIndex) || !statusOptions[statusIndex]) return;
    this.setData({ statusIndex, notice: '' });
    return this.loadList();
  },

  onLoadMore() {
    if (this.data.view === 'workbench') return this.loadList(true);
  },

  onOpenCase(event) {
    const caseNumber = dataset(event).case;
    if (!this._token || !['workbench', 'detail'].includes(this.data.view) || this.writesBlocked() ||
        typeof caseNumber !== 'string' || !casePattern.test(caseNumber)) return;
    this.clearContact();
    this.setData({ view: 'detail', activeCase: caseNumber, notice: '' });
    return this.loadDetail();
  },

  onReturnToList() {
    if (this.writesBlocked() || !this._token) return;
    this.resetDetailToList();
  },

  resetDetailToList() {
    this._detailRequest++;
    this._editorRequest++;
    this._collaborationRequest++;
    this.clearContact();
    this.resetSupervision();
    this.clearMedia();
    this.setData({
      view: 'workbench', activeCase: '', detail: null, detailBusy: false, detailError: '',
      editor: null, availableActions: [], recovering: false, recoveryBusy: false, notice: '',
      submissionPhotos: [], supplementPhotos: [], canPublishFeedbackPhotos: false, saving: false, ...emptyPreview(),
      ...emptyCollaborations()
    });
  },

  caseUnavailable() {
    this.resetDetailToList();
    this.setData({ counts: null, items: [], nextBefore: '', notice: '该工单已不在当前权限范围内。' });
    return this.refreshOverview();
  },

  showDetail(value) {
    this.clearContact();
    this.resetSupervision();
    this.clearMedia();
    const detail = detailView(value);
    const { staff } = this.data;
    this.setData({
      detail, availableActions: allowedActions(staff, detail),
      submissionPhotos: submissionPhotos(staff, detail, value.submissionPhotos),
      supplementPhotos: staff && canView(staff, detail) ? supplementPhotos(detail, value.supplementPhotos) : [],
      canPublishFeedbackPhotos: canEditAction(staff, detail, 'publish_photos'), ...emptyPreview(),
      detailBusy: false, detailError: '', editor: null
    });
  },

  async loadDetail() {
    const caseNumber = this.data.activeCase;
    if (!this._token || !caseNumber) return;
    const session = this._session;
    const request = ++this._detailRequest;
    this._editorRequest++;
    this._collaborationRequest++;
    this.clearContact();
    this.resetSupervision();
    this.clearMedia();
    this.setData({
      detail: null, detailBusy: true, detailError: '', availableActions: [], editor: null,
      submissionPhotos: [], supplementPhotos: [], canPublishFeedbackPhotos: false, ...emptyPreview(),
      ...emptyCollaborations()
    });
    try {
      const value = await this.request(caseEndpoint + '/' + caseNumber);
      if (!this.active(session) || request !== this._detailRequest) return;
      if (value.caseNumber !== caseNumber || !canView(this.data.staff, value)) return this.caseUnavailable();
      if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('Invalid case version');
      this.showDetail(value);
      return this.loadCollaborations(caseNumber);
    } catch (error) {
      if (!this.active(session) || request !== this._detailRequest || this.sessionError(error)) return;
      if (error.status === 404) return this.caseUnavailable();
      this.setData({ detailBusy: false, detailError: readError });
    }
  },

  onRetryDetail() {
    if (this.data.saving || this.data.recoveryBusy) return;
    if (this.data.recovering) return this.readBack();
    return this.loadDetail();
  },

  clearContact() {
    this._contactRequest++;
    clearTimeout(this._contactTimer);
    this._contactTimer = null;
    this.setData(emptyContact());
  },

  onHideContact() {
    this.clearContact();
  },

  async onReadContact() {
    const { staff, detail, activeCase, view, contactBusy, contactReady } = this.data;
    const session = this._session;
    if (!this.active(session) || !this._token || view !== 'detail' || staff?.readContact !== true ||
        !detail || detail.caseNumber !== activeCase || !casePattern.test(activeCase) || !canView(staff, detail) ||
        this.writesBlocked() || contactBusy || contactReady) return;
    const request = ++this._contactRequest;
    const { origin } = apiEnvironment();
    const current = () => this.active(session) && request === this._contactRequest &&
      this.data.view === 'detail' && this.data.activeCase === activeCase && this.data.staff?.readContact === true;
    const deadline = Date.now() + contactWindowMs;
    this.setData({ ...emptyContact(), contactBusy: true });
    this._contactTimer = setTimeout(() => {
      if (request === this._contactRequest) this.clearContact();
    }, contactWindowMs);
    try {
      const { contact } = await this.request(caseEndpoint + '/' + activeCase + '/contact');
      if (!current()) return;
      if (Date.now() >= deadline || origin !== apiEnvironment().origin) return this.clearContact();
      if (contact !== null && (typeof contact !== 'string' || !contact.trim() || Array.from(contact).length > 300)) {
        throw new Error('Invalid contact response');
      }
      this.setData({ contact, contactReady: true, contactBusy: false });
    } catch (error) {
      if (!current()) return;
      this.clearContact();
      if (this.sessionError(error)) return;
      if (error.status === 404) return this.caseUnavailable();
      this.setData({ contactError: '联系方式读取失败，请重试。' });
    }
  },

  async loadCollaborations(caseNumber) {
    const session = this._session;
    const request = ++this._collaborationRequest;
    this.onClosePhotoPreview();
    this.setData({ ...emptyCollaborations(), collaborationBusy: true });
    try {
      const result = await this.request(taskPath(caseNumber));
      if (!this.active(session) || request !== this._collaborationRequest) return false;
      if (!Array.isArray(result.items)) throw new Error('Invalid collaboration list');
      const { staff, detail } = this.data;
      this.setData({
        collaborations: result.items.map(task => taskView(task, staff, detail)),
        collaborationReady: true, collaborationBusy: false,
        canAssignCollaboration: canAssignCollaboration(staff, detail)
      });
      return true;
    } catch (error) {
      if (!this.active(session) || request !== this._collaborationRequest || this.sessionError(error)) return false;
      if (error.status === 404) {
        await this.caseUnavailable();
        return false;
      }
      this.setData({ collaborationBusy: false, collaborationError: '协办记录读取失败，请重试。' });
      return false;
    }
  },

  writesBlocked() {
    return this.data.saving || this.data.recovering;
  },

  async readBack() {
    const session = this._session;
    const caseNumber = this.data.activeCase;
    this.setData({ recoveryBusy: true });
    const loaded = await this.loadDetail();
    if (!this.active(session) || this.data.activeCase !== caseNumber) return;
    this.setData({
      recoveryBusy: false, recovering: !loaded,
      notice: loaded ? '已重新读取工单和协办。请核对结果后再操作。系统未重发操作。' :
        '仍需读回工单和协办才能继续办理。系统未重发操作。'
    });
  },

  async onActionTap(event) {
    return this.openAction(dataset(event).action);
  },

  onOpenFeedbackPublisher() {
    return this.openAction('publish_photos');
  },

  async openAction(action) {
    if (this.writesBlocked() || !this.data.collaborationReady ||
        !canEditAction(this.data.staff, this.data.detail, action)) return;
    const rule = actionRule(action);
    const request = ++this._editorRequest;
    const session = this._session;
    this._pickedFiles = [];
    const editor = {
      action, label: rule.label, needsAssignee: !!rule.assignee, needsReason: !!rule.reason,
      needsSummary: !!rule.summary, needsPhotoReason: !!rule.photoReason, needsNextStatus: !!rule.nextStatus,
      reason: '', summary: '', photoReason: '', continueProcessing: false,
      photoCount: 0, photoChoosing: false, derivativesReviewed: false,
      people: [], peopleLabels: [], personIndex: -1, pending: !!rule.assignee, error: '',
      date: timeLabel(new Date().toISOString()).slice(0, 10), time: ''
    };
    this.setData({ editor, collaborationEditor: null, notice: '' });
    if (!rule.assignee) return;
    try {
      const result = await this.request('/api/v1/staff/assignees');
      if (!this.active(session) || request !== this._editorRequest) return;
      if (!Array.isArray(result.items)) throw new Error('Invalid assignee directory');
      const staff = this.data.staff;
      const people = result.items.filter(item => item && typeof item.id === 'string' && typeof item.department === 'string' &&
        safeId.test(item.id) && safeId.test(item.department) &&
        (staff.role === 'duty' || item.department === staff.department))
        .map(({ id, department }) => ({ id, department, label: id + ' · ' + department }));
      this.setData({ editor: {
        ...this.data.editor, people, peopleLabels: ['请选择承办人'].concat(people.map(person => person.label)), pending: false,
        error: people.length ? '' : '暂无可派承办人，请核对本地工作人员配置。'
      } });
    } catch (error) {
      if (!this.active(session) || request !== this._editorRequest || this.sessionError(error)) return;
      this.setData({ editor: { ...this.data.editor, pending: false, error: '承办人目录读取失败，请重试。' } });
    }
  },

  onCancelAction() {
    if (this.writesBlocked()) return;
    this._editorRequest++;
    this._pickedFiles = [];
    this.setData({ editor: null });
  },

  onEditorChange(event) {
    const { editor } = this.data;
    const field = dataset(event).field;
    if (!editor || this.writesBlocked() ||
        !['personIndex', 'date', 'time', 'summary', 'reason', 'photoReason', 'continueProcessing', 'derivativesReviewed'].includes(field)) return;
    const value = field === 'personIndex' ? Number(event.detail.value) - 1 : event.detail.value;
    this.setData({ editor: { ...editor, error: '', [field]: value } });
  },

  onActionSubmit() {
    const { detail, editor, staff } = this.data;
    if (this.writesBlocked() || !this.data.collaborationReady || !detail || !editor || editor.pending || editor.photoChoosing ||
        !canEditAction(staff, detail, editor.action)) return;
    const result = actionPayload(editor, detail);
    if (result.error) {
      this.setData({ editor: { ...editor, error: result.error } });
      return;
    }
    const selected = this._pickedFiles.slice();
    const prepare = editor.photoCount
      ? current => multipartPhotos(result.body, selected, editor.action === 'publish_photos', current)
      : null;
    return this.writeAction(caseEndpoint + '/' + detail.caseNumber + '/actions', result.body, 200, value => {
      if (value.caseNumber !== detail.caseNumber || !canView(staff, value)) return this.caseUnavailable();
      if (!Number.isSafeInteger(value.version) || value.version <= detail.version) throw new Error('Invalid action response version');
      this.showDetail(value);
      return Promise.all([this.loadCollaborations(detail.caseNumber), this.refreshOverview()]);
    }, 'editor', prepare);
  },

  async onChoosePhotos() {
    const { editor, detail } = this.data;
    if (this.writesBlocked() || !editor || editor.photoChoosing ||
        !['submit_result', 'publish_photos'].includes(editor.action)) return;
    const session = this._session;
    const request = ++this._editorRequest;
    const current = () => this.active(session) && request === this._editorRequest && this.data.activeCase === detail.caseNumber;
    this.setData({ editor: { ...editor, photoChoosing: true, error: '' } });
    try {
      const files = await choosePhotos(editor.action === 'publish_photos');
      if (!current()) return;
      if (files) this._pickedFiles = files;
      this.setData({ editor: {
        ...this.data.editor, photoChoosing: false, photoCount: this._pickedFiles.length,
        derivativesReviewed: files ? false : this.data.editor.derivativesReviewed
      } });
    } catch (error) {
      if (!current()) return;
      this.setData({ editor: { ...this.data.editor, photoChoosing: false, error: photoMessage(error) } });
    }
  },

  onClearPickedPhotos() {
    const { editor } = this.data;
    if (!editor || this.writesBlocked() || editor.photoChoosing) return;
    this._pickedFiles = [];
    this.setData({ editor: { ...editor, photoCount: 0, derivativesReviewed: false, error: '' } });
  },

  clearMedia() {
    this._pickedFiles = [];
    this._previewRequest++;
    this._previewFiles.clear();
  },

  onClosePhotoPreview() {
    this._previewRequest++;
    this._previewFiles.clear();
    this.setData(emptyPreview());
  },

  onPhotoPreviewError(event) {
    if (dataset(event).path !== this.data.previewPath) return;
    const { previewTaskId, previewLabel } = this.data;
    this.onClosePhotoPreview();
    this.setData({ previewTaskId, previewLabel, previewError: '原图预览失败，可重新读取。' });
  },

  onPreviewOriginal(event) {
    const { detail, staff } = this.data;
    const photo = this.data.submissionPhotos.find(item => item.key === dataset(event).photo);
    if (this.writesBlocked() || !this._token || !detail || !staff || !photo || !canView(staff, detail) ||
        !['handler', 'supervisor'].includes(staff.role)) return;
    return this.openPhotoPreview(detail.caseNumber, caseEndpoint + '/' + detail.caseNumber + '/submission-photos/' + photo.key, photo);
  },

  onPreviewCollaborationPhoto(event) {
    const { task: taskId, photo: key } = dataset(event);
    const { detail, staff, collaborations, collaborationReady } = this.data;
    const task = collaborations.find(item => item.taskId === taskId);
    if (this.writesBlocked() || !this._token || !collaborationReady || !canViewTaskPhotos(staff, detail, task)) return;
    const photo = task.submissionPhotos.find(item => item.key === key);
    if (!photo) return;
    return this.openPhotoPreview(detail.caseNumber, taskPath(detail.caseNumber) + '/' + task.taskId +
      '/submission-photos/' + photo.key, photo, task.taskId);
  },

  onPreviewSupplementPhoto(event) {
    const { detail, staff, activeCase } = this.data;
    const photo = this.data.supplementPhotos.find(item => item.key === dataset(event).photo);
    if (this.writesBlocked() || !this._token || !detail || detail.caseNumber !== activeCase || !photo ||
        !canView(staff, detail)) return;
    return this.openPhotoPreview(activeCase, caseEndpoint + '/' + activeCase + '/supplement-photos/' + photo.key,
      photo, '', '补件原图');
  },

  async openPhotoPreview(caseNumber, path, photo, taskId = '', previewLabel = '送审原图') {
    this.onClosePhotoPreview();
    const session = this._session;
    const request = this._previewRequest;
    const current = () => this.active(session) && request === this._previewRequest && this.data.activeCase === caseNumber;
    this.setData({ previewBusy: true, previewTaskId: taskId, previewLabel });
    try {
      const response = await this.request(path, 'GET', undefined, 200, { binary: true });
      if (!current()) return;
      const previewPath = this._previewFiles.write(response.data, photo, response.header);
      this.setData({ previewBusy: false, previewPath });
    } catch (error) {
      if (!current() || this.sessionError(error)) return;
      if (error.status === 404) {
        if (previewLabel === '补件原图') return this.loadDetail();
        if (!taskId) return this.caseUnavailable();
        this.setData({ notice: '协办原图已不可读，正在刷新工单与任务。' });
        return this.loadDetail();
      }
      this.onClosePhotoPreview();
      this.setData({ previewTaskId: taskId, previewLabel, previewError: '原图读取失败，请重试。' });
    }
  },

  onAssignCollaboration() {
    const { staff, detail, collaborationReady } = this.data;
    if (this.writesBlocked() || !collaborationReady || !canAssignCollaboration(staff, detail)) return;
    this._editorRequest++;
    this._pickedFiles = [];
    this.setData({
      editor: null, notice: '',
      collaborationEditor: {
        action: 'assign', label: '派发协办', merchantId: '', instructions: '', location: '',
        date: timeLabel(new Date().toISOString()).slice(0, 10), time: '', error: ''
      }
    });
  },

  onReviewCollaboration(event) {
    const { action, task: taskId } = dataset(event);
    const { staff, detail, collaborations, collaborationReady } = this.data;
    if (this.writesBlocked() || !collaborationReady) return;
    const task = collaborations.find(item => item.taskId === taskId);
    const option = reviewActions(staff, detail, task).find(item => item.id === action);
    if (!option) return;
    this._editorRequest++;
    this._pickedFiles = [];
    this.setData({
      editor: null, notice: '',
      collaborationEditor: { action, taskId, label: option.label, merchantId: task.merchantId, reason: '', error: '' }
    });
  },

  onCollaborationInput(event) {
    const editor = this.data.collaborationEditor;
    const field = dataset(event).field;
    if (!editor || this.writesBlocked() ||
        !['merchantId', 'instructions', 'location', 'date', 'time', 'reason'].includes(field)) return;
    this.setData({ collaborationEditor: { ...editor, [field]: event.detail.value, error: '' } });
  },

  onCancelCollaboration() {
    if (!this.writesBlocked()) this.setData({ collaborationEditor: null });
  },

  onSubmitCollaboration() {
    const { staff, detail, collaborationEditor: editor, collaborations, collaborationReady } = this.data;
    if (this.writesBlocked() || !detail || !editor || !collaborationReady) return;
    const assign = editor.action === 'assign';
    const task = collaborations.find(item => item.taskId === editor.taskId);
    if (assign ? !canAssignCollaboration(staff, detail) :
      !reviewActions(staff, detail, task).some(item => item.id === editor.action)) return;
    const result = collaborationPayload(editor, detail, task);
    if (result.error) {
      this.setData({ collaborationEditor: { ...editor, error: result.error } });
      return;
    }
    const endpoint = taskPath(detail.caseNumber);
    const path = assign ? endpoint : endpoint + '/' + task.taskId + '/actions';
    return this.writeAction(path, result.body, assign ? 201 : 200, value => {
      const updated = taskView(value, staff, detail);
      if (updated.round !== detail.round ||
          (assign ? value.caseVersion !== detail.version + 1 || updated.version !== 1 ||
              collaborations.some(item => item.taskId === updated.taskId) :
            updated.taskId !== task.taskId || updated.version !== task.version + 1)) {
        throw new Error('Invalid collaboration write response');
      }
      this.setData({
        detail: assign ? { ...detail, version: value.caseVersion } : detail,
        collaborations: assign ? collaborations.concat(updated) :
          collaborations.map(item => item.taskId === updated.taskId ? updated : item),
        collaborationEditor: null
      });
    }, 'collaborationEditor');
  },

  async writeAction(path, body, status, applyResult, editorKey, prepare) {
    const session = this._session;
    const detailRequest = this._detailRequest;
    const activeCase = this.data.activeCase;
    const current = () => this.active(session) && detailRequest === this._detailRequest && this.data.activeCase === activeCase;
    this.clearContact();
    this.onClosePhotoPreview();
    this.setData({ saving: true, notice: '' });
    let options;
    if (prepare) {
      try {
        options = await prepare(current);
        if (!current() || !options) return;
        body = options.data;
      } catch (error) {
        if (!current()) return;
        this.setData({ saving: false, editor: { ...this.data.editor, error: photoMessage(error) } });
        return;
      }
    }
    try {
      const value = await this.request(path, 'POST', body, status, options);
      if (!current()) return;
      this.setData({ saving: false, notice: '操作已完成。' });
      return applyResult(value);
    } catch (error) {
      if (!current() || this.sessionError(error)) return;
      this.setData({ saving: false });
      if (error.status === 404 && editorKey === 'editor') return this.caseUnavailable();
      if (!error.status || [404, 408, 409].includes(error.status) || error.status >= 500 ||
          (error.status >= 200 && error.status < 300)) {
        this.setData({
          recovering: true, editor: null, collaborationEditor: null,
          notice: '正在读回工单和协办，请核对结果。系统未重发操作。'
        });
        return Promise.all([this.readBack(), this.refreshOverview()]);
      }
      this.setData({
        [editorKey]: {
          ...this.data[editorKey],
          error: editorKey === 'collaborationEditor' ?
            '协办操作未提交，请核对所填内容、商户编号与当前权限。' :
            '操作未提交，请核对所填内容与当前权限。'
        }
      });
    }
  }
});

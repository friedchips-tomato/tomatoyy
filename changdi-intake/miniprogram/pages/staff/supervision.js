const { canView, casePattern, futureDeadline, timeLabel } = require('./workbench');

const casePaths = '/api/v1/staff/cases/';
const ledgerPath = '/api/v1/staff/remediation';
const conclusions = ['follow_up', 'resolved'];
const conclusionLabels = ['继续整改', '复查通过'];
const statuses = { open: '待复查', follow_up: '继续整改', resolved: '复查通过' };
const actions = { classify: '标注点位和分类', confirm: '确认重复', revoke: '撤销确认' };
const targetData = event => event.currentTarget.dataset;
const validText = (value, limit) => typeof value === 'string' && value.trim() &&
  Array.from(value).length <= limit && !value.includes('\0');
const emptySupervision = () => ({ supervisionPanel: null });
const emptyLedger = () => ({ ledger: null });

function panelView(value) {
  const { points, categories, candidates, revision } = value;
  if (!Array.isArray(points) || !Array.isArray(categories) || !Array.isArray(candidates) ||
      !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid supervision response');
  const classification = value.classification;
  return {
    ...value, busy: false, error: '', mustRefresh: false, editor: null,
    pointLabel: points.find(item => item.code === classification?.pointCode)?.label ?? classification?.pointCode,
    categoryLabel: categories.find(item => item.code === classification?.categoryCode)?.label ?? classification?.categoryCode,
    changeLabel: actions[value.lastChange?.action], changeTime: timeLabel(value.lastChange?.at),
    candidates: candidates.map(item => ({ ...item, time: timeLabel(item.occurredAt) }))
  };
}

const ledgerRow = item => ({ ...item, statusLabel: statuses[item.status], dueLabel: timeLabel(item.dueAt) });
function ledgerEntry(value) {
  return {
    ...ledgerRow(value), createdLabel: timeLabel(value.createdAt),
    reviews: value.reviews.map(item => ({
      ...item, statusLabel: statuses[item.conclusion], timeLabel: timeLabel(item.reviewedAt)
    }))
  };
}

const supervisionMethods = {
  resetSupervision() {
    this._supervisionRequest++;
    this.setData(emptySupervision());
  },

  async onOpenSupervision() {
    const { detail, activeCase, staff, view } = this.data;
    if (view !== 'detail' || staff?.supervision !== true || !detail || !canView(staff, detail) ||
        detail.caseNumber !== activeCase || !casePattern.test(activeCase) ||
        this.data.supervisionPanel?.busy || this.writesBlocked()) return;
    return this.supervisionCall(activeCase);
  },

  onCloseSupervision() {
    this.resetSupervision();
  },

  async supervisionCall(number, payload) {
    const sequence = ++this._supervisionRequest;
    const session = this._session;
    const current = () => sequence === this._supervisionRequest && this.active(session) &&
      this.data.view === 'detail' && this.data.activeCase === number && this.data.staff?.supervision === true;
    this.setData({ supervisionPanel: { ...this.data.supervisionPanel, busy: true, error: '' } });
    try {
      const result = await this.request(casePaths + number + '/supervision', payload ? 'POST' : 'GET', payload);
      if (current()) this.setData({ supervisionPanel: panelView(result) });
    } catch (error) {
      if (!current() || this.sessionError(error)) return;
      if (!payload && error.status === 404) return this.caseUnavailable();
      const mustRefresh = !payload || !error.status || error.status === 404 || error.status === 409 || error.status >= 500;
      this.setData({ supervisionPanel: {
        ...this.data.supervisionPanel, busy: false, mustRefresh,
        error: mustRefresh ? '请重新读取监督记录后核对结果。' : '保存失败，请核对填写内容。'
      } });
    }
  },

  onEditSupervision(event) {
    const { action, target } = targetData(event);
    const panel = this.data.supervisionPanel;
    if (!panel || panel.busy || panel.mustRefresh || !Object.hasOwn(actions, action)) return;
    if ((action === 'classify' && panel.classificationLocked) ||
        (action === 'confirm' && !panel.candidates.some(item => item.caseNumber === target)) ||
        (action === 'revoke' && (!panel.linked || !panel.targetCaseNumber))) return;
    const { classification, points, categories } = panel;
    const editor = {
      action, target, label: actions[action], reason: '',
      pointIndex: points.findIndex(item => item.code === classification?.pointCode),
      categoryIndex: categories.findIndex(item => item.code === classification?.categoryCode)
    };
    this.setData({ supervisionPanel: { ...panel, editor, error: '' } });
  },

  onSupervisionInput(event) {
    const panel = this.data.supervisionPanel;
    const { field } = targetData(event);
    if (!panel?.editor || panel.busy || panel.mustRefresh || !['pointIndex', 'categoryIndex', 'reason'].includes(field)) return;
    const value = field === 'reason' ? event.detail.value : Number(event.detail.value);
    this.setData({ supervisionPanel: { ...panel, editor: { ...panel.editor, [field]: value } } });
  },

  onSaveSupervision() {
    const panel = this.data.supervisionPanel;
    if (!panel?.editor || panel.busy || panel.mustRefresh || this.writesBlocked() ||
        this.data.view !== 'detail' || this.data.staff?.supervision !== true) return;
    const { action, reason, pointIndex, categoryIndex, target } = panel.editor;
    const payload = { action, expectedRevision: panel.revision, reason };
    if (action === 'classify') {
      payload.pointCode = panel.points[pointIndex]?.code;
      payload.categoryCode = panel.categories[categoryIndex]?.code;
    } else if (action === 'confirm') {
      payload.targetCaseNumber = target;
    }
    if (!validText(reason, 1000) || (action === 'classify' && (!payload.pointCode || !payload.categoryCode))) {
      this.setData({ supervisionPanel: { ...panel, error: '请完成选项并填写理由。' } });
      return;
    }
    return this.supervisionCall(this.data.activeCase, payload);
  }
};

const ledgerMethods = {
  resetLedger() {
    this._ledgerRequest++;
    this.setData(emptyLedger());
  },

  async onOpenRemediation() {
    if (this.data.view !== 'workbench' || this.data.staff?.role !== 'duty' ||
        this.data.staff.supervision !== true || !this._token) return;
    this.setData({ view: 'remediation' });
    return this.onLedgerList();
  },

  onCloseRemediation() {
    if (this.data.view !== 'remediation') return;
    this.resetLedger();
    this.setData({ view: 'workbench' });
  },

  async ledgerCall(path, { payload, status = 200, apply }) {
    const session = this._session;
    const sequence = ++this._ledgerRequest;
    const current = () => sequence === this._ledgerRequest && this.active(session) && this.data.view === 'remediation';
    this.setData({ ledger: { ...this.data.ledger, busy: true, error: '' } });
    try {
      const result = await this.request(path, payload ? 'POST' : 'GET', payload, status);
      if (current()) this.setData({ ledger: { ...apply(result), busy: false, error: '' } });
    } catch (error) {
      if (!current() || this.sessionError(error)) return;
      const mustRefresh = Boolean(payload && (!error.status || error.status === 404 || error.status === 409 || error.status >= 500));
      this.setData({ ledger: {
        ...this.data.ledger, busy: false, mustRefresh,
        error: mustRefresh ? '请返回台账列表并核对记录后再操作。' : payload ? '保存失败，请核对填写内容。' : '台账读取失败，请重试。'
      } });
    }
  },

  onLedgerList(event) {
    if (this.data.view !== 'remediation' || this.data.ledger?.busy) return;
    const previous = this.data.ledger;
    const before = event && targetData(event).more ? previous?.nextBefore : null;
    return this.ledgerCall(ledgerPath + (before ? '?before=' + before : ''), { apply: result => ({
      items: (before ? previous.items : []).concat(result.items.map(ledgerRow)), nextBefore: result.nextBefore
    }) });
  },

  onLedgerEntry(event) {
    const id = Number(targetData(event).id);
    const { ledger } = this.data;
    if (this.data.view !== 'remediation' || ledger?.busy || !ledger?.items?.some(item => item.id === id)) return;
    return this.ledgerCall(ledgerPath + '/' + id, { apply: value => ({ entry: ledgerEntry(value) }) });
  },

  onNewLedgerEntry() {
    if (this.data.view !== 'remediation' || this.data.ledger?.busy) return;
    this.setData({ ledger: { form: { topic: '', minutes: '', responsibleUnit: '', date: '', time: '' } } });
  },

  onLedgerInput(event) {
    const { field } = targetData(event);
    const { ledger } = this.data;
    if (this.data.view !== 'remediation' || !ledger || ledger.busy || ledger.mustRefresh) return;
    if (ledger.form && Object.hasOwn(ledger.form, field)) {
      this.setData({ ledger: { ...ledger, form: { ...ledger.form, [field]: event.detail.value }, error: '' } });
    } else if (ledger.entry && ['notes', 'conclusionIndex'].includes(field)) {
      this.setData({ ledger: { ...ledger, [field]: event.detail.value, error: '' } });
    }
  },

  onSaveLedgerEntry() {
    const { ledger } = this.data;
    if (this.data.view !== 'remediation' || !ledger?.form || ledger.busy || ledger.mustRefresh) return;
    const { topic, minutes, responsibleUnit, date, time } = ledger.form;
    const dueAt = futureDeadline(date, time);
    if (!dueAt || !validText(topic, 120) || !validText(minutes, 2000) || !validText(responsibleUnit, 120)) {
      return this.setData({ ledger: { ...ledger, error: '请填写主题、纪要、责任单位和未来的整改期限。' } });
    }
    return this.ledgerCall(ledgerPath, { payload: { topic, minutes, responsibleUnit, dueAt }, status: 201,
      apply: value => ({ entry: ledgerEntry(value) }) });
  },

  onReviewLedgerEntry() {
    const { ledger } = this.data;
    if (this.data.view !== 'remediation' || !ledger?.entry || ledger.busy || ledger.mustRefresh ||
        ledger.entry.status === 'resolved') return;
    const conclusion = conclusions[ledger.conclusionIndex];
    if (!conclusion || !validText(ledger.notes, 2000)) {
      return this.setData({ ledger: { ...ledger, error: '请填写复查情况并选择结论。' } });
    }
    return this.ledgerCall(ledgerPath + '/' + ledger.entry.id + '/reviews', {
      payload: { expectedRevision: ledger.entry.revision, notes: ledger.notes, conclusion },
      apply: value => ({ entry: ledgerEntry(value) })
    });
  }
};

module.exports = { emptySupervision, emptyLedger, supervisionMethods, ledgerMethods, conclusionLabels };

const roleLabels = { duty: '值班人员', supervisor: '主管', handler: '承办人' };
const statusLabels = {
  submitted: '待受理', awaiting_supplement: '待补充材料', accepted: '待分派', rejected: '不予受理', assigned: '已分派',
  processing: '处理中', awaiting_review: '待复核', awaiting_evaluation: '待评价',
  closed: '已办结', reopen_pending: '补办待审核'
};
const queues = [
  { id: 'pending_intake', label: '待受理' },
  { id: 'pending_assignment', label: '待分派' },
  { id: 'processing', label: '处理中' },
  { id: 'pending_review', label: '待复核' },
  { id: 'pending_reopen', label: '补办待审核' },
  { id: 'due_soon', label: '临期' },
  { id: 'overdue', label: '超时' }
];
const statusOptions = [{ id: '', label: '全部状态' }].concat(
  Object.keys(statusLabels).map(id => ({ id, label: statusLabels[id] }))
);
const actions = {
  accept: { label: '受理', roles: ['duty'], states: ['submitted'] },
  request_supplement: { label: '要求补材料', roles: ['duty'], states: ['submitted'], reason: true },
  reject: { label: '不予受理', roles: ['duty'], states: ['submitted'], reason: true },
  assign: { label: '分派', roles: ['duty'], states: ['accepted'], assignee: true },
  reassign: {
    label: '转派', roles: ['duty', 'supervisor'], states: ['assigned', 'processing', 'awaiting_review'],
    assignee: true, reason: true
  },
  start: { label: '接单', roles: ['handler'], states: ['assigned'] },
  submit_result: {
    label: '提交办理结果', roles: ['handler'], states: ['processing'], summary: true, photoReason: true
  },
  return_result: { label: '退回承办', roles: ['supervisor'], states: ['awaiting_review'], reason: true },
  publish: { label: '发布文字反馈', roles: ['supervisor'], states: ['awaiting_review'], summary: true },
  close: { label: '结案', roles: ['supervisor'], states: ['awaiting_evaluation'], reason: true },
  approve_reopen: {
    label: '通过补办', roles: ['supervisor'], states: ['reopen_pending'], assignee: true, nextStatus: true
  },
  reject_reopen: { label: '驳回补办', roles: ['supervisor'], states: ['reopen_pending'], reason: true }
};
const eventLabels = {
  submit: '提交诉求', evaluate: '提交评价', confirm_resolved: '确认解决',
  request_reopen: '申请补办', assign_collaboration: '追加协办', submit_supplement: '补交材料'
};
const feedbackPhotoRule = { label: '发布图片反馈', summary: true };
const actionRule = action => action === 'publish_photos' ? feedbackPhotoRule : actions[action];
const casePattern = /^CD-[0-9A-F]{32}$/;
const safeId = /^[A-Za-z0-9_-]{1,64}$/;

const { localOrigin } = require('../../api-environment');

function timeLabel(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

function identity(value) {
  if (!value || !Object.prototype.hasOwnProperty.call(roleLabels, value.role) ||
      typeof value.id !== 'string' || !safeId.test(value.id) ||
      (value.role !== 'duty' && (typeof value.department !== 'string' || !safeId.test(value.department)))) {
    return null;
  }
  const { id, role } = value;
  return { id, role, roleLabel: roleLabels[role], department: role === 'duty' ? '' : value.department };
}

function canView(staff, item) {
  return staff.role === 'duty' || (staff.department === item.department &&
    (staff.role === 'supervisor' || staff.id === item.assignee));
}

function allowedActions(staff, item, now = Date.now()) {
  if (!staff || !item || !canView(staff, item)) return [];
  return Object.keys(actions).filter(id => {
    const rule = actions[id];
    return rule.roles.includes(staff.role) && rule.states.includes(item.status) &&
      (id !== 'request_supplement' || item.sourceType === 'integration') &&
      (id !== 'close' || Date.parse(item.evaluationEndsAt) <= now);
  }).map(id => ({ id, label: actions[id].label }));
}

function canEditAction(staff, detail, action) {
  const backendAction = action === 'publish_photos' ? 'publish' : action;
  return allowedActions(staff, detail).some(entry => entry.id === backendAction);
}

function caseRow(item) {
  const sourceType = ['integration', 'merchant'].includes(item.sourceType) ? item.sourceType : '';
  return {
    caseNumber: item.caseNumber, status: item.status, statusLabel: statusLabels[item.status] || '状态更新中',
    category: item.category || '', sourceType,
    sourceLabel: sourceType === 'merchant' ? '商户提交' : sourceType === 'integration' ? '外部申报' : '来源未确认',
    department: item.department || '', assignee: item.assignee || '',
    dueLabel: timeLabel(item.dueAt),
    deadlineLabel: item.deadlineState === 'overdue' ? '超时' : item.deadlineState === 'due_soon' ? '临期' : ''
  };
}

function detailView(item) {
  return {
    ...caseRow(item), version: item.version, round: item.round,
    evaluationEndsAt: item.evaluationEndsAt, evaluationLabel: timeLabel(item.evaluationEndsAt),
    location: item.location, description: item.description, occurredLabel: timeLabel(item.occurredAt),
    suggestedDepartment: item.suggestedDepartment,
    history: (item.history || []).map((event, index) => {
      const detail = event.detail || {};
      return {
        id: index, title: (actions[event.action] || {}).label || eventLabels[event.action] || '办理更新',
        time: timeLabel(event.occurredAt), actor: event.actorId || '',
        status: statusLabels[event.status] || '',
        notes: [detail.summary, detail.reason, detail.photoOmissionReason,
          detail.assignee && ('承办人 ' + detail.assignee),
          detail.dueAt && ('截止 ' + timeLabel(detail.dueAt))].filter(Boolean).join('\n')
      };
    }),
    reopenRequests: (item.reopenRequests || []).map((entry, index) => ({
      id: index, reason: entry.reason, time: timeLabel(entry.requestedAt),
      previous: statusLabels[entry.previousStatus] || '', decisionReason: entry.decisionReason,
      decision: entry.decision === 'approved' ? '已批准' : entry.decision === 'rejected' ? '已驳回' : '待审核'
    })),
    rounds: (item.rounds || []).filter(entry => entry.feedback || entry.evaluation).map(entry => ({
      round: entry.round, summary: entry.feedback ? entry.feedback.summary : '',
      evaluation: entry.evaluation ? [entry.evaluation.speed, entry.evaluation.effectiveness, entry.evaluation.attitude].join(' / ') : ''
    }))
  };
}

function futureDeadline(date, time, now = Date.now()) {
  const value = date + 'T' + time + ':00+08:00';
  const due = Date.parse(value);
  return Number.isFinite(due) && timeLabel(value) === date + ' ' + time && due > now ? value : '';
}

function actionPayload(editor, detail, now = Date.now()) {
  const { action } = editor;
  const rule = actionRule(action);
  const body = { action: action === 'publish_photos' ? 'publish' : action, expectedVersion: detail.version };
  const text = (value, limit) => typeof value === 'string' && value.trim() &&
    Array.from(value).length <= limit && !value.includes('\0') ? value.trim() : '';
  if (rule.assignee) {
    const person = editor.people[editor.personIndex];
    if (!person) return { error: '请选择可派承办人。' };
    const dueAt = futureDeadline(editor.date, editor.time, now);
    if (!dueAt) {
      return { error: '请选择未来的办理截止日期和时间。' };
    }
    body.assignee = person.id;
    body.dueAt = dueAt;
  }
  if (rule.reason) {
    body.reason = text(editor.reason, 1000);
    if (!body.reason) return { error: '请输入 1–1000 字的原因。' };
  }
  if (rule.summary) {
    body.summary = text(editor.summary, 4000);
    if (!body.summary) return { error: '请输入 1–4000 字的说明。' };
  }
  if (action === 'publish_photos') {
    if (!editor.photoCount) return { error: '请选择独立脱敏的 PNG 文件。' };
    if (editor.derivativesReviewed !== true) return { error: '请确认逐张检查脱敏图片后再发布。' };
    body.derivativesReviewed = true;
  }
  if (rule.photoReason && !editor.photoCount) {
    body.photoOmissionReason = text(editor.photoReason, 1000);
    if (!body.photoOmissionReason) return { error: '请输入未提供照片的原因。' };
  }
  if (rule.nextStatus) body.nextStatus = editor.continueProcessing ? 'processing' : 'assigned';
  return { body };
}

module.exports = {
  localOrigin, identity, canView, allowedActions, caseRow, detailView, actionPayload,
  actions, queues, statusOptions, casePattern, safeId, timeLabel, futureDeadline, actionRule, canEditAction
};

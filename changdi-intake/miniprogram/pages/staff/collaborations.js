const { canView, safeId, timeLabel, futureDeadline } = require('./workbench');
const { photoEntries } = require('./photos');

const taskStatuses = {
  awaiting_submission: '待提交', awaiting_review: '待复核', returned: '退回补充',
  approved: '已通过', withdrawn: '已撤回'
};
const decisions = { approve: '通过协办', return: '退回补充', withdraw: '撤回协办' };
const eventLabels = { assign: '派发协办', submit: '提交协办说明', ...decisions };
const taskPattern = /^CT-[0-9A-F]{32}$/;
const assignStates = ['assigned', 'processing'];
const reviewStates = ['assigned', 'processing', 'awaiting_review'];

function canAssignCollaboration(staff, detail) {
  return Boolean(staff && detail && ['duty', 'supervisor'].includes(staff.role) &&
    canView(staff, detail) && assignStates.includes(detail.status));
}

function reviewActions(staff, detail, task) {
  if (!staff || !detail || !task || staff.role !== 'supervisor' || !canView(staff, detail) ||
      detail.round !== task.round || !reviewStates.includes(detail.status)) return [];
  const actions = task.status === 'awaiting_review' ? ['approve', 'return', 'withdraw'] :
    ['awaiting_submission', 'returned'].includes(task.status) ? ['withdraw'] : [];
  return actions.map(id => ({ id, label: decisions[id] }));
}

function canViewTaskPhotos(staff, detail, task) {
  return Boolean(staff && detail && task && ['handler', 'supervisor'].includes(staff.role) &&
    canView(staff, detail) && detail.round === task.round && task.status !== 'withdrawn' &&
    reviewStates.includes(detail.status));
}

function taskView(task, staff, detail) {
  if (!task || typeof task.taskId !== 'string' || !taskPattern.test(task.taskId) ||
      !Number.isSafeInteger(task.version) || task.version < 1 ||
      !Number.isSafeInteger(task.round) || task.round < 1 ||
      !Object.prototype.hasOwnProperty.call(taskStatuses, task.status)) {
    throw new Error('Invalid collaboration task');
  }
  return {
    taskId: task.taskId, status: task.status, statusLabel: taskStatuses[task.status],
    round: task.round, version: task.version, merchantId: task.merchantId,
    instructions: task.instructions || '', location: task.location || '',
    dueLabel: timeLabel(task.dueAt), latestSubmission: task.latestSubmission || '', returnReason: task.returnReason || '',
    actions: reviewActions(staff, detail, task),
    submissionPhotos: canViewTaskPhotos(staff, detail, task)
      ? photoEntries(task.submissionPhotos, task.version).filter(photo => photo.submitVersion > 1)
        .map(({ round, ...photo }) => photo)
      : [],
    history: (task.history || []).map(entry => ({
      version: entry.version, title: eventLabels[entry.action] || '协办更新',
      time: timeLabel(entry.occurredAt), actor: entry.actorId || '',
      note: entry.detail ? entry.detail.reason || entry.detail.summary || '' : ''
    }))
  };
}

function collaborationPayload(editor, detail, task) {
  if (editor.action === 'assign') {
    const merchantId = editor.merchantId.trim();
    if (!safeId.test(merchantId)) return { error: '请输入有效的本地商户编号。' };
    const instructions = editor.instructions.trim();
    if (!instructions || Array.from(instructions).length > 1000) return { error: '请输入 1–1000 字的协办说明。' };
    const location = editor.location.trim();
    if (Array.from(location).length > 300) return { error: '协办地点最多 300 字。' };
    const dueAt = futureDeadline(editor.date, editor.time);
    if (!dueAt) return { error: '请选择未来的协办截止日期和时间。' };
    return { body: { expectedVersion: detail.version, merchantId, instructions, ...(location ? { location } : {}), dueAt } };
  }
  const body = { action: editor.action, expectedVersion: task.version };
  if (editor.action !== 'approve') {
    const reason = editor.reason.trim();
    if (!reason || Array.from(reason).length > 1000) return { error: '请输入 1–1000 字的原因。' };
    body.reason = reason;
  }
  return { body };
}

module.exports = { canAssignCollaboration, reviewActions, taskView, collaborationPayload, canViewTaskPhotos };

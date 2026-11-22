import { HttpError, onlyFields, readText, timestamp } from './http.js';

export function canAssignHandler(principal, assignee) {
  return assignee.role === 'handler' &&
    (principal.role === 'duty' ||
      (principal.role === 'supervisor' && principal.department === assignee.department));
}

const actions = {
  accept: { roles: ['duty'], from: ['submitted'], to: 'accepted', fields: [] },
  reject: { roles: ['duty'], from: ['submitted'], to: 'rejected', fields: ['reason'] },
  request_supplement: { roles: ['duty'], from: ['submitted'], to: 'awaiting_supplement', fields: ['reason'] },
  assign: {
    roles: ['duty'], from: ['accepted'], to: 'assigned',
    fields: ['assignee', 'dueAt'],
  },
  reassign: {
    roles: ['duty', 'supervisor'], from: ['assigned', 'processing', 'awaiting_review'],
    to: 'assigned', fields: ['assignee', 'dueAt', 'reason'],
  },
  start: { roles: ['handler'], from: ['assigned'], to: 'processing', fields: [] },
  submit_result: {
    roles: ['handler'], from: ['processing'], to: 'awaiting_review', fields: ['summary', 'photoOmissionReason'],
  },
  return_result: {
    roles: ['supervisor'], from: ['awaiting_review'], to: 'processing', fields: ['reason'],
  },
  publish: {
    roles: ['supervisor'], from: ['awaiting_review'], to: 'awaiting_evaluation', fields: ['summary'],
  },
  close: { roles: ['supervisor'], from: ['awaiting_evaluation'], to: 'closed', fields: ['reason'] },
  approve_reopen: {
    roles: ['supervisor'], from: ['reopen_pending'], fields: ['assignee', 'dueAt', 'nextStatus'],
  },
  reject_reopen: { roles: ['supervisor'], from: ['reopen_pending'], fields: ['reason'] },
};

export function requireVersion(input, item) {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new HttpError(400, 'invalid_version');
  }
  if (input.expectedVersion !== item.version) throw new HttpError(409, 'stale_version');
}

export function applyAction(input, item, principal, staff, now, periods, pending, hasPhotos = false) {
  if (typeof input.action !== 'string' || !Object.hasOwn(actions, input.action)) {
    throw new HttpError(400, 'invalid_action');
  }
  if (hasPhotos && !['submit_result', 'publish'].includes(input.action)) throw new HttpError(400, 'invalid_action');
  const action = actions[input.action];
  if (!action.roles.includes(principal.role)) throw new HttpError(403, 'forbidden');
  onlyFields(input, ['action', 'expectedVersion', ...action.fields]);
  requireVersion(input, item);
  if (!action.from.includes(item.status)) throw new HttpError(409, 'invalid_transition');
  if (input.action === 'request_supplement' && item.source.startsWith('merchant:')) {
    throw new HttpError(409, 'supplement_owner_unavailable');
  }

  const changes = {
    status: action.to,
    department: item.department,
    assignee: item.assignee,
    dueAt: item.due_at,
    evaluationEndsAt: item.evaluation_ends_at,
    reopenEndsAt: item.reopen_ends_at,
    round: item.round,
    public: input.action !== 'submit_result' && input.action !== 'return_result',
    detail: {},
  };
  if (action.fields.includes('reason')) changes.detail.reason = readText(input.reason, 1000);
  if (action.fields.includes('summary')) changes.detail.summary = readText(input.summary, 4000);
  if (input.action === 'submit_result' && !hasPhotos) {
    changes.detail.photoOmissionReason = readText(input.photoOmissionReason, 1000);
  }
  if (action.fields.includes('assignee')) {
    const assignee = staff.get(readText(input.assignee, 64));
    if (assignee?.role !== 'handler') throw new HttpError(400, 'invalid_assignee');
    if (!canAssignHandler(principal, assignee)) {
      throw new HttpError(403, 'forbidden');
    }
    const dueAt = timestamp(input.dueAt);
    if (dueAt <= now) throw new HttpError(400, 'invalid_due_at');
    changes.detail = { ...changes.detail, assignee: assignee.id, department: assignee.department, dueAt };
    changes.department = assignee.department;
    changes.assignee = assignee.id;
    changes.dueAt = dueAt;
  }
  if (input.action === 'publish') {
    if (hasPhotos) changes.detail.derivativesReviewed = true;
    changes.evaluationEndsAt = new Date(Date.parse(now) + periods.evaluationSeconds * 1000).toISOString();
    changes.reopenEndsAt = new Date(Date.parse(now) + periods.reopenSeconds * 1000).toISOString();
  }
  if (input.action === 'close' && item.evaluation_ends_at > now) {
    throw new HttpError(409, 'evaluation_window_open');
  }
  if (input.action === 'approve_reopen' || input.action === 'reject_reopen') {
    if (!pending || pending.round !== item.round) throw new HttpError(409, 'no_pending_reopen');
    if (input.action === 'approve_reopen') {
      if (!['assigned', 'processing'].includes(input.nextStatus)) throw new HttpError(400, 'invalid_next_status');
      changes.status = input.nextStatus;
      changes.round++;
      changes.evaluationEndsAt = null;
      changes.reopenEndsAt = null;
      changes.reopenDecision = 'approved';
    } else {
      changes.status = pending.previous_status;
      changes.reopenDecision = 'rejected';
    }
  }
  return changes;
}

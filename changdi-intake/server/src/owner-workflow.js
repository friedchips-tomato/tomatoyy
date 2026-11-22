import { HttpError, onlyFields, readText } from './http.js';
import { requireVersion } from './workflow.js';

const actionFields = {
  evaluate: ['speed', 'effectiveness', 'attitude', 'comment'],
  confirm_resolved: [],
  request_reopen: ['reason'],
  submit_supplement: ['summary'],
};

export function canRequestReopen(item, now) {
  return ['awaiting_evaluation', 'closed'].includes(item.status) && item.reopen_ends_at > now;
}

export function ownerChange(input, item, now) {
  if (typeof input.action !== 'string' || !Object.hasOwn(actionFields, input.action)) {
    throw new HttpError(400, 'invalid_action');
  }
  onlyFields(input, ['action', 'expectedVersion', ...actionFields[input.action]]);
  requireVersion(input, item);
  if (input.action === 'submit_supplement') {
    if (item.status !== 'awaiting_supplement') throw new HttpError(409, 'invalid_transition');
    return { status: 'submitted', detail: { summary: readText(input.summary, 4000) } };
  }
  if (input.action === 'request_reopen') {
    if (!['awaiting_evaluation', 'closed'].includes(item.status)) throw new HttpError(409, 'invalid_transition');
    if (!canRequestReopen(item, now)) throw new HttpError(409, 'reopen_window_expired');
    return { status: 'reopen_pending', reason: readText(input.reason, 1000) };
  }
  if (item.status !== 'awaiting_evaluation') throw new HttpError(409, 'invalid_transition');
  if (input.action === 'confirm_resolved') return { status: 'closed' };
  if (item.evaluation_ends_at <= now) throw new HttpError(409, 'evaluation_window_expired');
  const { speed, effectiveness, attitude } = input;
  if (![speed, effectiveness, attitude].every(value => Number.isInteger(value) && value >= 1 && value <= 5)) {
    throw new HttpError(400, 'invalid_rating');
  }
  return {
    status: item.status,
    scores: {
      speed, effectiveness, attitude,
      comment: Object.hasOwn(input, 'comment') ? readText(input.comment, 1000) : null,
    },
  };
}

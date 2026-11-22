import { canRequestReopen } from './owner-workflow.js';

export const externalStatus = status => status === 'awaiting_review' ? 'processing' : status;
export const sourceType = source => source.startsWith('merchant:') ? 'merchant' :
  source === 'miniprogram' ? 'public' : 'integration';

export function createCaseDetails(db, feedbackPhotos) {
  const events = db.prepare(`
    SELECT action, status, round, actor_type AS actorType,
      CASE WHEN actor_type = 'staff' THEN actor_id END AS actorId,
      occurred_at AS occurredAt, detail
    FROM case_events WHERE case_id = ? ORDER BY version
  `);
  const ownerEvents = db.prepare(`
    SELECT action, status, round, occurred_at AS occurredAt,
      CASE WHEN action IN ('reject', 'request_supplement') THEN json_extract(detail, '$.reason') END AS reason,
      CASE WHEN action = 'submit_supplement' THEN json_extract(detail, '$.summary') END AS summary
    FROM case_events WHERE case_id = ? AND (public = 1 OR action = 'evaluate') ORDER BY version
  `);
  const publications = db.prepare(`
    SELECT round, version, occurred_at AS publishedAt, json_extract(detail, '$.summary') AS summary
    FROM case_events WHERE case_id = ? AND action = 'publish' ORDER BY round
  `);
  const evaluations = db.prepare(`
    SELECT round, speed, effectiveness, attitude, comment, created_at AS submittedAt
    FROM case_evaluations WHERE case_id = ? ORDER BY round
  `);
  const reopenRequests = db.prepare(`
    SELECT round, previous_status AS previousStatus, reason, requested_at AS requestedAt,
      decision, decision_reason AS decisionReason, decided_at AS decidedAt
    FROM reopen_requests WHERE case_id = ? ORDER BY requested_version
  `);

  function rounds(item, includePhotos = false) {
    const scores = new Map(evaluations.all(item.id).map(({ round, ...evaluation }) => [round, evaluation]));
    const byVersion = new Map();
    if (includePhotos) {
      for (const photo of feedbackPhotos.list(item.id)) {
        if (!byVersion.has(photo.publishVersion)) byVersion.set(photo.publishVersion, []);
        byVersion.get(photo.publishVersion).push(photo);
      }
    }
    const result = publications.all(item.id).map(({ round, version, publishedAt, summary }) => ({
      round,
      feedback: { publishedAt, summary, photos: byVersion.get(version) ?? [] },
      evaluation: scores.get(round) ?? null,
    }));
    if (result.at(-1)?.round !== item.round) result.push({ round: item.round, feedback: null, evaluation: null });
    return result;
  }

  return {
    staff(item, principal) {
      const details = {
        caseNumber: item.case_number,
        sourceType: sourceType(item.source),
        status: item.status,
        version: item.version,
        round: item.round,
        occurredAt: item.occurred_at,
        location: item.location,
        category: item.category,
        description: item.description,
        suggestedDepartment: item.suggested_department,
        department: item.department,
        assignee: item.assignee,
        dueAt: item.due_at,
        evaluationEndsAt: item.evaluation_ends_at,
        reopenEndsAt: item.reopen_ends_at,
        history: events.all(item.id).map(event => ({ ...event, detail: JSON.parse(event.detail) })),
      };
      if (principal.role !== 'handler') {
        details.rounds = rounds(item);
        details.reopenRequests = reopenRequests.all(item.id);
      }
      return details;
    },
    owner(item, now) {
      const history = ownerEvents.all(item.id).map(({ reason, summary, ...event }) => ({
        ...event,
        ...(reason === null ? {} : { reason }),
        ...(summary === null ? {} : { summary }),
      }));
      const record = rounds(item, true);
      const availableActions = [];
      const requirement = item.status === 'awaiting_supplement'
        ? history.findLast(event => event.action === 'request_supplement')
        : null;
      if (requirement) availableActions.push('submit_supplement');
      if (item.status === 'awaiting_evaluation') {
        if (item.evaluation_ends_at > now && !record.at(-1).evaluation) availableActions.push('evaluate');
        availableActions.push('confirm_resolved');
      }
      if (canRequestReopen(item, now)) availableActions.push('request_reopen');
      return {
        caseNumber: item.case_number,
        status: externalStatus(item.status),
        version: item.version,
        round: item.round,
        evaluationEndsAt: item.evaluation_ends_at,
        reopenEndsAt: item.reopen_ends_at,
        availableActions,
        supplementRequirement: requirement ? { reason: requirement.reason, requestedAt: requirement.occurredAt } : null,
        history,
        rounds: record,
        reopenRequests: reopenRequests.all(item.id),
      };
    },
  };
}

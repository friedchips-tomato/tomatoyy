import { randomUUID } from 'node:crypto';
import { externalStatus } from './case-details.js';
import { HttpError, onlyFields, readText, timestamp } from './http.js';
import { requireVersion } from './workflow.js';
import { canReadSubmissionPhotos } from './staff-submission-photos.js';

const caseStatuses = new Set([
  'submitted', 'accepted', 'rejected', 'assigned', 'processing', 'awaiting_evaluation', 'closed', 'reopen_pending',
]);
const active = status => ['assigned', 'processing', 'awaiting_review'].includes(status);
const visibleToMerchant = "t.round = c.round AND c.status IN ('assigned', 'processing', 'awaiting_review')";
const pageSize = 50;
const isActiveTask = (task, item) => task.round === item.round && active(item.status) && task.status !== 'withdrawn';

function page(rows, key) {
  const items = rows.slice(0, pageSize);
  return { items, nextBefore: rows.length > pageSize ? items.at(-1)[key] : null };
}

function taskDetails(task) {
  return {
    taskId: task.task_id,
    status: task.status,
    version: task.version,
    instructions: task.instructions,
    location: task.location,
    dueAt: task.due_at,
    latestSubmission: task.latest_submission,
    returnReason: task.return_reason,
  };
}

export function createMerchantStore(db, { now, write, read, createCase, scopedCase, recordAssignment }) {
  const merchantCase = db.prepare(`
    SELECT c.*, s.occurred_at AS submitted_at
    FROM merchant_cases m JOIN cases c ON c.id = m.case_id
    JOIN case_events s ON s.case_id = c.id AND s.version = 1
    WHERE m.merchant_id = ? AND c.case_number = ?
  `);
  const merchantTask = db.prepare(`
    SELECT t.* FROM collaboration_tasks t JOIN cases c ON c.id = t.case_id
    WHERE t.merchant_id = ? AND t.task_id = ? AND ${visibleToMerchant} AND t.status != 'withdrawn'
  `);
  const taskByCase = db.prepare('SELECT * FROM collaboration_tasks WHERE case_id = ? AND task_id = ?');
  const insertPhoto = db.prepare('INSERT INTO collaboration_submission_photos VALUES (?, ?, ?, ?, ?, ?, ?)');
  const scopedPhotos = `
    FROM collaboration_submission_photos p JOIN collaboration_events e
    ON p.task_id = e.task_id AND p.submit_version = e.version
    WHERE p.task_id = ? AND e.action = 'submit' AND e.actor_type = 'merchant'
  `;
  const photoMetadata = db.prepare(`
    SELECT p.submit_version AS submitVersion, p.position, p.media_type AS mediaType, p.size
    ${scopedPhotos} ORDER BY p.submit_version, p.position
  `);
  const photoByVersion = db.prepare(`
    SELECT p.media_type AS mediaType, p.bytes ${scopedPhotos} AND p.submit_version = ? AND p.position = ?
  `);
  const insertEvent = db.prepare('INSERT INTO collaboration_events VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateTask = db.prepare(`
    UPDATE collaboration_tasks SET status = ?, version = ?, latest_submission = ?, return_reason = ?
    WHERE id = ?
  `);

  function scopedMerchantTask(principal, taskId) {
    const task = merchantTask.get(principal.merchantId, taskId);
    if (!task) throw new HttpError(404, 'collaboration_not_found');
    return task;
  }

  function readPhoto(task, version, position) {
    const photo = photoByVersion.get(task.id, version, position);
    if (!photo) throw new HttpError(404, 'collaboration_photo_not_found');
    return photo;
  }

  function staffTask(task, item, principal) {
    return {
      ...taskDetails(task),
      merchantId: task.merchant_id,
      round: task.round,
      ...(canReadSubmissionPhotos(principal) && isActiveTask(task, item) ? { submissionPhotos: photoMetadata.all(task.id) } : {}),
      history: db.prepare(`
        SELECT version, action, actor_type AS actorType, actor_id AS actorId, occurred_at AS occurredAt, detail
        FROM collaboration_events WHERE task_id = ? ORDER BY version
      `).all(task.id).map(event => ({ ...event, detail: JSON.parse(event.detail) })),
    };
  }

  return {
    submit(principal, submission) {
      return write(() => {
        const source = ['merchant', principal.merchantId, principal.id].join(':');
        const { created, item } = createCase(source, submission.payload.clientRequestId, 'owner', principal.id, submission);
        if (created) {
          db.prepare('INSERT INTO merchant_cases VALUES (?, ?, ?)').run(item.id, principal.merchantId, principal.id);
        }
        const record = merchantCase.get(principal.merchantId, item.case_number);
        return {
          created,
          summary: { caseNumber: record.case_number, status: 'submitted', submittedAt: record.submitted_at },
        };
      });
    },
    cases(principal, { status, before }) {
      if (status !== null && !caseStatuses.has(status)) throw new HttpError(400, 'invalid_status');
      return read(() => {
        const cursor = before === null ? null : merchantCase.get(principal.merchantId, before);
        if (before !== null && !cursor) throw new HttpError(400, 'invalid_cursor');
        return page(db.prepare(`
          SELECT c.case_number AS caseNumber,
            CASE WHEN c.status = 'awaiting_review' THEN 'processing' ELSE c.status END AS status,
            s.occurred_at AS submittedAt
          FROM merchant_cases m JOIN cases c ON c.id = m.case_id
          JOIN case_events s ON s.case_id = c.id AND s.version = 1
          WHERE m.merchant_id = ? AND (? IS NULL OR m.case_id < ?) AND
            (? IS NULL OR c.status = ? OR (? = 'processing' AND c.status = 'awaiting_review'))
          ORDER BY m.case_id DESC LIMIT ?
        `).all(principal.merchantId, cursor?.id ?? null, cursor?.id ?? null, status, status, status, pageSize + 1), 'caseNumber');
      });
    },
    case(principal, caseNumber) {
      return read(() => {
        const item = merchantCase.get(principal.merchantId, caseNumber);
        if (!item) throw new HttpError(404, 'case_not_found');
        const history = db.prepare(`
          SELECT status, round, occurred_at AS occurredAt
          FROM case_events WHERE case_id = ? AND public = 1 ORDER BY version
        `).all(item.id);
        const feedback = db.prepare(`
          SELECT round, occurred_at AS publishedAt, json_extract(detail, '$.summary') AS summary
          FROM case_events WHERE case_id = ? AND action = 'publish' ORDER BY round
        `).all(item.id);
        return {
          caseNumber, status: externalStatus(item.status), submittedAt: item.submitted_at,
          round: item.round, occurredAt: item.occurred_at, location: item.location,
          category: item.category, description: item.description, history, feedback,
        };
      });
    },
    tasks(principal, before) {
      return read(() => {
        const cursor = before === null ? null :
          db.prepare('SELECT id FROM collaboration_tasks WHERE merchant_id = ? AND task_id = ?').get(principal.merchantId, before);
        if (before !== null && !cursor) throw new HttpError(400, 'invalid_cursor');
        return page(db.prepare(`
          SELECT t.task_id AS taskId, t.instructions, t.due_at AS dueAt, t.status, t.version
          FROM collaboration_tasks t JOIN cases c ON c.id = t.case_id
          WHERE t.merchant_id = ? AND (? IS NULL OR t.id < ?) AND ${visibleToMerchant}
            AND t.status IN ('awaiting_submission', 'returned', 'awaiting_review')
          ORDER BY t.id DESC LIMIT ?
        `).all(principal.merchantId, cursor?.id ?? null, cursor?.id ?? null, pageSize + 1), 'taskId');
      });
    },
    task(principal, taskId) {
      return read(() => {
        const task = scopedMerchantTask(principal, taskId);
        return { ...taskDetails(task), submissionPhotos: photoMetadata.all(task.id) };
      });
    },
    taskPhoto(principal, taskId, version, position) {
      return read(() => readPhoto(scopedMerchantTask(principal, taskId), version, position));
    },
    submitTask(principal, taskId, input, photos = []) {
      return write(() => {
        const task = scopedMerchantTask(principal, taskId);
        onlyFields(input, ['expectedVersion', 'summary']);
        requireVersion(input, task);
        if (!['awaiting_submission', 'returned'].includes(task.status)) throw new HttpError(409, 'invalid_transition');
        const summary = readText(input.summary, 4000);
        const version = task.version + 1;
        updateTask.run('awaiting_review', version, summary, null, task.id);
        insertEvent.run(task.id, version, 'submit', 'merchant', principal.id, now().toISOString(), JSON.stringify({ summary }));
        photos.forEach(({ mediaType, bytes, sha256 }, position) => {
          insertPhoto.run(task.id, version, position, mediaType, bytes.length, sha256, bytes);
        });
        return { ...taskDetails(scopedMerchantTask(principal, taskId)), submissionPhotos: photoMetadata.all(task.id) };
      });
    },
    staffTasks(principal, caseNumber) {
      return read(() => {
        const item = scopedCase(caseNumber, principal);
        return { items: db.prepare('SELECT * FROM collaboration_tasks WHERE case_id = ? ORDER BY id')
          .all(item.id).map(task => staffTask(task, item, principal)) };
      });
    },
    staffTaskPhoto(principal, caseNumber, taskId, version, position) {
      if (!canReadSubmissionPhotos(principal)) throw new HttpError(403, 'forbidden');
      return read(() => {
        const item = scopedCase(caseNumber, principal);
        const task = taskByCase.get(item.id, taskId);
        if (!task || !isActiveTask(task, item)) throw new HttpError(404, 'collaboration_not_found');
        return readPhoto(task, version, position);
      });
    },
    assignTask(principal, caseNumber, input, eligibleMerchants) {
      return write(() => {
        const item = scopedCase(caseNumber, principal);
        if (!['duty', 'supervisor'].includes(principal.role)) throw new HttpError(403, 'forbidden');
        onlyFields(input, ['expectedVersion', 'merchantId', 'instructions', 'location', 'dueAt']);
        requireVersion(input, item);
        if (!['assigned', 'processing'].includes(item.status)) throw new HttpError(409, 'invalid_transition');
        if (!eligibleMerchants.has(input.merchantId)) throw new HttpError(400, 'invalid_merchant');
        const time = now().toISOString();
        const dueAt = timestamp(input.dueAt);
        if (dueAt <= time) throw new HttpError(400, 'invalid_due_at');
        const instructions = readText(input.instructions, 1000);
        const location = Object.hasOwn(input, 'location') ? readText(input.location, 300) : null;
        const taskId = 'CT-' + randomUUID().replaceAll('-', '').toUpperCase();
        const row = db.prepare(`
          INSERT INTO collaboration_tasks (task_id, case_id, round, merchant_id, instructions, location, due_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_submission')
        `).run(taskId, item.id, item.round, input.merchantId, instructions, location, dueAt);
        insertEvent.run(row.lastInsertRowid, 1, 'assign', 'staff', principal.id, time, '{}');
        recordAssignment(item, principal, time);
        return { ...staffTask(taskByCase.get(item.id, taskId), item, principal), caseVersion: item.version + 1 };
      });
    },
    reviewTask(principal, caseNumber, taskId, input) {
      return write(() => {
        const item = scopedCase(caseNumber, principal);
        if (principal.role !== 'supervisor') throw new HttpError(403, 'forbidden');
        const task = taskByCase.get(item.id, taskId);
        if (!task) throw new HttpError(404, 'collaboration_not_found');
        if (!['approve', 'return', 'withdraw'].includes(input.action)) throw new HttpError(400, 'invalid_action');
        const reasonRequired = input.action !== 'approve';
        onlyFields(input, reasonRequired ? ['action', 'expectedVersion', 'reason'] : ['action', 'expectedVersion']);
        requireVersion(input, task);
        const validState = input.action === 'withdraw'
          ? ['awaiting_submission', 'awaiting_review', 'returned'].includes(task.status)
          : task.status === 'awaiting_review';
        if (task.round !== item.round || !active(item.status) || !validState) {
          throw new HttpError(409, 'invalid_transition');
        }
        const status = { approve: 'approved', return: 'returned', withdraw: 'withdrawn' }[input.action];
        const reason = reasonRequired ? readText(input.reason, 1000) : null;
        const version = task.version + 1;
        updateTask.run(status, version, task.latest_submission, status === 'returned' ? reason : null, task.id);
        insertEvent.run(task.id, version, input.action, 'staff', principal.id, now().toISOString(),
          JSON.stringify(reasonRequired ? { reason } : {}));
        return staffTask(taskByCase.get(item.id, taskId), item, principal);
      });
    },
  };
}

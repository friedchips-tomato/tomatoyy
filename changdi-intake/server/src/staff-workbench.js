import { HttpError } from './http.js';

const dueSoonSeconds = 24 * 60 * 60;
const queues = {
  pending_intake: "status = 'submitted'",
  pending_assignment: "status = 'accepted'",
  processing: "status IN ('assigned', 'processing')",
  pending_review: "status = 'awaiting_review'",
  pending_reopen: "status = 'reopen_pending'",
  due_soon: "deadline_state = 'due_soon'",
  overdue: "deadline_state = 'overdue'",
};
const statuses = new Set([
  'submitted', 'awaiting_supplement', 'accepted', 'rejected', 'assigned', 'processing', 'awaiting_review',
  'awaiting_evaluation', 'closed', 'reopen_pending',
]);

function caseScope(principal) {
  switch (principal.role) {
    case 'duty': return { predicate: '1 = 1', parameters: [] };
    case 'supervisor': return { predicate: 'c.department = ?', parameters: [principal.department] };
    case 'handler': return {
      predicate: 'c.department = ? AND c.assignee = ?', parameters: [principal.department, principal.id],
    };
    default: throw new HttpError(403, 'forbidden');
  }
}

export function createStaffWorkbench(db, now, read) {
  function scopedCase(principal, caseNumber) {
    const scope = caseScope(principal);
    return db.prepare(`
      SELECT c.* FROM cases c WHERE c.case_number = ? AND ${scope.predicate}
    `).get(caseNumber, ...scope.parameters);
  }

  function visibleWork(principal) {
    const scope = caseScope(principal);
    const time = now();
    const asOf = time.toISOString();
    const horizon = new Date(time.valueOf() + dueSoonSeconds * 1000).toISOString();
    const sql = `
      WITH visible AS (
        SELECT c.id, c.case_number, c.status, c.category, c.source, c.department, c.assignee,
          CASE WHEN c.status IN ('assigned', 'processing', 'awaiting_review') THEN c.due_at END AS active_due_at
        FROM cases c WHERE ${scope.predicate}
      ), work AS (
        SELECT *,
          CASE WHEN active_due_at <= ? THEN 'overdue'
            WHEN active_due_at <= ? THEN 'due_soon'
            WHEN active_due_at IS NOT NULL THEN 'on_track'
          END AS deadline_state
        FROM visible
      )
    `;
    return { sql, parameters: [...scope.parameters, asOf, horizon], asOf };
  }

  return {
    case(principal, caseNumber) {
      const item = scopedCase(principal, caseNumber);
      if (!item) throw new HttpError(404, 'case_not_found');
      return item;
    },
    counts(principal) {
      const work = visibleWork(principal);
      const counts = Object.entries(queues).map(([name, predicate]) => `COUNT(*) FILTER (WHERE ${predicate}) AS ${name}`);
      return {
        asOf: work.asOf,
        dueSoonSeconds,
        counts: db.prepare(work.sql + 'SELECT ' + counts.join(', ') + ' FROM work').get(...work.parameters),
      };
    },
    list(principal, filters) {
      const queue = filters.get('queue');
      const status = filters.get('status');
      const department = filters.get('department');
      const assignee = filters.get('assignee');
      const before = filters.get('before');
      const rawLimit = filters.get('limit') ?? '20';
      if ((queue !== null && !Object.hasOwn(queues, queue)) || (status !== null && !statuses.has(status)) ||
          [department, assignee].some(value => value !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(value))) {
        throw new HttpError(400, 'invalid_filter');
      }
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) throw new HttpError(400, 'invalid_limit');
      const limit = Number(rawLimit);
      return read(() => {
        // Check the cursor against the same live authorization as details, even when the row changed queues.
        const cursor = before === null ? null : scopedCase(principal, before);
        if (before !== null && !cursor) throw new HttpError(400, 'invalid_cursor');
        const work = visibleWork(principal);
        const where = [];
        const parameters = [...work.parameters];
        if (queue !== null) where.push(queues[queue]);
        for (const [column, value] of [['status', status], ['department', department], ['assignee', assignee]]) {
          if (value !== null) {
            where.push(column + ' = ?');
            parameters.push(value);
          }
        }
        if (cursor) {
          where.push('id < ?');
          parameters.push(cursor.id);
        }
        const rows = db.prepare(`
          ${work.sql}
          SELECT case_number AS caseNumber, status, category,
            CASE WHEN instr(source, 'merchant:') = 1 THEN 'merchant'
              WHEN source = 'miniprogram' THEN 'public' ELSE 'integration' END AS sourceType,
            department, assignee, active_due_at AS dueAt, deadline_state AS deadlineState
          FROM work ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY id DESC LIMIT ?
        `).all(...parameters, limit + 1);
        const items = rows.slice(0, limit);
        return { asOf: work.asOf, items, nextBefore: rows.length > limit ? items.at(-1).caseNumber : null };
      });
    },
  };
}

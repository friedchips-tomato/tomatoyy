import { HttpError } from './http.js';

const beijingOffset = 8 * 3600000;
const beijingTime = ms => new Date(ms + beijingOffset).toISOString().slice(0, 19) + '+08:00';
const utcTime = ms => new Date(ms).toISOString();
const ratio = (count, total) => total ? count / total : null;

function monthBounds(month, asOf) {
  const match = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])$/.exec(month ?? '');
  if (!match || match[0] !== month || Number(match[1]) === 9999) throw new HttpError(400, 'invalid_report_month');
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const start = Date.UTC(year, index, 1) - beijingOffset;
  const end = Date.UTC(year, index + 1, 1) - beijingOffset;
  if (start > asOf) throw new HttpError(400, 'future_report_month');
  return { start, end, snapshot: Math.min(asOf, end) };
}

function firstResponseStats(minutes, submitted) {
  const sorted = minutes.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMinutes = !sorted.length ? null : sorted.length % 2
    ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const distribution = { atMostOneHour: 0, upTo24Hours: 0, over24Hours: 0 };
  for (const duration of sorted) {
    if (duration <= 60) distribution.atMostOneHour++;
    else if (duration <= 1440) distribution.upTo24Hours++;
    else distribution.over24Hours++;
  }
  return { submitted, responded: sorted.length, pending: submitted - sorted.length, medianMinutes, distribution };
}

function evaluationStats(rows, publishedRounds) {
  const dimensions = {};
  for (const dimension of ['speed', 'effectiveness', 'attitude']) {
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const row of rows) {
      distribution[row[dimension]]++;
      sum += row[dimension];
    }
    dimensions[dimension] = { distribution, mean: ratio(sum, rows.length) };
  }
  return { publishedRounds, validEvaluations: rows.length, coverage: ratio(rows.length, publishedRounds),
    unevaluatedRounds: publishedRounds - rows.length, dimensions };
}

function isResponse(event) {
  return event.actor_type === 'staff' && (event.action === 'accept' ||
    (['request_supplement', 'reject'].includes(event.action) &&
      typeof event.response_reason === 'string' && event.response_reason.trim().length > 0));
}

export function createMonthlyReport(db, now, read) {
  const history = db.prepare(`
    WITH candidates AS (
      SELECT DISTINCT case_id FROM case_events
      WHERE occurred_at >= ? AND occurred_at < ?
        AND action IN ('submit', 'accept', 'publish', 'approve_reopen', 'reject_reopen')
    )
    SELECT e.case_id, e.version, e.action, e.status, e.actor_type, e.round, e.occurred_at,
      CASE WHEN e.action IN ('request_supplement','reject') THEN json_extract(e.detail, '$.reason') END AS response_reason,
      CASE WHEN e.action IN ('assign','reassign','approve_reopen') THEN json_extract(e.detail, '$.dueAt') END AS deadline
    FROM candidates c JOIN case_events e ON e.case_id = c.case_id
    WHERE e.occurred_at < ?
    ORDER BY e.case_id, e.occurred_at, e.version
  `);
  const applications = db.prepare(`
    SELECT COUNT(*) AS total FROM reopen_requests WHERE requested_at >= ? AND requested_at < ?
  `);
  const evaluations = db.prepare(`
    SELECT v.speed, v.effectiveness, v.attitude FROM case_evaluations v
    WHERE v.created_at < ? AND EXISTS (
      SELECT 1 FROM case_events e WHERE e.case_id = v.case_id AND e.round = v.round AND
      e.action = 'publish' AND e.actor_type = 'staff' AND e.occurred_at >= ? AND e.occurred_at < ?
    )
  `);

  return month => read(() => {
    const asOf = Math.floor(now().valueOf() / 1000) * 1000;
    const { start, end, snapshot } = monthBounds(month, asOf);
    const startUtc = utcTime(start);
    const snapshotUtc = utcTime(snapshot);
    const cutoffUtc = utcTime(asOf);
    const isInMonth = event => event.occurred_at >= startUtc && event.occurred_at < snapshotUtc;
    const histories = new Map();
    const responseMinutes = [];
    let submitted = 0;
    let accepted = 0;
    let completed = 0;
    let unfinished = 0;
    let overdue = 0;
    let withoutDeadline = 0;
    let missingDeadlineEvidence = 0;
    let publishedRounds = 0;
    let approved = 0;
    let rejected = 0;
    for (const event of history.iterate(startUtc, snapshotUtc, cutoffUtc)) {
      if (!histories.has(event.case_id)) histories.set(event.case_id, []);
      histories.get(event.case_id).push(event);
      if (isInMonth(event) && event.actor_type === 'staff') {
        if (event.action === 'approve_reopen') approved++;
        if (event.action === 'reject_reopen') rejected++;
      }
    }
    for (const events of histories.values()) {
      const submitIndex = events.findIndex(event => event.action === 'submit');
      const submit = events[submitIndex];
      if (submit && isInMonth(submit)) {
        submitted++;
        const response = events.slice(submitIndex + 1).find(isResponse);
        if (response) responseMinutes.push((Date.parse(response.occurred_at) - Date.parse(submit.occurred_at)) / 60000);
      }
      const publications = events.filter(event => event.action === 'publish' && event.actor_type === 'staff');
      publishedRounds += new Set(publications.filter(isInMonth).map(event => event.round)).size;
      const firstAccept = events.find(event => event.action === 'accept' && event.actor_type === 'staff');
      if (!firstAccept || !isInMonth(firstAccept)) continue;
      accepted++;
      if (publications.some(event => event.round === events.at(-1).round)) completed++;

      const atSnapshot = events.filter(event => event.occurred_at < snapshotUtc);
      const last = atSnapshot.at(-1);
      if (publications.some(event => event.round === last.round && event.occurred_at < snapshotUtc)) continue;
      unfinished++;
      const deadlineEvent = atSnapshot.findLast(event => event.round === last.round &&
        ['assign', 'reassign', 'approve_reopen'].includes(event.action));
      const deadline = Date.parse(deadlineEvent?.deadline);
      const active = ['assigned', 'processing', 'awaiting_review'].includes(last.status);
      if (!Number.isFinite(deadline)) {
        withoutDeadline++;
        if (active) missingDeadlineEvidence++;
      } else if (active && deadline < snapshot) overdue++;
    }
    return {
      month, timeZone: 'Asia/Shanghai',
      period: { start: beijingTime(start), endExclusive: beijingTime(end) },
      asOf: beijingTime(asOf),
      firstResponse: firstResponseStats(responseMinutes, submitted),
      completion: { accepted, completed, rate: ratio(completed, accepted) },
      monthEnd: {
        cutoff: beijingTime(snapshot), state: snapshot === end ? 'final' : 'provisional',
        unfinished, overdue, withoutDeadline, missingDeadlineEvidence,
        deadlineData: missingDeadlineEvidence ? 'insufficient' : 'available',
      },
      reopen: { applications: applications.get(startUtc, snapshotUtc).total, approved, rejected, newRounds: approved },
      evaluation: evaluationStats(evaluations.all(cutoffUtc, startUtc, snapshotUtc), publishedRounds),
      duplicateComplaints: { status: 'unavailable', reason: 'structured_location_and_confirmation_missing' },
      tourism: { status: 'unavailable', reason: 'source_data_missing' },
    };
  });
}

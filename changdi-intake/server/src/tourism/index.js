import { createHash } from 'node:crypto';
import { HttpError } from '../http.js';
import { compileSources, validateEvent } from './contract.js';
import { compileCoverage, createTourismReport } from './report.js';

export { MAX_FUTURE_SKEW_MS, TOURISM_BODY_LIMIT } from './contract.js';

export function createTourismCore(db, {sources = [], coverage = [], now = () => new Date()} = {}) {
  const configured = compileSources(sources);
  const report = createTourismReport(db, compileCoverage(coverage, configured), now);
  const findEventId = db.prepare('SELECT fingerprint FROM tourism_event_ids WHERE source_id = ? AND event_id = ?');
  const insertEventId = db.prepare(
    'INSERT INTO tourism_event_ids (source_id, event_id, fingerprint, canonical_id) VALUES (?, ?, ?, ?)'
  );
  const insertEvent = db.prepare(`
    INSERT INTO tourism_events
      (source_id, evidence, type, subject_id, flow_id, occurred_at, recorded_at, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, type, subject_id, flow_id) DO NOTHING
    RETURNING id
  `);
  const findFlow = db.prepare(
    'SELECT id FROM tourism_events WHERE source_id = ? AND type = ? AND subject_id = ? AND flow_id = ?'
  );

  function requireSource(sourceId) {
    const source = configured.get(sourceId);
    if (!source) throw new HttpError(403, 'tourism_source_forbidden');
    return source;
  }

  function recordEvent(sourceId, payload) {
    const source = requireSource(sourceId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const acceptedAt = now();
      const event = validateEvent(source, payload, acceptedAt);
      const fingerprint = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      const previous = findEventId.get(source.id, event.eventId);
      let status;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HttpError(409, 'tourism_event_conflict');
        status = 'replayed';
      } else {
        const {type, subjectId, flowId, occurredAt, durationSeconds} = event;
        const inserted = insertEvent.get(
          source.id, source.evidence, type, subjectId, flowId, occurredAt, acceptedAt.toISOString(), durationSeconds ?? null
        );
        const canonical = inserted ?? findFlow.get(source.id, type, subjectId, flowId);
        insertEventId.run(source.id, event.eventId, fingerprint, canonical.id);
        status = inserted ? 'recorded' : 'deduplicated';
      }
      db.exec('COMMIT');
      return {status};
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    validateEvent: (sourceId, payload) => validateEvent(requireSource(sourceId), payload, now()),
    recordEvent,
    ...report
  };
}

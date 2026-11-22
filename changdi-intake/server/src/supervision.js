import { HttpError, onlyFields, readText, timestamp } from './http.js';
import { caseScope } from './staff-workbench.js';

const codePattern = /^[A-Za-z0-9_-]{1,32}$/;
const casePattern = /^CD-[0-9A-F]{32}$/;
const candidateLimit = 20;
const ledgerLimit = 20;
const hour = 3600000;

function directory(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new Error('Invalid supervision directory');
  const codes = new Set();
  return items.map(item => {
    if (typeof item?.code !== 'string' || !codePattern.test(item.code) || codes.has(item.code) ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 80) {
      throw new Error('Invalid supervision directory entry');
    }
    codes.add(item.code);
    return { code: item.code, label: item.label.trim() };
  });
}

export function supervisionConfig(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value.windowHours) || value.windowHours < 1 || value.windowHours > 720) {
    throw new Error('Invalid supervision window');
  }
  return { windowHours: value.windowHours, points: directory(value.points), categories: directory(value.categories) };
}

export function createSupervision(db, now, read, write, workbench, config) {
  const current = db.prepare('SELECT * FROM current_case_supervision WHERE case_id = ?');
  const incoming = db.prepare('SELECT 1 FROM current_case_supervision WHERE duplicate_of = ? LIMIT 1');
  const caseNumber = db.prepare('SELECT case_number FROM cases WHERE id = ?');
  const append = db.prepare(`
    INSERT INTO case_supervision_events
      (case_id, revision, action, point_code, category_code, duplicate_of, reason, staff_id, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const atCutoff = db.prepare(`
    SELECT s.case_id, s.duplicate_of
    FROM case_events submitted JOIN case_supervision_events s ON s.case_id = submitted.case_id
    WHERE submitted.version = 1 AND submitted.action = 'submit' AND submitted.occurred_at >= ? AND submitted.occurred_at < ?
      AND s.revision = (
        SELECT max(revision) FROM case_supervision_events WHERE case_id = s.case_id AND changed_at < ?
      )
  `);
  const ledger = db.prepare(`
    SELECT e.id, e.topic, e.responsible_unit AS responsibleUnit, e.due_at AS dueAt,
      COALESCE((SELECT conclusion FROM remediation_reviews WHERE entry_id = e.id ORDER BY revision DESC LIMIT 1), 'open') AS status
    FROM remediation_entries e WHERE e.id < ? ORDER BY e.id DESC LIMIT ?
  `);
  const entryById = db.prepare(`
    SELECT id, topic, minutes, responsible_unit AS responsibleUnit, due_at AS dueAt,
      staff_id AS staffId, created_at AS createdAt FROM remediation_entries WHERE id = ?
  `);
  const reviews = db.prepare(`
    SELECT revision, notes, conclusion, staff_id AS staffId, reviewed_at AS reviewedAt
    FROM remediation_reviews WHERE entry_id = ? ORDER BY revision
  `);
  const insertEntry = db.prepare(`
    INSERT INTO remediation_entries (topic, minutes, responsible_unit, due_at, staff_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertReview = db.prepare(`
    INSERT INTO remediation_reviews (entry_id, revision, notes, conclusion, staff_id, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const enabled = principal => Boolean(config && principal.type === 'staff' && principal.supervision === true);
  const ledgerEnabled = principal => enabled(principal) && principal.role === 'duty';
  const pointCodes = new Set(config?.points.map(item => item.code));
  const categoryCodes = new Set(config?.categories.map(item => item.code));
  const configuredCodes = (point, category) => pointCodes.has(point) && categoryCodes.has(category);

  function requireGrant(allowed) {
    if (!allowed) throw new HttpError(403, 'forbidden');
  }

  function unavailableTarget() {
    return new HttpError(404, 'supervision_target_unavailable');
  }

  function targetFor(principal, number) {
    try {
      return workbench.case(principal, number);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw unavailableTarget();
      throw error;
    }
  }

  function linkedTarget(principal, id) {
    if (!id) return null;
    const number = caseNumber.get(id)?.case_number;
    try {
      return targetFor(principal, number).case_number;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  const earliestTime = item => new Date(Date.parse(item.occurred_at) - config.windowHours * hour);
  function view(principal, item) {
    const state = current.get(item.id);
    const hasDependents = Boolean(incoming.get(item.id));
    const linked = Boolean(state?.duplicate_of);
    const targetCaseNumber = linkedTarget(principal, state?.duplicate_of);
    const scope = caseScope(principal);
    const candidates = state && configuredCodes(state.point_code, state.category_code) && !linked && !hasDependents ? db.prepare(`
      SELECT c.case_number AS caseNumber, c.occurred_at AS occurredAt
      FROM current_case_supervision s JOIN cases c ON c.id = s.case_id
      WHERE ${scope.predicate} AND s.point_code = ? AND s.category_code = ?
        AND s.duplicate_of IS NULL AND c.occurred_at >= ? AND c.occurred_at < ?
      ORDER BY c.occurred_at DESC, c.id DESC LIMIT ?
    `).all(...scope.parameters, state.point_code, state.category_code, earliestTime(item).toISOString(),
      item.occurred_at, candidateLimit) : [];
    return {
      revision: state?.revision ?? 0,
      classification: state ? { pointCode: state.point_code, categoryCode: state.category_code } : null,
      lastChange: state && (!linked || targetCaseNumber)
        ? { action: state.action, reason: state.reason, staffId: state.staff_id, at: state.changed_at } : null,
      linked, targetCaseNumber,
      classificationLocked: linked || hasDependents,
      candidates, candidateLimit, windowHours: config.windowHours,
      points: config.points, categories: config.categories,
    };
  }

  function change(principal, number, input) {
    const { action, expectedRevision } = input;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new HttpError(400, 'invalid_revision');
    const item = workbench.case(principal, number);
    const state = current.get(item.id);
    const time = now().toISOString();
    if (expectedRevision !== (state?.revision ?? 0) || (state && time < state.changed_at)) {
      throw new HttpError(409, 'supervision_conflict');
    }
    let point = state?.point_code;
    let category = state?.category_code;
    let target = null;
    if (action === 'classify') {
      onlyFields(input, ['action', 'expectedRevision', 'pointCode', 'categoryCode', 'reason']);
      if (state?.duplicate_of || incoming.get(item.id)) throw new HttpError(409, 'supervision_conflict');
      if (!configuredCodes(input.pointCode, input.categoryCode)) {
        throw new HttpError(400, 'invalid_supervision_code');
      }
      point = input.pointCode;
      category = input.categoryCode;
    } else if (action === 'confirm') {
      onlyFields(input, ['action', 'expectedRevision', 'targetCaseNumber', 'reason']);
      if (!state || !configuredCodes(point, category) || state.duplicate_of || incoming.get(item.id)) {
        throw new HttpError(409, 'supervision_conflict');
      }
      if (typeof input.targetCaseNumber !== 'string' || !casePattern.test(input.targetCaseNumber)) {
        throw new HttpError(400, 'invalid_supervision_target');
      }
      const earlier = targetFor(principal, input.targetCaseNumber);
      const earlierState = current.get(earlier.id);
      if (!earlierState || earlierState.duplicate_of || earlierState.point_code !== point ||
          earlierState.category_code !== category || earlier.occurred_at >= item.occurred_at ||
          Date.parse(earlier.occurred_at) < earliestTime(item).valueOf()) {
        throw unavailableTarget();
      }
      target = earlier.id;
    } else if (action === 'revoke') {
      onlyFields(input, ['action', 'expectedRevision', 'reason']);
      if (!state?.duplicate_of) throw new HttpError(409, 'supervision_conflict');
      if (!linkedTarget(principal, state.duplicate_of)) throw unavailableTarget();
    } else {
      throw new HttpError(400, 'invalid_supervision_action');
    }
    append.run(item.id, expectedRevision + 1, action, point, category, target, readText(input.reason, 1000), principal.id, time);
    return view(principal, item);
  }

  function entry(id) {
    const row = entryById.get(id);
    if (!row) throw new HttpError(404, 'remediation_not_found');
    const history = reviews.all(id);
    const latest = history.at(-1);
    return { ...row, revision: latest?.revision ?? 1, status: latest?.conclusion ?? 'open', reviews: history };
  }

  return {
    enabled, ledgerEnabled,
    case(principal, number) {
      requireGrant(enabled(principal));
      return read(() => view(principal, workbench.case(principal, number)));
    },
    change(principal, number, input) {
      requireGrant(enabled(principal));
      return write(() => change(principal, number, input));
    },
    duplicateStats({ includeDuplicates, includeCase, submittedCaseIds, start, cutoff, contributions }) {
      if (!config || !includeDuplicates) return { status: 'unavailable', reason: 'structured_location_and_confirmation_missing' };
      let covered = 0;
      let confirmed = 0;
      for (const state of atCutoff.iterate(start, cutoff, cutoff)) {
        if (!submittedCaseIds.has(state.case_id)) continue;
        covered++;
        const matched = state.duplicate_of !== null && includeCase(state.duplicate_of);
        if (contributions) contributions.get(state.case_id).duplicate = matched;
        if (matched) confirmed++;
      }
      const submitted = submittedCaseIds.size;
      const counts = { submitted, covered, unclassified: submitted - covered, windowHours: config.windowHours };
      if (submitted > 0 && covered === 0) {
        return { status: 'unavailable', reason: 'structured_coverage_missing', ...counts };
      }
      return { status: covered === submitted ? 'available' : 'partial', ...counts,
        confirmed, notConfirmed: covered - confirmed };
    },
    list(principal, before) {
      requireGrant(ledgerEnabled(principal));
      if (before !== null && (!/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(Number(before)))) {
        throw new HttpError(400, 'invalid_cursor');
      }
      const rows = ledger.all(before === null ? Number.MAX_SAFE_INTEGER : Number(before), ledgerLimit + 1);
      const items = rows.slice(0, ledgerLimit);
      return { items, nextBefore: rows.length > ledgerLimit ? items.at(-1).id : null };
    },
    entry(principal, id) {
      requireGrant(ledgerEnabled(principal));
      return read(() => entry(id));
    },
    createEntry(principal, input) {
      requireGrant(ledgerEnabled(principal));
      onlyFields(input, ['topic', 'minutes', 'responsibleUnit', 'dueAt']);
      return write(() => {
        const time = now().toISOString();
        const dueAt = timestamp(input.dueAt);
        if (dueAt <= time) throw new HttpError(400, 'invalid_remediation_due_at');
        const result = insertEntry.run(readText(input.topic, 120), readText(input.minutes, 2000),
          readText(input.responsibleUnit, 120), dueAt, principal.id, time);
        return entry(result.lastInsertRowid);
      });
    },
    reviewEntry(principal, id, input) {
      requireGrant(ledgerEnabled(principal));
      onlyFields(input, ['expectedRevision', 'notes', 'conclusion']);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new HttpError(400, 'invalid_revision');
      }
      if (!['follow_up', 'resolved'].includes(input.conclusion)) throw new HttpError(400, 'invalid_remediation_conclusion');
      return write(() => {
        const row = entry(id);
        const time = now().toISOString();
        if (row.status === 'resolved' || row.revision !== input.expectedRevision ||
            time < (row.reviews.at(-1)?.reviewedAt ?? row.createdAt)) {
          throw new HttpError(409, 'remediation_conflict');
        }
        insertReview.run(id, row.revision + 1, readText(input.notes, 2000), input.conclusion, principal.id, time);
        return entry(id);
      });
    },
  };
}

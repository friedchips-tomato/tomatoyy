import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createCaseDetails, externalStatus } from './case-details.js';
import { HttpError } from './http.js';
import { createMerchantStore } from './merchant-store.js';
import { createMonthlyReport } from './monthly-report.js';
import { createOwnerAuth, privateTokenForCode } from './owner-auth.js';
import { createSupplementPhotos } from './owner-supplement-photos.js';
import { ownerChange } from './owner-workflow.js';
import { createPublishedFeedbackPhotos } from './published-feedback-photos.js';
import { createRepresentativeReports } from './representative-report.js';
import { createStaffWorkbench } from './staff-workbench.js';
import { canReadSubmissionPhotos, createStaffSubmissionPhotos } from './staff-submission-photos.js';
import { createSupervision } from './supervision.js';
import { createTourismCore } from './tourism/index.js';
import { applyAction } from './workflow.js';

const publicSource = 'miniprogram';

// The newest migration number. Production code and its regressions read this value
// instead of repeating the number, so the migration framework has one source of truth.
export const SCHEMA_VERSION = 14;

const initialSchema = readFileSync(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
const ownerSchema = readFileSync(new URL('../migrations/002-owner-workflow.sql', import.meta.url), 'utf8');
const merchantSchema = readFileSync(new URL('../migrations/003-merchants.sql', import.meta.url), 'utf8');
const supplementSchema = readFileSync(new URL('../migrations/004-case-supplement.sql', import.meta.url), 'utf8');
const staffPhotoSchema = readFileSync(new URL('../migrations/005-staff-submission-photos.sql', import.meta.url), 'utf8');
const feedbackPhotoSchema = readFileSync(new URL('../migrations/006-published-feedback-photos.sql', import.meta.url), 'utf8');
const collaborationPhotoSchema = readFileSync(new URL('../migrations/007-collaboration-photos.sql', import.meta.url), 'utf8');
const supplementPhotoSchema = readFileSync(new URL('../migrations/008-owner-supplement-photos.sql', import.meta.url), 'utf8');
const wechatReceiptSchema = readFileSync(new URL('../migrations/009-wechat-receipt-codes.sql', import.meta.url), 'utf8');
const publicSubmissionSchema = readFileSync(new URL('../migrations/010-public-submissions.sql', import.meta.url), 'utf8');
const contactAuditSchema = readFileSync(new URL('../migrations/011-contact-access-audit.sql', import.meta.url), 'utf8');
const supervisionSchema = readFileSync(new URL('../migrations/012-supervision.sql', import.meta.url), 'utf8');
const representativeSchema = readFileSync(new URL('../migrations/013-representative-reports.sql', import.meta.url), 'utf8');
const tourismSchema = readFileSync(new URL('../migrations/014-tourism-events.sql', import.meta.url), 'utf8');

export function openStore(dbPath, receiptKey, now, periods) {
  const db = new DatabaseSync(dbPath);
  function transaction(operation, begin) {
    db.exec(begin);
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  const write = operation => transaction(operation, 'BEGIN IMMEDIATE');
  const read = operation => transaction(operation, 'BEGIN');

  const sign = value => createHmac('sha256', receiptKey).update(value).digest('base64url');
  let tourism;
  try {
    // Table rebuilds preserve IDs and validate all references before commit.
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF; PRAGMA synchronous = FULL;');
    write(() => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const keyCheck = sign('changdi-intake:verify-receipt-key:v1');
      if (version === 0) {
        db.exec(initialSchema);
        db.prepare('INSERT INTO settings VALUES (?, ?)').run('receipt_key_check', keyCheck);
      } else if (version < 1 || version > SCHEMA_VERSION) {
        throw new Error('Unsupported database schema version');
      } else if (db.prepare('SELECT value FROM settings WHERE key = ?').get('receipt_key_check')?.value !== keyCheck) {
        throw new Error('Receipt key does not match database');
      }
      if (version < 2) {
        db.exec(ownerSchema);
        db.prepare(`
          UPDATE cases SET reopen_ends_at = (
            SELECT strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+' || ? || ' seconds')
            FROM case_events WHERE case_id = cases.id AND action = 'publish' ORDER BY version DESC LIMIT 1
          ) WHERE status IN ('awaiting_evaluation', 'closed')
        `).run(periods.reopenSeconds);
      }
      if (version < 3) {
        db.exec(merchantSchema);
      }
      if (version < 4) {
        db.exec(supplementSchema);
      }
      if (version < 5) {
        db.exec(staffPhotoSchema);
      }
      if (version < 6) {
        db.exec(feedbackPhotoSchema);
      }
      if (version < 7) {
        db.exec(collaborationPhotoSchema);
      }
      if (version < 8) {
        db.exec(supplementPhotoSchema);
      }
      if (version < 9) {
        db.exec(wechatReceiptSchema);
        if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid case references after migration');
        db.exec('PRAGMA user_version = 9');
      }
      if (version < 10) {
        db.exec(publicSubmissionSchema);
        if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid case references after migration');
        db.exec('PRAGMA user_version = 10');
      }
      if (version < 11) {
        db.exec(contactAuditSchema);
        if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid case references after migration');
        db.exec('PRAGMA user_version = 11');
      }
      if (version < 12) {
        db.exec(supervisionSchema);
        if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid case references after migration');
        db.exec('PRAGMA user_version = 12');
      }
      if (version < 13) {
        db.exec(representativeSchema);
        if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid case references after migration');
        db.exec('PRAGMA user_version = 13');
      }
      if (version < SCHEMA_VERSION) {
        db.exec(tourismSchema);
        if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid case references after migration');
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      tourism = createTourismCore(db, {...periods.tourism, now});
    });
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }

  function receipt(item) {
    return {
      caseNumber: item.case_number,
      publicLookupCode: item.public_lookup_code,
      privateLookupToken: privateTokenForCode(sign, item.public_lookup_code),
    };
  }

  const insertEvent = db.prepare(`
    INSERT INTO case_events
      (case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public, round)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const caseByNumber = db.prepare('SELECT * FROM cases WHERE case_number = ?');
  const pendingReopen = db.prepare('SELECT * FROM reopen_requests WHERE case_id = ? AND decision IS NULL');
  const feedbackPhotos = createPublishedFeedbackPhotos(db);
  const details = createCaseDetails(db, feedbackPhotos);
  const ownerAuth = createOwnerAuth(db, sign, now);
  const staffWorkbench = createStaffWorkbench(db, now, read);
  const supervision = createSupervision(db, now, read, write, staffWorkbench, periods.supervision);
  const summarizeMonth = createMonthlyReport(db, now, supervision.duplicateStats);
  const monthlyReport = (month, options) => read(() => {
    const asOf = now().valueOf();
    return {
      ...summarizeMonth(month, {...options, asOf: Math.floor(asOf / 1000) * 1000}),
      tourism: tourism.summarizeAt(month, asOf)
    };
  });
  const representativeReports = createRepresentativeReports(db, now, write, summarizeMonth, periods.representativeReports);
  const staffPhotos = createStaffSubmissionPhotos(db);
  const supplementPhotos = createSupplementPhotos(db);
  const receiptCode = db.prepare(`
    SELECT media_type AS mediaType, bytes FROM wechat_receipt_codes
    WHERE case_id = ? AND app_scope = ? AND env_version = ?
  `);

  function getCase(caseNumber) {
    const item = caseByNumber.get(caseNumber);
    if (!item) throw new HttpError(404, 'case_not_found');
    return item;
  }

  function scopedCase(caseNumber, principal) {
    return staffWorkbench.case(principal, caseNumber);
  }

  function staffDetails(item, principal) {
    const result = details.staff(item, principal);
    if (canReadSubmissionPhotos(principal)) result.submissionPhotos = staffPhotos.list(item.id);
    return withSupplementPhotos(item.id, result);
  }

  function withSupplementPhotos(caseId, result) {
    const photos = supplementPhotos.list(caseId);
    if (photos.length) result.supplementPhotos = photos;
    return result;
  }

  function ownerDetails(item, time) {
    return withSupplementPhotos(item.id, details.owner(item, time));
  }

  function createCase(source, requestId, actorType, actorId, { payload, photos, hash }, beforeCreate) {
    const previous = db.prepare(`
      SELECT id, submission_hash, case_number, public_lookup_code
      FROM cases WHERE source = ? AND external_case_id = ?
    `).get(source, requestId);
    if (previous) {
      if (previous.submission_hash !== hash) throw new HttpError(409, 'submission_conflict');
      return { created: false, item: previous };
    }
    // The creation guard runs only for a new case, so a replay or a conflict never fails on it.
    if (beforeCreate) beforeCreate();
    const caseNumber = 'CD-' + randomUUID().replaceAll('-', '').toUpperCase();
    const publicLookupCode = randomBytes(18).toString('base64url');
    const result = db.prepare(`
      INSERT INTO cases (source, external_case_id, submission_hash, case_number, public_lookup_code,
        occurred_at, location, category, description, suggested_department, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
    `).run(source, requestId, hash, caseNumber, publicLookupCode,
      payload.occurredAt, payload.location, payload.category, payload.description, payload.suggestedDepartment ?? null);
    const id = result.lastInsertRowid;
    if (payload.contact !== undefined) {
      db.prepare('INSERT INTO case_contacts VALUES (?, ?)').run(id, payload.contact);
    }
    const insertPhoto = db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)');
    photos.forEach((photo, position) => {
      insertPhoto.run(id, position, photo.mediaType, photo.bytes.length, photo.sha256, photo.bytes);
    });
    insertEvent.run(id, 1, 'submit', 'submitted', actorType, actorId, now().toISOString(), '{}', 1, 1);
    return { created: true, item: { id, case_number: caseNumber, public_lookup_code: publicLookupCode } };
  }

  const merchant = createMerchantStore(db, {
    now, write, read, createCase, scopedCase,
    recordAssignment(item, principal, time) {
      const version = item.version + 1;
      db.prepare('UPDATE cases SET version = ? WHERE id = ?').run(version, item.id);
      insertEvent.run(item.id, version, 'assign_collaboration', item.status, 'staff', principal.id, time, '{}', 0, item.round);
    },
  });

  const store = {
    close: () => db.close(),
    merchant,
    staffWorkbench,
    monthlyReport,
    tourism,
    supervision,
    representativeReports,
    merchantClaimant: {
      case(principal, number) {
        return store.ownerCase(number, () => merchant.ownReceipt(principal, number));
      },
      action(principal, number, input) {
        return store.ownerAction(number, input, [], () => merchant.ownReceipt(principal, number));
      },
      feedbackPhoto(principal, number, version, position) {
        return read(() => feedbackPhotos.read(merchant.ownReceipt(principal, number).caseId, version, position));
      },
    },
    submit(source, submission) {
      return write(() => {
        const { created, item } = createCase(source, submission.payload.externalCaseId, 'integration', source, submission);
        return { created, caseId: item.id, receipt: receipt(item) };
      });
    },
    submitPublic(submission, beforeCreate) {
      return write(() => {
        const { created, item } = createCase(publicSource, submission.payload.clientRequestId,
          'public', publicSource, submission, beforeCreate);
        return { created, caseId: item.id, receipt: receipt(item) };
      });
    },
    readWechatCode(caseId, scope, envVersion) {
      return receiptCode.get(caseId, scope, envVersion);
    },
    saveWechatCode(caseId, scope, envVersion, { mediaType, bytes }) {
      return write(() => {
        db.prepare(`
          INSERT INTO wechat_receipt_codes (case_id, app_scope, env_version, media_type, bytes)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (case_id, app_scope, env_version) DO NOTHING
        `).run(caseId, scope, envVersion, mediaType, bytes);
        return receiptCode.get(caseId, scope, envVersion);
      });
    },
    publicStatus(code) {
      // A single SELECT gives the case and its public events from the same snapshot.
      const rows = db.prepare(`
        SELECT cases.case_number AS caseNumber, cases.status AS currentStatus,
          case_events.status, case_events.occurred_at AS occurredAt
        FROM cases JOIN case_events ON case_events.case_id = cases.id
        WHERE cases.public_lookup_code = ? AND case_events.public = 1 ORDER BY case_events.version
      `).all(code);
      if (!rows.length) throw new HttpError(404, 'case_not_found');
      const { caseNumber, currentStatus } = rows[0];
      return {
        caseNumber,
        status: externalStatus(currentStatus),
        milestones: rows.map(({ status, occurredAt }) => ({ status, occurredAt })),
      };
    },
    staffCase(caseNumber, principal) {
      return read(() => staffDetails(scopedCase(caseNumber, principal), principal));
    },
    staffContact(caseNumber, principal) {
      if (principal.type !== 'staff' || principal.readContact !== true) throw new HttpError(403, 'forbidden');
      // Lock the write snapshot so reassignment cannot race the scope check and audit.
      return write(() => {
        const { id } = scopedCase(caseNumber, principal);
        const row = db.prepare('SELECT contact FROM case_contacts WHERE case_id = ?').get(id);
        const audit = db.prepare(
          'INSERT INTO case_contact_access_audit (case_id, staff_id, accessed_at) VALUES (?, ?, ?)'
        ).run(id, principal.id, now().toISOString());
        if (audit.changes !== 1) throw new Error('Contact access audit was not written');
        return { contact: row?.contact ?? null };
      });
    },
    staffSubmissionPhoto(caseNumber, principal, version, position) {
      if (!canReadSubmissionPhotos(principal)) throw new HttpError(403, 'forbidden');
      return read(() => staffPhotos.read(scopedCase(caseNumber, principal).id, version, position));
    },
    staffSupplementPhoto(caseNumber, principal, version, position) {
      return read(() => supplementPhotos.read(scopedCase(caseNumber, principal).id, version, position));
    },
    staffAction(caseNumber, principal, staff, input, photos = []) {
      return write(() => {
        const item = scopedCase(caseNumber, principal);
        const time = now().toISOString();
        const pending = item.status === 'reopen_pending' ? pendingReopen.get(item.id) : null;
        const change = applyAction(input, item, principal, staff, time, periods, pending, photos.length > 0);
        const version = item.version + 1;
        db.prepare(`
          UPDATE cases SET status = ?, version = ?, department = ?, assignee = ?, due_at = ?,
            evaluation_ends_at = ?, reopen_ends_at = ?, round = ?
          WHERE id = ?
        `).run(change.status, version, change.department, change.assignee, change.dueAt,
          change.evaluationEndsAt, change.reopenEndsAt, change.round, item.id);
        if (change.reopenDecision) {
          db.prepare(`
            UPDATE reopen_requests SET decision = ?, decision_reason = ?, decided_at = ?, decided_by = ?
            WHERE case_id = ? AND requested_version = ?
          `).run(change.reopenDecision, change.detail.reason ?? null, time, principal.id, item.id, pending.requested_version);
          // Review reasons live in the permission-scoped application record.
          delete change.detail.reason;
        }
        insertEvent.run(item.id, version, input.action, change.status, 'staff',
          principal.id, time, JSON.stringify(change.detail), Number(change.public), change.round);
        if (photos.length) {
          if (input.action === 'publish') feedbackPhotos.write(item.id, version, photos);
          else staffPhotos.write(item.id, version, photos);
        }
        return staffDetails(getCase(caseNumber), principal);
      });
    },
    verifyOwner(input, address) {
      return write(() => ownerAuth.verify(input, address));
    },
    authenticateOwner: ownerAuth.authenticate,
    ownerCase(caseNumber, authorize) {
      return read(() => {
        authorize?.();
        return ownerDetails(getCase(caseNumber), now().toISOString());
      });
    },
    ownerFeedbackPhoto(caseNumber, version, position) {
      return read(() => feedbackPhotos.read(getCase(caseNumber).id, version, position));
    },
    ownerSupplementPhoto(caseNumber, version, position) {
      return read(() => supplementPhotos.read(getCase(caseNumber).id, version, position));
    },
    ownerAction(caseNumber, input, photos = [], authorize) {
      return write(() => {
        authorize?.();
        if (photos.length && input.action !== 'submit_supplement') throw new HttpError(400, 'invalid_action');
        const item = getCase(caseNumber);
        const time = now().toISOString();
        const change = ownerChange(input, item, time);
        const version = item.version + 1;
        if (change.scores) {
          const { speed, effectiveness, attitude, comment } = change.scores;
          const result = db.prepare(`
            INSERT INTO case_evaluations VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (case_id, round) DO NOTHING
          `).run(item.id, item.round, speed, effectiveness, attitude, comment, time);
          if (!result.changes) throw new HttpError(409, 'evaluation_exists');
        }
        db.prepare('UPDATE cases SET status = ?, version = ? WHERE id = ?').run(change.status, version, item.id);
        insertEvent.run(item.id, version, input.action, change.status, 'owner',
          'claimant', time, JSON.stringify(change.detail ?? {}), Number(input.action !== 'evaluate'), item.round);
        if (photos.length) supplementPhotos.write(item.id, version, photos);
        if (input.action === 'request_reopen') {
          db.prepare(`
            INSERT INTO reopen_requests (case_id, requested_version, round, previous_status, reason, requested_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(item.id, version, item.round, item.status, change.reason, time);
        }
        return ownerDetails(getCase(caseNumber), time);
      });
    },
  };
  return store;
}

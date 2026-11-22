import { HttpError } from './http.js';

export function canReadSubmissionPhotos(principal) {
  return principal.role === 'handler' || principal.role === 'supervisor';
}

export function createStaffSubmissionPhotos(db) {
  const insert = db.prepare('INSERT INTO staff_submission_photos VALUES (?, ?, ?, ?, ?, ?, ?)');
  const metadata = db.prepare(`
    SELECT e.round, p.submit_version AS submitVersion, p.position, p.media_type AS mediaType, p.size
    FROM staff_submission_photos p
    JOIN case_events e ON e.case_id = p.case_id AND e.version = p.submit_version
    WHERE p.case_id = ? AND e.action = 'submit_result' ORDER BY p.submit_version, p.position
  `);
  const byVersion = db.prepare(`
    SELECT p.media_type AS mediaType, p.bytes
    FROM staff_submission_photos p
    JOIN case_events e ON e.case_id = p.case_id AND e.version = p.submit_version
    WHERE p.case_id = ? AND p.submit_version = ? AND p.position = ? AND e.action = 'submit_result'
  `);
  return {
    write(caseId, version, photos) {
      photos.forEach(({ mediaType, bytes, sha256 }, position) => {
        insert.run(caseId, version, position, mediaType, bytes.length, sha256, bytes);
      });
    },
    list(caseId) {
      return metadata.all(caseId);
    },
    read(caseId, version, position) {
      const photo = byVersion.get(caseId, version, position);
      if (!photo) throw new HttpError(404, 'submission_photo_not_found');
      return photo;
    },
  };
}

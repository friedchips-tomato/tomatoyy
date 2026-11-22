import { HttpError } from './http.js';

export function createPublishedFeedbackPhotos(db) {
  const original = db.prepare(`
    SELECT 1 FROM attachments WHERE case_id = ? AND sha256 = ?
    UNION ALL
    SELECT 1 FROM staff_submission_photos WHERE case_id = ? AND sha256 = ?
    UNION ALL
    SELECT 1 FROM collaboration_submission_photos p
    JOIN collaboration_tasks t ON t.id = p.task_id
    WHERE t.case_id = ? AND p.sha256 = ?
    UNION ALL
    SELECT 1 FROM owner_supplement_photos WHERE case_id = ? AND sha256 = ?
    LIMIT 1
  `);
  const insert = db.prepare('INSERT INTO published_feedback_photos VALUES (?, ?, ?, ?, ?, ?)');
  const published = `
    FROM published_feedback_photos p JOIN case_events e
      ON e.case_id = p.case_id AND e.version = p.publish_version
    WHERE p.case_id = ? AND e.action = 'publish' AND e.public = 1 AND e.actor_type = 'staff'
  `;
  const metadata = db.prepare(`
    SELECT p.publish_version AS publishVersion, p.position, 'image/png' AS mediaType, p.size
    ${published} ORDER BY p.publish_version, p.position
  `);
  const byVersion = db.prepare(`
    SELECT 'image/png' AS mediaType, p.bytes ${published} AND p.publish_version = ? AND p.position = ?
  `);
  return {
    write(caseId, version, photos) {
      photos.forEach(({ bytes, originalSha256, sha256 }, position) => {
        if ([originalSha256, sha256].some(hash => original.get(caseId, hash, caseId, hash, caseId, hash, caseId, hash))) {
          throw new HttpError(409, 'feedback_original_not_allowed');
        }
        insert.run(caseId, version, position, bytes.length, sha256, bytes);
      });
    },
    list(caseId) {
      return metadata.all(caseId);
    },
    read(caseId, version, position) {
      const photo = byVersion.get(caseId, version, position);
      if (!photo) throw new HttpError(404, 'feedback_photo_not_found');
      return photo;
    },
  };
}

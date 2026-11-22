import { HttpError } from './http.js';

export function createSupplementPhotos(db) {
  const insert = db.prepare('INSERT INTO owner_supplement_photos VALUES (?, ?, ?, ?, ?, ?, ?)');
  const scoped = `
    FROM owner_supplement_photos p JOIN case_events e ON e.case_id = p.case_id AND e.version = p.submit_version
    WHERE p.case_id = ? AND e.action = 'submit_supplement' AND e.actor_type = 'owner'
  `;
  const metadata = db.prepare(`
    SELECT e.round, p.submit_version AS submitVersion, p.position, p.media_type AS mediaType, p.size
    ${scoped} ORDER BY p.submit_version, p.position
  `);
  const locate = db.prepare(`
    SELECT p.media_type AS mediaType, p.bytes ${scoped} AND p.submit_version = ? AND p.position = ?
  `);
  return {
    write(caseId, version, photos) {
      photos.forEach(({ mediaType, bytes, sha256 }, position) => {
        insert.run(caseId, version, position, mediaType, bytes.length, sha256, bytes);
      });
    },
    list(caseId) { return metadata.all(caseId); },
    read(caseId, version, position) {
      const photo = locate.get(caseId, version, position);
      if (!photo) throw new HttpError(404, 'supplement_photo_not_found');
      return photo;
    },
  };
}

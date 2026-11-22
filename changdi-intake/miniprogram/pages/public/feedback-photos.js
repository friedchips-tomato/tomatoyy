const { casePattern } = require('../staff/workbench');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const maxSize = 5 * 1024 * 1024;

function publishedPhotos(rounds, version) {
  if (!Array.isArray(rounds) || !Number.isSafeInteger(version)) return [];
  const photos = [];
  const seen = new Set();
  for (const entry of rounds) {
    if (!entry || !Number.isSafeInteger(entry.round) || entry.round < 1 || !entry.feedback ||
        !Array.isArray(entry.feedback.photos)) continue;
    for (const photo of entry.feedback.photos) {
      if (!photo || !Number.isSafeInteger(photo.publishVersion) || photo.publishVersion < 1 ||
          photo.publishVersion > version || !Number.isInteger(photo.position) || photo.position < 0 ||
          photo.position > 2 || photo.mediaType !== 'image/png' || !Number.isSafeInteger(photo.size) ||
          photo.size < 45 || photo.size > maxSize) continue;
      const key = photo.publishVersion + '/' + photo.position;
      if (seen.has(key)) continue;
      seen.add(key);
      photos.push({ key, round: entry.round, position: photo.position, mediaType: photo.mediaType, size: photo.size });
    }
  }
  return photos;
}

function fetchOwnerPhoto({ baseUrl, caseNumber, photo, token, timeout }, section) {
  const { origin } = apiEnvironment();
  if (!origin || baseUrl !== origin || !casePattern.test(caseNumber) || !token || !/^[1-9][0-9]*\/[0-2]$/.test(photo.key)) {
    return Promise.reject({});
  }
  return new Promise((resolve, reject) => {
    requestConfigured({
      url: origin + '/api/v1/owner/cases/' + caseNumber + '/' + section + '/' + photo.key,
      method: 'GET', responseType: 'arraybuffer', dataType: 'text', timeout,
      header: { Authorization: 'Bearer ' + token },
      success: result => result.statusCode === 200 ? resolve(result) : reject({ status: result.statusCode }),
      fail: () => reject({})
    });
  });
}

const fetchFeedbackPhoto = options => fetchOwnerPhoto(options, 'feedback-photos');
const fetchSupplementPhoto = options => fetchOwnerPhoto(options, 'supplement-photos');

module.exports = { publishedPhotos, fetchFeedbackPhoto, fetchSupplementPhoto };

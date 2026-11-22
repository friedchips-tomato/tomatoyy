import {
  HttpError,
  isMultipart,
  readAction,
  requireMethod,
  sendJson,
  sendPhoto,
} from '../http.js';
import {readOwnerSupplementWithPhotos} from '../intake.js';

const ownerPath = /^\/api\/v1\/owner\/cases\/(CD-[0-9A-F]{32})(\/actions)?$/;
const ownerFeedbackPath = /^\/api\/v1\/owner\/cases\/(CD-[0-9A-F]{32})\/feedback-photos\/([1-9][0-9]{0,15})\/([0-2])$/;
const supplementPhotoPath = /^\/api\/v1\/(owner|staff)\/cases\/(CD-[0-9A-F]{32})\/supplement-photos\/([1-9][0-9]{0,15})\/([0-2])$/;
const ownerVerifyPath = '/api/v1/owner/verify';

/** Returns whether this route group handled the request. */
export async function handleOwnerRoute(request, response, {
  auth, store, readPhotoUpload,
}) {
  if (request.url === ownerVerifyPath) {
    requireMethod(request, response, 'POST');
    if (request.headers.authorization !== undefined) {
      throw new HttpError(403, 'forbidden');
    }
    const address = request.socket.remoteAddress ?? 'unknown';
    const result = store.verifyOwner(await readAction(request), address);
    if (!result) {
      throw new HttpError(401, 'invalid_private_lookup_token');
    }
    if (result.retryAfter) {
      response.setHeader('Retry-After', String(result.retryAfter));
      throw new HttpError(429, 'owner_verification_limited');
    }
    sendJson(response, 200, result);
    return true;
  }
  const ownerFeedback = ownerFeedbackPath.exec(request.url);
  if (ownerFeedback) {
    requireMethod(request, response, 'GET');
    const [, caseNumber, version, position] = ownerFeedback;
    store.authenticateOwner(request.headers.authorization, caseNumber);
    if (!Number.isSafeInteger(Number(version))) {
      throw new HttpError(404, 'feedback_photo_not_found');
    }
    sendPhoto(response, store.ownerFeedbackPhoto(caseNumber, Number(version), Number(position)));
    return true;
  }
  const supplementPhoto = supplementPhotoPath.exec(request.url);
  if (supplementPhoto) {
    requireMethod(request, response, 'GET');
    const [, kind, caseNumber, rawVersion, rawPosition] = supplementPhoto;
    const version = Number(rawVersion);
    const position = Number(rawPosition);
    if (kind === 'owner') {
      store.authenticateOwner(request.headers.authorization, caseNumber);
      if (!Number.isSafeInteger(version)) {
        throw new HttpError(404, 'supplement_photo_not_found');
      }
      sendPhoto(response, store.ownerSupplementPhoto(caseNumber, version, position));
    } else {
      const principal = auth.authenticate(request, 'staff');
      if (!Number.isSafeInteger(version)) {
        throw new HttpError(404, 'supplement_photo_not_found');
      }
      sendPhoto(response, store.staffSupplementPhoto(caseNumber, principal, version, position));
    }
    return true;
  }
  const ownerMatch = ownerPath.exec(request.url);
  if (ownerMatch) {
    const [, caseNumber, actions] = ownerMatch;
    requireMethod(request, response, actions ? 'POST' : 'GET');
    store.authenticateOwner(request.headers.authorization, caseNumber);
    if (actions) {
      const { payload, photos } = isMultipart(request)
        ? await readPhotoUpload(request, response, readOwnerSupplementWithPhotos)
        : { payload: await readAction(request) };
      store.authenticateOwner(request.headers.authorization, caseNumber);
      sendJson(response, 200, store.ownerAction(caseNumber, payload, photos));
    } else {
      sendJson(response, 200, store.ownerCase(caseNumber));
    }
    return true;
  }
  return false;
}

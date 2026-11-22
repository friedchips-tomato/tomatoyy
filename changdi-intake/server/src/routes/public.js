import {
  requireMethod,
  sendJson,
} from '../http.js';
import {readPublicIntake} from '../intake.js';

const publicCasesPath = '/api/v1/public/cases';
const publicCasePath = /^\/api\/v1\/public\/cases\/([A-Za-z0-9_-]{24})$/;

/** Returns whether this route group handled the request. */
export async function handlePublicRoute(request, response, {
  store, receiptCode, readPhotoUpload, rateLimiter,
}) {
  if (request.url === publicCasesPath) {
    requireMethod(request, response, 'POST');
    // The endpoint is anonymous. A carried credential is ignored, never required.
    const upload = await readPhotoUpload(request, response, readPublicIntake);
    const address = request.socket.remoteAddress ?? 'unknown';
    // The limit guards new cases only. A replay or a conflict settles inside the store
    // transaction without reaching the guard, so an existing receipt is always retrievable.
    const { created, receipt, caseId } = store.submitPublic(upload, () => rateLimiter.check(address));
    if (created) rateLimiter.record(address);
    if (receiptCode) {
      receipt.wechatCode = await receiptCode(caseId, receipt.publicLookupCode);
    }
    if (response.destroyed) {
      return true;
    }
    sendJson(response, created ? 201 : 200, receipt);
    return true;
  }
  const publicMatch = publicCasePath.exec(request.url);
  if (publicMatch) {
    requireMethod(request, response, 'GET');
    sendJson(response, 200, store.publicStatus(publicMatch[1]));
    return true;
  }
  return false;
}

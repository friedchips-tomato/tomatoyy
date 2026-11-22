import {
  HttpError,
  onlyFields,
  readAction,
  requireMethod,
  sendJson,
} from '../http.js';
import {readIntake} from '../intake.js';

const intakePath = '/api/v1/integrations/intake/cases';
const wechatLoginPath = '/api/v1/auth/wechat/session';

/** Returns whether this route group handled the request. */
export async function handleIntakeRoute(request, response, {
  auth, store, receiptCode, readPhotoUpload,
}) {
  if (request.url === intakePath) {
    requireMethod(request, response, 'POST');
    const integration = auth.authenticate(request, 'integration');
    const upload = await readPhotoUpload(request, response, readIntake);
    const {created, receipt, caseId} = store.submit(integration.id, upload);
    if (receiptCode) {
      receipt.wechatCode = await receiptCode(caseId, receipt.publicLookupCode);
    }
    if (response.destroyed) {
      return true;
    }
    sendJson(response, created ? 201 : 200, receipt);
    return true;
  }
  if (auth.login && request.url === wechatLoginPath) {
    requireMethod(request, response, 'POST');
    if (request.headers.authorization !== undefined) {
      throw new HttpError(403, 'forbidden');
    }
    const input = await readAction(request);
    onlyFields(input, ['code']);
    const session = await auth.login.issue(input.code);
    if (!response.destroyed) {
      sendJson(response, 200, session);
    }
    return true;
  }
  return false;
}

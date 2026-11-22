import {
  HttpError,
  isMultipart,
  readAction,
  readFilters,
  requireMethod,
  sendJson,
  sendPhoto,
} from '../http.js';
import {readCollaborationSubmissionWithPhotos, readIntake} from '../intake.js';

const merchantCaseList = /^\/api\/v1\/merchant\/cases(?:\?(.*))?$/;
const merchantCasePath = /^\/api\/v1\/merchant\/cases\/(CD-[0-9A-F]{32})$/;
const merchantTaskList = /^\/api\/v1\/merchant\/collaborations(?:\?(.*))?$/;
const merchantTaskPath = /^\/api\/v1\/merchant\/collaborations\/(CT-[0-9A-F]{32})(\/submissions)?$/;
const merchantTaskPhotoPath = /^\/api\/v1\/merchant\/collaborations\/(CT-[0-9A-F]{32})\/submission-photos\/([1-9][0-9]{0,15})\/([0-2])$/;

function requireGrant(principal, permission) {
  if (!principal.permissions.has(permission)) {
    throw new HttpError(403, 'forbidden');
  }
}

/** Returns whether this route group handled the request. */
export async function handleMerchantRoute(request, response, {
  auth, store, readPhotoUpload,
}) {
  if (request.url === '/api/v1/merchant/me') {
    requireMethod(request, response, 'GET');
    const { merchantId, permissions } = auth.authenticate(request, 'merchant');
    sendJson(response, 200, { merchantId, permissions: [...permissions] });
    return true;
  }
  const merchantCases = merchantCaseList.exec(request.url);
  if (merchantCases) {
    const principal = auth.authenticate(request, 'merchant');
    if (request.method === 'POST') {
      requireGrant(principal, 'submitCases');
      if (merchantCases[1] !== undefined) {
        throw new HttpError(400, 'invalid_filter');
      }
      const upload = await readPhotoUpload(request, response, req => readIntake(req, true));
      const current = auth.authenticate(request, 'merchant');
      requireGrant(current, 'submitCases');
      const { created, summary } = store.merchant.submit(current, upload);
      sendJson(response, created ? 201 : 200, summary);
    } else {
      requireMethod(request, response, 'GET');
      requireGrant(principal, 'readCases');
      const params = readFilters(merchantCases[1], ['status', 'before']);
      sendJson(response, 200, store.merchant.cases(principal, {
        status: params.get('status'), before: params.get('before'),
      }));
    }
    return true;
  }
  const merchantCase = merchantCasePath.exec(request.url);
  if (merchantCase) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireGrant(principal, 'readCases');
    sendJson(response, 200, store.merchant.case(principal, merchantCase[1]));
    return true;
  }
  const merchantTasks = merchantTaskList.exec(request.url);
  if (merchantTasks) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireGrant(principal, 'collaborate');
    sendJson(response, 200, store.merchant.tasks(principal, readFilters(merchantTasks[1], ['before']).get('before')));
    return true;
  }
  const merchantTask = merchantTaskPath.exec(request.url);
  if (merchantTask) {
    const [, taskId, submitting] = merchantTask;
    requireMethod(request, response, submitting ? 'POST' : 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireGrant(principal, 'collaborate');
    if (submitting && isMultipart(request)) {
      store.merchant.task(principal, taskId);
      const { payload, photos } = await readPhotoUpload(request, response, readCollaborationSubmissionWithPhotos);
      const current = auth.authenticate(request, 'merchant');
      requireGrant(current, 'collaborate');
      sendJson(response, 200, store.merchant.submitTask(current, taskId, payload, photos));
      return true;
    }
    if (submitting) {
      const input = await readAction(request);
      const current = auth.authenticate(request, 'merchant');
      requireGrant(current, 'collaborate');
      sendJson(response, 200, store.merchant.submitTask(current, taskId, input));
    } else {
      sendJson(response, 200, store.merchant.task(principal, taskId));
    }
    return true;
  }
  const merchantTaskPhoto = merchantTaskPhotoPath.exec(request.url);
  if (merchantTaskPhoto) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireGrant(principal, 'collaborate');
    const [, taskId, version, position] = merchantTaskPhoto;
    if (!Number.isSafeInteger(Number(version))) {
      throw new HttpError(404, 'collaboration_photo_not_found');
    }
    sendPhoto(response, store.merchant.taskPhoto(principal, taskId, Number(version), Number(position)));
    return true;
  }
  return false;
}

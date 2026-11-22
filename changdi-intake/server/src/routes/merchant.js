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
const merchantReceiptPath = /^\/api\/v1\/merchant\/cases\/(CD-[0-9A-F]{32})\/receipt$/;
const merchantOwnerPath = /^\/api\/v1\/merchant\/cases\/(CD-[0-9A-F]{32})\/claimant(\/actions)?$/;
const merchantFeedbackPath = /^\/api\/v1\/merchant\/cases\/(CD-[0-9A-F]{32})\/claimant\/feedback-photos\/([1-9][0-9]{0,14})\/([0-2])$/;
const representativeReportPath = /^\/api\/v1\/merchant\/representative-report(?:\?(.*))?$/;
const merchantTaskList = /^\/api\/v1\/merchant\/collaborations(?:\?(.*))?$/;
const merchantTaskPath = /^\/api\/v1\/merchant\/collaborations\/(CT-[0-9A-F]{32})(\/submissions)?$/;
const merchantTaskPhotoPath = /^\/api\/v1\/merchant\/collaborations\/(CT-[0-9A-F]{32})\/submission-photos\/([1-9][0-9]{0,15})\/([0-2])$/;

function requireGrant(principal, permission) {
  if (!principal.permissions.has(permission)) {
    throw new HttpError(403, 'forbidden');
  }
}

function requireClaimantGrant(principal) {
  if (!principal.permissions.has('readCases') && !principal.permissions.has('submitCases')) {
    throw new HttpError(403, 'forbidden');
  }
}

async function withWechatCode(result, receiptCode) {
  if (!receiptCode) return result.summary;
  let timer;
  try {
    const fallback = new Promise(resolve => { timer = setTimeout(resolve, 4000, null); });
    const wechatCode = await Promise.race([receiptCode(result.caseId, result.summary.publicLookupCode), fallback]);
    return { ...result.summary, wechatCode };
  } catch {
    return { ...result.summary, wechatCode: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns whether this route group handled the request. */
export async function handleMerchantRoute(request, response, {
  auth, store, readPhotoUpload, receiptCode,
}) {
  if (request.url === '/api/v1/merchant/me') {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    const permissions = [...principal.permissions].filter(permission =>
      permission !== 'representativeReport' || store.representativeReports.enabled(principal));
    sendJson(response, 200, { merchantId: principal.merchantId, permissions });
    return true;
  }
  const representativeReport = representativeReportPath.exec(request.url);
  if (representativeReport) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    if (!store.representativeReports.enabled(principal)) throw new HttpError(403, 'forbidden');
    const month = readFilters(representativeReport[1], ['month']).get('month');
    sendJson(response, 200, store.representativeReports.get(principal, month));
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
      const result = store.merchant.submit(current, upload);
      const summary = await withWechatCode(result, receiptCode);
      if (response.destroyed) return true;
      const finalPrincipal = auth.authenticate(request, 'merchant');
      requireGrant(finalPrincipal, 'submitCases');
      store.merchant.ownReceipt(finalPrincipal, summary.caseNumber);
      sendJson(response, result.created ? 201 : 200, summary);
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
  const merchantReceipt = merchantReceiptPath.exec(request.url);
  if (merchantReceipt) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireClaimantGrant(principal);
    const number = merchantReceipt[1];
    const summary = await withWechatCode(store.merchant.ownReceipt(principal, number), receiptCode);
    if (response.destroyed) return true;
    const current = auth.authenticate(request, 'merchant');
    requireClaimantGrant(current);
    store.merchant.ownReceipt(current, number);
    sendJson(response, 200, summary);
    return true;
  }
  const claimant = merchantOwnerPath.exec(request.url);
  const feedbackPhoto = merchantFeedbackPath.exec(request.url);
  if (feedbackPhoto) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireClaimantGrant(principal);
    const [, number, version, position] = feedbackPhoto;
    sendPhoto(response, store.merchantClaimant.feedbackPhoto(principal, number, Number(version), Number(position)));
    return true;
  }
  if (claimant) {
    const [, number, actions] = claimant;
    requireMethod(request, response, actions ? 'POST' : 'GET');
    const principal = auth.authenticate(request, 'merchant');
    requireClaimantGrant(principal);
    if (actions) {
      store.merchant.ownReceipt(principal, number);
      const input = await readAction(request);
      if (!['evaluate', 'confirm_resolved', 'request_reopen'].includes(input.action)) throw new HttpError(400, 'invalid_action');
      const current = auth.authenticate(request, 'merchant');
      requireClaimantGrant(current);
      sendJson(response, 200, store.merchantClaimant.action(current, number, input));
    } else {
      sendJson(response, 200, store.merchantClaimant.case(principal, number));
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

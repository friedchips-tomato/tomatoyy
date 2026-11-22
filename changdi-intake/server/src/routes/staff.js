import {
  HttpError,
  isMultipart,
  readAction,
  readFilters,
  requireMethod,
  sendJson,
  sendPhoto,
} from '../http.js';
import {readStaffActionWithPhotos} from '../intake.js';
import {canAssignHandler} from '../workflow.js';

const staffPath = /^\/api\/v1\/staff\/cases\/(CD-[0-9A-F]{32})(\/actions)?$/;
const staffPhotoPath = /^\/api\/v1\/staff\/cases\/(CD-[0-9A-F]{32})\/submission-photos\/([1-9][0-9]{0,15})\/([0-2])$/;
const staffCaseList = /^\/api\/v1\/staff\/cases(?:\?(.*))?$/;
const staffTasksPath = /^\/api\/v1\/staff\/cases\/(CD-[0-9A-F]{32})\/collaborations(?:\/(CT-[0-9A-F]{32})\/actions)?$/;
const staffTaskPhotoPath = /^\/api\/v1\/staff\/cases\/(CD-[0-9A-F]{32})\/collaborations\/(CT-[0-9A-F]{32})\/submission-photos\/([1-9][0-9]{0,15})\/([0-2])$/;

/** Returns whether this route group handled the request. */
export async function handleStaffRoute(request, response, {
  auth, store, readPhotoUpload,
}) {
  if (request.url === '/api/v1/staff/me') {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    sendJson(response, 200, {
      id: principal.id,
      role: principal.role,
      department: principal.role === 'duty' ? null : principal.department,
    });
    return true;
  }
  if (request.url === '/api/v1/staff/workbench') {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    sendJson(response, 200, store.staffWorkbench.counts(principal));
    return true;
  }
  const monthlyReport = /^\/api\/v1\/staff\/monthly-report(?:\?(.*))?$/.exec(request.url);
  if (monthlyReport) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    if (principal.role !== 'duty') {
      throw new HttpError(403, 'forbidden');
    }
    sendJson(response, 200, store.monthlyReport(readFilters(monthlyReport[1], ['month']).get('month')));
    return true;
  }
  if (request.url === '/api/v1/staff/assignees') {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    if (principal.role === 'handler') {
      throw new HttpError(403, 'forbidden');
    }
    const items = [...auth.staffById.values()]
      .filter(assignee => canAssignHandler(principal, assignee))
      .map(({ id, department }) => ({ id, department }))
      .sort((a, b) => a.id.localeCompare(b.id));
    sendJson(response, 200, { items });
    return true;
  }
  const staffCases = staffCaseList.exec(request.url);
  if (staffCases) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    const params = readFilters(staffCases[1], ['queue', 'status', 'department', 'assignee', 'before', 'limit']);
    sendJson(response, 200, store.staffWorkbench.list(principal, params));
    return true;
  }
  const staffTasks = staffTasksPath.exec(request.url);
  if (staffTasks) {
    const [, caseNumber, taskId] = staffTasks;
    const principal = auth.authenticate(request, 'staff');
    if (taskId) {
      requireMethod(request, response, 'POST');
      const input = await readAction(request);
      sendJson(response, 200, store.merchant.reviewTask(auth.authenticate(request, 'staff'), caseNumber, taskId, input));
    } else if (request.method === 'POST') {
      const input = await readAction(request);
      const current = auth.authenticate(request, 'staff');
      sendJson(response, 201, store.merchant.assignTask(current, caseNumber, input, auth.collaboratingMerchants));
    } else {
      requireMethod(request, response, 'GET');
      sendJson(response, 200, store.merchant.staffTasks(principal, caseNumber));
    }
    return true;
  }
  const staffPhoto = staffPhotoPath.exec(request.url);
  const staffTaskPhoto = staffTaskPhotoPath.exec(request.url);
  if (staffTaskPhoto) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    const [, caseNumber, taskId, version, position] = staffTaskPhoto;
    if (!Number.isSafeInteger(Number(version))) {
      throw new HttpError(404, 'collaboration_photo_not_found');
    }
    sendPhoto(response, store.merchant.staffTaskPhoto(principal, caseNumber, taskId, Number(version), Number(position)));
    return true;
  }
  if (staffPhoto) {
    requireMethod(request, response, 'GET');
    const principal = auth.authenticate(request, 'staff');
    const [, caseNumber, version, position] = staffPhoto;
    if (!Number.isSafeInteger(Number(version))) {
      throw new HttpError(404, 'submission_photo_not_found');
    }
    sendPhoto(response, store.staffSubmissionPhoto(caseNumber, principal, Number(version), Number(position)));
    return true;
  }
  const staffMatch = staffPath.exec(request.url);
  if (staffMatch) {
    const [, caseNumber, actions] = staffMatch;
    requireMethod(request, response, actions ? 'POST' : 'GET');
    const principal = auth.authenticate(request, 'staff');
    if (actions && isMultipart(request)) {
      if (!['handler', 'supervisor'].includes(principal.role)) {
        throw new HttpError(403, 'forbidden');
      }
      store.staffWorkbench.case(principal, caseNumber);
      const { payload, photos } = await readPhotoUpload(request, response, req => readStaffActionWithPhotos(req, principal.role));
      const current = auth.authenticate(request, 'staff');
      sendJson(response, 200, store.staffAction(caseNumber, current, auth.staffById, payload, photos));
      return true;
    }
    if (actions) {
      const input = await readAction(request);
      sendJson(response, 200, store.staffAction(caseNumber, auth.authenticate(request, 'staff'), auth.staffById, input));
    } else {
      sendJson(response, 200, store.staffCase(caseNumber, principal));
    }
    return true;
  }
  return false;
}

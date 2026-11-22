// 商户窗口的请求封装与视图归一化。页面与本地模拟检查共用此模块。
// 只读取本商户工单与获派协办任务，不请求也不展示其他商户记录或与任务无关的工单信息。
// 商户令牌只作为 Authorization 头传输，不进入网址、日志或持久缓存。

const { localOrigin } = require('../../api-environment');
const {
  maxPhotoBytes,
  maxPhotos,
  extensions,
  multipartBody,
  checkPreviewBytes
} = require('./photos.js');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const CASE_NUMBER_PATTERN = /^CD-[0-9A-F]{32}$/;
const TASK_ID_PATTERN = /^CT-[0-9A-F]{32}$/;

const caseStatusLabels = {
  submitted: '已提交',
  accepted: '已受理',
  rejected: '不予受理',
  assigned: '已分派',
  processing: '处理中',
  awaiting_evaluation: '待评价',
  closed: '已办结',
  reopen_pending: '补办待审核'
};

const taskStatusLabels = {
  awaiting_submission: '待提交',
  returned: '待补充',
  awaiting_review: '待管理方复核',
  approved: '已通过',
  withdrawn: '已撤回'
};

// 商户工单列表可筛选的状态。服务端按精确状态筛选，待复核在列表中按“处理中”展示。
const statusOptions = [
  { id: '', label: '全部状态' },
  { id: 'submitted', label: '已提交' },
  { id: 'accepted', label: '已受理' },
  { id: 'rejected', label: '不予受理' },
  { id: 'assigned', label: '已分派' },
  { id: 'processing', label: '处理中' },
  { id: 'awaiting_evaluation', label: '待评价' },
  { id: 'closed', label: '已办结' },
  { id: 'reopen_pending', label: '补办待审核' }
];

const permissionLabels = {
  readCases: '查看本商户工单',
  submitCases: '提交商户诉求',
  collaborate: '协办任务'
};

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

// 时间统一按北京时间显示。
function timeLabel(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

// request 需符合 wx.request 的形状：options 里有 url/method/timeout/success/fail。
function requestJson({ request, url, method = 'GET', data, header, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = fn => value => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const onSuccess = settle(resolve);
    const onFail = settle(reject);
    request({
      url,
      method,
      timeout,
      data,
      header,
      dataType: 'json',
      success: response => onSuccess({ statusCode: response.statusCode, data: response.data }),
      fail: error => {
        const message = (error && error.errMsg) || 'request failed';
        const failure = new Error(message);
        failure.timedOut = /timeout/i.test(message);
        onFail(failure);
      }
    });
  });
}

// 二进制请求：读取协办送审原图。响应不解析，只取字节与响应头。
function requestBinary({ request, url, header, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = fn => value => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const onSuccess = settle(resolve);
    const onFail = settle(reject);
    request({
      url,
      method: 'GET',
      timeout,
      header,
      responseType: 'arraybuffer',
      dataType: 'text',
      success: response => onSuccess({
        statusCode: response.statusCode,
        data: response.data,
        header: response.header || {}
      }),
      fail: error => {
        const message = (error && error.errMsg) || 'request failed';
        const failure = new Error(message);
        failure.timedOut = /timeout/i.test(message);
        onFail(failure);
      }
    });
  });
}

// 网络层失败归类。超时与断网分开，便于界面提示。
function networkFailure(error) {
  if (error && error.timedOut) return { kind: 'timeout', message: '读取超时，请稍后重试' };
  return { kind: 'network', message: '网络异常，请检查网络后重试' };
}

// 服务端错误归类。401 表示凭据失效，403 表示权限不足，400 表示请求不被接受。
function statusFailure(response) {
  const code = response.data && typeof response.data.error === 'string' ? response.data.error : '';
  if (response.statusCode === 401) return { kind: 'unauthorized', message: '商户凭据已失效，请重新核验。' };
  if (response.statusCode === 403) return { kind: 'forbidden', message: '当前账号没有该操作的权限。' };
  if (response.statusCode === 404) return { kind: 'notfound', message: '未找到该记录。' };
  if (response.statusCode === 400) {
    if (code === 'invalid_cursor') return { kind: 'invalid_cursor', message: '列表范围已变化，请重新读取第一页。' };
    if (code === 'invalid_version') return { kind: 'conflict', message: '任务已被更新，请刷新后再提交。' };
    if (code === 'invalid_status') return { kind: 'invalid', message: '状态筛选无效，请重新选择。' };
    return { kind: 'invalid', message: '提交内容有误，请检查后重试。' };
  }
  if (response.statusCode === 409) {
    if (code === 'stale_version') return { kind: 'conflict', message: '任务已被更新，请刷新后再提交。' };
    if (code === 'invalid_transition') return { kind: 'conflict', message: '任务状态已变化，请刷新后再提交。' };
    return { kind: 'conflict', message: '状态已变化，请刷新后再提交。' };
  }
  return { kind: 'error', message: '服务暂时不可用，请稍后重试' };
}

function baseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function authHeader(token) {
  return { Authorization: 'Bearer ' + token };
}

// 读取商户身份与授权。权限由服务端给出，页面只按此显示。
async function fetchIdentity({ request, baseUrl: origin, token, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/me',
      header: authHeader(token),
      timeout
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return statusFailure(response);
  const data = response.data;
  if (!data || typeof data !== 'object' || typeof data.merchantId !== 'string' || !data.merchantId) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  const permissions = Array.isArray(data.permissions)
    ? data.permissions.filter(item => typeof item === 'string' && Object.hasOwn(permissionLabels, item))
    : [];
  return { kind: 'success', merchantId: data.merchantId, permissions };
}

// 读取本商户工单列表，按状态筛选并用 nextBefore 翻页。
async function fetchMerchantCases({ request, baseUrl: origin, token, status, before, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  const params = [];
  if (status) params.push('status=' + encodeURIComponent(status));
  if (before) params.push('before=' + encodeURIComponent(before));
  const query = params.length ? '?' + params.join('&') : '';
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/cases' + query,
      header: authHeader(token),
      timeout
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return statusFailure(response);
  const data = response.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  const items = data.items
    .filter(item => item && typeof item === 'object' && CASE_NUMBER_PATTERN.test(item.caseNumber || ''))
    .map(item => ({
      caseNumber: item.caseNumber,
      status: typeof item.status === 'string' ? item.status : '',
      statusLabel: caseStatusLabels[item.status] || '状态更新中',
      submittedLabel: timeLabel(item.submittedAt)
    }));
  const nextBefore = typeof data.nextBefore === 'string' && CASE_NUMBER_PATTERN.test(data.nextBefore)
    ? data.nextBefore
    : '';
  return { kind: 'success', items, nextBefore };
}

// 读取本商户单个工单详情。
async function fetchMerchantCase({ request, baseUrl: origin, token, caseNumber, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  if (!CASE_NUMBER_PATTERN.test(caseNumber || '')) return { kind: 'invalid', message: '工单编号无效。' };
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/cases/' + caseNumber,
      header: authHeader(token),
      timeout
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return statusFailure(response);
  const data = response.data;
  if (!data || typeof data !== 'object' || data.caseNumber !== caseNumber) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  return { kind: 'success', detail: caseDetailView(data) };
}

// 读取获派的协办待办，按 nextBefore 翻页。
async function fetchCollaborations({ request, baseUrl: origin, token, before, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  const query = before ? '?before=' + encodeURIComponent(before) : '';
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/collaborations' + query,
      header: authHeader(token),
      timeout
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return statusFailure(response);
  const data = response.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  const items = data.items
    .filter(item => item && typeof item === 'object' && TASK_ID_PATTERN.test(item.taskId || ''))
    .map(item => ({
      taskId: item.taskId,
      instructions: typeof item.instructions === 'string' ? item.instructions : '',
      dueLabel: timeLabel(item.dueAt),
      status: typeof item.status === 'string' ? item.status : '',
      statusLabel: taskStatusLabels[item.status] || '状态更新中',
      version: Number.isSafeInteger(item.version) ? item.version : null
    }));
  const nextBefore = typeof data.nextBefore === 'string' && TASK_ID_PATTERN.test(data.nextBefore)
    ? data.nextBefore
    : '';
  return { kind: 'success', items, nextBefore };
}

// 读取协办任务详情。只展示任务自身授权的信息，不含原工单申报内容。
async function fetchCollaboration({ request, baseUrl: origin, token, taskId, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  if (!TASK_ID_PATTERN.test(taskId || '')) return { kind: 'invalid', message: '协办任务编号无效。' };
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/collaborations/' + taskId,
      header: authHeader(token),
      timeout
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return statusFailure(response);
  const data = response.data;
  if (!data || typeof data !== 'object' || data.taskId !== taskId) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  return { kind: 'success', detail: taskDetailView(data) };
}

// 协办送审。请求体含任务版本与文字说明；附照片时用 multipart，
// 不附照片时保持原来的 JSON 形态，两种都被服务端接受。
async function submitCollaboration({ request, baseUrl: origin, token, taskId, expectedVersion, summary, photos, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  if (!TASK_ID_PATTERN.test(taskId || '')) return { kind: 'invalid', message: '协办任务编号无效。' };
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { kind: 'error', message: '缺少任务版本，请刷新后重试' };
  }
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (!text || Array.from(text).length > 4000) {
    return { kind: 'invalid', message: '请输入 1–4000 字的协办说明。' };
  }
  const files = Array.isArray(photos) ? photos : [];
  if (files.length > maxPhotos) return { kind: 'invalid', message: '最多只能附加 3 张照片。' };
  for (const photo of files) {
    if (!photo || !Object.hasOwn(extensions, photo.mediaType) || !(photo.bytes instanceof Uint8Array) ||
        photo.bytes.length < 1 || photo.bytes.length > maxPhotoBytes) {
      return { kind: 'invalid', message: '照片内容不符合要求，请重新选择。' };
    }
  }
  let body = { expectedVersion, summary: text };
  let contentType = 'application/json';
  if (files.length) {
    // 附照片时按接单口径组装 multipart：一个 payload 文本 part 加若干 photos 文件 part。
    const boundary = '----ChangdiMerchantTaskBoundary' + taskId.replace(/[^A-Za-z0-9]/g, '');
    try {
      body = multipartBody(boundary, { expectedVersion, summary: text }, files);
    } catch {
      return { kind: 'invalid', message: '照片总大小超出上限，请减少张数或压缩后再试。' };
    }
    contentType = 'multipart/form-data; boundary=' + boundary;
  }
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/collaborations/' + taskId + '/submissions',
      method: 'POST',
      data: body,
      header: { ...authHeader(token), 'content-type': contentType },
      timeout
    });
  } catch (error) {
    if (error && error.timedOut) return { kind: 'timeout', message: '提交超时，结果未知，请刷新任务核对后再决定是否重试。' };
    return { kind: 'network', message: '网络异常，结果未知，请刷新任务核对后再决定是否重试。' };
  }
  if (response.statusCode >= 500) {
    return { kind: 'uncertain', message: '服务异常，送审结果未知。' };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return statusFailure(response);
  const data = response.data;
  if (!data || typeof data !== 'object' || data.taskId !== taskId ||
      data.status !== 'awaiting_review' || data.version !== expectedVersion + 1) {
    return { kind: 'uncertain', message: '无法确认送审回执。' };
  }
  return { kind: 'success', detail: taskDetailView(data) };
}

// 读取协办送审原图。只读本商户获派任务下的原图，按任务与送审版本定位，不借用原单路线。
// 返回字节与响应头，由调用方按任务详情里的元数据校验类型、大小与签名。
async function fetchCollaborationPhoto({ request, baseUrl: origin, token, taskId, submitVersion, position, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  if (!TASK_ID_PATTERN.test(taskId || '')) return { kind: 'invalid', message: '协办任务编号无效。' };
  if (!Number.isSafeInteger(submitVersion) || submitVersion < 1) {
    return { kind: 'invalid', message: '送审版本无效。' };
  }
  if (!Number.isInteger(position) || position < 0 || position > 2) {
    return { kind: 'invalid', message: '图片序号无效。' };
  }
  let response;
  try {
    response = await requestBinary({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/collaborations/' + taskId +
        '/submission-photos/' + submitVersion + '/' + position,
      header: authHeader(token),
      timeout
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (response.statusCode === 401) return { kind: 'unauthorized', message: '商户凭据已失效，请重新核验。' };
  if (response.statusCode === 403) return { kind: 'forbidden', message: '当前账号没有查看该原图的权限。' };
  if (response.statusCode === 404) return { kind: 'notfound', message: '该原图已不可读。' };
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { kind: 'error', message: '原图读取失败，请稍后重试。' };
  }
  const bytes = response.data;
  if (!(bytes instanceof ArrayBuffer)) return { kind: 'error', message: '原图读取失败，请稍后重试。' };
  return { kind: 'success', bytes, header: response.header };
}

// 工单详情视图。只保留服务端返回的本商户可见字段。
function caseDetailView(data) {
  const history = Array.isArray(data.history) ? data.history : [];
  const feedback = Array.isArray(data.feedback) ? data.feedback : [];
  return {
    caseNumber: data.caseNumber,
    status: typeof data.status === 'string' ? data.status : '',
    statusLabel: caseStatusLabels[data.status] || '状态更新中',
    round: Number.isSafeInteger(data.round) ? data.round : null,
    submittedLabel: timeLabel(data.submittedAt),
    occurredLabel: timeLabel(data.occurredAt),
    location: typeof data.location === 'string' ? data.location : '',
    category: typeof data.category === 'string' ? data.category : '',
    description: typeof data.description === 'string' ? data.description : '',
    history: history
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        status: typeof item.status === 'string' ? item.status : '',
        statusLabel: caseStatusLabels[item.status] || '状态更新中',
        round: Number.isSafeInteger(item.round) ? item.round : null,
        timeLabel: timeLabel(item.occurredAt)
      })),
    feedback: feedback
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        round: Number.isSafeInteger(item.round) ? item.round : null,
        summary: typeof item.summary === 'string' ? item.summary : '',
        publishedLabel: timeLabel(item.publishedAt)
      }))
  };
}

// 协办任务详情视图。任务之外的工单信息不在此处出现。
function taskDetailView(data) {
  return {
    taskId: data.taskId,
    status: typeof data.status === 'string' ? data.status : '',
    statusLabel: taskStatusLabels[data.status] || '状态更新中',
    version: Number.isSafeInteger(data.version) ? data.version : null,
    instructions: typeof data.instructions === 'string' ? data.instructions : '',
    location: typeof data.location === 'string' ? data.location : '',
    dueLabel: timeLabel(data.dueAt),
    latestSubmission: typeof data.latestSubmission === 'string' ? data.latestSubmission : '',
    returnReason: typeof data.returnReason === 'string' ? data.returnReason : '',
    // 本商户自己送审的原图元数据。只含版本、序号、类型与大小。
    submissionPhotos: collaborationPhotos(data.submissionPhotos)
  };
}

// 整理协办送审原图的元数据。只保留服务端给出的送审版本、序号、类型与大小，
// 并按送审版本与序号排序，便于逐张定位。
function collaborationPhotos(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object' &&
      Number.isSafeInteger(item.submitVersion) && item.submitVersion >= 1 &&
      Number.isInteger(item.position) && item.position >= 0 && item.position <= 2 &&
      Object.hasOwn(extensions, item.mediaType) &&
      Number.isSafeInteger(item.size) && item.size >= 1 && item.size <= maxPhotoBytes)
    .map(item => ({
      key: item.submitVersion + '/' + item.position,
      submitVersion: item.submitVersion,
      position: item.position,
      mediaType: item.mediaType,
      size: item.size,
      typeLabel: extensions[item.mediaType].toUpperCase()
    }))
    .sort((left, right) => left.submitVersion - right.submitVersion || left.position - right.position);
}

// 只有待提交或退回补充的任务可以送审。
function canSubmitTask(detail) {
  if (!detail) return false;
  return detail.status === 'awaiting_submission' || detail.status === 'returned';
}

// 新诉求的字段上限，与服务端一致。
const submissionLimits = {
  clientRequestId: 128,
  location: 300,
  category: 80,
  description: 4000,
  contact: 300
};

// 服务端要求带时区的时间戳。
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

// 生成一次申报的请求号。同一份内容重试时沿用同一个请求号，服务端据此去重。
function newClientRequestId(sequence) {
  const time = Date.now().toString(36);
  const seq = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence.toString(36) : '0';
  let random = '';
  for (let index = 0; index < 3; index += 1) {
    random += Math.floor(Math.random() * 0x1000000).toString(36).padStart(5, '0');
  }
  return `mp-${time}-${seq}-${random}`;
}

// 校验并整理新诉求内容。返回 null 表示可用，否则返回给用户看的提示。
function normalizeSubmission(input) {
  const content = input && typeof input === 'object' ? input : {};
  const clientRequestId = typeof content.clientRequestId === 'string' ? content.clientRequestId.trim() : '';
  const occurredAt = typeof content.occurredAt === 'string' ? content.occurredAt.trim() : '';
  const location = typeof content.location === 'string' ? content.location.trim() : '';
  const category = typeof content.category === 'string' ? content.category.trim() : '';
  const description = typeof content.description === 'string' ? content.description.trim() : '';
  const contact = typeof content.contact === 'string' ? content.contact.trim() : '';
  if (!clientRequestId || Array.from(clientRequestId).length > submissionLimits.clientRequestId) {
    return { error: '请求号无效，请重新提交。' };
  }
  if (!TIMESTAMP_PATTERN.test(occurredAt)) {
    return { error: '请选择发生时间。' };
  }
  if (!location || Array.from(location).length > submissionLimits.location) {
    return { error: '请填写发生地点，最多 300 字。' };
  }
  if (!category || Array.from(category).length > submissionLimits.category) {
    return { error: '请填写事项分类，最多 80 字。' };
  }
  if (!description || Array.from(description).length > submissionLimits.description) {
    return { error: '请填写诉求说明，最多 4000 字。' };
  }
  if (contact && Array.from(contact).length > submissionLimits.contact) {
    return { error: '联系方式最多 300 字。' };
  }
  return {
    content: { clientRequestId, occurredAt, location, category, description, ...(contact ? { contact } : {}) }
  };
}

// 组装一次新诉求提交所需的请求体与内容类型。照片可选，最多 3 张。
function buildMerchantSubmission(input) {
  const normalized = normalizeSubmission(input);
  if (normalized.error) return { error: normalized.error };
  const payload = normalized.content;
  const photos = Array.isArray(input.photos) ? input.photos : [];
  if (photos.length > maxPhotos) return { error: '最多只能附加 3 张照片。' };
  for (const photo of photos) {
    if (!photo || !Object.hasOwn(extensions, photo.mediaType) || !(photo.bytes instanceof Uint8Array) ||
        photo.bytes.length < 1 || photo.bytes.length > maxPhotoBytes) {
      return { error: '照片内容不符合要求，请重新选择。' };
    }
  }
  // 字段顺序与服务端一致，避免同一内容两次拼装出不同结果。
  const ordered = {
    clientRequestId: payload.clientRequestId,
    occurredAt: payload.occurredAt,
    location: payload.location,
    category: payload.category,
    description: payload.description,
    ...(payload.contact === undefined ? {} : { contact: payload.contact })
  };
  const boundary = '----ChangdiMerchantBoundary' + payload.clientRequestId.replace(/[^A-Za-z0-9]/g, '');
  let body;
  try {
    body = multipartBody(boundary, ordered, photos);
  } catch {
    // 整包超限等组装失败：客户端提示，不发请求。
    return { error: '照片总大小超出上限，请减少张数或压缩后再试。' };
  }
  return {
    payload: ordered,
    body,
    contentType: 'multipart/form-data; boundary=' + boundary
  };
}

// 提交一条商户新诉求。返回回执，不返回工单内容。
// unknown 表示结果未知（超时、断网、响应无法识别）：服务端可能已经建单，
// 调用方必须按“待确认”处理，不能改内容换请求号重发同一事项。
async function submitMerchantCase({ request, baseUrl: origin, token, submission, prepared, timeout }) {
  if (!token) return { kind: 'unauthorized', message: '请先核验商户身份。' };
  // prepared 用于重试：直接重发冻结的同一份字节。
  const built = prepared || buildMerchantSubmission(submission);
  if (built.error) return { kind: 'invalid', message: built.error };
  // 记录本次实际发出的字节：结果未知时页面据此冻结，重试时原样重发。
  const sent = {
    body: built.body,
    contentType: built.contentType,
    requestId: (built.payload && built.payload.clientRequestId) || built.requestId || ''
  };
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl(origin) + '/api/v1/merchant/cases',
      method: 'POST',
      data: built.body,
      header: { ...authHeader(token), 'content-type': built.contentType },
      timeout
    });
  } catch (error) {
    if (error && error.timedOut) {
      return { kind: 'timeout', unknown: true, sent, message: '提交超时，结果未知，本次申报已锁定，请重试确认。' };
    }
    return { kind: 'network', unknown: true, sent, message: '网络异常，结果未知，本次申报已锁定，请重试确认。' };
  }
  if (response.statusCode === 401) return { kind: 'unauthorized', message: '商户凭据已失效，请重新核验。' };
  if (response.statusCode === 403) return { kind: 'forbidden', message: '当前账号没有提交诉求的权限。' };
  if (response.statusCode === 409) {
    const code = response.data && typeof response.data.error === 'string' ? response.data.error : '';
    if (code === 'submission_conflict') {
      // 该请求号已对应其他内容：本次内容未写入，但同事项是否已入库无法据此判定。
      return { kind: 'conflict', unknown: true, sent, message: '该请求号已对应其他内容，本次内容未写入，请先在工单列表核对是否已有同一事项。' };
    }
    return { kind: 'conflict', unknown: true, sent, message: '状态已变化，结果未知，本次申报已锁定，请重试确认。' };
  }
  if (response.statusCode === 400 || response.statusCode === 415) {
    // 服务端明确拒绝，没有建单，可以修正后重提。
    const code = response.data && typeof response.data.error === 'string' ? response.data.error : '';
    if (code === 'invalid_field') return { kind: 'invalid', message: '提交内容有误，请检查后重试。' };
    if (code === 'invalid_timestamp') return { kind: 'invalid', message: '发生时间格式有误，请重新选择。' };
    if (code === 'invalid_payload_part' || code === 'invalid_multipart' || code === 'invalid_multipart_fields') {
      return { kind: 'invalid', message: '提交内容有误，请检查后重试。' };
    }
    if (code === 'expected_multipart') return { kind: 'invalid', message: '提交格式不被接受，请检查后重试。' };
    return { kind: 'invalid', message: '提交内容有误，请检查后重试。' };
  }
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    return { kind: 'error', unknown: true, sent, message: '服务暂时不可用，结果未知，本次申报已锁定，请重试确认。' };
  }
  const data = response.data;
  if (!data || typeof data !== 'object' || typeof data.caseNumber !== 'string' || !CASE_NUMBER_PATTERN.test(data.caseNumber)) {
    return { kind: 'error', unknown: true, sent, message: '回执无法识别，结果未知，本次申报已锁定，请重试确认。' };
  }
  return {
    kind: 'success',
    created: response.statusCode === 201,
    receipt: {
      caseNumber: data.caseNumber,
      status: typeof data.status === 'string' ? data.status : '',
      statusLabel: caseStatusLabels[data.status] || '状态更新中',
      submittedLabel: timeLabel(data.submittedAt)
    }
  };
}

module.exports = {
  TOKEN_PATTERN,
  CASE_NUMBER_PATTERN,
  TASK_ID_PATTERN,
  caseStatusLabels,
  taskStatusLabels,
  statusOptions,
  permissionLabels,
  localOrigin,
  isValidToken,
  timeLabel,
  caseDetailView,
  taskDetailView,
  canSubmitTask,
  newClientRequestId,
  normalizeSubmission,
  buildMerchantSubmission,
  fetchIdentity,
  fetchMerchantCases,
  fetchMerchantCase,
  fetchCollaborations,
  fetchCollaboration,
  fetchCollaborationPhoto,
  submitCollaboration,
  submitMerchantCase
};

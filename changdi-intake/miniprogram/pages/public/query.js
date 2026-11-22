// 公开查询与本人核验的纯逻辑与请求封装。页面与本地模拟检查共用此模块。
// 只处理公开查询码与本人授权，不涉及申报信息、服务端地址拼接以外的任何内容。

const { publishedPhotos } = require('./feedback-photos');
const { multipartPhotos, photoMessage, supplementPhotos } = require('../staff/photos');
const { casePattern } = require('../staff/workbench');
const { localOrigin, httpsOrigin } = require('../../api-environment');
const CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const PRIVATE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const STATUS_TEXT = {
  submitted: '已提交',
  accepted: '已受理',
  awaiting_supplement: '待补充材料',
  rejected: '不予受理',
  assigned: '已分派',
  processing: '处理中',
  awaiting_review: '待复核',
  awaiting_evaluation: '待评价',
  closed: '已办结',
  reopen_pending: '补办待审核'
};

// 服务端未收录的状态不做臆测，统一显示为“状态更新中”。
function statusText(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_TEXT, status) ? STATUS_TEXT[status] : '状态更新中';
}

function trimCode(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isValidCode(code) {
  return CODE_PATTERN.test(code);
}

function isValidPrivateToken(token) {
  return PRIVATE_TOKEN_PATTERN.test(token);
}

// 只解码一次百分号编码，用于识别 scene=c%3D<code> 这类写法。
function decodeOnce(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// 识别小程序路径中携带的公开码。
// 接受的格式：
//   /pages/public/index?code=<code>
//   /pages/public/index?scene=<code>
//   /pages/public/index?scene=c%3D<code>
//   /pages/public/index?publicLookupCode=<code>
// 只认上述明确的参数，不从路径其他位置检索字符段。
function extractFromPath(pathText) {
  if (typeof pathText !== 'string' || !pathText) return '';
  const text = decodeOnce(pathText.trim());
  const match = /[?&](?:code|publicLookupCode|scene)=([^&]+)/.exec(text);
  if (!match) return '';
  return extractFromParamValue(match[1]);
}

// 识别参数值中的公开码：整体即码，或 c=码 形式。
function extractFromParamValue(value) {
  const text = trimCode(value);
  if (!text) return '';
  if (isValidCode(text)) return text;
  const scoped = /^(?:c|code|publicLookupCode)=([A-Za-z0-9_-]{24})$/.exec(decodeOnce(text));
  if (scoped) return scoped[1];
  return '';
}

// 从扫码结果中提取公开码。
// 接受的输入仅限：
//   1) 公开码本身
//   2) 含 code / publicLookupCode / scene 参数的链接
//   3) 小程序路径（含上述参数）
// 其他任意文本一律不接受，不再从中检索独立字符段。
function extractPublicCode(raw) {
  const text = trimCode(raw);
  if (!text) return '';
  if (isValidCode(text)) return text;

  // 路径或链接中的参数值。
  const fromParam = /[?&;](?:code|publicLookupCode|scene)=([^&#;]+)/i.exec(text);
  if (fromParam) {
    const code = extractFromParamValue(decodeOnce(fromParam[1]));
    if (code) return code;
  }

  // 单独的 scene 值，例如 “c=CODE”。
  if (/^(?:c|code|publicLookupCode)=/i.test(text)) {
    const code = extractFromParamValue(text);
    if (code) return code;
  }

  // 路径形式。
  if (text.startsWith('/')) {
    const code = extractFromPath(text);
    if (code) return code;
  }

  return '';
}

function formatBeijingTime(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return '';
  const shifted = new Date(moment.getTime() + 8 * 60 * 60 * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

function buildPublicCaseUrl(baseUrl, code) {
  const trimmedBase = String(baseUrl || '').replace(/\/+$/, '');
  return `${trimmedBase}/api/v1/public/cases/${code}`;
}

function buildOwnerCaseUrl(baseUrl, caseNumber) {
  const trimmedBase = String(baseUrl || '').replace(/\/+$/, '');
  return `${trimmedBase}/api/v1/owner/cases/${caseNumber}`;
}

class RequestFailure extends Error {
  constructor(message, timedOut) {
    super(message);
    this.timedOut = Boolean(timedOut);
  }
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
        onFail(new RequestFailure(message, /timeout/i.test(message)));
      }
    });
  });
}

// 把服务端响应整理为页面可直接渲染的公开字段：编号、中文状态、公开时间节点。
function normalizePublicCase(data) {
  if (!data || typeof data !== 'object') return null;
  const caseNumber = typeof data.caseNumber === 'string' ? data.caseNumber : '';
  const status = typeof data.status === 'string' ? data.status : '';
  if (!caseNumber || !status) return null;
  const milestones = Array.isArray(data.milestones) ? data.milestones : [];
  return {
    caseNumber,
    status,
    statusText: statusText(status),
    milestones: milestones
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        status: typeof item.status === 'string' ? item.status : '',
        label: statusText(item.status),
        occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
        timeText: formatBeijingTime(item.occurredAt)
      }))
      .filter(item => item.status)
  };
}

// 查询一次公开进度。返回 { kind, ... }，kind 为页面状态机取值。
async function queryPublicCase({ request, baseUrl, code, timeout }) {
  if (!isValidCode(code)) {
    return { kind: 'invalid', message: '公开码格式不正确，应为 24 位字母、数字、下划线或连字符' };
  }
  let response;
  try {
    response = await requestJson({ request, url: buildPublicCaseUrl(baseUrl, code), timeout });
  } catch (error) {
    if (error && error.timedOut) {
      return { kind: 'timeout', message: '查询超时，请稍后重试' };
    }
    return { kind: 'network', message: '网络异常，请检查网络后重试' };
  }
  if (response.statusCode === 404) {
    return { kind: 'notfound', message: '无法查询，请重新扫描回执' };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { kind: 'error', message: '服务暂时不可用，请稍后重试' };
  }
  const normalized = normalizePublicCase(response.data);
  if (!normalized) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  return { kind: 'success', ...normalized };
}

// 本人核验：公开码加私密凭证换取短期授权。
// 私密凭证只在请求体中传输，不进入 URL。
async function verifyOwner({ request, baseUrl, publicLookupCode, privateLookupToken, timeout }) {
  if (!isValidCode(publicLookupCode)) {
    return { kind: 'invalid', message: '公开码格式不正确' };
  }
  if (!isValidPrivateToken(privateLookupToken)) {
    return { kind: 'invalid', message: '私密凭证格式不正确' };
  }
  let response;
  try {
    response = await requestJson({
      request,
      url: `${String(baseUrl || '').replace(/\/+$/, '')}/api/v1/owner/verify`,
      method: 'POST',
      data: { publicLookupCode, privateLookupToken },
      header: { 'content-type': 'application/json' },
      timeout
    });
  } catch (error) {
    if (error && error.timedOut) {
      return { kind: 'timeout', message: '核验超时，请稍后重试' };
    }
    return { kind: 'network', message: '网络异常，请检查网络后重试' };
  }
  if (response.statusCode === 401) {
    return { kind: 'unauthorized', message: '凭证有误，请核对回执' };
  }
  if (response.statusCode === 429) {
    return { kind: 'limited', message: '核验尝试过于频繁，请稍后再试' };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { kind: 'error', message: '核验暂时不可用，请稍后重试' };
  }
  const data = response.data;
  if (!data || typeof data !== 'object') {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  const caseNumber = typeof data.caseNumber === 'string' ? data.caseNumber : '';
  const ownerSessionToken = typeof data.ownerSessionToken === 'string' ? data.ownerSessionToken : '';
  if (!caseNumber || !ownerSessionToken) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  return { kind: 'success', caseNumber, ownerSessionToken, expiresAt: data.expiresAt };
}

// 读取本人详情及已发布反馈。
async function fetchOwnerCase({ request, baseUrl, caseNumber, ownerSessionToken, timeout }) {
  if (!caseNumber || !ownerSessionToken) {
    return { kind: 'unauthorized', message: '本人授权已失效，请重新核验' };
  }
  let response;
  try {
    response = await requestJson({
      request,
      url: buildOwnerCaseUrl(baseUrl, caseNumber),
      header: { Authorization: 'Bearer ' + ownerSessionToken },
      timeout
    });
  } catch (error) {
    if (error && error.timedOut) {
      return { kind: 'timeout', message: '读取超时，请稍后重试' };
    }
    return { kind: 'network', message: '网络异常，请检查网络后重试' };
  }
  if (response.statusCode === 401 || response.statusCode === 403) {
    return { kind: 'unauthorized', message: '本人授权已失效，请重新核验' };
  }
  if (response.statusCode === 404) {
    return { kind: 'notfound', message: '未找到该工单' };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { kind: 'error', message: '服务暂时不可用，请稍后重试' };
  }
  const data = response.data;
  if (!data || typeof data !== 'object' || data.caseNumber !== caseNumber) {
    return { kind: 'error', message: '返回数据无法识别，请稍后重试' };
  }
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  const reopenRequests = Array.isArray(data.reopenRequests) ? data.reopenRequests : [];
  const availableActions = Array.isArray(data.availableActions) ? data.availableActions : [];
  const requirement = data.supplementRequirement && typeof data.supplementRequirement === 'object'
    ? data.supplementRequirement
    : null;
  return {
    kind: 'success',
    caseNumber: data.caseNumber,
    version: Number.isSafeInteger(data.version) ? data.version : null,
    round: Number.isSafeInteger(data.round) ? data.round : null,
    status: typeof data.status === 'string' ? data.status : '',
    statusText: statusText(data.status),
    availableActions: availableActions.filter(action => typeof action === 'string'),
    supplementRequirement: requirement ? {
      reason: typeof requirement.reason === 'string' ? requirement.reason : '',
      requestedAt: typeof requirement.requestedAt === 'string' ? requirement.requestedAt : '',
      requestedText: formatBeijingTime(requirement.requestedAt)
    } : null,
    feedbackPhotos: publishedPhotos(rounds, data.version),
    supplementPhotos: supplementPhotos(data),
    rounds: rounds
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const feedback = item.feedback && typeof item.feedback === 'object' ? item.feedback : null;
        const evaluation = item.evaluation && typeof item.evaluation === 'object' ? item.evaluation : null;
        return {
          round: Number.isSafeInteger(item.round) ? item.round : null,
          summary: feedback && typeof feedback.summary === 'string' ? feedback.summary : '',
          publishedAt: feedback && typeof feedback.publishedAt === 'string' ? feedback.publishedAt : '',
          publishedText: formatBeijingTime(feedback && feedback.publishedAt),
          speed: evaluation && Number.isSafeInteger(evaluation.speed) ? evaluation.speed : null,
          effectiveness: evaluation && Number.isSafeInteger(evaluation.effectiveness) ? evaluation.effectiveness : null,
          attitude: evaluation && Number.isSafeInteger(evaluation.attitude) ? evaluation.attitude : null,
          comment: evaluation && typeof evaluation.comment === 'string' ? evaluation.comment : '',
          evaluated: Boolean(evaluation)
        };
      }),
    reopenRequests: reopenRequests
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        round: Number.isSafeInteger(item.round) ? item.round : null,
        reason: typeof item.reason === 'string' ? item.reason : '',
        requestedText: formatBeijingTime(item.requestedAt),
        decision: typeof item.decision === 'string' ? item.decision : '',
        decisionReason: typeof item.decisionReason === 'string' ? item.decisionReason : ''
      }))
  };
}

// 提交本人动作。
// 单次写入由调用方加锁，这里只负责一次请求与结果归类。
async function submitOwnerAction({
  request, baseUrl, caseNumber, ownerSessionToken, action, expectedVersion, payload, timeout, files = [], isCurrent
}) {
  if (!caseNumber || !ownerSessionToken) {
    return { kind: 'unauthorized', message: '本人授权已失效，请重新核验' };
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { kind: 'error', message: '缺少版本号，请刷新后重试' };
  }
  const body = { action, expectedVersion };
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) body[key] = value;
    }
  }
  let url = buildOwnerCaseUrl(baseUrl, caseNumber) + '/actions';
  let dataToSend = body;
  let contentType = 'application/json';
  if (files.length) {
    const origin = localOrigin(baseUrl) || httpsOrigin(baseUrl);
    if (action !== 'submit_supplement' || !origin || !casePattern.test(caseNumber)) {
      return { kind: 'error', message: '补件照片上传需要当前工单及有效服务配置。' };
    }
    try {
      const upload = await multipartPhotos(body, files, false, isCurrent);
      if (!upload || !isCurrent()) return { kind: 'cancelled' };
      url = buildOwnerCaseUrl(origin, caseNumber) + '/actions';
      dataToSend = upload.data;
      contentType = upload.contentType;
    } catch (error) {
      if (!isCurrent()) return { kind: 'cancelled' };
      return { kind: 'invalid', message: photoMessage(error) };
    }
  }
  let response;
  try {
    response = await requestJson({
      request,
      url,
      method: 'POST',
      data: dataToSend,
      header: { Authorization: 'Bearer ' + ownerSessionToken, 'content-type': contentType },
      timeout
    });
  } catch (error) {
    if (error && error.timedOut) {
      return { kind: 'timeout', message: '提交超时，结果未知，请刷新确认' };
    }
    return { kind: 'network', message: '网络异常，请检查网络后重试' };
  }
  if (response.statusCode === 401 || response.statusCode === 403) {
    return { kind: 'unauthorized', message: '本人授权已失效，请重新核验' };
  }
  if (response.statusCode === 409) {
    const code = response.data && typeof response.data.error === 'string' ? response.data.error : '';
    if (code === 'evaluation_window_expired') {
      return { kind: 'expired', message: '评价期已结束，无法提交评价' };
    }
    if (code === 'reopen_window_expired') {
      return { kind: 'expired', message: '已超过补办申请期' };
    }
    if (code === 'evaluation_exists') {
      return { kind: 'conflict', message: '本轮已评价，请刷新查看' };
    }
    return { kind: 'conflict', message: '工单状态已更新，请刷新后重试' };
  }
  if (response.statusCode === 400) {
    const code = response.data && typeof response.data.error === 'string' ? response.data.error : '';
    if (code === 'invalid_rating') {
      return { kind: 'invalid', message: '评分需为 1 至 5 的整数' };
    }
    if (code === 'invalid_version') {
      return { kind: 'conflict', message: '工单状态已更新，请刷新后重试' };
    }
    return { kind: 'error', message: '提交内容有误，请检查后重试' };
  }
  if (response.statusCode >= 500) {
    return { kind: 'uncertain', message: '服务异常，提交结果未知，请刷新确认。' };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { kind: 'error', message: '服务暂时不可用，请稍后重试' };
  }
  const data = response.data;
  if (!data || typeof data !== 'object' || data.caseNumber !== caseNumber ||
      data.version !== expectedVersion + 1) {
    return { kind: 'uncertain', message: '无法确认提交回执，请刷新原工单。' };
  }
  return { kind: 'success', data };
}

module.exports = {
  CODE_PATTERN,
  PRIVATE_TOKEN_PATTERN,
  STATUS_TEXT,
  statusText,
  trimCode,
  isValidCode,
  isValidPrivateToken,
  decodeOnce,
  extractFromPath,
  extractFromParamValue,
  extractPublicCode,
  formatBeijingTime,
  buildPublicCaseUrl,
  buildOwnerCaseUrl,
  normalizePublicCase,
  queryPublicCase,
  verifyOwner,
  fetchOwnerCase,
  submitOwnerAction
};


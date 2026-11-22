// 游客诉求提交的纯逻辑：字段校验、载荷组装、multipart 组装、请求与错误归一化。
// 页面与本地模拟检查共用此模块。这里不写任何持久缓存，也不记录私密查询凭证。
// 私密查询凭证只由服务端在回执里下发一次，页面拿到后仅留在页面内存中展示。

const { multipartPhotos, multipartPayload, photoMessage } = require('../staff/photos');

// 字段上限与服务端接单口径一致。
const LIMITS = {
  clientRequestId: 128,
  location: 300,
  category: 80,
  description: 4000,
  suggestedDepartment: 100,
  contact: 300
};

// 可选照片最多 3 张，每张不超过 5 MiB。
const MAX_PHOTOS = 3;

// 服务端要求带时区的时间戳。
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

// 问题类别选项。与商户窗口的事项分类同一套词汇，游客与商户报同一件事时能对上。
const CATEGORY_OPTIONS = [
  { value: '街面维护', label: '街面维护' },
  { value: '环境卫生', label: '环境卫生' },
  { value: '设施损坏', label: '设施损坏' },
  { value: '公共秩序', label: '公共秩序' },
  { value: '停车问题', label: '停车问题' },
  { value: '噪声扰民', label: '噪声扰民' },
  { value: '其他问题', label: '其他问题' }
];

// 回执里的公开查询码与私密凭证只允许 URL 安全的字符，便于复制与转交。
// 校验时用宽松范围，保证回执原样显示；拼接页面路径时另用与公开查询页一致的严格公开码格式。
const RECEIPT_CODE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RECEIPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
// 与 pages/public/query.js 的公开码格式一致：24 位字母、数字、下划线或连字符。
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

// 生成一次申报的请求号。页面加载即生成，同一表单的重试沿用同一个，成功建单后重新生成。
// 随机部分为 40 位十六进制，只作去重标识，不作凭据用。
function newClientRequestId(sequence) {
  const time = Date.now().toString(36);
  const seq = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence.toString(36) : '0';
  let random = '';
  for (let index = 0; index < 40; index += 1) {
    random += Math.floor(Math.random() * 16).toString(16);
  }
  return `pg-${time}-${seq}-${random}`;
}

// 按发生日期与时刻拼出带时区的时间戳。日期与时刻都是北京时间。
function occurredAtText(date, time) {
  const day = typeof date === 'string' ? date.trim() : '';
  const clock = typeof time === 'string' ? time.trim() : '';
  if (!day || !clock) return '';
  return `${day}T${clock}:00+08:00`;
}

// 逐字段校验。返回 { errors } 表示有字段级问题，否则返回 { payload }。
// 字段级提示就地显示在对应输入框旁，其余输入保持不变。
function validateSubmission(input) {
  const content = input && typeof input === 'object' ? input : {};
  const errors = {};
  const clientRequestId = typeof content.clientRequestId === 'string' ? content.clientRequestId.trim() : '';
  const occurredAt = typeof content.occurredAt === 'string' ? content.occurredAt.trim() : '';
  const location = typeof content.location === 'string' ? content.location.trim() : '';
  const category = typeof content.category === 'string' ? content.category.trim() : '';
  const description = typeof content.description === 'string' ? content.description.trim() : '';
  const suggestedDepartment = typeof content.suggestedDepartment === 'string' ? content.suggestedDepartment.trim() : '';
  const contact = typeof content.contact === 'string' ? content.contact.trim() : '';
  if (!clientRequestId || Array.from(clientRequestId).length > LIMITS.clientRequestId) {
    errors.clientRequestId = '请求号无效，请重新提交。';
  }
  if (!occurredAt) errors.occurredAt = '请选择发生时间。';
  else if (!TIMESTAMP_PATTERN.test(occurredAt)) errors.occurredAt = '发生时间格式有误，请重新选择。';
  if (!location) errors.location = '请填写发生地点。';
  else if (Array.from(location).length > LIMITS.location) errors.location = '发生地点最多 300 字。';
  if (!category) errors.category = '请选择问题类别。';
  else if (Array.from(category).length > LIMITS.category) errors.category = '问题类别最多 80 字。';
  if (!description) errors.description = '请填写问题描述。';
  else if (Array.from(description).length > LIMITS.description) errors.description = '问题描述最多 4000 字。';
  if (suggestedDepartment && Array.from(suggestedDepartment).length > LIMITS.suggestedDepartment) {
    errors.suggestedDepartment = '建议处理部门最多 100 字。';
  }
  if (contact && Array.from(contact).length > LIMITS.contact) errors.contact = '联系方式最多 300 字。';
  if (Object.keys(errors).length) return { errors };
  // 字段顺序固定，避免同一内容两次拼装出不同结果。
  const payload = {
    clientRequestId,
    occurredAt,
    location,
    category,
    description
  };
  // 建议处理部门是选填项：填了才带上，不填不传空串。
  if (suggestedDepartment) payload.suggestedDepartment = suggestedDepartment;
  if (contact) payload.contact = contact;
  return { errors: {}, payload };
}

// 组装 multipart 请求体。不附照片时只发 payload part，附照片时复用公共的照片上传工具。
// 返回 null 表示期间表单已变化，本次请求不再发出。
async function buildMultipart({ payload, files, isCurrent }) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_PHOTOS) throw new Error('invalid_photo_selection');
  if (!list.length) return multipartPayload(payload);
  const upload = await multipartPhotos(payload, list, false, isCurrent || (() => true));
  if (!upload) return null;
  return upload;
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

// 服务端错误归类。明确被拒的错误没有建单，可以修正后重试；
// 超时、断网与服务端异常结果未知，调用方必须按同一请求重试，不能换请求号另发。
function statusFailure(response) {
  const code = response.data && typeof response.data.error === 'string' ? response.data.error : '';
  if (response.statusCode === 400) {
    // 服务端明确拒绝，没有建单，可以修正后重试。
    return { kind: 'invalid', message: '提交内容有误，请检查后重试。' };
  }
  if (response.statusCode === 409) {
    if (code === 'submission_conflict') {
      // 同一请求号此前已对应其他内容：本次内容未写入，是否已入库需凭回执核对。
      return {
        kind: 'conflict',
        message: '本次提交的内容与此前同一请求号的内容冲突，未写入。请先用回执查询确认是否已提交，再决定是否重新提交。'
      };
    }
    return { kind: 'conflict', message: '提交内容与此前不一致，本次未写入，请先查询回执确认后再试。' };
  }
  if (response.statusCode === 413) {
    return { kind: 'invalid', message: '内容或照片超出大小限制，请减少照片后重试。' };
  }
  if (response.statusCode === 415) {
    return { kind: 'invalid', message: '提交格式不被接受，请重新选择照片后重试。' };
  }
  if (response.statusCode === 429) {
    return { kind: 'limited', message: '提交过于频繁，请稍后再试。' };
  }
  if (response.statusCode === 503 && code === 'wechat_code_unavailable') {
    // 工单与照片已保存，只是微信查询码暂不可用；用同一请求重试可取回原回执。
    return { kind: 'error', unknown: true, message: '诉求已保存，微信查询码暂不可用，请用同一请求稍后重试取回回执。' };
  }
  if (response.statusCode >= 500) {
    return { kind: 'error', unknown: true, message: '服务暂时不可用，结果未知，请用同一请求稍后重试。' };
  }
  return { kind: 'error', message: '提交未完成，请稍后重试。' };
}

// 整理回执。工单编号、公开查询码与私密查询凭证缺一不可，缺任一项都不算可用的回执。
// 微信小程序查询码是可选字段：随回执原样带出，由页面另行校验与展示。
function normalizeReceipt(data) {
  if (!data || typeof data !== 'object') return null;
  const caseNumber = typeof data.caseNumber === 'string' ? data.caseNumber.trim() : '';
  const publicLookupCode = typeof data.publicLookupCode === 'string' ? data.publicLookupCode.trim() : '';
  const privateLookupToken = typeof data.privateLookupToken === 'string' ? data.privateLookupToken.trim() : '';
  if (!caseNumber || !RECEIPT_CODE_PATTERN.test(publicLookupCode) || !RECEIPT_TOKEN_PATTERN.test(privateLookupToken)) {
    return null;
  }
  const receipt = { caseNumber, publicLookupCode, privateLookupToken };
  if (data.wechatCode && typeof data.wechatCode === 'object') receipt.wechatCode = data.wechatCode;
  return receipt;
}

// 提交一条游客诉求。返回 { kind, ... }，kind 为页面状态机取值。
// unknown 表示结果未知（超时、断网、响应无法识别）：服务端可能已经建单，
// 调用方必须沿用同一请求号与同一内容重试，不能改内容换号重发。
// 结果未知时一并返回已发出的请求体 body，调用方按原字节重试，
// 本机照片临时路径失效也不影响重试。
// prepared 是已经组装好的请求体：重试时直接复用，不再读本机照片文件。
async function submitCase({ request, baseUrl, payload, files, timeout, isCurrent, prepared }) {
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) {
    return { kind: 'error', message: '服务地址无效，无法提交诉求。' };
  }
  const checked = validateSubmission(payload);
  if (Object.keys(checked.errors).length) {
    return { kind: 'invalid', local: true, errors: checked.errors, message: '请补全必填项后再提交。' };
  }
  let body = null;
  if (prepared && prepared.data && prepared.contentType) {
    // 复用已经发出过的请求体：按原字节重试，不再读本机照片文件。
    body = prepared;
  } else {
    try {
      body = await buildMultipart({ payload: checked.payload, files, isCurrent });
    } catch (error) {
      // 本地校验或制包失败：请求没有发出，服务端没有存单。
      return { kind: 'invalid', local: true, message: photoMessage(error) };
    }
    if (!body) return { kind: 'cancelled' };
  }
  let response;
  try {
    response = await requestJson({
      request,
      url: baseUrl.replace(/\/+$/, '') + '/api/v1/public/cases',
      method: 'POST',
      data: body.data,
      header: { 'content-type': body.contentType },
      timeout
    });
  } catch (error) {
    const message = (error && error.message) || '';
    if (/invalid_api_environment/.test(message)) {
      // 服务地址未配置，请求没有发出，可以修正配置后重试。
      return { kind: 'invalid', local: true, message: '服务地址无效，无法提交诉求，请稍后再试。' };
    }
    if (error && error.timedOut) {
      return { kind: 'timeout', unknown: true, body, message: '提交超时，结果未知，请用同一请求重试。' };
    }
    return { kind: 'network', unknown: true, body, message: '网络异常，结果未知，请用同一请求重试。' };
  }
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    const failure = statusFailure(response);
    // 结果未知时保留已发出的字节，供按原内容原样重试。
    if (failure.unknown) failure.body = body;
    return failure;
  }
  const receipt = normalizeReceipt(response.data);
  if (!receipt) {
    return { kind: 'error', unknown: true, body, message: '回执无法识别，结果未知，请用同一请求稍后重试。' };
  }
  return { kind: 'success', created: response.statusCode === 201, receipt };
}

// 查看进度用的页面路径。只带公开查询码，不带任何私密凭证。
function progressUrl(code) {
  if (typeof code !== 'string' || !PUBLIC_CODE_PATTERN.test(code)) return '';
  return '/pages/public/index?code=' + encodeURIComponent(code);
}

module.exports = {
  LIMITS,
  MAX_PHOTOS,
  CATEGORY_OPTIONS,
  TIMESTAMP_PATTERN,
  PUBLIC_CODE_PATTERN,
  RECEIPT_CODE_PATTERN,
  RECEIPT_TOKEN_PATTERN,
  newClientRequestId,
  occurredAtText,
  validateSubmission,
  buildMultipart,
  submitCase,
  progressUrl
};

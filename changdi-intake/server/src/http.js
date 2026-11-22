export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

export async function readBody(request, maxBytes) {
  if (Number(request.headers['content-length']) > maxBytes) {
    throw new HttpError(413, 'body_too_large');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => fail(new HttpError(408, 'body_timeout')), 15_000);
    function cleanup() {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('close', onError);
    }
    function fail(error) {
      request.pause();
      cleanup();
      reject(error);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    }
    function onError() {
      fail(new HttpError(400, 'incomplete_body'));
    }
    request.on('error', onError);
    request.on('close', onError);
    request.on('end', onEnd);
    request.on('data', onData);
  });
}

export function parseJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json_object');
  }
  return value;
}

export function onlyFields(object, fields) {
  if (Object.keys(object).some(key => !fields.includes(key))) {
    throw new HttpError(400, 'unknown_field');
  }
}

export function readText(value, maxLength) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maxLength ||
      value.includes('\0') || !value.isWellFormed()) {
    throw new HttpError(400, 'invalid_field');
  }
  return value.trim();
}

export function timestamp(value) {
  const text = readText(value, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(text);
  const date = new Date(text);
  if (!match || Number.isNaN(date.valueOf()) ||
      new Date(text.slice(0, 10)).toISOString().slice(0, 10) !== text.slice(0, 10) ||
      date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new HttpError(400, 'invalid_timestamp');
  }
  return date.toISOString();
}

export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

export function sendPhoto(response, photo) {
  response.writeHead(200, {
    'Content-Type': photo.mediaType,
    'Content-Length': photo.bytes.length,
    'Content-Disposition': 'attachment',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(photo.bytes);
}

export function requireMethod(request, response, method) {
  if (request.method === method) {
    return;
  }
  response.setHeader('Allow', method);
  throw new HttpError(405, 'method_not_allowed');
}

export async function readAction(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'expected_json');
  }
  const bytes = await readBody(request, 32 * 1024);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'invalid_utf8');
  }
  return parseJson(text);
}

export function readFilters(query, fields) {
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (!fields.includes(key) || params.getAll(key).length !== 1) {
      throw new HttpError(400, 'invalid_filter');
    }
  }
  return params;
}

export function isMultipart(request) {
  const contentType = request.headers['content-type'] ?? '';
  return /^multipart\/form-data\b/i.test(contentType);
}

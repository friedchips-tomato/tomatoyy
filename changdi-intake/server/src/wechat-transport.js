export const wechatOrigin = 'https://api.weixin.qq.com';
const maxJsonBytes = 16 * 1024;
const requestError = () => new Error('wechat_request_failed');

export function validWechatOptions(appId, appSecret, fetchImpl, timeoutMs) {
  return typeof appId === 'string' && /^wx[A-Za-z0-9]{16}$/.test(appId) && appId.length === 18 &&
    typeof appSecret === 'string' && /^[A-Za-z0-9_-]{16,128}(?![\s\S])/.test(appSecret) &&
    typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10_000;
}

async function readLimited(response, limit, signal) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw requestError();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw requestError();
      chunks.push(value);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function asWechatJson(bytes) {
  if (bytes.length > maxJsonBytes) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function requestWechat(url, { fetchImpl, timeoutMs, body, imageTypes = [], maxImageBytes = 0 }) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(requestError());
      controller.abort();
    }, timeoutMs);
  });
  async function request() {
    const response = await fetchImpl(url, {
      ...(body === undefined ? { method: 'GET' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
      redirect: 'error', signal: controller.signal,
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw requestError();
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const bytes = await readLimited(response, imageTypes.includes(type) ? maxImageBytes : maxJsonBytes, controller.signal);
    return { ok: response.ok, type, bytes };
  }
  try {
    return await Promise.race([request(), deadline]);
  } catch {
    // Never retain upstream URLs, payloads, or fetch errors.
    throw requestError();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

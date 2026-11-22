import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.js';
import { asWechatJson, requestWechat, validWechatOptions, wechatOrigin } from './wechat-transport.js';

const codePattern = /^[A-Za-z0-9_-]{1,256}(?![\s\S])/;
const openIdPattern = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const rejectedCodes = new Set([40029, 40163, 40226]);
const replayMs = 5 * 60 * 1000;
const maxCodeAttempts = 8192;
const maxSessions = 4096;
const maxConcurrentExchanges = 8;
const hash = value => createHash('sha256').update(value).digest('hex');
const denied = () => new HttpError(401, 'wechat_login_denied');
const unavailable = () => new HttpError(503, 'wechat_login_unavailable');

function validOpenId(value) {
  return typeof value === 'string' && openIdPattern.test(value);
}

function discardExpired(entries, time) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= time) entries.delete(key);
  }
}

export function createWechatLogin({
  appId, appSecret, bindings, fetchImpl = globalThis.fetch, timeoutMs = 3000, sessionSeconds = 900,
}, now, findIdentity) {
  if (!validWechatOptions(appId, appSecret, fetchImpl, timeoutMs) || !Array.isArray(bindings) ||
      !Number.isSafeInteger(sessionSeconds) || sessionSeconds < 1 || sessionSeconds > 1800) {
    throw new Error('Invalid WeChat login configuration');
  }
  const approved = new Map();
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' ||
        Object.keys(binding).some(key => !['openid', 'type', 'id'].includes(key)) ||
        !validOpenId(binding.openid) || !findIdentity(binding.type, binding.id)) {
      throw new Error('Invalid WeChat identity binding');
    }
    const key = hash(binding.openid);
    if (approved.has(key)) throw new Error('Duplicate WeChat identity binding');
    approved.set(key, { type: binding.type, id: binding.id });
  }

  const attempts = new Map();
  const sessions = new Map();
  let exchanges = 0;

  function resolveIdentity(key) {
    const binding = approved.get(key);
    return binding && findIdentity(binding.type, binding.id);
  }

  async function exchange(code) {
    const url = new URL('/sns/jscode2session', wechatOrigin);
    url.search = new URLSearchParams({
      appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code',
    });
    let result;
    try {
      result = await requestWechat(url.href, { fetchImpl, timeoutMs });
    } catch {
      throw unavailable();
    }
    const json = asWechatJson(result.bytes);
    if (rejectedCodes.has(json?.errcode)) throw denied();
    if (!result.ok || !json || (json.errcode !== undefined && json.errcode !== 0) || !validOpenId(json.openid)) {
      throw unavailable();
    }
    return hash(json.openid);
  }

  return {
    async issue(code) {
      if (typeof code !== 'string' || !codePattern.test(code)) throw new HttpError(400, 'invalid_wechat_login_request');
      if (approved.size === 0) throw denied();
      const time = now().getTime();
      discardExpired(attempts, time);
      const key = hash(code);
      if (attempts.has(key)) throw denied();
      if (exchanges >= maxConcurrentExchanges || attempts.size >= maxCodeAttempts) throw unavailable();
      // The upstream may have consumed code even when its response is lost.
      attempts.set(key, { expiresAt: time + replayMs });
      exchanges++;
      try {
        const subject = await exchange(code);
        const principal = resolveIdentity(subject);
        if (!principal) throw denied();
        const issuedAt = now().getTime();
        discardExpired(sessions, issuedAt);
        if (sessions.size >= maxSessions) throw unavailable();
        const sessionToken = 'wxsession.' + randomBytes(32).toString('base64url');
        const expiresAt = issuedAt + sessionSeconds * 1000;
        sessions.set(hash(sessionToken), { subject, expiresAt });
        const identity = principal.type === 'staff'
          ? { type: 'staff', id: principal.id, role: principal.role,
            department: principal.role === 'duty' ? null : principal.department }
          : { type: 'merchant', merchantId: principal.merchantId, permissions: [...principal.permissions] };
        return { sessionToken, expiresAt: new Date(expiresAt).toISOString(), identity };
      } finally {
        exchanges--;
      }
    },
    authenticate(token) {
      const key = hash(token);
      const session = sessions.get(key);
      if (!session) return undefined;
      const principal = session.expiresAt > now().getTime() ? resolveIdentity(session.subject) : undefined;
      if (!principal) sessions.delete(key);
      return principal;
    },
  };
}

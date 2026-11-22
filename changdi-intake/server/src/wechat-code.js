import { createHash } from 'node:crypto';
import { HttpError } from './http.js';
import { matchesPhotoSignature } from './intake.js';
import { asWechatJson, requestWechat, validWechatOptions, wechatOrigin } from './wechat-transport.js';

const codePage = 'pages/public/index';
const imageTypes = ['image/jpeg', 'image/png'];
const binaryTypes = [...imageTypes, 'application/octet-stream'];
const expiredTokenCodes = new Set([40001, 40014, 42001]);
const maxCodeBytes = 1024 * 1024;
const maxPendingCodes = 4;
const unavailable = () => new HttpError(503, 'wechat_code_unavailable');

export function createWechatCodeClient({ appId, appSecret, envVersion, fetchImpl = globalThis.fetch, timeoutMs = 3000 }, now) {
  if (!validWechatOptions(appId, appSecret, fetchImpl, timeoutMs) ||
      !['release', 'trial', 'develop'].includes(envVersion)) {
    throw new Error('Invalid WeChat mini-program code configuration');
  }
  let cachedToken;
  let fetchingToken;
  let lastForcedAt = -Infinity;

  async function post(url, body, allowImage = false) {
    try {
      return await requestWechat(url, {
        fetchImpl, timeoutMs, body, imageTypes: allowImage ? binaryTypes : [], maxImageBytes: maxCodeBytes,
      });
    } catch {
      throw unavailable();
    }
  }

  async function getToken(rejected) {
    const time = now().getTime();
    if (cachedToken?.value === rejected && rejected !== undefined) cachedToken = undefined;
    if (cachedToken && cachedToken.refreshAt > time) return cachedToken.value;
    if (fetchingToken) return fetchingToken;
    const force = rejected !== undefined;
    if (force) {
      if (time - lastForcedAt < 30_000) throw unavailable();
      lastForcedAt = time;
    }
    fetchingToken = (async () => {
      const result = await post(wechatOrigin + '/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: force,
      });
      const json = asWechatJson(result.bytes);
      if (!result.ok || !json || (json.errcode !== undefined && json.errcode !== 0) ||
          typeof json.access_token !== 'string' || !/^[\x21-\x7e]{1,2048}(?![\s\S])/.test(json.access_token) ||
          !Number.isSafeInteger(json.expires_in) || json.expires_in < 1 || json.expires_in > 7200) {
        throw unavailable();
      }
      const ttl = json.expires_in;
      cachedToken = { value: json.access_token, refreshAt: time + (ttl - Math.min(60, Math.floor(ttl / 10))) * 1000 };
      return cachedToken.value;
    })();
    try {
      return await fetchingToken;
    } finally {
      fetchingToken = undefined;
    }
  }

  async function requestCode(scene, token) {
    const url = new URL('/wxa/getwxacodeunlimit', wechatOrigin);
    url.searchParams.set('access_token', token);
    const result = await post(url.href, {
      scene, page: codePage, check_path: envVersion === 'release', env_version: envVersion,
    }, true);
    const types = result.type === 'application/octet-stream' ? imageTypes : imageTypes.filter(type => type === result.type);
    const mediaType = result.ok && types.find(type => matchesPhotoSignature(type, result.bytes));
    if (mediaType) return { image: { mediaType, bytes: result.bytes } };
    return { tokenRejected: expiredTokenCodes.has(asWechatJson(result.bytes)?.errcode) };
  }

  return {
    scope: createHash('sha256').update(appId).digest('hex'),
    envVersion,
    async generate(scene) {
      if (typeof scene !== 'string' || scene.length !== 24 || !/^[A-Za-z0-9_-]{24}$/.test(scene)) throw unavailable();
      let token = await getToken();
      let result = await requestCode(scene, token);
      if (result.tokenRejected) {
        token = await getToken(token);
        result = await requestCode(scene, token);
        if (result.tokenRejected && cachedToken?.value === token) cachedToken = undefined;
      }
      if (!result.image) throw unavailable();
      return result.image;
    },
  };
}

export function createWechatReceiptCode(client, store) {
  const { scope, envVersion } = client;
  const pending = new Map();
  return async (caseId, scene) => {
    let image = store.readWechatCode(caseId, scope, envVersion);
    if (!image) {
      let task = pending.get(caseId);
      if (!task) {
        if (pending.size >= maxPendingCodes) throw unavailable();
        task = client.generate(scene)
          .then(generated => store.saveWechatCode(caseId, scope, envVersion, generated))
          .finally(() => pending.delete(caseId));
        pending.set(caseId, task);
      }
      image = await task;
    }
    return { envVersion, mediaType: image.mediaType, base64: Buffer.from(image.bytes).toString('base64') };
  };
}

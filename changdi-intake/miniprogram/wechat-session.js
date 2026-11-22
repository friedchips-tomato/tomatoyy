const config = require('./config');
const { apiEnvironment, requestConfigured } = require('./api-environment');

const invalidEnvironment = '服务地址无效，请检查正式 HTTPS 或本地回环配置。';
const expiredMessage = '微信登录已失效，请重新登录。';
const loginError = '微信登录失败，请重试。';

function clearWechatSession(page) {
  clearTimeout(page._wechatExpiryTimer);
  page._wechatExpiresAt = 0;
  page._wechatOrigin = '';
}

function activeSession(page, sequence) {
  if (!page._alive || page._session !== sequence) return false;
  const { origin, wechatEnabled } = apiEnvironment();
  if ((page._wechatOrigin && (page._wechatExpiresAt <= Date.now() || page._wechatOrigin !== origin)) ||
      (page._token && wechatEnabled && !page._wechatOrigin)) {
    page.clearSession(expiredMessage);
    return false;
  }
  return true;
}

async function exchange(origin, current) {
  const code = await new Promise((resolve, reject) => wx.login({
    timeout: config.requestTimeout, success: result => resolve(result && result.code), fail: reject
  }));
  if (!current()) return null;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,256}(?![\s\S])/.test(code)) throw new Error(loginError);
  const reply = await new Promise((resolve, reject) => requestConfigured({
    url: origin + '/api/v1/auth/wechat/session',
    method: 'POST', data: { code }, header: { 'Content-Type': 'application/json' },
    timeout: config.requestTimeout, dataType: 'json', success: resolve, fail: reject
  }));
  return current() ? reply : null;
}

async function loginWithWechat(page, expectedType) {
  if (!page._alive || page.data.loginBusy || page.data.view !== 'login') return;
  const { origin, wechatEnabled } = apiEnvironment();
  if (!wechatEnabled) {
    page.setData({ loginError: invalidEnvironment });
    return;
  }
  const sequence = ++page._session;
  page.setData({ loginBusy: true, loginError: '' });
  const current = () => page.active(sequence) && apiEnvironment().origin === origin;
  try {
    const reply = await exchange(origin, current);
    if (!page.active(sequence)) return;
    if (!current()) return page.clearSession(invalidEnvironment);
    if (reply.statusCode !== 200) {
      const message = reply.statusCode === 401 ? '当前微信账号未获准进入此窗口，请联系管理员。' : loginError;
      return page.clearSession(message);
    }
    const { sessionToken, expiresAt, identity } = reply.data || {};
    if (!identity || identity.type !== expectedType) return page.clearSession('当前微信身份无法进入此窗口。');
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof sessionToken !== 'string' || !/^wxsession\.[A-Za-z0-9_-]{43}(?![\s\S])/.test(sessionToken) ||
        !Number.isFinite(expiry) || expiry <= Date.now() || expiry - Date.now() > 30 * 60 * 1000) {
      return page.clearSession(expiredMessage);
    }
    page._token = sessionToken;
    page._wechatOrigin = origin;
    page._wechatExpiresAt = expiry;
    page._wechatExpiryTimer = setTimeout(() => {
      if (page._session === sequence) page.clearSession(expiredMessage);
    }, expiry - Date.now());
    return page.finishLogin(sequence);
  } catch {
    if (page.active(sequence)) page.clearSession(loginError);
  }
}

module.exports = { invalidEnvironment, clearWechatSession, activeSession, loginWithWechat };

const config = require('./config');

function localOrigin(value) {
  if (typeof value !== 'string') return '';
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?(?![\s\S])/.exec(value);
  return match && (!match[1] || Number(match[1]) <= 65535) ? value : '';
}

function httpsOrigin(value) {
  if (typeof value !== 'string') return '';
  const match = /^https:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?(?![\s\S])/.exec(value);
  if (!match || match[1].length > 253 || (match[2] && Number(match[2]) > 65535)) return '';
  const labels = match[1].split('.');
  const suffix = labels[labels.length - 1];
  if (labels.length < 2 || !/^[a-z]/.test(suffix) || suffix === 'localhost' ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
  return value;
}

function apiEnvironment() {
  const local = config.apiMode === 'development' ? localOrigin(config.apiBaseUrl) : '';
  const https = config.apiMode === 'production' ? httpsOrigin(config.productionApiBaseUrl) : '';
  return { origin: local || https, localEnabled: Boolean(local), wechatEnabled: Boolean(https) };
}

function requestConfigured(options) {
  const { origin } = apiEnvironment();
  if (!origin || typeof options.url !== 'string' || !options.url.startsWith(origin + '/api/v1/')) {
    options.fail({ errMsg: 'invalid_api_environment' });
    return;
  }
  return wx.request(options);
}

module.exports = { apiEnvironment, requestConfigured, localOrigin, httpsOrigin };

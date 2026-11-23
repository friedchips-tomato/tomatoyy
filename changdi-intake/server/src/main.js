import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIntakeServer } from './server.js';

// 启动失败时必须打印真实原因，但绝不能回显任何环境变量的值。
// 下面两组名单用于「该隐藏什么」，第三组用于「该保留什么」。
const SECRET_ENVIRONMENT_VARIABLES = ['CHANGDI_RECEIPT_KEY', 'CHANGDI_WECHAT_APP_SECRET'];
const CREDENTIAL_ENVIRONMENT_VARIABLES = [
  'CHANGDI_INTEGRATIONS_JSON',
  'CHANGDI_STAFF_JSON',
  'CHANGDI_MERCHANTS_JSON',
  'CHANGDI_SUPERVISION_JSON',
  'CHANGDI_REPRESENTATIVE_REPORTS_JSON',
  'CHANGDI_TOURISM_JSON',
  'CHANGDI_WECHAT_IDENTITY_BINDINGS_JSON',
  'CHANGDI_PARKING_RATE_LIMIT',
];
const KNOWN_ENVIRONMENT_VARIABLES = new Set([
  ...SECRET_ENVIRONMENT_VARIABLES,
  ...CREDENTIAL_ENVIRONMENT_VARIABLES,
  'CHANGDI_PORT',
  'CHANGDI_EVALUATION_SECONDS',
  'CHANGDI_REOPEN_SECONDS',
  'CHANGDI_WECHAT_CODE_ENABLED',
  'CHANGDI_WECHAT_LOGIN_ENABLED',
  'CHANGDI_WECHAT_APP_ID',
  'CHANGDI_WECHAT_ENV_VERSION',
  'CHANGDI_PARKING_DIR',
  'NODE_ENV',
]);

// 收集需要隐藏的字面量：密钥本身，以及 JSON 配置里的 token / appSecret。
function secretValues(environment) {
  const secrets = new Set();
  const add = value => {
    if (typeof value === 'string' && value.length >= 8) secrets.add(value);
  };
  for (const name of SECRET_ENVIRONMENT_VARIABLES) add(environment[name]);
  for (const name of CREDENTIAL_ENVIRONMENT_VARIABLES) {
    const raw = environment[name];
    if (typeof raw !== 'string') continue;
    for (const match of raw.matchAll(/"(?:token|appSecret|password|secret)"\s*:\s*"([^"\\]*)"/g)) add(match[1]);
  }
  return [...secrets];
}

// 去掉疑似凭据的长串（base64url 密钥与 token 都是 32 位以上）。
// 已知的环境变量名保留，方便现场判断是哪一个变量没配好。
function redact(text, secrets) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret && output.includes(secret)) output = output.split(secret).join('[redacted]');
  }
  output = output.replace(/[A-Za-z0-9_-]{32,}/g, match =>
    KNOWN_ENVIRONMENT_VARIABLES.has(match) ? match : '[redacted]');
  return output;
}

// JSON 解析失败时只报变量名和位置，不把原文（可能含 token）带进日志。
function parseConfigurationJson(name, raw, fallback) {
  try {
    return JSON.parse(raw ?? fallback);
  } catch (error) {
    const detail = String(error && error.message ? error.message : error);
    const position = /at position (\d+)/.exec(detail)?.[1];
    throw new Error('Invalid ' + name + ': not valid JSON' + (position ? ' at position ' + position : ''));
  }
}

let server;
try {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This entry point is for local development only');
  }
  const key = process.env.CHANGDI_RECEIPT_KEY ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Configure CHANGDI_RECEIPT_KEY');
  const receiptKey = Buffer.from(key, 'base64url');
  if (receiptKey.toString('base64url') !== key) throw new Error('Configure CHANGDI_RECEIPT_KEY');
  const integrations = parseConfigurationJson('CHANGDI_INTEGRATIONS_JSON', process.env.CHANGDI_INTEGRATIONS_JSON, '[]');
  const staff = parseConfigurationJson('CHANGDI_STAFF_JSON', process.env.CHANGDI_STAFF_JSON, '[]');
  const merchants = parseConfigurationJson('CHANGDI_MERCHANTS_JSON', process.env.CHANGDI_MERCHANTS_JSON, '[]');
  const supervision = parseConfigurationJson('CHANGDI_SUPERVISION_JSON', process.env.CHANGDI_SUPERVISION_JSON, 'null');
  const representativeReports = parseConfigurationJson('CHANGDI_REPRESENTATIVE_REPORTS_JSON',
    process.env.CHANGDI_REPRESENTATIVE_REPORTS_JSON, 'null');
  const tourism = parseConfigurationJson('CHANGDI_TOURISM_JSON', process.env.CHANGDI_TOURISM_JSON, '{}');
  const port = Number(process.env.CHANGDI_PORT ?? 3400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const evaluationSeconds = Number(process.env.CHANGDI_EVALUATION_SECONDS ?? 7 * 86400);
  const reopenSeconds = Number(process.env.CHANGDI_REOPEN_SECONDS ?? 30 * 86400);
  const wechatEnabled = process.env.CHANGDI_WECHAT_CODE_ENABLED ?? '0';
  if (!['0', '1'].includes(wechatEnabled)) throw new Error('Configure CHANGDI_WECHAT_CODE_ENABLED');
  const wechatLoginEnabled = process.env.CHANGDI_WECHAT_LOGIN_ENABLED ?? '0';
  if (!['0', '1'].includes(wechatLoginEnabled)) throw new Error('Configure CHANGDI_WECHAT_LOGIN_ENABLED');
  const wechatCode = wechatEnabled === '1' ? {
    appId: process.env.CHANGDI_WECHAT_APP_ID,
    appSecret: process.env.CHANGDI_WECHAT_APP_SECRET,
    envVersion: process.env.CHANGDI_WECHAT_ENV_VERSION,
  } : undefined;
  const wechatLogin = wechatLoginEnabled === '1' ? {
    appId: process.env.CHANGDI_WECHAT_APP_ID,
    appSecret: process.env.CHANGDI_WECHAT_APP_SECRET,
    bindings: parseConfigurationJson('CHANGDI_WECHAT_IDENTITY_BINDINGS_JSON',
      process.env.CHANGDI_WECHAT_IDENTITY_BINDINGS_JSON, '[]'),
  } : undefined;
  const dataDirectory = new URL('../.local/', import.meta.url);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  server = createIntakeServer({
    dbPath: fileURLToPath(new URL('intake.sqlite', dataDirectory)),
    receiptKey,
    integrations,
    staff,
    merchants,
    supervision,
    representativeReports,
    tourism,
    evaluationSeconds,
    reopenSeconds,
    wechatCode,
    wechatLogin,
    parkingRateLimit: process.env.CHANGDI_PARKING_RATE_LIMIT === undefined ? undefined :
      parseConfigurationJson('CHANGDI_PARKING_RATE_LIMIT', process.env.CHANGDI_PARKING_RATE_LIMIT, undefined),
    onInternalError: () => console.error('changdi-intake: internal_error'),
  });
  server.once('error', error => {
    console.error('changdi-intake: listen failed (' + error.code + ')');
    server.close();
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log('changdi-intake listening on http://127.0.0.1:' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close());
  }
} catch (error) {
  const secrets = secretValues(process.env);
  console.error('changdi-intake: startup failed. Check local configuration, data path and receipt key.');
  console.error('changdi-intake: startup error:', redact(error && error.message ? error.message : String(error), secrets));
  if (error && error.stack) console.error('changdi-intake: startup stack:', redact(String(error.stack), secrets));
  process.exitCode = 1;
}

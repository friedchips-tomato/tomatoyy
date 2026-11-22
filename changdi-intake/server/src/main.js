import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIntakeServer } from './server.js';

let server;
try {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This entry point is for local development only');
  }
  const key = process.env.CHANGDI_RECEIPT_KEY ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Configure CHANGDI_RECEIPT_KEY');
  const receiptKey = Buffer.from(key, 'base64url');
  if (receiptKey.toString('base64url') !== key) throw new Error('Configure CHANGDI_RECEIPT_KEY');
  const integrations = JSON.parse(process.env.CHANGDI_INTEGRATIONS_JSON ?? '[]');
  const staff = JSON.parse(process.env.CHANGDI_STAFF_JSON ?? '[]');
  const merchants = JSON.parse(process.env.CHANGDI_MERCHANTS_JSON ?? '[]');
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
    bindings: JSON.parse(process.env.CHANGDI_WECHAT_IDENTITY_BINDINGS_JSON ?? '[]'),
  } : undefined;
  const dataDirectory = new URL('../.local/', import.meta.url);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  server = createIntakeServer({
    dbPath: fileURLToPath(new URL('intake.sqlite', dataDirectory)),
    receiptKey,
    integrations,
    staff,
    merchants,
    evaluationSeconds,
    reopenSeconds,
    wechatCode,
    wechatLogin,
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
} catch {
  console.error('changdi-intake: startup failed. Check local configuration, data path and receipt key.');
  process.exitCode = 1;
}

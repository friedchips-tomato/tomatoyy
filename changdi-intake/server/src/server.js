import {createServer} from 'node:http';

import {createAuth} from './auth.js';
import {HttpError, sendJson} from './http.js';
import {createPublicRateLimiter} from './public-rate-limit.js';
import {representativeReportConfig} from './representative-report.js';
import {handleIntakeRoute} from './routes/intake.js';
import {handleOwnerRoute} from './routes/owner.js';
import {handleMerchantRoute} from './routes/merchant.js';
import {handlePublicRoute} from './routes/public.js';
import {handleStaffRoute} from './routes/staff.js';
import {handleTourismRoute} from './routes/tourism.js';
import {openStore} from './store.js';
import {supervisionConfig} from './supervision.js';
import {createWechatCodeClient, createWechatReceiptCode} from './wechat-code.js';

const MAX_CONCURRENT_UPLOADS = 4;

export function createIntakeServer({
  dbPath,
  receiptKey,
  integrations,
  staff = [],
  merchants = [],
  now = () => new Date(),
  evaluationSeconds = 7 * 86400,
  reopenSeconds = 30 * 86400,
  onInternalError = () => {},
  wechatCode,
  wechatLogin,
  publicRateLimit,
  supervision,
  representativeReports,
  tourism = {},
}) {
  if (!Buffer.isBuffer(receiptKey) || receiptKey.length !== 32) {
    throw new Error('Receipt key must contain 32 bytes');
  }
  if (!Number.isSafeInteger(evaluationSeconds) || evaluationSeconds < 1 || evaluationSeconds > 90 * 86400) {
    throw new Error('Evaluation period must be between one second and 90 days');
  }
  if (!Number.isSafeInteger(reopenSeconds) || reopenSeconds < 1 || reopenSeconds > 365 * 86400) {
    throw new Error('Reopen period must be between one second and 365 days');
  }
  if (!tourism || typeof tourism !== 'object' || Array.isArray(tourism) ||
      Object.keys(tourism).some(key => key !== 'sources' && key !== 'coverage')) {
    throw new Error('Invalid tourism configuration');
  }
  const {sources: tourismSources = [], coverage = []} = tourism;
  const auth = createAuth(integrations, staff, merchants, { wechatLogin, now, tourismSources });
  const supervisionSettings = supervisionConfig(supervision);
  const representativeSettings = representativeReportConfig(representativeReports, auth.representativeMerchants);
  const rateLimiter = createPublicRateLimiter({ ...publicRateLimit, now });
  const wechatClient = wechatCode === undefined ?
      null : createWechatCodeClient(wechatCode, now);
  const store = openStore(dbPath, receiptKey, now, {
    evaluationSeconds,
    reopenSeconds,
    supervision: supervisionSettings,
    representativeReports: representativeSettings,
    tourism: {sources: tourismSources.map(({id, kind, evidence, subjects}) => ({id, kind, evidence, subjects})), coverage},
  });
  const receiptCode = wechatClient && createWechatReceiptCode(wechatClient, store);
  let uploadsInProgress = 0;
  async function readPhotoUpload(request, response, read) {
    if (uploadsInProgress >= MAX_CONCURRENT_UPLOADS) {
      response.setHeader('Retry-After', '1');
      throw new HttpError(503, 'intake_busy');
    }
    uploadsInProgress++;
    try {
      return await read(request);
    } finally {
      uploadsInProgress--;
    }
  }

  const routeContext = { auth, store, receiptCode, readPhotoUpload, rateLimiter };
  const tourismContext = {authenticateTourismSource: request => auth.authenticate(request, 'tourism'), tourism: store.tourism};
  const server = createServer({
    headersTimeout: 15_000,
    requestTimeout: 20_000,
    connectionsCheckingInterval: 1000,
    keepAliveTimeout: 3000,
  }, async (request, response) => {
    try {
      if (await handleIntakeRoute(request, response, routeContext) ||
          await handleTourismRoute(request, response, tourismContext) ||
          await handlePublicRoute(request, response, routeContext) ||
          await handleOwnerRoute(request, response, routeContext) ||
          await handleMerchantRoute(request, response, routeContext) ||
          await handleStaffRoute(request, response, routeContext)) {
        return;
      }
      throw new HttpError(404, 'route_not_found');
    } catch (error) {
      if (response.destroyed) {
        return;
      }
      if (!request.readableEnded) {
        response.setHeader('Connection', 'close');
      }
      if (error instanceof HttpError) {
        if (error.status === 401) {
          response.setHeader('WWW-Authenticate', 'Bearer');
        }
        if (error.retryAfter !== undefined) {
          response.setHeader('Retry-After', String(error.retryAfter));
        }
        if (['wechat_code_unavailable', 'wechat_login_unavailable'].includes(error.message)) {
          response.setHeader('Retry-After', '1');
        }
        sendJson(response, error.status, { error: error.message });
      } else if (error.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 255)) {
        response.setHeader('Retry-After', '1');
        sendJson(response, 503, { error: 'database_busy' });
      } else {
        onInternalError();
        sendJson(response, 500, { error: 'internal_error' });
      }
    }
  });
  server.once('close', store.close);
  return server;
}

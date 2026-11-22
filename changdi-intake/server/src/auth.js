import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';
import { createWechatLogin } from './wechat-login.js';

const roles = new Set(['duty', 'supervisor', 'handler']);
const permissions = new Set(['readCases', 'submitCases', 'collaborate']);
const digest = token => createHash('sha256').update(token).digest();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);

export function createAuth(integrations, staff, merchants, { wechatLogin, now } = {}) {
  if (!Array.isArray(integrations) || !integrations.length || !Array.isArray(staff) || !Array.isArray(merchants)) {
    throw new Error('Invalid identity configuration');
  }
  const credentials = [];
  const staffById = new Map();
  const merchantMembers = new Map();
  const collaboratingMerchants = new Set();

  function addCredential(token, principal) {
    if (!validToken(token)) throw new Error('Invalid credential format');
    const hash = digest(token);
    if (credentials.some(entry => timingSafeEqual(entry.hash, hash))) {
      throw new Error('Duplicate credential');
    }
    credentials.push({ hash, principal });
  }

  for (const entry of integrations) {
    if (!entry || !validId(entry.source)) throw new Error('Invalid integration source');
    addCredential(entry.token, { type: 'integration', id: entry.source });
  }
  for (const entry of staff) {
    if (!entry || !validId(entry.id) || !roles.has(entry.role) || staffById.has(entry.id) ||
        (entry.role !== 'duty' && !validId(entry.department))) {
      throw new Error('Invalid staff directory entry');
    }
    const principal = { type: 'staff', id: entry.id, role: entry.role, department: entry.department };
    if (wechatLogin === undefined) addCredential(entry.token, principal);
    staffById.set(entry.id, principal);
  }
  for (const entry of merchants) {
    if (!entry || !validId(entry.id) || !validId(entry.merchantId) || merchantMembers.has(entry.id) ||
        !Array.isArray(entry.permissions) || entry.permissions.some(permission => !permissions.has(permission))) {
      throw new Error('Invalid merchant directory entry');
    }
    const grants = new Set(entry.permissions);
    const principal = { type: 'merchant', id: entry.id, merchantId: entry.merchantId, permissions: grants };
    if (wechatLogin === undefined) addCredential(entry.token, principal);
    merchantMembers.set(entry.id, principal);
    if (grants.has('collaborate')) collaboratingMerchants.add(entry.merchantId);
  }

  function findIdentity(type, id) {
    if (type === 'staff') return staffById.get(id);
    if (type === 'merchant') return merchantMembers.get(id);
    return undefined;
  }
  const login = wechatLogin === undefined ? null : createWechatLogin(wechatLogin, now, findIdentity);

  function findCredential(token) {
    const hash = digest(token);
    let principal;
    for (const entry of credentials) {
      if (timingSafeEqual(entry.hash, hash)) principal = entry.principal;
    }
    return principal;
  }

  return {
    login,
    staffById,
    collaboratingMerchants,
    authenticate(request, type) {
      const token = /^Bearer ((?:wxsession\.)?[A-Za-z0-9_-]{32,256})(?![\s\S])/i.exec(request.headers.authorization ?? '')?.[1];
      if (!token) throw new HttpError(401, 'unauthorized');
      const principal = token.startsWith('wxsession.') ? login?.authenticate(token) : findCredential(token);
      if (!principal) throw new HttpError(401, 'unauthorized');
      if (principal.type !== type) throw new HttpError(403, 'forbidden');
      return principal;
    },
  };
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, onlyFields } from './http.js';

const publicCode = /^[A-Za-z0-9_-]{24}$/;
const signature = /^[A-Za-z0-9_-]{43}$/;
const ownerBearer = /^Bearer owner\.([0-9]{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/i;
const sessionSeconds = 30 * 60;
const attemptSeconds = 15 * 60;
const maxFailures = 10;
const compare = (left, right) => timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
const epoch = date => Math.floor(date.valueOf() / 1000);

export const privateTokenForCode = (sign, code) => sign('changdi-intake:private-lookup:v1:' + code);

export function createOwnerAuth(db, sign, now) {
  const signSession = (caseNumber, expires, nonce) =>
    sign('changdi-intake:owner-session:v1:' + [caseNumber, expires, nonce].join(':'));
  const caseByCode = db.prepare('SELECT case_number FROM cases WHERE public_lookup_code = ?');
  const attempts = db.prepare('SELECT expires_at, failures FROM owner_verify_attempts WHERE origin_hash = ?');
  const discardExpired = db.prepare('DELETE FROM owner_verify_attempts WHERE expires_at <= ?');
  const recordFailure = db.prepare(`
    INSERT INTO owner_verify_attempts VALUES (?, ?, 1)
    ON CONFLICT (origin_hash) DO UPDATE SET failures = failures + 1
  `);

  return {
    // Called inside the store write transaction. Return errors so counting a failure can commit.
    verify(input, address) {
      onlyFields(input, ['publicLookupCode', 'privateLookupToken']);
      const current = epoch(now());
      discardExpired.run(current);
      const origin = sign('changdi-intake:verify-origin:v1:' + address);
      const entry = attempts.get(origin);
      if (entry?.failures >= maxFailures) return { retryAfter: entry.expires_at - current };

      const code = input.publicLookupCode;
      const token = input.privateLookupToken;
      const item = typeof code === 'string' && code.length === 24 && publicCode.test(code) &&
        typeof token === 'string' && token.length === 43 && signature.test(token) &&
        compare(privateTokenForCode(sign, code), token) && caseByCode.get(code);
      if (!item) {
        recordFailure.run(origin, current + attemptSeconds);
        return null;
      }

      const expires = current + sessionSeconds;
      const nonce = randomBytes(12).toString('base64url');
      return {
        caseNumber: item.case_number,
        ownerSessionToken: ['owner', expires, nonce, signSession(item.case_number, expires, nonce)].join('.'),
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },
    authenticate(authorization, caseNumber) {
      const match = ownerBearer.exec(authorization ?? '');
      if (match) {
        const [, expires, nonce, token] = match;
        if (Number(expires) > epoch(now()) && compare(signSession(caseNumber, expires, nonce), token)) return;
      }
      throw new HttpError(401, 'owner_authorization_required');
    },
  };
}

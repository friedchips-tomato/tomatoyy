import { HttpError } from './http.js';

const defaultWindowSeconds = 600;
const defaultLimit = 10;
const sweepThreshold = 1024;

/**
 * Fixed window counter keyed by the peer address. Only new case creations are
 * counted, so a replay of the same client request id keeps its receipt.
 */
export function createPublicRateLimiter({
  windowSeconds = defaultWindowSeconds,
  limit = defaultLimit,
  now = () => new Date(),
}) {
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error('Public rate limit window must be a positive number of seconds');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Public rate limit must be a positive number of submissions');
  }
  const windows = new Map();

  function sweep(time) {
    if (windows.size < sweepThreshold) return;
    for (const [address, entry] of windows) {
      if (entry.resetAt <= time) windows.delete(address);
    }
  }

  function window(address, time) {
    const entry = windows.get(address);
    if (!entry) return null;
    if (entry.resetAt <= time) {
      sweep(time);
      return null;
    }
    return entry;
  }

  return {
    // Called before the case is written so a limited request leaves no rows.
    check(address) {
      const time = now().getTime();
      const entry = window(address, time);
      if (entry && entry.count >= limit) {
        const error = new HttpError(429, 'too_many_requests');
        error.retryAfter = Math.max(1, Math.ceil((entry.resetAt - time) / 1000));
        throw error;
      }
    },
    record(address) {
      const time = now().getTime();
      const entry = window(address, time);
      if (entry) {
        entry.count += 1;
        return;
      }
      sweep(time);
      windows.set(address, { count: 1, resetAt: time + windowSeconds * 1000 });
    },
  };
}

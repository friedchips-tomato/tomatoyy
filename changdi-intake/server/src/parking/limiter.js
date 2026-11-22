import {HttpError} from '../http.js';

export function createParkingLimiter(raw, now) {
  const config = raw === undefined ? {windowSeconds: 600, limit: 60} : JSON.parse(raw);
  if (!config || Object.keys(config).some(key => !['windowSeconds', 'limit'].includes(key)) ||
      !Number.isSafeInteger(config.windowSeconds * 1000) || !Number.isSafeInteger(config.windowSeconds) ||
      config.windowSeconds < 1 || !Number.isSafeInteger(config.limit) || config.limit < 1) {
    throw new Error('CHANGDI_PARKING_RATE_LIMIT 配置无效');
  }
  const addresses = new Map();
  return address => {
    const time = now().getTime();
    // 窗口按创建顺序到期，无需定时器。
    for (const [key, entry] of addresses) {
      if (entry.until > time) break;
      addresses.delete(key);
    }
    let entry = addresses.get(address);
    if (!entry) {
      entry = {until: time + 1000 * config.windowSeconds, count: 0};
      addresses.set(address, entry);
    }
    if (entry.count >= config.limit) {
      const error = new HttpError(429, 'too_many_requests');
      error.retryAfter = Math.ceil((entry.until - time) / 1000);
      throw error;
    }
    entry.count++;
  };
}

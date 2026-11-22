// 共享工具（与 Python 侧 src/pf/features.py 逐位一致）。
// 约定：合成数据时间戳均为零填充 ISO 8601 + "+08:00"；内部以「墙钟 epoch 秒」表示时间，
// 与 Python 的 naive datetime + total_seconds() 完全一致。

export const HORIZONS = [15, 30, 45, 60];
export const MINUTES_PER_SLOT = 15;
export const SLOTS_PER_DAY = 96;
export const WEEK_DAYS = 7;

export const WEATHER_CODES = { sunny: 0, cloudy: 1, rain: 2, heavy_rain: 3, storm: 4 };
export const RAIN_WEATHER = new Set(["rain", "heavy_rain", "storm"]);
export const PEAK_CODES = { none: 0, am_peak: 1, pm_peak: 2, evening: 3 };

export function parseParts(s) {
  return {
    y: Number(s.slice(0, 4)),
    mo: Number(s.slice(5, 7)),
    d: Number(s.slice(8, 10)),
    h: Number(s.slice(11, 13)),
    mi: Number(s.slice(14, 16)),
    s: Number(s.slice(17, 19)),
  };
}

export function epochSec(s) {
  const p = parseParts(s);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
}

export function dateKey(s) {
  return s.slice(0, 10);
}

export function dayNumOfParts(p) {
  return Date.UTC(p.y, p.mo - 1, p.d) / 86400000;
}

export function dayNum(s) {
  return dayNumOfParts(parseParts(s));
}

export function weekdayOfParts(p) {
  // 周一=0（与 Python datetime.weekday() 一致；1970-01-01 周四 => (0+3)%7=3）
  return (dayNumOfParts(p) + 3) % 7;
}

export function slotOfParts(p) {
  return p.h * 4 + Math.floor(p.mi / MINUTES_PER_SLOT);
}

export function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2.0;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

// 从「墙钟 epoch 秒」反推日历字段（Date.UTC 与 Python naive datetime 同用公历，逐位一致）。
export function partsFromEpoch(sec) {
  const d = new Date(sec * 1000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

export function dateKeyFromParts(p) {
  return `${pad(p.y, 4)}-${pad(p.mo, 2)}-${pad(p.d, 2)}`;
}

export function fmtEpoch(sec) {
  const p = partsFromEpoch(sec);
  return `${pad(p.y, 4)}-${pad(p.mo, 2)}-${pad(p.d, 2)}T${pad(p.h, 2)}:${pad(p.mi, 2)}:${pad(p.s, 2)}+08:00`;
}

export function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

export function clamp01(x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

// 时间戳字典序比较（零填充 ISO 8601 下与按时间排序等价）
export function lteTs(a, b) {
  return a.slice(0, 19) <= b.slice(0, 19);
}

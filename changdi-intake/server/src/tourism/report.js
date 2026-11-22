import { HttpError } from '../http.js';
import { bookingTypes, normalizeTime, reportTypes } from './contract.js';

const monthPattern = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])$/;
const offset = 8 * 60 * 60_000;
const bookingState = {
  booking_requested: 'requested',
  booking_confirmed: 'confirmed',
  booking_cancelled: 'cancelled'
};
const utc = ms => new Date(ms).toISOString();
const beijing = ms => utc(ms + offset).slice(0, -1) + '+08:00';

export function compileCoverage(coverage, sources) {
  if (!Array.isArray(coverage)) throw new TypeError('Tourism coverage must be an array');
  const scopes = {demo: new Map(), operational: new Map()};
  for (const {evidence, type, from, to, status} of coverage) {
    if (typeof evidence !== 'string' || !Object.hasOwn(reportTypes, evidence) || !reportTypes[evidence].includes(type) ||
        !['partial', 'complete'].includes(status) ||
        ![...sources.values()].some(source => source.evidence === evidence && source.catalog.has(type))) {
      throw new TypeError('Invalid tourism coverage scope');
    }
    const start = Date.parse(normalizeTime(from));
    const end = to == null ? Infinity : Date.parse(normalizeTime(to));
    if (start >= end) throw new TypeError('Invalid tourism coverage interval');
    const group = scopes[evidence];
    if (!group.has(type)) group.set(type, []);
    group.get(type).push({start, end, status});
  }
  for (const group of Object.values(scopes)) {
    for (const windows of group.values()) windows.sort((a, b) => a.start - b.start);
  }
  return scopes;
}

function scopeStatus(windows, start, end) {
  if (start === end || !windows.some(window => window.start < end && window.end > start)) return 'unavailable';
  let coveredUntil = start;
  for (const window of windows) {
    if (window.start > coveredUntil) break;
    if (window.status === 'complete') coveredUntil = Math.max(coveredUntil, window.end);
    if (coveredUntil >= end) return 'complete';
  }
  return 'partial';
}

function combinedStatus(scopes) {
  if (scopes.every(scope => scope.status === 'complete')) return 'complete';
  return scopes.some(scope => scope.status !== 'unavailable') ? 'partial' : 'unavailable';
}

export function createTourismReport(db, coverage, now) {
  const select = db.prepare(`
    SELECT source_id, evidence, type, subject_id, flow_id, occurred_at, duration_seconds
    FROM tourism_events
    WHERE occurred_at >= ? AND occurred_at < ? AND recorded_at < ?
  `);
  function periodFor(month, asOf) {
    const match = typeof month === 'string' && monthPattern.exec(month);
    if (!match || match[0] !== month || match[1] === '9999') throw new HttpError(400, 'invalid_report_month');
    const year = Number(match[1]);
    const index = Number(match[2]) - 1;
    const start = Date.UTC(year, index, 1) - offset;
    const end = Date.UTC(year, index + 1, 1) - offset;
    if (asOf < start) throw new HttpError(400, 'future_report_month');
    return {start, end, cutoff: Math.min(asOf, end)};
  }

  function summarizeAt(month, reportAt) {
    const {start, end, cutoff} = periodFor(month, reportAt);
    const metrics = {};
    const seconds = {demo: 0n, operational: 0n};
    const bookings = new Map();
    for (const [evidence, types] of Object.entries(reportTypes)) {
      metrics[evidence] = Object.fromEntries(types.map(type => {
        const status = scopeStatus(coverage[evidence].get(type) ?? [], start, cutoff);
        return [type, status === 'unavailable' ? {status} : {status, count: 0}];
      }));
    }

    for (const row of select.iterate(utc(start), utc(cutoff), utc(reportAt))) {
      const time = Date.parse(row.occurred_at);
      const windows = coverage[row.evidence].get(row.type);
      if (!windows?.some(window => window.start <= time && time < window.end)) continue;
      metrics[row.evidence][row.type].count++;
      if (row.type === 'guide_played') seconds[row.evidence] += BigInt(row.duration_seconds);
      if (bookingTypes.includes(row.type)) {
        const key = `${row.source_id}:${row.subject_id}:${row.flow_id}`;
        const rank = bookingTypes.indexOf(row.type);
        const previous = bookings.get(key);
        if (!previous || time > previous.time || (time === previous.time && rank > previous.rank)) {
          bookings.set(key, {time, rank, state: bookingState[row.type]});
        }
      }
    }

    for (const [evidence, total] of Object.entries(seconds)) {
      const playback = metrics[evidence].guide_played;
      if (playback.status !== 'unavailable') {
        playback.durationSeconds = total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString();
      }
    }
    const bookingCoverage = combinedStatus(bookingTypes.map(type => metrics.operational[type]));
    const bookingStatus = {status: bookingCoverage};
    if (bookingCoverage !== 'unavailable') {
      Object.assign(bookingStatus, {requested: 0, confirmed: 0, cancelled: 0});
      for (const {state} of bookings.values()) bookingStatus[state]++;
    }
    return {
      status: combinedStatus([...Object.values(metrics.demo), ...Object.values(metrics.operational)]),
      period: {start: beijing(start), endExclusive: beijing(end)},
      asOf: beijing(reportAt),
      occurrenceCutoffExclusive: beijing(cutoff),
      demo: metrics.demo,
      operational: {...metrics.operational, bookingStatus}
    };
  }

  return {
    summarizeAt,
    summarizeMonth(month, {asOf} = {}) {
      const currentTime = now().valueOf();
      const reportAt = asOf === undefined ? currentTime : Date.parse(normalizeTime(asOf));
      if (reportAt > currentTime) throw new HttpError(400, 'future_report_cutoff');
      return summarizeAt(month, reportAt);
    }
  };
}

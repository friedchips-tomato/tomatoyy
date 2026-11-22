import { createHash } from 'node:crypto';
import { HttpError } from './http.js';
import { responseDurationBand } from './monthly-report.js';

const validMonth = value => typeof value === 'string' && /^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/.test(value) && value < '9999-01';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const withheld = { status: 'withheld' };
const unavailable = { status: 'unavailable' };
const meanRating = scores => scores.flat().reduce((sum, value) => sum + value, 0) / (scores.length * 3);
const band = (value, size) => ({ status: 'available', band: Math.min(3, Math.floor(value / size)) });

export function representativeReportConfig(value, representativeMerchants) {
  if (value === undefined || value === null) return null;
  const { minimumGroupSize, months, ranges } = value;
  if (!Number.isSafeInteger(minimumGroupSize) || minimumGroupSize < 5 || minimumGroupSize > 100 ||
      !Array.isArray(months) || !months.length || months.some(month => !validMonth(month)) ||
      !Array.isArray(ranges) || !ranges.length || ranges.length > 50) {
    throw new Error('Invalid representative report policy');
  }
  const byMerchant = new Map();
  const byRange = new Map();
  for (const range of ranges) {
    if (!validId(range?.id) || byRange.has(range.id) || !Array.isArray(range.merchantIds) ||
        !range.merchantIds.length || range.merchantIds.length > 500 || range.merchantIds.some(id => !validId(id))) {
      throw new Error('Invalid representative report range');
    }
    for (const id of range.merchantIds) {
      if (byMerchant.has(id)) throw new Error('Representative report ranges must not overlap');
      byMerchant.set(id, range.id);
    }
    byRange.set(range.id, range.merchantIds.toSorted());
  }
  const excluded = [...representativeMerchants].sort();
  const policyHash = createHash('sha256').update(JSON.stringify([
    1, minimumGroupSize, [...byRange].sort(([a], [b]) => a.localeCompare(b)), excluded,
  ])).digest('hex');
  return {
    minimumGroupSize, months: new Set(months), byMerchant, byRange, excluded: new Set(excluded), policyHash,
  };
}

function monthWindow(month) {
  const start = Date.parse(month + '-01T00:00:00+08:00');
  const [year, number] = month.split('-').map(Number);
  const end = Date.UTC(year, number, 1) - 8 * 3600000;
  return { start: new Date(start).toISOString(), cutoff: new Date(end).toISOString(), end };
}

function binarySafe(rows, read, k) {
  let yes = 0;
  let no = 0;
  for (const row of rows) {
    const value = read(row);
    if (value === true) yes++;
    if (value === false) no++;
  }
  return yes >= k && no >= k;
}

function jointSafe(rows, contributions, k) {
  const cells = new Map();
  for (const row of rows) {
    const key = JSON.stringify(contributions.map(read => read(row)));
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  return [...cells.values()].every(count => count >= k);
}

function disclose(report, rows, k) {
  const { firstResponse, completion, duplicateComplaints, evaluation } = report;
  const results = {
    firstResponse: withheld, firstResponseDuration: withheld, completion: withheld, satisfaction: withheld,
    duplicateComplaints: duplicateComplaints.reason === 'structured_location_and_confirmation_missing' ? unavailable : withheld,
  };
  const inputs = [];
  function eligible(name, isSafe, contribution, publication) {
    if (isSafe) inputs.push({ name, contribution, publication });
  }
  const responded = row => row.responseMinutes !== null;
  const completed = row => row.completion;
  const duplicate = row => row.duplicate;
  const satisfaction = row => row.ratings.length ? meanRating(row.ratings) >= 4 : null;
  eligible('firstResponse', binarySafe(rows, responded, k), responded, () => band(firstResponse.responded / firstResponse.submitted, 0.25));
  eligible('completion', binarySafe(rows, completed, k), completed, () => band(completion.rate, 0.25));
  eligible('duplicateComplaints', duplicateComplaints.status === 'available' && binarySafe(rows, duplicate, k),
    duplicate, () => band(duplicateComplaints.confirmed / duplicateComplaints.submitted, 0.25));
  eligible('satisfaction', binarySafe(rows, satisfaction, k), row => row.ratings.map(rating => rating.join('')).sort(),
    () => band((evaluation.dimensions.speed.mean + evaluation.dimensions.effectiveness.mean +
      evaluation.dimensions.attitude.mean) / 3 - 1, 1));
  // Enforce k on the joint contributions, including ineligible cases, before releasing overlapping metrics.
  const joint = inputs.map(input => input.contribution);
  if (jointSafe(rows, joint, k)) {
    for (const input of inputs) results[input.name] = input.publication();
    // Adding the duration must not refine any published group into a small, inferable cell.
    const duration = row => row.responseMinutes === null ? null : responseDurationBand(row.responseMinutes);
    const { responded, distribution: { atMostOneHour, upTo24Hours } } = firstResponse;
    const splitMedian = responded % 2 === 0 &&
      [atMostOneHour, atMostOneHour + upTo24Hours].includes(responded / 2);
    // If the two middle responses straddle bands, the result can depend on their individual times.
    if (responded >= k && !splitMedian && jointSafe(rows, [...joint, duration], k)) {
      results.firstResponseDuration = { status: 'available', band: responseDurationBand(firstResponse.medianMinutes) };
    }
  }
  return results;
}

export function createRepresentativeReports(db, now, write, summarizeMonth, config) {
  const findRelease = db.prepare('SELECT policy_hash, reports FROM representative_report_releases WHERE month = ?');
  const saveRelease = db.prepare('INSERT INTO representative_report_releases VALUES (?, ?, ?, ?)');
  const eligibleCases = db.prepare(`
    SELECT m.case_id, m.merchant_id
    FROM merchant_cases m JOIN case_events e ON e.case_id = m.case_id AND e.version = 1 AND e.action = 'submit'
    WHERE e.occurred_at >= ? AND e.occurred_at < ?
  `);
  const collaborations = db.prepare(`
    SELECT t.case_id, t.merchant_id
    FROM collaboration_tasks t JOIN case_events e ON e.case_id = t.case_id AND e.version = 1 AND e.action = 'submit'
    WHERE e.occurred_at >= ? AND e.occurred_at < ?
  `);
  const enabled = principal => Boolean(config && principal.permissions.has('representativeReport') &&
    config.byMerchant.has(principal.merchantId));
  const notReleased = () => new HttpError(404, 'report_not_released');

  function freeze(month, window, frozenAt) {
    const cohorts = new Map([...config.byRange.keys()].map(range => [range, new Map()]));
    const alreadyVisible = new Set();
    for (const task of collaborations.iterate(window.start, window.cutoff)) {
      if (config.excluded.has(task.merchant_id)) alreadyVisible.add(task.case_id);
    }
    for (const row of eligibleCases.iterate(window.start, window.cutoff)) {
      const range = config.byMerchant.get(row.merchant_id);
      if (range && !config.excluded.has(row.merchant_id) && !alreadyVisible.has(row.case_id)) {
        cohorts.get(range).set(row.case_id, { responseMinutes: null, completion: null, duplicate: null, ratings: [] });
      }
    }
    const releases = Object.create(null);
    for (const [range, contributions] of cohorts) {
      const report = summarizeMonth(month, {
        asOf: window.end, includeDuplicates: true, includeCase: id => contributions.has(id), contributions,
      });
      releases[range] = disclose(report, [...contributions.values()], config.minimumGroupSize);
    }
    saveRelease.run(month, config.policyHash, JSON.stringify(releases), frozenAt.toISOString());
    return releases;
  }

  return {
    enabled,
    get(principal, month) {
      if (!enabled(principal)) throw new HttpError(403, 'forbidden');
      if (!validMonth(month)) throw new HttpError(400, 'invalid_report_month');
      const window = monthWindow(month);
      const frozenAt = now();
      if (!config.months.has(month) || window.end > frozenAt.valueOf()) throw notReleased();
      const range = config.byMerchant.get(principal.merchantId);
      const result = stored => {
        if (stored.policy_hash !== config.policyHash) throw notReleased();
        return { month, metrics: JSON.parse(stored.reports)[range] };
      };
      const previous = findRelease.get(month);
      if (previous) return result(previous);
      return write(() => {
        const stored = findRelease.get(month);
        return stored ? result(stored) : { month, metrics: freeze(month, window, frozenAt)[range] };
      });
    },
  };
}

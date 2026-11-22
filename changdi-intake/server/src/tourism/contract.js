import { HttpError, parseJson, timestamp } from '../http.js';

export const TOURISM_BODY_LIMIT = 512;
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const shortId = /^[a-f0-9]{24}$/;
const sourceIdPattern = /^[a-z][a-z0-9_-]{0,47}$/;
const subjectIdPattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const fields = ['eventId', 'type', 'subjectId', 'flowId', 'occurredAt'];

export const guideTypes = Object.freeze([
  'route_exposed', 'route_adopted', 'route_completed_self_reported', 'guide_played',
  'parking_advice_adopted', 'parking_navigation_clicked'
]);
export const bookingTypes = Object.freeze(['booking_requested', 'booking_confirmed', 'booking_cancelled']);
const demoBooking = 'booking_demo_submitted';
const verifiedArrival = 'parking_arrival_verified';
export const reportTypes = Object.freeze({
  demo: Object.freeze([...guideTypes, demoBooking]),
  operational: Object.freeze([...guideTypes, ...bookingTypes, verifiedArrival])
});
const allTypes = new Set([...reportTypes.demo, ...reportTypes.operational]);

function allowedTypes(kind, evidence) {
  if (typeof evidence !== 'string' || !Object.hasOwn(reportTypes, evidence)) return [];
  if (kind === 'guide_h5') return evidence === 'demo' ? reportTypes.demo : guideTypes;
  if (evidence === 'operational' && kind === 'booking_service') return bookingTypes;
  if (evidence === 'operational' && kind === 'parking_verifier') return [verifiedArrival];
  return [];
}

export function compileSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError('Tourism sources must be an array');
  const configured = new Map();
  for (const {id, kind, evidence, subjects} of sources) {
    if (typeof id !== 'string' || !sourceIdPattern.test(id) || configured.has(id)) {
      throw new TypeError('Invalid or duplicate tourism source ID');
    }
    const allowed = allowedTypes(kind, evidence);
    if (!allowed.length || !subjects || typeof subjects !== 'object' || Array.isArray(subjects)) {
      throw new TypeError('Invalid tourism source permissions');
    }
    const catalog = new Map();
    for (const [type, ids] of Object.entries(subjects)) {
      if (!allowed.includes(type) || !Array.isArray(ids) || !ids.length ||
          ids.some(id => typeof id !== 'string' || id.length > 32 || !subjectIdPattern.test(id))) {
        throw new TypeError('Invalid tourism source catalog');
      }
      catalog.set(type, new Set(ids));
    }
    if (!catalog.size) throw new TypeError('Tourism source catalog is empty');
    configured.set(id, {id, evidence, catalog});
  }
  return configured;
}

export function normalizeTime(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new HttpError(400, 'invalid_timestamp');
  return timestamp(value);
}

function decodeEvent(payload) {
  if (typeof payload !== 'string' && !(payload instanceof Uint8Array)) {
    throw new TypeError('Tourism payload must be raw JSON text or bytes');
  }
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
  if (size > TOURISM_BODY_LIMIT) throw new HttpError(413, 'body_too_large');
  let text;
  try {
    text = typeof payload === 'string' ? payload : new TextDecoder('utf-8', {fatal: true}).decode(payload);
  } catch {
    throw new HttpError(400, 'invalid_utf8');
  }
  const event = parseJson(text);
  // JSON.parse collapses repeated names. Check the raw names, including escaped spellings.
  const keys = new Set();
  for (const [, key, colon] of text.matchAll(/("(?:[^"\\]|\\[\s\S])*")(?:[ \t\r\n]*(:))?/g)) {
    if (!colon) continue;
    const name = JSON.parse(key);
    if (keys.has(name)) throw new HttpError(400, 'duplicate_field');
    keys.add(name);
  }
  return event;
}

export function validateEvent(source, payload, now) {
  const value = decodeEvent(payload);
  const {eventId, type, subjectId, flowId, occurredAt, durationSeconds} = value;
  if (!allTypes.has(type)) throw new HttpError(400, 'invalid_tourism_type');
  const playback = type === 'guide_played';
  const expected = playback ? [...fields, 'durationSeconds'] : fields;
  if (Object.keys(value).length !== expected.length || !expected.every(key => Object.hasOwn(value, key))) {
    throw new HttpError(400, 'invalid_tourism_fields');
  }
  if (![eventId, flowId].every(id => typeof id === 'string' && shortId.test(id))) {
    throw new HttpError(400, 'invalid_tourism_id');
  }
  const subjects = source.catalog.get(type);
  if (!subjects) throw new HttpError(403, 'tourism_type_forbidden');
  if (!subjects.has(subjectId)) throw new HttpError(400, 'invalid_tourism_subject');
  if (playback && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1)) {
    throw new HttpError(400, 'invalid_tourism_duration');
  }
  const time = normalizeTime(occurredAt);
  if (Date.parse(time) > now.valueOf() + MAX_FUTURE_SKEW_MS) {
    throw new HttpError(400, 'future_tourism_event');
  }
  return {eventId, type, subjectId, flowId, occurredAt: time, ...(playback ? {durationSeconds} : {})};
}

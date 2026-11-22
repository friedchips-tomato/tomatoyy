import { setTimeout as delay } from 'node:timers/promises';

const bodyLimit = 512;
const routeIds = new Set(['R1', 'R2', 'R3']);
const parkingIds = new Set(['P1', 'P2']);
const subjects = new Map([
  ['route_exposed', routeIds],
  ['route_adopted', routeIds],
  ['route_completed_self_reported', routeIds],
  ['guide_played', new Set(['CD-R01', 'CD-R02', 'CD-V01', 'CD-A01', 'CD-A02', 'CD-A03', 'CD-S01', 'CD-S02', 'CD-S03'])],
  ['booking_demo_submitted', new Set(['G1', 'G2', 'G3'])],
  ['parking_advice_adopted', parkingIds],
  ['parking_navigation_clicked', parkingIds]
]);
const baseFields = ['eventId', 'type', 'subjectId', 'flowId', 'occurredAt'];
const shortId = /^[a-f0-9]{24}$/;
const zonedTime = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function parseEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {eventId, type, subjectId, flowId, occurredAt, durationSeconds} = value;
  const isPlayback = type === 'guide_played';
  const fields = isPlayback ? [...baseFields, 'durationSeconds'] : baseFields;
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) return null;
  if (!subjects.get(type)?.has(subjectId)) return null;
  if (![eventId, flowId].every(id => typeof id === 'string' && shortId.test(id))) return null;
  if (typeof occurredAt !== 'string' || !zonedTime.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) return null;
  const calendarDate = occurredAt.slice(0, 10);
  if (new Date(calendarDate).toISOString().slice(0, 10) !== calendarDate) return null;
  if (isPlayback && (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0)) return null;
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

export function createTourismHandler(upstream, metricsToken) {
  const endpoint = new URL('/api/v1/metrics/tourism/events', upstream);
  let active = 0;

  async function forward(event) {
    const body = JSON.stringify(event);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await delay(150);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${metricsToken}`},
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(1500)
        });
        response.body?.cancel().catch(() => {});
        if (response.ok) return 204;
        if (![408, 429].includes(response.status) && response.status < 500) return 502;
      } catch {
        // A timed-out request may have reached the receiver. Retry the same event ID and body.
      }
    }
    return 503;
  }

  return async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(405, {Allow: 'POST'}).end();
    if (req.headers.origin !== `http://127.0.0.1:${res.socket.localPort}`) return res.writeHead(403).end();
    if (!metricsToken) return res.writeHead(404).end();
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      return res.writeHead(415).end();
    }
    if (Number(req.headers['content-length']) > bodyLimit) return res.writeHead(413).end();
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > bodyLimit) return res.writeHead(413).end();
      chunks.push(chunk);
    }
    let event;
    try {
      const body = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
      event = parseEvent(JSON.parse(body));
    } catch {
      return res.writeHead(400).end();
    }
    if (!event) return res.writeHead(400).end();
    if (active >= 16) return res.writeHead(503).end();
    active++;
    try {
      res.writeHead(await forward(event)).end();
    } finally {
      active--;
    }
  };
}

import { HttpError, readBody, requireMethod } from '../http.js';
import { TOURISM_BODY_LIMIT } from '../tourism/index.js';

const path = '/api/v1/metrics/tourism/events';
const json = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

/** Returns whether this route group handled the request. */
export async function handleTourismRoute(request, response, {authenticateTourismSource, tourism}) {
  if (request.url !== path) return false;
  requireMethod(request, response, 'POST');
  const source = await authenticateTourismSource(request);
  if (!json.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'expected_json');
  const payload = await readBody(request, TOURISM_BODY_LIMIT);
  const {status} = tourism.recordEvent(source.id, payload);
  if (!response.destroyed) {
    response.writeHead(status === 'recorded' ? 201 : 200, {'Cache-Control': 'no-store'}).end();
  }
  return true;
}

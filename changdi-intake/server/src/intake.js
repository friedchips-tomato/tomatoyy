import { createHash } from 'node:crypto';
import { reencodeFeedbackPhoto } from './feedback-png.js';
import { HttpError, onlyFields, parseJson, readBody, readText, timestamp } from './http.js';

const maxPhotoBytes = 5 * 1024 * 1024;
const maxPhotos = 3;
const limits = {
  externalCaseId: 128,
  occurredAt: 40,
  location: 300,
  category: 80,
  description: 4000,
  suggestedDepartment: 100,
  contact: 300,
};
const merchantLimits = {
  clientRequestId: 128,
  occurredAt: limits.occurredAt,
  location: limits.location,
  category: limits.category,
  description: limits.description,
  contact: limits.contact,
};
const publicLimits = {
  clientRequestId: 128,
  occurredAt: limits.occurredAt,
  location: limits.location,
  category: limits.category,
  description: limits.description,
  suggestedDepartment: limits.suggestedDepartment,
  contact: limits.contact,
};
const optional = new Set(['suggestedDepartment', 'contact']);
const signatures = {
  'image/jpeg': bytes => bytes.length >= 7 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
  'image/png': bytes => bytes.length >= 45 && bytes.subarray(0, 8).equals(
    Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')),
  'image/webp': bytes => bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)),
};

export function matchesPhotoSignature(mediaType, bytes) {
  return Object.hasOwn(signatures, mediaType) && signatures[mediaType](bytes);
}

function parsePayload(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32 * 1024) {
    throw new HttpError(400, 'invalid_payload_part');
  }
  return parseJson(raw);
}

function validatePayload(input, fields) {
  onlyFields(input, Object.keys(fields));
  const payload = {};
  for (const [field, limit] of Object.entries(fields)) {
    if (!Object.hasOwn(input, field) && optional.has(field)) continue;
    payload[field] = field === 'occurredAt'
      ? timestamp(input[field])
      : readText(input[field], limit);
  }
  return payload;
}

async function readPhotoForm(request, validate) {
  const contentType = request.headers['content-type'];
  if (!/^multipart\/form-data\s*;/i.test(contentType ?? '')) {
    throw new HttpError(415, 'expected_multipart');
  }
  const body = await readBody(request, maxPhotos * maxPhotoBytes + 64 * 1024);
  let form;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new HttpError(400, 'invalid_multipart');
  }
  if (form.getAll('payload').length !== 1 ||
      [...form.keys()].some(key => key !== 'payload' && key !== 'photos')) {
    throw new HttpError(400, 'invalid_multipart_fields');
  }
  const payload = validate(parsePayload(form.get('payload')));
  const files = form.getAll('photos');
  if (files.length > maxPhotos) throw new HttpError(413, 'too_many_photos');
  const photos = [];
  for (const file of files) {
    if (!(file instanceof File) || !Object.hasOwn(signatures, file.type)) {
      throw new HttpError(415, 'invalid_photo_type');
    }
    if (file.size > maxPhotoBytes) throw new HttpError(413, 'photo_too_large');
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!matchesPhotoSignature(file.type, bytes)) throw new HttpError(415, 'invalid_photo_type');
    photos.push({
      mediaType: file.type,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    });
  }
  return { payload, photos };
}

function submissionHash(payload, photos) {
  const photoKeys = photos.map(photo => photo.mediaType + ':' + photo.sha256).sort();
  return createHash('sha256').update(JSON.stringify([payload, photoKeys])).digest('hex');
}

export async function readIntake(request, merchant = false) {
  const { payload, photos } = await readPhotoForm(request, input => validatePayload(input, merchant ? merchantLimits : limits));
  return { payload, photos, hash: submissionHash(payload, photos) };
}

export async function readPublicIntake(request) {
  const { payload, photos } = await readPhotoForm(request, input => validatePayload(input, publicLimits));
  return { payload, photos, hash: submissionHash(payload, photos) };
}

export async function readCollaborationSubmissionWithPhotos(request) {
  const result = await readPhotoForm(request, input => {
    onlyFields(input, ['expectedVersion', 'summary']);
    return input;
  });
  if (!result.photos.length) throw new HttpError(400, 'photos_required');
  return result;
}

export async function readOwnerSupplementWithPhotos(request) {
  const result = await readPhotoForm(request, input => {
    onlyFields(input, ['action', 'expectedVersion', 'summary']);
    if (input.action !== 'submit_supplement') throw new HttpError(400, 'invalid_action');
    return input;
  });
  if (!result.photos.length) throw new HttpError(400, 'photos_required');
  return result;
}

export async function readStaffActionWithPhotos(request, role) {
  const result = await readPhotoForm(request, input => {
    if (input.action === 'publish') {
      if (role !== 'supervisor') throw new HttpError(403, 'forbidden');
      onlyFields(input, ['action', 'expectedVersion', 'summary', 'derivativesReviewed']);
      if (input.derivativesReviewed !== true) throw new HttpError(400, 'feedback_review_required');
      const { action, expectedVersion, summary } = input;
      return { action, expectedVersion, summary };
    }
    onlyFields(input, ['action', 'expectedVersion', 'summary']);
    if (input.action !== 'submit_result') throw new HttpError(400, 'invalid_action');
    if (role !== 'handler') throw new HttpError(403, 'forbidden');
    return input;
  });
  if (!result.photos.length) throw new HttpError(400, 'photos_required');
  return result.payload.action === 'publish'
    ? { payload: result.payload, photos: result.photos.map(reencodeFeedbackPhoto) }
    : result;
}

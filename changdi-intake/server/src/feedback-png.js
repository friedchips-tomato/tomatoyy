import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { HttpError } from './http.js';

const maxDimension = 2048;
const maxFileBytes = 5 * 1024 * 1024;
const maxChunks = 2048;
const discarded = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'pHYs', 'sRGB', 'gAMA', 'cHRM', 'iCCP']);
const invalidPng = () => new HttpError(415, 'invalid_feedback_png');

function pngChunk(kind, value) {
  const chunk = Buffer.alloc(value.length + 12);
  chunk.writeUInt32BE(value.length, 0);
  chunk.write(kind, 4, 'ascii');
  value.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export function reencodeFeedbackPhoto(photo) {
  if (photo.mediaType !== 'image/png') throw invalidPng();
  const { bytes, sha256: originalSha256 } = photo;
  let header;
  let stride;
  let height;
  let offset = 8;
  let finished = false;
  let idatEnded = false;
  const compressed = [];
  for (let count = 0; offset <= bytes.length - 12 && count < maxChunks; count++) {
    const length = bytes.readUInt32BE(offset);
    const dataEnd = offset + 8 + length;
    const next = dataEnd + 4;
    if (next > bytes.length) throw invalidPng();
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    const value = bytes.subarray(offset + 8, dataEnd);
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))) throw invalidPng();

    if (!header) {
      if (kind !== 'IHDR' || length !== 13 || !value.subarray(8).equals(Buffer.from([8, 2, 0, 0, 0]))) {
        throw invalidPng();
      }
      const width = value.readUInt32BE(0);
      height = value.readUInt32BE(4);
      if (!width || !height || width > maxDimension || height > maxDimension) throw invalidPng();
      stride = width * 3 + 1;
      header = value;
    } else if (kind === 'IDAT') {
      if (idatEnded) throw invalidPng();
      compressed.push(value);
    } else if (kind === 'IEND') {
      if (length !== 0 || next !== bytes.length || !compressed.length) throw invalidPng();
      finished = true;
      break;
    } else {
      if (!discarded.has(kind)) throw invalidPng();
      if (compressed.length) idatEnded = true;
    }
    offset = next;
  }
  if (!finished) throw invalidPng();

  const expected = stride * height;
  let scanlines;
  try {
    scanlines = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch {
    throw invalidPng();
  }
  if (scanlines.length !== expected) throw invalidPng();
  for (let index = 0; index < expected; index += stride) {
    if (scanlines[index] > 4) throw invalidPng();
  }
  const encoded = Buffer.concat([bytes.subarray(0, 8), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
  if (encoded.length > maxFileBytes) throw new HttpError(413, 'photo_too_large');
  return { bytes: encoded, originalSha256, sha256: createHash('sha256').update(encoded).digest('hex') };
}

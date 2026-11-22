const maxPhotoBytes = 5 * 1024 * 1024;
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
let previewSequence = 0;
const pendingDeletes = new Set();
const deleting = new Set();
const activePreviews = new Set();

function bytesOf(value) {
  if (!(value instanceof ArrayBuffer)) throw new Error('invalid_photo_buffer');
  return new Uint8Array(value);
}

function matches(bytes, offset, signature) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function mediaType(bytes) {
  if (bytes.length >= 45 && matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
      matches(bytes, 12, [73, 72, 68, 82]) &&
      matches(bytes, bytes.length - 12, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])) return 'image/png';
  if (bytes.length >= 7 && matches(bytes, 0, [255, 216, 255]) &&
      matches(bytes, bytes.length - 2, [255, 217])) return 'image/jpeg';
  if (bytes.length >= 20 && matches(bytes, 0, [82, 73, 70, 70]) && matches(bytes, 8, [87, 69, 66, 80])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = view.getUint32(12);
    if (view.getUint32(4, true) === bytes.length - 8 &&
        [0x56503820, 0x5650384c, 0x56503858].includes(tag)) return 'image/webp';
  }
  return '';
}

function checkFeedbackPng(bytes, type) {
  if (type !== 'image/png') throw new Error('invalid_feedback_png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (view.getUint32(8) !== 13 || !width || !height || width > 2048 || height > 2048 ||
      !matches(bytes, 24, [8, 2, 0, 0, 0])) throw new Error('invalid_feedback_png');
}

function choosePhotos(feedback) {
  return new Promise((resolve, reject) => {
    const callbacks = {
      count: 3,
      success: result => {
        const files = result.tempFiles;
        if (!Array.isArray(files) || files.length < 1 || files.length > 3 ||
            files.some(file => !file || typeof (feedback ? file.path : file.tempFilePath) !== 'string' ||
              !Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxPhotoBytes)) {
          reject(new Error('invalid_photo_selection'));
          return;
        }
        resolve(files.map(file => ({ path: feedback ? file.path : file.tempFilePath, length: file.size })));
      },
      fail: error => {
        if (/cancel/i.test(error && error.errMsg || '')) resolve(null);
        else reject(new Error('photo_selection_failed'));
      }
    };
    if (feedback) wx.chooseMessageFile({ ...callbacks, type: 'file', extension: ['png'] });
    else wx.chooseMedia({ ...callbacks, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['original'] });
  });
}

function readFile(path) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path, position: 0, length: maxPhotoBytes + 1,
      success: result => resolve(result.data),
      fail: () => reject(new Error('photo_read_failed'))
    });
  });
}

function utf8(text) {
  const encoded = encodeURIComponent(text);
  const result = new Uint8Array(encoded.length);
  let written = 0;
  for (let cursor = 0; cursor < encoded.length; cursor++) {
    if (encoded[cursor] === '%') {
      result[written++] = Number.parseInt(encoded.slice(cursor + 1, cursor + 3), 16);
      cursor += 2;
    } else result[written++] = encoded.charCodeAt(cursor);
  }
  return result.subarray(0, written);
}

async function multipartPhotos(payload, files, feedback, isCurrent) {
  if (!files.length || files.length > 3) throw new Error('invalid_photo_selection');
  const boundary = 'Changdi-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const chunks = [utf8('--' + boundary + '\r\nContent-Disposition: form-data; name="payload"\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n\r\n' + JSON.stringify(payload) + '\r\n')];
  for (const [index, file] of files.entries()) {
    const value = await readFile(file.path);
    if (!isCurrent()) return null;
    const bytes = bytesOf(value);
    if (bytes.length > maxPhotoBytes || bytes.length !== file.length) throw new Error('invalid_photo_selection');
    const type = mediaType(bytes);
    if (feedback) checkFeedbackPng(bytes, type);
    if (!type) throw new Error('invalid_photo_type');
    chunks.push(utf8('--' + boundary + '\r\nContent-Disposition: form-data; name="photos"; filename="photo-' +
      (index + 1) + '.' + extensions[type] + '"\r\nContent-Type: ' + type + '\r\n\r\n'), bytes, utf8('\r\n'));
  }
  chunks.push(utf8('--' + boundary + '--\r\n'));
  const combined = new Uint8Array(chunks.reduce((total, item) => total + item.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return { data: combined.buffer, contentType: 'multipart/form-data; boundary=' + boundary };
}

// 组装只有 payload 文本 part 的 multipart 请求体。
// 与 multipartPhotos 的报文格式一致，用于不附照片的提交：只发一个 payload part。
function multipartPayload(payload) {
  const boundary = 'Changdi-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  // utf8 返回的是视图，这里复制成独立字节，保证请求体长度与内容一致。
  const bytes = utf8('--' + boundary + '\r\nContent-Disposition: form-data; name="payload"\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n\r\n' + JSON.stringify(payload) + '\r\n' +
    '--' + boundary + '--\r\n');
  const body = bytes.slice();
  return { data: body.buffer, contentType: 'multipart/form-data; boundary=' + boundary };
}

function photoMessage(error) {
  switch (error.message) {
    case 'invalid_photo_selection': return '请选择 1–3 张图片，每张不超过 5 MiB。文件变化后请重新选择。';
    case 'invalid_photo_type': return '仅支持 JPEG、PNG 或 WebP 图片。';
    case 'invalid_feedback_png': return '请选择独立导出的 8 位 RGB 非隔行 PNG，每个维度最多 2048 像素。';
    default: return '无法读取所选图片，请重新选择后再试。';
  }
}

function photoEntries(value, version) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && Number.isSafeInteger(item.submitVersion) && item.submitVersion > 0 &&
    item.submitVersion <= version &&
    Number.isInteger(item.position) && item.position >= 0 && item.position <= 2 &&
    Object.prototype.hasOwnProperty.call(extensions, item.mediaType) && Number.isSafeInteger(item.size) &&
    item.size >= 1 && item.size <= maxPhotoBytes).map(item => ({
    key: item.submitVersion + '/' + item.position, round: item.round, submitVersion: item.submitVersion,
    position: item.position, mediaType: item.mediaType, size: item.size, typeLabel: extensions[item.mediaType].toUpperCase()
  }));
}

function submissionPhotos(staff, detail, value) {
  if (!staff || !['handler', 'supervisor'].includes(staff.role)) return [];
  return photoEntries(value, detail.version)
    .filter(item => Number.isSafeInteger(item.round) && item.round > 0 && item.round <= detail.round);
}

function supplementPhotos(detail, value = detail.supplementPhotos) {
  if (!Number.isSafeInteger(detail.version) || !Number.isSafeInteger(detail.round)) return [];
  const seen = new Set();
  return photoEntries(value, detail.version).filter(item => {
    if (!Number.isSafeInteger(item.round) || item.round < 1 || item.round > detail.round || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function attemptDelete(path, retry = true) {
  if (!pendingDeletes.has(path) || deleting.has(path)) return;
  try {
    const fs = wx.getFileSystemManager();
    try {
      fs.unlinkSync(path);
      pendingDeletes.delete(path);
    } catch (error) {
      if (/ENOENT|no such file|not exist/i.test(String(error && (error.errMsg || error.message) || ''))) {
        pendingDeletes.delete(path);
      } else {
        deleting.add(path);
        fs.unlink({
          filePath: path, success: () => pendingDeletes.delete(path),
          fail: result => {
            if (/ENOENT|no such file|not exist/i.test(String(result && result.errMsg || ''))) pendingDeletes.delete(path);
          },
          complete: () => {
            deleting.delete(path);
            if (retry && pendingDeletes.has(path)) setTimeout(() => attemptDelete(path, false), 250);
          }
        });
      }
    }
  } catch {
    deleting.delete(path);
    // Retry tracked failures on the next staff lifecycle cleanup.
  }
}

function retryPreviewCleanup() {
  for (const path of pendingDeletes) attemptDelete(path);
}

function cleanupOwnerPreviewOrphans() {
  const root = typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH;
  if (!root) return;
  try {
    for (const name of wx.getFileSystemManager().readdirSync(root)) {
      if (!/^owner-(?:feedback-preview-[a-z0-9]+-[a-z0-9]+\.png|supplement-preview-[a-z0-9]+-[a-z0-9]+\.(?:jpg|png|webp))(?![\s\S])/.test(name)) continue;
      const path = root + '/' + name;
      if (!activePreviews.has(path)) pendingDeletes.add(path);
    }
  } catch {
    // The next page entry can retry the private directory scan.
  }
  retryPreviewCleanup();
}

function createPreviewFiles(kind = 'staff') {
  const paths = new Set();
  return {
    clear() {
      for (const path of paths) {
        activePreviews.delete(path);
        pendingDeletes.add(path);
      }
      paths.clear();
      retryPreviewCleanup();
    },
    write(buffer, photo, headers) {
      const bytes = bytesOf(buffer);
      const mimeKey = Object.keys(headers || {}).find(key => key.toLowerCase() === 'content-type');
      if (!mimeKey || typeof headers[mimeKey] !== 'string' || headers[mimeKey].toLowerCase() !== photo.mediaType ||
          bytes.length !== photo.size || mediaType(bytes) !== photo.mediaType || !wx.env || !wx.env.USER_DATA_PATH) {
        throw new Error('invalid_preview_response');
      }
      if (kind === 'owner-feedback') checkFeedbackPng(bytes, photo.mediaType);
      const path = wx.env.USER_DATA_PATH + '/' + kind + '-preview-' + Date.now().toString(36) + '-' +
        (++previewSequence).toString(36) + '.' + extensions[photo.mediaType];
      paths.add(path);
      activePreviews.add(path);
      try {
        wx.getFileSystemManager().writeFileSync(path, buffer);
        return path;
      } catch (error) {
        this.clear();
        throw error;
      }
    }
  };
}

module.exports = {
  choosePhotos, multipartPhotos, multipartPayload, photoMessage, submissionPhotos, createPreviewFiles, retryPreviewCleanup,
  cleanupOwnerPreviewOrphans, photoEntries, supplementPhotos
};

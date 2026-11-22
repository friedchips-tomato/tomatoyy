// 商户新诉求的可选照片：本地选图、读取校验与 multipart 编码。
// 只处理本机选中的临时文件，不访问任何网址、真实图片或真实凭据。
// 数量、类型与大小上限按服务端接单口径：最多 3 张、每张 5 MiB、仅 JPEG/PNG/WebP，
// 文件签名必须与声明的类型一致。

const maxPhotoBytes = 5 * 1024 * 1024;
const maxPhotos = 3;
// 整包上限与服务端一致：15 MiB + 64 KiB（含 multipart 头尾开销）。
const maxBodyBytes = maxPhotos * maxPhotoBytes + 64 * 1024;

const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function bytesOf(value) {
  if (!(value instanceof ArrayBuffer)) throw new Error('invalid_photo_buffer');
  return new Uint8Array(value);
}

function matches(bytes, offset, signature) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

// 按文件签名判断图片类型。与服务端接单的签名校验口径一致。
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

// 选图。仅接受本机临时文件，数量与大小在此处先挡一层。
function choosePhotos() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: maxPhotos,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: result => {
        const files = result && result.tempFiles;
        if (!Array.isArray(files) || files.length < 1 || files.length > maxPhotos ||
            files.some(file => !file || typeof file.tempFilePath !== 'string' || !file.tempFilePath ||
              !Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxPhotoBytes)) {
          reject(new Error('invalid_photo_selection'));
          return;
        }
        resolve(files.map(file => ({ path: file.tempFilePath, length: file.size })));
      },
      fail: error => {
        if (/cancel/i.test((error && error.errMsg) || '')) resolve(null);
        else reject(new Error('photo_selection_failed'));
      }
    });
  });
}

function readFile(path) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      position: 0,
      // 多读一个字节，用来发现超出上限的文件。
      length: maxPhotoBytes + 1,
      success: result => resolve(result.data),
      fail: () => reject(new Error('photo_read_failed'))
    });
  });
}

// 读取并校验所选照片。任一张不合法即整体失败，此时请求尚未发出，可以就地修正。
async function readPhotos(files) {
  const photos = [];
  for (const file of files) {
    const bytes = bytesOf(await readFile(file.path));
    if (bytes.length < 1 || bytes.length > maxPhotoBytes || bytes.length !== file.length) {
      throw new Error('invalid_photo_selection');
    }
    const type = mediaType(bytes);
    if (!type) throw new Error('invalid_photo_type');
    photos.push({ mediaType: type, bytes });
  }
  return photos;
}

// 照片内容的指纹，只用于判断“是不是同一组照片”，不做安全用途。
function bytesFingerprint(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return bytes.length.toString(36) + '-' + hash.toString(36);
}

function photoFingerprint(photos) {
  if (!Array.isArray(photos) || !photos.length) return '';
  return photos.map(photo => photo.mediaType + ':' + bytesFingerprint(photo.bytes)).join('|');
}

// 文本转 UTF-8 字节。
function utf8(text) {
  const encoded = encodeURIComponent(text);
  const result = new Uint8Array(encoded.length);
  let written = 0;
  for (let cursor = 0; cursor < encoded.length; cursor += 1) {
    if (encoded[cursor] === '%') {
      result[written++] = Number.parseInt(encoded.slice(cursor + 1, cursor + 3), 16);
      cursor += 2;
    } else {
      result[written++] = encoded.charCodeAt(cursor);
    }
  }
  return result.subarray(0, written);
}

// 组装 multipart 请求体：一个 payload 文本 part，加上若干 photos 文件 part。
function multipartBody(boundary, payload, photos) {
  const chunks = [utf8('--' + boundary + '\r\nContent-Disposition: form-data; name="payload"\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n\r\n' + JSON.stringify(payload) + '\r\n')];
  (photos || []).forEach((photo, index) => {
    chunks.push(utf8('--' + boundary + '\r\nContent-Disposition: form-data; name="photos"; filename="photo-' +
      (index + 1) + '.' + extensions[photo.mediaType] + '"\r\nContent-Type: ' + photo.mediaType + '\r\n\r\n'));
    chunks.push(photo.bytes);
    chunks.push(utf8('\r\n'));
  });
  chunks.push(utf8('--' + boundary + '--\r\n'));
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  if (total > maxBodyBytes) throw new Error('package_too_large');
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body.buffer;
}

// 协办送审原图的预览文件登记处。预览文件写在商户自己的目录下，逐个登记、逐个清理，
// 页面关闭、隐藏、失权或切换任务时都不会留下旧图。
let previewSequence = 0;

// 校验服务端返回的原图：类型、字节数与文件签名都要与任务详情里的元数据一致。
function checkPreviewBytes(bytes, photo, headers) {
  const data = bytesOf(bytes);
  const mimeKey = Object.keys(headers || {}).find(key => key.toLowerCase() === 'content-type');
  const mime = mimeKey ? String(headers[mimeKey]).toLowerCase() : '';
  if (!mime || mime !== photo.mediaType || !Object.hasOwn(extensions, mime)) {
    throw new Error('invalid_preview_type');
  }
  if (data.length !== photo.size) throw new Error('invalid_preview_size');
  if (mediaType(data) !== photo.mediaType) throw new Error('invalid_preview_signature');
  return data;
}

// 预览文件管理：写入后登记，清理时逐个删除。
function createPreviewFiles() {
  const paths = new Set();
  const remove = path => {
    paths.delete(path);
    try {
      wx.getFileSystemManager().unlinkSync(path);
    } catch {
      // 文件可能已被系统清理，忽略。
    }
  };
  return {
    clear() {
      for (const path of [...paths]) remove(path);
    },
    // 写入并返回可预览的本地路径。
    write(bytes, photo, headers) {
      const data = checkPreviewBytes(bytes, photo, headers);
      if (!wx.env || !wx.env.USER_DATA_PATH) throw new Error('invalid_preview_response');
      const path = wx.env.USER_DATA_PATH + '/merchant-collaboration-preview-' +
        Date.now().toString(36) + '-' + (++previewSequence).toString(36) + '.' + extensions[photo.mediaType];
      wx.getFileSystemManager().writeFileSync(path, data);
      paths.add(path);
      return path;
    },
    remove
  };
}

// 用户可见的失败说明。
function photoMessage(error) {
  switch (error && error.message) {
    case 'invalid_photo_selection': return '请选择 1–3 张图片，每张不超过 5 MiB；文件变动后请重新选择。';
    case 'invalid_photo_type': return '仅支持 JPEG、PNG 或 WebP 图片。';
    case 'photo_read_failed': return '无法读取所选图片，请重新选择后再试。';
    case 'photo_selection_failed': return '选择图片失败，请重试。';
    case 'package_too_large': return '照片总大小超出上限，请减少张数或压缩后再试。';
    case 'invalid_preview_type': return '原图类型与任务记录不一致，已拒绝显示。';
    case 'invalid_preview_size': return '原图大小与任务记录不一致，已拒绝显示。';
    case 'invalid_preview_signature': return '原图内容与记录的类型不符，已拒绝显示。';
    case 'invalid_preview_response': return '原图读取失败，请重试。';
    default: return '照片处理失败，请重新选择后再试。';
  }
}

module.exports = {
  maxPhotoBytes,
  maxPhotos,
  maxBodyBytes,
  extensions,
  mediaType,
  choosePhotos,
  readPhotos,
  photoFingerprint,
  multipartBody,
  createPreviewFiles,
  checkPreviewBytes,
  photoMessage
};

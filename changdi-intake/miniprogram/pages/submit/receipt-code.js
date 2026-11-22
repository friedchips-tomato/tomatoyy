// 回执里的微信小程序查询码：校验、落盘与释放。
// 这里只处理服务端在回执中下发的查询码（envVersion、mediaType、base64），
// 本机不生成任何图片，也不调用外部制码服务。查询码图片只含公开查询码，
// 私密查询凭证不进入图片、文件名、链接、存储与日志。

// 与 OpenAPI 一致：解码后最多 1 MiB，Base64 串最多 1398104 个字符。
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_BASE64_LENGTH = 1398104;
// 标准 Base64：只允许字母数字与加号斜杠，末尾可带最多两个等号补位。
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
// 服务端只用这三个版本环境值。
const ENV_VERSIONS = ['release', 'trial', 'develop'];
const MEDIA_TYPES = ['image/png', 'image/jpeg'];
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg' };
// 本机查询码图片的固定前缀，便于识别并清理本模块留下的文件。
const FILE_PREFIX = 'receipt-code-';
const FILE_PATTERN = /^receipt-code-[A-Za-z0-9_-]{1,64}\.(?:png|jpg)$/;
// PNG 文件头与 IEND 结尾，与服务端识别图片的口径一致。
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_TAIL = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function matchesPng(bytes) {
  if (bytes.length < 45) return false;
  if (!PNG_HEADER.every((byte, index) => bytes[index] === byte)) return false;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return false;
  return PNG_TAIL.every((byte, index) => bytes[bytes.length - 12 + index] === byte);
}

function matchesJpeg(bytes) {
  if (bytes.length < 7) return false;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
  return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

// 解 Base64。优先用小程序的 wx.base64ToArrayBuffer，Node 下退回 Buffer。
function decodeBase64(text) {
  if (typeof text !== 'string' || !text) return null;
  if (text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) return null;
  const api = typeof wx === 'undefined' ? null : wx;
  if (api && typeof api.base64ToArrayBuffer === 'function') {
    try {
      const buffer = api.base64ToArrayBuffer(text);
      if (!(buffer instanceof ArrayBuffer)) return null;
      return new Uint8Array(buffer);
    } catch (error) {
      return null;
    }
  }
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(text, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return null;
}

// 校验回执里的查询码。任一项不合规都返回 null，调用方据此降级为「只显示公开码」。
function normalizeWechatCode(value) {
  if (!value || typeof value !== 'object') return null;
  const envVersion = typeof value.envVersion === 'string' ? value.envVersion : '';
  const mediaType = typeof value.mediaType === 'string' ? value.mediaType : '';
  const base64 = typeof value.base64 === 'string' ? value.base64 : '';
  if (!ENV_VERSIONS.includes(envVersion)) return null;
  if (!MEDIA_TYPES.includes(mediaType)) return null;
  if (base64.length < 4 || base64.length > MAX_BASE64_LENGTH) return null;
  const bytes = decodeBase64(base64);
  if (!bytes || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  const matched = mediaType === 'image/png' ? matchesPng(bytes) : matchesJpeg(bytes);
  if (!matched) return null;
  return { envVersion, mediaType, bytes };
}

// 本机存储目录。取不到时返回空串，调用方据此放弃落盘。
function userDataPath() {
  const api = typeof wx === 'undefined' ? null : wx;
  return api && api.env && typeof api.env.USER_DATA_PATH === 'string' ? api.env.USER_DATA_PATH : '';
}

// 查询码图片的文件名。只用公开查询码，不含工单号与私密凭证。
function receiptCodeFileName(publicLookupCode, mediaType) {
  const code = typeof publicLookupCode === 'string' ? publicLookupCode : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return '';
  return FILE_PREFIX + code + '.' + (EXTENSIONS[mediaType] || 'png');
}

// 把查询码图片写进本机目录，返回可展示的临时文件路径。
// 写失败抛出 receipt_code_unavailable，由调用方降级展示。
function writeReceiptCodeFile({ publicLookupCode, mediaType, bytes }) {
  const root = userDataPath();
  const name = receiptCodeFileName(publicLookupCode, mediaType);
  if (!root || !name || !bytes || !bytes.length) throw new Error('receipt_code_unavailable');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    wx.getFileSystemManager().writeFileSync(root + '/' + name, buffer);
  } catch (error) {
    throw new Error('receipt_code_unavailable');
  }
  return root + '/' + name;
}

// 释放一张查询码图片。文件不存在或删除失败都不外抛。
function removeReceiptCodeFile(path) {
  if (typeof path !== 'string' || !path) return false;
  try {
    wx.getFileSystemManager().unlinkSync(path);
    return true;
  } catch (error) {
    return false;
  }
}

// 清理上一次会话遗留的查询码图片。只动本模块命名规则下的文件。
function cleanupReceiptCodeFiles() {
  const root = userDataPath();
  if (!root) return;
  try {
    const fs = wx.getFileSystemManager();
    for (const name of fs.readdirSync(root)) {
      if (!FILE_PATTERN.test(name)) continue;
      removeReceiptCodeFile(root + '/' + name);
    }
  } catch (error) {
    // 目录不可读时留到下次进入页面再清理。
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_BASE64_LENGTH,
  BASE64_PATTERN,
  ENV_VERSIONS,
  MEDIA_TYPES,
  FILE_PATTERN,
  matchesPng,
  matchesJpeg,
  decodeBase64,
  normalizeWechatCode,
  userDataPath,
  receiptCodeFileName,
  writeReceiptCodeFile,
  removeReceiptCodeFile,
  cleanupReceiptCodeFiles
};

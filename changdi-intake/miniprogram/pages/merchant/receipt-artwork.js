const {
  normalizeWechatCode, writeReceiptCodeFile, removeReceiptCodeFile, receiptCodeFileName, userDataPath
} = require('../submit/receipt-code');

const ownedFile = /^receipt-code-merchant-(?:submitReceipt|caseReceipt)-[A-Za-z0-9_-]{24}\.(?:png|jpg)$/;

function createReceiptArtwork() {
  const files = new Map();
  const pending = new Set();
  let revision = 0;

  function remove(path) {
    if (!path) return;
    if (removeReceiptCodeFile(path)) pending.delete(path);
    else pending.add(path);
  }

  function clear(slot) {
    remove(files.get(slot));
    files.delete(slot);
  }

  function clearAll() {
    for (const slot of files.keys()) clear(slot);
    for (const path of pending) remove(path);
  }

  function cleanupPrevious() {
    const root = userDataPath();
    if (!root) return;
    try {
      for (const name of wx.getFileSystemManager().readdirSync(root)) {
        if (ownedFile.test(name)) remove(root + '/' + name);
      }
    } catch {
      // The current session still releases the files it creates.
    }
  }

  function present(slot, receipt, rawCode) {
    clear(slot);
    const image = receipt?.publicLookupCode && normalizeWechatCode(rawCode);
    if (!image) return receipt;
    const fileKey = 'merchant-' + slot + '-' + receipt.publicLookupCode;
    try {
      const path = writeReceiptCodeFile({ ...image, publicLookupCode: fileKey });
      pending.delete(path);
      files.set(slot, path);
      return { ...receipt, qrSource: path, qrRevision: ++revision };
    } catch {
      const root = userDataPath();
      if (root) remove(root + '/' + receiptCodeFileName(fileKey, image.mediaType));
      return receipt;
    }
  }

  return { present, clear, clearAll, cleanupPrevious };
}

module.exports = { createReceiptArtwork };

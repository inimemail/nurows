import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { createNotesStore } from "./notes-store.js";
import { migrateNotesDatabase, openEncryptedNotes, migrateAttachments, decodeAttachment } from './notes-storage.js';
const key = Buffer.from(workerData.key);
workerData.key.fill(0);
const attachmentDir = path.join(
  path.dirname(workerData.filename),
  "note-attachments",
);
await migrateNotesDatabase(workerData.filename, key);
const db = openEncryptedNotes(workerData.filename, key);
const store = createNotesStore(db, {attachmentDir});
const attachmentSize = db.prepare('SELECT size FROM attachments WHERE id=?');
await migrateAttachments(attachmentDir, key, id => attachmentSize.get(id)?.size);
const addAttachment = store.attachmentAdd;
const cleanup = store.cleanup;
store.cleanup = () => {
  const result = cleanup();
  const root = path.dirname(workerData.filename);
  // A snapshot may still refer to an attachment recently purged from live metadata.
  if (
    fs.readdirSync(root).some((name) => name.startsWith(".backup-")) ||
    !fs.existsSync(attachmentDir)
  )
    return result;
  for (const name of fs.readdirSync(attachmentDir)) {
    if (!/^[a-f0-9-]{36}$/.test(name) || store.hasAttachment({ id: name }))
      continue;
    const file = path.join(attachmentDir, name),
      stat = fs.lstatSync(file);
    if (stat.isFile() && Date.now() - stat.mtimeMs > 30 * 86400000)
      fs.unlinkSync(file);
  }
  return result;
};
store.attachmentAdd = (args) => {
  if (args.mime.startsWith("image/")) {
    const decoded = decodeAttachment(fs.readFileSync(path.join(attachmentDir, args.id)), key);
    let dimensions;
    try { dimensions = imageSize(decoded); } finally { decoded.fill(0); }
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > 40000000 ||
      dimensions.width > 16000 ||
      dimensions.height > 16000
    )
      throw new Error("图片尺寸过大，请压缩后上传");
  }
  return addAttachment(args);
};
store.readAttachment = (args) => {
  const item = store.attachment(args), filename = path.join(attachmentDir, item.id);
  if (fs.statSync(filename).size > 10 * 1024 * 1024 + 36) throw Error('附件大小异常');
  return { item, data: decodeAttachment(fs.readFileSync(filename), key) };
};
parentPort.postMessage({ ready: true });
parentPort.on("message", ({ requestId, method, args }) => {
  try {
    if (!Object.hasOwn(store, method)) throw new Error("未知笔记操作");
    const result = store[method](args || {});
    if (method === 'readAttachment') {
      // Transfer a dedicated buffer, never Node's shared Buffer pool.
      const data = Uint8Array.from(result.data); result.data.fill(0);
      parentPort.postMessage({ requestId, result: { ...result, data } }, [data.buffer]);
    } else parentPort.postMessage({ requestId, result });
  } catch (error) {
    parentPort.postMessage({
      requestId,
      error: { message: error.message, statusCode: error.statusCode || 400 },
    });
  }
});

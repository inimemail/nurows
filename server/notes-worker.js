import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { createNotesStore } from "./notes-store.js";
const attachmentDir = path.join(
  path.dirname(workerData.filename),
  "note-attachments",
);
const store = createNotesStore(new Database(workerData.filename), {attachmentDir});
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
    const dimensions = imageSize(
      fs.readFileSync(path.join(attachmentDir, args.id)),
    );
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
parentPort.on("message", ({ requestId, method, args }) => {
  try {
    if (!Object.hasOwn(store, method)) throw new Error("未知笔记操作");
    parentPort.postMessage({ requestId, result: store[method](args || {}) });
  } catch (error) {
    parentPort.postMessage({
      requestId,
      error: { message: error.message, statusCode: error.statusCode || 400 },
    });
  }
});

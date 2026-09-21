import { Worker } from "node:worker_threads";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
const noteError = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

export function createNotesService({ dataDir }) {
  let worker = null;
  const pending = new Map();
  let nextId = 0,
    failed = false;
  const fail = (error) => {
    failed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  function start() {
    worker = new Worker(new URL("./notes-worker.js", import.meta.url), {
      workerData: { filename: path.join(dataDir, "notes.db") },
    });
    worker.on("error", fail);
    worker.on("exit", () =>
      fail(noteError("笔记服务暂不可用，请重启服务", 503)),
    );
    worker.on("message", (message) => {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      clearTimeout(item.timer);
      message.error
        ? item.reject(
            Object.assign(new Error(message.error.message), {
              statusCode: message.error.statusCode,
            }),
          )
        : item.resolve(message.result);
    });
  }
  return {
    call(method, args = {}) {
      if (failed) return Promise.reject(noteError("笔记服务暂不可用", 503));
      if (
        method === "cleanup" &&
        !worker &&
        !fs.existsSync(path.join(dataDir, "notes.db"))
      )
        return Promise.resolve({ ok: true });
      if (!worker) start();
      if (pending.size >= 64)
        return Promise.reject(noteError("笔记操作繁忙，请稍后重试", 429));
      return new Promise((resolve, reject) => {
        const requestId = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(noteError("笔记操作超时，请重新读取确认保存状态", 503));
        }, 30000);
        pending.set(requestId, { resolve, reject, timer });
        worker.postMessage({ requestId, method, args });
      });
    },
    close: () => worker?.terminate(),
  };
}
export function registerNotesRoutes(app, service, { dataDir }) {
  app.use("/api/notes", (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  const route = (
    verb,
    url,
    method,
    args = (req) => ({ ...req.body, ...req.params }),
  ) =>
    app[verb](url, async (req, res) =>
      res.json(await service.call(method, args(req))),
    );
  route("get", "/api/notes", "books");
  route("post", "/api/notes/notebooks", "bookSave");
  route("put", "/api/notes/notebooks/:id", "bookSave");
  route("delete", "/api/notes/notebooks/:id", "bookDelete");
  route("get", "/api/notes/documents", "list", (req) => req.query);
  route("post", "/api/notes/documents", "create");
  route("get", "/api/notes/documents/:id", "get");
  route("put", "/api/notes/documents/:id", "save");
  route("post", "/api/notes/documents/:id/move", "move");
  route("delete", "/api/notes/documents/:id", "trash");
  route("post", "/api/notes/documents/:id/restore", "restore");
  route("post", "/api/notes/documents/:id/purge", "purge");
  route("get", "/api/notes/documents/:id/versions", "versions");
  route("get", "/api/notes/documents/:id/versions/:version", "version");
  route("post", "/api/notes/documents/:id/versions/:version", "revert");
  route("get", "/api/notes/documents/:id/attachments", "attachments");
  const directory = path.join(dataDir, "note-attachments");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let uploads = 0;
  app.post("/api/notes/documents/:id/attachments", async (req, res) => {
    if (uploads >= 2) throw noteError("附件正在上传，请稍后重试", 429);
    uploads++;
    const id = crypto.randomUUID(),
      file = path.join(directory, id);
    let complete = false;
    try {
      await service.call("get", { id: req.params.id });
      let name = "",
        size = 0,
        head = Buffer.alloc(0),
        count = 0,
        limited = false,
        write;
      const parser = Busboy({
        headers: req.headers,
        limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
      });
      parser.on("filesLimit", () => {
        limited = true;
      });
      parser.on("partsLimit", () => {
        limited = true;
      });
      parser.on("fieldsLimit", () => {
        limited = true;
      });
      parser.on("file", (_field, stream, info) => {
        count++;
        name = info.filename;
        stream.on("limit", () => {
          limited = true;
        });
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (head.length < 16)
            head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        });
        write = pipeline(
          stream,
          fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
        );
        write.catch(() => {});
      });
      try {
        await pipeline(req, parser);
      } finally {
        if (write) await write;
      }
      if (count !== 1 || !size || limited)
        throw noteError("请选择一个不超过 10 MB 的附件");
      const mime = head
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : head[0] === 255 && head[1] === 216 && head[2] === 255
          ? "image/jpeg"
          : head.toString("ascii", 0, 4) === "RIFF" &&
              head.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp"
            : "application/octet-stream";
      const item = await service.call("attachmentAdd", {
        id,
        documentId: req.params.id,
        name,
        mime,
        size,
      });
      complete = true;
      res.status(201).json(item);
    } finally {
      uploads--;
      if (!complete) await fs.promises.unlink(file).catch(() => {});
    }
  });
  app.get("/api/notes/attachments/:id", async (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id))
      throw noteError("附件不存在", 404);
    const item = await service.call("attachment", { id: req.params.id });
    res.set({
      "Content-Type": item.mime,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${item.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name).replace(/'/g, "%27")}`,
    });
    res.sendFile(path.join(directory, item.id));
  });
  const timer = setInterval(
    () => service.call("cleanup").catch(() => {}),
    6 * 3600000,
  );
  timer.unref();
  return () => clearInterval(timer);
}

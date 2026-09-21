import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { createNotesService, registerNotesRoutes } from "../server/notes.js";

test("notes worker routes authenticate uploads/downloads and safely serve active file types", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "nurossh-notes-http-"),
  );
  const service = createNotesService({ dataDir });
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) =>
    req.headers.authorization === "test-only"
      ? next()
      : res.status(401).json({ error: "unauthorized" }),
  );
  const cleanup = registerNotesRoutes(app, service, { dataDir });
  app.use((e, req, res, next) =>
    res.status(e.statusCode || 400).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    cleanup();
    server.closeAllConnections();
    if (server.listening) await new Promise((r) => server.close(r));
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Sandbox does not allow a loopback listener");
      return;
    }
    throw error;
  }
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (endpoint, options = {}) =>
    fetch(url + endpoint, {
      ...options,
      headers: { authorization: "test-only", ...options.headers },
    });
  assert.equal((await fetch(url + "/api/notes")).status, 401);
  const created = await call("/api/notes/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "http",
      body: "<script>bad</script><p>safe</p>",
    }),
  });
  const doc = (await created.json()).document;
  assert.equal(doc.body, "<p>safe</p>");
  const form = new FormData();
  form.append(
    "file",
    new Blob(['<svg onload="alert(1)"></svg>'], { type: "image/svg+xml" }),
    "picture.svg",
  );
  const upload = await call(`/api/notes/documents/${doc.id}/attachments`, {
    method: "POST",
    body: form,
  });
  assert.equal(upload.status, 201);
  const attachment = await upload.json();
  assert.equal(attachment.mime, "application/octet-stream");
  const withAttachment=(await (await call(`/api/notes/documents/${doc.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...doc,body:`<p><a href="${attachment.url}">附件</a></p>`})})).json()).document;
  const copied=(await (await call('/api/notes/documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...withAttachment,title:'副本'})})).json()).document;
  assert.ok(!copied.body.includes(attachment.id));
  const copyId=copied.body.match(/attachments\/([a-f0-9-]{36})/)[1];
  await call(`/api/notes/documents/${doc.id}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({revision:withAttachment.revision})});
  await call(`/api/notes/documents/${doc.id}/restore`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal((await call(`/api/notes/attachments/${copyId}`)).status,200);
  assert.equal((await fetch(url + attachment.url)).status, 401);
  const read = await call(attachment.url);
  assert.equal(read.headers.get("x-content-type-options"), "nosniff");
  assert.match(read.headers.get("content-disposition"), /^attachment/);
  assert.match(read.headers.get("cache-control"), /no-store/);
  const conflict = await call(`/api/notes/documents/${doc.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...doc, revision: 0 }),
  });
  assert.equal(conflict.status, 409);
  const original=(await (await call(`/api/notes/documents/${doc.id}`)).json()).document;
  await call(`/api/notes/documents/${doc.id}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({revision:original.revision})});
  await call(`/api/notes/documents/${doc.id}/purge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'delete-permanently'})});
  assert.equal((await call(`/api/notes/attachments/${copyId}`)).status,200);
});

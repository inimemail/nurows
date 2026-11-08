import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from 'node:crypto';
import express from "express";
import { createNotesService, registerNotesRoutes } from "../server/notes.js";

test("notes worker routes authenticate uploads/downloads and safely serve active file types", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "nurossh-notes-http-"),
  );
  const service = createNotesService({ dataDir, key: crypto.randomBytes(32) });
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

test('attachment reads queue bounded bursts and retain capacity until decrypted data and response are released', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nurossh-notes-capacity-'));
  const held = [];
  const app = express();
  const service = { call: method => method === 'readAttachment' ? new Promise(resolve => held.push(resolve)) : Promise.resolve({}) };
  const cleanup = registerNotesRoutes(app, service, { dataDir });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { cleanup(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/notes/attachments/${crypto.randomUUID()}`;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const jobs = controllers.map(controller => fetch(url, { signal: controller.signal }).then(res => res.text()).catch(() => 'aborted'));
  for (let i = 0; held.length < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 4);
  const canceledWaiting = new AbortController();
  const waiting = fetch(url, { signal: canceledWaiting.signal }).then(res => res.text()).catch(() => 'aborted');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 4, 'bursts wait instead of being rejected');
  canceledWaiting.abort(); assert.equal(await waiting, 'aborted');
  controllers[0].abort(); await jobs[0];
  const next = fetch(url).then(res => res.text());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 4, 'cancelled active reads retain their slot during decryption');
  const result = { item: { mime: 'application/octet-stream', name: 'fixture.txt' }, data: Buffer.from('verified') };
  held[0](result);
  for (let i = 0; held.length < 5 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 5);
  for (const finish of held.slice(1)) finish(result);
  assert.equal(await next, 'verified');
  assert.deepEqual(await Promise.all(jobs.slice(1)), ['verified', 'verified', 'verified']);
});

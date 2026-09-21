import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createNotesStore } from "../server/notes-store.js";
import { noteBody } from "../server/notes-content.js";
import { createNoteAutosave } from "../shared/note-autosave.js";
import { parseStoredRecord } from "../server/storage-validation.js";

function fixture(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const store = createNotesStore(db);
  return { db, store, book: store.books().notebooks[0].id };
}
test("notes are row-based, paginated and exclude body from listings", (t) => {
  const { store, book } = fixture(t);
  for (let i = 0; i < 55; i++)
    store.create({
      notebookId: book,
      title: `文档${i}`,
      body: "<p>私密正文</p>",
    });
  const first = store.list({ notebookId: book }),
    second = store.list({ notebookId: book, page: 2 });
  assert.equal(first.documents.length, 50);
  assert.equal(first.pages, 2);
  assert.equal(second.documents.length, 5);
  assert.ok(first.documents.every((d) => !Object.hasOwn(d, "body")));
});
test("directory metadata supports safe trash without loading the body and rejects stale deletions", (t) => {
  const { store, book } = fixture(t);
  const active = store.create({ title: "正在编辑", body: "<p>保留正文</p>" }).document;
  const target = store.create({ title: "待删除" }).document;
  const row = store.list({ notebookId: book }).documents.find(d => d.id === target.id);
  assert.equal(row.body, undefined);
  const newer = store.save({ ...target, title: "已被其他页面修改" }).document;
  assert.throws(() => store.trash(row), error => error.statusCode === 409);
  const fresh = store.list({ notebookId: book }).documents.find(d => d.id === newer.id);
  store.trash(fresh);
  assert.equal(store.get(active).document.body, active.body);
  assert.equal(store.list({ view: "trash" }).documents[0].id, target.id);
  assert.equal(store.restore(target).document.title, newer.title);
});

test("Chinese body search supports two-character fallback and indexed substrings", (t) => {
  const { store, book } = fixture(t);
  let d = store.create({
    notebookId: book,
    title: "运维",
    body: "<p>服务器备份恢复流程</p>",
  }).document;
  for (const q of ["备份", "份恢复", "服务器", '"', "%", "_"])
    assert.equal(store.list({ q }).total, ['"', "%", "_"].includes(q) ? 0 : 1);
  d = store.save({ ...d, body: "<p>已更新正文</p>" }).document;
  assert.equal(store.list({ q: "份恢复" }).total, 0);
  assert.equal(store.list({ q: "新正文" }).total, 1);
});
test("stale updates fail atomically and unchanged saves do not write revisions", (t) => {
  const { store } = fixture(t);
  const d = store.create({ title: "旧", body: "<p>原文</p>" }).document;
  assert.equal(store.save(d).document.revision, 1);
  const next = store.save({ ...d, title: "新" }).document;
  assert.equal(next.revision, 2);
  assert.throws(
    () => store.save({ ...d, title: "覆盖" }),
    (e) => e.statusCode === 409,
  );
  assert.equal(store.get({ id: d.id }).document.title, "新");
});
test("version restore retains the current text and trash restores safely", (t) => {
  const { store } = fixture(t);
  let d = store.create({ title: "旧", body: "<p>原文</p>" }).document;
  d = store.save({ ...d, title: "新", body: "<p>新文</p>" }).document;
  d = store.revert({ id: d.id, version: 1, revision: d.revision }).document;
  assert.equal(d.title, "旧");
  assert.equal(
    store.version({ id: d.id, version: 2 }).version.body,
    "<p>新文</p>",
  );
  store.trash(d);
  assert.throws(
    () => store.get(d),
    (e) => e.statusCode === 404,
  );
  assert.equal(store.list({ view: "trash" }).total, 1);
  d = store.restore(d).document;
  assert.equal(d.deletedAt, null);
});
test("invalid parent links and cycles cannot corrupt directories", (t) => {
  const { store, book } = fixture(t);
  const a = store.create({ notebookId: book, title: "父" }).document,
    b = store.create({
      notebookId: book,
      parentId: a.id,
      title: "子",
    }).document;
  assert.throws(
    () => store.move({ ...a, notebookId: book, parentId: b.id }),
    /循环/,
  );
  assert.throws(() => store.trash(a), /子文档/);
  assert.throws(() => store.create({ notebookId: "missing" }), /知识库不存在/);
  assert.throws(
    () => store.create({ notebookId: book, parentId: "missing" }),
    /文档不存在/,
  );
});
test("permanent deletion requires trash and confirmation; cleanup never deletes active notes", (t) => {
  const { store, db } = fixture(t);
  const a = store.create({ title: "保留" }).document,
    b = store.create({ title: "删除" }).document;
  assert.throws(
    () => store.purge({ ...a, confirm: "delete-permanently" }),
    /回收站/,
  );
  store.trash(b);
  assert.throws(() => store.purge(b), /确认/);
  db.prepare("UPDATE documents SET deleted_at=? WHERE id=?").run(
    "2020-01-01T00:00:00Z",
    b.id,
  );
  store.cleanup();
  assert.equal(store.list({ view: "trash" }).total, 0);
  assert.equal(store.get(a).document.title, "保留");
});
test("rich text rejects oversized content and removes active HTML and remote images", () => {
  const result = noteBody(
    '<script>alert(1)</script><p onclick="x()">ok</p><a href="javascript:alert(1)">x</a><img src="https://evil.test/track"><iframe src="/api/state"></iframe><svg onload="x()"></svg><img src="/api/notes/attachments/12345678-1234-1234-1234-123456789abc">',
  );
  assert.ok(!/script|onclick|javascript:|evil|iframe|svg/.test(result));
  assert.ok(result.includes("/api/notes/attachments/"));
  assert.throws(() => noteBody("x".repeat(1024 * 1024 + 1)), /1 MB/);
});
test("damaged persisted auth/state fails closed, never returns empty defaults", () => {
  for (const raw of ["{", "null", "[]", '"text"'])
    assert.throws(() => parseStoredRecord(raw));
  assert.throws(() => parseStoredRecord("{}", "auth"));
  assert.throws(() => parseStoredRecord('{"configured":true}', "auth"));
  assert.deepEqual(parseStoredRecord('{"configured":false}', "auth"), {
    configured: false,
  });
});
test("autosave serializes requests and never replaces newer typing with an old response", async () => {
  const requests = [];
  let finish;
  const manager = createNoteAutosave({
    save: (doc) => {
      requests.push(doc);
      return new Promise((resolve) => {
        finish = () => resolve({ ...doc, revision: doc.revision + 1 });
      });
    },
  });
  manager.open({ id: "a", body: "", revision: 1 });
  manager.update({ body: "first" });
  const promise = manager.flush();
  await Promise.resolve();
  manager.update({ body: "second" });
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get().body, "second");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].revision, 2);
  finish();
  await promise;
  assert.equal(manager.get().revision, 3);
  assert.equal(manager.dirty(), false);
  manager.dispose();
});
test("failed saves retain text and block switching until saved or explicitly discarded", async () => {
  const manager = createNoteAutosave({
    save: async () => {
      throw new Error("offline");
    },
  });
  manager.open({ id: "a", body: "", revision: 1 });
  manager.update({ body: "do not lose" });
  await assert.rejects(manager.flush(), /offline/);
  assert.equal(manager.get().body, "do not lose");
  assert.throws(() => manager.open({ id: "b" }), /保存/);
  manager.discard();
  manager.open({ id: "b", revision: 1 });
  manager.dispose();
});

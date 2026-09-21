import crypto from "node:crypto";
import fs from 'node:fs';
import path from 'node:path';
import { noteError, noteText, noteBody, bodyText } from "./notes-content.js";

const META =
  "id, notebook_id AS notebookId, parent_id AS parentId, title, summary, revision, favorite, position, tags, deleted_at AS deletedAt, created_at AS createdAt, updated_at AS updatedAt";
const unpack = (row) =>
  row && {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    favorite: Boolean(row.favorite),
  };
export function createNotesStore(db, {attachmentDir} = {}) {
  const statements = new Map();
  const statement = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS notes_schema (version INTEGER NOT NULL);
      INSERT INTO notes_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM notes_schema);
      CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id), parent_id TEXT REFERENCES documents(id),
        title TEXT NOT NULL, body TEXT NOT NULL, plain TEXT NOT NULL, summary TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        favorite INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_list ON documents(notebook_id,deleted_at,parent_id,position);
      CREATE INDEX IF NOT EXISTS documents_updated ON documents(deleted_at,updated_at DESC);
      CREATE TABLE IF NOT EXISTS revisions (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(document_id,revision));
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_document ON attachments(document_id);
      CREATE TABLE IF NOT EXISTS attachment_copies (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, source_id TEXT NOT NULL, attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE, PRIMARY KEY(document_id,source_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_search USING fts5(title,plain,tags,content='documents',content_rowid='rowid',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON documents BEGIN INSERT INTO notes_search(rowid,title,plain,tags) VALUES(new.rowid,new.title,new.plain,new.tags); END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON documents BEGIN INSERT INTO notes_search(notes_search,rowid,title,plain,tags) VALUES('delete',old.rowid,old.title,old.plain,old.tags); END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title,plain,tags ON documents WHEN old.title != new.title OR old.plain != new.plain OR old.tags != new.tags BEGIN
        INSERT INTO notes_search(notes_search,rowid,title,plain,tags) VALUES('delete',old.rowid,old.title,old.plain,old.tags);
        INSERT INTO notes_search(rowid,title,plain,tags) VALUES(new.rowid,new.title,new.plain,new.tags); END;`);
    if (statement("SELECT version FROM notes_schema").get().version !== 1)
      throw noteError("笔记数据库版本不兼容", 503);
    if (!statement("SELECT id FROM notebooks LIMIT 1").get())
      statement("INSERT INTO notebooks VALUES(?,?,?)").run(
        crypto.randomUUID(),
        "我的知识库",
        new Date().toISOString(),
      );
  })();
  function get(id, trash = false) {
    const row = unpack(
      statement(
          `SELECT ${META},body FROM documents WHERE id=? ${trash ? "" : "AND deleted_at IS NULL"}`,
        )
        .get(id),
    );
    if (!row) throw noteError("文档不存在或已移入回收站", 404);
    return row;
  }
  function checkRevision(doc, input) {
    if (
      !Number.isSafeInteger(input.revision) ||
      doc.revision !== input.revision
    )
      throw noteError(
        "文档已在其他页面更新。你的内容已保留，请另存副本或重新读取。",
        409,
      );
  }
  function notebook(id) {
    if (!statement("SELECT id FROM notebooks WHERE id=?").get(id))
      throw noteError("知识库不存在", 404);
  }
  function parent(id, book, self) {
    if (!id) return null;
    let current = get(id);
    let depth = 0;
    while (current) {
      if (current.notebookId !== book || current.id === self || ++depth > 12)
        throw noteError("目录不能循环、跨知识库或超过 12 层");
      current = current.parentId ? get(current.parentId) : null;
    }
    return id;
  }
  function content(input) {
    const title = noteText(input.title ?? "未命名文档") || "未命名文档";
    const body = noteBody(input.body ?? "<p></p>");
    const plain = bodyText(body);
    if (!Array.isArray(input.tags ?? []) || (input.tags || []).length > 12)
      throw noteError("最多 12 个标签");
    const tags = JSON.stringify([
      ...new Set(
        (input.tags || []).map((t) => noteText(t, 30)).filter(Boolean),
      ),
    ]);
    return { title, body, plain, tags, summary: plain.slice(0, 180) };
  }
  function ownedAttachments(body, documentId) {
    const replacements = new Map();
    for (const match of body.matchAll(/(?:src|href)="\/api\/notes\/attachments\/([a-f0-9-]{36})"/g)) {
      const id = match[1];
      if (replacements.has(id)) continue;
      const copied = statement('SELECT attachment_id FROM attachment_copies WHERE document_id=? AND source_id=?').get(documentId,id);
      if (copied) { replacements.set(id,copied.attachment_id); continue; }
      const item = statement('SELECT * FROM attachments WHERE id=?').get(id);
      if (!item || item.document_id === documentId) continue;
      get(item.document_id);
      if (!attachmentDir) throw noteError('附件存储不可用');
      const next = crypto.randomUUID();
      fs.copyFileSync(path.join(attachmentDir,id),path.join(attachmentDir,next),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
      statement('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(next,documentId,item.name,item.mime,item.size,new Date().toISOString());
      statement('INSERT INTO attachment_copies VALUES(?,?,?)').run(documentId,id,next);
      replacements.set(id,next);
    }
    return body.replace(/((?:src|href)="\/api\/notes\/attachments\/)([a-f0-9-]{36})(")/g,(_,prefix,id,end)=>prefix+(replacements.get(id)||id)+end);
  }
  function snapshot(doc) {
    statement("INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,?)").run(
      doc.id,
      doc.revision,
      doc.title,
      doc.body,
      doc.updatedAt,
    );
    statement(
      "DELETE FROM revisions WHERE document_id=? AND revision NOT IN (SELECT revision FROM revisions WHERE document_id=? ORDER BY revision DESC LIMIT 50)",
    ).run(doc.id, doc.id);
  }
  const methods = {
    books: () => ({
      notebooks: statement(
          `SELECT n.id,n.title,n.created_at AS createdAt,(SELECT count(*) FROM documents d WHERE d.notebook_id=n.id AND d.deleted_at IS NULL) AS count FROM notebooks n ORDER BY n.created_at`,
        )
        .all(),
    }),
    bookSave: ({ id, title }) => {
      title = noteText(title);
      if (!title) throw noteError("请输入知识库名称");
      if (id) {
        notebook(id);
        statement("UPDATE notebooks SET title=? WHERE id=?").run(title, id);
      } else {
        id = crypto.randomUUID();
        statement("INSERT INTO notebooks VALUES(?,?,?)").run(
          id,
          title,
          new Date().toISOString(),
        );
      }
      return { id };
    },
    bookDelete: ({ id }) => {
      notebook(id);
      if (
        statement("SELECT 1 FROM documents WHERE notebook_id=? LIMIT 1")
          .get(id)
      )
        throw noteError("请先移走文档并清理该知识库的回收站");
      statement("DELETE FROM notebooks WHERE id=?").run(id);
      return { ok: true };
    },
    list: ({
      notebookId = "",
      parentId = "",
      q = "",
      view = "all",
      page = 1,
    }) => {
      q = noteText(q, 100);
      page = Math.max(1, Math.min(100000, Math.trunc(Number(page)) || 1));
      const args = [];
      let where =
        view === "trash" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
      if (notebookId) {
        where += " AND notebook_id=?";
        args.push(notebookId);
      }
      if (view === "favorites") where += " AND favorite=1";
      if (q) {
        if ([...q].length >= 3) {
          where +=
            " AND rowid IN (SELECT rowid FROM notes_search WHERE notes_search MATCH ?)";
          args.push('"' + q.replaceAll('"', '""') + '"');
        } else {
          where +=
            " AND (instr(lower(title),lower(?))>0 OR instr(lower(plain),lower(?))>0 OR instr(lower(tags),lower(?))>0)";
          args.push(q, q, q);
        }
      } else if (view === "all") {
        where += " AND parent_id IS ?";
        args.push(parentId || null);
      }
      const total = statement(`SELECT count(*) n FROM documents WHERE ${where}`)
        .get(...args).n;
      const documents = statement(
          `SELECT ${META},EXISTS(SELECT 1 FROM documents c WHERE c.parent_id=documents.id AND c.deleted_at IS NULL) AS hasChildren FROM documents WHERE ${where} ORDER BY ${q || view !== "all" ? "updated_at DESC" : "position,title,id"} LIMIT 50 OFFSET ?`,
        )
        .all(...args, (page - 1) * 50)
        .map(unpack);
      return {
        documents,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / 50)),
      };
    },
    get: ({ id }) => ({ document: get(id) }),
    create: db.transaction((input) => {
      const book = input.notebookId || methods.books().notebooks[0]?.id;
      notebook(book);
      const pid = parent(input.parentId, book);
      const c = content(input);
      const id = crypto.randomUUID(),
        time = new Date().toISOString();
      const position = statement(
          "SELECT coalesce(max(position),0)+1 n FROM documents WHERE notebook_id=? AND parent_id IS ?",
        )
        .get(book, pid).n;
      statement(
        "INSERT INTO documents(id,notebook_id,parent_id,title,body,plain,summary,tags,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        book,
        pid,
        c.title,
        c.body,
        c.plain,
        c.summary,
        c.tags,
        position,
        time,
        time,
      );
      const ownedBody = ownedAttachments(c.body,id);
      if (ownedBody !== c.body) statement('UPDATE documents SET body=? WHERE id=?').run(ownedBody,id);
      return { document: get(id) };
    }),
    save: db.transaction(({ id, ...input }) => {
      const doc = get(id);
      checkRevision(doc, input);
      const c = content(input);
      c.body = ownedAttachments(c.body,id);
      if (
        doc.title === c.title &&
        doc.body === c.body &&
        JSON.stringify(doc.tags) === c.tags &&
        doc.favorite === Boolean(input.favorite)
      )
        return { document: doc };
      const last = statement(
          "SELECT created_at FROM revisions WHERE document_id=? ORDER BY revision DESC LIMIT 1",
        )
        .get(id);
      if (!last || Date.now() - Date.parse(last.created_at) > 60000)
        snapshot(doc);
      statement(
        "UPDATE documents SET title=?,body=?,plain=?,summary=?,tags=?,favorite=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(
        c.title,
        c.body,
        c.plain,
        c.summary,
        c.tags,
        input.favorite ? 1 : 0,
        new Date().toISOString(),
        id,
      );
      return { document: get(id) };
    }),
    move: db.transaction(({ id, notebookId, parentId, revision, position }) => {
      const doc = get(id);
      checkRevision(doc, { revision });
      notebook(notebookId);
      const pid = parent(parentId, notebookId, id);
      if (
        notebookId !== doc.notebookId &&
        statement("SELECT 1 FROM documents WHERE parent_id=? LIMIT 1").get(id)
      )
        throw noteError("包含子文档时请先移动子文档");
      statement(
        "UPDATE documents SET notebook_id=?,parent_id=?,position=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(
        notebookId,
        pid,
        Number.isFinite(position) ? position : Date.now(),
        new Date().toISOString(),
        id,
      );
      return { document: get(id) };
    }),
    trash: db.transaction(({ id, revision }) => {
      const doc = get(id);
      checkRevision(doc, { revision });
      if (
        statement(
            "SELECT 1 FROM documents WHERE parent_id=? AND deleted_at IS NULL LIMIT 1",
          )
          .get(id)
      )
        throw noteError("请先移动或删除子文档");
      snapshot(doc);
      statement(
        "UPDATE documents SET deleted_at=?,revision=revision+1 WHERE id=?",
      ).run(new Date().toISOString(), id);
      return { ok: true };
    }),
    restore: ({ id }) => {
      const doc = get(id, true);
      if (doc.deletedAt)
        statement(
          "UPDATE documents SET deleted_at=NULL,parent_id=NULL,revision=revision+1 WHERE id=?",
        ).run(id);
      return { document: get(id) };
    },
    purge: db.transaction(({ id, confirm }) => {
      if (confirm !== "delete-permanently") throw noteError("请确认永久删除");
      const doc = get(id, true);
      if (!doc.deletedAt) throw noteError("只能永久删除回收站文档");
      statement("UPDATE documents SET parent_id=NULL WHERE parent_id=?").run(
        id,
      );
      statement("DELETE FROM documents WHERE id=?").run(id);
      return { ok: true };
    }),
    versions: ({ id }) => {
      get(id);
      return {
        versions: statement(
            "SELECT revision,title,created_at AS createdAt FROM revisions WHERE document_id=? ORDER BY revision DESC LIMIT 50",
          )
          .all(id),
      };
    },
    version: ({ id, version }) => {
      get(id);
      const row = statement(
          "SELECT revision,title,body,created_at AS createdAt FROM revisions WHERE document_id=? AND revision=?",
        )
        .get(id, Number(version));
      if (!row) throw noteError("版本不存在", 404);
      return { version: row };
    },
    revert: db.transaction(({ id, version, revision }) => {
      const doc = get(id);
      checkRevision(doc, { revision });
      const old = methods.version({ id, version }).version;
      snapshot(doc);
      const c = content({ ...doc, ...old });
      statement(
        "UPDATE documents SET title=?,body=?,plain=?,summary=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(c.title, c.body, c.plain, c.summary, new Date().toISOString(), id);
      return { document: get(id) };
    }),
    attachmentAdd: ({ id, documentId, name, mime, size }) => {
      get(documentId);
      if (
        statement("SELECT count(*) n FROM attachments WHERE document_id=?")
          .get(documentId).n >= 100
      )
        throw noteError("每篇文档最多 100 个附件");
      statement("INSERT INTO attachments VALUES(?,?,?,?,?,?)").run(
        id,
        documentId,
        noteText(name, 200),
        mime,
        size,
        new Date().toISOString(),
      );
      return { id, name, mime, size, url: `/api/notes/attachments/${id}` };
    },
    attachment: ({ id }) => {
      const row = statement("SELECT * FROM attachments WHERE id=?").get(id);
      if (!row) throw noteError("附件不存在", 404);
      get(row.document_id);
      return row;
    },
    attachments: ({ id }) => {
      get(id);
      return {
        attachments: statement(
            "SELECT id,name,mime,size FROM attachments WHERE document_id=? ORDER BY created_at DESC",
          )
          .all(id),
      };
    },
    hasAttachment: ({ id }) =>
      Boolean(statement("SELECT 1 FROM attachments WHERE id=?").get(id)),
    cleanup: db.transaction(() => {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      statement(
        "UPDATE documents SET parent_id=NULL WHERE parent_id IN(SELECT id FROM documents WHERE deleted_at<?)",
      ).run(cutoff);
      statement("DELETE FROM documents WHERE deleted_at<?").run(cutoff);
      return { ok: true };
    }),
  };
  return methods;
}

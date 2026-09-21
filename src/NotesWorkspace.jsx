import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileText,
  FolderPlus,
  Plus,
  Save,
  Search,
  Star,
  Clock3,
  Trash2,
  PanelLeft,
  ListTree,
  MoreHorizontal,
  ChevronRight,
  ChevronLeft,
  X,
  LockKeyhole,
  Download,
  Upload,
  History,
  Copy,
  FolderInput,
  Pencil,
  FilePlus2,
  ArrowUp,
  ArrowDown,
  Paperclip,
  Maximize2,
  Minimize2,
  ChevronsDownUp,
} from "lucide-react";
import { createNoteAutosave } from "../shared/note-autosave.js";
import NoteEditor from "./NoteEditor.jsx";
import NoteTree from "./NoteTree.jsx";
import NoteOutline from "./NoteOutline.jsx";
import { copyNoteText } from "./note-clipboard.js";
import Dialog from "./Dialog.jsx";
import "./notes.css";

const time = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const templates = {
  blank: { title: "未命名文档", body: "<p></p>" },
  runbook: {
    title: "运维操作手册",
    body: "<h1>操作目标</h1><p></p><h2>前置检查</h2><ul><li><p>确认环境与备份</p></li></ul><h2>执行步骤</h2><pre><code></code></pre><h2>验证结果</h2><p></p><h2>回退方案</h2><p></p>",
  },
  incident: {
    title: "故障复盘",
    body: "<h1>事件概况</h1><p></p><h2>影响范围</h2><p></p><h2>时间线</h2><p></p><h2>原因分析</h2><p></p><h2>改进措施</h2><ul><li><p></p></li></ul>",
  },
};
const draftKey = (id) => `nurossh-note-draft:${id}`;
function rememberDraft(doc) {
  try {
    const keys = Object.keys(sessionStorage).filter(
      (key) =>
        key.startsWith("nurossh-note-draft:") && key !== draftKey(doc.id),
    );
    for (const key of keys.slice(0, Math.max(0, keys.length - 2)))
      sessionStorage.removeItem(key);
    sessionStorage.setItem(draftKey(doc.id), JSON.stringify(doc));
  } catch {
    /* Save status still reports unsaved content. */
  }
}
function clearDraft(id) {
  try {
    sessionStorage.removeItem(draftKey(id));
  } catch {}
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function NotesWorkspace({
  api,
  toast,
  search = "",
  onSearchScopeChange,
  onBeforeLeave,
}) {
  const [books, setBooks] = useState([]),
    [book, setBook] = useState(""),
    [view, setView] = useState("all"),
    [parents, setParents] = useState([]);
  const [listing, setListing] = useState({
      documents: [],
      page: 1,
      pages: 1,
      total: 0,
    }),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [drawer, setDrawer] = useState(false),
    [outlineOpen, setOutlineOpen] = useState(false);
  const [doc, setDoc] = useState(null),
    [saveState, setSaveState] = useState({}),
    [outline, setOutline] = useState([]),
    [editorEpoch, setEditorEpoch] = useState(0);
  const [dialog, setDialog] = useState(null),
    [versions, setVersions] = useState([]),
    [version, setVersion] = useState(null),
    [attachments, setAttachments] = useState([]);
  const [tagText, setTagText] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [collapseKey, setCollapseKey] = useState(0);
  const workspace = useRef(null);
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);
  useEffect(() => {
    const keydown = (event) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector('.dialog[aria-modal="true"]')
      )
        return;
      if (drawer) setDrawer(false);
      else if (outlineOpen && matchMedia("(max-width: 760px)").matches)
        setOutlineOpen(false);
      else setFullscreen(false);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [drawer, outlineOpen]);
  const mounted = useRef(true),
    editor = useRef(null),
    importInput = useRef(null),
    requestEpoch = useRef(0),
    managerRef = useRef(null),
    busyRef = useRef(false),
    draftTimer = useRef(null);
  if (!managerRef.current)
    managerRef.current = createNoteAutosave({
      save: async (value) =>
        (
          await api(`/api/notes/documents/${value.id}`, {
            method: "PUT",
            body: JSON.stringify(value),
          })
        ).document,
      onChange: (state) => {
        clearTimeout(draftTimer.current);
        if (state.document) {
          if (state.dirty)
            draftTimer.current = setTimeout(
              () => rememberDraft(state.document),
              400,
            );
          else clearDraft(state.document.id);
        }
        if (mounted.current) {
          setSaveState(state);
          setDoc(state.document);
          if (state.document && !state.dirty)
            setListing((prior) => ({
              ...prior,
              documents: prior.documents.map((item) =>
                item.id === state.document.id
                  ? {
                      ...item,
                      title: state.document.title,
                      favorite: state.document.favorite,
                      updatedAt: state.document.updatedAt,
                    }
                  : item,
              ),
            }));
        }
      },
    });
  const manager = managerRef.current;
  async function reloadBooks() {
    const data = await api("/api/notes");
    if (mounted.current) {
      setBooks(data.notebooks);
      setBook((prior) =>
        data.notebooks.some((b) => b.id === prior)
          ? prior
          : data.notebooks[0]?.id || "",
      );
    }
  }
  useEffect(() => {
    mounted.current = true;
    manager.resume();
    reloadBooks().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
    onSearchScopeChange?.({ tab: "notes", section: "notes" });
    const unload = (e) => {
      if (manager.dirty()) {
        rememberDraft(manager.get());
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const hidden = () => {
      if (document.hidden) manager.flush().catch(() => {});
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", hidden);
    const hash = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("note");
      if (/^[a-f0-9-]{36}$/.test(id || "")) open(id);
    };
    const initialHash = setTimeout(hash, 0);
    window.addEventListener("hashchange", hash);
    onBeforeLeave?.(async () => {
      try {
        await manager.flush();
        return true;
      } catch (e) {
        toast(e.message);
        return false;
      }
    });
    return () => {
      mounted.current = false;
      requestEpoch.current++;
      clearTimeout(draftTimer.current);
      if (manager.dirty()) rememberDraft(manager.get());
      manager.dispose();
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("hashchange", hash);
      clearTimeout(initialHash);
      onBeforeLeave?.(null);
    };
  }, []);
  useEffect(() => {
    setPage(1);
  }, [book, view, search, parents]);
  useEffect(() => {
    if (!book) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        try {
          const query = new URLSearchParams({
            notebookId: book,
            view,
            q: search.slice(0, 100),
            parentId: parents.at(-1)?.id || "",
            page: String(page),
          });
          const result = await api(`/api/notes/documents?${query}`, {
            signal: controller.signal,
          });
          if (active) {
            setListing(result);
            setError("");
          }
        } catch (e) {
          if (active && e.name !== "AbortError") setError(e.message);
        } finally {
          if (active) setLoading(false);
        }
      },
      search ? 300 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [book, view, search, parents, page, revision]);
  async function act(fn) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      toast(e.message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function refresh() {
    setRevision((n) => n + 1);
    reloadBooks().catch(() => {});
  }
  function accept(value) {
    manager.open(value);
    setTagText(value.tags.join("、"));
    setEditorEpoch((n) => n + 1);
    setOutline([]);
    setAttachments([]);
    setDrawer(false);
  }
  async function open(id) {
    await act(async () => {
      await manager.flush();
      const epoch = ++requestEpoch.current;
      const result = await api(`/api/notes/documents/${id}`);
      if (epoch !== requestEpoch.current || !mounted.current) return;
      let recovery;
      try {
        recovery = JSON.parse(sessionStorage.getItem(draftKey(id)) || "null");
      } catch {}
      accept(result.document);
      if (
        recovery &&
        (recovery.body !== result.document.body ||
          recovery.title !== result.document.title)
      ) {
        rememberDraft(recovery);
        setDialog({ type: "recovery", draft: recovery });
      }
    });
  }
  async function create(template = "blank", overrides = {}) {
    await act(async () => {
      await manager.flush();
      const result = await api("/api/notes/documents", {
        method: "POST",
        body: JSON.stringify({
          ...templates[template],
          notebookId: book,
          parentId: parents.at(-1)?.id || null,
          ...overrides,
        }),
      });
      accept(result.document);
      setDialog(null);
      refresh();
    });
  }
  function patch(value) {
    manager.update(value);
  }
  async function duplicate() {
    const value = manager.get();
    if (!value) return;
    await act(async () => {
      const result = await api("/api/notes/documents", {
        method: "POST",
        body: JSON.stringify({
          ...value,
          id: undefined,
          title: `${value.title.slice(0, 190)}（副本）`,
          parentId: null,
        }),
      });
      clearDraft(value.id);
      managerRef.current = manager;
      await manager.flush().catch(() => {});
      // A conflict must not prevent saving the local text as a separate document.
      manager.discard();
      accept(result.document);
      refresh();
      setError("");
    });
  }
  async function submitDialog(e) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await act(async () => {
      if (dialog.type === "book") {
        const result = await api(
          dialog.id
            ? `/api/notes/notebooks/${dialog.id}`
            : "/api/notes/notebooks",
          {
            method: dialog.id ? "PUT" : "POST",
            body: JSON.stringify({ title: data.get("title") }),
          },
        );
        await reloadBooks();
        setBook(result.id);
        setParents([]);
      }
      if (dialog.type === "link") {
        const href = String(data.get("url")).trim();
        if (!/^(https?:\/\/|mailto:|#note=)/i.test(href))
          throw new Error("链接仅支持 http、https、mailto 或笔记链接");
        editor.current
          .chain()
          .focus()
          .extendMarkRange("link")
          .setLink({ href })
          .run();
      }
      if (dialog.type === "move") {
        await manager.flush();
        const current = manager.get();
        const result = await api(`/api/notes/documents/${current.id}/move`, {
          method: "POST",
          body: JSON.stringify({
            revision: current.revision,
            notebookId: data.get("book"),
            parentId: data.get("parent") || null,
          }),
        });
        accept(result.document);
        refresh();
      }
      setDialog(null);
    });
  }
  async function upload(file, instance) {
    if (file.size > 10 * 1024 * 1024) {
      toast("附件不能超过 10 MB");
      return;
    }
    await act(async () => {
      const form = new FormData();
      form.append("file", file);
      const target = manager.get().id;
      const result = await api(`/api/notes/documents/${target}/attachments`, {
        method: "POST",
        headers: {},
        body: form,
      });
      if (manager.get()?.id !== target) return;
      if (result.mime.startsWith("image/"))
        instance
          .chain()
          .focus()
          .setImage({ src: result.url, alt: result.name })
          .run();
      else
        instance
          .chain()
          .focus()
          .insertContent({
            type: "text",
            text: result.name,
            marks: [{ type: "link", attrs: { href: result.url } }],
          })
          .run();
      await manager.flush();
    });
  }
  async function exportDoc(format) {
    await act(async () => {
      await manager.flush();
      const value = manager.get();
      if (format === "html")
        download(
          `${value.title}.html`,
          `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${value.title.replace(/[<>&]/g, "")}</title><style>body{max-width:850px;margin:40px auto;font:16px/1.8 system-ui}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:8px}pre{white-space:pre-wrap}</style>${value.body}`,
          "text/html",
        );
      if (format === "md") {
        const { default: Turndown } = await import("turndown");
        const converter = new Turndown({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        });
        download(
          `${value.title}.md`,
          converter.turndown(value.body),
          "text/markdown",
        );
      }
      if (format === "json")
        download(
          `${value.title}.json`,
          JSON.stringify(
            {
              format: "nurossh-note-v1",
              title: value.title,
              body: value.body,
              tags: value.tags,
            },
            null,
            2,
          ),
          "application/json",
        );
    });
  }
  async function importFile(file) {
    if (file.size > 1024 * 1024) {
      toast("导入文件不能超过 1 MB");
      return;
    }
    await act(async () => {
      await manager.flush();
      let value;
      const text = await file.text();
      if (file.name.endsWith(".json")) {
        value = JSON.parse(text);
        if (value.format !== "nurossh-note-v1")
          throw new Error("不支持的笔记格式");
      } else if (/\.md$/i.test(file.name)) {
        const { marked } = await import("marked");
        value = {
          title: file.name.replace(/\.md$/i, ""),
          body: marked.parse(text, { async: false }),
        };
      } else if (/\.html?$/i.test(file.name)) {
        value = { title: file.name.replace(/\.html?$/i, ""), body: text };
      } else throw new Error("支持 Markdown、HTML 和笔记 JSON");
      const result = await api("/api/notes/documents", {
        method: "POST",
        body: JSON.stringify({
          title: value.title,
          body: value.body,
          tags: value.tags || [],
          notebookId: book,
        }),
      });
      accept(result.document);
      refresh();
    });
  }
  async function reorder(item, direction) {
    await act(async () => {
      await manager.flush();
      const index = listing.documents.findIndex((d) => d.id === item.id),
        other = listing.documents[index + direction];
      if (!other) return;
      const current = (await api(`/api/notes/documents/${item.id}`)).document;
      const result = await api(`/api/notes/documents/${item.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          notebookId: book,
          parentId: item.parentId,
          revision: current.revision,
          position: other.position + direction * 0.5,
        }),
      });
      if (doc?.id === item.id) accept(result.document);
      refresh();
    });
  }
  async function place(item, position) {
    await act(async () => {
      await manager.flush();
      const current = (await api(`/api/notes/documents/${item.id}`)).document;
      const result = await api(`/api/notes/documents/${item.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          notebookId: current.notebookId,
          parentId: current.parentId,
          revision: current.revision,
          position,
        }),
      });
      if (manager.get()?.id === item.id) accept(result.document);
      refresh();
    });
  }
  const currentBook = books.find((b) => b.id === book);
  return (
    <section
      ref={workspace}
      className={`notes-workspace ${fullscreen ? "notes-fullscreen" : ""}`}
      aria-label="笔记工作台"
    >
      <header className="notes-header">
        <div className="notes-heading">
          <span className="notes-mark">
            <BookOpen />
          </span>
          <div>
            <h1>笔记</h1>
            <p>把经验留下，让知识有序生长</p>
          </div>
        </div>
        <div className="notes-header-actions">
          <span className="notes-private">
            <LockKeyhole />
            私人知识库
          </span>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => setDialog({ type: "book" })}
          >
            <FolderPlus />
            知识库
          </button>
          <button
            className="primary"
            disabled={busy || !book}
            onClick={() => setDialog({ type: "new" })}
          >
            <Plus />
            新建文档
          </button>
        </div>
      </header>
      {error ? (
        <div className="note-error" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              refresh();
            }}
          >
            重试读取
          </button>
        </div>
      ) : null}
      <div
        className={`notes-layout ${sidebarHidden ? "notes-sidebar-hidden" : ""}`}
      >
        <aside className={"notes-sidebar " + (drawer ? "open" : "")}>
          <div className="notes-sidebar-head">
            <strong>我的知识库</strong>
            <button
              className="note-mobile icon-button"
              aria-label="关闭目录"
              onClick={() => setDrawer(false)}
            >
              <X />
            </button>
          </div>
          <div className="note-book-picker">
            <select
              aria-label="选择知识库"
              value={book}
              onChange={(e) => {
                setBook(e.target.value);
                setParents([]);
                setView("all");
              }}
            >
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title} · {b.count}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              title="编辑知识库"
              aria-label="编辑知识库"
              disabled={!book}
              onClick={() =>
                setDialog({ type: "book", id: book, title: currentBook?.title })
              }
            >
              <Pencil />
            </button>
          </div>
          <div className="notes-views">
            {[
              ["all", FileText, "文档"],
              ["recent", Clock3, "最近"],
              ["favorites", Star, "收藏"],
              ["trash", Trash2, "回收站"],
            ].map(([key, Icon, label]) => (
              <button
                key={key}
                className={view === key ? "active" : ""}
                onClick={() => {
                  setView(key);
                  setParents([]);
                }}
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
          <div className="notes-list-head">
            <span>
              {search ? "搜索结果" : parents.at(-1)?.title || "文档目录"}
            </span>
            <small>{listing.total} 篇</small>
            {view === "all" &&
            !search &&
            listing.documents.some((item) => item.hasChildren) ? (
              <button
                className="icon-button"
                title="收起所有子文档"
                aria-label="收起所有子文档"
                onClick={() => setCollapseKey((n) => n + 1)}
              >
                <ChevronsDownUp />
              </button>
            ) : null}
          </div>
          {parents.length ? (
            <button
              className="notes-back"
              onClick={() => setParents((p) => p.slice(0, -1))}
            >
              <ChevronLeft />
              返回上级目录
            </button>
          ) : null}
          <div className="notes-doc-list">
            {loading && !listing.documents.length ? (
              <p className="notes-list-empty">正在读取…</p>
            ) : view === "all" && !search ? (
              <NoteTree
                key={`${book}:${parents.at(-1)?.id || "root"}:${page}`}
                items={listing.documents}
                api={api}
                book={book}
                revision={revision}
                active={doc}
                busy={busy || loading}
                onOpen={open}
                onCreate={(item) => create("blank", { parentId: item.id })}
                onPlace={place}
                onDelete={(item) => setDialog({ type: "delete", item })}
                collapseKey={collapseKey}
              />
            ) : (
              listing.documents.map((item) => (
                <div
                  className={
                    "notes-doc-row " + (doc?.id === item.id ? "active" : "")
                  }
                  key={item.id}
                  draggable={!busy && view === "all" && !search}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-nurossh-note",
                      item.id,
                    );
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (
                      event.dataTransfer.types.includes(
                        "application/x-nurossh-note",
                      )
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = listing.documents.find(
                      (value) =>
                        value.id ===
                        event.dataTransfer.getData(
                          "application/x-nurossh-note",
                        ),
                    );
                    if (source && source.id !== item.id)
                      place(source, item.position - 0.25);
                  }}
                >
                  <button
                    className="notes-doc-item"
                    disabled={busy}
                    onClick={() =>
                      view === "trash"
                        ? setDialog({ type: "trash", item })
                        : open(item.id)
                    }
                    onDoubleClick={() =>
                      view !== "trash" &&
                      setParents((p) => [
                        ...p,
                        { id: item.id, title: item.title },
                      ])
                    }
                  >
                    <FileText />
                    <span>
                      <strong>{item.title}</strong>
                      {view !== "all" || search ? (
                        <small>
                          {item.deletedAt ? "删除于 " : ""}
                          {time(item.deletedAt || item.updatedAt)}
                        </small>
                      ) : null}
                    </span>
                    {item.favorite ? <Star size={12} /> : null}
                  </button>
                  {view === "all" && !search ? (
                    <>
                      <button
                        className="note-row-tool"
                        title="打开子文档目录"
                        aria-label={`${item.title} 的子文档`}
                        onClick={() =>
                          setParents((p) => [
                            ...p,
                            { id: item.id, title: item.title },
                          ])
                        }
                      >
                        <ChevronRight />
                      </button>
                      <details className="note-row-order">
                        <summary aria-label="排序">
                          <MoreHorizontal />
                        </summary>
                        <button onClick={() => reorder(item, -1)}>
                          <ArrowUp />
                          上移
                        </button>
                        <button onClick={() => reorder(item, 1)}>
                          <ArrowDown />
                          下移
                        </button>
                      </details>
                    </>
                  ) : null}
                  {view !== "trash" ? (
                    <details className="note-row-order">
                      <summary aria-label={`${item.title} 的目录操作`}>
                        <MoreHorizontal />
                      </summary>
                      <div>
                        <button
                          className="danger-text-button"
                          disabled={busy}
                          onClick={(event) => {
                            event.currentTarget.closest("details").open = false;
                            setDialog({
                              type: "delete",
                              item:
                                manager.get()?.id === item.id
                                  ? manager.get()
                                  : item,
                            });
                          }}
                        >
                          <Trash2 />
                          移入回收站
                        </button>
                      </div>
                    </details>
                  ) : null}
                </div>
              ))
            )}
            {!loading && !listing.documents.length ? (
              <div className="notes-list-empty">
                <FileText />
                <span>
                  {search
                    ? "没有匹配的笔记"
                    : view === "trash"
                      ? "回收站是空的"
                      : "这里还没有文档"}
                </span>
              </div>
            ) : null}
          </div>
          {listing.pages > 1 ? (
            <div className="notes-pagination">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft />
              </button>
              <span>
                {page}/{listing.pages}
              </span>
              <button
                disabled={page >= listing.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight />
              </button>
            </div>
          ) : null}
          <div className="notes-sidebar-foot">
            <button onClick={() => importInput.current.click()} disabled={busy}>
              <Upload />
              导入文档
            </button>
            <span>
              {view === "trash"
                ? "删除的文档保留 30 天"
                : "仅加载当前目录 · 自动保存"}
            </span>
            <input
              hidden
              ref={importInput}
              type="file"
              accept=".md,.html,.htm,.json"
              onChange={(e) => {
                const file = e.target.files[0];
                e.target.value = "";
                if (file) importFile(file);
              }}
            />
          </div>
        </aside>
        {drawer ? (
          <button
            className="notes-scrim"
            aria-label="关闭目录"
            onClick={() => setDrawer(false)}
          />
        ) : null}
        <main className="notes-editor">
          <div className="notes-editor-meta">
            <button
              className="icon-button"
              title="文档目录"
              aria-label="文档目录"
              aria-expanded={
                matchMedia("(max-width: 760px)").matches
                  ? drawer
                  : !sidebarHidden
              }
              onClick={() =>
                matchMedia("(max-width: 760px)").matches
                  ? setDrawer((value) => !value)
                  : setSidebarHidden((value) => !value)
              }
            >
              <PanelLeft />
            </button>
            <span className="note-breadcrumb">
              {books.find((b) => b.id === doc?.notebookId)?.title ||
                currentBook?.title ||
                "笔记"}
              {doc ? " / 文档" : ""}
            </span>
            <span
              className={"note-save-state " + (saveState.error ? "failed" : "")}
            >
              {saveState.error
                ? "保存失败"
                : saveState.saving
                  ? "保存中…"
                  : saveState.dirty
                    ? "待保存"
                    : doc
                      ? "已保存"
                      : ""}
            </span>
            {doc ? (
              <>
                <button
                  className="icon-button"
                  title="立即保存"
                  aria-label="立即保存"
                  disabled={busy || saveState.saving}
                  onClick={() => act(() => manager.flush())}
                >
                  <Save />
                </button>
                <button
                  className={
                    "icon-button " + (doc.favorite ? "note-starred" : "")
                  }
                  title="收藏"
                  aria-label="收藏"
                  aria-pressed={doc.favorite}
                  disabled={busy}
                  onClick={() => patch({ favorite: !doc.favorite })}
                >
                  <Star />
                </button>
                <button
                  className="icon-button"
                  title="大纲"
                  aria-label="大纲"
                  onClick={() => setOutlineOpen((v) => !v)}
                >
                  <ListTree />
                </button>
                <details className="note-menu">
                  <summary aria-label="文档更多操作">
                    <MoreHorizontal />
                  </summary>
                  <div
                    onClick={(event) => {
                      if (event.target.closest("button"))
                        event.currentTarget.closest("details").open = false;
                    }}
                  >
                    <button
                      onClick={() => {
                        duplicate();
                      }}
                      disabled={busy}
                    >
                      <Copy />
                      复制 / 另存副本
                    </button>
                    <button onClick={() => setDialog({ type: "move" })}>
                      <FolderInput />
                      移动文档
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        place(doc, doc.position < 0 ? Date.now() : -Date.now())
                      }
                    >
                      <ArrowUp />
                      {doc.position < 0 ? "取消置顶" : "置顶文档"}
                    </button>
                    <button
                      onClick={() =>
                        act(async () => {
                          await manager.flush();
                          setVersions(
                            (
                              await api(
                                `/api/notes/documents/${doc.id}/versions`,
                              )
                            ).versions,
                          );
                          setVersion(null);
                          setDialog({ type: "versions" });
                        })
                      }
                    >
                      <History />
                      历史版本
                    </button>
                    <button
                      onClick={() =>
                        act(async () => {
                          setAttachments(
                            (
                              await api(
                                `/api/notes/documents/${doc.id}/attachments`,
                              )
                            ).attachments,
                          );
                          setDialog({ type: "attachments" });
                        })
                      }
                    >
                      <Paperclip />
                      附件
                    </button>
                    <button onClick={() => exportDoc("md")}>
                      <Download />
                      导出 Markdown
                    </button>
                    <button onClick={() => exportDoc("html")}>
                      <Download />
                      导出 HTML
                    </button>
                    <button onClick={() => exportDoc("json")}>
                      <Download />
                      导出笔记源文件
                    </button>
                    <button onClick={() => window.print()}>
                      <FileText />
                      打印 / PDF
                    </button>
                    <button
                      onClick={() =>
                        copyNoteText(
                          `${location.origin}${location.pathname}#note=${doc.id}`,
                        )
                          .then(() => toast("笔记链接已复制"))
                          .catch((error) => toast(error.message))
                      }
                    >
                      <Copy />
                      复制笔记链接
                    </button>
                    <button
                      className="danger-text-button"
                      onClick={() =>
                        setDialog({ type: "delete", item: manager.get() })
                      }
                    >
                      <Trash2 />
                      移入回收站
                    </button>
                  </div>
                </details>
              </>
            ) : null}
            <button
              className="icon-button note-fullscreen-toggle"
              title={fullscreen ? "退出全屏（Esc）" : "全屏笔记"}
              aria-label={fullscreen ? "退出笔记全屏" : "全屏笔记"}
              aria-pressed={fullscreen}
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </button>
          </div>
          {saveState.error ? (
            <div className="note-error" role="alert">
              <span>{saveState.error.message}</span>
              <button onClick={() => act(() => manager.flush())}>
                重试保存
              </button>
              <button onClick={duplicate}>另存副本</button>
            </div>
          ) : null}
          {doc ? (
            <div className="note-writing-layout">
              <div className="note-writing-scroll">
                <input
                  className="notes-title"
                  aria-label="文档标题"
                  value={doc.title}
                  disabled={busy}
                  maxLength={200}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="未命名文档"
                />
                <div className="note-tags">
                  <span>标签</span>
                  <input
                    aria-label="文档标签"
                    placeholder="用逗号分隔，例如 运维、备忘"
                    value={tagText}
                    onChange={(e) => {
                      setTagText(e.target.value);
                      patch({
                        tags: e.target.value
                          .split(/[、,，]/)
                          .map((t) => t.trim())
                          .filter(Boolean),
                      });
                    }}
                  />
                </div>
                <NoteEditor
                  key={`${doc.id}:${editorEpoch}`}
                  document={doc}
                  toast={toast}
                  disabled={busy}
                  saved={!saveState.dirty}
                  onChange={(body) => patch({ body })}
                  onReady={(value) => (editor.current = value)}
                  onOutline={setOutline}
                  onLink={() => setDialog({ type: "link" })}
                  onUpload={upload}
                />
                <div className="notes-editor-foot">
                  <span>
                    修订 {doc.revision} ·{" "}
                    {doc.updatedAt ? time(doc.updatedAt) : ""}
                  </span>
                  <span>内容私有 · 不受任务记录清理影响</span>
                </div>
              </div>
              {outlineOpen ? (
                <NoteOutline
                  key={`${doc.id}:${editorEpoch}`}
                  headings={outline}
                  onClose={() => setOutlineOpen(false)}
                  onNavigate={(h) => {
                    const instance = editor.current;
                    if (!instance) return;
                    const resolved = instance.state.doc.resolve(h.pos + 1);
                    const chain = instance.chain().focus();
                    for (let depth = 1; depth <= resolved.depth; depth++) {
                      const node = resolved.node(depth);
                      if (node.type.name === "details" && !node.attrs.open)
                        chain.command(({ tr }) => {
                          tr.setNodeMarkup(resolved.before(depth), undefined, {
                            ...node.attrs,
                            open: true,
                          });
                          return true;
                        });
                    }
                    chain
                      .setTextSelection(h.pos + 1)
                      .scrollIntoView()
                      .run();
                    if (matchMedia("(max-width: 760px)").matches)
                      setOutlineOpen(false);
                  }}
                />
              ) : null}
            </div>
          ) : (
            <div className="notes-empty">
              <span className="notes-empty-icon">
                <BookOpen />
              </span>
              <h2>从一篇好笔记开始</h2>
              <p>记录操作方法、整理排障经验，也留住一闪而过的想法。</p>
              <button
                className="primary"
                disabled={busy || !book}
                onClick={() => setDialog({ type: "new" })}
              >
                <Plus />
                写一篇笔记
              </button>
              <button
                className="ghost note-mobile"
                onClick={() => setDrawer(true)}
              >
                查看文档目录
              </button>
              <div className="notes-template-preview">
                <span>运维手册</span>
                <span>故障复盘</span>
                <span>自由记录</span>
              </div>
            </div>
          )}
        </main>
      </div>
      {dialog ? (
        <Dialog
          title={
            {
              book: dialog.id ? "编辑知识库" : "新建知识库",
              new: "新建文档",
              link: "插入链接",
              move: "移动文档",
              delete: "移入回收站",
              trash: "回收站文档",
              versions: "历史版本",
              attachments: "文档附件",
              recovery: "发现未保存的草稿",
            }[dialog.type]
          }
          className="note-dialog"
          wide={dialog.type === "versions"}
          onClose={() => !busy && setDialog(null)}
        >
          {["book", "link", "move"].includes(dialog.type) ? (
            <form className="note-form" onSubmit={submitDialog}>
              {dialog.type === "book" ? (
                <label>
                  知识库名称
                  <input
                    name="title"
                    required
                    maxLength={200}
                    defaultValue={dialog.title || ""}
                  />
                </label>
              ) : dialog.type === "link" ? (
                <label>
                  链接地址
                  <input
                    name="url"
                    required
                    placeholder="https://… 或 #note=文档ID"
                  />
                </label>
              ) : (
                <>
                  <label>
                    目标知识库
                    <select name="book" defaultValue={doc.notebookId}>
                      {books.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    上级文档 ID（留空放到根目录）
                    <input name="parent" defaultValue={doc.parentId || ""} />
                  </label>
                  <small>可以从目标文档的“复制笔记链接”取得 ID。</small>
                </>
              )}
              <div className="dialog-actions">
                {dialog.type === "book" && dialog.id ? (
                  <button
                    type="button"
                    className="ghost danger-text-button"
                    disabled={busy || currentBook?.count > 0}
                    onClick={() =>
                      act(async () => {
                        await api(`/api/notes/notebooks/${dialog.id}`, {
                          method: "DELETE",
                        });
                        await reloadBooks();
                        setDialog(null);
                      })
                    }
                  >
                    删除空知识库
                  </button>
                ) : null}
                <button className="primary" disabled={busy}>
                  保存
                </button>
              </div>
            </form>
          ) : null}
          {dialog.type === "new" ? (
            <div className="note-template-grid">
              {[
                ["blank", "空白文档", "从一个想法开始", FilePlus2],
                ["runbook", "运维手册", "步骤、验证与回退", BookOpen],
                ["incident", "故障复盘", "记录问题与改进", Clock3],
              ].map(([key, title, desc, Icon]) => (
                <button key={key} disabled={busy} onClick={() => create(key)}>
                  <Icon />
                  <strong>{title}</strong>
                  <span>{desc}</span>
                </button>
              ))}
            </div>
          ) : null}
          {dialog.type === "delete" ? (
            <>
              <p className="note-delete-title">{dialog.item.title}</p>
              <p>
                文档将保留在回收站 30 天，期间可以恢复。历史版本和附件一并保留。
              </p>
              <div className="dialog-actions">
                <button className="ghost" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button
                  className="primary danger-action"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const isCurrent = manager.get()?.id === dialog.item.id;
                      if (isCurrent) await manager.flush();
                      const value = isCurrent ? manager.get() : dialog.item;
                      await api(`/api/notes/documents/${value.id}`, {
                        method: "DELETE",
                        body: JSON.stringify({ revision: value.revision }),
                      });
                      if (isCurrent) manager.open(null);
                      setDialog(null);
                      refresh();
                    })
                  }
                >
                  移入回收站
                </button>
              </div>
            </>
          ) : null}
          {dialog.type === "trash" ? (
            <>
              <p>{dialog.item.title}</p>
              <p>
                删除于 {time(dialog.item.deletedAt)}，保留 30
                天。永久删除后不可恢复。
              </p>
              <div className="dialog-actions">
                <button
                  className="ghost danger-text-button"
                  disabled={busy}
                  onClick={() => setDialog({ ...dialog, confirm: true })}
                >
                  {dialog.confirm ? "已确认，请点永久删除" : "永久删除…"}
                </button>
                {dialog.confirm ? (
                  <button
                    className="primary danger-action"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await api(
                          `/api/notes/documents/${dialog.item.id}/purge`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              confirm: "delete-permanently",
                            }),
                          },
                        );
                        setDialog(null);
                        refresh();
                      })
                    }
                  >
                    确认永久删除
                  </button>
                ) : null}
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api(
                        `/api/notes/documents/${dialog.item.id}/restore`,
                        { method: "POST", body: "{}" },
                      );
                      setDialog(null);
                      refresh();
                    })
                  }
                >
                  恢复文档
                </button>
              </div>
            </>
          ) : null}
          {dialog.type === "versions" ? (
            <div className="note-versions">
              <div>
                {versions.length ? (
                  versions.map((v) => (
                    <button
                      key={v.revision}
                      className={
                        version?.revision === v.revision ? "active" : ""
                      }
                      onClick={() =>
                        act(async () =>
                          setVersion(
                            (
                              await api(
                                `/api/notes/documents/${doc.id}/versions/${v.revision}`,
                              )
                            ).version,
                          ),
                        )
                      }
                    >
                      <strong>版本 {v.revision}</strong>
                      <span>{time(v.createdAt)}</span>
                    </button>
                  ))
                ) : (
                  <p>暂无历史版本，修改后会自动保留。</p>
                )}
              </div>
              {version ? (
                <section>
                  <div
                    className="note-version-preview note-prose"
                    dangerouslySetInnerHTML={{ __html: version.body }}
                  />
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await manager.flush();
                        const result = await api(
                          `/api/notes/documents/${doc.id}/versions/${version.revision}`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              revision: manager.get().revision,
                            }),
                          },
                        );
                        accept(result.document);
                        setDialog(null);
                        refresh();
                      })
                    }
                  >
                    恢复此版本（保留当前版本）
                  </button>
                </section>
              ) : (
                <p>选择版本预览内容</p>
              )}
            </div>
          ) : null}
          {dialog.type === "attachments" ? (
            <div className="note-attachment-list">
              {attachments.length ? (
                attachments.map((a) => (
                  <a
                    key={a.id}
                    href={`/api/notes/attachments/${a.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Paperclip />
                    <span>{a.name}</span>
                    <small>{Math.ceil(a.size / 1024)} KB</small>
                  </a>
                ))
              ) : (
                <p>还没有附件，点击编辑器中的回形针上传。</p>
              )}
            </div>
          ) : null}
          {dialog.type === "recovery" ? (
            <>
              <p>
                此浏览器标签页保留了一份未保存的修改。恢复草稿不会直接覆盖服务器版本。
              </p>
              <div className="dialog-actions">
                <button
                  className="ghost"
                  onClick={() => {
                    clearDraft(doc.id);
                    setDialog(null);
                  }}
                >
                  保留服务器版本
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    patch({
                      title: dialog.draft.title,
                      body: dialog.draft.body,
                      tags: dialog.draft.tags || [],
                    });
                    setTagText((dialog.draft.tags || []).join("、"));
                    setEditorEpoch((n) => n + 1);
                    setDialog(null);
                  }}
                >
                  恢复草稿
                </button>
              </div>
            </>
          ) : null}
        </Dialog>
      ) : null}
    </section>
  );
}

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FileText,
  MoreHorizontal,
  Plus,
  Star,
  Trash2,
} from "lucide-react";

// Children are fetched only for expanded branches, 50 at a time, with no polling.
export default function NoteTree({
  items,
  api,
  book,
  revision,
  active,
  busy,
  onOpen,
  onCreate,
  onPlace,
  onDelete,
  collapseKey = 0,
  depth = 0,
}) {
  return (
    <div className="note-tree" role="list">
      {items.map((item, index) => (
        <NoteTreeItem
          key={item.id}
          {...{
            item,
            index,
            items,
            api,
            book,
            revision,
            active,
            busy,
            onOpen,
            onCreate,
            onPlace,
            onDelete,
            collapseKey,
            depth,
          }}
        />
      ))}
    </div>
  );
}
function NoteTreeItem(props) {
  const {
    item,
    index,
    items,
    api,
    book,
    revision,
    active,
    busy,
    onOpen,
    onCreate,
    onPlace,
    onDelete,
    collapseKey,
    depth,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setExpanded(false);
  }, [collapseKey]);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      notebookId: book,
      parentId: item.id,
      page: String(page),
      view: "all",
    });
    api(`/api/notes/documents?${query}`, { signal: controller.signal })
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((e) => {
        if (alive && e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [expanded, book, item.id, page, revision, retry]);
  const selected = active?.id === item.id;
  const title = selected ? active.title : item.title;
  const childItems = data?.documents || [];
  return (
    <div role="listitem" className="note-tree-branch">
      <div
        className={`notes-doc-row ${selected ? "active" : ""}`}
        style={{ paddingLeft: Math.min(depth, 6) * 12 }}
        draggable={!busy}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-nurossh-note", item.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("application/x-nurossh-note"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const source = items.find(
            (value) =>
              value.id ===
              event.dataTransfer.getData("application/x-nurossh-note"),
          );
          if (source && source.id !== item.id)
            onPlace(source, item.position - 0.25);
        }}
      >
        {item.hasChildren ? (
          <button
            className="note-tree-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"}子文档：${title}`}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight />
          </button>
        ) : (
          <span className="note-tree-spacer" />
        )}
        <button
          className="notes-doc-item"
          title={title}
          disabled={busy}
          aria-current={selected ? "page" : undefined}
          onClick={() => onOpen(item.id)}
        >
          <FileText />
          <span>
            <strong>{title}</strong>
          </span>
          {(selected ? active.favorite : item.favorite) ? (
            <Star size={12} />
          ) : null}
        </button>
        <details className="note-row-order">
          <summary aria-label={`${title} 的目录操作`}>
            <MoreHorizontal />
          </summary>
          <div
            onClick={(event) => {
              if (event.target.closest("button"))
                event.currentTarget.closest("details").open = false;
            }}
          >
            <button
              disabled={busy || depth >= 11}
              onClick={() => {
                setExpanded(true);
                onCreate(item);
              }}
            >
              <Plus />
              新建子文档
            </button>
            <button
              disabled={busy || index === 0}
              onClick={() => onPlace(item, items[index - 1].position - 0.5)}
            >
              <ArrowUp />
              上移
            </button>
            <button
              disabled={busy || index === items.length - 1}
              onClick={() => onPlace(item, items[index + 1].position + 0.5)}
            >
              <ArrowDown />
              下移
            </button>
            <button
              className="danger-text-button"
              disabled={busy}
              onClick={() => onDelete(selected ? { ...item, ...active } : item)}
            >
              <Trash2 />
              移入回收站
            </button>
          </div>
        </details>
      </div>
      {expanded ? (
        <div className="note-tree-children">
          {loading ? (
            <p className="note-tree-status">正在读取…</p>
          ) : error ? (
            <button
              className="note-tree-status"
              onClick={() => setRetry((n) => n + 1)}
            >
              读取失败，点击重试
            </button>
          ) : (
            <>
              <NoteTree {...props} items={childItems} depth={depth + 1} />
              {!childItems.length ? (
                <button
                  className="note-tree-status"
                  disabled={busy}
                  onClick={() => onCreate(item)}
                >
                  添加子文档
                </button>
              ) : null}
              {data?.pages > 1 ? (
                <div className="notes-pagination">
                  <button
                    disabled={page === 1}
                    onClick={() => setPage((n) => n - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {page}/{data.pages}
                  </span>
                  <button
                    disabled={page >= data.pages}
                    onClick={() => setPage((n) => n + 1)}
                  >
                    下一页
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

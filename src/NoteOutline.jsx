import { memo, useMemo } from "react";
import { ChevronRight, X } from "lucide-react";

export default memo(function NoteOutline({ headings, onClose, onNavigate, onToggle, onToggleAll }) {
  const rows = useMemo(() => {
    const result = [];
    let hiddenBelow = null;
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (hiddenBelow !== null && h.level > hiddenBelow) continue;
      hiddenBelow = null;
      const children = headings[i + 1]?.level > h.level;
      result.push({ ...h, children });
      if (h.collapsed) hiddenBelow = h.level;
    }
    return result;
  }, [headings]);
  return (
    <aside className="note-outline" aria-label="文档大纲">
      <div className="note-outline-head">
        <strong>文档大纲</strong>
        <button className="icon-button" aria-label="关闭大纲" onClick={onClose}>
          <X />
        </button>
      </div>
      {headings.length ? (
        <>
          <div className="note-outline-actions">
            <button onClick={() => onToggleAll?.(headings, false)}>全部展开</button>
            <button onClick={() => onToggleAll?.(headings, true)}>全部收起</button>
          </div>
          <nav>
            {rows.map((h) => (
              <div
                className="note-outline-row"
                key={h.pos}
                style={{ paddingLeft: (h.level - 1) * 10 }}
              >
                {h.children || h.foldable ? (
                  <button
                    className="note-tree-toggle"
                    aria-label={`${h.collapsed ? "展开" : "收起"}标题内容：${h.text}`}
                    aria-expanded={!h.collapsed}
                    onClick={() => onToggle?.(h, !h.collapsed)}
                  >
                    <ChevronRight />
                  </button>
                ) : (
                  <span className="note-tree-spacer" />
                )}
                <button
                  className="note-outline-link"
                  onClick={() => onNavigate(h)}
                >
                  {h.text || "未命名标题"}
                </button>
              </div>
            ))}
          </nav>
        </>
      ) : (
        <p>添加标题后自动生成大纲</p>
      )}
    </aside>
  );
});

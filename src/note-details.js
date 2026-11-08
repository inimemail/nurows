import { Node, mergeAttributes } from "@tiptap/core";

export const NoteDetails = Node.create({
  name: "details",
  group: "block",
  content: "summary block*",
  defining: true,
  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute("open"),
        renderHTML: (attrs) => (attrs.open ? { open: "" } : {}),
      },
    };
  },
  parseHTML: () => [{ tag: "details" }],
  renderHTML: ({ HTMLAttributes }) => [
    "details",
    mergeAttributes(HTMLAttributes),
    0,
  ],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "note-details";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.contentEditable = "false";
      toggle.className = "note-details-toggle";
      toggle.textContent = "›";
      const label = document.createElement("span");
      label.className = "note-details-label";
      label.contentEditable = "false";
      const contentDOM = document.createElement("div");
      contentDOM.className = "note-details-content";
      dom.append(toggle, label, contentDOM);
      const sync = () => {
        dom.dataset.open = String(current.attrs.open);
        label.textContent = current.firstChild?.textContent || "折叠内容";
        toggle.setAttribute("aria-expanded", String(current.attrs.open));
        toggle.setAttribute(
          "aria-label",
          current.attrs.open ? "收起折叠内容" : "展开折叠内容",
        );
      };
      toggle.onmousedown = (event) => event.preventDefault();
      toggle.onclick = () => {
        if (!editor.isEditable) return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        const chain = editor.chain().focus();
        if (current.attrs.open) chain.setTextSelection(pos + 2);
        chain
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, {
              ...current.attrs,
              open: !current.attrs.open,
            });
            return true;
          })
          .run();
      };
      sync();
      return {
        dom,
        contentDOM,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          sync();
          return true;
        },
        stopEvent: (event) => toggle.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" &&
          !contentDOM.contains(mutation.target),
        destroy() {
          toggle.onclick = toggle.onmousedown = null;
        },
      };
    };
  },
});

export const NoteSummary = Node.create({
  name: "summary",
  content: "inline*",
  defining: true,
  addAttributes() {
    return {
      level: {
        default: null,
        parseHTML: (element) => Number(element.getAttribute("data-note-heading-level")) || null,
        renderHTML: (attrs) => attrs.level ? { "data-note-heading-level": attrs.level } : {},
      },
    };
  },
  parseHTML: () => [{ tag: "summary" }],
  renderHTML: ({ HTMLAttributes }) => ["summary", mergeAttributes(HTMLAttributes), 0],
});

export function collectNoteHeadings(doc) {
  const headings = [];
  doc.descendants((node, pos) => {
    const foldedHeading = node.type.name === "summary" && Number(node.attrs.level) >= 1 && Number(node.attrs.level) <= 6;
    if (node.type.name !== "heading" && !foldedHeading) return;
    const $pos = doc.resolve(pos);
    const details = foldedHeading
      ? $pos.parent
      : $pos.parent.type.name === "summary" && $pos.depth > 0
        ? $pos.node($pos.depth - 1)
        : null;
    let foldable = foldedHeading && details?.type.name === "details" && details.childCount > 1;
    if (!foldable && node.type.name === "heading") {
      const index = $pos.index();
      for (let i = index + 1; i < $pos.parent.childCount; i++) {
        const sibling = $pos.parent.child(i);
        if (sibling.type.name === "heading" && sibling.attrs.level <= node.attrs.level) break;
        foldable = true;
        break;
      }
    }
    headings.push({
      text: node.textContent,
      level: foldedHeading ? Number(node.attrs.level) : node.attrs.level,
      pos,
      collapsed: Boolean(details?.type.name === "details" && !details.attrs.open),
      foldable,
    });
  });
  return headings;
}

export function setHeadingSectionCollapsed(tr, pos, collapsed) {
  const heading = tr.doc.nodeAt(pos);
  const foldedHeading = heading?.type.name === "summary" && Number(heading.attrs.level) >= 1 && Number(heading.attrs.level) <= 6;
  if (heading?.type.name !== "heading" && !foldedHeading) return false;
  const $pos = tr.doc.resolve(pos);
  const parent = $pos.parent;

  if (foldedHeading) {
    const detailsDepth = $pos.depth;
    const details = parent;
    if (details.type.name === "details") {
      if (Boolean(!details.attrs.open) === collapsed) return false;
      tr.setNodeMarkup($pos.before(detailsDepth), undefined, {
        ...details.attrs,
        open: !collapsed,
      });
      return true;
    }
  }
  if (!collapsed) return false;

  const index = $pos.index();
  const section = [];
  let end = pos + heading.nodeSize;
  for (let i = index + 1; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling.type.name === "heading" && sibling.attrs.level <= heading.attrs.level) break;
    section.push(sibling);
    end += sibling.nodeSize;
  }
  const summary = tr.doc.type.schema.nodes.summary.create(
    { level: heading.attrs.level },
    heading.content,
  );
  if (!summary) return false;
  const body = section.length ? section : [tr.doc.type.schema.nodes.paragraph.create()];
  const details = tr.doc.type.schema.nodes.details.create({ open: false }, [summary, ...body]);
  if (!details) return false;
  tr.replaceWith(pos, end, details);
  return true;
}

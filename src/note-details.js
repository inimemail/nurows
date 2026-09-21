import { Node, mergeAttributes } from "@tiptap/core";

export const NoteDetails = Node.create({
  name: "details",
  group: "block",
  content: "summary block+",
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
      const contentDOM = document.createElement("div");
      contentDOM.className = "note-details-content";
      dom.append(toggle, contentDOM);
      const sync = () => {
        dom.dataset.open = String(current.attrs.open);
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
  parseHTML: () => [{ tag: "summary" }],
  renderHTML: () => ["summary", 0],
});

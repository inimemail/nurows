import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { copyNoteText } from "./note-clipboard.js";
import { NoteDetails, NoteSummary } from "./note-details.js";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code2,
  Table2,
  Link,
  Paperclip,
  Undo2,
  Redo2,
  Minus,
  ChevronDown,
  Copy,
} from "lucide-react";

const lowlight = createLowlight(common);
const SafeImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el) =>
          /^\/api\/notes\/attachments\/[a-f0-9-]{36}$/.test(
            el.getAttribute("src") || "",
          )
            ? el.getAttribute("src")
            : null,
      },
    };
  },
});
const actions = [
  ["粗体", Bold, (e) => e.chain().focus().toggleBold().run(), "bold"],
  ["斜体", Italic, (e) => e.chain().focus().toggleItalic().run(), "italic"],
  [
    "无序列表",
    List,
    (e) => e.chain().focus().toggleBulletList().run(),
    "bulletList",
  ],
  [
    "有序列表",
    ListOrdered,
    (e) => e.chain().focus().toggleOrderedList().run(),
    "orderedList",
  ],
  [
    "待办清单",
    ListChecks,
    (e) => e.chain().focus().toggleTaskList().run(),
    "taskList",
  ],
  [
    "引用提示",
    Quote,
    (e) => e.chain().focus().toggleBlockquote().run(),
    "blockquote",
  ],
  [
    "代码块",
    Code2,
    (e) => e.chain().focus().toggleCodeBlock().run(),
    "codeBlock",
  ],
  [
    "表格",
    Table2,
    (e) =>
      e
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
    "table",
  ],
];
export default function NoteEditor({
  document: doc,
  onChange,
  onOutline,
  onReady,
  onLink,
  onUpload,
  toast,
  disabled = false,
  saved = true,
}) {
  const copyText = (text) =>
    copyNoteText(text)
      .then(() => toast?.("已复制"))
      .catch((error) => toast?.(error.message));
  const callbacks = useRef({ onChange, onOutline, onReady });
  callbacks.current = { onChange, onOutline, onReady };
  const [slash, setSlash] = useState(null),
    [selection, setSelection] = useState(false),
    [, render] = useState(0);
  const outlineTimer = useRef(null),
    upload = useRef(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        link: {
          openOnClick: true,
          protocols: ["http", "https", "mailto"],
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      SafeImage,
      Placeholder.configure({ placeholder: "开始记录，输入 / 插入内容…" }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight }),
      NoteDetails,
      NoteSummary,
    ],
    content: doc.body,
    editable: !disabled,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "note-prose",
        role: "textbox",
        "aria-label": "笔记正文",
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape") setSlash(null);
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      callbacks.current.onChange(e.getHTML());
      const { from, $from } = e.state.selection;
      const text = $from.parent.textBetween(0, $from.parentOffset, " ");
      setSlash(text === "/" ? from : null);
      clearTimeout(outlineTimer.current);
      outlineTimer.current = setTimeout(() => {
        const headings = [];
        e.state.doc.descendants((node, pos) => {
          if (node.type.name === "heading")
            headings.push({
              text: node.textContent,
              level: node.attrs.level,
              pos,
            });
        });
        callbacks.current.onOutline(headings);
      }, 350);
    },
    onSelectionUpdate: ({ editor: e }) => {
      setSelection(!e.state.selection.empty);
      render((n) => n + 1);
    },
    onCreate: ({ editor: e }) => {
      callbacks.current.onReady(e);
      const headings = [];
      e.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading")
          headings.push({
            text: node.textContent,
            level: node.attrs.level,
            pos,
          });
      });
      callbacks.current.onOutline(headings);
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [disabled, editor]);
  useEffect(() => {
    if (
      !saved ||
      !editor ||
      editor.view.composing ||
      editor.getHTML() === doc.body
    )
      return;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(doc.body, { emitUpdate: false });
    const end = editor.state.doc.content.size;
    editor.commands.setTextSelection({
      from: Math.min(from, end),
      to: Math.min(to, end),
    });
  }, [doc.revision, saved, editor]);
  useEffect(() => () => clearTimeout(outlineTimer.current), []);
  if (!editor) return null;
  function insert(action) {
    if (slash)
      editor
        .chain()
        .focus()
        .deleteRange({ from: slash - 1, to: slash })
        .run();
    setSlash(null);
    action(editor);
  }
  return (
    <>
      <div className="note-formatbar" aria-label="格式工具栏">
        <select
          aria-label="段落格式"
          disabled={disabled}
          value={
            [1, 2, 3, 4, 5, 6].find((level) =>
              editor.isActive("heading", { level }),
            ) || 0
          }
          onChange={(e) =>
            Number(e.target.value)
              ? editor
                  .chain()
                  .focus()
                  .toggleHeading({ level: Number(e.target.value) })
                  .run()
              : editor.chain().focus().setParagraph().run()
          }
        >
          <option value="0">正文</option>
          <option value="1">标题 1</option>
          <option value="2">标题 2</option>
          <option value="3">标题 3</option>
          <option value="4">标题 4</option>
          <option value="5">标题 5</option>
          <option value="6">标题 6</option>
        </select>
        {actions.map(([label, Icon, action, active]) => (
          <button
            key={label}
            title={label}
            aria-label={label}
            aria-pressed={editor.isActive(active)}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => action(editor)}
          >
            <Icon />
          </button>
        ))}
        <button
          title="插入链接"
          aria-label="插入链接"
          disabled={disabled}
          onClick={() => onLink(editor)}
        >
          <Link />
        </button>
        <button
          title="图片或附件"
          aria-label="图片或附件"
          disabled={disabled}
          onClick={() => upload.current.click()}
        >
          <Paperclip />
        </button>
        <button
          title="折叠内容"
          aria-label="折叠内容"
          disabled={disabled}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertContent(
                "<details><summary>点击展开</summary><p>折叠内容</p></details>",
              )
              .run()
          }
        >
          <ChevronDown />
        </button>
        <button
          title="分隔线"
          aria-label="分隔线"
          disabled={disabled}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          <Minus />
        </button>
        <button
          title="撤销"
          aria-label="撤销"
          disabled={disabled || !editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 />
        </button>
        <button
          title="重做"
          aria-label="重做"
          disabled={disabled || !editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 />
        </button>
        <input
          hidden
          ref={upload}
          type="file"
          onChange={(e) => {
            const file = e.target.files[0];
            e.target.value = "";
            if (file) onUpload(file, editor);
          }}
        />
      </div>
      {editor.isActive("table") ? (
        <div className="note-context-tools">
          {[
            ["加行", "addRowAfter"],
            ["加列", "addColumnAfter"],
            ["删除行", "deleteRow"],
            ["删除列", "deleteColumn"],
            ["删除表格", "deleteTable"],
          ].map(([label, command]) => (
            <button
              key={command}
              disabled={disabled}
              onClick={() => editor.chain().focus()[command]().run()}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {editor.isActive("codeBlock") ? (
        <div className="note-context-tools">
          <button
            onClick={() =>
              copyText(editor.state.selection.$from.parent.textContent)
            }
          >
            <Copy />
            复制代码
          </button>
          <select
            aria-label="代码语言"
            value={editor.getAttributes("codeBlock").language || ""}
            onChange={(event) =>
              editor
                .chain()
                .focus()
                .updateAttributes("codeBlock", {
                  language: event.target.value || null,
                })
                .run()
            }
          >
            <option value="">自动识别</option>
            {[
              "bash",
              "javascript",
              "typescript",
              "json",
              "python",
              "yaml",
              "sql",
              "css",
              "xml",
            ].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {selection ? (
        <div className="note-context-tools" aria-label="选中文字操作">
          <button onClick={() => editor.chain().focus().toggleBold().run()}>
            加粗
          </button>
          <button onClick={() => onLink(editor)}>添加链接</button>
          <button
            onClick={() =>
              copyText(
                editor.state.doc.textBetween(
                  editor.state.selection.from,
                  editor.state.selection.to,
                  "\n",
                ),
              )
            }
          >
            <Copy />
            复制文字
          </button>
        </div>
      ) : null}
      <EditorContent editor={editor} />
      {slash ? (
        <div className="note-slash-menu">
          <strong>插入内容</strong>
          {actions.slice(2).map(([label, Icon, action]) => (
            <button
              key={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(action)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

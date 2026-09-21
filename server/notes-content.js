import sanitizeHtml from "sanitize-html";
export const NOTE_BODY_LIMIT = 1024 * 1024;
export function noteError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export function noteText(value, max = 200) {
  if (typeof value !== "string" || value.length > max)
    throw noteError(`文本长度不能超过 ${max} 个字符`);
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
}
export function noteBody(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > NOTE_BODY_LIMIT)
    throw noteError("正文不能超过 1 MB");
  return sanitizeHtml(value, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "h4",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "img",
      "span",
      "div",
      "label",
      "input",
      "details",
      "summary",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title"],
      code: ["class"],
      ul: ["data-type"],
      li: ["data-type", "data-checked"],
      input: ["type", "checked", "disabled"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: "a",
        attribs: {
          ...attrs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
      input: (_tag, attrs) => ({
        tagName: "input",
        attribs: {
          type: "checkbox",
          disabled: "",
          ...(Object.hasOwn(attrs, "checked") ? { checked: "" } : {}),
        },
      }),
    },
    exclusiveFilter: (frame) =>
      frame.tag === "img" &&
      !/^\/api\/notes\/attachments\/[a-f0-9-]{36}$/.test(
        frame.attribs.src || "",
      ),
  });
}
export function bodyText(body) {
  return sanitizeHtml(
    body.replace(/<\/(p|h[1-4]|li|tr|pre|blockquote)>/g, " </$1>"),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

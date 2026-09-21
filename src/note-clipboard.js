export async function copyNoteText(value) {
  const text = String(value ?? "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // HTTP deployments and browsers with denied clipboard permission need a fallback.
  }
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.cssText =
    "position:fixed;left:-9999px;top:0;opacity:0;font-size:16px";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("copy denied");
  } catch {
    throw new Error("浏览器未允许复制，请选中文字后手动复制");
  } finally {
    input.remove();
    active?.focus?.({ preventScroll: true });
    if (selection && ranges.length) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

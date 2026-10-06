export function isTerminalSubmitKey(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing
    && !event.nativeEvent?.isComposing && event.keyCode !== 229;
}

export function canAutoFocusTerminal(doc = document, win = window) {
  if (win.matchMedia('(max-width: 760px)').matches || doc.querySelector('[aria-modal="true"]')) return false;
  return !doc.activeElement?.isContentEditable && !doc.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
}

// Read only when requested, bounded even with long-lived terminal sessions.
export function terminalCopyText(terminal, lineLimit = 2000) {
  if (terminal.hasSelection()) return terminal.getSelection();
  const buffer = terminal.buffer.active;
  const end = buffer.type === 'alternate' ? buffer.length : Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
  const lines = [];
  const start = Math.max(0, end - lineLimit);
  let line = start < end ? buffer.getLine(start) : null;
  for (let i = start; i < end; i++) {
    const next = i + 1 < end ? buffer.getLine(i + 1) : null;
    if (line) {
      const text = line.translateToString(!next?.isWrapped);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    line = next;
  }
  return lines.join('\n');
}

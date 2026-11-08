import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { pasteNoteImages } from '../src/note-clipboard.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/note-clipboard.js', import.meta.url), 'utf8'), { format: 'cjs' }).code;
function clipboardHarness(clipboard, allowed = true) {
  const copies = [], focus = [], selected = [], removed = [];
  let attached;
  const ranges = [{ id: 'previous-selection' }];
  const selection = { rangeCount: 1, getRangeAt: () => ({ cloneRange: () => ranges[0] }), removeAllRanges() { selected.push('clear'); }, addRange(range) { selected.push(range); } };
  const document = {
    activeElement: { focus(options) { focus.push(options); } },
    body: { append(element) { attached = element; } },
    createElement: () => ({ style: {}, select() { selected.push('temporary-input'); }, remove() { removed.push(this); } }),
    execCommand(command) { assert.equal(command, 'copy'); copies.push(attached.value); return allowed; }
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, navigator: { clipboard }, document, window: { getSelection: () => selection } });
  return { copy: module.exports.copyNoteText, copies, focus, selected, removed, ranges };
}

test('secure clipboard copies multiline IPs without changing focus or selection', async () => {
  const written = [];
  const view = clipboardHarness({ async writeText(value) { written.push(value); } });
  await view.copy('192.0.2.1\n2001:db8::1');
  assert.deepEqual(written, ['192.0.2.1\n2001:db8::1']);
  assert.equal(view.copies.length, 0);
  assert.equal(view.focus.length, 0);
});

test('HTTP and denied clipboard permission fall back to copy and restore focus and previous selection', async () => {
  for (const clipboard of [undefined, { async writeText() { throw Error('denied'); } }]) {
    const view = clipboardHarness(clipboard);
    const text = Array.from({ length: 5000 }, (_, i) => `2001:db8::${(i + 1).toString(16)}`).join('\n');
    await view.copy(text);
    assert.deepEqual(view.copies, [text]);
    assert.equal(view.removed.length, 1);
    assert.equal(view.focus[0].preventScroll, true);
    assert.deepEqual(view.selected, ['temporary-input', 'clear', view.ranges[0]]);
  }
});

test('denied fallback reports a useful error and still removes temporary input and restores focus', async () => {
  const view = clipboardHarness(undefined, false);
  await assert.rejects(view.copy('192.0.2.1'), /手动复制/);
  assert.equal(view.removed.length, 1);
  assert.equal(view.focus.length, 1);
});

test('image paste uploads clipboard files while internal note images keep their attachment URLs', async () => {
  const files = [
    { name: 'one.png', type: 'image/png' },
    { name: 'two.jpg', type: 'image/jpeg' },
  ];
  let prevented = 0;
  const event = {
    clipboardData: {
      items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: () => '',
    },
    preventDefault: () => prevented++,
  };
  const uploaded = [];
  assert.equal(pasteNoteImages(event, { isEditable: true }, async file => uploaded.push(file), () => {}), true);
  for (let i = 0; i < 20 && uploaded.length < files.length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prevented, 1);
  assert.deepEqual(uploaded, files);

  const internal = { ...event, clipboardData: { items: event.clipboardData.items, getData: () => '<img src="/api/notes/attachments/12345678-1234-1234-1234-123456789abc">' } };
  assert.equal(pasteNoteImages(internal, { isEditable: true }, async () => assert.fail('internal images are cloned by the server'), () => {}), false);
});

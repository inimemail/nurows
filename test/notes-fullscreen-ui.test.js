import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/notes.css', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../src/NotesWorkspace.jsx', import.meta.url), 'utf8');
function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing rule: ${selector}`);
  return css.slice(start, css.indexOf('}', start) + 1);
}

test('portaled note dialogs and feedback appear above the fullscreen workspace', () => {
  const z = selector => Number(rule(selector).match(/z-index:\s*(\d+)/)[1]);
  const fullscreen = z('.notes-workspace.notes-fullscreen');
  const dialog = z('.dialog-backdrop:has(> .note-dialog)');
  assert.ok(dialog > fullscreen);
  assert.ok(z('body:has(.notes-fullscreen, .note-dialog) .toast-stack') > dialog);
  assert.match(workspace, /className="note-dialog"/);
});

test('fullscreen bounds the editor and owns scrolling instead of the locked page', () => {
  assert.match(rule('.notes-fullscreen > .notes-layout'), /min-height:\s*0/);
  assert.match(rule('.notes-fullscreen .notes-editor'), /min-height:\s*0/);
  assert.match(rule('.notes-fullscreen .note-writing-layout'), /display:\s*flex/);
  assert.match(rule('.notes-fullscreen .note-writing-scroll'), /overflow:\s*auto/);
  assert.match(rule('.notes-fullscreen .note-writing-scroll'), /overscroll-behavior:\s*contain/);
});

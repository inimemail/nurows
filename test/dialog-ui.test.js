import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const compiled = transformSync(fs.readFileSync(new URL('../src/Dialog.jsx', import.meta.url), 'utf8'), {
  loader: 'jsx', format: 'cjs', jsx: 'automatic'
}).code;

function renderDialog() {
  const effects = [], listeners = new Map();
  let dismissed = 0;
  const document = { body: {}, activeElement: null, querySelectorAll: () => [element],
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name) };
  const focusable = () => ({ isConnected: true, disabled: false, tabIndex: 0,
    getClientRects: () => [1], focus() { document.activeElement = this; } });
  const trigger = focusable(), first = focusable(), last = focusable();
  const hidden = { ...focusable(), getClientRects: () => [] };
  const element = { focus() { document.activeElement = this; }, contains: (target) => [element, first, last].includes(target),
    querySelectorAll: () => [hidden, first, { ...focusable(), disabled: true }, last] };
  document.activeElement = trigger;
  const module = { exports: {} };
  let portalTarget, tree, refs = 0;
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, { document, module, exports: module.exports, require(name) {
    if (name === 'react') return { useEffect: (effect) => effects.push(effect), useId: () => 'title-id', useRef: (initial) => ({ current: refs++ === 0 ? element : initial }) };
    if (name === 'react-dom') return { createPortal(content, target) { portalTarget = target; tree = content; return content; } };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    throw Error(`Unexpected import ${name}`);
  } });
  module.exports.default({ title: '动态 IP 守护', onClose: () => dismissed++, footer: 'Save', children: 'Form' });
  const cleanup = effects[0]();
  const key = (value, shiftKey = false) => { let prevented = false; listeners.get('keydown')({ key: value, shiftKey, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };
  return { document, element, first, last, trigger, portalTarget, tree, key, cleanup, listeners, dismissed: () => dismissed };
}

test('dialog mounts at document body, outside clipped or filtered workspace surfaces', () => {
  const view = renderDialog();
  assert.equal(view.portalTarget, view.document.body);
  const props = view.tree.props.children.props;
  assert.equal(props.role, 'dialog');
  assert.equal(props['aria-modal'], 'true');
  assert.equal(props['aria-labelledby'], 'title-id');
  assert.equal(view.document.activeElement, view.element);
  view.cleanup();
});

test('keyboard navigation stays in the modal and closing restores focus to its trigger', () => {
  const view = renderDialog();
  assert.equal(view.key('Tab'), true);
  assert.equal(view.document.activeElement, view.first);
  view.key('Tab', true);
  assert.equal(view.document.activeElement, view.last);
  view.key('Tab');
  assert.equal(view.document.activeElement, view.first);
  view.key('Escape');
  assert.equal(view.dismissed(), 1);
  view.cleanup();
  assert.equal(view.document.activeElement, view.trigger);
  assert.equal(view.listeners.size, 0);
});

test('only the topmost dialog handles Escape and focus trapping', () => {
  const view = renderDialog();
  view.document.querySelectorAll = () => [view.element, {}];
  assert.equal(view.key('Escape'), false);
  assert.equal(view.dismissed(), 0);
  view.cleanup();
});

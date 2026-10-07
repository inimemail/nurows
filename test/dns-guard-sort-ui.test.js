import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as ordering from '../shared/dns-guard-order.js';
import * as search from '../shared/workspace-search.js';
import { orchestrationDefaults } from '../server/orchestration.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/GuardSortableList.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(api = async () => ({ dnsGuardOrder: ['b', 'a', 'c'] })) {
  const slots = [], effects = [], frames = new Map(), listeners = new Map();
  let cursor = 0, frameId = 0, layoutReads = 0, state = { dnsGuardOrder: [] };
  const items = ['a', 'b', 'c'].map(id => ({ id, name: id }));
  const scroller = { scrollTop: 0, clientHeight: 220, scrollHeight: 800, parentElement: null, getBoundingClientRect: () => ({ top: 0, bottom: 220 }) };
  const root = { parentElement: scroller, querySelectorAll: () => props.items.map((item, i) => ({ dataset: { guardSortId: item.id }, getBoundingClientRect: () => { layoutReads++; return { top: i * 70 - scroller.scrollTop, bottom: (i + 1) * 70 - scroller.scrollTop }; } })) };
  const flags = [], messages = [];
  const react = {
    useState: initial => { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useRef: initial => { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo: fn => fn(),
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } }
  };
  const module = { exports: {} };
  const events = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const document = { ...events, scrollingElement: scroller, hidden: false };
  vm.runInNewContext(compiled, { module, exports: module.exports, document, window: { ...events, innerHeight: 220 }, getComputedStyle: () => ({ overflowY: 'auto' }),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    require: name => name === 'react' ? react : name === 'lucide-react' ? { GripVertical: 'grip-icon' } : name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : ordering });
  const props = { items, records: items, order: [], scope: '', api, onState: fn => { state = fn(state); props.order = state.dnsGuardOrder; }, toast: value => messages.push(value), onSaving: value => flags.push(value), children: item => item.name };
  const render = () => { cursor = 0; const tree = module.exports.default(props); tree.props.ref.current = root; effects.splice(0).forEach(fn => fn()); return tree; };
  const handle = (tree, i) => tree.props.children[i].props.children[0].props;
  const event = (y, pointerType = 'touch') => ({ pointerId: 1, pointerType, button: 0, clientX: 10, clientY: y, preventDefault() {}, currentTarget: { setPointerCapture() {} } });
  return { render, handle, event, props, frames, flags, messages, scroller, listeners, document, layoutReads: () => layoutReads, state: () => state, unmount: () => slots.forEach(slot => slot.cleanup?.()) };
}

test('touch and mouse save only on drop, preserve actions, and disable repeated saves', async () => {
  for (const type of ['touch', 'mouse']) {
    const calls = [];
    let resolve;
    const h = harness((...args) => { calls.push(args); return new Promise(done => { resolve = done; }); });
    const button = h.handle(h.render(), 0);
    button.onPointerDown(h.event(35, type));
    button.onPointerMove(h.event(125, type));
    assert.equal(calls.length, 0);
    button.onPointerUp(h.event(125, type));
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).targetId, 'b');
    assert.equal(JSON.parse(calls[0][1].body).placement, 'after');
    const tree = h.render();
    assert.deepEqual(Array.from(tree.props.children, row => row.props.children[1]), ['b', 'a', 'c']);
    assert.equal(h.handle(tree, 0).disabled, true);
    button.onPointerUp(h.event(125, type));
    assert.equal(calls.length, 1);
    resolve({ dnsGuardOrder: ['b', 'a', 'c'] });
    await new Promise(setImmediate);
    assert.deepEqual(Array.from(h.state().dnsGuardOrder), ['b', 'a', 'c']);
    assert.deepEqual(h.flags, [true, false]);
    assert.equal(h.frames.size, 0);
  }
});

test('cancellation, tap and changing search never save; keyboard errors restore previous order', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('offline'); });
  let button = h.handle(h.render(), 0);
  button.onPointerDown(h.event(35)); button.onPointerUp(h.event(35));
  button.onPointerDown(h.event(35)); button.onPointerMove(h.event(180)); button.onPointerCancel(); button.onPointerUp(h.event(180));
  button.onPointerDown(h.event(35)); button.onPointerMove(h.event(180));
  h.props.scope = 'new search'; h.render(); button.onPointerUp(h.event(180));
  assert.equal(calls, 0); assert.equal(h.frames.size, 0);
  button = h.handle(h.render(), 0);
  button.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.match(h.messages[0], /offline/);
  assert.deepEqual(Array.from(h.render().props.children, row => row.props.children[1]), ['a', 'b', 'c']);
});

test('dragging near the viewport edge scrolls; cancel stops animation', () => {
  const h = harness();
  const button = h.handle(h.render(), 0);
  button.onPointerDown(h.event(35)); button.onPointerMove(h.event(210));
  const [id, tick] = [...h.frames][0]; h.frames.delete(id); tick(16);
  assert.ok(h.scroller.scrollTop > 0);
  button.onPointerCancel();
  assert.equal(h.frames.size, 0);
});

test('long-list dragging caches row geometry instead of forcing layout for every pointer frame', () => {
  const h = harness();
  h.props.items = h.props.records = Array.from({ length: 1000 }, (_, i) => ({ id: `g${i}`, name: `g${i}` }));
  const button = h.handle(h.render(), 0);
  button.onPointerDown(h.event(35));
  for (let i = 1; i <= 60; i++) {
    button.onPointerMove(h.event(100 + i));
    const [id, tick] = [...h.frames][0]; h.frames.delete(id); tick(i * 16);
  }
  assert.equal(h.layoutReads(), 999);
  button.onPointerCancel();
  assert.equal(h.frames.size, 0);
});

test('new tasks stay visible while saving; deleted tasks never reappear from an optimistic order', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.handle(h.render(), 0).onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  h.props.items = h.props.records = [...h.props.items.filter(item => item.id !== 'c'), { id: 'new', name: 'new' }];
  assert.deepEqual(Array.from(h.render().props.children, row => row.props.children[1]), ['b', 'a', 'new']);
  resolve({ dnsGuardOrder: ['b', 'a', 'c'] });
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(h.render().props.children, row => row.props.children[1]), ['b', 'a', 'new']);
});

test('rejected shared save locks make no request and unmount cancels the drag loop', () => {
  let calls = 0;
  const h = harness(() => { calls++; });
  h.props.onSaving = () => false;
  const button = h.handle(h.render(), 0);
  button.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(calls, 0);
  assert.equal(h.render().props['aria-busy'], false);
  button.onPointerDown(h.event(35)); button.onPointerMove(h.event(180));
  h.unmount();
  button.onPointerUp(h.event(180));
  assert.equal(calls, 0);
  assert.equal(h.frames.size, 0);
});

test('secondary pointers and right-clicks cannot start or finish a sort; cancellation releases touch capture', () => {
  let calls = 0, captured = false, releases = 0;
  const h = harness(() => { calls++; });
  const button = h.handle(h.render(), 0);
  button.onPointerDown({ ...h.event(35, 'mouse'), button: 2 });
  button.onPointerDown({ ...h.event(35), isPrimary: false });
  assert.equal(h.frames.size, 0);
  const event = h.event(35);
  event.currentTarget = { setPointerCapture() { captured = true; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; releases++; } };
  button.onPointerDown(event);
  button.onPointerUp({ ...h.event(180), pointerId: 2 });
  assert.equal(calls, 0);
  assert.equal(captured, true);
  button.onPointerCancel();
  assert.equal(captured, false);
  assert.equal(releases, 1);
  assert.equal(h.frames.size, 0);
});

test('losing focus, rotating the screen and hiding the page cancel the drag and clean up listeners', () => {
  const h = harness(() => assert.fail('canceled drag must not save'));
  const button = h.handle(h.render(), 0);
  for (const type of ['blur', 'resize', 'visibilitychange']) {
    button.onPointerDown(h.event(35)); button.onPointerMove(h.event(180));
    h.document.hidden = type === 'visibilitychange';
    h.listeners.get(type)();
    button.onPointerUp(h.event(180));
    assert.equal(h.frames.size, 0);
  }
  h.unmount();
  assert.equal(h.listeners.size, 0);
});

test('workspace polling keeps fresh status without overwriting a saved or pending order', async () => {
  const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  let poll, resolve;
  let state = { ...orchestrationDefaults(), dnsGuards: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], dnsGuardOrder: ['a', 'b'] };
  const hooks = {
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: initial => ({ current: initial }), useMemo: fn => fn(), useEffect: fn => { fn(); }
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, structuredClone, URLSearchParams, window: { location: { search: '?tgSection=guards' } },
    require: name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : name.endsWith('workspace-search.js') ? search : name.endsWith('polling.js') ? { startPolling: callback => { poll = callback; return () => {}; } } : {} });
  const tree = module.exports.default({ tab: 'probes', state, api: () => new Promise(done => { resolve = done; }), onState: fn => { state = fn(state); }, toast() {} });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const sortable = nodes(tree).find(node => node.props?.onSaving);
  assert.ok(sortable);
  const stalePoll = poll();
  sortable.props.onSaving(true);
  state.dnsGuardOrder = ['b', 'a'];
  sortable.props.onSaving(false);
  resolve({ dnsGuardOrder: ['a', 'b'], dnsGuards: [{ id: 'a', status: 'healthy' }, { id: 'b' }] });
  await stalePoll;
  assert.deepEqual(state.dnsGuardOrder, ['b', 'a']);
  assert.equal(state.dnsGuards[0].status, 'healthy');
  sortable.props.onSaving(true);
  const pendingPoll = poll();
  resolve({ dnsGuardOrder: ['a', 'b'] });
  await pendingPoll;
  assert.deepEqual(state.dnsGuardOrder, ['b', 'a']);
  sortable.props.onSaving(false);
  const freshPoll = poll();
  resolve({ dnsGuardOrder: ['a', 'b'] });
  await freshPoll;
  assert.deepEqual(state.dnsGuardOrder, ['a', 'b']);

  // Full-state responses from remote management and edits have the same race.
  const staleRead = sortable.props.api('/api/dns-guards/a/sync');
  sortable.props.onSaving(true);
  state.dnsGuardOrder = ['b', 'a'];
  sortable.props.onSaving(false);
  resolve({ state: { ...state, dnsGuardOrder: ['a', 'b'], dnsGuards: [{ id: 'a', status: 'replaced' }, { id: 'b' }] } });
  sortable.props.onState((await staleRead).state);
  assert.deepEqual(state.dnsGuardOrder, ['b', 'a']);
  assert.equal(state.dnsGuards[0].status, 'replaced');
});

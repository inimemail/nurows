import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { authenticatorRequest } from '../src/authenticator-request.js';

const source = fs.readFileSync(new URL('../src/AuthenticatorWorkspace.jsx', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(api) {
  const slots = [], effects = [], listeners = new Map(), timers = new Map();
  let cursor = 0, nextTimer = 0;
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, n) => value !== slots[i].deps[n])) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, n) => value !== slots[i].deps[n])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } }
  };
  const document = { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const module = { exports: {} };
  let time = Date.now();
  class TestDate extends Date { static now() { return time; } }
  vm.runInNewContext(compiled, { module, exports: module.exports, document, Date: TestDate, Set, Map, JSON, AbortController, DOMException, setTimeout: (fn, delay) => { fn.delay = delay; timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
    require: name => name === 'react' ? react : name === './authenticator-request.js' ? { authenticatorRequest } : name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : name === 'lucide-react' ? new Proxy({}, { get: (_, key) => key }) : {} });
  const props = { api, toast() {}, Dialog() {}, search: '', onSearchScopeChange() {} };
  const render = () => { cursor = 0; const tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); return tree; };
  const find = (node, predicate) => { if (!node || typeof node !== 'object') return null; if (Array.isArray(node)) { for (const value of node) { const result = find(value, predicate); if (result) return result; } return null; } if (predicate(node)) return node; return find(node.props?.children, predicate); };
  const button = (tree, name) => find(tree, node => node.type === 'button' && (node.props['aria-label'] === name || (Array.isArray(node.props.children) && node.props.children.includes(name))));
  return { render, find, button, document, listeners, timers, props, now: () => time, advance: ms => { time += ms; }, unmount: () => slots.forEach(slot => slot.cleanup?.()) };
}
const metadata = { accounts: [{ id: 'a', issuer: 'Example', account: 'alice', note: '', revision: 1, algorithm: 'SHA1', digits: 6, period: 30 }], settings: { idleMinutes: 5 }, serverTime: Date.now() };
const grant = () => ({ ...metadata, token: 'test-token', deadline: Date.now() + 1800000, expiresAt: Date.now() + 300000 });
const settle = () => new Promise(setImmediate);

test('saved vault locks on hiding the page and ordinary countdown ticks do not poll', async () => {
  const calls = [];
  const h = harness(async (path, options) => { calls.push([path, options]); return path.endsWith('/unlock') ? grant() : path.endsWith('/codes') ? { codes: [], serverTime: Date.now() } : metadata; });
  h.render(); await settle();
  h.button(h.render(), '解锁').props.onClick();
  const modal = h.find(h.render(), node => node.type?.name === 'PasswordDialog');
  await modal.props.onSubmit('password');
  assert.ok(h.button(h.render(), '立即锁定'));
  const count = calls.length;
  for (let i = 0; i < 3; i++) { const [id, fn] = h.timers.entries().next().value; h.timers.delete(id); fn(); h.render(); }
  assert.equal(calls.length, count);
  h.document.hidden = true; h.listeners.get('visibilitychange')();
  assert.equal(h.button(h.render(), '立即锁定'), null);
  assert.equal(calls.at(-1)[0], '/api/authenticator/lock');
  h.unmount(); assert.equal(h.timers.size, 0);
});

test('unlock completing after leaving the menu never restores plaintext and revokes its grant', async () => {
  let finish;
  const calls = [];
  const h = harness(async (path, options) => { calls.push([path, options]); if (path.endsWith('/unlock')) return new Promise(resolve => { finish = resolve; }); return metadata; });
  h.render(); await settle(); h.button(h.render(), '解锁').props.onClick();
  const dialog = h.find(h.render(), node => node.type?.name === 'PasswordDialog');
  const unlock = dialog.props.onSubmit('password');
  h.unmount(); finish(grant()); await unlock; await settle();
  assert.equal(calls.at(-1)[0], '/api/authenticator/lock');
  assert.equal(calls.at(-1)[1].headers['X-Authenticator-Unlock'], 'test-token');
  assert.equal(h.timers.size, 0);
});

test('temporary input is not persisted and mobile list does not depend on undefined parent height', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|sendBeacon/);
  assert.match(source, /section: 'authenticator'/);
  assert.doesNotMatch(source, /store\.secrets|secrets\.current/);
  assert.match(source, /current\.get\(item\.id\) === item\.revision/);
  const css = fs.readFileSync(new URL('../src/authenticator.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.authenticator-workspace\.ops-workspace\s*\{[^}]*height: auto/);
  assert.match(css, /\.authenticator-workspace \.authenticator-list\s*\{[^}]*flex: 0 0 auto/);
});

test('first user action after sleep cannot renew an expired local unlock', async () => {
  const calls = [];
  const h = harness(async path => { calls.push(path); return path.endsWith('/unlock') ? grant() : path.endsWith('/codes') ? { codes: [], serverTime: Date.now() } : metadata; });
  h.render(); await settle(); h.button(h.render(), '解锁').props.onClick();
  await h.find(h.render(), node => node.type?.name === 'PasswordDialog').props.onSubmit('password');
  h.advance(300001);
  h.listeners.get('pointerdown')();
  assert.equal(h.button(h.render(), '立即锁定'), null);
  assert.equal(calls.at(-1), '/api/authenticator/lock');
  h.unmount();
});

test('a stale metadata load cannot overwrite an unlocked snapshot after a manual refresh', async () => {
  let initial;
  let loads = 0;
  const h = harness(async path => {
    if (path.endsWith('/unlock')) return grant();
    if (path === '/api/authenticator' && ++loads === 1) return new Promise(resolve => { initial = resolve; });
    return metadata;
  });
  h.render();
  await h.button(h.render(), '刷新验证器').props.onClick();
  h.button(h.render(), '解锁').props.onClick();
  await h.find(h.render(), node => node.type?.name === 'PasswordDialog').props.onSubmit('password');
  initial({ ...metadata, accounts: [] }); await settle();
  const list = h.find(h.render(), node => node.props?.records);
  assert.equal(list.props.records.length, 1);
  assert.ok(h.button(h.render(), '立即锁定'));
  h.unmount();
});

test('requests time out with an operation-specific message and forward cancellation', async () => {
  const hang = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  await assert.rejects(authenticatorRequest(hang, '/api/authenticator/unlock', {}, 5), /刷新确认结果/);
  const controller = new AbortController();
  const request = authenticatorRequest(hang, '/api/authenticator', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('saved codes fetch only the visible page and refresh at expiry without accepting a late hidden-page response', async () => {
  const accounts = Array.from({ length: 55 }, (_, i) => ({ ...metadata.accounts[0], id: `a${i}` }));
  const calls = []; let late;
  const h = harness(async (path, options) => {
    calls.push([path, options]);
    if (path.endsWith('/codes')) {
      if (late === true) return new Promise(resolve => { late = resolve; });
      return { codes: JSON.parse(options.body).ids.map(id => ({ id, revision: 1, code: '123456', validFrom: h.now() - 1000, validUntil: h.now() + 29000 })), serverTime: h.now() };
    }
    return { ...(path.endsWith('/unlock') ? grant() : metadata), accounts };
  });
  h.render(); await settle(); h.button(h.render(), '解锁').props.onClick();
  await h.find(h.render(), node => node.type?.name === 'PasswordDialog').props.onSubmit('password');
  h.render(); await settle(); h.render();
  let codeCalls = calls.filter(([path]) => path.endsWith('/codes'));
  assert.equal(codeCalls.length, 1); assert.equal(JSON.parse(codeCalls[0][1].body).ids.length, 50);
  const list = h.find(h.render(), node => node.props?.records);
  assert.equal(h.find(list.props.children(list.props.items[0]), node => node.type?.name === 'CodeDisplay').props.value.code, '123456');
  assert.ok([...h.timers.values()].some(fn => fn.delay >= 29000 && fn.delay <= 29100));
  h.button(h.render(), '下一页').props.onClick(); h.render(); await settle();
  codeCalls = calls.filter(([path]) => path.endsWith('/codes'));
  assert.deepEqual(JSON.parse(codeCalls.at(-1)[1].body).ids, ['a50', 'a51', 'a52', 'a53', 'a54']);
  late = true;
  const timer = [...h.timers.entries()].find(([, fn]) => fn.delay >= 29000); h.timers.delete(timer[0]); timer[1](); await settle();
  h.document.hidden = true; h.listeners.get('visibilitychange')();
  late({ codes: [{ id: 'a50', revision: 1, code: '654321', validFrom: h.now(), validUntil: h.now() + 30000 }], serverTime: h.now() }); await settle();
  assert.equal(h.button(h.render(), '立即锁定'), null);
  h.unmount(); assert.equal(h.timers.size, 0);
});

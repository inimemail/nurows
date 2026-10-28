import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as epay from '../shared/epay.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/EpayWorkspace.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const fixture = () => ({ accounts: [{ id: 'one', name: '主站', url: 'https://pay.example.com/', pid: '1001', currency: 'CNY', enabled: true, botIds: [], balance: 100, interval: 30 }],
  bots: [], balances: [], summary: [], totals: [], orders: { records: [], total: 0, page: 1, pages: 1 }, notifications: [] });
function harness(api = async () => fixture()) {
  const slots = [], effects = [], messages = [], listeners = new Map();
  let cursor = 0, effectIndex = 0, tree, poll, search = '';
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) { const index = effectIndex++, old = effects[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) effects[index] = { fn, deps, cleanup: old?.cleanup, pending: true }; }
  };
  const jsx = (type, props) => ({ type, props }), module = { exports: {} };
  const document = { hidden: false, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  vm.runInNewContext(compiled, { module, exports: module.exports, document, AbortSignal, AbortController, URL, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {},
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === 'lucide-react') return new Proxy({}, { get: (_target, key) => key });
      if (name.endsWith('epay.js')) return epay;
      if (name.endsWith('RenewalWorkspace.jsx')) return { RenewalBotPicker: 'bot-picker' };
      if (name.endsWith('note-clipboard.js')) return { copyNoteText: async () => {} };
      if (name.endsWith('polling.js')) return { startPolling(fn) { poll = fn; return () => {}; } };
      if (name.endsWith('.css')) return {};
      throw Error(name);
    }
  });
  const render = () => {
    cursor = 0; effectIndex = 0;
    tree = module.exports.default({ api, toast: value => messages.push(value), Dialog: 'dialog', search });
    for (const effect of effects) if (effect.pending) { effect.cleanup?.(); effect.pending = false; effect.cleanup = effect.fn(); }
    return tree;
  };
  function nodes(value = tree) { if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object') return []; return [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)]; }
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = label => nodes().find(node => node.type === 'button' && (text(node).startsWith(label) || node.props['aria-label'] === label));
  render();
  return { render, nodes, button, messages, document, poll: (signal = new AbortController().signal) => poll(signal),
    close() { for (const effect of effects) effect.cleanup?.(); } };
}

test('closing a merchant test aborts I/O and its late completion cannot unlock a newer editor test', async () => {
  const requests = [];
  const view = harness((path, options = {}) => {
    if (!options.method) return Promise.resolve(fixture());
    return new Promise(resolve => requests.push({ path, options, resolve }));
  });
  await view.poll(); view.render(); view.button('添加商户').props.onClick(); view.render();
  const start = view.button('测试连接').props.onClick;
  const first = start(); start(); assert.equal(requests.length, 1);
  view.render(); assert.equal(view.button('测试中…').props.disabled, true);
  view.button('取消').props.onClick(); assert.equal(requests[0].options.signal.aborted, true);
  view.render(); view.button('添加商户').props.onClick(); view.render();
  const second = view.button('测试连接').props.onClick(); view.render();
  requests[0].resolve({ ok: true, message: 'old-test' }); await first; view.render();
  assert.equal(view.button('测试中…').props.disabled, true);
  assert.ok(view.nodes().every(node => node.props?.className !== 'epay-test-result'));
  requests[1].resolve({ ok: true, message: 'new-test' }); await second; view.render();
  assert.equal(view.button('测试连接').props.disabled, false);
  assert.ok(view.nodes().some(node => node.props?.className === 'epay-test-result'));
  view.close();
});

test('order filters never leak into the overview and account polling asks for its lightweight view', async () => {
  const paths = [];
  const view = harness(async path => { paths.push(path); return fixture(); });
  await view.poll(); view.render(); view.button('订单记录').props.onClick(); view.render();
  view.nodes().find(node => node.type === 'select' && node.props.value === '' && node.props.children?.[0]?.props?.children === '全部状态').props.onChange({ target: { value: 'pending' } });
  view.render(); await view.poll(); assert.match(paths.at(-1), /status=pending/);
  view.button('收款总览').props.onClick(); view.render(); await view.poll();
  const overview = new URL(paths.at(-1), 'https://panel.example.com/');
  assert.equal(overview.searchParams.get('status'), ''); assert.equal(overview.searchParams.get('page'), '1');
  view.button('商户账号').props.onClick(); view.render(); await view.poll();
  assert.equal(new URL(paths.at(-1), 'https://panel.example.com/').searchParams.get('view'), 'accounts');
  view.close();
});

test('bulk merchant deletion needs confirmation, snapshots its IDs and ignores a stale read', async () => {
  let pendingRead, readCount = 0, releaseDelete;
  const mutations = [];
  const view = harness((path, options = {}) => {
    if (!options.method) return ++readCount === 1 ? Promise.resolve(fixture()) : new Promise(resolve => { pendingRead = resolve; });
    mutations.push({ path, body: JSON.parse(options.body) });
    return new Promise(resolve => { releaseDelete = resolve; });
  });
  await view.poll(); view.render(); const stale = view.poll();
  view.button('商户账号').props.onClick(); view.render(); view.button('全部删除').props.onClick(); view.render();
  assert.equal(mutations.length, 0);
  const confirm = view.button('确认删除').props.onClick;
  const operation = confirm(); confirm(); assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].body, { confirm: 'delete-records', ids: ['one'] });
  releaseDelete({ deletedCount: 1 }); await operation;
  pendingRead(fixture()); await stale; view.render();
  assert.equal(view.button('全部删除').props.disabled, true);
  assert.ok(view.messages.includes('已删除 1 个商户及其本地订单'));
  view.close();
});

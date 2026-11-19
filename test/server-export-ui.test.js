import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { filterPickerServers } from '../shared/server-picker-search.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/ServerGroupExportDialog.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(api) {
  const slots = [], effects = [], copies = [], messages = [];
  let cursor = 0, tree;
  const props = { group: { id: 'g', name: '本组' }, servers: [
    { id: 'a', groupId: 'g', name: 'Alpha', host: '192.0.2.1', port: 22 },
    { id: 'b', groupId: 'g', name: 'Beta', host: '2001:db8::1', port: 22 },
    { id: 'other', groupId: 'outside', name: 'Other', host: '192.0.2.3', port: 22 }
  ], api, toast: message => messages.push(message), onClose() {} };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, AbortController, JSON, require(path) {
    if (path === 'react') return {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
      useMemo(fn) { return fn(); },
      useEffect(fn, deps) { const i = cursor++; const previous = slots[i]; if (!previous || deps.some((value, j) => value !== previous.deps[j])) effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
    };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path === 'lucide-react') return Object.fromEntries(['Search', 'Server', 'FileText', 'List', 'Copy', 'Download', 'LoaderCircle', 'Check'].map(name => [name, 'svg']));
    if (path.endsWith('server-picker-search.js')) return { filterPickerServers };
    if (path.endsWith('note-clipboard.js')) return { copyNoteText: async text => { copies.push(text); } };
    if (path.endsWith('Dialog.jsx')) return { default: 'dialog', __esModule: true };
    throw Error(path);
  } });
  const render = () => { cursor = 0; tree = module.exports.default(props); while (effects.length) effects.shift()(); };
  const nodes = (value = tree) => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)];
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const output = () => nodes().find(node => node.type === 'textarea');
  const checks = () => nodes().filter(node => node.type === 'input' && node.props.type === 'checkbox');
  const search = query => { nodes().find(node => node.props?.['aria-label'] === '搜索导出服务器').props.onChange({ target: { value: query } }); render(); };
  const mode = value => { nodes().find(node => node.props?.['data-export-mode'] === value).props.onClick(); render(); };
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); render(); };
  render();
  return { render, nodes, props, checks, search, mode, output, button, copies, messages, settle };
}

test('group export defaults to all group members and keeps selections across searches with select/invert/clear', async () => {
  const calls = [];
  const view = harness(async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { text: 'generated', count: JSON.parse(options.body).serverIds.length }; });
  await view.settle();
  assert.deepEqual(calls[0], { path: '/api/groups/g/export', body: { mode: 'import', serverIds: ['a', 'b'] } });
  assert.equal(view.checks().length, 2);
  assert.ok(view.checks().every(node => node.props.checked));
  view.search('Alpha');
  assert.equal(view.checks().length, 1);
  assert.equal(calls.length, 1);
  view.button('反选').props.onClick(); view.render(); await view.settle();
  assert.deepEqual(calls.at(-1).body.serverIds, ['b']);
  view.button('全选').props.onClick(); view.render(); await view.settle();
  assert.deepEqual(calls.at(-1).body.serverIds, ['a', 'b']);
  view.search('');
  view.checks()[0].props.onChange(); view.render(); await view.settle();
  assert.deepEqual(calls.at(-1).body.serverIds, ['b']);
  view.button('清空').props.onClick(); view.render();
  assert.equal(view.output().props.value, '');
  assert.equal(view.button('复制内容').props.disabled, true);
});

test('switching formats and selection ignores old in-flight exports and copies only current output', async () => {
  const pending = [];
  const view = harness((_path, options) => new Promise(resolve => pending.push({ options, resolve })));
  view.mode('ip');
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(view.button('复制内容').props.disabled, true);
  pending[0].resolve({ text: 'old credentials', count: 2 }); await view.settle();
  assert.equal(view.output().props.value, '');
  pending[1].resolve({ text: '192.0.2.1\n2001:db8::1', count: 2 }); await view.settle();
  await view.button('复制内容').props.onClick();
  assert.deepEqual(view.copies, ['192.0.2.1\n2001:db8::1']);
  view.checks()[0].props.onChange(); view.render();
  assert.equal(view.output().props.value, '');
  assert.equal(view.button('复制内容').props.disabled, true);
});

test('export failure allows retry and an empty group makes no credential request', async () => {
  let attempts = 0;
  const view = harness(async () => { attempts++; if (attempts === 1) throw Error('导出失败'); return { text: 'recovered', count: 2 }; });
  await view.settle();
  assert.ok(view.nodes().some(node => node.props?.role === 'alert'));
  view.button('重试').props.onClick(); view.render(); await view.settle();
  assert.equal(attempts, 2);
  assert.equal(view.output().props.value, 'recovered');
  view.props.servers = []; view.render();
  assert.equal(view.output().props.value, '');
  assert.equal(view.button('下载 TXT').props.disabled, true);
  assert.equal(attempts, 2);
});

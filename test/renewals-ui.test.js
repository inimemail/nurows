import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as renewals from '../shared/renewals.js';
import * as searchHelpers from '../shared/workspace-search.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/RenewalWorkspace.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const item = { id: 'one', version: 'v1', name: '香港入口', address: 'hk.example.com', price: '0.00', currency: 'USD', dueDate: '2026-09-24', botIds: ['bot'], note: '备注', notificationError: 'error' };
const fixture = () => ({ renewals: [structuredClone(item)], renewalSettings: { days: [7, 3, 1, 0], time: '09:00' }, renewalRevision: 1, bots: [{ id: 'bot', name: '通知', enabled: true, configured: true, hasRecipients: true }] });
function harness(api = async () => fixture()) {
  const slots = [], effects = [];
  let cursor = 0, tree, poll, search = '';
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useMemo(fn) { return fn(); }, useEffect(fn) { effects.push(fn); }
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} }, document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, structuredClone, document,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === 'lucide-react') return Object.fromEntries(['CalendarClock', 'Plus', 'Settings', 'Trash2', 'Copy', 'Pencil', 'MoreHorizontal', 'X', 'RefreshCw'].map((key) => [key, key]));
      if (name.endsWith('renewals.js')) return renewals;
      if (name.endsWith('workspace-search.js')) return searchHelpers;
      if (name.endsWith('polling.js')) return { startPolling(fn) { poll = fn; return () => {}; } };
      if (name.endsWith('.css')) return {};
      throw Error(name);
    }
  });
  const render = () => { cursor = 0; effects.length = 0; tree = module.exports.default({ state: fixture(), api, search, toast() {}, Dialog: 'dialog' }); return tree; };
  render(); effects.forEach((effect) => effect());
  function nodes(value = tree) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)];
  }
  const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = (label) => nodes().find((node) => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  return { render, nodes, button, exports: module.exports, document, poll: (signal = new AbortController().signal) => poll(signal), data: () => slots[0], setSearch(value) { search = value; render(); } };
}

test('renewal copy preserves selected bots and values but strips identity and reminder state', () => {
  const view = harness();
  const copy = view.exports.duplicateRenewal(item);
  assert.equal(copy.name, ''); assert.equal(copy.address, '');
  for (const key of ['price', 'currency', 'dueDate', 'note']) assert.equal(copy[key], item[key]);
  assert.deepEqual([...copy.botIds], ['bot']);
  for (const key of ['id', 'version', 'notificationError', 'deliveries']) assert.equal(copy[key], undefined);
  copy.botIds.push('other'); assert.deepEqual(item.botIds, ['bot']);
});

test('renewal search limits rendered rows, new entries default to no bots, and triple click opens a copy', async () => {
  const view = harness(); await view.poll(); view.render();
  view.setSearch('missing'); assert.equal(view.nodes().filter((node) => node.type === 'article').length, 0);
  assert.equal(view.data().renewals.length, 1);
  view.setSearch('hk.example');
  const row = view.nodes().find((node) => node.type === 'article');
  row.props.onClick({ detail: 3, target: { closest: () => null } }); view.render();
  let editor = view.nodes().find((node) => node.type === view.exports.RenewalEditor);
  assert.equal(editor.props.value.name, ''); assert.deepEqual([...editor.props.value.botIds], ['bot']);
  view.button('取消').props.onClick(); view.render();
  view.button('添加').props.onClick(); view.render();
  editor = view.nodes().find((node) => node.type === view.exports.RenewalEditor);
  assert.deepEqual([...editor.props.value.botIds], []); assert.equal(editor.props.value.currency, 'CNY');
  assert.equal(editor.props.value.notificationEnabled, true);
});

test('renewal notification checkbox defaults checked for legacy records and preserves opt-out when copied', () => {
  const view = harness();
  let value = structuredClone(item);
  const render = () => view.exports.RenewalEditor({ value, bots: fixture().bots, patch(next) { value = { ...value, ...next }; } });
  const checkbox = () => view.nodes(render()).find((node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkbox().props.checked, true);
  checkbox().props.onChange({ target: { checked: false } });
  assert.equal(checkbox().props.checked, false);
  assert.equal(view.nodes(render()).some((node) => node.type === view.exports.RenewalBotPicker), false);
  assert.equal(view.exports.duplicateRenewal(value).notificationEnabled, false);
  checkbox().props.onChange({ target: { checked: true } });
  assert.equal(view.nodes(render()).some((node) => node.type === view.exports.RenewalBotPicker), true);
  assert.deepEqual(value.botIds, ['bot']);
});

test('renewal mutations suppress double clicks and ignore a late poll; bulk deletion needs confirmation', async () => {
  let pollResolve, mutateResolve;
  const calls = [];
  const view = harness((path, options) => {
    if (!options.method) return pollResolve ? new Promise((resolve) => { pollResolve = resolve; }) : (pollResolve = true, Promise.resolve(fixture()));
    calls.push({ path, body: JSON.parse(options.body) });
    return new Promise((resolve) => { mutateResolve = resolve; });
  });
  await view.poll(); view.render();
  const pendingPoll = view.poll();
  view.button('全部删除').props.onClick(); view.render();
  assert.equal(calls.length, 0);
  const confirm = view.button('确认删除').props.onClick;
  const mutation = confirm(); confirm(); assert.equal(calls.length, 1);
  assert.equal(calls[0].body.confirm, true); assert.equal(calls[0].body.all, true); assert.equal(calls[0].body.revision, 1);
  mutateResolve({ ...fixture(), renewals: [], renewalRevision: 2 }); await mutation;
  pollResolve(fixture()); await pendingPoll;
  assert.equal(view.data().renewals.length, 0);
});

test('hidden renewal tabs do not poll and timeout errors do not leave loading controls stuck', async () => {
  let calls = 0;
  const view = harness(async () => { calls++; throw Object.assign(Error('timed out'), { name: 'TimeoutError' }); });
  view.document.hidden = true; await view.poll(); assert.equal(calls, 0);
  view.document.hidden = false;
  await view.poll(AbortSignal.abort()); view.render();
  assert.equal(calls, 1);
  assert.ok(view.nodes().some((node) => node.props?.role === 'alert' && node.props.children === '读取超时，请刷新重试'));
  assert.equal(view.button('添加').props.disabled, false);
});

test('renewal navigation is before Telegram, uses isolated workspace, and mobile rules are scoped', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/renewals.css', import.meta.url), 'utf8');
  assert.ok(app.indexOf("{ key: 'renewals'") < app.indexOf("{ key: 'telegram'"));
  assert.match(app, /tab === 'renewals' \? <RenewalWorkspace/);
  assert.match(css, /\.renewal-workspace \.ops-tabs \{[^}]*flex-wrap: nowrap/);
  assert.match(css, /\.renewal-dialog \.ops-editor-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.renewal-status \{[^}]*align-self: start/);
});

test('renewal editor blocks duplicate names and canonical addresses locally but allows unchanged self edits', async () => {
  let requests = 0;
  const view = harness(async (_path, options) => { if (options.method) requests++; return fixture(); });
  await view.poll(); view.render();
  view.button('添加').props.onClick(); view.render();
  const editor = () => view.nodes().find((node) => node.type === view.exports.RenewalEditor);
  editor().props.patch({ name: ' 香港入口 ' }); view.render();
  assert.equal(editor().props.duplicate, 'name');
  assert.equal(view.button('保存').props.disabled, true);
  view.nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(requests, 0);
  editor().props.patch({ name: 'new', address: 'HK.EXAMPLE.COM.' }); view.render();
  assert.equal(editor().props.duplicate, 'address');
  assert.equal(view.button('保存').props.disabled, true);
  editor().props.patch({ address: '' }); view.render();
  assert.equal(editor().props.duplicate, '');
  assert.equal(view.button('保存').props.disabled, false);
  view.button('取消').props.onClick(); view.render();
  view.button('编辑 香港入口').props.onClick(); view.render();
  assert.equal(editor().props.duplicate, '');
  assert.equal(view.button('保存').props.disabled, false);
});

test('renewal reminder settings expose actual robots, default unchecked, and submit selected IDs', async () => {
  const calls = [];
  const view = harness(async (path, options) => {
    if (!options.method) return fixture();
    calls.push({ path, body: JSON.parse(options.body) });
    return { ...fixture(), renewalSettings: JSON.parse(options.body), renewalRevision: 2 };
  });
  await view.poll(); view.render();
  view.button('提醒设置').props.onClick(); view.render();
  const settingsNode = () => view.nodes().find((node) => node.type === view.exports.RenewalSettings);
  let tree = view.exports.RenewalSettings(settingsNode().props);
  const picker = view.nodes(tree).find((node) => node.type === view.exports.RenewalBotPicker);
  assert.equal(picker.props.label, '默认 TG 通知机器人');
  assert.equal(picker.props.bots[0].name, '通知');
  const checkboxes = view.nodes(view.exports.RenewalBotPicker(picker.props)).filter((node) => node.type === 'input');
  assert.equal(checkboxes[0].props.checked, false);
  checkboxes[0].props.onChange({ target: { checked: true } }); view.render();
  assert.deepEqual([...settingsNode().props.value.botIds], ['bot']);
  tree = view.exports.RenewalSettings(settingsNode().props);
  tree.props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/renewals/settings');
  assert.deepEqual(calls[0].body.botIds, ['bot']);
  view.render();
  assert.ok(view.nodes().some((node) => node.props?.className === 'renewal-notification-summary' && node.props.children.includes('通知')));
});

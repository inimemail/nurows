import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';

const compiled = transformSync(fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8') + '\nexport { renderSection, DataView };', { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(api = async () => fixture()) {
  const values = [], copies = [], messages = [], cleanups = [], timers = new Set();
  let cursor = 0, tree, closed = false;
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  const useState = initial => {
    const index = cursor++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], update => { values[index] = typeof update === 'function' ? update(values[index]) : update; }];
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, AbortController, setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); }, navigator: { clipboard: { async writeText(value) { copies.push(value); } } }, require(path) {
    if (path === 'react') return { useState, useRef: initial => useState({ current: initial })[0], useMemo: fn => fn(), useEffect(fn) { if (!cleanups.length) cleanups.push(fn()); } };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('note-clipboard.js')) return { async copyNoteText(value) { copies.push(value); } };
    return {};
  } });
  const render = () => { cursor = 0; tree = module.exports.IpUsageLookup({ api, Dialog: 'dialog', toast: message => messages.push(message), onClose: () => { closed = true; } }); };
  const walk = value => Array.isArray(value) ? value.flatMap(walk) : value && typeof value === 'object' ? [value, ...walk(value.props?.children), ...walk(value.props?.footer)] : [];
  const nodes = (value = tree) => walk(value);
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const input = value => { nodes().find(node => node.type === 'textarea').props.onChange({ target: { value } }); render(); };
  render();
  return { render, nodes, text, button, input, copies, messages, exports: module.exports, expire: () => [...timers].forEach(fn => fn()), timerCount: () => timers.size, close: () => button('关闭').props.onClick(), closed: () => closed, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}
function fixture() {
  const results = Array.from({ length: 103 }, (_, i) => ({ address: `192.0.2.${i + 1}`, status: i < 100 ? 'unused' : i === 100 ? 'used' : i === 101 ? 'reserved' : 'invalid', references: [], pools: [] }));
  return { results, summary: { total: 103, unused: 100, used: 1, reserved: 1, invalid: 1, duplicates: 0 }, checkedAt: '2026-10-03T00:00:00Z' };
}

test('toolbar places batch lookup before history and creation, including an empty or filtered list', () => {
  const view = harness();
  let opened = 0;
  const section = view.exports.renderSection('guards', { state: {}, visibleRecords: [], search: 'no-match', openIpLookup: () => opened++ });
  const header = view.exports.DataView(section.props);
  const buttons = view.nodes(header).filter(node => node.type === 'button');
  assert.deepEqual(buttons.map(node => view.text(node)), ['批量查 IP', '检查记录', '新增守护任务']);
  buttons[0].props.onClick();
  assert.equal(opened, 1);
});

test('large results render only a page, filter resets pagination, copy includes all filtered pages but skips invalids', async () => {
  const view = harness();
  view.input('192.0.2.1');
  await view.button('查询使用情况').props.onClick(); view.render();
  assert.equal(view.nodes().filter(node => node.type === 'article').length, 50);
  view.button('下一页').props.onClick(); view.render();
  assert.equal(view.nodes().find(node => node.type === 'code').props.children, '192.0.2.51');
  await view.button('复制全部 IP').props.onClick();
  assert.equal(view.copies[0].split('\n').length, 102);
  view.button('未发现使用100').props.onClick(); view.render();
  assert.equal(view.nodes().find(node => node.type === 'code').props.children, '192.0.2.1');
  await view.button('复制未发现使用 IP').props.onClick();
  assert.equal(view.copies[1].split('\n').length, 100);
  view.button('无效输入1').props.onClick(); view.render();
  assert.equal(view.button('复制 IP').props.disabled, true);
  assert.equal(view.nodes().filter(node => node.type === 'article').length, 1);
});

test('repeat clicks make one request; editing cancels it and ignores a late response', async () => {
  let finish;
  const calls = [];
  const view = harness((path, options) => { calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); });
  view.input('192.0.2.1');
  const query = view.button('查询使用情况').props.onClick;
  const pending = query(); await query(); view.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/dns-guards/ip-usage');
  assert.equal(view.button('查询中…').props.disabled, true);
  view.input('192.0.2.2');
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(view.timerCount(), 0);
  finish(fixture()); await pending; view.render();
  assert.equal(view.nodes().filter(node => node.type === 'article').length, 0);
  assert.equal(view.button('查询使用情况').props.disabled, false);
});

test('a timed-out query stops waiting, can retry, and cannot replace the retry with a stale response', async () => {
  let finishOld, count = 0, oldSignal;
  const view = harness((_path, options) => {
    if (!count++) { oldSignal = options.signal; return new Promise(resolve => { finishOld = resolve; }); }
    return Promise.resolve(fixture());
  });
  view.input('192.0.2.1');
  const pending = view.button('查询使用情况').props.onClick();
  view.expire(); view.render();
  assert.equal(oldSignal.aborted, true);
  assert.equal(view.timerCount(), 0);
  assert.match(view.text(view.nodes().find(node => node.props?.role === 'alert')), /查询超时/);
  assert.equal(view.button('查询使用情况').props.disabled, false);
  await view.button('查询使用情况').props.onClick(); view.render();
  assert.equal(view.timerCount(), 0);
  finishOld({ results: [], summary: { total: 0 } }); await pending; view.render();
  assert.equal(view.nodes().filter(node => node.type === 'article').length, 50);
});

test('many domains sharing an IP render three references initially and can expand without losing any association', async () => {
  const data = fixture();
  data.results[0].references = Array.from({ length: 60 }, (_, i) => ({ id: `guard-${i}`, type: 'guard', kind: 'used', name: `守护${i}`, domain: `d${i}.example.com`, enabled: true }));
  const view = harness(async () => data);
  view.input('192.0.2.1');
  await view.button('查询使用情况').props.onClick(); view.render();
  const references = () => view.nodes().filter(node => node.props?.className === 'ip-lookup-reference');
  assert.equal(references().length, 3);
  assert.equal(view.button('展开其余 57 个关联').props['aria-expanded'], false);
  view.button('展开其余 57 个关联').props.onClick(); view.render();
  assert.equal(references().length, 60);
  view.button('收起关联').props.onClick(); view.render();
  assert.equal(references().length, 3);
});

test('closing and unmounting abort queries; validation errors allow retry', async () => {
  for (const close of ['close', 'unmount']) {
    let finish, signal;
    const view = harness((_path, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
    view.input('192.0.2.1');
    const pending = view.button('查询使用情况').props.onClick();
    view[close]();
    assert.equal(signal.aborted, true);
    finish(fixture()); await pending; view.render();
    assert.equal(view.nodes().filter(node => node.type === 'article').length, 0);
  }
  let count = 0;
  const view = harness(async () => { if (!count++) throw Error('单次最多查询 5000 个 IP'); return fixture(); });
  view.input('192.0.2.1');
  await view.button('查询使用情况').props.onClick(); view.render();
  assert.match(view.text(view.nodes().find(node => node.props?.role === 'alert')), /5000/);
  await view.button('查询使用情况').props.onClick(); view.render();
  assert.equal(view.nodes().filter(node => node.props?.role === 'alert').length, 0);
  assert.equal(view.nodes().filter(node => node.type === 'article').length, 50);
});

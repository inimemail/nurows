import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as telegramPermissions from '../shared/telegram-permissions.js';
import * as workspaceSearch from '../shared/workspace-search.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(api, assets, search = '') {
  const values = [], messages = [], updates = [];
  let cursor = 0, tree;
  const state = { ipAssets: assets || [{ id: 'a', name: '测试 IP', address: '192.0.2.1', labels: [], health: 'unknown' }], ipPools: [], ipUsageRecords: [] };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], (update) => { values[index] = typeof update === 'function' ? update(values[index]) : update; }];
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
    if (path === 'react') return { useState, useRef: (initial) => useState({ current: initial })[0], useEffect() {}, useMemo: (fn) => fn() };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('polling.js')) return { startPolling() {} };
    if (path.endsWith('telegram-permissions.js')) return telegramPermissions;
    if (path.endsWith('workspace-search.js')) return workspaceSearch;
    if (path.endsWith('DynamicGuardWorkspace.jsx')) return { default: 'dynamic', __esModule: true };
    throw Error(path);
  } });
  function render() { cursor = 0; tree = module.exports.default({ tab: 'pools', state, search, api, onState: (next) => updates.push(next), toast: (message) => messages.push(message), Dialog: 'dialog' }); }
  function nodes(value = tree) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.actions ?? null), ...nodes(value.props?.footer ?? null)];
  }
  const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const buttons = (label) => nodes().filter((node) => node.type === 'button' && text(node) === label);
  render();
  return { render, nodes, buttons, messages, updates };
}

test('asset row supports direct deletion; cancel makes no request and repeated confirmation sends only once', async () => {
  const calls = [];
  let finish;
  const view = harness((path, options) => { calls.push({ path, options }); return new Promise((resolve) => { finish = resolve; }); });
  view.buttons('删除')[0].props.onClick(); view.render();
  assert.equal(view.nodes().some((node) => node.type === 'dialog' && node.props.title === '删除 IP 资产'), true);
  view.buttons('取消')[0].props.onClick(); view.render();
  assert.equal(calls.length, 0);
  assert.equal(view.buttons('确认删除').length, 0);
  view.buttons('删除')[0].props.onClick(); view.render();
  const confirm = view.buttons('确认删除')[0].props.onClick;
  const pending = confirm();
  await confirm();
  view.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/orchestration/ip-assets/a');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(view.buttons('删除中...')[0].props.disabled, true);
  assert.equal(view.buttons('取消')[0].props.disabled, true);
  finish({ state: { ipAssets: [], ipPools: [] } });
  await pending; view.render();
  assert.equal(view.buttons('确认删除').length, 0);
  assert.equal(view.updates.length, 1);
});

test('IP assets show newest first after single and batch additions without changing allocation order', () => {
  const assets = [
    { id: 'legacy', address: '192.0.2.1' },
    { id: 'old', address: '192.0.2.2', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'new', address: '192.0.2.3', createdAt: '2026-09-21T00:00:00Z' },
    { id: 'batch1', address: '192.0.2.4', createdAt: '2026-09-22T00:00:00Z' },
    { id: 'batch2', address: '192.0.2.5', createdAt: '2026-09-22T00:00:00Z' },
    { id: 'invalid', address: '192.0.2.6', createdAt: 'invalid' }
  ];
  const original = structuredClone(assets);
  const view = harness(() => assert.fail('sorting must not request the server'), assets);
  const titles = () => view.nodes().filter((node) => node.props?.title && node.props?.actions).map((node) => node.props.title);
  assert.deepEqual(titles(), ['192.0.2.5', '192.0.2.4', '192.0.2.3', '192.0.2.2', '192.0.2.6', '192.0.2.1']);
  view.render(); assert.equal(titles()[0], '192.0.2.5');
  assert.deepEqual(assets, original);
  const filtered = harness(() => {}, assets, '192.0.2.3');
  assert.deepEqual(filtered.nodes().filter((node) => node.props?.title && node.props?.actions).map((node) => node.props.title), ['192.0.2.3']);
});

test('editor deletion also confirms; server rejection preserves asset and allows cancel', async () => {
  let calls = 0;
  const view = harness(async () => { calls++; throw Error('该 IP 正在使用或被任务占用，暂时不能删除'); });
  view.buttons('编辑')[0].props.onClick(); view.render();
  await view.buttons('删除').at(-1).props.onClick(); view.render();
  assert.equal(calls, 0);
  await view.buttons('确认删除')[0].props.onClick(); view.render();
  assert.equal(calls, 1);
  assert.equal(view.updates.length, 0);
  assert.match(view.messages[0], /正在使用/);
  assert.equal(view.buttons('确认删除')[0].props.disabled, false);
  view.buttons('取消').at(-1).props.onClick(); view.render();
  assert.equal(view.buttons('确认删除').length, 0);
  assert.equal(view.nodes().some((node) => node.type === 'dialog' && node.props.title === '编辑IP 资产'), true);
});

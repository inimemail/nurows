import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as search from '../shared/workspace-search.js';
import * as permissions from '../shared/telegram-permissions.js';
import * as capabilities from '../shared/probe-capabilities.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(type, api) {
  const slots = [], messages = [], updates = [];
  let cursor = 0, tree;
  const item = { id: `${type}-1`, name: '测试配置', domain: 'test.example.com', provider: 'huawei', sources: [], currentValues: [], probeIds: [] };
  const state = { dnsGuards: [item], dnsAccounts: [item], dnsBindings: [item], probes: [], ipPools: [], telegramBots: [] };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  const useState = initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; };
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, URLSearchParams, window: { location: { search: type === 'guard' ? '?tgSection=guards' : '' } }, require(path) {
    if (path === 'react') return { useState, useRef: initial => useState({ current: initial })[0], useMemo: fn => fn(), useEffect() {} };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('workspace-search.js')) return search;
    if (path.endsWith('telegram-permissions.js')) return permissions;
    if (path.endsWith('probe-capabilities.js')) return capabilities;
    return {};
  } });
  const render = () => { cursor = 0; tree = module.exports.default({ tab: type === 'guard' ? 'probes' : 'dns', state, api, onState: next => updates.push(next), toast: text => messages.push(text), Dialog: 'dialog' }); };
  const nodes = (value = tree) => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.actions ?? null), ...nodes(value.props?.footer ?? null), ...(value.props?.items && typeof value.props.children === 'function' ? value.props.items.flatMap(item => nodes(value.props.children(item))) : [])] : [];
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = label => nodes().findLast(node => node.type === 'button' && text(node) === label);
  render();
  if (type === 'binding') { nodes().find(node => node.type === 'button' && text(node).startsWith('解析绑定')).props.onClick(); render(); }
  button(type === 'guard' ? '编辑规则' : '编辑').props.onClick(); render();
  return { render, nodes, button, text, messages, updates };
}

for (const [type, resource] of [['guard', 'dns-guards'], ['account', 'dns-accounts'], ['binding', 'dns-bindings']]) {
  test(`${type} deletion requires confirmation, preserves drafts on cancel, and submits once`, async () => {
    const calls = [];
    let resolve;
    const h = harness(type, (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); });
    await h.button('删除').props.onClick(); h.render();
    assert.equal(calls.length, 0);
    assert.match(h.text(h.nodes().findLast(node => node.type === 'dialog')), /测试配置.*远程 DNS 记录不会删除/);
    h.button('取消').props.onClick(); h.render();
    assert.equal(calls.length, 0);
    assert.ok(h.button('删除'));
    await h.button('删除').props.onClick(); h.render();
    const confirm = h.button('确认删除').props.onClick;
    const pending = confirm();
    await confirm(); h.render();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `/api/orchestration/${resource}/${type}-1`);
    assert.equal(calls[0][1].method, 'DELETE');
    assert.equal(h.button('取消').props.disabled, true);
    const dialog = h.nodes().findLast(node => node.type === 'dialog');
    dialog.props.onClose(); h.render();
    assert.ok(h.nodes().some(node => node.type === 'dialog'));
    resolve({ state: {} }); await pending; h.render();
    assert.equal(h.nodes().filter(node => node.type === 'dialog').length, 0);
    assert.equal(h.updates.length, 1);
  });
}

test('server rejection preserves DNS editor and confirmation for retry or cancellation', async () => {
  let calls = 0;
  const h = harness('guard', async () => { calls++; throw Error('守护检查正在执行，请结束后再删除'); });
  await h.button('删除').props.onClick(); h.render();
  await h.button('确认删除').props.onClick(); h.render();
  assert.equal(calls, 1);
  assert.equal(h.updates.length, 0);
  assert.equal(h.button('确认删除').props.disabled, false);
  assert.match(h.messages[0], /正在执行/);
  h.button('取消').props.onClick(); h.render();
  assert.ok(h.button('删除'));
  assert.equal(h.nodes().filter(node => node.type === 'dialog').length, 1);
});

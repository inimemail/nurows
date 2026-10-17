import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as searchHelpers from '../shared/workspace-search.js';
import * as permissions from '../shared/telegram-permissions.js';
import * as capabilities from '../shared/probe-capabilities.js';

const compile = file => transformSync(fs.readFileSync(new URL(`../src/${file}.jsx`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const compiled = Object.fromEntries(['OrchestrationWorkspace', 'DynamicGuardWorkspace', 'WebhookWorkspace'].map(file => [file, compile(file)]));
function harness(file, props) {
  const slots = [], messages = [], effects = [];
  let cursor = 0, tree, poll;
  const useState = initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; };
  const jsx = (type, props) => typeof type === 'function' && type.name === 'DataView' ? type(props) : { type, props };
  const module = { exports: {} };
  vm.runInNewContext(compiled[file], { module, exports: module.exports, structuredClone, AbortSignal, URLSearchParams, Date,
    setTimeout, clearTimeout, document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    window: { location: { search: props.link || '' } }, require(name) {
      if (name === 'react') return { useState, useRef: initial => useState({ current: initial })[0], useMemo: fn => fn(), useEffect: fn => effects.push(fn) };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (name.endsWith('workspace-search.js')) return searchHelpers;
      if (name.endsWith('telegram-permissions.js')) return permissions;
      if (name.endsWith('probe-capabilities.js')) return capabilities;
      if (name.endsWith('polling.js')) return { startPolling(fn) { poll = fn; return () => {}; } };
      return {};
    } });
  const render = () => { cursor = 0; effects.length = 0; tree = module.exports.default({ toast: value => messages.push(value), Dialog: 'dialog', ...props }); };
  const walk = value => Array.isArray(value) ? value.flatMap(walk) : value && typeof value === 'object'
    ? [value, ...walk(value.props?.children), ...walk(value.props?.footer)] : [];
  const nodes = () => walk(tree);
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  render();
  return { render, nodes, text, button, messages, startPoll: index => effects[index](), poll: () => poll(new AbortController().signal) };
}

const config = key => ({ probes: [], probeTargets: [], dnsGuards: [], dynamicGuards: [], failoverPolicies: [], telegramBots: [], ipAssets: [], ipPools: [], dnsAccounts: [], dnsBindings: [],
  [key]: [{ id: 'one', name: 'one', sources: [], probeIds: [], currentValues: [] }, { id: 'hidden', name: 'hidden', sources: [], probeIds: [], currentValues: [] }] });

for (const [section, tab, key, resource] of [['probes', 'probes', 'probes', 'probes'], ['targets', 'probes', 'probeTargets', 'probe-targets'],
  ['guards', 'probes', 'dnsGuards', 'dns-guards'], ['policies', 'probes', 'failoverPolicies', 'failover-policies'],
  ['bots', 'telegram', 'telegramBots', 'telegram-bots'], ['assets', 'pools', 'ipAssets', 'ip-assets'],
  ['pools', 'pools', 'ipPools', 'ip-pools'], ['accounts', 'dns', 'dnsAccounts', 'dns-accounts'], ['dns', 'dns', 'dnsBindings', 'dns-bindings']]) {
  test(`${section} bulk confirmation snapshots the whole collection regardless of search and submits once`, async () => {
    const calls = [], state = config(key);
    let release;
    const view = harness('OrchestrationWorkspace', { tab, state, link: `?tgSection=${section}`, search: 'one', onState() {},
      api: (url, options) => { calls.push({ url, options }); return new Promise(resolve => { release = resolve; }); } });
    view.button('全部删除').props.onClick(); view.render();
    assert.equal(calls.length, 0);
    assert.match(view.text(view.nodes().find(node => node.type === 'dialog')), /全部 2 项/);
    view.button('取消').props.onClick(); view.render(); assert.equal(calls.length, 0);
    view.button('全部删除').props.onClick(); view.render();
    state[key].push({ id: 'new' });
    const confirm = view.button('确认全部删除').props.onClick;
    const pending = confirm(); await confirm(); view.render();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/orchestration/${resource}/delete-all`);
    assert.deepEqual(JSON.parse(calls[0].options.body).ids, ['one', 'hidden']);
    assert.equal(view.button('取消').props.disabled, true);
    view.nodes().find(node => node.type === 'dialog').props.onClose(); view.render();
    assert.ok(view.button('删除中...'));
    release({ state, deletedIds: ['one'], deletedCount: 1, skippedCount: 1, reasons: [{ reason: '正在执行', count: 1 }] });
    await pending; view.render();
    assert.ok(view.button('完成')); assert.match(view.text(view.nodes().find(node => node.type === 'dialog')), /正在执行：1 项/);
  });
}

test('a late orchestration poll cannot resurrect deleted DNS guards', async () => {
  let releasePoll;
  const state = config('dnsGuards'), updates = [];
  const view = harness('OrchestrationWorkspace', { tab: 'probes', state, link: '?tgSection=guards', onState: value => updates.push(value),
    api: (url) => url.includes('/status/') ? new Promise(resolve => { releasePoll = resolve; })
      : Promise.resolve({ state: { dnsGuards: [] }, deletedIds: ['one', 'hidden'], deletedCount: 2, skippedCount: 0 }) });
  // First effect publishes search scope, second owns this section's polling.
  view.startPoll(1); const poll = view.poll();
  view.button('全部删除').props.onClick(); view.render();
  await view.button('确认全部删除').props.onClick();
  releasePoll(state); await poll;
  assert.equal(updates.length, 1); assert.deepEqual(updates[0], { dnsGuards: [] });
});

test('dynamic guard bulk deletion updates the cache without deleting newer or skipped tasks', async () => {
  const guards = ['one', 'hidden'].map(id => ({ id, name: id, probeIds: [], status: 'healthy', enabled: true }));
  const cache = { current: { data: { guards, probes: [], bots: [] } } }, calls = [];
  let release;
  const view = harness('DynamicGuardWorkspace', { cache, search: 'one', api: (url, options) => { calls.push({ url, options }); return new Promise(resolve => { release = resolve; }); } });
  view.button('全部删除').props.onClick(); view.render();
  guards.push({ id: 'new', name: 'new', probeIds: [] });
  const confirm = view.button('确认全部删除').props.onClick;
  const pending = confirm(); await confirm(); view.render();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/dynamic-guards/delete-all');
  assert.deepEqual(JSON.parse(calls[0].options.body).ids, ['one', 'hidden']);
  release({ deletedIds: ['one'], deletedCount: 1, skippedCount: 1, reasons: [{ reason: 'API 命令正在执行', count: 1 }] });
  await pending; view.render();
  assert.deepEqual(Array.from(cache.current.data.guards, item => item.id), ['hidden', 'new']);
  assert.ok(view.button('完成'));
});

test('Webhook bulk deletion loads a safe snapshot across all pages before confirmation and invalidates cache', async () => {
  const calls = [], cache = { current: { data: { tasks: [], total: 60, servers: [], bots: [], settings: {} } } };
  const ids = Array.from({ length: 60 }, (_, i) => `task-${i}`);
  let release;
  const view = harness('WebhookWorkspace', { cache, search: 'absent', api: (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/choices') ? Promise.resolve({ tasks: ids.map(id => ({ id })) }) : new Promise(resolve => { release = resolve; });
  } });
  await view.button('全部删除').props.onClick(); view.render();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/webhooks/choices');
  assert.match(view.text(view.nodes().find(node => node.type === 'dialog')), /全部 60 个任务/);
  const confirm = view.button('确认').props.onClick;
  const pending = confirm(); await confirm(); view.render();
  assert.equal(calls.length, 2); assert.equal(calls[1].url, '/api/webhooks/delete-all');
  assert.deepEqual(JSON.parse(calls[1].options.body).ids, ids);
  release({ deletedIds: ids, deletedCount: 60, skippedCount: 0 }); await pending; view.render();
  assert.equal(cache.current, null);
  assert.equal(view.nodes().some(node => node.type === 'dialog'), false);
});

const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function appFunction(name, next) {
  return appSource.slice(appSource.indexOf(`  function ${name}(`), appSource.indexOf(next, appSource.indexOf(`  function ${name}(`)));
}

for (const [type, key, resource] of [['servers', 'servers', 'servers'], ['proxies', 'proxies', 'proxies'],
  ['commands', 'commands', 'commands'], ['automation', 'automationTasks', 'automation-tasks']]) {
  test(`App ${type} deletion requires confirmation, keeps the snapshot and blocks duplicate submits`, async () => {
    let dialog, release, deletionResult;
    const calls = [], busy = [], updates = [], messages = [];
    const state = { servers: [], proxies: [], commands: [], automationTasks: [], [key]: [{ id: 'one' }, { id: 'hidden' }] };
    const configBulkDeleting = { current: false };
    const context = vm.createContext({ state, configBulkDeleting,
      selectedCommandId: 'one', selectedServerId: 'one', selectedProxyId: 'one', automationTaskId: 'one', temporaryCommandText: 'temporary', EMPTY_AUTOMATION_TASK: {},
      openConfirm: value => { dialog = value; },
      api: (url, options) => { calls.push({ url, options }); return new Promise(resolve => { release = resolve; }); },
      setActionBusy: (_key, value) => busy.push(value), setState: value => updates.push(value),
      setSelectedCommandId() {}, setSelectedServerId() {}, setSelectedProxyId() {}, setCommandText() {}, setAutomationTaskId() {}, setAutomationDraft() {},
      setConfigDeletionResult: value => { deletionResult = value; }, toast: value => messages.push(value)
    });
    vm.runInContext(appFunction('requestConfigDeleteAll', '  async function deleteAutomationTask('), context);
    context.requestConfigDeleteAll(type);
    assert.equal(calls.length, 0); assert.match(dialog.message, /全部 2 项/);
    // Cancelling discards the callback and never contacts the deletion API.
    dialog = null; assert.equal(calls.length, 0);
    context.requestConfigDeleteAll(type);
    state[key].push({ id: 'new' });
    const confirm = dialog.onConfirm, pending = confirm();
    await confirm();
    assert.equal(calls.length, 1); assert.equal(calls[0].url, `/api/${resource}/delete-all`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: 'delete-records', ids: ['one', 'hidden'] });
    dialog = null; context.requestConfigDeleteAll(type); assert.equal(dialog, null);
    release({ state, deletedIds: ['one'], deletedCount: 1, skippedCount: 1, reasons: [{ reason: '正在执行', count: 1 }] });
    await pending;
    assert.equal(updates.length, 1); assert.equal(deletionResult.skippedCount, 1);
    assert.equal(configBulkDeleting.current, false); assert.deepEqual(busy, [true, false]);
    assert.match(messages[0], /保留 1 项/);
  });
}

test('App deletion failure releases the lock, keeps existing state and allows reconfirmation', async () => {
  let dialog;
  const messages = [], configBulkDeleting = { current: false };
  const context = vm.createContext({ state: { commands: [{ id: 'one' }] }, configBulkDeleting,
    openConfirm: value => { dialog = value; }, setActionBusy() {}, setState: () => assert.fail('failed deletion must not replace state'),
    api: async () => { throw new Error('synthetic network error'); }, toast: value => messages.push(value)
  });
  vm.runInContext(appFunction('requestConfigDeleteAll', '  async function deleteAutomationTask('), context);
  context.requestConfigDeleteAll('commands'); await dialog.onConfirm();
  assert.equal(configBulkDeleting.current, false); assert.equal(messages[0], 'synthetic network error');
  dialog = null; context.requestConfigDeleteAll('commands'); assert.ok(dialog);
});

test('legacy server and proxy no-selection shortcuts enter the protected bulk confirmation flow', () => {
  const requests = [];
  const context = vm.createContext({ selectedServerId: '', selectedProxyId: '', requestConfigDeleteAll: type => requests.push(type),
    removeServer: () => assert.fail('must not delete individually'), removeProxy: () => assert.fail('must not delete individually'),
    openConfirm: () => assert.fail('must use the shared batch flow') });
  vm.runInContext(appFunction('confirmSidebarDelete', '  async function saveGroup('), context);
  context.confirmSidebarDelete('server'); context.confirmSidebarDelete('proxy');
  assert.deepEqual(requests, ['servers', 'proxies']);
});

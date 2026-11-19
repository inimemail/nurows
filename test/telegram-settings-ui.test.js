import assert from 'node:assert/strict';
import * as probeCapabilities from '../shared/probe-capabilities.js';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as permissions from '../shared/telegram-permissions.js';
import * as workspaceSearch from '../shared/workspace-search.js';

const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
const compiled = transformSync(`${source}\nexport { BotEditor, normalizeDraft, serializeDraft, EMPTY };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const nodes = (value) => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children)];
function harness() {
  const module = { exports: {} }, jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
    if (path === 'react') return { useState: (value) => [typeof value === 'function' ? value() : value, () => {}], useRef: (current) => ({ current }), useEffect() {}, useMemo: (fn) => fn() };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path === 'lucide-react') return {};
    if (path.endsWith('telegram-permissions.js')) return permissions;
    if (path.endsWith('probe-capabilities.js')) return probeCapabilities;
    if (path.endsWith('workspace-search.js')) return workspaceSearch;
    if (path.endsWith('note-clipboard.js')) return { copyNoteText() {} };
    if (path.endsWith('polling.js')) return {};
    if (path.endsWith('DynamicGuardWorkspace.jsx')) return { default: 'dynamic', __esModule: true };
    if (path.endsWith('GuardSortableList.jsx')) return { default: 'guard-sort', __esModule: true };
    throw new Error(path);
  } });
  return module.exports;
}

test('bot editor exposes all independent permissions including Webhook and saves explicit empty selection', () => {
  const ui = harness();
  let draft = ui.normalizeDraft('bot', { menuScopeVersion: 2, menuScopes: ['probes'], automationTaskIds: ['t'], userIds: ['123'] });
  const tree = ui.BotEditor({ value: draft, patch: (next) => { draft = { ...draft, ...next }; }, state: { automationTasks: [] } });
  const picker = nodes(tree).find((node) => node.props?.label === 'TG 可用管理功能');
  assert.equal(picker.props.items.length, permissions.TELEGRAM_FEATURES.length);
  assert.ok(picker.props.items.some((item) => item.id === 'webhooks'));
  assert.deepEqual(picker.props.value, ['probes']);
  assert.equal(picker.props.selectable, true);
  picker.props.onChange(['guards', 'dynamic']);
  assert.deepEqual(ui.serializeDraft('bot', draft).menuScopes, ['guards', 'dynamic']);
  picker.props.onChange([]);
  const saved = ui.serializeDraft('bot', draft);
  assert.deepEqual(saved.menuScopes, []);
  assert.equal(saved.menuScopeVersion, 2);
  assert.deepEqual(saved.automationTaskIds, ['t']);
});

test('editing an older bot does not silently enable default features or suppress migration', () => {
  const ui = harness();
  assert.deepEqual(ui.normalizeDraft('bot', {}).menuScopes, []);
  assert.deepEqual(ui.normalizeDraft('bot', { menuScopes: [] }).menuScopes, []);
  const old = ui.normalizeDraft('bot', { menuScopes: ['probes', 'pools'] });
  assert.deepEqual(old.menuScopes, ['probes', 'pools', 'guards', 'assets']);
  assert.equal(old.menuScopeVersion, 2);
});

test('new bot defaults select every feature and task and keep manual deselections after later additions', () => {
  const ui = harness();
  let draft = structuredClone(ui.EMPTY.bot);
  const state = { automationTasks: [{ id: 't1', name: '任务一' }] };
  const render = () => ui.BotEditor({ value: draft, patch: next => { draft = { ...draft, ...next }; }, state });
  const picker = label => nodes(render()).find(node => node.props?.label === label);
  assert.deepEqual(picker('TG 可用管理功能').props.value, permissions.TELEGRAM_FEATURES.map(([key]) => key));
  assert.deepEqual(picker('允许执行的自动化任务').props.value, ['t1']);
  picker('TG 可用管理功能').props.onChange([]);
  picker('允许执行的自动化任务').props.onChange([]);
  assert.deepEqual(picker('TG 可用管理功能').props.value, []);
  assert.deepEqual(picker('允许执行的自动化任务').props.value, []);
  state.automationTasks.push({ id: 't2', name: '新任务' });
  assert.deepEqual(picker('允许执行的自动化任务').props.value, ['t2']);
  picker('允许执行的自动化任务').props.onChange(['t2']);
  assert.deepEqual(picker('允许执行的自动化任务').props.value, ['t2']);
  assert.deepEqual(ui.serializeDraft('bot', draft).automationTaskCatalog, ['t1', 't2']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as permissions from '../shared/telegram-permissions.js';
import * as workspaceSearch from '../shared/workspace-search.js';

const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
const compiled = transformSync(`${source}\nexport { BotEditor, normalizeDraft, serializeDraft };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const nodes = (value) => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children)];
function harness() {
  const module = { exports: {} }, jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
    if (path === 'react') return { useState: (value) => [typeof value === 'function' ? value() : value, () => {}], useRef: (current) => ({ current }), useEffect() {}, useMemo: (fn) => fn() };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('telegram-permissions.js')) return permissions;
    if (path.endsWith('workspace-search.js')) return workspaceSearch;
    if (path.endsWith('polling.js')) return {};
    if (path.endsWith('DynamicGuardWorkspace.jsx')) return { default: 'dynamic', __esModule: true };
    throw new Error(path);
  } });
  return module.exports;
}

test('bot editor exposes twelve independent permissions and saves explicit empty selection', () => {
  const ui = harness();
  let draft = ui.normalizeDraft('bot', { menuScopeVersion: 2, menuScopes: ['probes'], automationTaskIds: ['t'], userIds: ['123'] });
  const tree = ui.BotEditor({ value: draft, patch: (next) => { draft = { ...draft, ...next }; }, state: { automationTasks: [] } });
  const picker = nodes(tree).find((node) => node.props?.label === 'TG 可用管理功能');
  assert.equal(picker.props.items.length, 12);
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

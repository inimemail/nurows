import assert from 'node:assert/strict';
import * as probeCapabilities from '../shared/probe-capabilities.js';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as permissions from '../shared/telegram-permissions.js';
import * as search from '../shared/workspace-search.js';

const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
const compiled = transformSync(`${source}\nexport { GuardEditor, PoolEditor, normalizeDraft, serializeDraft };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const jsx = (type, props) => ({ type, props });
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
  if (path === 'react') return { useState: (value) => [typeof value === 'function' ? value() : value, () => {}] };
  if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (path.endsWith('telegram-permissions.js')) return permissions;
  if (path.endsWith('probe-capabilities.js')) return probeCapabilities;
  if (path.endsWith('workspace-search.js')) return search;
  return {};
} });
const { GuardEditor, PoolEditor, normalizeDraft, serializeDraft } = module.exports;
const nodes = (value) => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const field = (tree, label) => nodes(tree).find((node) => node.props?.label === label);
const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');

test('guard form defaults to repair, conditionally exposes a bounded fill target and preserves settings on save', () => {
  let value = normalizeDraft('guard', { maxActiveIps: 20 });
  const state = { probes: [], ipPools: [], dnsAccounts: [], telegramBots: [] };
  const render = () => GuardEditor({ value, state, patch: (next) => { value = { ...value, ...next }; } });
  assert.equal(value.poolFillMode, 'repair');
  assert.equal(field(render(), '目标 IP 数量'), undefined);
  field(render(), '补位方式').props.children.props.onChange({ target: { value: 'fill' } });
  const input = field(render(), '目标 IP 数量').props.children;
  assert.equal(input.props.max, 20);
  assert.equal(input.props.value, 20);
  input.props.onChange({ target: { value: '10' } });
  const saved = serializeDraft('guard', value);
  assert.equal(saved.poolFillMode, 'fill');
  assert.equal(saved.poolTargetCount, '10');
  assert.equal(normalizeDraft('guard', saved).poolTargetCount, '10');
  field(render(), '补位方式').props.children.props.onChange({ target: { value: 'repair' } });
  assert.equal(field(render(), '目标 IP 数量'), undefined);
});

test('guard pool selection is independent of fill mode and survives save and copy', () => {
  let value = normalizeDraft('guard', { poolIds: ['a', 'b'], poolFillMode: 'repair', currentValues: ['192.0.2.1'], poolOrigins: { '192.0.2.1': 'a', '192.0.2.2': 'b' } });
  const state = { probes: [], ipPools: [], dnsAccounts: [], telegramBots: [] };
  const render = () => GuardEditor({ value, state, patch: (next) => { value = { ...value, ...next }; } });
  assert.equal(field(render(), '备用池取用方式').props.children.props.value, 'ordered');
  assert.ok(field(render(), '备用池（按选择顺序兜底）'));
  field(render(), '备用池取用方式').props.children.props.onChange({ target: { value: 'balanced' } });
  assert.ok(field(render(), '备用池（均衡取用）'));
  const poolPicker = field(render(), '备用池（均衡取用）');
  assert.equal(poolPicker.props.secondary({ id: 'a', assetIds: ['1', '2'] }), '库存 2 个 · 当前域名 1 个');
  assert.equal(poolPicker.props.secondary({ id: 'b', assetIds: [] }), '库存 0 个 · 当前域名 0 个');
  assert.equal(value.poolFillMode, 'repair');
  const saved = serializeDraft('guard', value);
  assert.equal(saved.poolSelectionMode, 'balanced');
  assert.equal(normalizeDraft('guard', saved).poolSelectionMode, 'balanced');
  assert.deepEqual(saved.poolIds, ['a', 'b']);
  field(render(), '补位方式').props.children.props.onChange({ target: { value: 'fill' } });
  assert.equal(value.poolSelectionMode, 'balanced');
});

test('pool editor separates DNS guard and incident allocation without changing stored incident choices', () => {
  for (const allocationMode of ['one', 'count', 'all']) {
    const value = normalizeDraft('pool', { allocationMode, allocationCount: 7, assetIds: ['asset'], selectionMode: 'random' });
    const tree = PoolEditor({ value, patch() {}, state: { ipAssets: [], telegramBots: [] } });
    assert.match(text(field(tree, 'DNS 守护取用')), /跟随守护设置/);
    assert.equal(field(tree, '故障切换取用').props.children.props.value, allocationMode);
    assert.equal(Boolean(field(tree, '取用数量')), allocationMode === 'count');
    const saved = serializeDraft('pool', value);
    assert.equal(saved.allocationMode, allocationMode);
    assert.equal(saved.allocationCount, 7);
    assert.equal(saved.selectionMode, 'random');
    assert.deepEqual(saved.assetIds, ['asset']);
  }
});

test('balanced selection enables automatic rebalance by default and preserves explicit opt-out on save and copy', () => {
  let value = normalizeDraft('guard', {});
  const state = { probes: [], ipPools: [], dnsAccounts: [], telegramBots: [] };
  const render = () => GuardEditor({ value, state, patch: (next) => { value = { ...value, ...next }; } });
  const toggle = () => nodes(render()).find((node) => node.props?.children === '自动调整已有 IP');
  assert.equal(value.poolRebalanceEnabled, false);
  assert.equal(value.poolRebalanceIntervalMinutes, 30);
  assert.equal(field(render(), '自动调整间隔（分钟）'), undefined);
  assert.equal(toggle(), undefined);
  field(render(), '备用池取用方式').props.children.props.onChange({ target: { value: 'balanced' } });
  assert.equal(toggle().props.checked, true);
  const interval = field(render(), '自动调整间隔（分钟）').props.children;
  assert.equal(interval.props.value, 30);
  assert.equal(interval.props.min, '1');
  assert.equal(interval.props.max, '1440');
  assert.equal(interval.props.required, true);
  interval.props.onChange({ target: { value: '45' } });
  assert.match(text(render()), /确认远程替换后/);
  const saved = serializeDraft('guard', value);
  assert.equal(saved.poolRebalanceEnabled, true);
  assert.equal(saved.poolRebalanceIntervalMinutes, '45');
  assert.equal(normalizeDraft('guard', saved).poolRebalanceEnabled, true);
  assert.equal(normalizeDraft('guard', saved).poolRebalanceIntervalMinutes, '45');
  toggle().props.onChange(false);
  const optedOut = serializeDraft('guard', value);
  assert.equal(normalizeDraft('guard', optedOut).poolRebalanceEnabled, false);
  assert.equal(field(render(), '自动调整间隔（分钟）'), undefined);
  field(render(), '备用池取用方式').props.children.props.onChange({ target: { value: 'ordered' } });
  assert.equal(value.poolRebalanceEnabled, false);
  assert.equal(toggle(), undefined);
  assert.equal(field(render(), '自动调整间隔（分钟）'), undefined);
  field(render(), '备用池取用方式').props.children.props.onChange({ target: { value: 'balanced' } });
  assert.equal(toggle().props.checked, true);
});

test('automatic rebalance has a separate full-width setting row and an accessible switch', () => {
  const value = normalizeDraft('guard', { poolSelectionMode: 'balanced', poolRebalanceEnabled: true });
  const tree = GuardEditor({ value, state: { probes: [], ipPools: [], dnsAccounts: [], telegramBots: [] }, patch() {} });
  const row = nodes(tree).find((node) => node.props?.className === 'guard-rebalance-settings');
  assert.ok(row);
  assert.ok(field(row, '自动调整间隔（分钟）'));
  const toggle = nodes(row).find((node) => node.props?.switchControl);
  assert.equal(toggle.props.className, 'guard-rebalance-toggle');
  const rendered = toggle.type(toggle.props);
  assert.equal(nodes(rendered).find((node) => node.type === 'input').props.role, 'switch');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.guard-rebalance-settings \{ grid-column: 1 \/ -1/);
  assert.match(css, /\.ops-guard-editor \.guard-pool-settings \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.guard-rebalance-settings \.guard-rebalance-toggle > input:focus-visible/);
});

import assert from 'node:assert/strict';
import * as probeCapabilities from '../shared/probe-capabilities.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as permissions from '../shared/telegram-permissions.js';
import * as search from '../shared/workspace-search.js';

const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
const compiled = transformSync(`${source}\nexport { GuardEditor, PoolEditor, normalizeDraft, serializeDraft, sourceStatusLabel, sourceStatusTone, STATUS };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const jsx = (type, props) => ({ type, props });
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, crypto, require(path) {
  if (path === 'react') return { useState: (value) => [typeof value === 'function' ? value() : value, () => {}] };
  if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (path === 'lucide-react') return { Plus: 'plus-icon', Trash2: 'trash-icon', ScanSearch: 'scan-icon', LoaderCircle: 'loading-icon' };
  if (path.endsWith('telegram-permissions.js')) return permissions;
  if (path.endsWith('probe-capabilities.js')) return probeCapabilities;
  if (path.endsWith('workspace-search.js')) return search;
  return {};
} });
const { GuardEditor, PoolEditor, normalizeDraft, serializeDraft, sourceStatusLabel, sourceStatusTone, STATUS } = module.exports;
const nodes = (value) => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const field = (tree, label) => nodes(tree).find((node) => node.props?.label === label);
const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');

test('each source has an independent fallback switch that survives editing and copying', () => {
  let value = normalizeDraft('guard', { sources: [{ id: 'a', domain: 'a.example.com' }, { id: 'b', domain: 'b.example.com' }] });
  const state = { probes: [], ipPools: [], dnsAccounts: [], telegramBots: [] };
  const render = () => GuardEditor({ value, state, patch: (next) => { value = { ...value, ...next }; } });
  const toggles = nodes(render()).filter((node) => node.type?.name === 'Toggle' && node.props.className === 'ops-source-fallback');
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].props.switchControl, true);
  assert.equal(toggles[0].props.checked, false);
  assert.equal(toggles[1].props.checked, false);
  toggles[0].props.onChange(true);
  const saved = serializeDraft('guard', value);
  assert.deepEqual(Array.from(saved.sources, (source) => source.fallbackOnly), [true, false]);
  assert.deepEqual(Array.from(normalizeDraft('guard', saved).sources, (source) => source.fallbackOnly), [true, false]);
  const migrated = normalizeDraft('guard', { sourcesFallbackOnly: true, sources: [{ domain: 'old.example.com' }, { domain: 'explicit.example.com', fallbackOnly: false }] });
  assert.deepEqual(Array.from(migrated.sources, (source) => source.fallbackOnly), [true, false]);
  assert.equal(migrated.sourcesFallbackOnly, false);
  const add = nodes(render()).find((node) => node.type === 'button' && node.props.className === 'ghost ops-add-source');
  add.props.onClick();
  assert.equal(value.sources.at(-1).fallbackOnly, false);
  assert.equal(sourceStatusLabel({ status: 'fallback_idle', failedValues: ['192.0.2.1'] }), '兜底待命 · 已有其他健康 IP');
  assert.equal(sourceStatusTone({ status: 'fallback_idle', failedValues: ['192.0.2.1'] }), 'ok');
});

test('source status distinguishes partial failures and waiting for usable IPs', () => {
  assert.equal(STATUS.waiting_ip, '等待可用 IP');
  const partial = { status: 'synced', pending: false, failedValues: ['192.0.2.1', '192.0.2.2'] };
  assert.equal(sourceStatusLabel(partial), '已同步 · 2 个 IP 待复检');
  assert.equal(sourceStatusTone(partial), 'warn');
  const recovered = { ...partial, failedValues: [] };
  assert.equal(sourceStatusLabel(recovered), '主来源已同步');
  assert.equal(sourceStatusTone(recovered), 'ok');
  assert.equal(sourceStatusLabel({ status: 'resolve_error', pending: true }), '解析失败 · 待重试');
});

test('source layout groups named inputs and actions without changing field editing or deletion', () => {
  let value = normalizeDraft('guard', { sources: [{ id: 'a', domain: 'a.example.com', fallbackOnly: true },
    { id: 'b', domain: 'b.example.com', fallbackOnly: false }], sourceState: { a: { status: 'fallback_idle' } } });
  const state = { probes: [], ipPools: [], dnsAccounts: [], telegramBots: [] };
  const render = () => GuardEditor({ value, state, patch: (next) => { value = { ...value, ...next }; } });
  let tree = render();
  const items = nodes(tree).filter((node) => node.props?.className === 'ops-source-item');
  assert.equal(items.length, 2);
  for (const item of items) {
    const header = nodes(item).find((node) => node.props?.className === 'ops-source-header');
    assert.ok(nodes(header).find((node) => node.props?.className === 'ops-source-options'));
    assert.equal(nodes(item).filter((node) => node.props?.className === 'ops-source-field').length, 2);
  }
  nodes(tree).find((node) => node.props?.['aria-label'] === '来源 1 名称').props.onChange({ target: { value: 'Home' } });
  assert.equal(value.sources[0].name, 'Home');
  assert.equal(value.sources[0].fallbackOnly, true);
  tree = render();
  nodes(tree).find((node) => node.props?.['aria-label'] === '来源 1 主域名').props.onChange({ target: { value: 'new.example.com' } });
  assert.equal(value.sources[0].domain, 'new.example.com');
  assert.equal(value.sourceState.a, undefined);
  tree = render();
  nodes(tree).find((node) => node.props?.['aria-label'] === '来源 1 备用域名').props.onChange({ target: { value: 'backup.example.com' } });
  assert.equal(value.sources[0].backupDomain, 'backup.example.com');
  tree = render();
  nodes(tree).find((node) => node.props?.['aria-label'] === '删除来源 1').props.onClick();
  assert.deepEqual(Array.from(value.sources, (source) => source.id), ['b']);
  assert.equal(value.sources[0].fallbackOnly, false);
});

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

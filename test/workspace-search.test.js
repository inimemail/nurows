import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as search from '../shared/workspace-search.js';
import * as permissions from '../shared/telegram-permissions.js';

const cases = [
  ['nodes', { name: '上海探针', region: '华东', carrier: '电信' }, '电信'],
  ['targets', { name: '检查', address: 'target.EXAMPLE.com' }, 'target.example'],
  ['guards', { name: '守护', sources: [{ backupDomain: 'backup.example.com' }] }, 'backup.example'],
  ['dynamic', { name: '动态', domain: 'dynamic.example.com', currentIp: '2001:db8::1' }, '2001:DB8::1'],
  ['policies', { name: '策略', businessKey: '业务甲' }, '业务甲'],
  ['incidents', { targetName: '故障目标', policyName: '切换甲', allocatedIps: ['192.0.2.8'] }, '192.0.2.8'],
  ['assets', { name: '资产', address: '192.0.2.1', labels: ['备用甲'], region: '华南' }, '备用甲'],
  ['pools', { name: '地址池', assetIds: ['a'] }, '198.51.100.1'],
  ['usage', { address: '192.0.2.2', bindings: [{ domain: 'used.example.com' }] }, 'used.example'],
  ['accounts', { name: '账号', provider: 'huawei' }, '华为云'],
  ['bindings', { name: '绑定', domain: 'record.example.com', recordValues: ['some-TXT-value'] }, 'some-txt'],
  ['changes', { beforeValues: ['192.0.2.3'], afterValues: ['192.0.2.4'] }, '192.0.2.3'],
  ['bots', { name: '机器人', userIds: ['-10012345'] }, '-10012345']
];
const related = { ipAssets: [{ id: 'a', address: '198.51.100.1' }], dnsBindings: [{ id: 'binding', domain: 'legacy.example.com' }] };

test('all management sections search their advertised fields without modifying source records', () => {
  for (const [section, record, keyword] of cases) {
    const items = [{ id: 'match', ...record }, { id: 'other', name: 'unrelated' }], before = structuredClone(items);
    const result = search.filterWorkspaceRecords(section, items, `  ${keyword}  `, related, { huawei: '华为云 DNS' });
    assert.deepEqual(result.map((item) => item.id), ['match'], section);
    assert.equal(result[0], items[0], `${section} preserves action target identity`);
    assert.equal(search.filterWorkspaceRecords(section, items, '  '), items, `${section} clearing restores all records`);
    assert.equal(search.filterWorkspaceRecords(section, items, 'absent-keyword', related).length, 0);
    assert.deepEqual(items, before);
  }
  assert.equal(search.filterWorkspaceRecords('changes', [{ bindingId: 'binding' }], 'legacy', related).length, 1);
});

test('search never inspects secrets, commands, or unrelated state and safely handles missing fields', () => {
  for (const [section] of cases) {
    const record = { id: 'r', name: 'visible', token: 'hidden-secret', password: 'hidden-secret', command: 'hidden-secret' };
    Object.defineProperty(record, 'credentials', { get() { assert.fail('credentials read'); } });
    assert.equal(search.filterWorkspaceRecords(section, [record, {}], 'hidden-secret').length, 0, section);
  }
  const state = { get dnsGuardRuns() { assert.fail('unrelated history read'); } };
  assert.equal(search.filterWorkspaceRecords('nodes', [{ name: 'test' }], 'test', state).length, 1);
});

test('array search stops at its first match without allocating or reading remaining field values', () => {
  const values = ['192.0.2.1'];
  Object.defineProperty(values, '1', { get() { assert.fail('read IP after match'); } });
  const record = { currentValues: values };
  assert.equal(search.filterWorkspaceRecords('guards', [record], '192.0.2.1')[0], record);
  const sources = [{ domain: 'first.example.com' }, { get domain() { assert.fail('read source after match'); } }];
  assert.equal(search.filterWorkspaceRecords('guards', [{ sources }], 'first.example').length, 1);
});

test('top-level defaults and every sub-menu have matching search hints', () => {
  for (const [tab, section] of [['probes', 'nodes'], ['pools', 'assets'], ['dns', 'accounts'], ['telegram', 'bots']]) {
    assert.equal(search.workspaceSearchPlaceholder(tab), search.WORKSPACE_SEARCH[section].placeholder);
    assert.ok(!search.workspaceSearchPlaceholder(tab).includes('代理'));
  }
  for (const [section] of cases) assert.equal(search.workspaceSearchPlaceholder('probes', section), search.WORKSPACE_SEARCH[section].placeholder);
});

const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
const compiled = transformSync(`${source}\nexport { renderSection, DataView, UsageRecordsView };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness() {
  const module = { exports: {} }, jsx = (type, props) => ({ type, props });
  const slots = [], effects = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
    if (path === 'react') return { useState, useMemo: (fn) => fn(), useRef: (current) => useState({ current })[0], useEffect: (fn) => effects.push(fn) };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('workspace-search.js')) return search;
    if (path.endsWith('telegram-permissions.js')) return permissions;
    if (path.endsWith('polling.js')) return { startPolling: () => () => {} };
    if (path.endsWith('DynamicGuardWorkspace.jsx')) return { __esModule: true, default: 'dynamic' };
    throw new Error(path);
  } });
  return { ui: module.exports, call(fn, props) { cursor = 0; effects.length = 0; return fn(props); }, render(props) { cursor = 0; effects.length = 0; return module.exports.default(props); }, runEffects() { effects.forEach((fn) => fn()); } };
}
const nodes = (value) => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children)];
const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');

test('actual list renderers filter rows and preserve unfiltered editing context', () => {
  const { ui } = harness();
  for (const [section, record, keyword] of cases.filter(([section]) => !['dynamic', 'usage'].includes(section))) {
    const key = search.WORKSPACE_SEARCH[section].key, item = { id: 'match', ...record };
    const state = { ...related, [key]: [item, { id: 'other', name: 'other', address: '203.0.113.1' }] };
    let edited;
    const view = ui.renderSection(section, { state, search: keyword, guardSyncingIds: [], openEdit: (_type, target) => { edited = target; } });
    assert.equal(view.props.children.length, 1, section);
    const edit = nodes(view.props.children[0].props.actions).find((node) => node.type === 'button' && ['编辑', '编辑规则'].includes(text(node)));
    if (edit) { edit.props.onClick(); assert.equal(edited, item); }
    assert.equal(state[key].length, 2);
    const emptyView = ui.renderSection(section, { state, search: 'absent', guardSyncingIds: [] });
    assert.match(text(ui.DataView(emptyView.props)), /没有匹配结果/);
  }
});

test('search propagates through workspace, follows sub-menu changes, and reaches dynamic guards', () => {
  const h = harness(), scopes = [];
  const state = { probes: [{ id: 'p', name: 'probe-hit' }, { id: 'p2', name: 'other' }], dnsGuards: [{ id: 'g', name: 'guard-hit' }] };
  const props = { tab: 'probes', state, search: 'hit', onSearchScopeChange: (scope) => scopes.push(scope) };
  let tree = h.render(props); h.runEffects();
  assert.equal(scopes.at(-1).section, 'nodes');
  let view = nodes(tree).find((node) => node.type === h.ui.DataView);
  assert.equal(view.props.children.length, 1);
  nodes(tree).find((node) => node.type === 'button' && text(node).startsWith('DNS 守护')).props.onClick();
  tree = h.render(props); h.runEffects();
  assert.equal(scopes.at(-1).section, 'guards');
  view = nodes(tree).find((node) => node.type === h.ui.DataView);
  assert.equal(view.props.children[0].props.title, 'guard-hit');
  nodes(tree).find((node) => node.type === 'button' && text(node).startsWith('动态 IP 守护')).props.onClick();
  tree = h.render(props); h.runEffects();
  assert.equal(scopes.at(-1).section, 'dynamic');
  assert.equal(nodes(tree).find((node) => node.type === 'dynamic').props.search, 'hit');
  h.render({ ...props, tab: 'telegram' }); h.runEffects();
  assert.equal(scopes.at(-1).section, 'bots');
});

test('usage search shares the header query and composes with its status filter', () => {
  const h = harness();
  const records = [{ id: 'a', address: '192.0.2.1', poolName: 'pool', status: 'consumed' }, { id: 'b', address: '192.0.2.2', status: 'failed' }];
  let nextQuery;
  const props = { records, query: '192.0.2.1', onQueryChange: (value) => { nextQuery = value; } };
  const tree = h.call(h.ui.UsageRecordsView, props);
  const input = nodes(tree).find((node) => node.type === 'input');
  assert.equal(input.props.value, '192.0.2.1');
  assert.equal(nodes(tree).filter((node) => node.props?.title === '192.0.2.1').length, 1);
  assert.equal(nodes(tree).filter((node) => node.props?.title === '192.0.2.2').length, 0);
  input.props.onChange({ target: { value: '' } });
  assert.equal(nextQuery, '');
  nodes(tree).find((node) => node.type === 'select').props.onChange({ target: { value: 'failed' } });
  assert.match(text(h.call(h.ui.UsageRecordsView, props)), /没有匹配的使用记录/);
  const cleared = h.call(h.ui.UsageRecordsView, { ...props, query: '' });
  assert.equal(nodes(cleared).filter((node) => node.props?.title === '192.0.2.2').length, 1);
});

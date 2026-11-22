import assert from 'node:assert/strict';
import * as probeCapabilities from '../shared/probe-capabilities.js';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as telegramPermissions from '../shared/telegram-permissions.js';
import * as workspaceSearch from '../shared/workspace-search.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(api, assets, search = '', extra = {}, tab = 'pools') {
  const values = [], messages = [], updates = [];
  let cursor = 0, tree;
  const state = { ipAssets: assets || [{ id: 'a', name: '测试 IP', address: '192.0.2.1', labels: [], health: 'unknown' }], ipPools: [], ipUsageRecords: [], ...extra };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], (update) => { values[index] = typeof update === 'function' ? update(values[index]) : update; }];
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
    if (path === 'react') return { useState, useRef: (initial) => useState({ current: initial })[0], useEffect() {}, useMemo: (fn) => fn() };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path === 'lucide-react') return {};
    if (path.endsWith('polling.js')) return { startPolling() {} };
    if (path.endsWith('telegram-permissions.js')) return telegramPermissions;
    if (path.endsWith('probe-capabilities.js')) return probeCapabilities;
    if (path.endsWith('workspace-search.js')) return workspaceSearch;
    if (path.endsWith('DynamicGuardWorkspace.jsx')) return { default: 'dynamic', __esModule: true };
    if (path.endsWith('GuardSortableList.jsx')) return { default: 'guard-sort', __esModule: true };
    if (path.endsWith('PoolExternalAccessDialog.jsx')) return { default: 'pool-external-dialog', __esModule: true };
    if (path.endsWith('DnsGuardBatchDialog.jsx')) return { default: 'guard-batch-dialog', __esModule: true };
    if (path.endsWith('note-clipboard.js')) return { copyNoteText() {} };
    throw Error(path);
  } });
  function render() { cursor = 0; tree = module.exports.default({ tab, state, search, api, onState: (next) => updates.push(next), toast: (message) => messages.push(message), Dialog: 'dialog' }); }
  function nodes(value = tree) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.type === 'guard-sort' ? value.props.items.map(value.props.children) : value.props?.children ?? null), ...nodes(value.props?.actions ?? null), ...nodes(value.props?.footer ?? null)];
  }
  const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const buttons = (label) => nodes().filter((node) => node.type === 'button' && text(node) === label);
  render();
  return { render, nodes, buttons, messages, updates, state };
}

const poolFixture = () => ({ ipPools: [{ id: 'p1', name: '备用池一', assetIds: ['a'], enabled: true }] });

const healthFixture = () => ({ ...poolFixture(), ipPools: [{ ...poolFixture().ipPools[0], probeIds: ['probe'] }], probes: [{ id: 'probe', name: '在线探针', status: 'online', agentVersion: probeCapabilities.POOL_HEALTH_PROBE_VERSION, lastSeenAt: new Date().toISOString() }] });

test('each guard has a source shortcut, sends one scoped update and changes its label only after success', async () => {
  const calls=[];let finish;
  const fixture={dnsGuards:[{id:'g1',name:'守护一',domain:'one.example.com',sources:[{id:'source',domain:'source.example.com'}]},
    {id:'g2',name:'守护二',sourcesEnabled:false,sources:[]}]};
  const view=harness((path,options)=>{calls.push({path,options});return new Promise(resolve=>{finish=resolve;});},undefined,'',fixture,'probes');
  view.buttons('DNS 守护2')[0].props.onClick();view.render();
  assert.equal(view.buttons('禁用域名来源').length,1);assert.equal(view.buttons('启用域名来源').length,1);
  const click=view.buttons('禁用域名来源')[0].props.onClick;
  const pending=click();await click();view.render();
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/dns-guards/g1/sources-enabled');
  assert.equal(calls[0].options.method,'PUT');assert.deepEqual(JSON.parse(calls[0].options.body),{enabled:false});
  assert.equal(view.buttons('切换中…')[0].props.disabled,true);
  const updated={...fixture.dnsGuards[0],sourcesEnabled:false};
  finish({guard:updated});await pending;view.render();
  const next=view.updates.at(-1)({...view.state,dnsGuardOrder:['g2','g1'],ipPools:[{id:'new-pool'}]});
  assert.equal(next.dnsGuards[0].sourcesEnabled,false);assert.equal(next.dnsGuards[1].sourcesEnabled,false);
  assert.deepEqual(next.dnsGuardOrder,['g2','g1']);assert.deepEqual(next.ipPools,[{id:'new-pool'}]);
  Object.assign(view.state,next);view.render();assert.equal(view.buttons('启用域名来源').length,2);
  const enabling=view.buttons('启用域名来源')[0].props.onClick();view.render();
  assert.deepEqual(JSON.parse(calls[1].options.body),{enabled:true});
  finish({guard:{...updated,sourcesEnabled:true}});await enabling;
  Object.assign(view.state,view.updates.at(-1)(view.state));view.render();assert.equal(view.buttons('禁用域名来源').length,1);
});

test('source shortcut errors preserve the saved enabled state and allow retry', async () => {
  const view=harness(async()=>{throw Error('正在确认远程写入');},undefined,'',
    {dnsGuards:[{id:'g',name:'守护',sources:[],sourcesEnabled:true}]},'probes');
  view.buttons('DNS 守护1')[0].props.onClick();view.render();
  await view.buttons('禁用域名来源')[0].props.onClick();view.render();
  assert.equal(view.messages.at(-1),'正在确认远程写入');assert.equal(view.updates.length,0);
  assert.equal(view.buttons('禁用域名来源')[0].props.disabled,false);
});

test('every pool has an external call button including disabled and empty pools, opening the matching pool', () => {
  const view = harness(async () => {}, undefined, '', {ipPools:[
    {id:'a',name:'启用池',enabled:true,assetIds:['a']},
    {id:'b',name:'空池',enabled:false,assetIds:[]}
  ]});
  view.buttons('备用池2')[0].props.onClick(); view.render();
  assert.equal(view.buttons('外部调用').length, 2);
  for (const [i,id] of ['a','b'].entries()) {
    view.buttons('外部调用')[i].props.onClick(); view.render();
    const dialog = view.nodes().find(node=>node.type==='pool-external-dialog');
    assert.equal(dialog.props.pool.id,id);
    dialog.props.onChange({externalApiEnabled:false});
    const next=view.updates.at(-1)(view.state);
    assert.equal(next.ipPools[i].externalApiEnabled,false);
    assert.equal(next.ipPools[1-i].externalApiEnabled,undefined);
    dialog.props.onClose(); view.render();
    assert.equal(view.nodes().some(node=>node.type==='pool-external-dialog'),false);
  }
});

test('probe list deletes a probe directly and prevents repeated deletion requests', async () => {
  const calls = [];
  let finish;
  const view = harness((path, options) => { calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); }, undefined, '', healthFixture(), 'probes');
  const remove = view.buttons('删除')[0].props.onClick;
  const pending = remove(); await remove(); view.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/orchestration/probes/probe');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(view.buttons('删除')[0].props.disabled, true);
  finish({ state: { ...poolFixture(), probes: [] } }); await pending; view.render();
  assert.match(view.messages[0], /取消所有关联选择/);
});

test('a pool without any bound probes explicitly shows no probe and can still open its editor', () => {
  const view = harness(async () => {}, undefined, '', poolFixture());
  view.buttons('备用池1')[0].props.onClick(); view.render();
  const row = view.nodes().find(node => node.type?.name === 'Row');
  assert.match(row.props.subtitle, /无探针/);
  view.buttons('编辑')[0].props.onClick(); view.render();
  assert.deepEqual(Array.from(view.nodes().find(node => node.type?.name === 'PoolEditor').props.value.probeIds), []);
  assert.equal(view.buttons('保存')[0].props.disabled, true);
});

test('pool editor requires a probe and legacy pools cannot silently use all online probes', async () => {
  const calls = [];
  const fixture = healthFixture();
  delete fixture.ipPools[0].probeIds;
  const view = harness(async (...args) => { calls.push(args); return { state: fixture }; }, undefined, '', fixture);
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('检测并删除不通 IP')[0].props.onClick(); view.render();
  assert.equal(view.buttons('确认检测并删除').length, 0);
  assert.match(view.messages[0], /先编辑备用池/);
  view.buttons('编辑')[0].props.onClick(); view.render();
  assert.equal(view.buttons('保存')[0].props.disabled, true);
  await view.buttons('保存')[0].props.onClick();
  assert.equal(calls.length, 0);
  const editor = view.nodes().find(node => node.type?.name === 'PoolEditor');
  editor.props.patch({ probeIds: ['probe'] }); view.render();
  assert.equal(view.buttons('保存')[0].props.disabled, false);
  await view.buttons('保存')[0].props.onClick();
  assert.deepEqual(JSON.parse(calls[0][1].body).probeIds, ['probe']);
});

test('pool health defaults to bound probes and never substitutes an unrelated online probe', () => {
  const fixture = healthFixture();
  fixture.probes.push({ ...fixture.probes[0], id: 'unrelated', name: '其他探针' });
  const view = harness(async () => {}, undefined, '', fixture);
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('检测并删除不通 IP')[0].props.onClick(); view.render();
  const fields = () => view.nodes().find(node => node.type?.name === 'PoolHealthFields');
  assert.deepEqual(Array.from(fields().props.probes, probe => probe.id), ['probe']);
  assert.deepEqual(Array.from(fields().props.value.probeIds), ['probe']);
  fields().props.patch({ probeIds: ['unrelated'] }); view.render();
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, true);
  fields().props.patch({ probeIds: ['probe'] });
  view.state.probes[0].status = 'offline'; view.render();
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, true);
  assert.deepEqual(Array.from(fields().props.value.probeIds), ['probe']);
});

test('pool health check confirms selected probes and snapshot, defaults to 50 parallel IPs and prevents duplicate starts', async () => {
  const calls = [];
  let finish;
  const view = harness((path, options) => { calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); }, undefined, '', healthFixture());
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('检测并删除不通 IP')[0].props.onClick(); view.render();
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, false);
  view.buttons('取消')[0].props.onClick(); view.render();
  assert.equal(calls.length, 0);
  view.buttons('检测并删除不通 IP')[0].props.onClick(); view.render();
  const fields = view.nodes().find(node => node.type?.name === 'PoolHealthFields');
  assert.equal(fields.props.value.maxParallel, 50);
  assert.deepEqual(Array.from(fields.props.value.probeIds), ['probe']);
  view.state.ipPools[0].assetIds.push('added-later');
  const confirm = view.buttons('确认检测并删除')[0].props.onClick;
  const pending = confirm(); await confirm(); view.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/ip-pools/p1/health-check');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.confirm, 'check-and-delete-unreachable');
  assert.deepEqual(body.assetIds, ['a']);
  assert.equal(body.maxParallel, 50);
  assert.equal(view.buttons('启动中...')[0].props.disabled, true);
  finish({ state: { ...healthFixture(), ipAssets: [] } }); await pending; view.render();
  assert.equal(view.buttons('确认检测并删除').length, 0);
});

test('pool health setup validates online probes and numbers, and keeps errors editable for retry', async () => {
  const view = harness(async () => { throw Error('所选探针已离线'); }, undefined, '', healthFixture());
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('检测并删除不通 IP')[0].props.onClick(); view.render();
  const fields = () => view.nodes().find(node => node.type?.name === 'PoolHealthFields');
  fields().props.patch({ maxParallel: '101' }); view.render();
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, true);
  fields().props.patch({ maxParallel: '50', probeIds: [] }); view.render();
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, true);
  fields().props.patch({ probeIds: ['probe'] }); view.render();
  await view.buttons('确认检测并删除')[0].props.onClick(); view.render();
  assert.equal(fields().props.value.error, '所选探针已离线');
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, false);
  view.state.probes[0].status = 'offline'; view.render();
  assert.equal(view.buttons('确认检测并删除')[0].props.disabled, true);
});

test('running pool health checks replace the start button with an idempotent stop action', async () => {
  const fixture = healthFixture();
  fixture.ipPools[0].healthCheck = { id: 'job', status: 'running' };
  const calls = [];
  let finish;
  const view = harness((path, options) => { calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); }, undefined, '', fixture);
  view.buttons('备用池1')[0].props.onClick(); view.render();
  assert.equal(view.buttons('检测并删除不通 IP').length, 0);
  const stop = view.buttons('停止检测')[0].props.onClick;
  const pending = stop(); await stop(); view.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/ip-pools/p1/health-check/stop');
  assert.deepEqual(JSON.parse(calls[0].options.body), { jobId: 'job' });
  assert.equal(view.buttons('停止中...')[0].props.disabled, true);
  finish({ state: fixture }); await pending;
});

test('pool cleanup confirms saved membership, cancels without requests and prevents duplicate submission', async () => {
  const calls = [];
  let finish;
  const view = harness((path, options) => { calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); }, undefined, '', poolFixture());
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('删除本池空闲 IP')[0].props.onClick(); view.render();
  view.buttons('取消')[0].props.onClick(); view.render();
  assert.equal(calls.length, 0);
  view.buttons('删除本池空闲 IP')[0].props.onClick(); view.render();
  view.state.ipPools[0].assetIds.push('added-later');
  const confirm = view.buttons('确认删除空闲 IP')[0].props.onClick;
  const pending = confirm(); await confirm(); view.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/ip-pools/p1/delete-unused');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: 'delete-unused-pool-assets', assetIds: ['a'] });
  assert.equal(view.buttons('删除中...')[0].props.disabled, true);
  assert.equal(view.buttons('取消')[0].props.disabled, true);
  finish({ deletedCount: 1, skippedCount: 0, occupiedCount: 0, changedCount: 0, remainingCount: 1, state: { ipAssets: [], ipPools: [] } });
  await pending; view.render();
  assert.equal(view.buttons('确认删除空闲 IP').length, 0);
  assert.equal(view.updates.length, 1);
  assert.match(view.messages[0], /已删除 1 个.*本池剩余 1 个/);
});

test('pool cleanup allows retry after failure and preserves editor draft except deleted asset IDs', async () => {
  let calls = 0;
  const view = harness(async () => {
    if (++calls === 1) throw Error('网络中断');
    return { deletedCount: 1, skippedCount: 0, occupiedCount: 0, changedCount: 0, remainingCount: 0, state: { ipAssets: [{ id: 'b' }], ipPools: [] } };
  }, undefined, '', poolFixture());
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('编辑')[0].props.onClick(); view.render();
  const editor = () => view.nodes().find(node => node.type?.name === 'PoolEditor');
  editor().props.patch({ name: '未保存的新名称', assetIds: ['a', 'b'], note: '保留备注' }); view.render();
  editor().props.onCleanup(editor().props.value); view.render();
  assert.equal(view.nodes().filter(node => node.type === 'dialog').length, 2);
  await view.buttons('确认删除空闲 IP')[0].props.onClick(); view.render();
  assert.equal(view.buttons('确认删除空闲 IP')[0].props.disabled, false);
  assert.equal(view.messages[0], '网络中断');
  assert.equal(view.updates.length, 0);
  await view.buttons('确认删除空闲 IP')[0].props.onClick(); view.render();
  assert.equal(view.nodes().filter(node => node.type === 'dialog').length, 1);
  assert.equal(editor().props.value.name, '未保存的新名称');
  assert.equal(editor().props.value.note, '保留备注');
  assert.deepEqual(Array.from(editor().props.value.assetIds), ['b']);
});

test('cancel all selection only edits membership and never deletes IP assets', () => {
  const view = harness(() => assert.fail('deselection must not request the server'), undefined, '', poolFixture());
  view.buttons('备用池1')[0].props.onClick(); view.render();
  view.buttons('编辑')[0].props.onClick(); view.render();
  const editor = view.nodes().find(node => node.type?.name === 'PoolEditor');
  const editorTree = editor.type(editor.props);
  const multi = view.nodes(editorTree).find(node => node.type?.name === 'Multi' && node.props.label === '已有 IP 资产');
  const multiTree = multi.type(multi.props);
  const clear = view.nodes(multiTree).find(node => node.type === 'button' && node.props.children === '取消全部选择');
  clear.props.onClick(); view.render();
  assert.equal(view.nodes().find(node => node.type?.name === 'PoolEditor').props.value.assetIds.length, 0);
  assert.deepEqual(view.state.ipPools[0].assetIds, ['a']);
  assert.equal(view.state.ipAssets.length, 1);
});

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

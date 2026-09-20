import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramWorkspace } from '../server/telegram-workspace.js';
import { createTelegramActions } from '../server/telegram-actions.js';
import { clearFinishedIncidents, normalizeOrchestrationState, orchestrationDefaults } from '../server/orchestration.js';
import { TELEGRAM_FEATURES, telegramScopes } from '../shared/telegram-permissions.js';

function harness(extra = {}, options = {}) {
  const bot = { id: 'bot', enabled: true, menuScopeVersion: 2, menuScopes: TELEGRAM_FEATURES.map(([key]) => key), automationTaskIds: ['task'], role: 'operator' };
  const state = { ...orchestrationDefaults(), dynamicGuards: [], dynamicGuardRuns: [], telegramBots: [bot], ...extra };
  const packets = [], operations = [];
  let sequence = 0;
  const workspace = createTelegramWorkspace({
    readState: (keys) => { options.onRead?.(keys); return state; }, authorized: (settings) => settings?.enabled,
    readGuardHistoryPage: options.readGuardHistoryPage,
    role: (settings) => settings.role, publicUrl: 'https://panel.example.com/',
    async call(token, method, body) { const packet = { token, method, ...body, message_id: body.message_id || ++sequence }; packets.push(packet); return packet; },
    async invoke(...args) { operations.push(args); return options.invoke?.(...args); },
    clearFinishedIncidents: (ids) => { operations.push(['clear', ids]); return { removed: ids.length }; },
    liveJob: options.liveJob, cancelJob: (id) => operations.push(['cancel', id])
  });
  const latest = () => packets.findLast((packet) => packet.method !== 'answerCallbackQuery');
  const buttons = () => latest()?.reply_markup?.inline_keyboard.flat() || [];
  const find = (label) => { const item = buttons().find((button) => button.text === label); assert.ok(item, `missing ${label} in ${buttons().map((item) => item.text)}`); return item.callback_data; };
  const send = (text, user = 1, settings = bot) => workspace.handle({ message: { from: { id: user }, chat: { id: 10 }, text } }, 'token', settings);
  const click = (data, user = 1, settings = bot) => workspace.handle({ callback_query: { id: `cb-${++sequence}`, from: { id: user }, message: { chat: { id: 10 }, message_id: latest()?.message_id || 1 }, data } }, 'token', settings);
  return { workspace, state, bot, packets, operations, latest, buttons, find, send, click, press: (label) => click(find(label)) };
}
const guard = (id = 'g') => ({ id, name: `守护 ${id}`, recordType: 'A', domain: `${id}.example.com`, accountId: 'account', currentValues: ['192.0.2.1'], enabled: true, status: 'healthy' });

test('scope migration preserves old combined capabilities and explicit empty never grants access', () => {
  assert.deepEqual(telegramScopes({ menuScopes: [] }), []);
  assert.deepEqual(telegramScopes({}), []);
  assert.deepEqual(telegramScopes({ menuScopes: ['probes', 'pools', 'invented'] }), ['probes', 'pools', 'guards', 'assets']);
  assert.deepEqual(telegramScopes({ menuScopes: ['probes'], menuScopeVersion: 2 }), ['probes']);
  const migrated = normalizeOrchestrationState({ telegramBots: [{ id: 'b', menuScopes: ['probes'] }] }).telegramBots[0];
  assert.equal(migrated.menuScopeVersion, 2);
  assert.deepEqual(migrated.menuScopes, ['probes', 'guards']);
});

test('main menu has four rows, granular permissions, and no implicit management for notification-only bots', async () => {
  const h = harness();
  await h.send('/menu');
  assert.deepEqual(h.latest().reply_markup.inline_keyboard.map((row) => row.map((item) => item.text)), [
    ['系统总览', '故障事件'], ['DNS 守护', '动态 IP 守护'], ['探针与检查', 'IP 资产与备用池'], ['解析管理', '自动化任务']
  ]);
  h.bot.menuScopes = ['guards'];
  await h.send('/menu');
  assert.deepEqual(h.buttons().map((item) => item.text), ['DNS 守护']);
  h.bot.menuScopes = [];
  await h.send('/menu');
  assert.equal(h.buttons().length, 0);
  assert.match(h.latest().text, /通知仍按各自配置/);
  await h.click('guard_check:g');
  assert.match(h.latest().text, /没有访问权限/);
  assert.equal(h.operations.length, 0);
});

test('list pagination, detail return, search and abnormal filter retain context while editing messages', async () => {
  const h = harness({ dnsGuards: Array.from({ length: 17 }, (_, index) => ({ ...guard(`g${index}`), status: index === 16 ? 'error' : 'healthy' })) });
  await h.send('/guards');
  assert.equal(h.buttons().filter((item) => item.text.startsWith('守护')).length, 8);
  await h.press('下一页');
  assert.equal(h.latest().method, 'editMessageText');
  assert.match(h.latest().text, /第 2 \/ 3 页/);
  await h.click(h.buttons()[0].callback_data);
  await h.press('返回列表');
  assert.match(h.latest().text, /第 2 \/ 3 页/);
  await h.press('搜索'); await h.send('g16');
  assert.match(h.latest().text, /1 条/);
  await h.press('仅看异常');
  assert.match(h.latest().text, /仅显示异常/);
  await h.click(h.buttons()[0].callback_data); await h.press('返回列表');
  assert.match(h.latest().text, /搜索：g16/);
  await h.press('清除搜索'); await h.press('显示全部');
  assert.match(h.latest().text, /17 条/);
});

test('Telegram searches actual IP and probe fields with accurate hints and only loads needed associations', async () => {
  const reads = [];
  const h = harness({ dnsGuards: [guard()], dynamicGuards: [{ id: 'd', name: '动态', currentIp: '2001:db8::1' }],
    probes: [{ id: 'p', name: '节点', region: '上海', carrier: '电信' }],
    ipAssets: [{ id: 'ip', address: '192.0.2.9' }], ipPools: [{ id: 'pool', name: '备用', assetIds: ['ip'] }]
  }, { onRead: (keys) => reads.push(keys) });
  for (const [command, hint, query] of [['/guards', '活动 IP', '192.0.2.1'], ['/dynamic', '当前 IP', '2001:DB8::1'], ['/targets', 'IP', 'missing']]) {
    await h.send(command); await h.press('搜索'); assert.ok(h.latest().text.includes(hint));
    await h.send(query); assert.match(h.latest().text, query === 'missing' ? /0 条/ : /1 条/);
  }
  assert.ok(reads.every((keys) => !keys.includes('ipAssets')));
  await h.send('/probes'); await h.press('探针节点'); await h.press('搜索'); await h.send('电信');
  assert.match(h.latest().text, /1 条/);
  await h.send('/pools'); await h.press('搜索'); await h.send('192.0.2.9');
  assert.match(h.latest().text, /1 条/);
  assert.equal(reads.filter((keys) => keys.includes('ipAssets')).length, 1);
});

test('dynamic status labels and abnormal filter agree with the guard runtime', async () => {
  const h = harness({ dynamicGuards: ['query_error', 'limit', 'waiting_ip', 'healthy', 'verifying'].map((status) => ({ id: status, name: status, status })) });
  await h.send('/dynamic');
  assert.ok(h.buttons().some((item) => item.text === 'waiting_ip · 等待新 IP'));
  assert.ok(h.buttons().some((item) => item.text === 'verifying · 验证新 IP'));
  await h.press('仅看异常');
  assert.match(h.latest().text, /3 条/);
  assert.ok(h.buttons().some((item) => item.text === 'query_error · 查询异常'));
  assert.ok(h.buttons().some((item) => item.text === 'limit · 达到每日上限'));
});

test('Telegram guard history uses bounded page reader and never loads full history', async () => {
  const requests = [];
  const h = harness({ dnsGuards: [guard()] }, {
    onRead: (keys) => assert.ok(!keys.some((key) => key.endsWith('Runs'))),
    readGuardHistoryPage(key, id, page) { requests.push([key, id, page]); return { total: 9, pages: 2, page, records: [{ id: 'r', status: 'healthy', message: `page-${page}` }] }; }
  });
  await h.click('guard:g'); await h.press('检查记录');
  assert.match(h.latest().text, /执行记录 9 条/);
  assert.match(h.latest().text, /page-0/);
  await h.press('下一页'); assert.match(h.latest().text, /page-1/);
  assert.deepEqual(requests, [['dnsGuardRuns', 'g', 0], ['dnsGuardRuns', 'g', 1]]);
});

test('callback tokens belong to bot, chat and user; revoked feature blocks old details and actions', async () => {
  const h = harness({ dnsGuards: [guard()] });
  await h.send('/guards'); const token = h.buttons()[0].callback_data;
  await h.click(token, 2);
  assert.match(h.packets.at(-1).text, /其他用户/);
  const other = { ...h.bot, id: 'other' }; h.state.telegramBots.push(other);
  await h.click(token, 1, other);
  assert.match(h.packets.at(-1).text, /其他用户/);
  h.bot.menuScopes = [];
  await h.click(token);
  assert.match(h.latest().text, /没有访问权限/);
  assert.equal(h.operations.length, 0);
});

test('confirmation is single-use, cancelled by navigation and rechecks roles', async () => {
  const h = harness({ dnsGuards: [guard()] });
  await h.click('guard:g'); await h.press('暂停'); const first = h.find('确认');
  await h.press('取消'); await h.click(first);
  assert.match(h.latest().text, /确认已失效/);
  await h.click('guard:g'); await h.press('暂停'); const second = h.find('确认');
  h.bot.role = 'viewer'; await h.click(second); await h.workspace.drain();
  assert.equal(h.operations.length, 0);
  h.bot.role = 'operator';
  await h.click('guard_toggle:g'); await h.press('确认'); await h.workspace.drain();
  assert.equal(h.operations.length, 1);
  assert.equal(h.operations[0][3].enabled, false);
  await h.click(second); await h.workspace.drain();
  assert.equal(h.operations.length, 1);
});

test('approver can approve but cannot use an old deletion confirmation after downgrade', async () => {
  const h = harness({ incidents: [{ id: 'i', status: 'failed', targetName: 'target' }] });
  await h.click('incident:i'); await h.press('清理事件'); const old = h.find('确认');
  h.bot.role = 'approver'; await h.click(old); await h.workspace.drain();
  assert.equal(h.operations.length, 0);
  await h.click('incident_execute:i'); await h.press('确认'); await h.workspace.drain();
  assert.equal(h.operations[0][1], '/api/incidents/:id/execute');
});

test('slow operations have four workers, deduplicate resources and leave navigation responsive', async () => {
  const releases = [];
  const h = harness({ dnsGuards: Array.from({ length: 7 }, (_, i) => guard(`g${i}`)) }, { invoke: () => new Promise((resolve) => releases.push(resolve)) });
  for (let i = 0; i < 7; i++) await h.click(`guard_check:g${i}`);
  assert.equal(h.operations.length, 4);
  await h.click('guard_check:g0');
  assert.match(h.latest().text, /请勿重复点击/);
  await h.send('/menu');
  assert.match(h.latest().text, /操作菜单/);
  h.bot.menuScopes = []; // Queued requests must recheck permission when a worker is free.
  releases.forEach((resolve) => resolve({})); await h.workspace.drain();
  assert.equal(h.operations.length, 4);
  assert.ok(h.packets.some((packet) => packet.text?.includes('没有访问权限')));
});

test('operation queue is bounded and confirmation buttons expire after ten minutes', async (t) => {
  const releases = [];
  const h = harness({ dnsGuards: Array.from({ length: 37 }, (_, i) => guard(`g${i}`)) }, { invoke: () => new Promise((resolve) => releases.push(resolve)) });
  for (let i = 0; i < 37; i++) await h.click(`guard_check:g${i}`);
  assert.equal(h.operations.length, 4);
  assert.match(h.latest().text, /当前操作较多/);
  h.bot.enabled = false;
  releases.forEach((resolve) => resolve({})); await h.workspace.drain();
  assert.equal(h.operations.length, 4);
  h.bot.enabled = true;
  await h.click('guard_toggle:g0'); const token = h.find('确认');
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 600001);
  await h.click(token);
  assert.match(h.packets.at(-1).text, /过期/);
  assert.equal(h.operations.length, 4);
});

test('IP management reads cached values, supports empty guards, and only explicitly reads remote', async () => {
  const h = harness({ dnsGuards: [{ ...guard(), currentValues: [], status: 'checking' }] });
  await h.click('guard:g'); await h.press('管理 IP');
  assert.match(h.latest().text, /暂无记录/);
  assert.equal(h.operations.length, 0);
  await h.press('读取远程'); await h.workspace.drain();
  assert.equal(h.operations[0][1], '/api/dns-guards/:id/sync');
});

test('guard IP writes pass expected values, reject changed values or identity and do not expose secrets', async () => {
  for (const change of ['none', 'values', 'domain']) {
    const h = harness({ dnsGuards: [guard()] });
    await h.click('guard:g'); await h.press('管理 IP'); await h.press('添加 IP'); await h.send('192.0.2.2');
    if (change === 'values') h.state.dnsGuards[0].currentValues.push('192.0.2.3');
    if (change === 'domain') h.state.dnsGuards[0].domain = 'other.example.com';
    await h.press('确认'); await h.workspace.drain();
    assert.equal(h.operations.length, change === 'none' ? 1 : 0);
    if (change === 'none') {
      assert.equal(h.operations[0][1], '/api/dns-guards/:id/remote-values');
      assert.deepEqual(h.operations[0][3], { values: ['192.0.2.1', '192.0.2.2'], expectedValues: ['192.0.2.1'] });
    } else assert.match(h.latest().text, /变化/);
  }
});

test('unknown slash commands cancel pending input instead of becoming search or IP data', async () => {
  const h = harness({ dnsGuards: [guard()] });
  await h.send('/guards'); await h.press('搜索'); await h.send('/cancel');
  assert.match(h.latest().text, /操作菜单/);
  assert.equal(await h.send('g'), false);
  await h.click('guard:g'); await h.press('管理 IP'); await h.press('添加 IP'); await h.send('/help');
  assert.match(h.latest().text, /操作菜单/);
  assert.equal(await h.send('192.0.2.2'), false);
});

test('DNS creation uses account, domain, type, values and one final confirmation', async () => {
  const h = harness({ dnsAccounts: [{ id: 'a', name: '账号', credentialsEnc: 'never-display' }] });
  await h.send('/dns'); await h.press('新建解析'); await h.press('账号'); await h.send('test.example.com');
  await h.press('AAAA'); await h.send('2001:db8::1');
  assert.equal(h.operations.length, 0);
  await h.press('确认'); await h.workspace.drain();
  assert.equal(h.operations.length, 1);
  assert.equal(h.operations[0][0], 'POST');
  assert.deepEqual(h.operations[0][2], { resource: 'dns-bindings' });
  assert.equal(h.operations[0][3].recordType, 'AAAA');
  assert.deepEqual(h.operations[0][3].expectedValues, []);
  assert.deepEqual(h.operations[0][3].backupIps, ['2001:db8::1']);
  assert.ok(h.packets.every((packet) => !packet.text?.includes('never-display')));
});

test('DNS binding writes carry snapshot into the shared business handler without redundant sync', async () => {
  const h = harness({ dnsBindings: [guard()] });
  await h.click('dns:g'); await h.press('管理记录'); await h.press('替换全部 IP'); await h.send('192.0.2.5');
  await h.press('确认'); await h.workspace.drain();
  assert.equal(h.operations.length, 1);
  assert.equal(h.operations[0][0], 'PUT');
  assert.deepEqual(h.operations[0][3].expectedValues, ['192.0.2.1']);
});

test('dynamic guard commands reuse check/change/enabled handlers and hide encrypted commands', async () => {
  const h = harness({ dynamicGuards: [{ ...guard('d'), commandEnc: 'secret-api-command', currentIp: '192.0.2.1' }] });
  await h.send('/dynamic'); await h.click(h.buttons()[0].callback_data); const detail = h.latest();
  assert.ok(!detail.text.includes('secret-api-command'));
  const link = h.buttons().find((item) => item.url);
  assert.equal(new URL(link.url).searchParams.get('tgItem'), 'd');
  await h.press('立即检查'); await h.workspace.drain();
  assert.equal(h.operations[0][1], '/api/dynamic-guards/:id/check');
  await h.press('查看最新状态'); await h.press('手动换 IP');
  assert.equal(h.operations.length, 1);
  await h.press('确认'); await h.workspace.drain();
  assert.equal(h.operations[1][1], '/api/dynamic-guards/:id/change');
  assert.deepEqual(h.operations[1][3], { confirm: 'change-ip' });
  await h.press('查看最新状态'); await h.press('暂停'); await h.press('确认'); await h.workspace.drain();
  assert.equal(h.operations[2][1], '/api/dynamic-guards/:id/enabled');
});

test('automation runs are restricted to assigned tasks, including old cancellation buttons', async () => {
  const h = harness({ automationTasks: [{ id: 'task', name: 'visible' }, { id: 'secret', name: 'hidden' }], automationRuns: [{ id: 'r1', taskId: 'task' }, { id: 'r2', taskId: 'secret' }] }, { liveJob: () => ({ status: 'running', results: [] }) });
  await h.send('/run'); assert.equal(h.buttons().some((item) => item.text.includes('hidden')), false);
  await h.press('执行记录'); assert.equal(h.buttons().some((item) => item.text.includes('r2')), false);
  await h.click('run:r2'); assert.match(h.latest().text, /授权范围/);
  await h.click('canceljob:r1'); const confirm = h.find('确认');
  h.bot.automationTaskIds = []; await h.click(confirm); await h.workspace.drain();
  assert.equal(h.operations.length, 0);
});

test('sources are paginated and overview excludes recovered incidents', async () => {
  const sources = Array.from({ length: 9 }, (_, i) => ({ domain: `source${i}.example.com` }));
  const h = harness({ dnsGuards: [{ ...guard(), sources, sourceState: { 'source0.example.com': { status: 'healthy' } } }], incidents: [{ status: 'recovered' }, { status: 'failed' }] });
  await h.send('/status'); assert.match(h.latest().text, /活动故障：1/);
  await h.click('guard:g'); await h.press('来源状态');
  assert.match(h.latest().text, /第 1\/3 页/); assert.match(h.latest().text, /状态：正常/);
  await h.press('下一页'); await h.press('下一页'); assert.match(h.latest().text, /source8/);
});

test('finished incident cleanup preserves live allocations and rollback recovery dependencies', () => {
  let state = { ...orchestrationDefaults(), incidents: [
    { id: 'done', status: 'recovered' }, { id: 'active', status: 'checking' }, { id: 'locked', status: 'failed' },
    { id: 'recovery', status: 'failed' }, { id: 'executing', status: 'failed', executionId: 'e' }
  ], ipLeases: [{ incidentId: 'locked', status: 'active' }], dnsChanges: [{ incidentId: 'recovery', status: 'recovery_pending' }] };
  const result = clearFinishedIncidents({ updateState(fn) { state = fn(structuredClone(state)); } }, state.incidents.map((item) => item.id), 'test');
  assert.deepEqual(result, { removed: 1, kept: 4 });
  assert.equal(state.incidents.some((item) => item.id === 'done'), false);
  assert.equal(state.dnsChanges.length, 1);
});

test('route adapter propagates web validation and does not serialize full application state', async () => {
  let state = { ...orchestrationDefaults(), ipAssets: [{ id: 'a', address: '192.0.2.1' }], dnsGuards: [{ ...guard(), cycle: { id: 'c' } }] };
  const calls = [];
  const invoke = createTelegramActions({ readState: () => state, updateState(fn) { state = fn(structuredClone(state)); return state; }, sanitizeState() { throw new Error('full serialization'); } }, { request: (...args) => calls.push(args) });
  await assert.rejects(invoke('DELETE', '/api/orchestration/:resource/:id', { resource: 'ip-assets', id: 'a' }, {}, 'test'), /正在使用或被任务占用/);
  await assert.rejects(invoke('POST', '/api/dns-guards/:id/check-now', { id: 'g' }, {}, 'test'), /守护检查正在执行/);
  assert.equal(state.dnsGuards[0].cycle.id, 'c');
  await invoke('POST', '/api/dynamic-guards/:id/check', { id: 'd' }, {}, 'test');
  await assert.rejects(invoke('POST', '/api/dynamic-guards/:id/change', { id: 'd' }, {}, 'test'), /请确认/);
  assert.deepEqual(calls, [['d']]);
  state.dnsGuards = [];
  const result = await invoke('DELETE', '/api/orchestration/:resource/:id', { resource: 'ip-assets', id: 'a' }, {}, 'test');
  assert.equal(result.state, undefined);
  assert.equal(state.ipAssets.length, 0);
});

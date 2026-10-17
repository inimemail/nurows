import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { bulkDeleteIds } from '../server/bulk-delete.js';
import { registerConfigBulkDeleteRoutes } from '../server/config-bulk-delete.js';
import { orchestrationDefaults, registerOrchestrationRoutes, saveDnsBindingConfiguration } from '../server/orchestration.js';
import { registerDynamicGuardRoutes } from '../server/dynamic-guard.js';
import { createWebhookService, registerWebhookRoutes } from '../server/webhooks.js';

function harness(extra = {}, options = {}) {
  let state = { ...orchestrationDefaults(), servers: [], commands: [], automationTasks: [], ...extra }, writes = 0, telegramUpdates = 0;
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  const deps = { readState: () => structuredClone(state),
    updateState(fn) { const draft = structuredClone(state); const result = fn(draft); state = result || draft; writes++; return state; },
    sanitizeState: value => value,
    onTelegramChanged() { telegramUpdates++; }, ...options, jobs: typeof options.jobs === 'function' ? options.jobs : () => options.jobs || [] };
  registerOrchestrationRoutes(app, deps);
  registerDynamicGuardRoutes(app, deps, { isExecuting: id => options.executing?.includes(id) });
  registerConfigBulkDeleteRoutes(app, deps);
  return { deps, state: () => state, writes: () => writes, telegramUpdates: () => telegramUpdates,
    async request(path, ids, resource, body = { confirm: 'delete-records', ids }) {
      let result, status = 200;
      await routes.get(`post ${path}`)({ params: { resource }, body, auth: { username: 'test' } },
        { status(code) { status = code; return this; }, json(value) { result = value; } }, error => { throw error; });
      return { status, ...result };
    } };
}
const orchestration = (env, resource, ids, body) => env.request('/api/orchestration/:resource/delete-all', ids, resource, body);

test('bulk deletion rejects unconfirmed, malformed and oversized scopes before writing', async () => {
  for (const body of [null, {}, { confirm: true, ids: ['a'] }, { confirm: 'delete-records', ids: [] },
    { confirm: 'delete-records', ids: [1] }, { confirm: 'delete-records', ids: [''] },
    { confirm: 'delete-records', ids: ['a'.repeat(201)] }, { confirm: 'delete-records', ids: Array(20001).fill('a') }]) {
    assert.throws(() => bulkDeleteIds(body), /确认删除范围/);
    const env = harness();
    await assert.rejects(orchestration(env, 'dns-guards', [], body), /确认删除范围/);
    assert.equal(env.writes(), 0);
  }
  const env = harness();
  assert.equal((await orchestration(env, '__proto__', ['a'])).status, 404);
  assert.equal(env.writes(), 0);
});

test('DNS guard batch deletion is one write, skips active cycles, prunes order and preserves remote records/history', async () => {
  let scheduled = 0;
  const env = harness({ dnsGuards: [{ id: 'idle', currentValues: ['192.0.2.1'] }, { id: 'busy', cycle: { id: 'cycle' } }, { id: 'new' }],
    dnsGuardOrder: ['busy', 'idle', 'new'], dnsGuardRuns: [{ id: 'history', guardId: 'idle' }], dnsBindings: [{ id: 'binding' }] },
  { onDnsGuardChanged() { scheduled++; } });
  const result = await orchestration(env, 'dns-guards', ['idle', 'idle', 'busy', 'missing']);
  assert.equal(result.deletedCount, 1); assert.equal(result.skippedCount, 2); assert.equal(result.missingCount, 1);
  assert.deepEqual(env.state().dnsGuards.map(item => item.id), ['busy', 'new']);
  assert.deepEqual(env.state().dnsGuardOrder, ['busy', 'new']);
  assert.equal(env.state().dnsGuardRuns[0].guardId, 'idle'); assert.equal(env.state().dnsBindings.length, 1);
  assert.equal(env.writes(), 1); assert.equal(scheduled, 0);
  assert.match(result.reasons[0].reason, /正在执行/);
});

test('all orchestration resource lists delete in one write while retaining referenced records', async () => {
  const cases = [
    ['probes', 'probes', { dynamicGuards: [{ probeIds: ['linked'] }] }],
    ['probe-targets', 'probeTargets', { incidents: [{ status: 'automating', targetId: 'linked' }] }],
    ['ip-pools', 'ipPools', { dnsGuards: [{ poolIds: ['linked'] }] }],
    ['dns-accounts', 'dnsAccounts', { dnsGuards: [{ accountId: 'linked' }] }],
    ['dns-zones', 'dnsZones', { dnsBindings: [{ zoneId: 'linked' }] }],
    ['dns-bindings', 'dnsBindings', { failoverPolicies: [{ dnsBindingIds: ['linked'] }] }],
    ['failover-policies', 'failoverPolicies', { probeTargets: [{ policyId: 'linked' }] }],
    ['telegram-bots', 'telegramBots', { ipPools: [{ alertEnabled: true, alertBotIds: ['linked'] }] }]
  ];
  for (const [resource, key, extra] of cases) {
    const env = harness({ ...extra, [key]: [{ id: 'idle' }, { id: 'linked' }, { id: 'new' }] });
    const result = await orchestration(env, resource, ['idle', 'linked']);
    assert.equal(result.deletedCount, 1, resource); assert.equal(result.skippedCount, 1, resource);
    assert.deepEqual(env.state()[key].map(item => item.id), ['linked', 'new']);
    assert.equal(env.writes(), 1);
  }
});

test('asset batch builds occupation once and removes inventory/pool memberships without deleting history', async () => {
  let occupationReads = 0;
  const assets = Array.from({ length: 5000 }, (_, i) => ({ id: `ip${i}`, address: `192.0.${Math.floor(i / 256)}.${i % 256}` }));
  const env = harness({ ipAssets: assets, ipPools: [{ id: 'pool', assetIds: assets.map(item => item.id) }],
    ipUsageRecords: [{ id: 'history', assetId: 'ip1' }] },
  { runningAutomationIpUses() { occupationReads++; return [{ address: assets[0].address, name: 'active' }]; } });
  const result = await orchestration(env, 'ip-assets', assets.slice(0, -1).map(item => item.id));
  assert.equal(occupationReads, 1); assert.equal(env.writes(), 1);
  assert.equal(result.deletedCount, 4998); assert.equal(result.skippedCount, 1);
  assert.deepEqual(env.state().ipPools[0].assetIds, ['ip0', 'ip4999']);
  assert.equal(env.state().ipUsageRecords.length, 1);
});

test('running pool checks and their probes cannot be bulk deleted', async () => {
  const extra = { ipPools: [{ id: 'pool', healthCheck: { status: 'running', probeIds: ['probe'] } }], probes: [{ id: 'probe' }] };
  for (const [resource, id] of [['ip-pools', 'pool'], ['probes', 'probe']]) {
    const env = harness(extra);
    const result = await orchestration(env, resource, [id]);
    assert.equal(result.deletedCount, 0); assert.equal(result.skippedCount, 1);
  }
});

test('dynamic guard batch cancels waiting flows but retains executing/recovering commands and new tasks', async () => {
  const env = harness({ dynamicGuards: [{ id: 'waiting', flow: { id: 'run' } }, { id: 'active' },
    { id: 'recovering', flow: { commandState: 'executing' } }, { id: 'new' }], dynamicGuardRuns: [{ id: 'run', status: 'waiting_ip' }] }, { executing: ['active'] });
  const result = await env.request('/api/dynamic-guards/delete-all', ['waiting', 'active', 'recovering']);
  assert.equal(result.deletedCount, 1); assert.equal(result.skippedCount, 2);
  assert.deepEqual(env.state().dynamicGuards.map(item => item.id), ['active', 'recovering', 'new']);
  assert.equal(env.state().dynamicGuardRuns[0].status, 'cancelled'); assert.equal(env.writes(), 1);
});

test('command/automation batch snapshots preserve temporary commands, running jobs, linked tasks and bot permissions', async () => {
  const env = harness({ commands: [{ id: 'old' }, { id: 'new' }], automationTasks: ['idle', 'active', 'linked', 'new'].map(id => ({ id })),
    telegramBots: [{ automationTaskIds: ['idle', 'active'] }], failoverPolicies: [{ automationTaskId: 'linked' }] },
  { jobs: [{ taskId: 'active', type: 'automation', status: 'running' }] });
  const commands = await env.request('/api/commands/delete-all', ['old']);
  assert.equal(commands.deletedCount, 1); assert.deepEqual(env.state().commands, [{ id: 'new' }]);
  const tasks = await env.request('/api/automation-tasks/delete-all', ['idle', 'active', 'linked']);
  assert.equal(tasks.deletedCount, 1); assert.equal(tasks.skippedCount, 2);
  assert.deepEqual(env.state().automationTasks.map(item => item.id), ['active', 'linked', 'new']);
  assert.deepEqual(env.state().telegramBots[0].automationTaskIds, ['active']);
  assert.equal(env.telegramUpdates(), 1); assert.equal(env.writes(), 2);
});

test('server/proxy bulk deletion protects running command hosts and Webhook references, clears idle proxy assignments', async () => {
  const env = harness({ servers: [{ id: 'live', proxyId: 'liveProxy' }, { id: 'linked' }, { id: 'idle', proxyId: 'idleProxy' }],
    proxies: [{ id: 'liveProxy' }, { id: 'idleProxy' }], groups: [{ id: 'default' }] },
  { jobs: [{ status: 'running', results: [{ serverId: 'live', status: 'awaiting_input' }] }], webhookTasks: () => [{ serverId: 'linked' }] });
  const proxies = await env.request('/api/proxies/delete-all', ['liveProxy', 'idleProxy']);
  assert.equal(proxies.deletedCount, 1); assert.equal(proxies.skippedCount, 1);
  assert.equal(env.state().servers[2].proxyId, '');
  const servers = await env.request('/api/servers/delete-all', ['live', 'linked', 'idle']);
  assert.equal(servers.deletedCount, 1); assert.equal(servers.skippedCount, 2);
  assert.equal(env.state().groups.length, 1);
});

test('Webhook deletion spans pages, preserves linked/live tasks and history, revokes deleted tokens', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const guards = [];
  const service = createWebhookService({ db, encrypt: value => value, decrypt: value => value, servers: () => [], bots: () => [], guards: () => guards });
  const tasks = Array.from({ length: 55 }, (_, index) => service.save({ name: `task ${index}`, command: 'true' }));
  const ids = service.choices().map(item => item.id);
  const token = service.token(tasks[0].id);
  const newer = service.save({ name: 'created after confirmation', command: 'true' });
  guards.push({ id: 'guard', webhookTaskId: tasks[1].id });
  service.store.saveRun({ id: 'live', taskId: tasks[2].id, status: 'running', created: Date.now() });
  service.store.saveRun({ id: 'history', taskId: tasks[0].id, status: 'success', created: Date.now() });
  const result = service.removeMany({ confirm: 'delete-records', ids });
  assert.equal(result.deletedCount, 53); assert.equal(result.skippedCount, 2);
  assert.equal(service.snapshot().total, 3);
  assert.ok(service.store.task(newer.id)); assert.ok(service.store.run('history'));
  assert.throws(() => service.authenticate(tasks[0].id, token), /凭证无效/);
  // The destructive endpoint is only registered behind panel authentication.
  const publicPaths = [], app = { get: path => publicPaths.push(path), post: path => publicPaths.push(path) };
  registerWebhookRoutes(app, service, { publicOnly: true });
  assert.equal(publicPaths.some(path => path.includes('delete-all')), false);
});

test('active Webhook runs protect their SSH hosts and proxies even without a task configuration', async () => {
  const env = harness({ servers: [{ id: 'host', proxyId: 'proxy' }], proxies: [{ id: 'proxy' }, { id: 'idle' }] },
    { webhookRuns: () => [{ serverId: 'host', status: 'running' }] });
  const proxies = await env.request('/api/proxies/delete-all', ['proxy', 'idle']);
  assert.equal(proxies.deletedCount, 1); assert.equal(proxies.skippedCount, 1);
  assert.equal(env.state().servers[0].proxyId, 'proxy');
  const servers = await env.request('/api/servers/delete-all', ['host']);
  assert.equal(servers.deletedCount, 0); assert.equal(servers.skippedCount, 1);
});

test('saved command deletion avoids runtime scans and automation deletion avoids per-host scans', async () => {
  const unexpected = () => { throw new Error('unnecessary runtime scan'); };
  const commands = harness({ commands: [{ id: 'command' }] }, { jobs: unexpected, webhookTasks: unexpected, webhookRuns: unexpected });
  assert.equal((await commands.request('/api/commands/delete-all', ['command'])).deletedCount, 1);
  const tasks = harness({ automationTasks: [{ id: 'active' }, { id: 'idle' }] }, {
    jobs: [{ type: 'automation', taskId: 'active', status: 'running', get results() { return unexpected(); } }],
    webhookTasks: unexpected, webhookRuns: unexpected
  });
  const result = await tasks.request('/api/automation-tasks/delete-all', ['active', 'idle']);
  assert.equal(result.deletedCount, 1); assert.equal(result.skippedCount, 1);
});

test('DNS binding deletion waits for remote writes and releases protection after success or failure', async () => {
  for (const fails of [false, true]) {
    let release, started, writes = 0, remote = ['192.0.2.1'];
    const ready = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const binding = { id: 'binding', name: 'binding', accountId: 'account', domain: 'test.example.com', recordType: 'A', updatedAt: 'before' };
    const env = harness({ dnsAccounts: [{ id: 'account', enabled: true, provider: 'cloudflare', credentialsEnc: 'synthetic' }], dnsBindings: [binding] }, {
      decryptSecret: () => '{}',
      resolveDnsBinding: async (_state, _account, _credentials, candidate) => ({ zone: { name: 'example.com' }, normalizedBinding: candidate }),
      readDnsRecord: async () => ({ values: remote }),
      writeDnsRecord: async (_account, _credentials, _zone, _binding, values) => {
        writes++;
        if (writes === 1) { started(); await gate; if (fails) throw new Error('synthetic provider error'); }
        remote = [...values]; return ['record'];
      }
    });
    const pending = saveDnsBindingConfiguration({ ...binding, backupIps: ['192.0.2.2'], updateMode: 'replace', expectedValues: remote }, binding.id, env.deps);
    const settled = pending.then(value => ({ value }), error => ({ error }));
    await ready;
    const result = await orchestration(env, 'dns-bindings', [binding.id]);
    assert.equal(result.deletedCount, 0); assert.equal(result.skippedCount, 1);
    assert.match(result.reasons[0].reason, /正在写入/);
    release();
    const outcome = await settled;
    if (fails) { assert.match(outcome.error.message, /远端保存失败/); assert.deepEqual(remote, ['192.0.2.1']); }
    else { assert.ok(outcome.value); assert.equal(writes, 1); assert.deepEqual(remote, ['192.0.2.2']); }
    assert.equal((await orchestration(env, 'dns-bindings', [binding.id])).deletedCount, 1);
    assert.equal((await orchestration(env, 'dns-accounts', ['account'])).deletedCount, 1);
  }
});

test('overlapping new DNS saves protect an otherwise unreferenced account until both operations finish', async () => {
  const releases = [];
  const env = harness({ dnsAccounts: [{ id: 'account', enabled: true, provider: 'cloudflare', credentialsEnc: 'synthetic' }] }, {
    decryptSecret: () => '{}',
    resolveDnsBinding: () => new Promise((_resolve, reject) => { releases.push(() => reject(new Error('synthetic cancelled save'))); })
  });
  const save = domain => saveDnsBindingConfiguration({ name: domain, accountId: 'account', domain, recordType: 'A', backupIps: ['192.0.2.1'] }, '', env.deps)
    .then(() => assert.fail('expected cancellation'), error => assert.match(error.message, /synthetic cancelled/));
  const first = save('one.example.com'), second = save('two.example.com');
  assert.equal((await orchestration(env, 'dns-accounts', ['account'])).skippedCount, 1);
  releases[0](); await first;
  assert.equal((await orchestration(env, 'dns-accounts', ['account'])).skippedCount, 1);
  releases[1](); await second;
  assert.equal((await orchestration(env, 'dns-accounts', ['account'])).deletedCount, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationDefaults, registerOrchestrationRoutes, runningAutomationIpUses } from '../server/orchestration.js';

function harness(extra = {}, overrides = {}) {
  let state = { ...orchestrationDefaults(),
    ipAssets: [{ id: 'a', address: '192.0.2.1' }, { id: 'b', address: '192.0.2.2' }],
    ipPools: [{ id: 'p1', assetIds: ['a', 'b'] }, { id: 'p2', assetIds: ['a'] }],
    ipUsageRecords: [{ id: 'history', assetId: 'a', status: 'failed' }], ...extra };
  let writes = 0;
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  registerOrchestrationRoutes(app, {
    readState: () => state,
    updateState(mutate) { const next = mutate(structuredClone(state)); state = next; writes++; return state; },
    sanitizeState: () => ({ sanitized: true }), ...overrides
  });
  return { state: () => state, writes: () => writes,
    async cleanup(assetIds = ['a', 'b'], id = 'p1', confirm = 'delete-unused-pool-assets') {
      let result, status = 200;
      await routes.get('post /api/ip-pools/:id/delete-unused')({ params: { id }, body: { assetIds, confirm }, auth: { username: 'tester' } },
        { status(value) { status = value; return this; }, json(value) { result = value; } }, error => { throw error; });
      return { ...result, status };
    },
    async remove(id = 'a', resource = 'ip-assets') {
      let result;
      await routes.get('delete /api/orchestration/:resource/:id')({ params: { resource, id }, auth: { username: 'tester' } },
        { json(value) { result = value; } }, (error) => { throw error; });
      return result;
    }
  };
}

test('asset deletion removes all pool memberships in one write and preserves pools and history', async () => {
  const h = harness();
  const history = structuredClone(h.state().ipUsageRecords);
  const response = await h.remove();
  assert.equal(response.state.sanitized, true);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.state().ipAssets.map((item) => item.id), ['b']);
  assert.deepEqual(h.state().ipPools.map((item) => [item.id, item.assetIds]), [['p1', ['b']], ['p2', []]]);
  assert.deepEqual(h.state().ipUsageRecords, history);
  assert.equal(h.state().auditLogs[0].action, 'ipAssets.delete');
});

test('only live incident allocations block deletion, including expired leases while execution is active', async () => {
  for (const extra of [
    { ipLeases: [{ assetId: 'a', status: 'locked', incidentId: 'i', expiresAt: '2000-01-01' }], incidents: [{ id: 'i', executionId: 'live', status: 'allocating' }] },
    { incidents: [{ id: 'i', status: 'automating', allocatedIps: ['192.0.2.1'] }] }
  ]) {
    const h = harness(extra);
    const before = structuredClone(h.state());
    await assert.rejects(h.remove(), /正在使用或被任务占用/);
    assert.deepEqual(h.state(), before);
    assert.equal(h.writes(), 0);
  }
});

test('static DNS associations and idle or stale leases do not block manual asset deletion', async () => {
  for (const extra of [
    { dnsGuards: [{ cycle: { candidateAssets: [{ assetId: 'a', address: '192.0.2.1' }] } }] },
    { dnsGuards: [{ currentValues: ['192.0.2.1'] }] },
    { dnsBindings: [{ currentValues: ['192.0.2.1'], managedValues: ['192.0.2.1'], backupIps: ['192.0.2.1'] }] },
    { ipLeases: [{ assetId: 'a', status: 'locked', expiresAt: new Date(Date.now() + 60000).toISOString() }] },
    { ipLeases: [{ assetId: 'a', status: 'active' }] },
    { ipLeases: [{ assetId: 'a', status: 'locked', expiresAt: 'invalid' }] },
    { incidents: [{ id: 'i', status: 'failed', executionId: 'stale', allocatedIps: ['192.0.2.1'] }] },
    { incidents: [{ id: 'i', status: 'stabilizing', allocatedIps: ['192.0.2.1'] }], ipLeases: [{ assetId: 'a', incidentId: 'i', status: 'locked' }] }
  ]) {
    const h = harness(extra);
    await h.remove();
    assert.equal(h.writes(), 1);
    assert.deepEqual(h.state().ipPools[0].assetIds, ['b']);
    assert.deepEqual(h.state().dnsBindings, extra.dnsBindings || []);
    assert.equal(h.state().ipUsageRecords.length, 1);
  }
});

test('expired inactive leases and released leases do not prevent deletion; unrelated locks stay intact', async () => {
  const unrelated = { assetId: 'b', status: 'locked' };
  const h = harness({ ipLeases: [{ assetId: 'a', status: 'locked', expiresAt: '2000-01-01' }, { assetId: 'a', status: 'released' }, unrelated] });
  await h.remove();
  assert.deepEqual(h.state().ipLeases, [unrelated]);
});

test('deletion without pool membership works and missing assets do not modify state', async () => {
  const h = harness({ ipPools: [] });
  await h.remove();
  await assert.rejects(h.remove(), /IP 资产不存在/);
  assert.equal(h.writes(), 1);
});

test('the reported IP appearing only in DNS configuration can be removed from asset inventory', async () => {
  const h = harness({ ipAssets: [{ id: 'a', address: '172.235.18.185' }],
    dnsGuards: [{ currentValues: ['172.235.18.185'] }],
    dnsBindings: [{ currentValues: ['172.235.18.185'], backupIps: ['172.235.18.185'] }] });
  await h.remove();
  assert.equal(h.state().ipAssets.length, 0);
  assert.deepEqual(h.state().dnsGuards[0].currentValues, ['172.235.18.185']);
  assert.deepEqual(h.state().dnsBindings[0].backupIps, ['172.235.18.185']);
});

test('pool deletion still rejects a referenced pool', async () => {
  const h = harness({ dnsGuards: [{ poolIds: ['p1'] }] });
  await assert.rejects(h.remove('p1', 'ip-pools'), /解除关联/);
  assert.equal(h.writes(), 0);
});

test('batch removes shared unused assets in one write, preserving history and occupied IPs', async () => {
  const h = harness({ ipLeases: [{ assetId: 'b', incidentId: 'i', status: 'locked' }], incidents: [{ id: 'i', status: 'automating' }] });
  const history = structuredClone(h.state().ipUsageRecords);
  const result = await h.cleanup();
  assert.equal(result.deletedCount, 1);
  assert.equal(result.occupiedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.remainingCount, 1);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.state().ipPools.map(p => p.assetIds), [['b'], []]);
  assert.deepEqual(h.state().ipUsageRecords, history);
  assert.equal(h.state().auditLogs[0].action, 'ipPools.delete_unused');
  const repeated = await h.cleanup();
  assert.equal(repeated.deletedCount, 0);
  assert.equal(repeated.skippedCount, 2);
});

test('batch never widens confirmation to newly added members, other pools, or removed assets', async () => {
  const h = harness({ ipPools: [{ id: 'p1', assetIds: ['b'] }, { id: 'p2', assetIds: ['a'] }] });
  const result = await h.cleanup(['a', 'a', 'missing']);
  assert.equal(result.deletedCount, 0);
  assert.equal(result.changedCount, 2);
  assert.equal(result.remainingCount, 1);
  assert.equal(h.state().ipAssets.length, 2);
  assert.equal((await h.cleanup([], 'p1')).deletedCount, 0);
  await assert.rejects(h.cleanup(['a'], 'missing'), /备用池不存在/);
});

test('batch requires a valid explicit confirmation and leaves state untouched on invalid requests', async () => {
  for (const [ids, confirm] of [[['a'], ''], [null, 'delete-unused-pool-assets'], [[{}], 'delete-unused-pool-assets']]) {
    const h = harness();
    assert.equal((await h.cleanup(ids, 'p1', confirm)).status, 400);
    assert.equal(h.writes(), 0);
  }
});

test('batch and single deletion protect only running tasks and unconfirmed rebalance writes', async () => {
  for (const extra of [
    { dnsGuards: [{ cycle: { rebalanceCommit: { writeAttempted: true, desired: ['192.0.2.1'] } } }] },
    { dnsGuards: [{ cycle: { rebalanceCommit: { writeAttempted: true, returnedAssets: [{ assetId: 'a' }] } } }] },
    { incidents: [{ id: 'i', status: 'automating', allocatedIps: ['192.0.2.1'] }] },
    { incidents: [{ id: 'i', status: 'allocating', executionId: 'running' }], ipLeases: [{ assetId: 'a', incidentId: 'i', status: 'locked', expiresAt: '2000-01-01' }] }
  ]) {
    const h = harness(extra);
    await assert.rejects(h.remove(), /正在使用或被任务占用/);
    const result = await h.cleanup();
    assert.equal(result.deletedCount, 1);
    assert.equal(result.occupiedCount, 1);
    assert.deepEqual(h.state().ipAssets.map(a => a.id), ['a']);
  }
});

test('manual deletion cancels only affected candidate cycles and retains DNS state and history', async () => {
  const h = harness({ dnsGuards: [
    { id: 'g1', domain: 'one.example.com', currentValues: ['192.0.2.8'], sourceOwnedValues: ['192.0.2.8'], cycle: { id: 'c1', candidateAssets: [{ assetId: 'a', address: '192.0.2.1' }] } },
    { id: 'g2', cycle: { id: 'c2', candidateAssets: [{ assetId: 'b', address: '192.0.2.2' }] } }
  ] });
  await h.remove();
  assert.equal(h.state().dnsGuards[0].cycle, null);
  assert.equal(h.state().dnsGuards[0].status, 'queued');
  assert.deepEqual(h.state().dnsGuards[0].currentValues, ['192.0.2.8']);
  assert.deepEqual(h.state().dnsGuards[0].sourceOwnedValues, ['192.0.2.8']);
  assert.equal(h.state().dnsGuards[1].cycle.id, 'c2');
});

test('removing an unused candidate preserves a pending rebalance commit after restart', async () => {
  for (const batch of [false, true]) {
    const cycle = { id: 'pending', candidateAssets: [{ assetId: 'a', address: '192.0.2.1' }, { assetId: 'b', address: '192.0.2.2' }],
      rebalanceCommit: { writeAttempted: true, desired: ['192.0.2.1'], usedAssets: [{ assetId: 'a', address: '192.0.2.1' }] } };
    const h = harness({ dnsGuards: [{ id: 'g', cycle }] });
    if (batch) {
      const result = await h.cleanup();
      assert.equal(result.deletedCount, 1);
      assert.equal(result.occupiedCount, 1);
    } else await h.remove('b');
    assert.deepEqual(h.state().dnsGuards[0].cycle, cycle);
    assert.deepEqual(h.state().ipAssets.map(asset => asset.id), ['a']);
    await assert.rejects(h.remove('a'), /正在写入或确认 DNS 结果/);
  }
});

test('automation occupation comes from live jobs and unfinished hosts, never persisted run history', async () => {
  const jobs = [{ type: 'automation', taskName: '部署网站', status: 'running', results: [
    { serverId: 'a', host: '192.0.2.1', status: 'awaiting_input' }, { host: '192.0.2.2', status: 'done' },
    { host: '192.0.2.3', status: 'queued' }
  ] }, { type: 'automation', status: 'done', results: [{ host: '192.0.2.9', status: 'running' }] },
  { type: 'command', status: 'running', results: [{ host: '192.0.2.10', status: 'running' }] }];
  const uses = runningAutomationIpUses(jobs);
  assert.deepEqual(uses.map((use) => use.address), ['192.0.2.1', '192.0.2.3']);
  const h = harness({ automationRuns: [{ status: 'running' }] }, { runningAutomationIpUses: () => runningAutomationIpUses(jobs) });
  await assert.rejects(h.remove(), /自动化任务「部署网站」正在执行/);
  await h.remove('b');
  jobs[0].cancelled = true;
  await h.remove();
});

test('IPv6 equivalent addresses in live automation jobs are protected', async () => {
  const h = harness({ ipAssets: [{ id: 'a', address: '2606:4700:4700:0:0:0:0:1111' }] },
    { runningAutomationIpUses: () => [{ address: '2606:4700:4700::1111', name: 'IPv6 deploy' }] });
  await assert.rejects(h.remove(), /IPv6 deploy/);
});

test('large pool cleanup persists once rather than once per IP', async () => {
  const assets = Array.from({ length: 10000 }, (_, i) => ({ id: `a${i}`, address: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` }));
  const ids = assets.map(a => a.id);
  const h = harness({ ipAssets: assets, ipPools: [{ id: 'p1', assetIds: ids }, { id: 'p2', assetIds: ids.slice(0, 500) }] });
  const result = await h.cleanup(ids);
  assert.equal(result.deletedCount, 10000);
  assert.equal(result.remainingCount, 0);
  assert.equal(h.writes(), 1);
});

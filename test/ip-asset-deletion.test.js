import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationDefaults, registerOrchestrationRoutes } from '../server/orchestration.js';

function harness(extra = {}) {
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
    sanitizeState: () => ({ sanitized: true })
  });
  return { state: () => state, writes: () => writes,
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

test('locked, active, and still-running expired allocations cannot be deleted', async () => {
  for (const extra of [
    { ipLeases: [{ assetId: 'a', status: 'locked', expiresAt: new Date(Date.now() + 60000).toISOString() }] },
    { ipLeases: [{ assetId: 'a', status: 'active' }] },
    { ipLeases: [{ assetId: 'a', status: 'locked', expiresAt: 'invalid' }] },
    { ipLeases: [{ assetId: 'a', status: 'locked', incidentId: 'i', expiresAt: '2000-01-01' }], incidents: [{ id: 'i', status: 'stabilizing' }] },
    { incidents: [{ id: 'i', status: 'automating', allocatedIps: ['192.0.2.1'] }] }
  ]) {
    const h = harness(extra);
    const before = structuredClone(h.state());
    await assert.rejects(h.remove(), /正在使用或被任务占用/);
    assert.deepEqual(h.state(), before);
    assert.equal(h.writes(), 0);
  }
});

test('DNS guard candidates and current DNS addresses are protected', async () => {
  for (const extra of [
    { dnsGuards: [{ cycle: { candidateAssets: [{ assetId: 'a', address: '192.0.2.1' }] } }] },
    { dnsGuards: [{ currentValues: ['192.0.2.1'] }] },
    { dnsBindings: [{ currentValues: ['192.0.2.1'] }] }
  ]) {
    const h = harness(extra);
    await assert.rejects(h.remove(), /正在使用或被任务占用/);
    assert.equal(h.writes(), 0);
    assert.deepEqual(h.state().ipPools[0].assetIds, ['a', 'b']);
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

test('pool deletion still rejects a referenced pool', async () => {
  const h = harness({ dnsGuards: [{ poolIds: ['p1'] }] });
  await assert.rejects(h.remove('p1', 'ip-pools'), /解除关联/);
  assert.equal(h.writes(), 0);
});

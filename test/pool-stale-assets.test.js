import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationDefaults, registerOrchestrationRoutes } from '../server/orchestration.js';

function harness() {
  let state = { ...orchestrationDefaults(), ipAssets: [{ id: 'kept', address: '192.0.2.2' }],
    ipPools: [{ id: 'pool', name: 'pool', assetIds: ['kept'] }] };
  const routes = new Map();
  const changes = [];
  registerOrchestrationRoutes(Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, fn) => routes.set(`${method} ${path}`, fn)])), {
    readState: () => state,
    updateState(fn) { state = fn(structuredClone(state)); return state; },
    sanitizeState: (value) => value,
    onIpAvailabilityChanged: (change) => changes.push(change)
  });
  return { state: () => state, changes, async save(method, body) {
    let response;
    await routes.get(`${method} /api/orchestration/:resource${method === 'put' ? '/:id' : ''}`)({
      params: { resource: 'ip-pools', id: 'pool' }, auth: { username: 'test' }, body
    }, { json: (value) => { response = value; } }, (error) => { throw error; });
    return response;
  } };
}

for (const method of ['post', 'put']) {
  test(`${method} pool drops stale IDs but explicitly reimports consumed addresses with new IDs`, async () => {
    const h = harness();
    const response = await h.save(method, { name: 'pool', assetIds: ['consumed-old-id', 'kept'], newAssetAddresses: '192.0.2.1\n192.0.2.2' });
    assert.equal(response.ignoredAssetCount, 1);
    assert.equal(h.state().ipAssets.length, 2);
    const imported = h.state().ipAssets.find((asset) => asset.address === '192.0.2.1');
    assert.notEqual(imported.id, 'consumed-old-id');
    assert.deepEqual(response.item.assetIds, ['kept', imported.id]);
    assert.deepEqual(h.changes, [{ poolIds: [response.item.id] }]);
  });
}

test('stale IDs alone cannot resurrect consumed IPs and deliberate deselection is preserved', async () => {
  const h = harness();
  const response = await h.save('put', { name: 'pool', assetIds: ['consumed-old-id'] });
  assert.deepEqual(response.item.assetIds, []);
  assert.equal(response.ignoredAssetCount, 1);
  assert.deepEqual(h.state().ipAssets.map((asset) => asset.id), ['kept']);
});

test('invalid imports still reject atomically without partial pool changes', async () => {
  const h = harness();
  const before = structuredClone(h.state());
  await assert.rejects(h.save('put', { name: 'pool', assetIds: ['old'], newAssetAddresses: '192.0.2.1\ninvalid' }), /格式不正确/);
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.changes, []);
});

test('stale selections are removed before the pool size bound, not after truncating new imports', async () => {
  const h = harness();
  const response = await h.save('put', { name: 'pool', assetIds: Array.from({ length: 5000 }, (_, i) => `old-${i}`), newAssetAddresses: '192.0.2.1' });
  assert.equal(response.ignoredAssetCount, 5000);
  assert.equal(response.item.assetIds.length, 1);
  assert.equal(h.state().ipAssets.find((asset) => asset.id === response.item.assetIds[0]).address, '192.0.2.1');
});

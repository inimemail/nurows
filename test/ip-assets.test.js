import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeIncidentIpAssets, finalizeIpUsageRecords, importIpAssets, normalizeOrchestrationState, parseIpBatch, releaseIncidentIpLocks, startIpUsageRecords } from '../server/orchestration.js';

test('parses IPv4 and IPv6 batches and removes duplicates', () => {
  assert.deepEqual(parseIpBatch('1.1.1.1\n2001:db8::1, 1.1.1.1'), ['1.1.1.1', '2001:db8::1']);
});

test('rejects the whole batch when one IP is invalid', () => {
  assert.throws(() => parseIpBatch('1.1.1.1\n999.1.1.1'), /999\.1\.1\.1/);
});

test('reuses existing assets and creates missing assets', () => {
  const state = {
    ipAssets: [{ id: 'existing', address: '1.1.1.1', name: 'existing' }],
    auditLogs: []
  };
  const result = importIpAssets(state, ['1.1.1.1', '2.2.2.2'], { region: '上海', carrier: '电信' }, 'tester');
  assert.equal(result.created, 1);
  assert.equal(result.reused, 1);
  assert.deepEqual(result.assetIds[0], 'existing');
  assert.equal(state.ipAssets[1].address, '2.2.2.2');
  assert.equal(state.ipAssets[1].region, '上海');
});

test('consumes allocated assets only after a successful incident', () => {
  const state = {
    ipAssets: [
      { id: 'a1', address: '1.1.1.1' },
      { id: 'a2', address: '2.2.2.2' },
      { id: 'a3', address: '3.3.3.3' }
    ],
    ipPools: [
      { id: 'p1', assetIds: ['a1', 'a2'] },
      { id: 'p2', assetIds: ['a1', 'a3'] }
    ],
    ipLeases: [
      { id: 'l1', assetId: 'a1', incidentId: 'incident-1', status: 'locked' },
      { id: 'l2', assetId: 'a1', incidentId: 'old-incident', status: 'released' }
    ]
  };

  const result = consumeIncidentIpAssets(state, 'incident-1');
  assert.deepEqual(result.addresses, ['1.1.1.1']);
  assert.deepEqual(state.ipAssets.map((item) => item.id), ['a2', 'a3']);
  assert.deepEqual(state.ipPools, [
    { id: 'p1', assetIds: ['a2'] },
    { id: 'p2', assetIds: ['a3'] }
  ]);
  assert.deepEqual(state.ipLeases, []);
});

test('releases only the internal lock when an incident fails', () => {
  const state = {
    ipAssets: [{ id: 'a1', address: '1.1.1.1' }],
    ipPools: [{ id: 'p1', assetIds: ['a1'] }],
    ipLeases: [{ id: 'l1', assetId: 'a1', incidentId: 'incident-1', status: 'locked' }]
  };

  assert.equal(releaseIncidentIpLocks(state, 'incident-1'), 1);
  assert.deepEqual(state.ipAssets, [{ id: 'a1', address: '1.1.1.1' }]);
  assert.deepEqual(state.ipPools, [{ id: 'p1', assetIds: ['a1'] }]);
  assert.deepEqual(state.ipLeases, []);
});

test('removes legacy lease settings and released locks during state normalization', () => {
  const state = normalizeOrchestrationState({
    ipPools: [{ id: 'p1', name: 'pool', leaseMinutes: 30, cooldownMinutes: 10, sharingMode: 'limited', shareLimit: 2 }],
    ipLeases: [
      { id: 'released', status: 'released' },
      { id: 'locked', status: 'locked' }
    ]
  });

  assert.deepEqual(state.ipPools, [{ id: 'p1', name: 'pool' }]);
  assert.deepEqual(state.ipLeases, [{ id: 'locked', status: 'locked' }]);
});

test('keeps a complete IP usage record after the asset is consumed', () => {
  const state = {
    incidents: [{ id: 'incident-1', targetId: 'target-1', policyId: 'policy-1', targetName: '主站', policyName: '自动切换' }],
    failoverPolicies: [{ id: 'policy-1', name: '自动切换', automationTaskId: 'task-1', dnsBindingIds: ['binding-1'] }],
    probeTargets: [{ id: 'target-1', name: '主站' }],
    automationTasks: [{ id: 'task-1', name: '部署节点' }],
    dnsBindings: [{ id: 'binding-1', domain: 'www.example.com', recordType: 'A' }],
    ipPools: [{ id: 'pool-1', name: '上海备用池', assetIds: ['asset-1'] }],
    ipAssets: [{ id: 'asset-1', address: '1.1.1.1' }],
    ipLeases: [{ id: 'lease-1', assetId: 'asset-1', poolId: 'pool-1', incidentId: 'incident-1', status: 'locked' }],
    ipUsageRecords: []
  };

  const records = startIpUsageRecords(state, 'incident-1', [{ address: '1.1.1.1', assetId: 'asset-1', poolId: 'pool-1', leaseId: 'lease-1' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'processing');
  assert.equal(records[0].poolName, '上海备用池');
  assert.equal(records[0].automationTaskName, '部署节点');
  assert.deepEqual(records[0].bindings, [{ id: 'binding-1', domain: 'www.example.com', recordType: 'A' }]);

  consumeIncidentIpAssets(state, 'incident-1');
  assert.equal(finalizeIpUsageRecords(state, 'incident-1', 'consumed'), 1);
  assert.equal(state.ipUsageRecords[0].address, '1.1.1.1');
  assert.equal(state.ipUsageRecords[0].status, 'consumed');
  assert.equal(state.ipAssets.length, 0);
});

test('marks the usage record failed while retaining the IP asset', () => {
  const state = {
    incidents: [{ id: 'incident-1', targetId: 'target-1', policyId: 'policy-1' }],
    failoverPolicies: [{ id: 'policy-1', dnsBindingIds: [] }],
    probeTargets: [],
    automationTasks: [],
    dnsBindings: [],
    ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['asset-1'] }],
    ipAssets: [{ id: 'asset-1', address: '2.2.2.2' }],
    ipLeases: [{ id: 'lease-1', assetId: 'asset-1', poolId: 'pool-1', incidentId: 'incident-1', status: 'locked' }],
    ipUsageRecords: []
  };

  startIpUsageRecords(state, 'incident-1', [{ address: '2.2.2.2', assetId: 'asset-1', poolId: 'pool-1', leaseId: 'lease-1' }]);
  releaseIncidentIpLocks(state, 'incident-1');
  finalizeIpUsageRecords(state, 'incident-1', 'failed', '自动化执行失败');
  assert.equal(state.ipUsageRecords[0].status, 'failed');
  assert.equal(state.ipUsageRecords[0].error, '自动化执行失败');
  assert.equal(state.ipAssets[0].address, '2.2.2.2');
});

test('updates only the current attempt when an incident is retried', () => {
  const state = {
    ipUsageRecords: [
      { id: 'old', incidentId: 'incident-1', leaseId: 'old-lease', status: 'rolled_back' },
      { id: 'current', incidentId: 'incident-1', leaseId: 'current-lease', status: 'rolled_back' }
    ]
  };

  assert.equal(finalizeIpUsageRecords(state, 'incident-1', 'failed', '本次失败', ['current-lease']), 1);
  assert.equal(state.ipUsageRecords[0].status, 'rolled_back');
  assert.equal(state.ipUsageRecords[1].status, 'failed');
});

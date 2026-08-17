import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeIncidentIpAssets, crossedInventoryThresholds, dnsVerificationMatches, evaluateTargetHealth, finalizeIpUsageRecords, importIpAssets, migratePoolAlertBotSelections, normalizeOrchestrationState, parseIpBatch, releaseIncidentIpLocks, requestWaitingIncidentRechecks, restoreDnsBindingLocalState, retryWaitingIpIncidents, rollbackIncident, runIncidentWorkflow, startIpUsageRecords, syncDnsBindingLocalState } from '../server/orchestration.js';

function failedObservation(checkedAt = new Date().toISOString()) {
  return { ok: false, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3, attempts: 9, checkedAt };
}

function failedTarget(overrides = {}) {
  const checkedAt = new Date().toISOString();
  return {
    id: 'target-1', name: '主站', address: '203.0.113.10', health: 'down',
    probeIds: ['probe-1'], interval: 30, timeout: 5, lastCheckAt: checkedAt,
    observations: { 'probe-1': failedObservation(checkedAt) },
    ...overrides
  };
}

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
    probeTargets: [{ id: 'target-1', failureThreshold: 3, recoveryThreshold: 2, observations: { p1: { ok: false, failures: 3, successes: 0 } } }],
    ipLeases: [
      { id: 'released', status: 'released' },
      { id: 'locked', status: 'locked' }
    ]
  });

  assert.deepEqual(state.ipPools, [{ id: 'p1', name: 'pool' }]);
  assert.deepEqual(state.ipLeases, [{ id: 'locked', status: 'locked' }]);
  assert.equal(state.probeTargets[0].failureThreshold, undefined);
  assert.equal(state.probeTargets[0].recoveryThreshold, undefined);
  assert.equal(state.probeTargets[0].checkRounds, 3);
  assert.equal(state.probeTargets[0].attemptsPerRound, 3);
  assert.deepEqual(state.probeTargets[0].observations.p1, { ok: false });
});

test('migrates pool alerts to bot recipients and removes pool-level chat IDs', () => {
  const state = normalizeOrchestrationState({
    telegramBots: [{ id: 'bot-1', enabled: true, tokenEnc: 'encrypted', userIds: ['10001'] }],
    ipPools: [{ id: 'pool-1', alertEnabled: true, alertThresholds: [5, 1, 0], alertBotIds: [], alertChatIds: ['legacy-chat'] }]
  });
  assert.deepEqual(state.ipPools[0].alertBotIds, ['bot-1']);
  assert.equal('alertChatIds' in state.ipPools[0], false);

  const legacyState = normalizeOrchestrationState({
    ipPools: [{ id: 'pool-legacy', alertEnabled: true, alertThresholds: [1, 0], alertBotIds: [] }]
  });
  legacyState.telegramBots.push({ id: 'telegram-primary', enabled: true, tokenEnc: 'encrypted', userIds: ['10001'] });
  migratePoolAlertBotSelections(legacyState);
  assert.deepEqual(legacyState.ipPools[0].alertBotIds, ['telegram-primary']);
});

test('notifies only when inventory drops across configured thresholds', () => {
  const thresholds = [5, 3, 1, 0];
  assert.deepEqual(crossedInventoryThresholds(6, 5, thresholds), [5]);
  assert.deepEqual(crossedInventoryThresholds(6, 0, thresholds), [5, 3, 1, 0]);
  assert.deepEqual(crossedInventoryThresholds(5, 4, thresholds), []);
  assert.deepEqual(crossedInventoryThresholds(0, 5, thresholds), []);
});

test('migrates old no-IP failures into the waiting state', () => {
  const state = normalizeOrchestrationState({ incidents: [{ id: 'i1', status: 'failed', message: '执行失败', error: '备用 IP 池没有满足策略的可用 IP' }] });
  assert.equal(state.incidents[0].status, 'waiting_for_ip');
  assert.equal(state.incidents[0].message, '等待备用 IP');
  assert.equal(state.incidents[0].error, '');
});

test('normalizes legacy DNS change values for the change history view', () => {
  const state = normalizeOrchestrationState({
    dnsChanges: [{ id: 'change-1', beforeValues: '1.1.1.1, 2.2.2.2', afterValues: null }]
  });
  assert.deepEqual(state.dnsChanges[0].beforeValues, ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(state.dnsChanges[0].afterValues, []);
});

test('verifies replacement IPs against provider records by address family', () => {
  assert.equal(dnsVerificationMatches('A', ['172.236.12.169'], ['172.236.12.169']), true);
  assert.equal(dnsVerificationMatches('A', ['198.51.100.8'], ['172.236.12.169']), false);
  assert.equal(dnsVerificationMatches('A', ['172.236.12.169', '198.51.100.8'], ['172.236.12.169']), false);
  assert.equal(dnsVerificationMatches('AAAA', ['2001:db8::8'], ['172.236.12.169']), false);
  assert.equal(dnsVerificationMatches('A', [], []), true);
});

test('keeps local DNS values aligned with remote writes and rollbacks', () => {
  const binding = { id: 'binding-1', recordType: 'A', backupIps: ['1.1.1.1'], currentValues: ['1.1.1.1'], managedValues: ['1.1.1.1'] };
  syncDnsBindingLocalState(binding, ['2.2.2.2', '3.3.3.3'], ['3.3.3.3'], ['record-2'], '2026-08-17T01:00:00.000Z');
  assert.deepEqual(binding.backupIps, ['2.2.2.2', '3.3.3.3']);
  assert.deepEqual(binding.currentValues, ['2.2.2.2', '3.3.3.3']);
  assert.deepEqual(binding.managedValues, ['3.3.3.3']);
  assert.equal(binding.providerRecordId, 'record-2');
  assert.equal(binding.lastSyncAt, '2026-08-17T01:00:00.000Z');

  restoreDnsBindingLocalState(binding, { beforeValues: ['1.1.1.1'], beforeManagedValues: ['1.1.1.1'] }, ['record-1'], '2026-08-17T01:01:00.000Z');
  assert.deepEqual(binding.backupIps, ['1.1.1.1']);
  assert.deepEqual(binding.currentValues, ['1.1.1.1']);
  assert.deepEqual(binding.managedValues, ['1.1.1.1']);
  assert.equal(binding.providerRecordId, 'record-1');
});

test('runs a complete failover DNS write and restores remote and local values on rollback', async () => {
  const oldIp = '203.0.113.10';
  const replacementIp = '198.51.100.40';
  let remoteValues = [oldIp];
  const state = {
    incidents: [{ id: 'incident-dns', targetId: 'target-1', targetName: '主站', policyId: 'policy-1', status: 'queued', executionId: '', leaseIds: [], allocatedIps: [], dnsChangeIds: [] }],
    failoverPolicies: [{ id: 'policy-1', name: 'DNS 切换', poolIds: ['pool-1'], automationTaskId: '', dnsBindingIds: ['binding-1'], autoRollback: true, enabled: true }],
    probes: [{ id: 'probe-1', enabled: true }],
    probeTargets: [failedTarget()],
    ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['asset-1'], allocationMode: 'one', selectionMode: 'ordered', enabled: true }],
    ipAssets: [{ id: 'asset-1', address: replacementIp, enabled: true, health: 'unknown' }],
    ipLeases: [], ipUsageRecords: [],
    dnsAccounts: [{ id: 'account-1', provider: 'huawei', credentialsEnc: 'encrypted', enabled: true }],
    dnsBindings: [{ id: 'binding-1', name: '主站解析', accountId: 'account-1', domain: 'www.example.com', recordName: 'www', recordType: 'A', updateMode: 'replace', backupIps: [oldIp], currentValues: [oldIp], managedValues: [oldIp], enabled: true }],
    dnsChanges: [], auditLogs: []
  };
  const deps = {
    readState: () => state,
    updateState: (updater) => updater(state),
    decryptSecret: () => '{}',
    resolveDnsBinding: async (_state, _account, _credentials, binding) => ({ zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' }, normalizedBinding: binding }),
    readDnsRecord: async () => ({ values: [...remoteValues], recordId: 'record-1', recordIds: ['record-1'] }),
    writeDnsRecord: async (_account, _credentials, _zone, _binding, values) => { remoteValues = [...values]; return ['record-1']; },
    executeAutomation: async () => ({ jobId: 'unused' }),
    waitAutomation: async () => {},
    checkIp: async () => ({ ok: true, error: '' })
  };

  await runIncidentWorkflow('incident-dns', deps);

  assert.equal(state.incidents[0].status, 'succeeded');
  assert.deepEqual(remoteValues, [replacementIp]);
  assert.deepEqual(state.dnsBindings[0].backupIps, [replacementIp]);
  assert.deepEqual(state.dnsBindings[0].currentValues, [replacementIp]);
  assert.deepEqual(state.dnsBindings[0].managedValues, [replacementIp]);
  assert.deepEqual(state.dnsChanges[0].beforeValues, [oldIp]);
  assert.deepEqual(state.dnsChanges[0].afterValues, [replacementIp]);

  await rollbackIncident('incident-dns', deps, 'tester');

  assert.equal(state.incidents[0].status, 'rolled_back');
  assert.deepEqual(remoteValues, [oldIp]);
  assert.deepEqual(state.dnsBindings[0].backupIps, [oldIp]);
  assert.deepEqual(state.dnsBindings[0].currentValues, [oldIp]);
  assert.deepEqual(state.dnsBindings[0].managedValues, [oldIp]);
  assert.equal(state.dnsChanges[0].status, 'rolled_back');
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

test('uses all assigned probes for a round, with any success winning the round', () => {
  const probes = [{ id: 'p1', enabled: true }, { id: 'p2', enabled: true }];
  const base = { id: 'target-1', probeIds: ['p1', 'p2'], interval: 30, timeout: 5 };
  const checkedAt = new Date().toISOString();
  const failedCheck = failedObservation(checkedAt);
  assert.deepEqual(evaluateTargetHealth({ ...base, observations: {
    p1: failedCheck,
    p2: { ok: true, rounds: 3, attemptsPerRound: 3, roundsCompleted: 1, attempts: 1, checkedAt }
  } }, probes), { failed: false, health: 'healthy' });
  assert.deepEqual(evaluateTargetHealth({ ...base, observations: {
    p1: failedCheck,
    p2: failedCheck
  } }, probes), { failed: true, health: 'down' });
  assert.deepEqual(evaluateTargetHealth({ ...base, checkRounds: 2, attemptsPerRound: 2, observations: {
    p1: { ok: false, rounds: 2, attemptsPerRound: 2, roundsCompleted: 2, attempts: 4, checkedAt },
    p2: { ok: false, rounds: 2, attemptsPerRound: 2, roundsCompleted: 2, attempts: 4, checkedAt }
  } }, probes), { failed: true, health: 'down' });
});

test('does not trigger failover from legacy or stale single-attempt failures', () => {
  const probes = [{ id: 'p1', enabled: true }];
  const base = { id: 'target-1', probeIds: ['p1'], interval: 30, timeout: 5 };
  assert.deepEqual(evaluateTargetHealth({ ...base, observations: {
    p1: { ok: false, checkedAt: new Date().toISOString() }
  } }, probes), { failed: false, health: 'observing' });
  assert.deepEqual(evaluateTargetHealth({ ...base, observations: {
    p1: { ok: false, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3, attempts: 9, checkedAt: new Date(Date.now() - 120000).toISOString() }
  } }, probes), { failed: false, health: 'observing' });
});

test('waits without a replacement IP and retries after one becomes available', async () => {
  const state = {
    incidents: [{ id: 'incident-wait', targetId: 'target-1', targetName: '主站', policyId: 'policy-1', status: 'queued', executionId: '', leaseIds: [], allocatedIps: [], dnsChangeIds: [] }],
    failoverPolicies: [{ id: 'policy-1', name: '切换', poolIds: [], automationTaskId: '', dnsBindingIds: [], enabled: true }],
    probes: [{ id: 'probe-1', enabled: true }],
    probeTargets: [failedTarget()],
    ipPools: [],
    ipAssets: [],
    ipLeases: [],
    ipUsageRecords: [],
    dnsBindings: [],
    dnsChanges: [],
    auditLogs: []
  };
  const deps = {
    readState: () => state,
    updateState: (updater) => updater(state),
    executeAutomation: async () => { throw new Error('automation must wait for an IP'); },
    waitAutomation: async () => {},
    checkIp: async () => ({ ok: true, error: '' })
  };
  await runIncidentWorkflow('incident-wait', deps);
  assert.equal(state.incidents[0].status, 'waiting_for_ip');
  assert.equal(state.incidents[0].message, '等待备用 IP');

  state.ipAssets.push({ id: 'asset-1', address: '198.51.100.20', enabled: true, health: 'unknown' });
  state.ipPools.push({ id: 'pool-1', name: '备用池', assetIds: ['asset-1'], allocationMode: 'one', selectionMode: 'ordered', enabled: true });
  state.failoverPolicies[0].poolIds = ['pool-1'];
  assert.equal(requestWaitingIncidentRechecks(deps), 1);
  const recheckedAt = new Date().toISOString();
  state.probeTargets[0].lastCheckAt = recheckedAt;
  state.probeTargets[0].observations['probe-1'].checkedAt = recheckedAt;
  assert.equal(retryWaitingIpIncidents(deps), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.incidents[0].status, 'succeeded');
  assert.equal(state.ipAssets.length, 0);
});

test('closes a waiting incident when probes confirm the target recovered', () => {
  const state = {
    incidents: [{ id: 'incident-recovered', targetId: 'target-1', policyId: 'policy-1', status: 'waiting_for_ip', executionId: '', recheckRequestedAt: '' }],
    probeTargets: [{ id: 'target-1', health: 'healthy', lastCheckAt: new Date().toISOString() }],
    failoverPolicies: [{ id: 'policy-1', poolIds: [] }],
    ipPools: [], ipAssets: [], ipLeases: [], ipUsageRecords: [], auditLogs: []
  };
  const deps = { readState: () => state, updateState: (updater) => updater(state) };
  assert.equal(retryWaitingIpIncidents(deps), 0);
  assert.equal(state.incidents[0].status, 'recovered');
});

test('does not combine a fresh failure with another probe old success after an IP recheck request', () => {
  const requestedAt = new Date().toISOString();
  const freshAt = new Date(Date.now() + 10).toISOString();
  const oldAt = new Date(Date.now() - 20000).toISOString();
  const state = {
    incidents: [{ id: 'incident-recheck', targetId: 'target-1', policyId: 'policy-1', status: 'waiting_for_ip', executionId: '', recheckRequestedAt: requestedAt }],
    probes: [{ id: 'p1', enabled: true }, { id: 'p2', enabled: true }],
    probeTargets: [{ id: 'target-1', health: 'healthy', probeIds: ['p1', 'p2'], observations: {
      p1: { ...failedObservation(freshAt) },
      p2: { ok: true, rounds: 3, attemptsPerRound: 3, roundsCompleted: 1, attempts: 1, checkedAt: oldAt }
    } }],
    failoverPolicies: [{ id: 'policy-1', poolIds: [] }],
    ipPools: [], ipAssets: [], ipLeases: [], ipUsageRecords: [], auditLogs: []
  };
  const deps = { readState: () => state, updateState: (updater) => updater(state) };

  assert.equal(retryWaitingIpIncidents(deps), 0);
  assert.equal(state.incidents[0].status, 'waiting_for_ip');
});

test('discards an unusable replacement IP, records it, and takes the next one', async () => {
  const state = {
    incidents: [{ id: 'incident-check', targetId: 'target-1', targetName: '主站', policyId: 'policy-1', status: 'queued', executionId: '', leaseIds: [], allocatedIps: [], dnsChangeIds: [] }],
    failoverPolicies: [{ id: 'policy-1', name: '切换', poolIds: ['pool-1'], automationTaskId: '', dnsBindingIds: [], enabled: true }],
    probes: [{ id: 'probe-1', enabled: true }],
    probeTargets: [failedTarget()],
    ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['bad', 'good'], allocationMode: 'one', selectionMode: 'ordered', enabled: true }],
    ipAssets: [{ id: 'bad', address: '198.51.100.1', enabled: true, health: 'unknown' }, { id: 'good', address: '198.51.100.2', enabled: true, health: 'unknown' }],
    ipLeases: [],
    ipUsageRecords: [],
    dnsBindings: [],
    dnsChanges: [],
    auditLogs: []
  };
  const checked = [];
  const deps = {
    readState: () => state,
    updateState: (updater) => updater(state),
    executeAutomation: async () => ({ jobId: 'unused' }),
    waitAutomation: async () => {},
    checkIp: async (address, attempts) => { checked.push([address, attempts]); return { ok: address.endsWith('.2'), error: address.endsWith('.2') ? '' : 'ping failed' }; }
  };
  await runIncidentWorkflow('incident-check', deps);
  assert.deepEqual(checked, [['198.51.100.1', 3], ['198.51.100.2', 3]]);
  assert.equal(state.incidents[0].status, 'succeeded');
  assert.equal(state.ipAssets.length, 0);
  assert.deepEqual(state.ipUsageRecords.map((item) => [item.address, item.status, item.preflight.attempts]), [
    ['198.51.100.2', 'consumed', 3],
    ['198.51.100.1', 'discarded', 3]
  ]);
});

test('cancels failover before automation when the target recovers during IP preflight', async () => {
  const state = {
    incidents: [{ id: 'incident-recovered-before-run', targetId: 'target-1', targetName: '主站', policyId: 'policy-1', status: 'queued', executionId: '', leaseIds: [], allocatedIps: [], dnsChangeIds: [] }],
    failoverPolicies: [{ id: 'policy-1', name: '切换', poolIds: ['pool-1'], automationTaskId: 'task-1', dnsBindingIds: [], enabled: true }],
    probes: [{ id: 'probe-1', enabled: true }],
    probeTargets: [failedTarget()],
    ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['asset-1'], allocationMode: 'one', selectionMode: 'ordered', enabled: true }],
    ipAssets: [{ id: 'asset-1', address: '198.51.100.10', enabled: true, health: 'unknown' }],
    ipLeases: [], ipUsageRecords: [], dnsBindings: [], dnsChanges: [], auditLogs: []
  };
  let automationStarted = false;
  const deps = {
    readState: () => state,
    updateState: (updater) => updater(state),
    executeAutomation: async () => { automationStarted = true; return { jobId: 'unexpected' }; },
    waitAutomation: async () => {},
    checkIp: async () => {
      const checkedAt = new Date().toISOString();
      state.probeTargets[0].health = 'healthy';
      state.probeTargets[0].lastCheckAt = checkedAt;
      state.probeTargets[0].observations['probe-1'] = { ok: true, rounds: 3, attemptsPerRound: 3, roundsCompleted: 1, attempts: 1, checkedAt };
      return { ok: true, attempts: 3, error: '' };
    }
  };

  await runIncidentWorkflow('incident-recovered-before-run', deps);

  assert.equal(automationStarted, false);
  assert.equal(state.incidents[0].status, 'recovered');
  assert.equal(state.incidents[0].message, '目标已恢复，无需切换');
  assert.equal(state.ipAssets.length, 1);
  assert.equal(state.ipLeases.length, 0);
  assert.equal(state.ipUsageRecords[0].status, 'rolled_back');
});

test('honors disabled auto rollback and removes a DNS-bound IP from inventory', async () => {
  const state = {
    incidents: [{ id: 'incident-preserve', targetId: 'target-1', targetName: '主站', policyId: 'policy-1', status: 'queued', executionId: '', leaseIds: [], allocatedIps: [], dnsChangeIds: [] }],
    failoverPolicies: [{ id: 'policy-1', name: '保留变更', poolIds: ['pool-1'], automationTaskId: 'task-1', dnsBindingIds: [], autoRollback: false, enabled: true }],
    probes: [{ id: 'probe-1', enabled: true }],
    probeTargets: [failedTarget()],
    ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['asset-1'], allocationMode: 'one', selectionMode: 'ordered', enabled: true }],
    ipAssets: [{ id: 'asset-1', address: '198.51.100.30', enabled: true, health: 'unknown' }],
    ipLeases: [], ipUsageRecords: [], dnsBindings: [], dnsChanges: [], auditLogs: []
  };
  const deps = {
    readState: () => state,
    updateState: (updater) => updater(state),
    executeAutomation: async () => ({ jobId: 'job-1' }),
    waitAutomation: async () => {
      state.dnsChanges.unshift({ id: 'change-1', incidentId: 'incident-preserve', status: 'applied' });
      state.incidents[0].dnsChangeIds.push('change-1');
      throw new Error('验证失败');
    },
    checkIp: async () => ({ ok: true, error: '' })
  };

  await runIncidentWorkflow('incident-preserve', deps);

  assert.equal(state.incidents[0].status, 'failed');
  assert.match(state.incidents[0].error, /已按策略保留 DNS 变更/);
  assert.equal(state.ipAssets.length, 0);
  assert.deepEqual(state.ipPools[0].assetIds, []);
  assert.equal(state.ipUsageRecords[0].status, 'failed');
  assert.equal(state.auditLogs.some((item) => item.action === 'incident.rollback'), false);
  assert.equal(state.auditLogs.some((item) => item.action === 'incident.dns_preserved'), true);
});

test('keeps a partially written DNS IP out of inventory when provider recovery fails', async () => {
  const replacementIp = '198.51.100.50';
  let remoteValues = ['203.0.113.50'];
  let writeCalls = 0;
  const state = {
    incidents: [{ id: 'incident-partial', targetId: 'target-1', targetName: '主站', policyId: 'policy-1', status: 'queued', executionId: '', leaseIds: [], allocatedIps: [], dnsChangeIds: [] }],
    failoverPolicies: [{ id: 'policy-1', name: 'DNS 切换', poolIds: ['pool-1'], automationTaskId: '', dnsBindingIds: ['binding-1'], autoRollback: true, enabled: true }],
    probes: [{ id: 'probe-1', enabled: true }], probeTargets: [failedTarget()],
    ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['asset-1'], allocationMode: 'one', selectionMode: 'ordered', enabled: true }],
    ipAssets: [{ id: 'asset-1', address: replacementIp, enabled: true, health: 'unknown' }], ipLeases: [], ipUsageRecords: [],
    dnsAccounts: [{ id: 'account-1', provider: 'huawei', credentialsEnc: 'encrypted', enabled: true }],
    dnsBindings: [{ id: 'binding-1', name: '主站解析', accountId: 'account-1', domain: 'www.example.com', recordName: 'www', recordType: 'A', updateMode: 'replace', backupIps: ['203.0.113.50'], currentValues: ['203.0.113.50'], managedValues: ['203.0.113.50'], enabled: true }],
    dnsChanges: [], auditLogs: []
  };
  const deps = {
    readState: () => state, updateState: (updater) => updater(state), decryptSecret: () => '{}',
    resolveDnsBinding: async (_state, _account, _credentials, binding) => ({ zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' }, normalizedBinding: binding }),
    readDnsRecord: async () => ({ values: [...remoteValues], recordId: 'record-1', recordIds: ['record-1'] }),
    writeDnsRecord: async (_account, _credentials, _zone, _binding, values) => {
      writeCalls += 1;
      if (writeCalls === 1) remoteValues = [...values];
      throw new Error(writeCalls === 1 ? '服务商部分写入失败' : '服务商恢复接口不可用');
    },
    executeAutomation: async () => ({ jobId: 'unused' }), waitAutomation: async () => {}, checkIp: async () => ({ ok: true, error: '' })
  };

  await runIncidentWorkflow('incident-partial', deps);

  assert.equal(state.incidents[0].status, 'failed');
  assert.match(state.incidents[0].error, /自动回滚失败/);
  assert.equal(state.dnsChanges[0].status, 'recovery_pending');
  assert.equal(state.ipAssets.length, 0);
  assert.deepEqual(state.ipPools[0].assetIds, []);
  assert.equal(state.auditLogs.some((item) => item.action === 'dns.recovery_pending'), true);
  assert.equal(state.auditLogs.some((item) => item.action === 'incident.dns_preserved'), true);
});

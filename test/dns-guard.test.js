import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import test from 'node:test';
import {
  buildDnsGuardCheckAddresses,
  collectDnsGuardPoolCandidates,
  calculateDnsGuardOwnership,
  dnsGuardCheckReady,
  dnsGuardCycleReady,
  normalizeOrchestrationState,
  orchestrationDefaults,
  processReadyDnsGuards,
  registerOrchestrationRoutes,
  registerProbePublicRoutes,
  requestWaitingDnsGuardProbeChecks,
  requestWaitingDnsGuardChecks,
  resolveManagedDnsZone,
  resolveDnsGuardSources,
  clearDnsGuardSourceCache,
  roundRobinDnsGuardSourceValues,
  runDueDnsGuards,
  selectHealthyDnsGuardSources,
  syncDnsGuardRemote,
  writeDnsGuardRemoteValues
} from '../server/orchestration.js';

function guardState() {
  return {
    ...orchestrationDefaults(),
    dnsAccounts: [{ id: 'account-1', provider: 'huawei', enabled: true, credentialsEnc: 'saved' }],
    dnsGuards: [{
      id: 'guard-1', name: '入口守护', accountId: 'account-1', domain: 'edge.example.com', recordType: 'A',
      recordLine: '默认', ttl: 60, interval: 30, maxActiveIps: 50, sources: [], currentValues: [],
      ownedValues: [], sourceOwnedValues: [], sourceState: {}, providerRecordId: '', providerRecordIds: [], cycle: null
    }]
  };
}

function remoteDeps(initialState, initialRemote = ['198.51.100.10']) {
  let state = structuredClone(initialState);
  let remote = [...initialRemote];
  return {
    readState: (keys) => keys ? Object.fromEntries(keys.map((key) => [key, state[key]])) : state,
    updateState: (updater) => { state = updater(state); return state; },
    decryptSecret: () => JSON.stringify({ accessKey: 'ak', secretKey: 'sk' }),
    resolveDnsBinding: async (_state, _account, _credentials, binding) => ({
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { ...binding, recordName: 'edge' }
    }),
    readDnsRecord: async () => ({ values: [...remote], recordId: remote.length ? 'record-1' : '', recordIds: remote.length ? ['record-1'] : [] }),
    writeDnsRecord: async (_account, _credentials, _zone, _binding, values) => {
      remote = [...values];
      return remote.length ? ['record-1'] : [];
    },
    getRemote: () => remote,
    getState: () => state
  };
}

function sourceGuardFixture(remote = ['198.51.100.10', '198.51.100.11'], options = {}) {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1', 'probe-2'], poolIds: [], checkRounds: 3, attemptsPerRound: 3,
    timeout: 5, maxParallel: 20, pruneStale: true,
    sources: [{ id: 'home', domain: 'home.example.com', backupDomain: 'backup.example.com' }],
    ...options
  });
  state.probes = ['probe-1', 'probe-2'].map((id) => ({ id, enabled: true, status: 'online',
    agentSecretHash: 'synthetic-secret', lastSeenAt: new Date().toISOString() }));
  const deps = remoteDeps(state, remote);
  deps.lookups = [];
  deps.resolveDomainAddresses = async (domain, family) => {
    deps.lookups.push([domain, family]);
    return domain === 'home.example.com' ? ['203.0.113.20', '203.0.113.21'] : ['203.0.113.30'];
  };
  return deps;
}

async function finishGuardChecks(deps, succeeds = () => true) {
  const checked = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const guard = deps.getState().dnsGuards[0];
    if (!guard.cycle) return checked;
    assert.ok(guard.cycle.checks.length, 'an empty check queue must settle immediately');
    for (const check of guard.cycle.checks) {
      checked.push(check.address);
      const ok = succeeds(check.address);
      for (const probe of ok ? ['probe-1'] : guard.cycle.expectedProbeIds) {
        check.observations[probe] = { ok, rounds: guard.checkRounds, attemptsPerRound: guard.attemptsPerRound,
          roundsCompleted: ok ? 1 : guard.checkRounds, attempts: ok ? 1 : guard.checkRounds * guard.attemptsPerRound };
      }
    }
    await processReadyDnsGuards(deps);
  }
  assert.fail('DNS guard did not finish within 20 stages');
}

async function nextSourceCycle(deps, succeeds) {
  deps.getState().dnsGuards[0].nextCheckAt = '';
  await runDueDnsGuards(deps);
  return finishGuardChecks(deps, succeeds);
}

function addFillStock(deps, count, start = 1, poolId = 'fill-pool') {
  const state = deps.getState();
  let pool = state.ipPools.find((item) => item.id === poolId);
  if (!pool) { pool = { id: poolId, enabled: true, assetIds: [], allocationMode: 'one', selectionMode: 'ordered' }; state.ipPools.push(pool); }
  for (let i = start; i < start + count; i++) {
    state.ipAssets.push({ id: `fill-${i}`, address: `203.0.113.${i}`, enabled: true });
    pool.assetIds.push(`fill-${i}`);
  }
}

function autoBalanceFixture(total = 50, poolIds = ['a', 'b']) {
  const remote = Array.from({ length: total }, (_, index) => `198.51.100.${index + 1}`);
  const deps = sourceGuardFixture(remote, { sources: [], currentValues: remote, ownedValues: remote,
    poolOrigins: Object.fromEntries(remote.map((address) => [address, 'a'])), poolIds,
    poolSelectionMode: 'balanced', poolRebalanceEnabled: true, poolFillMode: 'fill', poolTargetCount: total });
  addFillStock(deps, 0, 1, 'a');
  return deps;
}

function guardConfigSaver(deps) {
  deps.sanitizeState = (state) => state;
  const routes = new Map();
  registerOrchestrationRoutes(Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, fn) => routes.set(`${method} ${path}`, fn)])), deps);
  return async (extra) => {
    let result;
    await routes.get('put /api/orchestration/:resource/:id')({ params: { resource: 'dns-guards', id: 'guard-1' }, auth: { username: 'test' }, body: { ...deps.getState().dnsGuards[0], ...extra } },
      { json(value) { result = value; } }, (error) => { throw error; });
    return result.item;
  };
}

test('automatic rebalancing swaps a full domain to 25/25 and returns old healthy IPs only after verification', async () => {
  const deps = autoBalanceFixture();
  addFillStock(deps, 30, 1, 'b');
  const write = deps.writeDnsRecord;
  let writes = 0;
  deps.writeDnsRecord = async (...args) => {
    writes++;
    assert.equal(deps.getState().ipPools.find((pool) => pool.id === 'a').assetIds.length, 0, 'old IPs must not be available before remote confirmation');
    return write(...args);
  };
  await nextSourceCycle(deps);
  const state = deps.getState(), guard = state.dnsGuards[0];
  assert.equal(deps.getRemote().length, 50);
  assert.deepEqual(['a', 'b'].map((id) => Object.values(guard.poolOrigins).filter((poolId) => poolId === id).length), [25, 25]);
  const returnedIds = state.ipPools.find((pool) => pool.id === 'a').assetIds;
  assert.equal(returnedIds.length, 25);
  assert.ok(state.ipAssets.filter((asset) => returnedIds.includes(asset.id)).every((asset) => !deps.getRemote().includes(asset.address)));
  assert.equal(state.ipUsageRecords.filter((entry) => entry.status === 'returned').length, 25);
  assert.equal(state.dnsGuardRuns[0].returnedIps.length, 25);
  assert.equal(writes, 1);
  const deadline = guard.poolRebalanceNextAt;
  assert.equal(Date.parse(deadline) - Date.parse(guard.poolRebalanceLastAt), 30 * 60000);
  await nextSourceCycle(deps);
  assert.equal(writes, 1, 'balanced domains do not churn on later checks');
  assert.equal(guard.poolRebalanceNextAt, deadline, 'ordinary health checks must not slide the rebalance deadline');
});

test('automatic rebalance supports three and four pools with stable indivisible remainders', async () => {
  for (const poolIds of [['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
    const deps = autoBalanceFixture(50, poolIds);
    for (const [index, poolId] of poolIds.slice(1).entries()) addFillStock(deps, 25, index * 40 + 1, poolId);
    await nextSourceCycle(deps);
    const counts = poolIds.map((id) => Object.values(deps.getState().dnsGuards[0].poolOrigins).filter((poolId) => poolId === id).length);
    assert.equal(counts.reduce((a, b) => a + b), 50);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    const before = [...deps.getRemote()], inventory = deps.getState().ipAssets.length;
    deps.getState().dnsGuards[0].poolRebalanceNextAt = '2000-01-01';
    await nextSourceCycle(deps);
    assert.deepEqual(deps.getRemote(), before);
    assert.equal(deps.getState().ipAssets.length, inventory);
  }
});

test('automatic rebalance keeps healthy old records on empty or failed pools and resumes after replenishment', async () => {
  const deps = autoBalanceFixture(10);
  addFillStock(deps, 0, 1, 'b');
  const before = [...deps.getRemote()];
  await nextSourceCycle(deps);
  assert.deepEqual(deps.getRemote(), before);
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  addFillStock(deps, 2, 1, 'b');
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['b'] }), 0, 'stock changes cannot bypass the rebalance interval');
  deps.getState().dnsGuards[0].poolRebalanceNextAt = '2000-01-01';
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['b'] }), 1);
  await new Promise((resolve) => setImmediate(resolve));
  await finishGuardChecks(deps, (address) => address !== '203.0.113.1');
  assert.equal(deps.getRemote().length, 10);
  assert.equal(deps.getState().dnsGuardRuns[0].returnedIps.length, 1);
  assert.equal(deps.getState().ipPools.find((pool) => pool.id === 'a').assetIds.length, 1);
  addFillStock(deps, 4, 3, 'b');
  deps.getState().dnsGuards[0].poolRebalanceNextAt = '2000-01-01';
  await nextSourceCycle(deps);
  assert.equal(Object.values(deps.getState().dnsGuards[0].poolOrigins).filter((id) => id === 'b').length, 5);
});

test('automatic rebalance leaves unknown and DDNS-owned IPs alone and respects explicit opt-out', async () => {
  for (const mode of ['off', 'unknown', 'source']) {
    const deps = autoBalanceFixture(4);
    addFillStock(deps, 4, 1, 'b');
    const guard = deps.getState().dnsGuards[0];
    if (mode === 'off') guard.poolRebalanceEnabled = false;
    if (mode === 'unknown') guard.poolOrigins = {};
    if (mode === 'source') guard.sourceOwnedValues = [...guard.currentValues];
    const before = [...deps.getRemote()];
    await nextSourceCycle(deps);
    assert.deepEqual(deps.getRemote(), before);
    assert.equal(deps.getState().ipUsageRecords.length, 0);
  }
});

test('uncertain rebalance writes survive restart and offline probes without duplicate consumption or returns', async () => {
  let deps = autoBalanceFixture(4);
  addFillStock(deps, 2, 1, 'b');
  await runDueDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  const write = deps.writeDnsRecord;
  deps.writeDnsRecord = async (...args) => { await write(...args); throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await processReadyDnsGuards(deps);
  assert.equal(deps.getState().dnsGuards[0].cycle.rebalanceCommit.writeAttempted, true);
  assert.equal(deps.getState().ipPools.find((pool) => pool.id === 'a').assetIds.length, 0);
  assert.equal(deps.getState().ipAssets.length, 2);
  await assert.rejects(writeDnsGuardRemoteValues('guard-1', { values: [] }, deps), /正在确认自动均衡/);
  await assert.rejects(syncDnsGuardRemote('guard-1', deps), /正在确认自动均衡/);
  deps = remoteDeps(normalizeOrchestrationState(deps.getState()), deps.getRemote());
  deps.getState().probes.forEach((probe) => { probe.status = 'offline'; probe.lastSeenAt = '2000-01-01'; });
  deps.getState().dnsGuards[0].cycle.startedAt = '2000-01-01';
  await runDueDnsGuards(deps);
  assert.ok(deps.getState().dnsGuards[0].cycle.rebalanceCommit);
  assert.equal(await processReadyDnsGuards(deps), 0, 'confirmation retries respect their delay');
  deps.getState().dnsGuards[0].cycle.rebalanceRetryAt = '';
  deps.writeDnsRecord = async () => { assert.fail('already applied write must only be verified, not resubmitted'); };
  const read = deps.readDnsRecord;
  deps.readDnsRecord = async (...args) => {
    assert.equal(args[3].providerRecordId, '');
    assert.deepEqual(args[3].providerRecordIds, []);
    return read(...args);
  };
  await runDueDnsGuards(deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.equal(deps.getState().ipPools.find((pool) => pool.id === 'a').assetIds.length, 2);
  assert.equal(deps.getState().ipUsageRecords.filter((entry) => entry.status === 'consumed').length, 2);
  await processReadyDnsGuards(deps);
  assert.equal(deps.getState().ipUsageRecords.filter((entry) => entry.status === 'returned').length, 2);
});

test('rebalance waits for the required recipient pools, not many successes from only one pool', async () => {
  const deps = autoBalanceFixture(6, ['a', 'b', 'c']);
  addFillStock(deps, 5, 1, 'b'); addFillStock(deps, 5, 40, 'c');
  await runDueDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  const guard = deps.getState().dnsGuards[0];
  for (const check of guard.cycle.checks.filter((check) => Number(check.address.split('.').at(-1)) < 40)) check.observations['probe-1'] = { ok: true, attempts: 1 };
  assert.equal(dnsGuardCycleReady(guard), false, 'five B successes cannot fill the two C slots');
  for (const check of guard.cycle.checks.filter((check) => Number(check.address.split('.').at(-1)) >= 40).slice(0, 2)) check.observations['probe-1'] = { ok: true, attempts: 1 };
  assert.equal(dnsGuardCycleReady(guard), true);
  await processReadyDnsGuards(deps);
  assert.deepEqual(['a', 'b', 'c'].map((id) => Object.values(deps.getState().dnsGuards[0].poolOrigins).filter((poolId) => poolId === id).length), [2, 2, 2]);
});

test('automatic rebalance cancels without consuming stock when remote or pool settings change before writing', async () => {
  for (const change of ['remote', 'disabled', 'removed', 'asset']) {
    const deps = autoBalanceFixture(4);
    addFillStock(deps, 2, 1, 'b');
    await runDueDnsGuards(deps);
    for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
    await processReadyDnsGuards(deps);
    const state = deps.getState(), before = [...deps.getRemote()];
    if (change === 'remote') await deps.writeDnsRecord(null, null, null, null, ['192.0.2.99']);
    if (change === 'disabled') state.ipPools.find((pool) => pool.id === 'b').enabled = false;
    if (change === 'removed') state.ipPools.find((pool) => pool.id === 'b').assetIds = [];
    if (change === 'asset') state.ipAssets[0].enabled = false;
    deps.writeDnsRecord = async () => assert.fail('changed plans must not write');
    await finishGuardChecks(deps);
    assert.equal(state.dnsGuards[0].status, 'queued');
    assert.equal(state.ipUsageRecords.length, 0);
    assert.equal(state.ipPools.find((pool) => pool.id === 'a').assetIds.length, 0);
    assert.equal(state.ipAssets.length, 2);
    assert.deepEqual(deps.getRemote(), change === 'remote' ? ['192.0.2.99'] : before);
  }
});

test('automatic rebalance does not remove healthy old IPs when every replacement fails', async () => {
  const deps = autoBalanceFixture(4);
  addFillStock(deps, 2, 1, 'b');
  const before = [...deps.getRemote()];
  deps.writeDnsRecord = async () => assert.fail('failed replacements must not replace healthy IPs');
  await nextSourceCycle(deps, (address) => address.startsWith('198.51.100.'));
  assert.deepEqual(deps.getRemote(), before);
  assert.equal(deps.getState().ipUsageRecords.filter((entry) => entry.status === 'returned').length, 0);
  assert.equal(deps.getState().ipPools.find((pool) => pool.id === 'a').assetIds.length, 0);
});

test('legacy recorded pool origins can be rebalanced without assigning unknown old IPs', async () => {
  const deps = autoBalanceFixture(5);
  const state = deps.getState();
  delete state.dnsGuards[0].poolOrigins;
  state.ipUsageRecords = state.dnsGuards[0].currentValues.slice(0, 4).map((address, i) => ({
    id: `old-${i}`, guardId: 'guard-1', address, poolId: 'a', status: 'consumed'
  }));
  addFillStock(deps, 5, 1, 'b');
  const restored = remoteDeps(normalizeOrchestrationState(state), deps.getRemote());
  await nextSourceCycle(restored);
  assert.deepEqual(['a', 'b'].map((id) => Object.values(restored.getState().dnsGuards[0].poolOrigins).filter((poolId) => poolId === id).length), [2, 2]);
  assert.ok(restored.getRemote().includes('198.51.100.5'));
  assert.equal(restored.getState().dnsGuards[0].poolOrigins['198.51.100.5'], undefined);
});

test('uncertain rebalance mismatch holds inventory and reimported addresses until remote confirmation', async () => {
  const deps = autoBalanceFixture(4);
  addFillStock(deps, 2, 1, 'b');
  const write = deps.writeDnsRecord;
  deps.writeDnsRecord = async (...args) => {
    await write(...args.slice(0, 4), args[4].slice(0, 1));
    return ['record-1'];
  };
  await runDueDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  const state = deps.getState(), guard = state.dnsGuards[0], commit = guard.cycle.rebalanceCommit;
  assert.equal(commit.writeAttempted, true);
  assert.equal(state.ipUsageRecords.length, 0);
  state.ipAssets.push({ id: 'reimport', address: commit.returnedAssets[0].address, enabled: true });
  state.ipPools.find((pool) => pool.id === 'b').assetIds.push('reimport');
  assert.deepEqual(collectDnsGuardPoolCandidates(state, { poolIds: ['b'], recordType: 'A' }), []);
  assert.equal(await processReadyDnsGuards(deps), 0);
  guard.cycle.rebalanceRetryAt = '';
  deps.writeDnsRecord = async () => assert.fail('unexpected remote changes must not be overwritten');
  await processReadyDnsGuards(deps);
  assert.match(guard.lastError, /前后均不一致/);
  assert.equal(state.ipUsageRecords.length, 0);
  await write(null, null, null, null, commit.desired);
  guard.cycle.rebalanceRetryAt = '';
  await processReadyDnsGuards(deps);
  assert.equal(guard.cycle, null);
  assert.equal(state.ipAssets.filter((asset) => asset.address === commit.returnedAssets[0].address).length, 1);
  assert.equal(state.ipPools.find((pool) => pool.id === 'a').assetIds.length, 2);
});

test('pending remote rebalance confirmations do not occupy probe preparation slots', async () => {
  const deps = autoBalanceFixture(4);
  addFillStock(deps, 2, 1, 'b');
  await runDueDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  deps.writeDnsRecord = async () => { throw new Error('timeout'); };
  await processReadyDnsGuards(deps);
  const state = deps.getState(), guard = state.dnsGuards[0];
  guard.cycle.rebalanceRetryAt = '2099-01-01';
  for (let i = 1; i < 10; i++) state.dnsGuards.push({ ...structuredClone(guard), id: `pending-${i}` });
  state.dnsGuards.push({ ...structuredClone(guard), id: 'fresh', cycle: null, nextCheckAt: '', poolRebalanceEnabled: false });
  assert.equal(await runDueDnsGuards(deps), 1);
  assert.ok(state.dnsGuards.find((item) => item.id === 'fresh').cycle?.checks.length);
  assert.ok(guard.cycle.rebalanceCommit.writeAttempted);
});

test('rebalance cadence survives restart and cooldown checks do not evaluate pools or write DNS', async () => {
  const original = autoBalanceFixture(4);
  addFillStock(original, 0, 1, 'b');
  await nextSourceCycle(original);
  const deps = remoteDeps(normalizeOrchestrationState(original.getState()), original.getRemote());
  const state = deps.getState(), guard = state.dnsGuards[0], deadline = guard.poolRebalanceNextAt;
  addFillStock(deps, 4, 1, 'b');
  const readState = deps.readState;
  deps.readState = (keys) => {
    assert.ok(keys && !['ipAssets', 'ipPools', 'ipLeases', 'incidents', 'ipUsageRecords'].some((key) => keys.includes(key)),
      'routine full healthy checks must not load inventory, leases or histories');
    return readState(keys);
  };
  deps.writeDnsRecord = async () => assert.fail('a full domain must wait for its rebalance deadline');
  await nextSourceCycle(deps);
  assert.equal(guard.poolRebalanceNextAt, deadline);
  deps.readState = readState;
  assert.deepEqual(deps.getRemote(), original.getRemote());
});

test('inventory notifications do not load assets or rewrite idle guards during rebalance cooldown', async () => {
  const deps = autoBalanceFixture(4);
  addFillStock(deps, 0, 1, 'b');
  await nextSourceCycle(deps);
  addFillStock(deps, 4, 1, 'b');
  const readState = deps.readState;
  deps.readState = (keys) => {
    assert.deepEqual(keys, ['dnsGuards'], 'cooldown notifications skip even the pool membership lists');
    return readState(keys);
  };
  deps.updateState = () => assert.fail('idle notifications must not rewrite state');
  for (let i = 0; i < 25; i++) assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['b'] }), 0);
});

test('balanced repairs run during rebalance cooldown without returning healthy survivors', async () => {
  const deps = autoBalanceFixture(6);
  addFillStock(deps, 8, 1, 'b');
  await nextSourceCycle(deps);
  const guard = deps.getState().dnsGuards[0], deadline = guard.poolRebalanceNextAt;
  const before = [...deps.getRemote()];
  const failed = before.find((address) => guard.poolOrigins[address] === 'b');
  await nextSourceCycle(deps, (address) => address !== failed);
  assert.equal(deps.getRemote().length, 6);
  assert.ok(before.filter((address) => address !== failed).every((address) => deps.getRemote().includes(address)));
  assert.deepEqual(['a', 'b'].map((id) => Object.values(guard.poolOrigins).filter((poolId) => poolId === id).length), [3, 3]);
  assert.deepEqual(deps.getState().dnsGuardRuns[0].returnedIps, []);
  assert.equal(guard.poolRebalanceNextAt, deadline);
});

test('a due rebalance gives priority to failed-IP repair and only redistributes on a later evaluation', async () => {
  const deps = autoBalanceFixture(6);
  addFillStock(deps, 8, 1, 'b');
  const before = [...deps.getRemote()];
  await nextSourceCycle(deps, (address) => address !== before[0]);
  const state = deps.getState(), guard = state.dnsGuards[0];
  assert.equal(deps.getRemote().length, 6);
  assert.deepEqual(['a', 'b'].map((id) => Object.values(guard.poolOrigins).filter((poolId) => poolId === id).length), [5, 1]);
  assert.deepEqual(state.dnsGuardRuns[0].returnedIps, []);
  assert.equal(state.ipPools.find((pool) => pool.id === 'a').assetIds.length, 0);
  await nextSourceCycle(deps);
  assert.equal(state.ipPools.find((pool) => pool.id === 'a').assetIds.length, 0);
  guard.poolRebalanceNextAt = '2000-01-01';
  await nextSourceCycle(deps);
  assert.deepEqual(['a', 'b'].map((id) => Object.values(guard.poolOrigins).filter((poolId) => poolId === id).length), [3, 3]);
  assert.equal(state.dnsGuardRuns[0].returnedIps.length, 2);
});

test('due rebalance uses the existing scheduler even with a longer health interval and coalesces repeated ticks', async () => {
  const deps = autoBalanceFixture(6);
  addFillStock(deps, 8, 1, 'b');
  const guard = deps.getState().dnsGuards[0];
  Object.assign(guard, { status: 'healthy', interval: 86400, nextCheckAt: '2099-01-01', poolRebalanceNextAt: '2000-01-01', poolRebalanceIntervalMinutes: 45 });
  assert.equal(await runDueDnsGuards(deps), 1);
  const cycleId = guard.cycle.id;
  assert.equal(await runDueDnsGuards(deps), 0);
  assert.equal(guard.cycle.id, cycleId);
  await finishGuardChecks(deps);
  assert.equal(Date.parse(guard.poolRebalanceNextAt) - Date.parse(guard.poolRebalanceLastAt), 45 * 60000);
  assert.equal(await runDueDnsGuards(deps), 0);
});

test('rebalance cadence validates minutes and enables immediately without resetting on unrelated edits', async () => {
  const deps = autoBalanceFixture(4);
  addFillStock(deps, 4, 1, 'b');
  addFillStock(deps, 4, 10, 'c');
  const guard = deps.getState().dnsGuards[0];
  guard.poolRebalanceEnabled = false;
  guard.nextCheckAt = '2099-01-01';
  const changed = [];
  deps.onDnsGuardChanged = (id) => changed.push(id);
  const save = guardConfigSaver(deps);
  for (const poolRebalanceIntervalMinutes of [0, 1441, 1.5, '', 'abc', Infinity]) {
    await assert.rejects(save({ poolRebalanceIntervalMinutes }), /自动调整间隔/);
  }
  await save({ poolRebalanceEnabled: true, poolRebalanceIntervalMinutes: '30', poolRebalanceNextAt: '2099-01-01' });
  assert.deepEqual(changed, ['guard-1']);
  assert.equal(guard.nextCheckAt, '');
  assert.equal(guard.poolRebalanceNextAt, '');
  await nextSourceCycle(deps);
  const last = guard.poolRebalanceLastAt, next = guard.poolRebalanceNextAt;
  await save({ name: 'renamed', poolIds: ['b', 'a'], poolRebalanceLastAt: '2000-01-01', poolRebalanceNextAt: '2099-01-01' });
  assert.equal(guard.poolRebalanceLastAt, last);
  assert.equal(guard.poolRebalanceNextAt, next);
  await save({ poolRebalanceIntervalMinutes: 60 });
  assert.equal(Date.parse(guard.poolRebalanceNextAt) - Date.parse(last), 60 * 60000);
  await save({ poolRebalanceIntervalMinutes: 5 });
  assert.equal(Date.parse(guard.poolRebalanceNextAt) - Date.parse(last), 5 * 60000);
  await save({ poolIds: ['a', 'b', 'c'] });
  assert.equal(guard.poolRebalanceLastAt, '');
  assert.equal(guard.poolRebalanceNextAt, '');
  await nextSourceCycle(deps);
  assert.ok(Object.values(guard.poolOrigins).includes('c'));
  await save({ poolRebalanceEnabled: false });
  assert.equal(guard.poolRebalanceNextAt, '');
  await save({ poolRebalanceEnabled: true });
  assert.equal(guard.poolRebalanceNextAt, '');
});

test('editing rebalance interval or disabling during preflight cancels the old plan safely', async () => {
  for (const patch of [{ poolRebalanceIntervalMinutes: 45 }, { poolRebalanceEnabled: false }]) {
    const deps = autoBalanceFixture(4);
    addFillStock(deps, 4, 1, 'b');
    await runDueDnsGuards(deps);
    const guard = deps.getState().dnsGuards[0];
    for (const check of guard.cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
    await processReadyDnsGuards(deps);
    assert.ok(guard.cycle.rebalancePlan);
    const before = [...deps.getRemote()];
    await guardConfigSaver(deps)(patch);
    assert.equal(guard.cycle, null);
    await processReadyDnsGuards(deps);
    assert.deepEqual(deps.getRemote(), before);
    assert.equal(deps.getState().ipUsageRecords.length, 0);
  }
});

test('changing rebalance interval during preparation cannot publish the obsolete cycle', async () => {
  const deps = autoBalanceFixture(4);
  addFillStock(deps, 2, 1, 'b');
  const read = deps.readDnsRecord, gate = Promise.withResolvers();
  deps.readDnsRecord = async (...args) => { await gate.promise; return read(...args); };
  const running = runDueDnsGuards(deps);
  await Promise.resolve();
  await guardConfigSaver(deps)({ poolRebalanceIntervalMinutes: 45 });
  gate.resolve();
  await running;
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
});

test('balanced legacy guards migrate once, preserve running commits and honor later opt-outs after restart', async () => {
  const state = guardState();
  state.dnsGuards = [
    { id: 'missing', poolSelectionMode: 'balanced' },
    { id: 'off', poolSelectionMode: 'balanced', poolRebalanceEnabled: false, poolRebalanceNextAt: '2099-01-01' },
    { id: 'on', poolSelectionMode: 'balanced', poolRebalanceEnabled: true, poolRebalanceIntervalMinutes: 45, poolRebalanceNextAt: '2099-01-01' },
    { id: 'ordered', poolSelectionMode: 'ordered' },
    { id: 'paused', enabled: false, poolSelectionMode: 'balanced' },
    { id: 'pending', poolSelectionMode: 'balanced', poolRebalanceEnabled: true, cycle: { id: 'pending-cycle', rebalanceCommit: { writeAttempted: true, desired: ['192.0.2.1'] } } }
  ];
  const migrated = normalizeOrchestrationState(state);
  assert.deepEqual(migrated.dnsGuards.map((guard) => guard.poolRebalanceEnabled), [true, true, true, false, true, true]);
  assert.ok(migrated.dnsGuards.every((guard) => guard.poolRebalanceDefaultVersion === 1));
  assert.equal(migrated.dnsGuards[0].poolRebalanceIntervalMinutes, 30);
  assert.equal(migrated.dnsGuards[1].poolRebalanceNextAt, '');
  assert.equal(migrated.dnsGuards[2].poolRebalanceIntervalMinutes, 45);
  assert.equal(migrated.dnsGuards[2].poolRebalanceNextAt, '2099-01-01');
  assert.equal(migrated.dnsGuards[4].enabled, false);
  assert.deepEqual(migrated.dnsGuards[5].cycle, state.dnsGuards[5].cycle);
  migrated.dnsGuards[1].poolRebalanceEnabled = false;
  assert.equal(normalizeOrchestrationState(migrated).dnsGuards[1].poolRebalanceEnabled, false);

  const deps = autoBalanceFixture(4);
  addFillStock(deps, 4, 1, 'b');
  const save = guardConfigSaver(deps);
  await save({ poolRebalanceEnabled: false });
  assert.equal(normalizeOrchestrationState(deps.getState()).dnsGuards[0].poolRebalanceEnabled, false);
  await save({ poolSelectionMode: 'ordered' });
  const balanced = await save({ poolSelectionMode: 'balanced', poolRebalanceEnabled: undefined });
  assert.equal(balanced.poolRebalanceEnabled, true, 'API mode changes use the same default as the form');
  assert.equal(balanced.poolRebalanceIntervalMinutes, 30);
});

test('migrating many balanced tasks keeps the ten-cycle limit and does not duplicate preparations', async () => {
  const fixture = autoBalanceFixture(2);
  const state = fixture.getState();
  state.dnsGuards = Array.from({ length: 35 }, (_, i) => ({ ...structuredClone(state.dnsGuards[0]), id: `migrated-${i}`, poolRebalanceEnabled: false }));
  const deps = remoteDeps(normalizeOrchestrationState(state), fixture.getRemote());
  assert.equal(await runDueDnsGuards(deps), 10);
  assert.equal(await runDueDnsGuards(deps), 0);
  assert.equal(deps.getState().dnsGuards.filter((guard) => guard.cycle).length, 10);
  assert.ok(deps.getState().dnsGuards.filter((guard) => guard.cycle).every((guard) => guard.cycle.rebalanceDue));
});

test('balanced pool candidates rotate across pools while legacy selection keeps pool priority', () => {
  const deps = sourceGuardFixture([], { poolIds: ['a', 'b', 'c'] });
  for (const [pool, start] of [['a', 1], ['b', 40], ['c', 80]]) addFillStock(deps, 10, start, pool);
  const state = deps.getState(), guard = state.dnsGuards[0];
  assert.deepEqual(collectDnsGuardPoolCandidates(state, guard, 4).map((item) => item.poolId), ['a', 'a', 'a', 'a']);
  guard.poolSelectionMode = 'balanced';
  assert.deepEqual(collectDnsGuardPoolCandidates(state, guard, 7).map((item) => item.poolId), ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  guard.poolBalanceNextId = 'b';
  assert.deepEqual(collectDnsGuardPoolCandidates(state, guard, 4).map((item) => item.poolId), ['b', 'c', 'a', 'b']);
  assert.equal(guard.poolBalanceNextId, 'b', 'collecting candidates must not move the persisted cursor');
});

test('random pool draws stay bounded, unique and leave the saved pool order intact', (t) => {
  const deps = sourceGuardFixture([], { poolIds: ['a', 'b'], poolSelectionMode: 'balanced' });
  addFillStock(deps, 100, 1, 'a'); addFillStock(deps, 100, 101, 'b');
  const state = deps.getState();
  for (const pool of state.ipPools) pool.selectionMode = 'random';
  const before = state.ipPools.map((pool) => [...pool.assetIds]);
  let calls = 0;
  t.mock.method(Math, 'random', () => { calls++; return 0.5; });
  const one = collectDnsGuardPoolCandidates(state, state.dnsGuards[0], 1);
  assert.equal(calls, 1, 'drawing one candidate must not randomize the whole inventory');
  assert.equal(one[0].assetId, 'fill-51');
  calls = 0;
  const all = collectDnsGuardPoolCandidates(state, state.dnsGuards[0], 200);
  assert.equal(all.length, 200);
  assert.equal(new Set(all.map((item) => item.assetId)).size, 200);
  assert.equal(calls, 200);
  assert.deepEqual(state.ipPools.map((pool) => pool.assetIds), before);
});

test('one inventory wakeup shares its index across multiple deficient guards', () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['a'], poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 2 });
  addFillStock(deps, 10, 1, 'a');
  const state = deps.getState();
  state.dnsGuards[0].recordType = 'AAAA';
  for (let i = 1; i < 24; i++) state.dnsGuards.push({ ...structuredClone(state.dnsGuards[0]), id: `idle-${i}` });
  let idReads = 0;
  for (const asset of state.ipAssets) {
    const id = asset.id;
    Object.defineProperty(asset, 'id', { get() { idReads++; return id; } });
  }
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['a'] }), 0, 'IPv4 stock cannot wake IPv6 guards');
  assert.equal(idReads, state.ipAssets.length, 'inventory indexing runs once for this snapshot, not once per guard');
});

test('healthy guard cycles leave unused inventory arrays and pool membership untouched', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { sources: [], poolIds: ['a'], poolSelectionMode: 'balanced' });
  addFillStock(deps, 100, 1, 'a');
  const state = deps.getState(), assets = state.ipAssets, members = state.ipPools[0].assetIds, usage = state.ipUsageRecords;
  await nextSourceCycle(deps);
  assert.equal(state.dnsGuards[0].status, 'healthy');
  assert.equal(state.ipAssets, assets);
  assert.equal(state.ipPools[0].assetIds, members);
  assert.equal(state.ipUsageRecords, usage);
});

test('balanced fill targets total pool ownership, reaching 25 per pool instead of splitting only new IPs', async () => {
  const remote = Array.from({ length: 40 }, (_, i) => `198.51.100.${i + 1}`);
  const poolOrigins = Object.fromEntries(remote.map((address, index) => [address, index < 25 ? 'a' : 'b']));
  const deps = sourceGuardFixture(remote, { sources: [], currentValues: remote, poolOrigins,
    poolIds: ['a', 'b'], poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 50 });
  addFillStock(deps, 20, 1, 'a'); addFillStock(deps, 20, 40, 'b');
  await nextSourceCycle(deps);
  const origins = Object.values(deps.getState().dnsGuards[0].poolOrigins);
  assert.deepEqual(['a', 'b'].map((id) => origins.filter((poolId) => id === poolId).length), [25, 25]);
  assert.ok(remote.every((address) => deps.getRemote().includes(address)));
  assert.ok(deps.getState().ipUsageRecords.every((record) => record.poolId === 'b'));
});

test('three pool total ownership reaches 17 17 16 and persists after history cleanup and restart', async () => {
  const remote = Array.from({ length: 17 }, (_, i) => `198.51.100.${i + 1}`);
  const deps = sourceGuardFixture(remote, { sources: [], currentValues: remote, poolOrigins: Object.fromEntries(remote.map((address) => [address, 'a'])),
    poolIds: ['a', 'b', 'c'], poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 50 });
  addFillStock(deps, 20, 1, 'a'); addFillStock(deps, 20, 40, 'b'); addFillStock(deps, 20, 80, 'c');
  await nextSourceCycle(deps);
  const origins = Object.values(deps.getState().dnsGuards[0].poolOrigins);
  assert.deepEqual(['a', 'b', 'c'].map((id) => origins.filter((poolId) => id === poolId).length), [17, 17, 16]);
  deps.getState().ipUsageRecords = [];
  const restarted = remoteDeps(normalizeOrchestrationState(deps.getState()), deps.getRemote());
  assert.deepEqual(restarted.getState().dnsGuards[0].poolOrigins, deps.getState().dnsGuards[0].poolOrigins);
  await nextSourceCycle(restarted, (address) => address !== '198.51.100.1');
  const repaired = Object.values(restarted.getState().dnsGuards[0].poolOrigins);
  assert.equal(restarted.getRemote().length, 50);
  assert.equal(Math.max(...['a', 'b', 'c'].map((id) => repaired.filter((poolId) => id === poolId).length)), 17);
  assert.equal(restarted.getState().dnsGuards[0].poolOrigins['198.51.100.1'], undefined);
});

test('overrepresented healthy IPs are kept, and all available capacity goes to the smaller pool', async () => {
  const remote = Array.from({ length: 40 }, (_, i) => `198.51.100.${i + 1}`);
  const deps = sourceGuardFixture(remote, { sources: [], currentValues: remote, poolOrigins: Object.fromEntries(remote.map((address) => [address, 'a'])),
    poolIds: ['a', 'b'], poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 50 });
  addFillStock(deps, 10, 1, 'a'); addFillStock(deps, 10, 40, 'b');
  await nextSourceCycle(deps);
  assert.ok(remote.every((address) => deps.getRemote().includes(address)));
  assert.equal(Object.values(deps.getState().dnsGuards[0].poolOrigins).filter((id) => id === 'b').length, 10);
  const remaining = deps.getState().ipAssets.length;
  await nextSourceCycle(deps);
  assert.equal(deps.getState().ipAssets.length, remaining, 'full healthy domain must not rotate records just for balance');
});

test('legacy current pool ownership recovers from successful history only and is not recreated after deletion', async () => {
  const state = guardState();
  state.dnsGuards[0].currentValues = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];
  state.ipUsageRecords = [
    { guardId: 'guard-1', address: '198.51.100.1', poolId: 'b', status: 'consumed' },
    { guardId: 'guard-1', address: '198.51.100.1', poolId: 'a', status: 'consumed' },
    { guardId: 'guard-1', address: '198.51.100.2', poolId: 'a', status: 'discarded' },
    { guardId: 'other', address: '198.51.100.3', poolId: 'c', status: 'consumed' },
    { guardId: 'guard-1', address: '198.51.100.4', poolId: 'c', status: 'consumed' }
  ];
  const migrated = normalizeOrchestrationState(state);
  assert.deepEqual(migrated.dnsGuards[0].poolOrigins, { '198.51.100.1': 'b' });
  const deps = remoteDeps(migrated, state.dnsGuards[0].currentValues);
  await writeDnsGuardRemoteValues('guard-1', { values: ['198.51.100.2'], expectedValues: state.dnsGuards[0].currentValues }, deps);
  assert.deepEqual(deps.getState().dnsGuards[0].poolOrigins, {});
  assert.deepEqual(normalizeOrchestrationState(deps.getState()).dnsGuards[0].poolOrigins, {});
});

test('remote reads prune removed ownership but do not assign unknown external IPs to pools', async () => {
  const deps = sourceGuardFixture(['198.51.100.2', '198.51.100.3'], {
    sources: [], currentValues: ['198.51.100.1', '198.51.100.2'],
    poolOrigins: { '198.51.100.1': 'a', '198.51.100.2': 'b' }
  });
  await syncDnsGuardRemote('guard-1', deps);
  assert.deepEqual(deps.getState().dnsGuards[0].poolOrigins, { '198.51.100.2': 'b' });
});

test('balanced healthy survivor counts exclude failed IPs before replacement preflight', async () => {
  const remote = ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4'];
  const deps = sourceGuardFixture(remote, { sources: [], currentValues: remote,
    poolOrigins: { '198.51.100.1': 'a', '198.51.100.2': 'a', '198.51.100.3': 'b', '198.51.100.4': 'b' },
    poolIds: ['a', 'b'], poolSelectionMode: 'balanced', poolBalanceNextId: 'a', maxParallel: 1 });
  addFillStock(deps, 2, 1, 'a'); addFillStock(deps, 2, 40, 'b');
  await nextSourceCycle(deps, (address) => address !== '198.51.100.3');
  assert.equal(deps.getState().ipUsageRecords[0].poolId, 'b', 'failed pool IP no longer contributes to the existing count');
  assert.deepEqual(Object.values(deps.getState().dnsGuards[0].poolOrigins).sort(), ['a', 'a', 'b', 'b']);
});

test('four-pool balancing skips empty disabled and missing pools without waiting for their stock', async () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['empty', 'disabled', 'missing', 'available'],
    poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 5 });
  addFillStock(deps, 0, 1, 'empty');
  addFillStock(deps, 5, 10, 'disabled');
  addFillStock(deps, 5, 40, 'available');
  deps.getState().ipPools.find((pool) => pool.id === 'disabled').enabled = false;
  await nextSourceCycle(deps);
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.equal(deps.getRemote().length, 5);
  assert.ok(Object.values(deps.getState().dnsGuards[0].poolOrigins).every((id) => id === 'available'));
  assert.equal(deps.getState().ipPools.find((pool) => pool.id === 'disabled').assetIds.length, 5);
});

test('all-empty pools settle immediately and refill only the real deficit when stock is added', async () => {
  for (const remote of [[], ['198.51.100.1']]) {
    const deps = sourceGuardFixture(remote, { sources: [], currentValues: remote, poolIds: ['a', 'b', 'c', 'd'],
      poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 5 });
    for (const id of ['a', 'b', 'c', 'd']) addFillStock(deps, 0, 1, id);
    await nextSourceCycle(deps);
    const guard = deps.getState().dnsGuards[0];
    assert.equal(guard.cycle, null);
    assert.equal(guard.status, remote.length ? 'degraded' : 'waiting_ip');
    assert.deepEqual(deps.getRemote(), remote);
    assert.ok(Date.parse(guard.nextCheckAt) > Date.now(), 'empty inventory retries on the interval, not a busy loop');
    assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['a'] }), 0);
    addFillStock(deps, 2, 1, 'a');
    assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['a'] }), 1);
    await new Promise((resolve) => setImmediate(resolve));
    await finishGuardChecks(deps);
    assert.equal(deps.getRemote().length, remote.length + 2);
    assert.equal(deps.getState().dnsGuards[0].cycle, null);
    assert.equal(deps.getState().dnsGuards[0].repairTargetCount, 5);
    addFillStock(deps, 5, 40, 'b');
    assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['b'] }), 1);
    await new Promise((resolve) => setImmediate(resolve));
    await finishGuardChecks(deps);
    assert.equal(deps.getRemote().length, 5);
    assert.equal(deps.getState().dnsGuards[0].repairTargetCount, 0);
    assert.equal(deps.getState().ipAssets.length, remote.length + 2);
  }
});

test('a smaller pool whose candidates all fail falls back to healthy stock in a larger pool', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { sources: [], currentValues: ['198.51.100.1'],
    poolOrigins: { '198.51.100.1': 'b' }, poolIds: ['a', 'b', 'empty'],
    poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 4, maxParallel: 2 });
  addFillStock(deps, 4, 1, 'a'); addFillStock(deps, 4, 40, 'b'); addFillStock(deps, 0, 80, 'empty');
  await nextSourceCycle(deps, (address) => !['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'].includes(address));
  assert.equal(deps.getRemote().length, 4);
  assert.ok(Object.values(deps.getState().dnsGuards[0].poolOrigins).every((poolId) => poolId === 'b'));
  assert.equal(deps.getState().ipUsageRecords.filter((item) => item.status === 'consumed').length, 3);
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
});

test('a replenished pool catches up on future deficits without replacing healthy IPs just for balance', async () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['a', 'b', 'c', 'd'],
    poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 8 });
  addFillStock(deps, 0, 1, 'a');
  for (const [id, start] of [['b', 40], ['c', 80], ['d', 120]]) addFillStock(deps, 5, start, id);
  await nextSourceCycle(deps);
  const before = [...deps.getRemote()];
  addFillStock(deps, 5, 1, 'a');
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['a'] }), 0, 'no extra rebalance check for a full healthy domain');
  await nextSourceCycle(deps);
  assert.deepEqual(deps.getRemote(), before);
  const failed = new Set(['b', 'c'].map((id) => Object.entries(deps.getState().dnsGuards[0].poolOrigins).find(([, poolId]) => poolId === id)[0]));
  await nextSourceCycle(deps, (address) => !failed.has(address));
  const origins = Object.values(deps.getState().dnsGuards[0].poolOrigins);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => origins.filter((poolId) => poolId === id).length), [2, 2, 2, 2]);
});

test('balanced fill consumes ten IPs as four three three without changing existing healthy records', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], {
    sources: [], poolIds: ['a', 'b', 'c'], poolFillMode: 'fill', poolTargetCount: 11, poolSelectionMode: 'balanced'
  });
  for (const [pool, start] of [['a', 1], ['b', 40], ['c', 80]]) addFillStock(deps, 10, start, pool);
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 11);
  assert.ok(deps.getRemote().includes('198.51.100.1'));
  assert.deepEqual(['a', 'b', 'c'].map((id) => deps.getState().ipUsageRecords.filter((item) => item.poolId === id).length), [4, 3, 3]);
  assert.equal(deps.getState().dnsGuards[0].poolBalanceNextId, 'b');
});

test('balanced consumption redistributes healthy results after uneven candidate failures', async () => {
  const deps = sourceGuardFixture([], {
    sources: [], poolIds: ['a', 'b'], poolFillMode: 'fill', poolTargetCount: 10, poolSelectionMode: 'balanced'
  });
  addFillStock(deps, 10, 1, 'a'); addFillStock(deps, 10, 40, 'b');
  await nextSourceCycle(deps, (address) => Number(address.split('.').at(-1)) > 5);
  const records = deps.getState().ipUsageRecords;
  assert.deepEqual(['a', 'b'].map((id) => records.filter((item) => item.poolId === id && item.status === 'consumed').length), [5, 5]);
  assert.equal(records.filter((item) => item.status === 'discarded').length, 5);
  assert.equal(deps.getRemote().length, 10);
});

test('balanced fill lets other pools cover depleted or unhealthy pools', async () => {
  const deps = sourceGuardFixture([], {
    sources: [], poolIds: ['a', 'b', 'c'], poolFillMode: 'fill', poolTargetCount: 5, poolSelectionMode: 'balanced', maxParallel: 3
  });
  addFillStock(deps, 2, 1, 'a'); addFillStock(deps, 5, 40, 'b'); addFillStock(deps, 0, 80, 'c');
  await nextSourceCycle(deps, (address) => address !== '203.0.113.1');
  assert.deepEqual(['a', 'b', 'c'].map((id) => deps.getState().ipUsageRecords.filter((item) => item.poolId === id && item.status === 'consumed').length), [1, 4, 0]);
  assert.equal(deps.getRemote().length, 5);
});

test('single IP balanced repairs rotate across runs and survive restart', async () => {
  let deps = sourceGuardFixture([], { sources: [], poolIds: ['a', 'b', 'c'], poolSelectionMode: 'balanced', maxParallel: 1 });
  for (const [pool, start] of [['a', 1], ['b', 40], ['c', 80]]) addFillStock(deps, 2, start, pool);
  for (const poolId of ['a', 'b', 'c', 'a']) {
    const previous = new Set(deps.getRemote());
    await nextSourceCycle(deps, (address) => !previous.has(address));
    assert.equal(deps.getRemote().length, 1);
    assert.equal(deps.getState().ipUsageRecords[0].poolId, poolId);
    deps = remoteDeps(normalizeOrchestrationState(deps.getState()), deps.getRemote());
  }
});

test('balanced candidates skip unavailable and duplicate IPs and preserve IPv6 pool order', () => {
  const deps = sourceGuardFixture([], { recordType: 'AAAA', poolIds: ['a', 'off', 'b'], poolSelectionMode: 'balanced' });
  const state = deps.getState();
  state.ipAssets = [
    { id: 'active', address: '2001:db8::1' }, { id: 'shared', address: '2001:db8::2' },
    { id: 'leased', address: '2001:db8::3' }, { id: 'reserved', address: '2001:db8::4' },
    { id: 'bad', address: '2001:db8::5', health: 'unhealthy' }, { id: 'disabled', address: '2001:db8::6', enabled: false },
    { id: 'ipv4', address: '192.0.2.1' }, { id: 'only-b', address: '2001:db8::7' }, { id: 'only-off', address: '2001:db8::8' }
  ];
  state.ipPools = [{ id: 'a', assetIds: state.ipAssets.slice(0, 7).map((item) => item.id) },
    { id: 'off', enabled: false, assetIds: ['only-off'] }, { id: 'b', assetIds: ['shared', 'only-b'] }];
  state.ipLeases = [{ assetId: 'leased', status: 'locked', expiresAt: '2099-01-01' }];
  state.dnsGuards.push({ id: 'busy', cycle: { candidateAssets: [{ assetId: 'reserved' }] } });
  const result = collectDnsGuardPoolCandidates(state, state.dnsGuards[0], 50, new Set(['2001:db8::1']));
  assert.deepEqual(result.map((item) => item.address), ['2001:db8::2', '2001:db8::7']);
});

test('balanced checks finish when enough candidates pass without waiting for a slow pool or probe', async () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['a', 'b'], poolSelectionMode: 'balanced', poolFillMode: 'fill', poolTargetCount: 2 });
  addFillStock(deps, 2, 1, 'a'); addFillStock(deps, 2, 40, 'b');
  await runDueDnsGuards(deps);
  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.cycle.checks.length, 4);
  for (const check of guard.cycle.checks.filter((item) => ['203.0.113.40', '203.0.113.41'].includes(item.address))) {
    check.observations['probe-1'] = { ok: true, attempts: 1 };
  }
  await processReadyDnsGuards(deps);
  assert.deepEqual(deps.getRemote(), ['203.0.113.40', '203.0.113.41']);
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.equal(deps.getState().ipAssets.length, 2, 'unsettled candidates must remain in inventory');
});

test('balanced cursor advances only after a successful provider commit, including timeout retries', async () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['a', 'b'], poolSelectionMode: 'balanced', poolBalanceNextId: 'b' });
  addFillStock(deps, 2, 1, 'a'); addFillStock(deps, 2, 40, 'b');
  await runDueDnsGuards(deps);
  for (const check of deps.getState().dnsGuards[0].cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  const read = deps.readDnsRecord;
  deps.readDnsRecord = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  await processReadyDnsGuards(deps);
  assert.equal(deps.getState().dnsGuards[0].poolBalanceNextId, 'b');
  assert.equal(deps.getState().ipAssets.length, 4);
  assert.deepEqual(deps.getRemote(), []);
  deps.readDnsRecord = read;
  await processReadyDnsGuards(deps);
  assert.deepEqual(deps.getRemote(), ['203.0.113.40']);
  assert.equal(deps.getState().dnsGuards[0].poolBalanceNextId, 'a');
  assert.equal(deps.getState().ipAssets.length, 3);
  await processReadyDnsGuards(deps);
  assert.equal(deps.getState().dnsGuards[0].poolBalanceNextId, 'a');
});

test('changing pool selection during preparation rejects the old preparation', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { sources: [], poolSelectionMode: 'ordered' });
  const read = deps.readDnsRecord, gate = Promise.withResolvers();
  deps.readDnsRecord = async (...args) => { await gate.promise; return read(...args); };
  const running = runDueDnsGuards(deps);
  await Promise.resolve();
  deps.getState().dnsGuards[0].poolSelectionMode = 'balanced';
  gate.resolve(); await running;
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
});

test('fill mode tops up healthy records to fifty independently of the pool incident allocation mode', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 50 });
  addFillStock(deps, 60);
  let notifications = 0;
  deps.notifyDnsGuard = () => notifications++;
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 50);
  assert.equal(deps.getState().ipAssets.length, 11);
  assert.equal(deps.getState().dnsGuards[0].repairTargetCount, 0);
  assert.match(deps.getState().dnsGuards[0].message, /已补充 49 个 IP/);
  assert.equal(notifications, 0, 'routine filling does not send failure notifications');
  assert.deepEqual(await nextSourceCycle(deps), deps.getRemote(), 'full guard only checks existing records');
  assert.equal(deps.getState().ipAssets.length, 11);
});

test('forty-nine healthy records consume only one candidate and do not wait for slower candidates or probes', async () => {
  const remote = Array.from({ length: 49 }, (_, i) => `198.51.100.${i + 1}`);
  const deps = sourceGuardFixture(remote, { sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 50 });
  addFillStock(deps, 10);
  await runDueDnsGuards(deps);
  let guard = deps.getState().dnsGuards[0];
  for (const check of guard.cycle.checks) check.observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  guard = deps.getState().dnsGuards[0];
  assert.equal(guard.cycle.replacementNeeded, 1);
  assert.ok(guard.cycle.checks.length > 1, 'candidate preflight remains parallel');
  guard.cycle.checks[0].observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  assert.equal(deps.getRemote().length, 50);
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.equal(deps.getState().ipAssets.length, 9);
});

test('partial fill survives restart and recalculates the deficit after another active IP fails', async () => {
  let deps = sourceGuardFixture(['198.51.100.1'], { sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 5 });
  addFillStock(deps, 2);
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 3);
  assert.equal(deps.getState().dnsGuards[0].status, 'degraded');
  assert.match(deps.getState().dnsGuards[0].message, /3\/5.*待补 2/);
  deps = remoteDeps(deps.getState(), deps.getRemote());
  addFillStock(deps, 3, 3);
  await nextSourceCycle(deps, (address) => address !== '198.51.100.1');
  assert.equal(deps.getRemote().length, 5);
  assert.ok(!deps.getRemote().includes('198.51.100.1'));
  assert.equal(deps.getState().ipAssets.length, 0);
});

test('lowering a fill target preserves healthy records and does not restore the old larger target', async () => {
  const deps = sourceGuardFixture(['198.51.100.1', '198.51.100.2', '198.51.100.3'], {
    sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 2, repairTargetCount: 50
  });
  let notifications = 0;
  deps.notifyDnsGuard = () => notifications++;
  addFillStock(deps, 5);
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 3);
  assert.equal(notifications, 0);
  await nextSourceCycle(deps, (address) => address !== '198.51.100.3');
  assert.equal(deps.getRemote().length, 2);
  assert.equal(deps.getState().ipAssets.length, 5);
  assert.equal(deps.getState().dnsGuards[0].status, 'healthy');
  assert.match(deps.getState().dnsGuards[0].message, /已移除 1 个故障 IP.*2 个健康 IP.*已达到目标/);
  assert.equal(notifications, 1, 'removing a failed IP still notifies when the lower target is already met');
  await nextSourceCycle(deps, (address) => address !== '198.51.100.2');
  assert.equal(deps.getRemote().length, 2);
  assert.equal(deps.getState().ipAssets.length, 4);
});

test('source IPs satisfy the fill target before pool candidates are used', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 3 });
  addFillStock(deps, 5, 40);
  const checked = await nextSourceCycle(deps);
  assert.deepEqual(deps.getRemote(), ['198.51.100.1', '203.0.113.20', '203.0.113.21']);
  assert.equal(deps.getState().ipAssets.length, 5);
  assert.ok(!checked.includes('203.0.113.40'));
});

test('empty records and failed pool candidates can partially fill and resume without blacklisting', async () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 3 });
  addFillStock(deps, 2);
  await nextSourceCycle(deps, (address) => address !== '203.0.113.1');
  assert.deepEqual(deps.getRemote(), ['203.0.113.2']);
  assert.equal(deps.getState().ipUsageRecords.find((record) => record.address === '203.0.113.1').status, 'discarded');
  addFillStock(deps, 1, 1);
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 2);
  assert.ok(deps.getRemote().includes('203.0.113.1'));
});

test('stock changes only wake related idle guards with a real deficit and available candidates', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 2, currentValues: ['198.51.100.1'], nextCheckAt: '2099-01-01' });
  addFillStock(deps, 2);
  const state = deps.getState(), base = state.dnsGuards[0];
  state.dnsGuards.push(
    { ...structuredClone(base), id: 'other', poolIds: ['other-pool'] },
    { ...structuredClone(base), id: 'full', currentValues: ['198.51.100.1', '198.51.100.2'] },
    { ...structuredClone(base), id: 'disabled', enabled: false },
    { ...structuredClone(base), id: 'active', cycle: { id: 'keep', checks: [] } }
  );
  let writes = 0;
  const update = deps.updateState;
  deps.updateState = (fn) => { writes++; return update(fn); };
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['other-pool'] }), 0);
  assert.equal(writes, 0);
  const prepared = Promise.withResolvers();
  const read = deps.readDnsRecord;
  deps.readDnsRecord = async (...args) => { await prepared.promise; return read(...args); };
  assert.equal(requestWaitingDnsGuardChecks(deps, { assetIds: ['fill-1'] }), 1);
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['fill-pool'] }), 0, 'running preparation is not duplicated');
  assert.ok(state.dnsGuards.slice(1).every((guard) => guard.nextCheckAt === '2099-01-01'));
  assert.equal(state.dnsGuards.at(-1).cycle.id, 'keep');
  prepared.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  // The synthetic active record is unrelated to this guard and has no probes assigned.
  state.dnsGuards = state.dnsGuards.slice(0, 1);
  await finishGuardChecks(deps);
  assert.equal(deps.getRemote().length, 2);
});

test('stock containing only an already active address does not wake a deficient guard', () => {
  const deps = sourceGuardFixture(['203.0.113.1'], {
    sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 2,
    currentValues: ['203.0.113.1'], nextCheckAt: '2099-01-01'
  });
  addFillStock(deps, 1);
  let writes = 0;
  deps.updateState = () => { writes++; return deps.getState(); };
  assert.equal(requestWaitingDnsGuardChecks(deps, { poolIds: ['fill-pool'] }), 0);
  assert.equal(writes, 0);
  assert.equal(deps.getState().dnsGuards[0].nextCheckAt, '2099-01-01');
});

test('fill configuration defaults safely, validates the target and clears obsolete fill deficits on mode change', async () => {
  const legacy = normalizeOrchestrationState({ dnsGuards: [{ maxActiveIps: 20 }] }).dnsGuards[0];
  assert.equal(legacy.poolFillMode, 'repair');
  assert.equal(legacy.poolTargetCount, 20);
  assert.equal(legacy.poolSelectionMode, 'ordered');
  assert.equal(legacy.poolRebalanceEnabled, false);
  assert.equal(legacy.poolRebalanceIntervalMinutes, 30);
  assert.equal(legacy.poolRebalanceNextAt, '');
  assert.equal(legacy.poolBalanceNextId, '');
  const deps = sourceGuardFixture(undefined, { sources: [], maxActiveIps: 20 });
  deps.sanitizeState = (state) => state;
  const routes = new Map();
  registerOrchestrationRoutes(Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, fn) => routes.set(`${method} ${path}`, fn)])), deps);
  const save = async (extra) => {
    let result;
    await routes.get('put /api/orchestration/:resource/:id')({ params: { resource: 'dns-guards', id: 'guard-1' }, auth: { username: 'test' }, body: { ...deps.getState().dnsGuards[0], ...extra } },
      { json(value) { result = value; } }, (error) => { throw error; });
    return result.item;
  };
  for (const poolTargetCount of [0, 21, 1.5, '']) await assert.rejects(save({ poolFillMode: 'fill', poolTargetCount }), /补满目标数量/);
  const filled = await save({ poolFillMode: 'fill', poolTargetCount: '20' });
  assert.equal(filled.poolTargetCount, 20);
  assert.equal(filled.poolFillMode, 'fill');
  deps.getState().dnsGuards[0].repairTargetCount = 20;
  assert.equal((await save({ poolFillMode: 'repair' })).repairTargetCount, 0);
  deps.getState().dnsGuards[0].repairTargetCount = 5;
  assert.equal((await save({ name: 'renamed' })).repairTargetCount, 5, 'ordinary edits retain actual repair deficits');
  addFillStock(deps, 2, 1, 'a'); addFillStock(deps, 2, 40, 'b');
  const balanced = await save({ poolIds: ['a', 'b'], poolSelectionMode: 'balanced', poolBalanceNextId: 'forged' });
  assert.equal(balanced.poolSelectionMode, 'balanced');
  assert.equal(balanced.poolRebalanceEnabled, false);
  assert.equal((await save({ poolRebalanceEnabled: true })).poolRebalanceEnabled, true);
  assert.equal((await save({ name: 'rebalance preserved', poolRebalanceEnabled: undefined })).poolRebalanceEnabled, true);
  assert.equal(balanced.poolBalanceNextId, '', 'the client cannot choose the runtime cursor');
  deps.getState().dnsGuards[0].poolBalanceNextId = 'b';
  assert.equal((await save({ name: 'rename again', poolSelectionMode: undefined, poolBalanceNextId: 'a' })).poolBalanceNextId, 'b');
  assert.equal((await save({ poolIds: ['a'] })).poolBalanceNextId, '', 'removing the next pool resets its cursor');
  assert.equal((await save({ poolSelectionMode: 'ordered' })).poolBalanceNextId, '');
  assert.equal(deps.getState().dnsGuards[0].poolRebalanceEnabled, false);
  deps.getState().dnsGuards[0].currentValues = ['198.51.100.1'];
  deps.getState().dnsGuards[0].poolOrigins = { '198.51.100.1': 'a' };
  assert.deepEqual((await save({ poolOrigins: { '198.51.100.1': 'forged' } })).poolOrigins, { '198.51.100.1': 'a' });
  assert.deepEqual((await save({ domain: 'changed.example.com' })).poolOrigins, {});
});

test('shared pool candidates are reserved across concurrent guards and released after completion', async () => {
  const deps = sourceGuardFixture([], { sources: [], poolIds: ['fill-pool'], poolFillMode: 'fill', poolTargetCount: 1 });
  addFillStock(deps, 3);
  const state = deps.getState();
  state.dnsGuards.push({ ...structuredClone(state.dnsGuards[0]), id: 'second', domain: 'second.example.com' });
  const remote = new Map(state.dnsGuards.map((guard) => [guard.domain, []]));
  deps.readDnsRecord = async (_account, _credentials, _zone, binding) => ({ values: remote.get(binding.domain), recordIds: [] });
  deps.writeDnsRecord = async (_account, _credentials, _zone, binding, values) => { remote.set(binding.domain, [...values]); return []; };
  await runDueDnsGuards(deps);
  const active = state.dnsGuards.filter((guard) => guard.cycle?.candidateAssets?.length);
  assert.equal(active.length, 1);
  const waiting = state.dnsGuards.find((guard) => guard.id !== active[0].id);
  assert.equal(waiting.status, 'waiting_ip');
  assert.equal(collectDnsGuardPoolCandidates(state, waiting).length, 0, 'in-flight candidates stay reserved');
  active[0].cycle.checks[0].observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  assert.equal(collectDnsGuardPoolCandidates(state, waiting).length, 2, 'unused candidates return after cycle ends');
  waiting.nextCheckAt = '';
  await runDueDnsGuards(deps, waiting.id);
  waiting.cycle.checks[0].observations['probe-1'] = { ok: true, attempts: 1 };
  await processReadyDnsGuards(deps);
  const written = [...remote.values()].flat();
  assert.equal(written.length, 2);
  assert.equal(new Set(written).size, 2);
  assert.equal(state.ipAssets.length, 1);
});

test('fill mode supports IPv6 and multiple fallback pools with the same health rules', async () => {
  const deps = sourceGuardFixture(['2001:db8::1'], { sources: [], recordType: 'AAAA', poolIds: ['a', 'b'], poolFillMode: 'fill', poolTargetCount: 3 });
  const state = deps.getState();
  state.ipAssets = [{ id: 'v4', address: '192.0.2.1' }, { id: 'v6-a', address: '2001:db8::2' }, { id: 'v6-b', address: '2001:db8::3' }];
  state.ipPools = [{ id: 'a', assetIds: ['v4', 'v6-a'] }, { id: 'b', assetIds: ['v6-a', 'v6-b'] }];
  await nextSourceCycle(deps);
  assert.deepEqual(deps.getRemote(), ['2001:db8::1', '2001:db8::2', '2001:db8::3']);
  assert.deepEqual(state.ipAssets.map((asset) => asset.id), ['v4']);
});

test('changing the fill target during preparation cannot publish the obsolete preparation', async () => {
  const deps = sourceGuardFixture(['198.51.100.1'], { sources: [], poolFillMode: 'fill', poolTargetCount: 50 });
  const read = deps.readDnsRecord, gate = Promise.withResolvers();
  deps.readDnsRecord = async (...args) => { await gate.promise; return read(...args); };
  const running = runDueDnsGuards(deps);
  await Promise.resolve();
  deps.getState().dnsGuards[0].poolTargetCount = 10;
  gate.resolve(); await running;
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.equal(deps.getState().dnsGuards[0].poolTargetCount, 10);
});

test('new DDNS sources sync while current IPs are healthy and then use cached healthy addresses', async () => {
  const deps = sourceGuardFixture();
  let notices = 0;
  deps.notifyDnsGuard = () => { notices += 1; };
  assert.deepEqual(await nextSourceCycle(deps), ['198.51.100.10', '198.51.100.11', '203.0.113.20', '203.0.113.21']);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11', '203.0.113.20', '203.0.113.21']);
  assert.deepEqual(deps.lookups, [['home.example.com', 4]]);
  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.sourceState.home.status, 'synced');
  assert.equal(guard.sourceState.home.pending, false);
  assert.deepEqual(guard.sourceOwnedValues, ['203.0.113.20', '203.0.113.21']);
  assert.deepEqual(await nextSourceCycle(deps), deps.getRemote());
  assert.equal(deps.lookups.length, 1, 'healthy source and its backup perform no new lookup');
  assert.equal(notices, 0, 'source additions and routine checks are silent');
});

test('a failed source retries independently without resolving other healthy sources', async () => {
  const deps = sourceGuardFixture(['198.51.100.10'], {
    sources: [{ id: 'cached', domain: 'cached.example.com', backupDomain: '' }, { id: 'home', domain: 'home.example.com', backupDomain: '' }],
    sourceState: { cached: { domains: { primary: 'cached.example.com', backup: '' }, primary: ['198.51.100.10'], pending: false } }
  });
  let attempts = 0;
  deps.resolveDomainAddresses = async (domain) => {
    assert.equal(domain, 'home.example.com');
    if (++attempts === 1) throw new Error('DNS timeout');
    return ['203.0.113.20'];
  };
  await nextSourceCycle(deps);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'resolve_error');
  assert.deepEqual(deps.getRemote(), ['198.51.100.10']);
  await nextSourceCycle(deps);
  assert.equal(attempts, 2);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '203.0.113.20']);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'synced');
});

test('source additions obey capacity and resume after the limit is raised', async () => {
  const deps = sourceGuardFixture(undefined, { maxActiveIps: 3 });
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 3);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'capacity');
  assert.deepEqual(await nextSourceCycle(deps), deps.getRemote());
  assert.equal(deps.lookups.length, 1, 'a capacity-limited source is not resolved repeatedly');
  deps.getState().dnsGuards[0].maxActiveIps = 5;
  await nextSourceCycle(deps);
  assert.equal(deps.getRemote().length, 4);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'synced');
});

test('a full manual record skips source probes and reuses capacity-limited DNS results', async () => {
  const deps = sourceGuardFixture(undefined, { maxActiveIps: 2 });
  assert.deepEqual(await nextSourceCycle(deps), deps.getRemote());
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'capacity');
  assert.deepEqual(await nextSourceCycle(deps), deps.getRemote());
  assert.deepEqual(deps.lookups, [['home.example.com', 4]]);
  assert.deepEqual(deps.getState().dnsGuards[0].sourceOwnedValues, []);
});

test('failed source probes retry on a later cycle while healthy remote IPs remain', async () => {
  const deps = sourceGuardFixture();
  await nextSourceCycle(deps, (address) => address.startsWith('198.51.100.'));
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'probe_failed');
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11']);
  await nextSourceCycle(deps);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'synced');
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11', '203.0.113.20', '203.0.113.21']);
});

test('an edited source DNS failure cannot prune an existing healthy source-owned IP', async () => {
  const deps = sourceGuardFixture(undefined, { sourceOwnedValues: ['198.51.100.11'], ownedValues: ['198.51.100.11'] });
  deps.resolveDomainAddresses = async () => { throw new Error('DNS timeout'); };
  await nextSourceCycle(deps);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11']);
  assert.deepEqual(deps.getState().dnsGuards[0].sourceOwnedValues, ['198.51.100.11']);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.pending, true);
});

test('an empty remote receives every healthy source IP without filling from a pool', async () => {
  const deps = sourceGuardFixture([]);
  const state = deps.getState();
  state.dnsGuards[0].poolIds = ['pool'];
  state.ipPools.push({ id: 'pool', enabled: true, assetIds: ['asset'] });
  state.ipAssets.push({ id: 'asset', address: '203.0.113.40', enabled: true });
  assert.deepEqual(await nextSourceCycle(deps), ['203.0.113.20', '203.0.113.21']);
  assert.deepEqual(deps.getRemote(), ['203.0.113.20', '203.0.113.21']);
  assert.equal(state.ipAssets.length, 1);
});

test('backup sources are queried only after every primary IP fails on every probe', async () => {
  const deps = sourceGuardFixture();
  await runDueDnsGuards(deps);
  const remote = deps.getState().dnsGuards[0].cycle;
  remote.checks.forEach((check) => { check.observations['probe-1'] = { ok: true, attempts: 1 }; });
  await processReadyDnsGuards(deps);
  let guard = deps.getState().dnsGuards[0];
  assert.equal(guard.cycle.phase, 'sources');
  guard.cycle.checks.forEach((check) => { check.observations['probe-1'] = { ok: false, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3, attempts: 9 }; });
  assert.equal(await processReadyDnsGuards(deps), 0);
  assert.deepEqual(deps.lookups, [['home.example.com', 4]]);
  await finishGuardChecks(deps, (address) => address === '203.0.113.30');
  guard = deps.getState().dnsGuards[0];
  assert.equal(guard.sourceState.home.activeSide, 'backup');
  assert.equal(guard.sourceState.home.status, 'synced');
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11', '203.0.113.30']);
  assert.deepEqual(deps.lookups, [['home.example.com', 4], ['backup.example.com', 4]]);
  await nextSourceCycle(deps);
  assert.equal(deps.lookups.length, 2, 'a healthy active backup uses its cache');
});

test('a partially healthy primary syncs its good IP without checking backup or retrying bad peers forever', async () => {
  const deps = sourceGuardFixture();
  await nextSourceCycle(deps, (address) => address !== '203.0.113.21');
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11', '203.0.113.20']);
  await nextSourceCycle(deps);
  assert.equal(deps.lookups.length, 1);
});

test('a changed DDNS source can replace its old owned IP at full capacity without removing manual records', async () => {
  const deps = sourceGuardFixture(['198.51.100.10', '198.51.100.11'], {
    maxActiveIps: 2, sourceOwnedValues: ['198.51.100.11'], ownedValues: ['198.51.100.11']
  });
  await nextSourceCycle(deps);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '203.0.113.20']);
  assert.deepEqual(deps.getState().dnsGuards[0].sourceOwnedValues, ['203.0.113.20']);
});

test('source lookup completion cannot restore a cycle canceled by manual IP management', async () => {
  const deps = sourceGuardFixture();
  let release;
  let started;
  const resolving = new Promise((resolve) => { started = resolve; });
  deps.resolveDomainAddresses = async () => { started(); return new Promise((resolve) => { release = resolve; }); };
  await runDueDnsGuards(deps);
  deps.getState().dnsGuards[0].cycle.checks.forEach((check) => { check.observations['probe-1'] = { ok: true, attempts: 1 }; });
  const processing = processReadyDnsGuards(deps);
  await resolving;
  await writeDnsGuardRemoteValues('guard-1', { expectedValues: ['198.51.100.10', '198.51.100.11'], values: ['198.51.100.30'] }, deps, 'tester');
  release(['203.0.113.20']);
  await processing;
  assert.deepEqual(deps.getRemote(), ['198.51.100.30']);
  assert.equal(deps.getState().dnsGuards[0].cycle.phase, 'remote');
});

test('source resolution is bounded and keeps the configured source order', async () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({ id: `source-${i}`, domain: `${i}.example.com` }));
  let active = 0;
  let peak = 0;
  const result = await resolveDnsGuardSources({ recordType: 'A', sources }, [], async (domain) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active -= 1;
    return [`203.0.113.${Number(domain.split('.')[0]) + 1}`];
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(result.values, Array.from({ length: 12 }, (_, i) => `203.0.113.${i + 1}`));
});

test('concurrent guards share one source DNS lookup but keep independent source state', async () => {
  clearDnsGuardSourceCache();
  let lookups = 0;
  const resolve = async () => {
    lookups += 1;
    await new Promise(setImmediate);
    return ['203.0.113.77'];
  };
  const guard = (id, domain) => ({ id, recordType: 'A', sources: [{ id: `source-${id}`, domain }] });
  const [first, second] = await Promise.all([
    resolveDnsGuardSources(guard('a', 'Shared.Example.com.'), [], resolve),
    resolveDnsGuardSources(guard('b', 'shared.example.com'), [], resolve)
  ]);
  assert.equal(lookups, 1);
  assert.deepEqual(first.values, ['203.0.113.77']);
  assert.deepEqual(second.values, ['203.0.113.77']);
  assert.notEqual(first.state['source-a'], second.state['source-b']);
  first.state['source-a'].primary.push('198.51.100.9');
  assert.deepEqual(second.state['source-b'].primary, ['203.0.113.77']);
});

test('DNS failures are not cached and A and AAAA source answers stay separate', async () => {
  clearDnsGuardSourceCache();
  let lookups = 0;
  const resolve = async (_domain, family) => {
    lookups += 1;
    if (lookups === 1) throw new Error('temporary resolver failure');
    return family === 6 ? ['2001:db8::77'] : ['203.0.113.77'];
  };
  const source = [{ id: 'shared', domain: 'shared.example.com' }];
  const failed = await resolveDnsGuardSources({ recordType: 'A', sources: source }, [], resolve);
  const a = await resolveDnsGuardSources({ recordType: 'A', sources: source }, [], resolve);
  const aaaa = await resolveDnsGuardSources({ recordType: 'AAAA', sources: source }, [], resolve);
  assert.equal(failed.state.shared.status, 'resolve_error');
  assert.deepEqual(a.values, ['203.0.113.77']);
  assert.deepEqual(aaaa.values, ['2001:db8::77']);
  assert.equal(lookups, 3);
});

test('an invalidated slow DNS response cannot overwrite the newer shared answer', async () => {
  clearDnsGuardSourceCache();
  let releaseOld;
  let lookups = 0;
  const resolve = async () => {
    lookups += 1;
    if (lookups === 1) await new Promise((resolve) => { releaseOld = resolve; });
    return [lookups === 1 ? '203.0.113.10' : '203.0.113.20'];
  };
  const guard = { recordType: 'A', sources: [{ id: 'shared', domain: 'race.example.com' }] };
  const oldRequest = resolveDnsGuardSources(guard, [], resolve);
  await new Promise(setImmediate);
  clearDnsGuardSourceCache();
  const newRequest = resolveDnsGuardSources(guard, [], resolve);
  assert.deepEqual((await newRequest).values, ['203.0.113.20']);
  releaseOld();
  assert.deepEqual((await oldRequest).values, ['203.0.113.20']);
  const cached = await resolveDnsGuardSources(guard, [], resolve);
  assert.deepEqual(cached.values, ['203.0.113.20']);
  assert.equal(lookups, 2);
});

test('source DNS timeout cancels its resolver and produces an explicit retry state', async (t) => {
  let canceled = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(dns, 'Resolver', function () {
    this.resolve4 = () => new Promise((_resolve, reject) => { this.reject = reject; });
    this.cancel = () => { canceled += 1; this.reject(new Error('DNS resolution timed out')); };
  });
  const pending = resolveDnsGuardSources({ recordType: 'A', sources: [{ id: 'one', domain: 'one.example.com' }] }, []);
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(canceled, 1);
  assert.equal(result.state.one.status, 'resolve_error');
  assert.equal(result.state.one.pending, true);
  assert.match(result.state.one.lastError, /timed out/);
});

test('canceling a source resolution cycle stops queued DNS lookups', async () => {
  let active = true;
  let lookups = 0;
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  const sources = Array.from({ length: 12 }, (_, i) => ({ id: `source-${i}`, domain: `${i}.example.com` }));
  const resolving = resolveDnsGuardSources({ recordType: 'A', sources }, [], async () => {
    lookups += 1;
    await pause;
    return ['203.0.113.20'];
  }, 'primary', () => active);
  assert.equal(lookups, 4);
  active = false;
  release();
  await resolving;
  assert.equal(lookups, 4);
});

test('AAAA source sync filters IPv4 values and reuses existing IP probe evidence', async () => {
  const deps = sourceGuardFixture(['2001:db8::10'], { recordType: 'AAAA' });
  deps.resolveDomainAddresses = async (_domain, family) => {
    assert.equal(family, 6);
    return ['2001:db8::10', '2001:db8::20', '192.0.2.20'];
  };
  assert.deepEqual(await nextSourceCycle(deps), ['2001:db8::10', '2001:db8::20']);
  assert.deepEqual(deps.getRemote(), ['2001:db8::10', '2001:db8::20']);
  assert.deepEqual(deps.getState().dnsGuards[0].sourceOwnedValues, ['2001:db8::20']);
});

test('saving one changed source preserves the DNS cache of unchanged sources', async () => {
  const deps = sourceGuardFixture();
  await nextSourceCycle(deps);
  const guard = deps.getState().dnsGuards[0];
  const cached = structuredClone(guard.sourceState.home);
  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }]));
  registerOrchestrationRoutes(app, { ...deps, sanitizeState: (value) => value });
  let error;
  await routes['put /api/orchestration/:resource/:id']({
    params: { resource: 'dns-guards', id: 'guard-1' }, auth: { username: 'tester' },
    body: { ...guard, sources: [...guard.sources, { id: 'new', domain: 'new.example.com', backupDomain: '' }] }
  }, { json() {} }, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.deepEqual(deps.getState().dnsGuards[0].sourceState.home, cached);
  assert.equal(deps.getState().dnsGuards[0].sourceState.new, undefined);
});

test('a lost IP keeps a repair deficit so a pool can refill it on a later healthy cycle', async () => {
  const deps = sourceGuardFixture(undefined, { sources: [], poolIds: ['pool'] });
  deps.getState().ipPools.push({ id: 'pool', enabled: true, assetIds: [] });
  await nextSourceCycle(deps, (address) => address !== '198.51.100.11');
  assert.deepEqual(deps.getRemote(), ['198.51.100.10']);
  assert.equal(deps.getState().dnsGuards[0].repairTargetCount, 2);
  deps.getState().ipAssets.push({ id: 'replacement', address: '203.0.113.40', enabled: true });
  deps.getState().ipPools[0].assetIds.push('replacement');
  assert.deepEqual(await nextSourceCycle(deps), ['198.51.100.10', '203.0.113.40']);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '203.0.113.40']);
  assert.equal(deps.getState().dnsGuards[0].repairTargetCount, 0);
});

test('pool checks start only after source checks and never refill all available capacity', async () => {
  const deps = sourceGuardFixture(undefined, { poolIds: ['pool'] });
  const state = deps.getState();
  state.ipPools.push({ id: 'pool', enabled: true, assetIds: ['asset'] });
  state.ipAssets.push({ id: 'asset', address: '203.0.113.40', enabled: true });
  const checked = await nextSourceCycle(deps, (address) => ['198.51.100.10', '203.0.113.40'].includes(address));
  assert.deepEqual(checked, ['198.51.100.10', '198.51.100.11', '203.0.113.20', '203.0.113.21', '203.0.113.30', '203.0.113.40']);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '203.0.113.40']);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'probe_failed');
});

test('a verified manual IP reduction clears a previous pool repair deficit', async () => {
  const deps = sourceGuardFixture(undefined, { sources: [], repairTargetCount: 5, poolIds: ['pool'] });
  deps.getState().ipPools.push({ id: 'pool', enabled: true, assetIds: ['asset'] });
  deps.getState().ipAssets.push({ id: 'asset', address: '203.0.113.40', enabled: true });
  await writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10', '198.51.100.11'], values: ['198.51.100.10']
  }, deps, 'tester');
  assert.equal(deps.getState().dnsGuards[0].repairTargetCount, 0);
  await finishGuardChecks(deps);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10']);
  assert.equal(deps.getState().ipAssets.length, 1);
});

test('source evidence survives pool checks and a provider retry', async () => {
  const deps = sourceGuardFixture(undefined, { repairTargetCount: 4, poolIds: ['pool'] });
  deps.getState().ipPools.push({ id: 'pool', enabled: true, assetIds: ['asset'] });
  deps.getState().ipAssets.push({ id: 'asset', address: '203.0.113.40', enabled: true });
  const read = deps.readDnsRecord;
  await runDueDnsGuards(deps);
  for (const phase of ['remote', 'sources', 'replacement']) {
    const guard = deps.getState().dnsGuards[0];
    assert.equal(guard.cycle.phase, phase);
    for (const check of guard.cycle.checks) {
      const ok = !['198.51.100.11', '203.0.113.21'].includes(check.address);
      for (const probe of ok ? ['probe-1'] : ['probe-1', 'probe-2']) {
        check.observations[probe] = { ok, attempts: ok ? 1 : 9, rounds: 3, attemptsPerRound: 3, roundsCompleted: ok ? 1 : 3 };
      }
    }
    if (phase === 'replacement') deps.readDnsRecord = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    await processReadyDnsGuards(deps);
  }
  assert.ok(deps.getState().dnsGuards[0].cycle.finalResults);
  deps.readDnsRecord = read;
  await processReadyDnsGuards(deps);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '203.0.113.20', '203.0.113.40']);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.status, 'synced');
  assert.equal(deps.getState().ipAssets.length, 0);
});

test('an empty replacement queue can retry a provider timeout without waiting for stale-cycle expiry', async () => {
  const deps = sourceGuardFixture(['198.51.100.10'], { sources: [] });
  await runDueDnsGuards(deps);
  const guard = deps.getState().dnsGuards[0];
  for (const probe of guard.cycle.expectedProbeIds) {
    guard.cycle.checks[0].observations[probe] = { ok: false, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3, attempts: 9 };
  }
  const readRecord = deps.readDnsRecord;
  deps.readDnsRecord = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  await processReadyDnsGuards(deps);
  assert.equal(deps.getState().dnsGuards[0].cycle.checks.length, 0);
  assert.equal(dnsGuardCycleReady(deps.getState().dnsGuards[0]), true);
  deps.readDnsRecord = readRecord;
  await processReadyDnsGuards(deps);
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.deepEqual(deps.getRemote(), []);
});

test('allows editing a DNS guard while it is waiting for probe reports', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    status: 'checking',
    message: '正在检查 1 个 IP',
    nextCheckAt: new Date(Date.now() + 30000).toISOString(),
    cycle: {
      id: 'old-cycle',
      startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'],
      checks: [{ id: 'old-check', address: '198.51.100.10', observations: {} }]
    }
  });
  state.probes.push({ id: 'probe-1', name: '英国探针', enabled: true });

  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }]));
  let changedId = '';
  const deps = {
    readState: () => state,
    updateState: (updater) => updater(state),
    sanitizeState: (value) => value,
    onDnsGuardChanged: (id) => { changedId = id; }
  };
  registerOrchestrationRoutes(app, deps);

  let response;
  let routeError;
  await routes['put /api/orchestration/:resource/:id']({
    params: { resource: 'dns-guards', id: 'guard-1' },
    body: {
      ...state.dnsGuards[0],
      interval: 60,
      probeIds: ['probe-1'],
      poolIds: [],
      checkRounds: 3,
      attemptsPerRound: 3,
      maxParallel: 20
    },
    auth: { username: 'tester' }
  }, { json: (value) => { response = value; } }, (error) => { routeError = error; });

  assert.equal(routeError, undefined);
  assert.equal(response.ok, true);
  assert.equal(state.dnsGuards[0].cycle, null);
  assert.equal(state.dnsGuards[0].status, 'queued');
  assert.equal(state.dnsGuards[0].message, '配置已更新，等待重新检查');
  assert.equal(state.dnsGuards[0].interval, 60);
  assert.equal(state.dnsGuards[0].nextCheckAt, '');
  assert.equal(changedId, 'guard-1');
});

test('keeps primary and backup DDNS domains paired during normalization', () => {
  const normalized = normalizeOrchestrationState({
    dnsGuards: [{ id: 'guard-1', recordType: 'A', sources: [{ id: 'home', name: '家庭宽带', domain: 'home.example.com', backupDomain: 'home-backup.example.com' }] }]
  });
  assert.deepEqual(normalized.dnsGuards[0].sources, [{
    id: 'home', name: '家庭宽带', domain: 'home.example.com', backupDomain: 'home-backup.example.com'
  }]);
});

test('migrates legacy flattened backup sources back into a primary pair', () => {
  const normalized = normalizeOrchestrationState({
    dnsGuards: [{
      id: 'guard-1',
      recordType: 'A',
      sources: [
        { id: 'home', name: '家庭宽带', domain: 'home.example.com' },
        { id: 'home-backup', name: '家庭宽带 备用', domain: 'home-backup.example.com' }
      ]
    }]
  });

  assert.deepEqual(normalized.dnsGuards[0].sources, [{
    id: 'home', name: '家庭宽带', domain: 'home.example.com', backupDomain: 'home-backup.example.com'
  }]);
});

test('retries a formerly blocked source IP instead of permanently suppressing it', async () => {
  const guard = {
    recordType: 'A',
    sources: [{ id: 'home', domain: 'home.example.com', backupDomain: '' }],
    sourceState: { home: { cached: ['198.51.100.20'], blocked: ['198.51.100.20'] } }
  };
  const result = await resolveDnsGuardSources(guard, [], async () => ['198.51.100.20']);
  assert.deepEqual(result.values, ['198.51.100.20']);
  assert.equal('blocked' in result.state.home, false);
});

test('uses a healthy backup source only when the primary source has no healthy address', () => {
  const sources = [{ id: 'home', domain: 'home.example.com', backupDomain: 'backup.example.com' }];
  const candidates = { home: { primary: ['198.51.100.20'], backup: ['203.0.113.30'] } };
  const sourceState = { home: { primary: candidates.home.primary, backup: candidates.home.backup, activeSide: 'primary' } };
  const fallback = selectHealthyDnsGuardSources(sources, candidates, sourceState, new Map([
    ['198.51.100.20', { ok: false }], ['203.0.113.30', { ok: true }]
  ]));
  assert.deepEqual(fallback.values, ['203.0.113.30']);
  assert.equal(fallback.state.home.activeSide, 'backup');
  assert.equal(fallback.state.home.pending, false);

  const recovered = selectHealthyDnsGuardSources(sources, candidates, fallback.state, new Map([
    ['198.51.100.20', { ok: true }], ['203.0.113.30', { ok: true }]
  ]));
  assert.deepEqual(recovered.values, ['198.51.100.20']);
  assert.equal(recovered.state.home.activeSide, 'primary');
});

test('settles an IP as soon as any responsible probe succeeds', () => {
  const guard = {
    checkRounds: 3,
    attemptsPerRound: 3,
    cycle: { expectedProbeIds: ['probe-1', 'probe-2'] }
  };
  const check = { observations: {
    'probe-1': { ok: true, attempts: 1, rounds: 3, attemptsPerRound: 3, roundsCompleted: 1 },
    'probe-2': undefined
  } };

  assert.equal(dnsGuardCheckReady(check, guard), true);
  assert.equal(dnsGuardCycleReady({ ...guard, cycle: { ...guard.cycle, checks: [check] } }), true);
});

test('waits for every responsible probe to finish three failed rounds', () => {
  const guard = {
    checkRounds: 3,
    attemptsPerRound: 3,
    cycle: { expectedProbeIds: ['probe-1', 'probe-2'] }
  };
  const failed = { ok: false, attempts: 9, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3 };
  const check = { observations: { 'probe-1': failed, 'probe-2': undefined } };

  assert.equal(dnsGuardCheckReady(check, guard), false);
  check.observations['probe-2'] = failed;
  assert.equal(dnsGuardCheckReady(check, guard), true);
});

test('clears a stale DNS guard cycle when no responsible probe is online', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: [],
    checkRounds: 3,
    attemptsPerRound: 3,
    timeout: 5,
    maxParallel: 20,
    status: 'checking',
    nextCheckAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    cycle: {
      id: 'stale-cycle',
      startedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      checks: [{ id: 'check-1', address: '198.51.100.10', observations: {} }]
    }
  });
  const deps = remoteDeps(state);

  assert.equal(await runDueDnsGuards(deps), 0);
  assert.equal(deps.getState().dnsGuards[0].status, 'waiting_probe');
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
});

test('waits instead of starting a guard cycle with a stale registered probe', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20
  });
  state.probes.push({
    id: 'probe-1', name: '英国探针', enabled: true, agentSecretHash: 'registered',
    lastSeenAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  });
  const deps = remoteDeps(state);

  assert.equal(await runDueDnsGuards(deps), 1);
  assert.equal(deps.getState().dnsGuards[0].status, 'waiting_probe');
  assert.equal(deps.getState().dnsGuards[0].cycle, null);
  assert.match(deps.getState().dnsGuards[0].message, /等待 1 个负责探针上线/);
});

test('stops an active guard cycle when one responsible probe goes offline', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1', 'probe-2'], status: 'checking', currentValues: ['198.51.100.10'],
    checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20,
    cycle: {
      id: 'active-cycle', startedAt: new Date().toISOString(), phase: 'remote',
      expectedProbeIds: ['probe-1', 'probe-2'], remoteValues: ['198.51.100.10'],
      checks: [{ id: 'check-1', address: '198.51.100.10', observations: {} }]
    }
  });
  state.probes.push(
    { id: 'probe-1', enabled: true, agentSecretHash: 'registered', status: 'online', lastSeenAt: new Date().toISOString() },
    { id: 'probe-2', enabled: true, agentSecretHash: 'registered', status: 'online', lastSeenAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }
  );
  const deps = remoteDeps(state);

  assert.equal(await runDueDnsGuards(deps), 0);
  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.status, 'waiting_probe');
  assert.equal(guard.cycle, null);
  assert.deepEqual(guard.currentValues, ['198.51.100.10']);
  assert.match(guard.message, /等待 1 个负责探针上线/);
});

test('wakes a waiting DNS guard as soon as its probe becomes available', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], status: 'waiting_probe', message: '等待负责探针上线',
    nextCheckAt: new Date(Date.now() + 30000).toISOString()
  });
  state.probes.push({ id: 'probe-1', enabled: true, agentSecretHash: 'registered', status: 'online', lastSeenAt: new Date().toISOString() });
  const deps = remoteDeps(state);

  assert.equal(requestWaitingDnsGuardProbeChecks(deps, 'probe-1'), 1);
  assert.notEqual(deps.getState().dnsGuards[0].status, 'waiting_probe');
  assert.equal(deps.getState().dnsGuards[0].nextCheckAt, '');
});

test('does not rewrite state when a probe has no waiting DNS guard', () => {
  const deps = remoteDeps(guardState());
  let updates = 0;
  const updateState = deps.updateState;
  deps.updateState = (updater) => {
    updates += 1;
    return updateState(updater);
  };

  assert.equal(requestWaitingDnsGuardProbeChecks(deps, 'probe-1'), 0);
  assert.equal(updates, 0);
});

test('gives every configured source a primary and backup probe slot before extra addresses', () => {
  const sources = Array.from({ length: 100 }, (_, index) => ({ id: `source-${index}`, domain: `primary-${index}.example.com`, backupDomain: `backup-${index}.example.com` }));
  const candidates = Object.fromEntries(sources.map((source, index) => [source.id, {
    primary: [`10.0.0.${index + 1}`, `10.1.0.${index + 1}`],
    backup: [`172.16.0.${index + 1}`, `172.17.0.${index + 1}`]
  }]));

  const values = roundRobinDnsGuardSourceValues(sources, candidates, 200);
  assert.equal(values.length, 200);
  assert.ok(sources.every((source) => values.includes(candidates[source.id].primary[0]) && values.includes(candidates[source.id].backup[0])));
  assert.equal(values.some((address) => address.startsWith('10.1.') || address.startsWith('172.17.')), false);
});

test('reads and safely writes guard remote IPs with snapshot conflict detection', async () => {
  const state = guardState();
  state.dnsGuards[0].ownedValues = ['198.51.100.10', '198.51.100.99'];
  state.dnsGuards[0].sourceOwnedValues = ['198.51.100.99'];
  const deps = remoteDeps(state);
  const pulled = await syncDnsGuardRemote('guard-1', deps, 'tester');
  assert.deepEqual(pulled.values, ['198.51.100.10']);
  assert.deepEqual(deps.getState().dnsGuards[0].currentValues, ['198.51.100.10']);
  assert.deepEqual(deps.getState().dnsGuards[0].ownedValues, ['198.51.100.10']);
  assert.deepEqual(deps.getState().dnsGuards[0].sourceOwnedValues, []);

  const written = await writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10'],
    values: ['198.51.100.11', '198.51.100.12']
  }, deps, 'tester');
  assert.deepEqual(written.values, ['198.51.100.11', '198.51.100.12']);
  assert.deepEqual(deps.getRemote(), written.values);
  assert.equal(deps.getState().dnsChanges[0].guardId, 'guard-1');
  assert.equal(deps.getState().auditLogs[0].action, 'dnsGuard.push');

  await assert.rejects(
    writeDnsGuardRemoteValues('guard-1', { expectedValues: ['198.51.100.10'], values: ['198.51.100.13'] }, deps, 'tester'),
    /远程 IP 已发生变化/
  );
});

test('allows remote IP management while waiting for guard checks', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    status: 'checking',
    currentValues: ['198.51.100.10'],
    cycle: {
      id: 'active-cycle', phase: 'remote', startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'], remoteValues: ['198.51.100.10'],
      checks: [{ id: 'check-1', address: '198.51.100.10', observations: {} }]
    }
  });
  const deps = remoteDeps(state, ['198.51.100.10']);

  const written = await writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10'],
    values: ['198.51.100.11']
  }, deps, 'tester');

  const guard = deps.getState().dnsGuards[0];
  assert.deepEqual(written.values, ['198.51.100.11']);
  assert.deepEqual(deps.getRemote(), ['198.51.100.11']);
  assert.equal(guard.cycle, null);
  assert.equal(guard.status, 'queued');
  assert.equal(guard.nextCheckAt, '');
});

test('does not revive a canceled guard cycle after manual remote management', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    checkRounds: 1,
    attemptsPerRound: 1,
    maxParallel: 20,
    status: 'checking',
    currentValues: ['198.51.100.10'],
    cycle: {
      id: 'cycle-1',
      startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'],
      remoteValues: ['198.51.100.10'],
      sourceValues: [],
      sourceCandidates: {},
      candidateAssets: [],
      sourceState: {},
      sourceErrors: [],
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
      checks: [{
        id: 'check-1',
        address: '198.51.100.10',
        observations: { 'probe-1': { ok: false, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } }
      }]
    }
  });
  const deps = remoteDeps(state);
  let releaseRead;
  let markReadStarted;
  let reads = 0;
  let notifications = 0;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readRemote = deps.readDnsRecord;
  deps.readDnsRecord = async () => {
    reads += 1;
    if (reads === 1) {
      markReadStarted();
      await new Promise((resolve) => { releaseRead = resolve; });
    }
    return readRemote();
  };
  deps.notifyDnsGuard = () => { notifications += 1; };

  const writing = writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10'],
    values: ['198.51.100.11']
  }, deps, 'tester');
  await readStarted;
  const processing = processReadyDnsGuards(deps);
  releaseRead();
  await Promise.all([writing, processing]);

  const guard = deps.getState().dnsGuards[0];
  assert.deepEqual(deps.getRemote(), ['198.51.100.11']);
  assert.deepEqual(guard.currentValues, ['198.51.100.11']);
  assert.equal(guard.cycle, null);
  assert.equal(guard.status, 'queued');
  assert.equal(guard.message, '远程 IP 已更新，等待检查并修复');
  assert.equal(notifications, 0);
});

test('serializes a remote read against concurrent guard writes', async () => {
  const deps = remoteDeps(guardState());
  let releaseRead;
  let markReadStarted;
  let reads = 0;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readRemote = deps.readDnsRecord;
  deps.readDnsRecord = async () => {
    reads += 1;
    if (reads === 1) {
      markReadStarted();
      await new Promise((resolve) => { releaseRead = resolve; });
    }
    return readRemote();
  };

  const syncing = syncDnsGuardRemote('guard-1', deps, 'tester');
  await readStarted;
  let writeSettled = false;
  const writing = writeDnsGuardRemoteValues(
    'guard-1',
    { expectedValues: ['198.51.100.10'], values: ['198.51.100.11'] },
    deps,
    'tester'
  ).finally(() => { writeSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writeSettled, false);
  releaseRead();
  await syncing;
  const written = await writing;
  assert.deepEqual(written.values, ['198.51.100.11']);
  assert.equal(reads >= 2, true);
});

test('keeps automatic guard preparation healthy while a manual remote read is active', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20
  });
  state.probes.push({
    id: 'probe-1', name: '英国探针', enabled: true, agentSecretHash: 'registered',
    lastSeenAt: new Date().toISOString()
  });
  const deps = remoteDeps(state);
  let releaseRead;
  let markReadStarted;
  let reads = 0;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readRemote = deps.readDnsRecord;
  deps.readDnsRecord = async () => {
    reads += 1;
    if (reads === 1) {
      markReadStarted();
      await new Promise((resolve) => { releaseRead = resolve; });
    }
    return readRemote();
  };

  const syncing = syncDnsGuardRemote('guard-1', deps, 'tester');
  await readStarted;
  const checking = runDueDnsGuards(deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(deps.getState().dnsGuards[0].status, 'error');
  releaseRead();
  await Promise.all([syncing, checking]);

  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.status, 'checking');
  assert.equal(guard.lastError || '', '');
  assert.deepEqual(guard.cycle.checks.map((check) => check.address), ['198.51.100.10']);
});

test('manual guard writes do not wait for a slow automatic provider read', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20
  });
  state.probes.push({ id: 'probe-1', enabled: true, agentSecretHash: 'registered' });
  const deps = remoteDeps(state);
  const readRemote = deps.readDnsRecord;
  let reads = 0;
  let releaseAutomaticRead;
  let markAutomaticReadStarted;
  const automaticReadStarted = new Promise((resolve) => { markAutomaticReadStarted = resolve; });
  deps.readDnsRecord = async (...args) => {
    reads += 1;
    if (reads === 1) {
      markAutomaticReadStarted();
      await new Promise((resolve) => { releaseAutomaticRead = resolve; });
    }
    return readRemote(...args);
  };

  const checking = runDueDnsGuards(deps);
  await automaticReadStarted;
  const written = await Promise.race([
    writeDnsGuardRemoteValues('guard-1', {
      expectedValues: ['198.51.100.10'], values: ['198.51.100.11']
    }, deps, 'tester'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Manual write waited for automatic read')), 500))
  ]);
  assert.deepEqual(written.values, ['198.51.100.11']);
  releaseAutomaticRead();
  await checking;

  const guard = deps.getState().dnsGuards[0];
  assert.deepEqual(guard.currentValues, ['198.51.100.11']);
  assert.equal(guard.cycle.phase, 'remote');
  assert.deepEqual(guard.cycle.remoteValues, ['198.51.100.11']);
  assert.equal(guard.status, 'checking');
});

test('starts probe checks from a verified manual write without rereading the provider', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20
  });
  state.probes.push({ id: 'probe-1', enabled: true, agentSecretHash: 'registered' });
  const deps = remoteDeps(state);
  const readRemote = deps.readDnsRecord;
  let reads = 0;
  deps.readDnsRecord = async (...args) => {
    reads += 1;
    return readRemote(...args);
  };

  await writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10'], values: ['198.51.100.11']
  }, deps, 'tester');

  assert.equal(reads, 1);
  assert.equal(await runDueDnsGuards(deps, 'guard-1'), 0);
  assert.equal(reads, 1);
  assert.deepEqual(deps.getState().dnsGuards[0].cycle.checks.map((check) => check.address), ['198.51.100.11']);
});

test('releases a manual guard write after a transient provider timeout without rolling back', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20,
    currentValues: ['198.51.100.10']
  });
  state.probes.push({ id: 'probe-1', enabled: true, agentSecretHash: 'registered' });
  const deps = remoteDeps(state);
  const readRemote = deps.readDnsRecord;
  let reads = 0;
  let writes = 0;
  deps.readDnsRecord = async (...args) => {
    reads += 1;
    return readRemote(...args);
  };
  deps.writeDnsRecord = async () => {
    writes += 1;
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };

  const result = await writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10'], values: ['198.51.100.11']
  }, deps, 'tester');

  const guard = deps.getState().dnsGuards[0];
  assert.equal(result.verificationPending, true);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.deepEqual(guard.currentValues, ['198.51.100.10']);
  assert.equal(guard.cycle, null);
  assert.equal(guard.status, 'queued');
  assert.match(guard.message, /等待后台确认/);
  assert.equal(deps.getState().dnsChanges.length, 0);
  assert.equal(deps.getState().auditLogs[0].action, 'dnsGuard.push_pending');

  const pulled = await syncDnsGuardRemote('guard-1', deps, 'tester');
  assert.deepEqual(pulled.values, ['198.51.100.10']);
  assert.equal(reads, 2);
});

test('keeps the last healthy guard status when a provider read times out', async () => {
  const state = guardState();
  const lastCheckAt = new Date(Date.now() - 30000).toISOString();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20,
    status: 'healthy', message: '全部解析 IP 正常', lastCheckAt, nextCheckAt: ''
  });
  state.probes.push({
    id: 'probe-1', name: '英国探针', enabled: true, agentSecretHash: 'registered',
    lastSeenAt: new Date().toISOString()
  });
  const deps = remoteDeps(state);
  deps.readDnsRecord = async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };

  assert.equal(await runDueDnsGuards(deps), 1);

  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.status, 'healthy');
  assert.equal(guard.message, '全部解析 IP 正常');
  assert.equal(guard.lastCheckAt, lastCheckAt);
  assert.equal(guard.lastError, '');
  assert.equal(guard.cycle, null);
  assert.equal(deps.getState().auditLogs[0].action, 'dnsGuard.retry');
});

test('retains a ready guard cycle when a provider write check times out', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    checkRounds: 1,
    attemptsPerRound: 1,
    maxParallel: 20,
    status: 'checking',
    currentValues: ['198.51.100.10'],
    cycle: {
      id: 'cycle-timeout',
      startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'],
      remoteValues: ['198.51.100.10'],
      sourceValues: [],
      sourceCandidates: {},
      candidateAssets: [],
      sourceState: {},
      sourceErrors: [],
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
      checks: [{
        id: 'check-1',
        address: '198.51.100.10',
        observations: { 'probe-1': { ok: false, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } }
      }]
    }
  });
  const deps = remoteDeps(state);
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  deps.readDnsRecord = async () => {
    markReadStarted();
    await new Promise((resolve) => { releaseRead = resolve; });
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };

  const processing = processReadyDnsGuards(deps);
  await readStarted;
  const duplicate = processReadyDnsGuards(deps);
  assert.equal(duplicate, processing);
  releaseRead();
  assert.equal(await processing, 1);

  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.status, 'checking');
  assert.equal(guard.message, '服务商请求超时，等待自动重试');
  assert.equal(guard.lastError, '');
  assert.equal(guard.cycle.id, 'cycle-timeout');
  assert.equal(deps.getState().auditLogs[0].action, 'dnsGuard.retry');
});

test('allows the last remote IP to be removed manually without blacklisting it', async () => {
  const state = guardState();
  state.dnsGuards[0].sources = [{ id: 'home', name: '家庭宽带', domain: 'home.example.com', backupDomain: '' }];
  state.dnsGuards[0].sourceState = { home: { primary: ['198.51.100.10'], backup: [], pending: false } };
  state.dnsGuards[0].sourceOwnedValues = ['198.51.100.10'];
  const deps = remoteDeps(state);

  const written = await writeDnsGuardRemoteValues('guard-1', {
    expectedValues: ['198.51.100.10'],
    values: []
  }, deps, 'tester');

  assert.deepEqual(written.values, []);
  assert.deepEqual(deps.getRemote(), []);
  assert.equal(deps.getState().dnsGuards[0].sourceState.home.pending, true);
  assert.equal('blocked' in deps.getState().dnsGuards[0].sourceState.home, false);
});

test('removes the last failed remote IP during an automatic guard cycle', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    checkRounds: 1,
    attemptsPerRound: 1,
    maxParallel: 20,
    status: 'checking',
    currentValues: ['198.51.100.10'],
    cycle: {
      id: 'cycle-1',
      startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'],
      remoteValues: ['198.51.100.10'],
      sourceValues: [],
      sourceCandidates: {},
      candidateAssets: [],
      sourceState: {},
      sourceErrors: [],
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
      checks: [{
        id: 'check-1',
        address: '198.51.100.10',
        observations: { 'probe-1': { ok: false, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } }
      }]
    }
  });
  const deps = remoteDeps(state);
  let notifications = 0;
  deps.notifyDnsGuard = () => { notifications += 1; };

  await processReadyDnsGuards(deps);

  const guard = deps.getState().dnsGuards[0];
  assert.deepEqual(deps.getRemote(), []);
  assert.deepEqual(guard.currentValues, []);
  assert.equal(guard.status, 'waiting_ip');
  assert.equal(guard.cycle, null);
  assert.equal(notifications, 1);
  assert.equal(Object.values(guard.sourceState).some((entry) => entry?.blocked?.length), false);
});

test('keeps healthy remote IPs when a failed peer has no replacement', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    checkRounds: 1,
    attemptsPerRound: 1,
    maxParallel: 20,
    status: 'checking',
    currentValues: ['198.51.100.10', '198.51.100.11'],
    cycle: {
      id: 'partial-failure-cycle',
      phase: 'remote',
      startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'],
      remoteValues: ['198.51.100.10', '198.51.100.11'],
      sourceValues: [],
      sourceCandidates: {},
      candidateAssets: [],
      sourceState: {},
      sourceErrors: [],
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
      checks: [
        { id: 'check-1', address: '198.51.100.10', observations: { 'probe-1': { ok: false, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } } },
        { id: 'check-2', address: '198.51.100.11', observations: { 'probe-1': { ok: true, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } } }
      ]
    }
  });
  const deps = remoteDeps(state, ['198.51.100.10', '198.51.100.11']);

  await processReadyDnsGuards(deps);

  assert.deepEqual(deps.getRemote(), ['198.51.100.11']);
  assert.deepEqual(deps.getState().dnsGuards[0].currentValues, ['198.51.100.11']);
  assert.equal(deps.getState().dnsGuards[0].status, 'degraded');
});

test('does not notify after a routine healthy DNS guard check', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    checkRounds: 1,
    attemptsPerRound: 1,
    maxParallel: 20,
    status: 'checking',
    currentValues: ['198.51.100.10'],
    ownedValues: ['198.51.100.10'],
    sourceOwnedValues: ['198.51.100.10'],
    sourceState: { home: { primary: ['198.51.100.10'], backup: [], pending: false } },
    cycle: {
      id: 'healthy-cycle',
      startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'],
      remoteValues: ['198.51.100.10'],
      sourceValues: [],
      sourceCandidates: {},
      candidateAssets: [],
      sourceState: {},
      sourceErrors: [],
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
      checks: [{
        id: 'check-1',
        address: '198.51.100.10',
        observations: { 'probe-1': { ok: true, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } }
      }]
    }
  });
  const deps = remoteDeps(state);
  let notifications = 0;
  deps.notifyDnsGuard = () => { notifications += 1; };

  await processReadyDnsGuards(deps);

  assert.equal(deps.getState().dnsGuards[0].status, 'healthy');
  assert.deepEqual(deps.getState().dnsGuards[0].sourceOwnedValues, ['198.51.100.10']);
  assert.equal(notifications, 0);
});

test('starts a DNS guard cycle with remote IPs only', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'],
    poolIds: ['pool-1'],
    checkRounds: 3,
    attemptsPerRound: 3,
    timeout: 5,
    maxParallel: 20
  });
  state.probes.push({
    id: 'probe-1', name: '英国探针', enabled: true, agentSecretHash: 'registered',
    lastSeenAt: new Date().toISOString()
  });
  state.ipAssets.push({ id: 'asset-1', address: '203.0.113.20', enabled: true, health: 'unknown' });
  state.ipPools.push({ id: 'pool-1', assetIds: ['asset-1'], enabled: true, selectionMode: 'ordered' });
  const deps = remoteDeps(state, ['198.51.100.10', '198.51.100.11']);

  assert.equal(await runDueDnsGuards(deps), 1);

  const guard = deps.getState().dnsGuards[0];
  assert.equal(guard.cycle.phase, 'remote');
  assert.deepEqual(guard.cycle.checks.map((check) => check.address), ['198.51.100.10', '198.51.100.11']);
  assert.deepEqual(guard.cycle.candidateAssets, []);
  assert.equal(guard.providerRecordId, 'record-1');
  assert.deepEqual(guard.providerRecordIds, ['record-1']);
  assert.equal(guard.zoneName, 'example.com');
  assert.equal(guard.providerZoneId, 'provider-zone-1');
  assert.equal(guard.cycle.normalizedBinding.providerRecordId, 'record-1');
  assert.equal(guard.message, '正在检查活动 IP：0/2');
});

test('reuses a persisted provider zone without listing account zones again', async () => {
  const binding = {
    domain: 'edge.example.com', recordType: 'A', ttl: 60,
    zoneName: 'example.com', providerZoneId: 'provider-zone-1'
  };
  const resolved = await resolveManagedDnsZone(
    { dnsZones: [] },
    { id: 'account-1', provider: 'huawei' },
    { accessKey: 'ak', secretKey: 'sk' },
    binding
  );

  assert.equal(resolved.zone.name, 'example.com');
  assert.equal(resolved.zone.providerZoneId, 'provider-zone-1');
  assert.equal(resolved.normalizedBinding.recordName, 'edge');
});

test('prepares multiple due DNS guards concurrently', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20
  });
  state.dnsGuards.push({
    ...structuredClone(state.dnsGuards[0]), id: 'guard-2', name: '第二守护', domain: 'edge-2.example.com'
  });
  state.probes.push({
    id: 'probe-1', name: '英国探针', enabled: true, agentSecretHash: 'registered',
    lastSeenAt: new Date().toISOString()
  });
  const deps = remoteDeps(state, ['198.51.100.10']);
  const started = [];
  let release;
  let markBothStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const bothStarted = new Promise((resolve) => { markBothStarted = resolve; });
  deps.resolveDnsBinding = async (_state, _account, _credentials, binding) => {
    started.push(binding.domain);
    if (started.length === 2) markBothStarted();
    await gate;
    return {
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { ...binding, recordName: binding.domain.split('.')[0] }
    };
  };

  const running = runDueDnsGuards(deps);
  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('DNS guards were prepared serially')), 500))
  ]);
  assert.deepEqual(new Set(started), new Set(['edge.example.com', 'edge-2.example.com']));
  release();
  assert.equal(await running, 2);
});

test('limits globally active DNS guard cycles to ten', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, timeout: 5, maxParallel: 20
  });
  for (let index = 2; index <= 12; index += 1) {
    state.dnsGuards.push({
      ...structuredClone(state.dnsGuards[0]),
      id: `guard-${index}`,
      name: `守护 ${index}`,
      domain: `edge-${index}.example.com`
    });
  }
  state.probes.push({
    id: 'probe-1', enabled: true, agentSecretHash: 'registered', status: 'online', lastSeenAt: new Date().toISOString()
  });
  const deps = remoteDeps(state, ['198.51.100.10']);

  assert.equal(await runDueDnsGuards(deps), 10);
  assert.equal(deps.getState().dnsGuards.filter((guard) => guard.cycle).length, 10);
  assert.equal(await runDueDnsGuards(deps), 0);
  assert.equal(deps.getState().dnsGuards.filter((guard) => guard.cycle).length, 10);
});

test('returns lightweight guard polling state and only the latest run per guard', () => {
  const state = guardState();
  state.dnsGuards[0].cycle = {
    id: 'cycle-1', phase: 'remote', startedAt: new Date().toISOString(),
    expectedProbeIds: ['probe-1'], checks: Array.from({ length: 50 }, (_, index) => ({
      id: `check-${index}`, address: `198.51.100.${index + 1}`, observations: { 'probe-1': { ok: true } }
    }))
  };
  state.dnsGuardRuns = [
    { id: 'new-run', guardId: 'guard-1', finishedAt: '2026-09-18T00:00:00.000Z' },
    { id: 'old-run', guardId: 'guard-1', finishedAt: '2026-09-17T00:00:00.000Z' }
  ];
  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }]));
  registerOrchestrationRoutes(app, {
    readState: () => state,
    readDnsGuardStatusState: () => state
  });
  let response;

  routes['get /api/dns-guards/status']({}, { json: (value) => { response = value; } });

  assert.deepEqual(response.dnsGuards[0].cycle, {
    id: 'cycle-1', phase: 'remote', startedAt: state.dnsGuards[0].cycle.startedAt
  });
  assert.deepEqual(response.dnsGuardRuns.map((run) => run.id), ['new-run']);
});

test('processes ready DNS guards concurrently with a fixed worker pool', async () => {
  const state = guardState();
  const readyCycle = (id, address) => ({
    id,
    startedAt: new Date().toISOString(),
    phase: 'remote',
    expectedProbeIds: ['probe-1'],
    remoteValues: [address],
    sourceValues: [], sourceCandidates: {}, candidateAssets: [], sourceState: {}, sourceErrors: [],
    zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
    normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
    checks: [{
      id: `${id}-check`, address,
      observations: { 'probe-1': { ok: false, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } }
    }]
  });
  Object.assign(state.dnsGuards[0], {
    checkRounds: 1, attemptsPerRound: 1, maxParallel: 20, status: 'checking',
    currentValues: ['198.51.100.10'], cycle: readyCycle('cycle-1', '198.51.100.10')
  });
  state.dnsGuards.push({
    ...structuredClone(state.dnsGuards[0]), id: 'guard-2', name: '第二守护', domain: 'edge-2.example.com',
    currentValues: ['198.51.100.11'], cycle: readyCycle('cycle-2', '198.51.100.11')
  });
  const deps = remoteDeps(state, ['198.51.100.10']);
  const readRemote = deps.readDnsRecord;
  const started = new Set();
  let release;
  let markBothStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const bothStarted = new Promise((resolve) => { markBothStarted = resolve; });
  deps.readDnsRecord = async (...args) => {
    started.add(args[3].domain);
    if (started.size === 2) markBothStarted();
    await gate;
    return readRemote(...args);
  };

  const processing = processReadyDnsGuards(deps);
  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Ready DNS guards were processed serially')), 500))
  ]);
  release();
  assert.equal(await processing, 2);
});

test('sends DNS guard checks before ordinary probe targets', () => {
  const state = guardState();
  const secret = 'probe-secret';
  state.probes.push({
    id: 'probe-1', name: '英国探针', enabled: true,
    agentSecretHash: crypto.createHash('sha256').update(secret).digest('hex')
  });
  state.probeTargets.push({
    id: 'target-1', name: '普通目标', address: 'example.net', probeIds: ['probe-1'], enabled: true
  });
  Object.assign(state.dnsGuards[0], {
    enabled: true, probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3, maxParallel: 20,
    cycle: {
      id: 'cycle-1', expectedProbeIds: ['probe-1'],
      checks: [{ id: 'guard-check-1', address: '198.51.100.10', observations: {} }]
    }
  });
  const routes = new Map();
  const app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler)
  };
  registerProbePublicRoutes(app, {
    readState: () => { throw new Error('full state should not be read for probe config'); },
    readProbeState: () => state,
    updateState: (updater) => updater(state),
    allowProbeRegistration: () => true
  });
  let response;
  routes.get('GET /probe/config')({
    headers: { 'x-probe-id': 'probe-1', authorization: `Bearer ${secret}` },
    query: {}
  }, {
    status: () => ({ json: (value) => { response = value; } }),
    json: (value) => { response = value; }
  });

  assert.deepEqual(response.targets.map((target) => target.id), ['guard-check-1', 'target-1']);
  assert.equal(response.targets[1].name, undefined);
  assert.equal(response.targets[1].probeIds, undefined);
  assert.equal(response.unchanged, false);
  assert.equal(response.heartbeatInterval, 20);
  assert.equal(response.maxConcurrency, 100);

  const version = response.version;
  routes.get('GET /probe/config')({
    headers: { 'x-probe-id': 'probe-1', authorization: `Bearer ${secret}` },
    query: { version }
  }, {
    status: () => ({ json: (value) => { response = value; } }),
    json: (value) => { response = value; }
  });
  assert.equal(response.version, version);
  assert.equal(response.unchanged, true);
  assert.equal(response.targets, undefined);

  state.dnsGuards[0].cycle.finalResults = { '198.51.100.10': { ok: true } };
  routes.get('GET /probe/config')({ headers: { 'x-probe-id': 'probe-1', authorization: `Bearer ${secret}` }, query: {} },
    { json: (value) => { response = value; } });
  assert.deepEqual(response.targets.map((target) => target.id), ['target-1'], 'DNS confirmations do not keep unused probe checks alive');
});

test('routes probe report follow-up work only to the matching subsystem', () => {
  const state = guardState();
  const secret = 'probe-secret';
  state.probes.push({
    id: 'probe-1', enabled: true,
    agentSecretHash: crypto.createHash('sha256').update(secret).digest('hex')
  });
  state.probeTargets.push({
    id: 'target-1', name: '普通目标', address: 'example.net', probeIds: ['probe-1'],
    enabled: true, checkRounds: 3, attemptsPerRound: 3, observations: {}
  });
  Object.assign(state.dnsGuards[0], {
    enabled: true, probeIds: ['probe-1'], checkRounds: 3, attemptsPerRound: 3,
    status: 'checking',
    cycle: {
      id: 'cycle-1', phase: 'remote', expectedProbeIds: ['probe-1'],
      checks: [{ id: 'guard-check-1', address: '198.51.100.10', observations: {} }]
    }
  });
  const routes = new Map();
  const app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler)
  };
  let guardFollowUps = 0;
  let targetFollowUps = 0;
  registerProbePublicRoutes(app, {
    readState: () => state,
    updateState: (updater) => updater(state),
    allowProbeRegistration: () => true,
    onDnsGuardReport: () => { guardFollowUps += 1; },
    onProbeReport: () => { targetFollowUps += 1; }
  });
  const report = routes.get('POST /probe/report');
  const response = { status: () => response, json: () => {} };
  const headers = { 'x-probe-id': 'probe-1', authorization: `Bearer ${secret}` };
  const result = { ok: true, rounds: 3, attemptsPerRound: 3, roundsCompleted: 1, attempts: 1 };

  report({ headers, body: { version: '1.4.5', results: [{ targetId: 'guard-check-1', ...result }] } }, response);
  assert.deepEqual([guardFollowUps, targetFollowUps], [1, 0]);

  report({ headers, body: { version: '1.4.5', results: [{ targetId: 'target-1', ...result }] } }, response);
  assert.deepEqual([guardFollowUps, targetFollowUps], [1, 1]);

  const guard = state.dnsGuards[0];
  guard.cycle.finalResults = { '198.51.100.10': { ok: true } };
  guard.message = '正在确认自动均衡写入结果，旧 IP 尚未退池';
  const before = structuredClone(guard.cycle.checks);
  report({ headers, body: { results: [{ targetId: 'guard-check-1', ...result, ok: false }] } }, response);
  assert.deepEqual([guardFollowUps, targetFollowUps], [1, 1], 'late reports must not restart settled provider work');
  assert.deepEqual(guard.cycle.checks, before);
  assert.equal(guard.message, '正在确认自动均衡写入结果，旧 IP 尚未退池');
});

test('skips redundant probe heartbeat state writes', () => {
  const state = guardState();
  const secret = 'probe-secret';
  state.probes.push({
    id: 'probe-1', enabled: true, status: 'online', agentVersion: '1.4.4',
    lastSeenAt: new Date().toISOString(),
    agentSecretHash: crypto.createHash('sha256').update(secret).digest('hex')
  });
  const routes = new Map();
  const app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler)
  };
  let updates = 0;
  registerProbePublicRoutes(app, {
    readState: () => state,
    updateState: (updater) => { updates += 1; return updater(state); },
    allowProbeRegistration: () => true
  });
  routes.get('POST /probe/heartbeat')({
    headers: { 'x-probe-id': 'probe-1', authorization: `Bearer ${secret}` },
    body: { version: '1.4.4' }
  }, { status: () => ({ json: () => {} }), json: () => {} });

  assert.equal(updates, 0);
});

test('checks replacements only after a remote failure and stops after enough succeed', async () => {
  const state = guardState();
  Object.assign(state.dnsGuards[0], {
    poolIds: ['pool-1'], checkRounds: 1, attemptsPerRound: 1, maxParallel: 20,
    status: 'checking', currentValues: ['198.51.100.10', '198.51.100.11'],
    cycle: {
      id: 'staged-cycle', phase: 'remote', startedAt: new Date().toISOString(),
      expectedProbeIds: ['probe-1'], remoteValues: ['198.51.100.10', '198.51.100.11'],
      sourceValues: [], sourceCandidates: {}, candidateAssets: [], sourceState: {}, sourceErrors: [],
      zone: { id: 'zone-1', name: 'example.com', providerZoneId: 'provider-zone-1' },
      normalizedBinding: { recordName: 'edge', providerRecordId: 'record-1', providerRecordIds: ['record-1'] },
      checks: [
        { id: 'remote-1', address: '198.51.100.10', observations: { 'probe-1': { ok: false, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } } },
        { id: 'remote-2', address: '198.51.100.11', observations: { 'probe-1': { ok: true, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 } } }
      ]
    }
  });
  state.ipAssets.push(
    { id: 'asset-1', address: '203.0.113.20', enabled: true, health: 'unknown' },
    { id: 'asset-2', address: '203.0.113.21', enabled: true, health: 'unknown' }
  );
  state.ipPools.push({ id: 'pool-1', name: '备用池', assetIds: ['asset-1', 'asset-2'], enabled: true, selectionMode: 'ordered' });
  const deps = remoteDeps(state, ['198.51.100.10', '198.51.100.11']);
  let notifications = 0;
  deps.notifyDnsGuard = () => { notifications += 1; };

  await processReadyDnsGuards(deps);
  let guard = deps.getState().dnsGuards[0];
  assert.equal(guard.cycle.phase, 'replacement');
  assert.equal(guard.cycle.replacementNeeded, 1);
  assert.deepEqual(guard.cycle.checks.map((check) => check.address), ['203.0.113.20', '203.0.113.21']);
  assert.deepEqual(deps.getRemote(), ['198.51.100.10', '198.51.100.11']);

  guard.cycle.checks[0].observations['probe-1'] = { ok: true, rounds: 1, attemptsPerRound: 1, roundsCompleted: 1, attempts: 1 };
  await processReadyDnsGuards(deps);

  guard = deps.getState().dnsGuards[0];
  assert.deepEqual(deps.getRemote(), ['198.51.100.11', '203.0.113.20']);
  assert.equal(guard.cycle, null);
  assert.equal(guard.status, 'replaced');
  assert.equal(notifications, 1);
  assert.ok(deps.getState().ipAssets.some((asset) => asset.id === 'asset-2'));
});

test('checks every selected pool candidate instead of discarding untested assets', () => {
  const current = Array.from({ length: 50 }, (_, index) => `10.0.0.${index + 1}`);
  const sources = Array.from({ length: 100 }, (_, index) => `198.51.${Math.floor(index / 254)}.${index % 254 + 1}`);
  const assets = Array.from({ length: 50 }, (_, index) => ({ assetId: `asset-${index}`, address: `203.0.113.${index + 1}` }));
  const addresses = buildDnsGuardCheckAddresses(current, sources, assets);

  assert.equal(addresses.length, 200);
  assert.ok(assets.every((item) => addresses.includes(item.address)));
});

test('does not claim a pre-existing manual IP as DDNS-owned', () => {
  const ownership = calculateDnsGuardOwnership(
    { ownedValues: [], sourceOwnedValues: [] },
    ['198.51.100.10'],
    ['198.51.100.10', '198.51.100.11'],
    ['198.51.100.10', '198.51.100.11']
  );

  assert.deepEqual(ownership.sourceOwnedValues, ['198.51.100.11']);
  assert.deepEqual(ownership.ownedValues, ['198.51.100.11']);
});

test('verifies that a failed remote write was actually rolled back', async () => {
  const state = guardState();
  state.dnsAccounts[0].provider = 'cloudflare';
  const deps = remoteDeps(state);
  let writes = 0;
  deps.writeDnsRecord = async (_account, _credentials, _zone, _binding, values) => {
    writes += 1;
    if (writes === 1) return ['record-1'];
    return values.length ? ['record-1'] : [];
  };
  deps.readDnsRecord = async () => ({ values: writes ? ['203.0.113.99'] : ['198.51.100.10'], recordId: 'record-1', recordIds: ['record-1'] });

  await assert.rejects(
    writeDnsGuardRemoteValues('guard-1', { expectedValues: ['198.51.100.10'], values: ['198.51.100.11'] }, deps, 'tester'),
    /远程写入失败且自动恢复失败/
  );
  assert.equal(writes, 2);
});

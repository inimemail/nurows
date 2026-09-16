import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDnsGuardCheckAddresses,
  calculateDnsGuardOwnership,
  normalizeOrchestrationState,
  orchestrationDefaults,
  processReadyDnsGuards,
  resolveDnsGuardSources,
  roundRobinDnsGuardSourceValues,
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
    readState: () => state,
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

test('serializes a remote read against concurrent guard writes', async () => {
  const deps = remoteDeps(guardState());
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  deps.readDnsRecord = async () => {
    markReadStarted();
    await new Promise((resolve) => { releaseRead = resolve; });
    return { values: ['198.51.100.10'], recordId: 'record-1', recordIds: ['record-1'] };
  };

  const syncing = syncDnsGuardRemote('guard-1', deps, 'tester');
  await readStarted;
  await assert.rejects(
    writeDnsGuardRemoteValues('guard-1', { expectedValues: ['198.51.100.10'], values: ['198.51.100.11'] }, deps, 'tester'),
    /正在执行/
  );
  releaseRead();
  await syncing;
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

  await processReadyDnsGuards(deps);

  const guard = deps.getState().dnsGuards[0];
  assert.deepEqual(deps.getRemote(), []);
  assert.deepEqual(guard.currentValues, []);
  assert.equal(guard.status, 'waiting_ip');
  assert.equal(guard.cycle, null);
  assert.equal(Object.values(guard.sourceState).some((entry) => entry?.blocked?.length), false);
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
  const deps = remoteDeps(guardState());
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

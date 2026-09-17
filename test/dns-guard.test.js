import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildDnsGuardCheckAddresses,
  calculateDnsGuardOwnership,
  dnsGuardCheckReady,
  dnsGuardCycleReady,
  normalizeOrchestrationState,
  orchestrationDefaults,
  processReadyDnsGuards,
  registerOrchestrationRoutes,
  registerProbePublicRoutes,
  requestWaitingDnsGuardProbeChecks,
  resolveManagedDnsZone,
  resolveDnsGuardSources,
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

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { orchestrationDefaults, registerOrchestrationRoutes, registerProbePublicRoutes, processPoolHealthChecks,
  sanitizeOrchestrationState, normalizeOrchestrationState } from '../server/orchestration.js';
import { poolHealthProbeState, poolHealthSchedule } from '../server/pool-health-check.js';
import { supportsPoolHealthCheck } from '../shared/probe-capabilities.js';

function harness(count = 3, extra = {}) {
  const assets = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, address: `8.8.${Math.floor(i / 256)}.${i % 256}`, enabled: true }));
  let state = { ...orchestrationDefaults(), ipAssets: assets,
    ipPools: [{ id: 'pool', name: '备用池', assetIds: assets.map(asset => asset.id) }],
    probes: ['p1', 'p2'].map(id => ({ id, status: 'online', enabled: true, agentVersion: '1.4.9', lastSeenAt: new Date().toISOString(),
      agentSecretHash: crypto.createHash('sha256').update('secret').digest('hex') })), ...extra };
  let writes = 0;
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  const deps = { readState: () => structuredClone(state), updateState(fn) {
    const next = fn(structuredClone(state)); state = next; writes++; return state;
  }, sanitizeState: sanitizeOrchestrationState };
  registerOrchestrationRoutes(app, deps);
  registerProbePublicRoutes(app, deps);
  const request = async (method, path, body = {}, params = {}, probeId = 'p1') => {
    let result;
    await routes.get(`${method} ${path}`)({ body, params, query: {}, headers: { 'x-probe-id': probeId, authorization: 'Bearer secret' }, auth: { username: 'tester' } },
      { json(value) { result = value; }, status() { return this; } }, error => { throw error; });
    return result;
  };
  const job = (id = 'pool') => state.ipPools.find(pool => pool.id === id)?.healthCheck;
  return { state: () => state, writes: () => writes, deps, job, request,
    start: (input = {}, id = 'pool') => request('post', '/api/ip-pools/:id/health-check', {
      confirm: 'check-and-delete-unreachable', assetIds: state.ipPools.find(pool => pool.id === id).assetIds,
      probeIds: ['p1', 'p2'], ...input
    }, { id }),
    stop: (jobId = job().id, id = 'pool') => request('post', '/api/ip-pools/:id/health-check/stop', { jobId }, { id }),
    config: (probeId = 'p1') => request('get', '/probe/config', {}, {}, probeId),
    report: (probeId, results) => request('post', '/probe/report', { results }, {}, probeId),
    evidence(check, ok = false, patch = {}, id = 'pool') {
      const current = job(id);
      return { targetId: check.id, checkMarker: current.id, ok, rounds: current.checkRounds,
        attemptsPerRound: current.attemptsPerRound, roundsCompleted: ok ? 1 : current.checkRounds,
        attempts: ok ? 1 : current.checkRounds * current.attemptsPerRound, resolvedAddresses: [check.address],
        error: ok ? '' : '3 rounds x 3 attempts failed: ping failed', ...patch };
    }
  };
}

test('starts 50 parallel checks by default, persists once and never sends inventory queues to clients/probes', async () => {
  const h = harness(5000);
  const response = await h.start();
  assert.equal(h.job().maxParallel, 50);
  assert.equal(h.job().checks.length, 50);
  assert.equal(h.writes(), 1);
  assert.equal(response.state.ipPools[0].healthCheck.queue, undefined);
  assert.equal(response.state.ipPools[0].healthCheck.checks, undefined);
  assert.equal(response.state.ipPools[0].healthCheck.checkingCount, 50);
  assert.equal(poolHealthProbeState(h.state().ipPools)[0].healthCheck.queue, undefined);
  const config = await h.config();
  assert.equal(config.targets.length, 50);
  assert.equal(config.targets[0].checkNowAt, h.job().id);
  assert.equal(config.targets[0].interval, 5);
  assert.equal(config.targets[0].allowPrivate, false);
  const summary = sanitizeOrchestrationState(response.state);
  assert.equal(summary.ipPools[0].healthCheck.checkingCount, 50);
  assert.equal(normalizeOrchestrationState(h.state()).ipPools[0].healthCheck.queue.length, 5000);
});

test('one probe succeeds immediately, refills capacity and ignores late failures', async () => {
  const h = harness(101);
  await h.start();
  const first = h.job().checks.slice();
  await h.report('p1', first.map(check => h.evidence(check, true)));
  assert.equal(h.job().healthyCount, 50);
  assert.equal(h.job().checks.length, 50);
  assert.equal(h.job().completedCount, 50);
  await h.report('p2', first.map(check => h.evidence(check)));
  assert.equal(h.job().healthyCount, 50);
  assert.equal(h.state().ipAssets.length, 101);
  const config = await h.config('p2');
  assert.equal(config.targets.some(check => check.id === first[0].id), false);
});

test('only every selected probe completing every failed attempt deletes; shared membership and history are handled once', async () => {
  const history = [{ id: 'history', address: '8.8.0.0' }];
  const h = harness(3, { ipUsageRecords: history });
  h.state().ipPools.push({ id: 'shared', assetIds: ['a0', 'a1'] });
  await h.start();
  const checks = h.job().checks.slice();
  await h.report('p1', checks.map(check => h.evidence(check)));
  assert.equal(h.state().ipAssets.length, 3);
  assert.equal((await h.config('p1')).targets.length, 0);
  const before = h.writes();
  await h.report('p2', checks.map(check => h.evidence(check)));
  assert.equal(h.writes(), before + 1);
  assert.equal(h.state().ipAssets.length, 0);
  assert.equal(h.state().ipPools[1].assetIds.length, 0);
  assert.deepEqual(h.state().ipUsageRecords, history);
  assert.equal(h.job().status, 'completed');
  assert.equal(h.job().deletedCount, 3);
  assert.equal(h.job().remainingCount, 0);
  assert.equal(h.job().queue, undefined);
  assert.equal(h.state().auditLogs.filter(log => log.action === 'ipPools.health_check_finished').length, 1);
});

test('invalid, incomplete, wrong marker and unassigned-probe evidence never deletes', async () => {
  const h = harness(1);
  await h.start({ probeIds: ['p1'] });
  const check = h.job().checks[0];
  for (const patch of [{ checkMarker: 'stale' }, { attempts: 8 }, { attempts: 1000 }, { roundsCompleted: 1 }, { ok: 'false' }, { attempts: '9' }]) {
    await h.report('p1', [h.evidence(check, false, patch)]);
    assert.equal(h.job().completedCount, 0);
  }
  await h.report('p2', [h.evidence(check)]);
  assert.equal(h.job().completedCount, 0);
  assert.equal(h.state().ipAssets.length, 1);
});

test('runtime errors and unverified address evidence preserve assets; other probes can still rescue them', async () => {
  for (const patch of [{ error: "No such file or directory: 'ping'" }, { error: 'target address is not allowed' }, { resolvedAddresses: [] }, { resolvedAddresses: ['1.1.1.1'] }]) {
    const h = harness(1);
    await h.start();
    const check = h.job().checks[0];
    await h.report('p1', [h.evidence(check, false, patch)]);
    await h.report('p2', [h.evidence(check)]);
    assert.equal(h.job().uncertainCount, 1);
    assert.equal(h.job().status, 'completed');
    assert.equal(h.state().ipAssets.length, 1);
  }
  const h = harness(1);
  await h.start();
  const check = h.job().checks[0];
  await h.report('p1', [h.evidence(check, false, { error: 'Permission denied' })]);
  await h.report('p2', [h.evidence(check, true)]);
  assert.equal(h.job().healthyCount, 1);
});

test('occupation, removal, disabled status and address changes during checking are revalidated before deletion', async () => {
  for (const mutate of [
    state => state.ipLeases.push({ assetId: 'a0', status: 'locked' }),
    state => state.dnsGuards.push({ currentValues: ['8.8.0.0'] }),
    state => state.dnsGuards.push({ cycle: { candidateAssets: [{ assetId: 'a0' }] } }),
    state => { state.ipPools[0].assetIds = []; },
    state => { state.ipAssets[0].address = '1.1.1.1'; },
    state => { state.ipAssets[0].enabled = false; }
  ]) {
    const h = harness(1);
    await h.start();
    const check = h.job().checks[0];
    await h.report('p1', [h.evidence(check)]);
    mutate(h.state());
    await h.report('p2', [h.evidence(check)]);
    assert.equal(h.state().ipAssets.length, 1);
    assert.equal(h.job().skippedCount, 1);
    assert.equal(h.job().deletedCount, 0);
  }
});

test('snapshot excludes later additions and initially skips occupied/private/disabled assets', async () => {
  const h = harness(5);
  h.state().ipLeases.push({ assetId: 'a0', status: 'active' });
  h.state().ipAssets[1].address = '127.0.0.1';
  h.state().ipAssets[2].enabled = false;
  await h.start({ assetIds: ['a0', 'a1', 'a2', 'a3', 'missing'] });
  assert.equal(h.job().checks.length, 1);
  assert.equal(h.job().skippedCount, 4);
  assert.equal(h.job().checks[0].assetId, 'a3');
});

test('stop, restart, offline probes and deadlines end jobs without accepting old reports or deleting unresolved IPs', async () => {
  for (const mode of ['stop', 'restart', 'offline', 'timeout']) {
    const h = harness(2);
    await h.start();
    const check = h.job().checks[0];
    const report = h.evidence(check);
    await h.report('p1', [report]);
    if (mode === 'stop') await h.stop();
    if (mode === 'restart') processPoolHealthChecks(h.deps, true);
    if (mode === 'offline') { h.state().probes[1].status = 'offline'; processPoolHealthChecks(h.deps); }
    if (mode === 'timeout') { h.job().checks[0].deadline = Date.now() - 1; processPoolHealthChecks(h.deps); }
    assert.notEqual(h.job().status, 'running');
    await h.report('p2', [report]);
    assert.equal(h.state().ipAssets.length, 2);
    assert.equal((await h.config()).targets.length, 0);
  }
});

test('late reports cannot bypass deadlines and an offline peer never becomes a failed vote', async () => {
  const h = harness(1);
  await h.start();
  const check = h.job().checks[0];
  await h.report('p1', [h.evidence(check)]);
  h.job().checks[0].deadline = Date.now() - 1;
  await h.report('p2', [h.evidence(check)]);
  assert.equal(h.state().ipAssets.length, 1);
  processPoolHealthChecks(h.deps);
  assert.equal(h.job().status, 'interrupted');
  await h.start();
  const fresh = h.job().checks[0];
  await h.report('p1', [h.evidence(fresh)]);
  h.state().probes[0].status = 'offline';
  await h.report('p2', [h.evidence(fresh)]);
  assert.equal(h.state().ipAssets.length, 1);
  assert.equal(h.job().status, 'interrupted');
});

test('validation and duplicate starts do not change the job, and stale stop requests cannot stop a replacement job', async () => {
  const h = harness(1);
  for (const input of [{ confirm: '' }, { probeIds: [] }, { probeIds: ['unknown'] }, { maxParallel: 101 }, { checkRounds: 0 }, { assetIds: [null] }]) {
    await assert.rejects(h.start(input));
    assert.equal(h.writes(), 0);
  }
  await h.start({ checkType: 'tcp', port: 8443, maxParallel: 100 });
  const oldId = h.job().id;
  await assert.rejects(h.start(), /正在检测/);
  assert.equal(h.job().id, oldId);
  assert.equal((await h.config()).targets[0].port, 8443);
  await h.stop();
  await h.start();
  await assert.rejects(h.stop(oldId), /已变化/);
  assert.equal(h.job().status, 'running');
});

test('global concurrency remains 100 across jobs and stopping releases capacity without per-IP writes', async () => {
  const h = harness(300);
  h.state().ipPools = Array.from({ length: 3 }, (_, i) => ({ id: `pool${i}`, assetIds: h.state().ipAssets.slice(i * 100, i * 100 + 100).map(asset => asset.id) }));
  await h.start({}, 'pool0'); await h.start({}, 'pool1'); await h.start({}, 'pool2');
  assert.equal(h.job('pool0').checks.length, 50);
  assert.equal(h.job('pool1').checks.length, 50);
  assert.equal(h.job('pool2').checks.length, 0);
  assert.equal((await h.config()).targets.length, 100);
  const before = h.writes();
  await h.stop(h.job('pool0').id, 'pool0');
  assert.equal(h.writes(), before + 1);
  assert.equal((await h.config()).targets.length, 100);
  assert.equal(h.job('pool2').checks.length, 50);
});

test('idle ticks use compact schedule metadata and never persist or load full queues', async () => {
  const h = harness(5000);
  await h.start();
  const writes = h.writes();
  processPoolHealthChecks({ ...h.deps, readState() { assert.fail('full state read'); },
    readPoolHealthSchedule: () => ({ schedule: poolHealthSchedule(h.state().ipPools), probes: h.state().probes }) });
  assert.equal(h.writes(), writes);
});

test('pool checks require the independent worker version and never reach old probe agents', async () => {
  const h = harness(1);
  for (const version of ['', '1.4.8', 'invalid', '1.3.99']) {
    h.state().probes[0].agentVersion = version;
    await assert.rejects(h.start(), /升级/);
    assert.equal(h.writes(), 0);
    assert.equal(supportsPoolHealthCheck(version), false);
  }
  h.state().probes[0].agentVersion = '1.4.9';
  await h.start();
  const target = (await h.config()).targets[0];
  assert.equal(target.poolCheckId, 'pool');
  assert.equal(target.guardId, undefined);
  h.state().probes[0].agentVersion = '1.4.8';
  assert.equal((await h.config()).targets.length, 0);
  processPoolHealthChecks(h.deps);
  assert.equal(h.job().status, 'interrupted');
  assert.equal(h.state().ipAssets.length, 1);
});

test('uncertain runtime failures stop a large scan instead of repeatedly wasting checks on the remaining queue', async () => {
  const h = harness(2000);
  await h.start();
  const check = h.job().checks[0];
  await h.report('p1', [h.evidence(check, false, { error: 'ping command error (exit 2)' })]);
  await h.report('p2', [h.evidence(check)]);
  assert.equal(h.job().status, 'interrupted');
  assert.equal(h.job().uncertainCount, 1);
  assert.equal(h.job().queue, undefined);
  assert.equal(h.state().ipAssets.length, 2000);
});

test('shared IPs are not checked concurrently by two cleanup jobs and IPv6 reports match normalized addresses', async () => {
  const h = harness(1);
  h.state().ipPools.push({ id: 'other', assetIds: ['a0'] });
  h.state().ipAssets[0].address = '2606:4700:4700:0:0:0:0:1111';
  await h.start(); await h.start({}, 'other');
  assert.equal(h.job('other').status, 'completed');
  assert.equal(h.job('other').skippedCount, 1);
  const check = h.job().checks[0];
  const report = h.evidence(check, false, { resolvedAddresses: ['2606:4700:4700::1111'] });
  await h.report('p1', [report]); await h.report('p2', [report]);
  assert.equal(h.job().deletedCount, 1);
});

test('equivalent IPv6 representations in DNS occupation are protected and editor saves cannot overwrite live jobs', async () => {
  const h = harness(1);
  h.state().ipAssets[0].address = '2606:4700:4700:0:0:0:0:1111';
  await h.start();
  const check = h.job().checks[0];
  const jobId = h.job().id;
  await h.request('put', '/api/orchestration/:resource/:id', { name: 'edited', assetIds: ['a0'], healthCheck: { status: 'completed' } }, { resource: 'ip-pools', id: 'pool' });
  assert.equal(h.job().id, jobId);
  assert.equal(h.job().checks.length, 1);
  await h.report('p1', [h.evidence(check)]);
  h.state().dnsGuards.push({ currentValues: ['2606:4700:4700::1111'] });
  await h.report('p2', [h.evidence(check)]);
  assert.equal(h.job().deletedCount, 0);
  assert.equal(h.job().skippedCount, 1);
});

test('five thousand healthy IPs stream through 50-IP batches without per-IP requests or retained evidence', async () => {
  const h = harness(5000);
  await h.start();
  let batches = 0;
  while (h.job().status === 'running') {
    const checks = h.job().checks;
    assert.ok(checks.length > 0 && checks.length <= 50);
    await h.report('p1', checks.map(check => h.evidence(check, true)));
    batches++;
  }
  assert.equal(batches, 100);
  assert.equal(h.writes(), 101);
  assert.equal(h.job().healthyCount, 5000);
  assert.equal(h.state().ipAssets.length, 5000);
  assert.equal(h.job().queue, undefined);
  assert.equal(h.job().checks, undefined);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { commandJobDelta, mergeCommandDelta } from '../shared/command-output.js';
import { startPolling } from '../shared/polling.js';
import { sanitizeDynamicGuard } from '../server/dynamic-guard.js';
import { collectDnsGuardPoolCandidates, orchestrationDefaults, registerOrchestrationRoutes } from '../server/orchestration.js';

// Load individual runtime functions without opening storage or starting services.
const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
function runtime(names, globals = {}) {
  const functions = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  });
  const context = vm.createContext({ structuredClone, ...globals });
  vm.runInContext(functions.join('\n'), context);
  return context;
}

test('scoped state snapshots skip histories and cannot mutate persisted state', () => {
  const state = { probes: [{ id: 'probe' }], dnsGuards: [{ id: 'guard' }] };
  Object.defineProperty(state, 'auditLogs', { enumerable: true, get() { throw new Error('history copied'); } });
  const ctx = runtime(['readState'], { ensureStorage() {}, cachedState: state });
  const snapshot = ctx.readState(['dnsGuards', 'probes']);
  snapshot.dnsGuards[0].id = 'changed';
  assert.equal(state.dnsGuards[0].id, 'guard');
  assert.deepEqual(Object.keys(snapshot).sort(), ['dnsGuards', 'probes']);
});

test('failed persistence never publishes an uncommitted cache value', () => {
  const before = { name: 'before' };
  const ctx = runtime(['writeState', 'readState'], {
    ensureStorage() {}, cachedState: before, normalizeStateRecord: (state) => state,
    STORAGE_KEYS: { state: 'state' }, dbSetJson() { throw new Error('disk full'); }
  });
  assert.throws(() => ctx.writeState({ name: 'after' }), /disk full/);
  assert.equal(ctx.readState().name, 'before');
  ctx.dbSetJson = () => {};
  ctx.writeState({ name: 'after' });
  assert.equal(ctx.readState().name, 'after');
});

test('dynamic guard updates copy only their own record and preserve cache on persistence failure', () => {
  const before = { dynamicGuards: [{ id: 'one', status: 'queued' }, { id: 'two' }], dynamicGuardRuns: [{ id: 'run', status: 'processing' }], auditLogs: [{ content: 'large history' }] };
  let saved;
  const cloned = [];
  const ctx = runtime(['updateDynamicGuardState'], {
    ensureStorage() {}, cachedState: before, STORAGE_KEYS: { state: 'state' },
    structuredClone(value) { cloned.push(value); return structuredClone(value); },
    dbSetJson(_key, next) { saved = next; }
  });
  ctx.updateDynamicGuardState((draft) => { draft.dynamicGuards[0].status = 'checking'; }, false, 'one');
  assert.equal(cloned.length, 1);
  assert.equal(cloned[0], before.dynamicGuards[0]);
  assert.equal(saved.auditLogs, before.auditLogs);
  assert.equal(saved.dynamicGuardRuns, before.dynamicGuardRuns);
  assert.equal(saved.dynamicGuards[1], before.dynamicGuards[1]);
  assert.equal(before.dynamicGuards[0].status, 'queued');
  const committed = ctx.cachedState;
  ctx.dbSetJson = () => { throw Error('disk full'); };
  assert.throws(() => ctx.updateDynamicGuardState((draft) => { draft.dynamicGuards[0].status = 'failed'; draft.dynamicGuardRuns[0].status = 'succeeded'; }, true, 'one'), /disk full/);
  assert.equal(ctx.cachedState, committed);
  assert.equal(ctx.cachedState.dynamicGuards[0].status, 'checking');
  assert.equal(ctx.cachedState.dynamicGuardRuns[0].status, 'processing');
});

test('dynamic probe status reads only readiness fields and skips credential payloads', () => {
  const probe = { id: 'p', status: 'online', enabled: true, lastSeenAt: '2026-09-20' };
  Object.defineProperty(probe, 'tokenEnc', { enumerable: true, get() { throw Error('credentials copied'); } });
  const ctx = runtime(['readDynamicProbeStatus'], { ensureStorage() {}, cachedState: { probes: [probe] } });
  assert.equal(ctx.readDynamicProbeStatus()[0].id, 'p');
  assert.equal(ctx.readDynamicProbeStatus()[0].tokenEnc, undefined);
});

test('dynamic status polling excludes command bodies, probe secrets, and unrelated histories before cloning', () => {
  const state = { dynamicGuards: [{ id: 'guard', commandEnc: { cipher: 'secret'.repeat(5000) }, cycle: { id: 'cycle', address: '192.0.2.1', startedAt: 1, observations: { p: { ok: true } } } }],
    probes: [{ id: 'p', tokenEnc: 'probe-secret' }], telegramBots: [{ id: 'bot', tokenEnc: 'bot-secret' }] };
  Object.defineProperty(state, 'dynamicGuardRuns', { get() { throw Error('history loaded'); } });
  const ctx = runtime(['readDynamicGuardStatus'], { ensureStorage() {}, cachedState: state, sanitizeDynamicGuard,
    structuredClone(value) { assert.ok(!JSON.stringify(value).includes('secret')); return structuredClone(value); } });
  const snapshot = ctx.readDynamicGuardStatus();
  assert.equal(snapshot.guards[0].commandConfigured, true);
  assert.equal(snapshot.guards[0].cycle.observations, undefined);
  snapshot.guards[0].cycle.address = 'changed';
  assert.equal(state.dynamicGuards[0].cycle.address, '192.0.2.1');
});

test('probe config snapshots keep evidence but omit provider and source payloads', () => {
  const cycle = { id: 'cycle', phase: 'sources', expectedProbeIds: ['probe'], checks: [{ id: 'check', observations: { probe: { ok: true } } }],
    sourceState: { large: 'x'.repeat(100000) }, candidateResults: {}, zone: { id: 'secret-zone' } };
  const ctx = runtime(['readProbeState'], { ensureStorage() {}, cachedState: { probes: [], probeTargets: [], dnsGuards: [{ id: 'guard', cycle }] } });
  const compact = ctx.readProbeState().dnsGuards[0].cycle;
  assert.deepEqual(compact.checks, cycle.checks);
  assert.equal(compact.sourceState, undefined);
  assert.equal(compact.zone, undefined);
  compact.checks[0].observations.probe.ok = false;
  assert.equal(cycle.checks[0].observations.probe.ok, true);
});

test('view snapshots retain live sidebar counts and latest runs without copying unrelated history', () => {
  const state = { ...orchestrationDefaults(), dnsGuards: [{ id: 'guard', cycle: { id: 'cycle', checks: [{ id: 'check' }] } }],
    dnsGuardRuns: [{ id: 'latest', guardId: 'guard' }, { id: 'old', guardId: 'guard' }],
    probes: [{ status: 'online', lastSeenAt: new Date().toISOString() }, { status: 'online', lastSeenAt: '2000-01-01' }],
    ipAssets: [{ id: 'asset' }], incidents: [{ status: 'waiting_for_ip' }, { status: 'succeeded' }] };
  Object.defineProperty(state, 'auditLogs', { get() { throw new Error('unrelated history'); } });
  const ctx = runtime(['readOrchestrationStatusState'], { ensureStorage() {}, cachedState: state });
  const snapshot = ctx.readOrchestrationStatusState(['dnsGuards', 'dnsGuardRuns']);
  assert.equal(snapshot.dnsGuards[0].cycle.checks, undefined);
  assert.deepEqual(snapshot.dnsGuardRuns.map((run) => run.id), ['latest']);
  assert.equal(snapshot.orchestrationSummary.counts.ipAssets, 1);
  assert.equal(snapshot.orchestrationSummary.checkingGuards, 1);
  assert.equal(snapshot.orchestrationSummary.onlineProbes, 1);
  assert.equal(snapshot.orchestrationSummary.activeIncidents, 1);
});

test('section polling only returns requested resources and strips all credentials', () => {
  const state = { ...orchestrationDefaults(),
    probes: [{ id: 'probe', tokenHash: 'secret', tokenEnc: 'secret', agentSecretHash: 'secret' }],
    dnsAccounts: [{ id: 'account', credentialsEnc: 'secret' }],
    telegramBots: [{ id: 'bot', tokenEnc: 'secret', tokenHash: 'secret' }],
    automationTasks: [{ id: 'task', password: 'secret', passwordEnc: 'secret' }] };
  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }]));
  registerOrchestrationRoutes(app, { readState(keys) { return structuredClone(Object.fromEntries(keys.map((key) => [key, state[key]]))); } });
  const handler = routes['get /api/orchestration/status/:section'];
  for (const section of ['nodes', 'targets', 'guards', 'policies', 'incidents', 'assets', 'pools', 'usage', 'accounts', 'bindings', 'changes', 'bots']) {
    let result;
    handler({ params: { section } }, { json(value) { result = value; } });
    assert.ok(result);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(result.auditLogs, undefined);
    assert.equal(result.workspaces, undefined);
  }
  let status;
  handler({ params: { section: 'toString' } }, { status(value) { status = value; return this; }, json() {} });
  assert.equal(status, 400);
});

test('indexed pool selection preserves order, locks, address family and shared-pool deduplication', () => {
  const assets = [
    { id: 'first', address: '192.0.2.1' }, { id: 'disabled', address: '192.0.2.2', enabled: false },
    { id: 'failed', address: '192.0.2.3', health: 'unhealthy' }, { id: 'locked', address: '192.0.2.4' },
    { id: 'stabilizing', address: '192.0.2.5' }, { id: 'expired', address: '192.0.2.6' }, { id: 'v6', address: '2001:db8::1' }
  ];
  const state = { ipAssets: assets, ipPools: [{ id: 'one', assetIds: ['missing', ...assets.map((item) => item.id)] }, { id: 'two', assetIds: ['first', 'expired'] }],
    incidents: [{ id: 'incident', status: 'stabilizing' }], ipLeases: [
      { assetId: 'locked', status: 'active', expiresAt: new Date(Date.now() + 60000).toISOString() },
      { assetId: 'stabilizing', status: 'locked', incidentId: 'incident', expiresAt: '2000-01-01' },
      { assetId: 'expired', status: 'active', expiresAt: '2000-01-01' }
    ] };
  const guard = { poolIds: ['one', 'two'], recordType: 'A' };
  assert.deepEqual(collectDnsGuardPoolCandidates(state, guard).map((item) => item.assetId), ['first', 'expired']);
  assert.deepEqual(collectDnsGuardPoolCandidates(state, { ...guard, recordType: 'AAAA' }).map((item) => item.assetId), ['v6']);
  assert.deepEqual(collectDnsGuardPoolCandidates(state, guard, 1).map((item) => item.assetId), ['first']);
});

test('full output deltas preserve long logs, detect equal-length changes and recover a lost cursor', () => {
  const job = { results: Array.from({ length: 3 }, (_, i) => ({ serverId: String(i), stdout: 'x'.repeat(200000), stderr: '', status: 'running' })) };
  const initial = commandJobDelta(job, -1, true);
  const client = mergeCommandDelta([], initial);
  assert.equal(client[0].stdout.length, 200000);
  assert.deepEqual(commandJobDelta(job, initial.revision, true).results, []);
  job.results[1].stdout = 'y' + job.results[1].stdout.slice(1);
  const delta = commandJobDelta(job, initial.revision, true);
  assert.deepEqual(delta.results.map((item) => item.serverId), ['1']);
  const updated = mergeCommandDelta(client, delta);
  assert.equal(updated[0], client[0]);
  assert.equal(updated[1].stdout, job.results[1].stdout);
  assert.equal(commandJobDelta(job, 99999, true).reset, true);
  assert.equal(commandJobDelta(job, -1).results[0].stdout.length, 4096);
  job.results[2].status = 'done';
  assert.equal(commandJobDelta(job, delta.revision, true).results[0].status, 'done');
});

test('canceling automation releases its scheduler and retains results for the normal retention window', () => {
  const session = { executionTimer: 9, ssh: { end() {} } };
  const job = { id: 'job', type: 'automation', status: 'running', automationInterval: 3, results: [{ status: 'queued' }], sessions: new Map([['server', session]]), pendingClients: new Map() };
  const jobs = new Map([['job', job]]);
  let cleared;
  let cleanup;
  const timeouts = [];
  const ctx = runtime(['cancelCommandJob'], {
    commandJobs: jobs, clearInterval(id) { cleared = id; }, clearTimeout(id) { timeouts.push(id); },
    setTimeout(callback, delay) { cleanup = callback; assert.equal(delay, 600000); return 4; }, recordAutomationRun() {}, broadcastCommandSession() {}
  });
  ctx.cancelCommandJob(job);
  assert.equal(cleared, 3);
  assert.equal(job.automationInterval, null);
  assert.equal(session.executionTimer, null);
  assert.deepEqual(timeouts, [9]);
  assert.equal(job.results[0].status, 'error');
  assert.equal(jobs.has('job'), true);
  cleanup();
  assert.equal(jobs.size, 0);
});

test('a scheduled SSH retry cannot reopen a canceled task', () => {
  const ctx = runtime(['startInteractiveCommandSession']);
  // No SSH constructor or credentials are available; cancellation must exit
  // before touching either, including when a retry timer has already fired.
  assert.doesNotThrow(() => ctx.startInteractiveCommandSession({ cancelled: true }));
});

test('maintenance removes expired cache entries while preserving active limits and sessions', () => {
  const old = Date.now() - 60000;
  const future = Date.now() + 60000;
  const sessions = new Map([['old', { expiresAt: old }], ['active', { expiresAt: future }]]);
  const authAttempts = new Map([['old', { until: old }], ['active', { until: future }]]);
  const pending = new Map([['old', { expiresAt: old }], ['active', { expiresAt: future }]]);
  runtime(['cleanupExpiredSessions', 'cleanupRuntimeCaches'], { sessions, sessionSockets: { revoke: (token) => sessions.delete(token) }, authAttempts, probeRegistrationAttempts: new Map(), telegramRuntime: { pending } }).cleanupRuntimeCaches();
  for (const map of [sessions, authAttempts, pending]) assert.deepEqual([...map.keys()], ['active']);
});

test('progress updates never overlap and still send completion if the job finishes during a request', async () => {
  let tick;
  let release;
  let cleared = false;
  const calls = [];
  const job = { id: 'job', status: 'running', results: [{ status: 'running' }] };
  const ctx = runtime(['scheduleTelegramProgress'], {
    telegramRuntime: { progressTimers: new Map() }, commandJobs: new Map([['job', job]]),
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { cleared = true; },
    telegramCall(_token, _method, payload) { calls.push(payload); return new Promise((resolve) => { release = resolve; }); }
  });
  ctx.scheduleTelegramProgress('chat', 'message', 'job', 'synthetic');
  const first = tick();
  await tick();
  assert.equal(calls.length, 1);
  release();
  await first;
  await tick();
  assert.equal(calls.length, 1, 'unchanged progress sends no request');
  job.results.push({ status: 'queued' });
  const second = tick();
  job.status = 'done';
  release();
  await second;
  assert.equal(cleared, false);
  const final = tick();
  assert.match(calls.at(-1).text, /已完成/);
  release();
  await final;
  assert.equal(cleared, true);
});

test('workspace polling does not overlap slow requests and cleanup aborts pending I/O', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release;
  const signals = [];
  const stop = startPolling((signal) => {
    signals.push(signal);
    return new Promise((resolve) => { release = resolve; });
  }, 5000);
  t.mock.timers.tick(10000);
  assert.equal(signals.length, 1);
  release();
  await new Promise(setImmediate);
  t.mock.timers.tick(1);
  assert.equal(signals.length, 2);
  stop();
  assert.equal(signals[1].aborted, true);
  release();
  await new Promise(setImmediate);
  t.mock.timers.tick(60000);
  assert.equal(signals.length, 2);
});

test('workspace polling recovers a transient error without shortening its normal interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  let errors = 0;
  const stop = startPolling(async () => {
    if (++calls === 1) throw new Error('temporary timeout');
  }, 5000, { onError() { errors++; } });
  await new Promise(setImmediate);
  assert.equal(errors, 1);
  t.mock.timers.tick(4999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  stop();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { DYNAMIC_DEFAULTS, normalizeDynamicGuard, sanitizeDynamicGuard, dynamicDailyCount,
  dynamicProbeTargets, acceptDynamicReports, createDynamicGuardService, registerDynamicGuardRoutes, executeDynamicCommand } from '../server/dynamic-guard.js';
import { sanitizeOrchestrationState, orchestrationDefaults, registerProbePublicRoutes } from '../server/orchestration.js';
import { pruneHistory } from '../server/history.js';

const initialTime = Date.parse('2026-09-20T12:00:00Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(overrides = {}, options = {}) {
  let time = initialTime, writes = 0, address = '192.0.2.1';
  const calls = [], notices = [], reads = [];
  const state = { probes: ['p1', 'p2'].map((id) => ({ id, name: id, status: 'online', enabled: true, lastSeenAt: new Date(time).toISOString() })), telegramBots: [], dynamicGuards: [], dynamicGuardRuns: [] };
  const encryptSecret = (value) => ({ cipher: value });
  const deps = { readState(keys) { reads.push(keys); return structuredClone(Object.fromEntries(keys.map((key) => [key, state[key]]))); },
    updateState(mutate) { writes++; const copy = structuredClone(state); mutate(copy); Object.assign(state, copy); return structuredClone(state); },
    readDynamicGuard(id) { return structuredClone(state.dynamicGuards.find((guard) => guard.id === id)); },
    encryptSecret, decryptSecret: (value) => value.cipher, notifyDynamicGuard: (guard, message) => notices.push({ id: guard.id, message }) };
  state.dynamicGuards.push(normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'vps.example.com', command: 'curl --fail https://provider.invalid/change', probeIds: ['p1', 'p2'], ...overrides }, null, state, encryptSecret, time));
  const config = { now: () => time, resolveIp: async () => address, execute: async (command) => { calls.push(command); return { ok: true, output: 'submitted' }; }, ...options };
  const service = createDynamicGuardService(deps, config);
  const guard = () => state.dynamicGuards[0];
  const report = (id, ok, patch = {}) => {
    const current = guard(), cycle = current.cycle;
    return acceptDynamicReports(state, id, [{ targetId: cycle?.id, checkMarker: cycle?.id, ok,
      rounds: current.checkRounds, attemptsPerRound: current.attemptsPerRound, roundsCompleted: ok ? 1 : current.checkRounds,
      attempts: ok ? 1 : current.checkRounds * current.attemptsPerRound, resolvedAddresses: [cycle?.address], ...patch }], time);
  };
  const tick = async () => { service.tick(); await service.drain(); };
  const advance = (seconds) => { time += seconds * 1000; for (const probe of state.probes) probe.lastSeenAt = new Date(time).toISOString(); };
  return { state, deps, service, config, guard, report, tick, advance, calls, notices, reads,
    writes: () => writes, now: () => time, address: (value) => { address = value; } };
}
async function failAndSubmit(env) {
  await env.tick();
  env.report('p1', false); env.report('p2', false);
  await env.tick();
}

test('configuration validates domain, probes and bounds; commands never leak in normal state or probe targets', async () => {
  const env = setup();
  assert.equal(sanitizeDynamicGuard(env.guard()).commandConfigured, true);
  assert.equal(JSON.stringify(sanitizeDynamicGuard(env.guard())).includes('provider.invalid'), false);
  assert.equal(JSON.stringify(sanitizeOrchestrationState(env.state)).includes('provider.invalid'), false);
  for (const domain of ['192.0.2.1', 'https://test.example', 'test.example/path', 'bad']) {
    assert.throws(() => normalizeDynamicGuard({ ...env.guard(), domain }, env.guard(), env.state, env.deps.encryptSecret), /DDNS/);
  }
  assert.throws(() => normalizeDynamicGuard({ ...env.guard(), probeIds: [] }, env.guard(), env.state, env.deps.encryptSecret), /探针/);
  assert.throws(() => normalizeDynamicGuard({ ...env.guard(), interval: -1 }, env.guard(), env.state, env.deps.encryptSecret), /整数/);
  await env.tick();
  assert.equal(dynamicProbeTargets(env.state.dynamicGuards, 'p1').length, 1);
  assert.equal(dynamicProbeTargets(env.state.dynamicGuards, 'unassigned').length, 0);
  assert.equal(JSON.stringify(dynamicProbeTargets(env.state.dynamicGuards, 'p1')).includes('provider.invalid'), false);
});

test('one success settles immediately without waiting for slow probes or running remaining rounds', async () => {
  const env = setup();
  await env.tick();
  env.report('p1', true);
  assert.equal(dynamicProbeTargets(env.state.dynamicGuards, 'p2').length, 0);
  await env.tick();
  assert.equal(env.guard().status, 'healthy');
  assert.equal(env.guard().cycle, null);
  assert.equal(env.calls.length, 0);
  assert.equal(env.notices.length, 0);
});

test('only complete failures from every assigned probe submit once; duplicate requests are rejected', async () => {
  const env = setup();
  await env.tick();
  assert.equal(env.report('p1', false, { attempts: 3, roundsCompleted: 1 }), false);
  assert.equal(env.report('p1', false, { checkMarker: 'stale' }), false);
  assert.equal(env.report('p1', false, { resolvedAddresses: [] }), false);
  assert.equal(env.report('p1', false, { error: "No such file or directory: 'ping'" }), false);
  env.report('p1', false);
  await env.tick();
  assert.equal(env.calls.length, 0);
  env.report('p2', false);
  await env.tick();
  assert.equal(env.calls.length, 1);
  assert.equal(env.guard().status, 'waiting_ip');
  assert.equal(env.guard().daily.count, 1);
  assert.throws(() => env.service.request(env.guard().id, true), /已有换 IP/);
  assert.equal(env.state.dynamicGuardRuns.length, 1);
});

test('old IP is retried only after the configured waiting timeout, and restarts the deadline', async () => {
  const env = setup({ waitTimeout: 120 });
  await failAndSubmit(env);
  await env.tick();
  env.advance(119); await env.tick();
  assert.equal(env.calls.length, 1);
  env.advance(5); await env.tick();
  assert.equal(env.calls.length, 2);
  assert.equal(env.guard().flow.deadlineAt, env.now() + 120000);
  assert.equal(env.state.dynamicGuardRuns.length, 1);
  assert.equal(env.state.dynamicGuardRuns[0].attempts, 2);
});

test('zero waiting timeout waits indefinitely, while DNS errors never trigger another submission', async () => {
  const env = setup({ waitTimeout: 0 });
  await failAndSubmit(env);
  env.advance(86400); await env.tick();
  assert.equal(env.calls.length, 1);
  assert.equal(env.guard().flow.deadlineAt, 0);
  const broken = createDynamicGuardService(env.deps, { ...env.config, resolveIp: async () => { throw Error('DNS timeout'); } });
  env.guard().nextAt = 0; env.guard().flow.deadlineAt = 1;
  broken.tick(); await broken.drain();
  assert.equal(env.calls.length, 1);
  assert.equal(env.guard().status, 'query_error');
  assert.ok(env.guard().flow);
});

test('new IP is checked immediately and one successful probe completes the entire change flow', async () => {
  const env = setup();
  await failAndSubmit(env);
  env.address('192.0.2.2');
  await env.tick();
  assert.equal(env.guard().status, 'verifying');
  assert.equal(env.guard().cycle.address, '192.0.2.2');
  env.report('p2', true); await env.tick();
  assert.equal(env.guard().flow, null);
  assert.equal(env.guard().status, 'healthy');
  assert.equal(env.state.dynamicGuardRuns[0].status, 'succeeded');
  assert.equal(env.state.dynamicGuardRuns[0].newIp, '192.0.2.2');
  assert.equal(env.notices.length, 1);
  assert.match(env.notices[0].message, /192\.0\.2\.1 → 192\.0\.2\.2/);
  await env.tick(); assert.equal(env.notices.length, 1);
});

test('an unhealthy new IP starts another change only after all probes fail every round', async () => {
  const env = setup();
  await failAndSubmit(env);
  env.address('192.0.2.2'); await env.tick();
  env.report('p1', false); await env.tick();
  assert.equal(env.calls.length, 1);
  env.report('p2', false); await env.tick();
  assert.equal(env.calls.length, 2);
  assert.equal(env.guard().flow.oldIp, '192.0.2.2');
  assert.equal(env.guard().flow.initialIp, '192.0.2.1');
});

test('a DDNS change after a failed check invalidates that failure instead of changing the new IP blindly', async () => {
  const env = setup();
  await env.tick(); env.report('p1', false); env.report('p2', false);
  env.address('192.0.2.9'); await env.tick();
  assert.equal(env.calls.length, 0);
  await env.tick(); assert.equal(env.guard().cycle.address, '192.0.2.9');
});

test('offline probes and incomplete reports wait safely instead of causing API calls', async () => {
  const env = setup();
  await env.tick(); env.report('p1', false); env.report('p2', false);
  env.state.probes[1].status = 'offline'; await env.tick();
  assert.equal(env.calls.length, 0);
  assert.equal(env.guard().status, 'waiting_probe');
  env.state.probes[1].status = 'online'; env.advance(5); await env.tick();
  const old = env.guard().cycle.id;
  env.advance(100); await env.tick();
  assert.equal(env.guard().cycle, null);
  assert.equal(env.guard().status, 'waiting_probe');
  env.advance(5); await env.tick();
  assert.notEqual(env.guard().cycle.id, old);
  assert.equal(env.calls.length, 0);
});

test('daily limits suppress repeat submissions and notifications while a new IP can still recover', async () => {
  const env = setup({ maxDaily: 1, waitTimeout: 5 });
  await failAndSubmit(env);
  env.advance(5); await env.tick();
  assert.equal(env.guard().status, 'limit');
  assert.equal(env.calls.length, 1);
  env.advance(30); await env.tick();
  assert.equal(env.calls.length, 1);
  assert.equal(env.notices.length, 1);
  env.address('192.0.2.2'); env.advance(30); await env.tick();
  env.report('p1', true); await env.tick();
  assert.equal(env.guard().status, 'healthy');
  assert.equal(env.calls.length, 1);
  assert.equal(dynamicDailyCount(env.guard(), env.now() + 86400000), 0);
});

test('cooldown is enforced for automatic retries and then rechecks DNS before another submission', async () => {
  const env = setup({ cooldown: 60, waitTimeout: 5 });
  await failAndSubmit(env);
  env.advance(5); await env.tick();
  assert.equal(env.guard().status, 'cooldown');
  assert.equal(env.calls.length, 1);
  env.advance(54); await env.tick(); assert.equal(env.calls.length, 1);
  env.advance(1); await env.tick(); assert.equal(env.calls.length, 2);
});

test('uncertain command outcomes consume one attempt and wait before retrying', async () => {
  const env = setup({ waitTimeout: 120 }, { execute: async () => ({ ok: false, uncertain: true, error: 'timeout' }) });
  await failAndSubmit(env);
  assert.equal(env.guard().daily.count, 1);
  assert.equal(env.guard().flow.commandState, 'uncertain');
  await env.tick();
  assert.equal(env.guard().daily.count, 1);
  env.address('192.0.2.2'); env.advance(5); await env.tick();
  env.report('p1', true); await env.tick();
  assert.equal(env.guard().flow, null);
});

test('restart during command execution preserves the conservative deadline and does not duplicate the command', async () => {
  const env = setup();
  env.guard().flow = { id: 'flow', oldIp: '192.0.2.1', initialIp: '192.0.2.1', commandState: 'executing', executionId: 'lost', attempts: 1,
    submittedAt: env.now(), deadlineAt: env.now() + 395000, startedAt: new Date(env.now()).toISOString() };
  env.guard().daily = { date: '2026-09-20', count: 1 };
  await env.tick();
  assert.equal(env.guard().flow.commandState, 'uncertain');
  assert.equal(env.calls.length, 0);
  env.advance(300); await env.tick(); assert.equal(env.calls.length, 0);
  env.advance(95); await env.tick(); assert.equal(env.calls.length, 1);
});

test('edits during DNS preparation reject the obsolete result; editing a target invalidates its old flow', async () => {
  let resolve;
  const env = setup({}, { resolveIp: () => new Promise((done) => { resolve = done; }) });
  env.service.tick(); await flush();
  env.guard().revision++; env.guard().enabled = false;
  resolve('192.0.2.1'); await env.service.drain();
  assert.equal(env.guard().cycle, null);
  assert.equal(env.calls.length, 0);
  env.guard().flow = { id: 'old' };
  const next = normalizeDynamicGuard({ ...env.guard(), domain: 'new.example.com' }, env.guard(), env.state, env.deps.encryptSecret);
  assert.equal(next.flow, null);
  assert.equal(next.currentIp, '');
});

test('slow API commands have their own concurrency limit and do not block healthy target checks', async () => {
  let release;
  const env = setup({}, { maxCommands: 1, execute: () => new Promise((resolve) => { release = resolve; }) });
  const second = normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'second.example.com', command: 'true', probeIds: ['p1', 'p2'] }, null, env.state, env.deps.encryptSecret, env.now());
  env.state.dynamicGuards.push(second);
  await env.tick(); env.report('p1', false); env.report('p2', false);
  env.service.tick(); await flush();
  assert.equal(env.service.isExecuting(env.guard().id), true);
  assert.throws(() => env.service.request(env.guard().id, true), /正在执行/);
  assert.ok(env.state.dynamicGuards[1].cycle);
  acceptDynamicReports(env.state, 'p1', [{ targetId: second.cycle?.id || env.state.dynamicGuards[1].cycle.id, checkMarker: env.state.dynamicGuards[1].cycle.id, ok: true, attempts: 1 }]);
  env.service.tick(); await flush();
  assert.equal(env.state.dynamicGuards[1].status, 'healthy');
  release({ ok: true, output: '' }); await env.service.drain();
});

test('idle scheduler writes nothing and does not load histories; unfinished flows survive history cleanup', async () => {
  const env = setup();
  env.guard().nextAt = env.now() + 30000;
  await env.tick(); await env.tick();
  assert.equal(env.writes(), 0);
  assert.ok(env.reads.every((keys) => !keys.includes('dynamicGuardRuns')));
  env.guard().flow = { id: 'active' };
  env.state.dynamicGuardRuns = [{ id: 'active', status: 'processing', startedAt: '2000-01-01' }, { id: 'finished', status: 'succeeded', finishedAt: '2000-01-01' }];
  const result = pruneHistory(env.state, { all: true, scope: 'dynamicGuardRuns' });
  assert.equal(result.removed, 1);
  assert.equal(env.state.dynamicGuardRuns[0].id, 'active');
});

test('unchanged old-IP polls do not keep rewriting the database', async () => {
  const env = setup({ waitTimeout: 300 });
  await failAndSubmit(env); await env.tick();
  const writes = env.writes();
  for (let index = 0; index < 10; index++) { env.advance(5); await env.tick(); }
  assert.equal(env.writes(), writes);
  assert.equal(env.calls.length, 1);
});

test('the check cap does not block successful reports and queued checks start after a slot is released', async () => {
  const env = setup({}, { maxChecks: 1 });
  const second = normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'second.example.com', command: 'true', probeIds: ['p1'] }, null, env.state, env.deps.encryptSecret, env.now());
  env.state.dynamicGuards.push(second);
  await env.tick();
  assert.equal(env.state.dynamicGuards.filter((guard) => guard.cycle).length, 1);
  env.report('p1', true); await env.tick();
  assert.equal(env.guard().status, 'healthy');
  env.advance(5); await env.tick();
  assert.ok(env.state.dynamicGuards[1].cycle);
});

test('API concurrency is bounded and failed checks queue without rerunning DNS or writing state repeatedly', async () => {
  let release;
  const env = setup({}, { maxCommands: 1, execute: () => new Promise((resolve) => { release = resolve; }) });
  env.state.dynamicGuards.push(normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'second.example.com', command: 'true', probeIds: ['p1'] }, null, env.state, env.deps.encryptSecret, env.now()));
  await env.tick();
  env.report('p1', false); env.report('p2', false);
  const second = env.state.dynamicGuards[1];
  acceptDynamicReports(env.state, 'p1', [{ targetId: second.cycle.id, checkMarker: second.cycle.id, ok: false, attempts: 9, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3, resolvedAddresses: [second.cycle.address] }]);
  env.service.tick(); await flush();
  assert.equal(env.service.isExecuting(env.guard().id), true);
  assert.equal(env.service.isExecuting(second.id), false);
  env.service.tick(); await flush();
  const writes = env.writes();
  env.service.tick(); await flush();
  assert.equal(env.writes(), writes);
  assert.equal(env.state.dynamicGuards[1].status, 'queued');
  release({ ok: true }); await env.service.drain();
});

test('editing the wait timeout after restart cannot bypass the old command deadline', async () => {
  const env = setup({ waitTimeout: 5 });
  const safeAfter = env.now() + 96000;
  Object.assign(env.guard(), { commandNotBefore: safeAfter, flow: { id: 'old', oldIp: '192.0.2.1', initialIp: '192.0.2.1', startedAt: new Date(env.now()).toISOString(),
    attempts: 1, submittedAt: env.now(), deadlineAt: safeAfter + 5000, commandState: 'executing' } });
  await env.tick();
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, callback) => handlers.set(`${method} ${path}`, callback)]));
  registerDynamicGuardRoutes(app, env.deps, { ...env.service, tick: () => {} });
  handlers.get('put /api/dynamic-guards/:id')({ params: { id: env.guard().id }, body: { ...env.guard(), waitTimeout: 1, command: '' } }, { json() {}, status() { throw Error('save failed'); } });
  assert.equal(env.guard().flow.deadlineAt, safeAfter + 1000);
  env.advance(10); await env.tick();
  assert.equal(env.calls.length, 0);
});

test('late evidence cannot revive a disabled or edited check', async () => {
  const env = setup(); await env.tick();
  const old = env.guard().cycle.id;
  env.guard().enabled = false;
  assert.equal(env.report('p1', true), false);
  env.guard().enabled = true;
  env.state.dynamicGuards[0] = normalizeDynamicGuard({ ...env.guard(), interval: 60 }, env.guard(), env.state, env.deps.encryptSecret, env.now());
  env.service.request(env.guard().id); await env.service.drain();
  assert.notEqual(env.guard().cycle.id, old);
  assert.equal(env.report('p1', true, { targetId: old, checkMarker: old }), false);
});

test('repeated check clicks preserve the current cycle and its accepted evidence', async () => {
  const env = setup(); await env.tick();
  const cycleId = env.guard().cycle.id;
  env.report('p1', false);
  for (let i = 0; i < 20; i++) env.service.request(env.guard().id);
  await env.service.drain();
  assert.equal(env.guard().cycle.id, cycleId);
  assert.equal(env.guard().cycle.observations.p1.ok, false);
  env.report('p2', true); await env.tick();
  assert.equal(env.guard().status, 'healthy');
});

test('a probe going offline during DNS confirmation invalidates automatic submission', async () => {
  let resolving;
  const env = setup(); await env.tick();
  env.report('p1', false); env.report('p2', false);
  const service = createDynamicGuardService(env.deps, { ...env.config, resolveIp: () => new Promise((resolve) => { resolving = resolve; }) });
  service.tick(); await flush();
  env.state.probes[1].status = 'offline';
  resolving('192.0.2.1'); await service.drain();
  assert.equal(env.calls.length, 0);
  assert.equal(env.guard().status, 'waiting_probe');
  assert.equal(env.guard().cycle, null);
});

test('API queues release check slots and expired failures are checked again before submission', async () => {
  let release, executions = 0;
  const env = setup({}, { maxCommands: 1, maxChecks: 2, execute: () => {
    executions++;
    return executions === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ ok: true });
  } });
  const add = (domain) => env.state.dynamicGuards.push(normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain, command: 'true', probeIds: ['p1'] }, null, env.state, env.deps.encryptSecret, env.now()));
  add('second.example.com');
  await env.tick(); env.report('p1', false); env.report('p2', false);
  const second = env.state.dynamicGuards[1];
  acceptDynamicReports(env.state, 'p1', [{ targetId: second.cycle.id, checkMarker: second.cycle.id, ok: false, attempts: 9, rounds: 3, attemptsPerRound: 3, roundsCompleted: 3, resolvedAddresses: [second.cycle.address] }], env.now());
  env.service.tick(); await flush();
  assert.equal(env.state.dynamicGuards[1].cycle, null);
  assert.ok(env.state.dynamicGuards[1].pendingChange);
  add('third.example.com');
  env.service.tick(); await flush();
  assert.ok(env.state.dynamicGuards[2].cycle, 'API queue must not occupy the freed check slot');
  env.advance(31);
  release({ ok: true }); await env.service.drain();
  await env.tick();
  assert.equal(executions, 1, 'old failure evidence must not submit a command');
  assert.ok(env.state.dynamicGuards[1].cycle);
  assert.equal(env.state.dynamicGuards[1].pendingChange, null);
});

test('wait timeout and command error notices do not alternate into repeated notifications', async () => {
  const env = setup({ waitTimeout: 5, maxDaily: 0 }, { execute: async () => ({ ok: false, error: 'timeout' }) });
  await failAndSubmit(env);
  for (let i = 0; i < 5; i++) { env.advance(5); await env.tick(); }
  assert.equal(env.guard().daily.count, 6);
  assert.equal(env.notices.length, 2);
  assert.ok(env.notices.some((notice) => notice.message.includes('仍未出现新 IP')));
});

test('disable during command execution preserves its outcome but prevents subsequent retries', async () => {
  let release;
  const env = setup({}, { execute: () => new Promise((resolve) => { release = resolve; }) });
  await env.tick(); env.report('p1', false); env.report('p2', false);
  env.service.tick(); await flush();
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, callback) => handlers.set(`${method} ${path}`, callback)]));
  registerDynamicGuardRoutes(app, env.deps, env.service);
  env.state.probes = [];
  handlers.get('post /api/dynamic-guards/:id/enabled')({ params: { id: env.guard().id }, body: { enabled: false, domain: 'stale.example.com' } }, { json() {}, status() { throw Error('disable failed'); } });
  assert.equal(env.guard().enabled, false);
  assert.equal(env.guard().domain, 'vps.example.com');
  release({ ok: true }); await env.service.drain();
  assert.equal(env.guard().flow.commandState, 'submitted');
  assert.equal(sanitizeDynamicGuard(env.guard()).status, 'disabled');
  env.advance(1000); await env.tick();
  assert.equal(env.guard().daily.count, 1);
  assert.equal(env.guard().cycle, null);
});

test('restart recovers a disabled interrupted command without resolving DNS or submitting again', async () => {
  const env = setup({}, { resolveIp: async () => { throw Error('disabled task must not resolve'); } });
  Object.assign(env.guard(), { enabled: false, commandNotBefore: env.now() + 96000,
    flow: { id: 'old', executionId: 'interrupted', commandState: 'executing', deadlineAt: env.now() + 396000 } });
  await env.tick();
  assert.equal(env.guard().status, 'disabled');
  assert.equal(env.guard().flow.commandState, 'uncertain');
  assert.equal(env.guard().commandNotBefore, env.now() + 96000);
  assert.equal(env.calls.length, 0);
  const next = normalizeDynamicGuard({ ...env.guard(), interval: 60 }, env.guard(), env.state, env.deps.encryptSecret, env.now());
  assert.equal(next.enabled, false);
});

test('per-task history pages only contain the requested task with bounded page size', () => {
  const env = setup();
  env.state.dynamicGuardRuns = Array.from({ length: 120 }, (_, i) => ({ id: String(i), guardId: i % 2 ? 'other' : env.guard().id }));
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, callback) => handlers.set(`${method} ${path}`, callback)]));
  registerDynamicGuardRoutes(app, env.deps, env.service);
  let result;
  handlers.get('get /api/dynamic-guards/:id/history')({ params: { id: env.guard().id }, query: { page: '2' } }, { json(value) { result = value; } });
  assert.equal(result.total, 60);
  assert.equal(result.records.length, 10);
  assert.equal(result.pages, 2);
  assert.ok(result.records.every((run) => run.guardId === env.guard().id));
});

test('routes enforce confirmation, keep secrets private, and only schedule the changed task', () => {
  const env = setup();
  const handlers = new Map(), scheduled = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, callback) => handlers.set(`${method} ${path}`, callback)]));
  registerDynamicGuardRoutes(app, env.deps, { ...env.service, tick: (id) => scheduled.push(id) });
  let result, status = 200, cache;
  const res = { json(value) { result = value; }, status(value) { status = value; return this; }, set(_name, value) { cache = value; } };
  handlers.get('get /api/dynamic-guards')({}, res);
  assert.equal(JSON.stringify(result).includes('provider.invalid'), false);
  handlers.get('post /api/dynamic-guards/:id/change')({ params: { id: env.guard().id }, body: {} }, res);
  assert.equal(status, 400); assert.equal(env.calls.length, 0);
  handlers.get('get /api/dynamic-guards/:id/command')({ params: { id: env.guard().id } }, res);
  assert.equal(cache, 'no-store'); assert.match(result.command, /curl/);
  handlers.get('put /api/dynamic-guards/:id')({ params: { id: env.guard().id }, body: { ...env.guard(), command: '', name: 'edited' } }, res);
  assert.equal(env.guard().name, 'edited');
  assert.deepEqual(scheduled, [env.guard().id]);
  assert.match(env.guard().commandEnc.cipher, /curl/);
});

test('duplicate domain tasks are rejected and a task can still be disabled after its probe is removed', () => {
  const env = setup();
  assert.throws(() => normalizeDynamicGuard({ ...env.guard(), command: 'true' }, null, env.state, env.deps.encryptSecret), /已有守护任务/);
  env.state.probes = [];
  const disabled = normalizeDynamicGuard({ ...env.guard(), enabled: false }, env.guard(), env.state, env.deps.encryptSecret);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'disabled');
});

test('local command runner bounds output, uses an independent timeout and does not inherit application secrets', async () => {
  let child, args, settings;
  const promise = executeDynamicCommand('printf safe', 30, (program, argv, options) => {
    assert.equal(program, 'timeout'); args = argv; settings = options;
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child;
  });
  child.stdout.write('x'.repeat(20000)); child.emit('close', 0);
  const result = await promise;
  assert.equal(result.ok, true); assert.equal(result.output.length, 8192);
  assert.deepEqual(args.slice(0, 5), ['--signal=TERM', '--kill-after=5', '30s', 'bash', '--noprofile']);
  assert.deepEqual(Object.keys(settings.env).sort(), ['LANG', 'PATH']);
  assert.equal(settings.detached, true);
});

test('existing probe configuration and report routes deliver dynamic checks and wake only their own subsystem', async () => {
  const env = setup(); await env.tick();
  Object.assign(env.state, { ...orchestrationDefaults(), ...env.state });
  env.state.probes[0].agentSecretHash = createHash('sha256').update('test-secret').digest('hex');
  const handlers = new Map();
  const app = { get: (path, handler) => handlers.set(`GET ${path}`, handler), post: (path, handler) => handlers.set(`POST ${path}`, handler) };
  let dynamic = 0, dns = 0, ordinary = 0;
  registerProbePublicRoutes(app, { ...env.deps, readProbeState: () => structuredClone(env.state),
    onDynamicGuardReport: () => dynamic++, onDnsGuardReport: () => dns++, onProbeReport: () => ordinary++ });
  const headers = { 'x-probe-id': 'p1', authorization: 'Bearer test-secret' };
  let result;
  const res = { json(value) { result = value; }, status(code) { throw Error(`unexpected status ${code}`); } };
  handlers.get('GET /probe/config')({ headers, query: {} }, res);
  assert.equal(result.targets.length, 1);
  const check = result.targets[0];
  assert.equal(check.guardId, env.guard().id);
  assert.equal(check.address, '192.0.2.1');
  assert.equal(JSON.stringify(result).includes('provider.invalid'), false);
  handlers.get('POST /probe/report')({ headers, body: { results: [{ targetId: check.id, checkMarker: check.checkNowAt, ok: true, attempts: 1 }] } }, res);
  assert.equal(dynamic, 1); assert.equal(dns, 0); assert.equal(ordinary, 0);
  assert.equal(env.guard().cycle.result, 'healthy');
  await env.tick(); assert.equal(env.guard().status, 'healthy');
});

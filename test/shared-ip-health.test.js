import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createSharedIpHealth, seedDnsGuardHealth, seedDynamicGuardHealth, shareGuardHealthReports } from '../server/shared-ip-health.js';
import { orchestrationDefaults, registerProbePublicRoutes, runDueDnsGuards,
  dnsGuardCheckReady, resolveDnsGuardSources, clearDnsGuardSourceCache, invalidateChangedDnsGuardSource } from '../server/orchestration.js';
import { acceptDynamicReports, createDynamicGuardService } from '../server/dynamic-guard.js';

const config = { interval: 30, checkType: 'ping', port: 443, timeout: 5, checkRounds: 3, attemptsPerRound: 3 };
const ip = '203.0.113.10';
const evidence = (ok, address = ip) => ({ ok, attempts: ok ? 1 : 9, rounds: 3, attemptsPerRound: 3,
  roundsCompleted: ok ? 1 : 3, resolvedAddresses: [address], successfulAddress: ok ? address : '', error: '' });
const guard = (id, probeIds = ['p1', 'p2']) => ({ ...config, id, domain: `${id}.example.com`, enabled: true,
  probeIds, maxParallel: 20, currentValues: [ip], sources: [], cycle: { id: `cycle-${id}`, startedAt: Date.now() - 100,
    phase: 'remote', remoteValues: [ip], expectedProbeIds: [...probeIds], checks: [{ id: `check-${id}`, address: ip, observations: {} }] } });
const rawFor = (item, ok = true, patch = {}) => ({ ...evidence(ok), targetId: item.cycle.checks[0].id, checkMarker: item.cycle.id, ...patch });

function fixture(guards) {
  let state = { ...orchestrationDefaults(), dnsGuards: guards };
  const secret = 'synthetic-probe-secret';
  state.probes = ['p1', 'p2', 'p3'].map((id) => ({ id, enabled: true, status: 'online',
    lastSeenAt: new Date().toISOString(), agentSecretHash: crypto.createHash('sha256').update(secret).digest('hex') }));
  const routes = new Map(), followups = { dns: 0, dynamic: 0 };
  const deps = { sharedIpHealth: createSharedIpHealth(), readState: () => state,
    updateState(mutate) { const draft = structuredClone(state); state = mutate(draft); return state; },
    onDnsGuardReport: () => followups.dns++, onDynamicGuardReport: () => followups.dynamic++ };
  registerProbePublicRoutes({ get: (url, handler) => routes.set(`GET ${url}`, handler), post: (url, handler) => routes.set(`POST ${url}`, handler) }, deps);
  const invoke = (route, probeId, body = {}) => {
    let response;
    routes.get(route)({ headers: { 'x-probe-id': probeId, authorization: `Bearer ${secret}` }, body, query: {} },
      { json: (value) => { response = value; }, status() { return this; } });
    return response;
  };
  return { deps, followups, state: () => state, poll: (probeId = 'p1') => invoke('GET /probe/config', probeId),
    report: (reports, probeId = 'p1') => invoke('POST /probe/report', probeId, { results: reports }) };
}

test('shared evidence expires at producer/consumer intervals and duplicate reports cannot renew it', () => {
  let now = 100000;
  const health = createSharedIpHealth({ now: () => now });
  assert.equal(health.remember(ip, 'p1', config, evidence(true), 'sample', now - 1), true);
  const original = health.lookup(ip, 'p1', config).checkedAt;
  now += 4999;
  assert.equal(health.lookup(ip, 'p1', { ...config, interval: 5 }).checkedAt, original);
  now++;
  assert.equal(health.lookup(ip, 'p1', { ...config, interval: 5 }), null);
  now += 24000;
  assert.equal(health.remember(ip, 'p1', config, evidence(true), 'sample', 99999), false);
  now += 1000;
  assert.equal(health.lookup(ip, 'p1', config), null);
  assert.equal(health.remember(ip, 'p1', config, evidence(false), 'older', 99998), false);
  assert.equal(health.remember(ip, 'p1', { ...config, interval: 5 }, evidence(true), 'fresh', now), true);
  now += 5000;
  assert.equal(health.lookup(ip, 'p1', config), null);
});

test('signatures isolate probes, protocols, ports, rounds, timeouts, private access and IP families', () => {
  const health = createSharedIpHealth();
  health.remember(ip, 'p1', config, evidence(true), 'sample', Date.now() - 1);
  for (const patch of [{ checkType: 'tcp' }, { timeout: 6 }, { checkRounds: 2 }, { attemptsPerRound: 2 }, { allowPrivate: true }]) {
    assert.equal(health.lookup(ip, 'p1', { ...config, ...patch }), null);
  }
  assert.ok(health.lookup(ip, 'p1', { ...config, port: 80 }), 'ping ignores TCP port');
  assert.equal(health.lookup(ip, 'p2', config), null);
  assert.equal(health.lookup('2001:db8::1', 'p1', config), null);
  health.remember('2001:db8::1', 'p1', config, evidence(true, '2001:db8::1'), 'v6', Date.now() - 1);
  assert.ok(health.lookup('2001:db8:0:0:0:0:0:1', 'p1', config));
  const tcp = { ...config, checkType: 'tcp' };
  health.remember(ip, 'p1', tcp, evidence(true), 'tcp', Date.now() - 1);
  assert.equal(health.lookup(ip, 'p1', { ...tcp, port: 80 }), null);
});

test('partial failures, tooling/DNS errors, wrong addresses and stale markers cannot spread', () => {
  for (const patch of [{ attempts: 3 }, { roundsCompleted: 1 }, { resolvedAddresses: [] },
    { resolvedAddresses: ['203.0.113.99'] }, { error: 'Permission denied' }, { error: 'getaddrinfo failed' },
    { error: 'No such file or directory' }, { error: 'cancelled' }, { checkMarker: 'stale' }]) {
    const state = { dnsGuards: [guard('one'), guard('two')], dynamicGuards: [] };
    const health = createSharedIpHealth();
    shareGuardHealthReports(state, 'p1', [rawFor(state.dnsGuards[0], false, patch)], health);
    assert.equal(health.size, 0, JSON.stringify(patch));
    assert.deepEqual(state.dnsGuards[1].cycle.checks[0].observations, {});
  }
});

test('one dispatched check settles compatible DNS/dynamic cycles while ordinary targets stay independent', () => {
  const env = fixture([guard('one'), guard('two'), guard('different', ['p3'])]);
  env.state().dynamicGuards.push({ ...config, id: 'dynamic', enabled: true, domain: 'source.example.com',
    cycle: { id: 'dynamic-cycle', address: ip, probeIds: ['p1', 'p2'], observations: {}, startedAt: Date.now() - 50 } });
  env.state().probeTargets.push({ id: 'ordinary', address: ip, enabled: true, probeIds: ['p1'] });
  const poll = env.poll();
  assert.deepEqual(poll.targets.map((item) => item.id), ['check-one', 'ordinary']);
  env.report([rawFor(env.state().dnsGuards[0])]);
  assert.equal(env.poll().targets.length, 1);
  assert.equal(env.state().dnsGuards[1].cycle.checks[0].observations.p1.shared, true);
  assert.deepEqual(env.state().dnsGuards[2].cycle.checks[0].observations, {});
  assert.equal(env.state().dynamicGuards[0].cycle.result, 'healthy');
  assert.deepEqual(env.followups, { dns: 1, dynamic: 1 });
});

test('different probe sets require every consumer probe to finish all failed rounds', () => {
  const env = fixture([guard('one'), guard('two', ['p1', 'p3'])]);
  env.report([rawFor(env.state().dnsGuards[0], false)]);
  assert.equal(dnsGuardCheckReady(env.state().dnsGuards[1].cycle.checks[0], env.state().dnsGuards[1]), false);
  env.report([rawFor(env.state().dnsGuards[0], false)], 'p2');
  assert.equal(dnsGuardCheckReady(env.state().dnsGuards[0].cycle.checks[0], env.state().dnsGuards[0]), true);
  assert.equal(dnsGuardCheckReady(env.state().dnsGuards[1].cycle.checks[0], env.state().dnsGuards[1]), false);
  env.report([rawFor(env.state().dnsGuards[1], false)], 'p3');
  assert.equal(dnsGuardCheckReady(env.state().dnsGuards[1].cycle.checks[0], env.state().dnsGuards[1]), true);
});

test('removing the elected leader immediately exposes a live follower and orphan reports are ignored', () => {
  const env = fixture([guard('one'), guard('two')]);
  const old = rawFor(env.state().dnsGuards[0]);
  assert.equal(env.poll().targets[0].id, old.targetId);
  env.state().dnsGuards.shift();
  assert.equal(env.poll().targets[0].id, 'check-two');
  env.report([old]);
  assert.equal(env.deps.sharedIpHealth.size, 0);
  assert.deepEqual(env.state().dnsGuards[0].cycle.checks[0].observations, {});
});

test('failed persistence cannot publish shared results into the runtime cache', () => {
  const env = fixture([guard('one'), guard('two')]);
  const raw = rawFor(env.state().dnsGuards[0]);
  env.deps.updateState = (mutate) => { mutate(structuredClone(env.state())); throw new Error('disk full'); };
  assert.throws(() => env.report([raw]), /disk full/);
  assert.equal(env.deps.sharedIpHealth.size, 0);
  assert.deepEqual(env.state().dnsGuards[1].cycle.checks[0].observations, {});
});

test('idle consumers wake only for confirmed failed current IPs or newly healthy referenced sources', () => {
  const producer = guard('producer');
  producer.cycle.sourceCandidates = { home: { primary: [ip] } };
  producer.sources = [{ id: 'home', domain: 'shared.example.com' }];
  const idle = (id, values, sources = []) => ({ ...guard(id), currentValues: values, cycle: null, nextCheckAt: '2099-01-01', sources });
  const state = { dnsGuards: [producer, idle('add', [], producer.sources), idle('healthy', [ip]), idle('unrelated', [])], dynamicGuards: [] };
  const health = createSharedIpHealth();
  assert.deepEqual(shareGuardHealthReports(state, 'p1', [rawFor(producer)], health).wakeIds, ['add']);
  const failures = { dnsGuards: [guard('failed'), idle('remove', [ip])], dynamicGuards: [] };
  const failedHealth = createSharedIpHealth();
  assert.deepEqual(shareGuardHealthReports(failures, 'p1', [rawFor(failures.dnsGuards[0], false)], failedHealth).wakeIds, []);
  assert.deepEqual(shareGuardHealthReports(failures, 'p2', [rawFor(failures.dnsGuards[0], false)], failedHealth).wakeIds, ['remove']);
});

test('pre-command results cannot verify a new dynamic flow and expired shared observations are removed', () => {
  let now = Date.now();
  const health = createSharedIpHealth({ now: () => now });
  health.remember(ip, 'p1', config, evidence(true), 'before-command', now - 100);
  const item = { ...config, flow: { submittedAt: now - 50 }, cycle: { address: ip, probeIds: ['p1'], observations: {} } };
  assert.equal(seedDynamicGuardHealth(item, health, now), false);
  assert.equal(item.cycle.result, undefined);
  const dns = guard('dns');
  seedDnsGuardHealth(dns, dns.cycle, health, now);
  assert.equal(dns.cycle.checks[0].observations.p1.shared, true);
  now += 30000;
  seedDnsGuardHealth(dns, dns.cycle, health, now);
  assert.deepEqual(dns.cycle.checks[0].observations, {});
});

test('direct dynamic reports reject wrong successful addresses and cancelled complete failures', () => {
  for (const patch of [{ ok: true, successfulAddress: '203.0.113.99' },
    { cancelled: true }, { error: 'operation aborted' }]) {
    const item = { ...config, enabled: true, cycle: { id: 'dynamic', address: ip, probeIds: ['p1'], observations: {} } };
    const state = { probes: [{ id: 'p1' }], dynamicGuards: [item] };
    assert.equal(acceptDynamicReports(state, 'p1', [{ ...evidence(false), ...patch,
      targetId: 'dynamic', checkMarker: 'dynamic' }]), false);
    assert.deepEqual(item.cycle.observations, {});
    assert.equal(item.cycle.result, undefined);
  }
});

test('a dynamic service settles a shared healthy cycle immediately without a new probe report', async () => {
  const time = Date.now();
  const health = createSharedIpHealth({ now: () => time });
  health.remember(ip, 'p1', config, evidence(true), 'dns-sample', time - 100);
  let state = { probes: ['p1', 'p2'].map((id) => ({ id, enabled: true, status: 'online', lastSeenAt: new Date(time).toISOString() })),
    dynamicGuards: [{ ...config, id: 'dynamic', revision: 1, domain: 'dynamic.example.com', enabled: true,
      probeIds: ['p1', 'p2'], nextAt: 0, cycle: null }] };
  const service = createDynamicGuardService({ sharedIpHealth: health,
    readState: () => structuredClone(state),
    updateState(mutate) { const draft = structuredClone(state); mutate(draft); state = draft; }
  }, { now: () => time, resolveIp: async () => ip,
    execute: async () => { assert.fail('healthy evidence must never submit a change command'); } });
  service.tick();
  await service.drain();
  assert.equal(state.dynamicGuards[0].status, 'healthy');
  assert.equal(state.dynamicGuards[0].cycle, null);
  assert.equal(state.dynamicGuards[0].nextAt, time + config.interval * 1000);
});

test('recent dynamic evidence adds source IPs and settles DNS cycles without new probe reports', async () => {
  clearDnsGuardSourceCache();
  const env = fixture([guard('one'), guard('two')]);
  env.state().dnsAccounts = [{ id: 'account', provider: 'huawei', enabled: true, credentialsEnc: 'synthetic' }];
  const remote = new Map();
  for (const item of env.state().dnsGuards) {
    Object.assign(item, { accountId: 'account', recordType: 'A', recordLine: '默认', ttl: 60, maxActiveIps: 50,
      cycle: null, currentValues: [], sourceState: {}, sources: [{ id: 'home', domain: 'dynamic.example.com' }] });
    remote.set(item.domain, []);
  }
  const dynamic = { ...config, id: 'dynamic', domain: 'dynamic.example.com', enabled: true,
    cycle: { id: 'dynamic-cycle', address: ip, probeIds: ['p1', 'p2'], observations: {}, startedAt: Date.now() - 10 } };
  env.state().dynamicGuards.push(dynamic);
  env.report([{ ...evidence(true), targetId: dynamic.cycle.id, checkMarker: dynamic.cycle.id }]);
  let lookups = 0;
  Object.assign(env.deps, { decryptSecret: () => '{}', resolveDomainAddresses: async () => { lookups++; return [ip]; },
    resolveDnsBinding: async (_state, _account, _credentials, binding) => ({ zone: { name: 'example.com' }, normalizedBinding: binding }),
    readDnsRecord: async (_account, _credentials, _zone, binding) => ({ values: remote.get(binding.domain), recordIds: [] }),
    writeDnsRecord: async (_account, _credentials, _zone, binding, values) => { remote.set(binding.domain, values); return []; } });
  await runDueDnsGuards(env.deps);
  assert.equal(lookups, 1);
  for (const item of env.state().dnsGuards) { assert.equal(item.cycle, null); assert.deepEqual(remote.get(item.domain), [ip]); }
  assert.equal(env.poll().targets.length, 0);
  // A second cycle must also settle its already-active IP using the same evidence.
  env.state().dnsGuards.forEach((item) => { item.nextCheckAt = ''; });
  await runDueDnsGuards(env.deps);
  assert.ok(env.state().dnsGuards.every((item) => item.cycle === null));
});

test('DDNS changes invalidate only older conflicting source snapshots including local fast paths', async () => {
  clearDnsGuardSourceCache();
  let answer = [ip], calls = 0;
  const resolve = async () => { calls++; return [...answer]; };
  const item = { recordType: 'A', sources: [{ id: 'home', domain: 'dynamic.example.com' }] };
  const original = await resolveDnsGuardSources(item, [], resolve);
  item.sourceState = { home: { ...original.state.home, healthyValues: [ip], pending: false, status: 'synced' } };
  answer = ['203.0.113.11'];
  invalidateChangedDnsGuardSource('dynamic.example.com', 'A', answer[0], Date.now());
  const changed = await resolveDnsGuardSources(item, [ip], resolve);
  assert.equal(calls, 2);
  assert.deepEqual(changed.values, answer);
  invalidateChangedDnsGuardSource('dynamic.example.com', 'A', ip, Date.parse(changed.state.home.resolvedAt.primary) - 1);
  await resolveDnsGuardSources({ ...item, sourceState: {} }, [], resolve);
  assert.equal(calls, 2, 'an older resolution cannot invalidate a newer answer');
});

test('shared cache stays bounded with many IPs and a large compatible target list dispatches once', () => {
  const health = createSharedIpHealth({ limit: 100 });
  for (let index = 1; index <= 1000; index++) {
    const address = `2001:db8::${index.toString(16)}`;
    health.remember(address, 'p1', config, evidence(true, address), `sample-${index}`, Date.now() - 1);
  }
  assert.equal(health.size, 100);
  const targets = Array.from({ length: 1000 }, (_, index) => ({ ...config, id: `check-${index}`, guardId: `guard-${index}`, address: ip }));
  assert.equal(health.deduplicate(targets, 'p1').length, 1);
});

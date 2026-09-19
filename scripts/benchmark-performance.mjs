// Synthetic, offline benchmark: no app startup, database, credentials or DNS I/O.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { orchestrationDefaults, collectDnsGuardPoolCandidates } from '../server/orchestration.js';
import { commandJobDelta } from '../shared/command-output.js';

const state = {
  ...orchestrationDefaults(),
  probes: Array.from({ length: 10 }, (_, id) => ({ id: `probe-${id}`, status: 'online', lastSeenAt: new Date().toISOString() })),
  dnsGuards: Array.from({ length: 100 }, (_, id) => ({ id: `guard-${id}`, currentValues: ['192.0.2.1', '192.0.2.2'], probeIds: ['probe-0', 'probe-1'] })),
  ipAssets: Array.from({ length: 10000 }, (_, id) => ({ id: `asset-${id}`, address: `198.18.${Math.floor(id / 256)}.${id % 256}`, enabled: true })),
  ipUsageRecords: Array.from({ length: 5000 }, (_, id) => ({ id, message: `${id}:` + 'history '.repeat(128) })),
  auditLogs: Array.from({ length: 5000 }, (_, id) => ({ id, summary: 'audit '.repeat(100) }))
};
state.ipPools = [{ id: 'pool', assetIds: state.ipAssets.map((item) => item.id) }];
const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const start = source.indexOf('function readState(');
const end = source.indexOf('\nfunction ', start + 1);
const context = vm.createContext({ cachedState: state, ensureStorage() {}, structuredClone });
vm.runInContext(source.slice(start, end), context);

function measure(fn, iterations = 20) {
  for (let i = 0; i < 3; i++) fn();
  global.gc?.();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = (performance.now() - started) / iterations;
  const usage = process.cpuUsage(cpu);
  return { mean_ms: +elapsed.toFixed(3), cpu_ms: +((usage.user + usage.system) / 1000 / iterations).toFixed(3) };
}

const guard = { poolIds: ['pool'], recordType: 'A' };
// Previous ordered-pool lookup: a linear asset scan for each configured ID.
function previousPoolLookup() {
  const result = [];
  for (const poolId of guard.poolIds) {
    const pool = state.ipPools.find((item) => item.id === poolId);
    const assets = pool.assetIds.map((id) => state.ipAssets.find((item) => item.id === id))
      .filter((item) => item.enabled !== false && item.health !== 'unhealthy');
    for (const asset of assets) if (result.length < 50) result.push({ assetId: asset.id, poolId, address: asset.address });
  }
  return result;
}
assert.deepEqual(collectDnsGuardPoolCandidates(state, guard), previousPoolLookup());

const job = { results: Array.from({ length: 100 }, (_, id) => ({
  serverId: String(id), status: 'running', stdout: `${id}:` + 'log '.repeat(25000), stderr: ''
})) };
const cursor = commandJobDelta(job, -1, true).revision;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const output = {
  fixture: { guards: 100, probes: 10, assets: 10000, historicalRecords: 10000, commandServers: 100 },
  stateRead: {
    before: measure(() => context.readState()),
    after: measure(() => context.readState(['dnsGuards', 'probes'])),
    beforeBytes: bytes(context.readState()), afterBytes: bytes(context.readState(['dnsGuards', 'probes']))
  },
  poolLookup: { before: measure(previousPoolLookup, 5), after: measure(() => collectDnsGuardPoolCandidates(state, guard), 5) },
  unchangedAutomationPoll: {
    before: measure(() => JSON.stringify({ results: job.results })),
    after: measure(() => JSON.stringify(commandJobDelta(job, cursor, true))),
    beforeBytes: bytes({ results: job.results }), afterBytes: bytes(commandJobDelta(job, cursor, true))
  }
};
console.log(JSON.stringify(output, null, 2));

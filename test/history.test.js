import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { HISTORY_RETENTION_DAYS, HISTORY_KEYS, HISTORY_STATE_KEYS, pruneHistory } from '../server/history.js';

const now = Date.parse('2026-09-20T12:00:00Z');
const date = (days) => new Date(now - days * 86400000).toISOString();
const fixture = () => Object.fromEntries(HISTORY_KEYS.map((key) => [key, [
  { id: `${key}-old`, status: 'done', createdAt: date(8) },
  { id: `${key}-recent`, status: 'done', createdAt: date(6) }
]]));

test('all six history types expire at seven days while configurations and inventory stay intact', () => {
  const state = fixture();
  state.servers = [{ id: 'server' }];
  state.dnsGuards = [{ cycle: { id: 'live' }, currentValues: ['192.0.2.1'] }];
  state.ipAssets = [{ id: 'asset' }];
  state.ipLeases = [{ id: 'lease' }];
  state.workspaces = { user: { sessions: ['terminal'] } };
  const original = structuredClone(state);
  const result = pruneHistory(state, { now });
  assert.equal(result.removed, 6);
  assert.equal(result.kept, 6);
  for (const key of HISTORY_KEYS) assert.deepEqual(state[key].map((item) => item.id), [`${key}-recent`]);
  for (const key of ['servers', 'dnsGuards', 'ipAssets', 'ipLeases', 'workspaces']) assert.deepEqual(state[key], original[key]);
  assert.equal(pruneHistory(state, { now }).changed, false);
});

test('completion and rollback timestamps take precedence over an old start', () => {
  const state = { automationRuns: [{ id: 'run', status: 'done', startedAt: date(20), finishedAt: date(1) }],
    dnsChanges: [{ id: 'change', status: 'rolled_back', createdAt: date(20), rolledBackAt: date(2) }],
    auditLogs: [{ id: 'boundary', createdAt: date(7) }, { id: 'newer', createdAt: new Date(now - 7 * 86400000 + 1).toISOString() }] };
  assert.equal(pruneHistory(state, { now }).removed, 1);
  assert.equal(state.automationRuns.length, 1);
  assert.equal(state.dnsChanges.length, 1);
  assert.deepEqual(state.auditLogs.map((item) => item.id), ['newer']);
});

test('legacy undated records receive one retention window instead of living forever', () => {
  const state = { auditLogs: [{ id: 'legacy', createdAt: 'invalid' }] };
  assert.equal(pruneHistory(state, { now }).changed, true);
  assert.equal(state.auditLogs[0].retentionStartedAt, new Date(now).toISOString());
  assert.equal(pruneHistory(state, { now: now + 86400000 }).changed, false);
  assert.equal(pruneHistory(state, { now: now + 7 * 86400000 }).removed, 1);
});

test('manual clear preserves active incidents, job histories, usage and the entire rollback chain', () => {
  const state = fixture();
  state.incidents.push({ id: 'active', status: 'stabilizing', startedAt: date(20), dnsChangeIds: ['linked-change'], automationJobId: 'linked-run' });
  state.automationRuns.push({ id: 'linked-run', status: 'done', finishedAt: date(20) }, { id: 'live-run', status: 'running', startedAt: date(20) });
  state.dnsChanges.push({ id: 'linked-change', status: 'applied', createdAt: date(20) }, { id: 'other-change', incidentId: 'active', status: 'applied', createdAt: date(20) });
  state.ipUsageRecords.push({ id: 'usage', incidentId: 'active', status: 'consumed', finishedAt: date(20) });
  const result = pruneHistory(state, { all: true, now });
  assert.equal(result.removed, 12);
  assert.deepEqual(state.incidents.map((item) => item.id), ['active']);
  assert.deepEqual(state.automationRuns.map((item) => item.id), ['linked-run', 'live-run']);
  assert.equal(state.dnsChanges.length, 2);
  assert.equal(state.ipUsageRecords.length, 1);
  assert.equal(state.auditLogs.length, 0);
});

test('failed partial DNS writes and live IP locks stay recoverable during cleanup', () => {
  const state = { incidents: [
    { id: 'failed', status: 'failed', finishedAt: date(20), dnsChangeIds: ['change'] },
    { id: 'locked', status: 'failed', finishedAt: date(20) },
    { id: 'idle', status: 'failed', finishedAt: date(20) }
  ], dnsChanges: [
    { id: 'change', incidentId: 'failed', status: 'applied', createdAt: date(20) },
    { id: 'recovery', status: 'recovery_pending', createdAt: date(20) }
  ], ipLeases: [{ id: 'lease', incidentId: 'locked', status: 'locked', expiresAt: date(-1) }],
  ipUsageRecords: [{ id: 'usage', leaseId: 'lease', status: 'failed', finishedAt: date(20) }] };
  pruneHistory(state, { all: true, now });
  assert.deepEqual(state.incidents.map((item) => item.id), ['failed', 'locked']);
  assert.equal(state.dnsChanges.length, 2);
  assert.equal(state.ipLeases.length, 1);
  assert.equal(state.ipUsageRecords.length, 1);
});

test('recent completed incidents retain older related records until their rollback window expires', () => {
  const state = { incidents: [{ id: 'incident', status: 'succeeded', finishedAt: date(1), dnsChangeIds: ['change'] }],
    dnsChanges: [{ id: 'change', incidentId: 'incident', status: 'applied', createdAt: date(8) }],
    ipUsageRecords: [{ incidentId: 'incident', status: 'consumed', finishedAt: date(8) }] };
  assert.equal(pruneHistory(state, { now }).removed, 0);
  assert.equal(pruneHistory(state, { now: now + 7 * 86400000 }).removed, 3);
});

test('waiting and paused tasks survive age and manual cleanup', () => {
  const state = { incidents: ['waiting_for_ip', 'queued', 'observing', 'pending_approval'].map((status) => ({ id: status, status, startedAt: date(30) })),
    automationRuns: [{ id: 'paused', status: 'paused', startedAt: date(30) }, { id: 'live', status: 'done', finishedAt: date(30) }] };
  assert.equal(pruneHistory(state, { all: true, now, activeJobIds: new Set(['live']) }).removed, 0);
});

test('each category can be cleared independently without changing any other history', () => {
  for (const scope of HISTORY_KEYS) {
    const state = fixture();
    for (const key of HISTORY_KEYS) state[key].push({ id: `${key}-undated`, status: 'done' });
    const original = structuredClone(state);
    const result = pruneHistory(state, { all: true, scope, now });
    assert.deepEqual(result.counts, { [scope]: 3 });
    assert.equal(result.removed, 3);
    assert.equal(result.kept, 0);
    assert.deepEqual(state[scope], []);
    for (const key of HISTORY_KEYS.filter((key) => key !== scope)) assert.deepEqual(state[key], original[key]);
  }
});

test('scoped age cleanup does not stamp undated records in other categories', () => {
  const state = { incidents: [{ id: 'undated', status: 'succeeded' }], auditLogs: [{ id: 'old', createdAt: date(8) }] };
  pruneHistory(state, { scope: 'auditLogs', now });
  assert.deepEqual(state.incidents, [{ id: 'undated', status: 'succeeded' }]);
  assert.deepEqual(state.auditLogs, []);
});

test('single-category cleanup preserves completed incidents and their rollback dependencies', () => {
  const original = { incidents: [{ id: 'completed', status: 'succeeded', finishedAt: date(20), dnsChangeIds: ['change'], automationJobId: 'job' }],
    dnsChanges: [{ id: 'change', status: 'applied' }, { id: 'related', incidentId: 'completed' }, { id: 'unrelated' }],
    automationRuns: [{ id: 'job', status: 'done' }, { id: 'unrelated', status: 'done' }],
    ipUsageRecords: [{ id: 'usage', incidentId: 'completed', status: 'consumed' }, { id: 'unrelated', status: 'consumed' }] };
  for (const scope of ['dnsChanges', 'automationRuns', 'ipUsageRecords']) {
    const state = structuredClone(original);
    const result = pruneHistory(state, { scope, all: true, now });
    assert.equal(result.removed, 1);
    assert.deepEqual(state[scope], original[scope].filter((item) => item.id !== 'unrelated'));
    for (const key of Object.keys(original).filter((key) => key !== scope)) assert.deepEqual(state[key], original[key]);
  }
});

test('invalid cleanup scope is rejected before any mutation', () => {
  for (const scope of ['', null, [], {}, 'typo', '__proto__']) {
    const state = fixture();
    const original = structuredClone(state);
    assert.throws(() => pruneHistory(state, { scope, all: true, now }), /未知历史记录类别/);
    assert.deepEqual(state, original);
  }
});

const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
test('hourly cleanup skips database writes when no history changed and tolerates persistence failure', () => {
  const start = source.indexOf('function cleanupHistoryRecords(');
  const end = source.indexOf('\nfunction ', start + 1);
  let state = { auditLogs: [{ createdAt: new Date().toISOString() }] };
  let writes = 0;
  let errors = 0;
  const context = vm.createContext({ HISTORY_STATE_KEYS, pruneHistory, commandJobs: new Map(),
    readState: () => structuredClone(state), updateState: (mutate) => { writes++; mutate(state); }, console: { error() { errors++; } } });
  vm.runInContext(source.slice(start, end), context);
  context.cleanupHistoryRecords();
  assert.equal(writes, 0);
  state = { auditLogs: [{ createdAt: '2000-01-01' }] };
  context.cleanupHistoryRecords();
  assert.equal(writes, 1);
  assert.equal(state.auditLogs.length, 0);
  state = { auditLogs: [{ createdAt: '2000-01-01' }] };
  context.updateState = () => { throw new Error('disk full'); };
  assert.equal(context.cleanupHistoryRecords(), null);
  assert.equal(errors, 1);
  assert.equal(state.auditLogs.length, 1);
});

test('clear-history route requires explicit confirmation and returns sanitized refreshed state', () => {
  const start = source.indexOf("app.delete('/api/history'");
  const end = source.indexOf('\nregisterOrchestrationRoutes', start);
  let handler;
  let state = fixture();
  let writes = 0;
  vm.runInNewContext(source.slice(start, end), { app: { delete(_path, callback) { handler = callback; } },
    commandJobs: new Map(), pruneHistory, HISTORY_RETENTION_DAYS, HISTORY_KEYS,
    updateState(mutate) { writes++; return mutate(state); }, sanitizeStateForClient: () => ({ sanitized: true }) });
  let status = 200;
  let result;
  const response = { status(code) { status = code; return this; }, json(value) { result = value; } };
  handler({ body: {}, auth: { username: 'test' } }, response);
  assert.equal(status, 400);
  assert.equal(writes, 0);
  handler({ body: { confirm: 'clear-history', scope: 'unknown' }, auth: { username: 'test' } }, response);
  assert.equal(status, 400);
  assert.equal(writes, 0);
  handler({ body: { confirm: 'clear-history', scope: 'auditLogs' }, auth: { username: 'test' } }, response);
  assert.equal(result.removed, 2);
  assert.deepEqual(state.auditLogs, []);
  assert.equal(state.dnsChanges.length, 2);
  assert.equal(writes, 1);
  handler({ body: { confirm: 'clear-history' }, auth: { username: 'test' } }, response);
  assert.equal(result.removed, 10);
  assert.equal(result.kept, 0);
  assert.equal(result.retentionDays, 7);
  assert.equal(result.state.sanitized, true);
  assert.equal(writes, 2);
});

test('history reader loads only the selected category, paginates and clamps stale page numbers', () => {
  const start = source.indexOf("app.get('/api/history/:scope'");
  const end = source.indexOf("app.delete('/api/history'", start);
  let handler;
  let reads = 0;
  const records = Array.from({ length: 115 }, (_, index) => ({ id: String(index) }));
  vm.runInNewContext(source.slice(start, end), { app: { get(_path, callback) { handler = callback; } }, HISTORY_KEYS,
    readState(keys) { reads++; assert.deepEqual(Array.from(keys), ['dnsGuardRuns']); return { dnsGuardRuns: records }; },
    sanitizeOrchestrationState: (state) => state });
  let status = 200;
  let result;
  const response = { status(code) { status = code; return this; }, json(value) { result = value; } };
  handler({ params: { scope: 'dnsGuardRuns' }, query: { page: '2' } }, response);
  assert.equal(result.total, 115);
  assert.equal(result.records.length, 50);
  assert.equal(result.records[0].id, '50');
  handler({ params: { scope: 'dnsGuardRuns' }, query: { page: '999' } }, response);
  assert.equal(result.page, 3);
  assert.equal(result.records.length, 15);
  handler({ params: { scope: 'dnsGuardRuns' }, query: { page: 'bad' } }, response);
  assert.equal(result.page, 1);
  handler({ params: { scope: 'dnsAccounts' }, query: {} }, response);
  assert.equal(status, 400);
  assert.equal(reads, 3);
});

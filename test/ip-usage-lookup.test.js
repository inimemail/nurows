import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupIpUsage, parseIpUsageInput, IP_USAGE_KEYS } from '../server/ip-usage-lookup.js';
import { registerOrchestrationRoutes, orchestrationDefaults } from '../server/orchestration.js';

test('shared IPs list all domains, including disabled guards; sources and history are not active use', () => {
  const state = { dnsGuards: [
    { id: 'a', name: 'A', domain: 'a.example.com', currentValues: ['192.0.2.1'], sourceState: { primary: ['192.0.2.2'] } },
    { id: 'b', name: 'B', domain: 'b.example.com', enabled: false, currentValues: ['192.0.2.1'] }
  ], ipUsageRecords: [{ address: '192.0.2.2', status: 'consumed' }] };
  const before = structuredClone(state);
  const result = lookupIpUsage(state, '192.0.2.1\n192.0.2.2');
  assert.equal(result.results[0].status, 'used');
  assert.deepEqual(result.results[0].references.map(ref => ref.domain), ['a.example.com', 'b.example.com']);
  assert.equal(result.results[0].references[1].enabled, false);
  assert.equal(result.results[1].status, 'unused');
  assert.deepEqual(state, before);
});

test('IPv6 canonicalization deduplicates equivalent inputs and matches expanded stored addresses', () => {
  const result = lookupIpUsage({ dnsGuards: [{ id: 'a', currentValues: ['2001:0DB8:0000:0000:0000:0000:0000:0001'] }] },
    '2001:db8::1\n2001:0db8:0:0:0:0:0:1,192.0.2.1;192.0.2.1 invalid invalid');
  assert.deepEqual(result.results.map(item => [item.address, item.status]), [['2001:db8::1', 'used'], ['192.0.2.1', 'unused'], ['invalid', 'invalid']]);
  assert.deepEqual(result.summary, { total: 3, used: 1, reserved: 0, unused: 1, invalid: 1, duplicates: 3 });
});

test('every DNS cycle occupancy is protected, including candidate IDs and returning assets', () => {
  const state = { ipAssets: Array.from({ length: 6 }, (_, i) => ({ id: `ip${i}`, address: `192.0.2.${i + 1}` })), dnsGuards: [{ id: 'a', cycle: {
    remoteValues: ['192.0.2.1'], candidateAssets: [{ assetId: 'ip1' }], rebalanceCommit: {
      desired: ['192.0.2.3'], usedAssets: [{ address: '192.0.2.4' }], returnedAssets: [{ assetId: 'ip4' }]
    }
  } }] };
  const result = lookupIpUsage(state, state.ipAssets.map(item => item.address).join('\n'));
  assert.deepEqual(result.results.map(item => item.status), ['used', 'reserved', 'reserved', 'reserved', 'reserved', 'unused']);
});

test('current DNS binding takes priority over reservations, and pools never imply active use', () => {
  const state = { dnsBindings: [{ id: 'binding', domain: 'dns.example.com', currentValues: ['192.0.2.1'], managedValues: ['192.0.2.1', '192.0.2.2'], backupIps: ['192.0.2.3'] }],
    ipAssets: [{ id: 'asset', address: '192.0.2.4' }], ipPools: [{ id: 'pool', name: '池一', assetIds: ['asset', 'missing'] }, { id: 'pool2', name: '池二', enabled: false, assetIds: ['asset'] }] };
  const result = lookupIpUsage(state, '192.0.2.1 192.0.2.2 192.0.2.3 192.0.2.4');
  assert.deepEqual(result.results.map(item => item.status), ['used', 'reserved', 'reserved', 'unused']);
  assert.equal(result.results[0].references.length, 1);
  assert.equal(result.results[0].references[0].kind, 'used');
  assert.deepEqual(result.results[3].pools.map(pool => pool.name), ['池一', '池二']);
});

test('one domain appears once per IP even when current, candidate, and pending values overlap', () => {
  const result = lookupIpUsage({ dnsGuards: [
    { id: 'a', domain: 'a.example.com', currentValues: ['192.0.2.1'], cycle: { remoteValues: ['192.0.2.1'], candidateAssets: [{ address: '192.0.2.1' }], rebalanceCommit: { desired: ['192.0.2.1'] } } },
    { id: 'b', domain: 'b.example.com', cycle: { candidateAssets: [{ address: '192.0.2.1' }] } }
  ] }, '192.0.2.1');
  assert.equal(result.results[0].status, 'used');
  assert.deepEqual(result.results[0].references.map(ref => [ref.domain, ref.kind]), [['a.example.com', 'used'], ['b.example.com', 'reserved']]);
});

test('expired inactive leases and released leases are ignored; running and indefinite locks stay reserved', () => {
  const state = { ipAssets: Array.from({ length: 5 }, (_, i) => ({ id: `ip${i}`, address: `192.0.2.${i + 1}` })),
    incidents: [{ id: 'running', status: 'automating', allocatedIps: ['192.0.2.5'] }], ipLeases: [
      { assetId: 'ip0', status: 'locked', expiresAt: '2000-01-01' },
      { assetId: 'ip1', status: 'active' },
      { assetId: 'ip2', status: 'released' },
      { assetId: 'ip3', status: 'locked', incidentId: 'running', expiresAt: '2000-01-01' }
    ] };
  const result = lookupIpUsage(state, state.ipAssets.map(item => item.address).join('\n'));
  assert.deepEqual(result.results.map(item => item.status), ['unused', 'reserved', 'unused', 'reserved', 'reserved']);
});

test('conservative protection fallback also compares canonical IPv6 and asset IDs', () => {
  const result = lookupIpUsage({ ipAssets: [{ id: 'asset', address: '192.0.2.1' }] }, '2001:db8::1 192.0.2.1',
    { ids: new Set(['asset']), addresses: new Set(['2001:0db8:0:0:0:0:0:1']) });
  assert.deepEqual(result.results.map(item => item.status), ['reserved', 'reserved']);
});

test('input is bounded and invalid entries are reported without blocking valid IPs', () => {
  for (const value of ['', '  ', null, [], {}]) assert.throws(() => parseIpUsageInput(value), /请输入|请粘贴|请至少/);
  assert.throws(() => parseIpUsageInput('a'.repeat(524289)), /过长/);
  assert.throws(() => parseIpUsageInput(Array.from({ length: 5001 }, (_, i) => `2001:db8::${(i + 1).toString(16)}`).join('\n')), /最多查询 5000/);
  const result = lookupIpUsage({}, '192.0.2.1\n999.1.1.1\n<script>alert(1)</script>\n192.0.2.0/24');
  assert.equal(result.summary.invalid, 3);
  assert.equal(result.summary.unused, 1);
});

test('route reads one selective snapshot, never writes or starts jobs, and rejects oversize input before reads', () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  let reads = 0;
  registerOrchestrationRoutes(app, { readState(keys) { reads++; assert.deepEqual(keys, IP_USAGE_KEYS); return { ...orchestrationDefaults(), dnsGuards: [{ id: 'a', currentValues: ['192.0.2.1'], secret: 'hidden' }] }; }, updateState() { assert.fail('query must never write'); } });
  const query = addresses => {
    let body, status = 200;
    const headers = {};
    routes.get('post /api/dns-guards/ip-usage')({ body: { addresses } }, { set(key, value) { headers[key] = value; }, status(value) { status = value; return this; }, json(value) { body = value; } });
    return { body, status, headers };
  };
  const result = query('192.0.2.1');
  assert.equal(reads, 1);
  assert.equal(result.body.results[0].status, 'used');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.stringify(result.body).includes('hidden'), false);
  assert.equal(query(null).status, 400);
  assert.equal(query('x'.repeat(524289)).status, 400);
  assert.equal(reads, 1);
});

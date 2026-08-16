import assert from 'node:assert/strict';
import test from 'node:test';
import { addIpsToPool, createDnsBinding, createPoolWithIps, dnsBindingDesiredValues, dnsRecordLayout, normalizeRecordName, setDnsBindingIps, withRecordName } from '../server/orchestration.js';

test('derives the root record from a complete domain', () => {
  assert.equal(withRecordName({ domain: 'example.com' }, 'example.com').recordName, '@');
});

test('derives a multi-level host record from a complete domain', () => {
  assert.equal(withRecordName({ domain: 'a.b.example.com' }, 'example.com').recordName, 'a.b');
});

test('uses one multi-value recordset only for Huawei DNS', () => {
  assert.equal(dnsRecordLayout('huawei'), 'recordset');
  assert.equal(dnsRecordLayout('cloudflare'), 'individual');
  assert.equal(dnsRecordLayout('aliyun'), 'individual');
  assert.equal(dnsRecordLayout('tencent'), 'individual');
});

test('normalizes provider host labels without treating them as full domains', () => {
  assert.equal(normalizeRecordName('@', 'example.com'), '@');
  assert.equal(normalizeRecordName('www', 'example.com'), 'www');
  assert.equal(normalizeRecordName('www.example.com.', 'example.com'), 'www');
  assert.notEqual(normalizeRecordName('www2', 'example.com'), 'www');
});

test('adds imported IP assets to an existing pool without duplicates', () => {
  const state = { ipAssets: [{ id: 'ip-1', address: '1.1.1.1' }], ipPools: [{ id: 'pool-1', name: '备用池', assetIds: ['ip-1'] }], auditLogs: [] };
  const result = addIpsToPool(state, 'pool-1', ['1.1.1.1', '2.2.2.2'], 'tester');
  assert.equal(result.created, 1);
  assert.equal(result.pool.assetIds.length, 2);
});

test('creates a pool and validates DNS address families', () => {
  const state = { ipAssets: [], ipPools: [], dnsBindings: [{ id: 'dns-1', recordType: 'A', backupIps: [] }], auditLogs: [] };
  const result = createPoolWithIps(state, '新池', ['3.3.3.3'], 'tester');
  assert.equal(result.pool.assetIds.length, 1);
  setDnsBindingIps(state, 'dns-1', ['4.4.4.4'], 'append', 'tester');
  assert.deepEqual(state.dnsBindings[0].backupIps, ['4.4.4.4']);
  assert.throws(() => setDnsBindingIps(state, 'dns-1', ['2001:db8::1']), /IPv4/);
});

test('creates non-address DNS records and limits CNAME to one target', () => {
  const state = { dnsAccounts: [{ id: 'account-1', enabled: true }], dnsBindings: [], auditLogs: [] };
  const txt = createDnsBinding(state, 'account-1', 'txt.example.com', 'TXT', ['value,with,commas', 'second'], 'tester');
  const cname = createDnsBinding(state, 'account-1', 'www.example.com', 'CNAME', ['target.example.com', 'ignored.example.com'], 'tester');
  assert.deepEqual(txt.recordValues, ['value,with,commas', 'second']);
  assert.deepEqual(cname.recordValues, ['target.example.com']);
});

test('applies DNS editor values according to the selected remote update mode', () => {
  const base = { recordType: 'A', managedValues: ['2.2.2.2'] };
  assert.deepEqual(dnsBindingDesiredValues({ ...base, updateMode: 'append' }, ['1.1.1.1'], ['2.2.2.2']), ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(dnsBindingDesiredValues({ ...base, updateMode: 'managed_replace' }, ['1.1.1.1', '2.2.2.2'], ['3.3.3.3']), ['1.1.1.1', '3.3.3.3']);
  assert.deepEqual(dnsBindingDesiredValues({ ...base, updateMode: 'replace' }, ['1.1.1.1'], ['4.4.4.4']), ['4.4.4.4']);
  assert.deepEqual(dnsBindingDesiredValues({ recordType: 'TXT' }, ['old'], ['new']), ['new']);
});

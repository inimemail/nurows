import assert from 'node:assert/strict';
import test from 'node:test';
import { importIpAssets, parseIpBatch } from '../server/orchestration.js';

test('parses IPv4 and IPv6 batches and removes duplicates', () => {
  assert.deepEqual(parseIpBatch('1.1.1.1\n2001:db8::1, 1.1.1.1'), ['1.1.1.1', '2001:db8::1']);
});

test('rejects the whole batch when one IP is invalid', () => {
  assert.throws(() => parseIpBatch('1.1.1.1\n999.1.1.1'), /999\.1\.1\.1/);
});

test('reuses existing assets and creates missing assets', () => {
  const state = {
    ipAssets: [{ id: 'existing', address: '1.1.1.1', name: 'existing' }],
    auditLogs: []
  };
  const result = importIpAssets(state, ['1.1.1.1', '2.2.2.2'], { region: '上海', carrier: '电信' }, 'tester');
  assert.equal(result.created, 1);
  assert.equal(result.reused, 1);
  assert.deepEqual(result.assetIds[0], 'existing');
  assert.equal(state.ipAssets[1].address, '2.2.2.2');
  assert.equal(state.ipAssets[1].region, '上海');
});

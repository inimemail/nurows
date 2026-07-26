import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExactPerServerInputs,
  parsePerServerInputLines
} from '../shared/command-input.js';

test('parses one input line per server', () => {
  assert.deepEqual(parsePerServerInputLines('yes\nno', 2), ['yes', 'no']);
  assert.deepEqual(parsePerServerInputLines('yes\r\nno', 2), ['yes', 'no']);
});

test('allows a trailing newline without creating an extra input', () => {
  assert.deepEqual(parsePerServerInputLines('yes\nno\n', 2), ['yes', 'no']);
});

test('preserves blank lines as enter inputs', () => {
  assert.deepEqual(parsePerServerInputLines('yes\n', 2), ['yes', '']);
  assert.deepEqual(parsePerServerInputLines('\n\n', 3), ['', '', '']);
});

test('detects missing and extra input lines', () => {
  assert.equal(parsePerServerInputLines('yes', 2).length, 1);
  assert.equal(parsePerServerInputLines('yes\nno\nmaybe', 2).length, 3);
});

test('accepts an exact per-server input mapping', () => {
  assert.equal(
    hasExactPerServerInputs(
      [
        { serverId: 'server-b', data: 'no' },
        { serverId: 'server-a', data: 'yes' }
      ],
      ['server-a', 'server-b']
    ),
    true
  );
});

test('rejects incomplete, duplicate, unknown, and invalid mappings', () => {
  const expectedServerIds = ['server-a', 'server-b'];
  assert.equal(hasExactPerServerInputs([{ serverId: 'server-a', data: 'yes' }], expectedServerIds), false);
  assert.equal(
    hasExactPerServerInputs(
      [
        { serverId: 'server-a', data: 'yes' },
        { serverId: 'server-a', data: 'no' }
      ],
      expectedServerIds
    ),
    false
  );
  assert.equal(
    hasExactPerServerInputs(
      [
        { serverId: 'server-a', data: 'yes' },
        { serverId: 'server-c', data: 'no' }
      ],
      expectedServerIds
    ),
    false
  );
  assert.equal(
    hasExactPerServerInputs(
      [
        { serverId: 'server-a', data: 'yes' },
        { serverId: 'server-b', data: null }
      ],
      expectedServerIds
    ),
    false
  );
});

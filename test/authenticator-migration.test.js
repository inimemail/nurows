import test from 'node:test';
import assert from 'node:assert/strict';
import { Secret } from 'otpauth';
import { parseAuthenticatorImport, addAuthenticatorImport } from '../shared/authenticator-migration.js';
import { otpCode } from '../shared/authenticator.js';

const varint = input => { let n = BigInt(input); const out = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
const number = (key, value) => Buffer.concat([varint(key * 8), varint(value)]);
const bytes = (key, value) => { const data = Buffer.from(value); return Buffer.concat([varint(key * 8 + 2), varint(data.length), data]); };
const parameter = ({ secret = '12345678901234567890', name = 'Example:alice', issuer = 'Example', algorithm = 1, digits = 1, type = 2 } = {}) => bytes(1, Buffer.concat([bytes(1, secret), bytes(2, name), bytes(3, issuer), ...(algorithm === null ? [] : [number(4, algorithm)]), ...(digits === null ? [] : [number(5, digits)]), ...(type === null ? [] : [number(6, type)])]));
const uri = (entries = [parameter()], { size = 1, index = 0, id = 42, version = 1, suffix = Buffer.alloc(0) } = {}) => `otpauth-migration://offline?data=${encodeURIComponent(Buffer.concat([...entries, ...(version === null ? [] : [number(2, version)]), ...(size === null ? [] : [number(3, size)]), ...(index === null ? [] : [number(4, index)]), ...(id === null ? [] : [number(5, id)]), suffix]).toString('base64'))}`;

test('Google export QR decodes many accounts and preserves RFC TOTP parameters', () => {
  const parsed = parseAuthenticatorImport(uri([parameter(), parameter({ secret: '12345678901234567890123456789012', name: 'bob', issuer: 'Cloud', algorithm: 2, digits: 2 })]));
  assert.deepEqual(parsed.batch, { id: '42', size: 1, index: 0 });
  assert.equal(parsed.accounts.length, 2); assert.equal(parsed.accounts[0].account, 'alice');
  assert.equal(otpCode({ ...parsed.accounts[0], digits: 8 }, 59000), '94287082');
  assert.equal(otpCode(parsed.accounts[1], 59000), '46119246');
  assert.equal(parsed.accounts[1].algorithm, 'SHA256'); assert.equal(parsed.accounts[1].digits, 8);
});

test('split Google batches accept out-of-order frames, skip rescans and reject mixed batches', () => {
  const first = parseAuthenticatorImport(uri([parameter()], { size: 2, index: 1 }));
  let state = addAuthenticatorImport(null, first);
  assert.equal(addAuthenticatorImport(state, first), state);
  state = addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter({ secret: 'another-secret-value!', name: 'bob' })], { size: 2, index: 0 })));
  assert.equal(state.frames.length, 2); assert.equal(state.accounts.length, 2);
  assert.throws(() => addAuthenticatorImport(state, parseAuthenticatorImport(uri([], { size: 3 }))), /格式无效/);
  assert.throws(() => addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter()], { size: 2, id: 43 }))), /当前批次/);
});

test('unsupported HOTP and MD5 never silently become valid TOTP accounts', () => {
  const parsed = parseAuthenticatorImport(uri([parameter({ type: 1 }), parameter({ algorithm: 4 }), parameter()]));
  assert.equal(parsed.accounts.length, 1); assert.equal(parsed.unsupported.length, 2);
  assert.match(parsed.unsupported[0].error, /HOTP/);
  assert.equal(JSON.stringify(parsed.unsupported).includes('1234567890'), false);
});

test('ordinary account QR and duplicate secrets remain supported', () => {
  const secret = Secret.fromUTF8('12345678901234567890').base32;
  const parsed = parseAuthenticatorImport(`otpauth://totp/Example:alice?secret=${secret}&issuer=Example`);
  assert.equal(parsed.batch, null);
  const state = addAuthenticatorImport(addAuthenticatorImport(null, parsed), parsed);
  assert.equal(state.accounts.length, 1);
});

test('invalid base64, truncated/oversized protobuf, invalid metadata and unsafe URIs fail closed', () => {
  for (const text of ['otpauth-migration://offline?data=bad!', 'otpauth-migration://online?data=AA==', uri([parameter()], { version: 3 }), uri([parameter()], { size: 2, index: 2 }), uri([parameter()], { size: 101 }), uri([parameter()], { suffix: Buffer.from([0x0a, 255]) }), uri([parameter()], { suffix: number(2, 1) }), uri([parameter()]) + '&data=x', 'otpauth-migration://offline?data=' + 'A'.repeat(66000)]) assert.throws(() => parseAuthenticatorImport(text));
  const short = parseAuthenticatorImport.bind(null, uri([parameter({ secret: 'short' })]));
  assert.throws(short, /格式无效/);
});

test('a repeated frame with changed contents is rejected instead of silently mixing account keys', () => {
  const first = parseAuthenticatorImport(uri([parameter()], { size: 2 }));
  const state = addAuthenticatorImport(null, first);
  const changed = parseAuthenticatorImport(uri([parameter({ secret: 'another-secret-value!' })], { size: 2 }));
  assert.throws(() => addAuthenticatorImport(state, changed), /同一分片包含不同内容/);
});


test('Google migration versions zero, one, two and omitted versions decode identical account data and OTPs', () => {
  const entries = [parameter(), parameter({ secret: '12345678901234567890123456789012', algorithm: 2, digits: 2 }), parameter({ secret: '1234567890123456789012345678901234567890123456789012345678901234', algorithm: 3, digits: 2 })];
  const expected = parseAuthenticatorImport(uri(entries));
  for (const version of [null, 0, 1, 2]) {
    const parsed = parseAuthenticatorImport(uri(entries, { version }));
    assert.deepEqual(parsed, expected);
    assert.equal(otpCode({ ...parsed.accounts[0], digits: 8 }, 59000), '94287082');
    assert.equal(otpCode(parsed.accounts[1], 59000), '46119246');
    assert.equal(otpCode(parsed.accounts[2], 59000), '90693936');
  }
});

test('omitted and zero-valued enums use Google defaults, explicit unsupported enums do not', () => {
  for (const version of [null, 0, 1, 2]) for (const value of [null, 0]) {
    const parsed = parseAuthenticatorImport(uri([parameter({ algorithm: value, digits: value, type: value })], { version }));
    assert.equal(parsed.accounts.length, 1); assert.equal(parsed.unsupported.length, 0);
    assert.equal(parsed.accounts[0].algorithm, 'SHA1'); assert.equal(parsed.accounts[0].digits, 6);
    assert.equal(otpCode({ ...parsed.accounts[0], digits: 8 }, 59000), '94287082');
  }
  for (const params of [{ algorithm: 4 }, { algorithm: 99 }, { digits: 99 }, { type: 1 }, { type: 99 }]) {
    const parsed = parseAuthenticatorImport(uri([parameter(params)], { version: 2 }));
    assert.equal(parsed.accounts.length, 0); assert.equal(parsed.unsupported.length, 1);
  }
});

test('compatible versions retain strict batch validation, rescan detection and complete account lists', () => {
  for (const version of [null, 0, 1, 2]) {
    const frame1 = parseAuthenticatorImport(uri([parameter({ name: 'bob', secret: 'another-secret-value!' })], { version, size: 2, index: 1 }));
    let state = addAuthenticatorImport(null, frame1);
    assert.equal(state.frames.length, 1);
    state = addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter()], { version, size: 2, index: 0 })));
    assert.equal(state.frames.length, 2); assert.equal(state.accounts.length, 2);
    assert.equal(addAuthenticatorImport(state, frame1), state);
    assert.throws(() => addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter()], { version, size: 2, index: 0, id: 43 }))), /当前批次/);
    assert.equal(parseAuthenticatorImport(uri([parameter()], { version, size: 2, id: null })).batch.id, '0');
    assert.throws(() => parseAuthenticatorImport(uri([parameter()], { version, size: 2, index: 2 })), /格式无效/);
  }
  const single = parseAuthenticatorImport(uri([parameter()], { version: null, size: null, index: null, id: null }));
  assert.deepEqual(single.batch, { id: '0', size: 1, index: 0 });
});

test('multi-frame exports accept omitted batch IDs and normalize explicit zero without losing batch checks', () => {
  for (const version of [null, 0, 1, 2]) {
    const frame1 = parseAuthenticatorImport(uri([parameter({ name: 'bob', secret: 'another-secret-value!' })], { version, size: 2, index: 1, id: null }));
    let state = addAuthenticatorImport(null, frame1);
    assert.deepEqual(state.batch, { id: '0', size: 2, index: 1 });
    assert.deepEqual(state.frames, [1]);
    assert.equal(addAuthenticatorImport(state, frame1), state);
    const frame0 = parseAuthenticatorImport(uri([parameter()], { version, size: 2, index: 0, id: null }));
    state = addAuthenticatorImport(state, frame0);
    assert.deepEqual(state.frames, [1, 0]);
    assert.deepEqual(state.accounts.map(item => item.account), ['bob', 'alice']);
    assert.equal(otpCode({ ...state.accounts[1], digits: 8 }, 59000), '94287082');
    const explicitZero = parseAuthenticatorImport(uri([parameter()], { version, size: 2, index: 0, id: 0 }));
    assert.deepEqual(explicitZero, frame0);
    assert.equal(addAuthenticatorImport(state, explicitZero), state);
    assert.throws(() => addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter({ secret: 'changed-secret-value!' })], { version, size: 2, index: 0, id: null }))), /同一分片包含不同内容/);
    assert.throws(() => addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter()], { version, size: 3, id: null }))), /当前批次/);
    assert.throws(() => addAuthenticatorImport(state, parseAuthenticatorImport(uri([parameter()], { version, size: 2, id: 42 }))), /当前批次/);
    for (const metadata of [{ size: 0 }, { size: 101 }, { size: 2, index: 2 }]) {
      assert.throws(() => parseAuthenticatorImport(uri([parameter()], { version, id: null, ...metadata })), /格式无效/);
    }
  }
});

test('unsupported versions expose only the numeric version and malformed compatible payloads still fail closed', () => {
  for (const version of [3, 100, 2147483647]) assert.throws(() => parseAuthenticatorImport(uri([parameter()], { version })), error => {
    assert.match(error.message, new RegExp(`版本 ${version}，`));
    assert.doesNotMatch(error.message, /alice|Example|123456789|otpauth-migration/); return true;
  });
  assert.throws(() => parseAuthenticatorImport(uri([parameter()], { version: 2, suffix: number(2, 2) })), /格式无效/);
  assert.throws(() => parseAuthenticatorImport(uri([parameter()], { version: 2, suffix: Buffer.from([0x0a,255]) })), /格式无效/);
  const wrongWire = bytes(1, Buffer.concat([bytes(1, '12345678901234567890'), bytes(4, 'SHA1')]));
  assert.throws(() => parseAuthenticatorImport(uri([wrongWire], { version: 2 })), /格式无效/);
  assert.throws(() => parseAuthenticatorImport(uri([parameter({ secret: 'short' })], { version: 2 })), /格式无效/);
  const withCounter = bytes(1, Buffer.concat([bytes(1, '12345678901234567890'), number(7, 5)]));
  const parsed = parseAuthenticatorImport(uri([withCounter], { version: 2 }));
  assert.equal(parsed.accounts.length, 0); assert.match(parsed.unsupported[0].error, /计数器/);
});

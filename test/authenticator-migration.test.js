import test from 'node:test';
import assert from 'node:assert/strict';
import { Secret } from 'otpauth';
import { parseAuthenticatorImport, addAuthenticatorImport } from '../shared/authenticator-migration.js';
import { otpCode } from '../shared/authenticator.js';

const varint = input => { let n = BigInt(input); const out = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
const number = (key, value) => Buffer.concat([varint(key * 8), varint(value)]);
const bytes = (key, value) => { const data = Buffer.from(value); return Buffer.concat([varint(key * 8 + 2), varint(data.length), data]); };
const parameter = ({ secret = '12345678901234567890', name = 'Example:alice', issuer = 'Example', algorithm = 1, digits = 1, type = 2 } = {}) => bytes(1, Buffer.concat([bytes(1, secret), bytes(2, name), bytes(3, issuer), number(4, algorithm), number(5, digits), number(6, type)]));
const uri = (entries = [parameter()], { size = 1, index = 0, id = 42, version = 1, suffix = Buffer.alloc(0) } = {}) => `otpauth-migration://offline?data=${encodeURIComponent(Buffer.concat([...entries, number(2, version), number(3, size), number(4, index), number(5, id), suffix]).toString('base64'))}`;

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
  for (const text of ['otpauth-migration://offline?data=bad!', 'otpauth-migration://online?data=AA==', uri([parameter()], { version: 2 }), uri([parameter()], { size: 2, index: 2 }), uri([parameter()], { size: 101 }), uri([parameter()], { suffix: Buffer.from([0x0a, 255]) }), uri([parameter()], { suffix: number(2, 1) }), uri([parameter()]) + '&data=x', 'otpauth-migration://offline?data=' + 'A'.repeat(66000)]) assert.throws(() => parseAuthenticatorImport(text));
  const short = parseAuthenticatorImport.bind(null, uri([parameter({ secret: 'short' })]));
  assert.throws(short, /格式无效/);
});

test('a repeated frame with changed contents is rejected instead of silently mixing account keys', () => {
  const first = parseAuthenticatorImport(uri([parameter()], { size: 2 }));
  const state = addAuthenticatorImport(null, first);
  const changed = parseAuthenticatorImport(uri([parameter({ secret: 'another-secret-value!' })], { size: 2 }));
  assert.throws(() => addAuthenticatorImport(state, changed), /同一分片包含不同内容/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { Secret } from 'otpauth';
import { createAuthenticatorStore, encodeAuthenticatorBackup, decodeAuthenticatorBackup, registerAuthenticatorRoutes } from '../server/authenticator.js';
import { otpCode, parseOtpInput, normalizeOtpSecret, otpRemaining } from '../shared/authenticator.js';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const config = (account = 'alice') => ({ issuer: 'Example', account, note: '', secret, algorithm: 'SHA1', digits: 6, period: 30 });
function fixture() {
  const db = new Database(':memory:');
  const key = crypto.randomBytes(32);
  const encrypt = value => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }; };
  const decrypt = value => { const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64')); d.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([d.update(Buffer.from(value.data, 'base64')), d.final()]).toString('utf8'); };
  return { db, store: createAuthenticatorStore(db, encrypt, decrypt) };
}

test('TOTP URI parsing and RFC vector', () => {
  assert.equal(otpCode({ secret, algorithm: 'SHA1', digits: 8, period: 30 }, 59000), '94287082');
  assert.deepEqual(parseOtpInput(`otpauth://totp/Example%3Aalice?secret=${secret}&issuer=Example`), { algorithm: 'SHA1', digits: 6, period: 30, secret, issuer: 'Example', account: 'alice' });
  assert.throws(() => parseOtpInput(`otpauth://totp/x?secret=${secret}&counter=1`), /不支持/);
  assert.equal(parseOtpInput(`otpauth://totp/Example%3AOps%3Aalice?secret=${secret}&issuer=Example%3AOps`).account, 'alice');
});

test('SQL statements are reused; metadata reads and sorting never decrypt account keys', () => {
  const db = new Database(':memory:');
  let prepares = 0, decrypts = 0;
  const nativePrepare = db.prepare.bind(db);
  db.prepare = (...args) => { prepares++; return nativePrepare(...args); };
  const store = createAuthenticatorStore(db, value => ({ value }), value => { decrypts++; return value.value; });
  const prepared = prepares;
  const a = store.save(config()), b = store.save({ ...config('b'), secret: Secret.fromUTF8('another-secret-value!').base32 });
  for (let i = 0; i < 100; i++) { store.list(); store.settings(); }
  store.reorder(b, a, 'before');
  assert.equal(prepares, prepared);
  assert.equal(decrypts, 0);
  db.close();
});

test('all RFC 6238 vectors pass for SHA1, SHA256 and SHA512, including large timestamps', () => {
  const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
  const vectors = {
    SHA1: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
    SHA256: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
    SHA512: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826']
  };
  for (const [algorithm, expected] of Object.entries(vectors)) {
    const length = { SHA1: 20, SHA256: 32, SHA512: 64 }[algorithm];
    const secret = Secret.fromUTF8('1234567890'.repeat(7).slice(0, length)).base32;
    times.forEach((time, i) => assert.equal(otpCode({ secret, algorithm, digits: 8, period: 30 }, time * 1000), expected[i]));
  }
  assert.equal(otpRemaining(30, 30000), 30);
  assert.equal(otpRemaining(30, 29999), 1);
});

test('malformed secrets, HOTP, noncanonical encodings and duplicate URI parameters are rejected', () => {
  for (const input of [null, {}, '', 'abc', 'not@base32', 'AAAAAAAAAAAAAAAAB']) assert.throws(() => normalizeOtpSecret(input));
  assert.equal(normalizeOtpSecret(secret.toLowerCase().replace(/(.{4})/g, '$1 ')), secret);
  for (const uri of [`otpauth://hotp/x?secret=${secret}`, `otpauth://totp/x?secret=${secret}&secret=${secret}`, `otpauth://totp/x?secret=${secret}&digits=7`, `otpauth://totp/x?secret=${secret}&period=0`]) assert.throws(() => parseOtpInput(uri));
});

test('store never exposes encrypted secret in metadata, detects duplicates and enforces revisions', () => {
  const { db, store } = fixture();
  const id = store.save(config());
  assert.equal(store.list().accounts[0].secret, undefined);
  assert.equal(store.secrets()[0].secret, secret);
  assert.throws(() => store.save(config('other')), /重复/);
  assert.throws(() => store.remove(id, 0), /修改/);
  store.save({ ...config(), revision: 1, note: 'changed' }, id);
  assert.equal(store.list().accounts[0].revision, 2);
  store.save({ issuer: 'Edited', account: 'alice', note: '', revision: 2, algorithm: 'SHA256', digits: 8, period: 45, secret: '' }, id);
  assert.equal(store.account(id).secret, secret);
  assert.equal(store.account(id).algorithm, 'SHA256');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM authenticator_accounts').get()).includes(secret));
  const other = { ...config('bob'), secret: Secret.fromUTF8('another-secret-value!').base32 };
  assert.throws(() => store.import([other, config()]), /重复/);
  assert.equal(store.list().accounts.length, 1);
  const second = store.save(other);
  store.reorder(second, id, 'before');
  assert.deepEqual(store.list().accounts.map(item => item.id), [second, id]);
  store.audit('edit');
  assert.equal(store.history()[0].action, 'edit');
  assert.throws(() => store.configure(0));
  db.close();
});

test('unlock grants bind to login sessions, expire, and recheck after async reauthentication', async () => {
  const { db, store } = fixture(), routes = {};
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }]));
  let time = 1000, waiting, block = false, valid = true;
  registerAuthenticatorRoutes(app, store, async req => {
    if (req.body.password !== 'test-password') { const error = Error('密码错误'); error.statusCode = 403; throw error; }
    if (block) await new Promise(resolve => { waiting = resolve; });
  }, { now: () => time, sessionValid: () => valid });
  const session = {};
  const call = async (key, body = {}, token = '', auth = session, params = {}) => {
    const res = { code: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
    await routes[key]({ body, headers: { 'x-authenticator-unlock': token }, auth, params }, res);
    assert.equal(res.headers['Cache-Control'], 'no-store'); return res;
  };
  assert.equal((await call('post /api/authenticator', config())).code, 423);
  assert.equal((await call('post /api/authenticator/unlock', { password: 'wrong' })).code, 403);
  const unlock = await call('post /api/authenticator/unlock', { password: 'test-password' });
  const token = unlock.data.token;
  assert.equal((await call('post /api/authenticator/touch', {}, token, {})).code, 423);
  assert.equal((await call('post /api/authenticator/touch', {}, token)).code, 200);
  // A foreign login cannot revoke another session's valid grant.
  const second = await call('post /api/authenticator/unlock', { password: 'test-password' });
  const t = second.data.token;
  assert.equal((await call('post /api/authenticator/touch', {}, token)).code, 200, 'another tab unlock preserves existing grant');
  const created = await call('post /api/authenticator', config(), t);
  assert.equal(created.code, 201);
  assert.equal((await call('get /api/authenticator')).data.accounts[0].secret, undefined);
  block = true;
  const reveal = call('post /api/authenticator/:id/reveal', { password: 'test-password' }, t, session, { id: created.data.item.id });
  await new Promise(setImmediate);
  assert.equal((await call('post /api/authenticator/unlock', { password: 'test-password' })).code, 429);
  await call('post /api/authenticator/lock', {}, t);
  waiting(); assert.equal((await reveal).code, 423);
  block = false;
  const expiring = (await call('post /api/authenticator/unlock', { password: 'test-password' })).data.token;
  time += 5 * 60000;
  assert.equal((await call('post /api/authenticator/touch', {}, expiring)).code, 423);
  const invalid = (await call('post /api/authenticator/unlock', { password: 'test-password' })).data.token;
  valid = false;
  assert.equal((await call('post /api/authenticator/session', {}, invalid)).code, 423);
  db.close();
});

test('encrypted backup rejects tampering and restores only valid accounts', async () => {
  const accounts = [{ ...config(), id: 'local', revision: 1 }];
  const backup = await encodeAuthenticatorBackup(accounts, 'a secure passphrase');
  assert.deepEqual(await decodeAuthenticatorBackup(backup, 'a secure passphrase'), accounts);
  await assert.rejects(() => decodeAuthenticatorBackup({ ...backup, data: `${backup.data.slice(0, -2)}AA` }, 'a secure passphrase'), /损坏/);
  await assert.rejects(() => decodeAuthenticatorBackup(backup, 'wrong password'), /错误/);
});

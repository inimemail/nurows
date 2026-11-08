import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadStorageKey, defaultMasterKeyFile} from '../server/storage-key.js';
test('optional external key preserves existing credential encryption key and fails closed if missing or changed',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nurossh-key-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'key'),key=crypto.randomBytes(32).toString('hex');fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),{mode:0o600});
  assert.deepEqual(loadStorageKey(key),{key,stored:key});const wrapped=loadStorageKey(key,file);assert.equal(wrapped.key,key);assert.ok(!wrapped.stored.includes(key));assert.deepEqual(loadStorageKey(wrapped.stored,file),wrapped);assert.throws(()=>loadStorageKey(wrapped.stored),/必须提供原/);
  fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'));assert.throws(()=>loadStorageKey(wrapped.stored,file),/不匹配/);assert.throws(()=>loadStorageKey('broken'),/密钥损坏/);fs.chmodSync(file,0o644);assert.throws(()=>loadStorageKey(key,file),/仅所有者/);
});

test('automatic independent master persists outside data and is never regenerated for wrapped databases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nurossh-master-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32).toString('hex'), filename = defaultMasterKeyFile(key, root);
  const contents = fs.readFileSync(filename, 'utf8');
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const wrapped = loadStorageKey(key, filename);
  assert.equal(defaultMasterKeyFile(wrapped.stored, root), filename);
  assert.equal(fs.readFileSync(filename, 'utf8'), contents);
  fs.unlinkSync(filename);
  assert.throws(() => defaultMasterKeyFile(wrapped.stored, root), /缺少独立主密钥/);
  assert.equal(fs.existsSync(filename), false);
});

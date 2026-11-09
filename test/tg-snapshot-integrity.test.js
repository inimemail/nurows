import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encoder, decoder } from '../server/backup-crypto.cjs';
import { execFileSync } from 'node:child_process';

const source = await fs.readFile(new URL('../tg-hosting/runner.mjs', import.meta.url), 'utf8');
test('snapshot readback authenticates all bytes, compares the source digest and invalidates cached verification after modification', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-snapshot-verify-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), plain = crypto.randomBytes(256 * 1024), file = path.join(root, 'snapshot.enc');
  await pipeline(Readable.from([plain]), encoder(key), syncFs.createWriteStream(file));
  const original = await fs.readFile(file), verifiedSnapshots = new Map(); let reads = 0;
  const verify = vm.runInNewContext(`(${source.slice(source.indexOf('async function verifySnapshot('), source.indexOf('\nasync function reuseSnapshot('))})`, {
    fsp: fs, fs: { ...syncFs, createReadStream: (...args) => { reads++; return syncFs.createReadStream(...args); } }, crypto, Writable, pipeline, decoder, key, verifiedSnapshots,
    TG_PROFILE_MAX_BYTES: 20 * 1024 ** 3, AbortSignal, fail: message => { throw Error(message); },
  });
  await verify(file, { bytes: plain.length, digest: crypto.createHash('sha256').update(plain).digest('hex') });
  assert.equal(reads, 1); await verify(file); await verify(file); assert.equal(reads, 1, 'unchanged snapshots do not reread the data');
  await assert.rejects(verify(file, { bytes: plain.length, digest: 'wrong' }), /完整性/);
  // Preserve length and mtime: inode/ctime also participate in invalidation.
  const before = await fs.stat(file), corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  await fs.writeFile(file, corrupt); await fs.utimes(file, before.atime, before.mtime);
  await assert.rejects(verify(file), /完整性/); assert.deepEqual(await fs.readFile(file), corrupt);
  await fs.writeFile(file, original); await verify(file);
  const link = path.join(root, 'link'); await fs.symlink(file, link); await assert.rejects(verify(link), /格式或大小异常/);
});

test('truncated gzip trailers and corrupted compressed payloads fail validation before any profile extraction', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-archive-verify-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'); await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'session'), crypto.randomBytes(10000));
  const script = path.join(root, 'archive.py'); await fs.writeFile(script, (await fs.readFile(new URL('../tg-hosting/profile-archive.py', import.meta.url), 'utf8')).replace("root = Path('/profile')", `root = Path(${JSON.stringify(profile)})`));
  const archive = path.join(profile, '.tg-snapshot-test.tar.gz'); execFileSync('python3', [script, 'pack', archive]); const valid = await fs.readFile(archive);
  execFileSync('python3', [script, 'verify', archive]);
  const data = Buffer.from(valid); data[data.length - 8] ^= 1;
  for (const bytes of [valid.subarray(0, valid.length - 8), valid.subarray(0, valid.length - 1), data]) {
    const broken = path.join(root, 'broken.tar.gz'); await fs.writeFile(broken, bytes);
    assert.throws(() => execFileSync('python3', [script, 'verify', broken], { stdio: 'pipe' }));
    const originalSession = await fs.readFile(path.join(profile, 'session'));
    assert.throws(() => execFileSync('python3', [script, 'extract', broken], { stdio: 'pipe' }));
    assert.deepEqual(await fs.readFile(path.join(profile, 'session')), originalSession);
  }
});

test('metadata-only profiles cannot replace valid session snapshots, while nested names remain real data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-metadata-only-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'); await fs.mkdir(profile);
  const script = path.join(root, 'archive.py'); await fs.writeFile(script, (await fs.readFile(new URL('../tg-hosting/profile-archive.py', import.meta.url), 'utf8')).replace("root = Path('/profile')", `root = Path(${JSON.stringify(profile)})`));
  for (const name of ['.nurossh-login.json', '.nurossh-browser-version', '.nurossh-browser-error.json', '.nurossh-login.json.abcdef123456.partial']) await fs.writeFile(path.join(profile, name), 'metadata');
  const archive = path.join(profile, '.tg-snapshot-test.tar.gz');
  assert.throws(() => execFileSync('python3', [script, 'pack', archive], { stdio: 'pipe' }), error => error.stderr.toString().includes('empty profile'));
  await fs.rm(archive);
  // Archives created before this check must also be rejected at restore.
  execFileSync('python3', ['-c', "import tarfile,sys\nwith tarfile.open(sys.argv[2],'w:gz') as t: t.add(sys.argv[1],arcname='.nurossh-browser-version')", path.join(profile, '.nurossh-browser-version'), archive]);
  assert.throws(() => execFileSync('python3', [script, 'verify', archive], { stdio: 'pipe' }), error => error.stderr.toString().includes('empty profile archive'));
  await fs.rm(archive);
  await fs.mkdir(path.join(profile, 'Default')); await fs.writeFile(path.join(profile, 'Default/.nurossh-login.json'), 'actual-database-content');
  execFileSync('python3', [script, 'pack', archive]); execFileSync('python3', [script, 'verify', archive]);
  assert.equal(await fs.readFile(path.join(profile, 'Default/.nurossh-login.json'), 'utf8'), 'actual-database-content');
});

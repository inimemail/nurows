import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createNotesStore } from '../server/notes-store.js';
import { createNotesService } from '../server/notes.js';
import { openEncryptedNotes, decodeAttachment, migrateNotesDatabase } from '../server/notes-storage.js';
import { defaultMasterKeyFile, loadStorageKey } from '../server/storage-key.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('legacy notes, revisions, FTS and attachments migrate, reopen and snapshot without plaintext on disk', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nurows-notes-encryption-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'); await fs.mkdir(dataDir);
  const filename = path.join(dataDir, 'notes.db'), key = crypto.randomBytes(32);
  const db = new Database(filename), store = createNotesStore(db);
  let doc = store.create({ title: '私密标题', body: '<p>历史正文私密标记</p>', tags: ['私密标签'] }).document;
  doc = store.save({ ...doc, body: '<p>当前正文服务器备份</p>' }).document;
  const attachmentId = crypto.randomUUID(), attachmentDir = path.join(dataDir, 'note-attachments');
  await fs.mkdir(attachmentDir); const contents = Buffer.from('附件私密标记');
  await fs.writeFile(path.join(attachmentDir, attachmentId), contents);
  store.attachmentAdd({ id: attachmentId, documentId: doc.id, name: '私密文件名.txt', mime: 'application/octet-stream', size: contents.length });
  const collisionId = crypto.randomUUID(), collision = Buffer.from('NUROATT1' + 'raw-binary-fixture'.repeat(5));
  await fs.writeFile(path.join(attachmentDir, collisionId), collision);
  store.attachmentAdd({ id: collisionId, documentId: doc.id, name: 'header-collision.bin', mime: 'application/octet-stream', size: collision.length });
  db.close();
  let service = createNotesService({ dataDir, key });
  t.after(() => service.close());
  assert.equal((await service.call('get', doc)).document.body, doc.body);
  assert.equal((await service.call('version', { id: doc.id, version: 1 })).version.body, '<p>历史正文私密标记</p>');
  for (const q of ['备份', '服务器', '私密标签']) assert.equal((await service.call('list', { q })).total, 1);
  const attachment = await service.call('readAttachment', { id: attachmentId }); assert.deepEqual(Buffer.from(attachment.data), contents);
  assert.deepEqual(Buffer.from((await service.call('readAttachment', { id: collisionId })).data), collision);
  for (const name of await fs.readdir(dataDir)) {
    if (!(await fs.stat(path.join(dataDir, name))).isFile()) continue;
    const bytes = await fs.readFile(path.join(dataDir, name));
    for (const text of ['私密标题', '历史正文私密标记', '当前正文服务器备份', '私密标签', '私密文件名']) assert.equal(bytes.includes(Buffer.from(text)), false, name);
  }
  const encryptedAttachment = await fs.readFile(path.join(attachmentDir, attachmentId));
  assert.equal(encryptedAttachment.includes(contents), false);
  assert.throws(() => decodeAttachment(encryptedAttachment, crypto.randomBytes(32)), /解密校验失败/);
  const damaged = Buffer.from(encryptedAttachment); damaged[25] ^= 1;
  assert.throws(() => decodeAttachment(damaged, key), /解密校验失败/);
  await service.close();
  assert.throws(() => new Database(filename).prepare('SELECT * FROM documents').all(), /not a database/);
  assert.throws(() => openEncryptedNotes(filename, crypto.randomBytes(32)), /not a database|encrypted/);
  service = createNotesService({ dataDir, key });
  assert.equal((await service.call('get', doc)).document.title, doc.title);
  assert.deepEqual(Buffer.from((await service.call('readAttachment', { id: attachmentId })).data), contents);
  // Exercise the actual backup helper, including encrypted online VACUUM snapshots.
  const masterFile = defaultMasterKeyFile(key.toString('hex'), root), wrapped = loadStorageKey(key.toString('hex'), masterFile);
  const main = new Database(path.join(dataDir, 'app.db'));
  main.exec('CREATE TABLE app_kv(key TEXT PRIMARY KEY,value TEXT)'); main.prepare('INSERT INTO app_kv VALUES (?,?)').run('secret', wrapped.stored); main.close();
  const output = path.join(dataDir, '.backup-review');
  const child = spawn(process.execPath, ['server/storage-backup.js', dataDir, output, path.join(dataDir, 'app.db')], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, MASTER_KEY_FILE: masterFile }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', data => error += data);
  assert.equal((await once(child, 'exit'))[0], 0, error);
  const snapshot = openEncryptedNotes(path.join(output, 'notes.db'), key, { readonly: true });
  assert.equal(snapshot.prepare('SELECT body FROM documents WHERE id=?').get(doc.id).body, doc.body); snapshot.close();
  assert.deepEqual(decodeAttachment(await fs.readFile(path.join(output, 'note-attachments', attachmentId)), key), contents);
});

test('damaged legacy databases never replace the original with an empty encrypted database', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nurows-notes-damaged-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'notes.db'), bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(900)]);
  await fs.writeFile(filename, bytes);
  await assert.rejects(migrateNotesDatabase(filename, crypto.randomBytes(32)));
  assert.deepEqual(await fs.readFile(filename), bytes);
});

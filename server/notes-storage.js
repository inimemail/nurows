import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import Database from 'better-sqlite3-multiple-ciphers';

const magic = Buffer.from('NUROATT1');
export function notesKey(key, purpose) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('笔记加密密钥不可用');
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `nurossh-notes-${purpose}-v1`, 32));
}
function configure(db, key) {
  db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.key(key);
  db.pragma('temp_store=MEMORY'); db.pragma('busy_timeout=5000');
  return db;
}
export function openEncryptedNotes(filename, key, options = {}) {
  const db = new Database(filename, options);
  try {
    const derived = notesKey(key, 'database');
    try { configure(db, derived); } finally { derived.fill(0); }
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw Error('笔记数据库完整性检查失败');
    return db;
  } catch (error) { db.close(); throw error; }
}
function syncFile(filename) { const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

// Build and verify a separate encrypted copy. Never rekey the only source copy.
export async function migrateNotesDatabase(filename, key) {
  if (!fs.existsSync(filename) || !fs.statSync(filename).size) return;
  const fd = fs.openSync(filename, 'r'), header = Buffer.alloc(16);
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (header.toString() !== 'SQLite format 3\0') return;
  const stage = `${filename}.encrypting`, source = new Database(filename);
  let copy;
  try {
    // An interrupted prior attempt leaves the source intact; rebuild its stage.
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(stage + suffix, { force: true });
    source.pragma('busy_timeout=5000'); source.pragma('temp_store=MEMORY');
    if (source.pragma('quick_check', { simple: true }) !== 'ok') throw Error('原笔记数据库损坏，已停止迁移');
    const counts = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(({ name }) => [name, source.prepare(`SELECT count(*) n FROM "${name.replaceAll('"', '""')}"`).get().n]);
    fs.closeSync(fs.openSync(stage, 'wx', 0o600));
    await source.backup(stage);
    copy = new Database(stage); copy.pragma('temp_store=MEMORY'); copy.pragma("cipher='sqlcipher'"); copy.pragma('legacy=4');
    const derived = notesKey(key, 'database');
    try { copy.rekey(derived); } finally { derived.fill(0); }
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('笔记加密副本校验失败');
    for (const [name, count] of counts) if (copy.prepare(`SELECT count(*) n FROM "${name.replaceAll('"', '""')}"`).get().n !== count) throw Error('笔记迁移记录数不匹配');
    copy.close(); copy = null; syncFile(stage);
    source.pragma('wal_checkpoint(TRUNCATE)'); source.close();
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(filename + suffix, { force: true });
    fs.renameSync(stage, filename); syncFile(path.dirname(filename));
  } finally {
    if (copy?.open) copy.close(); if (source.open) source.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(stage + suffix, { force: true });
  }
}

export function attachmentEncoder(key) {
  const iv = crypto.randomBytes(12), derived = notesKey(key, 'attachments');
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv); derived.fill(0);
  cipher.setAAD(magic);
  let started = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!started) { this.push(Buffer.concat([magic, iv])); started = true; }
      try { callback(null, cipher.update(chunk)); } catch (error) { callback(error); }
    },
    flush(callback) {
      try { if (!started) this.push(Buffer.concat([magic, iv])); this.push(cipher.final()); this.push(cipher.getAuthTag()); callback(); }
      catch (error) { callback(error); }
    }
  });
}
export function decodeAttachment(data, key) {
  if (data.length < 36 || !data.subarray(0, 8).equals(magic)) throw Error('附件未加密或格式损坏');
  const derived = notesKey(key, 'attachments');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derived, data.subarray(8, 20));
    decipher.setAAD(magic); decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(20, -16)), decipher.final()]);
  } catch { throw Error('附件解密校验失败，原文件未修改'); } finally { derived.fill(0); }
}
export async function migrateAttachments(directory, key, originalSize = () => undefined) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { pipeline } = await import('node:stream/promises');
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('附件包含不安全文件');
    const fd = fs.openSync(file, 'r'), header = Buffer.alloc(8);
    try { fs.readSync(fd, header, 0, 8, 0); } finally { fs.closeSync(fd); }
    const size = originalSize(name);
    if (header.equals(magic) && (size === undefined || stat.size === size + 36)) continue;
    if (size !== undefined && stat.size !== size) throw Error('附件大小与记录不符，已保留原文件');
    if (stat.size > 10 * 1024 * 1024) throw Error('旧附件超过安全大小限制，请检查原文件，未替换该文件');
    const stage = `${file}.encrypting`;
    try {
      fs.rmSync(stage, { force: true });
      await pipeline(fs.createReadStream(file), attachmentEncoder(key), fs.createWriteStream(stage, { flags: 'wx', mode: 0o600 }));
      // Verify before replacing the source. Files are bounded by upload limits.
      const check = decodeAttachment(fs.readFileSync(stage), key);
      try { if (check.length !== stat.size) throw Error('附件迁移校验失败'); } finally { check.fill(0); }
      syncFile(stage); fs.renameSync(stage, file); syncFile(directory);
    } finally { fs.rmSync(stage, { force: true }); }
  }
}

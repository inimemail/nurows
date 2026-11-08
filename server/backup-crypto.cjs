// Standalone Node-only codec, also passed to `node -e` in a clean container.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const MAGIC = Buffer.from('NUROSSH-BACKUP-1\n');
function keyFile(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('备份主密钥文件权限或格式无效');
  const text = fs.readFileSync(filename, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(text)) throw Error('备份主密钥格式无效');
  return Buffer.from(text, 'hex');
}
function derive(master, salt) { return Buffer.from(crypto.hkdfSync('sha256', master, salt, 'nurossh-deployment-backup-v1', 32)); }
function encoder(master) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), header = Buffer.concat([MAGIC, salt, iv]);
  const key = derive(master, salt), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); key.fill(0); cipher.setAAD(header);
  let started = false;
  return new Transform({ transform(chunk, _enc, cb) { try { if (!started) { this.push(header); started = true; } cb(null, cipher.update(chunk)); } catch (e) { cb(e); } },
    flush(cb) { try { if (!started) this.push(header); this.push(cipher.final()); this.push(cipher.getAuthTag()); cb(); } catch (e) { cb(e); } } });
}
function decoder(master) {
  let pending = Buffer.alloc(0), decipher;
  const headerSize = MAGIC.length + 28;
  return new Transform({ transform(chunk, _enc, cb) {
    try {
      pending = Buffer.concat([pending, chunk]);
      if (!decipher) {
        if (pending.length < headerSize) { cb(); return; }
        const header = pending.subarray(0, headerSize);
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw Error('不是受支持的加密备份');
        const key = derive(master, header.subarray(MAGIC.length, MAGIC.length + 16));
        decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(-12)); key.fill(0); decipher.setAAD(header);
        pending = pending.subarray(headerSize);
      }
      if (pending.length > 16) { this.push(decipher.update(pending.subarray(0, -16))); pending = Buffer.from(pending.subarray(-16)); }
      cb();
    } catch (e) { cb(e); }
  }, flush(cb) {
    try { if (!decipher || pending.length !== 16) throw Error(); decipher.setAuthTag(pending); this.push(decipher.final()); cb(); }
    catch { cb(Error('备份主密钥不匹配，或加密备份已损坏；未执行恢复')); }
  } });
}
module.exports = { MAGIC, encoder, decoder, keyFile };
if (require.main === module || (!require.main && ['encrypt', 'decrypt'].includes(process.argv[1]))) {
  const args = process.argv.slice(require.main ? 2 : 1);
  const run = async () => {
    const [mode, filename] = args;
    if (!['encrypt', 'decrypt'].includes(mode) || !filename) throw Error('缺少加密操作或主密钥文件');
    const key = keyFile(filename);
    try { await pipeline(process.stdin, mode === 'encrypt' ? encoder(key) : decoder(key), process.stdout); }
    finally { key.fill(0); }
  };
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

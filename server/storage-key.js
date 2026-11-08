import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// This directory must be mounted separately from data and excluded from archives.
// Never generate a replacement after an encrypted database has been initialized.
export function defaultMasterKeyFile(stored, root) {
  const filename = path.join(root, 'secrets', 'master.key');
  if (fs.existsSync(path.dirname(filename)) && fs.lstatSync(path.dirname(filename)).isSymbolicLink() || fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw Error('独立主密钥路径不能是符号链接');
  if (!fs.existsSync(filename)) {
    if (stored?.startsWith('wrapped-v1:')) throw Error('缺少独立主密钥 secrets/master.key，请恢复原密钥，禁止生成替代密钥');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, crypto.randomBytes(32).toString('hex') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const directory = fs.openSync(path.dirname(filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return filename;
}

// Wrap the existing application key, so enabling this does not re-encrypt or
// invalidate any saved SSH, cloud or Telegram credential.
export function loadStorageKey(stored, keyFile = '') {
  let master;
  if (keyFile) {
    const stat = fs.statSync(keyFile);
    if (!stat.isFile() || stat.size > 1024) throw new Error('外部主密钥文件无效');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('外部主密钥文件必须限制为仅所有者可读（0600 或 0400）');
    const value = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('外部主密钥必须是 32 字节的十六进制字符串');
    master = Buffer.from(value, 'hex');
  }
  if (stored.startsWith('wrapped-v1:')) {
    if (!master) throw new Error('数据库已启用外部主密钥，必须提供原 MASTER_KEY_FILE，禁止生成替代密钥');
    try {
      const { iv, tag, data } = JSON.parse(stored.slice(11));
      const decipher = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      const key = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('hex');
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid key');
      return { key, stored };
    } catch { throw new Error('外部主密钥不匹配或密钥记录损坏，原数据未修改'); }
  }
  if (!/^[a-f0-9]{64}$/i.test(stored)) throw new Error('应用密钥损坏，禁止自动更换，请恢复原密钥');
  if (!master) return { key: stored, stored };
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(stored, 'hex')), cipher.final()]);
  return { key: stored, stored: 'wrapped-v1:' + JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }) };
}

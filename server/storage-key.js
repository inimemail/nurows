import fs from 'node:fs';
import crypto from 'node:crypto';

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

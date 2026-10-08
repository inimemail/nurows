import { Secret, TOTP } from 'otpauth';

export const OTP_DEFAULTS = { algorithm: 'SHA1', digits: 6, period: 30 };
export const OTP_MAX_ACCOUNTS = 500;

export function normalizeOtpSecret(input) {
  if (typeof input !== 'string') throw Error('请输入有效的 Base32 密钥');
  const raw = String(input || '').replace(/\s/g, '').toUpperCase();
  if (raw.length > 256 || !/^[A-Z2-7]+={0,6}$/.test(raw)) throw Error('请输入有效的 Base32 密钥');
  const text = raw.replace(/=+$/, '');
  if (![0, 2, 4, 5, 7].includes(text.length % 8)) throw Error('密钥长度不完整');
  const secret = Secret.fromBase32(text);
  if (secret.buffer.byteLength < 10 || secret.base32 !== text) throw Error('密钥无效或过短（至少 80 位）');
  return secret.base32;
}

export function otpParameters(input = {}) {
  const algorithm = String(input.algorithm || 'SHA1').toUpperCase().replace(/-/g, '');
  const digits = Number(input.digits ?? 6), period = Number(input.period ?? 30);
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) throw Error('仅支持 SHA-1、SHA-256、SHA-512');
  if (![6, 8].includes(digits)) throw Error('验证码位数必须为 6 或 8');
  if (!Number.isInteger(period) || period < 15 || period > 120) throw Error('周期必须为 15 至 120 秒');
  return { algorithm, digits, period };
}

export function parseOtpInput(input, parameters = OTP_DEFAULTS) {
  if (typeof input !== 'string') throw Error('请输入密钥或配置链接');
  const text = String(input || '').trim();
  if (!/^otpauth:/i.test(text)) return { ...otpParameters(parameters), secret: normalizeOtpSecret(text) };
  if (text.length > 4096) throw Error('配置链接过长');
  let url;
  try { url = new URL(text); } catch { throw Error('配置链接无效'); }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp' || url.port || url.username || url.password || url.hash) throw Error('仅支持 otpauth 时间型 TOTP 配置，不支持 HOTP');
  for (const key of ['secret', 'algorithm', 'digits', 'period', 'issuer']) if (url.searchParams.getAll(key).length > 1) throw Error('配置链接包含重复参数');
  for (const key of url.searchParams.keys()) if (!['secret', 'algorithm', 'digits', 'period', 'issuer'].includes(key)) throw Error('配置链接包含不支持的参数');
  let label;
  try { label = decodeURIComponent(url.pathname.slice(1)); } catch { throw Error('配置链接名称编码无效'); }
  const colon = label.indexOf(':');
  const issuer = url.searchParams.get('issuer') || (colon >= 0 ? label.slice(0, colon) : '');
  const account = issuer && label.startsWith(`${issuer}:`) ? label.slice(issuer.length + 1) : colon >= 0 ? label.slice(colon + 1) : label;
  return { ...otpParameters({ algorithm: url.searchParams.get('algorithm') || 'SHA1', digits: url.searchParams.get('digits') || 6, period: url.searchParams.get('period') || 30 }), secret: normalizeOtpSecret(url.searchParams.get('secret')), issuer: issuer.slice(0, 120), account: account.slice(0, 200) };
}

export function createOtp(config) {
  const params = otpParameters(config);
  return new TOTP({ ...params, issuer: config.issuer || '', label: config.account || config.issuer || 'Authenticator', secret: Secret.fromBase32(normalizeOtpSecret(config.secret)) });
}

export function otpCode(config, now = Date.now()) { return createOtp(config).generate({ timestamp: now }); }
export function otpRemaining(period, now = Date.now()) { return period - Math.floor(now / 1000) % period; }

export function normalizeOtpAccount(input, existing) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('验证器配置无效');
  if (input.secret !== undefined && typeof input.secret !== 'string') throw Error('密钥格式无效');
  const clean = (value, limit) => String(value || '').trim().slice(0, limit);
  const parsed = input.secret ? parseOtpInput(input.secret, input) : null;
  if (!parsed && !existing) throw Error('请输入密钥');
  const issuer = clean(input.issuer || parsed?.issuer, 120), account = clean(input.account || parsed?.account, 200);
  if (!issuer) throw Error('请输入服务名称');
  if (!account) throw Error('请输入账号名称');
  return { issuer, account, note: clean(input.note, 500), ...otpParameters(parsed || { ...existing, ...input }), ...(parsed ? { secret: parsed.secret } : {}) };
}

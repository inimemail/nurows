import { Secret } from 'otpauth';
import { normalizeOtpAccount, parseOtpInput, OTP_MAX_ACCOUNTS } from './authenticator.js';

const invalid = () => { throw Error('谷歌迁移二维码格式无效或数据不完整'); };
// Bounded protobuf reader for Google's offline migration format. No remote
// decoder, eval, dynamic schema loading or third-party service is involved.
function fields(bytes) {
  let offset = 0;
  const result = new Map();
  function integer() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) invalid();
      const byte = bytes[offset++];
      if (shift === 63n && byte > 1) invalid();
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    invalid();
  }
  while (offset < bytes.length) {
    const tag = integer(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!number || number > 536870911) invalid();
    let value;
    if (wire === 0) value = integer();
    else if ([1, 2, 5].includes(wire)) {
      const size = wire === 2 ? Number(integer()) : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) invalid();
      value = bytes.subarray(offset, offset + size); offset += size;
    } else invalid();
    const values = result.get(number) || []; values.push({ wire, value }); result.set(number, values);
  }
  return result;
}
function single(map, key, wire, fallback) {
  const values = map.get(key);
  if (!values) return fallback;
  if (values.length !== 1 || values[0].wire !== wire) invalid();
  return values[0].value;
}
function label(bytes, max) {
  if (!bytes) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }
  catch { invalid(); }
}
export function parseAuthenticatorImport(text) {
  if (typeof text !== 'string' || text.length > 65536) invalid();
  if (!/^otpauth-migration:/i.test(text.trim())) {
    if (!/^otpauth:/i.test(text.trim())) throw Error('请扫描验证器配置二维码');
    const config = parseOtpInput(text);
    return { batch: null, accounts: [normalizeOtpAccount({ ...config, issuer: config.issuer || '验证器', account: config.account || '未命名账号' })], unsupported: [] };
  }
  let url;
  try { url = new URL(text.trim()); } catch { invalid(); }
  if (url.protocol !== 'otpauth-migration:' || url.hostname !== 'offline' || !['', '/'].includes(url.pathname) || url.username || url.password || url.port || url.hash || url.searchParams.getAll('data').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'data')) invalid();
  const encoded = url.searchParams.get('data').replace(/ /g, '+');
  if (!encoded || encoded.length > 48000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
  let bytes;
  try { const raw = atob(encoded); if (btoa(raw).replace(/=+$/, '') !== encoded.replace(/=+$/, '')) invalid(); bytes = Uint8Array.from(raw, char => char.charCodeAt(0)); }
  catch { invalid(); }
  try {
    const root = fields(bytes), version = single(root, 2, 0, 0n);
    // Compatible offline payloads use the same account schema in versions
    // 0–2; proto3 may omit the zero-valued version field entirely. Validate
    // every account and batch below instead of requiring an explicit 1.
    if (version > 2n) throw Error(`暂不支持谷歌迁移格式版本 ${version.toString()}，当前支持版本 0、1、2`);
    const size = Number(single(root, 3, 0, 1n)), index = Number(single(root, 4, 0, 0n));
    // Proto3 omits zero-valued batch IDs. An absent ID and an explicit zero
    // identify the same batch; size/index and conflicting-frame checks still apply.
    const id = BigInt.asIntN(32, single(root, 5, 0, 0n)).toString();
    if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(index) || index < 0 || index >= size) invalid();
    const entries = root.get(1) || [];
    if (!entries.length || entries.length > OTP_MAX_ACCOUNTS) invalid();
    const accounts = [], unsupported = [];
    for (const entry of entries) {
      if (entry.wire !== 2) invalid();
      const row = fields(entry.value), issuer = label(single(row, 3, 2), 120);
      let account = label(single(row, 2, 2), 200);
      if (issuer && account.startsWith(`${issuer}:`)) account = account.slice(issuer.length + 1).trim();
      const identity = { issuer: issuer || 'Google Authenticator', account: account || '未命名账号' };
      // Google's unspecified/default enums mean SHA1, six digits and TOTP.
      // Other explicit values must never silently fall back to those defaults.
      const type = single(row, 6, 0, 0n), algorithm = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }[single(row, 4, 0, 0n).toString()];
      const digits = { 0: 6, 1: 6, 2: 8 }[single(row, 5, 0, 0n).toString()];
      if (![0n, 2n].includes(type) || !algorithm || !digits) { unsupported.push({ ...identity, error: type === 1n ? '暂不支持计数型 HOTP' : '不支持的验证码类型、算法或位数' }); continue; }
      // A counter contradicts the time-based configuration, even if the type
      // enum was omitted. Do not turn a HOTP record into a TOTP record.
      const counter = single(row, 7, 0, 0n);
      if (counter !== 0n) { unsupported.push({ ...identity, error: '账号包含计数器，无法作为时间型 TOTP 导入' }); continue; }
      const secret = single(row, 1, 2);
      if (!secret || secret.length < 10 || secret.length > 160) invalid();
      accounts.push(normalizeOtpAccount({ ...identity, secret: Secret.fromHex(Array.from(secret, byte => byte.toString(16).padStart(2, '0')).join('')).base32, algorithm, digits, period: 30 }));
    }
    return { batch: { id, size, index }, accounts, unsupported };
  } finally { bytes.fill(0); }
}

export function addAuthenticatorImport(state, parsed) {
  const current = state || { batch: null, frames: [], accounts: [], unsupported: [] };
  if (current.batch && (!parsed.batch || current.batch.id !== parsed.batch.id || current.batch.size !== parsed.batch.size) || !current.batch && current.accounts.length && parsed.batch) throw Error('请先导入或清空当前批次，再扫描另一批二维码');
  if (parsed.batch && current.frames.includes(parsed.batch.index)) {
    const previous = current.parts?.find(part => part.batch.index === parsed.batch.index);
    if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw Error('同一分片包含不同内容，请清空后重新导出同一批二维码');
    return current;
  }
  if (current.accounts.length + current.unsupported.length + parsed.accounts.length + parsed.unsupported.length > OTP_MAX_ACCOUNTS) throw Error(`一次最多导入 ${OTP_MAX_ACCOUNTS} 个验证器`);
  const keys = new Set(current.accounts.map(item => item.secret));
  const accounts = [...current.accounts];
  for (const item of parsed.accounts) if (!keys.has(item.secret)) { keys.add(item.secret); accounts.push(item); }
  return { parts: parsed.batch ? [...(current.parts || []), parsed] : current.parts || [], batch: parsed.batch || current.batch, frames: parsed.batch ? [...current.frames, parsed.batch.index] : current.frames,
    accounts, unsupported: [...current.unsupported, ...parsed.unsupported] };
}

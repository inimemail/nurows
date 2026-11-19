import crypto from 'node:crypto';
import net from 'node:net';
import express from 'express';

const MAX_IPS = 5000;
const externalPath = id => `/api/external/ip-pools/${encodeURIComponent(id)}/ips`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const route = handler => (req, res, next) => {
  try { handler(req, res, next); }
  catch (error) { if (error.statusCode) res.status(error.statusCode).json({ error: error.message }); else next(error); }
};

// These fields belong to the credential endpoints. Generic pool edits and
// duplication must neither overwrite an existing key nor copy another's key.
export function poolExternalAccess(existing) {
  return {
    externalApiEnabled: existing?.externalApiEnabled !== false,
    externalTokenHash: existing?.externalTokenHash || '',
    externalTokenEnc: existing?.externalTokenEnc || null,
    externalTokenUpdatedAt: existing?.externalTokenUpdatedAt || '',
    externalLastUsedAt: existing?.externalLastUsedAt || '',
    externalLastAddedCount: existing?.externalLastAddedCount || 0
  };
}

export function sanitizePoolExternalAccess(pool) {
  const { externalTokenHash, externalTokenEnc, ...safe } = pool;
  return { ...safe, externalApiEnabled: pool.externalApiEnabled !== false,
    externalApiConfigured: Boolean(externalTokenHash && externalTokenEnc) };
}

function metadata(pool) {
  return {
    externalApiEnabled: pool.externalApiEnabled !== false,
    externalApiConfigured: Boolean(pool.externalTokenHash && pool.externalTokenEnc),
    externalTokenUpdatedAt: pool.externalTokenUpdatedAt || '',
    externalLastUsedAt: pool.externalLastUsedAt || '',
    externalLastAddedCount: pool.externalLastAddedCount || 0
  };
}

function issueToken(pool, deps) {
  const token = crypto.randomBytes(32).toString('base64url');
  pool.externalTokenHash = hash(token);
  pool.externalTokenEnc = deps.encryptSecret(token);
  pool.externalTokenUpdatedAt = new Date().toISOString();
  return token;
}

export function registerPoolExternalManagementRoutes(app, deps) {
  const credential = rotate => route((req, res) => {
    res.set('Cache-Control', 'no-store');
    let token, result;
    deps.updateState(draft => {
      const pool = draft.ipPools.find(item => item.id === req.params.id);
      if (!pool) fail('备用池不存在，请刷新列表', 404);
      if (rotate || !pool.externalTokenEnc || !pool.externalTokenHash) {
        token = issueToken(pool, deps);
        deps.pushAudit(draft, rotate ? 'ipPools.external_rotate' : 'ipPools.external_issue', 'ipPools', pool.id,
          rotate ? '轮换外部调用密钥，旧密钥立即失效' : '生成备用池外部调用密钥', req.auth.username);
      } else {
        token = deps.decryptSecret(pool.externalTokenEnc);
        deps.pushAudit(draft, 'ipPools.external_reveal', 'ipPools', pool.id, '查看外部调用凭证', req.auth.username);
      }
      result = { ok: true, poolId: pool.id, path: externalPath(pool.id), token, access: metadata(pool) };
      return draft;
    });
    res.json(result);
  });
  app.get('/api/ip-pools/:id/external-access', credential(false));
  app.post('/api/ip-pools/:id/external-access/rotate-token', credential(true));
  app.put('/api/ip-pools/:id/external-access', route((req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof req.body?.enabled !== 'boolean') fail('请指定是否启用外部调用');
    let result;
    deps.updateState(draft => {
      const pool = draft.ipPools.find(item => item.id === req.params.id);
      if (!pool) fail('备用池不存在，请刷新列表', 404);
      pool.externalApiEnabled = req.body.enabled;
      deps.pushAudit(draft, 'ipPools.external_toggle', 'ipPools', pool.id,
        req.body.enabled ? '启用备用池外部调用' : '停用备用池外部调用', req.auth.username);
      result = { ok: true, poolId: pool.id, access: metadata(pool) };
      return draft;
    });
    res.json(result);
  }));
}

function canonicalIp(value) {
  if (typeof value !== 'string') return '';
  const family = net.isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes('%')) return '';
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}

export function parseExternalPoolIps(body) {
  let input;
  if (typeof body === 'string') input = body;
  else if (body && typeof body === 'object' && !Array.isArray(body)) {
    const keys = Object.keys(body);
    if (keys.length !== 1 || !['ip', 'ips'].includes(keys[0])) fail('请仅提交 ip 或 ips，不支持覆盖库存或修改备用池');
    input = body[keys[0]];
  }
  let values;
  if (typeof input === 'string') values = input.split(/[\s,，;；]+/).filter(Boolean);
  else if (Array.isArray(input) && input.every(item => typeof item === 'string')) values = input.map(item => item.trim());
  else fail('IP 格式无效，请使用字符串或字符串数组');
  if (!values.length) fail('请至少提交一个 IP 地址');
  if (values.length > MAX_IPS) fail('单次最多提交 5000 个 IP 地址');
  const addresses = [], invalid = [];
  for (const value of values) {
    const address = value.length <= 64 ? canonicalIp(value) : '';
    if (!address) invalid.push(value.slice(0, 64)); else addresses.push(address);
  }
  if (invalid.length) fail(`IP 地址格式不正确：${invalid.slice(0, 10).join('、')}；本次未添加任何 IP`);
  return { received: values.length, addresses: [...new Set(addresses)] };
}

function authorized(pool, token) {
  if (!pool || !token || !/^[a-f0-9]{64}$/.test(pool.externalTokenHash || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(pool.externalTokenHash, 'hex'), Buffer.from(hash(token), 'hex'));
}

function createLimiter(maximum, now) {
  const entries = new Map();
  return key => {
    const time = now();
    let entry = entries.get(key);
    if (!entry || entry.until <= time) {
      if (entries.size >= 10000) {
        for (const [id, value] of entries) if (value.until <= time) entries.delete(id);
        if (entries.size >= 10000) return 60;
      }
      entry = { count: 0, until: time + 60000 }; entries.set(key, entry);
    }
    if (++entry.count > maximum) return Math.max(1, Math.ceil((entry.until - time) / 1000));
    return 0;
  };
}

// Registered before the session guard; only a pool's own Bearer key can append
// to it. Session cookies, probe tokens and URL query credentials are not used.
export function registerPoolExternalPublicRoutes(app, deps) {
  const limitClient = createLimiter(120, deps.now || Date.now);
  const limitPool = createLimiter(60, deps.now || Date.now);
  const throttle = (seconds, res) => {
    res.set('Retry-After', String(seconds));
    res.status(429).json({ error: '调用过于频繁，请稍后重试' });
  };
  const authenticate = route((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const wait = limitClient(req.ip || req.socket?.remoteAddress || 'unknown');
    if (wait) return throttle(wait, res);
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(String(req.headers.authorization || ''));
    const token = match?.[1] || '';
    const pool = deps.readState(['ipPools']).ipPools.find(item => item.id === req.params.id);
    if (!authorized(pool, token)) fail('备用池或调用密钥无效', 401);
    if (pool.externalApiEnabled === false) fail('本备用池的外部调用已停用', 403);
    const poolWait = limitPool(pool.id);
    if (poolWait) return throttle(poolWait, res);
    req.poolExternalToken = token;
    next();
  });
  // Authentication runs before the text parser. JSON is already bounded by the
  // application's parser; this parser applies only to this append endpoint.
  app.post('/api/external/ip-pools/:id/ips', authenticate, express.text({ type: 'text/plain', limit: '256kb' }), route((req, res) => {
    const token = req.poolExternalToken;
    const { received, addresses } = parseExternalPoolIps(req.body);
    let result;
    deps.updateState(draft => {
      const pool = draft.ipPools.find(item => item.id === req.params.id);
      if (!authorized(pool, token)) fail('备用池或调用密钥无效', 401);
      if (pool.externalApiEnabled === false) fail('本备用池的外部调用已停用', 403);
      // Reuse existing assets by canonical address, including older IPv6
      // spellings. Never reset an asset's health/enabled state or active use.
      const members = new Set(pool.assetIds || []);
      const byAddress = new Map();
      for (const asset of draft.ipAssets) {
        const canonical = canonicalIp(asset.address);
        if (canonical && (!byAddress.has(canonical) || members.has(asset.id))) byAddress.set(canonical, asset);
      }
      const added = addresses.filter(address => !members.has(byAddress.get(address)?.id)).length;
      if (members.size + added > MAX_IPS) fail('加入后本池将超过 5000 个 IP，请先清理库存', 409);
      const missing = addresses.filter(address => !byAddress.has(address));
      const imported = deps.importIpAssets(draft, missing, {}, `external-pool:${pool.id}`);
      const createdIds = new Map(missing.map((address, index) => [address, imported.assetIds[index]]));
      pool.assetIds = [...new Set([...members, ...addresses.map(address => byAddress.get(address)?.id || createdIds.get(address))])];
      pool.externalLastUsedAt = new Date().toISOString();
      pool.externalLastAddedCount = added;
      pool.updatedAt = pool.externalLastUsedAt;
      deps.pushAudit(draft, 'ipPools.external_add', 'ipPools', pool.id,
        `外部调用追加 ${added} 个 IP，池内已存在 ${addresses.length - added} 个`, `external-pool:${pool.id}`);
      result = { ok: true, poolId: pool.id, received, total: addresses.length, added,
        existing: addresses.length - added, duplicates: received - addresses.length,
        created: imported.created, reused: addresses.length - imported.created, poolSize: pool.assetIds.length };
      return draft;
    });
    if (result.added) deps.onIpAvailabilityChanged?.({ poolIds: [result.poolId] });
    res.json(result);
  }));
}

import net from 'node:net';

export const IP_USAGE_KEYS = ['dnsGuards', 'dnsBindings', 'ipAssets', 'ipPools', 'ipLeases', 'incidents'];
const RUNNING = new Set(['allocating', 'automating', 'dns_updating', 'verifying', 'stabilizing', 'rolling_back']);

function canonicalIp(value) {
  if (typeof value !== 'string') return '';
  const address = value.trim();
  if (net.isIPv4(address)) return address;
  if (!net.isIPv6(address)) return '';
  try { return new URL(`http://[${address}]/`).hostname.slice(1, -1); }
  catch { return ''; }
}

export function parseIpUsageInput(input) {
  if (typeof input !== 'string') throw new Error('请粘贴需要查询的 IP 地址');
  if (input.length > 512 * 1024) throw new Error('输入内容过长，单次最多查询 5000 个 IP');
  const tokens = input.split(/[\s,，;；]+/).filter(Boolean);
  if (!tokens.length) throw new Error('请至少输入一个 IP 地址');
  const entries = new Map();
  let duplicates = 0;
  for (const token of tokens) {
    const address = canonicalIp(token);
    const key = address || token;
    if (entries.has(key)) { duplicates++; continue; }
    if (entries.size >= 5000) throw new Error('单次最多查询 5000 个 IP，请分批查询');
    entries.set(key, { address: key, status: address ? 'unused' : 'invalid', references: new Map(), pools: new Map() });
  }
  return { entries, duplicates };
}

// Index only requested addresses. Neither remote DNS nor probe jobs are involved.
export function lookupIpUsage(state, input, protectedIps = { ids: new Set(), addresses: new Set() }, now = Date.now()) {
  const { entries, duplicates } = typeof input === 'string' ? parseIpUsageInput(input) : input;
  const assetsById = new Map((state.ipAssets || []).map(asset => [asset.id, asset]));
  const matches = new Map([...entries].filter(([, entry]) => entry.status !== 'invalid'));
  const entryFor = address => {
    if (matches.has(address)) return matches.get(address);
    const entry = entries.get(canonicalIp(address));
    if (entry) matches.set(address, entry);
    return entry;
  };
  const reference = (addresses, item, type, kind, detail) => {
    for (const address of addresses || []) {
      const entry = entryFor(address);
      if (!entry) continue;
      const key = `${type}:${item.id}`;
      const previous = entry.references.get(key);
      if (!previous || kind === 'used' || previous.kind !== 'used') {
        entry.references.set(key, { type, id: item.id, name: item.name || item.targetName || item.domain || '未命名任务',
          domain: item.domain || '', enabled: item.enabled !== false, kind, detail });
      }
      if (kind === 'used' || entry.status !== 'used') entry.status = kind;
    }
  };
  const candidates = (values, item, detail) => reference((values || []).map(value => value.address || assetsById.get(value.assetId)?.address), item, 'guard', 'reserved', detail);
  for (const guard of state.dnsGuards || []) {
    reference(guard.currentValues, guard, 'guard', 'used', '活动解析 IP');
    reference(guard.cycle?.remoteValues, guard, 'guard', 'used', '检查中的远程解析 IP');
    reference(guard.cycle?.rebalanceCommit?.desired, guard, 'guard', 'reserved', '等待 DNS 写入确认');
    candidates(guard.cycle?.candidateAssets, guard, '补位候选 IP');
    candidates(guard.cycle?.rebalanceCommit?.usedAssets, guard, '均衡调整中');
    candidates(guard.cycle?.rebalanceCommit?.returnedAssets, guard, '等待退回备用池');
  }
  for (const binding of state.dnsBindings || []) {
    reference(binding.currentValues, binding, 'binding', 'used', '解析绑定中的 IP');
    reference([...(binding.managedValues || []), ...(binding.backupIps || [])], binding, 'binding', 'reserved', '解析绑定保留 IP');
  }
  const activeIncidents = new Map((state.incidents || []).filter(item => item.executionId || RUNNING.has(item.status)).map(item => [item.id, item]));
  for (const incident of activeIncidents.values()) reference(incident.allocatedIps, incident, 'incident', 'reserved', '故障切换任务占用');
  for (const lease of state.ipLeases || []) {
    if (!['locked', 'active'].includes(lease.status)) continue;
    const expiry = Date.parse(lease.expiresAt);
    if (!activeIncidents.has(lease.incidentId) && Number.isFinite(expiry) && expiry <= now) continue;
    reference([assetsById.get(lease.assetId)?.address], activeIncidents.get(lease.incidentId) || { id: lease.incidentId || lease.id, name: 'IP 分配任务' }, 'incident', 'reserved', 'IP 分配锁定');
  }
  const addPool = (entry, pool) => { if (entry && pool) entry.pools.set(pool.id, { id: pool.id, name: pool.name || '未命名备用池', enabled: pool.enabled !== false }); };
  for (const pool of state.ipPools || []) {
    for (const id of pool.assetIds || []) addPool(entryFor(assetsById.get(id)?.address), pool);
  }
  // Use the same protection set as asset deletion as a conservative fallback.
  for (const address of protectedIps.addresses) {
    const entry = entryFor(address);
    if (entry?.status === 'unused') entry.status = 'reserved';
  }
  for (const id of protectedIps.ids) {
    const entry = entryFor(assetsById.get(id)?.address);
    if (entry?.status === 'unused') entry.status = 'reserved';
  }
  const summary = { total: entries.size, used: 0, reserved: 0, unused: 0, invalid: 0, duplicates };
  const results = [...entries.values()].map(entry => {
    summary[entry.status]++;
    return { ...entry, references: [...entry.references.values()], pools: [...entry.pools.values()] };
  });
  return { results, summary, checkedAt: new Date(now).toISOString() };
}

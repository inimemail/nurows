import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { supportsPoolHealthCheck, POOL_HEALTH_PROBE_VERSION } from '../shared/probe-capabilities.js';

export const POOL_CHECK_LIMIT = 100;
const running = (pool) => pool.healthCheck?.status === 'running';
export const poolProbeOnline = (probe, now = Date.now()) => Boolean(probe && probe.enabled !== false
  && probe.status === 'online' && Number.isFinite(Date.parse(probe.lastSeenAt)) && now - Date.parse(probe.lastSeenAt) <= 90000);

export function poolHealthSummary(job) {
  if (!job) return null;
  const { queue, checks, cursor, dispatchSerial, ...summary } = job;
  return { ...summary, checkingCount: checks?.length ?? job.checkingCount ?? 0 };
}

export function clonePoolHealthPools(pools = []) {
  // Queues and member arrays are immutable during scans; only the small live
  // check window needs a deep copy. Deletion replaces membership arrays.
  return pools.map(pool => ({ ...pool, healthCheck: pool.healthCheck ? {
    ...pool.healthCheck, ...(pool.healthCheck.checks ? { checks: structuredClone(pool.healthCheck.checks) } : {})
  } : pool.healthCheck }));
}

export function poolHealthProbeState(pools = []) {
  return pools.filter(running).map(({ id, healthCheck: job }) => ({ id, healthCheck: {
    id: job.id, status: job.status, probeIds: job.probeIds, checkType: job.checkType, port: job.port,
    timeout: job.timeout, checkRounds: job.checkRounds, attemptsPerRound: job.attemptsPerRound, checks: job.checks
  } }));
}

export function poolHealthTargets(pools, probeId) {
  return (pools || []).filter(running).flatMap(({ id, healthCheck: job }) => !job.probeIds.includes(probeId) ? []
    : (job.checks || []).filter(check => !check.observations[probeId]).map(check => ({
      id: check.id, poolCheckId: id, address: check.address, allowPrivate: false,
      checkType: job.checkType, port: job.port, timeout: job.timeout, checkRounds: job.checkRounds,
      attemptsPerRound: job.attemptsPerRound, interval: 5, checkNowAt: job.id
    })));
}

export function createPoolHealthCheck(pool, input, state, actor, now = Date.now()) {
  if (running(pool)) throw new Error('本池正在检测，请等待完成或先停止');
  if (state.ipPools.filter(running).length >= 3) throw new Error('已有 3 个备用池正在检测，请稍后再试');
  if (input.confirm !== 'check-and-delete-unreachable' || !Array.isArray(input.assetIds)
    || input.assetIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('请确认检测删除范围');
  if (!Array.isArray(input.probeIds) || !input.probeIds.length || input.probeIds.length > 20
    || input.probeIds.some(id => typeof id !== 'string')) throw new Error('请选择 1–20 个在线探针');
  const probeIds = [...new Set(input.probeIds)];
  const probes = new Map(state.probes.map(probe => [probe.id, probe]));
  if (probeIds.some(id => !poolProbeOnline(probes.get(id), now))) throw new Error('所选探针未上线或已停用，请重新选择');
  if (probeIds.some(id => !supportsPoolHealthCheck(probes.get(id)?.agentVersion))) throw new Error(`请先将所选探针升级至 ${POOL_HEALTH_PROBE_VERSION} 或更新版本`);
  const integer = (key, fallback, min, max) => {
    const value = Number(input[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('检测参数超出允许范围');
    return value;
  };
  if (input.checkType && !['ping', 'tcp'].includes(input.checkType)) throw new Error('不支持的检测方式');
  const assets = new Map(state.ipAssets.map(asset => [asset.id, asset]));
  const members = new Set(pool.assetIds || []);
  const requested = [...new Set(input.assetIds)];
  const queue = requested.filter(id => members.has(id) && assets.has(id)).map(id => ({ assetId: id, address: assets.get(id).address }));
  if (!queue.length) throw new Error('本池没有可检测的已保存 IP');
  pool.healthCheck = {
    id: randomUUID(), status: 'running', actor, startedAt: new Date(now).toISOString(), finishedAt: '', message: '',
    checkType: input.checkType === 'tcp' ? 'tcp' : 'ping', port: integer('port', 443, 1, 65535),
    timeout: integer('timeout', 5, 1, 30), checkRounds: integer('checkRounds', 3, 1, 10),
    attemptsPerRound: integer('attemptsPerRound', 3, 1, 10), maxParallel: integer('maxParallel', 50, 1, 100), probeIds,
    total: requested.length, healthyCount: 0, deletedCount: 0, skippedCount: requested.length - queue.length,
    uncertainCount: 0, completedCount: requested.length - queue.length, remainingCount: members.size,
    queue, cursor: 0, checks: []
  };
}

export function finishPoolHealthCheck(pool, status, message, hooks, now = Date.now()) {
  const job = pool.healthCheck;
  if (!job || job.status !== 'running') return;
  job.status = status;
  job.finishedAt = new Date(now).toISOString();
  job.message = message;
  job.remainingCount = pool.assetIds?.length || 0;
  delete job.queue;
  delete job.cursor;
  delete job.checks;
  hooks.audit(pool, job);
}

const canonicalAddress = (address) => net.isIPv6(address) ? new URL(`http://[${address}]/`).hostname : address;

function failureIsNetwork(raw, check) {
  // Agent errors (missing ping, denied permissions, forbidden addresses, etc.)
  // must not become evidence that a remote IP is unreachable.
  return Array.isArray(raw.resolvedAddresses) && raw.resolvedAddresses.some(address => typeof address === 'string'
    && canonicalAddress(address) === canonicalAddress(check.address))
    && /ping failed|timed out|round timeout|connection refused|network is unreachable|no route to host|host is unreachable/i.test(String(raw.error || ''));
}

export function acceptPoolHealthReports(state, probeId, reports, hooks, now = Date.now()) {
  const byCheck = new Map();
  for (const pool of state.ipPools || []) {
    const job = pool.healthCheck;
    if (!running(pool) || !job.probeIds.includes(probeId)) continue;
    for (const check of job.checks) byCheck.set(check.id, { job, check });
  }
  let accepted = false;
  for (const raw of reports) {
    const entry = byCheck.get(raw?.targetId);
    if (!entry || raw.checkMarker !== entry.job.id || entry.check.observations[probeId] || now >= entry.check.deadline) continue;
    const { job, check } = entry;
    const attempts = raw.attempts;
    const success = raw.ok === true && Number.isInteger(attempts) && attempts >= 1 && attempts <= job.checkRounds * job.attemptsPerRound;
    const failed = raw.ok === false && raw.rounds === job.checkRounds && raw.attemptsPerRound === job.attemptsPerRound
      && raw.roundsCompleted === job.checkRounds && attempts === job.checkRounds * job.attemptsPerRound;
    if (!success && !failed) continue;
    check.observations[probeId] = success ? 'healthy' : failureIsNetwork(raw, check) ? 'failed' : 'uncertain';
    accepted = true;
  }
  if (accepted) advancePoolHealthChecks(state, hooks, now);
  return accepted;
}

export function advancePoolHealthChecks(state, hooks, now = Date.now()) {
  const pools = (state.ipPools || []).filter(running);
  if (!pools.length) return;
  const assets = new Map(state.ipAssets.map(asset => [asset.id, asset]));
  const protectedAssets = hooks.protected(state);
  const protectedAddresses = new Set([...protectedAssets.addresses,
    ...[...protectedAssets.ids].map(id => assets.get(id)?.address)].filter(Boolean).map(canonicalAddress));
  const probes = new Map(state.probes.map(probe => [probe.id, probe]));
  const deleted = new Set();
  const eligible = (candidate, members) => {
    const asset = assets.get(candidate.assetId);
    return asset && asset.address === candidate.address && asset.enabled !== false && members.has(asset.id)
      && !deleted.has(asset.id) && !protectedAssets.ids.has(asset.id) && !protectedAddresses.has(canonicalAddress(asset.address))
      && net.isIP(asset.address) && hooks.allowed(asset.address);
  };
  for (const pool of pools) {
    const job = pool.healthCheck;
    const allOnline = job.probeIds.every(id => poolProbeOnline(probes.get(id), now) && supportsPoolHealthCheck(probes.get(id)?.agentVersion));
    const members = new Set(pool.assetIds || []);
    const pending = [];
    for (const check of job.checks) {
      const observations = job.probeIds.map(id => check.observations[id]);
      let result = !eligible(check, members) ? 'skipped' : observations.includes('healthy') ? 'healthy'
        : observations.every(Boolean) && allOnline ? observations.every(value => value === 'failed') ? 'deleted' : 'uncertain' : '';
      if (!result) { pending.push(check); continue; }
      if (result === 'deleted') deleted.add(check.assetId);
      job[`${result}Count`]++;
      job.completedCount++;
    }
    job.checks = pending;
  }
  // One deletion pass per report batch, with occupation rechecked in this same
  // synchronous state transaction. Checking never locks inventory from DNS.
  hooks.remove(state, deleted);
  for (const pool of pools) {
    const job = pool.healthCheck;
    job.remainingCount = pool.assetIds?.length || 0;
    if (job.completedCount === job.total) finishPoolHealthCheck(pool, 'completed', '检测完成', hooks, now);
    else if (job.probeIds.some(id => !poolProbeOnline(probes.get(id), now) || !supportsPoolHealthCheck(probes.get(id)?.agentVersion))) {
      finishPoolHealthCheck(pool, 'interrupted', '探针离线、停用或版本不兼容，未确认的 IP 已保留', hooks, now);
    } else if (job.uncertainCount) {
      finishPoolHealthCheck(pool, 'interrupted', '探针检测异常，未确认的 IP 已保留', hooks, now);
    } else if (job.checks.some(check => now >= check.deadline)) {
      finishPoolHealthCheck(pool, 'interrupted', '等待探针结果超时，未确认的 IP 已保留', hooks, now);
    }
  }
  let available = POOL_CHECK_LIMIT - pools.filter(running).reduce((sum, pool) => sum + pool.healthCheck.checks.length, 0);
  const checkingIds = new Set(pools.filter(running).flatMap(pool => pool.healthCheck.checks.map(check => check.assetId)));
  const membersByPool = new Map(pools.filter(running).map(pool => [pool.id, new Set(pool.assetIds || [])]));
  let serial = Math.max(0, ...pools.map(pool => pool.healthCheck.dispatchSerial || 0));
  while (available > 0) {
    // Give newly queued pools a share of released slots before refilling pools
    // that already hold most of the capacity; rotate ties across report batches.
    const pool = pools.filter(running).filter(pool => pool.healthCheck.cursor < pool.healthCheck.queue.length
      && pool.healthCheck.checks.length < pool.healthCheck.maxParallel).sort((a, b) =>
      a.healthCheck.checks.length - b.healthCheck.checks.length
      || (a.healthCheck.dispatchSerial || 0) - (b.healthCheck.dispatchSerial || 0))[0];
    if (!pool) break;
    const job = pool.healthCheck;
    const members = membersByPool.get(pool.id);
    while (job.cursor < job.queue.length) {
      const candidate = job.queue[job.cursor++];
      if (!eligible(candidate, members) || checkingIds.has(candidate.assetId)) { job.skippedCount++; job.completedCount++; continue; }
      job.checks.push({ ...candidate, id: randomUUID(), observations: {},
        deadline: now + Math.max(60000, (job.checkRounds * job.timeout + job.checkRounds - 1 + 30) * 1000) });
      available--;
      checkingIds.add(candidate.assetId);
      job.dispatchSerial = ++serial;
      break;
    }
    if (!job.checks.length && job.cursor === job.queue.length) finishPoolHealthCheck(pool, 'completed', '检测完成', hooks, now);
  }
}

export function poolHealthSchedule(pools = []) {
  return pools.filter(running).map(({ id, healthCheck: job }) => ({ id, probeIds: job.probeIds,
    pending: job.cursor < job.queue.length, count: job.checks.length, maxParallel: job.maxParallel,
    deadline: Math.min(...job.checks.map(check => check.deadline)) }));
}

export function poolHealthTickNeeded(schedule, probes, now = Date.now()) {
  const online = new Map(probes.map(probe => [probe.id, poolProbeOnline(probe, now) && supportsPoolHealthCheck(probe.agentVersion)]));
  const available = POOL_CHECK_LIMIT - schedule.reduce((sum, job) => sum + job.count, 0);
  return schedule.some(job => job.probeIds.some(id => !online.get(id)) || now >= job.deadline
    || (available > 0 && job.pending && job.count < job.maxParallel));
}

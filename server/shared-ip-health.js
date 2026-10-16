import net from 'node:net';

const MAX_AGE = 30000;
const invalidFailure = /no such file|not found|permission denied|operation not permitted|getaddrinfo|name or service not known|cancelled|canceled|aborted/i;
const addressKey = (value) => net.isIPv6(value) ? new URL(`http://[${value}]/`).hostname : value;
const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value || '');
const windowMs = (config) => Math.min(MAX_AGE, Math.max(0, Number(config.interval ?? 30) * 1000));

function keyFor(address, probeId, config) {
  if (!net.isIP(address) || !probeId) return '';
  return JSON.stringify([addressKey(address), probeId, config.checkType || 'ping',
    config.checkType === 'tcp' ? Number(config.port || 443) : 0,
    Number(config.timeout || 5), Number(config.checkRounds || 3), Number(config.attemptsPerRound || 3), Boolean(config.allowPrivate)]);
}

function complete(evidence, config) {
  if (evidence.ok === true) return Number(evidence.attempts) >= 1;
  const rounds = Number(config.checkRounds || 3), attempts = Number(config.attemptsPerRound || 3);
  return evidence.ok === false && evidence.rounds === rounds && evidence.attemptsPerRound === attempts
    && evidence.roundsCompleted === rounds && evidence.attempts === rounds * attempts;
}

export function validIpHealthEvidence(address, config, raw, { requireAddress = true } = {}) {
  if (!raw || raw.cancelled || !complete(raw, config)) return false;
  if (raw.ok === true) return !raw.successfulAddress || addressKey(raw.successfulAddress) === addressKey(address);
  if (invalidFailure.test(String(raw.error || ''))) return false;
  if (!requireAddress && raw.resolvedAddresses === undefined) return true;
  return Array.isArray(raw.resolvedAddresses) && raw.resolvedAddresses.some((value) => net.isIP(value) && addressKey(value) === addressKey(address));
}

// One process-local, bounded cache shared by DNS and dynamic guards. Evidence
// carries its original timestamp: reads and duplicate deliveries never renew it.
export function createSharedIpHealth({ now = Date.now, limit = 5000 } = {}) {
  const entries = new Map();
  function view(pending = null) {
    const get = (key) => pending?.get(key) || entries.get(key);
    const put = (key, value) => {
      const destination = pending || entries;
      destination.delete(key);
      destination.set(key, value);
      if (!pending) while (entries.size > limit) entries.delete(entries.keys().next().value);
    };
    return {
    get size() { return entries.size; },
    stage() { return view(new Map()); },
    commit() { if (pending) for (const [key, value] of pending) { entries.delete(key); entries.set(key, value); }
      while (entries.size > limit) entries.delete(entries.keys().next().value); },
    remember(address, probeId, config, raw, sampleId, startedAt, time = now()) {
      const key = keyFor(address, probeId, config);
      if (!key || !validIpHealthEvidence(address, config, raw) || !sampleId) return false;
      const start = timestamp(startedAt);
      if (!Number.isFinite(start) || start > time) return false;
      const previous = get(key);
      if (previous && (previous.sampleId === sampleId || previous.startedAt >= start)) return false;
      const evidence = {
        ok: raw.ok, attempts: Number(raw.attempts), rounds: raw.rounds, attemptsPerRound: raw.attemptsPerRound,
        roundsCompleted: raw.roundsCompleted, error: String(raw.error || '').slice(0, 300),
        latencyMs: Number(raw.latencyMs) || 0, checkedAt: new Date(time).toISOString()
      };
      put(key, { evidence, sampleId, startedAt: start, time, expiresAt: time + windowMs(config) });
      return true;
    },
    lookup(address, probeId, config, { time = now(), after = 0 } = {}) {
      const entry = get(keyFor(address, probeId, config));
      if (!entry || time < entry.time || time >= entry.expiresAt || time - entry.time >= windowMs(config)
        || entry.startedAt < after) return null;
      return { ...entry.evidence, shared: true };
    },
    // Re-elected from the live configuration on each poll: deleting/editing a
    // leader cannot leave followers waiting on a stale in-flight reservation.
    deduplicate(targets, probeId) {
      const seen = new Set();
      return targets.filter((target) => {
        if (!target.guardId && !target.dynamicGuardId) return true;
        const key = keyFor(target.address, probeId, target);
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    };
  }
  return view();
}

export function seedDnsGuardHealth(guard, cycle, health, time = Date.now()) {
  if (!health || cycle.finalResults) return false;
  let changed = false;
  for (const check of cycle.checks || []) {
    check.observations ||= {};
    for (const probeId of cycle.expectedProbeIds || []) {
      const evidence = health.lookup(check.address, probeId, guard, { time });
      if (!evidence && check.observations[probeId]?.shared) { delete check.observations[probeId]; changed = true; }
      if (!evidence || evidence.checkedAt === check.observations[probeId]?.checkedAt) continue;
      const previous = check.observations[probeId];
      if (previous && timestamp(previous.checkedAt) > timestamp(evidence.checkedAt)) continue;
      check.observations[probeId] = evidence;
      changed = true;
    }
  }
  return changed;
}

export function seedDynamicGuardHealth(guard, health, time = Date.now()) {
  const cycle = guard.cycle;
  if (!health || !cycle || cycle.result) return false;
  let changed = false;
  for (const probeId of cycle.probeIds || []) {
    const evidence = health.lookup(cycle.address, probeId, guard, { time, after: timestamp(guard.flow?.submittedAt) || 0 });
    if (!evidence && cycle.observations[probeId]?.shared) { delete cycle.observations[probeId]; changed = true; }
    if (!evidence || evidence.checkedAt === cycle.observations[probeId]?.checkedAt) continue;
    const previous = cycle.observations[probeId];
    if (previous && timestamp(previous.checkedAt) > timestamp(evidence.checkedAt)) continue;
    cycle.observations[probeId] = evidence;
    changed = true;
  }
  if (Object.values(cycle.observations).some((item) => item.ok)) cycle.result = 'healthy';
  else if (cycle.probeIds.length && cycle.probeIds.every((id) => cycle.observations[id]?.ok === false)) cycle.result = 'failed';
  return changed;
}

// Called inside the existing report transaction. Only live, assigned cycles
// with the exact marker can publish evidence; orphan/stale reports are ignored.
export function shareGuardHealthReports(state, probeId, reports, health, time = Date.now()) {
  const result = { dns: false, dynamic: false, wakeIds: [] };
  if (!health) return result;
  const producers = new Map();
  for (const guard of state.dnsGuards || []) {
    if (guard.enabled === false || guard.cycle?.finalResults || !guard.cycle?.expectedProbeIds?.includes(probeId)) continue;
    for (const check of guard.cycle.checks || []) producers.set(check.id, { guard, address: check.address, marker: guard.cycle.id, startedAt: guard.cycle.startedAt });
  }
  for (const guard of state.dynamicGuards || []) {
    if (guard.enabled === false || !guard.cycle?.probeIds?.includes(probeId)) continue;
    producers.set(guard.cycle.id, { guard, address: guard.cycle.address, marker: guard.cycle.id, startedAt: guard.cycle.startedAt, dynamic: true });
  }
  const published = new Map();
  for (const raw of reports) {
    const producer = producers.get(raw.targetId);
    if (!producer || raw.checkMarker !== producer.marker) continue;
    const { guard, address } = producer;
    if (!health.remember(address, probeId, guard, raw, `${producer.marker}:${raw.targetId}`, producer.startedAt, time)) continue;
    const domains = new Set();
    if (producer.dynamic) domains.add(guard.domain);
    else for (const source of guard.sources || []) {
      const entry = guard.cycle.sourceCandidates?.[source.id || source.domain] || guard.sourceState?.[source.id || source.domain];
      for (const [side, domain] of [['primary', source.domain], ['backup', source.backupDomain]]) {
        if (domain && (entry?.[side] || []).includes(address)) domains.add(domain);
      }
    }
    if (!published.has(address)) published.set(address, new Set());
    for (const domain of domains) published.get(address).add(domain);
  }
  if (!published.size) return result;
  for (const guard of state.dnsGuards || []) {
    if (guard.enabled === false) continue;
    if (guard.cycle) { result.dns = seedDnsGuardHealth(guard, guard.cycle, health, time) || result.dns; continue; }
    // Only wake consumers that can add a newly healthy source or remove a
    // confirmed failed current IP. Normal healthy checks do not fan out work.
    const current = new Set(guard.currentValues || []);
    const affected = [...published].some(([address, domains]) => {
      const existing = current.has(address);
      if (!existing && !(guard.sources || []).some((source) => domains.has(source.domain) || domains.has(source.backupDomain))) return false;
      const evidence = (guard.probeIds || []).map((id) => health.lookup(address, id, guard, { time }));
      const healthy = evidence.some((item) => item?.ok);
      const failed = evidence.length && evidence.every((item) => item?.ok === false);
      return (existing && failed) || (!existing && healthy);
    });
    if (affected && guard.nextCheckAt) {
      guard.nextCheckAt = '';
      guard.updatedAt = new Date(time).toISOString();
      result.wakeIds.push(guard.id);
    }
  }
  for (const guard of state.dynamicGuards || []) {
    if (guard.enabled !== false) result.dynamic = seedDynamicGuardHealth(guard, health, time) || result.dynamic;
  }
  return result;
}

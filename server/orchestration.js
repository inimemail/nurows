import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { promisify } from 'node:util';
import { v4 as uuidv4 } from 'uuid';

const execFile = promisify(execFileCallback);

const RESOURCE_MAP = {
  probes: 'probes',
  'probe-targets': 'probeTargets',
  'dns-guards': 'dnsGuards',
  'ip-assets': 'ipAssets',
  'ip-pools': 'ipPools',
  'dns-accounts': 'dnsAccounts',
  'dns-zones': 'dnsZones',
  'dns-bindings': 'dnsBindings',
  'failover-policies': 'failoverPolicies',
  'telegram-bots': 'telegramBots'
};

const ACTIVE_INCIDENT_STATES = new Set([
  'observing', 'pending_approval', 'queued', 'waiting_for_ip', 'allocating', 'automating', 'dns_updating', 'verifying', 'stabilizing', 'rolling_back'
]);
const RUNNING_INCIDENT_STATES = new Set(['allocating', 'automating', 'dns_updating', 'verifying', 'stabilizing', 'rolling_back']);
const ACTIVE_DNS_CHANGE_STATES = new Set(['applied', 'recovery_pending']);
const DEFAULT_TARGET_CHECK_ROUNDS = 3;
const DEFAULT_TARGET_ATTEMPTS_PER_ROUND = 3;
const MAX_TARGET_CHECK_ROUNDS = 10;
const MAX_TARGET_ATTEMPTS_PER_ROUND = 10;

const DNS_PROVIDERS = new Set([
  'huawei', 'aliyun', 'tencent', 'dnspod', 'cloudflare', 'godaddy', 'porkbun', 'cloudns', 'callback',
  'aliyun_esa', 'baidu', 'namecheap', 'namesilo', 'dynadot', 'dnsla', 'era', 'tndns', 'gcore',
  'edgeone', 'ns1', 'rainyun', 'dynv6', 'vercel', 'spaceship'
]);
const CALLBACK_PROVIDERS = new Set(['callback', 'aliyun_esa', 'baidu', 'namecheap', 'namesilo', 'dynadot', 'dnsla', 'era', 'tndns', 'gcore', 'edgeone', 'ns1', 'rainyun', 'dynv6', 'vercel', 'spaceship']);
const DNS_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'NS', 'CAA']);
const ALLOCATION_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const DNS_GUARD_HISTORY_LIMIT = 1000;
const DNS_GUARD_MAX_VALUES = 50;
const DNS_GUARD_PREPARE_CONCURRENCY = 10;
const DNS_GUARD_APPLY_CONCURRENCY = 10;
const DNS_ZONE_CACHE_TTL_MS = 10 * 60 * 1000;
// Probe agents poll the server for cycle progress. This is not the guard's
// user-configured interval between complete DNS guard cycles.
const DNS_GUARD_PROBE_POLL_INTERVAL_SECONDS = 5;
const DNS_GUARD_PROVIDER_OPERATION_WAIT_MS = 30000;
const DNS_GUARD_MANUAL_OPERATION_WAIT_MS = 1000;
const DNS_PROVIDER_VERIFY_DELAYS_MS = [0, 500, 1500, 3000];
const dnsZoneCache = new Map();

export function orchestrationDefaults() {
  return {
    probes: [],
    probeTargets: [],
    dnsGuards: [],
    ipAssets: [],
    ipPools: [],
    dnsAccounts: [],
    dnsZones: [],
    dnsBindings: [],
    failoverPolicies: [],
    incidents: [],
    ipLeases: [],
    ipUsageRecords: [],
    dnsChanges: [],
    dnsGuardRuns: [],
    auditLogs: [],
    telegramBots: []
  };
}

export function normalizeOrchestrationState(parsed = {}) {
  const defaults = orchestrationDefaults();
  const normalized = Object.fromEntries(Object.keys(defaults).map((key) => [key, Array.isArray(parsed?.[key]) ? parsed[key] : defaults[key]]));
  normalized.ipPools = normalized.ipPools.map(({ sharingMode, shareLimit, leaseMinutes, cooldownMinutes, alertChatIds, ...pool }) => pool);
  normalized.ipPools = normalized.ipPools.map((pool) => {
    const hasAlertConfig = ['alertEnabled', 'alertThresholds', 'alertBotIds'].some((key) => Object.prototype.hasOwnProperty.call(pool, key));
    const selectedBotIds = cleanIds(pool.alertBotIds, 50);
    return {
      ...pool,
      ...(Object.prototype.hasOwnProperty.call(pool, 'enabled') ? { enabled: pool.enabled !== false } : {}),
      ...(hasAlertConfig ? {
        alertEnabled: Boolean(pool.alertEnabled),
        alertThresholds: normalizeThresholds(pool.alertThresholds ?? [5, 3, 1, 0]),
        alertBotIds: selectedBotIds
      } : {})
    };
  });
  migratePoolAlertBotSelections(normalized);
  normalized.probeTargets = normalized.probeTargets.map(({ quorumMode, quorumCount, failureThreshold, recoveryThreshold, ...target }) => ({
    ...target,
    checkRounds: clampNumber(target.checkRounds, 1, MAX_TARGET_CHECK_ROUNDS, DEFAULT_TARGET_CHECK_ROUNDS),
    attemptsPerRound: clampNumber(target.attemptsPerRound, 1, MAX_TARGET_ATTEMPTS_PER_ROUND, DEFAULT_TARGET_ATTEMPTS_PER_ROUND),
    observations: Object.fromEntries(Object.entries(target.observations || {}).map(([probeId, observation]) => {
      const { failures, successes, ...current } = observation || {};
      return [probeId, current];
    }))
  }));
  normalized.incidents = normalized.incidents.map((incident) => {
    const legacyNoIp = incident.status === 'failed' && /备用\s*IP|备用地址|没有可用 IP/i.test(`${incident.error || ''} ${incident.message || ''}`);
    const current = legacyNoIp ? { ...incident, status: 'waiting_for_ip', message: '等待备用 IP', error: '', executionId: '', recheckRequestedAt: '' } : incident;
    if (current.status !== 'stabilizing') return current;
    return {
      ...current,
      stabilization: {
        expectedAddresses: cleanTexts(current.stabilization?.expectedAddresses, 100),
        bindingIds: cleanIds(current.stabilization?.bindingIds, 100),
        domains: cleanTexts(current.stabilization?.domains, 100),
        dnsWrittenAt: cleanText(current.stabilization?.dnsWrittenAt, 40),
        deadlineAt: cleanText(current.stabilization?.deadlineAt, 40),
        checkMarker: cleanText(current.stabilization?.checkMarker, 100),
        timeoutNotifiedAt: cleanText(current.stabilization?.timeoutNotifiedAt, 40)
      }
    };
  });
  normalized.dnsChanges = normalized.dnsChanges.filter((change) => change && typeof change === 'object').map((change) => ({
    ...change,
    beforeValues: cleanTexts(change.beforeValues, 5000),
    afterValues: cleanTexts(change.afterValues, 5000),
    beforeManagedValues: cleanTexts(change.beforeManagedValues, 5000),
    afterManagedValues: cleanTexts(change.afterManagedValues, 5000)
  }));
  normalized.dnsBindings = normalized.dnsBindings.map((binding) => ({
    ...binding,
    currentValues: cleanTexts(binding.currentValues ?? (isAddressRecord(binding.recordType) ? (binding.managedValues ?? binding.backupIps) : binding.recordValues), 5000)
  }));
  normalized.dnsGuards = normalized.dnsGuards.map((guard) => normalizeDnsGuardState(guard));
  normalized.ipLeases = normalized.ipLeases.filter((lease) => lease.status !== 'released');
  normalized.ipUsageRecords = normalized.ipUsageRecords.slice(0, 5000);
  normalized.dnsGuardRuns = normalized.dnsGuardRuns.slice(0, DNS_GUARD_HISTORY_LIMIT);
  return normalized;
}

export function sanitizeOrchestrationState(state = {}) {
  const domain = normalizeOrchestrationState(state);
  return {
    ...domain,
    probes: domain.probes.map(({ tokenHash, tokenEnc, agentSecretHash, ...item }) => ({
      ...item,
      status: item.status === 'online' && (!item.lastSeenAt || Date.now() - Date.parse(item.lastSeenAt) > 90000) ? 'offline' : item.status
    })),
    dnsAccounts: domain.dnsAccounts.map(({ credentialsEnc, ...item }) => ({ ...item, configured: Boolean(credentialsEnc) })),
    telegramBots: domain.telegramBots.map(({ tokenEnc, tokenHash, ...item }) => ({ ...item, configured: Boolean(tokenEnc) })),
    incidents: domain.incidents.slice(0, 200),
    dnsGuardRuns: domain.dnsGuardRuns.slice(0, DNS_GUARD_HISTORY_LIMIT),
    ipUsageRecords: domain.ipUsageRecords.slice(0, 5000),
    dnsChanges: domain.dnsChanges.slice(0, 300),
    auditLogs: domain.auditLogs.slice(0, 500)
  };
}

export function registerProbePublicRoutes(app, deps) {
  const agentDir = path.join(process.cwd(), 'probe-agent');
  app.get('/probe/agent.py', (_req, res) => res.sendFile(path.join(agentDir, 'nurossh_probe.py')));
  app.get('/probe/install.sh', (_req, res) => res.sendFile(path.join(agentDir, 'install.sh')));
  app.get('/probe/uninstall.sh', (_req, res) => res.sendFile(path.join(agentDir, 'uninstall.sh')));

  app.post('/probe/register', (req, res) => {
    const probeId = cleanId(req.body.probeId);
    const token = String(req.body.token || '');
    let agentSecret = '';
    let found = false;
    if (!deps.allowProbeRegistration(req.ip)) return res.status(429).json({ error: '注册请求过于频繁，请稍后再试' });
    const state = deps.updateState((draft) => {
      const probe = draft.probes.find((item) => item.id === probeId);
      if (!probe || probe.enabled === false || !probe.tokenHash || !safeHashEqual(probe.tokenHash, hashSecret(token))) return draft;
      agentSecret = randomSecret(32);
      probe.agentSecretHash = hashSecret(agentSecret);
      probe.registeredAt = nowIso();
      probe.status = 'online';
      probe.lastSeenAt = nowIso();
      probe.updatedAt = nowIso();
      found = true;
      pushAudit(draft, 'probe.register', 'probe', probe.id, '探针完成注册或重新注册', 'agent');
      return draft;
    });
    if (!found) return res.status(401).json({ error: '注册凭证无效、已使用或已过期' });
    deps.onProbeAvailable?.(probeId, state);
    res.json({ ok: true, probeId, agentSecret, heartbeatInterval: 20 });
  });

  app.get('/probe/config', (req, res) => {
    const auth = authenticateProbe(req, deps.readProbeState?.() || deps.readState());
    if (!auth) return res.status(401).json({ error: '探针凭证无效' });
    const targets = auth.state.probeTargets
      .filter((target) => target.enabled !== false && target.probeIds?.includes(auth.probe.id))
      .map(probeTargetConfiguration);
    const guardChecks = auth.state.dnsGuards.flatMap((guard) => {
      if (guard.enabled === false || !guard.cycle?.expectedProbeIds?.includes(auth.probe.id)) return [];
      return (guard.cycle.checks || [])
        .filter((check) => !dnsGuardCheckReady(check, guard) && !completeGuardEvidence(check.observations?.[auth.probe.id], guard))
        .slice(0, guard.maxParallel)
        .map((check) => ({
          id: check.id,
          guardId: guard.id,
          address: check.address,
          allowPrivate: false,
          checkType: guard.checkType,
          port: guard.port,
          timeout: guard.timeout,
          checkRounds: guard.checkRounds,
          attemptsPerRound: guard.attemptsPerRound,
          interval: DNS_GUARD_PROBE_POLL_INTERVAL_SECONDS,
          checkNowAt: guard.cycle.id
        }));
    });
    // DNS guard cycles are latency-sensitive: start them before ordinary
    // targets so a busy probe cannot make a two-IP guard wait behind a queue.
    const checks = [...guardChecks, ...targets];
    const version = configVersion(checks);
    const unchanged = cleanText(req.query?.version, 100) === version;
    res.json({
      ok: true,
      version,
      probeId: auth.probe.id,
      heartbeatInterval: 20,
      maxConcurrency: auth.probe.maxConcurrency || 100,
      unchanged,
      targets: unchanged ? undefined : checks
    });
  });

  app.post('/probe/heartbeat', (req, res) => {
    const auth = authenticateProbe(req, deps.readProbeState?.() || deps.readState());
    if (!auth) return res.status(401).json({ error: '探针凭证无效' });
    const agentVersion = cleanText(req.body.version, 40);
    const lastSeenAt = Date.parse(auth.probe.lastSeenAt || 0);
    const heartbeatFresh = auth.probe.status === 'online'
      && auth.probe.agentVersion === agentVersion
      && Number.isFinite(lastSeenAt)
      && Date.now() - lastSeenAt < 15000;
    let state = auth.state;
    if (!heartbeatFresh) {
      state = deps.updateState((draft) => {
        const probe = draft.probes.find((item) => item.id === auth.probe.id);
        if (probe) Object.assign(probe, { status: 'online', lastSeenAt: nowIso(), agentVersion, updatedAt: nowIso() });
        return draft;
      });
    }
    deps.onProbeAvailable?.(auth.probe.id, state);
    res.json({ ok: true, serverTime: nowIso() });
  });

  app.post('/probe/report', (req, res) => {
    const auth = authenticateProbe(req, deps.readState());
    if (!auth) return res.status(401).json({ error: '探针凭证无效' });
    const reports = Array.isArray(req.body.results) ? req.body.results.slice(0, 2000) : [];
    const createdIncidentIds = [];
    const retryIncidentIds = [];
    const notifyIncidentIds = [];
    let acceptedGuardReport = false;
    let acceptedTargetReport = false;
    const state = deps.updateState((draft) => {
      const probe = draft.probes.find((item) => item.id === auth.probe.id);
      if (probe) Object.assign(probe, { status: 'online', lastSeenAt: nowIso(), agentVersion: cleanText(req.body.version, 40) || probe.agentVersion, updatedAt: nowIso() });
      const targetById = new Map((draft.probeTargets || []).map((item) => [item.id, item]));
      const guardCheckById = new Map();
      const enabledProbeIds = new Set((draft.probes || []).filter((item) => item.enabled !== false).map((item) => item.id));
      const policyById = new Map((draft.failoverPolicies || []).filter((item) => item.enabled !== false).map((item) => [item.id, item]));
      const activeIncidentTargetIds = new Set((draft.incidents || [])
        .filter((item) => ACTIVE_INCIDENT_STATES.has(item.status) || item.status === 'failed')
        .map((item) => item.targetId));
      for (const guard of draft.dnsGuards || []) {
        if (guard.enabled === false || !guard.cycle?.expectedProbeIds?.includes(auth.probe.id)) continue;
        for (const check of guard.cycle.checks || []) guardCheckById.set(check.id, { guard, check });
      }
      for (const raw of reports) {
        const targetId = cleanId(raw.targetId);
        const candidateTarget = targetById.get(targetId);
        const target = candidateTarget?.probeIds?.includes(auth.probe.id) ? candidateTarget : null;
        if (!target) {
          const guardEntry = guardCheckById.get(targetId);
          if (!guardEntry) continue;
          const { guard, check } = guardEntry;
          acceptedGuardReport = true;
          check.observations ||= {};
          check.observations[auth.probe.id] = normalizeCheckEvidence(raw, guard);
          if (guard.cycle.phase === 'replacement') {
            const completed = Object.values(guard.cycle.candidateResults || {}).filter((result) => result?.ok).length;
            const current = guard.cycle.checks.filter((item) => Object.values(item.observations || {}).some((evidence) => evidence?.ok)).length;
            guard.message = `正在寻找替补：已找到 ${Math.min(guard.cycle.replacementNeeded || 1, completed + current)}/${guard.cycle.replacementNeeded || 1}`;
          } else {
            const settled = guard.cycle.checks.filter((item) => dnsGuardCheckReady(item, guard)).length;
            guard.message = `正在检查活动 IP：${settled}/${guard.cycle.checks.length}`;
          }
          guard.updatedAt = nowIso();
          continue;
        }
        acceptedTargetReport = true;
        target.observations ||= {};
        const ok = Boolean(raw.ok);
        const checkedAt = nowIso();
        const checkRounds = clampNumber(target.checkRounds, 1, MAX_TARGET_CHECK_ROUNDS, DEFAULT_TARGET_CHECK_ROUNDS);
        const attemptsPerRound = clampNumber(target.attemptsPerRound, 1, MAX_TARGET_ATTEMPTS_PER_ROUND, DEFAULT_TARGET_ATTEMPTS_PER_ROUND);
        target.observations[auth.probe.id] = {
          ok,
          latencyMs: clampNumber(raw.latencyMs, 0, 600000, 0),
          error: cleanText(raw.error, 300),
          checkedAt,
          rounds: clampNumber(raw.rounds, 0, checkRounds, 0),
          attemptsPerRound: clampNumber(raw.attemptsPerRound, 0, attemptsPerRound, 0),
          roundsCompleted: clampNumber(raw.roundsCompleted, 0, checkRounds, 0),
          attempts: clampNumber(raw.attempts, 0, checkRounds * attemptsPerRound, 0),
          successfulRound: clampNumber(raw.successfulRound, 0, checkRounds, 0),
          successfulAttempt: clampNumber(raw.successfulAttempt, 0, attemptsPerRound, 0),
          resolvedAddresses: cleanTexts(raw.resolvedAddresses, 20),
          successfulAddress: cleanText(raw.successfulAddress, 80),
          checkMarker: cleanText(raw.checkMarker, 100)
        };
        target.updatedAt = nowIso();
        const transition = evaluateTargetHealth(target, draft.probes, enabledProbeIds);
        target.health = transition.health;
        target.lastCheckAt = checkedAt;
        const stabilizationResult = settleStabilizingIncidentForTarget(draft, target);
        if (stabilizationResult.action === 'retry') retryIncidentIds.push(stabilizationResult.incidentId);
        if (['succeeded', 'timed_out'].includes(stabilizationResult.action)) notifyIncidentIds.push(stabilizationResult.incidentId);
        if (transition.failed && target.policyId) {
          const active = activeIncidentTargetIds.has(target.id);
          const policy = policyById.get(target.policyId);
          if (!active && policy) {
            const incident = createIncident(target, policy, auth.probe.id);
            draft.incidents.unshift(incident);
            activeIncidentTargetIds.add(target.id);
            createdIncidentIds.push(incident.id);
            pushAudit(draft, 'incident.created', 'incident', incident.id, `${target.name} 所有探针完成 ${checkRounds}×${attemptsPerRound} 检查且全部失败`, 'probe');
          }
        }
      }
      draft.incidents = draft.incidents.slice(0, 500);
      return draft;
    });
    for (const incidentId of createdIncidentIds) deps.onIncidentCreated?.(incidentId);
    for (const incidentId of [...new Set(retryIncidentIds)]) deps.onIncidentCreated?.(incidentId);
    for (const incidentId of [...new Set(notifyIncidentIds)]) deps.notifyIncident?.(incidentId);
    const waitingForThisProbe = auth.state.dnsGuards?.some((guard) => guard.enabled !== false
      && guard.status === 'waiting_probe' && !guard.cycle && guard.probeIds?.includes(auth.probe.id));
    if (auth.probe.status !== 'online' || waitingForThisProbe) deps.onProbeAvailable?.(auth.probe.id, state);
    if (acceptedGuardReport) deps.onDnsGuardReport?.(state);
    if (acceptedTargetReport) deps.onProbeReport?.(state);
    res.json({ ok: true, accepted: reports.length, incidents: createdIncidentIds });
  });
}

export function registerOrchestrationRoutes(app, deps) {
  app.get('/api/dns-guards/status', (req, res) => {
    const state = deps.readDnsGuardStatusState?.() || deps.readState();
    res.json({
      dnsGuards: (state.dnsGuards || []).map(normalizeDnsGuardState),
      dnsGuardRuns: (state.dnsGuardRuns || []).slice(0, DNS_GUARD_HISTORY_LIMIT)
    });
  });

  app.post('/api/ip-assets/batch', (req, res) => {
    const addresses = parseIpBatch(req.body.addresses);
    let result;
    const state = deps.updateState((draft) => {
      result = importIpAssets(draft, addresses, req.body, req.auth.username);
      pushAudit(draft, 'ipAssets.batch_create', 'ipAssets', '', `批量导入 ${result.created} 个 IP，复用 ${result.reused} 个`, req.auth.username);
      return draft;
    });
    deps.onIpAvailabilityChanged?.();
    res.json({ ok: true, ...result, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/dns-sources/resolve', asyncRoute(async (req, res) => {
    const domain = normalizeDomain(req.body.domain);
    const recordType = req.body.recordType === 'AAAA' ? 'AAAA' : 'A';
    let addresses = [];
    try { addresses = await resolveDomainAddresses(domain, recordType === 'AAAA' ? 6 : 4); }
    catch (_error) { addresses = []; }
    res.json({ ok: true, domain, recordType, addresses });
  }));

  app.post('/api/orchestration/:resource', asyncRoute(async (req, res) => {
    const key = RESOURCE_MAP[req.params.resource];
    if (!key) return res.status(404).json({ error: '未知资源类型' });
    if (key === 'dnsBindings') {
      const result = await saveDnsBindingConfiguration(req.body, '', deps, req.auth.username);
      return res.json({ ok: true, item: sanitizeResource(key, result.item), state: deps.sanitizeState(result.state, req.auth) });
    }
    let created;
    const state = deps.updateState((draft) => {
      const imported = key === 'ipPools' ? importIpAssets(draft, parseOptionalIpBatch(req.body.newAssetAddresses), req.body.assetDefaults, req.auth.username) : null;
      if (imported) req.body.assetIds = [...new Set([...(req.body.assetIds || []), ...imported.assetIds])];
      created = normalizeResource(key, req.body, null, deps);
      ensureResourceReferences(draft, key, created, deps);
      draft[key].push(created);
      pushAudit(draft, `${key}.create`, key, created.id, `新增 ${created.name || created.address || created.domain || created.id}`, req.auth.username);
      return draft;
    });
    if (key === 'telegramBots') deps.onTelegramChanged?.();
    if (['ipAssets', 'ipPools'].includes(key)) deps.onIpAvailabilityChanged?.();
    if (key === 'dnsGuards') deps.onDnsGuardChanged?.(created.id);
    res.json({ ok: true, item: sanitizeResource(key, created), state: deps.sanitizeState(state, req.auth) });
  }));

  app.put('/api/orchestration/:resource/:id', asyncRoute(async (req, res) => {
    const key = RESOURCE_MAP[req.params.resource];
    if (!key) return res.status(404).json({ error: '未知资源类型' });
    // A pending probe cycle is safe to cancel: saving the rule creates a new
    // cycle with new check IDs, so late reports from the old cycle are ignored.
    // Only block during the short remote DNS read/write critical section.
    if (key === 'dnsGuards') assertDnsGuardProviderIdle(req.params.id, deps, '正在读写远程 DNS，请稍后再编辑规则');
    if (key === 'dnsBindings') {
      const result = await saveDnsBindingConfiguration(req.body, req.params.id, deps, req.auth.username);
      return res.json({ ok: true, item: sanitizeResource(key, result.item), state: deps.sanitizeState(result.state, req.auth) });
    }
    let updated;
    const state = deps.updateState((draft) => {
      const item = draft[key].find((entry) => entry.id === req.params.id);
      if (!item) throw new Error('记录不存在');
      const imported = key === 'ipPools' ? importIpAssets(draft, parseOptionalIpBatch(req.body.newAssetAddresses), req.body.assetDefaults, req.auth.username) : null;
      if (imported) req.body.assetIds = [...new Set([...(req.body.assetIds || []), ...imported.assetIds])];
      updated = normalizeResource(key, req.body, item, deps);
      ensureResourceReferences(draft, key, updated, deps);
      Object.assign(item, updated, { id: item.id, createdAt: item.createdAt });
      if (key === 'ipPools') {
        delete item.sharingMode;
        delete item.shareLimit;
        delete item.leaseMinutes;
        delete item.cooldownMinutes;
      }
      if (key === 'probeTargets') {
        delete item.failureThreshold;
        delete item.recoveryThreshold;
      }
      pushAudit(draft, `${key}.update`, key, item.id, `更新 ${item.name || item.address || item.domain || item.id}`, req.auth.username);
      return draft;
    });
    if (key === 'telegramBots') deps.onTelegramChanged?.();
    if (['ipAssets', 'ipPools'].includes(key)) deps.onIpAvailabilityChanged?.();
    if (key === 'dnsGuards') deps.onDnsGuardChanged?.(updated.id);
    res.json({ ok: true, item: sanitizeResource(key, updated), state: deps.sanitizeState(state, req.auth) });
  }));

  app.delete('/api/orchestration/:resource/:id', asyncRoute(async (req, res) => {
    const key = RESOURCE_MAP[req.params.resource];
    if (!key) return res.status(404).json({ error: '未知资源类型' });
    if (key === 'dnsGuards') assertDnsGuardIdle(req.params.id, deps, '守护检查正在执行，请结束后再删除');
    const state = deps.updateState((draft) => {
      ensureNotReferenced(draft, key, req.params.id);
      draft[key] = draft[key].filter((entry) => entry.id !== req.params.id);
      if (key === 'telegramBots') {
        for (const pool of draft.ipPools) pool.alertBotIds = (pool.alertBotIds || []).filter((id) => id !== req.params.id);
      }
      pushAudit(draft, `${key}.delete`, key, req.params.id, '删除记录', req.auth.username);
      return draft;
    });
    if (key === 'telegramBots') deps.onTelegramChanged?.();
    if (key === 'dnsGuards') deps.onDnsGuardChanged?.();
    res.json({ ok: true, state: deps.sanitizeState(state, req.auth) });
  }));

  app.post('/api/ip-leases/:id/release', (req, res) => {
    const state = deps.updateState((draft) => {
      const lease = draft.ipLeases.find((item) => item.id === req.params.id);
      if (!lease) throw new Error('租约不存在');
      draft.ipLeases = draft.ipLeases.filter((item) => item.id !== lease.id);
      pushAudit(draft, 'ip_lease.release', 'ipLease', lease.id, '手动释放备用 IP', req.auth.username);
      return draft;
    });
    res.json({ ok: true, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/probes/:id/rotate-token', (req, res) => {
    const token = randomSecret(24);
    let probe;
    const state = deps.updateState((draft) => {
      probe = draft.probes.find((item) => item.id === req.params.id);
      if (!probe) throw new Error('探针不存在');
      probe.tokenHash = hashSecret(token);
      probe.tokenEnc = deps.encryptSecret(token);
      probe.tokenExpiresAt = '';
      probe.tokenUsedAt = '';
      probe.agentSecretHash = '';
      probe.status = 'pending';
      probe.updatedAt = nowIso();
      pushAudit(draft, 'probe.rotate_token', 'probe', probe.id, '轮转探针注册令牌并使旧令牌失效', req.auth.username);
      return draft;
    });
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const publicProto = forwardedProto === 'https' || req.secure || (!isLocalRequestHost(req.get('host')) && forwardedProto !== 'http') ? 'https' : 'http';
    const baseUrl = `${publicProto}://${req.get('host')}`;
    res.json({
      ok: true,
      installCommand: `curl -fsSL '${baseUrl}/probe/install.sh' | sudo bash -s -- '${baseUrl}' '${probe.id}' '${token}'`,
      uninstallCommand: `curl -fsSL ${baseUrl}/probe/uninstall.sh | sudo bash`,
      state: deps.sanitizeState(state, req.auth)
    });
  });

  app.get('/api/probes/:id/install-command', (req, res) => {
    let token = '';
    const state = deps.updateState((draft) => {
      const probe = draft.probes.find((item) => item.id === req.params.id);
      if (!probe) throw new Error('探针不存在');
      if (probe.tokenEnc) token = deps.decryptSecret(probe.tokenEnc);
      if (!token) {
        token = randomSecret(24);
        probe.tokenHash = hashSecret(token);
        probe.tokenEnc = deps.encryptSecret(token);
        probe.updatedAt = nowIso();
        pushAudit(draft, 'probe.issue_token', 'probe', probe.id, '生成探针长期注册令牌', req.auth.username);
      }
      return draft;
    });
    const probe = state.probes.find((item) => item.id === req.params.id);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const publicProto = forwardedProto === 'https' || req.secure || (!isLocalRequestHost(req.get('host')) && forwardedProto !== 'http') ? 'https' : 'http';
    const baseUrl = `${publicProto}://${req.get('host')}`;
    res.json({
      ok: true,
      installCommand: `curl -fsSL '${baseUrl}/probe/install.sh' | sudo bash -s -- '${baseUrl}' '${probe.id}' '${token}'`,
      uninstallCommand: `curl -fsSL '${baseUrl}/probe/uninstall.sh' | sudo bash`
    });
  });

  app.post('/api/probes/:id/revoke', (req, res) => {
    const state = deps.updateState((draft) => {
      const probe = draft.probes.find((item) => item.id === req.params.id);
      if (!probe) throw new Error('探针不存在');
      Object.assign(probe, { enabled: false, status: 'revoked', tokenHash: '', tokenEnc: null, agentSecretHash: '', updatedAt: nowIso() });
      pushAudit(draft, 'probe.revoke', 'probe', probe.id, '吊销探针凭证', req.auth.username);
      return draft;
    });
    res.json({ ok: true, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/dns-guards/:id/check-now', (req, res) => {
    assertDnsGuardIdle(req.params.id, deps, '守护检查正在执行，请稍后再试');
    const state = deps.updateState((draft) => {
      const guard = draft.dnsGuards.find((item) => item.id === req.params.id);
      if (!guard) throw new Error('DNS 守护任务不存在');
      guard.nextCheckAt = '';
      guard.cycle = null;
      guard.status = 'queued';
      guard.message = '等待立即检查';
      guard.updatedAt = nowIso();
      return draft;
    });
    deps.onDnsGuardChanged?.(req.params.id);
    res.json({ ok: true, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/dns-guards/:id/sync', asyncRoute(async (req, res) => {
    const result = await syncDnsGuardRemote(req.params.id, deps, req.auth.username);
    res.json({ ok: true, ...result, state: deps.sanitizeState(result.state, req.auth) });
  }));

  app.put('/api/dns-guards/:id/remote-values', asyncRoute(async (req, res) => {
    const result = await writeDnsGuardRemoteValues(req.params.id, req.body, deps, req.auth.username);
    deps.onDnsGuardChanged?.(req.params.id);
    res.json({ ok: true, ...result, state: deps.sanitizeState(result.state, req.auth) });
  }));

  app.get('/api/dns-accounts/:id/credentials', (req, res) => {
    const account = deps.readState().dnsAccounts.find((item) => item.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'DNS 账号不存在' });
    const credentials = decryptCredentials(account, deps);
    deps.updateState((draft) => {
      pushAudit(draft, 'dns_account.reveal', 'dnsAccount', account.id, '查看 DNS 账号凭证', req.auth.username);
      return draft;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, credentials });
  });

  app.get('/api/telegram-bots/:id/token', (req, res) => {
    const bot = deps.readState().telegramBots.find((item) => item.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'Telegram 机器人不存在' });
    if (!bot.tokenEnc) return res.status(404).json({ error: '机器人尚未配置 Token' });
    const token = deps.decryptSecret(bot.tokenEnc);
    deps.updateState((draft) => {
      pushAudit(draft, 'telegram_bot.reveal', 'telegramBot', bot.id, '查看 Telegram Bot Token', req.auth.username);
      return draft;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, token });
  });

  app.post('/api/dns-accounts/:id/test', asyncRoute(async (req, res) => {
    const state = deps.readState();
    const account = state.dnsAccounts.find((item) => item.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'DNS 账号不存在' });
    const credentials = decryptCredentials(account, deps);
    const result = await testDnsAccount(account, credentials);
    const next = deps.updateState((draft) => {
      const item = draft.dnsAccounts.find((entry) => entry.id === account.id);
      if (item) Object.assign(item, { status: 'healthy', lastTestAt: nowIso(), lastError: '' });
      pushAudit(draft, 'dns_account.test', 'dnsAccount', account.id, 'DNS 账号连接测试成功', req.auth.username);
      return draft;
    });
    res.json({ ok: true, result, state: deps.sanitizeState(next, req.auth) });
  }));

  app.post('/api/dns-bindings/:id/sync', asyncRoute(async (req, res) => {
    const result = await syncDnsBinding(req.params.id, deps, req.auth.username);
    res.json({ ok: true, ...result, state: deps.sanitizeState(result.state, req.auth) });
  }));

  app.post('/api/probe-targets/:id/check-now', (req, res) => {
    const state = deps.updateState((draft) => {
      const target = draft.probeTargets.find((item) => item.id === req.params.id);
      if (!target) throw new Error('检查目标不存在');
      target.checkNowAt = nowIso();
      target.updatedAt = nowIso();
      pushAudit(draft, 'probe_target.check_now', 'probeTarget', target.id, '请求立即检查', req.auth.username);
      return draft;
    });
    res.json({ ok: true, state: deps.sanitizeState(state, req.auth) });
  });

  app.delete('/api/incidents/:id', (req, res) => {
    let removed = false;
    const state = deps.updateState((draft) => {
      const incident = draft.incidents.find((item) => item.id === req.params.id);
      if (!incident) throw new Error('故障事件不存在');
      if (incident.executionId || RUNNING_INCIDENT_STATES.has(incident.status)) throw new Error('事件正在执行，结束后才能删除');
      draft.ipLeases = draft.ipLeases.filter((lease) => lease.incidentId !== incident.id);
      draft.incidents = draft.incidents.filter((item) => item.id !== incident.id);
      pushAudit(draft, 'incident.delete', 'incident', incident.id, `删除故障事件 ${incident.targetName || incident.id}`, req.auth.username);
      removed = true;
      return draft;
    });
    res.json({ ok: true, removed, state: deps.sanitizeState(state, req.auth) });
  });

  app.delete('/api/incidents', (req, res) => {
    let removed = 0;
    let kept = 0;
    const state = deps.updateState((draft) => {
      const removableIds = new Set(draft.incidents
        .filter((item) => !item.executionId && !RUNNING_INCIDENT_STATES.has(item.status))
        .map((item) => item.id));
      removed = removableIds.size;
      kept = draft.incidents.length - removed;
      draft.ipLeases = draft.ipLeases.filter((lease) => !removableIds.has(lease.incidentId));
      draft.incidents = draft.incidents.filter((item) => !removableIds.has(item.id));
      pushAudit(draft, 'incident.clear', 'incident', '', `清理 ${removed} 条故障事件，保留 ${kept} 条执行中事件`, req.auth.username);
      return draft;
    });
    res.json({ ok: true, removed, kept, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/incidents/:id/execute', (req, res) => {
    const state = deps.updateState((draft) => {
      const incident = draft.incidents.find((item) => item.id === req.params.id);
      if (!incident) throw new Error('故障事件不存在');
      if (!['pending_approval', 'failed', 'observing'].includes(incident.status)) throw new Error('当前状态不能执行');
      incident.status = 'queued';
      incident.updatedAt = nowIso();
      pushAudit(draft, 'incident.execute', 'incident', incident.id, '批准并执行故障编排', req.auth.username);
      return draft;
    });
    deps.runIncident?.(req.params.id, req.auth.encryptionKey);
    res.json({ ok: true, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/incidents/:id/rollback', asyncRoute(async (req, res) => {
    const result = await rollbackIncident(req.params.id, deps, req.auth.username);
    res.json({ ok: true, ...result, state: deps.sanitizeState(deps.readState(), req.auth) });
  }));
}

export async function syncDnsBinding(bindingId, deps, actor = 'system') {
  const state = deps.readState();
  const binding = state.dnsBindings.find((item) => item.id === bindingId);
  if (!binding) throw new Error('解析绑定不存在');
  const account = state.dnsAccounts.find((item) => item.id === binding.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 账号不可用');
  const credentials = decryptCredentials(account, deps);
  const { zone, normalizedBinding } = await resolveManagedDnsZone(state, account, credentials, binding);
  const remote = await getDnsRecord(account, credentials, zone, withoutProviderRecordIds(normalizedBinding));
  const values = normalizeDnsRecordValues(remote.values, binding.recordType);
  const next = deps.updateState((draft) => {
    const item = draft.dnsBindings.find((entry) => entry.id === binding.id);
    if (!item) throw new Error('解析绑定已被删除');
    const providerRecordIds = cleanTexts(remote.recordIds || (remote.recordId ? [remote.recordId] : []), 500);
    Object.assign(item, {
      ...(isAddressRecord(item.recordType) ? { backupIps: values, currentValues: values, managedValues: values } : { recordValues: values, currentValues: values }),
      recordName: normalizedBinding.recordName,
      providerRecordId: providerRecordIds[0] || '',
      providerRecordIds,
      lastSyncAt: nowIso(),
      lastSyncError: '',
      updatedAt: nowIso()
    });
    pushAudit(draft, 'dns.pull', 'dnsBinding', binding.id, `${binding.domain} 从服务商读取 ${values.length} 个记录值`, actor);
    return draft;
  });
  return { values, layout: dnsRecordLayout(account.provider), direction: 'remote_to_local', state: next };
}

export async function syncDnsGuardRemote(guardId, deps, actor = 'system') {
  const current = deps.readState().dnsGuards.find((item) => item.id === guardId);
  if (!current) throw new Error('DNS 守护任务不存在');
  return withDnsGuardProviderOperation(
    guardId,
    () => syncDnsGuardRemoteLocked(guardId, deps, actor),
    DNS_GUARD_MANUAL_OPERATION_WAIT_MS
  );
}

async function resolveDnsGuardRecord(state, guard, account, credentials, deps, ignoreRecordIds = false) {
  const resolveDnsBinding = deps.resolveDnsBinding || resolveManagedDnsZone;
  const readDnsRecord = deps.readDnsRecord || getDnsRecord;
  const binding = guardBinding(guard);
  let resolved = await resolveDnsBinding(state, account, credentials, binding);
  try {
    const remote = await readDnsRecord(
      account,
      credentials,
      resolved.zone,
      ignoreRecordIds ? withoutProviderRecordIds(resolved.normalizedBinding) : resolved.normalizedBinding
    );
    return { ...resolved, remote };
  } catch (error) {
    if (!binding.zoneName || Number(error?.providerStatus) !== 404 || deps.resolveDnsBinding) throw error;
    dnsZoneCache.delete(`${account.id}:${account.provider}`);
    const discoveryBinding = { ...binding, zoneName: '', providerZoneId: '' };
    resolved = await resolveManagedDnsZone(state, account, credentials, discoveryBinding);
    const remote = await readDnsRecord(
      account,
      credentials,
      resolved.zone,
      ignoreRecordIds ? withoutProviderRecordIds(resolved.normalizedBinding) : resolved.normalizedBinding
    );
    return { ...resolved, remote };
  }
}

async function syncDnsGuardRemoteLocked(guardId, deps, actor) {
  const state = deps.readState();
  const guard = state.dnsGuards.find((item) => item.id === guardId);
  if (!guard) throw new Error('DNS 守护任务不存在');
  const account = state.dnsAccounts.find((item) => item.id === guard.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 账号不可用');
  const credentials = decryptCredentials(account, deps);
  const { zone, normalizedBinding, remote } = await resolveDnsGuardRecord(state, guard, account, credentials, deps, true);
  const values = filterAddressFamily(remote.values, guard.recordType).slice(0, DNS_GUARD_MAX_VALUES);
  const providerRecordIds = cleanTexts(remote.recordIds || (remote.recordId ? [remote.recordId] : []), 500);
  const next = deps.updateState((draft) => {
    const item = draft.dnsGuards.find((entry) => entry.id === guard.id);
    if (!item) throw new Error('DNS 守护任务已被删除');
    Object.assign(item, {
      currentValues: values,
      ownedValues: (item.ownedValues || []).filter((address) => values.includes(address)),
      sourceOwnedValues: (item.sourceOwnedValues || []).filter((address) => values.includes(address)),
      providerRecordId: providerRecordIds[0] || '',
      providerRecordIds,
      zoneName: zone.name,
      providerZoneId: zone.providerZoneId || '',
      updatedAt: nowIso()
    });
    pushAudit(draft, 'dnsGuard.pull', 'dnsGuard', guard.id, `${guard.domain} 从服务商读取 ${values.length} 个 IP`, actor);
    return draft;
  });
  return { values, direction: 'remote_to_local', state: next };
}

export async function writeDnsGuardRemoteValues(guardId, input, deps, actor = 'system') {
  const current = deps.readState().dnsGuards.find((item) => item.id === guardId);
  if (!current) throw new Error('DNS 守护任务不存在');
  dnsGuardPreparationVersions.set(guardId, (dnsGuardPreparationVersions.get(guardId) || 0) + 1);
  return withDnsGuardProviderOperation(
    guardId,
    () => writeDnsGuardRemoteValuesLocked(guardId, input, deps, actor),
    DNS_GUARD_MANUAL_OPERATION_WAIT_MS
  );
}

async function withDnsGuardProviderOperation(guardId, operation, waitMs = DNS_GUARD_PROVIDER_OPERATION_WAIT_MS) {
  await acquireDnsGuardProvider(guardId, waitMs);
  try {
    return await operation();
  } finally {
    dnsGuardProviderRuntime.delete(guardId);
  }
}

async function acquireDnsGuardProvider(guardId, waitMs) {
  const deadline = Number.isFinite(waitMs) ? Date.now() + waitMs : Number.POSITIVE_INFINITY;
  while (dnsGuardProviderRuntime.has(guardId)) {
    if (Date.now() >= deadline) {
      const error = new Error('守护任务正在读写远程 DNS，请稍后再试');
      error.statusCode = 409;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  dnsGuardProviderRuntime.add(guardId);
}

async function writeDnsGuardRemoteValuesLocked(guardId, input, deps, actor) {
  const state = deps.readState();
  const guard = state.dnsGuards.find((item) => item.id === guardId);
  if (!guard) throw new Error('DNS 守护任务不存在');
  const values = normalizeGuardRemoteValues(input.values, guard.recordType);
  const expectedValues = Array.isArray(input.expectedValues) ? normalizeGuardRemoteValues(input.expectedValues, guard.recordType) : null;
  const account = state.dnsAccounts.find((item) => item.id === guard.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 账号不可用');
  const credentials = decryptCredentials(account, deps);
  const writeDnsRecord = deps.writeDnsRecord || updateDnsRecord;
  const readDnsRecord = deps.readDnsRecord || getDnsRecord;
  const { zone, normalizedBinding, remote } = await resolveDnsGuardRecord(state, guard, account, credentials, deps, true);
  const beforeValues = filterAddressFamily(remote.values, guard.recordType).slice(0, DNS_GUARD_MAX_VALUES);
  if (expectedValues && !sameStringSet(beforeValues, expectedValues)) {
    const error = new Error('远程 IP 已发生变化，请重新读取后再保存');
    error.statusCode = 409;
    throw error;
  }
  const providerBinding = {
    ...normalizedBinding,
    providerRecordId: remote.recordId ? String(remote.recordId) : '',
    providerRecordIds: cleanTexts(remote.recordIds || (remote.recordId ? [remote.recordId] : []), 500)
  };
  const replacement = await replaceDnsRecordSafely({
    account, credentials, zone, binding: providerBinding, beforeValues, afterValues: values,
    recordType: guard.recordType, readDnsRecord, writeDnsRecord,
    verificationMode: account.provider === 'huawei' ? 'provider_ack' : 'tolerant'
  });
  const providerRecordIds = replacement.recordIds;
  const verificationPending = replacement.verificationPending;
  const savedAt = nowIso();
  const committedValues = verificationPending ? beforeValues : values;
  const removed = new Set(beforeValues.filter((address) => !committedValues.includes(address)));
  const next = deps.updateState((draft) => {
    const item = draft.dnsGuards.find((entry) => entry.id === guard.id);
    if (!item) throw new Error('DNS 守护任务已被删除');
    const sourceState = structuredClone(item.sourceState || {});
    for (const source of item.sources || []) {
      const key = source.id || source.domain;
      const current = sourceState[key];
      if (!current) continue;
      const sourceValues = [...cleanTexts(current.primary, 500), ...cleanTexts(current.backup, 500), ...cleanTexts(current.cached, 500)];
      if (sourceValues.some((address) => removed.has(address))) current.pending = true;
    }
    const expectedProbeIds = activeDnsGuardProbeIds(item, draft);
    const verifiedCycle = !verificationPending && committedValues.length && expectedProbeIds.length
      ? createDnsGuardRemoteCycle(item, expectedProbeIds, committedValues, zone, normalizedBinding, providerRecordIds)
      : null;
    Object.assign(item, {
      currentValues: committedValues,
      ownedValues: (item.ownedValues || []).filter((address) => committedValues.includes(address)),
      sourceOwnedValues: (item.sourceOwnedValues || []).filter((address) => committedValues.includes(address)),
      sourceState,
      providerRecordId: providerRecordIds?.[0] || '',
      providerRecordIds: providerRecordIds || [],
      zoneName: zone.name,
      providerZoneId: zone.providerZoneId || '',
      cycle: verifiedCycle,
      status: verifiedCycle ? 'checking' : 'queued',
      message: verificationPending
        ? '写入请求已提交，等待后台确认远程 IP'
        : (verifiedCycle ? `正在检查活动 IP：0/${committedValues.length}` : '远程 IP 已更新，等待检查并修复'),
      nextCheckAt: verifiedCycle ? addSeconds(item.interval) : '',
      lastError: verificationPending ? cleanText(replacement.verificationError, 500) : '',
      updatedAt: savedAt
    });
    if (!verificationPending) {
      draft.dnsChanges.unshift({ id: uuidv4(), incidentId: '', guardId: item.id, bindingId: '', accountId: account.id, zoneId: zone.id || '', zoneName: zone.name, providerZoneId: zone.providerZoneId || '', domain: item.domain, recordType: item.recordType, provider: account.provider, beforeValues, afterValues: committedValues, status: 'applied', createdAt: savedAt, rolledBackAt: '' });
      draft.dnsChanges = draft.dnsChanges.slice(0, 3000);
    }
    pushAudit(
      draft,
      verificationPending ? 'dnsGuard.push_pending' : 'dnsGuard.push',
      'dnsGuard', item.id,
      verificationPending
        ? `${item.domain} 手工写入请求结果待确认，已交给后台重新读取`
        : `${item.domain} 手工写入服务商 ${committedValues.length} 个 IP`,
      actor
    );
    return draft;
  });
  return {
    values: committedValues,
    requestedValues: values,
    beforeValues,
    verificationPending,
    direction: 'local_to_remote',
    state: next
  };
}

export async function saveDnsBindingConfiguration(input, bindingId, deps, actor = 'system') {
  const state = deps.readState();
  const existing = bindingId ? state.dnsBindings.find((item) => item.id === bindingId) : null;
  if (bindingId && !existing) throw new Error('解析绑定不存在');
  const candidate = normalizeResource('dnsBindings', input, existing, deps);
  ensureResourceReferences(state, 'dnsBindings', candidate, deps);
  const account = state.dnsAccounts.find((item) => item.id === candidate.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 账号不可用');
  const credentials = decryptCredentials(account, deps);
  const { zone, normalizedBinding } = await resolveManagedDnsZone(state, account, credentials, candidate);
  const remote = await getDnsRecord(account, credentials, zone, withoutProviderRecordIds(normalizedBinding));
  const providerBinding = {
    ...normalizedBinding,
    providerRecordId: remote.recordId ? String(remote.recordId) : '',
    providerRecordIds: cleanTexts(remote.recordIds || (remote.recordId ? [remote.recordId] : []), 500)
  };
  const beforeValues = normalizeDnsRecordValues(remote.values, candidate.recordType);
  const configuredValues = await resolveBindingSources(candidate);
  const desiredValues = dnsBindingDesiredValues(candidate, beforeValues, configuredValues);
  if (!desiredValues.length) throw new Error(`${candidate.domain} 没有可写入的 ${candidate.recordType} 记录值`);

  let providerRecordIds;
  let writeStarted = false;
  try {
    writeStarted = true;
    providerRecordIds = await updateDnsRecord(account, credentials, zone, providerBinding, desiredValues);
    const verified = await getDnsRecord(account, credentials, zone, { ...providerBinding, providerRecordId: providerRecordIds?.[0] || '', providerRecordIds });
    const verifiedValues = normalizeDnsRecordValues(verified.values, candidate.recordType);
    if (!sameStringSet(verifiedValues, desiredValues)) throw new Error('服务商返回的记录值与保存内容不一致');
  } catch (error) {
    if (writeStarted) {
      try { await updateDnsRecord(account, credentials, zone, { ...providerBinding, providerRecordId: providerRecordIds?.[0] || providerBinding.providerRecordId, providerRecordIds: providerRecordIds || providerBinding.providerRecordIds }, beforeValues); }
      catch (rollbackError) { throw new Error(`远端保存失败，且自动恢复失败：${cleanText(error.message, 240)}；${cleanText(rollbackError.message, 240)}`); }
    }
    throw new Error(`远端保存失败，已恢复原记录：${cleanText(error.message, 300)}`);
  }

  const savedAt = nowIso();
  const managedValues = configuredValues.length ? configuredValues : desiredValues;
  Object.assign(candidate, {
    ...(isAddressRecord(candidate.recordType) && !configuredValues.length ? { backupIps: desiredValues } : {}),
    currentValues: desiredValues,
    recordName: normalizedBinding.recordName,
    providerRecordId: providerRecordIds?.[0] || '',
    providerRecordIds: providerRecordIds || [],
    managedValues,
    lastSyncAt: savedAt,
    lastSyncError: '',
    updatedAt: savedAt
  });

  let next;
  try {
    next = deps.updateState((draft) => {
      const current = bindingId ? draft.dnsBindings.find((item) => item.id === bindingId) : null;
      if (bindingId && !current) throw new Error('解析绑定已被删除');
      if (current) Object.assign(current, candidate, { id: current.id, createdAt: current.createdAt });
      else draft.dnsBindings.push(candidate);
      draft.dnsChanges.unshift({ id: uuidv4(), incidentId: '', bindingId: candidate.id, accountId: account.id, zoneId: zone.id || '', zoneName: zone.name, providerZoneId: zone.providerZoneId || '', domain: candidate.domain, recordType: candidate.recordType, provider: account.provider, beforeValues, afterValues: desiredValues, beforeManagedValues: existing?.managedValues || [], afterManagedValues: managedValues, status: 'applied', createdAt: savedAt, rolledBackAt: '' });
      pushAudit(draft, bindingId ? 'dnsBindings.update' : 'dnsBindings.create', 'dnsBindings', candidate.id, `${bindingId ? '更新' : '新增'} ${candidate.name}`, actor);
      pushAudit(draft, 'dns.push', 'dnsBinding', candidate.id, `${candidate.domain} 写入服务商 ${desiredValues.length} 个记录值`, actor);
      return draft;
    });
  } catch (error) {
    try { await updateDnsRecord(account, credentials, zone, { ...providerBinding, providerRecordId: providerRecordIds?.[0] || providerBinding.providerRecordId, providerRecordIds: providerRecordIds || providerBinding.providerRecordIds }, beforeValues); }
    catch (rollbackError) { throw new Error(`本地保存失败，且远端自动恢复失败：${cleanText(error.message, 240)}；${cleanText(rollbackError.message, 240)}`); }
    throw new Error(`本地保存失败，远端已恢复原记录：${cleanText(error.message, 300)}`);
  }
  return { item: next.dnsBindings.find((item) => item.id === candidate.id), values: desiredValues, layout: dnsRecordLayout(account.provider), direction: 'local_to_remote', state: next };
}

export async function runIncidentWorkflow(incidentId, deps, encryptionKey = null) {
  const executionId = randomSecret(18);
  let claimed = false;
  deps.updateState((draft) => {
    const item = draft.incidents.find((entry) => entry.id === incidentId);
    if (!item || !['queued', 'observing', 'waiting_for_ip'].includes(item.status) || item.executionId) return draft;
    Object.assign(item, { executionId, claimedAt: nowIso(), status: 'allocating', message: '正在分配备用 IP', updatedAt: nowIso() });
    claimed = true;
    return draft;
  });
  if (!claimed) return;
  let snapshot = deps.readState();
  let incident = snapshot.incidents.find((item) => item.id === incidentId);
  if (!incident || incident.executionId !== executionId) return;
  const policy = snapshot.failoverPolicies.find((item) => item.id === incident.policyId);
  const target = snapshot.probeTargets.find((item) => item.id === incident.targetId);
  if (!policy || !target) return failIncident(deps, incidentId, '关联策略或目标不存在');
  const initialHealth = evaluateTargetHealth(target, snapshot.probes || []).health;
  if (initialHealth !== 'down') {
    settleIncidentForTargetHealth(deps, incidentId, initialHealth);
    deps.notifyIncident?.(incidentId);
    return;
  }
  try {
    const allocated = allocateIpsForIncident(incidentId, deps);
    // A failover incident must not run against the original host when no
    // replacement address has been allocated. Keep it observable and retry
    // when an eligible asset becomes available.
    if (!allocated.length) {
      deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'waiting_for_ip', message: '等待备用 IP', executionId: '', error: '', recheckRequestedAt: '' }));
      deps.notifyIncident?.(incidentId);
      return;
    }
    const checkedLeaseIds = new Set();
    let currentAllocated = allocated;
    while (currentAllocated.length) {
      deps.updateState((draft) => {
        startIpUsageRecords(draft, incidentId, currentAllocated);
        return updateIncident(draft, incidentId, { allocatedIps: currentAllocated.map((item) => item.address), leaseIds: currentAllocated.map((item) => item.leaseId) });
      });
      const pendingChecks = currentAllocated.filter((item) => !checkedLeaseIds.has(item.leaseId));
      if (!pendingChecks.length) break;
      const checks = await Promise.all(pendingChecks.map(async (item) => ({ ...item, ...(await checkReplacementIp(item.address, deps)) })));
      checks.forEach((item) => checkedLeaseIds.add(item.leaseId));
      const unusable = checks.filter((item) => !item.ok);
      deps.updateState((draft) => {
        const records = draft.ipUsageRecords.filter((record) => record.incidentId === incidentId);
        for (const result of checks) {
          const record = records.find((item) => item.leaseId === result.leaseId);
          if (record) record.preflight = { attempts: result.attempts, ok: result.ok, checkedAt: nowIso(), error: result.error || '' };
        }
        if (unusable.length) discardUnusableIncidentIps(draft, incidentId, unusable);
        return draft;
      });
      if (!unusable.length) break;
      const beforeLeaseIds = new Set(currentAllocated.map((item) => item.leaseId));
      currentAllocated = allocateIpsForIncident(incidentId, deps);
      const added = currentAllocated.some((item) => !beforeLeaseIds.has(item.leaseId));
      if (!added) break;
    }
    const allocatedForExecution = currentAllocated;
    if (!allocatedForExecution.length) {
      deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'waiting_for_ip', message: '等待备用 IP', executionId: '', error: '', allocatedIps: [], leaseIds: [], recheckRequestedAt: '' }));
      deps.notifyIncident?.(incidentId);
      return;
    }
    deps.updateState((draft) => updateIncident(draft, incidentId, { allocatedIps: allocatedForExecution.map((item) => item.address), leaseIds: allocatedForExecution.map((item) => item.leaseId) }));

    snapshot = deps.readState();
    const latestTarget = snapshot.probeTargets.find((item) => item.id === incident.targetId);
    const latestHealth = latestTarget ? evaluateTargetHealth(latestTarget, snapshot.probes || []).health : 'observing';
    if (latestHealth !== 'down') {
      settleIncidentForTargetHealth(deps, incidentId, latestHealth);
      deps.notifyIncident?.(incidentId);
      return;
    }

    if (policy.automationTaskId) {
      deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'automating', message: '正在执行自动化任务' }));
      const hosts = policy.automationHosts === 'target' ? [target.address] : allocatedForExecution.map((item) => item.address);
      const context = buildIncidentContext(incident, target, allocatedForExecution);
      const result = await deps.executeAutomation(policy.automationTaskId, hosts, context, encryptionKey);
      deps.updateState((draft) => updateIncident(draft, incidentId, { automationJobId: result.jobId }));
      await deps.waitAutomation(result.jobId, policy.automationTimeout || 1800);
    }

    snapshot = deps.readState();
    incident = snapshot.incidents.find((item) => item.id === incidentId);
    const bindings = snapshot.dnsBindings.filter((item) => policy.dnsBindingIds?.includes(item.id) && item.enabled !== false);
    if (bindings.length) {
      deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'dns_updating', message: '正在更新 DNS' }));
      for (const binding of bindings) await applyDnsBinding(binding, incident.allocatedIps || [], incidentId, deps);
      deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'verifying', message: '正在验证 DNS 变更' }));
      await verifyDnsBindings(bindings, incidentId, deps);
    }

    deps.updateState((draft) => {
      const currentIncident = draft.incidents.find((item) => item.id === incidentId);
      const currentTarget = draft.probeTargets.find((item) => item.id === currentIncident?.targetId);
      const currentPolicy = draft.failoverPolicies.find((item) => item.id === currentIncident?.policyId);
      const stabilization = createIncidentStabilization(draft, currentIncident, currentTarget, currentPolicy);
      if (stabilization) {
        const requestedAt = nowIso();
        stabilization.checkMarker = requestedAt;
        if (currentTarget) Object.assign(currentTarget, { checkNowAt: stabilization.checkMarker, updatedAt: requestedAt });
        updateIncident(draft, incidentId, { status: 'stabilizing', message: '等待 DNS 生效', error: '', executionId: '', finishedAt: '', stabilization });
        pushAudit(draft, 'incident.stabilizing', 'incident', incidentId, `DNS 已写入，等待探针确认新 IP：${stabilization.expectedAddresses.join(', ')}`, 'system');
        return draft;
      }
      completeIncidentSuccess(draft, incidentId);
      return draft;
    });
    deps.notifyIncident?.(incidentId);
  } catch (error) {
    let failureMessage = error.message || '故障编排失败';
    if (policy.autoRollback !== false) {
      try {
        await rollbackIncident(incidentId, deps, 'system');
      } catch (rollbackError) {
        failureMessage = `${failureMessage}；自动回滚失败：${cleanText(rollbackError.message, 300)}`;
      }
    }
    const current = deps.readState();
    const failedIncident = current.incidents.find((item) => item.id === incidentId);
    const appliedChangeIds = new Set(current.dnsChanges.filter((item) => ACTIVE_DNS_CHANGE_STATES.has(item.status)).map((item) => item.id));
    const keepsDnsChanges = failedIncident?.dnsChangeIds?.some((id) => appliedChangeIds.has(id));
    if (keepsDnsChanges) {
      deps.updateState((draft) => {
        const consumed = consumeIncidentIpAssets(draft, incidentId);
        pushAudit(draft, 'incident.dns_preserved', 'incident', incidentId, `故障流程保留 DNS 变更，已隔离 ${consumed.addresses.length} 个在用 IP`, 'system');
        return draft;
      });
      if (policy.autoRollback === false) failureMessage = `${failureMessage}；已按策略保留 DNS 变更`;
    }
    failIncident(deps, incidentId, failureMessage);
    deps.notifyIncident?.(incidentId);
  }
}

export function retryWaitingIpIncidents(deps, encryptionKey = null, initialState = null) {
  let state = initialState || deps.readState();
  const recovered = state.incidents.filter((incident) => {
    if (!['waiting_for_ip', 'observing', 'pending_approval'].includes(incident.status)) return false;
    const target = state.probeTargets.find((item) => item.id === incident.targetId);
    return target?.health === 'healthy' && targetCompletedCheckSince(target, state.probes || [], incident.recheckRequestedAt);
  });
  if (recovered.length) {
    deps.updateState((draft) => {
      for (const incident of recovered) updateIncident(draft, incident.id, { status: 'recovered', message: '目标已恢复，无需切换', executionId: '', finishedAt: nowIso() });
      return draft;
    });
    state = deps.readState();
  }
  const waiting = state.incidents.filter((item) => {
    const target = state.probeTargets.find((entry) => entry.id === item.targetId);
    const freshRecheck = targetCompletedCheckSince(target, state.probes || [], item.recheckRequestedAt);
    if (item.status === 'observing') return target?.health === 'down';
    return item.status === 'waiting_for_ip' && target?.health === 'down' && freshRecheck && hasAvailableIpForIncident(item, state);
  });
  for (const incident of waiting) runIncidentWorkflow(incident.id, deps, encryptionKey);
  return waiting.length;
}

export function requestWaitingIncidentRechecks(deps) {
  let requested = 0;
  deps.updateState((draft) => {
    const requestedAt = nowIso();
    for (const incident of draft.incidents.filter((item) => item.status === 'waiting_for_ip' && hasAvailableIpForIncident(item, draft))) {
      const target = draft.probeTargets.find((item) => item.id === incident.targetId && item.enabled !== false);
      if (!target) continue;
      target.checkNowAt = requestedAt;
      target.updatedAt = requestedAt;
      Object.assign(incident, { recheckRequestedAt: requestedAt, message: '备用 IP 已就绪，正在确认目标故障', updatedAt: requestedAt });
      requested += 1;
    }
    return draft;
  });
  return requested;
}

const dnsGuardRuntime = new Set();
const dnsGuardProviderRuntime = new Set();
const dnsGuardPreparationVersions = new Map();
const dnsGuardProcessors = new WeakMap();

function assertDnsGuardIdle(guardId, deps, message) {
  const guard = deps.readState().dnsGuards.find((item) => item.id === guardId);
  if (!guard) throw new Error('DNS 守护任务不存在');
  if (!guard.cycle && !dnsGuardRuntime.has(guardId)) return guard;
  const error = new Error(message);
  error.statusCode = 409;
  throw error;
}

function assertDnsGuardProviderIdle(guardId, deps, message) {
  const guard = deps.readState().dnsGuards.find((item) => item.id === guardId);
  if (!guard) throw new Error('DNS 守护任务不存在');
  if (!dnsGuardProviderRuntime.has(guardId)) return guard;
  const error = new Error(message);
  error.statusCode = 409;
  throw error;
}

export async function runDueDnsGuards(deps, requestedId = '') {
  const state = deps.readState();
  const now = Date.now();
  const requestedIds = new Set(Array.isArray(requestedId) ? requestedId : (requestedId ? [requestedId] : []));
  const due = state.dnsGuards.filter((guard) => {
    if (guard.enabled === false || dnsGuardRuntime.has(guard.id)) return false;
    if (requestedIds.size && !requestedIds.has(guard.id)) return false;
    let cycleStale = false;
    if (guard.cycle) {
      const batchCount = Math.max(1, Math.ceil((guard.cycle.checks?.length || 1) / Math.max(1, guard.maxParallel)));
      const batchWindow = guard.checkRounds * guard.timeout * 1000 + Math.max(0, guard.checkRounds - 1) * 1000 + 15000;
      const maxAge = Math.max(120000, batchCount * batchWindow + 60000);
      cycleStale = now - Date.parse(guard.cycle.startedAt || 0) > maxAge;
      if (!cycleStale) return false;
    }
    return cycleStale || !guard.nextCheckAt || Date.parse(guard.nextCheckAt) <= now;
  });
  for (const guard of due) dnsGuardRuntime.add(guard.id);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DNS_GUARD_PREPARE_CONCURRENCY, due.length) }, async () => {
    while (cursor < due.length) {
      const guard = due[cursor];
      cursor += 1;
      try { await prepareDnsGuardCycle(guard.id, deps); }
      catch (error) { recordDnsGuardError(guard.id, error, deps); }
      finally { dnsGuardRuntime.delete(guard.id); }
    }
  });
  await Promise.all(workers);
  return due.length;
}

export function requestWaitingDnsGuardChecks(deps) {
  const requestedIds = [];
  deps.updateState((draft) => {
    for (const guard of draft.dnsGuards) {
      if (guard.enabled === false || guard.status !== 'waiting_ip' || guard.cycle) continue;
      guard.nextCheckAt = '';
      guard.message = '备用 IP 已更新，等待重新确认故障';
      guard.updatedAt = nowIso();
      requestedIds.push(guard.id);
    }
    return draft;
  });
  if (requestedIds.length) runDueDnsGuards(deps, requestedIds).catch(() => {});
  return requestedIds.length;
}

export function requestWaitingDnsGuardProbeChecks(deps, probeId, snapshot = null) {
  const waiting = (snapshot || deps.readState()).dnsGuards.some((guard) => guard.enabled !== false
    && guard.status === 'waiting_probe'
    && !guard.cycle
    && guard.probeIds?.includes(probeId));
  if (!waiting) return 0;
  const requestedIds = [];
  deps.updateState((draft) => {
    for (const guard of draft.dnsGuards) {
      if (guard.enabled === false || guard.status !== 'waiting_probe' || guard.cycle || !guard.probeIds?.includes(probeId)) continue;
      guard.status = 'queued';
      guard.message = '探针已上线，等待检查';
      guard.nextCheckAt = '';
      guard.updatedAt = nowIso();
      requestedIds.push(guard.id);
    }
    return draft;
  });
  if (requestedIds.length) runDueDnsGuards(deps, requestedIds).catch(() => {});
  return requestedIds.length;
}

export function processReadyDnsGuards(deps, initialState = null) {
  const current = dnsGuardProcessors.get(deps);
  if (current) {
    current.rerun = true;
    return current.promise;
  }
  const controller = { rerun: false, promise: null };
  controller.promise = (async () => {
    let processed = 0;
    let stateSnapshot = initialState;
    const attempted = new Set();
    do {
      controller.rerun = false;
      const state = stateSnapshot || deps.readState();
      stateSnapshot = null;
      const ready = state.dnsGuards.filter((guard) => {
        if (guard.enabled === false || !guard.cycle || !dnsGuardCycleReady(guard) || dnsGuardRuntime.has(guard.id)) return false;
        const workId = dnsGuardWorkId(guard);
        if (attempted.has(workId)) return false;
        attempted.add(workId);
        return true;
      });
      let cursor = 0;
      const workers = Array.from({ length: Math.min(DNS_GUARD_APPLY_CONCURRENCY, ready.length) }, async () => {
        while (cursor < ready.length) {
          const guard = ready[cursor];
          cursor += 1;
          dnsGuardRuntime.add(guard.id);
          try { await applyDnsGuardCycle(guard.id, guard.cycle.id, deps); }
          catch (error) { recordDnsGuardError(guard.id, error, deps); }
          finally { dnsGuardRuntime.delete(guard.id); }
        }
      });
      await Promise.all(workers);
      processed += ready.length;
    } while (controller.rerun);
    return processed;
  })().finally(() => {
    if (dnsGuardProcessors.get(deps) === controller) dnsGuardProcessors.delete(deps);
  });
  dnsGuardProcessors.set(deps, controller);
  return controller.promise;
}

function dnsGuardWorkId(guard) {
  const checkIds = (guard.cycle?.checks || []).map((check) => check.id).join(',');
  return `${guard.id}:${guard.cycle?.id || ''}:${guard.cycle?.phase || ''}:${checkIds}`;
}

function dnsGuardPreparationKey(guard) {
  return JSON.stringify({
    accountId: guard.accountId,
    domain: guard.domain,
    recordType: guard.recordType,
    recordLine: guard.recordLine,
    ttl: guard.ttl,
    probeIds: guard.probeIds,
    poolIds: guard.poolIds,
    checkType: guard.checkType,
    port: guard.port,
    timeout: guard.timeout,
    checkRounds: guard.checkRounds,
    attemptsPerRound: guard.attemptsPerRound,
    maxParallel: guard.maxParallel,
    sources: guard.sources,
    pruneStale: guard.pruneStale
  });
}

async function prepareDnsGuardCycle(guardId, deps) {
  let state = deps.readState();
  let guard = state.dnsGuards.find((item) => item.id === guardId && item.enabled !== false);
  if (!guard) return;
  let expectedProbeIds = activeDnsGuardProbeIds(guard, state);
  if (!expectedProbeIds.length) {
    deps.updateState((draft) => updateDnsGuard(draft, guardId, { status: 'waiting_probe', message: '等待负责探针上线', cycle: null, nextCheckAt: addSeconds(guard.interval) }));
    return;
  }
  // Preparation only reads the provider. Keeping it outside the write lock lets
  // an operator manage IPs immediately; the version check below discards a
  // stale read if a manual write starts while this request is in flight.
  const preparationVersion = dnsGuardPreparationVersions.get(guardId) || 0;
  const preparationKey = dnsGuardPreparationKey(guard);
  const account = state.dnsAccounts.find((item) => item.id === guard.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 服务商账号不可用');
  const credentials = decryptCredentials(account, deps);
  const resolved = await resolveDnsGuardRecord(state, guard, account, credentials, deps);
  const before = resolved.remote;
  state = deps.readState();
  guard = state.dnsGuards.find((item) => item.id === guardId && item.enabled !== false);
  if (!guard
    || dnsGuardPreparationKey(guard) !== preparationKey
    || (dnsGuardPreparationVersions.get(guardId) || 0) !== preparationVersion) return;
  expectedProbeIds = activeDnsGuardProbeIds(guard, state);
  if (!expectedProbeIds.length) {
    deps.updateState((draft) => updateDnsGuard(draft, guardId, { status: 'waiting_probe', message: '等待负责探针上线', cycle: null, nextCheckAt: addSeconds(guard.interval) }));
    return;
  }
  const currentValues = filterAddressFamily(before.values, guard.recordType).slice(0, DNS_GUARD_MAX_VALUES);
  const providerRecordIds = cleanTexts(before.recordIds || (before.recordId ? [before.recordId] : []), 500);
  const cycle = createDnsGuardRemoteCycle(guard, expectedProbeIds, currentValues, resolved.zone, resolved.normalizedBinding, providerRecordIds);
  deps.updateState((draft) => updateDnsGuard(draft, guardId, {
    status: 'checking',
    message: currentValues.length ? `正在检查活动 IP：0/${currentValues.length}` : '正在寻找替补',
    currentValues, providerRecordId: providerRecordIds[0] || '', providerRecordIds,
    zoneName: resolved.zone.name, providerZoneId: resolved.zone.providerZoneId || '',
    cycle, lastError: '', nextCheckAt: addSeconds(guard.interval)
  }));
  const prepared = { guard, cycle, currentValues };
  if (prepared && !prepared.currentValues.length) await startDnsGuardReplacement(prepared.guard, prepared.cycle, [], deps);
}

function activeDnsGuardProbeIds(guard, state) {
  // Match ordinary target checks: a registered, enabled probe remains
  // responsible for failures even if a delayed heartbeat temporarily looks stale.
  return (guard.probeIds || []).filter((probeId) => state.probes.some((probe) => probe.id === probeId && probe.enabled !== false && probe.agentSecretHash));
}

function createDnsGuardCheck(address) {
  return { id: cleanId(`guard_${uuidv4()}`), address, observations: {} };
}

function createDnsGuardRemoteCycle(guard, expectedProbeIds, currentValues, zone, normalizedBinding, providerRecordIds = []) {
  const recordIds = cleanTexts(providerRecordIds, 500);
  return {
    id: uuidv4(),
    startedAt: nowIso(),
    phase: 'remote',
    expectedProbeIds,
    remoteValues: currentValues,
    sourceValues: [],
    sourceCandidates: {},
    candidateAssets: [],
    sourceState: structuredClone(guard.sourceState || {}),
    sourceErrors: [],
    zone: { id: zone.id || '', name: zone.name, providerZoneId: zone.providerZoneId || '' },
    normalizedBinding: { recordName: normalizedBinding.recordName, providerRecordId: recordIds[0] || '', providerRecordIds: recordIds },
    checks: currentValues.map(createDnsGuardCheck)
  };
}

async function startDnsGuardReplacement(guard, cycle, failedRemote, deps) {
  const state = deps.readState();
  const sourceResult = await resolveDnsGuardSources(guard, cycle.remoteValues || []);
  if (!deps.readState().dnsGuards.some((item) => item.id === guard.id && item.cycle?.id === cycle.id)) return;
  const candidateAssets = collectDnsGuardPoolCandidates(state, guard, DNS_GUARD_MAX_VALUES);
  const healthyRemote = (cycle.remoteValues || []).filter((address) => !failedRemote.includes(address));
  // maxActiveIps is an upper bound. A repair maintains the pre-check record
  // count instead of filling every healthy task up to that limit.
  const targetCount = Math.max(1, (cycle.remoteValues || []).length);
  const replacementNeeded = Math.max(0, targetCount - healthyRemote.length);
  const excluded = new Set(cycle.remoteValues || []);
  const remainingAddresses = buildDnsGuardCheckAddresses([], sourceResult.values, candidateAssets)
    .filter((address) => !excluded.has(address));
  const batchSize = Math.max(1, guard.maxParallel);
  const batch = remainingAddresses.slice(0, batchSize);
  const replacementCycle = {
    ...cycle,
    startedAt: nowIso(),
    phase: 'replacement',
    failedRemote,
    targetCount,
    replacementNeeded,
    sourceValues: sourceResult.values,
    sourceCandidates: sourceResult.candidates,
    candidateAssets,
    sourceState: sourceResult.state,
    sourceErrors: sourceResult.errors,
    candidateResults: {},
    remainingAddresses: remainingAddresses.slice(batch.length),
    checks: batch.map(createDnsGuardCheck)
  };
  if (!batch.length) {
    let active = false;
    deps.updateState((draft) => {
      const item = draft.dnsGuards.find((entry) => entry.id === guard.id && entry.cycle?.id === cycle.id);
      if (!item) return draft;
      active = true;
      return updateDnsGuard(draft, guard.id, {
        status: 'checking', message: `正在寻找替补：已找到 0/${replacementNeeded}`,
        currentValues: cycle.remoteValues || [], sourceState: sourceResult.state,
        sourceErrors: sourceResult.errors, cycle: replacementCycle, lastError: ''
      });
    });
    if (!active) return;
    const resultByAddress = new Map((cycle.remoteValues || []).map((address) => [address, { ok: !failedRemote.includes(address) }]));
    await finalizeDnsGuardCycle(guard.id, cycle.id, replacementCycle, resultByAddress, deps);
    return;
  }
  deps.updateState((draft) => {
    const item = draft.dnsGuards.find((entry) => entry.id === guard.id && entry.cycle?.id === cycle.id);
    if (!item) return draft;
    return updateDnsGuard(draft, guard.id, {
      status: 'checking',
      message: `正在寻找替补：已找到 0/${replacementNeeded}`,
      currentValues: cycle.remoteValues || [],
      sourceState: sourceResult.state,
      sourceErrors: sourceResult.errors,
      cycle: replacementCycle,
      lastError: ''
    });
  });
}

export async function resolveDnsGuardSources(guard, currentValues, resolveAddresses = resolveDomainAddresses) {
  const family = guard.recordType === 'AAAA' ? 6 : 4;
  const previousState = structuredClone(guard.sourceState || {});
  const state = {};
  const candidates = {};
  const errors = [];
  for (const source of guard.sources || []) {
    const key = source.id || source.domain;
    const previous = previousState[key] || {};
    const domains = { primary: source.domain, backup: source.backupDomain || '' };
    const previousDomains = previous.domains && typeof previous.domains === 'object' ? previous.domains : { primary: source.domain, backup: '' };
    const entry = {
      domains,
      primary: [],
      backup: [],
      activeSide: previous.activeSide === 'backup' && domains.backup ? 'backup' : 'primary',
      pending: Boolean(previous.pending),
      lastError: '',
      checkedAt: nowIso()
    };
    const sourceErrors = [];
    for (const side of ['primary', 'backup']) {
      const domain = domains[side];
      if (!domain) continue;
      const legacyCache = side === 'primary' ? previous.cached : [];
      const cached = previousDomains[side] === domain ? cleanTexts(previous[side] || legacyCache, 500) : [];
      try {
        entry[side] = await resolveAddresses(domain, family);
      } catch (error) {
        const message = `${domain}: ${cleanText(error.message, 120)}`;
        errors.push(message);
        sourceErrors.push(message);
        entry[side] = cached.filter((address) => currentValues.includes(address));
      }
    }
    entry.lastError = sourceErrors.join('；');
    candidates[key] = { primary: entry.primary, backup: entry.backup };
    state[key] = entry;
  }
  const values = roundRobinDnsGuardSourceValues(guard.sources, candidates, DNS_GUARD_MAX_VALUES * 4);
  return { values, candidates, state, errors };
}

export function roundRobinDnsGuardSourceValues(sources, candidates, limit = DNS_GUARD_MAX_VALUES * 4) {
  const groups = (sources || []).flatMap((source) => {
    const item = candidates?.[source.id || source.domain] || {};
    return [cleanTexts(item.primary, 500), cleanTexts(item.backup, 500)];
  });
  const result = [];
  const seen = new Set();
  const maxLength = Math.max(0, ...groups.map((values) => values.length));
  for (let index = 0; index < maxLength && result.length < limit; index += 1) {
    for (const values of groups) {
      const address = values[index];
      if (!address || seen.has(address)) continue;
      seen.add(address);
      result.push(address);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function selectHealthyDnsGuardSources(sources, candidates, sourceState, resultByAddress) {
  const state = structuredClone(sourceState || {});
  const values = [];
  for (const source of sources || []) {
    const key = source.id || source.domain;
    const current = state[key] || { domains: { primary: source.domain, backup: source.backupDomain || '' }, primary: [], backup: [] };
    const sourceCandidates = candidates?.[key] || { primary: current.primary || current.cached || [], backup: current.backup || [] };
    const allCandidates = [...new Set([...cleanTexts(sourceCandidates.primary, 500), ...cleanTexts(sourceCandidates.backup, 500)])];
    const evaluated = allCandidates.filter((address) => resultByAddress.has(address));
    const primary = cleanTexts(sourceCandidates.primary, 500).filter((address) => resultByAddress.get(address)?.ok);
    const backup = cleanTexts(sourceCandidates.backup, 500).filter((address) => resultByAddress.get(address)?.ok);
    if (!primary.length && !backup.length && evaluated.length < allCandidates.length) {
      state[key] = current;
      continue;
    }
    const activeSide = primary.length ? 'primary' : backup.length ? 'backup' : (current.activeSide === 'backup' && source.backupDomain ? 'backup' : 'primary');
    const selected = activeSide === 'backup' ? backup : primary;
    current.activeSide = activeSide;
    current.pending = selected.length === 0;
    if (!selected.length && (sourceCandidates.primary?.length || sourceCandidates.backup?.length)) {
      current.lastError = [current.lastError, '探针检查失败'].filter(Boolean).join('；');
    }
    current.checkedAt = nowIso();
    state[key] = current;
    for (const address of selected) if (!values.includes(address)) values.push(address);
  }
  return { values: values.slice(0, DNS_GUARD_MAX_VALUES), state };
}

export function collectDnsGuardPoolCandidates(state, guard, limit = DNS_GUARD_MAX_VALUES) {
  const result = [];
  const seen = new Set();
  for (const poolId of guard.poolIds || []) {
    const pool = state.ipPools.find((item) => item.id === poolId && item.enabled !== false);
    if (!pool) continue;
    let assets = (pool.assetIds || []).map((id) => state.ipAssets.find((item) => item.id === id)).filter((item) => item?.enabled !== false && item.health !== 'unhealthy' && canAllocateAsset(state, item.id));
    if (pool.selectionMode === 'random') assets = assets.sort(() => Math.random() - 0.5);
    for (const asset of assets) {
      if (seen.has(asset.id) || result.length >= limit) continue;
      if ((guard.recordType === 'AAAA' ? net.isIPv6(asset.address) : net.isIPv4(asset.address))) {
        seen.add(asset.id);
        result.push({ assetId: asset.id, poolId, address: asset.address });
      }
    }
  }
  return result;
}

export function buildDnsGuardCheckAddresses(currentValues, sourceValues, candidateAssets) {
  return [...new Set([
    ...cleanTexts(currentValues, DNS_GUARD_MAX_VALUES),
    ...cleanTexts(sourceValues, DNS_GUARD_MAX_VALUES * 4),
    ...(candidateAssets || []).slice(0, DNS_GUARD_MAX_VALUES).map((item) => item.address)
  ])].slice(0, DNS_GUARD_MAX_VALUES * 6);
}

export function dnsGuardCycleReady(guard) {
  const expected = guard.cycle?.expectedProbeIds || [];
  if (!expected.length || !guard.cycle?.checks?.length) return false;
  if (guard.cycle.phase === 'replacement') {
    const completed = Object.values(guard.cycle.candidateResults || {}).filter((result) => result?.ok).length;
    const current = guard.cycle.checks.filter((check) => Object.values(check.observations || {}).some((item) => item?.ok)).length;
    if (completed + current >= Math.max(1, Number(guard.cycle.replacementNeeded) || 1)) return true;
  }
  return guard.cycle.checks.every((check) => dnsGuardCheckReady(check, guard));
}

export function dnsGuardCheckReady(check, guard) {
  const expected = guard.cycle?.expectedProbeIds || [];
  if (!expected.length) return false;
  const observations = expected.map((probeId) => check?.observations?.[probeId]);
  // One successful probe settles this IP immediately; slow probes no longer block the cycle.
  if (observations.some((evidence) => evidence?.ok && evidence.attempts >= 1)) return true;
  // A failed IP is removable only after every responsible probe completes all failed rounds.
  return observations.every((evidence) => completeGuardEvidence(evidence, guard));
}

export function completeGuardEvidence(evidence, guard) {
  if (!evidence) return false;
  if (evidence.ok) return evidence.attempts >= 1;
  return evidence.rounds === guard.checkRounds && evidence.attemptsPerRound === guard.attemptsPerRound && evidence.roundsCompleted === guard.checkRounds && evidence.attempts === guard.checkRounds * guard.attemptsPerRound;
}

async function applyDnsGuardCycle(guardId, cycleId, deps) {
  const state = deps.readState();
  const guard = state.dnsGuards.find((item) => item.id === guardId && item.cycle?.id === cycleId);
  if (!guard || !dnsGuardCycleReady(guard)) return;
  if (guard.cycle.phase !== 'replacement') {
    const resultByAddress = new Map(guard.cycle.checks.map((check) => [check.address, {
      ok: Object.values(check.observations || {}).some((item) => item.ok),
      observations: check.observations
    }]));
    const failedRemote = (guard.cycle.remoteValues || []).filter((address) => !resultByAddress.get(address)?.ok);
    if (failedRemote.length) {
      await startDnsGuardReplacement(guard, guard.cycle, failedRemote, deps);
      return;
    }
    await finalizeDnsGuardCycle(guardId, cycleId, guard.cycle, resultByAddress, deps);
    return;
  }

  const candidateResults = structuredClone(guard.cycle.candidateResults || {});
  for (const check of guard.cycle.checks) {
    const ok = Object.values(check.observations || {}).some((item) => item?.ok);
    if (ok || dnsGuardCheckReady(check, guard)) candidateResults[check.address] = { ok, observations: check.observations };
  }
  const found = Object.values(candidateResults).filter((result) => result?.ok).length;
  const needed = Math.max(1, Number(guard.cycle.replacementNeeded) || 1);
  if (found < needed && guard.cycle.remainingAddresses?.length) {
    const batchSize = Math.max(1, guard.maxParallel);
    const batch = guard.cycle.remainingAddresses.slice(0, batchSize);
    deps.updateState((draft) => {
      const item = draft.dnsGuards.find((entry) => entry.id === guardId && entry.cycle?.id === cycleId);
      if (!item) return draft;
      Object.assign(item.cycle, {
        startedAt: nowIso(),
        candidateResults,
        remainingAddresses: item.cycle.remainingAddresses.slice(batch.length),
        checks: batch.map(createDnsGuardCheck)
      });
      item.message = `正在寻找替补：已找到 ${found}/${needed}`;
      item.updatedAt = nowIso();
      return draft;
    });
    return;
  }

  const resultByAddress = new Map();
  const failedRemote = guard.cycle.failedRemote || [];
  for (const address of guard.cycle.remoteValues || []) resultByAddress.set(address, { ok: !failedRemote.includes(address) });
  for (const [address, result] of Object.entries(candidateResults)) resultByAddress.set(address, result);
  await finalizeDnsGuardCycle(guardId, cycleId, { ...guard.cycle, candidateResults }, resultByAddress, deps);
}

async function finalizeDnsGuardCycle(guardId, cycleId, cycle, resultByAddress, deps) {
  let state = deps.readState();
  const guard = state.dnsGuards.find((item) => item.id === guardId && item.cycle?.id === cycleId);
  if (!guard) return;
  const remote = cycle.remoteValues || [];
  const failedRemote = cycle.failedRemote || remote.filter((address) => !resultByAddress.get(address)?.ok);
  const healthyRemote = remote.filter((address) => resultByAddress.get(address)?.ok);
  const selectedSources = cycle.phase === 'replacement'
    ? selectHealthyDnsGuardSources(guard.sources, cycle.sourceCandidates, cycle.sourceState, resultByAddress)
    : { values: [], state: structuredClone(guard.sourceState || {}) };
  const healthySources = [...new Set([
    ...(guard.sourceOwnedValues || []).filter((address) => healthyRemote.includes(address)),
    ...selectedSources.values
  ])];
  const staleOwned = cycle.phase !== 'replacement' || guard.pruneStale === false
    ? new Set()
    : new Set((guard.sourceOwnedValues || []).filter((address) => !healthySources.includes(address)));
  const desired = healthyRemote.filter((address) => !staleOwned.has(address));
  const targetCount = cycle.phase === 'replacement' ? Math.max(1, Number(cycle.targetCount) || remote.length || 1) : remote.length;
  for (const address of healthySources) if (!desired.includes(address) && desired.length < targetCount) desired.push(address);
  const usedAssets = [];
  const unusableAssets = [];
  for (const item of cycle.candidateAssets || []) {
    if (desired.includes(item.address)) continue;
    const result = resultByAddress.get(item.address);
    if (result?.ok && desired.length < targetCount) { desired.push(item.address); usedAssets.push(item); }
    else if (result && !result.ok) unusableAssets.push(item);
  }
  const changed = !sameStringSet(remote, desired);
  const account = state.dnsAccounts.find((item) => item.id === guard.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 服务商账号不可用');
  let providerRecordIds = [];
  if (changed) {
    const credentials = decryptCredentials(account, deps);
    const readDnsRecord = deps.readDnsRecord || getDnsRecord;
    const writeDnsRecord = deps.writeDnsRecord || updateDnsRecord;
    const binding = { ...guardBinding(guard), ...(cycle.normalizedBinding || {}) };
    const zone = cycle.zone;
    const writeResult = await withDnsGuardProviderOperation(guardId, async () => {
      const active = deps.readState().dnsGuards.some((item) => item.id === guardId && item.cycle?.id === cycleId);
      if (!active) return { canceled: true, stale: false, recordIds: [] };
      const latest = await readDnsRecord(account, credentials, zone, binding);
      if (!sameStringSet(filterAddressFamily(latest.values, guard.recordType), remote)) return { canceled: false, stale: true, recordIds: [] };
      const latestRecordIds = cleanTexts(latest.recordIds || (latest.recordId ? [latest.recordId] : []), 500);
      const replacement = await replaceDnsRecordSafely({
        account, credentials, zone,
        binding: { ...binding, providerRecordId: latestRecordIds[0] || '', providerRecordIds: latestRecordIds },
        beforeValues: remote, afterValues: desired,
        recordType: guard.recordType, readDnsRecord, writeDnsRecord
      });
      return { canceled: false, stale: false, recordIds: replacement.recordIds };
    }, Number.POSITIVE_INFINITY);
    if (writeResult.canceled) return;
    if (writeResult.stale) {
      deps.updateState((draft) => {
        const item = draft.dnsGuards.find((entry) => entry.id === guardId && entry.cycle?.id === cycleId);
        if (!item) return draft;
        return updateDnsGuard(draft, guardId, { status: 'queued', message: '服务商记录已变化，等待重新检查', cycle: null, nextCheckAt: '' });
      });
      return;
    }
    providerRecordIds = writeResult.recordIds;
  }
  const finishedAt = nowIso();
  let committed = false;
  state = deps.updateState((draft) => {
    const item = draft.dnsGuards.find((entry) => entry.id === guardId && entry.cycle?.id === cycleId);
    if (!item) return draft;
    committed = true;
    const cycleSnapshot = structuredClone(cycle);
    const sourceState = selectedSources.state;
    const discardedIds = new Set(unusableAssets.map((entry) => entry.assetId));
    const consumedIds = new Set(usedAssets.map((entry) => entry.assetId));
    const removedIds = new Set([...discardedIds, ...consumedIds]);
    const removedAssets = draft.ipAssets.filter((asset) => removedIds.has(asset.id));
    draft.ipAssets = draft.ipAssets.filter((asset) => !removedIds.has(asset.id));
    for (const pool of draft.ipPools) pool.assetIds = (pool.assetIds || []).filter((assetId) => !removedIds.has(assetId));
    for (const asset of removedAssets) {
      const candidate = [...unusableAssets, ...usedAssets].find((entry) => entry.assetId === asset.id);
      const discarded = discardedIds.has(asset.id);
      draft.ipUsageRecords.unshift({
        id: uuidv4(), leaseId: '', assetId: asset.id, address: asset.address, poolId: candidate?.poolId || '',
        poolName: draft.ipPools.find((pool) => pool.id === candidate?.poolId)?.name || '', guardId, guardName: item.name,
        incidentId: '', targetId: '', targetName: item.domain, policyId: '', policyName: 'DNS 守护', automationTaskId: '', automationTaskName: '',
        bindings: [{ id: item.id, domain: item.domain, recordType: item.recordType }], status: discarded ? 'discarded' : 'consumed',
        preflight: { attempts: item.checkRounds * item.attemptsPerRound, ok: !discarded, checkedAt: finishedAt, error: discarded ? '所有负责探针检查失败' : '' },
        startedAt: cycleSnapshot.startedAt, finishedAt, error: discarded ? 'DNS 守护候选 IP 不可用' : ''
      });
    }
    draft.ipUsageRecords = draft.ipUsageRecords.slice(0, 5000);
    if (changed) draft.dnsChanges.unshift({ id: uuidv4(), incidentId: '', guardId, bindingId: '', accountId: item.accountId, zoneId: cycleSnapshot.zone.id || '', zoneName: cycleSnapshot.zone.name, providerZoneId: cycleSnapshot.zone.providerZoneId || '', domain: item.domain, beforeValues: remote, afterValues: desired, status: 'applied', createdAt: finishedAt, rolledBackAt: '' });
    draft.dnsChanges = draft.dnsChanges.slice(0, 3000);
    const ownership = calculateDnsGuardOwnership(item, remote, desired, healthySources, usedAssets);
    const status = !desired.length
      ? 'waiting_ip'
      : (failedRemote.length
          ? (desired.length >= targetCount && (usedAssets.length || healthySources.some((address) => !remote.includes(address))) ? 'replaced' : 'degraded')
          : 'healthy');
    Object.assign(item, {
      status, message: dnsGuardStatusMessage(status, failedRemote.length, usedAssets.length), currentValues: desired,
      ...ownership, sourceState, cycle: null, lastCheckAt: finishedAt, nextCheckAt: addSeconds(item.interval), lastError: '',
      sourceErrors: Object.values(sourceState).map((entry) => cleanText(entry?.lastError, 300)).filter(Boolean),
      providerRecordId: changed ? (providerRecordIds[0] || '') : item.providerRecordId,
      providerRecordIds: changed ? providerRecordIds : item.providerRecordIds
    });
    draft.dnsGuardRuns.unshift({ id: uuidv4(), guardId, guardName: item.name, domain: item.domain, status, beforeValues: remote, afterValues: desired, failedValues: failedRemote, sourceValues: cycleSnapshot.sourceValues, consumedIps: usedAssets.map((entry) => entry.address), discardedIps: unusableAssets.map((entry) => entry.address), startedAt: cycleSnapshot.startedAt, finishedAt, message: item.message });
    draft.dnsGuardRuns = draft.dnsGuardRuns.slice(0, DNS_GUARD_HISTORY_LIMIT);
    pushAudit(draft, 'dnsGuard.check', 'dnsGuard', guardId, `${item.domain} 检查 ${remote.length} 个记录，故障 ${failedRemote.length} 个，补位 ${usedAssets.length} 个`, 'system');
    return draft;
  });
  // Routine checks stay silent. Notify only after unhealthy remote IPs were
  // successfully removed from the provider record.
  if (committed && changed && failedRemote.some((address) => !desired.includes(address))) deps.notifyDnsGuard?.(guardId);
}

export function calculateDnsGuardOwnership(guard, remoteValues, desiredValues, healthySourceValues, usedAssets = []) {
  const remote = new Set(remoteValues || []);
  const desired = new Set(desiredValues || []);
  const healthySources = new Set(healthySourceValues || []);
  const introducedSources = [...healthySources].filter((address) => desired.has(address) && !remote.has(address));
  return {
    ownedValues: [...new Set([
      ...(guard.ownedValues || []).filter((address) => desired.has(address)),
      ...introducedSources,
      ...usedAssets.map((entry) => entry.address).filter((address) => desired.has(address))
    ])],
    sourceOwnedValues: [...new Set([
      ...(guard.sourceOwnedValues || []).filter((address) => desired.has(address) && healthySources.has(address)),
      ...introducedSources
    ])]
  };
}

async function replaceDnsRecordSafely({
  account, credentials, zone, binding, beforeValues, afterValues, recordType,
  readDnsRecord, writeDnsRecord, verificationMode = 'strict'
}) {
  let afterIds = [];
  try {
    afterIds = await writeDnsRecord(account, credentials, zone, binding, afterValues);
    if (verificationMode === 'provider_ack') {
      return { recordIds: afterIds || [], verificationPending: false, verificationError: '' };
    }
    const verifyBinding = afterIds?.length
      ? { ...binding, providerRecordId: afterIds[0], providerRecordIds: afterIds }
      : withoutProviderRecordIds(binding);
    const verified = await readDnsRecord(account, credentials, zone, verifyBinding);
    if (!sameStringSet(filterAddressFamily(verified.values, recordType), afterValues)) throw new Error('服务商返回的记录值与写入内容不一致');
    return { recordIds: afterIds || [], verificationPending: false, verificationError: '' };
  } catch (error) {
    if (verificationMode !== 'strict' && isTransientDnsGuardError(error)) {
      return {
        recordIds: afterIds?.length
          ? afterIds
          : cleanTexts(binding.providerRecordIds || (binding.providerRecordId ? [binding.providerRecordId] : []), 500),
        verificationPending: true,
        verificationError: cleanText(error.message || '服务商写入结果待确认', 500)
      };
    }
    try {
      const rollbackBinding = afterIds?.length
        ? { ...binding, providerRecordId: afterIds[0], providerRecordIds: afterIds }
        : withoutProviderRecordIds(binding);
      const rollbackIds = await writeDnsRecord(account, credentials, zone, rollbackBinding, beforeValues);
      const verifyRollbackBinding = rollbackIds?.length
        ? { ...binding, providerRecordId: rollbackIds[0], providerRecordIds: rollbackIds }
        : withoutProviderRecordIds(binding);
      const restored = await readDnsRecord(account, credentials, zone, verifyRollbackBinding);
      if (!sameStringSet(filterAddressFamily(restored.values, recordType), beforeValues)) throw new Error('自动恢复后的记录验证不一致');
    } catch (rollbackError) {
      throw new Error(`远程写入失败且自动恢复失败：${cleanText(error.message, 240)}；${cleanText(rollbackError.message, 240)}`);
    }
    throw new Error(`远程写入失败，已恢复原记录：${cleanText(error.message, 300)}`);
  }
}

function recordDnsGuardError(guardId, error, deps) {
  const message = cleanText(error?.message || 'DNS 守护执行失败', 500);
  let retryReadyCycle = false;
  deps.updateState((draft) => {
    const guard = draft.dnsGuards.find((item) => item.id === guardId);
    if (!guard) return draft;
    if (isTransientDnsGuardError(error)) {
      if (guard.cycle) {
        updateDnsGuard(draft, guardId, { status: 'checking', message: '服务商请求超时，等待自动重试', lastError: '' });
        retryReadyCycle = true;
      } else {
        const stableStatus = ['healthy', 'replaced', 'degraded', 'waiting_ip'].includes(guard.status);
        updateDnsGuard(draft, guardId, {
          status: stableStatus ? guard.status : 'queued',
          message: stableStatus ? guard.message : '服务商请求超时，等待自动重试',
          lastError: '',
          nextCheckAt: addSeconds(Math.min(10, Math.max(1, Number(guard.interval) || 30)))
        });
      }
      pushAudit(draft, 'dnsGuard.retry', 'dnsGuard', guardId, `服务商请求暂时失败，已安排重试：${message}`, 'system');
      return draft;
    }
    updateDnsGuard(draft, guardId, { status: 'error', message: '检查失败', lastError: message, cycle: null, lastCheckAt: nowIso(), nextCheckAt: addSeconds(draft.dnsGuards.find((item) => item.id === guardId)?.interval || 30) });
    pushAudit(draft, 'dnsGuard.error', 'dnsGuard', guardId, message, 'system');
    return draft;
  });
  if (retryReadyCycle) deps.onDnsGuardRetry?.(guardId);
}

function isTransientDnsGuardError(error) {
  const name = String(error?.name || '');
  const code = String(error?.code || error?.cause?.code || '');
  const message = String(error?.message || '');
  if (message.includes('自动恢复失败')) return false;
  return name === 'TimeoutError'
    || name === 'AbortError'
    || /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/i.test(code)
    || /aborted due to timeout|timed?\s*out|timeout|socket hang up|network socket disconnected/i.test(message);
}

function updateDnsGuard(state, id, patch) {
  const guard = state.dnsGuards.find((item) => item.id === id);
  if (guard) Object.assign(guard, patch, { updatedAt: nowIso() });
  return state;
}

function guardBinding(guard) {
  return {
    accountId: guard.accountId,
    domain: guard.domain,
    recordType: guard.recordType,
    recordLine: guard.recordLine || '默认',
    ttl: guard.ttl,
    providerRecordId: guard.providerRecordId || '',
    providerRecordIds: guard.providerRecordIds || [],
    zoneName: guard.zoneName || '',
    providerZoneId: guard.providerZoneId || ''
  };
}

function dnsGuardStatusMessage(status, failed, consumed) {
  if (status === 'healthy') return '全部解析 IP 正常';
  if (status === 'replaced') return `已替换 ${failed} 个故障 IP，消耗 ${consumed} 个备用 IP`;
  if (status === 'degraded') return `已移除 ${failed} 个故障 IP，等待补足容量`;
  return '全部解析 IP 故障，等待可用来源或备用 IP';
}

function addSeconds(seconds) { return new Date(Date.now() + Math.max(1, Number(seconds) || 30) * 1000).toISOString(); }
function sameStringSet(left, right) { return JSON.stringify([...new Set(left || [])].sort()) === JSON.stringify([...new Set(right || [])].sort()); }
function filterAddressFamily(values, recordType) { const family = recordType === 'AAAA' ? 6 : 4; return [...new Set((values || []).filter((value) => net.isIP(value) === family))]; }
function normalizeGuardRemoteValues(value, recordType) {
  const raw = cleanTexts(value, DNS_GUARD_MAX_VALUES + 1);
  if (raw.length > DNS_GUARD_MAX_VALUES) throw new Error(`远程 IP 最多 ${DNS_GUARD_MAX_VALUES} 个`);
  const family = recordType === 'AAAA' ? 6 : 4;
  return [...new Set(raw.map((address) => {
    const normalized = validateIp(address);
    if (net.isIP(normalized) !== family) throw new Error(`${address} 不是有效的 ${recordType} 地址`);
    return normalized;
  }))];
}

function targetCompletedCheckSince(target, probes, requestedAt) {
  if (!target || !requestedAt) return true;
  const requestedTime = Date.parse(requestedAt);
  if (!Number.isFinite(requestedTime)) return false;
  const assignedProbeIds = (target.probeIds || []).filter((probeId) => probes.some((probe) => probe.id === probeId && probe.enabled !== false));
  return assignedProbeIds.length > 0 && assignedProbeIds.every((probeId) => Date.parse(target.observations?.[probeId]?.checkedAt || 0) >= requestedTime);
}

function normalizeResource(key, input = {}, existing = null, deps) {
  const now = nowIso();
  const base = { id: existing?.id || cleanId(input.id) || uuidv4(), createdAt: existing?.createdAt || now, updatedAt: now };
  if (key === 'probes') return { ...base, name: requiredText(input.name, '探针名称'), region: cleanText(input.region, 80), carrier: cleanText(input.carrier, 80), maxConcurrency: clampNumber(input.maxConcurrency, 1, 1000, 100), enabled: input.enabled !== false, status: existing?.status || 'pending', lastSeenAt: existing?.lastSeenAt || '', tokenHash: existing?.tokenHash || '', tokenEnc: existing?.tokenEnc || null, agentSecretHash: existing?.agentSecretHash || '', tokenExpiresAt: existing?.tokenExpiresAt || '', tokenUsedAt: existing?.tokenUsedAt || '', registeredAt: existing?.registeredAt || '', agentVersion: existing?.agentVersion || '' };
  if (key === 'probeTargets') {
    const address = validateHost(input.address, Boolean(input.allowPrivate));
    const checkType = input.checkType === 'tcp' ? 'tcp' : 'ping';
    const port = clampNumber(input.port, 1, 65535, 443);
    const probeIds = cleanIds(input.probeIds, 500);
    const checkRounds = clampNumber(input.checkRounds, 1, MAX_TARGET_CHECK_ROUNDS, DEFAULT_TARGET_CHECK_ROUNDS);
    const attemptsPerRound = clampNumber(input.attemptsPerRound, 1, MAX_TARGET_ATTEMPTS_PER_ROUND, DEFAULT_TARGET_ATTEMPTS_PER_ROUND);
    const identityChanged = Boolean(existing && (
      existing.address !== address || existing.checkType !== checkType || Number(existing.port) !== port ||
      Number(existing.checkRounds || DEFAULT_TARGET_CHECK_ROUNDS) !== checkRounds ||
      Number(existing.attemptsPerRound || DEFAULT_TARGET_ATTEMPTS_PER_ROUND) !== attemptsPerRound ||
      JSON.stringify([...(existing.probeIds || [])].sort()) !== JSON.stringify([...probeIds].sort())
    ));
    return {
      ...base,
      name: requiredText(input.name, '目标名称'),
      address,
      allowPrivate: Boolean(input.allowPrivate),
      checkType,
      port,
      interval: clampNumber(input.interval, 5, 3600, 30),
      timeout: clampNumber(input.timeout, 1, 60, 5),
      checkRounds,
      attemptsPerRound,
      probeIds,
      policyId: cleanId(input.policyId),
      enabled: input.enabled !== false,
      health: identityChanged ? 'unknown' : (existing?.health || 'unknown'),
      observations: identityChanged ? {} : (existing?.observations || {}),
      lastCheckAt: identityChanged ? '' : (existing?.lastCheckAt || ''),
      checkNowAt: identityChanged ? now : (existing?.checkNowAt || '')
    };
  }
  if (key === 'dnsGuards') {
    const accountId = cleanId(input.accountId);
    const domain = normalizeDomain(input.domain);
    const recordType = input.recordType === 'AAAA' ? 'AAAA' : 'A';
    const probeIds = cleanIds(input.probeIds, 500);
    const poolIds = cleanIds(input.poolIds, 100);
    validateDdnsSources(input.sources || input.ddnsSources);
    const sources = normalizeDdnsSources(input.sources || input.ddnsSources);
    const targetChanged = Boolean(existing && (existing.accountId !== accountId || existing.domain !== domain || existing.recordType !== recordType));
    const sourcesChanged = Boolean(existing && JSON.stringify(existing.sources || []) !== JSON.stringify(sources));
    const identityChanged = Boolean(existing && (
      targetChanged || sourcesChanged ||
      JSON.stringify([...(existing.probeIds || [])].sort()) !== JSON.stringify([...probeIds].sort())
    ));
    return normalizeDnsGuardState({
      ...base,
      name: requiredText(input.name, '守护任务名称'),
      accountId,
      domain,
      recordType,
      recordLine: cleanText(input.recordLine, 100) || '默认',
      ttl: clampNumber(input.ttl, 1, 86400, 60),
      maxActiveIps: clampNumber(input.maxActiveIps, 1, DNS_GUARD_MAX_VALUES, 50),
      probeIds,
      poolIds,
      checkType: input.checkType === 'tcp' ? 'tcp' : 'ping',
      port: clampNumber(input.port, 1, 65535, 443),
      interval: clampNumber(input.interval, 10, 86400, 30),
      timeout: clampNumber(input.timeout, 1, 60, 5),
      checkRounds: clampNumber(input.checkRounds, 1, 10, 3),
      attemptsPerRound: clampNumber(input.attemptsPerRound, 1, 10, 3),
      maxParallel: clampNumber(input.maxParallel, 1, 300, 20),
      pruneStale: input.pruneStale !== false,
      sources,
      enabled: input.enabled !== false,
      status: 'queued',
      message: existing ? '配置已更新，等待重新检查' : '',
      currentValues: targetChanged ? [] : (existing?.currentValues || []),
      ownedValues: targetChanged ? [] : (existing?.ownedValues || []),
      sourceOwnedValues: targetChanged ? [] : (existing?.sourceOwnedValues || []),
      sourceState: targetChanged || sourcesChanged ? {} : (existing?.sourceState || {}),
      sourceErrors: targetChanged || sourcesChanged ? [] : (existing?.sourceErrors || []),
      providerRecordId: targetChanged ? '' : (existing?.providerRecordId || ''),
      providerRecordIds: targetChanged ? [] : (existing?.providerRecordIds || []),
      zoneName: targetChanged ? '' : (existing?.zoneName || ''),
      providerZoneId: targetChanged ? '' : (existing?.providerZoneId || ''),
      cycle: null,
      lastCheckAt: identityChanged ? '' : (existing?.lastCheckAt || ''),
      nextCheckAt: '',
      lastError: ''
    });
  }
  if (key === 'ipAssets') return { ...base, name: cleanText(input.name, 100) || validateIp(input.address), address: validateIp(input.address), region: cleanText(input.region, 80), carrier: cleanText(input.carrier, 80), labels: cleanTexts(input.labels, 30), enabled: input.enabled !== false, health: ['healthy', 'unhealthy', 'unknown'].includes(input.health) ? input.health : 'unknown', note: cleanText(input.note, 500) };
  if (key === 'ipPools') return { ...base, name: requiredText(input.name, '备用池名称'), assetIds: cleanIds(input.assetIds, 5000), allocationMode: ['one', 'count', 'all'].includes(input.allocationMode) ? input.allocationMode : 'one', allocationCount: clampNumber(input.allocationCount, 1, 5000, 1), selectionMode: ['ordered', 'random'].includes(input.selectionMode) ? input.selectionMode : 'ordered', enabled: input.enabled !== false, alertEnabled: Boolean(input.alertEnabled), alertThresholds: normalizeThresholds(input.alertThresholds), alertBotIds: cleanIds(input.alertBotIds, 50), note: cleanText(input.note, 500) };
  if (key === 'dnsAccounts') {
    const provider = DNS_PROVIDERS.has(input.provider) ? input.provider : 'huawei';
    const supplied = input.credentials && typeof input.credentials === 'object' ? input.credentials : {};
    let current = {};
    if (existing?.provider === provider && existing.credentialsEnc) {
      try { current = JSON.parse(deps.decryptSecret(existing.credentialsEnc)); } catch (_error) { current = {}; }
    }
    const changed = Object.fromEntries(Object.entries(supplied).filter(([, value]) => String(value ?? '').length > 0));
    const credentials = { ...current, ...changed };
    const hasCredentials = Object.values(credentials).some((value) => String(value ?? '').length > 0);
    return { ...base, name: requiredText(input.name, '账号名称'), provider, enabled: input.enabled !== false, credentialsEnc: hasCredentials ? deps.encryptSecret(JSON.stringify(credentials)) : null, status: existing?.provider === provider ? (existing?.status || 'untested') : 'untested', lastTestAt: existing?.provider === provider ? (existing?.lastTestAt || '') : '', lastError: existing?.provider === provider ? (existing?.lastError || '') : '' };
  }
  if (key === 'dnsZones') return { ...base, name: normalizeDomain(input.name), accountId: cleanId(input.accountId), providerZoneId: cleanText(input.providerZoneId, 200), enabled: input.enabled !== false, lastSyncAt: existing?.lastSyncAt || '', status: existing?.status || 'ready' };
  if (key === 'dnsBindings') {
    const recordType = DNS_RECORD_TYPES.has(input.recordType) ? input.recordType : 'A';
    const accountId = cleanId(input.accountId);
    const domain = normalizeDomain(input.domain);
    const identityChanged = Boolean(existing && (existing.accountId !== accountId || existing.domain !== domain || existing.recordType !== recordType));
    const recordValues = cleanRecordValues(input.recordValues, recordType === 'CNAME' ? 1 : 5000);
    if (recordType === 'CNAME' && recordValues[0]) recordValues[0] = normalizeDomain(recordValues[0]);
    return { ...base, name: requiredText(input.name, '解析绑定名称'), zoneId: identityChanged ? '' : cleanId(input.zoneId), accountId, domain, recordName: identityChanged ? '' : cleanText(input.recordName, 255), recordType, recordValues, currentValues: identityChanged ? [] : cleanTexts(input.currentValues ?? existing?.currentValues ?? input.managedValues ?? input.backupIps, 5000), providerRecordId: identityChanged ? '' : cleanText(input.providerRecordId, 200), providerRecordIds: identityChanged ? [] : cleanTexts(input.providerRecordIds, 500), recordLine: cleanText(input.recordLine, 100) || '默认', ttl: clampNumber(input.ttl, 1, 86400, 60), updateMode: ['append', 'managed_replace', 'replace'].includes(input.updateMode) ? input.updateMode : 'managed_replace', managedValues: identityChanged ? [] : cleanTexts(input.managedValues, 5000), ddnsSources: normalizeDdnsSources(input.ddnsSources), backupIps: cleanTexts(input.backupIps, 5000), maxActiveIps: clampNumber(input.maxActiveIps, 1, 50, 50), pruneStale: input.pruneStale !== false, healthEnabled: input.healthEnabled !== false, healthInterval: clampNumber(input.healthInterval, 10, 86400, 30), pingCount: clampNumber(input.pingCount, 1, 10, 3), checkRounds: clampNumber(input.checkRounds, 1, 10, 3), roundDelay: clampNumber(input.roundDelay, 0, 60, 2), maxParallel: clampNumber(input.maxParallel, 1, 300, 20), lastSyncAt: identityChanged ? '' : (existing?.lastSyncAt || ''), lastSyncError: '', enabled: input.enabled !== false };
  }
  if (key === 'failoverPolicies') return { ...base, name: requiredText(input.name, '策略名称'), poolIds: cleanIds(input.poolIds, 100), automationTaskId: cleanId(input.automationTaskId), automationHosts: input.automationHosts === 'target' ? 'target' : 'allocated', automationTimeout: clampNumber(input.automationTimeout, 30, 7200, 1800), dnsBindingIds: cleanIds(input.dnsBindingIds, 500), approvalMode: input.approvalMode === 'telegram' ? 'telegram' : 'automatic', autoRollback: input.autoRollback !== false, enabled: input.enabled !== false, businessKey: cleanText(input.businessKey, 100) };
  if (key === 'telegramBots') {
    const token = String(input.token || '').trim();
    let tokenHash = existing?.tokenHash || '';
    if (token) tokenHash = hashSecret(token);
    else if (!tokenHash && existing?.tokenEnc) {
      try { tokenHash = hashSecret(deps.decryptSecret(existing.tokenEnc)); } catch (_error) { tokenHash = ''; }
    }
    return { ...base, name: requiredText(input.name || 'Telegram 机器人', '机器人名称'), tokenEnc: token ? deps.encryptSecret(token) : existing?.tokenEnc || null, tokenHash, enabled: input.enabled !== false, userIds: cleanTexts(input.userIds, 500), groupIds: [], roles: normalizeRoles(input.roles), menuScopes: cleanTexts(input.menuScopes, 30), automationTaskIds: cleanIds(input.automationTaskIds, 500), lastError: existing?.lastError || '', lastPollAt: existing?.lastPollAt || '' };
  }
  throw new Error('未知资源类型');
}

function parseOptionalIpBatch(value) {
  if (!String(value || '').trim()) return [];
  return parseIpBatch(value);
}

export function parseIpBatch(value) {
  const values = [...new Set(String(value || '').split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))];
  if (!values.length) throw new Error('请至少输入一个 IP 地址');
  if (values.length > 5000) throw new Error('单次最多导入 5000 个 IP 地址');
  const invalid = values.filter((address) => net.isIP(address) === 0);
  if (invalid.length) throw new Error(`IP 地址格式不正确：${invalid.slice(0, 10).join('、')}${invalid.length > 10 ? ` 等 ${invalid.length} 个` : ''}`);
  return values;
}

export function dnsRecordLayout(provider) {
  return provider === 'huawei' ? 'recordset' : 'individual';
}

export function importIpAssets(state, addresses, defaults = {}, actor = 'system') {
  const assetIds = [];
  let created = 0;
  let reused = 0;
  for (const address of addresses) {
    let asset = state.ipAssets.find((item) => item.address === address);
    if (asset) {
      reused += 1;
    } else {
      asset = normalizeResource('ipAssets', {
        address,
        name: address,
        region: defaults?.region,
        carrier: defaults?.carrier,
        labels: defaults?.labels,
        health: defaults?.health || 'unknown',
        enabled: defaults?.enabled !== false,
        note: defaults?.note
      });
      state.ipAssets.push(asset);
      created += 1;
    }
    assetIds.push(asset.id);
  }
  if (created) pushAudit(state, 'ipAssets.batch_import', 'ipAssets', '', `创建 ${created} 个 IP 资产`, actor);
  return { created, reused, total: addresses.length, assetIds };
}

export function addIpsToPool(state, poolId, addresses, actor = 'system') {
  const pool = state.ipPools.find((item) => item.id === poolId);
  if (!pool) throw new Error('备用池不存在');
  const imported = importIpAssets(state, addresses, {}, actor);
  pool.assetIds = [...new Set([...(pool.assetIds || []), ...imported.assetIds])];
  pool.updatedAt = nowIso();
  pushAudit(state, 'ipPools.telegram_add', 'ipPools', pool.id, `通过 Telegram 加入 ${addresses.length} 个 IP`, actor);
  return { pool, ...imported };
}

export function createPoolWithIps(state, name, addresses, actor = 'system') {
  const imported = importIpAssets(state, addresses, {}, actor);
  const pool = normalizeResource('ipPools', { name, assetIds: imported.assetIds, allocationMode: 'one', enabled: true });
  state.ipPools.push(pool);
  pushAudit(state, 'ipPools.telegram_create', 'ipPools', pool.id, `通过 Telegram 创建备用池并加入 ${addresses.length} 个 IP`, actor);
  return { pool, ...imported };
}

export function setDnsBindingIps(state, bindingId, addresses, mode = 'append', actor = 'system') {
  const binding = state.dnsBindings.find((item) => item.id === bindingId);
  if (!binding) throw new Error('解析绑定不存在');
  if (!['A', 'AAAA'].includes(binding.recordType)) throw new Error('只有 A/AAAA 记录可以添加 IP');
  const family = binding.recordType === 'AAAA' ? 6 : 4;
  if (addresses.some((address) => net.isIP(address) !== family)) throw new Error(`${binding.recordType} 记录只能使用 IPv${family} 地址`);
  binding.backupIps = mode === 'replace' ? [...addresses] : [...new Set([...(binding.backupIps || []), ...addresses])];
  binding.updatedAt = nowIso();
  pushAudit(state, 'dnsBindings.telegram_ips', 'dnsBindings', binding.id, `通过 Telegram ${mode === 'replace' ? '替换' : '添加'} ${addresses.length} 个 IP`, actor);
  return binding;
}

export function createDnsBinding(state, accountId, domain, recordType, values, actor = 'system') {
  const account = state.dnsAccounts.find((item) => item.id === accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 账号不存在或已停用');
  const type = DNS_RECORD_TYPES.has(recordType) ? recordType : 'A';
  const addressRecord = ['A', 'AAAA'].includes(type);
  const binding = normalizeResource('dnsBindings', {
    name: `${domain} ${type}`,
    accountId,
    domain,
    recordType: type,
    backupIps: addressRecord ? values : [],
    recordValues: addressRecord ? [] : values,
    updateMode: 'replace',
    enabled: true
  });
  state.dnsBindings.push(binding);
  pushAudit(state, 'dnsBindings.telegram_create', 'dnsBindings', binding.id, `通过 Telegram 创建 ${binding.domain} ${binding.recordType}`, actor);
  return binding;
}

function ensureResourceReferences(state, key, item, deps) {
  const exists = (collection, id) => !id || state[collection]?.some((entry) => entry.id === id);
  if (key === 'probeTargets') {
    if (!item.probeIds.length || item.probeIds.some((id) => !exists('probes', id))) throw new Error('至少关联一个有效探针');
    if (!exists('failoverPolicies', item.policyId)) throw new Error('关联的故障策略不存在');
  }
  if (key === 'dnsGuards') {
    if (!exists('dnsAccounts', item.accountId)) throw new Error('DNS 账号不存在');
    if (!item.probeIds.length || item.probeIds.some((id) => !exists('probes', id))) throw new Error('至少关联一个有效探针');
    if (item.poolIds.some((id) => !exists('ipPools', id))) throw new Error('关联的备用池不存在');
  }
  if (key === 'ipPools' && item.assetIds.some((id) => !exists('ipAssets', id))) throw new Error('备用池包含不存在的 IP');
  if (key === 'ipPools' && item.alertEnabled) {
    if (!item.alertThresholds.length) throw new Error('启用库存预警时，请至少填写一个预警数量');
    if (!item.alertBotIds.length) throw new Error('启用库存预警时，请至少选择一个发送机器人');
    const bots = item.alertBotIds.map((id) => state.telegramBots.find((entry) => entry.id === id));
    if (bots.some((bot) => !bot)) throw new Error('备用池通知包含不存在的机器人');
    if (bots.some((bot) => bot.enabled === false || !bot.tokenEnc)) throw new Error('发送机器人未启用或尚未配置 Token');
    if (bots.some((bot) => !bot.userIds?.length)) throw new Error('发送机器人尚未配置授权用户或群 ID');
  }
  if (key === 'dnsZones' && !exists('dnsAccounts', item.accountId)) throw new Error('DNS 账号不存在');
  if (key === 'dnsBindings' && !exists('dnsAccounts', item.accountId)) throw new Error('DNS 账号不存在');
  if (key === 'failoverPolicies') {
    if (item.poolIds.some((id) => !exists('ipPools', id))) throw new Error('关联的备用池不存在');
    if (item.dnsBindingIds.some((id) => !exists('dnsBindings', id))) throw new Error('关联的解析绑定不存在');
    if (item.dnsBindingIds.some((id) => !['A', 'AAAA'].includes(state.dnsBindings.find((entry) => entry.id === id)?.recordType))) throw new Error('故障切换只能关联 A/AAAA 解析');
    if (!exists('automationTasks', item.automationTaskId)) throw new Error('关联的自动化任务不存在');
  }
  if (key === 'telegramBots') {
    if (item.automationTaskIds.some((id) => !exists('automationTasks', id))) throw new Error('机器人包含不存在的自动化任务');
    const duplicateToken = item.tokenHash && state.telegramBots.some((entry) => {
      if (entry.id === item.id) return false;
      let entryHash = entry.tokenHash || '';
      if (!entryHash && entry.tokenEnc) {
        try { entryHash = hashSecret(deps.decryptSecret(entry.tokenEnc)); } catch (_error) { entryHash = ''; }
      }
      return entryHash === item.tokenHash;
    });
    if (duplicateToken) throw new Error('这个 Bot Token 已被其他机器人使用');
    const usedByPoolAlert = state.ipPools.some((pool) => pool.alertEnabled && pool.alertBotIds?.includes(item.id));
    if (usedByPoolAlert && (item.enabled === false || !item.tokenEnc || !item.userIds.length)) throw new Error('该机器人正在发送库存预警，请先解除备用池关联');
  }
}

function ensureNotReferenced(state, key, id) {
  const references = {
    probes: state.probeTargets.some((item) => item.probeIds?.includes(id)) || state.dnsGuards.some((item) => item.probeIds?.includes(id)),
    ipAssets: state.ipPools.some((item) => item.assetIds?.includes(id)),
    ipPools: state.failoverPolicies.some((item) => item.poolIds?.includes(id)) || state.dnsGuards.some((item) => item.poolIds?.includes(id)),
    dnsAccounts: state.dnsZones.some((item) => item.accountId === id) || state.dnsBindings.some((item) => item.accountId === id) || state.dnsGuards.some((item) => item.accountId === id),
    dnsZones: state.dnsBindings.some((item) => item.zoneId === id),
    dnsBindings: state.failoverPolicies.some((item) => item.dnsBindingIds?.includes(id)),
    failoverPolicies: state.probeTargets.some((item) => item.policyId === id),
    telegramBots: state.ipPools.some((item) => item.alertEnabled && item.alertBotIds?.includes(id))
  };
  if (references[key]) throw new Error('当前记录仍被其他配置引用，请先解除关联');
}

function authenticateProbe(req, state) {
  const probeId = cleanId(req.headers['x-probe-id']);
  const secret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const probe = state.probes.find((item) => item.id === probeId && item.enabled !== false && item.agentSecretHash);
  return probe && safeHashEqual(probe.agentSecretHash, hashSecret(secret)) ? { probe, state } : null;
}

function probeTargetConfiguration(target) {
  return {
    id: target.id,
    address: target.address,
    allowPrivate: Boolean(target.allowPrivate),
    checkType: target.checkType,
    port: target.port,
    timeout: target.timeout,
    checkRounds: target.checkRounds,
    attemptsPerRound: target.attemptsPerRound,
    interval: target.interval,
    checkNowAt: target.checkNowAt || ''
  };
}

export function evaluateTargetHealth(target, probes, enabledProbeIds = null) {
  const enabled = enabledProbeIds || new Set(probes.filter((probe) => probe.enabled !== false).map((probe) => probe.id));
  const assignedProbeIds = (target.probeIds || []).filter((probeId) => enabled.has(probeId));
  const assignedProbeIdSet = new Set(assignedProbeIds);
  const now = Date.now();
  const checkRounds = clampNumber(target.checkRounds, 1, MAX_TARGET_CHECK_ROUNDS, DEFAULT_TARGET_CHECK_ROUNDS);
  const attemptsPerRound = clampNumber(target.attemptsPerRound, 1, MAX_TARGET_ATTEMPTS_PER_ROUND, DEFAULT_TARGET_ATTEMPTS_PER_ROUND);
  const intervalMs = Math.max(5000, Number(target.interval || 30) * 1000);
  const checkWindowMs = Math.max(15000, Number(target.timeout || 5) * checkRounds * 1000 + (checkRounds - 1) * 1000);
  const freshnessMs = intervalMs + checkWindowMs + 10000;
  const maxRoundSkewMs = intervalMs + checkWindowMs;
  const observations = Object.entries(target.observations || {}).filter(([probeId, observation]) => {
    const checkedAt = Date.parse(observation.checkedAt || 0);
    return assignedProbeIdSet.has(probeId) && Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt <= freshnessMs;
  });
  const completeRound = assignedProbeIds.length > 0 && observations.length === assignedProbeIds.length;
  const checkedTimes = observations.map(([, item]) => Date.parse(item.checkedAt));
  const alignedRound = completeRound && Math.max(...checkedTimes) - Math.min(...checkedTimes) <= maxRoundSkewMs;
  const completedConfiguredCheck = (item) => item.rounds === checkRounds &&
    item.attemptsPerRound === attemptsPerRound &&
    item.roundsCompleted === checkRounds &&
    item.attempts === checkRounds * attemptsPerRound;
  const failed = alignedRound && observations.every(([, item]) => !item.ok && completedConfiguredCheck(item));
  const healthy = alignedRound && observations.some(([, item]) => item.ok);
  return { failed, health: failed ? 'down' : healthy ? 'healthy' : 'observing' };
}

function completeConfiguredFailure(observation, target) {
  const checkRounds = clampNumber(target.checkRounds, 1, MAX_TARGET_CHECK_ROUNDS, DEFAULT_TARGET_CHECK_ROUNDS);
  const attemptsPerRound = clampNumber(target.attemptsPerRound, 1, MAX_TARGET_ATTEMPTS_PER_ROUND, DEFAULT_TARGET_ATTEMPTS_PER_ROUND);
  return !observation.ok && observation.rounds === checkRounds &&
    observation.attemptsPerRound === attemptsPerRound &&
    observation.roundsCompleted === checkRounds &&
    observation.attempts === checkRounds * attemptsPerRound;
}

function probeSupportsSuccessfulAddress(version) {
  const parts = String(version || '').split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return false;
  return (parts[0] || 0) > 1 || ((parts[0] || 0) === 1 && (parts[1] || 0) >= 4);
}

export function evaluateIncidentStabilization(incident, target, probes, now = Date.now()) {
  if (incident?.status !== 'stabilizing' || !incident.stabilization) return { action: 'inactive' };
  const expected = new Set(cleanTexts(incident.stabilization.expectedAddresses, 100).map(normalizeComparableIp).filter(Boolean));
  const dnsWrittenAt = Date.parse(incident.stabilization.dnsWrittenAt || 0);
  const checkRounds = clampNumber(target?.checkRounds, 1, MAX_TARGET_CHECK_ROUNDS, DEFAULT_TARGET_CHECK_ROUNDS);
  const legacyCheckWindowMs = Math.max(15000, clampNumber(target?.timeout, 1, 60, 5) * checkRounds * 1000 + Math.max(0, checkRounds - 1) * 1000 + 10000);
  const assigned = (target?.probeIds || [])
    .map((probeId) => probes.find((probe) => probe.id === probeId && probe.enabled !== false))
    .filter(Boolean);
  const evidence = assigned.map((probe) => ({ probe, observation: target?.observations?.[probe.id] })).filter(({ probe, observation }) => {
    const checkedAt = Date.parse(observation?.checkedAt || 0);
    if (!Number.isFinite(checkedAt) || !Number.isFinite(dnsWrittenAt)) return false;
    if (probeSupportsSuccessfulAddress(probe.agentVersion)) return checkMarkerAtOrAfter(observation?.checkMarker, incident.stabilization.checkMarker);
    return checkedAt >= dnsWrittenAt + legacyCheckWindowMs;
  });
  const checkedExpectedSuccessfully = evidence.some(({ probe, observation }) => {
    if (!observation.ok) return false;
    if (expected.has(normalizeComparableIp(observation.successfulAddress))) return true;
    const resolved = cleanTexts(observation.resolvedAddresses, 100).map(normalizeComparableIp).filter(Boolean);
    return !probeSupportsSuccessfulAddress(probe.agentVersion) && resolved.length > 0 && resolved.every((address) => expected.has(address));
  });
  if (checkedExpectedSuccessfully) return { action: 'succeeded' };
  const failedResolved = evidence.map(({ observation }) => cleanTexts(observation.resolvedAddresses, 100).map(normalizeComparableIp).filter(Boolean));
  const resolvedEveryExpected = expected.size > 0 && [...expected].every((address) => failedResolved.some((addresses) => addresses.includes(address)));
  const everyProbeFailedExpected = assigned.length > 0 && evidence.length === assigned.length && resolvedEveryExpected && evidence.every(({ observation }, index) => {
    const resolved = failedResolved[index];
    return resolved.length > 0 && resolved.every((address) => expected.has(address)) && completeConfiguredFailure(observation, target);
  });
  if (everyProbeFailedExpected) return { action: 'retry' };
  const deadline = Date.parse(incident.stabilization.deadlineAt || 0);
  if (!incident.stabilization.timeoutNotifiedAt && Number.isFinite(deadline) && now >= deadline) return { action: 'timed_out' };
  return { action: 'waiting' };
}

export function settleStabilizingIncidentForTarget(state, target, now = Date.now()) {
  const incident = state.incidents?.find((item) => item.targetId === target?.id && item.status === 'stabilizing');
  if (!incident) return { action: 'inactive', incidentId: '' };
  const result = evaluateIncidentStabilization(incident, target, state.probes || [], now);
  const incidentId = incident.id;
  if (result.action === 'succeeded') {
    completeIncidentSuccess(state, incidentId);
  } else if (result.action === 'retry') {
    const candidates = (incident.leaseIds || []).map((leaseId) => {
      const lease = state.ipLeases.find((item) => item.id === leaseId && item.incidentId === incidentId);
      const asset = state.ipAssets.find((item) => item.id === lease?.assetId);
      return lease && asset ? { leaseId, assetId: asset.id, address: asset.address } : null;
    }).filter(Boolean);
    discardUnusableIncidentIps(state, incidentId, candidates, '新 IP 经全部负责探针完整检查失败，已丢弃');
    updateIncident(state, incidentId, { status: 'queued', message: '新 IP 检查失败，正在尝试下一个备用 IP', error: '', executionId: '', allocatedIps: [], leaseIds: [], stabilization: null, finishedAt: '' });
    pushAudit(state, 'incident.stabilization_failed', 'incident', incidentId, `新 IP 检查失败，已丢弃 ${candidates.length} 个候选并继续同一事件`, 'probe');
  } else if (result.action === 'timed_out') {
    const timedOutAt = new Date(now).toISOString();
    incident.stabilization.timeoutNotifiedAt = timedOutAt;
    updateIncident(state, incidentId, { message: 'DNS 传播超时，继续等待' });
    pushAudit(state, 'incident.dns_timeout', 'incident', incidentId, 'DNS 传播超时，保留当前备用 IP 并继续等待探针解析生效', 'system');
  } else if (result.action === 'waiting') {
    const leaseIds = new Set(incident.leaseIds || []);
    for (const lease of state.ipLeases || []) {
      if (leaseIds.has(lease.id)) lease.expiresAt = new Date(now + ALLOCATION_LOCK_TTL_MS).toISOString();
    }
  }
  return { ...result, incidentId };
}

function createIncidentStabilization(state, incident, target, policy) {
  if (!incident || !target || !policy || net.isIP(target.address)) return null;
  const targetDomain = String(target.address || '').trim().toLowerCase().replace(/\.$/, '');
  const bindings = (state.dnsBindings || []).filter((binding) =>
    policy.dnsBindingIds?.includes(binding.id) && binding.enabled !== false &&
    ['A', 'AAAA'].includes(binding.recordType) && String(binding.domain || '').trim().toLowerCase().replace(/\.$/, '') === targetDomain
  );
  if (!bindings.length) return null;
  const expectedAddresses = [...new Set(bindings.flatMap((binding) => filterAddressFamily(incident.allocatedIps || [], binding.recordType)))];
  if (!expectedAddresses.length) return null;
  const bindingIds = bindings.map((binding) => binding.id);
  const changes = (state.dnsChanges || []).filter((change) => change.incidentId === incident.id && bindingIds.includes(change.bindingId) && change.status === 'applied');
  if (!changes.length) return null;
  const writtenTimes = changes.map((change) => Date.parse(change.createdAt || 0)).filter(Number.isFinite);
  const writtenMs = writtenTimes.length ? Math.max(...writtenTimes) : Date.now();
  const maxTtl = Math.max(...bindings.map((binding) => clampNumber(binding.ttl, 1, 86400, 60)));
  const propagationSeconds = Math.min(1800, Math.max(180, 2 * maxTtl + 60));
  return {
    expectedAddresses,
    bindingIds,
    domains: [...new Set(bindings.map((binding) => binding.domain))],
    dnsWrittenAt: new Date(writtenMs).toISOString(),
    deadlineAt: new Date(writtenMs + propagationSeconds * 1000).toISOString(),
    checkMarker: '',
    timeoutNotifiedAt: ''
  };
}

function completeIncidentSuccess(state, incidentId) {
  const incident = state.incidents.find((item) => item.id === incidentId);
  const consumed = consumeIncidentIpAssets(state, incidentId);
  finalizeIpUsageRecords(state, incidentId, 'consumed', '', incident?.leaseIds);
  updateIncident(state, incidentId, { status: 'succeeded', message: '故障切换完成', error: '', executionId: '', finishedAt: nowIso() });
  pushAudit(state, 'incident.succeeded', 'incident', incidentId, `自动故障切换完成，已消耗 ${consumed.addresses.length} 个备用 IP`, 'system');
  return consumed;
}

function normalizeComparableIp(value) {
  const address = cleanText(value, 80);
  if (net.isIPv4(address)) return address.split('.').map(Number).join('.');
  if (!net.isIPv6(address)) return '';
  try { return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase(); }
  catch (_error) { return address.toLowerCase(); }
}

function checkMarkerAtOrAfter(actual, required) {
  if (!actual || !required) return false;
  const actualTime = Date.parse(actual);
  const requiredTime = Date.parse(required);
  if (Number.isFinite(actualTime) && Number.isFinite(requiredTime)) return actualTime >= requiredTime;
  return actual === required;
}

function hasAvailableIpForIncident(incident, state) {
  const policy = state.failoverPolicies.find((item) => item.id === incident?.policyId && item.enabled !== false);
  if (!policy?.poolIds?.length) return false;
  return policy.poolIds.some((poolId) => {
    const pool = state.ipPools.find((item) => item.id === poolId && item.enabled !== false);
    return Boolean(pool?.assetIds?.some((assetId) => {
      const asset = state.ipAssets.find((item) => item.id === assetId);
      return asset?.enabled !== false && asset?.health !== 'unhealthy' && canAllocateAsset(state, asset.id);
    }));
  });
}

function createIncident(target, policy, probeId) {
  return { id: uuidv4(), targetId: target.id, targetName: target.name, policyId: policy.id, policyName: policy.name, sourceProbeId: probeId, status: policy.approvalMode === 'telegram' ? 'pending_approval' : 'queued', message: policy.approvalMode === 'telegram' ? '等待确认' : '等待执行', allocatedIps: [], leaseIds: [], automationJobId: '', dnsChangeIds: [], executionId: '', claimedAt: '', recheckRequestedAt: '', error: '', startedAt: nowIso(), updatedAt: nowIso(), finishedAt: '' };
}

function allocateIpsForIncident(incidentId, deps) {
  const allocated = [];
  deps.updateState((draft) => {
    const incident = draft.incidents.find((item) => item.id === incidentId);
    const policy = draft.failoverPolicies.find((item) => item.id === incident?.policyId);
    if (!incident || !policy) throw new Error('故障策略不存在');
    const alreadySelected = new Set();
    const existingLeases = draft.ipLeases.filter((lease) => lease.incidentId === incidentId && ['locked', 'active'].includes(lease.status) && Date.parse(lease.expiresAt) > Date.now());
    for (const lease of existingLeases) {
      const asset = draft.ipAssets.find((item) => item.id === lease.assetId);
      if (asset) {
        allocated.push({ address: asset.address, assetId: asset.id, leaseId: lease.id, poolId: lease.poolId });
        alreadySelected.add(asset.id);
      }
    }
    const firstPool = draft.ipPools.find((item) => item.id === policy.poolIds?.[0]);
    const desired = firstPool?.allocationMode === 'all'
      ? Number.MAX_SAFE_INTEGER
      : firstPool?.allocationMode === 'count'
        ? firstPool.allocationCount
        : 1;
    for (const poolId of policy.poolIds || []) {
      if (allocated.length >= desired) break;
      const pool = draft.ipPools.find((item) => item.id === poolId && item.enabled !== false);
      if (!pool) continue;
      let candidates = pool.assetIds.map((id) => draft.ipAssets.find((item) => item.id === id)).filter((item) => item?.enabled !== false && item.health !== 'unhealthy');
      candidates = candidates.filter((asset) => !alreadySelected.has(asset.id) && canAllocateAsset(draft, asset.id));
      if (pool.selectionMode === 'random') candidates.sort(() => Math.random() - 0.5);
      const count = Math.min(candidates.length, desired - allocated.length);
      for (const asset of candidates.slice(0, count)) {
        const lease = { id: uuidv4(), assetId: asset.id, poolId: pool.id, incidentId, targetId: incident.targetId, status: 'locked', createdAt: nowIso(), expiresAt: new Date(Date.now() + ALLOCATION_LOCK_TTL_MS).toISOString(), releasedAt: '' };
        draft.ipLeases.push(lease);
        allocated.push({ address: asset.address, assetId: asset.id, leaseId: lease.id, poolId: pool.id });
        alreadySelected.add(asset.id);
      }
    }
    return draft;
  });
  return allocated;
}

function canAllocateAsset(state, assetId) {
  const active = state.ipLeases.filter((lease) => {
    if (lease.assetId !== assetId || !['locked', 'active'].includes(lease.status)) return false;
    const incident = state.incidents?.find((item) => item.id === lease.incidentId);
    return incident?.status === 'stabilizing' || Date.parse(lease.expiresAt) > Date.now();
  });
  return active.length === 0;
}

async function checkReplacementIp(address, deps) {
  if (deps.checkIp) {
    try {
      const result = await deps.checkIp(address, 3);
      return { attempts: 3, ok: Boolean(result?.ok), error: cleanText(result?.error, 300) };
    } catch (error) {
      return { attempts: 3, ok: false, error: cleanText(error?.message || '备用 IP Ping 检查失败', 300) };
    }
  }
  const familyFlag = net.isIPv6(address) ? '-6' : net.isIPv4(address) ? '-4' : '';
  const args = process.platform === 'win32'
    ? [familyFlag, '-n', '3', '-w', '2000', address]
    : process.platform === 'darwin'
      ? [familyFlag, '-c', '3', '-W', '2000', address]
      : [familyFlag, '-c', '3', '-W', '2', address];
  const commandArgs = args.filter(Boolean);
  try {
    await execFile('ping', commandArgs, { timeout: 12000, maxBuffer: 32 * 1024 });
    return { attempts: 3, ok: true, error: '' };
  } catch (error) {
    return { attempts: 3, ok: false, error: cleanText(error?.stderr || error?.message || '备用 IP Ping 检查失败', 300) };
  }
}

function discardUnusableIncidentIps(state, incidentId, unusable, reason = '备用 IP Ping 3 次失败，已丢弃') {
  const assetIds = new Set(unusable.map((item) => item.assetId).filter(Boolean));
  const leaseIds = new Set(unusable.map((item) => item.leaseId).filter(Boolean));
  if (!assetIds.size) return;
  state.ipAssets = state.ipAssets.filter((asset) => !assetIds.has(asset.id));
  for (const pool of state.ipPools) pool.assetIds = (pool.assetIds || []).filter((assetId) => !assetIds.has(assetId));
  state.ipLeases = state.ipLeases.filter((lease) => !leaseIds.has(lease.id));
  const incident = state.incidents.find((item) => item.id === incidentId);
  if (incident) {
    incident.leaseIds = (incident.leaseIds || []).filter((leaseId) => !leaseIds.has(leaseId));
    incident.allocatedIps = (incident.allocatedIps || []).filter((address) => !unusable.some((item) => item.address === address));
  }
  finalizeIpUsageRecords(state, incidentId, 'discarded', reason, [...leaseIds]);
  for (const item of unusable) pushAudit(state, 'ip_preflight.discard', 'ipAsset', item.assetId, `${item.address} ${reason}`, 'system');
}

export function consumeIncidentIpAssets(state, incidentId) {
  const incidentLeases = state.ipLeases.filter((lease) => lease.incidentId === incidentId);
  const assetIds = new Set(incidentLeases.map((lease) => lease.assetId).filter(Boolean));
  const addresses = state.ipAssets.filter((asset) => assetIds.has(asset.id)).map((asset) => asset.address);
  state.ipAssets = state.ipAssets.filter((asset) => !assetIds.has(asset.id));
  for (const pool of state.ipPools) {
    pool.assetIds = (pool.assetIds || []).filter((assetId) => !assetIds.has(assetId));
  }
  state.ipLeases = state.ipLeases.filter((lease) => lease.incidentId !== incidentId && !assetIds.has(lease.assetId));
  return { assetIds: [...assetIds], addresses };
}

export function releaseIncidentIpLocks(state, incidentId) {
  const previousCount = state.ipLeases.length;
  state.ipLeases = state.ipLeases.filter((lease) => lease.incidentId !== incidentId);
  return previousCount - state.ipLeases.length;
}

export function startIpUsageRecords(state, incidentId, allocated = []) {
  state.ipUsageRecords ||= [];
  const incident = state.incidents.find((item) => item.id === incidentId);
  const policy = state.failoverPolicies.find((item) => item.id === incident?.policyId);
  const target = state.probeTargets.find((item) => item.id === incident?.targetId);
  const automationTask = state.automationTasks?.find((item) => item.id === policy?.automationTaskId);
  const bindings = (state.dnsBindings || [])
    .filter((item) => policy?.dnsBindingIds?.includes(item.id))
    .map((item) => ({ id: item.id, domain: item.domain, recordType: item.recordType }));
  const existingLeaseIds = new Set(state.ipUsageRecords.map((item) => item.leaseId));
  const records = allocated
    .filter((item) => item.leaseId && !existingLeaseIds.has(item.leaseId))
    .map((item) => {
      const pool = state.ipPools.find((entry) => entry.id === item.poolId);
      return {
        id: uuidv4(),
        leaseId: item.leaseId,
        assetId: item.assetId,
        address: item.address,
        poolId: item.poolId,
        poolName: pool?.name || '',
        incidentId,
        targetId: incident?.targetId || '',
        targetName: target?.name || incident?.targetName || '',
        policyId: incident?.policyId || '',
        policyName: policy?.name || incident?.policyName || '',
        automationTaskId: policy?.automationTaskId || '',
        automationTaskName: automationTask?.name || '',
        bindings,
        status: 'processing',
        preflight: { attempts: 0, ok: null, checkedAt: '', error: '' },
        startedAt: nowIso(),
        finishedAt: '',
        error: ''
      };
    });
  state.ipUsageRecords = [...records, ...state.ipUsageRecords].slice(0, 5000);
  return records;
}

export function finalizeIpUsageRecords(state, incidentId, status, error = '', leaseIds = null) {
  state.ipUsageRecords ||= [];
  const finishedAt = nowIso();
  const allowedLeaseIds = Array.isArray(leaseIds) && leaseIds.length ? new Set(leaseIds) : null;
  let updated = 0;
  for (const record of state.ipUsageRecords) {
    if (record.incidentId !== incidentId || !['processing', 'rolled_back'].includes(record.status)) continue;
    if (allowedLeaseIds && !allowedLeaseIds.has(record.leaseId)) continue;
    Object.assign(record, { status, error: cleanText(error, 1000), finishedAt });
    updated += 1;
  }
  return updated;
}

export function syncDnsBindingLocalState(binding, values, managedValues, providerRecordIds = [], syncedAt = nowIso()) {
  const normalizedValues = normalizeDnsRecordValues(values, binding.recordType);
  const normalizedRecordIds = cleanTexts(providerRecordIds, 500);
  Object.assign(binding, {
    ...(isAddressRecord(binding.recordType) ? { backupIps: normalizedValues, managedValues: normalizeDnsRecordValues(managedValues, binding.recordType) } : { recordValues: normalizedValues }),
    currentValues: normalizedValues,
    providerRecordId: normalizedRecordIds[0] || '',
    providerRecordIds: normalizedRecordIds,
    lastSyncAt: syncedAt,
    lastSyncError: '',
    updatedAt: syncedAt
  });
  return binding;
}

export function restoreDnsBindingLocalState(binding, change, providerRecordIds = [], syncedAt = nowIso()) {
  const beforeValues = normalizeDnsRecordValues(change.beforeValues, binding.recordType);
  const beforeManagedValues = change.beforeManagedValues?.length ? change.beforeManagedValues : beforeValues;
  syncDnsBindingLocalState(binding, beforeValues, beforeManagedValues, providerRecordIds, syncedAt);
  return binding;
}

async function applyDnsBinding(binding, allocatedIps, incidentId, deps) {
  if (!['A', 'AAAA'].includes(binding.recordType)) throw new Error(`故障切换不能更新 ${binding.recordType} 记录`);
  const state = deps.readState();
  const account = state.dnsAccounts.find((item) => item.id === binding.accountId && item.enabled !== false);
  if (!account) throw new Error(`解析绑定 ${binding.name} 的账号不可用`);
  const credentials = decryptCredentials(account, deps);
  const resolveDnsBinding = deps.resolveDnsBinding || resolveManagedDnsZone;
  const readDnsRecord = deps.readDnsRecord || getDnsRecord;
  const writeDnsRecord = deps.writeDnsRecord || updateDnsRecord;
  const { zone, normalizedBinding } = await resolveDnsBinding(state, account, credentials, binding);
  const before = await readDnsRecord(account, credentials, zone, normalizedBinding);
  const current = normalizeDnsRecordValues(before.values, binding.recordType);
  const currentRecordIds = cleanTexts(before.recordIds || (before.recordId ? [before.recordId] : []), 500);
  const providerBinding = { ...normalizedBinding, providerRecordId: currentRecordIds[0] || '', providerRecordIds: currentRecordIds };
  const replacementIps = filterAddressFamily(allocatedIps, binding.recordType);
  if (!replacementIps.length) throw new Error(`解析绑定 ${binding.name} 没有匹配的 ${binding.recordType} 备用 IP`);
  const after = dnsBindingDesiredValues(binding, current, replacementIps);
  let providerRecordIds = [];
  let writeStarted = false;
  try {
    writeStarted = true;
    providerRecordIds = await writeDnsRecord(account, credentials, zone, providerBinding, after);
    const savedAt = nowIso();
    deps.updateState((draft) => {
      const currentBinding = draft.dnsBindings.find((item) => item.id === binding.id);
      const change = { id: uuidv4(), incidentId, bindingId: binding.id, accountId: account.id, zoneId: zone.id || '', zoneName: zone.name, providerZoneId: zone.providerZoneId || '', domain: binding.domain, recordType: binding.recordType, provider: account.provider, beforeValues: current, afterValues: after, beforeManagedValues: currentBinding?.managedValues || binding.managedValues || [], afterManagedValues: replacementIps, status: 'applied', createdAt: savedAt, rolledBackAt: '' };
      draft.dnsChanges.unshift(change);
      const incident = draft.incidents.find((item) => item.id === incidentId);
      if (incident) incident.dnsChangeIds = [...(incident.dnsChangeIds || []), change.id];
      const bindingItem = currentBinding;
      if (bindingItem) syncDnsBindingLocalState(bindingItem, after, replacementIps, providerRecordIds, savedAt);
      pushAudit(draft, 'dns.update', 'dnsBinding', binding.id, `${binding.domain}: ${current.join(',')} -> ${after.join(',')}`, 'system');
      return draft;
    });
  } catch (error) {
    if (writeStarted) {
      try {
        const restoredRecordIds = await writeDnsRecord(account, credentials, zone, { ...providerBinding, providerRecordId: providerRecordIds?.[0] || providerBinding.providerRecordId, providerRecordIds: providerRecordIds || providerBinding.providerRecordIds }, current);
        await verifyProviderDnsValues(account, credentials, zone, { ...normalizedBinding, providerRecordIds: restoredRecordIds }, current, '服务商记录未恢复到写入前内容', readDnsRecord);
      } catch (rollbackError) {
        const failedAt = nowIso();
        deps.updateState((draft) => {
          const currentBinding = draft.dnsBindings.find((item) => item.id === binding.id);
          const change = { id: uuidv4(), incidentId, bindingId: binding.id, accountId: account.id, zoneId: zone.id || '', zoneName: zone.name, providerZoneId: zone.providerZoneId || '', domain: binding.domain, recordType: binding.recordType, provider: account.provider, beforeValues: current, afterValues: after, beforeManagedValues: currentBinding?.managedValues || binding.managedValues || [], afterManagedValues: replacementIps, status: 'recovery_pending', error: cleanText(rollbackError.message, 500), createdAt: failedAt, rolledBackAt: '' };
          draft.dnsChanges.unshift(change);
          const currentIncident = draft.incidents.find((item) => item.id === incidentId);
          if (currentIncident) currentIncident.dnsChangeIds = [...(currentIncident.dnsChangeIds || []), change.id];
          if (currentBinding) Object.assign(currentBinding, { lastSyncError: `远端状态待恢复：${cleanText(rollbackError.message, 300)}`, updatedAt: failedAt });
          pushAudit(draft, 'dns.recovery_pending', 'dnsBinding', binding.id, `${binding.domain} 部分写入后恢复失败，已进入待恢复状态`, 'system');
          return draft;
        });
        throw new Error(`DNS 写入失败且自动恢复失败：${cleanText(error.message, 240)}；${cleanText(rollbackError.message, 240)}`);
      }
    }
    throw new Error(`DNS 写入失败，已恢复原记录：${cleanText(error.message, 300)}`);
  }
}

export async function rollbackIncident(incidentId, deps, actor) {
  const state = deps.readState();
  const incident = state.incidents.find((item) => item.id === incidentId);
  if (!incident) throw new Error('故障事件不存在');
  deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'rolling_back', message: '正在回滚 DNS 并释放备用 IP' }));
  try {
    for (const changeId of [...(incident.dnsChangeIds || [])].reverse()) {
      const current = deps.readState();
      const change = current.dnsChanges.find((item) => item.id === changeId && ACTIVE_DNS_CHANGE_STATES.has(item.status));
      if (!change) continue;
      const binding = current.dnsBindings.find((item) => item.id === change.bindingId);
      const account = current.dnsAccounts.find((item) => item.id === change.accountId);
      if (!binding) throw new Error(`DNS 回滚失败：解析绑定 ${change.bindingId} 不存在`);
      if (!account) throw new Error(`DNS 回滚失败：${binding.domain} 的服务商账号不存在`);
      const credentials = decryptCredentials(account, deps);
      const resolveDnsBinding = deps.resolveDnsBinding || resolveManagedDnsZone;
      const readDnsRecord = deps.readDnsRecord || getDnsRecord;
      const writeDnsRecord = deps.writeDnsRecord || updateDnsRecord;
      const discovered = change.zoneName ? { zone: { id: change.zoneId, name: change.zoneName, providerZoneId: change.providerZoneId }, normalizedBinding: withRecordName(binding, change.zoneName) } : await resolveDnsBinding(current, account, credentials, binding);
      const providerRecordIds = await writeDnsRecord(account, credentials, discovered.zone, discovered.normalizedBinding, change.beforeValues);
      await verifyProviderDnsValues(account, credentials, discovered.zone, { ...discovered.normalizedBinding, providerRecordIds }, change.beforeValues, `DNS 回滚验证失败：${binding.domain}`, readDnsRecord);
      deps.updateState((draft) => {
        const item = draft.dnsChanges.find((entry) => entry.id === change.id);
        if (item) Object.assign(item, { status: 'rolled_back', rolledBackAt: nowIso() });
        const bindingItem = draft.dnsBindings.find((entry) => entry.id === binding.id);
        if (bindingItem) restoreDnsBindingLocalState(bindingItem, change, providerRecordIds);
        return draft;
      });
    }
    const next = deps.updateState((draft) => {
      releaseIncidentIpLocks(draft, incidentId);
      finalizeIpUsageRecords(draft, incidentId, 'rolled_back', '', incident.leaseIds);
      updateIncident(draft, incidentId, { status: 'rolled_back', message: '已回滚', error: '', executionId: '', finishedAt: nowIso() });
      pushAudit(draft, 'incident.rollback', 'incident', incidentId, '回滚 DNS 变更并释放备用 IP', actor);
      return draft;
    });
    return { incident: next.incidents.find((item) => item.id === incidentId) };
  } catch (error) {
    deps.updateState((draft) => {
      updateIncident(draft, incidentId, { status: 'failed', message: '回滚失败', error: cleanText(error.message, 1000), executionId: '', finishedAt: nowIso() });
      pushAudit(draft, 'incident.rollback_failed', 'incident', incidentId, cleanText(error.message, 500), actor);
      return draft;
    });
    throw error;
  }
}

export function dnsVerificationMatches(recordType, actualValues, expectedValues) {
  const expected = normalizeDnsRecordValues(expectedValues, recordType);
  const actual = normalizeDnsRecordValues(actualValues, recordType);
  return sameStringSet(actual, expected);
}

async function verifyProviderDnsValues(account, credentials, zone, binding, expectedValues, failureLabel, readDnsRecord = getDnsRecord) {
  let lastError = null;
  for (const delay of DNS_PROVIDER_VERIFY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const remote = await readDnsRecord(account, credentials, zone, binding);
      if (dnsVerificationMatches(binding.recordType, remote.values, expectedValues)) return remote;
      lastError = new Error('服务商记录暂未与预期内容一致');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${failureLabel}${lastError?.message ? `（${cleanText(lastError.message, 180)}）` : ''}`);
}

async function verifyDnsBindings(bindings, incidentId, deps) {
  for (const binding of bindings) {
    if (!['A', 'AAAA'].includes(binding.recordType)) continue;
    const expectedChange = deps.readState().dnsChanges
      .filter((item) => item.incidentId === incidentId && item.bindingId === binding.id && item.status === 'applied')
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))[0];
    if (!expectedChange) throw new Error(`DNS 变更快照不存在：${binding.domain}`);
    const expectedValues = expectedChange?.afterValues || [];
    const state = deps.readState();
    const currentBinding = state.dnsBindings.find((item) => item.id === binding.id) || binding;
    const account = state.dnsAccounts.find((item) => item.id === currentBinding.accountId && item.enabled !== false);
    if (!account) throw new Error(`DNS 服务商记录验证失败：${binding.domain}（账号不可用）`);
    const credentials = decryptCredentials(account, deps);
    const resolveDnsBinding = deps.resolveDnsBinding || resolveManagedDnsZone;
    const readDnsRecord = deps.readDnsRecord || getDnsRecord;
    const { zone, normalizedBinding } = await resolveDnsBinding(state, account, credentials, currentBinding);
    await verifyProviderDnsValues(account, credentials, zone, normalizedBinding, expectedValues, `DNS 服务商记录与预期不一致：${binding.domain}`, readDnsRecord);
  }
}

async function testDnsAccount(account, credentials) {
  if (account.provider === 'cloudflare') return cloudflareRequest(credentials, 'GET', '/zones?per_page=1');
  if (account.provider === 'huawei') return huaweiRequest(account, credentials, 'GET', '/v2/zones?limit=1');
  if (account.provider === 'aliyun') return aliyunRequest(credentials, 'DescribeDomains', { PageSize: 1 });
  if (account.provider === 'tencent') return tencentRequest(credentials, 'DescribeDomainList', { Offset: 0, Limit: 1 });
  if (account.provider === 'dnspod') return dnspodRequest(credentials, 'Domain.List', { length: 1 });
  if (account.provider === 'godaddy') return godaddyRequest(credentials, 'GET', '/v1/domains?limit=1');
  if (account.provider === 'porkbun') return porkbunRequest(credentials, '/api/json/v3/ping');
  if (account.provider === 'cloudns') return cloudnsRequest(credentials, '/dns/list-zones.json');
  if (CALLBACK_PROVIDERS.has(account.provider)) return callbackRequest(account, credentials, { action: 'test', provider: account.provider });
  throw new Error('不支持的 DNS 服务商');
}

export async function resolveManagedDnsZone(state, account, credentials, binding) {
  const legacy = state.dnsZones.find((item) => item.id === binding.zoneId && item.accountId === account.id && item.enabled !== false);
  if (legacy) return { zone: legacy, normalizedBinding: withRecordName(binding, legacy.name) };
  const domain = normalizeDomain(binding.domain);
  const savedZoneName = cleanText(binding.zoneName, 253).toLowerCase().replace(/\.$/, '');
  if (savedZoneName && (domain === savedZoneName || domain.endsWith(`.${savedZoneName}`))) {
    const zone = { id: '', name: savedZoneName, providerZoneId: cleanText(binding.providerZoneId, 200) };
    return { zone, normalizedBinding: withRecordName(binding, savedZoneName) };
  }
  let zones = await listProviderZonesCached(account, credentials);
  let matches = zones.filter((zone) => domain === zone.name || domain.endsWith(`.${zone.name}`)).sort((left, right) => right.name.length - left.name.length);
  if (!matches.length && dnsZoneCache.has(`${account.id}:${account.provider}`)) {
    dnsZoneCache.delete(`${account.id}:${account.provider}`);
    zones = await listProviderZonesCached(account, credentials);
    matches = zones.filter((zone) => domain === zone.name || domain.endsWith(`.${zone.name}`)).sort((left, right) => right.name.length - left.name.length);
  }
  if (!matches.length) throw new Error(`账号中未找到 ${domain} 对应的托管域`);
  return { zone: matches[0], normalizedBinding: withRecordName(binding, matches[0].name) };
}

async function listProviderZonesCached(account, credentials) {
  const key = `${account.id}:${account.provider}`;
  const now = Date.now();
  const cached = dnsZoneCache.get(key);
  if (cached?.zones && now - cached.createdAt < DNS_ZONE_CACHE_TTL_MS) return cached.zones;
  if (cached?.pending) return cached.pending;
  const pending = listProviderZones(account, credentials)
    .then((zones) => {
      dnsZoneCache.set(key, { zones, createdAt: Date.now() });
      return zones;
    })
    .catch((error) => {
      dnsZoneCache.delete(key);
      throw error;
    });
  dnsZoneCache.set(key, { pending, createdAt: now });
  return pending;
}

export function withRecordName(binding, zoneName) {
  const domain = normalizeDomain(binding.domain);
  const zone = normalizeDomain(zoneName);
  const recordName = domain === zone ? '@' : domain.slice(0, -(zone.length + 1));
  return { ...binding, recordName };
}

async function listProviderZones(account, credentials) {
  if (account.provider === 'cloudflare') {
    const zones = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await cloudflareRequest(credentials, 'GET', `/zones?per_page=50&page=${page}`);
      zones.push(...(data.result || []));
      if (page >= Number(data.result_info?.total_pages || 1) || !(data.result || []).length) break;
    }
    return zones.map((item) => ({ id: '', name: normalizeDomain(item.name), providerZoneId: String(item.id) }));
  }
  if (account.provider === 'huawei') {
    const zones = [];
    let marker = '';
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '500' });
      if (marker) query.set('marker', marker);
      const data = await huaweiRequest(account, credentials, 'GET', `/v2/zones?${query}`);
      const batch = data.zones || [];
      zones.push(...batch);
      const next = data.links?.next ? new URL(data.links.next, 'https://dns.myhuaweicloud.com').searchParams.get('marker') : '';
      if (!next || next === marker || !batch.length) break;
      marker = next;
    }
    return zones.map((item) => ({ id: '', name: normalizeDomain(item.name), providerZoneId: String(item.id) }));
  }
  if (account.provider === 'aliyun') {
    const zones = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await aliyunRequest(credentials, 'DescribeDomains', { PageNumber: page, PageSize: 100 });
      const batch = data.Domains?.Domain || [];
      zones.push(...batch);
      if (zones.length >= Number(data.TotalCount || batch.length) || !batch.length) break;
    }
    return zones.map((item) => ({ id: '', name: normalizeDomain(item.DomainName), providerZoneId: String(item.DomainId || '') }));
  }
  if (account.provider === 'tencent') {
    const zones = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const data = await tencentRequest(credentials, 'DescribeDomainList', { Offset: offset, Limit: 100 });
      const batch = data.Response?.DomainList || [];
      zones.push(...batch);
      if (zones.length >= Number(data.Response?.DomainCountInfo?.AllTotal || batch.length) || !batch.length) break;
    }
    return zones.map((item) => ({ id: '', name: normalizeDomain(item.Name), providerZoneId: String(item.DomainId || '') }));
  }
  if (account.provider === 'dnspod') {
    const data = await dnspodRequest(credentials, 'Domain.List', { length: 3000 });
    return (data.domains || []).map((item) => ({ id: '', name: normalizeDomain(item.name), providerZoneId: String(item.id || '') }));
  }
  if (account.provider === 'godaddy') {
    const data = await godaddyRequest(credentials, 'GET', '/v1/domains?limit=1000');
    return (data || []).map((item) => ({ id: '', name: normalizeDomain(item.domain), providerZoneId: '' }));
  }
  if (account.provider === 'porkbun') {
    const data = await porkbunRequest(credentials, '/api/json/v3/domain/listAll');
    return (data.domains || []).map((item) => ({ id: '', name: normalizeDomain(item.domain), providerZoneId: '' }));
  }
  if (account.provider === 'cloudns') {
    const data = await cloudnsRequest(credentials, '/dns/list-zones.json');
    return Object.values(data || {}).map((item) => ({ id: '', name: normalizeDomain(item.name), providerZoneId: String(item.zone || item.id || '') }));
  }
  if (CALLBACK_PROVIDERS.has(account.provider)) {
    const data = await callbackRequest(account, credentials, { action: 'zones', provider: account.provider });
    return (data.zones || []).map((item) => typeof item === 'string' ? ({ id: '', name: normalizeDomain(item), providerZoneId: '' }) : ({ id: '', name: normalizeDomain(item.name), providerZoneId: String(item.id || '') }));
  }
  return [];
}

async function resolveBindingSources(binding) {
  if (!isAddressRecord(binding.recordType)) return cleanRecordValues(binding.recordValues, binding.recordType === 'CNAME' ? 1 : 5000);
  const family = binding.recordType === 'AAAA' ? 6 : 4;
  const sources = Array.isArray(binding.ddnsSources) ? binding.ddnsSources : [];
  const output = [];
  for (const source of sources) {
    const domains = [source.domain, source.backupDomain].filter(Boolean);
    for (const domain of domains) {
      try {
        const addresses = await resolveDomainAddresses(domain, family);
        for (const address of addresses) if (!output.includes(address)) output.push(address);
      } catch (_error) {
        // Sources without an address of the requested family are ignored.
      }
    }
  }
  for (const value of binding.backupIps || []) {
    if (net.isIP(value) === family && !output.includes(value)) output.push(value);
  }
  return output.slice(0, binding.maxActiveIps || 50);
}

function isAddressRecord(recordType) {
  return recordType === 'A' || recordType === 'AAAA';
}

function normalizeDnsRecordValues(values, recordType) {
  if (isAddressRecord(recordType)) return filterAddressFamily(cleanTexts(values, 5000), recordType);
  return cleanRecordValues(values, recordType === 'CNAME' ? 1 : 5000);
}

function withoutProviderRecordIds(binding) {
  return { ...binding, providerRecordId: '', providerRecordIds: [] };
}

export function dnsBindingDesiredValues(binding, currentValues, configuredValues) {
  const current = normalizeDnsRecordValues(currentValues, binding.recordType);
  const configured = normalizeDnsRecordValues(configuredValues, binding.recordType);
  if (!configured.length) return current;
  if (!isAddressRecord(binding.recordType)) return configured;
  if (binding.updateMode === 'append') return [...new Set([...current, ...configured])];
  if (binding.updateMode === 'managed_replace') {
    const managed = new Set(normalizeDnsRecordValues(binding.managedValues, binding.recordType));
    return [...new Set([...current.filter((value) => !managed.has(value)), ...configured])];
  }
  return configured;
}

async function resolveDomainAddresses(domain, family) {
  const errors = [];
  try {
    const records = family === 6 ? await dns.resolve6(domain) : await dns.resolve4(domain);
    const addresses = [...new Set(records.filter((address) => net.isIP(address) === family))];
    if (addresses.length) return addresses;
  } catch (error) {
    errors.push(cleanText(error.message, 160));
  }
  try {
    const records = await dns.lookup(domain, { all: true, family, verbatim: true });
    const addresses = [...new Set(records.map((record) => record.address).filter((address) => net.isIP(address) === family))];
    if (addresses.length) return addresses;
  } catch (error) {
    errors.push(cleanText(error.message, 160));
  }
  throw new Error(`${domain} 未解析出 ${family === 6 ? 'AAAA' : 'A'} 地址${errors.length ? `：${errors.join('；')}` : ''}`);
}

async function getDnsRecord(account, credentials, zone, binding) {
  if (CALLBACK_PROVIDERS.has(account.provider)) {
    const result = await callbackRequest(account, credentials, callbackPayload('read', zone, binding, []));
    return { values: cleanTexts(result?.values, 5000), recordId: '', recordIds: cleanTexts(result?.recordIds, 500) };
  }
  if (account.provider === 'godaddy') {
    const records = await godaddyRequest(credentials, 'GET', `/v1/domains/${encodeURIComponent(zone.name)}/records/${binding.recordType}/${encodeURIComponent(binding.recordName)}`);
    return { values: (records || []).map((item) => item.data).filter(Boolean), recordIds: [] };
  }
  if (account.provider === 'porkbun') {
    const result = await porkbunRequest(credentials, `/api/json/v3/dns/retrieve/${encodeURIComponent(zone.name)}`);
    const records = (result.records || []).filter((item) => item.type === binding.recordType && normalizeRecordName(item.name, zone.name) === binding.recordName);
    return { values: records.map((item) => item.content), recordIds: records.map((item) => String(item.id || '')).filter(Boolean) };
  }
  if (account.provider === 'cloudns') {
    const result = await cloudnsRequest(credentials, `/dns/records.json?domain-name=${encodeURIComponent(zone.name)}&host=${encodeURIComponent(binding.recordName)}`);
    const records = Object.entries(result || {}).filter(([, item]) => item?.type === binding.recordType);
    return { values: records.map(([, item]) => item.record || item.value || item.content).filter(Boolean), recordIds: records.map(([id]) => id) };
  }
  const recordIds = account.provider === 'huawei' ? [] : await discoverProviderRecordIds(account, credentials, zone, binding);
  if (account.provider === 'cloudflare') {
    const records = await Promise.all(recordIds.map((id) => cloudflareRequest(credentials, 'GET', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records/${encodeURIComponent(id)}`)));
    return { values: records.map((data) => data.result?.content).filter(Boolean), recordIds };
  }
  if (account.provider === 'huawei') {
    const recordset = await findHuaweiRecordset(account, credentials, zone, binding);
    const recordId = recordset?.id ? String(recordset.id) : '';
    return { values: recordset?.records || [], recordId, recordIds: recordId ? [recordId] : [] };
  }
  if (account.provider === 'aliyun') {
    const records = await Promise.all(recordIds.map((id) => aliyunRequest(credentials, 'DescribeDomainRecordInfo', { RecordId: id })));
    return { values: records.map((data) => data.Value).filter(Boolean), recordIds };
  }
  if (account.provider === 'dnspod') {
    const records = await Promise.all(recordIds.map((id) => dnspodRequest(credentials, 'Record.Info', { domain: zone.name, record_id: id })));
    return { values: records.map((data) => data.record?.value).filter(Boolean), recordIds };
  }
  const records = await Promise.all(recordIds.map((id) => tencentRequest(credentials, 'DescribeRecord', { Domain: zone.name, RecordId: Number(id) })));
  return { values: records.map((data) => data.Response?.RecordInfo?.Value).filter(Boolean), recordIds };
}

async function updateDnsRecord(account, credentials, zone, binding, values) {
  if (CALLBACK_PROVIDERS.has(account.provider)) {
    const result = await callbackRequest(account, credentials, callbackPayload('write', zone, binding, values));
    return cleanTexts(result?.recordIds, 500);
  }
  if (account.provider === 'godaddy') {
    await godaddyRequest(credentials, 'PUT', `/v1/domains/${encodeURIComponent(zone.name)}/records/${binding.recordType}/${encodeURIComponent(binding.recordName)}`, values.map((data) => ({ data, ttl: binding.ttl })));
    return values.map((_, index) => `godaddy-${index + 1}`);
  }
  if (account.provider === 'porkbun') return updatePorkbunRecords(credentials, zone, binding, values);
  if (account.provider === 'cloudns') return updateCloudnsRecords(credentials, zone, binding, values);
  const recordIds = account.provider === 'huawei' ? [] : await discoverProviderRecordIds(account, credentials, zone, binding);
  if (!values.length) {
    if (account.provider === 'huawei') {
      const recordId = cleanText(binding.providerRecordId || binding.providerRecordIds?.[0], 200);
      const recordset = recordId ? { id: recordId } : await findHuaweiRecordset(account, credentials, zone, binding);
      if (recordset?.id) await huaweiRequest(account, credentials, 'DELETE', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets/${encodeURIComponent(recordset.id)}`);
      return [];
    }
    for (const id of recordIds) {
      if (account.provider === 'cloudflare') await cloudflareRequest(credentials, 'DELETE', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records/${encodeURIComponent(id)}`);
      else if (account.provider === 'aliyun') await aliyunRequest(credentials, 'DeleteDomainRecord', { RecordId: id });
      else if (account.provider === 'dnspod') await dnspodRequest(credentials, 'Record.Remove', { domain: zone.name, record_id: id });
      else await tencentRequest(credentials, 'DeleteRecord', { Domain: zone.name, RecordId: Number(id) });
    }
    return [];
  }
  if (account.provider === 'cloudflare') {
    return reconcileProviderRecords(recordIds, values, {
      update: async (id, value) => { await cloudflareRequest(credentials, 'PUT', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records/${encodeURIComponent(id)}`, { type: binding.recordType, name: binding.domain, content: value, ttl: binding.ttl, proxied: false }); return id; },
      create: async (value) => (await cloudflareRequest(credentials, 'POST', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records`, { type: binding.recordType, name: binding.domain, content: value, ttl: binding.ttl, proxied: false })).result?.id,
      remove: (id) => cloudflareRequest(credentials, 'DELETE', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records/${encodeURIComponent(id)}`)
    });
  }
  if (account.provider === 'huawei') {
    const recordId = cleanText(binding.providerRecordId || binding.providerRecordIds?.[0], 200);
    const recordset = recordId ? { id: recordId } : await findHuaweiRecordset(account, credentials, zone, binding);
    const payload = { name: `${binding.domain}.`, type: binding.recordType, ttl: binding.ttl, records: values };
    if (recordset?.id) {
      await huaweiRequest(account, credentials, 'PUT', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets/${encodeURIComponent(recordset.id)}`, payload);
      return [recordset.id];
    }
    const created = await huaweiRequest(account, credentials, 'POST', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets`, payload);
    return created?.id ? [String(created.id)] : [];
  }
  if (account.provider === 'aliyun') {
    return reconcileProviderRecords(recordIds, values, {
      update: async (id, value) => { await aliyunRequest(credentials, 'UpdateDomainRecord', { RecordId: id, RR: binding.recordName, Type: binding.recordType, Value: value, TTL: binding.ttl }); return id; },
      create: async (value) => (await aliyunRequest(credentials, 'AddDomainRecord', { DomainName: zone.name, RR: binding.recordName, Type: binding.recordType, Value: value, TTL: binding.ttl })).RecordId,
      remove: (id) => aliyunRequest(credentials, 'DeleteDomainRecord', { RecordId: id })
    });
  }
  if (account.provider === 'dnspod') {
    return reconcileProviderRecords(recordIds, values, {
      update: async (id, value) => { await dnspodRequest(credentials, 'Record.Modify', { domain: zone.name, record_id: id, sub_domain: binding.recordName, record_type: binding.recordType, record_line: binding.recordLine || '默认', value, ttl: binding.ttl }); return id; },
      create: async (value) => String((await dnspodRequest(credentials, 'Record.Create', { domain: zone.name, sub_domain: binding.recordName, record_type: binding.recordType, record_line: binding.recordLine || '默认', value, ttl: binding.ttl })).record?.id || ''),
      remove: (id) => dnspodRequest(credentials, 'Record.Remove', { domain: zone.name, record_id: id })
    });
  }
  return reconcileProviderRecords(recordIds, values, {
    update: async (id, value) => { await tencentRequest(credentials, 'ModifyRecord', { Domain: zone.name, RecordType: binding.recordType, RecordLine: binding.recordLine || '默认', Value: value, RecordId: Number(id), SubDomain: binding.recordName, TTL: binding.ttl }); return id; },
    create: async (value) => String((await tencentRequest(credentials, 'CreateRecord', { Domain: zone.name, RecordType: binding.recordType, RecordLine: binding.recordLine || '默认', Value: value, SubDomain: binding.recordName, TTL: binding.ttl })).Response?.RecordId || ''),
    remove: (id) => tencentRequest(credentials, 'DeleteRecord', { Domain: zone.name, RecordId: Number(id) })
  });
}

async function reconcileProviderRecords(recordIds, values, adapter) {
  if (!values.length) throw new Error('DNS 记录值不能为空');
  const nextIds = [];
  for (let index = 0; index < values.length; index += 1) {
    const id = recordIds[index];
    const nextId = id ? await adapter.update(id, values[index]) : await adapter.create(values[index]);
    if (!nextId) throw new Error('DNS 服务商未返回记录 ID');
    nextIds.push(String(nextId));
  }
  for (const id of recordIds.slice(values.length)) await adapter.remove(id);
  return nextIds;
}

async function findHuaweiRecordset(account, credentials, zone, binding) {
  if (binding.providerRecordId) {
    try {
      const recordset = await huaweiRequest(account, credentials, 'GET', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets/${encodeURIComponent(binding.providerRecordId)}`);
      if (recordset && normalizeDomain(recordset.name) === binding.domain && recordset.type === binding.recordType) return recordset;
    } catch (_error) {
      // The record may have been deleted and recreated manually; discover its current ID by name.
    }
  }
  const query = `?name=${encodeURIComponent(`${binding.domain}.`)}&type=${encodeURIComponent(binding.recordType)}&limit=500`;
  const data = await huaweiRequest(account, credentials, 'GET', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets${query}`);
  const matches = (data.recordsets || []).filter((item) => normalizeDomain(item.name) === binding.domain && item.type === binding.recordType);
  if (matches.length > 1) {
    const requestedLine = cleanText(binding.recordLine, 100).toLowerCase();
    const lineMatches = matches.filter((item) => {
      const line = cleanText(item.line, 100).toLowerCase();
      if (!requestedLine || requestedLine === '默认' || requestedLine === 'default_view') return !line || line === 'default_view' || line === '默认';
      return line === requestedLine;
    });
    if (lineMatches.length === 1) return lineMatches[0];
    throw new Error(`华为云存在多个同名 ${binding.recordType} 记录，无法确定线路`);
  }
  return matches[0] || null;
}

async function discoverProviderRecordIds(account, credentials, zone, binding) {
  const configured = cleanTexts(binding.providerRecordIds, 500);
  if (configured.length) return configured;
  if (binding.providerRecordId) return [cleanText(binding.providerRecordId, 200)];
  if (account.provider === 'cloudflare') {
    const data = await cloudflareRequest(credentials, 'GET', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records?type=${encodeURIComponent(binding.recordType)}&name=${encodeURIComponent(binding.domain)}&per_page=100`);
    return (data.result || []).map((item) => String(item.id));
  }
  if (account.provider === 'aliyun') {
    const data = await aliyunRequest(credentials, 'DescribeSubDomainRecords', { DomainName: zone.name, SubDomain: binding.domain, Type: binding.recordType, PageSize: 500 });
    return (data.DomainRecords?.Record || []).filter((item) => item.Type === binding.recordType && normalizeRecordName(item.RR, zone.name) === binding.recordName).map((item) => String(item.RecordId));
  }
  if (account.provider === 'dnspod') {
    const data = await dnspodRequest(credentials, 'Record.List', { domain: zone.name, sub_domain: binding.recordName, record_type: binding.recordType, length: 3000 });
    return (data.records || []).filter((item) => item.type === binding.recordType).map((item) => String(item.id));
  }
  if (account.provider === 'cloudns') {
    const data = await cloudnsRequest(credentials, `/dns/records.json?domain-name=${encodeURIComponent(zone.name)}&host=${encodeURIComponent(binding.recordName)}&type=${encodeURIComponent(binding.recordType)}`);
    return Object.entries(data || {}).filter(([, item]) => item?.type === binding.recordType).map(([id]) => id);
  }
  const data = await tencentRequest(credentials, 'DescribeRecordList', { Domain: zone.name, Subdomain: binding.recordName, RecordType: binding.recordType, RecordLine: binding.recordLine || '默认', Limit: 100 });
  return (data.Response?.RecordList || []).map((item) => String(item.RecordId));
}

function normalizeDdnsSources(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const domains = new Set();
  const items = value.slice(0, 100);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item?.domain) continue;
    const domain = normalizeDomain(item.domain);
    if (domains.has(domain)) continue;
    domains.add(domain);
    let backupDomain = '';
    const next = items[index + 1];
    const itemId = cleanId(item.id) || `source-${index + 1}`;
    const itemName = cleanText(item.name, 100);
    const legacyBackup = !item.backupDomain && !item.backup_domain && next?.domain && !next.backupDomain && !next.backup_domain
      && cleanId(next.id) === `${itemId}-backup`
      && cleanText(next.name, 100) === (itemName ? `${itemName} 备用` : '备用来源');
    const backupValue = item.backupDomain || item.backup_domain || (legacyBackup ? next.domain : '');
    if (backupValue) {
      const normalizedBackup = normalizeDomain(backupValue);
      if (!domains.has(normalizedBackup) && normalizedBackup !== domain) {
        backupDomain = normalizedBackup;
        domains.add(normalizedBackup);
      }
    }
    result.push({
      id: itemId,
      name: itemName,
      domain,
      backupDomain
    });
    if (legacyBackup) index += 1;
  }
  return result;
}

function validateDdnsSources(value) {
  if (!Array.isArray(value)) return;
  if (value.length > 100) throw new Error('DDNS 来源最多 100 个');
  const ids = new Set();
  const domains = new Set();
  for (const [index, item] of value.entries()) {
    if (!item?.domain) continue;
    const id = cleanId(item.id) || `source-${index + 1}`;
    if (ids.has(id)) throw new Error('DDNS 来源 ID 不能重复');
    ids.add(id);
    const primary = normalizeDomain(item.domain);
    const backup = item.backupDomain || item.backup_domain ? normalizeDomain(item.backupDomain || item.backup_domain) : '';
    if (backup && backup === primary) throw new Error('备用 DDNS 域名不能与主域名相同');
    for (const domain of [primary, backup].filter(Boolean)) {
      if (domains.has(domain)) throw new Error(`DDNS 来源域名重复：${domain}`);
      domains.add(domain);
    }
  }
}

function normalizeDnsGuardState(value = {}) {
  return {
    ...value,
    name: cleanText(value.name, 200),
    accountId: cleanId(value.accountId),
    domain: cleanText(value.domain, 253).toLowerCase().replace(/\.$/, ''),
    recordType: value.recordType === 'AAAA' ? 'AAAA' : 'A',
    recordLine: cleanText(value.recordLine, 100) || '默认',
    ttl: clampNumber(value.ttl, 1, 86400, 60),
    maxActiveIps: clampNumber(value.maxActiveIps, 1, DNS_GUARD_MAX_VALUES, 50),
    probeIds: cleanIds(value.probeIds, 500),
    poolIds: cleanIds(value.poolIds, 100),
    checkType: value.checkType === 'tcp' ? 'tcp' : 'ping',
    port: clampNumber(value.port, 1, 65535, 443),
    interval: clampNumber(value.interval, 10, 86400, 30),
    timeout: clampNumber(value.timeout, 1, 60, 5),
    checkRounds: clampNumber(value.checkRounds, 1, 10, 3),
    attemptsPerRound: clampNumber(value.attemptsPerRound, 1, 10, 3),
    maxParallel: clampNumber(value.maxParallel, 1, 300, 20),
    sources: normalizeDdnsSources(value.sources || value.ddnsSources),
    pruneStale: value.pruneStale !== false,
    enabled: value.enabled !== false,
    status: cleanText(value.status, 40) || 'queued',
    message: cleanText(value.message, 300),
    currentValues: filterAddressFamily(cleanTexts(value.currentValues, DNS_GUARD_MAX_VALUES), value.recordType),
    ownedValues: filterAddressFamily(cleanTexts(value.ownedValues, DNS_GUARD_MAX_VALUES), value.recordType),
    sourceOwnedValues: filterAddressFamily(cleanTexts(value.sourceOwnedValues, DNS_GUARD_MAX_VALUES), value.recordType),
    sourceState: value.sourceState && typeof value.sourceState === 'object' ? value.sourceState : {},
    sourceErrors: cleanTexts(value.sourceErrors, 100),
    cycle: value.cycle && typeof value.cycle === 'object' ? value.cycle : null,
    providerRecordId: cleanText(value.providerRecordId, 200),
    providerRecordIds: cleanTexts(value.providerRecordIds, 500),
    zoneName: cleanText(value.zoneName, 253).toLowerCase().replace(/\.$/, ''),
    providerZoneId: cleanText(value.providerZoneId, 200),
    lastCheckAt: cleanText(value.lastCheckAt, 40),
    nextCheckAt: cleanText(value.nextCheckAt, 40),
    lastError: cleanText(value.lastError, 500)
  };
}

function normalizeThresholds(value) {
  const text = String(value ?? '').trim();
  const values = Array.isArray(value) ? value : (text ? text.split(/[,，\s]+/) : []);
  return [...new Set(values.map(Number).filter((item) => Number.isInteger(item) && item >= 0 && item <= 100000))].sort((left, right) => right - left).slice(0, 30);
}

export function crossedInventoryThresholds(before, after, thresholds) {
  if (!Number.isFinite(Number(before)) || !Number.isFinite(Number(after)) || Number(after) >= Number(before)) return [];
  return normalizeThresholds(thresholds).filter((level) => Number(before) > level && Number(after) <= level);
}

export function migratePoolAlertBotSelections(state) {
  const availableBotIds = cleanIds((state.telegramBots || [])
    .filter((bot) => bot.enabled !== false && bot.tokenEnc && bot.userIds?.length)
    .map((bot) => bot.id), 50);
  for (const pool of state.ipPools || []) {
    if (pool.alertEnabled && !pool.alertBotIds?.length && availableBotIds.length) pool.alertBotIds = [...availableBotIds];
  }
  return state;
}

function normalizeCheckEvidence(raw, target) {
  const checkRounds = clampNumber(target.checkRounds, 1, 10, 3);
  const attemptsPerRound = clampNumber(target.attemptsPerRound, 1, 10, 3);
  return {
    ok: Boolean(raw.ok),
    latencyMs: clampNumber(raw.latencyMs, 0, 600000, 0),
    error: cleanText(raw.error, 300),
    checkedAt: nowIso(),
    rounds: clampNumber(raw.rounds, 0, checkRounds, 0),
    attemptsPerRound: clampNumber(raw.attemptsPerRound, 0, attemptsPerRound, 0),
    roundsCompleted: clampNumber(raw.roundsCompleted, 0, checkRounds, 0),
    attempts: clampNumber(raw.attempts, 0, checkRounds * attemptsPerRound, 0),
    successfulRound: clampNumber(raw.successfulRound, 0, checkRounds, 0),
    successfulAttempt: clampNumber(raw.successfulAttempt, 0, attemptsPerRound, 0)
  };
}

async function cloudflareRequest(credentials, method, pathname, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, { method, headers: { authorization: `Bearer ${credentials.apiToken || ''}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.errors?.[0]?.message || 'Cloudflare API 请求失败');
  return payload;
}

async function huaweiRequest(account, credentials, method, pathname, body) {
  const host = 'dns.myhuaweicloud.com';
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const payload = body ? JSON.stringify(body) : '';
  const payloadHash = sha256(payload);
  const parsed = new URL(`https://${host}${pathname}`);
  const canonicalUri = (parsed.pathname || '/').endsWith('/') ? (parsed.pathname || '/') : `${parsed.pathname}/`;
  const canonicalQuery = [...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join('&');
  const signedHeaderEntries = body ? [['content-type', 'application/json'], ['host', host], ['x-sdk-date', date]] : [['host', host], ['x-sdk-date', date]];
  const canonicalHeaders = signedHeaderEntries.map(([key, value]) => `${key}:${value}\n`).join('');
  const signedHeaders = signedHeaderEntries.map(([key]) => key).join(';');
  const canonicalRequest = `${method.toUpperCase()}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `SDK-HMAC-SHA256\n${date}\n${sha256(canonicalRequest)}`;
  const signature = crypto.createHmac('sha256', credentials.secretKey || '').update(stringToSign).digest('hex');
  const authorization = `SDK-HMAC-SHA256 Access=${credentials.accessKey || ''}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = { host, 'x-sdk-date': date, authorization };
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(parsed, { method: method.toUpperCase(), headers, body: payload || undefined, signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error_msg || result.message || '华为云 DNS API 请求失败');
    error.providerStatus = response.status;
    throw error;
  }
  return result;
}

async function aliyunRequest(credentials, action, params = {}) {
  const common = { Format: 'JSON', Version: '2015-01-09', AccessKeyId: credentials.accessKey || '', SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: uuidv4(), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Action: action, ...params };
  const sorted = Object.entries(common).sort(([a], [b]) => a.localeCompare(b));
  const query = sorted.map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join('&');
  const signature = crypto.createHmac('sha1', `${credentials.secretKey || ''}&`).update(`GET&%2F&${percentEncode(query)}`).digest('base64');
  const response = await fetch(`https://alidns.aliyuncs.com/?${query}&Signature=${percentEncode(signature)}`, { signal: AbortSignal.timeout(12000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.Code) throw new Error(payload.Message || '阿里云 DNS API 请求失败');
  return payload;
}

async function tencentRequest(credentials, action, body = {}) {
  const host = 'dnspod.tencentcloudapi.com';
  const service = 'dnspod';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify(body);
  const canonicalRequest = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${sha256(payload)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${credentials.secretKey || ''}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${credentials.secretId || ''}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
  const response = await fetch(`https://${host}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json; charset=utf-8', host, 'x-tc-action': action, 'x-tc-timestamp': String(timestamp), 'x-tc-version': '2021-03-23' }, body: payload, signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Response?.Error) throw new Error(result.Response?.Error?.Message || '腾讯云 DNSPod API 请求失败');
  return result;
}

async function dnspodRequest(credentials, action, params = {}) {
  const token = `${credentials.tokenId || ''},${credentials.tokenSecret || ''}`;
  const body = new URLSearchParams({ login_token: token, format: 'json', lang: 'en', error_on_empty: 'no', ...params });
  const response = await fetch('https://dnsapi.cn/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Nurossh/1.0' }, body, signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status?.code !== '1') throw new Error(result.status?.message || 'DNSPod API 请求失败');
  return result;
}

async function godaddyRequest(credentials, method, pathname, body) {
  const response = await fetch(`https://api.godaddy.com${pathname}`, { method, headers: { authorization: `sso-key ${credentials.apiKey || ''}:${credentials.apiSecret || ''}`, accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'GoDaddy API 请求失败');
  return result;
}

async function porkbunRequest(credentials, pathname, extra = {}) {
  const body = { apikey: credentials.apiKey || '', secretapikey: credentials.secretApiKey || '', ...extra };
  const response = await fetch(`https://api.porkbun.com${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== 'SUCCESS') throw new Error(result.message || 'Porkbun API 请求失败');
  return result;
}

async function updatePorkbunRecords(credentials, zone, binding, values) {
  const existing = await porkbunRequest(credentials, `/api/json/v3/dns/retrieve/${encodeURIComponent(zone.name)}`);
  const records = (existing.records || []).filter((item) => item.type === binding.recordType && normalizeRecordName(item.name, zone.name) === binding.recordName);
  const ids = [];
  for (let index = 0; index < values.length; index += 1) {
    const record = records[index];
    const payload = { name: binding.recordName === '@' ? zone.name : `${binding.recordName}.${zone.name}`, type: binding.recordType, content: values[index], ttl: String(binding.ttl) };
    if (record?.id) { await porkbunRequest(credentials, `/api/json/v3/dns/edit/${encodeURIComponent(zone.name)}/${encodeURIComponent(record.id)}`, payload); ids.push(String(record.id)); }
    else { const created = await porkbunRequest(credentials, `/api/json/v3/dns/create/${encodeURIComponent(zone.name)}`, payload); ids.push(String(created.id || `porkbun-${index + 1}`)); }
  }
  for (const record of records.slice(values.length)) await porkbunRequest(credentials, `/api/json/v3/dns/delete/${encodeURIComponent(zone.name)}/${encodeURIComponent(record.id)}`);
  return ids;
}

async function updateCloudnsRecords(credentials, zone, binding, values) {
  const existing = await cloudnsRequest(credentials, `/dns/records.json?domain-name=${encodeURIComponent(zone.name)}&host=${encodeURIComponent(binding.recordName)}`);
  const records = Object.entries(existing || {}).filter(([, item]) => item?.type === binding.recordType);
  const ids = [];
  for (let index = 0; index < values.length; index += 1) {
    const [id] = records[index] || [];
    const params = { 'domain-name': zone.name, 'record-id': id || '', 'host': binding.recordName, 'record-type': binding.recordType, 'record': values[index], ttl: String(binding.ttl) };
    const result = await cloudnsRequest(credentials, id ? '/dns/mod-record.json' : '/dns/add-record.json', 'POST', params);
    ids.push(String(result?.id || id || `cloudns-${index + 1}`));
  }
  for (const [id] of records.slice(values.length)) await cloudnsRequest(credentials, '/dns/delete-record.json', 'POST', { 'domain-name': zone.name, 'record-id': id });
  return ids;
}

async function cloudnsRequest(credentials, pathname, method = 'GET', body) {
  const url = new URL(`https://api.cloudns.net${pathname}`);
  url.searchParams.set('auth-id', credentials.authId || '');
  url.searchParams.set('auth-password', credentials.authPassword || '');
  const response = await fetch(url, { method, headers: { accept: 'application/json' }, body: body ? new URLSearchParams(body) : undefined, signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.status === 'Failed') throw new Error(result?.statusDescription || 'ClouDNS API 请求失败');
  return result;
}

function callbackPayload(action, zone, binding, values) {
  return { action, zone: zone.name, domain: binding.domain, recordName: binding.recordName, recordType: binding.recordType, ttl: binding.ttl, values };
}

async function callbackRequest(account, credentials, payload) {
  const endpoint = String(credentials.endpoint || '').trim();
  if (!/^https:\/\//i.test(endpoint)) throw new Error('自定义 DNS 回调必须使用 HTTPS 地址');
  const parsed = new URL(endpoint);
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) throw new Error('自定义 DNS 回调地址不可使用本地域名');
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('自定义 DNS 回调地址不可指向本机或私网');
  let customHeaders = {};
  if (credentials.headers) { try { customHeaders = JSON.parse(credentials.headers); } catch (_error) { throw new Error('自定义请求头 JSON 格式无效'); } }
  const headers = { accept: 'application/json', 'content-type': 'application/json', ...Object.fromEntries(Object.entries(customHeaders).slice(0, 30).map(([key, value]) => [cleanText(key, 100), cleanText(value, 1000)])) };
  if (credentials.token && !headers.authorization) headers.authorization = `Bearer ${credentials.token}`;
  const response = await fetch(parsed, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false || result.error) throw new Error(result.error || `DNS 回调失败（${response.status}）`);
  return result;
}

export function normalizeRecordName(value, zoneName) {
  const normalized = cleanText(value, 253).toLowerCase().replace(/\.$/, '');
  const normalizedZone = normalizeDomain(zoneName);
  const suffix = `.${normalizedZone}`;
  if (normalized === '@' || normalized === normalizedZone) return '@';
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) { const [a, b] = address.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  return net.isIPv6(address) && (address === '::1' || address === '::' || address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd') || address.toLowerCase().startsWith('fe80'));
}

function decryptCredentials(account, deps) {
  if (!account.credentialsEnc) throw new Error('DNS 账号尚未配置凭证');
  try { return JSON.parse(deps.decryptSecret(account.credentialsEnc)); } catch (_error) { throw new Error('DNS 账号凭证无法解密'); }
}

function updateIncident(state, id, patch) {
  const incident = state.incidents.find((item) => item.id === id);
  if (incident) Object.assign(incident, patch, { updatedAt: nowIso() });
  return state;
}

function settleIncidentForTargetHealth(deps, id, health) {
  deps.updateState((draft) => {
    const incident = draft.incidents.find((item) => item.id === id);
    if (!incident) return draft;
    const recovered = health === 'healthy';
    releaseIncidentIpLocks(draft, id);
    finalizeIpUsageRecords(draft, id, 'rolled_back', recovered ? '目标已恢复，未执行切换' : '目标检查证据不足，等待重新确认', incident.leaseIds);
    updateIncident(draft, id, {
      status: recovered ? 'recovered' : 'observing',
      message: recovered ? '目标已恢复，无需切换' : '等待重新确认目标故障',
      error: '',
      executionId: '',
      allocatedIps: [],
      leaseIds: [],
      finishedAt: recovered ? nowIso() : ''
    });
    pushAudit(draft, recovered ? 'incident.recovered' : 'incident.recheck_wait', 'incident', id, recovered ? '执行前 3×3 检查结果已恢复，取消切换' : '执行前检查证据不足，暂停切换并等待重新确认', 'system');
    return draft;
  });
}

function failIncident(deps, id, message) {
  deps.updateState((draft) => {
    const incident = draft.incidents.find((item) => item.id === id);
    updateIncident(draft, id, { status: 'failed', error: cleanText(message, 1000), message: '执行失败', executionId: '', finishedAt: nowIso() });
    releaseIncidentIpLocks(draft, id);
    finalizeIpUsageRecords(draft, id, 'failed', message, incident?.leaseIds);
    pushAudit(draft, 'incident.failed', 'incident', id, cleanText(message, 500), 'system');
    return draft;
  });
}

function buildIncidentContext(incident, target, allocated) {
  const ips = allocated.map((item) => item.address);
  return { TARGET_IP: target.address, POOL_IP: ips[0] || '', POOL_IPS: ips.join('\n'), ALLOCATED_IPS: ips.join('\n'), INCIDENT_ID: incident.id, TARGET_NAME: target.name };
}

function pushAudit(state, action, resourceType, resourceId, summary, actor) {
  state.auditLogs ||= [];
  state.auditLogs.unshift({ id: uuidv4(), action, resourceType, resourceId, summary: cleanText(summary, 1000), actor: cleanText(actor, 100) || 'system', createdAt: nowIso() });
  state.auditLogs = state.auditLogs.slice(0, 2000);
}

function sanitizeResource(key, item) {
  if (key === 'dnsAccounts') { const { credentialsEnc, ...safe } = item; return { ...safe, configured: Boolean(credentialsEnc) }; }
  if (key === 'telegramBots') { const { tokenEnc, tokenHash, ...safe } = item; return { ...safe, configured: Boolean(tokenEnc) }; }
  if (key === 'probes') { const { tokenHash, tokenEnc, agentSecretHash, ...safe } = item; return safe; }
  return item;
}

function normalizeRoles(input) {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input).slice(0, 500).map(([id, role]) => [cleanText(id, 40), ['owner', 'admin', 'operator', 'approver', 'viewer', 'auditor'].includes(role) ? role : 'viewer']));
}

function cleanText(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function isLocalRequestHost(value) { const host = String(value || '').replace(/^\[|\](?::\d+)?$/g, '').split(':')[0].toLowerCase(); return host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host); }
function requiredText(value, label) { const result = cleanText(value, 200); if (!result) throw new Error(`请填写${label}`); return result; }
function cleanId(value) { return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100); }
function cleanIds(value, max) { return [...new Set((Array.isArray(value) ? value : []).map(cleanId).filter(Boolean))].slice(0, max); }
function cleanTexts(value, max) { return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\n,，;；]+/)).map((item) => cleanText(item, 255)).filter(Boolean))].slice(0, max); }
function cleanRecordValues(value, max) { return [...new Set((Array.isArray(value) ? value : String(value || '').split(/\n+/)).map((item) => cleanText(item, 1000)).filter(Boolean))].slice(0, max); }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback; }
function nowIso() { return new Date().toISOString(); }
function randomSecret(bytes) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashSecret(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function safeHashEqual(left, right) { try { return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')); } catch (_error) { return false; } }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, value) { return crypto.createHmac('sha256', key).update(value).digest(); }
function percentEncode(value) { return encodeURIComponent(String(value)).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A'); }
function configVersion(targets) { return sha256(JSON.stringify(targets)).slice(0, 16); }
function normalizeDomain(value) { const domain = cleanText(value, 253).toLowerCase().replace(/\.$/, ''); if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) throw new Error('域名格式不正确'); return domain; }
function validateIp(value) { const address = cleanText(value, 64); if (net.isIP(address) === 0) throw new Error('IP 地址格式不正确'); return address; }
function validateHost(value, allowPrivate = false) {
  const host = cleanText(value, 253).replace(/^\[|\]$/g, '');
  if (!host) throw new Error('请填写检查目标');
  if (/\s|[/?#@]/.test(host) || (!validateIpLiteral(host) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host))) throw new Error('检查目标格式不正确');
  if (validateIpLiteral(host) && isForbiddenProbeIp(host, allowPrivate)) throw new Error('该检查目标地址不允许使用');
  return host;
}
function validateIpLiteral(value) { return /^((25[0-5]|2[0-4]\d|1?\d?\d)(\.|$)){4}$/.test(value) || /^[a-f0-9:]+$/i.test(value); }
function isForbiddenProbeIp(value, allowPrivate) {
  if (value.includes(':')) return /^(?:::|::1|fe[89ab][a-f0-9]:|ff|0*:0*:0*:0*:0*:ffff:127\.)/i.test(value) || (!allowPrivate && /^(?:fc|fd)/i.test(value));
  const parts = value.split('.').map(Number);
  const [a, b] = parts;
  const metadata = value === '169.254.169.254' || value === '100.100.100.200';
  const alwaysBlocked = metadata || a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254);
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  return alwaysBlocked || (!allowPrivate && privateRange);
}
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }

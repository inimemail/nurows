import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { v4 as uuidv4 } from 'uuid';

const RESOURCE_MAP = {
  probes: 'probes',
  'probe-targets': 'probeTargets',
  'ip-assets': 'ipAssets',
  'ip-pools': 'ipPools',
  'dns-accounts': 'dnsAccounts',
  'dns-zones': 'dnsZones',
  'dns-bindings': 'dnsBindings',
  'failover-policies': 'failoverPolicies',
  'telegram-bots': 'telegramBots'
};

const ACTIVE_INCIDENT_STATES = new Set([
  'observing', 'pending_approval', 'queued', 'allocating', 'automating', 'dns_updating', 'verifying', 'rolling_back'
]);

const DNS_PROVIDERS = new Set([
  'huawei', 'aliyun', 'tencent', 'dnspod', 'cloudflare', 'godaddy', 'porkbun', 'cloudns', 'callback',
  'aliyun_esa', 'baidu', 'namecheap', 'namesilo', 'dynadot', 'dnsla', 'era', 'tndns', 'gcore',
  'edgeone', 'ns1', 'rainyun', 'dynv6', 'vercel', 'spaceship'
]);
const CALLBACK_PROVIDERS = new Set(['callback', 'aliyun_esa', 'baidu', 'namecheap', 'namesilo', 'dynadot', 'dnsla', 'era', 'tndns', 'gcore', 'edgeone', 'ns1', 'rainyun', 'dynv6', 'vercel', 'spaceship']);
const DNS_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'NS', 'CAA']);
const ALLOCATION_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

export function orchestrationDefaults() {
  return {
    probes: [],
    probeTargets: [],
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
    auditLogs: [],
    telegramBots: []
  };
}

export function normalizeOrchestrationState(parsed = {}) {
  const defaults = orchestrationDefaults();
  const normalized = Object.fromEntries(Object.keys(defaults).map((key) => [key, Array.isArray(parsed?.[key]) ? parsed[key] : defaults[key]]));
  normalized.ipPools = normalized.ipPools.map(({ sharingMode, shareLimit, leaseMinutes, cooldownMinutes, ...pool }) => pool);
  normalized.ipLeases = normalized.ipLeases.filter((lease) => lease.status !== 'released');
  normalized.ipUsageRecords = normalized.ipUsageRecords.slice(0, 5000);
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
    deps.updateState((draft) => {
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
    res.json({ ok: true, probeId, agentSecret, heartbeatInterval: 20 });
  });

  app.get('/probe/config', (req, res) => {
    const auth = authenticateProbe(req, deps.readState());
    if (!auth) return res.status(401).json({ error: '探针凭证无效' });
    const targets = auth.state.probeTargets
      .filter((target) => target.enabled !== false && target.probeIds?.includes(auth.probe.id))
      .map(({ observations, ...target }) => target);
    res.json({ ok: true, version: configVersion(targets), probeId: auth.probe.id, targets });
  });

  app.post('/probe/heartbeat', (req, res) => {
    const auth = authenticateProbe(req, deps.readState());
    if (!auth) return res.status(401).json({ error: '探针凭证无效' });
    deps.updateState((draft) => {
      const probe = draft.probes.find((item) => item.id === auth.probe.id);
      if (probe) Object.assign(probe, { status: 'online', lastSeenAt: nowIso(), agentVersion: cleanText(req.body.version, 40), updatedAt: nowIso() });
      return draft;
    });
    res.json({ ok: true, serverTime: nowIso() });
  });

  app.post('/probe/report', (req, res) => {
    const auth = authenticateProbe(req, deps.readState());
    if (!auth) return res.status(401).json({ error: '探针凭证无效' });
    const reports = Array.isArray(req.body.results) ? req.body.results.slice(0, 2000) : [];
    const createdIncidentIds = [];
    deps.updateState((draft) => {
      const probe = draft.probes.find((item) => item.id === auth.probe.id);
      if (probe) Object.assign(probe, { status: 'online', lastSeenAt: nowIso(), updatedAt: nowIso() });
      for (const raw of reports) {
        const target = draft.probeTargets.find((item) => item.id === cleanId(raw.targetId) && item.probeIds?.includes(auth.probe.id));
        if (!target) continue;
        target.observations ||= {};
        const previous = target.observations[auth.probe.id] || { failures: 0, successes: 0 };
        const ok = Boolean(raw.ok);
        target.observations[auth.probe.id] = {
          ok,
          latencyMs: clampNumber(raw.latencyMs, 0, 600000, 0),
          error: cleanText(raw.error, 300),
          checkedAt: nowIso(),
          failures: ok ? 0 : Number(previous.failures || 0) + 1,
          successes: ok ? Number(previous.successes || 0) + 1 : 0
        };
        target.updatedAt = nowIso();
        const transition = evaluateTargetHealth(target, draft.probes);
        target.health = transition.health;
        target.lastCheckAt = nowIso();
        if (transition.failed && target.policyId) {
          const active = draft.incidents.some((item) => item.targetId === target.id && ACTIVE_INCIDENT_STATES.has(item.status));
          const policy = draft.failoverPolicies.find((item) => item.id === target.policyId && item.enabled !== false);
          if (!active && policy) {
            const incident = createIncident(target, policy, auth.probe.id);
            draft.incidents.unshift(incident);
            createdIncidentIds.push(incident.id);
            pushAudit(draft, 'incident.created', 'incident', incident.id, `${target.name} 达到故障阈值`, 'probe');
          }
        }
      }
      draft.incidents = draft.incidents.slice(0, 500);
      return draft;
    });
    for (const incidentId of createdIncidentIds) deps.onIncidentCreated?.(incidentId);
    res.json({ ok: true, accepted: reports.length, incidents: createdIncidentIds });
  });
}

export function registerOrchestrationRoutes(app, deps) {
  app.post('/api/ip-assets/batch', (req, res) => {
    const addresses = parseIpBatch(req.body.addresses);
    let result;
    const state = deps.updateState((draft) => {
      result = importIpAssets(draft, addresses, req.body, req.auth.username);
      pushAudit(draft, 'ipAssets.batch_create', 'ipAssets', '', `批量导入 ${result.created} 个 IP，复用 ${result.reused} 个`, req.auth.username);
      return draft;
    });
    res.json({ ok: true, ...result, state: deps.sanitizeState(state, req.auth) });
  });

  app.post('/api/orchestration/:resource', asyncRoute(async (req, res) => {
    const key = RESOURCE_MAP[req.params.resource];
    if (!key) return res.status(404).json({ error: '未知资源类型' });
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
    res.json({ ok: true, item: sanitizeResource(key, created), state: deps.sanitizeState(state, req.auth) });
  }));

  app.put('/api/orchestration/:resource/:id', asyncRoute(async (req, res) => {
    const key = RESOURCE_MAP[req.params.resource];
    if (!key) return res.status(404).json({ error: '未知资源类型' });
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
      pushAudit(draft, `${key}.update`, key, item.id, `更新 ${item.name || item.address || item.domain || item.id}`, req.auth.username);
      return draft;
    });
    if (key === 'telegramBots') deps.onTelegramChanged?.();
    res.json({ ok: true, item: sanitizeResource(key, updated), state: deps.sanitizeState(state, req.auth) });
  }));

  app.delete('/api/orchestration/:resource/:id', asyncRoute(async (req, res) => {
    const key = RESOURCE_MAP[req.params.resource];
    if (!key) return res.status(404).json({ error: '未知资源类型' });
    const state = deps.updateState((draft) => {
      ensureNotReferenced(draft, key, req.params.id);
      draft[key] = draft[key].filter((entry) => entry.id !== req.params.id);
      pushAudit(draft, `${key}.delete`, key, req.params.id, '删除记录', req.auth.username);
      return draft;
    });
    if (key === 'telegramBots') deps.onTelegramChanged?.();
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
  const values = await resolveBindingSources(binding);
  if (!values.length) throw new Error('主来源和备用来源均未解析出可用地址');
  const account = state.dnsAccounts.find((item) => item.id === binding.accountId && item.enabled !== false);
  if (!account) throw new Error('DNS 账号不可用');
  const credentials = decryptCredentials(account, deps);
  const { zone, normalizedBinding } = await resolveManagedDnsZone(state, account, credentials, binding);
  const before = await getDnsRecord(account, credentials, zone, normalizedBinding);
  const after = binding.pruneStale === false ? [...new Set([...before.values, ...values])] : values;
  const providerRecordIds = await updateDnsRecord(account, credentials, zone, normalizedBinding, after);
  const next = deps.updateState((draft) => {
    const item = draft.dnsBindings.find((entry) => entry.id === binding.id);
    if (item) Object.assign(item, { managedValues: after, providerRecordIds: providerRecordIds || item.providerRecordIds, lastSyncAt: nowIso(), lastSyncError: '' });
    draft.dnsChanges.unshift({ id: uuidv4(), incidentId: '', bindingId: binding.id, accountId: account.id, zoneId: zone.id || '', zoneName: zone.name, providerZoneId: zone.providerZoneId || '', domain: binding.domain, beforeValues: before.values, afterValues: after, status: 'applied', createdAt: nowIso(), rolledBackAt: '' });
    pushAudit(draft, 'dns.sync', 'dnsBinding', binding.id, `${binding.domain} 同步 ${after.length} 个地址`, actor);
    return draft;
  });
  return { values: after, layout: dnsRecordLayout(account.provider), state: next };
}

export async function runIncidentWorkflow(incidentId, deps, encryptionKey = null) {
  const executionId = randomSecret(18);
  let claimed = false;
  deps.updateState((draft) => {
    const item = draft.incidents.find((entry) => entry.id === incidentId);
    if (!item || !['queued', 'observing'].includes(item.status) || item.executionId) return draft;
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
  try {
    const allocated = allocateIpsForIncident(incidentId, deps);
    if (!allocated.length && policy.poolIds?.length) throw new Error('备用 IP 池没有满足策略的可用 IP');
    deps.updateState((draft) => {
      startIpUsageRecords(draft, incidentId, allocated);
      return updateIncident(draft, incidentId, { allocatedIps: allocated.map((item) => item.address), leaseIds: allocated.map((item) => item.leaseId) });
    });

    if (policy.automationTaskId) {
      deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'automating', message: '正在执行自动化任务' }));
      const hosts = policy.automationHosts === 'target' || !allocated.length ? [target.address] : allocated.map((item) => item.address);
      const context = buildIncidentContext(incident, target, allocated);
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
      await verifyDnsBindings(bindings, incident.allocatedIps || []);
    }

    deps.updateState((draft) => {
      const consumed = consumeIncidentIpAssets(draft, incidentId);
      const currentIncident = draft.incidents.find((item) => item.id === incidentId);
      finalizeIpUsageRecords(draft, incidentId, 'consumed', '', currentIncident?.leaseIds);
      updateIncident(draft, incidentId, { status: 'succeeded', message: '故障切换完成', executionId: '', finishedAt: nowIso() });
      pushAudit(draft, 'incident.succeeded', 'incident', incidentId, `自动故障切换完成，已消耗 ${consumed.addresses.length} 个备用 IP`, 'system');
      return draft;
    });
    deps.notifyIncident?.(incidentId);
  } catch (error) {
    await rollbackIncident(incidentId, deps, 'system').catch(() => {});
    failIncident(deps, incidentId, error.message || '故障编排失败');
    deps.notifyIncident?.(incidentId);
  }
}

function normalizeResource(key, input = {}, existing = null, deps) {
  const now = nowIso();
  const base = { id: existing?.id || cleanId(input.id) || uuidv4(), createdAt: existing?.createdAt || now, updatedAt: now };
  if (key === 'probes') return { ...base, name: requiredText(input.name, '探针名称'), region: cleanText(input.region, 80), carrier: cleanText(input.carrier, 80), maxConcurrency: clampNumber(input.maxConcurrency, 1, 1000, 100), enabled: input.enabled !== false, status: existing?.status || 'pending', lastSeenAt: existing?.lastSeenAt || '', tokenHash: existing?.tokenHash || '', tokenEnc: existing?.tokenEnc || null, agentSecretHash: existing?.agentSecretHash || '', tokenExpiresAt: existing?.tokenExpiresAt || '', tokenUsedAt: existing?.tokenUsedAt || '', registeredAt: existing?.registeredAt || '', agentVersion: existing?.agentVersion || '' };
  if (key === 'probeTargets') return { ...base, name: requiredText(input.name, '目标名称'), address: validateHost(input.address, Boolean(input.allowPrivate)), allowPrivate: Boolean(input.allowPrivate), checkType: input.checkType === 'ping' ? 'ping' : 'tcp', port: clampNumber(input.port, 1, 65535, 443), interval: clampNumber(input.interval, 5, 3600, 30), timeout: clampNumber(input.timeout, 1, 60, 5), failureThreshold: clampNumber(input.failureThreshold, 1, 20, 3), recoveryThreshold: clampNumber(input.recoveryThreshold, 1, 20, 2), quorumMode: ['majority', 'all', 'count'].includes(input.quorumMode) ? input.quorumMode : 'majority', quorumCount: clampNumber(input.quorumCount, 1, 100, 2), probeIds: cleanIds(input.probeIds, 500), policyId: cleanId(input.policyId), enabled: input.enabled !== false, health: existing?.health || 'unknown', observations: existing?.observations || {}, lastCheckAt: existing?.lastCheckAt || '' };
  if (key === 'ipAssets') return { ...base, name: cleanText(input.name, 100) || validateIp(input.address), address: validateIp(input.address), region: cleanText(input.region, 80), carrier: cleanText(input.carrier, 80), labels: cleanTexts(input.labels, 30), enabled: input.enabled !== false, health: ['healthy', 'unhealthy', 'unknown'].includes(input.health) ? input.health : 'unknown', note: cleanText(input.note, 500) };
  if (key === 'ipPools') return { ...base, name: requiredText(input.name, '备用池名称'), assetIds: cleanIds(input.assetIds, 5000), allocationMode: ['one', 'count', 'all'].includes(input.allocationMode) ? input.allocationMode : 'one', allocationCount: clampNumber(input.allocationCount, 1, 5000, 1), selectionMode: ['ordered', 'random'].includes(input.selectionMode) ? input.selectionMode : 'ordered', enabled: input.enabled !== false, note: cleanText(input.note, 500) };
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
    return { ...base, name: requiredText(input.name, '解析绑定名称'), zoneId: identityChanged ? '' : cleanId(input.zoneId), accountId, domain, recordName: identityChanged ? '' : cleanText(input.recordName, 255), recordType, recordValues, providerRecordId: identityChanged ? '' : cleanText(input.providerRecordId, 200), providerRecordIds: identityChanged ? [] : cleanTexts(input.providerRecordIds, 500), recordLine: cleanText(input.recordLine, 100) || '默认', ttl: clampNumber(input.ttl, 1, 86400, 60), updateMode: ['append', 'managed_replace', 'replace'].includes(input.updateMode) ? input.updateMode : 'managed_replace', managedValues: identityChanged ? [] : cleanTexts(input.managedValues, 5000), ddnsSources: normalizeDdnsSources(input.ddnsSources), backupIps: cleanTexts(input.backupIps, 5000), maxActiveIps: clampNumber(input.maxActiveIps, 1, 50, 50), pruneStale: input.pruneStale !== false, healthEnabled: input.healthEnabled !== false, healthInterval: clampNumber(input.healthInterval, 10, 86400, 30), pingCount: clampNumber(input.pingCount, 1, 10, 3), checkRounds: clampNumber(input.checkRounds, 1, 10, 3), roundDelay: clampNumber(input.roundDelay, 0, 60, 2), maxParallel: clampNumber(input.maxParallel, 1, 300, 20), lastSyncAt: identityChanged ? '' : (existing?.lastSyncAt || ''), lastSyncError: '', enabled: input.enabled !== false };
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
  if (key === 'ipPools' && item.assetIds.some((id) => !exists('ipAssets', id))) throw new Error('备用池包含不存在的 IP');
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
  }
}

function ensureNotReferenced(state, key, id) {
  const references = {
    probes: state.probeTargets.some((item) => item.probeIds?.includes(id)),
    ipAssets: state.ipPools.some((item) => item.assetIds?.includes(id)),
    ipPools: state.failoverPolicies.some((item) => item.poolIds?.includes(id)),
    dnsAccounts: state.dnsZones.some((item) => item.accountId === id) || state.dnsBindings.some((item) => item.accountId === id),
    dnsZones: state.dnsBindings.some((item) => item.zoneId === id),
    dnsBindings: state.failoverPolicies.some((item) => item.dnsBindingIds?.includes(id)),
    failoverPolicies: state.probeTargets.some((item) => item.policyId === id)
  };
  if (references[key]) throw new Error('当前记录仍被其他配置引用，请先解除关联');
}

function authenticateProbe(req, state) {
  const probeId = cleanId(req.headers['x-probe-id']);
  const secret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const probe = state.probes.find((item) => item.id === probeId && item.enabled !== false && item.agentSecretHash);
  return probe && safeHashEqual(probe.agentSecretHash, hashSecret(secret)) ? { probe, state } : null;
}

function evaluateTargetHealth(target, probes) {
  const observations = Object.entries(target.observations || {}).filter(([probeId, observation]) => {
    const probe = probes.find((item) => item.id === probeId && item.enabled !== false);
    return probe && Date.now() - Date.parse(observation.checkedAt || 0) < Math.max(120000, target.interval * 4000);
  });
  const qualifiedFailures = observations.filter(([, item]) => !item.ok && item.failures >= target.failureThreshold).length;
  const qualifiedSuccesses = observations.filter(([, item]) => item.ok && item.successes >= target.recoveryThreshold).length;
  const required = target.quorumMode === 'all' ? Math.max(1, observations.length) : target.quorumMode === 'count' ? target.quorumCount : Math.max(1, Math.floor(observations.length / 2) + 1);
  const failed = observations.length > 0 && qualifiedFailures >= required;
  const healthy = observations.length > 0 && qualifiedSuccesses >= required;
  return { failed, health: failed ? 'down' : healthy ? 'healthy' : 'observing' };
}

function createIncident(target, policy, probeId) {
  return { id: uuidv4(), targetId: target.id, targetName: target.name, policyId: policy.id, policyName: policy.name, sourceProbeId: probeId, status: policy.approvalMode === 'telegram' ? 'pending_approval' : 'queued', message: policy.approvalMode === 'telegram' ? '等待确认' : '等待执行', allocatedIps: [], leaseIds: [], automationJobId: '', dnsChangeIds: [], executionId: '', claimedAt: '', error: '', startedAt: nowIso(), updatedAt: nowIso(), finishedAt: '' };
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
  const active = state.ipLeases.filter((lease) => lease.assetId === assetId && ['locked', 'active'].includes(lease.status) && Date.parse(lease.expiresAt) > Date.now());
  return active.length === 0;
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

async function applyDnsBinding(binding, allocatedIps, incidentId, deps) {
  if (!['A', 'AAAA'].includes(binding.recordType)) throw new Error(`故障切换不能更新 ${binding.recordType} 记录`);
  const state = deps.readState();
  const account = state.dnsAccounts.find((item) => item.id === binding.accountId && item.enabled !== false);
  if (!account) throw new Error(`解析绑定 ${binding.name} 的账号不可用`);
  const credentials = decryptCredentials(account, deps);
  const { zone, normalizedBinding } = await resolveManagedDnsZone(state, account, credentials, binding);
  const before = await getDnsRecord(account, credentials, zone, normalizedBinding);
  const current = before.values || [];
  let after;
  if (binding.updateMode === 'append') after = [...new Set([...current, ...allocatedIps])];
  else if (binding.updateMode === 'managed_replace') after = [...new Set([...current.filter((value) => !binding.managedValues?.includes(value)), ...allocatedIps])];
  else after = [...new Set(allocatedIps)];
  if (!after.length) throw new Error(`解析绑定 ${binding.name} 没有可写入 IP`);
  const providerRecordIds = await updateDnsRecord(account, credentials, zone, normalizedBinding, after);
  deps.updateState((draft) => {
    const change = { id: uuidv4(), incidentId, bindingId: binding.id, accountId: account.id, zoneId: zone.id || '', zoneName: zone.name, providerZoneId: zone.providerZoneId || '', domain: binding.domain, beforeValues: current, afterValues: after, status: 'applied', createdAt: nowIso(), rolledBackAt: '' };
    draft.dnsChanges.unshift(change);
    const incident = draft.incidents.find((item) => item.id === incidentId);
    if (incident) incident.dnsChangeIds = [...(incident.dnsChangeIds || []), change.id];
    const bindingItem = draft.dnsBindings.find((item) => item.id === binding.id);
    if (bindingItem) {
      bindingItem.managedValues = allocatedIps;
      if (providerRecordIds?.length) bindingItem.providerRecordIds = providerRecordIds;
    }
    pushAudit(draft, 'dns.update', 'dnsBinding', binding.id, `${binding.domain}: ${current.join(',')} -> ${after.join(',')}`, 'system');
    return draft;
  });
}

export async function rollbackIncident(incidentId, deps, actor) {
  const state = deps.readState();
  const incident = state.incidents.find((item) => item.id === incidentId);
  if (!incident) throw new Error('故障事件不存在');
  deps.updateState((draft) => updateIncident(draft, incidentId, { status: 'rolling_back', message: '正在回滚 DNS 并释放备用 IP' }));
  for (const changeId of [...(incident.dnsChangeIds || [])].reverse()) {
    const current = deps.readState();
    const change = current.dnsChanges.find((item) => item.id === changeId && item.status === 'applied');
    if (!change) continue;
    const binding = current.dnsBindings.find((item) => item.id === change.bindingId);
    const account = current.dnsAccounts.find((item) => item.id === change.accountId);
    if (!binding || !account) continue;
    const credentials = decryptCredentials(account, deps);
    const discovered = change.zoneName ? { zone: { id: change.zoneId, name: change.zoneName, providerZoneId: change.providerZoneId }, normalizedBinding: withRecordName(binding, change.zoneName) } : await resolveManagedDnsZone(current, account, credentials, binding);
    const providerRecordIds = await updateDnsRecord(account, credentials, discovered.zone, discovered.normalizedBinding, change.beforeValues);
    deps.updateState((draft) => {
      const item = draft.dnsChanges.find((entry) => entry.id === change.id);
      if (item) Object.assign(item, { status: 'rolled_back', rolledBackAt: nowIso() });
      const bindingItem = draft.dnsBindings.find((entry) => entry.id === binding.id);
      if (bindingItem && providerRecordIds?.length) bindingItem.providerRecordIds = providerRecordIds;
      return draft;
    });
  }
  const next = deps.updateState((draft) => {
    releaseIncidentIpLocks(draft, incidentId);
    finalizeIpUsageRecords(draft, incidentId, 'rolled_back', '', incident.leaseIds);
    updateIncident(draft, incidentId, { status: 'rolled_back', message: '已回滚', executionId: '', finishedAt: nowIso() });
    pushAudit(draft, 'incident.rollback', 'incident', incidentId, '回滚 DNS 变更并释放备用 IP', actor);
    return draft;
  });
  return { incident: next.incidents.find((item) => item.id === incidentId) };
}

async function verifyDnsBindings(bindings, expectedIps) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  for (const binding of bindings) {
    if (!['A', 'AAAA'].includes(binding.recordType)) continue;
    const type = binding.recordType === 'AAAA' ? 28 : 1;
    const response = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(binding.domain)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`DNS 验证失败：${binding.domain}`);
    const payload = await response.json();
    const values = (payload.Answer || []).map((item) => item.data);
    if (expectedIps.length && !expectedIps.some((ip) => values.includes(ip))) throw new Error(`DNS 尚未解析到备用 IP：${binding.domain}`);
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

async function resolveManagedDnsZone(state, account, credentials, binding) {
  const legacy = state.dnsZones.find((item) => item.id === binding.zoneId && item.accountId === account.id && item.enabled !== false);
  if (legacy) return { zone: legacy, normalizedBinding: withRecordName(binding, legacy.name) };
  const zones = await listProviderZones(account, credentials);
  const domain = normalizeDomain(binding.domain);
  const matches = zones.filter((zone) => domain === zone.name || domain.endsWith(`.${zone.name}`)).sort((left, right) => right.name.length - left.name.length);
  if (!matches.length) throw new Error(`账号中未找到 ${domain} 对应的托管域`);
  return { zone: matches[0], normalizedBinding: withRecordName(binding, matches[0].name) };
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
  if (!['A', 'AAAA'].includes(binding.recordType)) return cleanRecordValues(binding.recordValues, binding.recordType === 'CNAME' ? 1 : 5000);
  const family = binding.recordType === 'AAAA' ? 6 : 4;
  const sources = Array.isArray(binding.ddnsSources) ? binding.ddnsSources : [];
  const output = [];
  for (const source of sources) {
    const domains = [source.domain, source.backupDomain].filter(Boolean);
    for (const domain of domains) {
      try {
        const records = await dns.lookup(domain, { all: true, family, verbatim: true });
        for (const record of records) if (net.isIP(record.address) === family && !output.includes(record.address)) output.push(record.address);
        if (output.length) break;
      } catch (_error) {
        // Try the next source or its backup domain.
      }
    }
  }
  for (const value of binding.backupIps || []) {
    if (net.isIP(value) === family && !output.includes(value)) output.push(value);
  }
  return output.slice(0, binding.maxActiveIps || 50);
}

async function getDnsRecord(account, credentials, zone, binding) {
  if (CALLBACK_PROVIDERS.has(account.provider)) {
    const result = await callbackRequest(account, credentials, callbackPayload('read', zone, binding, []));
    return { values: cleanTexts(result?.values, 5000), recordId: '' };
  }
  if (account.provider === 'godaddy') {
    const records = await godaddyRequest(credentials, 'GET', `/v1/domains/${encodeURIComponent(zone.name)}/records/${binding.recordType}/${encodeURIComponent(binding.recordName)}`);
    return { values: (records || []).map((item) => item.data).filter(Boolean) };
  }
  if (account.provider === 'porkbun') {
    const result = await porkbunRequest(credentials, `/api/json/v3/dns/retrieve/${encodeURIComponent(zone.name)}`);
    return { values: (result.records || []).filter((item) => item.type === binding.recordType && normalizeRecordName(item.name, zone.name) === binding.recordName).map((item) => item.content) };
  }
  if (account.provider === 'cloudns') {
    const result = await cloudnsRequest(credentials, `/dns/records.json?domain-name=${encodeURIComponent(zone.name)}&host=${encodeURIComponent(binding.recordName)}`);
    const records = Object.values(result || {}).filter((item) => item?.type === binding.recordType);
    return { values: records.map((item) => item.record || item.value || item.content).filter(Boolean) };
  }
  const recordIds = account.provider === 'huawei' ? [] : await discoverProviderRecordIds(account, credentials, zone, binding);
  if (account.provider === 'cloudflare') {
    const records = await Promise.all(recordIds.map((id) => cloudflareRequest(credentials, 'GET', `/zones/${encodeURIComponent(zone.providerZoneId)}/dns_records/${encodeURIComponent(id)}`)));
    return { values: records.map((data) => data.result?.content).filter(Boolean) };
  }
  if (account.provider === 'huawei') {
    const recordset = await findHuaweiRecordset(account, credentials, zone, binding);
    return { values: recordset?.records || [], recordId: recordset?.id || '' };
  }
  if (account.provider === 'aliyun') {
    const records = await Promise.all(recordIds.map((id) => aliyunRequest(credentials, 'DescribeDomainRecordInfo', { RecordId: id })));
    return { values: records.map((data) => data.Value).filter(Boolean) };
  }
  if (account.provider === 'dnspod') {
    const records = await Promise.all(recordIds.map((id) => dnspodRequest(credentials, 'Record.Info', { domain: zone.name, record_id: id })));
    return { values: records.map((data) => data.record?.value).filter(Boolean) };
  }
  const records = await Promise.all(recordIds.map((id) => tencentRequest(credentials, 'DescribeRecord', { Domain: zone.name, RecordId: Number(id) })));
  return { values: records.map((data) => data.Response?.RecordInfo?.Value).filter(Boolean) };
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
      const recordset = await findHuaweiRecordset(account, credentials, zone, binding);
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
    const recordset = await findHuaweiRecordset(account, credentials, zone, binding);
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
    return huaweiRequest(account, credentials, 'GET', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets/${encodeURIComponent(binding.providerRecordId)}`);
  }
  const query = `?name=${encodeURIComponent(`${binding.domain}.`)}&type=${encodeURIComponent(binding.recordType)}&limit=500`;
  const data = await huaweiRequest(account, credentials, 'GET', `/v2/zones/${encodeURIComponent(zone.providerZoneId)}/recordsets${query}`);
  const matches = (data.recordsets || []).filter((item) => normalizeDomain(item.name) === binding.domain && item.type === binding.recordType);
  if (matches.length > 1) throw new Error(`华为云存在多个同名 ${binding.recordType} 记录，请先在华为云合并重复记录`);
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
  return value.slice(0, 100).map((item, index) => ({
    id: cleanId(item?.id) || `source-${index + 1}`,
    name: cleanText(item?.name, 100),
    domain: item?.domain ? normalizeDomain(item.domain) : '',
    backupDomain: item?.backupDomain ? normalizeDomain(item.backupDomain) : ''
  })).filter((item) => item.domain);
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
  if (!response.ok) throw new Error(result.error_msg || result.message || '华为云 DNS API 请求失败');
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

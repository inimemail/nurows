export const HISTORY_RETENTION_DAYS = 7;
export const HISTORY_KEYS = ['automationRuns', 'dnsGuardRuns', 'incidents', 'ipUsageRecords', 'dnsChanges', 'auditLogs'];
export const HISTORY_STATE_KEYS = [...HISTORY_KEYS, 'ipLeases'];
const ACTIVE_INCIDENTS = new Set(['observing', 'pending_approval', 'queued', 'waiting_for_ip', 'allocating', 'automating', 'dns_updating', 'verifying', 'stabilizing', 'rolling_back']);
const ACTIVE_RUNS = new Set(['queued', 'running', 'paused', 'awaiting_input']);

// This operates only on local history. Configuration, current DNS values,
// probe evidence, asset inventory and allocation locks are never modified.
export function pruneHistory(state, { all = false, scope = 'all', now = Date.now(), activeJobIds = new Set() } = {}) {
  if (scope !== 'all' && !HISTORY_KEYS.includes(scope)) throw new Error('未知历史记录类别');
  const keys = scope === 'all' ? HISTORY_KEYS : [scope];
  const cutoff = now - HISTORY_RETENTION_DAYS * 86400000;
  let stamped = 0;
  const eligible = (item) => {
    if (all) return true;
    const completed = [item.finishedAt, item.rolledBackAt].map(Date.parse).filter(Number.isFinite);
    const dates = completed.length ? completed : [item.updatedAt, item.createdAt, item.startedAt, item.retentionStartedAt].map(Date.parse).filter(Number.isFinite);
    if (dates.length) return Math.max(...dates) <= cutoff;
    // Give legacy undated records a full retention window on first sight.
    item.retentionStartedAt = new Date(now).toISOString();
    stamped++;
    return false;
  };
  const incidents = state.incidents || [];
  const incidentById = new Map(incidents.map((item) => [item.id, item]));
  const lockedIncidentIds = new Set((state.ipLeases || []).filter((lease) => ['locked', 'active'].includes(lease.status)
    && (Date.parse(lease.expiresAt) > now || incidentById.get(lease.incidentId)?.status === 'stabilizing')).map((lease) => lease.incidentId));
  const recoveryIncidentIds = new Set((state.dnsChanges || []).filter((change) => change.status === 'recovery_pending'
    || (change.status === 'applied' && incidentById.get(change.incidentId)?.status === 'failed')).map((change) => change.incidentId));
  const protectedIncidents = new Set(incidents.filter((item) => item.executionId || ACTIVE_INCIDENTS.has(item.status)
    || activeJobIds.has(item.automationJobId) || lockedIncidentIds.has(item.id) || recoveryIncidentIds.has(item.id)).map((item) => item.id));
  // When clearing another category, every existing incident still needs its
  // rollback dependencies, including completed incidents.
  const keptIncidents = keys.includes('incidents')
    ? incidents.filter((item) => protectedIncidents.has(item.id) || !eligible(item)) : incidents;
  const keptIncidentIds = new Set(keptIncidents.map((item) => item.id));
  const referencedChanges = new Set(keptIncidents.flatMap((item) => item.dnsChangeIds || []));
  const referencedJobs = new Set(keptIncidents.map((item) => item.automationJobId).filter(Boolean));
  const activeLeaseIds = new Set((state.ipLeases || []).filter((lease) => ['locked', 'active'].includes(lease.status)
    && (Date.parse(lease.expiresAt) > now || protectedIncidents.has(lease.incidentId))).map((lease) => lease.id));
  const isProtected = {
    incidents: (item) => protectedIncidents.has(item.id),
    automationRuns: (item) => activeJobIds.has(item.id) || ACTIVE_RUNS.has(item.status) || referencedJobs.has(item.id),
    dnsGuardRuns: () => false,
    ipUsageRecords: (item) => item.status === 'processing' || activeLeaseIds.has(item.leaseId) || keptIncidentIds.has(item.incidentId),
    dnsChanges: (item) => item.status === 'recovery_pending' || referencedChanges.has(item.id) || keptIncidentIds.has(item.incidentId),
    auditLogs: () => false
  };
  let removed = 0;
  let kept = 0;
  const counts = {};
  for (const key of keys) {
    const before = state[key] || [];
    const after = key === 'incidents' ? keptIncidents : before.filter((item) => isProtected[key](item) || !eligible(item));
    counts[key] = before.length - after.length;
    removed += counts[key];
    kept += after.length;
    if (counts[key]) state[key] = after;
  }
  return { removed, kept, counts, changed: removed > 0 || stamped > 0 };
}

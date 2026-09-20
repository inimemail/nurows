export const WORKSPACE_SEARCH = {
  nodes: { key: 'probes', placeholder: '搜索探针名称、地区、运营商', fields: ['name', 'region', 'carrier'] },
  targets: { key: 'probeTargets', placeholder: '搜索检查目标名称、IP、域名', fields: ['name', 'address'] },
  guards: { key: 'dnsGuards', placeholder: '搜索守护名称、域名、活动 IP、来源', fields: ['name', 'domain', 'currentValues', 'sources.name', 'sources.domain', 'sources.backupDomain'] },
  dynamic: { key: 'dynamicGuards', placeholder: '搜索动态守护名称、域名、当前 IP', fields: ['name', 'domain', 'currentIp'] },
  policies: { key: 'failoverPolicies', placeholder: '搜索切换策略名称、业务标识', fields: ['name', 'businessKey'] },
  incidents: { key: 'incidents', placeholder: '搜索故障目标、策略、IP、详情', fields: ['targetName', 'targetAddress', 'policyName', 'allocatedIps', 'message', 'error'] },
  assets: { key: 'ipAssets', placeholder: '搜索资产名称、IP、地区、标签', fields: ['name', 'address', 'region', 'carrier', 'labels', 'note'] },
  pools: { key: 'ipPools', placeholder: '搜索备用池名称、池内 IP、备注', fields: ['name', 'note'] },
  usage: { key: 'ipUsageRecords', placeholder: '搜索使用 IP、备用池、目标、域名', fields: ['address', 'poolName', 'targetName', 'guardName', 'policyName', 'automationTaskName', 'bindings.domain', 'error'] },
  accounts: { key: 'dnsAccounts', placeholder: '搜索 DNS 账号名称、服务商', fields: ['name', 'provider'] },
  bindings: { key: 'dnsBindings', placeholder: '搜索解析名称、域名、记录值、类型', fields: ['name', 'domain', 'recordType', 'currentValues', 'recordValues', 'managedValues', 'backupIps'] },
  changes: { key: 'dnsChanges', placeholder: '搜索变更域名、变更前后 IP 或记录值', fields: ['domain', 'beforeValues', 'afterValues'] },
  bots: { key: 'telegramBots', placeholder: '搜索机器人名称、授权用户或群 ID', fields: ['name', 'userIds'] }
};

export function workspaceSearchPlaceholder(tab, section) {
  const defaults = { probes: 'nodes', pools: 'assets', dns: 'accounts', telegram: 'bots' };
  return WORKSPACE_SEARCH[section || defaults[tab]]?.placeholder || ({
    servers: '搜索服务器名称、IP', commands: '搜索命令名称', automation: '搜索自动化任务', proxies: '搜索代理名称、地址'
  })[tab] || '搜索当前列表';
}

function fieldMatches(value, parts, matches, depth = 0) {
  if (Array.isArray(value)) return value.some((item) => fieldMatches(item, parts, matches, depth));
  if (depth === parts.length) return (typeof value === 'string' || typeof value === 'number') && matches(value);
  return Boolean(value && typeof value === 'object' && fieldMatches(value[parts[depth]], parts, matches, depth + 1));
}

// Only display fields participate; credentials, API command bodies and unrelated
// collections are never serialized or searched. Return original record references.
export function filterWorkspaceRecords(section, records = [], query = '', state = {}, providerLabels = {}) {
  const keyword = String(query).trim().toLowerCase(), config = WORKSPACE_SEARCH[section];
  if (!keyword || !config) return records;
  const paths = config.fields.map((field) => field.split('.'));
  const assets = section === 'pools' ? new Map((state.ipAssets || []).map((item) => [item.id, item.address])) : null;
  const bindings = section === 'changes' ? new Map((state.dnsBindings || []).map((item) => [item.id, item.domain])) : null;
  const matches = (value) => String(value ?? '').toLowerCase().includes(keyword);
  return records.filter((item) => paths.some((parts) => fieldMatches(item, parts, matches))
    || (section === 'accounts' && matches(providerLabels[item.provider]))
    || (assets && (item.assetIds || []).some((id) => matches(assets.get(id))))
    || (bindings && matches(bindings.get(item.bindingId))));
}

export const TELEGRAM_FEATURES = [
  ['overview', '系统总览'], ['incidents', '故障事件'],
  ['guards', 'DNS 守护'], ['dynamic', '动态 IP 守护'],
  ['probes', '探针节点'], ['targets', '检查目标'], ['policies', '切换策略'],
  ['assets', 'IP 资产'], ['pools', '备用 IP 池'], ['usage', 'IP 使用记录'],
  ['dns', '解析管理'], ['automation', '自动化任务'], ['webhooks', 'Webhook 任务'], ['renewals', '续费管理'], ['epay', '易支付查询']
];
export function telegramScopes(settings = {}) {
  const known = new Set(TELEGRAM_FEATURES.map(([key]) => key));
  const scopes = new Set(Array.isArray(settings.menuScopes) ? settings.menuScopes.filter((key) => known.has(key)) : []);
  // Preserve only features already exposed by the old combined menus.
  if (settings.menuScopeVersion !== 2) {
    if (scopes.has('probes')) scopes.add('guards');
    if (scopes.has('pools')) scopes.add('assets');
  }
  if (Array.isArray(settings.menuScopeCatalog)) {
    const previous = new Set(settings.menuScopeCatalog);
    for (const key of known) if (!previous.has(key)) scopes.add(key);
  }
  return [...scopes];
}

// Catalogs distinguish a deliberate deselection from an item added later.
// Missing catalogs migrate existing choices without reselecting old items.
export function telegramBotSelections(settings = {}, tasks) {
  const selection = {
    menuScopes: telegramScopes(settings), menuScopeVersion: 2,
    menuScopeCatalog: TELEGRAM_FEATURES.map(([key]) => key),
    automationTaskIds: [...new Set(settings.automationTaskIds || [])]
  };
  if (Array.isArray(tasks)) {
    const ids = tasks.map(task => task.id);
    const previous = Array.isArray(settings.automationTaskCatalog) ? new Set(settings.automationTaskCatalog) : null;
    if (previous) selection.automationTaskIds = [...new Set([...selection.automationTaskIds, ...ids.filter(id => !previous.has(id))])];
    selection.automationTaskCatalog = ids;
  }
  return selection;
}
export function telegramScopeAllowed(settings, scope) {
  return telegramScopes(settings).includes(scope);
}

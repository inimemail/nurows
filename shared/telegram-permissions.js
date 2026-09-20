export const TELEGRAM_FEATURES = [
  ['overview', '系统总览'], ['incidents', '故障事件'],
  ['guards', 'DNS 守护'], ['dynamic', '动态 IP 守护'],
  ['probes', '探针节点'], ['targets', '检查目标'], ['policies', '切换策略'],
  ['assets', 'IP 资产'], ['pools', '备用 IP 池'], ['usage', 'IP 使用记录'],
  ['dns', '解析管理'], ['automation', '自动化任务']
];
const known = new Set(TELEGRAM_FEATURES.map(([key]) => key));
export function telegramScopes(settings = {}) {
  const scopes = new Set(Array.isArray(settings.menuScopes) ? settings.menuScopes.filter((key) => known.has(key)) : []);
  // Preserve only features already exposed by the old combined menus.
  if (settings.menuScopeVersion !== 2) {
    if (scopes.has('probes')) scopes.add('guards');
    if (scopes.has('pools')) scopes.add('assets');
  }
  return [...scopes];
}
export function telegramScopeAllowed(settings, scope) {
  return telegramScopes(settings).includes(scope);
}

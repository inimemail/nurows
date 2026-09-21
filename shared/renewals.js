export const RENEWAL_CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP', 'SGD', 'AUD', 'CAD', 'TWD', 'KRW'];
export const DEFAULT_RENEWAL_SETTINGS = { days: [7, 3, 1, 0], time: '09:00', botIds: [] };

export function renewalBotIds(item, settings) {
  if (item.notificationEnabled === false) return [];
  return item.botIds?.length ? item.botIds : settings.botIds || [];
}

export function renewalIdentity(item) {
  const name = String(item.name || '').trim().normalize('NFKC').toLowerCase();
  let address = String(item.address || '').trim().toLowerCase().replace(/\.$/, '');
  if (address) {
    try {
      // WHATWG URL canonicalizes IDNs and equivalent IPv6 representations.
      address = new URL(address.includes(':') ? `http://[${address}]/` : `http://${address}/`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    } catch { /* Address syntax is validated separately on save. */ }
  }
  return { name, address };
}

export function renewalIdentityIndex(items, excludeId) {
  const names = new Set(), addresses = new Set();
  for (const item of items) {
    if (excludeId && item.id === excludeId) continue;
    const { name, address } = renewalIdentity(item);
    if (name) names.add(name);
    if (address) addresses.add(address);
  }
  return { names, addresses };
}

export function renewalDuplicateField(item, index) {
  const { name, address } = renewalIdentity(item);
  return name && index.names.has(name) ? 'name' : address && index.addresses.has(address) ? 'address' : '';
}

export function beijingDate(now = Date.now()) {
  return new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);
}

export function validRenewalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2199-12-31') return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function renewalDays(date, now = Date.now()) {
  return validRenewalDate(date || '') ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${beijingDate(now)}T00:00:00Z`)) / 86400000) : null;
}

export function renewalStatus(item, settings = DEFAULT_RENEWAL_SETTINGS, now = Date.now()) {
  const days = renewalDays(item.dueDate, now);
  if (days === null) return { key: 'unknown', label: '未知日期', countdown: '未知日期', tone: 'muted', days };
  if (days < 0) return { key: 'expired', label: '已过期', countdown: `已过期 ${-days} 天`, tone: 'bad', days };
  if (!days) return { key: 'soon', label: '当天到期', countdown: '今天到期', tone: 'bad', days };
  if (days <= Math.max(0, ...(settings.days || []))) return { key: 'soon', label: '即将到期', countdown: days === 1 ? '明天到期' : `还有 ${days} 天`, tone: 'warn', days };
  return { key: 'valid', label: '有效', countdown: `还有 ${days} 天`, tone: 'ok', days };
}

export function sortRenewals(items, now = Date.now()) {
  const today = beijingDate(now);
  return [...items].sort((a, b) => {
    const group = (item) => !item.dueDate ? 2 : item.dueDate < today ? 0 : 1;
    const ag = group(a), bg = group(b);
    return ag - bg || (ag === 0 ? b.dueDate.localeCompare(a.dueDate) : (a.dueDate || '').localeCompare(b.dueDate || ''))
      || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
  });
}

export function renewalAmount(item) {
  if (item.price === '' || item.price == null) return '未填写';
  return `${item.currency} ${Number(item.price).toFixed(2)}`;
}

export function renewalStage(item, settings, now = Date.now()) {
  const days = renewalDays(item.dueDate, now);
  if (days === null || days < 0) return null;
  if (days === 0 && !settings.days.includes(0)) return null;
  let stage = null;
  for (const day of settings.days) if (day >= days && (stage === null || day < stage)) stage = day;
  return stage;
}

export const EPAY_CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'USDT'];
export const EPAY_CHANNELS = { alipay: '支付宝', wxpay: '微信支付', qqpay: 'QQ 钱包', bank: '银行卡', jdpay: '京东支付', paypal: 'PayPal' };
export const EPAY_STATUSES = { paid: '支付成功', pending: '待支付', refunded: '已退款', closed: '已关闭', unknown: '未知状态' };
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const moneyFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// All accounting uses integer minor units; never sum floating point amounts.
export function epayCents(value) {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function epayMoney(cents, currency = 'CNY') {
  if (cents === null || cents === undefined || !Number.isSafeInteger(cents)) return '未提供';
  const symbol = { CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$', USDT: 'USDT ' }[currency] || `${currency} `;
  return `${symbol}${moneyFormatter.format(cents / 100)}`;
}

export function epayBalanceCents(value) {
  const text = String(value ?? '').trim();
  const cents = epayCents(text.startsWith('-') ? text.slice(1) : text);
  return cents === null ? null : text.startsWith('-') ? -cents : cents;
}

export function epayDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  const timestamp = /^\d{10,13}$/.test(text) ? Number(text) * (text.length === 10 ? 1000 : 1)
    : Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(text) ? text.replace(' ', 'T') + '+08:00' : text);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : '';
}

export function epayDay(value = Date.now()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dayFormatter.format(date) : '';
}

export function epayOrderStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (['1', 'paid', 'success', 'trade_success'].includes(status)) return 'paid';
  if (['2', 'refunded', 'refund'].includes(status)) return 'refunded';
  if (['3', 'closed', 'cancelled'].includes(status)) return 'closed';
  if (['0', 'pending', 'unpaid'].includes(status)) return 'pending';
  return 'unknown';
}

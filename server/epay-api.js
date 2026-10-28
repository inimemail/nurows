import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

const apiError = message => Object.assign(new Error(message), { epaySafe: true });
const fail = message => { throw Object.assign(apiError(message), { statusCode: 400 }); };

// Surface only local reason labels and a bounded numeric code. Remote error
// bodies can echo the merchant key, request URL, or private account details.
function rejectionReason(json) {
  const message = typeof json.msg === 'string' ? json.msg.slice(0, 1000) : '';
  const reason = /频繁|频率|限流|too many|rate.?limit/i.test(message) ? '接口限制了查询频率'
    : /权限|未开启|未开通|禁止|permission|disabled/i.test(message) ? '接口未开放或无查询权限'
    : /密钥|签名|商户.*(?:错误|不存在)|invalid.*(?:key|pid)|sign.*error/i.test(message) ? '商户凭证校验未通过'
    : /订单.*(?:不存在|未找到)|(?:未找到|不存在).*订单/.test(message) ? '该订单已不存在或不可查询'
    : /不支持|参数|操作|unsupported|invalid.*(?:act|method)/i.test(message) ? '接口不支持当前查询或参数'
    : '接口拒绝了本次查询';
  const code = /^-?\d{1,6}$/.test(String(json.code)) ? `返回码 ${Number(json.code)} · ` : '';
  return `${code}${reason}`;
}
const blocked = new net.BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(ip, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicEpayAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // IPv4-mapped IPv6 answers must receive the same private-range checks.
  const mapped = family === 6 && String(address).toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && net.isIP(mapped[1]) === 4) return publicEpayAddress(mapped[1]);
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function normalizeEpayUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { fail('请填写完整的 HTTPS 网站地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 1000) fail('请使用 HTTPS 地址，不要包含账号密码、查询参数或锚点');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || (net.isIP(hostname) && !publicEpayAddress(hostname))) fail('易支付网站必须使用公网地址');
  url.pathname = url.pathname.replace(/\/(?:api\.php|submit\.php|mapi\.php)\/?$/i, '/').replace(/\/+$/, '') + '/';
  return url.href;
}

export async function requestEpay(account, key, act, params = {}, options = {}) {
  if (!['query', 'orders', 'order'].includes(act)) fail('不支持的易支付查询');
  const url = new URL('api.php', normalizeEpayUrl(account.url));
  url.search = new URLSearchParams({ ...params, act, pid: account.pid, key }).toString();
  const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses, onAbort;
  try {
    // Resolve once, reject mixed private/public answers and pin the checked IP
    // to the TLS connection to prevent DNS rebinding. Preserve TLS verification.
    addresses = await Promise.race([
      (options.lookup || lookup)(hostname, { all: true, order: 'ipv4first' }),
      new Promise((_, reject) => {
        onAbort = () => reject(Error('timeout'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
  } catch { throw apiError('易支付网站解析失败或请求超时'); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  if (!addresses.length || addresses.some(item => !publicEpayAddress(item.address))) fail('易支付网站解析到了非公网地址，已阻止访问');
  const pinned = addresses[0];
  const json = await new Promise((resolve, reject) => {
    const req = (options.request || https.request)(url, { method: 'GET', signal, agent: false, family: pinned.family,
      lookup(_hostname, opts, callback) { if (opts?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family); },
      headers: { Accept: 'application/json', 'User-Agent': 'NuroSSH-Epay-Monitor/1.0' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(apiError(`易支付接口返回 HTTP ${res.statusCode}，请检查网站地址与接口权限`)); return; }
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 2 * 1024 * 1024) req.destroy(Error('response too large')); else chunks.push(chunk); });
      res.on('error', () => reject(apiError('易支付响应中断，请稍后重试')));
      res.on('end', () => {
        try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw Error(); resolve(data); }
        catch { reject(apiError('易支付接口未返回有效 JSON，请检查是否启用了商户 API')); }
      });
    });
    // Never surface the URL, key, remote error body, or transport error cause.
    req.on('error', () => reject(apiError(signal.aborted ? '易支付请求超时，请稍后重试' : '易支付连接失败，请检查地址、证书与网络')));
    req.end();
  });
  if (Number(json.code) !== 1) {
    // A small set of legacy sites use a failure code for an explicitly empty
    // order page. Do not reinterpret arbitrary errors or authentication errors.
    const empty = /^(?:暂无订单|没有订单|无订单|未查询到订单|未查到订单|订单记录为空|没有更多订单|查询结果为空)[！!。.\s]*$/.test(String(json.msg || '').trim());
    if (act === 'orders' && [-1, 0].includes(Number(json.code)) && empty && (!json.data || Array.isArray(json.data) && !json.data.length)) return { code: 1, data: [] };
    fail(`${{ query: '商户信息', orders: '订单列表', order: '单笔订单' }[act]}查询失败（${rejectionReason(json)}）`);
  }
  return json;
}

export const DNS_PROVIDER_TIMEOUT_MS = 20000;

const NETWORK_CODES = /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/i;
export function dnsRequestFailure(error) {
  const code = String(error?.code || error?.cause?.code || '');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|timed out/i.test(error?.message || '') || /TIMEOUT|ETIMEDOUT/.test(code)) return 'timeout';
  if (NETWORK_CODES.test(code) || error?.message === 'fetch failed' || /socket hang up|network socket disconnected/i.test(error?.message || '')) return 'network';
  return '';
}

// Retry reads only: a timed-out write may already have reached the provider.
// Include response-body reading in the same deadline, since a provider can
// send headers immediately and then stall while sending JSON.
export async function dnsProviderRequest(url, options, { provider, readOnly = false }, runtime = {}) {
  const request = runtime.fetch || globalThis.fetch;
  const wait = runtime.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeout = runtime.timeout || (ms => AbortSignal.timeout(ms));
  const attempts = readOnly ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const signal = timeout(DNS_PROVIDER_TIMEOUT_MS);
    try {
      const response = await request(url, { ...options, signal });
      if (readOnly && attempt < attempts && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        await wait(500);
        continue;
      }
      const text = response.status === 204 ? '' : await response.text();
      // Some providers acknowledge a successful write with 200 and no body.
      // Malformed/nonempty JSON and interrupted body reads are never success.
      const payload = !text.trim() && response.ok && !readOnly ? {} : JSON.parse(text);
      return { response, payload };
    } catch (original) {
      const error = signal.aborted ? signal.reason || original : original;
      const failure = dnsRequestFailure(error);
      if (failure && attempt < attempts) { await wait(500); continue; }
      const operation = readOnly ? '查询' : '写入';
      let message;
      if (failure === 'timeout') message = `${provider} DNS API ${operation}超时（单次 ${DNS_PROVIDER_TIMEOUT_MS / 1000} 秒${readOnly ? '，已尝试 2 次' : '，写入结果待确认'}）`;
      else if (failure === 'network') message = `${provider} DNS API ${operation}连接失败${readOnly ? '（已尝试 2 次）' : '（写入结果待确认）'}，请检查面板服务器到服务商的网络`;
      else if (original?.name === 'SyntaxError') message = `${provider} DNS API 返回了无效 JSON，请检查服务商响应或网络代理`;
      else message = `${provider} DNS API ${operation}请求失败，请检查服务商连接`;
      const wrapped = new Error(message, { cause: original });
      wrapped.name = failure === 'timeout' ? 'TimeoutError' : 'Error';
      wrapped.code = error?.code || error?.cause?.code || (failure === 'network' ? 'ECONNRESET' : undefined);
      throw wrapped;
    }
  }
}

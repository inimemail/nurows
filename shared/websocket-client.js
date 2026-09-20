export async function openAuthenticatedWebSocket(url, { signal, fetchImpl = fetch, Socket = WebSocket } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('获取终端连接凭证超时，请按任意键重试')), 10000);
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl('/api/auth/ws-ticket', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-NuroSSH-WebSocket': '1' },
      body: JSON.stringify({ path: new URL(url).pathname })
    });
    controller.signal.throwIfAborted();
    if (response.status === 401) throw new Error('登录已失效，请刷新页面重新登录');
    const data = await response.json().catch(() => ({}));
    controller.signal.throwIfAborted();
    if (!response.ok) throw new Error(data.error || '无法获取终端连接凭证，请刷新页面重试');
    if (!/^[a-f0-9]{64}$/.test(data.ticket || '')) throw new Error('终端连接凭证无效，请确认前后端已同时更新');
    // Keep the short-lived, single-use proof out of URLs and access logs.
    return new Socket(url, ['nurossh-v1', `nurossh-ticket.${data.ticket}`]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

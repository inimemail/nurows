export async function authenticatorRequest(api, path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try { return await api(path, { ...options, signal: controller.signal }); }
  catch (error) {
    if (timedOut) throw Error('验证器请求超时，请刷新确认结果后再操作');
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}

// Each poll owns one request and one timer. Cleanup also aborts in-flight I/O.
export function startPolling(task, interval, { onError = () => {}, timeout = 15000, visibilityDocument = globalThis.document } = {}) {
  const controller = new AbortController();
  let timer, request, running = false, resumeRequested = false;
  const poll = async () => {
    if(controller.signal.aborted||visibilityDocument?.hidden||running)return;
    running=true;
    request=new AbortController();
    const started = Date.now();
    try {
      await task(AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(timeout)]));
    } catch (error) {
      if (!controller.signal.aborted && !request.signal.aborted) onError(error);
    } finally {
      running=false;
      if (!controller.signal.aborted && !visibilityDocument?.hidden) timer = setTimeout(poll, resumeRequested ? 0 : Math.max(0, interval - (Date.now() - started)));
      resumeRequested=false;
    }
  };
  const visible = () => {
    clearTimeout(timer);
    if(visibilityDocument?.hidden){request?.abort();return;}
    if(running)resumeRequested=true;
    else void poll();
  };
  visibilityDocument?.addEventListener('visibilitychange',visible);
  void poll();
  return () => { controller.abort(); clearTimeout(timer); visibilityDocument?.removeEventListener('visibilitychange',visible); };
}

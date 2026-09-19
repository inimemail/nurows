// Each poll owns one request and one timer. Cleanup also aborts in-flight I/O.
export function startPolling(task, interval, { onError = () => {}, timeout = 15000 } = {}) {
  const controller = new AbortController();
  let timer;
  const poll = async () => {
    const started = Date.now();
    try {
      await task(AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]));
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(poll, Math.max(0, interval - (Date.now() - started)));
    }
  };
  void poll();
  return () => { controller.abort(); clearTimeout(timer); };
}

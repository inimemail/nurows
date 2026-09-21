// One in-flight save per document. Responses update the revision, never newer text.
export function createNoteAutosave({ save, onChange = () => {} }) {
  let current = null,
    edit = 0,
    saved = 0,
    running = null,
    timer = null,
    maxTimer = null,
    error = null,
    closed = false;
  const notify = () => {
    if (!closed)
      onChange({
        document: current,
        dirty: edit !== saved,
        saving: Boolean(running),
        error,
      });
  };
  const clear = () => {
    clearTimeout(timer);
    clearTimeout(maxTimer);
    timer = maxTimer = null;
  };
  function flush() {
    clear();
    if (running)
      return running.then(() => (edit !== saved ? flush() : current));
    if (!current || edit === saved) return Promise.resolve(current);
    const sent = structuredClone(current),
      version = edit;
    error = null;
    running = Promise.resolve()
      .then(() => save(sent))
      .then((result) => {
        current =
          edit === version ? result : { ...current, revision: result.revision };
        saved = version;
        error = null;
        return current;
      })
      .catch((err) => {
        error = err;
        throw err;
      })
      .finally(() => {
        running = null;
        notify();
      });
    notify();
    return running.then(() => (edit !== saved ? flush() : current));
  }
  return {
    open(doc) {
      if (running || edit !== saved) throw new Error("请先保存当前文档");
      current = structuredClone(doc);
      edit = saved = 0;
      error = null;
      notify();
    },
    update(patch) {
      current = { ...current, ...patch };
      edit++;
      error = null;
      notify();
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch(() => {}), 1000);
      if (!maxTimer)
        maxTimer = setTimeout(() => flush().catch(() => {}), 10000);
    },
    flush,
    get: () => current,
    discard() {
      if (running) throw new Error("保存正在执行");
      clear();
      saved = edit;
      error = null;
    },
    resume() {
      closed = false;
    },
    dirty: () => edit !== saved,
    dispose() {
      closed = true;
      clear();
      if (edit !== saved) flush().catch(() => {});
    },
  };
}

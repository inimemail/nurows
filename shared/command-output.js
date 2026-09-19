// Lists and saved workspaces need a preview, not the complete SSH transcript.
export const COMMAND_PREVIEW_LIMIT = 4096;
export const COMMAND_HISTORY_LIMIT = 1000000;

export function commandResultPreview(item) {
  const stdout = String(item.stdout || '');
  const stderr = String(item.stderr || '');
  return { ...item, stdout: stdout.slice(-COMMAND_PREVIEW_LIMIT), stderr: stderr.slice(-COMMAND_PREVIEW_LIMIT), previewOnly: true,
    outputTruncated: Boolean(item.outputTruncated || stdout.length > COMMAND_PREVIEW_LIMIT || stderr.length > COMMAND_PREVIEW_LIMIT) };
}

export function workspaceResultPreviews(results) {
  // Keep even large batches below the JSON body limit, including escaped and
  // multi-byte text. History is fetched per server when its detail is opened.
  const limit = Math.min(COMMAND_PREVIEW_LIMIT, Math.floor(100000 / Math.max(1, results.length)));
  return results.map((item) => {
    const preview = commandResultPreview(item);
    return { ...preview, stdout: limit ? preview.stdout.slice(-limit) : '', stderr: limit ? preview.stderr.slice(-limit) : '',
      outputTruncated: Boolean(preview.outputTruncated || preview.stdout.length > limit || preview.stderr.length > limit) };
  });
}

export function commandJobDelta(job, since) {
  job.previewCache ||= new Map();
  job.previewRevision ||= 0;
  for (const item of job.results) {
    const preview = commandResultPreview(item);
    const signature = JSON.stringify(preview);
    if (job.previewCache.get(item.serverId)?.signature !== signature) {
      job.previewCache.set(item.serverId, { signature, preview, revision: ++job.previewRevision });
    }
  }
  const cursor = Number(since);
  const reset = !Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.previewRevision;
  return {
    reset,
    revision: job.previewRevision,
    results: job.results.flatMap((item) => {
      const cached = job.previewCache.get(item.serverId);
      return reset || cached.revision > cursor ? [cached.preview] : [];
    })
  };
}

export function mergeCommandDelta(previous, delta) {
  if (delta.reset) return delta.results;
  if (!delta.results.length) return previous;
  const updates = new Map(delta.results.map((item) => [item.serverId, item]));
  const merged = previous.map((item) => {
    const next = updates.get(item.serverId);
    updates.delete(item.serverId);
    return next || item;
  });
  return [...merged, ...updates.values()];
}

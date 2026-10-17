// Require an explicit, bounded snapshot: records created after confirmation
// opens must never become part of a bulk deletion.
export function bulkDeleteIds(body) {
  if (body?.confirm !== 'delete-records' || !Array.isArray(body.ids) || !body.ids.length
    || body.ids.length > 20000 || body.ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    throw Object.assign(new Error('请确认删除范围后重试'), { statusCode: 400 });
  }
  return new Set(body.ids);
}

export function partitionDeletion(records, requested, reasonFor) {
  const deleted = new Set(), reasons = new Map();
  let found = 0;
  for (const item of records) {
    if (!requested.has(item.id)) continue;
    found++;
    const reason = reasonFor(item);
    if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    else deleted.add(item.id);
  }
  const missingCount = requested.size - found;
  if (missingCount) reasons.set('记录已不存在', missingCount);
  return { deleted, result: { deletedIds: [...deleted], deletedCount: deleted.size,
    skippedCount: requested.size - deleted.size, missingCount,
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })) } };
}

import { randomUUID } from 'node:crypto';

export const EPAY_RECONCILE_INTERVAL = 30 * 60000;
export const EPAY_RECONCILE_FIELDS = ['reconcileId', 'reconcilePhase', 'reconcileOffset', 'reconcileCutoff', 'reconcileNextAt', 'reconcileWarning', 'reconcileRetryAt', 'reconciledAt'];

const fail = message => { throw Object.assign(Error(message), { epaySafe: true }); };

// One page OR at most two single-order confirmations per regular sync. Remote
// pagination is only a candidate finder; it can never authorize a deletion.
export async function reconcileEpayOrders({ item, store, now, first, request, valid, normalize, merge }) {
  if (!item.initialized || (item.reconcileNextAt || 0) > now) return;
  if (item.historyUnsupported) fail('接口不支持可靠分页，远端删除核对暂不可用，已保留本地订单。');
  if (!item.reconcileId) {
    item.reconcileId = randomUUID(); item.reconcilePhase = 'scan'; item.reconcileOffset = 0;
    item.reconcileCutoff = store.beginAudit(item.id);
  }
  if (item.reconcilePhase === 'scan') {
    const offset = item.reconcileOffset || 0, size = item.pageSize || 50;
    const rows = offset ? await request('orders', { limit: size, num: size, page: Math.floor(offset / size) + 1, start: offset }) : first;
    if (!valid()) throw Error('核对已取消');
    if (!Array.isArray(rows) || rows.length > 1000) fail('订单分页格式不兼容');
    const added = store.auditSeen(item.id, item.reconcileId, rows);
    if (rows.length && !added) {
      item.reconcileId = ''; item.reconcilePhase = ''; item.reconcileNextAt = now;
      fail('订单分页重复，无法核实远端删除，已保留本地订单。');
    }
    item.reconcileOffset = offset + rows.length;
    if (rows.length < size) {
      store.prepareAuditCandidates(item.id, item.reconcileId, item.reconcileCutoff);
      item.reconcilePhase = 'confirm';
    }
    return;
  }
  for (const candidate of store.auditCandidates(item.id, item.reconcileId, item.reconcileCutoff, now)) {
    try {
      const raw = await request('order', { trade_no: candidate.trade_no });
      if (!valid()) throw Error('核对已取消');
      const row = normalize(raw);
      if (row.trade_no !== candidate.trade_no) throw Object.assign(Error('订单核对返回了不同订单号，已停止核对'), { epayIntegrity: true });
      merge([row]); store.auditSeen(item.id, item.reconcileId, [row]);
    } catch (error) {
      if (!valid() || !error.epayOrderMissing) throw error;
      if (candidate.missing_at && now - candidate.missing_at >= 60000) store.deleteOrder(item.id, candidate.trade_no);
      else store.auditMissing(item.id, candidate.trade_no, now);
    }
  }
  if (!store.auditRemaining(item.id, item.reconcileId, item.reconcileCutoff)) {
    item.reconcileId = ''; item.reconcilePhase = ''; item.reconciledAt = new Date(now).toISOString();
    item.reconcileNextAt = now + EPAY_RECONCILE_INTERVAL;
  }
}

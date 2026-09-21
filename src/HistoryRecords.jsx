import { useEffect, useState } from 'react';

export const HISTORY_LABELS = {
  automationRuns: '自动化执行记录', dnsGuardRuns: 'DNS 守护检查记录', incidents: '故障事件',
  ipUsageRecords: 'IP 使用记录', dnsChanges: 'DNS 变更记录', auditLogs: '审计记录', dynamicGuardRuns: '动态 IP 守护执行记录'
};

const STATUS = { running: '执行中', queued: '等待执行', paused: '已暂停', awaiting_input: '等待输入', done: '已完成',
  healthy: '正常', replaced: '已完成补位', degraded: '容量不足', error: '执行异常', waiting_ip: '等待备用 IP', processing: '处理中', succeeded: '已完成', cancelled: '已结束', returned: '已退回原池' };

// Load only while this record dialog is open, with bounded pages and no
// background polling. Do not overwrite the guard workspace's latest-run cache.
export default function HistoryRecords({ scope, api, revision, clearing, onClear, guardId }) {
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api(guardId ? `/api/dynamic-guards/${encodeURIComponent(guardId)}/history?page=${page}` : `/api/history/${scope}?page=${page}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then((data) => { if (!controller.signal.aborted) setResult(data); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, scope, guardId, page, refresh, revision]);
  const records = result?.records || [];
  return <>
    <div className="ops-content-head">
      <div><strong>{HISTORY_LABELS[scope]}</strong><span>默认保留 7 天{result ? ` · 共 ${result.total} 条` : ''}</span></div>
      <div className="ops-content-actions">
        {onClear ? <button className="ghost danger-text-button" disabled={clearing} onClick={() => onClear(scope)}>{clearing ? '清理中...' : '清理全部'}</button> : null}
        <button className="ghost" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
      </div>
    </div>
    {error ? <p role="alert" className="auth-error">{error}</p> : loading ? <p className="confirm-copy">正在读取记录...</p> : <div className="ops-list">
      {records.length ? records.map((item) => {
        const time = item.finishedAt || item.createdAt || item.startedAt;
        const title = scope === 'automationRuns' ? item.taskName : ['dnsGuardRuns', 'dynamicGuardRuns'].includes(scope) ? item.guardName || item.domain : item.summary || item.action;
        const detail = scope === 'automationRuns' ? `共 ${item.total || 0} 个 · 成功 ${item.ok || 0} · 失败 ${item.error || 0}`
          : scope === 'dynamicGuardRuns' ? [item.domain, `${item.oldIp} → ${item.newIp || '等待新 IP'}`, `尝试 ${item.attempts} 次`, item.message].filter(Boolean).join(' · ')
          : scope === 'dnsGuardRuns' ? [item.domain, item.message].filter(Boolean).join(' · ') : [item.actor, item.action].filter(Boolean).join(' · ');
        return <article className="ops-row" key={item.id}><div className="ops-row-main"><div><strong>{title || '历史记录'}</strong><span>{[time ? new Date(time).toLocaleString('zh-CN') : '', detail].filter(Boolean).join(' · ')}</span>{scope === 'dynamicGuardRuns' ? <details><summary>详情与最近命令输出</summary><p className="confirm-copy">{detail}</p><pre className="dynamic-run-output">{item.output || '暂无命令输出'}</pre></details> : null}</div></div>
          {item.status ? <div className="ops-row-side"><em className="ops-status muted">{STATUS[item.status] || item.status}</em></div> : null}</article>;
      }) : <div className="ops-empty"><strong>暂无{HISTORY_LABELS[scope]}</strong></div>}
    </div>}
    {result?.pages > 1 ? <div className="ops-content-actions">
      <button className="ghost" disabled={loading || result.page <= 1} onClick={() => setPage(result.page - 1)}>上一页</button>
      <span>{result.page} / {result.pages}</span>
      <button className="ghost" disabled={loading || result.page >= result.pages} onClick={() => setPage(result.page + 1)}>下一页</button>
    </div> : null}
  </>;
}

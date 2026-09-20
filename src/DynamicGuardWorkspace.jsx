import { useEffect, useRef, useState } from 'react';
import { startPolling } from '../shared/polling.js';
import HistoryRecords from './HistoryRecords.jsx';
import './dynamic-guard.css';

const DEFAULTS = { name: '', domain: '', command: '', recordType: 'A', probeIds: [], botIds: [], enabled: true,
  checkType: 'ping', port: 443, interval: 30, checkRounds: 3, attemptsPerRound: 3, timeout: 5,
  waitTimeout: 300, queryInterval: 5, commandTimeout: 90, cooldown: 0, maxDaily: 5 };
const LABELS = { queued: '等待执行', healthy: '正常', checking: '检查中', verifying: '验证新 IP', executing: '执行换 IP',
  waiting_ip: '等待新 IP', waiting_probe: '等待探针', query_error: '查询异常', command_error: '命令异常',
  cooldown: '冷却中', limit: '达到每日上限', disabled: '已停用' };
const numbers = [
  ['interval', '检查间隔（秒）', 5, 86400], ['checkRounds', '失败轮数', 1, 10],
  ['attemptsPerRound', '每轮次数', 1, 10], ['timeout', '每轮超时（秒）', 1, 60],
  ['waitTimeout', '等待新 IP 超时（秒，0 为持续等待）', 0, 86400], ['queryInterval', '等待期间查询间隔（秒）', 5, 3600],
  ['commandTimeout', '命令执行超时（秒）', 1, 600], ['cooldown', '两次提交最短间隔（秒）', 0, 86400],
  ['maxDaily', '每日换 IP 上限（0 为不限）', 0, 10000]
];

function GuardCountdown({ guard, offset }) {
  const [time, setTime] = useState(() => Date.now() + offset);
  const active = ['waiting_ip', 'cooldown'].includes(guard.status);
  useEffect(() => {
    if (!active) return;
    const update = () => { if (!document.hidden) setTime(Date.now() + offset); };
    update();
    const timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [active, offset]);
  if (guard.status === 'cooldown') return ` · 剩余 ${Math.max(0, Math.ceil((guard.nextAt - time) / 1000))} 秒`;
  if (guard.status !== 'waiting_ip') return null;
  if (!guard.flow?.deadlineAt) return ' · 持续等待，不因超时重提';
  const remaining = Math.max(0, Math.ceil((guard.flow.deadlineAt - time) / 1000));
  return remaining ? ` · ${remaining} 秒后仍无新 IP 则重试` : ' · 即将确认解析并重试';
}

export default function DynamicGuardWorkspace({ api, toast, Dialog, onOpenHistory, onState }) {
  const [data, setData] = useState({ guards: [], probes: [], bots: [] });
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyGuard, setHistoryGuard] = useState(null);
  const generation = useRef(0);
  const offset = useRef(0);
  const mounted = useRef(true);
  const actionLock = useRef(false);
  const saveLock = useRef(false);
  const time = Date.now() + offset.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    let cancelled = false;
    const stop = startPolling(async (signal) => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const version = generation.current;
      const result = await api('/api/dynamic-guards', { signal });
      if (cancelled || version !== generation.current) return;
      offset.current = result.serverTime - Date.now();
      setData(result); setError('');
      onState?.((current) => current.dynamicGuardsCount === result.guards.length ? current : { ...current, dynamicGuardsCount: result.guards.length });
    }, 5000, { onError: (err) => { if (!cancelled) setError(err.message); } });
    return () => { cancelled = true; stop(); };
  }, [api, refresh, onState]);

  const mutate = async (url, method, body) => {
    generation.current++;
    try { return await api(url, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
    finally { generation.current++; if (mounted.current) setRefresh((value) => value + 1); }
  };
  const patch = (value) => setEditor((current) => ({ ...current, ...value }));
  const openEditor = (guard) => { setFormError(''); setSettingsOpen(!guard); setEditor(guard ? { ...guard, command: '' } : structuredClone(DEFAULTS)); };
  const save = async (event) => {
    event.preventDefault();
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true); setFormError('');
    try {
      const body = Object.fromEntries([...Object.keys(DEFAULTS)].map((key) => [key, editor[key]]));
      await mutate(`/api/dynamic-guards${editor.id ? `/${editor.id}` : ''}`, editor.id ? 'PUT' : 'POST', body);
      setEditor(null); toast('动态 IP 守护已保存');
    } catch (err) { setFormError(err.message); }
    finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  };
  const act = async (guard, action) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusyId(guard.id);
    try {
      if (action === 'delete') await mutate(`/api/dynamic-guards/${guard.id}`, 'DELETE', { confirm: 'delete-guard' });
      else if (action === 'toggle') await mutate(`/api/dynamic-guards/${guard.id}/enabled`, 'POST', { enabled: !guard.enabled });
      else await mutate(`/api/dynamic-guards/${guard.id}/${action}`, 'POST', action === 'change' ? { confirm: 'change-ip' } : {});
      toast(action === 'delete' ? '任务已删除' : action === 'toggle' ? '任务状态已更新' : '请求已排队，后台处理');
    } catch (err) { toast(err.message); }
    finally { actionLock.current = false; if (mounted.current) setBusyId(''); }
  };

  return <>
    <div className="ops-content-head dynamic-head"><div><strong>动态 IP 守护</strong><span>多探针检查 · API 自动换 IP · 新 IP 验证</span></div>
      <div className="ops-content-actions"><button className="ghost" onClick={() => onOpenHistory('dynamicGuardRuns')}>执行记录</button><button className="primary" onClick={() => openEditor(null)}>新增任务</button></div>
    </div>
    {error ? <p className="auth-error" role="alert">读取失败：{error}，稍后自动重试</p> : null}
    <div className="ops-list dynamic-list">
      {!data.guards.length ? <div className="ops-empty"><strong>还没有动态 IP 守护任务</strong><span>填写 DDNS 域名和换 IP API 命令即可开始。</span></div> : data.guards.map((guard) => {
        const bad = ['query_error', 'command_error', 'limit', 'waiting_probe'].includes(guard.status);
        const tone = guard.status === 'healthy' ? 'ok' : bad ? 'bad' : 'warn';
        const locked = Boolean(busyId) || guard.status === 'executing';
        return <article className="dynamic-card" key={guard.id}>
          <div className="dynamic-card-title"><div><strong>{guard.name}</strong><span>{guard.domain} · {guard.recordType}</span></div><em className={`ops-status ${tone}`}>{LABELS[guard.status] || guard.status}</em></div>
          <div className="dynamic-facts"><div><span>当前 IP</span><code>{guard.currentIp || '尚未获取'}</code></div><div><span>今日提交 · 北京时间重置</span><strong>{guard.todayCount} / {guard.maxDaily || '不限'}</strong></div><div><span>负责探针</span><strong>{guard.probeIds.length} 个</strong></div></div>
          <p className="dynamic-message">{guard.message}<GuardCountdown guard={guard} offset={offset.current} /></p>
          <div className="dynamic-actions">
            <button className="ghost" onClick={() => setHistoryGuard(guard)}>查看记录</button>
            <button className="ghost" disabled={locked || !guard.enabled} onClick={() => act(guard, 'check')}>立即检查</button>
            <button className="ghost" disabled={locked || !guard.enabled || Boolean(guard.flow) || guard.manualRequested} onClick={() => setConfirmation({ guard, action: 'change' })}>手动换 IP</button>
            <button className="ghost" disabled={locked} onClick={() => openEditor(guard)}>编辑</button>
            <button className="ghost" disabled={Boolean(busyId)} onClick={() => act(guard, 'toggle')}>{guard.enabled ? '停用' : '启用'}</button>
            <button className="ghost danger-text-button" disabled={locked} onClick={() => setConfirmation({ guard, action: 'delete' })}>删除</button>
          </div>
        </article>;
      })}
    </div>
    {editor ? <Dialog title={editor.id ? '编辑动态 IP 守护' : '新增动态 IP 守护'} wide className="dynamic-editor" onClose={() => !saving && setEditor(null)}
      footer={<div className="dynamic-editor-footer"><button className="ghost" disabled={saving} onClick={() => setEditor(null)}>取消</button><button className="primary" form="dynamic-guard-form" type="submit" disabled={saving}>{saving ? '保存中...' : '保存任务'}</button></div>}>
      <form id="dynamic-guard-form" onSubmit={save}>
        <div className="dynamic-form-grid">
          <label>任务名称<input value={editor.name} maxLength={100} onChange={(event) => patch({ name: event.target.value })} placeholder="可留空，使用域名" /></label>
          <label>目标 DDNS 域名<input required value={editor.domain} autoCapitalize="none" spellCheck={false} onChange={(event) => patch({ domain: event.target.value })} placeholder="vps.example.com" /></label>
          <label>地址类型<select value={editor.recordType} onChange={(event) => patch({ recordType: event.target.value })}><option value="A">IPv4（A）</option><option value="AAAA">IPv6（AAAA）</option></select></label>
          <label>检查方式<select value={editor.checkType} onChange={(event) => patch({ checkType: event.target.value })}><option value="ping">Ping</option><option value="tcp">TCP</option></select></label>
          {editor.checkType === 'tcp' ? <label>TCP 端口<input type="number" inputMode="numeric" required min={1} max={65535} value={editor.port} onChange={(event) => patch({ port: event.target.value })} /></label> : null}
        </div>
        <fieldset className="dynamic-choice"><legend>检查探针 · 任意一个一次成功即通过</legend><div>{data.probes.filter((probe) => probe.enabled !== false).map((probe) => <label key={probe.id}><input type="checkbox" checked={editor.probeIds.includes(probe.id)} onChange={(event) => patch({ probeIds: event.target.checked ? [...editor.probeIds, probe.id] : editor.probeIds.filter((id) => id !== probe.id) })} /><span>{probe.name}{probe.status !== 'online' || time - Date.parse(probe.lastSeenAt) >= 90000 ? '（离线）' : ''}</span></label>)}</div>{!data.probes.length ? <p>请先在探针节点中添加探针。</p> : null}</fieldset>
        <label className="dynamic-command">换 IP API 命令<textarea required={!editor.commandConfigured} rows={6} maxLength={32768} autoCapitalize="none" spellCheck={false} value={editor.command} onChange={(event) => patch({ command: event.target.value })} placeholder={editor.commandConfigured ? '已保存加密命令；留空保持原命令' : 'curl --fail --max-time 60 ...\n支持多行，在面板所在 Linux 环境执行'} /></label>
        {editor.commandConfigured ? <button type="button" className="ghost" disabled={saving} onClick={async () => {
          const id = editor.id;
          try { const result = await api(`/api/dynamic-guards/${id}/command`, { signal: AbortSignal.timeout(15000) }); setEditor((current) => current?.id === id ? { ...current, command: result.command } : current); }
          catch (err) { setFormError(err.message); }
        }}>读取已保存命令</button> : null}
        <p className="confirm-copy">正常时不执行命令。全部探针全部轮次失败后才自动换 IP；等待新 IP 超时会重新提交。请让 API 命令的退出码反映请求结果，例如 curl 使用 --fail。更改目标域名会结束旧目标的等待流程。</p>
        <details className="dynamic-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}><summary>检查与重试设置</summary><div className="dynamic-form-grid">{numbers.map(([key, label, min, max]) => <label key={key}>{label}<input type="number" inputMode="numeric" required min={min} max={max} value={editor[key]} onChange={(event) => patch({ [key]: event.target.value })} /></label>)}</div></details>
        <fieldset className="dynamic-choice"><legend>结果通知（可选）</legend><div>{data.bots.filter((bot) => bot.enabled !== false && bot.configured).map((bot) => <label key={bot.id}><input type="checkbox" checked={editor.botIds.includes(bot.id)} onChange={(event) => patch({ botIds: event.target.checked ? [...editor.botIds, bot.id] : editor.botIds.filter((id) => id !== bot.id) })} /><span>{bot.name}</span></label>)}</div><p>正常检查不通知；完成、等待超时重试、命令异常或达到上限时通知，同一流程的同类异常不重复刷屏。</p></fieldset>
        <label className="dynamic-enable"><input type="checkbox" checked={editor.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用任务</label>
        {formError ? <p className="auth-error" role="alert">{formError}</p> : null}
      </form>
    </Dialog> : null}
    {historyGuard ? <Dialog title={`${historyGuard.name} · 执行记录`} wide onClose={() => setHistoryGuard(null)}><HistoryRecords key={historyGuard.id} scope="dynamicGuardRuns" guardId={historyGuard.id} api={api} /></Dialog> : null}
    {confirmation ? <Dialog title={confirmation.action === 'delete' ? '删除动态 IP 守护' : '手动换 IP'} onClose={() => setConfirmation(null)} footer={<div className="dialog-actions"><button className="ghost" onClick={() => setConfirmation(null)}>取消</button><button className="primary" onClick={() => { const { guard, action } = confirmation; setConfirmation(null); act(guard, action); }}>确认</button></div>}>
      <p className="confirm-copy">{confirmation.action === 'delete' ? `删除「${confirmation.guard.name}」并停止后续检查及重试。已经提交给服务商的请求无法撤回，执行记录会保留。` : `立即执行「${confirmation.guard.name}」的换 IP API 命令，会消耗今日一次提交额度，并可能中断目标服务。仍遵守每日上限和冷却时间。`}</p>
    </Dialog> : null}
  </>;
}

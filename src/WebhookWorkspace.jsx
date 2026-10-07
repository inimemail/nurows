import { useEffect, useRef, useState } from 'react';
import { Webhook, Plus, Settings, History, Play, Copy, Pencil, MoreHorizontal, Trash2, RefreshCw, Square, Eye, EyeOff, Link } from 'lucide-react';
import { startPolling } from '../shared/polling.js';
import { copyNoteText } from './note-clipboard.js';
import { RenewalBotPicker } from './RenewalWorkspace.jsx';
import './webhooks.css';

const EMPTY = { name: '', serverId: '', command: '', timeout: 30, note: '', enabled: true, externalEnabled: true, allowGet: false, botIds: [] };
const LABELS = { queued: '排队中', running: '执行中', waiting_guard: '守护处理中', success: '成功', failed: '失败', timeout: '超时', cancelled: '已停止', uncertain: '待确认' };
const ACTIVE = new Set(['queued', 'running', 'waiting_guard']);
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

export default function WebhookWorkspace({ api, toast, Dialog, cache, search = '', onSearchScopeChange }) {
  const [data, setData] = useState(() => cache.current?.data || null), [error, setError] = useState('');
  const [query, setQuery] = useState(search), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState(null), [calls, setCalls] = useState(null), [history, setHistory] = useState(null), [settings, setSettings] = useState(null), [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const generation = useRef(0), lock = useRef(false), latest = useRef(data), mounted = useRef(true);
  const editorRequest = useRef(0), [opening, setOpening] = useState('');
  latest.current = data;
  useEffect(() => { onSearchScopeChange?.({ tab: 'webhooks', section: 'webhooks' }); }, [onSearchScopeChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; editorRequest.current++; }; }, []);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let stop, cancelled = false;
    const start = () => {
      stop?.(); if (document.hidden || cancelled) return;
      let active = true, due = 0;
      const cleanup = startPolling(async (signal) => {
        if (lock.current || Date.now() < due) return;
        const version = generation.current;
        try {
          const result = await api(`/api/webhooks?search=${encodeURIComponent(query)}&page=${page}`, { signal });
          if (!active || cancelled || version !== generation.current) return;
          if (JSON.stringify(latest.current) !== JSON.stringify(result)) { latest.current = result; setData(result); }
          cache.current = { data: result }; setError('');
          due = Date.now() + (result.active ? 2000 : 10000);
        } catch (err) { if (active && !cancelled && version === generation.current) setError(err.message); due = Date.now() + 5000; }
      }, 2000);
      stop = () => { active = false; cleanup(); };
    };
    start(); document.addEventListener('visibilitychange', start);
    return () => { cancelled = true; stop?.(); document.removeEventListener('visibilitychange', start); };
  }, [api, query, page, refresh, cache]);
  async function mutate(path, body, method = 'POST') {
    if (lock.current) throw new Error('操作正在处理，请稍后');
    lock.current = true; generation.current++; setBusy(true); setFormError('');
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      if (!mounted.current) return;
      toast('操作已完成'); return result;
    } catch (err) { if (mounted.current) { setFormError(err.message); toast(err.message); } throw err; }
    finally { lock.current = false; generation.current++; if (mounted.current) { setBusy(false); setRefresh((n) => n + 1); } }
  }
  async function edit(item, duplicate = false) {
    if (opening || busy) return;
    const version = ++editorRequest.current; setOpening(item.id); setFormError('');
    try {
      const result = await api(`/api/webhooks/${item.id}`);
      if (mounted.current && version === editorRequest.current) setEditor(duplicate ? { ...result, id: undefined, version: undefined, name: `${result.name} 副本`.slice(0, 120), enabled: false } : result);
    } catch (err) { if (mounted.current && version === editorRequest.current) toast(err.message); }
    finally { if (mounted.current && version === editorRequest.current) setOpening(''); }
  }
  const ask = (title, text, action) => setConfirm({ title, text, action });
  const patch = (value) => setEditor((old) => ({ ...old, ...value }));
  const tasks = data?.tasks || [];
  return <section className="ops-workspace webhook-workspace">
    <header className="surface ops-header"><div><span className="ops-eyebrow">自动调用 · 后台执行</span><strong>Webhook 任务</strong></div><div className="webhook-summary"><Webhook size={17} /><span>{data ? `${data.total} 个任务 · ${data.active} 个处理中` : '正在读取任务…'}</span></div></header>
    <div className="surface ops-content webhook-content">
      <div className="ops-content-head"><div><strong>任务列表</strong><span>保存命令，通过链接触发，立即返回执行状态</span></div><div className="ops-content-actions webhook-actions">
        <button className="ghost icon-button" aria-label="刷新任务" title="刷新" onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={16} /></button>
        <button className="ghost" onClick={() => setHistory({ name: '全部任务' })}><History size={16} />历史记录</button>
        <button className="ghost icon-button" aria-label="Webhook 设置" title="设置" disabled={!data} onClick={() => setSettings({ ...data.settings })}><Settings size={17} /></button>
        <button className="primary" disabled={busy || !data} onClick={() => { setFormError(''); setEditor(structuredClone(EMPTY)); }}><Plus size={16} />新建任务</button>
      </div></div>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      <div className="webhook-table-head"><span>任务 / 执行位置</span><span>最近执行</span><span>操作</span></div>
      <div className="webhook-list">{tasks.map((item) => <article className="webhook-row" key={item.id} onClick={(event) => { if (event.detail === 3 && !event.target.closest('button, details, input')) void edit(item, true); }}>
        <div className="webhook-identity"><div className="webhook-name"><strong>{item.name}</strong>{!item.enabled ? <span className="webhook-badge muted">已停用</span> : null}{item.guardId ? <span className="webhook-badge">关联守护</span> : null}</div><span>{item.location} · 超时 {item.timeout} 秒</span>{item.note ? <p>{item.note}</p> : null}</div>
        <div className="webhook-state"><span className={`webhook-badge ${item.run?.status || 'muted'}`}>{LABELS[item.run?.status] || '暂无执行'}</span>{item.run ? <><small>{date(item.run.finishedAt || item.run.startedAt || item.run.created)}</small><span className="webhook-message" title={item.run.message}>{item.run.message}</span></> : null}</div>
        <div className="webhook-row-actions"><button className="ghost" disabled={busy || !item.enabled} onClick={() => ACTIVE.has(item.run?.status) ? setHistory({ id: item.id, name: item.name, runId: item.run.id }) : ask('执行 Webhook 任务', `将执行「${item.name}」中已保存的命令。${item.guardId ? '关联任务由动态守护处理，并沿用额度和冷却设置。' : ''}`, async () => { await mutate(`/api/webhooks/${item.id}/run`, {}); })}><Play size={14} />{ACTIVE.has(item.run?.status) ? '进度' : '执行'}</button>
          <button className="ghost" onClick={() => setCalls(item)}><Link size={14} />调用</button>
          <button className="ghost icon-button" aria-label={`${item.name} 的历史`} title="历史记录" onClick={() => setHistory({ id: item.id, name: item.name })}><History size={16} /></button>
          <details className="webhook-menu" onToggle={(event) => { if (event.currentTarget.open) event.currentTarget.querySelector('div')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }}><summary className="ghost icon-button" aria-label={`${item.name} 的更多操作`}><MoreHorizontal size={18} /></summary><div>{[
            ['编辑', Pencil, () => void edit(item)], ['复制', Copy, () => void edit(item, true)],
            [item.enabled ? '停用' : '启用', Play, () => ask(item.enabled ? '停用任务' : '启用任务', '此设置控制后续调用，当前执行可在历史记录中单独停止。', async () => { await mutate(`/api/webhooks/${item.id}`, { ...item, command: '', enabled: !item.enabled }, 'PUT'); })],
            ['删除', Trash2, () => ask('删除 Webhook 任务', `删除「${item.name}」后，其调用凭证立即失效。关联守护或正在执行的任务须先解除关联或停止。`, async () => { await mutate(`/api/webhooks/${item.id}`, { confirm: true }, 'DELETE'); })]
          ].map(([label, Icon, action]) => <button key={label} className={label === '删除' ? 'danger-text-button' : ''} disabled={busy || Boolean(opening)} onClick={(event) => { event.currentTarget.closest('details').open = false; action(); }}><Icon size={15} />{opening === item.id && label === '编辑' ? '读取中…' : label}</button>)}</div></details>
        </div>
      </article>)}</div>
      {!tasks.length ? <div className="ops-empty"><Webhook size={30} /><strong>{!data ? '正在读取…' : query ? '没有匹配的任务' : '暂无 Webhook 任务'}</strong><span>可在面板执行 API 命令，也可复用现有 SSH 服务器。</span></div> : null}
      {data?.pages > 1 ? <div className="webhook-pagination"><button className="ghost" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</button><span>{data.page} / {data.pages} · {data.matched} 个任务</span><button className="ghost" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>下一页</button></div> : null}
    </div>
    {editor ? <Dialog title={editor.id ? '编辑 Webhook 任务' : '新建 Webhook 任务'} className="webhook-dialog" wide onClose={() => !busy && setEditor(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setEditor(null)}>取消</button><button className="primary" type="submit" form="webhook-editor" disabled={busy}>{busy ? '保存中…' : '保存任务'}</button></div>}>
      <form className="webhook-form" id="webhook-editor" onSubmit={async (event) => { event.preventDefault(); try { await mutate(`/api/webhooks${editor.id ? `/${editor.id}` : ''}`, editor, editor.id ? 'PUT' : 'POST'); if (mounted.current) setEditor(null); } catch { /* inline error */ } }}>
        <div className="webhook-section-label"><Webhook size={17} /><span>任务配置</span></div>
        <label className="ops-field full"><span>任务名称 *</span><input required maxLength={120} value={editor.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：更换 VPS IP" /></label>
        <label className="ops-field"><span>执行位置</span><select value={editor.serverId} onChange={(e) => patch({ serverId: e.target.value })}><option value="">面板本机</option>{editor.serverId && !data.servers.some((server) => server.id === editor.serverId) ? <option value={editor.serverId}>服务器已删除，请重新选择</option> : null}{data.servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.host}</option>)}</select><small>{editor.serverId ? '复用服务器的 SSH 凭证和代理；远程需 Bash、coreutils。' : 'Docker 部署时，命令在面板容器内执行。'}</small></label>
        <label className="ops-field"><span>执行超时（秒）</span><input required type="number" inputMode="numeric" min={5} max={3600} value={editor.timeout} onChange={(e) => patch({ timeout: e.target.value })} /></label>
        <label className="ops-field full"><span>执行命令 *</span><textarea className="webhook-code-input" required rows={5} maxLength={32768} spellCheck={false} autoCapitalize="none" value={editor.command} onChange={(e) => patch({ command: e.target.value })} placeholder={'curl --fail --max-time 25 …\n支持多行 Bash 命令'} /><small>curl 默认使用 IPv4；显式网络参数会保留。运行中的命令使用原配置，编辑后下次生效。</small></label>
        <label className="ops-field full"><span>备注</span><textarea rows={2} maxLength={1000} value={editor.note} onChange={(e) => patch({ note: e.target.value })} /></label>
        <div className="webhook-options"><label><input type="checkbox" checked={editor.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /><span>启用任务<small>允许手动和外部触发</small></span></label><label><input type="checkbox" checked={editor.externalEnabled} onChange={(e) => patch({ externalEnabled: e.target.checked })} /><span>外部调用<small>独立 Token 验证</small></span></label></div>
        <details className="webhook-advanced"><summary>兼容与通知设置</summary><div><label className="ops-toggle"><input type="checkbox" checked={editor.allowGet} onChange={(e) => patch({ allowGet: e.target.checked })} /><span>允许 GET 兼容调用</span></label><p>默认使用 POST 和请求头凭证。GET 链接含 Token，请勿公开分享。</p><RenewalBotPicker label="TG 通知机器人（默认不选）" bots={data.bots} value={editor.botIds} onChange={(botIds) => patch({ botIds })} /><p>每次执行结束通知一次。关联动态守护时由守护通知最终结果。</p></div></details>
        {formError ? <p className="auth-error full" role="alert">{formError}</p> : null}
      </form>
    </Dialog> : null}
    {calls ? <CallDialog task={calls} api={api} toast={toast} Dialog={Dialog} onClose={() => setCalls(null)} onReset={() => setRefresh((n) => n + 1)} /> : null}
    {history ? <HistoryDialog task={history} api={api} toast={toast} Dialog={Dialog} onClose={() => setHistory(null)} onChange={() => setRefresh((n) => n + 1)} /> : null}
    {settings ? <Dialog title="Webhook 执行设置" className="webhook-dialog" onClose={() => !busy && setSettings(null)} footer={<div className="dialog-actions"><button className="ghost" onClick={() => setSettings(null)} disabled={busy}>取消</button><button className="primary" form="webhook-settings" type="submit" disabled={busy}>保存设置</button></div>}><form id="webhook-settings" className="webhook-form" onSubmit={async (e) => { e.preventDefault(); try { await mutate('/api/webhooks/settings', settings, 'PUT'); setSettings(null); } catch {} }}><label className="ops-field"><span>后台并发任务</span><input type="number" required min={1} max={50} value={settings.concurrency} onChange={(e) => setSettings((s) => ({ ...s, concurrency: e.target.value }))} /></label><label className="ops-field"><span>等待队列上限</span><input type="number" required min={10} max={2000} value={settings.queueLimit} onChange={(e) => setSettings((s) => ({ ...s, queueLimit: e.target.value }))} /></label><p className="webhook-help full">默认 8 个并发，仅作用于 Webhook 任务。执行与调用记录自动保留 7 天；历史记录内可以手动清理。</p>{formError ? <p className="auth-error full">{formError}</p> : null}</form></Dialog> : null}
    {confirm ? <Dialog title={confirm.title} onClose={() => !busy && setConfirm(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="primary" disabled={busy} onClick={async () => { try { await confirm.action(); if (mounted.current) setConfirm(null); } catch {} }}>{busy ? '处理中…' : '确认'}</button></div>}><p className="confirm-copy">{confirm.text}</p></Dialog> : null}
  </section>;
}

function CodeCopy({ title, value, toast }) {
  return <section className="webhook-call-code"><div><strong>{title}</strong><button className="ghost" disabled={!value} onClick={async () => { try { await copyNoteText(value); toast('已复制'); } catch { toast('复制失败，请手动选择文本'); } }}><Copy size={14} />复制</button></div><pre tabIndex={0}>{value || '读取中…'}</pre></section>;
}
function CallDialog({ task, api, toast, Dialog, onClose, onReset }) {
  const [token, setToken] = useState(''), [reveal, setReveal] = useState(false), [tab, setTab] = useState('run'), [error, setError] = useState(''), [reset, setReset] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => { const controller = new AbortController(); api(`/api/webhooks/${task.id}/token`, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setToken(result.token); }).catch((err) => { if (!controller.signal.aborted) setError(err.message); }); return () => controller.abort(); }, [api, task.id]);
  const url = `${window.location.origin}/hooks/${task.id}`;
  const command = token ? tab === 'run'
    ? `curl -4 --fail --max-time 15 -X POST ${quote(`${url}/run`)} -H ${quote(`Authorization: Bearer ${token}`)}`
    : `curl -4 --fail --max-time 15 ${quote(`${url}/status?executionId=执行ID`)} -H ${quote(`Authorization: Bearer ${token}`)}` : '';
  return <Dialog title={`${task.name} · 调用方式`} wide className="webhook-dialog" onClose={() => !busy && onClose()}>
    {!task.externalEnabled ? <p className="webhook-help">该任务的外部调用已关闭，可在编辑中开启。</p> : null}
    <div className="webhook-token"><label className="ops-field"><span>调用 Token</span><input type={reveal ? 'text' : 'password'} readOnly value={token} autoComplete="off" /></label><button className="ghost icon-button" aria-label={reveal ? '隐藏 Token' : '显示 Token'} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="ghost" disabled={!token} onClick={async () => { try { await copyNoteText(token); toast('Token 已复制'); } catch { toast('复制失败'); } }}><Copy size={14} />复制</button></div>
    <div className="webhook-tabs" role="tablist" aria-label="调用类型">{[['run', '触发执行'], ['status', '查询状态']].map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    <CodeCopy title={tab === 'run' ? 'POST 调用' : '执行状态查询'} value={command} toast={toast} />
    {tab === 'run' && task.allowGet ? <CodeCopy title="GET 兼容链接" value={token ? `${url}/run?token=${encodeURIComponent(token)}` : ''} toast={toast} /> : null}
    <p className="webhook-help">{task.guardId ? '关联动态守护：命令完成后继续等待并验证新 IP，流程结束前重复调用不会重复提交。' : '调用立即返回执行 ID。任务排队或执行期间，重复调用会返回同一条执行。'} 需要跨完成状态去重时，增加 -H 'Idempotency-Key: 自定义唯一标识'；同一操作重试沿用标识，新操作更换标识。</p>
    <p className="webhook-help">调用示例含凭证，请妥善保管。查询接口只返回状态，完整输出需要登录面板查看。</p>
    {error ? <p className="auth-error" role="alert">{error}</p> : null}
    {reset ? <div className="webhook-reset"><p>重置后原 Token 立即失效，已有调用方需要更新。</p><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setReset(false)}>取消</button><button className="primary danger-action" disabled={busy} onClick={async () => { if (lock.current) return; lock.current = true; setBusy(true); try { const result = await api(`/api/webhooks/${task.id}/token/reset`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); setToken(result.token); setReset(false); toast('Token 已重置'); onReset(); } catch (err) { setError(err.message); } finally { lock.current = false; setBusy(false); } }}>确认重置</button></div></div> : <button className="ghost danger-text-button" disabled={!token} onClick={() => setReset(true)}><RefreshCw size={14} />重置 Token</button>}
  </Dialog>;
}

function HistoryDialog({ task, api, toast, Dialog, onClose, onChange }) {
  const [kind, setKind] = useState('runs'), [data, setData] = useState(null), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [runId, setRunId] = useState(task.runId || ''), [run, setRun] = useState(null), [clear, setClear] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false), epoch = useRef(0);
  const live = useRef({ data, run }); live.current = { data, run };
  useEffect(() => {
    let stopped = false, stop;
    const start = () => {
      stop?.(); if (document.hidden || stopped) return;
      let active = true, due = 0, outputLoaded = false;
      const cleanup = startPolling(async (signal) => {
      if (lock.current || Date.now() < due) return;
      const version = epoch.current;
      const results = await Promise.allSettled([api(`/api/webhooks/history?kind=${kind}&taskId=${task.id || ''}&page=${page}`, { signal }), ...(runId && (!outputLoaded || ACTIVE.has(live.current.run?.status)) ? [api(`/api/webhooks/runs/${runId}`, { signal })] : [])]);
      if (!active || stopped || version !== epoch.current) return;
      if (results[0].status === 'fulfilled') { setData((old) => JSON.stringify(old) === JSON.stringify(results[0].value) ? old : results[0].value); setError(''); } else setError(results[0].reason.message);
      if (results[1]?.status === 'fulfilled') { outputLoaded = true; setRun((old) => JSON.stringify(old) === JSON.stringify(results[1].value) ? old : results[1].value); }
      else if (results[1]?.status === 'rejected') setError(results[1].reason.message);
      const running = ACTIVE.has(results[1]?.value?.status || live.current.run?.status) || results[0]?.value?.records.some((record) => ACTIVE.has(record.status));
      due = Date.now() + (running ? 3000 : 10000);
      }, 3000);
      stop = () => { active = false; cleanup(); };
    };
    start(); document.addEventListener('visibilitychange', start);
    return () => { stopped = true; stop?.(); document.removeEventListener('visibilitychange', start); };
  }, [api, task.id, kind, page, runId, refresh]);
  async function action(path, body) {
    if (lock.current) return; lock.current = true; epoch.current++; setBusy(true);
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setClear(false); toast('操作已完成'); onChange(); if (path.endsWith('/clear')) { setRunId(''); setRun(null); } }
    catch (err) { setError(err.message); }
    finally { lock.current = false; epoch.current++; setBusy(false); setRefresh((n) => n + 1); }
  }
  return <Dialog title={`${task.name} · 历史记录`} wide className="webhook-dialog webhook-history-dialog" onClose={() => !busy && onClose()}>
    <div className="webhook-history-toolbar"><div className="webhook-tabs" role="tablist" aria-label="历史类型">{[['runs', '执行记录'], ['calls', '调用记录']].map(([key, label]) => <button key={key} role="tab" aria-selected={kind === key} className={kind === key ? 'active' : ''} onClick={() => { setKind(key); setPage(1); setData(null); }}>{label}</button>)}</div><button className="ghost danger-text-button" disabled={busy || !data?.total} onClick={() => setClear(true)}><Trash2 size={14} />清理全部</button></div>
    <p className="webhook-help">记录保留 7 天。清理{task.id ? '此任务' : '全部任务'}的执行和调用记录时，正在处理的记录会保留。</p>
    {clear ? <div className="webhook-reset"><p>确认清理{task.id ? `「${task.name}」` : '所有任务'}的已结束记录？</p><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setClear(false)}>取消</button><button className="primary danger-action" disabled={busy} onClick={() => action('/api/webhooks/history/clear', { confirm: true, taskId: task.id })}>确认清理</button></div></div> : null}
    {error ? <p className="auth-error" role="alert">{error}</p> : null}
    <div className="webhook-history-list">{data?.records.map((record) => kind === 'calls' ? <article key={record.id}><div><strong>{record.source === 'webhook' ? '外部调用' : record.source === 'telegram' ? 'Telegram' : '面板调用'}</strong><small>{date(record.created)}</small></div><span>{record.duplicate ? '重复调用 · 已合并' : '已接受'}</span><button className="ghost" onClick={() => { setRun(null); setRunId(record.run_id); }}>执行详情</button></article> : <article key={record.id}><div><strong>{record.taskName}</strong><small>{date(record.created)} · {record.guardId ? '动态守护' : record.source === 'webhook' ? '外部调用' : record.source === 'telegram' ? 'Telegram' : '面板执行'}</small><span className="webhook-message">{record.message}</span></div><span className={`webhook-badge ${record.status}`}>{LABELS[record.status] || record.status}</span><button className="ghost" onClick={() => { setRun(null); setRunId(record.id); }}>查看输出</button></article>)}</div>
    {data && !data.records.length ? <div className="ops-empty"><History size={24} /><strong>暂无记录</strong></div> : null}
    {data?.pages > 1 ? <div className="webhook-pagination"><button className="ghost" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</button><span>{data.page} / {data.pages}</span><button className="ghost" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>下一页</button></div> : null}
    {runId ? <section className="webhook-output"><div><strong>执行输出{run ? ` · ${LABELS[run.status]}` : ''}</strong>{ACTIVE.has(run?.status) ? <button className="ghost danger-text-button" disabled={busy} onClick={() => action(`/api/webhooks/runs/${runId}/stop`, {})}><Square size={13} />停止{run.guardId ? '并停用守护' : ''}</button> : null}<button className="ghost" onClick={() => { setRunId(''); setRun(null); }}>收起</button></div><pre tabIndex={0}>{run ? run.output || '暂无输出' : '读取中…'}</pre>{run?.guardId ? <p className="webhook-help">命令结果：{LABELS[run.commandStatus] || '未执行'}；任务最终状态由新 IP 验证结果决定。</p> : null}</section> : null}
  </Dialog>;
}

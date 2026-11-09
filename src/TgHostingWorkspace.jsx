import { useEffect, useId, useRef, useState } from 'react';
import { MessagesSquare, Plus, Settings2, Maximize2, Minimize2, Moon, Play, LockKeyhole, Pencil, Trash2, RefreshCw, ShieldCheck, ClipboardPaste, CornerDownLeft, Expand, Save, Monitor, ChevronLeft, ChevronRight, ChevronDown, Check } from 'lucide-react';
import Dialog from './Dialog.jsx';
import { startPolling } from '../shared/polling.js';
import { openAuthenticatedWebSocket } from '../shared/websocket-client.js';
import { copyNoteText } from './note-clipboard.js';
import { TG_HOSTING_DEFAULTS, TG_HOSTING_STATES, TG_BROWSER_MIN_MEMORY_MB, tgViewRetryDelay } from '../shared/tg-hosting.js';
import './tg-hosting.css';

const EMPTY = { name: '', phone: '', group: '', note: '', mode: 'keep' };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未打开';
const storageSize = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes > 0 && bytes < 1024 ** 2 ? 1 : 0)} MB`;
const TG_SETUP_COMMAND = 'bash <(curl -fsSL https://raw.githubusercontent.com/inimemail/nurows/main/install.sh) tg-hosting';

export default function TgHostingWorkspace({ api, toast, search = '', onSearchScopeChange }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [page, setPage] = useState(1), [query, setQuery] = useState(''), [group, setGroup] = useState(''), [status, setStatus] = useState(''), [refresh, setRefresh] = useState(0);
  const [fullscreen, setFullscreen] = useState(false), [viewer, setViewer] = useState(null), [dialog, setDialog] = useState(null), [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [unlock, setUnlock] = useState(null), [password, setPassword] = useState('');
  const touchAt = useRef(0), session = useRef(null), alive = useRef(true), mutation = useRef(false), version = useRef(0), afterUnlock = useRef(null);
  const reset = () => setRefresh(value => value + 1);
  const lock = () => {
    const token = session.current?.token; session.current = null; version.current++;
    setUnlock(null); setViewer(null); setPassword(''); setDialog(null); afterUnlock.current = null;
    if (token) void api('/api/tg-hosting/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': token }, body: '{}' }).catch(() => {});
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; const token = session.current?.token; session.current = null; if (token) void api('/api/tg-hosting/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': token }, body: '{}' }).catch(() => {}); }; }, [api]);
  useEffect(() => { onSearchScopeChange?.({ tab: 'tgHosting', section: 'tgHosting' }); }, [onSearchScopeChange]);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let stop, disposed = false;
    const start = () => {
      stop?.(); if (document.hidden || disposed || viewer) return;
      stop = startPolling(async signal => {
        const result = await api(`/api/tg-hosting?${new URLSearchParams({ q: query, page, group, status })}`, { signal });
        if (!signal.aborted && !disposed) { setData(result); setError(''); }
      }, 5000, { onError: err => { if (!disposed) setError(err.message); } });
    };
    start(); document.addEventListener('visibilitychange', start);
    return () => { disposed = true; stop?.(); document.removeEventListener('visibilitychange', start); };
  }, [api, query, page, group, status, refresh, Boolean(viewer)]);
  useEffect(() => {
    const timer = setInterval(() => { if (session.current && (session.current.expiresAt <= Date.now() || session.current.deadline <= Date.now())) lock(); }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!fullscreen && !viewer) return;
    const before = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; };
  }, [fullscreen, viewer]);
  function secured(action) {
    if (session.current && session.current.expiresAt > Date.now() && session.current.deadline > Date.now()) { action(); return; }
    afterUnlock.current = action; setFormError(''); setPassword(''); setDialog({ type: 'unlock' });
  }
  async function mutate(endpoint, value = {}, method = 'POST', timeout = 20000) {
    if (mutation.current) throw Error('已有操作正在处理，请稍后重试');
    if (!session.current || session.current.expiresAt <= Date.now() || session.current.deadline <= Date.now()) { lock(); throw Error('请重新解锁 TG 托管'); }
    mutation.current = true; setBusy(true); setFormError('');
    try {
      const result = await api(`/api/tg-hosting${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': session.current.token }, body: JSON.stringify(value), signal: AbortSignal.timeout(timeout) });
      if (session.current) session.current.expiresAt = Math.min(session.current.deadline, Date.now() + 10 * 60000);
      return result;
    } catch (err) { if (alive.current) setFormError(err.message); throw err; }
    finally { mutation.current = false; if (alive.current) { setBusy(false); reset(); } }
  }
  async function unlockVault(event) {
    event.preventDefault(); if (mutation.current) return;
    mutation.current = true; setBusy(true); setFormError(''); const epoch = version.current;
    try {
      const result = await api('/api/tg-hosting/unlock', { method: 'POST', body: JSON.stringify({ password }), signal: AbortSignal.timeout(15000) });
      if (!alive.current || version.current !== epoch) { void api('/api/tg-hosting/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': result.token }, body: '{}' }).catch(() => {}); return; }
      session.current = result; setUnlock(result); setPassword(''); setDialog(null);
      const action = afterUnlock.current; afterUnlock.current = null; mutation.current = false; action?.();
    } catch (err) { if (alive.current) setFormError(err.message); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  async function openAccount(item) {
    if (!data?.component.connected) { openDialog({ type: 'setup' }); return; }
    try { if (item.runtime?.state !== 'running') await mutate(`/accounts/${item.id}/wake`); if (alive.current && session.current) setViewer(item); }
    catch (err) { toast(err.message); }
  }
  async function action(item, operation) {
    try { await mutate(`/accounts/${item.id}/${operation}`, {}, 'POST', operation === 'snapshot' ? 180000 : 20000); toast(operation === 'snapshot' ? '已安排保存快照，请留意账号状态' : operation === 'sleep' ? '已安排休眠，登录资料保留' : '已加入启动队列'); }
    catch (err) { toast(err.message); }
  }
  function closeViewer(sleep = false) {
    const item = viewer; setViewer(null); reset();
    if (item && (sleep || item.mode === 'sleep')) void action(item, 'sleep');
  }
  const openDialog = value => { setFormError(''); setDialog(value); };
  async function confirmDeleteAll() {
    try { const result = await mutate('/delete-selection'); if (session.current) openDialog({ type: 'deleteAll', ids: result.ids }); } catch (err) { toast(err.message); }
  }
  useEffect(() => { if (!fullscreen) return; const escape = event => { if (event.key === 'Escape' && !document.querySelector('.dialog-backdrop')) setFullscreen(false); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [fullscreen]);
  function touch() {
    if (!session.current) return; session.current.expiresAt = Math.min(session.current.deadline, Date.now() + 10 * 60000);
    if (Date.now() - touchAt.current < 20000) return; touchAt.current = Date.now();
    void api('/api/tg-hosting/touch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': session.current.token }, body: '{}' }).catch(() => {});
  }
  async function save(event) {
    event.preventDefault(); if (mutation.current) return;
    try {
      await mutate(dialog.type === 'settings' ? '/settings' : `/accounts${dialog.item.id ? `/${dialog.item.id}` : ''}`, dialog.item, (dialog.type === 'settings' || dialog.item.id) ? 'PUT' : 'POST');
      setDialog(dialog.type === 'edit' && !data?.component.connected ? { type: 'setup' } : null);
      toast(dialog.type === 'edit' && !data?.component.connected ? '账号信息已保存，启用浏览器组件后即可扫码登录' : '已保存');
    }
    catch {}
  }
  const patch = fields => setDialog(value => ({ ...value, item: { ...value.item, ...fields } }));
  const summary = data?.summary || {};
  return <section className={`ops-workspace tg-hosting-workspace ${fullscreen ? 'tg-hosting-fullscreen' : ''}`}>
    <header className="surface ops-header"><div><span className="ops-eyebrow">官方网页 · 独立会话</span><strong>TG 托管</strong></div><div className="tg-heading-tools"><span className={`tg-lock-state ${unlock ? 'open' : ''}`}><ShieldCheck size={15} />{unlock ? '已解锁' : '会话保护中'}</span>{unlock ? <button className="ghost icon-button" aria-label="锁定 TG 托管" onClick={lock}><LockKeyhole size={17} /></button> : null}<button className="ghost icon-button" title={fullscreen ? '退出全屏' : '全屏工作区'} aria-label={fullscreen ? '退出托管全屏' : '全屏托管工作区'} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button></div></header>
    <div className="surface tg-account-panel">
      <div className="tg-account-toolbar"><div className="tg-summary"><span><b>{summary.total || 0}</b>全部账号</span><span className="running"><b>{summary.running || 0}</b>后台保持</span><span><b>{summary.sleeping || 0}</b>休眠</span>{summary.queued ? <span><b>{summary.queued}</b>排队</span> : null}</div><div className="tg-toolbar-buttons"><button className="ghost icon-button" aria-label="刷新托管列表" onClick={reset}><RefreshCw size={16} /></button><button className="ghost" onClick={() => secured(() => openDialog({ type: 'settings', item: { ...(data?.settings || TG_HOSTING_DEFAULTS) } }))}><Settings2 size={15} />设置</button><button className="primary" onClick={() => secured(() => openDialog({ type: 'edit', item: { ...EMPTY } }))}><Plus size={16} />添加账号</button></div></div>
      <div className="tg-filter-row"><div><select aria-label="托管分组" value={group} onChange={e => { setGroup(e.target.value); setPage(1); }}><option value="">全部分组</option>{data?.groups.map(value => <option key={value}>{value}</option>)}</select><select aria-label="运行状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{['running', 'stopped', 'queued', 'error'].map(value => <option value={value} key={value}>{TG_HOSTING_STATES[value]}</option>)}</select></div><button className="ghost danger-text-button" disabled={!summary.total || busy || data?.deletion?.running} onClick={() => secured(() => void confirmDeleteAll())}><Trash2 size={14} />全部删除</button></div>
      {data && !data.component.connected ? <div className="tg-component-notice tg-setup-notice"><Monitor size={20} /><div><strong>{data.component.enabled ? '浏览器组件连接异常' : '还差一步：启用扫码登录组件'}</strong><p>{data.component.enabled ? data.component.error : '账号信息已保留。在部署面板的服务器上运行管理脚本，选择 11）TG 托管组件，完成后刷新即可扫码。'}</p></div><button className="ghost" onClick={() => openDialog({ type: 'setup' })}>{data.component.enabled ? '查看处理方法' : '如何启用'}</button></div> : null}
      {data?.component.migrationHold ? <div className="tg-component-notice tg-migration-notice"><ShieldCheck size={20} /><div><strong>会话已恢复，等待接管</strong><p>登录资料已保留。请先停止旧机器上的 TG 托管，再在这里接管，避免两台机器同时使用同一份会话。</p><button className="ghost" disabled={busy || !data.component.connected} onClick={() => secured(() => openDialog({ type: 'migration', acknowledged: false }))}>确认并接管会话</button></div></div> : null}
      {data?.component.connected && !data.component.migrationHold ? <div className="tg-resource-status">运行 <b>{summary.running || 0} / {data.settings.maxRunning}</b></div> : null}
      {data?.component.resources?.diskLow ? <div className="tg-deletion-progress failed" role="status">{data.component.resources.error ? '暂时无法读取服务器资源，已暂停新账号启动。' : '磁盘空间不足，已暂停新账号启动。现有登录资料保留，请清理服务器磁盘。'}</div> : null}
      {data?.deletion ? <div className={`tg-deletion-progress ${data.deletion.error ? 'failed' : ''}`} role="status">{data.deletion.running ? '正在删除托管资料' : data.deletion.error ? '删除未完成' : '托管资料删除完成'} · {data.deletion.completed}/{data.deletion.total}{data.deletion.error ? ` · ${data.deletion.error}` : ''}</div> : null}
      {error ? <div className="note-error" role="alert">{error}</div> : null}
      {!data ? <div className="ops-empty">正在读取托管账号…</div> : !data.accounts.length ? <div className="tg-empty"><span><MessagesSquare size={32} /></span><h3>{summary.total ? '没有匹配的账号' : '把常用账号留在这里'}</h3><p>{summary.total ? '调整搜索或筛选条件后再试' : '独立登录、集中打开；关闭窗口后默认继续后台保持。'}</p>{!summary.total ? <button className="primary" onClick={() => secured(() => openDialog({ type: 'edit', item: { ...EMPTY } }))}><Plus size={16} />添加账号</button> : null}</div> : <div className="tg-account-list">{data.accounts.map(item => <article className="tg-account-row" key={item.id}>
        <div className="tg-account-identity"><span className="tg-avatar"><MessagesSquare size={21} /></span><div><strong>{item.name}</strong><span>{item.group || '未分组'}{item.phone ? ` · ${item.phone.replace(/.(?=.{4})/g, '•')}` : ''}</span>{item.note ? <small title={item.note}>{item.note}</small> : null}</div></div>
        <div className="tg-account-status"><span className={`tg-state ${item.runtime.state}`}>{TG_HOSTING_STATES[item.runtime.state] || '待确认'}</span><small>{item.mode === 'keep' ? '关闭窗口继续保持' : '关闭窗口后休眠'}{item.runtime.state === 'running' && item.runtime.memoryMb ? ` · 限额 ${item.runtime.memoryMb} MB` : ''}</small><div className={`tg-account-storage ${item.runtime.storageBlocked ? 'full' : Number(item.runtime.storageBytes) >= (data.settings.storageGb || 5) * 1024 ** 3 * .85 ? 'near' : ''}`} title={`账号运行数据，不含快照和脚本备份。${item.runtime.storageCheckedAt ? `最近统计：${date(item.runtime.storageCheckedAt)}` : '后台分批统计中'}`}><span>存储 <b>{Number.isFinite(item.runtime.storageBytes) ? storageSize(item.runtime.storageBytes) : '待统计'} / {data.settings.storageGb || 5} GB</b></span>{item.runtime.storageMaintaining ? <span>清理缓存中</span> : item.runtime.snapshotBytes > 0 ? <span>快照 {storageSize(item.runtime.snapshotBytes)}</span> : null}</div>{item.runtime.error || item.runtime.snapshotError || item.runtime.storageError ? <em>{item.runtime.error || (item.runtime.snapshotError ? `快照未更新：${item.runtime.snapshotError}` : item.runtime.storageError)}</em> : null}</div>
        <div className="tg-account-time"><span>最近打开</span><time>{date(item.lastOpenedAt)}</time></div>
        <div className="tg-row-actions"><button className="ghost tg-open-account" disabled={busy || item.runtime.storageMaintaining || data.component.backupBusy || data.component.migrationHold} onClick={() => data.component.connected ? secured(() => void openAccount(item)) : openDialog({ type: 'setup' })}><Play size={14} />{!data.component.connected ? '启用后登录' : item.runtime.state === 'running' ? '进入' : '打开'}</button><button className="ghost icon-button" title="编辑账号" aria-label={`编辑 ${item.name}`} disabled={busy} onClick={() => secured(() => openDialog({ type: 'edit', item: { ...item } }))}><Pencil size={15} /></button><details className="tg-row-more" onToggle={event => { const menu = event.currentTarget; if (menu.open) requestAnimationFrame(() => { if (menu.isConnected && menu.open) menu.querySelector('div')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }); }}><summary aria-label={`${item.name} 的更多操作`}>•••</summary><div onClick={e => { if (e.target.closest('button')) e.currentTarget.closest('details').open = false; }}><button disabled={busy || !data.component.connected} onClick={() => secured(() => void action(item, 'sleep'))}><Moon size={14} />休眠账号</button><button disabled={busy || !data.component.connected} onClick={() => secured(() => openDialog({ type: 'snapshot', item }))}><Save size={14} />保存会话快照</button><button className="danger-text-button" disabled={busy} onClick={() => secured(() => openDialog({ type: 'delete', item }))}><Trash2 size={14} />删除账号</button></div></details></div>
      </article>)}</div>}
      {data?.pages > 1 ? <div className="tg-pagination"><span>共 {data.total} 个 · {data.page}/{data.pages}</span><div><button className="ghost icon-button" aria-label="上一页" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}><ChevronLeft size={16} /></button><button className="ghost icon-button" aria-label="下一页" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}><ChevronRight size={16} /></button></div></div> : null}
      <footer className="tg-footnote"><ShieldCheck size={13} /><span>会话保存在服务器；登录状态以官方网页为准。关闭画面不退出账号，官方撤销的登录仍需重新验证。</span></footer>
    </div>
    {dialog?.type === 'setup' ? <Dialog title={data?.component.enabled ? '恢复浏览器组件连接' : '启用扫码登录组件'} className="tg-edit-dialog" onClose={() => setDialog(null)} footer={<div className="dialog-actions"><button className="ghost" onClick={() => setDialog(null)}>稍后处理</button><button className="primary" onClick={() => { reset(); setDialog(null); }}>已完成，刷新状态</button></div>}><div className="tg-form tg-setup-guide"><p className="tg-dialog-description">账号名称、分组只是管理信息。扫码页面由服务器上的独立浏览器提供，需要首次启用组件；现有账号无需重新创建。</p><ol><li>在部署当前面板的服务器上打开终端，以 root 运行管理脚本。</li><li>选择 <strong>11）TG 托管组件</strong>，等待镜像构建和组件连接检查完成。</li><li>回到这里刷新状态，点击账号的「打开」，用手机 Telegram 扫码。</li></ol><div className="tg-setup-command"><code>{TG_SETUP_COMMAND}</code><button type="button" className="ghost" onClick={() => void copyNoteText(TG_SETUP_COMMAND).then(() => toast('启用命令已复制，请在面板所在服务器执行')).catch(error => toast(error.message))}>复制启用命令</button></div><p className="tg-dialog-description">上面的命令直接启用组件，无需再次选择菜单。首次会下载浏览器镜像，请预留内存和磁盘空间。</p>{data?.component.enabled ? <p className="tg-dialog-description">若已安装仍连接失败，可重新运行此命令修复组件，并保留输出中的具体错误；账号资料不会因此清空。</p> : null}</div></Dialog> : null}
    {dialog?.type === 'migration' ? <Dialog title="接管已恢复的会话" className="tg-edit-dialog" onClose={() => !busy && setDialog(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setDialog(null)}>暂不接管</button><button className="primary" disabled={busy || !dialog.acknowledged} onClick={async () => { try { await mutate('/activate-migration', { confirm: 'old-host-stopped' }, 'POST', 40000); setDialog(null); toast('已接管，后台保持账号将按资源顺序启动'); } catch (err) { setFormError(err.message); } }}>{busy ? '接管中…' : '确认接管'}</button></div>}><div className="tg-form"><p className="tg-dialog-description">恢复的登录资料可以继续使用。为避免登录冲突，旧机器上的相同会话必须先停止。接管后按资源限额逐个恢复，不会一次启动所有账号。</p><label className="tg-migration-confirm"><input type="checkbox" checked={dialog.acknowledged} onChange={event => setDialog(value => ({ ...value, acknowledged: event.target.checked }))} /><span>我已停止旧机器上的 TG 托管</span></label>{formError ? <p className="auth-error" role="alert">{formError}</p> : null}</div></Dialog> : null}
    {dialog?.type === 'unlock' ? <Dialog title="解锁 TG 托管" className="tg-edit-dialog" onClose={() => { version.current++; setDialog(null); setPassword(''); }} footer={<div className="dialog-actions"><button className="ghost" onClick={() => { version.current++; setDialog(null); }}>取消</button><button className="primary" form="tg-unlock" type="submit" disabled={busy}>{busy ? '验证中…' : '解锁'}</button></div>}><form id="tg-unlock" className="tg-form" onSubmit={unlockVault}><p className="tg-dialog-description">验证面板密码后，才能打开和操作服务器上的 Telegram 会话。</p><label className="ops-field"><span>面板密码</span><input type="password" value={password} required maxLength={1024} autoComplete="current-password" onChange={e => setPassword(e.target.value)} /></label>{formError ? <p className="auth-error" role="alert">{formError}</p> : null}</form></Dialog> : null}
    {dialog?.type === 'edit' ? <Dialog title={dialog.item.id ? '编辑托管账号' : '添加托管账号'} className="tg-edit-dialog" onClose={() => !busy && setDialog(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="primary" form="tg-account-edit" type="submit" disabled={busy}>{busy ? '保存中…' : '保存账号'}</button></div>}><form className="tg-form" id="tg-account-edit" onSubmit={save}><p className="tg-account-hint"><ShieldCheck size={15} /><span>保存后点「打开」，使用手机 Telegram 扫码登录。</span></p><label className="ops-field"><span>账号名称 *</span><input required maxLength={100} placeholder="例如：工作账号" value={dialog.item.name} onChange={e => patch({ name: e.target.value })} /></label><div className="tg-form-grid"><label className="ops-field"><span>手机号备注（选填）</span><input type="tel" maxLength={40} placeholder="仅用于查找和备注" value={dialog.item.phone} onChange={e => patch({ phone: e.target.value })} /></label><TgGroupPicker value={dialog.item.group} groups={data?.groups || []} onChange={group => patch({ group })} /></div><fieldset className="tg-mode-options"><legend>关闭窗口后</legend>{[['keep', '后台保持', '继续接收消息'], ['sleep', '自动休眠', '释放资源，保留登录']].map(([mode, title, text]) => <label key={mode} className={dialog.item.mode === mode ? 'selected' : ''}><input type="radio" name="tg-mode" value={mode} checked={dialog.item.mode === mode} onChange={() => patch({ mode })} /><span><strong>{title}</strong><small>{text}</small></span></label>)}</fieldset><label className="ops-field"><span>备注</span><textarea rows={2} maxLength={500} value={dialog.item.note} onChange={e => patch({ note: e.target.value })} /></label>{formError ? <p className="auth-error" role="alert">{formError}</p> : null}</form></Dialog> : null}
    {dialog?.type === 'settings' ? <Dialog title="托管运行设置" className="tg-edit-dialog" onClose={() => !busy && setDialog(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="primary" form="tg-settings" type="submit" disabled={busy}>保存设置</button></div>}>
      <form id="tg-settings" className="tg-form" onSubmit={save}>
        <p className="tg-dialog-description">内存上限下次启动生效；CPU 上限在线调整，无需重启浏览器。存储上限对全部账号生效。</p>
        <label className="ops-field"><span>同时运行账号数</span><input required type="number" min={1} max={50} value={dialog.item.maxRunning} onChange={e => patch({ maxRunning: Number(e.target.value) })} /></label>
        <div className="tg-form-grid">
          <label className="ops-field"><span>单账号内存上限（MB）</span><input required type="number" min={TG_BROWSER_MIN_MEMORY_MB} max={8192} step={128} value={dialog.item.memoryMb} onChange={e => patch({ memoryMb: Number(e.target.value) })} /></label>
          <label className="ops-field"><span>单账号 CPU 上限（核）</span><input required type="number" min={0.25} max={4} step={0.25} value={dialog.item.cpu} onChange={e => patch({ cpu: Number(e.target.value) })} /></label>
        </div>
        <details className="tg-cpu-settings">
          <summary><span>高级 CPU 保护<small>所有账号共享整体额度</small></span><ChevronDown size={16} /></summary>
          <div>
            <div className="tg-form-grid">
              <label className="ops-field"><span>整体 CPU 分配</span><select value={dialog.item.cpuTotal !== 0 && dialog.item.cpuTotal != null ? 'custom' : 'auto'} onChange={e => patch({ cpuTotal: e.target.value === 'auto' ? 0 : Math.min(256, Math.max(.25, Math.floor((data?.component.resources?.totalCpus || 4) * .75 * 4) / 4)) })}><option value="auto">自动 · 服务器 CPU 的 75%</option><option value="custom">自定义整体上限</option></select></label>
              {dialog.item.cpuTotal !== 0 && dialog.item.cpuTotal != null ? <label className="ops-field"><span>整体 CPU 上限（核）</span><input required type="number" min={.25} max={256} step={.25} value={dialog.item.cpuTotal} onChange={e => patch({ cpuTotal: e.target.value === '' ? '' : Number(e.target.value) })} /></label> : null}
            </div>
            <p className="tg-dialog-description">单账号可用到自己的上限，空闲额度由其他账号共享，不按数量均分。整体上限不超过服务器核数；旧运行账号在下次正常休眠并打开后加入共享分组。</p>
            {data?.component.resources?.cpuBudget?.error || data?.component.resources?.cpuBudget?.legacyAccounts ? <p className="tg-dialog-description tg-cpu-details">{data.component.resources.cpuBudget.error || `${data.component.resources.cpuBudget.legacyAccounts} 个旧运行账号将在下次正常休眠并打开后加入共享分组。`}</p> : null}
          </div>
        </details>
        <label className="ops-field"><span>单账号存储上限（GB）</span><input required type="number" min={1} max={20} step={1} value={dialog.item.storageGb ?? 5} onChange={e => patch({ storageGb: Number(e.target.value) })} /></label>
        <p className="tg-dialog-description">默认每账号 5 GB，可设 1–20 GB。每天错峰清理可重建缓存，正在查看时顺延；超限时优先清理，仍超限则暂停并保留登录资料。快照和备份另占空间。</p>
        {formError ? <p className="auth-error" role="alert">{formError}</p> : null}
      </form>
    </Dialog> : null}
    {['delete', 'deleteAll', 'snapshot'].includes(dialog?.type) ? <Dialog title={dialog.type === 'snapshot' ? '保存完整会话快照' : dialog.type === 'deleteAll' ? '确认删除全部托管账号' : '确认删除托管账号'} onClose={() => !busy && setDialog(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className={`primary ${dialog.type !== 'snapshot' ? 'danger-action' : ''}`} disabled={busy} onClick={async () => {
      try {
        if (dialog.type === 'snapshot') await mutate(`/accounts/${dialog.item.id}/snapshot`, {}, 'POST', 180000);
        else {
          const ids = dialog.type === 'deleteAll' ? dialog.ids : [dialog.item.id];
          await mutate('/delete', { ids, confirm: 'delete-tg-hosting' }, 'POST', 180000);
        }
        setDialog(null); toast(dialog.type === 'snapshot' ? '已安排保存会话快照' : '已安排删除，请留意列表进度');
      } catch (err) { setFormError(err.message); }
    }}>{busy ? '处理中…' : dialog.type === 'snapshot' ? '确认保存' : '确认删除'}</button></div>}><div className="confirm-copy">{dialog.type === 'snapshot' ? <p>保存「{dialog.item.name}」的完整登录配置。浏览器会短暂关闭；后台保持账号随后重新启动，不调用 Telegram 退出登录。</p> : <><p>{dialog.type === 'deleteAll' ? `将删除已确认的 ${dialog.ids.length} 个托管账号的本地配置和快照。` : `将删除「${dialog.item.name}」的本地配置和快照。`}</p><p>此操作不可撤销。本地删除不等于在 Telegram 撤销设备；需要时请在官方客户端结束对应会话。</p></>}{formError ? <p className="auth-error" role="alert">{formError}</p> : null}</div></Dialog> : null}
    {viewer && unlock ? <TgViewer item={viewer} api={api} token={unlock.token} onClose={closeViewer} onTouch={touch} toast={toast} /> : null}
  </section>;
}


function TgGroupPicker({ value, groups, onChange }) {
  const id = useId(), input = useRef(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1), [searching, setSearching] = useState(false);
  const query = value.trim(), matches = groups.filter(group => !searching || group.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 50);
  const options = [
    ...(!searching || !query ? [{ value: '', label: '未分组' }] : []),
    ...matches.map(group => ({ value: group, label: group })),
    ...(query && !groups.includes(query) ? [{ value: query, label: `新建分组「${query}」` }] : [])
  ];
  const choose = group => { onChange(group); setOpen(false); setActive(-1); };
  const keydown = event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); setOpen(true);
      const next = event.key === 'ArrowDown' ? Math.min(active + 1, options.length - 1) : Math.max(active - 1, 0);
      setActive(next); document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && open) { event.preventDefault(); choose(options[active]?.value ?? query); }
  };
  return <div className="ops-field tg-group-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label htmlFor={id}>分组（选填）</label>
    <div className="tg-group-input"><input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list" aria-activedescendant={open && options[active] ? `${id}-option-${active}` : undefined} autoComplete="off" maxLength={60} placeholder="选择或输入新分组" value={value} onFocus={() => { setOpen(true); setSearching(false); setActive(-1); }} onChange={event => { onChange(event.target.value); setOpen(true); setSearching(true); setActive(-1); }} onClick={() => setOpen(true)} onKeyDownCapture={keydown} /><button type="button" aria-label={open ? '收起分组列表' : '选择分组'} aria-expanded={open} onClick={() => { const next = !open; input.current?.focus(); setOpen(next); setActive(-1); }}><ChevronDown size={16} /></button></div>
    {open ? <div className="tg-group-options" id={`${id}-options`} role="listbox" aria-label="可选分组">{options.map((option, index) => <button key={option.value} type="button" id={`${id}-option-${index}`} role="option" aria-selected={value === option.value} className={index === active ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}><span>{option.label}</span>{value === option.value ? <Check size={14} /> : null}</button>)}</div> : null}
  </div>;
}

function TgViewer({ item, api, token, onClose, onTouch, toast }) {
  const target = useRef(null), rfb = useRef(null), [expanded, setExpanded] = useState(false), [attempt, setAttempt] = useState(0), [state, setState] = useState('waiting'), [message, setMessage] = useState(''), [text, setText] = useState(''), [clipboard, setClipboard] = useState(''), [showInput, setShowInput] = useState(false), [scale, setScale] = useState(true);
  const [runtime, setRuntime] = useState({ state: 'queued' });
  const retryCount = useRef(0), scaleChoice = useRef(scale);
  scaleChoice.current = scale;
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  useEffect(() => {
    if (!visible) return;
    return startPolling(async signal => { const result = await api(`/api/tg-hosting/accounts/${item.id}`, { headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': token }, signal }); if (!signal.aborted) setRuntime(result.runtime); }, 3000, { onError: err => setMessage(err.message) });
  }, [api, item.id, token, visible]);
  useEffect(() => {
    if (!visible) { setState('waiting'); setMessage('页面在后台，画面传输已暂停；账号登录资料保留。'); return; }
    if (runtime?.state && runtime.state !== 'running') {
      setState(['error', 'stopped', 'unavailable'].includes(runtime.state) ? 'disconnected' : 'waiting');
      setMessage(runtime.error || (runtime.state === 'queued' ? '账号正在排队；名额或资源不足时等待，可稍后再进入。' : runtime.state === 'stopped' ? '账号已休眠，登录资料保留；点击重连重新启动。' : runtime.state === 'unavailable' ? '托管组件暂未连接，恢复后可重新连接。' : '正在准备独立浏览器，请稍候…'));
    }
  }, [visible, runtime?.state, runtime?.error]);
  useEffect(() => {
    if (!visible || runtime?.state !== 'running') return;
    let disposed = false, connection;
    const controller = new AbortController();
    setState('connecting'); setMessage('正在建立安全画面连接…');
    void (async () => {
      try {
        const [module, proof] = await Promise.all([import('./tg-viewer-rfb.js'), api('/api/tg-hosting/view', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': token }, body: JSON.stringify({ id: item.id }), signal: controller.signal })]);
        if (disposed) return;
        const socketUrl = new URL(`/ws/tg-hosting?id=${encodeURIComponent(item.id)}`, location.href); socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        connection = await openAuthenticatedWebSocket(socketUrl.href, { signal: controller.signal, protocols: [proof.protocol] });
        if (disposed) { connection.close(); return; }
        const RFB = module.default?.default || module.default || module.RFB || module.r;
        if (typeof RFB !== 'function') throw Error('画面组件加载失败，请刷新页面后重试');
        const instance = new RFB(target.current, connection, { shared: true });
        rfb.current = instance; instance.scaleViewport = scaleChoice.current; instance.resizeSession = true; instance.qualityLevel = 5; instance.compressionLevel = 2;
        instance.addEventListener('connect', () => { if (!disposed) { setState('connected'); setMessage(''); } });
        instance.addEventListener('disconnect', () => { if (!disposed) { setState('disconnected'); setMessage('画面已断开；后台保持账号不会因此退出，请重新连接。'); } });
        instance.addEventListener('securityfailure', () => { if (!disposed) { setState('disconnected'); setMessage('安全画面连接失败，请重新解锁后重试'); } });
        instance.addEventListener('clipboard', event => { if (!disposed) setClipboard(event.detail.text); });
      } catch (error) { if (!disposed && !controller.signal.aborted) { setState('disconnected'); setMessage(error.message); } }
    })();
    return () => { disposed = true; controller.abort(); rfb.current?.disconnect(); rfb.current = null; connection?.close(); };
  }, [item.id, token, api, attempt, runtime?.state, visible]);
  useEffect(() => { if (rfb.current) rfb.current.scaleViewport = scale; }, [scale]);
  useEffect(() => {
    if (state !== 'connected') return;
    const timer = setTimeout(() => { retryCount.current = 0; }, 30000);
    return () => clearTimeout(timer);
  }, [state]);
  const retryDelay = state === 'disconnected' && runtime?.state === 'running' ? tgViewRetryDelay(retryCount.current + 1) : null;
  useEffect(() => {
    if (!visible || retryDelay === null) return;
    // Reconnect the picture only. Do not wake/restart Chromium, refresh the
    // Telegram page, prolong the unlock grant, or send any Telegram action.
    const timer = setTimeout(() => { retryCount.current++; setAttempt(value => value + 1); }, retryDelay);
    return () => clearTimeout(timer);
  }, [state, runtime?.state, retryDelay, visible]);
  async function reconnect() {
    try {
      retryCount.current = 0;
      if (['error', 'stopped'].includes(runtime?.state)) {
        await api(`/api/tg-hosting/accounts/${item.id}/wake`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TG-Hosting-Unlock': token }, body: '{}', signal: AbortSignal.timeout(20000) });
        setRuntime({ state: 'queued' });
      }
      onTouch(); setAttempt(value => value + 1);
    } catch (error) { setMessage(error.message); toast(error.message); }
  }
  function insert(value) {
    if (!rfb.current || state !== 'connected' || !value) return;
    rfb.current.clipboardPasteFrom(value); rfb.current.sendKey(0xffe3, 'ControlLeft', true); rfb.current.sendKey(0x76, 'KeyV'); rfb.current.sendKey(0xffe3, 'ControlLeft', false); onTouch(); setText('');
  }
  return <Dialog title={item.name} className={`tg-viewer-dialog ${expanded ? 'tg-viewer-fullscreen' : ''}`} xwide onClose={() => onClose(false)} headerActions={<div className="tg-viewer-tools"><div><button className="ghost" onClick={() => void reconnect()}><RefreshCw size={15} />重连</button><button className="ghost" aria-label="切换画面缩放" title={scale ? '当前适应窗口，点击切换原始尺寸' : '当前原始尺寸，点击适应窗口'} aria-pressed={scale} onClick={() => setScale(value => !value)}><Expand size={15} />{scale ? '适应窗口' : '原始尺寸'}</button></div><div><button className={`ghost ${showInput ? 'active' : ''}`} aria-expanded={showInput} aria-controls="tg-viewer-input" disabled={state !== 'connected'} onClick={() => setShowInput(value => !value)}><ClipboardPaste size={15} />输入与粘贴</button><button className="ghost icon-button" aria-label={expanded ? '退出会话全屏' : '全屏会话'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button></div></div>} footer={<div className="tg-viewer-footer"><span><i className={state === 'connected' ? 'connected' : ''} />{state === 'connected' ? '已连接' : '未连接'} · {item.mode === 'keep' ? '后台保持' : '关闭后休眠'}</span><button className="ghost" onClick={() => onClose(true)}><Moon size={14} />休眠并关闭</button></div>}>

    <div className="tg-remote-screen" onPointerDown={onTouch} onKeyDown={onTouch}><div ref={target} className="tg-vnc-target" />{state !== 'connected' ? <div className="tg-viewer-cover"><Monitor size={30} /><strong>{state === 'waiting' ? '准备账号会话' : state === 'connecting' ? '正在连接官方网页' : runtime?.state === 'error' ? '账号暂未启动' : '连接已断开'}</strong><p>{message}{retryDelay !== null && visible ? ` ${retryDelay / 1000} 秒后自动重连画面。` : ''}</p>{state === 'disconnected' ? <button className="primary" onClick={() => void reconnect()}>重新连接</button> : null}</div> : null}</div>
    {showInput ? <div className="tg-remote-input" id="tg-viewer-input"><textarea aria-label="写入远程页面的文字" rows={2} value={text} maxLength={32768} onChange={e => setText(e.target.value)} placeholder="在这里输入中文或粘贴文字，再写入远程页面当前输入框" /><div><button className="ghost" disabled={!clipboard} onClick={() => void copyNoteText(clipboard).then(() => toast('远程文字已复制')).catch(error => toast(error.message))}>复制选中文字</button><span /><button className="ghost" disabled={state !== 'connected'} onClick={() => { rfb.current?.sendKey(0xff0d, 'Enter'); onTouch(); }}><CornerDownLeft size={14} />回车</button><button className="primary" disabled={!text || state !== 'connected'} onClick={() => insert(text)}>写入文字</button></div></div> : null}
  </Dialog>;
}

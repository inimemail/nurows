import { useEffect, useMemo, useRef, useState } from 'react';
import { Wallet, Plus, RefreshCw, Trash2, Pencil, Copy, ArrowUpRight, ReceiptText, Landmark, ShieldCheck, CheckCircle2, CirclePause, AlertCircle, Eye, EyeOff, ChevronLeft, ChevronRight } from 'lucide-react';
import { startPolling } from '../shared/polling.js';
import { EPAY_CURRENCIES, EPAY_CHANNELS, EPAY_STATUSES, epayMoney } from '../shared/epay.js';
import { RenewalBotPicker } from './RenewalWorkspace.jsx';
import { copyNoteText } from './note-clipboard.js';
import './epay.css';

const EMPTY = { name: '', url: '', pid: '', key: '', currency: 'CNY', interval: 30, enabled: true, botIds: [], note: '' };
const TABS = [['overview', '收款总览'], ['orders', '订单记录'], ['accounts', '商户账号']];
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, dateStyle: 'short', timeStyle: 'medium' });
const date = value => value ? dateFormatter.format(new Date(value)) : '尚未同步';
const status = item => !item.enabled ? ['paused', '已暂停', CirclePause] : item.syncing ? ['syncing', '同步中', RefreshCw]
  : item.lastError ? ['error', '同步异常', AlertCircle] : item.initialized ? ['online', '监听中', CheckCircle2] : ['syncing', '等待首次同步', RefreshCw];

export default function EpayWorkspace({ api, toast, Dialog, search = '', onSearchScopeChange }) {
  const [tab, setTab] = useState('overview'), [data, setData] = useState(null), [error, setError] = useState('');
  const [accountId, setAccountId] = useState(''), [orderStatus, setOrderStatus] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [query, setQuery] = useState(search), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState(null), [deletion, setDeletion] = useState(null), [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false), [testing, setTesting] = useState(false), [formError, setFormError] = useState(''), [testResult, setTestResult] = useState(null), [showKey, setShowKey] = useState(false);
  const lock = useRef(false), generation = useRef(0), mounted = useRef(true), testEpoch = useRef(0), connectionTest = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; testEpoch.current++; connectionTest.current?.abort(); }; }, []);
  useEffect(() => { onSearchScopeChange?.({ tab: 'epay', section: tab === 'accounts' ? 'epayAccounts' : 'epay' }); }, [tab, onSearchScopeChange]);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let stop, cancelled = false;
    const start = () => {
      stop?.(); if (document.hidden || cancelled) return;
      stop = startPolling(async signal => {
        if (lock.current) return;
        const version = generation.current;
        // The account list does not render orders. Tell the server so it can
        // skip the count and page query instead of scanning a growing ledger
        // on every 10-second status refresh.
        const params = new URLSearchParams({ view: tab, accountId, status: tab === 'orders' ? orderStatus : '', from: tab === 'orders' ? from : '', to: tab === 'orders' ? to : '', page: tab === 'orders' ? page : 1, search: tab === 'accounts' ? '' : query });
        try {
          const result = await api(`/api/epay?${params}`, { signal });
          if (!cancelled && version === generation.current && !signal.aborted) { setData(result); setError(''); }
        } catch (err) { if (!cancelled && version === generation.current && (!signal.aborted || signal.reason?.name === 'TimeoutError')) setError(signal.aborted ? '读取超时，请稍后刷新重试' : err.message); }
      }, 10000);
    };
    start(); document.addEventListener('visibilitychange', start);
    return () => { cancelled = true; stop?.(); document.removeEventListener('visibilitychange', start); };
  }, [api, accountId, orderStatus, from, to, page, query, tab, refresh]);
  const accounts = data?.accounts || [], selected = accounts.find(item => item.id === accountId);
  const names = useMemo(() => new Map(accounts.map(item => [item.id, item])), [data?.accounts]);
  const accountTotals = useMemo(() => new Map((data?.totals || []).map(item => [item.accountId, item])), [data?.totals]);
  const filtered = useMemo(() => accounts.filter(item => !query || [item.name, item.url, item.pid, item.note].some(value => String(value || '').toLowerCase().includes(query.toLowerCase()))), [data?.accounts, query]);
  const openEditor = item => {
    cancelTest(); setEditor(item ? { ...item, key: '', botIds: item.botIds.filter(id => data?.bots.some(bot => bot.id === id)) } : { ...EMPTY, botIds: [] });
    setShowKey(false); setFormError(''); setTestResult(null);
  };
  function cancelTest() { testEpoch.current++; connectionTest.current?.abort(); connectionTest.current = null; setTesting(false); }
  const closeEditor = () => { if (!lock.current) { cancelTest(); setEditor(null); } };
  const patch = value => { cancelTest(); setEditor(current => ({ ...current, ...value })); setTestResult(null); };
  async function mutate(path, body, method = 'POST') {
    if (lock.current) return;
    lock.current = true; generation.current++; setBusy(true); setFormError('');
    const signal = AbortSignal.timeout(15000);
    try { return await api(path, { method, body: JSON.stringify(body), signal }); }
    catch (err) { if (signal.aborted) throw new Error('操作请求超时，请刷新确认结果后再操作'); throw err; }
    finally { lock.current = false; generation.current++; if (mounted.current) { setBusy(false); setRefresh(value => value + 1); } }
  }
  async function save() {
    if (!editor || lock.current || connectionTest.current) return;
    try {
      const result = await mutate(`/api/epay/accounts${editor.id ? `/${encodeURIComponent(editor.id)}` : ''}`, editor, editor.id ? 'PUT' : 'POST');
      if (!result || !mounted.current) return;
      setEditor(null); toast('商户已保存，后台将按设置同步订单');
    } catch (err) { if (mounted.current) setFormError(err.message); }
  }
  async function testConnection() {
    if (!editor || connectionTest.current || lock.current) return;
    const controller = new AbortController(); connectionTest.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const epoch = ++testEpoch.current; setTesting(true); setFormError(''); setTestResult(null);
    try {
      const result = await api('/api/epay/test', { method: 'POST', body: JSON.stringify(editor), signal });
      if (mounted.current && epoch === testEpoch.current) setTestResult(result);
    } catch (err) { if (mounted.current && epoch === testEpoch.current) setFormError(signal.reason?.name === 'TimeoutError' ? '连接测试超时，请检查网站与网络后重试' : err.message); }
    finally { if (connectionTest.current === controller) { connectionTest.current = null; if (mounted.current) setTesting(false); } }
  }
  async function sync(item) {
    if (lock.current) return;
    try {
      const result = await mutate(`/api/epay/accounts/${encodeURIComponent(item.id)}/sync`, {});
      if (result) toast('已安排后台同步，不影响页面操作');
    } catch (err) { toast(err.message); }
  }
  async function toggle(item) {
    if (lock.current) return;
    try {
      const result = await mutate(`/api/epay/accounts/${encodeURIComponent(item.id)}`, { ...item, enabled: !item.enabled, key: '' }, 'PUT');
      if (result) toast(item.enabled ? '已暂停监听' : '已恢复监听');
    } catch (err) { toast(err.message); }
  }
  async function remove() {
    if (!deletion || lock.current) return;
    try {
      const result = await mutate('/api/epay/delete', { confirm: 'delete-records', ids: deletion.ids });
      if (!result || !mounted.current) return;
      const ids = new Set(deletion.ids);
      setData(current => current ? { ...current, accounts: current.accounts.filter(item => !ids.has(item.id)) } : current);
      if (ids.has(accountId)) setAccountId('');
      setDeletion(null); toast(`已删除 ${result.deletedCount} 个商户及其本地订单`);
    } catch (err) { toast(err.message); }
  }
  const copy = async value => { try { await copyNoteText(value); toast('已复制订单号'); } catch { toast('复制失败，请长按选择复制'); } };
  const resetPage = setter => event => { setter(event.target.value); setPage(1); };
  const orderList = records => <div className="epay-orders"><div className="epay-order-head"><span>订单 / 商品</span><span>商户 / 支付方式</span><span>订单金额</span><span>状态 / 时间</span><span /></div>
    {records.map(row => { const account = names.get(row.account_id); return <article className="epay-order" key={`${row.account_id}:${row.trade_no}`}>
      <div className="epay-order-name"><strong>{row.name || '未提供商品名称'}</strong><button className="epay-copy" title="复制订单号" onClick={() => copy(row.trade_no)}><span>{row.trade_no}</span><Copy size={12} /></button></div>
      <div className="epay-order-merchant"><strong>{account?.name || '已删除商户'}</strong><span>{EPAY_CHANNELS[row.channel] || row.channel || '其他方式'}</span></div>
      <strong className={`epay-order-amount ${row.status === 'paid' ? 'paid' : ''}`}>{epayMoney(row.cents, account?.currency)}</strong>
      <div className="epay-order-time"><span className={`epay-badge ${row.status}`}>{EPAY_STATUSES[row.status] || '未知状态'}</span><time>{date(row.paid_at || row.created_at)}</time></div>
      <button className="ghost epay-detail-button" onClick={() => setDetail({ ...row, accountName: account?.name, currency: account?.currency })}>详情<ArrowUpRight size={13} /></button>
    </article>; })}</div>;

  return <section className="ops-workspace epay-workspace">
    <header className="surface ops-header"><div><span className="ops-eyebrow">商户收款 · 订单追踪</span><strong>易支付</strong></div><div className="epay-header-meta"><ShieldCheck size={15} /><span>密钥加密保存 · 仅查询订单</span></div></header>
    <nav className="ops-tabs epay-tabs" aria-label="易支付功能">{TABS.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => { setTab(key); setPage(1); }}>{label}{key === 'accounts' && data ? <em>{accounts.length}</em> : null}</button>)}</nav>
    <div className="surface ops-content epay-content">
      <div className="epay-content-body">
      <div className="ops-content-head"><div><strong>{TABS.find(([key]) => key === tab)[1]}</strong><span>{tab === 'accounts' ? `${accounts.length} 个商户 · ${accounts.filter(item => item.enabled).length} 个监听中` : selected ? selected.name : '全部商户 · 按币种分别统计'}</span></div>
        <div className="ops-content-actions epay-actions">{tab === 'overview' ? <select className="epay-scope-select" aria-label="商户范围" value={accountId} onChange={resetPage(setAccountId)}><option value="">全部商户</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : null}{tab === 'accounts' ? <button className="ghost danger-text-button" disabled={busy || !accounts.length} onClick={() => setDeletion({ ids: accounts.map(item => item.id), name: '全部商户' })}><Trash2 size={15} />全部删除</button> : null}
          <button className="ghost icon-button" title="刷新页面数据" aria-label="刷新页面数据" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button>
          <button className="primary" disabled={busy || !data} onClick={() => openEditor(null)}><Plus size={16} />添加商户</button>
        </div>
      </div>
      {error ? <div className="epay-warning" role="alert"><AlertCircle size={16} />{error}</div> : null}
      {tab === 'orders' ? <div className="epay-filters"><label><span>商户范围</span><select value={accountId} onChange={resetPage(setAccountId)}><option value="">全部商户</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>支付状态</span><select value={orderStatus} onChange={resetPage(setOrderStatus)}><option value="">全部状态</option>{Object.entries(EPAY_STATUSES).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label><span>开始日期</span><input type="date" value={from} max={to || undefined} onChange={resetPage(setFrom)} /></label><label><span>结束日期</span><input type="date" value={to} min={from || undefined} onChange={resetPage(setTo)} /></label>
      </div> : null}
      {!data ? <div className="ops-empty"><RefreshCw size={26} /><strong>正在读取易支付…</strong></div> : !accounts.length ? <div className="epay-empty"><div><Wallet size={30} /></div><strong>让每一笔收款都有回音</strong><p>添加易支付商户，统一查看订单、余额和收款通知。</p><button className="primary" onClick={() => openEditor(null)}><Plus size={16} />添加第一个商户</button></div> : <>
        {tab === 'overview' ? <>
          {data.summary.map(group => {
            const balance = data.balances.find(item => item.currency === group.currency);
            return <div className="epay-metrics epay-overview-metrics" key={group.currency}>
              <div className="epay-metric epay-balance-metric" title="余额为接口最近一次查询结果，与累计收款金额分别计算。未提供余额的账号不计入合计。">
                <span><Landmark size={13} />{selected ? '商户余额' : '总余额'}<small>{group.currency}</small></span>
                <strong>{epayMoney(balance?.balance, group.currency)}</strong>
                <small>{balance?.known || 0}/{balance?.total || 0} 个账号{balance?.stale ? ` · ${balance.stale} 个待刷新` : ' · 最近余额'}</small>
              </div>
              {[['today', '今日收款'], ['yesterday', '昨日收款'], ['month', '本月收款'], ['total', '累计收款']].map(([key, label]) => <div className="epay-metric" key={key}><span>{label}<small>{group.currency}</small></span><strong>{epayMoney(group[key], group.currency)}</strong>{key === 'total' ? <small>{group.paidCount} 笔成功订单</small> : null}</div>)}
            </div>;
          })}
          <div className="epay-summary-caption">北京时间统计 · 仅统计已同步的成功订单；余额为接口最近查询结果。</div>
          <div className="epay-section-title"><strong>商户概况</strong><button className="epay-link" onClick={() => setTab('accounts')}>管理账号<ArrowUpRight size={14} /></button></div>
          <div className="epay-account-cards">{accounts.filter(item => !accountId || item.id === accountId).map(item => { const total = accountTotals.get(item.id), [tone, label, Icon] = status(item); return <button className="epay-account-card" key={item.id} onClick={() => { setAccountId(item.id); setPage(1); }}><div><strong>{item.name}</strong><span className={`epay-badge ${tone}`}><Icon size={12} />{label}</span></div><span className="epay-account-host">{new URL(item.url).host} · 商户 {item.pid}</span><dl><div><dt>当前余额</dt><dd>{epayMoney(item.balance, item.currency)}</dd></div><div><dt>今日收款</dt><dd>{epayMoney(total?.today || 0, item.currency)}</dd></div></dl><small>{item.historyUnsupported ? '接口不支持历史分页 · 仅统计可查询范围' : item.historyComplete ? '历史订单已同步' : '历史订单分批同步中'} · {date(item.lastSyncAt)}</small>{item.lastWarning ? <span className="epay-inline-warning">{item.lastWarning}</span> : null}{item.lastError ? <span className="epay-inline-error">{item.lastError}</span> : null}</button>; })}</div>
          <div className="epay-section-title"><strong>最近订单</strong><button className="epay-link" onClick={() => setTab('orders')}>查看全部<ArrowUpRight size={14} /></button></div>
          {orderList(data.orders.records.slice(0, 6))}
        </> : tab === 'orders' ? <>{orderList(data.orders.records)}{!data.orders.records.length ? <div className="ops-empty"><ReceiptText size={25} /><strong>暂无匹配订单</strong><span>订单在后台同步，首次读取历史需要一些时间。</span></div> : null}
          <div className="epay-pagination"><span>共 {data.orders.total} 笔 · 第 {data.orders.page}/{data.orders.pages} 页</span><div><button className="ghost icon-button" aria-label="上一页" disabled={data.orders.page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button><button className="ghost icon-button" aria-label="下一页" disabled={data.orders.page >= data.orders.pages} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div></div>
        </> : <div className="epay-account-list">{filtered.map(item => { const [tone, label, Icon] = status(item); return <article key={item.id} className="epay-account-row"><div className="epay-merchant-icon"><Wallet size={21} /></div><div className="epay-account-info"><div><strong>{item.name}</strong><span className={`epay-badge ${tone}`}><Icon size={12} />{label}</span></div><span>{item.url} · 商户 {item.pid}</span><small>每 {item.interval} 秒监听 · {item.botIds.length ? `${item.botIds.length} 个通知机器人` : '未开启 TG 通知'} · {date(item.lastSyncAt)}</small>{item.lastWarning ? <span className="epay-inline-warning">{item.lastWarning}</span> : null}{item.lastError ? <span className="epay-inline-error">{item.lastError}</span> : null}{item.note ? <small>{item.note}</small> : null}</div><div className="epay-account-money"><small>最近余额</small><strong>{epayMoney(item.balance, item.currency)}</strong></div><div className="epay-row-actions"><button className="ghost" disabled={busy || !item.enabled || item.syncing} onClick={() => sync(item)}>{item.syncing ? '同步中' : '同步'}</button><button className="ghost" disabled={busy} onClick={() => toggle(item)}>{item.enabled ? '暂停' : '启用'}</button><button className="ghost icon-button" aria-label={`编辑 ${item.name}`} title="编辑" disabled={busy} onClick={() => openEditor(item)}><Pencil size={15} /></button><button className="ghost icon-button danger-text-button" aria-label={`删除 ${item.name}`} title="删除" disabled={busy} onClick={() => setDeletion({ ids: [item.id], name: item.name })}><Trash2 size={15} /></button></div></article>; })}{!filtered.length ? <div className="ops-empty">没有匹配的商户</div> : null}</div>}
        {data.notifications.some(item => ['uncertain', 'failed'].includes(item.state)) ? <div className="epay-warning"><AlertCircle size={16} /><span>部分通知发送失败或结果待确认。为避免重复收款提醒，结果不明确的通知不会自动重发，请以订单记录为准。</span></div> : null}
      </>}
      </div>
      <footer className="epay-footnote"><ShieldCheck size={13} /><span>后台独立监听，关闭页面仍会继续。首次导入的历史订单不补发提醒；密钥不返回浏览器，备份随现有数据库保存。</span></footer>
    </div>
    {editor ? <Dialog title={editor.id ? '编辑易支付商户' : '添加易支付商户'} wide className="epay-dialog" onClose={closeEditor} footer={<div className="epay-editor-footer"><button className="ghost" disabled={busy || testing} onClick={testConnection}>{testing ? '测试中…' : '测试连接'}</button><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={closeEditor}>取消</button><button className="primary" disabled={busy || testing} onClick={save}>{busy ? '保存中…' : '保存商户'}</button></div></div>}>
      <div className="epay-form-intro"><div><Wallet size={22} /></div><span><strong>连接你的收款账号</strong><small>兼容常见易支付商户查询接口，不修改收款配置。</small></span></div>
      <form className="epay-form" onSubmit={event => { event.preventDefault(); save(); }} autoComplete="off">
        <label className="epay-field full"><span>商户名称 <em>必填</em></span><input value={editor.name} maxLength={120} placeholder="例如：主站收款" disabled={busy || testing} onChange={event => patch({ name: event.target.value })} /></label>
        <label className="epay-field full"><span>易支付网站 <em>必填</em></span><input type="url" inputMode="url" value={editor.url} disabled={Boolean(editor.id) || busy || testing} placeholder="https://pay.example.com/" onChange={event => patch({ url: event.target.value })} /><small>使用公网 HTTPS 地址，自动请求网站下的 api.php。</small></label>
        <label className="epay-field"><span>商户号 <em>必填</em></span><input inputMode="numeric" value={editor.pid} maxLength={20} disabled={Boolean(editor.id) || busy || testing} placeholder="填写 PID" onChange={event => patch({ pid: event.target.value })} /></label>
        <label className="epay-field"><span>金额币种</span><select value={editor.currency} disabled={Boolean(editor.id) || busy || testing} onChange={event => patch({ currency: event.target.value })}>{EPAY_CURRENCIES.map(currency => <option key={currency}>{currency}</option>)}</select><small>与支付平台实际币种保持一致。</small></label>
        <label className="epay-field full"><span>商户密钥 <em>{editor.id ? '留空保留原密钥' : '必填'}</em></span><div className="epay-secret"><input type={showKey ? 'text' : 'password'} autoComplete="new-password" value={editor.key} maxLength={512} disabled={busy || testing} placeholder={editor.id ? '已加密保存，无需重复填写' : '填写商户密钥 KEY'} onChange={event => patch({ key: event.target.value })} /><button type="button" className="ghost icon-button" aria-label={showKey ? '隐藏密钥' : '显示本次输入的密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
        <fieldset className="epay-form-bots" disabled={busy || testing}><RenewalBotPicker label="收款通知机器人（默认不选）" bots={data?.bots || []} value={editor.botIds} onChange={botIds => patch({ botIds })} /><p>每笔成功收款通知一次，包含当前商户余额与全部商户总余额；通知接收人沿用机器人设置。</p></fieldset>
        <details className="epay-advanced"><summary>监听与备注设置</summary><div><label className="epay-field"><span>监听间隔（秒）</span><input type="number" min={15} max={3600} value={editor.interval} disabled={busy || testing} onChange={event => patch({ interval: event.target.value })} /></label><label className="epay-toggle"><input type="checkbox" checked={editor.enabled} disabled={busy || testing} onChange={event => patch({ enabled: event.target.checked })} /><span>启用后台监听</span></label><label className="epay-field full"><span>备注</span><textarea rows={2} maxLength={500} value={editor.note} disabled={busy || testing} onChange={event => patch({ note: event.target.value })} placeholder="仅供面板管理时查看" /></label></div></details>
        {formError ? <p className="epay-form-error full" role="alert">{formError}</p> : null}
        {testResult ? <div className="epay-test-result"><CheckCircle2 size={18} /><span>{testResult.message}<strong>当前余额：{epayMoney(testResult.balance, testResult.currency)}</strong></span></div> : null}
      </form>
    </Dialog> : null}
    {deletion ? <Dialog title={deletion.ids.length > 1 ? '确认全部删除商户' : '确认删除商户'} onClose={() => !lock.current && setDeletion(null)} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setDeletion(null)}>取消</button><button className="primary danger-action" disabled={busy} onClick={remove}>{busy ? '删除中…' : '确认删除'}</button></div>}><div className="confirm-copy"><p>确认删除「{deletion.name}」共 {deletion.ids.length} 个账号？</p><p>对应的本地订单、统计和通知记录一并删除，停止后续监听。易支付网站上的商户、余额和真实订单不受影响。</p><p>确认期间新增的账号不会被删除，此操作不可撤销。</p></div></Dialog> : null}
    {detail ? <Dialog title="订单详情" onClose={() => setDetail(null)} footer={<button className="primary" onClick={() => setDetail(null)}>完成</button>}><div className="epay-order-detail"><span className={`epay-badge ${detail.status}`}>{EPAY_STATUSES[detail.status]}</span><strong>{epayMoney(detail.cents, detail.currency)}</strong><dl>{[['商户', detail.accountName], ['商品名称', detail.name], ['平台订单号', detail.trade_no], ['商户订单号', detail.out_trade_no], ['支付方式', EPAY_CHANNELS[detail.channel] || detail.channel], ['创建时间', date(detail.created_at)], ['支付时间', detail.paid_at ? date(detail.paid_at) : '接口未提供']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '未提供'}</dd></div>)}</dl><button className="ghost" onClick={() => copy(detail.trade_no)}><Copy size={14} />复制订单号</button></div></Dialog> : null}
  </section>;
}

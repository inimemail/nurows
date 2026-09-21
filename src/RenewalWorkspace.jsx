import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Plus, Settings, Trash2, Copy, Pencil, MoreHorizontal, X, RefreshCw } from 'lucide-react';
import { startPolling } from '../shared/polling.js';
import { filterWorkspaceRecords } from '../shared/workspace-search.js';
import { DEFAULT_RENEWAL_SETTINGS, RENEWAL_CURRENCIES, beijingDate, renewalStatus, renewalAmount, sortRenewals, renewalIdentityIndex, renewalDuplicateField, renewalBotIds } from '../shared/renewals.js';
import './renewals.css';

const EMPTY = { name: '', address: '', price: '', currency: 'CNY', dueDate: '', botIds: [], notificationEnabled: true, note: '' };
const FILTERS = [['all', '全部'], ['soon', '即将到期'], ['valid', '有效'], ['expired', '已过期'], ['unknown', '未知日期']];
export function duplicateRenewal(item) {
  return { ...EMPTY, price: item.price, currency: item.currency, dueDate: item.dueDate, botIds: [...item.botIds], notificationEnabled: item.notificationEnabled !== false, note: item.note };
}

export default function RenewalWorkspace({ state, search = '', api, onState, toast, Dialog, onSearchScopeChange }) {
  const [data, setData] = useState(() => ({ renewals: state.renewals || [], renewalSettings: state.renewalSettings || DEFAULT_RENEWAL_SETTINGS, renewalRevision: state.renewalRevision || 0, bots: [] }));
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [filter, setFilter] = useState('all'), [page, setPage] = useState(1), [selected, setSelected] = useState([]);
  const [editor, setEditor] = useState(null), [settings, setSettings] = useState(null), [deletion, setDeletion] = useState(null);
  const [busy, setBusy] = useState(false), [today, setToday] = useState(() => beijingDate());
  const working = useRef(false), epoch = useRef(0), mounted = useRef(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { onSearchScopeChange?.({ tab: 'renewals', section: 'renewals' }); }, [onSearchScopeChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let canceled = false;
    const stop = startPolling(async (signal) => {
      if (document.hidden || working.current) return;
      const version = epoch.current;
      try {
        const next = await api('/api/renewals', { signal });
        if (!canceled && version === epoch.current && !working.current) {
          setData((prior) => next.renewalRevision >= prior.renewalRevision ? next : prior);
          setError(''); setLoading(false); setToday(beijingDate());
        }
      } catch (err) { if (!canceled && version === epoch.current) { setError(err.name === 'TimeoutError' ? '读取超时，请刷新重试' : err.message); setLoading(false); } }
    }, 60000);
    const visible = () => { if (!document.hidden) { setToday(beijingDate()); setRefresh((value) => value + 1); } };
    document.addEventListener('visibilitychange', visible);
    return () => { canceled = true; stop(); document.removeEventListener('visibilitychange', visible); };
  }, [api, refresh]);
  useEffect(() => { setPage(1); setSelected([]); }, [search, filter]);
  useEffect(() => {
    const ids = new Set(data.renewals.map((item) => item.id));
    setSelected((prior) => prior.filter((id) => ids.has(id)));
  }, [data.renewals]);
  const now = Date.parse(`${today}T00:00:00+08:00`);
  const { counts, statuses } = useMemo(() => {
    const output = { all: data.renewals.length, soon: 0, valid: 0, expired: 0, unknown: 0 };
    const statuses = new Map();
    for (const item of data.renewals) {
      const status = renewalStatus(item, data.renewalSettings, now);
      statuses.set(item.id, status); output[status.key]++;
    }
    return { counts: output, statuses };
  }, [data.renewals, data.renewalSettings, today]);
  const ordered = useMemo(() => sortRenewals(data.renewals, now), [data.renewals, today]);
  const filtered = useMemo(() => filterWorkspaceRecords('renewals', ordered, search)
    .filter((item) => filter === 'all' || statuses.get(item.id).key === filter), [ordered, statuses, filter, search]);
  const identities = useMemo(() => editor ? renewalIdentityIndex(data.renewals, editor.id) : null, [data.renewals, editor?.id, Boolean(editor)]);
  const duplicate = editor ? renewalDuplicateField(editor, identities) : '';
  const botNames = useMemo(() => new Map(data.bots.map((bot) => [bot.id, bot.name])), [data.bots]);
  const notificationNames = (ids) => ids.map((id) => botNames.get(id) || '已删除的机器人').join('、') || '未选择';
  const pages = Math.max(1, Math.ceil(filtered.length / 50)), currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 50, currentPage * 50);
  const selectedSet = new Set(selected), allSelected = visible.length > 0 && visible.every((item) => selectedSet.has(item.id));
  const toggleAll = () => setSelected((prior) => allSelected ? prior.filter((id) => !visible.some((item) => item.id === id)) : [...new Set([...prior, ...visible.map((item) => item.id)])]);
  async function mutate(path, body, method = 'POST') {
    if (working.current) return;
    working.current = true; epoch.current++; setBusy(true);
    try {
      const next = await api(path, { method, body: JSON.stringify(body) });
      if (!mounted.current) return;
      setData(next); onState?.((prior) => ({ ...prior, renewals: next.renewals, renewalSettings: next.renewalSettings, renewalRevision: next.renewalRevision }));
      setEditor(null); setSettings(null); setDeletion(null); setSelected([]); setError(''); toast('已保存');
    } catch (err) { if (mounted.current) { toast(err.message); setRefresh((value) => value + 1); } }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  const requestDelete = (ids, all = false) => setDeletion({ ids, all, count: all ? data.renewals.length : ids.length, revision: data.renewalRevision });
  const openCopy = (item) => { if (!busy && !loading) setEditor(duplicateRenewal({ ...item, botIds: item.botIds.filter((id) => data.bots.some((bot) => bot.id === id)) })); };
  return <section className="ops-workspace renewal-workspace">
    <header className="surface ops-header"><div><span className="ops-eyebrow">到期与续费</span><strong>续费管理</strong></div><div className="renewal-summary"><CalendarClock size={16} /><span>{counts.all} 条记录 · {counts.soon} 条即将到期</span></div></header>
    <div className="ops-tabs" role="tablist" aria-label="续费状态">{FILTERS.map(([key, label]) => <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}<em>{counts[key]}</em></button>)}</div>
    <div className="surface ops-content renewal-content">
      <div className="ops-content-head"><div><strong>服务器续费</strong><span>{filtered.length} 条{selected.length ? ` · 已选 ${selected.length} 条` : ''}</span><span className="renewal-notification-summary">默认通知机器人：{loading ? '读取中...' : notificationNames(data.renewalSettings.botIds || [])}</span></div><div className="ops-content-actions renewal-actions">
        <button className="ghost icon-button" title="刷新" aria-label="刷新" disabled={busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button>
        {selected.length ? <button className="ghost danger-text-button" disabled={busy || loading} onClick={() => requestDelete(selected)}><Trash2 size={15} />删除所选</button> : null}
        <button className="ghost danger-text-button" disabled={busy || loading || !data.renewals.length} onClick={() => requestDelete([], true)}><Trash2 size={15} />全部删除</button>
        <button className="ghost icon-button" title="提醒设置" aria-label="提醒设置" disabled={busy || loading} onClick={() => setSettings({ ...structuredClone(data.renewalSettings), revision: data.renewalRevision })}><Settings size={17} /></button>
        <button className="primary" disabled={busy || loading} onClick={() => setEditor(structuredClone(EMPTY))}><Plus size={16} />添加</button>
      </div></div>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      <div className="renewal-table-head"><label><input type="checkbox" aria-label="选择本页" checked={allSelected} disabled={!visible.length} onChange={toggleAll} /><span>名称 / 地址</span></label><span>续费金额</span><span>到期日期</span><span>状态</span><span>操作</span></div>
      <div className="ops-list renewal-list">{visible.map((item) => {
        const status = statuses.get(item.id);
        return <article className="renewal-row" key={item.id} onClick={(event) => { if (event.detail === 3 && !event.target.closest('button, input, label, details')) openCopy(item); }}>
          <div className="renewal-identity"><input type="checkbox" aria-label={`选择 ${item.name}`} checked={selectedSet.has(item.id)} onChange={(event) => setSelected((prior) => event.target.checked ? [...prior, item.id] : prior.filter((id) => id !== item.id))} /><div><strong>{item.name}</strong>{item.address ? <span className="renewal-address">{item.address}</span> : null}{item.note ? <span className="renewal-note">{item.note}</span> : null}{item.notificationError ? <span className="renewal-warning">{item.notificationError}</span> : null}</div></div>
          <div className="renewal-price"><span className="renewal-mobile-label">续费金额</span><span className={item.price === '' ? 'renewal-muted' : ''}>{renewalAmount(item)}</span></div>
          <div className="renewal-date"><span className="renewal-mobile-label">到期日期</span><time dateTime={item.dueDate || undefined}>{item.dueDate || '未知日期'}</time></div>
          <div className={`renewal-status ${status.tone}`}><strong>{status.countdown}</strong><span>{status.label}</span></div>
          <div className="renewal-row-actions"><button className="ghost icon-button" title="编辑" aria-label={`编辑 ${item.name}`} disabled={busy || loading} onClick={() => setEditor(structuredClone(item))}><Pencil size={16} /></button><details className="renewal-menu"><summary className="ghost icon-button" aria-label={`${item.name} 的更多操作`} title="更多操作"><MoreHorizontal size={18} /></summary><div><button disabled={busy || loading} onClick={(event) => { event.currentTarget.closest('details').open = false; openCopy(item); }}><Copy size={15} />复制</button><button className="danger-text-button" disabled={busy || loading} onClick={(event) => { event.currentTarget.closest('details').open = false; requestDelete([item.id]); }}><Trash2 size={15} />删除</button></div></details></div>
        </article>;
      })}</div>
      {!visible.length ? <div className="ops-empty"><CalendarClock size={28} /><strong>{loading ? '正在读取...' : data.renewals.length ? '没有匹配的续费记录' : '暂无续费记录'}</strong></div> : null}
      {pages > 1 ? <div className="renewal-pagination"><button className="ghost" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {pages}</span><button className="ghost" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div> : null}
    </div>
    {editor ? <Dialog title={editor.id ? '编辑续费记录' : '添加续费记录'} className="ops-editor-dialog renewal-dialog" onClose={() => !busy && setEditor(null)} footer={<><span /><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setEditor(null)}>取消</button><button className="primary" form="renewal-form" type="submit" disabled={busy || Boolean(duplicate)}>{busy ? '保存中...' : '保存'}</button></div></>}>
      <form id="renewal-form" className="ops-editor-grid" onSubmit={(event) => { event.preventDefault(); if (!duplicate) mutate(editor.id ? `/api/renewals/${encodeURIComponent(editor.id)}` : '/api/renewals', editor, editor.id ? 'PUT' : 'POST'); }}>
        <RenewalEditor value={editor} bots={data.bots} duplicate={duplicate} notificationNames={notificationNames(renewalBotIds(editor, data.renewalSettings))} patch={(patch) => setEditor((prior) => ({ ...prior, ...patch }))} />
      </form>
    </Dialog> : null}
    {settings ? <Dialog title="续费提醒设置" className="renewal-dialog" onClose={() => !busy && setSettings(null)} footer={<><span /><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setSettings(null)}>取消</button><button className="primary" type="submit" form="renewal-settings" disabled={busy}>{busy ? '保存中...' : '保存设置'}</button></div></>}><RenewalSettings value={settings} bots={data.bots} onChange={setSettings} onSave={(next) => mutate('/api/renewals/settings', next, 'PUT')} /></Dialog> : null}
    {deletion ? <Dialog title={deletion.all ? '删除全部续费记录' : '删除续费记录'} onClose={() => !busy && setDeletion(null)} footer={<><span /><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={() => setDeletion(null)}>取消</button><button className="primary danger-action" disabled={busy} onClick={() => mutate('/api/renewals/delete', { ...deletion, confirm: true })}>{busy ? '删除中...' : '确认删除'}</button></div></>}><p className="confirm-copy">将永久删除{deletion.all ? '全部' : '所选'} {deletion.count} 条续费记录及其提醒状态。{deletion.all ? '包含当前搜索或筛选中未显示的记录。' : ''}实际服务器、SSH 和守护任务不受影响。</p></Dialog> : null}
  </section>;
}

export function RenewalEditor({ value, patch, bots, duplicate = '', notificationNames = '未选择' }) {
  return <>
    <label className="ops-field full"><span>服务器名称 *</span><input required maxLength={120} aria-invalid={duplicate === 'name'} aria-describedby={duplicate === 'name' ? 'renewal-name-error' : undefined} value={value.name} onChange={(event) => patch({ name: event.target.value })} />{duplicate === 'name' ? <small className="renewal-field-error" id="renewal-name-error" role="alert">服务器名称已存在，请使用其他名称</small> : null}</label>
    <label className="ops-field full"><span>IP / 域名（选填）</span><input maxLength={253} aria-invalid={duplicate === 'address'} aria-describedby={duplicate === 'address' ? 'renewal-address-error' : undefined} value={value.address} onChange={(event) => patch({ address: event.target.value })} autoCapitalize="none" spellCheck={false} />{duplicate === 'address' ? <small className="renewal-field-error" id="renewal-address-error" role="alert">IP / 域名已存在，请勿重复添加</small> : null}</label>
    <label className="ops-field"><span>续费价格（选填）</span><input type="number" inputMode="decimal" min="0" max="9999999999.99" step="0.01" value={value.price} onChange={(event) => patch({ price: event.target.value })} /></label>
    <label className="ops-field"><span>币种</span><select value={value.currency} onChange={(event) => patch({ currency: event.target.value })}>{RENEWAL_CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
    <label className="ops-field full"><span>到期日期（北京时间，选填）</span><div className="renewal-date-input"><input type="date" min="2000-01-01" max="2199-12-31" value={value.dueDate} onChange={(event) => patch({ dueDate: event.target.value })} /><button type="button" className="ghost icon-button" title="清空到期日期" aria-label="清空到期日期" disabled={!value.dueDate} onClick={() => patch({ dueDate: '' })}><X size={16} /></button></div></label>
    <div className="renewal-notification-control">
      <label className="ops-toggle"><input type="checkbox" checked={value.notificationEnabled !== false} onChange={(event) => patch({ notificationEnabled: event.target.checked })} /><span>服务器续费通知</span></label>
      <p className="renewal-notification-current">{value.notificationEnabled === false ? '已关闭这条记录的续费通知' : `${value.botIds.length ? '单独通知' : '跟随设置'}：${notificationNames}`}</p>
      {value.notificationEnabled !== false ? <details className="renewal-bot-overrides"><summary>单独指定通知机器人{value.botIds.length ? `（已选 ${value.botIds.length} 个）` : '（选填）'}</summary><RenewalBotPicker label="TG 机器人（未选时跟随设置）" bots={bots} value={value.botIds} onChange={(botIds) => patch({ botIds })} /></details> : null}
    </div>
    <label className="ops-field full"><span>备注（选填）</span><textarea rows={3} maxLength={1000} value={value.note} onChange={(event) => patch({ note: event.target.value })} /></label>
  </>;
}

export function RenewalBotPicker({ label, bots = [], value = [], onChange }) {
  return <fieldset className="renewal-bots"><legend>{label}</legend>{bots.length ? bots.map((bot) => <label key={bot.id}><input type="checkbox" checked={value.includes(bot.id)} onChange={(event) => onChange(event.target.checked ? [...value, bot.id] : value.filter((id) => id !== bot.id))} /><span>{bot.name}<small>{!bot.enabled ? '已停用' : !bot.configured ? '未配置 Token' : !bot.hasRecipients ? '未配置接收人' : 'Telegram 机器人'}</small></span></label>) : <span className="renewal-muted">暂无可选机器人</span>}</fieldset>;
}

export function RenewalSettings({ value, bots = [], onChange, onSave }) {
  const [day, setDay] = useState('');
  const add = () => {
    const number = Number(day);
    if (!Number.isInteger(number) || number < 1 || number > 365 || value.days.length >= 20) return;
    onChange({ ...value, days: [...new Set([...value.days, number])].sort((a, b) => b - a) }); setDay('');
  };
  return <form id="renewal-settings" className="renewal-settings" onSubmit={(event) => {
    event.preventDefault();
    const days = day ? [...new Set([...value.days, Number(day)])].sort((a, b) => b - a) : value.days;
    if (days.length > 20 || days.some((number) => !Number.isInteger(number) || number < 0 || number > 365)) return;
    onSave({ ...value, days });
  }}>
    <RenewalBotPicker label="默认 TG 通知机器人" bots={bots} value={value.botIds || []} onChange={(botIds) => onChange({ ...value, botIds })} />
    <div className="ops-field"><span>提前通知（天）</span><div className="renewal-reminder-days">{value.days.filter((number) => number > 0).map((number) => <span key={number}>{number} 天<button type="button" title={`移除提前 ${number} 天`} aria-label={`移除提前 ${number} 天`} onClick={() => onChange({ ...value, days: value.days.filter((item) => item !== number) })}><X size={14} /></button></span>)}</div></div>
    <div className="renewal-day-add"><input type="number" inputMode="numeric" min="1" max="365" step="1" aria-label="提前通知天数" placeholder="天数" value={day} disabled={value.days.length >= 20} onChange={(event) => setDay(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} /><button type="button" className="ghost" disabled={!day || value.days.length >= 20 || !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 365} onClick={add}><Plus size={16} />添加节点</button></div>
    <label className="ops-toggle"><input type="checkbox" checked={value.days.includes(0)} disabled={!value.days.includes(0) && value.days.length >= 20} onChange={(event) => onChange({ ...value, days: event.target.checked ? [...value.days, 0] : value.days.filter((number) => number !== 0) })} /><span>到期当天通知</span></label>
    <label className="ops-field"><span>通知时间（北京时间）</span><input type="time" required value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value })} /></label>
    {!value.days.length ? <p className="renewal-warning">未选择提醒节点，将暂停全部续费提醒。</p> : null}
  </form>;
}

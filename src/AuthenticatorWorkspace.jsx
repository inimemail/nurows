import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, LockKeyhole, Unlock, Plus, Copy, Pencil, Trash2, QrCode, Settings, Download, Upload, RefreshCw, Eye, EyeOff, Clock, History, ChevronLeft, ChevronRight, Zap } from 'lucide-react';
import { createOtp, parseOtpInput, OTP_DEFAULTS, otpRemaining } from '../shared/authenticator.js';
import { copyNoteText } from './note-clipboard.js';
import { readAuthenticatorQr, authenticatorQr } from './authenticator-qr.js';
import GuardSortableList from './GuardSortableList.jsx';
import { authenticatorRequest } from './authenticator-request.js';
import './authenticator.css';

const BASE = { issuer: '', account: '', note: '', secret: '', ...OTP_DEFAULTS };
const AUDIT = { unlock: '解锁验证器', create: '添加验证器', edit: '编辑验证器', delete: '删除验证器', reveal: '查看配置二维码', import: '导入加密备份', export: '导出加密备份' };

export default function AuthenticatorWorkspace({ api, toast, Dialog, search = '', onSearchScopeChange }) {
  const [data, setData] = useState(null), [tab, setTab] = useState('saved'), [modal, setModal] = useState(null);
  const [unlocked, setUnlocked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now()), [visible, setVisible] = useState(!document.hidden), [page, setPage] = useState(1), [temporaryEpoch, setTemporaryEpoch] = useState(0);
  const secrets = useRef(new Map()), session = useRef(null), epoch = useRef(0), pending = useRef(false), mounted = useRef(true);
  const activity = useRef(Date.now()), touching = useRef(false), touched = useRef(Date.now()), offset = useRef(0), snapshot = useRef(data);
  const requests = useRef(new Set());
  snapshot.current = data;
  function accept(result) {
    if (result.serverTime) { offset.current = result.serverTime - Date.now(); setNow(result.serverTime); }
    if (result.accounts) {
      const accounts = result.accounts.map(({ secret: _secret, ...metadata }) => metadata);
      const next = new Map();
      for (const item of result.accounts) {
        const previous = secrets.current.get(item.id);
        const secret = item.secret || (previous?.revision === item.revision ? previous.secret : null);
        if (secret && session.current) next.set(item.id, { ...item, secret });
      }
      if (result.item && session.current) next.set(result.item.id, result.item);
      secrets.current.clear(); secrets.current = next;
      const value = { accounts, settings: result.settings };
      snapshot.current = value; setData(value);
    }
  }
  function lock() {
    const token = session.current?.token;
    epoch.current++; session.current = null; secrets.current.clear(); pending.current = false;
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
    if (mounted.current) { setUnlocked(false); setModal(null); setBusy(false); setError(''); setTemporaryEpoch(value => value + 1); }
    if (token) void authenticatorRequest(api, '/api/authenticator/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator-Unlock': token }, body: '{}' }).catch(() => {});
  }
  function ensureCurrent() {
    const grant = session.current;
    if (!grant || document.hidden || Date.now() - activity.current >= (snapshot.current?.settings.idleMinutes || 5) * 60000 || Date.now() + offset.current >= Math.min(grant.deadline, grant.expires)) {
      lock(); throw Error('验证器已锁定，请重新解锁');
    }
  }
  async function request(path, body, method = 'POST', needsUnlock = true) {
    if (pending.current) throw Error('操作正在处理，请稍后');
    if (needsUnlock) ensureCurrent();
    const version = epoch.current, token = session.current?.token;
    const controller = new AbortController(); requests.current.add(controller);
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await authenticatorRequest(api, `/api/authenticator${path}`, { method, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Authenticator-Unlock': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!mounted.current || epoch.current !== version || document.hidden) {
        if (result.token) void authenticatorRequest(api, '/api/authenticator/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator-Unlock': result.token }, body: '{}' }).catch(() => {});
        throw new DOMException('Cancelled', 'AbortError');
      }
      if (result.token) { session.current = { token: result.token, deadline: result.deadline, expires: result.expiresAt }; activity.current = touched.current = Date.now(); setUnlocked(true); }
      if (needsUnlock && session.current) session.current.expires = Math.min(session.current.deadline, Date.now() + offset.current + (snapshot.current?.settings.idleMinutes || 5) * 60000);
      accept(result);
      // Do not combine another tab's new configuration with a cached old key.
      if (needsUnlock && result.accounts && session.current && result.accounts.some(item => !secrets.current.has(item.id))) {
        const fresh = await authenticatorRequest(api, '/api/authenticator/session', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Authenticator-Unlock': token }, body: '{}' });
        if (!mounted.current || version !== epoch.current || document.hidden) throw new DOMException('Cancelled', 'AbortError');
        accept(fresh);
      }
      return result;
    } catch (err) {
      if (mounted.current && epoch.current === version) {
        if (err.status === 423 || err.status === 401) lock();
        if (err.name !== 'AbortError') setError(err.message);
      }
      throw err;
    } finally { requests.current.delete(controller); if (epoch.current === version && mounted.current) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    authenticatorRequest(api, '/api/authenticator', { signal: controller.signal }).then(result => { if (!controller.signal.aborted && !snapshot.current) accept(result); }).catch(err => { if (!controller.signal.aborted && !snapshot.current) setError(err.message); });
    return () => { mounted.current = false; controller.abort(); lock(); };
  }, [api]);
  useEffect(() => { onSearchScopeChange?.({ tab: 'authenticator', section: 'authenticator' }); }, [onSearchScopeChange]);
  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => {
    let timer;
    const tick = () => {
      clearTimeout(timer);
      const time = Date.now(), grant = session.current;
      if (grant && (time - activity.current >= (snapshot.current?.settings.idleMinutes || 5) * 60000 || time + offset.current >= Math.min(grant.deadline, grant.expires))) lock();
      setVisible(!document.hidden);
      if (document.hidden) { lock(); return; }
      setNow(time + offset.current);
      if (session.current && !pending.current && !touching.current && activity.current > touched.current && time - touched.current >= 20000) {
        const token = session.current.token, version = epoch.current;
        touching.current = true; touched.current = time;
        void authenticatorRequest(api, '/api/authenticator/touch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator-Unlock': token }, body: '{}' })
          .then(result => { if (version === epoch.current && session.current?.token === token) session.current.expires = result.expiresAt; })
          .catch(err => { if (version === epoch.current && (err.status === 423 || err.status === 401)) lock(); })
          .finally(() => { touching.current = false; });
      }
      timer = setTimeout(tick, 1000 - Date.now() % 1000);
    };
    const active = () => {
      if (session.current) { try { ensureCurrent(); } catch { return; } }
      activity.current = Date.now();
    };
    tick(); document.addEventListener('visibilitychange', tick);
    document.addEventListener('pointerdown', active); document.addEventListener('keydown', active);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', tick); document.removeEventListener('pointerdown', active); document.removeEventListener('keydown', active); };
  }, [api]);
  const accounts = data?.accounts || [];
  const matched = useMemo(() => {
    const text = search.trim().toLocaleLowerCase();
    return accounts.filter(item => [item.issuer, item.account, item.note].some(value => value.toLocaleLowerCase().includes(text)));
  }, [data, search]);
  const pages = Math.max(1, Math.ceil(matched.length / 50)), currentPage = Math.min(page, pages);
  const items = useMemo(() => matched.slice((currentPage - 1) * 50, currentPage * 50).map(item => ({ ...item, name: item.issuer })), [matched, currentPage]);
  const order = useMemo(() => accounts.map(item => item.id), [data]);
  const open = (value) => { setError(''); setModal(value); };
  const newAccount = config => open(unlocked ? { type: 'edit', item: { ...BASE, ...config } } : { type: 'unlock', next: config });
  const close = () => { if (!busy) { setModal(null); setError(''); } };
  async function refresh() { try { await request(unlocked ? '/session' : '', undefined, unlocked ? 'POST' : 'GET', unlocked); toast('已刷新'); } catch {} }
  return <section className="ops-workspace authenticator-workspace">
    <header className="surface ops-header"><div><span className="ops-eyebrow">安全工具</span><strong>2FA 验证器</strong></div><div className={`authenticator-status ${unlocked ? 'unlocked' : ''}`}>{unlocked ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}<span>{accounts.length} 个验证器 · {unlocked ? '已解锁' : '已锁定'}</span>{unlocked ? <button className="ghost icon-button" title="立即锁定" aria-label="立即锁定" onClick={lock}><LockKeyhole size={17} /></button> : null}</div></header>
    <div className="ops-tabs authenticator-tabs" role="tablist" aria-label="验证器视图">{[['saved', '我的验证器', ShieldCheck], ['temporary', '临时生成', Zap]].map(([key, label, Icon]) => <button key={key} role="tab" aria-selected={tab === key} disabled={busy} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setModal(null); setError(''); }}><Icon size={16} />{label}</button>)}</div>
    <div className={`surface ops-content authenticator-content ${tab === 'temporary' ? 'authenticator-temporary-content' : ''}`}>
      {tab === 'saved' ? <>
        <div className="ops-content-head"><div><strong>我的验证器</strong><span>{unlocked ? `${data?.settings.idleMinutes || 5} 分钟无操作后锁定` : '输入面板密码解锁'}</span></div><div className="ops-content-actions authenticator-toolbar">
          <button className="ghost icon-button" title="刷新" aria-label="刷新验证器" disabled={busy} onClick={refresh}><RefreshCw size={16} /></button>
          {unlocked ? <><button className="ghost icon-button" title="加密备份" aria-label="加密备份" disabled={busy} onClick={() => open({ type: 'backup' })}><Download size={16} /></button><button className="ghost icon-button" title="设置" aria-label="验证器设置" disabled={busy} onClick={() => open({ type: 'settings', idleMinutes: data.settings.idleMinutes })}><Settings size={17} /></button></> : <button className="ghost" disabled={busy || !data} onClick={() => open({ type: 'unlock' })}><Unlock size={15} />解锁</button>}
          <button className="primary" disabled={busy || !data} onClick={() => newAccount()}><Plus size={16} />添加</button>
        </div></div>
        {!modal && error ? <p className="auth-error" role="alert">{error}</p> : null}
        {Math.abs(offset.current) >= 30000 ? <p className="authenticator-warning"><Clock size={15} />设备与面板时间相差较大，验证码已按面板时间校准；请确认服务器时间准确。</p> : null}
        <div className="authenticator-list">
          <GuardSortableList items={items} records={accounts} order={order} scope={`${search}:${currentPage}:${unlocked}`} toast={toast} disabled={!unlocked || busy}
            onSaving={value => { if (value && (pending.current || !session.current)) return false; }}
            onReorder={body => request('/order', body, 'PUT')}>
            {item => <article className="authenticator-row"><div className="authenticator-identity"><span className="authenticator-service-icon"><ShieldCheck size={19} /></span><div><strong>{item.issuer}</strong><span>{item.account}</span>{item.note ? <small>{item.note}</small> : null}</div></div>
              <CodeDisplay config={unlocked && visible ? secrets.current.get(item.id) : null} now={now} toast={toast} currentTime={() => { ensureCurrent(); return Date.now() + offset.current; }} />
              <div className="authenticator-row-actions"><button className="ghost icon-button" disabled={!unlocked || busy} title="编辑" aria-label={`编辑 ${item.issuer}`} onClick={() => open({ type: 'edit', item: { ...item, secret: '' } })}><Pencil size={16} /></button><button className="ghost icon-button" disabled={!unlocked || busy} title="配置二维码" aria-label={`查看 ${item.issuer} 的配置二维码`} onClick={() => open({ type: 'reveal', item })}><QrCode size={17} /></button><button className="ghost icon-button danger-text-button" disabled={!unlocked || busy} title="删除" aria-label={`删除 ${item.issuer}`} onClick={() => open({ type: 'delete', item })}><Trash2 size={16} /></button></div>
            </article>}
          </GuardSortableList>
          {!items.length ? <div className="ops-empty"><ShieldCheck size={30} /><strong>{!data ? '正在加载验证器…' : search ? '没有匹配的验证器' : '暂无验证器'}</strong></div> : null}
        </div>
        {pages > 1 ? <div className="authenticator-pagination"><button className="ghost icon-button" title="上一页" aria-label="上一页" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button><span>{currentPage} / {pages} · {matched.length} 个</span><button className="ghost icon-button" title="下一页" aria-label="下一页" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button></div> : null}
    </> : <TemporaryGenerator key={temporaryEpoch} now={now} visible={visible} toast={toast} onSave={newAccount} currentTime={() => Date.now() + offset.current} />}
    </div>
    {modal?.type === 'unlock' ? <PasswordDialog Dialog={Dialog} title="解锁验证器" busy={busy} error={error} onClose={close} onSubmit={async password => { try { const result = await request('/unlock', { password }, 'POST', false); if (result) { setModal(modal.next ? { type: 'edit', item: { ...BASE, ...modal.next } } : null); setError(''); } } catch {} }} /> : null}
    {modal?.type === 'edit' ? <AccountEditor key={modal.item.id || 'new'} Dialog={Dialog} initial={modal.item} busy={busy} error={error} onClose={close} onSave={async item => { try { await request(item.id ? `/${item.id}` : '', item, item.id ? 'PUT' : 'POST'); setModal(null); toast('验证器已保存'); } catch {} }} /> : null}
    {modal?.type === 'delete' ? <Dialog title="删除验证器" className="authenticator-dialog" onClose={close} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={close}>取消</button><button className="primary danger-action" disabled={busy} onClick={async () => { try { await request(`/${modal.item.id}`, { revision: modal.item.revision }, 'DELETE'); setModal(null); toast('验证器已删除'); } catch {} }}>{busy ? '删除中…' : '确认删除'}</button></div>}><p className="confirm-copy">确认删除「{modal.item.issuer} · {modal.item.account}」？这不会关闭该网站的两步验证，请确保仍有其他验证方式。</p>{error ? <p className="auth-error" role="alert">{error}</p> : null}</Dialog> : null}
    {modal?.type === 'reveal' ? <RevealDialog key={modal.item.id} Dialog={Dialog} item={modal.item} request={request} busy={busy} error={error} onClose={close} /> : null}
    {modal?.type === 'settings' ? <SettingsDialog Dialog={Dialog} initial={modal.idleMinutes} request={request} busy={busy} error={error} onClose={close} onSave={() => { setModal(null); toast('设置已保存'); }} /> : null}
    {modal?.type === 'backup' ? <BackupDialog Dialog={Dialog} request={request} busy={busy} error={error} onClose={close} onImported={() => { setModal(null); toast('加密备份已导入'); }} /> : null}
  </section>;
}

function CodeDisplay({ config, now, toast, currentTime }) {
  const otp = useMemo(() => config ? createOtp(config) : null, [config]);
  const counter = Math.floor(now / ((config?.period || 30) * 1000));
  const code = useMemo(() => otp ? otp.generate({ timestamp: counter * otp.period * 1000 }) : '', [otp, counter]);
  const remaining = otpRemaining(config?.period || 30, now);
  return <div className={`authenticator-code ${remaining <= 5 ? 'expiring' : ''} ${!otp ? 'locked' : ''}`}><span className="authenticator-digits" aria-label={otp ? `验证码 ${code}` : '验证码已锁定'}>{code ? `${code.slice(0, code.length / 2)} ${code.slice(code.length / 2)}` : '••• •••'}</span><span className="authenticator-countdown" style={{ '--remaining': `${remaining / (config?.period || 30) * 100}%` }} title={otp ? `${remaining} 秒后更新` : '已锁定'}>{otp ? remaining : <LockKeyhole size={12} />}</span><button className="ghost icon-button" disabled={!otp} title="复制验证码" aria-label="复制验证码" onClick={async () => { try { await copyNoteText(otp.generate({ timestamp: currentTime() })); toast('验证码已复制'); } catch (err) { toast(err.message); } }}><Copy size={17} /></button></div>;
}

function SecretInput({ value, onChange, optional = false }) {
  const [reveal, setReveal] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState('');
  const upload = useRef(null), controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  return <div className="authenticator-secret-field"><label className="ops-field"><span>密钥 / otpauth 链接{optional ? '（留空保留原密钥）' : ' *'}</span><div className="authenticator-secret-input"><input required={!optional} type={reveal ? 'text' : 'password'} maxLength={4096} autoComplete="off" spellCheck={false} autoCapitalize="off" value={value} placeholder={optional ? '不修改密钥' : 'Base32 密钥或 otpauth://totp/…'} onChange={e => { controller.current?.abort(); setReading(false); onChange(e.target.value); setError(''); }} /><button className="ghost icon-button" type="button" title={reveal ? '隐藏密钥' : '显示密钥'} aria-label={reveal ? '隐藏密钥' : '显示密钥'} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
    <input ref={upload} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setReading(true); setError('');
      try { const text = await readAuthenticatorQr(file, abort.signal); parseOtpInput(text); if (!abort.signal.aborted) onChange(text); }
      catch (err) { if (!abort.signal.aborted) setError(err.message); }
      finally { if (!abort.signal.aborted) setReading(false); }
    }} /><button className="ghost authenticator-qr-upload" type="button" disabled={reading} onClick={() => upload.current?.click()}><QrCode size={16} />{reading ? '识别中…' : '从二维码图片导入'}</button>{error ? <p className="auth-error" role="alert">{error}</p> : null}
  </div>;
}

function Parameters({ value, onChange }) {
  return <details className="authenticator-advanced"><summary>高级参数 <span>{value.algorithm} · {value.digits} 位 · {value.period} 秒</span></summary><div className="authenticator-parameter-grid"><label className="ops-field"><span>算法</span><select value={value.algorithm} onChange={e => onChange({ algorithm: e.target.value })}>{['SHA1', 'SHA256', 'SHA512'].map(value => <option key={value}>{value}</option>)}</select></label><label className="ops-field"><span>验证码位数</span><select value={value.digits} onChange={e => onChange({ digits: Number(e.target.value) })}><option value={6}>6 位</option><option value={8}>8 位</option></select></label><label className="ops-field"><span>周期（秒）</span><input required type="number" min={15} max={120} value={value.period} onChange={e => onChange({ period: e.target.value })} /></label></div></details>;
}

function TemporaryGenerator({ now, visible, toast, onSave, currentTime }) {
  const [input, setInput] = useState(''), [params, setParams] = useState(OTP_DEFAULTS);
  const parsed = useMemo(() => { if (!input.trim()) return {}; try { return { config: parseOtpInput(input, params) }; } catch (err) { return { error: err.message }; } }, [input, params]);
  return <div className="authenticator-temporary">
    <header className="authenticator-temporary-head"><div className="authenticator-section-title"><span className="authenticator-temporary-icon"><Zap size={20} /></span><div><strong>临时生成验证码</strong><p>粘贴密钥或导入二维码，即刻获取验证码。</p></div></div><span className="authenticator-temporary-badge">不自动保存</span></header>
    <div className="authenticator-temporary-form"><SecretInput value={input} onChange={setInput} /><Parameters value={parsed.config || params} onChange={patch => { if (/^otpauth:/i.test(input.trim()) && parsed.config) { setParams({ ...parsed.config, ...patch }); setInput(parsed.config.secret); } else setParams(old => ({ ...old, ...patch })); }} />{parsed.error ? <p className="auth-error" role="alert">{parsed.error}</p> : null}<div className="authenticator-temporary-form-footer"><span>仅在当前页面生成</span><button className="ghost" disabled={!input} onClick={() => { setInput(''); setParams(OTP_DEFAULTS); }}><Trash2 size={15} />清空输入</button></div></div>
    <div className="authenticator-temporary-result"><span className="authenticator-temporary-result-label"><ShieldCheck size={16} />实时验证码</span><strong>{parsed.config?.issuer || (parsed.config ? '验证码已就绪' : '等待输入密钥')}</strong><span className="authenticator-temporary-account">{parsed.config?.account || (parsed.config ? '点击复制，直接使用' : '输入后自动生成，无需提交')}</span><div className="authenticator-temporary-code-area">{parsed.config ? <CodeDisplay config={visible ? parsed.config : null} now={now} toast={toast} currentTime={currentTime} /> : <span className="authenticator-digits authenticator-temporary-placeholder" aria-label="等待生成验证码">••• •••</span>}</div><p className="authenticator-temporary-cycle">{parsed.config ? `每 ${parsed.config.period} 秒自动更新` : '支持 6 / 8 位验证码'}</p><div className="authenticator-temporary-actions"><button className="primary" disabled={!parsed.config} onClick={() => onSave(parsed.config)}><Plus size={15} />保存到验证器</button></div></div>
  </div>;
}

function PasswordDialog({ Dialog, title, busy, error, onClose, onSubmit }) {
  const [password, setPassword] = useState('');
  return <Dialog title={title} className="authenticator-dialog" onClose={onClose} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" form="authenticator-password" disabled={busy}>{busy ? '验证中…' : '确认'}</button></div>}><form id="authenticator-password" className="authenticator-form" onSubmit={e => { e.preventDefault(); void onSubmit(password); }}><label className="ops-field"><span>面板登录密码</span><input required type="password" maxLength={1024} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>{error ? <p className="auth-error" role="alert">{error}</p> : null}</form></Dialog>;
}

function AccountEditor({ Dialog, initial, busy, error, onClose, onSave }) {
  const [item, setItem] = useState(initial), [localError, setLocalError] = useState('');
  const patch = value => { setItem(old => ({ ...old, ...value })); setLocalError(''); };
  const secret = value => {
    try { const parsed = parseOtpInput(value, item); patch({ secret: value, ...(/^otpauth:/i.test(value.trim()) ? { ...parsed, secret: value, issuer: item.issuer || parsed.issuer, account: item.account || parsed.account } : {}) }); }
    catch { patch({ secret: value }); }
  };
  return <Dialog title={item.id ? '编辑验证器' : '添加验证器'} className="authenticator-dialog" onClose={onClose} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" form="authenticator-account" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>}><form id="authenticator-account" className="authenticator-form" onSubmit={e => { e.preventDefault(); try { if (item.secret) parseOtpInput(item.secret, item); void onSave(item); } catch (err) { setLocalError(err.message); } }}>
    <SecretInput value={item.secret} onChange={secret} optional={Boolean(item.id)} /><div className="authenticator-name-grid"><label className="ops-field"><span>服务名称 *</span><input required maxLength={120} value={item.issuer} onChange={e => patch({ issuer: e.target.value })} placeholder="例如：Cloudflare" /></label><label className="ops-field"><span>账号名称 *</span><input required maxLength={200} value={item.account} onChange={e => patch({ account: e.target.value })} placeholder="例如：name@example.com" /></label></div><label className="ops-field"><span>备注</span><textarea maxLength={500} rows={2} value={item.note} onChange={e => patch({ note: e.target.value })} /></label><Parameters value={item} onChange={value => { if (/^otpauth:/i.test(item.secret.trim())) { try { patch({ ...parseOtpInput(item.secret), ...value }); } catch { patch(value); } } else patch(value); }} />{localError || error ? <p className="auth-error" role="alert">{localError || error}</p> : null}
  </form></Dialog>;
}

function RevealDialog({ Dialog, item, request, busy, error, onClose }) {
  const [image, setImage] = useState(''), [localError, setLocalError] = useState(''), [generating, setGenerating] = useState(false);
  const mounted = useRef(true), processing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!image) return <PasswordDialog Dialog={Dialog} title="查看配置二维码" busy={busy || generating} error={localError || error} onClose={onClose} onSubmit={async password => { if (processing.current) return; processing.current = true; setGenerating(true); try { const result = await request(`/${item.id}/reveal`, { password }); if (!mounted.current) return; const png = await authenticatorQr(result.item); if (mounted.current) setImage(png); } catch (err) { if (mounted.current && err.name !== 'AbortError') setLocalError(err.message); } finally { processing.current = false; if (mounted.current) setGenerating(false); } }} />;
  return <Dialog title={`${item.issuer} · 配置二维码`} className="authenticator-dialog" onClose={onClose}><div className="authenticator-qr-reveal"><img src={image} width={300} height={300} alt="验证器配置二维码" /><strong>{item.account}</strong><p>此二维码包含密钥，请勿分享给他人。</p></div></Dialog>;
}

function SettingsDialog({ Dialog, initial, request, busy, error, onClose, onSave }) {
  const [minutes, setMinutes] = useState(initial), [history, setHistory] = useState(null);
  return <Dialog title="验证器设置" className="authenticator-dialog" onClose={onClose} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" form="authenticator-settings" disabled={busy}>保存</button></div>}><form id="authenticator-settings" className="authenticator-form" onSubmit={async e => { e.preventDefault(); try { await request('/settings', { idleMinutes: Number(minutes) }, 'PUT'); onSave(); } catch {} }}><label className="ops-field"><span>无操作自动锁定（分钟）</span><input required type="number" min={1} max={30} value={minutes} onChange={e => setMinutes(e.target.value)} /></label>{error ? <p className="auth-error" role="alert">{error}</p> : null}</form><button className="ghost authenticator-history-button" disabled={busy} onClick={async () => { try { const result = await request('/history', undefined, 'GET'); setHistory(result.records); } catch {} }}><History size={16} />最近安全操作</button>{history ? <div className="authenticator-history">{history.map((event, i) => <div key={i}><span>{AUDIT[event.action] || '安全操作'}</span><time>{new Date(event.created_at).toLocaleString('zh-CN', { hour12: false })}</time></div>)}{!history.length ? <p>暂无记录</p> : null}</div> : null}</Dialog>;
}

function BackupDialog({ Dialog, request, busy, error, onClose, onImported }) {
  const [kind, setKind] = useState('export'), [password, setPassword] = useState(''), [passphrase, setPassphrase] = useState(''), [backup, setBackup] = useState(null), [name, setName] = useState(''), [localError, setLocalError] = useState('');
  const mounted = useRef(true), fileVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileVersion.current++; }; }, []);
  return <Dialog title="加密备份" className="authenticator-dialog" onClose={onClose} footer={<div className="dialog-actions"><button className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" form="authenticator-backup" disabled={busy || (kind === 'import' && !backup)}>{busy ? '处理中…' : kind === 'export' ? '导出加密文件' : '导入'}</button></div>}><div className="authenticator-backup-tabs" role="tablist" aria-label="备份方式">{[['export', '导出', Download], ['import', '导入', Upload]].map(([key, label, Icon]) => <button key={key} className={kind === key ? 'active' : ''} role="tab" aria-selected={kind === key} disabled={busy} onClick={() => { fileVersion.current++; setKind(key); setBackup(null); setName(''); setPassword(''); setPassphrase(''); setLocalError(''); }}><Icon size={16} />{label}</button>)}</div><form id="authenticator-backup" className="authenticator-form" onSubmit={async e => {
    e.preventDefault(); setLocalError('');
    try {
      if (kind === 'import') { await request('/import', { backup, passphrase }); if (mounted.current) onImported(); }
      else {
        const result = await request('/export', { password, passphrase }); if (!mounted.current) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `nurossh-authenticator-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setPassword(''); setPassphrase('');
      }
    } catch (err) { if (mounted.current && err.name !== 'AbortError') setLocalError(err.message); }
  }}>
    {kind === 'import' ? <label className="ops-field"><span>加密备份文件</span><input type="file" disabled={busy} accept=".json,application/json" onChange={async e => { const version = ++fileVersion.current, file = e.target.files?.[0]; setBackup(null); setName(''); if (!file) return; if (file.size > 2000000) { setLocalError('备份文件过大'); return; } try { const value = JSON.parse(await file.text()); if (!mounted.current || fileVersion.current !== version) return; if (value?.format !== 'nurossh-authenticator' || value.version !== 1) throw Error('仅支持验证器加密备份'); setBackup(value); setName(file.name); setLocalError(''); } catch (err) { if (mounted.current && fileVersion.current === version) setLocalError(err.message); } }} />{name ? <small>{name}</small> : null}</label> : <label className="ops-field"><span>面板登录密码</span><input required type="password" maxLength={1024} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>}
    <label className="ops-field"><span>{kind === 'export' ? '设置备份密码（至少 12 个字符）' : '备份密码'}</span><input required type="password" minLength={12} maxLength={1024} autoComplete="off" value={passphrase} onChange={e => setPassphrase(e.target.value)} /></label><p className="authenticator-backup-warning">{kind === 'export' ? '请妥善保管备份密码，遗失后无法恢复。文件只包含加密数据。' : '导入将新增验证器，不覆盖现有账号；重复密钥会拒绝整次导入。'}</p>{localError || error ? <p className="auth-error" role="alert">{localError || error}</p> : null}
  </form></Dialog>;
}

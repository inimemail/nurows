import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, Link, LoaderCircle, RefreshCw, Terminal } from 'lucide-react';
import { copyNoteText } from './note-clipboard.js';

const quote = text => `'${text.replace(/'/g, "'\\''")}'`;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无';

export default function PoolExternalAccessDialog({ pool, api, toast, Dialog, onChange, onClose }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const [example, setExample] = useState('batch');
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const actionPending = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const base = `/api/ip-pools/${encodeURIComponent(pool.id)}/external-access`;

  useEffect(() => {
    const current = ++request.current;
    const controller = new AbortController();
    setBusy('loading'); setError(''); setData(null); setVisible(false); setConfirmRotate(false);
    api(base, { signal: controller.signal }).then(next => {
      if (request.current !== current) return;
      setData(next); onChangeRef.current(next.access);
    }).catch(err => { if (request.current === current) setError(err.message); })
      .finally(() => { if (request.current === current) setBusy(''); });
    return () => { request.current++; controller.abort(); };
  }, [api, base, reload]);

  const mutate = async (action, enabled) => {
    if (actionPending.current || busy) return;
    actionPending.current = true;
    const current = ++request.current;
    setBusy(action); setError('');
    try {
      const next = await api(action === 'rotate' ? `${base}/rotate-token` : base,
        action === 'rotate' ? { method: 'POST' } : { method: 'PUT', body: JSON.stringify({ enabled }) });
      if (request.current !== current) return;
      setData(previous => ({ ...previous, ...next }));
      onChangeRef.current(next.access); setConfirmRotate(false);
      if (action === 'rotate') { setVisible(false); toast('密钥已轮换，旧密钥立即失效'); }
      else toast(enabled ? '本池外部调用已启用' : '本池外部调用已停用');
    } catch (err) {
      if (request.current === current) {
        setError(err.message);
        // A lost rotation response may have invalidated the displayed key.
        // Read back the current credential before offering another copy.
        if (action === 'rotate') { setData(null); setVisible(false); setConfirmRotate(false); }
      }
    }
    finally { if (request.current === current) setBusy(''); actionPending.current = false; }
  };

  const copy = async value => {
    try { await copyNoteText(value); toast('已复制'); }
    catch (err) { toast(err.message); }
  };
  const access = data?.access;
  const endpoint = data ? new URL(data.path, window.location.origin).href : '';
  const commands = token => {
    const header = `  -H ${quote(`Authorization: Bearer ${token}`)}`;
    const start = `curl --fail-with-body -sS -X POST ${quote(endpoint)} \\\n${header} \\\n`;
    if (example === 'text') return start + "  -H 'Content-Type: text/plain' \\\n  --data-binary @ips.txt";
    const body = example === 'single' ? { ip: '192.0.2.10' } : { ips: ['192.0.2.10', '192.0.2.11', '2001:db8::1'] };
    return start + "  -H 'Content-Type: application/json' \\\n  -d " + quote(JSON.stringify(body));
  };

  return <Dialog title={`外部调用 · ${pool.name}`} wide className="pool-external-dialog" onClose={onClose}
    footer={<><span className="pool-external-footer-note">仅向当前备用池追加 IP</span><button className="primary" onClick={onClose}>完成</button></>}>
    <div className="pool-external-content">
      <div className="pool-external-intro"><span className="pool-external-icon"><Link size={21} /></span><div><strong>让脚本直接补充备用 IP</strong><span>本池独立接口与密钥，单个或批量提交均可。</span></div></div>
      {busy === 'loading' ? <div className="pool-external-loading" role="status"><LoaderCircle size={18} className="pool-external-spinner" />正在读取调用配置…</div> : null}
      {data ? <>
        <div className="pool-external-status"><div><span className={`pool-external-badge ${access.externalApiEnabled ? 'enabled' : ''}`}><span />{access.externalApiEnabled ? '外部调用已启用' : '外部调用已停用'}</span><small>独立于备用池的分配开关</small></div><button className="ghost" disabled={Boolean(busy)} onClick={() => mutate('toggle', !access.externalApiEnabled)}>{busy === 'toggle' ? '保存中…' : access.externalApiEnabled ? '停用调用' : '启用调用'}</button></div>
        <div className="pool-external-fields">
          <div className="pool-external-field"><label htmlFor="pool-external-endpoint">调用地址 <span>POST</span></label><div><input id="pool-external-endpoint" aria-label="调用地址" readOnly value={endpoint} /><button className="icon-button" aria-label="复制调用地址" onClick={() => copy(endpoint)}><Copy size={16} /></button></div></div>
          <div className="pool-external-field"><label htmlFor="pool-external-token"><span className="pool-external-label"><KeyRound size={14} />本池调用密钥</span></label><div><input id="pool-external-token" aria-label="本池调用密钥" type={visible ? 'text' : 'password'} readOnly autoComplete="off" value={data.token} /><button className="icon-button" aria-label={visible ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button><button className="icon-button" aria-label="复制调用密钥" disabled={Boolean(busy)} onClick={() => copy(data.token)}><Copy size={16} /></button></div></div>
        </div>
        <section className="pool-external-examples" aria-label="调用示例">
          <div className="pool-external-example-head"><strong><Terminal size={16} />调用示例</strong><button className="ghost" disabled={Boolean(busy)} onClick={() => copy(commands(data.token))}><Copy size={14} />复制命令</button></div>
          <div className="pool-external-tabs" role="group" aria-label="示例格式">{[['single', '单个 IP'], ['batch', '多个 IP'], ['text', '文本文件']].map(([key, label]) => <button key={key} aria-pressed={example === key} className={example === key ? 'active' : ''} onClick={() => setExample(key)}>{label}</button>)}</div>
          <pre>{commands(visible ? data.token : '<本池调用密钥>')}</pre>
          <span className="pool-external-help">复制命令会自动带入当前密钥。{example === 'text' ? 'ips.txt 每行一个 IP，也支持空格、逗号分隔。' : '把示例地址替换为实际 IP 即可。'}</span>
        </section>
        <div className="pool-external-rules"><Check size={15} /><span>只追加、不覆盖，重复 IP 自动去重，支持 IPv4 / IPv6；任一地址无效时整批不入库。单次及池内最多 5000 个 IP，检测沿用本池探针。</span></div>
        <div className="pool-external-meta"><span>密钥更新 <b>{time(access.externalTokenUpdatedAt)}</b></span><span>最近调用 <b>{time(pool.externalLastUsedAt || access.externalLastUsedAt)}</b></span></div>
        <div className="pool-external-rotation"><div><strong>轮换调用密钥</strong><span>接口地址保持不变，轮换后请更新外部脚本中的密钥。</span></div><button className="ghost" disabled={Boolean(busy)} onClick={() => setConfirmRotate(true)}><RefreshCw size={14} />轮换密钥</button></div>
        {confirmRotate ? <div className="pool-external-confirm" role="alert"><strong>确认轮换？旧密钥将立即失效。</strong><div><button className="ghost" disabled={Boolean(busy)} onClick={() => setConfirmRotate(false)}>取消</button><button className="primary" disabled={Boolean(busy)} onClick={() => mutate('rotate')}>{busy === 'rotate' ? '轮换中…' : '确认轮换'}</button></div></div> : null}
      </> : null}
      {error ? <div className="pool-external-error" role="alert">{error}<button className="ghost" disabled={Boolean(busy)} onClick={() => setReload(value => value + 1)}>重新读取</button></div> : null}
    </div>
  </Dialog>;
}

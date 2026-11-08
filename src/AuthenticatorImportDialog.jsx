import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, QrCode, ShieldCheck, Trash2, X } from 'lucide-react';
import { OTP_MAX_ACCOUNTS } from '../shared/authenticator.js';
import { addAuthenticatorImport, parseAuthenticatorImport } from '../shared/authenticator-migration.js';
import { readAuthenticatorQr, scanAuthenticatorCamera } from './authenticator-qr.js';

const EMPTY = () => ({ batch: null, frames: [], accounts: [], unsupported: [] });
export default function AuthenticatorImportDialog({ Dialog, existing, busy, error, request, onClose, onImported }) {
  const [data, setData] = useState(EMPTY), [selected, setSelected] = useState(new Set()), [localError, setError] = useState('');
  const [reading, setReading] = useState(false), [camera, setCamera] = useState(false), [progress, setProgress] = useState('');
  const state = useRef(data), upload = useRef(null), video = useRef(null), reader = useRef(null), alive = useRef(true), processing = useRef(false);
  const known = useMemo(() => new Set(existing.map(item => item.secret)), [existing]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; reader.current?.abort(); state.current = EMPTY(); }; }, []);
  function accept(text) {
    const previous = state.current, next = addAuthenticatorImport(previous, parseAuthenticatorImport(text));
    if (next === previous) return;
    state.current = next; setData(next);
    const old = new Set(previous.accounts.map(item => item.secret));
    setSelected(current => { const value = new Set(current); for (const item of next.accounts) if (!old.has(item.secret) && !known.has(item.secret)) value.add(item.secret); return value; });
    setError('');
  }
  useEffect(() => {
    if (!camera) return;
    const controller = new AbortController();
    void scanAuthenticatorCamera(video.current, text => {
      if (!controller.signal.aborted && !processing.current) try { accept(text); } catch (err) { setError(err.message); }
    }, err => { if (!controller.signal.aborted) { setError(err.message); setCamera(false); } }, controller.signal)
      .catch(() => { if (!controller.signal.aborted) { setError('无法打开摄像头，请允许摄像头权限或选择二维码图片'); setCamera(false); } });
    return () => controller.abort();
  }, [camera]);
  const complete = !data.batch || data.frames.length === data.batch.size;
  const candidates = data.accounts.filter(item => !known.has(item.secret));
  const chosen = candidates.filter(item => selected.has(item.secret));
  const remaining = Math.max(0, OTP_MAX_ACCOUNTS - known.size), overCapacity = chosen.length > remaining;
  async function files(event) {
    const list = Array.from(event.target.files || []); event.target.value = '';
    if (!list.length || processing.current) return;
    if (list.length > 32) { setError('每次最多选择 32 张二维码图片，可分多次添加'); return; }
    processing.current = true; setCamera(false); setReading(true); setError('');
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller;
    let failed = 0, lastFailure = '';
    try {
      for (let i = 0; i < list.length && !controller.signal.aborted; i++) {
        setProgress(`正在识别 ${i + 1}/${list.length} 张`);
        try { const text = await readAuthenticatorQr(list[i], controller.signal); if (!controller.signal.aborted) accept(text); }
        catch (err) { if (!controller.signal.aborted) { failed++; lastFailure = `第 ${i + 1} 张：${err.message}`; setError(lastFailure); } }
      }
    } finally {
      processing.current = false;
      if (alive.current && !controller.signal.aborted) { setReading(false); if (failed) setError(`${failed} 张未成功识别。${lastFailure}`); setProgress(failed ? `${failed} 张未导入，可重新选择图片` : '图片识别完成'); }
    }
  }
  async function save() {
    if (processing.current || busy || !complete || !chosen.length || overCapacity) return;
    processing.current = true; setCamera(false); setError('');
    try { const result = await request('/import-batch', { accounts: chosen }); if (alive.current) onImported(result); }
    catch {} finally { processing.current = false; }
  }
  return <Dialog title="批量导入验证器" className="authenticator-dialog authenticator-import-dialog" onClose={() => !busy && onClose()} footer={<div className="authenticator-import-footer"><span>{chosen.length} 个待导入{known.size ? ' · 已存在的密钥自动跳过' : ''}</span><div className="dialog-actions"><button className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || reading || !complete || !chosen.length || overCapacity} onClick={save}>{busy ? '导入中…' : `导入 ${chosen.length} 个账号`}</button></div></div>}>
    <div className="authenticator-import-intro"><span><QrCode size={22} /></span><div><strong>从谷歌验证器迁移</strong><p>谷歌验证器 → 转移账号 → 导出账号，勾选需要的账号后扫描二维码。</p></div></div>
    <input hidden ref={upload} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={files} />
    <div className="authenticator-import-tools"><button className="ghost" disabled={busy || reading} onClick={() => upload.current?.click()}><ImagePlus size={17} />选择二维码图片</button><button className={`ghost ${camera ? 'active' : ''}`} disabled={busy || reading} onClick={() => { setError(''); setCamera(value => !value); }}><Camera size={17} />{camera ? '停止扫码' : '摄像头扫码'}</button></div>
    {camera ? <div className="authenticator-import-camera"><video ref={video} muted playsInline aria-label="二维码扫描预览" /><button className="ghost icon-button" aria-label="关闭摄像头" onClick={() => setCamera(false)}><X size={17} /></button><span>对准二维码，可连续扫描多张</span></div> : null}
    <div className="authenticator-import-summary" role="status"><span>{data.batch ? `已读取 ${data.frames.length}/${data.batch.size} 张 · ${data.accounts.length} 个账号` : reading ? progress : data.accounts.length ? `已识别 ${data.accounts.length} 个账号` : '支持谷歌批量迁移二维码和普通单账号二维码'}</span>{data.accounts.length || data.unsupported.length ? <button className="ghost" disabled={busy || reading} onClick={() => { setCamera(false); const empty = EMPTY(); state.current = empty; setData(empty); setSelected(new Set()); setError(''); setProgress(''); }}><Trash2 size={14} />清空</button> : null}</div>
    {!complete ? <p className="authenticator-import-hint">还差 {data.batch.size - data.frames.length} 张二维码，请继续扫描同一批次。</p> : null}
    {data.accounts.length ? <><label className="authenticator-import-select"><input type="checkbox" disabled={busy || reading || !candidates.length} checked={Boolean(candidates.length) && chosen.length === candidates.length} onChange={e => setSelected(new Set(e.target.checked ? candidates.map(item => item.secret) : []))} />全选可导入账号<span>{chosen.length}/{candidates.length}</span></label><div className="authenticator-import-list">{data.accounts.map((item, index) => { const duplicate = known.has(item.secret); return <label className={`authenticator-import-row ${duplicate ? 'duplicate' : ''}`} key={index}><input type="checkbox" disabled={busy || reading || duplicate} checked={!duplicate && selected.has(item.secret)} onChange={e => setSelected(current => { const value = new Set(current); e.target.checked ? value.add(item.secret) : value.delete(item.secret); return value; })} /><span><strong>{item.issuer}</strong><small>{item.account}</small></span><em>{duplicate ? '已存在' : `${item.digits} 位 · ${item.algorithm}`}</em></label>; })}</div></> : !data.unsupported.length ? <div className="authenticator-import-empty"><ShieldCheck size={27} /><span>选择图片或扫码后，在这里确认导入账号</span></div> : null}
    {data.unsupported.length ? <div className="authenticator-import-unsupported">{data.unsupported.map((item, i) => <p key={i}>{item.issuer} · {item.account}：{item.error}</p>)}</div> : null}
    {overCapacity ? <p className="authenticator-import-hint">最多保存 {OTP_MAX_ACCOUNTS} 个验证器，还可添加 {remaining} 个，请取消部分勾选。</p> : null}
    {localError || error ? <p className="auth-error" role="alert">{localError || error}</p> : null}
    <p className="authenticator-import-privacy"><ShieldCheck size={14} />二维码在本机识别，确认后加密保存；不向外部识别网站发送密钥。</p>
  </Dialog>;
}

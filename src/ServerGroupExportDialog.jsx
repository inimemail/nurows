import { useEffect, useMemo, useState } from 'react';
import { Search, Server, FileText, List, Copy, Download, LoaderCircle, Check } from 'lucide-react';
import { filterPickerServers } from '../shared/server-picker-search.js';
import { copyNoteText } from './note-clipboard.js';
import Dialog from './Dialog.jsx';

export default function ServerGroupExportDialog({ group, servers, api, toast, onClose }) {
  const members = useMemo(() => servers.filter(server => server.groupId === group.id), [servers, group.id]);
  const [selectedIds, setSelectedIds] = useState(() => members.map(server => server.id));
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('import');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const selected = new Set(selectedIds);
  const ids = members.filter(server => selected.has(server.id)).map(server => server.id);
  const visible = filterPickerServers(members, query);
  const requestKey = JSON.stringify([group.id, group.name, mode, ids]);
  const ready = result?.key === requestKey;
  const failed = error?.key === requestKey;
  const text = ready ? result.text : '';
  const loading = ids.length > 0 && !ready && !failed;

  useEffect(() => {
    if (!ids.length) return;
    const controller = new AbortController();
    setError(null);
    api(`/api/groups/${encodeURIComponent(group.id)}/export`, {
      method: 'POST', body: JSON.stringify({ serverIds: ids, mode }), signal: controller.signal
    }).then(data => {
      if (!controller.signal.aborted) setResult({ key: requestKey, text: data.text, count: data.count });
    }).catch(err => {
      if (!controller.signal.aborted) setError({ key: requestKey, message: err.message });
    });
    return () => controller.abort();
  }, [api, requestKey, retry]);

  const toggle = id => setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const selectVisible = () => setSelectedIds(current => [...new Set([...current, ...visible.map(server => server.id)])]);
  const invertVisible = () => setSelectedIds(current => {
    const next = new Set(current);
    for (const server of visible) { if (next.has(server.id)) next.delete(server.id); else next.add(server.id); }
    return [...next];
  });
  const copy = async () => {
    if (!ready || !text) return;
    try { await copyNoteText(text); toast(`已复制 ${result.count} 台服务器${mode === 'ip' ? '的 IP' : '的导入内容'}`); }
    catch (err) { toast(err.message); }
  };
  const download = () => {
    if (!ready || !text) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.name.replace(/[\\/:*?"<>|]/g, '_')}-${mode === 'ip' ? 'IP' : '服务器'}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <Dialog title={`导出服务器 · ${group.name}`} wide className="server-export-dialog" onClose={onClose}
    footer={<><span className="server-export-summary"><span className="server-export-summary-icon"><Check size={14} /></span>已选 <strong>{ids.length}</strong> / {members.length} 台服务器</span><div className="dialog-actions"><button className="ghost" onClick={onClose}>关闭</button><button className="ghost" disabled={!text} onClick={download}><Download size={15} />下载 TXT</button><button className="primary" disabled={!text} onClick={copy}><Copy size={15} />复制内容</button></div></>}>
    <div className="server-export-layout">
      <section className="server-export-selection" aria-label="选择导出服务器">
        <div className="server-export-section-head"><div><span className="server-export-step">01</span><strong>选择服务器</strong></div><span className="server-export-count">{members.length} 台</span></div>
        <div className="server-export-search"><Search size={16} /><input aria-label="搜索导出服务器" placeholder="搜索名称 / IP，空格分隔多项" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="server-export-tools"><span>{query.trim() ? `搜索到 ${visible.length} 台` : `本组 ${members.length} 台`}</span><button className="ghost" disabled={!visible.length} onClick={selectVisible}>全选</button><button className="ghost" disabled={!visible.length} onClick={invertVisible}>反选</button><button className="ghost" disabled={!ids.length} onClick={() => setSelectedIds([])}>清空</button></div>
        <div className="server-export-list">{visible.map(server => <label key={server.id} className={selected.has(server.id) ? 'selected' : ''}><input type="checkbox" checked={selected.has(server.id)} onChange={() => toggle(server.id)} /><span className="server-export-server-icon"><Server size={17} /></span><span className="server-export-server-copy"><strong>{server.name}</strong><code>{server.host}</code></span><span className="server-export-port">:{server.port}</span></label>)}{!visible.length ? <div className="server-export-empty"><Server size={28} /><strong>{members.length ? '没有匹配的服务器' : '本组暂无服务器'}</strong><span>{members.length ? '试试其他名称或 IP' : '添加服务器后即可导出'}</span></div> : null}</div>
        <small className="server-export-hint">全选、反选仅操作搜索结果，隐藏的已选项会保留。</small>
      </section>
      <section className="server-export-output" aria-label="导出内容">
        <div className="server-export-section-head"><div><span className="server-export-step">02</span><strong>格式与预览</strong></div><span className="server-export-live"><span />随选择更新</span></div>
        <div className="server-export-formats" role="group" aria-label="导出格式">
          <button data-export-mode="import" className={mode === 'import' ? 'active' : ''} aria-pressed={mode === 'import'} onClick={() => setMode('import')}><FileText size={20} /><span><strong>导入格式</strong><small>完整信息 · 含密码</small></span><span className="server-export-format-check">{mode === 'import' ? <Check size={12} /> : null}</span></button>
          <button data-export-mode="ip" className={mode === 'ip' ? 'active' : ''} aria-pressed={mode === 'ip'} onClick={() => setMode('ip')}><List size={20} /><span><strong>仅 IP</strong><small>一行一个地址</small></span><span className="server-export-format-check">{mode === 'ip' ? <Check size={12} /> : null}</span></button>
        </div>
        <div className="server-export-preview">
          <div className="server-export-preview-head"><span>{mode === 'import' ? '导入内容' : 'IP 列表'}</span><span>{loading ? <><LoaderCircle size={12} className="server-export-spinner" />生成中</> : text ? `${result.count} 行` : '暂无内容'}</span></div>
          <textarea aria-label="导出文本" readOnly spellCheck={false} value={text} placeholder={loading ? '正在生成导出内容…' : ids.length ? '导出内容显示在这里' : '选择左侧服务器，即可生成导出内容'} />
        </div>
        <span className="server-export-hint">{mode === 'import' ? '名称 IP 端口 用户名 密码 分组，可直接复制到批量导入。' : '仅导出服务器地址，每行一个。'}</span>
        {failed ? <div className="server-export-error" role="alert"><span>{error.message}</span><button className="ghost" onClick={() => { setError(null); setRetry(value => value + 1); }}>重试</button></div> : null}
      </section>
    </div>
  </Dialog>;
}

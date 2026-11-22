import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Layers, LoaderCircle, Check, Copy, ArrowRight, SlidersHorizontal } from 'lucide-react';
import { DNS_GUARD_BATCH_ACTIONS, DNS_GUARD_BATCH_SETTINGS, dnsGuardBatchLabel } from '../shared/dns-guard-batch.js';
import { dnsGuardOrder } from '../shared/dns-guard-order.js';
import { startPolling } from '../shared/polling.js';
import { copyNoteText } from './note-clipboard.js';

const STATUS = {queued:'排队',preparing:'读取中',ready:'待确认',unchanged:'无需修改',skipped:'已跳过',applying:'执行中',succeeded:'已完成',pending:'待确认远程结果',failed:'失败',canceled:'已取消'};
const SOURCE_ACTIONS = ['sources_add','sources_replace'];
const ACTIVE_JOBS = ['preparing','applying','recovering'];
const RULE_PAGE_SIZE=40,RESULT_PAGE_SIZE=20;
const keyOf = value => JSON.stringify(value);
function describe(value, state) {
  if (Array.isArray(value)) return value.join('\n') || '无 IP';
  if (typeof value === 'string') return value;
  if (!value) return '';
  return Object.entries(value).map(([key,val]) => {
    if (key === 'sources') return `来源：${val.length ? val.map(source => `${source.domain}${source.backupDomain ? ` → 备 ${source.backupDomain}` : ''}${source.name ? `（${source.name}）` : ''}`).join('；') : '无'}`;
    if (key === 'sourcesEnabled') return `域名来源：${val ? '启用' : '禁用'}`;
    if (key === 'enabled') return `守护任务：${val ? '启用' : '停用'}`;
    const ref = {probeIds:['探针',state.probes],poolIds:['备用池',state.ipPools],alertBotIds:['通知机器人',state.telegramBots]}[key];
    if (ref) return `${ref[0]}：${val.map(id=>ref[1]?.find(item=>item.id===id)?.name||id).join('、')||'无'}`;
    return `${DNS_GUARD_BATCH_SETTINGS.find(([id])=>id===key)?.[1]||key}：${val??'默认'}`;
  }).join('\n');
}
function difference(row,state) {
  if(!row.before||Array.isArray(row.before)||typeof row.before==='string')return [describe(row.before,state),describe(row.after,state)];
  const keys=Object.keys(row.before).filter(key=>keyOf(row.before[key])!==keyOf(row.after?.[key]));
  return [row.before,row.after].map(value=>describe(Object.fromEntries(keys.map(key=>[key,value[key]])),state));
}

export default function DnsGuardBatchDialog({state,api,toast,Dialog,onClose,onFinished,initialQuery='',open=true}) {
  const [selected,setSelected]=useState([]),[query,setQuery]=useState(initialQuery);
  const [action,setAction]=useState('ips_add'),[text,setText]=useState('');
  const [enabled,setEnabled]=useState(false),[perRule,setPerRule]=useState(false);
  const [refField,setRefField]=useState('probeIds'),[refMode,setRefMode]=useState('add'),[refIds,setRefIds]=useState([]);
  const [setting,setSetting]=useState('interval'),[settingValue,setSettingValue]=useState(30);
  const [job,setJob]=useState(null),[planKey,setPlanKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [rulePage,setRulePage]=useState(1),[resultPage,setResultPage]=useState(1);
  const pending=useRef(false),mounted=useRef(true),completed=useRef('');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const guards=useMemo(()=>{
    const records=state.dnsGuards||[],byId=new Map(records.map(guard=>[guard.id,guard]));
    return dnsGuardOrder(records,state.dnsGuardOrder||[]).map(id=>byId.get(id));
  },[state.dnsGuards,state.dnsGuardOrder]);
  const selectedSet=useMemo(()=>new Set(selected),[selected]);
  const ids=useMemo(()=>guards.filter(guard=>selectedSet.has(guard.id)).map(guard=>guard.id),[guards,selectedSet]);
  const searchIndex=useMemo(()=>open?guards.map(guard=>({guard,text:[guard.name,guard.domain,guard.recordType,...(guard.sources||[]).flatMap(source=>[source.name,source.domain,source.backupDomain])].join(' ').toLowerCase()})):[],[guards,open]);
  const visible=useMemo(()=>{
    const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length?searchIndex.filter(item=>terms.every(term=>item.text.includes(term))).map(item=>item.guard):guards;
  },[guards,searchIndex,query]);
  const rulePages=Math.max(1,Math.ceil(visible.length/RULE_PAGE_SIZE)),currentRulePage=Math.min(rulePage,rulePages);
  const pageGuards=visible.slice((currentRulePage-1)*RULE_PAGE_SIZE,currentRulePage*RULE_PAGE_SIZE);
  const resultPages=Math.max(1,Math.ceil((job?.rows.length||0)/RESULT_PAGE_SIZE)),currentResultPage=Math.min(resultPage,resultPages);
  const pageResults=useMemo(()=>open?(job?.rows||[]).slice((currentResultPage-1)*RESULT_PAGE_SIZE,currentResultPage*RESULT_PAGE_SIZE).map(row=>({row,diff:difference(row,state)})):[],[job,currentResultPage,state.probes,state.ipPools,state.telegramBots,open]);
  const payload={ids,action,...(['ips_add','ips_remove','sources_add','sources_remove','sources_replace','sources_map'].includes(action)?{text}:{}),
    ...(['sources_enabled','enabled'].includes(action)?{enabled}:{}),
    ...(SOURCE_ACTIONS.includes(action)?{perRule}:{}),
    ...(action==='references'?{field:refField,mode:refMode,values:refIds}:{}),
    ...(action==='settings'?{field:setting,value:settingValue}:{})};
  const requestKey=keyOf(payload);
  const working=busy||ACTIVE_JOBS.includes(job?.status);
  const actionable=job?.status==='ready'&&planKey===requestKey&&job.rows.some(row=>row.status==='ready');
  const failedIds=job?.rows.filter(row=>['failed','skipped'].includes(row.status)).map(row=>row.id)||[];
  const callbacks=useRef({onFinished,onClose,toast});callbacks.current={onFinished,onClose,toast};
  useEffect(()=>{
    if(!open&&!working&&(!job||job.status==='ready'||(job.status==='done'&&job.rows.every(row=>['succeeded','unchanged'].includes(row.status))))){
      setJob(null);setPlanKey('');setText('');setError('');setResultPage(1);
    }
  },[open,working,job]);

  useEffect(()=>{
    if(!job||!ACTIVE_JOBS.includes(job.status))return;
    return startPolling(async signal=>{
      const next=await api(`/api/dns-guards/batch/${encodeURIComponent(job.id)}`,{signal});
      if(mounted.current&&!signal.aborted){setJob(next);setError('');}
    },1200,{onError:err=>{
      if(!mounted.current)return;
      setError(err.message);
      if(err.status===404){setJob(null);setPlanKey('');}
    }});
  },[api,job?.id,job?.status]);
  useEffect(()=>{
    if(job?.status==='done'&&completed.current!==job.id){
      completed.current=job.id;
      callbacks.current.onFinished?.();
      const clean=job.rows.every(row=>['succeeded','unchanged'].includes(row.status));
      callbacks.current.toast(clean?`操作完成：成功 ${job.counts.succeeded||0} 条${job.counts.unchanged?`，无需修改 ${job.counts.unchanged} 条`:''}`:'操作已结束，部分规则未完成，请查看逐条结果');
      if(clean)callbacks.current.onClose();
    }
  },[job?.id,job?.status]);
  const command=async kind=>{
    if(kind==='apply'&&(!actionable||working))return;
    if(pending.current)return;pending.current=true;setBusy(true);setError('');
    try {
      const previewing=kind==='preview';
      const next=await api(previewing?'/api/dns-guards/batch/preview':`/api/dns-guards/batch/${encodeURIComponent(job.id)}/${kind}`,
        {method:'POST',body:JSON.stringify(previewing?payload:kind==='apply'?{confirm:'apply-dns-guard-batch'}:{})});
      if(!mounted.current)return;
      if(previewing){setPlanKey(requestKey);setResultPage(1);}
      setJob(next);
    }catch(err){
      if(mounted.current){
        setError(err.message);
        if(kind!=='preview'&&err.status===404){setJob(null);setPlanKey('');}
        else if(kind==='apply')setJob(current=>current?.id===job.id?{...current,status:'recovering'}:current);
      }
    }
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const copySources=async()=>{
    const rows=guards.filter(guard=>selectedSet.has(guard.id)).flatMap(guard=>(guard.sources||[]).map(source=>`${guard.domain}#${guard.id} | ${source.domain} | ${source.backupDomain||'-'} | ${(source.name||'').replace(/[\r\n]+/g,' ')}`));
    try{await copyNoteText(rows.join('\n'));if(mounted.current)setPerRule(true);toast('已复制，已切换为逐条填写；保留域名后的规则标识即可准确匹配');}catch(err){toast(err.message);}
  };
  const refs={probeIds:state.probes,poolIds:state.ipPools,alertBotIds:state.telegramBots}[refField]||[];
  const summary=job?`${job.rows.length} 条 · 待确认 ${job.counts.ready||0} · 完成 ${job.counts.succeeded||0} · 跳过 ${job.counts.skipped||0} · 失败 ${job.counts.failed||0}${job.counts.pending?` · 待核对 ${job.counts.pending}`:''}`:'';
  const progress=busy?'提交中…':job?.status==='preparing'?'准备中…':job?.status==='recovering'?'核对执行结果…':job?.status==='applying'?`执行中 ${job.counts.succeeded||0} / ${job.rows.length}`:'';

  if(!open)return null;
  return <Dialog title="DNS 守护 · 高级操作" xwide className="guard-batch-dialog" onClose={onClose}
    footer={<><span className="guard-batch-footer"><Check size={15}/>已选 <b>{ids.length}</b> / {guards.length} 条规则</span><div className="dialog-actions"><button className="ghost" onClick={onClose}>关闭</button>{job?.status==='applying'?<button className="ghost" disabled={busy||job.cancelRequested} onClick={()=>command('cancel')}>停止后续操作</button>:null}<button className="ghost" disabled={working||!ids.length} onClick={()=>command('preview')}>预览更改</button><button className="primary" disabled={!actionable||working} onClick={()=>command('apply')}>{progress||`确认执行 ${actionable?job.counts.ready:''}`}</button></div></>}>
    <div className="guard-batch-intro"><span><Layers size={20}/></span><div><strong>一次选择，逐条核对后执行</strong><p>预览只显示变化，点击“确认执行”后才会生效。全部成功后自动关闭；有未完成项会保留结果。远程 DNS 写入最多等待 30 秒。</p></div></div>
    <div className="guard-batch-layout">
      <section className="guard-batch-picker" aria-label="选择守护规则"><div className="guard-batch-section-head"><strong>01 选择规则</strong><span>{visible.length} 条匹配 · 已选 {ids.length}</span></div>
        <div className="guard-batch-search"><Search size={16}/><input aria-label="搜索守护规则" placeholder="搜索名称、域名、DDNS 来源" value={query} disabled={working} onChange={event=>{setQuery(event.target.value);setRulePage(1);}}/></div>
        <div className="guard-batch-select-tools"><button className="ghost" disabled={working} onClick={()=>setSelected(current=>[...new Set([...current,...visible.map(guard=>guard.id)])])}>全选搜索结果</button><button className="ghost" disabled={working} onClick={()=>setSelected(current=>{const next=new Set(current);for(const guard of visible){if(next.has(guard.id))next.delete(guard.id);else next.add(guard.id);}return [...next];})}>反选</button><button className="ghost" disabled={working} onClick={()=>setSelected([])}>清空</button></div>
        <div className="guard-batch-rule-list">{pageGuards.map(guard=><label key={guard.id} className={selectedSet.has(guard.id)?'selected':''}><input type="checkbox" disabled={working} checked={selectedSet.has(guard.id)} onChange={()=>setSelected(current=>current.includes(guard.id)?current.filter(id=>id!==guard.id):[...current,guard.id])}/><span><strong>{guard.name}</strong><code>{guard.recordType} · {guard.domain}</code><small>{guard.currentValues?.length||0} 个 IP · {guard.sources?.length||0} 个来源{guard.sourcesEnabled===false?' · 来源禁用':''}{guard.enabled===false?' · 任务停用':guard.cycle?' · 检查中':''}</small></span></label>)}{!visible.length?<p className="guard-batch-empty">没有匹配的规则</p>:null}</div>
        {rulePages>1?<nav className="guard-batch-pagination" aria-label="规则分页"><button className="ghost" disabled={currentRulePage<=1} onClick={()=>setRulePage(currentRulePage-1)}>上一页规则</button><span>{currentRulePage} / {rulePages} 页 · 共 {visible.length} 条</span><button className="ghost" disabled={currentRulePage>=rulePages} onClick={()=>setRulePage(currentRulePage+1)}>下一页规则</button></nav>:null}
        <small className="guard-batch-hint">全选与反选作用于全部搜索结果，跨页保留选择，单次最多 500 条。</small>
      </section>
      <section className="guard-batch-editor" aria-label="配置批量操作"><div className="guard-batch-section-head"><strong>02 设置操作</strong><SlidersHorizontal size={16}/></div>
        <label className="guard-batch-field"><span>操作类型</span><select aria-label="操作类型" disabled={working} value={action} onChange={event=>{setAction(event.target.value);setText('');}}>{DNS_GUARD_BATCH_ACTIONS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <fieldset disabled={working} className="guard-batch-fields">
          {['sources_enabled','enabled'].includes(action)?<div className="guard-batch-choice">{[[false,action==='sources_enabled'?'禁用域名来源':'停用守护任务'],[true,action==='sources_enabled'?'启用域名来源':'启用守护任务']].map(([value,label])=><label key={label}><input type="radio" name="guard-batch-enabled" checked={enabled===value} onChange={()=>setEnabled(value)}/>{label}</label>)}</div>:null}
          {SOURCE_ACTIONS.includes(action)?<><label className="guard-batch-field"><span>来源输入方式</span><select aria-label="来源输入方式" value={perRule?'per-rule':'common'} onChange={event=>setPerRule(event.target.value==='per-rule')}><option value="common">所选规则使用相同来源</option><option value="per-rule">按被守护域名分别填写</option></select></label><button type="button" className="ghost guard-batch-copy" disabled={!ids.length} onClick={copySources}><Copy size={14}/>复制所选规则的现有来源</button></>:null}
          {['ips_add','ips_remove','sources_add','sources_remove','sources_replace','sources_map'].includes(action)?<label className="guard-batch-field"><span>{action.startsWith('ips_')?'IP 地址':action==='sources_map'?'旧域名与新域名':action==='sources_remove'?'要删除的来源域名':'来源配置'}</span><textarea aria-label="批量操作内容" rows={7} value={text} onChange={event=>setText(event.target.value)} placeholder={action.startsWith('ips_')?'192.0.2.10\n2001:db8::10':action==='sources_map'?'old.example.com | new.example.com':action==='sources_remove'?'source.example.com\nbackup.example.com':perRule?'守护域名（同域名用 域名#规则ID） | 主来源 | 备用来源（可填 -） | 名称\nedge.example.com | home.example.com | backup.example.com | 家宽':'主来源 | 备用来源（可填 -） | 名称\nhome.example.com | backup.example.com | 家宽'}/></label>:null}
          {action==='references'?<><label className="guard-batch-field"><span>关联类型</span><select aria-label="关联类型" value={refField} onChange={event=>{setRefField(event.target.value);setRefIds([]);}}><option value="probeIds">负责探针</option><option value="poolIds">备用池</option><option value="alertBotIds">通知机器人</option></select></label><label className="guard-batch-field"><span>更改方式</span><select aria-label="关联更改方式" value={refMode} onChange={event=>setRefMode(event.target.value)}><option value="add">追加选中项</option><option value="remove">移除选中项</option><option value="replace">替换为选中项</option></select></label><div className="guard-batch-ref-list">{refs.map(item=><label key={item.id}><input type="checkbox" checked={refIds.includes(item.id)} onChange={()=>setRefIds(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}/>{item.name}</label>)}</div></>:null}
          {action==='settings'?<><label className="guard-batch-field"><span>修改参数</span><select aria-label="修改参数" value={setting} onChange={event=>{setSetting(event.target.value);setSettingValue(DNS_GUARD_BATCH_SETTINGS.find(([id])=>id===event.target.value)[2]);}}>{DNS_GUARD_BATCH_SETTINGS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label className="guard-batch-field"><span>新值</span><input aria-label="参数新值" type="number" min={DNS_GUARD_BATCH_SETTINGS.find(([id])=>id===setting)[2]} max={DNS_GUARD_BATCH_SETTINGS.find(([id])=>id===setting)[3]} step="1" value={settingValue} onChange={event=>setSettingValue(event.target.value)}/></label></>:null}
        </fieldset>
        <div className="guard-batch-notice">{action==='ips_add'?'先读取远程记录，再追加去重；按 A / AAAA 匹配地址，保留其他现有 IP。添加后仍受守护规则的健康检查约束。':action==='ips_remove'?'只移除输入的 IP，其他远程记录保留。来源仍启用时，后续检查可能从来源重新补入。':action==='sources_replace'?'只替换来源配置，不立即删除远程解析。按域名分别填写时，没有对应行的规则会跳过。':action==='sources_remove'?'匹配主域名：删除整条来源；仅匹配备用域名：只清空备用域名。各规则的其他来源保留。':action==='sources_map'?'按旧域名准确匹配主 / 备用来源，保留来源名称与兜底设置，不按列表位置修改。':action==='sources_enabled'?'保留每条规则各自的来源配置和现有健康解析，只切换来源总开关。':action==='sources_add'?'按主域名去重，已存在的来源保留原有设置；新来源默认不勾选仅作兜底。':action==='references'?'每条规则独立追加、移除或替换。负责探针至少保留一个有效选择。':action==='check'?'已在检查中的任务会跳过，不重复启动。停用的守护任务需要先启用。':'只修改选定参数，其他配置保持各自原值。'}</div>
      </section>
    </div>
    {error?<div className="guard-batch-error" role="alert">{error}</div>:null}
    {job?<section className="guard-batch-results" aria-label="批量操作预览与结果"><div className="guard-batch-section-head"><strong>{ACTIVE_JOBS.includes(job.status)?<LoaderCircle size={15} className="ops-source-spinner"/>:null}03 {job.status==='recovering'?'正在核对任务状态':job.status==='done'?'执行结果':job.status==='applying'?'正在执行':'逐条预览'} · {dnsGuardBatchLabel(job.action)}</strong><span>{summary}</span></div>
      {planKey!==requestKey&&!working?<p className="guard-batch-stale">选择或参数已变化，请重新预览后再执行。</p>:null}
      {job.status==='done'&&failedIds.length?<button className="ghost" onClick={()=>{setSelected(failedIds);setJob(null);}}>仅选择失败 / 跳过项重试</button>:null}
      <div className="guard-batch-result-list">{pageResults.map(({row,diff:[before,after]})=>{return <article key={row.id}><div className="guard-batch-result-heading"><div><strong>{row.name}</strong><span>{row.recordType} · {row.domain}</span></div><em className={row.status}>{STATUS[row.status]||row.status}</em></div>{before||after?<div className="guard-batch-diff"><div><small>更改前</small><pre>{before}</pre></div><ArrowRight size={14}/><div><small>更改后</small><pre>{after}</pre></div></div>:null}<p>{row.message}</p></article>;})}</div>
      {resultPages>1?<nav className="guard-batch-pagination" aria-label="结果分页"><button className="ghost" disabled={currentResultPage<=1} onClick={()=>setResultPage(currentResultPage-1)}>上一页结果</button><span>{currentResultPage} / {resultPages} 页 · 共 {job.rows.length} 条</span><button className="ghost" disabled={currentResultPage>=resultPages} onClick={()=>setResultPage(currentResultPage+1)}>下一页结果</button></nav>:null}
      <small className="guard-batch-hint">关闭弹窗后操作继续执行，本页重新打开可查看进度；服务重启会结束本次批量任务，已完成更改保留，可重新预览核对。</small>
    </section>:null}
  </Dialog>;
}
